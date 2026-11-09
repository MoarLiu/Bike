import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createAssetStore } from './asset-store.mjs';
const fixture = async (t, quotaBytes) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-assets-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, store: await createAssetStore({ directory, quotaBytes }) };
};
const asset = (bytes) => ({ id: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, metadata: { byteLength: bytes.length, mediaType: 'application/octet-stream' } });

test('server resumes across restart, deduplicates chunks and atomically verifies installation', async (t) => {
  const { directory, store } = await fixture(t);
  const bytes = randomBytes(2 * 1024 * 1024 + 77), { id, metadata } = asset(bytes);
  const lease = await store.begin(id, metadata);
  const first = bytes.subarray(0, 1024 * 1024);
  assert.equal((await store.writeChunk(id, { uploadId: lease.uploadId, offset: 0, bytes: first })).offset, first.length);
  const restarted = await createAssetStore({ directory });
  const resumed = await restarted.begin(id, { mediaType: metadata.mediaType, byteLength: metadata.byteLength });
  assert.equal(resumed.offset, first.length); assert.equal(resumed.uploadId, lease.uploadId);
  assert.equal((await restarted.writeChunk(id, { uploadId: resumed.uploadId, offset: 0, bytes: first })).offset, first.length);
  await assert.rejects(restarted.writeChunk(id, { uploadId: resumed.uploadId, offset: 0, bytes: Buffer.alloc(first.length) }), /不同字节/);
  for (let offset = first.length; offset < bytes.length; offset += first.length) await restarted.writeChunk(id, { uploadId: lease.uploadId, offset, bytes: bytes.subarray(offset, offset + first.length) });
  assert.equal((await restarted.finish(id, lease.uploadId)).complete, true);
  assert.equal((await restarted.finish(id, lease.uploadId)).complete, true);
  assert.equal((await restarted.begin(id, metadata)).complete, true);
  await assert.rejects(restarted.begin(id, { ...metadata, mediaType: 'application/pdf' }), /格式与清单/);
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += first.length) {
    const opened = await restarted.openChunk(id, offset);
    try { const value = Buffer.alloc(opened.length); await opened.file.read(value, 0, value.length, offset); parts.push(value); }
    finally { await opened.file.close(); }
  }
  assert.deepEqual(Buffer.concat(parts), bytes);
  assert.equal((await fs.stat(path.join(directory, 'objects', id.slice(7)))).mode & 0o777, 0o600);
});

test('bad hashes, path injection, oversize chunks and quota do not install an object', async (t) => {
  const { store, directory } = await fixture(t, 100);
  const bytes = Buffer.from('correct'), { id, metadata } = asset(bytes), lease = await store.begin(id, metadata);
  await store.writeChunk(id, { uploadId: lease.uploadId, offset: 0, bytes: Buffer.from('corrupt') });
  await assert.rejects(store.finish(id, lease.uploadId), /哈希/);
  await assert.rejects(fs.stat(path.join(directory, 'objects', id.slice(7))), (error) => error.code === 'ENOENT');
  await assert.rejects(store.begin('../escape', metadata), /标识/);
  await assert.rejects(store.begin(`sha256:${'f'.repeat(64)}`, { ...metadata, byteLength: 101 }), (error) => error.statusCode === 507);
  await assert.rejects(store.writeChunk(id, { uploadId: lease.uploadId, offset: 0, bytes: Buffer.alloc(1024 * 1024 + 1) }), /预算/);
  await store.reset(id, lease.uploadId);
  assert.equal((await store.begin(id, metadata)).offset, 0);
});

test('resuming an expired upload renews its lease before another upload performs cleanup', async (t) => {
  const { directory, store } = await fixture(t);
  const bytes = Buffer.from('resumable-original');
  const { id, metadata } = asset(bytes);
  const lease = await store.begin(id, metadata);
  await store.writeChunk(id, { uploadId: lease.uploadId, offset: 0, bytes: bytes.subarray(0, 5) });
  const filename = path.join(directory, 'uploads', `${id.slice(7)}.json`);
  const record = JSON.parse(await fs.readFile(filename, 'utf8'));
  await fs.writeFile(filename, JSON.stringify({ ...record, updatedAt: Date.now() - 8 * 86400_000 }));
  const resumed = await store.begin(id, metadata);
  assert.equal(resumed.uploadId, lease.uploadId);
  assert.equal(resumed.offset, 5);
  const other = asset(Buffer.from('another-original'));
  await store.begin(other.id, other.metadata);
  await store.writeChunk(id, { uploadId: resumed.uploadId, offset: 5, bytes: bytes.subarray(5) });
  assert.equal((await store.finish(id, resumed.uploadId)).complete, true);
  assert.deepEqual(await fs.readFile(path.join(directory, 'objects', id.slice(7))), bytes);
});
