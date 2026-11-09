import assert from "node:assert/strict";
import test from "node:test";
import { loadAppCallback } from "./helpers/typescript.mjs";
import { loadTypescript } from "./helpers/typescript.mjs";

const { retainLocalTrash } = loadTypescript("src/trash.ts");
const { sameWorkspaceContent } = loadTypescript("src/documentSignature.ts");

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const initialWorkspace = () => ({ version: 1, activeDocumentId: "doc", documents: [{ id: "doc", title: "original", nodes: [] }] });

function fixture() {
  const initial = initialWorkspace();
  const remote = deferred();
  const started = deferred();
  const saves = [];
  const states = [];
  const notices = [];
  let retries = 0;
  let pendingDraft;
  const bindings = {
    sameWorkspaceContent,
    syncBusyRef: { current: false },
    storageConflictRef: { current: false },
    recoveryBusyRef: { current: false },
    historyBusyRef: { current: false },
    workspaceRef: { current: initial },
    syncConfig: { serverUrl: "http://fixture.invalid", token: "fixture", autoSync: true },
    syncState: { documentRevisions: {} },
    loadSyncState: () => bindings.syncState,
    autoSyncDirtyRef: { current: false },
    flushPendingEdits: () => {
      if (pendingDraft) { bindings.workspaceRef.current = pendingDraft; pendingDraft = undefined; }
      return bindings.workspaceRef.current;
    },
    usesDesktopSyncProxy: () => true,
    setSyncBusy: () => {},
    persistSyncState: (state) => { states.push(state); },
    applySyncedWorkspace: (workspace) => { bindings.workspaceRef.current = workspace; },
    captureSyncSnapshots: () => {},
    retainLocalTrash,
    clearEditHistory: () => {},
    saveWorkspace: async (workspace) => { saves.push(workspace); return { ok: true, target: "indexeddb" }; },
    showNotice: (message) => { notices.push(message); },
    summarizeSyncResult: () => "synced",
    syncErrorMessage: (error) => error.message,
    scheduleAutoSync: () => { retries += 1; },
    syncWorkspaceWithRemote: async (_workspace, _config, _state, options) => {
      started.resolve(options);
      return remote.promise;
    },
    pullWorkspaceFromRemote: async () => { started.resolve(); return remote.promise; },
    window: { confirm: () => true },
    exportWorkspace: () => ({ content: "{}", mime: "application/json" }),
    downloadText: () => {},
  };
  return {
    bindings, initial, remote, started, saves, states, notices,
    retries: () => retries,
    setDraft: (workspace) => { pendingDraft = workspace; },
    callback: (name = "syncNow") => loadAppCallback(name, bindings),
    result: (workspace = { ...initial, documents: [{ ...initial.documents[0], title: "downloaded" }] }) => ({
      workspace, state: { documentRevisions: { doc: 2 } },
      summary: { uploaded: 0, downloaded: 1, deleted: 0, conflicts: [] },
    }),
  };
}

test("sync retains edits made while a request is pending and keeps upload checkpoints", async () => {
  const f = fixture();
  const operation = f.callback()();
  const options = await f.started.promise;
  const checkpoint = { documentRevisions: { uploaded: 1 } };
  options.onCheckpoint(checkpoint);
  const edited = { ...f.initial, documents: [{ ...f.initial.documents[0], title: "new edit" }] };
  f.bindings.workspaceRef.current = edited;
  f.remote.resolve(f.result());
  await operation;
  assert.equal(f.bindings.workspaceRef.current, edited);
  assert.deepEqual(f.states, [checkpoint]);
  assert.deepEqual(f.saves, [f.initial]);
  assert.equal(f.retries(), 1);
  assert.equal(f.bindings.syncBusyRef.current, false);
});

test("zero-change sync uses the real result application and preserves selection, focus and workspace identity", async () => {
  const f = fixture();
  const active = { id: "selected", text: "Selected", children: [] };
  f.initial.documents[0].nodes = [active];
  const selections = [], focuses = [];
  Object.assign(f.bindings, {
    ...loadTypescript("src/tree.ts"), ...loadTypescript("src/documentSignature.ts"),
    activeNodeIdRef: { current: active.id }, focusNodeId: active.id,
    syncAppliedWorkspaceRef: { current: null },
    replaceWorkspace: (value) => { f.bindings.workspaceRef.current = value; },
    setActiveNodeId: (id) => selections.push(id), setFocusNodeId: (id) => focuses.push(id),
    firstNodeIdInWorkspace: (value) => value.documents[0].nodes[0]?.id ?? null,
  });
  f.bindings.applySyncedWorkspace = f.callback("applySyncedWorkspace");
  const operation = f.callback()();
  await f.started.promise;
  f.remote.resolve({ ...f.result(f.initial), summary: { uploaded: 0, downloaded: 0, deleted: 0, conflicts: [] } });
  await operation;
  assert.equal(f.bindings.workspaceRef.current, f.initial);
  assert.deepEqual(selections, []);
  assert.deepEqual(focuses, []);
  assert.equal(f.saves.length, 1);
  assert.equal(f.retries(), 0);
  assert.equal(f.bindings.autoSyncDirtyRef.current, false);
});

test("edits made while sync snapshots are being saved are retained", async () => {
  const f = fixture();
  const snapshotGate = deferred();
  const snapshotStarted = deferred();
  f.bindings.captureSyncSnapshots = async () => {
    snapshotStarted.resolve();
    await snapshotGate.promise;
  };
  const operation = f.callback()();
  await f.started.promise;
  f.remote.resolve(f.result());
  await snapshotStarted.promise;
  const edited = { ...f.initial, documents: [{ ...f.initial.documents[0], title: "edited during snapshot" }] };
  f.bindings.workspaceRef.current = edited;
  snapshotGate.resolve();
  await operation;
  assert.equal(f.bindings.workspaceRef.current, edited);
  assert.deepEqual(f.states, []);
  assert.equal(f.retries(), 1);
});

test("manual pull retains local trash and archives missing documents", async () => {
  const f = fixture();
  const deleted = { ...f.initial.documents[0], id: "deleted", title: "Deleted" };
  f.bindings.workspaceRef.current = {
    ...f.initial,
    trash: [{ id: "trash-existing", document: deleted, deletedAt: new Date().toISOString(), originalIndex: 0 }],
  };
  const operation = f.callback("pullRemoteWorkspace")();
  await f.started.promise;
  const remoteDocument = { ...f.initial.documents[0], id: "remote", title: "Remote" };
  f.remote.resolve(f.result({ ...f.initial, activeDocumentId: "remote", documents: [remoteDocument] }));
  await operation;
  const restored = f.bindings.workspaceRef.current;
  assert.equal(restored.documents[0].id, "remote");
  assert.deepEqual(restored.trash.map((entry) => entry.document.id), ["doc", "deleted"]);
  assert.equal(f.saves[0], restored);
});

test("sync flushes pending editor drafts before deciding whether to apply downloads", async () => {
  const f = fixture();
  const operation = f.callback()();
  await f.started.promise;
  const edited = { ...f.initial, documents: [{ ...f.initial.documents[0], title: "uncommitted draft" }] };
  f.setDraft(edited);
  f.remote.resolve(f.result());
  await operation;
  assert.equal(f.bindings.workspaceRef.current, edited);
  assert.equal(f.states.length, 0);
});

test("sync cannot resurrect a document deleted while waiting", async () => {
  const f = fixture();
  const operation = f.callback()();
  await f.started.promise;
  const edited = { version: 1, activeDocumentId: "new", documents: [{ id: "new", title: "replacement", nodes: [] }] };
  f.bindings.workspaceRef.current = edited;
  f.remote.resolve(f.result());
  await operation;
  assert.equal(f.bindings.workspaceRef.current, edited);
  assert.equal(f.states.length, 0);
});

test("download revisions are persisted only after the workspace save succeeds", async () => {
  const f = fixture();
  const save = deferred();
  f.bindings.saveWorkspace = async (workspace) => {
    f.saves.push(workspace);
    return f.saves.length === 1 ? { ok: true } : save.promise;
  };
  const operation = f.callback()();
  await f.started.promise;
  const result = f.result({ ...f.initial, documents: [{ ...f.initial.documents[0], title: "downloaded" }] });
  f.remote.resolve(result);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.states.length, 0);
  save.resolve({ ok: true });
  await operation;
  assert.deepEqual(f.states, [result.state]);
});

test("failed local save does not acknowledge downloads or report success", async () => {
  const f = fixture();
  f.bindings.saveWorkspace = async (workspace) => {
    f.saves.push(workspace);
    return f.saves.length === 1 ? { ok: true } : { ok: false, error: new Error("disk full") };
  };
  const operation = f.callback()();
  await f.started.promise;
  f.remote.resolve(f.result());
  await operation;
  assert.equal(f.states.length, 0);
  assert.ok(f.notices.some((message) => message.includes("disk full")));
  assert.ok(!f.notices.includes("synced"));
});

test("edits made during the final save remain current and trigger another sync", async () => {
  const f = fixture();
  const save = deferred();
  f.bindings.saveWorkspace = async (workspace) => {
    f.saves.push(workspace);
    return f.saves.length === 1 ? { ok: true } : save.promise;
  };
  const operation = f.callback()();
  await f.started.promise;
  const result = f.result({ ...f.initial, documents: [{ ...f.initial.documents[0], title: "downloaded" }] });
  f.remote.resolve(result);
  await new Promise((resolve) => setImmediate(resolve));
  const edited = { ...result.workspace, documents: [{ ...result.workspace.documents[0], title: "edit during save" }] };
  f.bindings.workspaceRef.current = edited;
  save.resolve({ ok: true });
  await operation;
  assert.equal(f.bindings.workspaceRef.current, edited);
  assert.deepEqual(f.states, [result.state]);
  assert.equal(f.bindings.autoSyncDirtyRef.current, true);
  assert.equal(f.retries(), 1);
});

test("sync does not write to the remote when the initial local save fails", async () => {
  const f = fixture();
  let requests = 0;
  f.bindings.saveWorkspace = async () => ({ ok: false, error: new Error("disk full") });
  f.bindings.syncWorkspaceWithRemote = async () => { requests += 1; return f.result(); };
  await f.callback()();
  assert.equal(requests, 0);
  assert.equal(f.states.length, 0);
  assert.equal(f.bindings.syncBusyRef.current, false);
  assert.ok(f.notices.some((message) => message.includes("disk full")));
});

test("manual pull retains edits made after its confirmation", async () => {
  const f = fixture();
  const operation = f.callback("pullRemoteWorkspace")();
  await f.started.promise;
  const edited = { ...f.initial, documents: [{ ...f.initial.documents[0], title: "after confirmation" }] };
  f.bindings.workspaceRef.current = edited;
  f.remote.resolve(f.result());
  await operation;
  assert.equal(f.bindings.workspaceRef.current, edited);
  assert.equal(f.states.length, 0);
  assert.equal(f.saves.length, 0);
});

test("the synchronous busy guard prevents overlapping requests before a render", async () => {
  const f = fixture();
  const sync = f.callback();
  const first = sync();
  await sync();
  await f.started.promise;
  assert.equal(f.saves.length, 1);
  f.remote.resolve(f.result());
  await first;
  assert.equal(f.bindings.syncBusyRef.current, false);
});

test("an unresolved storage conflict pauses sync before any save or remote request", async () => {
  const f = fixture();
  f.bindings.storageConflictRef.current = true;
  await f.callback()();
  assert.equal(f.saves.length, 0);
  assert.equal(f.states.length, 0);
  assert.equal(f.bindings.syncBusyRef.current, false);
});
