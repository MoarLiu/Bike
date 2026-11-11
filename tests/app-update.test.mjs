import assert from "node:assert/strict";
import test from "node:test";
import { installFakeBrowserStorage } from "./helpers/fake-browser.mjs";
import { loadAppCallback, loadTypescriptIsolated } from "./helpers/typescript.mjs";
import * as knowledge from "../shared/bike-knowledge.mjs";

const fixture = (workspace = { version: 1, activeDocumentId: "doc", documents: [{ id: "doc", nodes: [] }] }) => {
  const shell = { inert: false };
  const saved = [];
  const bindings = {
    ready: true, loadError: null, workspaceRef: { current: workspace }, updateInstallRef: { current: null },
    storageConflictRef: { current: false }, recoveryBusyRef: { current: false },
    backupLocalPauseRef: { current: null }, backupScheduleRef: { current: knowledge.createBackupSchedule() },
    compositionActiveRef: { current: false }, operationCommitRef: { current: false },
    syncBusyRef: { current: false }, historyBusyRef: { current: false }, attachmentImportRef: { current: null },
    flushPendingEditsRef: { current: () => workspace }, setRecoveryBusy() {}, clearAutoSyncTimer() {},
    document: { querySelector: () => shell },
    saveWorkspaceToStorage: async (value) => { saved.push(value); return { ok: true, target: "indexeddb" }; },
    showSaveResult() {}, flushScheduledBackup: async () => {},
  };
  bindings.releaseUpdateLock = loadAppCallback("releaseUpdateLock", bindings);
  bindings.saveWorkspace = loadAppCallback("saveWorkspace", bindings);
  return { bindings, workspace, shell, saved, prepare: () => loadAppCallback("prepareUpdateInstall", bindings)() };
};

async function backupFixture(t, bridgeName = "bike") {
  const env = installFakeBrowserStorage(t);
  const storage = loadTypescriptIsolated("src/storage.ts");
  const initial = {
    version: 1, activeDocumentId: "doc", documents: [{
      id: "doc", title: "Before", createdAt: "2026-11-11T00:00:00Z", updatedAt: "2026-11-11T00:00:00Z",
      nodes: [{ id: "node", text: "Before", children: [] }],
    }],
  };
  env.idb.seed("bike-db", { workspace: initial, "workspace-meta": { revision: 4 } });
  const original = (await storage.loadWorkspace()).workspace;
  const latest = {
    ...original, documents: [{ ...original.documents[0], title: "Final draft",
      nodes: [{ ...original.documents[0].nodes[0], text: "Final draft" }] }],
  };
  const f = fixture(latest);
  const writes = [], notices = [];
  let didSave;
  const saved = new Promise((resolve) => { didSave = resolve; });
  const bridge = { enqueueBackup: async (request) => {
    writes.push(request);
    return { ok: true, ticket: writes.length };
  } };
  Object.assign(f.bindings, knowledge, {
    backupScheduleRef: { current: { ...knowledge.createBackupSchedule(), enabled: true } },
    backupPayloadsRef: { current: new Map() }, backupFlightRef: { current: null },
    backupTicketRef: { current: 0 }, backupTicketReadyRef: { current: true }, backupErrorNoticeRef: { current: null },
    window: { [bridgeName]: bridge }, refreshRecoverySnapshots() {}, armBackupTimer() {},
    showNotice: (message) => notices.push(message),
    getWorkspaceSaveRevision: storage.getWorkspaceSaveRevision,
    saveWorkspaceToStorage: async (value) => {
      f.saved.push(value);
      const result = await storage.saveWorkspace(value);
      didSave(result);
      return result;
    },
  });
  for (const name of ["pauseLocalBackup", "runBackupJob", "dispatchBackup", "flushScheduledBackup", "showSaveResult", "saveWorkspace"]) {
    f.bindings[name] = loadAppCallback(name, f.bindings);
  }
  return { ...f, ...env, storage, original, latest, writes, notices, bridge, saved };
}

test("update preparation saves the current draft and freezes editing until installation", async () => {
  const f = fixture();
  assert.equal((await f.prepare()).ok, true);
  assert.equal(f.saved[0], f.workspace);
  assert.equal(f.bindings.updateInstallRef.current, f.workspace);
  assert.equal(f.shell.inert, true);
  assert.equal(f.bindings.recoveryBusyRef.current, true);
  const other = { ...f.workspace };
  assert.equal((await f.bindings.saveWorkspace(other)).ok, false);
  assert.equal(f.saved.length, 1);
  f.bindings.releaseUpdateLock();
  assert.equal(f.shell.inert, false);
  assert.equal(f.bindings.recoveryBusyRef.current, false);
});

test("update preparation refuses conflicts, in-flight imports and fallback-only saves", async () => {
  const loading = fixture();
  loading.bindings.ready = false;
  assert.deepEqual(JSON.parse(JSON.stringify(await loading.prepare())), { ok: false, loading: true });
  loading.bindings.loadError = "load failed";
  assert.equal((await loading.prepare()).loading, undefined);
  assert.equal((await loading.prepare()).ok, false);
  assert.equal(loading.saved.length, 0);
  for (const key of ["compositionActiveRef", "operationCommitRef", "storageConflictRef", "syncBusyRef", "historyBusyRef", "attachmentImportRef"]) {
    const f = fixture();
    f.bindings[key].current = true;
    assert.equal((await f.prepare()).ok, false);
    assert.equal(f.saved.length, 0);
  }
  const f = fixture();
  f.bindings.saveWorkspaceToStorage = async () => ({ ok: true, target: "localstorage" });
  assert.equal((await f.prepare()).ok, false);
  assert.equal(f.shell.inert, false);
  assert.equal(f.bindings.updateInstallRef.current, null);
});

test("update preparation resumes after composition commits", async () => {
  const f = fixture();
  f.bindings.compositionActiveRef.current = true;
  assert.equal((await f.prepare()).ok, false);
  assert.equal(f.saved.length, 0);
  assert.equal(f.shell.inert, false);
  f.bindings.compositionActiveRef.current = false;
  assert.equal((await f.prepare()).ok, true);
  assert.equal(f.saved.length, 1);
  f.bindings.releaseUpdateLock();
});

test("an aborted preparation cannot acknowledge a later save as ready to install", async () => {
  const f = fixture();
  let finish;
  f.bindings.saveWorkspaceToStorage = () => new Promise((resolve) => { finish = resolve; });
  const operation = f.prepare();
  f.bindings.releaseUpdateLock();
  finish({ ok: true, target: "indexeddb" });
  assert.equal((await operation).ok, false);
  assert.equal(f.shell.inert, false);
});

for (const bridgeName of ["bike", "localOutline"]) {
  test(`${bridgeName} preparation backs up the final IndexedDB revision before acknowledging close`, async (t) => {
    const f = await backupFixture(t, bridgeName);
    let finish, started;
    const backingUp = new Promise((resolve) => { started = resolve; });
    f.bridge.enqueueBackup = (request) => {
      f.writes.push(request);
      started();
      return new Promise((resolve) => { finish = () => resolve({ ok: true, ticket: 10 }); });
    };
    let completed = false;
    const preparing = f.prepare().then((result) => { completed = true; return result; });
    await f.saved;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.writes.length, 1, "the final authoritative save must enter the backup queue while editing is frozen");
    await backingUp;
    assert.equal(completed, false);
    assert.equal(f.shell.inert, true);
    assert.equal(f.writes[0].workspace, f.latest);
    assert.equal(f.writes[0].sourceRevision, 5);
    assert.equal(f.writes[0].sourceRevision, f.idb.read("bike-db", "workspace-meta").revision);
    assert.equal(f.writes[0].wait, true);
    finish();
    assert.equal((await preparing).ok, true);
    assert.equal(f.bindings.backupScheduleRef.current.lastHash, knowledge.backupContentHash(f.latest));
    assert.equal(f.bindings.backupPayloadsRef.current.size, 0);
    f.bindings.releaseUpdateLock();
  });
}

test("preparation drains an older in-flight backup and then its final pending revision", async (t) => {
  const f = await backupFixture(t);
  const releases = [];
  f.bridge.enqueueBackup = (request) => {
    f.writes.push(request);
    return new Promise((resolve) => { releases.push(() => resolve({ ok: true, ticket: f.writes.length })); });
  };
  f.bindings.showSaveResult({ ok: true, target: "indexeddb" }, f.original);
  const previous = f.bindings.flushScheduledBackup();
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].sourceRevision, 4);
  const preparing = f.prepare();
  await f.saved;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(f.bindings.backupScheduleRef.current.pending);
  assert.equal(f.writes.length, 1);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[1].workspace, f.latest);
  assert.equal(f.writes[1].sourceRevision, 5);
  assert.equal(f.shell.inert, true);
  releases.shift()();
  assert.equal((await preparing).ok, true);
  await previous;
  assert.equal(f.bindings.backupScheduleRef.current.pending, null);
  assert.equal(f.bindings.backupScheduleRef.current.writing, null);
  f.bindings.releaseUpdateLock();
});

test("an authoritative pending backup may drain while preparation is still saving its final revision", async (t) => {
  const f = await backupFixture(t);
  const save = f.bindings.saveWorkspaceToStorage;
  let releaseSave;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  f.bindings.saveWorkspaceToStorage = async (value) => { await saveGate; return save(value); };
  f.bindings.showSaveResult({ ok: true, target: "indexeddb" }, f.original);
  const preparing = f.prepare();
  await f.bindings.flushScheduledBackup();
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].workspace, f.original);
  assert.equal(f.bindings.backupScheduleRef.current.paused, null);
  releaseSave();
  assert.equal((await preparing).ok, true);
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[1].workspace, f.latest);
  assert.equal(f.writes[1].sourceRevision, 5);
  f.bindings.releaseUpdateLock();
});

test("an external change reported by an older in-flight backup prevents the final pending write", async (t) => {
  const f = await backupFixture(t);
  let finish;
  f.bridge.enqueueBackup = (request) => {
    f.writes.push(request);
    return new Promise((resolve) => { finish = () => resolve({ ok: false, code: "external-change", error: "External backup changed" }); });
  };
  f.bindings.showSaveResult({ ok: true, target: "indexeddb" }, f.original);
  const previous = f.bindings.flushScheduledBackup();
  const preparing = f.prepare();
  await f.saved;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(f.bindings.backupScheduleRef.current.pending);
  finish();
  assert.equal((await preparing).ok, false);
  await previous;
  assert.equal(f.writes.length, 1);
  assert.equal(f.bindings.backupScheduleRef.current.paused, "external-change");
  assert.equal(f.bindings.backupScheduleRef.current.writing, null);
  assert.equal(f.bindings.backupScheduleRef.current.pending, null);
  assert.equal(f.shell.inert, false);
  assert.equal(f.bindings.updateInstallRef.current, null);
});

for (const code of ["write-failed", "external-change", "stale-source"]) {
  test(`preparation releases editing and refuses close when its required backup returns ${code}`, async (t) => {
    const f = await backupFixture(t);
    f.bridge.enqueueBackup = async (request) => {
      f.writes.push(request);
      return { ok: false, code, error: "Backup was not committed" };
    };
    assert.equal((await f.prepare()).ok, false);
    assert.equal(f.writes.length, 1);
    assert.equal(f.shell.inert, false);
    assert.equal(f.bindings.recoveryBusyRef.current, false);
    assert.equal(f.bindings.updateInstallRef.current, null);
    assert.equal(f.idb.read("bike-db", "workspace").documents[0].title, "Final draft");
    assert.notEqual(f.bindings.backupScheduleRef.current.lastHash, knowledge.backupContentHash(f.latest));
    if (code === "external-change") assert.equal(f.bindings.backupScheduleRef.current.paused, "external-change");
    if (code === "write-failed") {
      f.bridge.enqueueBackup = async () => ({ ok: true, ticket: 12 });
      assert.equal((await f.prepare()).ok, true);
      f.bindings.releaseUpdateLock();
    }
  });
}

test("preparation releases its lock when the required backup throws", async (t) => {
  const f = await backupFixture(t);
  f.bridge.enqueueBackup = async () => { throw new Error("Native backup unavailable"); };
  assert.equal((await f.prepare()).ok, false);
  assert.equal(f.shell.inert, false);
  assert.equal(f.bindings.updateInstallRef.current, null);
  assert.equal(f.bindings.recoveryBusyRef.current, false);
});

test("preparation respects disabled and already paused automatic backups", async (t) => {
  for (const pause of [null, "external-change", "recovering", "save-failed"]) {
    const f = await backupFixture(t);
    if (pause === null) f.bindings.backupScheduleRef.current.enabled = false;
    else {
      f.bindings.backupLocalPauseRef.current = pause;
      f.bindings.backupScheduleRef.current.paused = pause;
    }
    assert.equal((await f.prepare()).ok, true);
    assert.equal(f.writes.length, 0);
    assert.equal(f.bindings.backupScheduleRef.current.paused, pause);
    f.bindings.releaseUpdateLock();
  }
});

test("preparation accepts an already confirmed semantic backup without another write", async (t) => {
  const f = await backupFixture(t);
  f.bindings.backupScheduleRef.current.lastHash = knowledge.backupContentHash(f.latest);
  assert.equal((await f.prepare()).ok, true);
  assert.equal(f.writes.length, 0);
  f.bindings.releaseUpdateLock();
});

test("preparation never backs up a failed or fallback-only save and always releases editing", async (t) => {
  for (const result of [
    { ok: false, error: new Error("Local storage failed") },
    { ok: false, conflict: true, error: new Error("Another page changed storage") },
    { ok: true, target: "localstorage" },
  ]) {
    const f = await backupFixture(t);
    f.bindings.saveWorkspaceToStorage = async () => result;
    assert.equal((await f.prepare()).ok, false);
    assert.equal(f.writes.length, 0);
    assert.equal(f.shell.inert, false);
    assert.equal(f.bindings.updateInstallRef.current, null);
    assert.equal(f.bindings.recoveryBusyRef.current, false);
  }
});

test("the preparation exemption never permits an unrelated recovery or a changed workspace to back up", async (t) => {
  const f = await backupFixture(t);
  f.bindings.recoveryBusyRef.current = true;
  f.bindings.showSaveResult({ ok: true, target: "indexeddb" }, f.original);
  assert.equal(f.bindings.backupScheduleRef.current.pending, null);
  f.bindings.updateInstallRef.current = f.latest;
  f.bindings.workspaceRef.current = f.original;
  f.bindings.showSaveResult({ ok: true, target: "indexeddb" }, f.original);
  assert.equal(f.bindings.backupScheduleRef.current.pending, null);
  f.bindings.backupPayloadsRef.current.set(1, f.original);
  await f.bindings.runBackupJob({ ticket: 1, hash: knowledge.backupContentHash(f.original) });
  assert.equal(f.writes.length, 0);
  assert.equal(f.bindings.backupScheduleRef.current.paused, "storage-conflict");
});
