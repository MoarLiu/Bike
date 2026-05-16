import { createHmac, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");
const defaultConfigPath = path.join(
  projectRoot,
  "config",
  "local-outline.config.json",
);
const configPath = process.env.LOCAL_OUTLINE_CONFIG
  ? path.resolve(process.env.LOCAL_OUTLINE_CONFIG)
  : defaultConfigPath;
const cookieName = "local_outline_session";

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
      `无法读取认证配置：${configPath}\n请复制 config/local-outline.config.example.json 为 config/local-outline.config.json 后再启动。\n${error instanceof Error ? error.message : String(error)}`,
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

  return {
    host: parsed.host || "127.0.0.1",
    port: Number(parsed.port || process.env.PORT || 4173),
    auth: {
      username: String(auth.username),
      passwordHash: String(auth.passwordHash),
      sessionSecret: String(auth.sessionSecret),
      sessionMaxAgeHours: Number(auth.sessionMaxAgeHours || 168),
      secureCookies: Boolean(auth.secureCookies),
    },
  };
};

const html = (body) => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Local Outline 登录</title>
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

const send = (response, statusCode, body, headers = {}) => {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(body);
};

const redirect = (response, location) => {
  response.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
  });
  response.end();
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
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
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
    return parsed.sub === config.auth.username && Number(parsed.exp) > Date.now();
  } catch {
    return false;
  }
};

const verifyPassword = (password, passwordHash) => {
  const [scheme, iterationText, salt, expectedHash] = passwordHash.split("$");
  if (scheme !== "pbkdf2" || !iterationText || !salt || !expectedHash) return false;
  const iterations = Number(iterationText);
  if (!Number.isFinite(iterations) || iterations < 100000) return false;
  const actual = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString(
    "base64url",
  );
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expectedHash);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
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
  <h1>Local Outline</h1>
  <p>请输入部署配置里的单用户账号。登录后才能访问你的本地优先大纲工具。</p>
  ${error ? `<div class="error">${error}</div>` : ""}
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

const serveStatic = async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const rawPathname = decodeURIComponent(url.pathname);
  const pathname = rawPathname === "/" ? "/index.html" : rawPathname;
  const filePath = path.normalize(path.join(distDir, pathname));

  if (!filePath.startsWith(distDir)) {
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
    "Content-Type": contentTypes[extension] || "application/octet-stream",
    "Cache-Control":
      extension === ".html" ? "no-store" : "private, max-age=31536000, immutable",
  });
  createReadStream(target).pipe(response);
};

const handleRequest = async (request, response, config) => {
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
    if (
      username === config.auth.username &&
      verifyPassword(password, config.auth.passwordHash)
    ) {
      response.writeHead(302, {
        Location: "/",
        "Set-Cookie": `${cookieName}=${encodeURIComponent(
          createSessionToken(config),
        )}; ${sessionCookieOptions(config)}`,
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

  if (
    (request.method === "POST" || request.method === "GET") &&
    url.pathname === "/auth/logout"
  ) {
    response.writeHead(302, {
      Location: "/login",
      "Set-Cookie": `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      "Cache-Control": "no-store",
    });
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/auth/status") {
    send(
      response,
      authed ? 200 : 401,
      JSON.stringify({ authenticated: authed }),
      { "Content-Type": "application/json; charset=utf-8" },
    );
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
    send(response, 405, "Method Not Allowed", {
      "Content-Type": "text/plain; charset=utf-8",
      Allow: "GET, HEAD",
    });
    return;
  }

  await serveStatic(request, response);
};

const config = await readConfig();

createServer((request, response) => {
  handleRequest(request, response, config).catch((error) => {
    console.error(error);
    send(response, 500, "Internal Server Error", {
      "Content-Type": "text/plain; charset=utf-8",
    });
  });
}).listen(config.port, config.host, () => {
  console.log(`Local Outline 已启动：http://${config.host}:${config.port}`);
  console.log(`认证配置：${configPath}`);
});
