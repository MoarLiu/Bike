import assert from "node:assert/strict";
import test from "node:test";
import { createBackupService } from "./backup-service.cjs";

const hash = (value) => `hash:${value}`;

test("a local source pause cancels main-process retries until an authoritative source resumes", async () => {
  const { service, files } = memoryService();
  await service.setAuto(true);
  await service.pauseSource();
  assert.equal(service.status().paused, "local-source");
  assert.equal((await service.enqueue({ workspace: { id: "saved" }, sourceRevision: 2, wait: true })).code, "paused");
  assert.equal(files.size, 0);
  assert.equal((await service.enqueue({ workspace: { id: "saved" }, sourceRevision: 2, resumeSource: true, wait: true })).ok, true);
  assert.equal(service.status().paused, null);
  files.set("/icloud/bike-workspace.json", JSON.stringify({ id: "external" }));
  await service.enqueue({ workspace: { id: "next" }, sourceRevision: 3, wait: true });
  assert.equal(service.status().paused, "external-change");
  await service.pauseSource();
  assert.equal(service.status().paused, "external-change");
  assert.equal((await service.enqueue({ workspace: { id: "next" }, sourceRevision: 3, resumeSource: true, wait: true })).code, "paused");
});

test("a reopened renderer may reuse a source receipt with a fresh main-process ticket", async () => {
  const { service } = memoryService();
  await service.setAuto(true);
  await service.enqueue({ workspace: { id: "saved" }, sourceRevision: 5, ticket: 12, wait: true });
  await service.pauseSource();
  const resumed = await service.enqueue({ workspace: { id: "saved" }, sourceRevision: 5, ticket: 1, allocateNext: true, resumeSource: true, wait: true });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.ticket, 13);
  assert.equal(resumed.code, "unchanged");
  assert.equal(service.status().paused, null);
});

test("a completed ticket cannot be replayed with older content", async () => {
  const { service, files } = memoryService();
  await service.setAuto(true);
  await service.enqueue({ workspace: { id: "newer" }, ticket: 7, wait: true });
  const old = await service.enqueue({ workspace: { id: "older" }, ticket: 7, wait: true });
  assert.equal(old.code, "stale-source");
  assert.match(files.get("/icloud/bike-workspace.json"), /newer/);
});

test("source revisions order windows even when their counters collide or restart", async () => {
  const { service, files } = memoryService();
  await service.setAuto(true);
  assert.equal((await service.enqueue({ workspace: { id: "newer" }, sourceRevision: 12, ticket: 7, wait: true })).ok, true);
  const stale = await service.enqueue({ workspace: { id: "older" }, sourceRevision: 11, ticket: 100, allocateNext: true, wait: true });
  assert.equal(stale.code, "stale-source");
  const collision = await service.enqueue({ workspace: { id: "wrong" }, sourceRevision: 12, ticket: 100, wait: true });
  assert.equal(collision.code, "stale-source");
  const next = await service.enqueue({ workspace: { id: "latest" }, sourceRevision: 13, ticket: 7, wait: true });
  assert.equal(next.ok, true);
  assert.equal(next.ticket, 8);
  assert.match(files.get("/icloud/bike-workspace.json"), /latest/);
});

test("accepting an external baseline rechecks the file and saved content before resuming", async () => {
  const { service, files, savedSources } = memoryService();
  await service.setAuto(true);
  await service.enqueue({ workspace: { id: "local" }, sourceRevision: 1, wait: true });
  files.set("/icloud/bike-workspace.json", JSON.stringify({ id: "external" }));
  await service.enqueue({ workspace: { id: "edit" }, sourceRevision: 2, wait: true });
  const inspected = await service.inspect();
  savedSources.set("window", { sourceRevision: 3, workspace: { id: "external" } });
  const wrong = await service.acceptBaseline(inspected.fileHash, { ownerId: "window", ticket: 3, sourceRevision: 3, workspace: { id: "wrong" } });
  assert.equal(wrong.code, "stale-source");
  assert.equal(service.status().paused, "external-change");
  const accepted = await service.acceptBaseline(inspected.fileHash, { ownerId: "window", ticket: 3, sourceRevision: 3, workspace: { id: "external" } });
  assert.equal(accepted.ok, true);
  assert.equal(service.status().paused, null);
  assert.equal((await service.enqueue({ workspace: { id: "next edit" }, sourceRevision: 4, wait: true })).ok, true);
  assert.match(files.get("/icloud/bike-workspace.json"), /next edit/);
  savedSources.set("window", { sourceRevision: 5, workspace: { id: "external" } });
  const changed = await service.acceptBaseline(inspected.fileHash, { ownerId: "window", ticket: 5, sourceRevision: 5, workspace: { id: "external" } });
  assert.equal(changed.code, "external-change");
});

test("backup queue writes W2 after W1 and rejects a stale ticket", async () => {
  const files = new Map();
  let settings = "";
  let releaseFirst;
  let writes = 0;
  const service = createBackupService({
    fs: {
      mkdir: async () => {},
      readFile: async (filePath) => {
        if (!files.has(filePath)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return files.get(filePath);
      },
      readdir: async () => [],
      stat: async () => ({ mtimeMs: 0 }),
      rm: async () => {},
    },
    path: { join: (...parts) => parts.join("/") },
    getDirectory: async () => "/icloud",
    workspaceFilename: "bike-workspace.json",
    stampedPrefix: "bike-workspace-",
    lock: async (_filePath, callback) => {
      writes += 1;
      if (writes === 1) await new Promise((resolve) => { releaseFirst = resolve; });
      return callback();
    },
    writeAtomic: async (filePath, content) => { files.set(filePath, content); },
    hash,
    now: () => 0,
    readSettings: async () => settings,
    writeSettings: async (value) => { settings = value; },
    migrate: async (workspace) => workspace,
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  await service.setAuto(true);
  const first = service.enqueue({ workspace: { id: "W1" }, ticket: 1, wait: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await service.enqueue({ workspace: { id: "W2" }, ticket: 2, wait: false });
  assert.equal(second.code, "queued");
  const stale = await service.enqueue({ workspace: { id: "old" }, ticket: 1, wait: false });
  assert.equal(stale.code, "stale-source");
  releaseFirst();
  assert.equal((await first).code, "queued");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(files.get("/icloud/bike-workspace.json"), /W2/);
});


function memoryService() {
  const files = new Map();
  let settings = "";
  let currentNow = 0;
  const timers = [];
  const savedSources = new Map();
  const service = createBackupService({
    fs: {
      mkdir: async () => {},
      readFile: async (filePath) => {
        if (!files.has(filePath)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return files.get(filePath);
      },
      readdir: async () => [...files.keys()].map((filePath) => ({
        name: filePath.split("/").at(-1),
        isFile: () => true,
      })),
      stat: async () => ({ mtimeMs: currentNow }),
      rm: async (filePath) => { files.delete(filePath); },
    },
    path: { join: (...parts) => parts.join("/") },
    getDirectory: async () => "/icloud",
    workspaceFilename: "bike-workspace.json",
    stampedPrefix: "bike-workspace-",
    lock: async (_filePath, callback) => callback(),
    writeAtomic: async (filePath, content) => { files.set(filePath, content); },
    hash,
    now: () => currentNow,
    readSettings: async () => settings,
    writeSettings: async (value) => { settings = value; },
    migrate: async (workspace) => workspace,
    verifySavedSource: async ({ ownerId, sourceRevision, workspace }) => {
      const saved = savedSources.get(ownerId);
      return saved?.sourceRevision === sourceRevision && JSON.stringify(saved.workspace) === JSON.stringify(workspace);
    },
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  return { service, files, timers, savedSources, setNow: (value) => { currentNow = value; } };
}

test("forged revisions and old-window baselines cannot cancel or raise the normal backup floor", async () => {
  const { service, files, savedSources } = memoryService();
  await service.setAuto(true);
  await service.enqueue({ workspace: { id: "local" }, sourceRevision: 10, wait: true });
  const inspected = await service.inspect();
  savedSources.set("current", { workspace: { id: "local" }, sourceRevision: 10 });
  for (const input of [
    { ownerId: "old", sourceRevision: 10 },
    { ownerId: "current", sourceRevision: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.equal((await service.acceptBaseline(inspected.fileHash, { ...input, ticket: 999, workspace: { id: "local" } })).code, "stale-source");
  }
  assert.equal(service.status().lastTicket, 1);
  assert.equal((await service.enqueue({ workspace: { id: "next" }, sourceRevision: 11, wait: true })).ok, true);
  assert.match(files.get("/icloud/bike-workspace.json"), /next/);
});

test("external file changes pause automatic backup instead of overwriting", async () => {
  const { service, files } = memoryService();
  await service.setAuto(true);
  await service.enqueue({ workspace: { id: "local" }, ticket: 1, manual: true, wait: true });
  files.set("/icloud/bike-workspace.json", "{\"id\":\"agent\"}\n");
  const blocked = await service.enqueue({ workspace: { id: "newer" }, ticket: 2, manual: false, wait: true });
  assert.equal(blocked.code, "external-change");
  assert.equal(files.get("/icloud/bike-workspace.json"), "{\"id\":\"agent\"}\n");
  assert.equal(service.status().paused, "external-change");
  const retried = await service.enqueue({ workspace: { id: "newer" }, ticket: 3, manual: false, wait: true });
  assert.equal(retried.code, "paused");
});

test("replacing an external file rechecks its hash and keeps a copy", async () => {
  const { service, files } = memoryService();
  files.set("/icloud/bike-workspace.json", "{\"id\":\"agent\"}\n");
  const inspected = await service.inspect();
  files.set("/icloud/bike-workspace.json", "{\"id\":\"changed again\"}\n");
  const rejected = await service.replaceWithLocal({
    workspace: { id: "local" },
    expectedFileHash: inspected.fileHash,
    ticket: 4,
  });
  assert.equal(rejected.code, "external-change");
  assert.match(files.get("/icloud/bike-workspace.json"), /changed again/);
  const current = await service.inspect();
  const replaced = await service.replaceWithLocal({
    workspace: { id: "local" },
    expectedFileHash: current.fileHash,
    ticket: 5,
  });
  assert.equal(replaced.code, "ok");
  assert.match(files.get("/icloud/bike-workspace.json"), /local/);
  assert.ok([...files.keys()].some((filePath) => filePath.includes("external-")));
});

test("identical content does not create another workspace file", async () => {
  const { service, files } = memoryService();
  await service.setAuto(true);
  await service.enqueue({ workspace: { id: "same" }, ticket: 1, manual: true, wait: true });
  const before = files.size;
  const second = await service.enqueue({ workspace: { id: "same" }, ticket: 2, manual: false, wait: true });
  assert.equal(second.code, "unchanged");
  assert.equal(files.size, before);
});


test("a failed backup retry cannot roll back a newer successful backup", async () => {
  const files = new Map();
  let settings = "";
  let failures = 1;
  const timers = [];
  const service = createBackupService({
    fs: {
      mkdir: async () => {},
      readFile: async (filePath) => {
        if (!files.has(filePath)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return files.get(filePath);
      },
      readdir: async () => [],
      stat: async () => ({ mtimeMs: 0 }),
      rm: async () => {},
    },
    path: { join: (...parts) => parts.join("/") },
    getDirectory: async () => "/icloud",
    workspaceFilename: "bike-workspace.json",
    stampedPrefix: "bike-workspace-",
    lock: async (_filePath, callback) => callback(),
    writeAtomic: async (filePath, content) => {
      if (failures > 0) {
        failures -= 1;
        throw Object.assign(new Error("disk failure"), { code: "EIO" });
      }
      files.set(filePath, content);
    },
    hash,
    now: () => 0,
    readSettings: async () => settings,
    writeSettings: async (value) => { settings = value; },
    migrate: async (workspace) => workspace,
    setTimer: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  await service.setAuto(true);
  assert.equal((await service.enqueue({ workspace: { id: "W1" }, ticket: 1, wait: true })).ok, false);
  assert.equal((await service.enqueue({ workspace: { id: "W2" }, ticket: 2, wait: true })).code, "ok");
  for (const callback of [...timers]) callback();
  assert.equal(timers.length, 0);
  assert.match(files.get("/icloud/bike-workspace.json"), /W2/);
});

test("a restarted renderer receives the next ticket instead of a stale rejection", async () => {
  const { service } = memoryService();
  await service.setAuto(true);
  await service.enqueue({ workspace: { id: "saved" }, ticket: 20, manual: true, wait: true });
  const restarted = await service.enqueue({ workspace: { id: "next" }, ticket: 1, allocateNext: true, wait: true });
  assert.equal(restarted.code, "ok");
  assert.equal(restarted.ticket, 21);
});

test("matching content still adopts an externally changed baseline", async () => {
  const { service, files } = memoryService();
  await service.setAuto(true);
  await service.enqueue({ workspace: { id: "local" }, ticket: 1, manual: true, wait: true });
  const serialized = `${JSON.stringify({ id: "local" }, null, 2)}\n`;
  files.set("/icloud/bike-workspace.json", serialized.replace("local", "local"));
  const result = await service.enqueue({ workspace: { id: "local" }, ticket: 2, wait: true });
  assert.equal(result.code, "unchanged");
  assert.equal(service.status().paused, null);
  assert.equal(service.status().baselineHash, hash(files.get("/icloud/bike-workspace.json")));
});
