import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeBrowserStorage } from './helpers/fake-browser.mjs';
import { loadTypescriptIsolated, loadTypescript } from './helpers/typescript.mjs';
const { migrateWorkspace } = loadTypescript('src/migrations.ts');
const base = () => migrateWorkspace({ version: 3, activeDocumentId: 'doc', documents: [{ id: 'doc', title: 'Doc', nodes: [{ id: 'node', text: 'before', children: [] }] }] });
const edit = (workspace, text) => ({ ...workspace, documents: [{ ...workspace.documents[0], nodes: [{ ...workspace.documents[0].nodes[0], text }] }] });

test('v3 atomically commits body, operation, audit, outbox, and idempotent receipt', async (t) => {
  const env = installFakeBrowserStorage(t);
  env.idb.seed('bike-db', { workspace: base(), 'workspace-meta': { revision: 4 } });
  const storage = loadTypescriptIsolated('src/storage.ts');
  const loaded = await storage.loadWorkspace(), next = edit(loaded.workspace, 'after');
  const options = { requestId: 'request', source: { kind: 'ai', label: 'AI 批次' }, acceptedGroups: ['one'], candidateDigest: 'verified-candidate' };
  const saved = await storage.saveWorkspace(next, options);
  assert.equal(saved.ok, true);
  const replica = await storage.readReplicaState();
  assert.equal(replica.outbox.length, 1);
  assert.equal(replica.outbox[0].source.kind, 'ai');
  assert.equal(replica.audit[0].acceptedGroups[0], 'one');
  assert.equal((await storage.queryOperationReceipt('request')).status, 'committed');
  assert.equal((await storage.queryOperationReceipt('request')).candidateDigest, 'verified-candidate');
  const retried = await storage.saveWorkspace(next, options);
  assert.equal(retried.replayed, true);
  assert.equal(env.idb.read('bike-db', 'workspace-meta').revision, 5);
  assert.equal((await storage.readReplicaState()).outbox.length, 1);
  assert.equal((await storage.saveWorkspace(edit(next, 'different'), options)).ok, false);
  assert.equal((await storage.saveWorkspace(next, { ...options, candidateDigest: 'changed-candidate' })).ok, false);
  assert.equal(env.idb.read('bike-db', 'workspace').documents[0].nodes[0].text, 'after');
});

test('v3 never reports fallback storage as an operation commit', async (t) => {
  const env = installFakeBrowserStorage(t, { indexedDB: false });
  const storage = loadTypescriptIsolated('src/storage.ts');
  await storage.loadWorkspace();
  const result = await storage.saveWorkspace(base(), { requestId: 'offline-storage' });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /操作未提交/);
  assert.ok(env.localStorage.storage.length > 0);
});

test('revision and explicit proposal baseline prevent stale confirmation', async (t) => {
  const env = installFakeBrowserStorage(t);
  env.idb.seed('bike-db', { workspace: base(), 'workspace-meta': { revision: 1 } });
  const a = loadTypescriptIsolated('src/storage.ts'), b = loadTypescriptIsolated('src/storage.ts');
  const original = await a.loadWorkspace(); await b.loadWorkspace();
  await b.saveWorkspace(edit(original.workspace, 'remote'));
  const result = await a.saveWorkspace(edit(original.workspace, 'proposal'), { requestId: 'stale', expectedWorkspace: original.workspace });
  assert.equal(result.ok, false); assert.equal(result.conflict, true);
  assert.equal((await a.readReplicaState()).outbox.length, 1);
});

test('v1 migration preserves the exact old workspace and keeps replica identity out of body', async (t) => {
  const env = installFakeBrowserStorage(t);
  const old = { ...base(), version: 1 };
  env.idb.seed('bike-db', { workspace: old, 'workspace-meta': { revision: 1 } });
  const storage = loadTypescriptIsolated('src/storage.ts');
  const loaded = await storage.loadWorkspace();
  assert.equal((await storage.saveWorkspace({ ...loaded.workspace, version: 3 })).ok, true);
  assert.deepEqual(await storage.loadPreOperationWorkspace(), loaded.workspace);
  assert.equal((await storage.readReplicaState()).outbox.length, 0);
  assert.equal(JSON.stringify(env.idb.read('bike-db', 'workspace')).includes('actorId'), false);
  assert.equal((await storage.saveWorkspace(old)).ok, false);
});

for (const failure of ['body', 'journal', 'commit']) test(`transaction rollback at ${failure} leaves no partial operation`, async (t) => {
  const env = installFakeBrowserStorage(t);
  env.idb.seed('bike-db', { workspace: base(), 'workspace-meta': { revision: 1 } });
  const storage = loadTypescriptIsolated('src/storage.ts');
  const loaded = await storage.loadWorkspace();
  if (failure === 'commit') env.idb.failCommit({ db: 'bike-db', times: 1 });
  else env.idb.failPut({ db: 'bike-db', ...(failure === 'body' ? { key: 'workspace' } : {}), times: 1 });
  const result = await storage.saveWorkspace(edit(loaded.workspace, 'never committed'), { requestId: failure });
  assert.equal(result.ok, false);
  assert.equal(env.idb.read('bike-db', 'workspace-meta').revision, 1);
  assert.equal(env.idb.read('bike-db', 'workspace').documents[0].nodes[0].text, 'before');
  assert.equal(await storage.queryOperationReceipt(failure), null);
  assert.equal(await storage.readReplicaState(), null);
});

test('a stale remote generation cannot discard outbox even when local body returns to the same content', async (t) => {
  const env = installFakeBrowserStorage(t);
  env.idb.seed('bike-db', { workspace: base(), 'workspace-meta': { revision: 1 } });
  const storage = loadTypescriptIsolated('src/storage.ts');
  const loaded = await storage.loadWorkspace();
  const changed = edit(loaded.workspace, 'changed'); await storage.saveWorkspace(changed);
  const oldReplica = await storage.readReplicaState();
  const restored = edit(changed, 'before'); await storage.saveWorkspace(restored);
  const result = await storage.saveWorkspace(restored, { expectedWorkspace: restored, replicaUpdate: oldReplica });
  assert.equal(result.ok, false);
  assert.equal((await storage.readReplicaState()).outbox.length, 2);
});
