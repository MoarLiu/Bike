import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncStore } from '../server/sync-store.mjs';
import { createReplicaState, recordReplicaCommit, applyReplicaEvents } from '../shared/bike-replica.mjs';
import { createWorkspaceOperation, initialPositions } from '../shared/bike-operations.mjs';
import { loadTypescript } from './helpers/typescript.mjs';
const { syncOperationWorkspace } = loadTypescript('src/operationSync.ts');
const { migrateWorkspace } = loadTypescript('src/migrations.ts');
const base = () => migrateWorkspace({ version: 3, activeDocumentId: 'doc', documents: [{ id: 'doc', title: 'Doc', createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z', nodes: ['a', 'b'].map((id) => ({ id, text: id, children: [] })) }] });
const config = { serverUrl: 'http://fixture.invalid', token: 'test', autoSync: false, autoSyncIntervalSeconds: 60 };
const edit = (before, index, text, replica, id) => {
  const next = structuredClone(before); next.documents[0].nodes[index].text = text;
  return { workspace: next, replica: recordReplicaCommit(replica, before, next, { requestId: id, digest: id, source: { kind: 'user', label: '编辑' }, at: '2026-11-09T01:00:00Z' }).replica };
};
const fixture = async (t) => {
  const store = await createSyncStore(':memory:');
  store.operations.enable({ expectedRevision: 0 });
  const previous = globalThis.window;
  let lostAck = false;
  const calls = [];
  globalThis.window = { bike: { invokeSyncRequest: async ({ pathname, method, body }) => {
    calls.push({ pathname, method, bytes: Buffer.byteLength(JSON.stringify(body ?? null)) });
    const url = new URL(pathname, config.serverUrl), query = Object.fromEntries(url.searchParams);
    try {
      const data = url.pathname === '/api/v2/status' ? store.operations.status()
        : url.pathname === '/api/v2/checkpoint' ? store.operations.checkpoint(query)
          : url.pathname === '/api/v2/events' ? store.operations.events(query) : store.operations.submit(body);
      if (lostAck && method === 'POST') { lostAck = false; return { ok: false, status: 503, data: { message: 'lost acknowledgement' } }; }
      return { ok: true, status: 200, data };
    } catch (error) { return { ok: false, status: error.statusCode ?? 500, data: { message: error.message } }; }
  } } };
  t.after(() => { globalThis.window = previous; store.close(); });
  return { store, calls, loseAck: () => { lostAck = true; } };
};

test('two isolated clients converge after offline edits to different topics', async (t) => {
  const { store } = await fixture(t);
  const first = await syncOperationWorkspace(base(), config, createReplicaState(base(), 'a'));
  const second = await syncOperationWorkspace(base(), config, createReplicaState(base(), 'b'));
  const a = edit(first.workspace, 0, 'A offline', first.replica, 'a-edit');
  const b = edit(second.workspace, 1, 'B offline', second.replica, 'b-edit');
  const a1 = await syncOperationWorkspace(a.workspace, config, a.replica);
  const b1 = await syncOperationWorkspace(b.workspace, config, b.replica);
  const a2 = await syncOperationWorkspace(a1.workspace, config, a1.replica);
  assert.deepEqual(a2.workspace.documents[0].nodes, b1.workspace.documents[0].nodes);
  assert.deepEqual(store.getDocument('doc').document.nodes.map((node) => node.text), ['A offline', 'B offline']);
  assert.equal(a2.replica.outbox.length, 0);
  assert.equal(b1.replica.outbox.length, 0);
  assert.deepEqual(a2.summary.conflicts, []);
});

test('a lost acknowledgement is retried once by identity without duplicate nodes or endless outbox', async (t) => {
  const { store, loseAck } = await fixture(t);
  const replica = createReplicaState(base(), 'a');
  loseAck();
  await assert.rejects(syncOperationWorkspace(base(), config, replica), /lost acknowledgement/);
  const result = await syncOperationWorkspace(base(), config, replica);
  assert.equal(result.replica.outbox.length, 0);
  assert.equal(store.operations.status().cursor, 1);
  assert.equal(result.workspace.documents[0].nodes.length, 2);
});

test('same field candidate survives convergence and is visible on both clients', async (t) => {
  await fixture(t);
  const a = await syncOperationWorkspace(base(), config, createReplicaState(base(), 'a'));
  const b = await syncOperationWorkspace(base(), config, createReplicaState(base(), 'b'));
  const ae = edit(a.workspace, 0, 'A', a.replica, 'a-edit');
  const be = edit(b.workspace, 0, 'B', b.replica, 'b-edit');
  const a1 = await syncOperationWorkspace(ae.workspace, config, ae.replica);
  const b1 = await syncOperationWorkspace(be.workspace, config, be.replica);
  const a2 = await syncOperationWorkspace(a1.workspace, config, a1.replica);
  assert.equal(a2.workspace.documents[0].nodes[0].text, 'A');
  assert.equal(b1.replica.conflicts[0].operation.changes[0].after.value, 'B');
  assert.equal(a2.replica.conflicts[0].id, 'b-edit');
});

test('the steady-state sync transmits a text delta and no document checkpoint', async (t) => {
  const { calls } = await fixture(t);
  const a = await syncOperationWorkspace(base(), config, createReplicaState(base(), 'a'));
  calls.length = 0;
  const edited = edit(a.workspace, 0, 'small delta', a.replica, 'small-edit');
  await syncOperationWorkspace(edited.workspace, config, edited.replica);
  assert.equal(calls.some((call) => call.pathname.includes('/checkpoint')), false);
  assert.ok(calls.filter((call) => call.method === 'POST').every((call) => call.bytes < 1000));
});

test('out of order events cannot advance a replica cursor', () => {
  const initial = createReplicaState(base(), 'a');
  initial.remote = { workspace: base(), positions: initial.positions, clock: 0 };
  assert.throws(() => applyReplicaEvents(initial, [{ id: 'wrong', sequence: 2, status: 'applied' }]), /缺口/);
  assert.equal(initial.cursor, 0);
});

const checkpointFixture = (t, makePage) => {
  const previous = globalThis.window;
  const calls = [];
  const status = { protocol: 2, enabled: true, spaceId: 'fixture-space', cursor: 0, minimumCursor: 0 };
  globalThis.window = { bike: { invokeSyncRequest: async ({ pathname, method }) => {
    calls.push(pathname);
    if (method !== 'GET') throw new Error('checkpoint 验证完成前不应上传');
    const url = new URL(pathname, config.serverUrl);
    if (url.pathname === '/api/v2/status') return { ok: true, data: status };
    if (url.pathname === '/api/v2/checkpoint') {
      const page = Number(url.searchParams.get('after') ?? 0);
      const document = { ...base().documents[0], id: `checkpoint-${page}` };
      return { ok: true, data: { ...status, clock: 0, manifest: { documentOrder: [] }, conflicts: [],
        documents: [{ id: document.id, document, positions: initialPositions({ documents: [document] })[document.id] }],
        nextAfter: page + 1, ...makePage(page, document) } };
    }
    throw new Error(`unexpected checkpoint request ${pathname}`);
  } } };
  t.after(() => { globalThis.window = previous; });
  return calls;
};

test('checkpoint pagination stops at the combined workspace budget and preserves local pending edits', async (t) => {
  const note = 'x'.repeat(4 * 1024 * 1024);
  const calls = checkpointFixture(t, (page, document) => ({ documents: [{ id: document.id,
    document: { ...document, nodes: [{ ...document.nodes[0], note }] },
    positions: initialPositions({ documents: [document] })[document.id] }],
    nextAfter: page < 16 ? page + 1 : null }));
  const original = createReplicaState(base(), 'client');
  const local = edit(base(), 0, 'unuploaded local work', original, 'pending-work');
  const snapshot = structuredClone(local);
  await assert.rejects(syncOperationWorkspace(local.workspace, config, local.replica), /checkpoint.*64 MiB|工作区.*64 MiB/);
  assert.ok(calls.filter((pathname) => pathname.includes('/checkpoint')).length <= 16);
  assert.deepEqual(local, snapshot);
});

test('checkpoint pagination also bounds aggregate response metadata', async (t) => {
  const padding = '\\'.repeat(10 * 1024 * 1024);
  const calls = checkpointFixture(t, (page) => ({ padding, nextAfter: page < 8 ? page + 1 : null }));
  const original = createReplicaState(base(), 'client');
  await assert.rejects(syncOperationWorkspace(base(), config, original), /checkpoint.*160 MiB/);
  assert.ok(calls.filter((pathname) => pathname.includes('/checkpoint')).length <= 8);
  assert.equal(original.cursor, 0);
  assert.equal(original.remote, null);
});

test('repeated checkpoint identities including tombstones are refused before further requests', async (t) => {
  const calls = checkpointFixture(t, (page, document) => ({ documents: [{ id: 'duplicate', deletedAt: '2026-11-10T00:00:00Z',
    document: { ...document, id: 'duplicate' }, positions: {} }], nextAfter: page < 1 ? 1 : null }));
  await assert.rejects(syncOperationWorkspace(base(), config, createReplicaState(base(), 'client')), /身份重复/);
  assert.equal(calls.filter((pathname) => pathname.includes('/checkpoint')).length, 2);
});

test('checkpoint reconstruction preserves reserved document identities and their own positions', async (t) => {
  const { store } = await fixture(t);
  const workspace = base();
  workspace.documents[0].id = '__proto__';
  workspace.activeDocumentId = '__proto__';
  const first = await syncOperationWorkspace(workspace, config, createReplicaState(workspace, 'a'));
  const second = await syncOperationWorkspace(workspace, config, createReplicaState(workspace, 'b'));
  assert.equal(Object.prototype.hasOwnProperty.call(second.replica.remote.positions, '__proto__'), true);
  assert.equal(second.replica.remote.positions.__proto__.a.parentId, null);
  const changed = edit(second.workspace, 0, 'reserved topic edit', second.replica, 'reserved-edit');
  await syncOperationWorkspace(changed.workspace, config, changed.replica);
  assert.equal(store.getDocument('__proto__').document.nodes[0].text, 'reserved topic edit');
  assert.equal(first.workspace.documents[0].id, '__proto__');
});

test('a returning client rebuilds a compacted baseline and safely uploads its unsent independent edit', async (t) => {
  const { store, calls } = await fixture(t);
  const connected = await syncOperationWorkspace(base(), config, createReplicaState(base(), 'returning'));
  const local = edit(connected.workspace, 1, 'unsent offline edit', connected.replica, 'offline-after-compaction');
  let before = connected.workspace;
  for (let index = 0; index < 5001; index++) {
    const after = structuredClone(before);
    after.documents[0].nodes[0].text = `server-edit-${index}`;
    const operation = createWorkspaceOperation(before, after, { id: `server-${index}`, actorId: 'remote',
      source: { kind: 'user', label: '远端编辑' }, createdAt: '2026-11-09T02:00:00Z' });
    assert.equal(store.operations.submit(operation).status, 'applied');
    before = after;
  }
  assert.ok(local.replica.cursor < store.operations.status().minimumCursor);
  calls.length = 0;
  const caughtUp = await syncOperationWorkspace(local.workspace, config, local.replica);
  assert.equal(calls.some((call) => call.pathname.includes('/checkpoint')), true);
  assert.deepEqual(caughtUp.workspace.documents[0].nodes.map((node) => node.text), ['server-edit-5000', 'unsent offline edit']);
  assert.equal(caughtUp.replica.outbox.length, 0);
  assert.equal(local.replica.outbox.length, 1);
  assert.equal(caughtUp.replica.receipts['offline-after-compaction'].pendingSync, false);
  assert.equal(caughtUp.replica.cursor, store.operations.status().cursor);
});
