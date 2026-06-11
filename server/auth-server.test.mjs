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

const startAuthServer = async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bike-auth-"));
  const port = await getFreePort();
  const password = "correct horse battery staple";
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
  return { baseUrl, output, password };
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
