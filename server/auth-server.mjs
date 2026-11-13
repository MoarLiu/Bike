import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, chmod } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream";
import { ensurePrivateConfig } from "./private-config.mjs";
import { fileURLToPath } from "node:url";
import { isPbkdf2Hash, verifyPassword } from "./password.mjs";
import {
  bearerTokenFrom,
  createDeviceTokenGuard,
  createFailureLimiter,
  loginAttemptKeys,
  normalizeTrustedProxyCount,
  normalizeOptionalBoolean,
  normalizePositiveInteger,
  environmentInteger,
  resolveClientAddress,
  tooManyAuthFailuresPayload,
} from "./request-guards.mjs";
import { createSessionStateStore, resolveSessionStatePath, sessionStateFileName } from "./session-state.mjs";
import { handleSyncApi } from "./sync-api.mjs";
import { createSyncStore } from "./sync-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.umask(0o077);
const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");
const defaultSyncDatabasePath = path.join(projectRoot, "data", "bike-sync.sqlite");
const defaultConfigPath = path.join(
  projectRoot,
  "config",
  "bike.config.json",
);
const configPath = process.env.BIKE_CONFIG || process.env.LOCAL_OUTLINE_CONFIG
  ? path.resolve(process.env.BIKE_CONFIG || process.env.LOCAL_OUTLINE_CONFIG)
  : defaultConfigPath;
const cookieName = "bike_session";
const deviceCookieName = "bike_device";
const deviceCookieMaxAgeSeconds = 180 * 24 * 60 * 60;
// Loaded from the session state file at startup so logouts survive restarts.
let sessionRevokedBefore = 0;
const maxLoginFailures = 8;
const maxLoginAttemptEntries = 5000;
const loginWindowMs = 15 * 60 * 1000;
const maxLoginDelayMs = 30 * 1000;
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' http: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
const securityHeaders = {
  "Content-Security-Policy": contentSecurityPolicy,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
};

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const readConfig = async () => {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
    await ensurePrivateConfig(configPath);
  } catch (error) {
    throw new Error(
      `无法读取认证配置：${configPath}\n请复制 config/bike.config.example.json 为 config/bike.config.json 后再启动。\n${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const auth = parsed.auth ?? {};
  const missing = [];
  if (!auth.username) missing.push("auth.username");
  if (!auth.passwordHash) missing.push("auth.passwordHash");
  if (!auth.sessionSecret) missing.push("auth.sessionSecret");
  if (missing.length) {
    throw new Error(`认证配置缺少字段：${missing.join(", ")}`);
  }
  if (!isPbkdf2Hash(String(auth.passwordHash))) {
    throw new Error("auth.passwordHash 必须由 npm run auth:hash 生成");
  }
  if (String(auth.sessionSecret).length < 32) {
    throw new Error("auth.sessionSecret 太短，请使用 npm run auth:hash 生成");
  }

  const sync = parsed.sync ?? {};
  const deviceTokenHashes = Array.isArray(sync.deviceTokenHashes)
    ? sync.deviceTokenHashes.flatMap((entry) => {
        if (typeof entry === "string") return [entry];
        if (entry && typeof entry === "object" && typeof entry.hash === "string") {
          return [entry.hash];
        }
        return [];
      })
    : [];
  for (const hash of deviceTokenHashes) {
    if (!isPbkdf2Hash(String(hash))) {
      throw new Error("sync.deviceTokenHashes 必须由 npm run auth:hash 生成");
    }
  }

  return {
    host: parsed.host || "127.0.0.1",
    port: normalizePositiveInteger(parsed.port ?? environmentInteger(process.env.PORT, "PORT"), "port", 4173, { maximum: 65535 }),
    auth: {
      username: String(auth.username),
      passwordHash: String(auth.passwordHash),
      sessionSecret: String(auth.sessionSecret),
      sessionMaxAgeHours: normalizePositiveInteger(auth.sessionMaxAgeHours, "auth.sessionMaxAgeHours", 168, { maximum: 8760 }),
      secureCookies: normalizeOptionalBoolean(auth.secureCookies, "auth.secureCookies"),
      trustProxyHeaders: normalizeOptionalBoolean(auth.trustProxyHeaders, "auth.trustProxyHeaders"),
      trustedProxyCount: normalizeTrustedProxyCount(
        auth.trustedProxyCount,
        "auth.trustedProxyCount",
      ),
      sessionStatePath: resolveSessionStatePath({
        configuredPath: auth.sessionStatePath,
        projectRoot,
      }),
      legacySessionStatePath: !String(auth.sessionStatePath ?? "").trim() && process.env.STATE_DIRECTORY
        ? path.join(projectRoot, "data", sessionStateFileName)
        : undefined,
    },
    web: {
      defaultSyncServerUrl: String(
        parsed.web?.defaultSyncServerUrl ||
          process.env.BIKE_DEFAULT_SYNC_SERVER_URL ||
          process.env.BIKE_DEFAULT_SYNC_URL ||
          "",
      ).trim(),
    },
    sync: {
      enabled: normalizeOptionalBoolean(sync.enabled, "sync.enabled"),
      databasePath: sync.databasePath
        ? path.resolve(projectRoot, String(sync.databasePath))
        : defaultSyncDatabasePath,
      deviceTokenHashes,
      maxBodyBytes: normalizePositiveInteger(sync.maxBodyBytes, "sync.maxBodyBytes", 10 * 1024 * 1024, { maximum: 64 * 1024 * 1024 }),
    },
  };
};

const html = (body) => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bike 登录</title>
  <style>
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      color: #1d1d1f;
      background: #f5f4f2;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    main {
      width: min(360px, calc(100vw - 32px));
      display: grid;
      gap: 18px;
      padding: 28px;
      border: 1px solid #dedddb;
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 18px 44px rgba(28, 28, 31, 0.12);
    }
    h1 { margin: 0; font-size: 24px; line-height: 1.15; }
    p { margin: 0; color: #66666b; font-size: 14px; line-height: 1.45; }
    form { display: grid; gap: 12px; }
    label { display: grid; gap: 6px; color: #55555a; font-size: 13px; font-weight: 650; }
    input {
      min-height: 42px;
      padding: 0 12px;
      border: 1px solid #d8d6d4;
      border-radius: 6px;
      font: inherit;
      outline: 0;
    }
    input:focus { border-color: #6b4fd7; box-shadow: 0 0 0 3px rgba(107, 79, 215, 0.16); }
    button {
      min-height: 42px;
      border: 0;
      border-radius: 6px;
      color: #fff;
      background: #6b4fd7;
      font: inherit;
      font-weight: 720;
      cursor: pointer;
    }
    .error {
      min-height: 34px;
      padding: 8px 10px;
      border-radius: 6px;
      color: #9f2d2d;
      background: #fff0f0;
      font-size: 13px;
    }
  </style>
</head>
<body>${body}</body>
</html>`;

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);

const send = (response, statusCode, body, headers = {}) => {
  response.writeHead(statusCode, {
    ...securityHeaders,
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(body);
};

const sendJson = (response, statusCode, payload, headers = {}) => {
  send(response, statusCode, JSON.stringify(payload), {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
};

const redirect = (response, location) => {
  response.writeHead(302, {
    ...securityHeaders,
    Location: location,
    "Cache-Control": "no-store",
  });
  response.end();
};

const methodNotAllowed = (response, allow) => {
  send(response, 405, "Method Not Allowed", {
    "Content-Type": "text/plain; charset=utf-8",
    Allow: allow,
  });
};

const parseCookies = (request) =>
  Object.fromEntries(
    String(request.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) return [part, ""];
        try {
          return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
        } catch {
          return [part.slice(0, index), ""];
        }
      }),
  );

const sign = (value, secret) =>
  createHmac("sha256", secret).update(value).digest("base64url");

const signatureMatches = (payload, signature, secret) => {
  const actualBuffer = Buffer.from(String(signature ?? ""));
  const expectedBuffer = Buffer.from(sign(payload, secret));
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
};

const cookieOptions = (config, maxAgeSeconds) => [
  "Path=/",
  "HttpOnly",
  "SameSite=Strict",
  `Max-Age=${maxAgeSeconds}`,
  config.auth.secureCookies ? "Secure" : "",
]
  .filter(Boolean)
  .join("; ");

const sessionCookieOptions = (config) =>
  cookieOptions(config, Math.round(config.auth.sessionMaxAgeHours * 3600));

const createSessionToken = (config) => {
  const payload = Buffer.from(
    JSON.stringify({
      sub: config.auth.username,
      iat: Date.now(),
      exp: Date.now() + config.auth.sessionMaxAgeHours * 3600 * 1000,
    }),
  ).toString("base64url");
  return `${payload}.${sign(payload, config.auth.sessionSecret)}`;
};

const verifySessionToken = (token, config) => {
  if (!token || !token.includes(".")) return false;
  const [payload, signature] = token.split(".");
  if (!signatureMatches(payload, signature, config.auth.sessionSecret)) {
    return false;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return (
      parsed.sub === config.auth.username &&
      Number(parsed.exp) > Date.now() &&
      Number(parsed.iat) > sessionRevokedBefore
    );
  } catch {
    return false;
  }
};

// Device cookies only mark a browser that has logged in successfully before;
// they never authenticate anything. They are signed with a key derived from
// sessionSecret so a device token can never pass as a session token.
const deviceSigningKey = (config) =>
  sign("bike-device-cookie-v1", config.auth.sessionSecret);

const createDeviceToken = (config) => {
  const payload = Buffer.from(
    JSON.stringify({
      typ: "device",
      sub: config.auth.username,
      id: randomBytes(16).toString("base64url"),
      iat: Date.now(),
    }),
  ).toString("base64url");
  return `${payload}.${sign(payload, deviceSigningKey(config))}`;
};

const verifyDeviceToken = (token, username, config) => {
  if (typeof token !== "string") return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  if (!signatureMatches(payload, signature, deviceSigningKey(config))) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const issuedAt = Number(parsed.iat);
    if (
      parsed.typ !== "device" ||
      parsed.sub !== username ||
      typeof parsed.id !== "string" ||
      !parsed.id ||
      !Number.isFinite(issuedAt) ||
      Date.now() - issuedAt >= deviceCookieMaxAgeSeconds * 1000
    ) {
      return null;
    }
    return { id: parsed.id };
  } catch {
    return null;
  }
};

const clientIp = (request, config) => resolveClientAddress(request, config.auth);

const loginDelayMs = (failures) =>
  Math.min(maxLoginDelayMs, Math.max(0, 2 ** Math.max(0, failures - 3) * 1000));

const loginLimiterOptions = {
  maxFailures: maxLoginFailures,
  windowMs: loginWindowMs,
  maxEntries: maxLoginAttemptEntries,
  delayMs: loginDelayMs,
};
const loginLimiter = createFailureLimiter(loginLimiterOptions);
// Untrusted identities cannot fill the table used by signed device cookies.
const trustedLoginLimiter = createFailureLimiter(loginLimiterOptions);

const tooManyLoginAttempts = (response, retryAfterSeconds = 30) => {
  send(response, 429, loginPage("登录尝试过多，请稍后再试"), {
    "Content-Type": "text/html; charset=utf-8",
    "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))),
  });
};

const readRequestBody = (request) =>
  new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10000) {
        request.destroy();
        reject(new Error("请求体过大"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

const loginPage = (error = "") =>
  html(`<main>
  <h1>Bike</h1>
  <p>请输入部署配置里的单用户账号。登录后才能访问你的本地优先大纲工具。</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  <form method="post" action="/auth/login">
    <label>
      账号
      <input name="username" autocomplete="username" autofocus />
    </label>
    <label>
      密码
      <input name="password" type="password" autocomplete="current-password" />
    </label>
    <button type="submit">登录</button>
  </form>
</main>`);

const isAuthenticated = (request, config) =>
  verifySessionToken(parseCookies(request)[cookieName], config);

const apiAuthentication = async (request, config, deviceTokenGuard) => {
  if (!bearerTokenFrom(request) && isAuthenticated(request, config)) return { ok: true, limited: false, cookie: true };
  return await deviceTokenGuard.authenticate(
    bearerTokenFrom(request),
    clientIp(request, config),
  );
};

const sameOriginMutation = (request, config) => {
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  if (!request.headers.origin) return true; // non-browser clients
  try {
    const origin = new URL(request.headers.origin);
    const secure = config.auth.secureCookies || request.socket?.encrypted ||
      (config.auth.trustProxyHeaders && request.headers["x-forwarded-proto"] === "https");
    return origin.origin === `${secure ? "https" : "http"}://${request.headers.host}`;
  } catch { return false; }
};

const revokeSessions = async (sessionState) => {
  sessionRevokedBefore = Math.max(sessionRevokedBefore, Date.now());
  try {
    await sessionState.save(sessionRevokedBefore);
  } catch (error) {
    console.error(
      `无法写入会话状态文件：${sessionState.path}（${error instanceof Error ? error.message : String(error)}）。本次退出登录只在服务重启前有效。`,
    );
  }
};

const runtimeConfigMeta = (config) =>
  `<meta name="bike-default-sync-server-url" content="${escapeHtml(config.web.defaultSyncServerUrl)}" />`;

const prepareIndexHtml = (html, config) =>
  html
    .replace(
      /<meta name="bike-default-sync-server-url" content="[^"]*"\s*\/?>/,
      runtimeConfigMeta(config),
    )
    .replace(/\s+crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/g, "");

const serveStatic = async (request, response, config) => {
  let url;
  try { url = new URL(request.url, "http://localhost"); }
  catch { sendJson(response, 400, { error: "invalid_url", message: "请求地址无效" }); return; }
  let rawPathname;
  try {
    rawPathname = decodeURIComponent(url.pathname);
  } catch {
    send(response, 400, "URL 编码无效", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }
  const pathname = rawPathname === "/" ? "/index.html" : rawPathname;
  const filePath = path.normalize(path.join(distDir, pathname));

  if (filePath !== distDir && !filePath.startsWith(`${distDir}${path.sep}`)) {
    send(response, 403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  let target = filePath;
  try {
    const fileStat = await stat(target);
    if (!fileStat.isFile()) throw new Error("not a file");
  } catch {
    target = path.join(distDir, "index.html");
  }

  const extension = path.extname(target).toLowerCase();
  if (extension === ".html") {
    const body = prepareIndexHtml(await readFile(target, "utf8"), config);
    response.writeHead(200, {
      ...securityHeaders,
      "Content-Type": contentTypes[extension],
      "Cache-Control": "no-store",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    response.end(body);
    return;
  }

  response.writeHead(200, {
    ...securityHeaders,
    "Content-Type": contentTypes[extension] || "application/octet-stream",
    "Cache-Control":
      extension === ".html" ? "no-store" : "private, max-age=31536000, immutable",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  pipeline(createReadStream(target), response, (error) => {
    if (error && !response.destroyed) {
      response.destroy(error);
    }
  });
};

const handleRequest = async (
  request,
  response,
  config,
  syncStore,
  { deviceTokenGuard, sessionState },
) => {
  let url;
  try { url = new URL(request.url, "http://localhost"); }
  catch { sendJson(response, 400, { error: "invalid_url", message: "请求地址无效" }); return; }
  const authed = isAuthenticated(request, config);

  if (request.method === "GET" && url.pathname === "/login") {
    if (authed) {
      redirect(response, "/");
      return;
    }
    send(response, 200, loginPage(), { "Content-Type": "text/html; charset=utf-8" });
    return;
  }

  if (request.method === "POST" && url.pathname === "/auth/login") {
    const params = new URLSearchParams(await readRequestBody(request));
    const username = String(params.get("username") || "");
    const password = String(params.get("password") || "");
    const device = verifyDeviceToken(
      parseCookies(request)[deviceCookieName],
      username,
      config,
    );
    const attemptKeys = loginAttemptKeys({
      deviceId: device?.id,
      clientAddress: clientIp(request, config),
      username,
    });
    const limiter = device ? trustedLoginLimiter : loginLimiter;
    // Refuse throttled attempts before looking at the password. Letting a
    // correct password through while throttled would turn 429 into an oracle.
    const allowance = limiter.check(attemptKeys);
    if (allowance.limited || !limiter.begin(attemptKeys)) {
      tooManyLoginAttempts(response, allowance.retryAfterSeconds);
      return;
    }
    let credentialsValid = false;
    try {
      const passwordValid = await verifyPassword(password, config.auth.passwordHash);
      credentialsValid = username === config.auth.username && passwordValid;
    } finally {
      limiter.finish(attemptKeys, { failed: !credentialsValid });
    }
    if (credentialsValid) {
      limiter.clear(attemptKeys);
      response.writeHead(302, {
        ...securityHeaders,
        Location: "/",
        "Set-Cookie": [
          `${cookieName}=${encodeURIComponent(
            createSessionToken(config),
          )}; ${sessionCookieOptions(config)}`,
          `${deviceCookieName}=${encodeURIComponent(
            createDeviceToken(config),
          )}; ${cookieOptions(config, deviceCookieMaxAgeSeconds)}`,
        ],
        "Cache-Control": "no-store",
      });
      response.end();
      return;
    }
    send(response, 401, loginPage("账号或密码不正确"), {
      "Content-Type": "text/html; charset=utf-8",
    });
    return;
  }

  if (url.pathname === "/auth/logout" && request.method !== "POST") {
    send(response, 405, "Method Not Allowed", {
      "Content-Type": "text/plain; charset=utf-8",
      Allow: "POST",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/auth/logout") {
    if (!sameOriginMutation(request, config)) { sendJson(response, 403, { error: "origin_denied", message: "退出请求来源无效" }); return; }
    // The device cookie is kept on purpose: it is what lets this browser log
    // in again while untrusted clients are throttled.
    if (authed) await revokeSessions(sessionState);
    response.writeHead(302, {
      ...securityHeaders,
      Location: "/login",
      "Set-Cookie": `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      "Cache-Control": "no-store",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/auth/status") {
    sendJson(response, authed ? 200 : 401, { authenticated: authed });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (!config.sync.enabled || !syncStore) {
      sendJson(response, 404, {
        error: "sync_disabled",
        message: "Sync API is disabled",
      });
      return;
    }
    const apiAuth = await apiAuthentication(request, config, deviceTokenGuard);
    if (apiAuth.limited) {
      sendJson(response, 429, tooManyAuthFailuresPayload, {
        "Retry-After": String(apiAuth.retryAfterSeconds),
      });
      return;
    }
    if (!apiAuth.ok) {
      sendJson(response, 401, {
        error: "unauthorized",
        message: "Unauthorized",
      });
      return;
    }
    if (apiAuth.cookie && !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
        (!sameOriginMutation(request, config) || !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? ""))) {
      sendJson(response, 403, { error: "origin_denied", message: "写入请求需要同源 JSON" });
      return;
    }
    await handleSyncApi(request, response, config, syncStore);
    return;
  }

  if (!authed) {
    if (request.headers.accept?.includes("text/html")) {
      redirect(response, "/login");
    } else {
      send(response, 401, "Unauthorized", {
        "Content-Type": "text/plain; charset=utf-8",
      });
    }
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    methodNotAllowed(response, "GET, HEAD");
    return;
  }

  await serveStatic(request, response, config);
};

const config = await readConfig();
const sessionState = createSessionStateStore(config.auth.sessionStatePath, {
  legacyStatePath: config.auth.legacySessionStatePath,
});
sessionRevokedBefore = await sessionState.load();
const deviceTokenGuard = createDeviceTokenGuard({
  tokenHashes: config.sync.deviceTokenHashes,
});
const syncStore = config.sync.enabled
  ? await createSyncStore(config.sync.databasePath)
  : null;

createServer((request, response) => {
  handleRequest(request, response, config, syncStore, {
    deviceTokenGuard,
    sessionState,
  }).catch((error) => {
    console.error(error);
    send(response, 500, "Internal Server Error", {
      "Content-Type": "text/plain; charset=utf-8",
    });
  });
}).listen(config.port, config.host, () => {
  console.log(`Bike 已启动：http://${config.host}:${config.port}`);
  console.log(`认证配置：${configPath}`);
  console.log(`会话状态：${sessionState.path}`);
  if (syncStore) console.log(`同步数据库：${config.sync.databasePath}`);
});
