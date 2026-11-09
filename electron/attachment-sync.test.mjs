import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createAssetStore } from '../server/asset-store.mjs';
import { handleAssetApi } from '../server/asset-api.mjs';
const require = createRequire(import.meta.url);
const { createAttachmentService } = require('./attachment-service.cjs');
const { createAttachmentSync } = require('./attachment-sync.cjs');

test('attachment sync reserves its single run before asynchronous initialization and releases failed runs', async () => {
  const transfer = createAttachmentSync({ library: {}, directory: '' });
  const options = { assets: [], config: { serverUrl: 'http://127.0.0.1' } };
  const results = await Promise.allSettled([transfer.run(options), transfer.run(options)]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /仍在进行/);
  await assert.rejects(transfer.run({ assets: null, config: options.config }), /单批/);
  assert.equal((await transfer.run(options)).complete, true);
});

test('two local libraries upload and download original bytes over authenticated HTTP with cancellation and resume', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-asset-sync-'));
  const store = await createAssetStore({ directory: path.join(directory, 'server') });
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer fixture') { response.writeHead(401); response.end(); return; }
    requests.push(request.url);
    if (!await handleAssetApi(request, response, store)) { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const config = { serverUrl: `http://127.0.0.1:${server.address().port}`, token: 'fixture' };
  const a = createAttachmentService({ directory: path.join(directory, 'a') }), b = createAttachmentService({ directory: path.join(directory, 'b') });
  const bytes = randomBytes(2 * 1024 * 1024 + 99), item = await a.putBytes(bytes, 'original.bin');
  const assets = [{ assetId: item.assetId, metadata: item.metadata }];
  let cancelUpload = true;
  const upload = createAttachmentSync({ library: a, directory: path.join(directory, 'a-transfers'), onProgress: (progress) => { if (cancelUpload && progress.phase === 'upload') { cancelUpload = false; upload.cancel(); } } });
  const interrupted = await upload.run({ assets, config });
  assert.equal(interrupted.complete, false);
  assert.deepEqual(await a.read(item.assetId), bytes);
  requests.length = 0;
  assert.equal((await upload.run({ assets, config })).complete, true);
  assert.ok(requests.some((url) => url.includes('/chunks?') && url.includes('offset=1048576')));
  let cancelDownload = true;
  const download = createAttachmentSync({ library: b, directory: path.join(directory, 'b-transfers'), onProgress: (progress) => { if (cancelDownload && progress.phase === 'download') { cancelDownload = false; download.cancel(); } } });
  assert.equal((await download.run({ assets, config })).complete, false);
  requests.length = 0;
  assert.equal((await download.run({ assets, config })).complete, true);
  assert.ok(requests.some((url) => url.includes('?offset=1048576')));
  assert.deepEqual(await b.read(item.assetId, item.metadata), bytes);
  assert.equal((await download.run({ assets, config })).complete, true);
});

test('a partial ENOSPC upload preserves the original and resumes from persisted bytes after restart', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-asset-disk-full-'));
  const serverDirectory = path.join(directory, 'server');
  let store = await createAssetStore({ directory: serverDirectory });
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer fixture') { response.writeHead(401); response.end(); return; }
    if (!await handleAssetApi(request, response, store)) { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const original = createAttachmentService({ directory: path.join(directory, 'original') });
  const bytes = randomBytes(2 * 1024 * 1024 + 37), asset = await original.putBytes(bytes, 'disk-full.bin');
  const assets = [{ assetId: asset.assetId, metadata: asset.metadata }];
  const config = { serverUrl: `http://127.0.0.1:${server.address().port}`, token: 'fixture' };
  const transfer = createAttachmentSync({ library: original, directory: path.join(directory, 'transfers') });
  const nativeOpen = fs.open;
  const failingOpen = t.mock.method(fs, 'open', async (...args) => {
    const handle = await nativeOpen(...args);
    if (String(args[0]).startsWith(serverDirectory) && String(args[0]).endsWith('.part') && (args[1] & constants.O_RDWR)) {
      const write = handle.write.bind(handle);
      handle.write = async (buffer, offset, length, position) => {
        await write(buffer, offset, Math.min(length, 512 * 1024), position);
        throw Object.assign(new Error('ENOSPC disk-full fixture'), { code: 'ENOSPC' });
      };
    }
    return handle;
  });
  const failed = await transfer.run({ assets, config });
  failingOpen.mock.restore();
  assert.equal(failed.complete, false);
  assert.deepEqual(await original.read(asset.assetId, asset.metadata), bytes);
  const hash = asset.assetId.slice(7);
  assert.equal((await fs.stat(path.join(serverDirectory, 'uploads', `${hash}.part`))).size, 512 * 1024);
  await assert.rejects(fs.stat(path.join(serverDirectory, 'objects', hash)), (error) => error.code === 'ENOENT');
  store = await createAssetStore({ directory: serverDirectory });
  assert.equal((await transfer.run({ assets, config })).complete, true);
  const downloaded = createAttachmentService({ directory: path.join(directory, 'downloaded') });
  const receive = createAttachmentSync({ library: downloaded, directory: path.join(directory, 'download-transfers') });
  assert.equal((await receive.run({ assets, config })).complete, true);
  assert.deepEqual(await downloaded.read(asset.assetId, asset.metadata), bytes);
});
