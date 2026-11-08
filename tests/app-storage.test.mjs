import assert from "node:assert/strict";
import test from "node:test";
import { installFakeBrowserStorage } from "./helpers/fake-browser.mjs";
import { loadAppCallback, loadTypescript, loadTypescriptIsolated } from "./helpers/typescript.mjs";

const { migrateWorkspace } = loadTypescript("src/migrations.ts");
const workspace = (text) => migrateWorkspace({
  version: 1, activeDocumentId: "doc", documents: [{
    id: "doc", title: text, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    nodes: [{ id: "node", text, children: [] }],
  }],
});

async function fixture(t) {
  const env = installFakeBrowserStorage(t);
  env.idb.seed("bike-db", { workspace: workspace("original"), "workspace-meta": { revision: 1 } });
  const storage = loadTypescriptIsolated("src/storage.ts");
  const fromStorage = (await storage.loadWorkspace()).workspace;
  const other = loadTypescriptIsolated("src/storage.ts");
  await other.loadWorkspace();
  const backups = [];
  const notices = [];
  const bindings = {
    ...storage,
    ready: true,
    storageConflictRef: { current: false },
    syncBusyRef: { current: false },
    recoveryBusyRef: { current: false },
    workspaceRef: { current: fromStorage },
    refreshedWorkspaceRef: { current: null },
    activeNodeIdRef: { current: "node" },
    syncConfig: { serverUrl: "http://fixture.invalid" },
    flushPendingEdits: () => bindings.workspaceRef.current,
    replaceWorkspace: (value) => { bindings.workspaceRef.current = value; },
    setStorageConflict: () => {},
    setRecoveryBusy: () => {},
    setShowRecoverySnapshots: () => {},
    setActiveNodeId: () => {},
    setFocusNodeId: () => {},
    setSyncState: () => {},
    loadSyncState: () => ({}),
    findNode: (nodes, id) => nodes.find((node) => node.id === id),
    firstNodeIdInWorkspace: (value) => value.documents[0].nodes[0].id,
    clearAutoSyncTimer: () => {},
    clearEditHistory: () => {},
    refreshRecoverySnapshots: () => {},
    showNotice: (text) => notices.push(text),
    downloadWorkspaceBackup: (value, reason) => backups.push({ workspace: value, reason }),
    window: { confirm: () => true },
  };
  for (const name of ["handleStorageConflict", "refreshFromStorage"]) {
    bindings[name] = loadAppCallback(name, bindings);
  }
  storage.subscribeToWorkspaceConflicts(bindings.handleStorageConflict);
  return {
    ...env, bindings, storage, other, backups, notices,
    stored: () => env.idb.read("bike-db", "workspace"),
    callback: (name) => loadAppCallback(name, bindings),
    async conflict() {
      const edited = workspace("A's fallback edits");
      bindings.workspaceRef.current = edited;
      env.idb.failPut({ db: "bike-db", key: "workspace", times: 1 });
      assert.equal((await storage.saveWorkspace(edited)).target, "localstorage");
      env.idb.resetFailures();
      await other.saveWorkspace(workspace("B's saved edits"));
      return storage.listWorkspaceRecoverySnapshots()[0];
    },
  };
}

test("a newer page save immediately surfaces a conflict after a fallback save succeeded", async (t) => {
  const f = await fixture(t);
  await f.conflict();
  await f.bindings.refreshFromStorage();
  assert.equal(f.bindings.storageConflictRef.current, true);
  assert.equal(f.bindings.workspaceRef.current.documents[0].title, "A's fallback edits");
  assert.equal(f.stored().documents[0].title, "B's saved edits");
  const reopened = loadTypescriptIsolated("src/storage.ts");
  const latest = await reopened.loadWorkspace();
  assert.equal(latest.workspace.documents[0].title, "B's saved edits");
  assert.equal(reopened.listWorkspaceRecoverySnapshots(latest.workspace)[0].workspace.documents[0].title, "A's fallback edits");
});

test("recovery keeps both replacement backups and saves the selected copy only after confirmation", async (t) => {
  const f = await fixture(t);
  const selected = await f.conflict();
  f.bindings.window.confirm = () => false;
  await f.callback("restoreRecoverySnapshot")(selected);
  assert.equal(f.backups.length, 0);
  assert.equal(f.stored().documents[0].title, "B's saved edits");

  f.bindings.window.confirm = () => true;
  await f.callback("restoreRecoverySnapshot")(selected);
  assert.deepEqual(f.backups.map((item) => item.workspace.documents[0].title), ["A's fallback edits", "B's saved edits"]);
  assert.equal(f.stored().documents[0].title, "A's fallback edits");
  assert.equal(f.bindings.workspaceRef.current.documents[0].title, "A's fallback edits");
  assert.equal(f.storage.listWorkspaceRecoverySnapshots().length, 0);
  assert.equal(f.bindings.storageConflictRef.current, false);
});

test("a concurrent save during recovery is refused and all fallback edits remain recoverable", async (t) => {
  const f = await fixture(t);
  const selected = await f.conflict();
  f.bindings.loadWorkspace = async (options) => {
    const loaded = await f.storage.loadWorkspace(options);
    await f.other.saveWorkspace(workspace("B's concurrent edit"));
    return loaded;
  };
  await f.callback("restoreRecoverySnapshot")(selected);
  assert.equal(f.stored().documents[0].title, "B's concurrent edit");
  assert.equal(f.bindings.workspaceRef.current.documents[0].title, "A's fallback edits");
  assert.equal(f.storage.listWorkspaceRecoverySnapshots()[0].workspace.documents[0].title, "A's fallback edits");
  assert.equal(f.bindings.storageConflictRef.current, true);
  assert.ok(f.notices.some((notice) => notice.includes("恢复备用副本失败")));
});

test("temporary recovery after reopening preserves the original snapshot until an IndexedDB save succeeds", async (t) => {
  const f = await fixture(t);
  const selected = await f.conflict();
  const reopened = loadTypescriptIsolated("src/storage.ts");
  Object.assign(f.bindings, reopened);
  f.bindings.workspaceRef.current = (await reopened.loadWorkspace()).workspace;
  f.idb.failPut({ db: "bike-db", key: "workspace" });
  await f.callback("restoreRecoverySnapshot")(selected);
  assert.equal(f.stored().documents[0].title, "B's saved edits");
  assert.ok(f.storage.listWorkspaceRecoverySnapshots().some((snapshot) => snapshot.id === selected.id));
  assert.equal(f.bindings.workspaceRef.current.documents[0].title, "A's fallback edits");
  f.idb.resetFailures();
  await reopened.saveWorkspace(f.bindings.workspaceRef.current);
  assert.equal(f.storage.listWorkspaceRecoverySnapshots().length, 0);
  assert.equal(f.stored().documents[0].title, "A's fallback edits");
});
