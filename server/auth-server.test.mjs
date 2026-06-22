import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pbkdf2Sync } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

const makePasswordHash = (password) => {
  const iterations = 100000;
  const salt = "auth-server-test-salt";
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString(
    "base64url",
  );
  return `pbkdf2$${iterations}$${salt}$${hash}`;
};

const waitForServer = async (baseUrl, child) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (child.exitCode !== null) {
      throw new Error(`auth server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/auth/status`);
      if (response.status === 401) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Timed out waiting for auth server");
};

const stopServer = async (child) => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(resolve, 1000);
  });
};

const startAuthServer = async (t, { syncEnabled = true } = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bike-auth-"));
  const port = await getFreePort();
  const password = "correct horse battery staple";
  const syncToken = "test sync device token";
  const configPath = path.join(directory, "bike.config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        host: "127.0.0.1",
        port,
        auth: {
          username: "owner",
          passwordHash: makePasswordHash(password),
          sessionSecret: "auth-server-test-secret-32-characters-minimum",
          sessionMaxAgeHours: 1,
          secureCookies: false,
          trustProxyHeaders: true,
        },
        ...(syncEnabled
          ? {
              sync: {
                enabled: true,
                databasePath: path.join(directory, "bike-sync.sqlite"),
                deviceTokenHashes: [
                  {
                    name: "test-device",
                    hash: makePasswordHash(syncToken),
                  },
                ],
              },
            }
          : {}),
      },
      null,
      2,
    ),
    "utf8",
  );

  const child = spawn(process.execPath, ["server/auth-server.mjs"], {
    cwd: projectRoot,
    env: { ...process.env, BIKE_CONFIG: configPath },
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
  return { baseUrl, output, password, syncToken };
};

const login = async (baseUrl, password) => {
  const response = await postLogin(baseUrl, { password });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/");
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.match(cookie ?? "", /^bike_session=/);
  return cookie;
};

const postLogin = async (
  baseUrl,
  { username = "owner", password, forwardedFor } = {},
) => {
  const headers = {};
  if (forwardedFor) headers["X-Forwarded-For"] = forwardedFor;
  return await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers,
    body: new URLSearchParams({ username, password }),
    redirect: "manual",
  });
};

const status = async (baseUrl, cookie) =>
  await fetch(`${baseUrl}/auth/status`, {
    headers: cookie ? { Cookie: cookie } : {},
  });

const jsonRequest = async (baseUrl, path, { method = "GET", cookie, token, body } = {}) => {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return await fetch(`${baseUrl}${path}`, {
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

test("anonymous logout does not revoke authenticated sessions", async (t) => {
  const { baseUrl, password } = await startAuthServer(t);
  const cookie = await login(baseUrl, password);

  assert.equal((await status(baseUrl, cookie)).status, 200);

  const anonymousLogout = await fetch(`${baseUrl}/auth/logout`, {
    method: "POST",
    redirect: "manual",
  });
  assert.equal(anonymousLogout.status, 302);
  assert.equal(anonymousLogout.headers.get("location"), "/login");

  assert.equal((await status(baseUrl, cookie)).status, 200);

  const authenticatedLogout = await fetch(`${baseUrl}/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie },
    redirect: "manual",
  });
  assert.equal(authenticatedLogout.status, 302);
  assert.equal(authenticatedLogout.headers.get("location"), "/login");
  assert.equal((await status(baseUrl, cookie)).status, 401);
});

test("user-scoped login throttling does not lock out valid credentials", async (t) => {
  const { baseUrl, password } = await startAuthServer(t);

  const wrong = await postLogin(baseUrl, {
    password: "not the password",
    forwardedFor: "203.0.113.10",
  });
  assert.equal(wrong.status, 401);

  const wrongWhileUserLimited = await postLogin(baseUrl, {
    password: "still wrong",
    forwardedFor: "203.0.113.11",
  });
  assert.equal(wrongWhileUserLimited.status, 429);

  const valid = await postLogin(baseUrl, {
    password,
    forwardedFor: "203.0.113.12",
  });
  assert.equal(valid.status, 302);
  assert.equal(valid.headers.get("location"), "/");
  assert.match(valid.headers.get("set-cookie") ?? "", /^bike_session=/);
});

test("sync API is disabled unless explicitly configured", async (t) => {
  const { baseUrl, password } = await startAuthServer(t, { syncEnabled: false });
  const cookie = await login(baseUrl, password);

  const response = await jsonRequest(baseUrl, "/api/sync/manifest", { cookie });
  assert.equal(response.status, 404);
  assert.deepEqual(await readJson(response), {
    error: "sync_disabled",
    message: "Sync API is disabled",
  });
});

test("sync API stores documents and rejects stale revisions", async (t) => {
  const { baseUrl, password } = await startAuthServer(t);

  const anonymous = await jsonRequest(baseUrl, "/api/sync/manifest");
  assert.equal(anonymous.status, 401);

  const cookie = await login(baseUrl, password);
  const emptyManifestResponse = await jsonRequest(baseUrl, "/api/sync/manifest", { cookie });
  assert.equal(emptyManifestResponse.status, 200);
  assert.deepEqual(await readJson(emptyManifestResponse), {
    workspaceRevision: 0,
    activeDocumentId: null,
    documentOrder: [],
    documents: [],
  });

  const createdResponse = await jsonRequest(baseUrl, "/api/documents/doc-a", {
    method: "PUT",
    cookie,
    body: {
      expectedRevision: null,
      document: sampleDocument(),
    },
  });
  assert.equal(createdResponse.status, 200);
  const created = await readJson(createdResponse);
  assert.equal(created.revision, 1);
  assert.equal(created.document.title, "测试文档");

  const staleCreateResponse = await jsonRequest(baseUrl, "/api/documents/doc-a", {
    method: "PUT",
    cookie,
    body: {
      expectedRevision: null,
      document: sampleDocument("doc-a", "不应覆盖"),
    },
  });
  assert.equal(staleCreateResponse.status, 409);
  assert.equal((await readJson(staleCreateResponse)).currentRevision, 1);

  const updatedDocument = sampleDocument("doc-a", "更新后的文档");
  updatedDocument.updatedAt = "2026-06-21T01:00:00.000Z";
  const updatedResponse = await jsonRequest(baseUrl, "/api/documents/doc-a", {
    method: "PUT",
    cookie,
    body: {
      expectedRevision: 1,
      document: updatedDocument,
    },
  });
  assert.equal(updatedResponse.status, 200);
  assert.equal((await readJson(updatedResponse)).revision, 2);

  const fetchedResponse = await jsonRequest(baseUrl, "/api/documents/doc-a", { cookie });
  assert.equal(fetchedResponse.status, 200);
  const fetched = await readJson(fetchedResponse);
  assert.equal(fetched.revision, 2);
  assert.equal(fetched.document.title, "更新后的文档");

  const manifestResponse = await jsonRequest(baseUrl, "/api/sync/manifest", { cookie });
  const manifest = await readJson(manifestResponse);
  assert.equal(manifest.workspaceRevision, 1);
  assert.equal(manifest.activeDocumentId, "doc-a");
  assert.deepEqual(manifest.documentOrder, ["doc-a"]);
  assert.equal(manifest.documents[0].revision, 2);

  const patchedManifestResponse = await jsonRequest(baseUrl, "/api/sync/manifest", {
    method: "PATCH",
    cookie,
    body: {
      expectedRevision: 1,
      activeDocumentId: "doc-a",
      documentOrder: ["doc-a"],
    },
  });
  assert.equal(patchedManifestResponse.status, 200);
  assert.equal((await readJson(patchedManifestResponse)).workspaceRevision, 2);

  const staleManifestResponse = await jsonRequest(baseUrl, "/api/sync/manifest", {
    method: "PATCH",
    cookie,
    body: {
      expectedRevision: 1,
      activeDocumentId: "doc-a",
      documentOrder: ["doc-a"],
    },
  });
  assert.equal(staleManifestResponse.status, 409);
  assert.equal((await readJson(staleManifestResponse)).currentRevision, 2);

  const deletedResponse = await jsonRequest(baseUrl, "/api/documents/doc-a", {
    method: "DELETE",
    cookie,
    body: { expectedRevision: 2 },
  });
  assert.equal(deletedResponse.status, 200);
  assert.equal((await readJson(deletedResponse)).revision, 3);

  const deletedFetchResponse = await jsonRequest(baseUrl, "/api/documents/doc-a", { cookie });
  assert.equal(deletedFetchResponse.status, 410);
});

test("sync API accepts configured bearer device tokens", async (t) => {
  const { baseUrl, syncToken } = await startAuthServer(t);

  const rejected = await jsonRequest(baseUrl, "/api/sync/manifest", {
    token: "wrong token",
  });
  assert.equal(rejected.status, 401);

  const accepted = await jsonRequest(baseUrl, "/api/sync/manifest", {
    token: syncToken,
  });
  assert.equal(accepted.status, 200);
  assert.equal((await readJson(accepted)).workspaceRevision, 0);
});

test("sync operation log appends and reads document operations", async (t) => {
  const { baseUrl, password } = await startAuthServer(t);
  const cookie = await login(baseUrl, password);

  const createdResponse = await jsonRequest(baseUrl, "/api/documents/doc-a", {
    method: "PUT",
    cookie,
    body: {
      expectedRevision: null,
      document: sampleDocument(),
    },
  });
  assert.equal(createdResponse.status, 200);

  const appendedResponse = await jsonRequest(baseUrl, "/api/documents/doc-a/operations", {
    method: "POST",
    cookie,
    body: {
      baseRevision: 1,
      actorId: "macbook",
      operations: [
        { type: "node.update_text", nodeId: "node-a", text: "A" },
        { type: "node.set_checked", nodeId: "node-a", checked: true },
      ],
    },
  });
  assert.equal(appendedResponse.status, 200);
  const appended = await readJson(appendedResponse);
  assert.equal(appended.currentRevision, 1);
  assert.deepEqual(appended.operations.map((operation) => operation.sequence), [1, 2]);

  const sinceOneResponse = await jsonRequest(baseUrl, "/api/documents/doc-a/operations?after=1", { cookie });
  assert.equal(sinceOneResponse.status, 200);
  const sinceOne = await readJson(sinceOneResponse);
  assert.equal(sinceOne.operations.length, 1);
  assert.equal(sinceOne.operations[0].sequence, 2);
  assert.equal(sinceOne.operations[0].operation.type, "node.set_checked");

  const updatedDocument = sampleDocument("doc-a", "更新后的文档");
  const updatedResponse = await jsonRequest(baseUrl, "/api/documents/doc-a", {
    method: "PUT",
    cookie,
    body: {
      expectedRevision: 1,
      document: updatedDocument,
    },
  });
  assert.equal(updatedResponse.status, 200);

  const staleOperationResponse = await jsonRequest(baseUrl, "/api/documents/doc-a/operations", {
    method: "POST",
    cookie,
    body: {
      baseRevision: 1,
      actorId: "ipad",
      operations: [{ type: "node.update_text", nodeId: "node-a", text: "stale" }],
    },
  });
  assert.equal(staleOperationResponse.status, 409);
  assert.equal((await readJson(staleOperationResponse)).currentRevision, 2);
});
