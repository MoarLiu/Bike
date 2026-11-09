import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadTypescript } from '../tests/helpers/typescript.mjs';
const { migrateWorkspace } = loadTypescript('src/migrations.ts');
import { createSyncStore } from './sync-store.mjs';
import { createWorkspaceOperation, initialPositions } from '../shared/bike-operations.mjs';
import { createReplicaState, applyReplicaEvents } from '../shared/bike-replica.mjs';
const date = '2026-11-09T00:00:00.000Z';
const base = () => migrateWorkspace({ version: 3, activeDocumentId: 'doc', documents: [{ id: 'doc', title: 'Doc', createdAt: date, updatedAt: date, nodes: ['a', 'b'].map((id) => ({ id, text: id, children: [] })) }] });
const change = (workspace, index, text) => { const result = structuredClone(workspace); result.documents[0].nodes[index].text = text; return result; };
const op = (before, next, id, positions = initialPositions(before)) => createWorkspaceOperation(before, next, { id, actorId: id, positions, source: { kind: 'user', label: '编辑' }, createdAt: date });
const fixture = async (t) => {
  const store = await createSyncStore(':memory:'); t.after(() => store.close());
  store.putDocument({ id: 'doc', expectedRevision: null, document: base().documents[0] });
  store.operations.enable({ expectedRevision: store.getManifest().workspaceRevision });
  return store;
};

test('server applies distinct node operations and atomically sequences durable receipts', async (t) => {
  const store = await fixture(t), before = base();
  const a = op(before, change(before, 0, 'A'), 'a'), b = op(before, change(before, 1, 'B'), 'b');
  assert.equal(store.operations.submit(a).status, 'applied');
  assert.equal(store.operations.submit(b).status, 'applied');
  assert.equal(store.operations.submit(a).replayed, true);
  assert.equal(store.operations.status().cursor, 2);
  assert.deepEqual(store.getDocument('doc').document.nodes.map((n) => n.text), ['A', 'B']);
  assert.throws(() => store.operations.submit({ ...a, createdAt: '2026-11-10T00:00:00Z' }), /不同内容/);
  let replica = createReplicaState(before, 'client');
  replica.remote = { workspace: before, positions: initialPositions(before), clock: 0 };
  const events = store.operations.events({ after: 0 }).events;
  replica = applyReplicaEvents(replica, events);
  assert.deepEqual(replica.remote.workspace.documents[0].nodes.map((n) => n.text), ['A', 'B']);
  assert.equal(applyReplicaEvents(replica, events).cursor, 2);
  assert.throws(() => applyReplicaEvents({ ...replica, cursor: 0 }, [events[1]]), /缺口/);
});

test('same field retains the full rejected branch and prevents a partial cross-document write', async (t) => {
  const store = await fixture(t), before = base();
  store.operations.submit(op(before, change(before, 0, 'A'), 'a'));
  const candidate = change(before, 0, 'B'); candidate.documents.push({ ...base().documents[0], id: 'new' });
  const result = store.operations.submit(op(before, candidate, 'b'));
  assert.equal(result.status, 'conflict');
  assert.equal(store.getDocument('new'), null);
  assert.equal(store.operations.unresolved()[0].operation.changes[0].after.value, 'B');
  assert.equal(store.operations.status().cursor, 2);
});

test('old writes are refused in the same transaction after protocol upgrade', async (t) => {
  const store = await fixture(t);
  for (const call of [
    () => store.putDocument({ id: 'doc', expectedRevision: 1, document: base().documents[0] }),
    () => store.deleteDocument({ id: 'doc', expectedRevision: 1 }),
    () => store.patchManifest({ expectedRevision: 1, documentOrder: [] }),
    () => store.appendDocumentOperations({ id: 'doc', baseRevision: 1, actorId: 'old', operations: [{ type: 'anything' }] }),
  ]) assert.throws(call, (e) => e.statusCode === 426);
  assert.equal(store.getDocument('doc').revision, 1);
  assert.equal(store.operations.status().cursor, 0);
});

test('document tombstones reject offline resurrection while preserving candidate contents', async (t) => {
  const store = await fixture(t), before = base();
  store.operations.submit(op(before, { ...before, documents: [] }, 'delete'));
  const result = store.operations.submit(op({ ...before, documents: [] }, before, 'offline-create'));
  assert.equal(result.status, 'conflict');
  assert.ok(store.getDocument('doc').deletedAt);
  assert.equal(store.operations.unresolved()[0].operation.changes[0].document.nodes[0].text, 'a');
});

test('lost acknowledgement survives a server restart and a second connection', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bike-op-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'sync.sqlite');
  let store = await createSyncStore(file);
  store.putDocument({ id: 'doc', expectedRevision: null, document: base().documents[0] });
  store.operations.enable({ expectedRevision: 1 });
  const operation = op(base(), change(base(), 0, 'A'), 'request');
  const first = store.operations.submit(operation); store.close();
  store = await createSyncStore(file); t.after(() => store.close());
  const retry = store.operations.submit(operation);
  assert.equal(retry.sequence, first.sequence); assert.equal(retry.replayed, true);
  assert.equal(store.getDocument('doc').revision, 2);
  const checkpoint = store.operations.checkpoint();
  assert.equal(checkpoint.cursor, 1); assert.equal(checkpoint.documents[0].document.nodes[0].text, 'A');
});

test('log compaction requires checkpoint recovery while retaining original receipt identities', async (t) => {
  const store = await fixture(t);
  let before = base(), first;
  for (let index = 0; index < 5001; index++) {
    const after = change(before, 0, `edit-${index}`);
    const operation = op(before, after, `compaction-${index}`);
    if (!index) first = operation;
    store.operations.submit(operation);
    before = after;
  }
  assert.equal(store.operations.status().minimumCursor, 1);
  assert.throws(() => store.operations.events({ after: 0 }), (error) => error.statusCode === 410 && error.code === 'checkpoint_required');
  assert.equal(store.operations.submit(first).replayed, true);
  assert.equal(store.operations.status().cursor, 5001);
  assert.equal(store.operations.checkpoint().documents[0].document.nodes[0].text, 'edit-5000');
  const events = store.operations.events({ after: 1 });
  assert.equal(events.events[0].sequence, 2);
  assert.equal(events.hasMore, true);
});
