import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSyncStore } from './sync-store.mjs';

test('two SQLite connections preserve CAS and bound lock waits; sensitive files remain private', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bike-sqlite-safety-'));
  const file = path.join(directory, 'sync.sqlite');
  const a = await createSyncStore(file, { busyTimeoutMs: 50 });
  const b = await createSyncStore(file, { busyTimeoutMs: 50 });
  const blocker = new DatabaseSync(file);
  t.after(async () => { blocker.close(); a.close(); b.close(); await rm(directory, { recursive: true, force: true }); });
  const document = { id: 'doc', title: 'Doc', nodes: [] };
  a.putDocument({ id: 'doc', document, expectedRevision: null });
  b.putDocument({ id: 'doc', document: { ...document, title: 'B edit' }, expectedRevision: 1 });
  assert.throws(() => a.putDocument({ id: 'doc', document, expectedRevision: 1 }), (error) => error.statusCode === 409);
  blocker.exec('BEGIN IMMEDIATE');
  try {
    const start = performance.now();
    assert.throws(() => a.putDocument({ id: 'doc', document, expectedRevision: 2 }), (error) => error.statusCode === 503);
    assert.ok(performance.now() - start < 1500);
  } finally { blocker.exec('ROLLBACK'); }
  assert.equal(a.getDocument('doc').document.title, 'B edit');
  assert.equal(a.putDocument({ id: 'doc', document, expectedRevision: 2 }).revision, 3);
  for (const suffix of ['', '-wal', '-shm']) assert.equal((await stat(file + suffix)).mode & 0o777, 0o600);
});

test('operations pages have an explicit cursor and no missing or repeated sequence', async (t) => {
  const store = await createSyncStore(':memory:');
  t.after(() => store.close());
  store.putDocument({ id: 'doc', expectedRevision: null, document: { id: 'doc', title: 'Doc', nodes: [] } });
  for (let batch = 0; batch < 3; batch++) store.appendDocumentOperations({ id: 'doc', baseRevision: 1, actorId: 'test', operations: Array.from({ length: 100 }, () => ({ type: 'edit' })) });
  let after = 0;
  const sequences = [];
  do {
    const page = store.getDocumentOperations({ id: 'doc', after, limit: 77 });
    assert.ok(page.operations.length <= 77);
    sequences.push(...page.operations.map((operation) => operation.sequence));
    after = page.nextAfter;
  } while (after !== null);
  assert.deepEqual(sequences, Array.from({ length: 300 }, (_, i) => i + 1));
  assert.throws(() => store.getDocumentOperations({ id: 'doc', limit: 100000 }), /limit/);
});
