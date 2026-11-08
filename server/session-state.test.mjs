import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSessionStateStore,
  loadSessionRevokedBefore,
  resolveSessionStatePath,
  saveSessionRevokedBefore,
} from "./session-state.mjs";

const projectRoot = path.resolve("/srv/bike");

const tempDirectory = async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bike-session-state-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
};

const recordingLogger = () => {
  const errors = [];
  return { errors, error: (message) => errors.push(String(message)) };
};

test("session state path prefers config, then STATE_DIRECTORY, then data/", () => {
  assert.equal(
    resolveSessionStatePath({
      configuredPath: "state/auth.json",
      projectRoot,
      env: { STATE_DIRECTORY: "/var/lib/bike-web" },
    }),
    path.join(projectRoot, "state", "auth.json"),
  );
  assert.equal(
    resolveSessionStatePath({ configuredPath: "/etc/bike/auth.json", projectRoot, env: {} }),
    path.resolve("/etc/bike/auth.json"),
  );
  assert.equal(
    resolveSessionStatePath({
      configuredPath: "  ",
      projectRoot,
      env: { STATE_DIRECTORY: "/var/lib/bike-web:/var/lib/other" },
    }),
    path.resolve("/var/lib/bike-web/auth-session.json"),
  );
  assert.equal(
    resolveSessionStatePath({ projectRoot, env: { STATE_DIRECTORY: "" } }),
    path.join(projectRoot, "data", "auth-session.json"),
  );
  assert.equal(
    resolveSessionStatePath({ projectRoot, env: {} }),
    path.join(projectRoot, "data", "auth-session.json"),
  );
});

test("a missing state file means nothing has been revoked", async (t) => {
  const directory = await tempDirectory(t);
  const logger = recordingLogger();
  assert.equal(
    await loadSessionRevokedBefore(path.join(directory, "missing", "auth-session.json"), {
      now: () => 12345,
      logger,
    }),
    0,
  );
  assert.deepEqual(logger.errors, []);
});

test("corrupt or unreadable state revokes everything issued before startup", async (t) => {
  const directory = await tempDirectory(t);
  const statePath = path.join(directory, "auth-session.json");
  const cases = [
    "{ not json",
    "",
    "null",
    JSON.stringify({ sessionRevokedBefore: "soon" }),
    JSON.stringify({ sessionRevokedBefore: -1 }),
    JSON.stringify({ sessionRevokedBefore: 1.5 }),
    JSON.stringify({ sessionRevokedBefore: 2 ** 60 }),
    JSON.stringify({}),
  ];
  for (const contents of cases) {
    await fs.writeFile(statePath, contents, "utf8");
    const logger = recordingLogger();
    assert.equal(
      await loadSessionRevokedBefore(statePath, { now: () => 12345, logger }),
      12345,
      contents,
    );
    assert.equal(logger.errors.length, 1);
    assert.match(logger.errors[0], /会话状态文件已损坏/);
  }

  // A directory where the file should be cannot be read either.
  const directoryPath = path.join(directory, "is-a-directory");
  await fs.mkdir(directoryPath);
  const logger = recordingLogger();
  assert.equal(
    await loadSessionRevokedBefore(directoryPath, { now: () => 12345, logger }),
    12345,
  );
  assert.match(logger.errors[0], /无法读取会话状态文件/);
});

test("saving creates parent directories and writes a private file atomically", async (t) => {
  const directory = await tempDirectory(t);
  const statePath = path.join(directory, "nested", "state", "auth-session.json");

  await saveSessionRevokedBefore(statePath, 1_700_000_000_000);
  assert.equal(await loadSessionRevokedBefore(statePath), 1_700_000_000_000);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
  }

  await saveSessionRevokedBefore(statePath, 1_700_000_000_001);
  assert.equal(await loadSessionRevokedBefore(statePath), 1_700_000_000_001);
  assert.deepEqual(await fs.readdir(path.dirname(statePath)), ["auth-session.json"]);
});

test("a failed save leaves no temp files behind", async (t) => {
  const directory = await tempDirectory(t);
  // The target is a non-empty directory, so the final rename fails.
  const statePath = path.join(directory, "auth-session.json");
  await fs.mkdir(statePath);
  await fs.writeFile(path.join(statePath, "keep"), "", "utf8");

  await assert.rejects(saveSessionRevokedBefore(statePath, 1));
  assert.deepEqual(await fs.readdir(directory), ["auth-session.json"]);
});

test("the store serializes writes so the latest value wins", async (t) => {
  const directory = await tempDirectory(t);
  const store = createSessionStateStore(path.join(directory, "auth-session.json"));
  await Promise.all([store.save(1), store.save(2), store.save(3)]);
  assert.equal(await store.load(), 3);
});
