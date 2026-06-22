import { createHmac, pbkdf2, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  SyncConflictError,
  SyncNotFoundError,
  SyncValidationError,
  createSyncStore,
} from "./sync-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
const loginAttempts = new Map();
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
  "connect-src 'self'",
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
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const readConfig = async () => {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
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
  if (!String(auth.passwordHash).startsWith("pbkdf2$")) {
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
    if (!String(hash).startsWith("pbkdf2$")) {
      throw new Error("sync.deviceTokenHashes 必须由 npm run auth:hash 生成");
    }
  }

  return {
    host: parsed.host || "127.0.0.1",
    port: Number(parsed.port || process.env.PORT || 4173),
    auth: {
      username: String(auth.username),
      passwordHash: String(auth.passwordHash),
      sessionSecret: String(auth.sessionSecret),
      sessionMaxAgeHours: Number(auth.sessionMaxAgeHours || 168),
      secureCookies: Boolean(auth.secureCookies),
      trustProxyHeaders: Boolean(auth.trustProxyHeaders),
    },
    sync: {
      enabled: sync.enabled === true,
      databasePath: sync.databasePath
        ? path.resolve(projectRoot, String(sync.databasePath))
        : defaultSyncDatabasePath,
      deviceTokenHashes,
      maxBodyBytes: Number(sync.maxBodyBytes || 10 * 1024 * 1024),
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

const sessionCookieOptions = (config) => [
  "Path=/",
  "HttpOnly",
  "SameSite=Strict",
  `Max-Age=${Math.round(config.auth.sessionMaxAgeHours * 3600)}`,
  config.auth.secureCookies ? "Secure" : "",
]
  .filter(Boolean)
  .join("; ");

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
  const expected = sign(payload, config.auth.sessionSecret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
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

const verifyPassword = (password, passwordHash) => {
  const [scheme, iterationText, salt, expectedHash] = passwordHash.split("$");
  if (scheme !== "pbkdf2" || !iterationText || !salt || !expectedHash) return false;
  const iterations = Number(iterationText);
  if (!Number.isFinite(iterations) || iterations < 100000) return false;
  return new Promise((resolve) => {
    pbkdf2(password, salt, iterations, 32, "sha256", (error, derivedKey) => {
      if (error) {
        resolve(false);
        return;
      }
      const actualBuffer = Buffer.from(derivedKey.toString("base64url"));
      const expectedBuffer = Buffer.from(expectedHash);
      resolve(
        actualBuffer.length === expectedBuffer.length &&
          timingSafeEqual(actualBuffer, expectedBuffer),
      );
    });
  });
};

const clientIp = (request, config) => {
  const source = config.auth.trustProxyHeaders
    ? request.headers["x-forwarded-for"]
    : request.socket.remoteAddress;
  return String(source || request.socket.remoteAddress || "unknown").split(",")[0].trim();
};

const loginAttemptKeys = (request, username, config) => [
  { key: `ip:${clientIp(request, config)}:${username}`, scope: "ip" },
  { key: `user:${username}`, scope: "user" },
];

const pruneLoginAttempts = () => {
  const now = Date.now();
  for (const [key, attempt] of loginAttempts) {
    if (now - attempt.firstAt > loginWindowMs && now >= attempt.nextAllowedAt) {
      loginAttempts.delete(key);
    }
  }
  if (loginAttempts.size <= maxLoginAttemptEntries) return;
  const overflow = loginAttempts.size - maxLoginAttemptEntries;
  for (const key of [...loginAttempts.entries()]
    .sort((a, b) => a[1].firstAt - b[1].firstAt)
    .slice(0, overflow)
    .map(([key]) => key)) {
    loginAttempts.delete(key);
  }
};

const loginAttempt = (key) => {
  pruneLoginAttempts();
  const now = Date.now();
  const existing = loginAttempts.get(key);
  if (!existing || now - existing.firstAt > loginWindowMs) {
    const fresh = { failures: 0, firstAt: now, nextAllowedAt: 0 };
    loginAttempts.set(key, fresh);
    return fresh;
  }
  return existing;
};

const loginDelayMs = (failures) =>
  Math.min(maxLoginDelayMs, Math.max(0, 2 ** Math.max(0, failures - 3) * 1000));

const registerLoginFailure = (keys) => {
  for (const { key } of keys) {
    const attempt = loginAttempt(key);
    attempt.failures += 1;
    attempt.nextAllowedAt = Date.now() + loginDelayMs(attempt.failures);
  }
};

const clearLoginFailures = (keys) => {
  keys.forEach(({ key }) => loginAttempts.delete(key));
};

const loginLimitState = (keys) => {
  const now = Date.now();
  let userLimited = false;
  for (const { key, scope } of keys) {
    const attempt = loginAttempt(key);
    const delayed = now < attempt.nextAllowedAt;
    const exhausted = attempt.failures >= maxLoginFailures;
    if (scope === "ip" && (delayed || exhausted)) {
      return { blocked: true, userLimited: false };
    }
    if (scope === "user" && (delayed || exhausted)) {
      userLimited = true;
    }
  }
  return { blocked: false, userLimited };
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

const readJsonRequestBody = (request, maxBytes) =>
  new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        request.destroy();
        reject(new SyncValidationError("请求体过大"));
      }
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new SyncValidationError("请求体不是有效 JSON"));
      }
    });
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

const isApiAuthenticated = async (request, config) => {
  if (isAuthenticated(request, config)) return true;
  const authorization = String(request.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match || !config.sync.deviceTokenHashes.length) return false;
  for (const hash of config.sync.deviceTokenHashes) {
    if (await verifyPassword(match[1], hash)) return true;
  }
  return false;
};

const handleSyncError = (response, error) => {
  if (error instanceof SyncConflictError) {
    sendJson(response, 409, {
      error: "revision_conflict",
      message: error.message,
      currentRevision: error.currentRevision,
    });
    return;
  }
  if (error instanceof SyncValidationError) {
    sendJson(response, 400, {
      error: "invalid_request",
      message: error.message,
    });
    return;
  }
  if (error instanceof SyncNotFoundError) {
    sendJson(response, 404, {
      error: "not_found",
      message: error.message,
    });
    return;
  }
  throw error;
};

const handleSyncApi = async (request, response, config, syncStore) => {
  const url = new URL(request.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  if (request.method === "GET" && pathname === "/api/sync/manifest") {
    sendJson(response, 200, syncStore.getManifest());
    return;
  }

  if (pathname === "/api/sync/manifest") {
    if (request.method !== "PATCH") {
      methodNotAllowed(response, "GET, PATCH");
      return;
    }
    try {
      const body = await readJsonRequestBody(request, config.sync.maxBodyBytes);
      sendJson(response, 200, syncStore.patchManifest({
        expectedRevision: body.expectedRevision,
        activeDocumentId: body.activeDocumentId,
        documentOrder: body.documentOrder,
      }));
    } catch (error) {
      handleSyncError(response, error);
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/documents") {
    sendJson(response, 200, { documents: syncStore.getManifest().documents });
    return;
  }

  const operationsMatch = pathname.match(/^\/api\/documents\/([^/]+)\/operations$/);
  if (operationsMatch) {
    const id = operationsMatch[1];
    try {
      if (request.method === "GET") {
        sendJson(response, 200, syncStore.getDocumentOperations({
          id,
          after: url.searchParams.get("after"),
        }));
        return;
      }
      if (request.method === "POST") {
        const body = await readJsonRequestBody(request, config.sync.maxBodyBytes);
        sendJson(response, 200, syncStore.appendDocumentOperations({
          id,
          baseRevision: body.baseRevision,
          actorId: body.actorId,
          operations: body.operations,
        }));
        return;
      }
    } catch (error) {
      handleSyncError(response, error);
      return;
    }
    methodNotAllowed(response, "GET, POST");
    return;
  }

  const documentMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (!documentMatch) {
    sendJson(response, 404, { error: "not_found", message: "API route not found" });
    return;
  }

  const id = documentMatch[1];
  try {
    if (request.method === "GET") {
      const result = syncStore.getDocument(id);
      if (!result) {
        sendJson(response, 404, { error: "not_found", message: "Document not found" });
        return;
      }
      if (result.deletedAt) {
        sendJson(response, 410, {
          error: "document_deleted",
          revision: result.revision,
          deletedAt: result.deletedAt,
        });
        return;
      }
      sendJson(response, 200, {
        revision: result.revision,
        document: result.document,
      });
      return;
    }

    if (request.method === "PUT") {
      const body = await readJsonRequestBody(request, config.sync.maxBodyBytes);
      const result = syncStore.putDocument({
        id,
        expectedRevision: body.expectedRevision,
        document: body.document,
      });
      sendJson(response, 200, {
        revision: result.revision,
        document: result.document,
      });
      return;
    }

    if (request.method === "DELETE") {
      const body = await readJsonRequestBody(request, config.sync.maxBodyBytes);
      sendJson(response, 200, syncStore.deleteDocument({
        id,
        expectedRevision: body.expectedRevision,
      }));
      return;
    }
  } catch (error) {
    handleSyncError(response, error);
    return;
  }

  methodNotAllowed(response, "GET, PUT, DELETE");
};

const serveStatic = async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const rawPathname = decodeURIComponent(url.pathname);
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

const handleRequest = async (request, response, config, syncStore) => {
  const url = new URL(request.url, "http://localhost");
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
    const attemptKeys = loginAttemptKeys(request, username, config);
    const limit = loginLimitState(attemptKeys);
    if (limit.blocked) {
      send(response, 429, loginPage("登录尝试过多，请稍后再试"), {
        "Content-Type": "text/html; charset=utf-8",
        "Retry-After": "30",
      });
      return;
    }
    const credentialsValid =
      username === config.auth.username &&
      await verifyPassword(password, config.auth.passwordHash);
    if (credentialsValid) {
      clearLoginFailures(attemptKeys);
      response.writeHead(302, {
        ...securityHeaders,
        Location: "/",
        "Set-Cookie": `${cookieName}=${encodeURIComponent(
          createSessionToken(config),
        )}; ${sessionCookieOptions(config)}`,
        "Cache-Control": "no-store",
      });
      response.end();
      return;
    }
    if (limit.userLimited) {
      send(response, 429, loginPage("登录尝试过多，请稍后再试"), {
        "Content-Type": "text/html; charset=utf-8",
        "Retry-After": "30",
      });
      return;
    }
    registerLoginFailure(attemptKeys);
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
    if (authed) sessionRevokedBefore = Date.now();
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
    if (!(await isApiAuthenticated(request, config))) {
      sendJson(response, 401, {
        error: "unauthorized",
        message: "Unauthorized",
      });
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

  await serveStatic(request, response);
};

const config = await readConfig();
const syncStore = config.sync.enabled
  ? await createSyncStore(config.sync.databasePath)
  : null;

createServer((request, response) => {
  handleRequest(request, response, config, syncStore).catch((error) => {
    console.error(error);
    send(response, 500, "Internal Server Error", {
      "Content-Type": "text/plain; charset=utf-8",
    });
  });
}).listen(config.port, config.host, () => {
  console.log(`Bike 已启动：http://${config.host}:${config.port}`);
  console.log(`认证配置：${configPath}`);
  if (syncStore) console.log(`同步数据库：${config.sync.databasePath}`);
});
