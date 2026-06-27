import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSecretHash } from "./password.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const getFreePort = async () =>
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Unable to allocate test port"));
          return;
        }
        resolve(address.port);
      });
    });
  });

const waitForServer = async (baseUrl, child) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (child.exitCode !== null) {
      throw new Error(`sync server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.status === 200) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Timed out waiting for sync server");
};

const stopServer = async (child) => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(resolve, 1000);
  });
};

const startSyncServer = async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bike-sync-"));
  const port = await getFreePort();
  const syncToken = "test sync device token";
  const configPath = path.join(directory, "bike-sync.config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        host: "127.0.0.1",
        port,
        owner: {
          username: "owner",
        },
        databasePath: path.join(directory, "bike-sync.sqlite"),
        deviceTokenHashes: [
          {
            name: "test-device",
            hash: createSecretHash(syncToken, { iterations: 100000 }),
          },
        ],
        cors: {
          enabled: true,
          allowedOrigins: ["http://127.0.0.1:4173"],
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const child = spawn(process.execPath, ["server/sync-server.mjs"], {
    cwd: projectRoot,
    env: { ...process.env, BIKE_SYNC_CONFIG: configPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  t.after(async () => {
    await stopServer(child);
    await fs.rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child);
  return { baseUrl, output, syncToken };
};

const jsonRequest = async (
  baseUrl,
  requestPath,
  { method = "GET", token, body, origin } = {},
) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
};

const readJson = async (response) => JSON.parse(await response.text());

const sampleDocument = (id = "doc-a", title = "测试文档") => ({
  id,
  title,
  createdAt: "2026-06-21T00:00:00.000Z",
  updatedAt: "2026-06-21T00:00:00.000Z",
  nodes: [
    {
      id: "node-a",
      text: "主题",
      note: "",
      checked: false,
      collapsed: false,
      color: "plain",
      children: [],
    },
  ],
});

test("standalone sync server authenticates bearer tokens and serves CORS", async (t) => {
  const { baseUrl, syncToken } = await startSyncServer(t);

  const preflight = await fetch(`${baseUrl}/api/sync/manifest`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://127.0.0.1:4173",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization, content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:4173");

  const rejected = await jsonRequest(baseUrl, "/api/sync/manifest", {
    token: "wrong token",
    origin: "http://127.0.0.1:4173",
  });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get("access-control-allow-origin"), "http://127.0.0.1:4173");

  const accepted = await jsonRequest(baseUrl, "/api/sync/manifest", {
    token: syncToken,
    origin: "http://127.0.0.1:4173",
  });
  assert.equal(accepted.status, 200);
  assert.equal((await readJson(accepted)).workspaceRevision, 0);
});

test("standalone sync server stores documents and rejects stale revisions", async (t) => {
  const { baseUrl, syncToken } = await startSyncServer(t);

  const createdResponse = await jsonRequest(baseUrl, "/api/documents/doc-a", {
    method: "PUT",
    token: syncToken,
    body: {
      expectedRevision: null,
      document: sampleDocument(),
    },
  });
  assert.equal(createdResponse.status, 200);
  assert.equal((await readJson(createdResponse)).revision, 1);

  const staleResponse = await jsonRequest(baseUrl, "/api/documents/doc-a", {
    method: "PUT",
    token: syncToken,
    body: {
      expectedRevision: null,
      document: sampleDocument("doc-a", "不应覆盖"),
    },
  });
  assert.equal(staleResponse.status, 409);
  assert.equal((await readJson(staleResponse)).currentRevision, 1);
});
