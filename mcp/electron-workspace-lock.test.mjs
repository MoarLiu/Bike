import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  acquireWorkspaceWriteLock,
  workspaceLockPath,
  writeFileAtomically,
} = require("../electron/workspace-lock.cjs");

const makeWorkspacePath = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "localoutline-electron-lock-"));
  return path.join(directory, "localoutline-workspace.json");
};

test("electron workspace helper writes files atomically and removes temp files", async () => {
  const workspacePath = await makeWorkspacePath();
  await writeFileAtomically(workspacePath, "{\"version\":1}\n");

  assert.equal(await fs.readFile(workspacePath, "utf8"), "{\"version\":1}\n");
  const entries = await fs.readdir(path.dirname(workspacePath));
  assert.deepEqual(
    entries.filter((entry) => entry.endsWith(".tmp")),
    [],
  );
});

test("electron workspace lock release does not delete another owner lock", async () => {
  const workspacePath = await makeWorkspacePath();
  const lockPath = workspaceLockPath(workspacePath);
  const release = await acquireWorkspaceWriteLock(workspacePath);
  const replacementLock = `${JSON.stringify(
    {
      pid: process.pid,
      ownerToken: "replacement-owner",
      createdAt: "2026-06-05T08:00:00.000Z",
      workspacePath: path.basename(workspacePath),
    },
    null,
    2,
  )}\n`;

  await fs.writeFile(lockPath, replacementLock, "utf8");
  await release();
  assert.equal(await fs.readFile(lockPath, "utf8"), replacementLock);
  await fs.unlink(lockPath);
});

test("electron workspace lock release requires exact lock content", async () => {
  const workspacePath = await makeWorkspacePath();
  const lockPath = workspaceLockPath(workspacePath);
  const release = await acquireWorkspaceWriteLock(workspacePath);
  const originalReadFile = fs.readFile;
  const originalLock = JSON.parse(await originalReadFile(lockPath, "utf8"));
  const replacementLock = `${JSON.stringify(
    {
      ...originalLock,
      pid: process.pid + 1,
      createdAt: "2026-06-05T08:00:00.000Z",
    },
    null,
    2,
  )}\n`;

  let lockReads = 0;
  fs.readFile = async (...args) => {
    const result = await originalReadFile(...args);
    if (args[0] === lockPath && lockReads++ === 0) {
      await fs.writeFile(lockPath, replacementLock, "utf8");
    }
    return result;
  };
  try {
    await release();
  } finally {
    fs.readFile = originalReadFile;
  }
  assert.equal(await originalReadFile(lockPath, "utf8"), replacementLock);
  await fs.unlink(lockPath);
});

test("electron workspace lock times out while another writer owns it", async () => {
  const workspacePath = await makeWorkspacePath();
  const release = await acquireWorkspaceWriteLock(workspacePath);
  try {
    await assert.rejects(
      acquireWorkspaceWriteLock(workspacePath, {
        timeoutMs: 5,
        staleMs: 60_000,
        retryMs: 1,
      }),
      /正在被另一个 LocalOutline 写入/,
    );
  } finally {
    await release();
  }
});

test("electron workspace lock can recover stale locks", async () => {
  const workspacePath = await makeWorkspacePath();
  const lockPath = workspaceLockPath(workspacePath);
  await fs.writeFile(
    lockPath,
    `${JSON.stringify(
      {
        pid: 0,
        ownerToken: "stale-owner",
        createdAt: "2026-06-05T08:00:00.000Z",
        workspacePath: path.basename(workspacePath),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const oldTime = new Date(Date.now() - 60_000);
  await fs.utimes(lockPath, oldTime, oldTime);
  const release = await acquireWorkspaceWriteLock(workspacePath, {
    timeoutMs: 100,
    staleMs: 1,
    retryMs: 1,
  });

  await release();
  await assert.rejects(fs.stat(lockPath), /ENOENT/);
});
