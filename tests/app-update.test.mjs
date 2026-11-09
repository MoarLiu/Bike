import assert from "node:assert/strict";
import test from "node:test";
import { loadAppCallback } from "./helpers/typescript.mjs";

const fixture = () => {
  const workspace = { version: 1, activeDocumentId: "doc", documents: [{ id: "doc", nodes: [] }] };
  const shell = { inert: false };
  const saved = [];
  const bindings = {
    ready: true, workspaceRef: { current: workspace }, updateInstallRef: { current: null },
    storageConflictRef: { current: false }, recoveryBusyRef: { current: false },
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
  for (const key of ["storageConflictRef", "syncBusyRef", "historyBusyRef", "attachmentImportRef"]) {
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
