import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pbkdf2Sync } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const waitForServer = async (baseUrl, child, output = []) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (child.exitCode !== null) {
      throw new Error(
        `auth server exited early with code ${child.exitCode}\n${output.join("")}`,
      );
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
  // A child killed by a signal keeps exitCode === null and sets signalCode.
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(resolve, 1000);
  });
};

// Child stdout can arrive after the first HTTP response, so poll for it.
const waitForOutput = async (output, expected, timeoutMs = 2000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const text = output.join("");
    if (typeof expected === "string" ? text.includes(expected) : expected.test(text)) {
      return text;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for server output ${expected}\n${output.join("")}`);
};

// A fixture owns the temp directory (config, sync database and session state
// file) and outlives individual server processes, so tests can restart the
// server against the same state.
const createAuthFixture = async (t, { syncEnabled = true, auth = {} } = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bike-auth-"));
  const fixture = {
    directory,
    configPath: path.join(directory, "bike.config.json"),
    statePath: path.join(directory, "state", "auth-session.json"),
    password: "correct horse battery staple",
    syncToken: "test sync device token",
    syncEnabled,
    auth,
    children: [],
  };
  t.after(async () => {
    for (const child of fixture.children) await stopServer(child);
    await fs.rm(directory, { recursive: true, force: true });
  });
  return fixture;
};

const writeAuthConfig = async (fixture, port) => {
  await fs.writeFile(
    fixture.configPath,
    JSON.stringify(
      {
        host: "127.0.0.1",
        port,
        auth: {
          username: "owner",
          passwordHash: makePasswordHash(fixture.password),
          sessionSecret: "auth-server-test-secret-32-characters-minimum",
          sessionMaxAgeHours: 1,
          secureCookies: false,
          trustProxyHeaders: true,
          // Keep session state inside the temp directory, never in data/.
          sessionStatePath: fixture.statePath,
          ...fixture.auth,
        },
        ...(fixture.syncEnabled
          ? {
              sync: {
                enabled: true,
                databasePath: path.join(fixture.directory, "bike-sync.sqlite"),
                deviceTokenHashes: [
                  {
                    name: "test-device",
                    hash: makePasswordHash(fixture.syncToken),
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
};

const launchAuthServer = async (fixture, { env = {} } = {}) => {
  const port = await getFreePort();
  await writeAuthConfig(fixture, port);
  const childEnv = { ...process.env, BIKE_CONFIG: fixture.configPath };
  delete childEnv.STATE_DIRECTORY;
  Object.assign(childEnv, env);
  const child = spawn(process.execPath, ["server/auth-server.mjs"], {
    cwd: projectRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  fixture.children.push(child);
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child, output);
  return { baseUrl, output, stop: () => stopServer(child) };
};

const startAuthServer = async (t, options = {}) => {
  const fixture = await createAuthFixture(t, options);
  return { ...fixture, ...(await launchAuthServer(fixture, options)) };
};

const cookieNamed = (response, name) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .find((cookie) => cookie.startsWith(`${name}=`));

const loginCookies = async (baseUrl, password, options = {}) => {
  const response = await postLogin(baseUrl, { password, ...options });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/");
  const session = cookieNamed(response, "bike_session");
  const device = cookieNamed(response, "bike_device");
  assert.match(session ?? "", /^bike_session=./);
  assert.match(device ?? "", /^bike_device=./);
  return { session, device };
};

const login = async (baseUrl, password, options = {}) =>
  (await loginCookies(baseUrl, password, options)).session;

const logout = async (baseUrl, cookie) => {
  const response = await fetch(`${baseUrl}/auth/logout`, {
    method: "POST",
    headers: cookie ? { Cookie: cookie } : {},
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/login");
  return response;
};

const postLogin = async (
  baseUrl,
  { username = "owner", password, forwardedFor, cookie } = {},
) => {
  const headers = {};
  if (forwardedFor) headers["X-Forwarded-For"] = forwardedFor;
  if (cookie) headers.Cookie = cookie;
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

const jsonRequest = async (
  baseUrl,
  path,
  { method = "GET", cookie, token, body, forwardedFor } = {},
) => {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (forwardedFor) headers["X-Forwarded-For"] = forwardedFor;
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

test("user-scoped login throttling answers untrusted clients before checking the password", async (t) => {
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

  // Same answer for the correct password, so 429 vs 302 is not an oracle.
  const validWhileUserLimited = await postLogin(baseUrl, {
    password,
    forwardedFor: "203.0.113.12",
  });
  assert.equal(validWhileUserLimited.status, 429);
  assert.equal(validWhileUserLimited.headers.get("set-cookie"), null);
});

test("trusted device cookie logs in while the user scope is throttled", async (t) => {
  const { baseUrl, password } = await startAuthServer(t);
  const { device } = await loginCookies(baseUrl, password, {
    forwardedFor: "198.51.100.20",
  });

  const attackerGuess = await postLogin(baseUrl, {
    password: "not the password",
    forwardedFor: "203.0.113.10",
  });
  assert.equal(attackerGuess.status, 401);

  const untrusted = await postLogin(baseUrl, {
    password,
    forwardedFor: "198.51.100.20",
  });
  assert.equal(untrusted.status, 429);

  const trusted = await postLogin(baseUrl, {
    password,
    forwardedFor: "198.51.100.20",
    cookie: device,
  });
  assert.equal(trusted.status, 302);
  assert.equal(trusted.headers.get("location"), "/");
  const session = cookieNamed(trusted, "bike_session");
  assert.equal((await status(baseUrl, session)).status, 200);
  const renewedDevice = cookieNamed(trusted, "bike_device");
  assert.match(renewedDevice ?? "", /^bike_device=./);
  assert.notEqual(renewedDevice, device);

  const deviceCookie = trusted.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("bike_device="));
  assert.match(deviceCookie, /; HttpOnly(;|$)/);
  assert.match(deviceCookie, /; SameSite=Strict(;|$)/);
  assert.match(deviceCookie, /; Path=\/(;|$)/);
  assert.match(deviceCookie, /; Max-Age=15552000(;|$)/);
});

test("trusted device failures only throttle that device", async (t) => {
  const { baseUrl, password } = await startAuthServer(t);
  const { device } = await loginCookies(baseUrl, password, {
    forwardedFor: "198.51.100.20",
  });

  const typo = await postLogin(baseUrl, {
    password: "typo",
    forwardedFor: "198.51.100.20",
    cookie: device,
  });
  assert.equal(typo.status, 401);

  const deviceRetry = await postLogin(baseUrl, {
    password,
    forwardedFor: "198.51.100.20",
    cookie: device,
  });
  assert.equal(deviceRetry.status, 429);

  // The device failure was not charged to the shared user and IP buckets.
  const untrusted = await postLogin(baseUrl, {
    password,
    forwardedFor: "198.51.100.20",
  });
  assert.equal(untrusted.status, 302);
});

test("username and IP churn cannot evict the owner's limit or block trusted devices", async (t) => {
  const fixture = await createAuthFixture(t);
  const clockPath = path.join(fixture.directory, "test-clock.mjs");
  await fs.writeFile(clockPath, `Date.now = () => ${Date.now()};\n`);
  const { baseUrl } = await launchAuthServer(fixture, {
    env: { NODE_OPTIONS: `--import=${pathToFileURL(clockPath).href}` },
  });
  const { password } = fixture;
  const { device } = await loginCookies(baseUrl, password);
  assert.equal((await postLogin(baseUrl, { password: "wrong" })).status, 401);
  assert.equal((await postLogin(baseUrl, { password })).status, 429);

  for (let batch = 0; batch < 26; batch += 1) {
    await Promise.all(Array.from({ length: 100 }, async (_, offset) => {
      const id = batch * 100 + offset;
      const response = await postLogin(baseUrl, {
        username: `unknown-${id}`,
        password: "wrong",
        forwardedFor: `198.18.${Math.floor(id / 256)}.${id % 256}`,
      });
      assert.ok(response.status === 401 || response.status === 429);
      await response.text();
    }));
  }

  const ownerRetry = await postLogin(baseUrl, { password });
  assert.equal(ownerRetry.status, 429);
  assert.equal(ownerRetry.headers.get("set-cookie"), null);
  const trusted = await postLogin(baseUrl, { password, cookie: device });
  assert.equal(trusted.status, 302);
});

test("login IP limit applies across different usernames", async (t) => {
  const { baseUrl, password } = await startAuthServer(t);
  assert.equal((await postLogin(baseUrl, { username: "unknown-a", password: "wrong" })).status, 401);
  assert.equal((await postLogin(baseUrl, { username: "unknown-b", password: "wrong" })).status, 429);
  assert.equal((await postLogin(baseUrl, { password })).status, 429);
});

test("authenticated static GET and HEAD reject malformed URL encoding without a server error", async (t) => {
  const { baseUrl, password, output } = await startAuthServer(t, { syncEnabled: false });
  const cookie = await login(baseUrl, password);
  for (const method of ["GET", "HEAD"]) {
    for (const pathname of ["/%", "/%E0%A4%A", "/assets/%FF.js"]) {
      const response = await fetch(`${baseUrl}${pathname}`, { method, headers: { Cookie: cookie } });
      assert.equal(response.status, 400, `${method} ${pathname}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(await response.text(), method === "HEAD" ? "" : "URL 编码无效");
    }
  }
  assert.equal((await status(baseUrl, cookie)).status, 200);
  assert.doesNotMatch(output.join(""), /URIError|Internal Server Error/);
});

test("forged or foreign device cookies are treated as untrusted", async (t) => {
  const { baseUrl, password } = await startAuthServer(t);
  const { session, device } = await loginCookies(baseUrl, password, {
    forwardedFor: "198.51.100.20",
  });

  const attackerGuess = await postLogin(baseUrl, {
    password: "not the password",
    forwardedFor: "203.0.113.10",
  });
  assert.equal(attackerGuess.status, 401);

  const [payload, signature] = decodeURIComponent(
    device.slice("bike_device=".length),
  ).split(".");
  const forgedPayload = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
      id: "attacker-chosen-device",
    }),
  ).toString("base64url");
  const candidates = [
    `bike_device=${forgedPayload}.${signature}`,
    // A session token is signed with a different key and is not a device cookie.
    `bike_device=${session.slice("bike_session=".length)}`,
  ];
  for (const cookie of candidates) {
    const response = await postLogin(baseUrl, {
      password,
      forwardedFor: "198.51.100.20",
      cookie,
    });
    assert.equal(response.status, 429, cookie);
  }

  // A genuine device cookie only counts for the username it was issued to, so
  // failures for another username must not be charged to the device bucket.
  const otherUser = await postLogin(baseUrl, {
    username: "someone-else",
    password: "not the password",
    forwardedFor: "198.51.100.20",
    cookie: device,
  });
  assert.equal(otherUser.status, 401);
  const trusted = await postLogin(baseUrl, {
    password,
    forwardedFor: "198.51.100.20",
    cookie: device,
  });
  assert.equal(trusted.status, 302);
});

test("logout revocation survives a server restart", async (t) => {
  const fixture = await createAuthFixture(t);

  const first = await launchAuthServer(fixture);
  const cookie = await login(first.baseUrl, fixture.password);
  await first.stop();

  // No logout recorded yet: a restart must not invalidate live sessions.
  const second = await launchAuthServer(fixture);
  assert.equal((await status(second.baseUrl, cookie)).status, 200);
  await logout(second.baseUrl, cookie);
  assert.equal((await status(second.baseUrl, cookie)).status, 401);

  const state = JSON.parse(await fs.readFile(fixture.statePath, "utf8"));
  assert.ok(Number.isSafeInteger(state.sessionRevokedBefore));
  assert.ok(state.sessionRevokedBefore > 0);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(fixture.statePath)).mode & 0o777, 0o600);
  }
  assert.deepEqual(await fs.readdir(path.dirname(fixture.statePath)), [
    "auth-session.json",
  ]);
  await second.stop();

  const third = await launchAuthServer(fixture);
  assert.equal((await status(third.baseUrl, cookie)).status, 401);
  const fresh = await login(third.baseUrl, fixture.password);
  assert.equal((await status(third.baseUrl, fresh)).status, 200);
});

test("unreadable session state revokes sessions issued before startup", async (t) => {
  const fixture = await createAuthFixture(t);

  const first = await launchAuthServer(fixture);
  const cookie = await login(first.baseUrl, fixture.password);
  await first.stop();

  await fs.mkdir(path.dirname(fixture.statePath), { recursive: true });
  await fs.writeFile(fixture.statePath, "{ not json", "utf8");

  const second = await launchAuthServer(fixture);
  await waitForOutput(second.output, /会话状态文件已损坏/);
  assert.equal((await status(second.baseUrl, cookie)).status, 401);
  const fresh = await login(second.baseUrl, fixture.password);
  assert.equal((await status(second.baseUrl, fresh)).status, 200);

  await logout(second.baseUrl, fresh);
  const repaired = JSON.parse(await fs.readFile(fixture.statePath, "utf8"));
  assert.ok(Number.isSafeInteger(repaired.sessionRevokedBefore));
});

test("logout still revokes in memory when the session state cannot be written", async (t) => {
  const fixture = await createAuthFixture(t);
  // The parent of the state file is a regular file, so mkdir -p fails.
  const blocker = path.join(fixture.directory, "not-a-directory");
  await fs.writeFile(blocker, "", "utf8");
  fixture.statePath = path.join(blocker, "auth-session.json");

  const server = await launchAuthServer(fixture);
  const cookie = await login(server.baseUrl, fixture.password);
  const response = await logout(server.baseUrl, cookie);
  assert.match(response.headers.get("set-cookie") ?? "", /^bike_session=;.*Max-Age=0/);
  assert.equal((await status(server.baseUrl, cookie)).status, 401);
  await waitForOutput(server.output, /无法写入会话状态文件/);
});

test("session state defaults to the first STATE_DIRECTORY entry", async (t) => {
  const fixture = await createAuthFixture(t, {
    auth: { sessionStatePath: undefined },
  });
  const stateDirectory = path.join(fixture.directory, "systemd-state");
  const unusedDirectory = path.join(fixture.directory, "unused-state");
  const expectedPath = path.join(stateDirectory, "auth-session.json");

  const server = await launchAuthServer(fixture, {
    env: { STATE_DIRECTORY: `${stateDirectory}:${unusedDirectory}` },
  });
  // Bail out before logging out if the path is wrong, so the test can never
  // write into the repository's data/ directory.
  await waitForOutput(server.output, `会话状态：${expectedPath}`);

  const cookie = await login(server.baseUrl, fixture.password);
  await logout(server.baseUrl, cookie);
  const state = JSON.parse(await fs.readFile(expectedPath, "utf8"));
  assert.ok(state.sessionRevokedBefore > 0);
  await assert.rejects(fs.access(unusedDirectory));
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

test("bearer token guessing is throttled per client while verified tokens keep working", async (t) => {
  const { baseUrl, syncToken } = await startAuthServer(t);
  // Only the entry appended by the trusted proxy identifies the client; the
  // spoofed prefixes below must not give the attacker fresh limiter keys.
  const proxiedFrom = (spoofed) => `${spoofed}, 203.0.113.50`;

  const verified = await jsonRequest(baseUrl, "/api/sync/manifest", {
    token: syncToken,
    forwardedFor: proxiedFrom("198.51.100.1"),
  });
  assert.equal(verified.status, 200);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const rejected = await jsonRequest(baseUrl, "/api/sync/manifest", {
      token: `wrong token ${attempt}`,
      forwardedFor: proxiedFrom(`10.0.0.${attempt}`),
    });
    assert.equal(rejected.status, 401);
  }

  const limited = await jsonRequest(baseUrl, "/api/sync/manifest", {
    token: "yet another wrong token",
    forwardedFor: proxiedFrom("10.0.1.1"),
  });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal((await readJson(limited)).error, "too_many_requests");

  const cached = await jsonRequest(baseUrl, "/api/sync/manifest", {
    token: syncToken,
    forwardedFor: proxiedFrom("10.0.2.2"),
  });
  assert.equal(cached.status, 200);

  const otherClient = await jsonRequest(baseUrl, "/api/sync/manifest", {
    token: "wrong token",
    forwardedFor: "198.51.100.99",
  });
  assert.equal(otherClient.status, 401);
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
