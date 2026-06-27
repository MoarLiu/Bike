import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPbkdf2Hash, verifyPassword } from "./password.mjs";
import { handleSyncApi, sendJson } from "./sync-api.mjs";
import { createSyncStore } from "./sync-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const defaultConfigPath = path.join(projectRoot, "config", "bike-sync.config.json");
const defaultDatabasePath = path.join(projectRoot, "data", "bike-sync.sqlite");
const configPath = process.env.BIKE_SYNC_CONFIG
  ? path.resolve(process.env.BIKE_SYNC_CONFIG)
  : defaultConfigPath;

const normalizeTokenHashes = (value) =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        if (typeof entry === "string") return [entry];
        if (entry && typeof entry === "object" && typeof entry.hash === "string") {
          return [entry.hash];
        }
        return [];
      })
    : [];

const resolveProjectPath = (value, fallback) =>
  value ? path.resolve(projectRoot, String(value)) : fallback;

const normalizeOrigins = (value) =>
  Array.isArray(value)
    ? value
        .filter((origin) => typeof origin === "string")
        .map((origin) => origin.trim().replace(/\/+$/, ""))
        .filter(Boolean)
    : [];

const readConfig = async () => {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `无法读取同步服务配置：${configPath}\n请复制 config/bike-sync.config.example.json 为 config/bike-sync.config.json，或运行 npm run setup:sync。\n${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const sync = parsed.sync && typeof parsed.sync === "object" ? parsed.sync : parsed;
  const cors = parsed.cors && typeof parsed.cors === "object"
    ? parsed.cors
    : sync.cors && typeof sync.cors === "object"
      ? sync.cors
      : {};
  const deviceTokenHashes = normalizeTokenHashes(sync.deviceTokenHashes);
  for (const hash of deviceTokenHashes) {
    if (!isPbkdf2Hash(String(hash))) {
      throw new Error("deviceTokenHashes 必须由 npm run auth:hash 或 npm run setup:sync 生成");
    }
  }

  return {
    host: parsed.host || sync.host || "127.0.0.1",
    port: Number(parsed.port || sync.port || process.env.PORT || 4174),
    owner: {
      username: String(parsed.owner?.username || sync.owner?.username || "me"),
    },
    sync: {
      databasePath: resolveProjectPath(sync.databasePath, defaultDatabasePath),
      deviceTokenHashes,
      maxBodyBytes: Number(sync.maxBodyBytes || 10 * 1024 * 1024),
    },
    cors: {
      enabled: cors.enabled !== false,
      allowedOrigins: normalizeOrigins(cors.allowedOrigins),
    },
  };
};

const corsHeadersFor = (request, config) => {
  if (!config.cors.enabled) return {};
  const origin = String(request.headers.origin || "").replace(/\/+$/, "");
  if (!origin) return {};
  const allowsAnyOrigin = config.cors.allowedOrigins.includes("*");
  const allowed = allowsAnyOrigin || config.cors.allowedOrigins.includes(origin);
  if (!allowed) return {};
  return {
    "Access-Control-Allow-Origin": allowsAnyOrigin ? "*" : origin,
    "Access-Control-Allow-Methods": "GET, PATCH, PUT, DELETE, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    ...(allowsAnyOrigin ? {} : { "Access-Control-Allow-Credentials": "true" }),
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
};

const isApiAuthenticated = async (request, config) => {
  const authorization = String(request.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match || !config.sync.deviceTokenHashes.length) return false;
  for (const hash of config.sync.deviceTokenHashes) {
    if (await verifyPassword(match[1], hash)) return true;
  }
  return false;
};

const handleRequest = async (request, response, config, syncStore) => {
  const url = new URL(request.url, "http://localhost");
  const corsHeaders = corsHeadersFor(request, config);

  if (request.method === "OPTIONS") {
    if (request.headers.origin && !corsHeaders["Access-Control-Allow-Origin"]) {
      sendJson(response, 403, {
        error: "cors_origin_denied",
        message: "CORS origin is not allowed",
      });
      return;
    }
    response.writeHead(204, corsHeaders);
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, {
      ok: true,
      service: "bike-sync-server",
      owner: config.owner.username,
    }, corsHeaders);
    return;
  }

  if (!url.pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "not_found", message: "Route not found" }, corsHeaders);
    return;
  }

  if (!(await isApiAuthenticated(request, config))) {
    sendJson(response, 401, { error: "unauthorized", message: "Unauthorized" }, corsHeaders);
    return;
  }

  await handleSyncApi(request, response, config, syncStore, { headers: corsHeaders });
};

const config = await readConfig();
const syncStore = await createSyncStore(config.sync.databasePath);

if (!config.sync.deviceTokenHashes.length) {
  console.warn("警告：同步服务未配置 deviceTokenHashes，API 会拒绝所有同步客户端。");
}

const server = createServer((request, response) => {
  handleRequest(request, response, config, syncStore).catch((error) => {
    console.error(error);
    sendJson(response, 500, { error: "internal_server_error", message: "Internal Server Error" });
  });
});

const shutdown = () => {
  server.close(() => {
    syncStore.close();
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(config.port, config.host, () => {
  console.log(`Bike 同步服务已启动：http://${config.host}:${config.port}`);
  console.log(`同步服务配置：${configPath}`);
  console.log(`同步数据库：${config.sync.databasePath}`);
});
