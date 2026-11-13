import assert from "node:assert/strict";
import test from "node:test";
import { createSyncStore } from "../server/sync-store.mjs";
import { loadTypescript } from "./helpers/typescript.mjs";

const sync = loadTypescript("src/sync.ts");
const { migrateDocument } = loadTypescript("src/migrations.ts");
const { legacyDocumentSignature } = loadTypescript("src/documentSignature.ts");
const config = { serverUrl: "http://fixture.invalid", token: "fixture", autoSync: false, autoSyncIntervalSeconds: 60 };
const document = (id, text, updatedAt = "2026-09-01T00:00:00.000Z") => migrateDocument({
  id, title: id, createdAt: updatedAt, updatedAt, nodes: [{ id: `node-${id}`, text, children: [] }],
});

async function fixture(t) {
  const store = await createSyncStore(":memory:");
  const originalWindow = globalThis.window;
  let fail = () => false;
  let beforeRequest = () => {};
  globalThis.window = { bike: { invokeSyncRequest: async (request) => {
    const { pathname, method, body } = request;
    beforeRequest(request);
    if (fail(request)) return { ok: false, status: 503, data: { message: "injected failure" } };
    try {
      const id = decodeURIComponent(pathname.split("/")[3]);
      const data = pathname === "/api/sync/manifest"
        ? method === "GET" ? store.getManifest() : store.patchManifest(body)
        : method === "GET" ? store.getDocument(id)
          : method === "PUT" ? store.putDocument({ id, ...body }) : store.deleteDocument({ id, ...body });
      return { ok: true, status: 200, data };
    } catch (error) {
      return { ok: false, status: error.statusCode || 500, data: { message: error.message } };
    }
  } } };
  t.after(() => { store.close(); globalThis.window = originalWindow; });
  return {
    store,
    failWhen: (predicate) => { fail = predicate; },
    beforeRequest: (hook) => { beforeRequest = hook; },
  };
}

test("attachment sync refuses a legacy server before uploading and downloads v2 metadata from a capable server", async (t) => {
  const { store, beforeRequest } = await fixture(t);
  const assetId = `sha256:${"a".repeat(64)}`;
  const item = document("attached", "attachment");
  item.attachments = { version: 1, items: { [assetId]: { mediaType: "application/octet-stream", byteLength: 1 } } };
  item.nodes[0].attachmentRefs = [{ assetId, name: "file.bin" }];
  const before = JSON.stringify(item);
  const getManifest = store.getManifest;
  store.getManifest = () => {
    const { capabilities, ...legacy } = getManifest();
    return legacy;
  };
  let uploads = 0;
  beforeRequest(({ method }) => { if (method === "PUT") uploads++; });
  await assert.rejects(sync.putRemoteDocument(config, item, null), (error) => error.status === 426);
  assert.equal(uploads, 0);
  assert.equal(store.getDocument(item.id), null);
  assert.equal(JSON.stringify(item), before);
  store.getManifest = getManifest;
  await sync.putRemoteDocument(config, item, null);
  const downloaded = await sync.pullWorkspaceFromRemote(config);
  assert.equal(downloaded.workspace.version, 2);
  assert.deepEqual(downloaded.workspace.documents[0].nodes[0].attachmentRefs, item.nodes[0].attachmentRefs);
});

test("failed sync checkpoints uploads without acknowledging an unapplied new download", async (t) => {
  const { store, failWhen } = await fixture(t);
  const a = document("A", "remote only", "2026-09-02T00:00:00.000Z");
  const b = document("B", "base");
  store.putDocument({ id: "A", expectedRevision: null, document: a });
  store.putDocument({ id: "B", expectedRevision: null, document: b });
  const workspace = { version: 1, activeDocumentId: "B", documents: [document("B", "edited"), document("C", "new")] };
  let checkpoint = sync.emptySyncState(config.serverUrl);
  checkpoint.documentRevisions.B = 1;
  checkpoint.documentFingerprints.B = sync.documentFingerprint(b);
  failWhen(({ method, pathname }) => method === "PUT" && pathname.endsWith("/C"));
  await assert.rejects(sync.syncWorkspaceWithRemote(workspace, config, checkpoint, {
    onCheckpoint: (state) => { checkpoint = state; },
  }), /injected failure/);
  assert.equal(checkpoint.documentRevisions.A, undefined);
  assert.equal(checkpoint.documentRevisions.B, 2);
  failWhen(() => false);
  const retried = await sync.syncWorkspaceWithRemote(workspace, config, checkpoint);
  assert.equal(store.getDocument("A").deletedAt, null);
  assert.ok(retried.workspace.documents.some((item) => item.id === "A"));
  assert.equal(retried.summary.deleted, 0);
  assert.deepEqual(retried.summary.conflicts, []);
});

test("failed sync keeps the old baseline for a downloaded update", async (t) => {
  const { store, failWhen } = await fixture(t);
  const a = document("A", "base");
  store.putDocument({ id: "A", expectedRevision: null, document: a });
  store.putDocument({ id: "A", expectedRevision: 1, document: document("A", "remote edit") });
  // B first so the server order differs and the sync has to PATCH the manifest.
  const workspace = { version: 1, activeDocumentId: "A", documents: [document("B", "new"), a] };
  let checkpoint = sync.emptySyncState(config.serverUrl);
  checkpoint.documentRevisions.A = 1;
  checkpoint.documentFingerprints.A = sync.documentFingerprint(a);
  failWhen(({ method }) => method === "PATCH");
  await assert.rejects(sync.syncWorkspaceWithRemote(workspace, config, checkpoint, {
    onCheckpoint: (state) => { checkpoint = state; },
  }), /injected failure/);
  assert.equal(checkpoint.documentRevisions.A, 1);
  assert.equal(checkpoint.documentRevisions.B, 1);
  failWhen(() => false);
  const retried = await sync.syncWorkspaceWithRemote(workspace, config, checkpoint);
  assert.equal(retried.workspace.documents.find((item) => item.id === "A").nodes[0].text, "remote edit");
  assert.deepEqual(retried.summary.conflicts, []);
});

test("delete checkpoints exclude earlier downloads", async (t) => {
  const { store, failWhen } = await fixture(t);
  store.putDocument({ id: "A", expectedRevision: null, document: document("A", "remote", "2026-09-02T00:00:00.000Z") });
  store.putDocument({ id: "B", expectedRevision: null, document: document("B", "deleted locally") });
  const workspace = { version: 1, activeDocumentId: "C", documents: [document("C", "local")] };
  let checkpoint = sync.emptySyncState(config.serverUrl);
  checkpoint.documentRevisions.B = 1;
  failWhen(({ method, pathname }) => method === "PUT" && pathname.endsWith("/C"));
  await assert.rejects(sync.syncWorkspaceWithRemote(workspace, config, checkpoint, {
    onCheckpoint: (state) => { checkpoint = state; },
  }), /injected failure/);
  assert.equal(checkpoint.documentRevisions.A, undefined);
  assert.equal(checkpoint.documentRevisions.B, 2);
});

test("desktop sync preserves mobile shortcuts and document/node extensions", async (t) => {
  const { store } = await fixture(t);
  const source = { ...document("A", "mobile"), isShortcut: true, extension: { keep: true } };
  source.nodes[0].extension = ["keep"];
  source.knowledge = { version: 1, references: [{
    id: "ref", source: { kind: "node-field", nodeId: "lost-source", field: "text", start: -1, end: -1, raw: "[[A]]", groupId: "group" },
    target: { documentId: "A", nodeId: "node-A" }, labelMode: "auto",
  }], relations: [{ id: "edge", fromNodeId: "node-A", toNodeId: "missing-endpoint", label: "保留失效边" }],
  sourceGroups: { group: { raw: "[[A]]", candidates: [{ nodeId: "node-A", field: "text" }] } } };
  store.putDocument({ id: "A", expectedRevision: null, document: source });
  const pulled = await sync.pullWorkspaceFromRemote(config);
  const edited = { ...pulled.workspace, extension: "workspace", documents: pulled.workspace.documents.map((item) => ({ ...item, title: "desktop edit" })) };
  const result = await sync.syncWorkspaceWithRemote(edited, config, pulled.state);
  const remote = store.getDocument("A").document;
  assert.equal(remote.isShortcut, true);
  assert.deepEqual(remote.extension, { keep: true });
  assert.deepEqual(remote.nodes[0].extension, ["keep"]);
  assert.deepEqual(remote.knowledge, source.knowledge);
  assert.equal(result.workspace.extension, "workspace");
});

// A device is an independent workspace + sync state talking to the same store.
const pullDevice = async () => {
  const pulled = await sync.pullWorkspaceFromRemote(config);
  return { workspace: pulled.workspace, state: pulled.state };
};
const syncDevice = async (device) => {
  const result = await sync.syncWorkspaceWithRemote(device.workspace, config, device.state);
  device.workspace = result.workspace;
  device.state = result.state;
  return result;
};
const editDocument = (device, id, text) => {
  device.workspace = {
    ...device.workspace,
    documents: device.workspace.documents.map((item) =>
      item.id === id ? { ...item, nodes: [{ ...item.nodes[0], text }] } : item),
  };
};
const removeDocument = (device, id) => {
  const documents = device.workspace.documents.filter((item) => item.id !== id);
  device.workspace = { ...device.workspace, activeDocumentId: documents[0].id, documents };
};
const reorder = (device, ids) => {
  const byId = new Map(device.workspace.documents.map((item) => [item.id, item]));
  device.workspace = { ...device.workspace, documents: ids.map((id) => byId.get(id)) };
};
const ids = (workspace) => workspace.documents.map((item) => item.id);
const seed = (store, ...names) => {
  for (const name of names) store.putDocument({ id: name, expectedRevision: null, document: document(name, "base") });
};

test("local edits win over a remote delete and the conflict does not repeat", async (t) => {
  const { store } = await fixture(t);
  seed(store, "A", "B");
  const device = await pullDevice();
  store.deleteDocument({ id: "A", expectedRevision: 1 });
  editDocument(device, "A", "edited offline");
  let checkpoint;
  const first = await sync.syncWorkspaceWithRemote(device.workspace, config, device.state, {
    onCheckpoint: (state) => { checkpoint = state; },
  });
  device.workspace = first.workspace;
  device.state = first.state;
  assert.deepEqual(first.summary.conflicts, []);
  assert.equal(first.summary.uploaded, 1);
  assert.equal(checkpoint.documentRevisions.A, store.getDocument("A").revision);
  assert.equal(store.getDocument("A").deletedAt, null);
  assert.equal(store.getDocument("A").document.nodes[0].text, "edited offline");
  const second = await syncDevice(device);
  assert.deepEqual(second.summary.conflicts, []);
  assert.equal(second.summary.uploaded + second.summary.downloaded + second.summary.deleted, 0);
  assert.equal(store.getDocument("A").deletedAt, null);
  assert.ok(ids(device.workspace).includes("A"));
});

test("an unchanged document deleted remotely is removed locally", async (t) => {
  const { store } = await fixture(t);
  seed(store, "A", "B");
  const device = await pullDevice();
  store.deleteDocument({ id: "A", expectedRevision: 1 });
  const result = await syncDevice(device);
  assert.deepEqual(result.summary.conflicts, []);
  assert.equal(result.summary.deleted, 1);
  assert.deepEqual(ids(device.workspace), ["B"]);
  assert.ok(store.getDocument("A").deletedAt);
});

test("a remotely deleted only document is kept and restored on the server", async (t) => {
  const { store } = await fixture(t);
  seed(store, "A");
  const device = await pullDevice();
  store.deleteDocument({ id: "A", expectedRevision: 1 });
  const first = await syncDevice(device);
  assert.deepEqual(first.summary.conflicts, []);
  assert.deepEqual(ids(device.workspace), ["A"]);
  assert.equal(store.getDocument("A").deletedAt, null);
  const second = await syncDevice(device);
  assert.deepEqual(second.summary.conflicts, []);
  assert.equal(store.getDocument("A").deletedAt, null);
});

test("a conflicting resurrect reports a conflict once and a later round resolves it", async (t) => {
  const { store, beforeRequest } = await fixture(t);
  seed(store, "A", "B");
  const device = await pullDevice();
  store.deleteDocument({ id: "A", expectedRevision: 1 });
  editDocument(device, "A", "edited offline");
  // Another device restores and deletes A again right before our resurrect.
  beforeRequest(({ method, pathname }) => {
    if (method !== "PUT" || !pathname.endsWith("/A")) return;
    beforeRequest(() => {});
    store.putDocument({ id: "A", expectedRevision: 2, document: document("A", "other device") });
    store.deleteDocument({ id: "A", expectedRevision: 3 });
  });
  const previous = device.state;
  const first = await syncDevice(device);
  assert.equal(first.summary.conflicts.length, 1);
  assert.equal(first.state.documentRevisions.A, previous.documentRevisions.A);
  assert.equal(first.state.documentFingerprints.A, previous.documentFingerprints.A);
  assert.equal(first.state.deletedDocumentRevisions, undefined);
  assert.ok(ids(device.workspace).includes("A"));
  const second = await syncDevice(device);
  assert.deepEqual(second.summary.conflicts, []);
  assert.equal(store.getDocument("A").deletedAt, null);
  assert.equal(store.getDocument("A").document.nodes[0].text, "edited offline");
});

test("remote edits win over a local delete and the document is restored", async (t) => {
  const { store } = await fixture(t);
  seed(store, "A", "B");
  const device = await pullDevice();
  store.putDocument({ id: "A", expectedRevision: 1, document: document("A", "remote edit") });
  removeDocument(device, "A");
  const first = await syncDevice(device);
  assert.deepEqual(first.summary.conflicts, []);
  assert.equal(first.summary.downloaded, 1);
  assert.equal(device.workspace.documents.find((item) => item.id === "A").nodes[0].text, "remote edit");
  assert.equal(store.getDocument("A").deletedAt, null);
  const second = await syncDevice(device);
  assert.deepEqual(second.summary.conflicts, []);
  assert.equal(store.getDocument("A").deletedAt, null);
});

test("a device that did not reorder adopts another device's reorder", async (t) => {
  const { store } = await fixture(t);
  seed(store, "A", "B", "C");
  const deviceA = await pullDevice();
  const deviceB = await pullDevice();
  assert.deepEqual(ids(deviceA.workspace), ["A", "B", "C"]);
  reorder(deviceB, ["C", "A", "B"]);
  await syncDevice(deviceB);
  assert.deepEqual(store.getManifest().documentOrder, ["C", "A", "B"]);
  const revision = store.getManifest().workspaceRevision;
  const result = await syncDevice(deviceA);
  assert.deepEqual(result.summary.conflicts, []);
  assert.deepEqual(ids(deviceA.workspace), ["C", "A", "B"]);
  assert.deepEqual(store.getManifest().documentOrder, ["C", "A", "B"]);
  assert.equal(store.getManifest().workspaceRevision, revision);
  await syncDevice(deviceB);
  assert.deepEqual(ids(deviceB.workspace), ["C", "A", "B"]);
});

test("a manifest change during sync is not overwritten and the next sync converges", async (t) => {
  const { store, beforeRequest } = await fixture(t);
  seed(store, "A", "B", "C");
  const device = await pullDevice();
  reorder(device, ["B", "A", "C"]);
  editDocument(device, "B", "local edit");
  beforeRequest(({ method }) => {
    if (method !== "PATCH") return;
    beforeRequest(() => {});
    const manifest = store.getManifest();
    store.patchManifest({ expectedRevision: manifest.workspaceRevision, activeDocumentId: "C", documentOrder: ["C", "B", "A"] });
  });
  const first = await syncDevice(device);
  assert.equal(first.summary.uploaded, 1);
  assert.equal(store.getDocument("B").document.nodes[0].text, "local edit");
  assert.deepEqual(store.getManifest().documentOrder, ["C", "B", "A"]);
  assert.deepEqual(first.state.documentOrder, ["A", "B", "C"]);
  const second = await syncDevice(device);
  assert.deepEqual(second.summary.conflicts, []);
  assert.deepEqual(store.getManifest().documentOrder, ids(device.workspace));
  assert.deepEqual(second.state.documentOrder, ids(device.workspace));
  const revision = store.getManifest().workspaceRevision;
  await syncDevice(device);
  assert.equal(store.getManifest().workspaceRevision, revision);
});

test("a sync that changes nothing does not bump the workspace revision", async (t) => {
  const { store } = await fixture(t);
  seed(store, "A", "B");
  const device = await pullDevice();
  const revision = store.getManifest().workspaceRevision;
  const original = device.workspace;
  const result = await syncDevice(device);
  assert.equal(result.workspace, original);
  assert.equal(store.getManifest().workspaceRevision, revision);
  assert.equal(result.state.workspaceRevision, revision);
  assert.deepEqual(result.state.documentOrder, ["A", "B"]);
});

test('v2 candidate fingerprints reconcile remote edits and deletes before upgrading', async (t) => {
  const { store } = await fixture(t);
  seed(store, 'A', 'B');
  const device = await pullDevice();
  device.state.fingerprintVersion = 2;
  for (const item of device.workspace.documents) device.state.documentFingerprints[item.id] = `v2:${legacyDocumentSignature(item)}`;
  store.putDocument({ id: 'A', expectedRevision: 1, document: document('A', 'remote edit') });
  store.deleteDocument({ id: 'B', expectedRevision: 1 });
  const result = await syncDevice(device);
  assert.deepEqual(result.summary.conflicts, []);
  assert.deepEqual(ids(result.workspace), ['A']);
  assert.equal(result.workspace.documents[0].nodes[0].text, 'remote edit');
  assert.equal(result.state.fingerprintVersion, sync.FINGERPRINT_VERSION);
});

test("checkpoint storage failures do not stop uploads and a restart reconciles their actual content", async (t) => {
  const { store } = await fixture(t);
  seed(store, "A", "B");
  const device = await pullDevice();
  const durableState = device.state;
  editDocument(device, "A", "edited A");
  editDocument(device, "B", "edited B");
  const result = await sync.syncWorkspaceWithRemote(device.workspace, config, durableState, {
    onCheckpoint: () => { throw new Error("quota exceeded"); },
  });
  assert.equal(result.summary.uploaded, 2);
  assert.equal(result.summary.checkpointErrors.length, 2);
  assert.equal(result.state.documentRevisions.A, 2);
  assert.equal(result.state.documentRevisions.B, 2);
  const restarted = await sync.syncWorkspaceWithRemote(device.workspace, config, durableState);
  assert.deepEqual(restarted.summary.conflicts, []);
  assert.equal(restarted.summary.uploaded, 0);
  assert.equal(restarted.state.documentRevisions.A, 2);
  store.putDocument({ id: "A", expectedRevision: 2, document: document("A", "new remote edit") });
  const realConflict = await sync.syncWorkspaceWithRemote(device.workspace, config, durableState);
  assert.equal(realConflict.summary.conflicts.length, 1);
  assert.equal(store.getDocument("A").document.nodes[0].text, "new remote edit");
});

test("content fingerprints ignore timestamps and object key order, including edit then undo", async (t) => {
  const { store } = await fixture(t);
  seed(store, "A");
  const device = await pullDevice();
  const original = device.workspace.documents[0];
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  const timestampOnly = { ...reordered, updatedAt: "2030-01-01T00:00:00.000Z" };
  assert.equal(sync.documentFingerprint(original), sync.documentFingerprint(timestampOnly));
  device.workspace = { ...device.workspace, documents: [timestampOnly] };
  assert.equal((await syncDevice(device)).summary.uploaded, 0);
  editDocument(device, "A", "B");
  editDocument(device, "A", original.nodes[0].text);
  assert.equal((await syncDevice(device)).summary.uploaded, 0);
  assert.equal(store.getDocument("A").revision, 1);
});

test("server A to B to A preserves separate baselines and failed persistence retains memory progress", () => {
  const values = new Map();
  const original = globalThis.localStorage;
  let failWrites = false;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { if (failWrites) throw new Error("quota"); values.set(key, value); },
  };
  try {
    const a = { ...sync.emptySyncState("HTTP://A.invalid:80/"), documentRevisions: { A: 1 } };
    const b = { ...sync.emptySyncState("http://b.invalid"), documentRevisions: { B: 7 } };
    sync.saveSyncState(a);
    sync.saveSyncState(b);
    assert.equal(sync.loadSyncState("http://a.invalid").documentRevisions.A, 1);
    assert.equal(sync.loadSyncState("http://b.invalid/").documentRevisions.B, 7);
    failWrites = true;
    assert.throws(() => sync.saveSyncState({ ...a, documentRevisions: { A: 2 } }), /quota/);
    assert.equal(sync.loadSyncState("http://a.invalid").documentRevisions.A, 2);
    failWrites = false;
    sync.saveSyncState({ ...a, documentRevisions: { A: 2 } });
  } finally { globalThis.localStorage = original; }
});

test("the order guard accounts for this sync's own creates and deletes", async (t) => {
  const { store } = await fixture(t);
  seed(store, "A", "B", "C");
  const device = await pullDevice();
  removeDocument(device, "B");
  device.workspace = { ...device.workspace, documents: [document("D", "new"), ...device.workspace.documents] };
  const result = await syncDevice(device);
  assert.deepEqual(result.summary.conflicts, []);
  assert.deepEqual(ids(device.workspace), ["D", "A", "C"]);
  assert.deepEqual(store.getManifest().documentOrder, ["D", "A", "C"]);
  assert.equal(result.state.workspaceRevision, store.getManifest().workspaceRevision);
  assert.deepEqual(result.state.documentOrder, ["D", "A", "C"]);
});

test("sync state round-trips documentOrder and rejects invalid values", () => {
  const storage = new Map();
  const originalLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  try {
    assert.equal(sync.emptySyncState(config.serverUrl).documentOrder, null);
    sync.saveSyncState({ ...sync.emptySyncState(config.serverUrl), documentOrder: ["A", "B"] });
    assert.deepEqual(sync.loadSyncState(config.serverUrl).documentOrder, ["A", "B"]);
    sync.saveSyncState({ ...sync.emptySyncState(config.serverUrl), documentOrder: ["A", 1] });
    assert.equal(sync.loadSyncState(config.serverUrl).documentOrder, null);
  } finally {
    globalThis.localStorage = originalLocalStorage;
  }
});

test("two devices: one deletes, the other edits offline; the edit survives on both", async (t) => {
  const { store } = await fixture(t);
  seed(store, "A", "B");
  const deviceA = await pullDevice();
  const deviceB = await pullDevice();
  removeDocument(deviceB, "A");
  await syncDevice(deviceB);
  assert.ok(store.getDocument("A").deletedAt);
  editDocument(deviceA, "A", "kept by A");
  const resultA = await syncDevice(deviceA);
  assert.deepEqual(resultA.summary.conflicts, []);
  const resultB = await syncDevice(deviceB);
  assert.deepEqual(resultB.summary.conflicts, []);
  assert.equal(deviceB.workspace.documents.find((item) => item.id === "A").nodes[0].text, "kept by A");
  for (const device of [deviceA, deviceB]) {
    assert.deepEqual((await syncDevice(device)).summary.conflicts, []);
  }
  assert.deepEqual(ids(deviceA.workspace), ids(deviceB.workspace));
});

test("a document created at the top on one device keeps its place on the others", async (t) => {
  const { store } = await fixture(t);
  seed(store, "A", "B");
  const deviceA = await pullDevice();
  const deviceB = await pullDevice();
  deviceB.workspace = { ...deviceB.workspace, documents: [document("N", "new"), ...deviceB.workspace.documents] };
  await syncDevice(deviceB);
  assert.deepEqual(store.getManifest().documentOrder, ["N", "A", "B"]);
  const revision = store.getManifest().workspaceRevision;
  await syncDevice(deviceA);
  assert.deepEqual(ids(deviceA.workspace), ["N", "A", "B"]);
  assert.equal(store.getManifest().workspaceRevision, revision);
});
