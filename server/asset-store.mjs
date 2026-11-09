import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { attachmentDigest, validateAttachmentMetadata, MAX_ATTACHMENT_BYTES } from '../shared/bike-attachments.mjs';
import { OPERATION_LIMITS } from '../shared/bike-operations.mjs';
const require = createRequire(import.meta.url);
const { withWorkspaceWriteLock, writeFileAtomically } = require('../electron/workspace-lock.cjs');
const { metadataFor } = require('../electron/attachment-service.cjs');
const fail = (message, statusCode = 400, code = 'asset_error') => Object.assign(new Error(message), { statusCode, code });
const fileExists = async (file) => fs.lstat(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
const safeFile = async (file, flags = constants.O_RDONLY) => fs.open(file, flags | (constants.O_NOFOLLOW ?? 0), 0o600);
const verifyFile = async (filename, assetId) => {
  const handle = await safeFile(filename);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) throw fail('远端附件对象无效', 422, 'asset_integrity');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const header = Buffer.alloc(Math.min(1024 * 1024, stat.size));
    await handle.read(header, 0, header.length, 0);
    return { valid: hash.digest('hex') === attachmentDigest(assetId), size: stat.size,
      metadata: { ...metadataFor(header), byteLength: stat.size } };
  } finally { await handle.close(); }
};

export const createAssetStore = async ({ directory, quotaBytes = 2 * 1024 * 1024 * 1024 }) => {
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1) throw new Error('附件配额必须是正整数');
  const root = path.resolve(directory), objects = path.join(root, 'objects'), uploads = path.join(root, 'uploads');
  for (const folder of [root, objects, uploads]) {
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('附件服务目录无效');
    await fs.chmod(folder, 0o700);
  }
  const paths = (assetId) => { const hash = attachmentDigest(assetId); return { object: path.join(objects, hash), partial: path.join(uploads, `${hash}.part`), lease: path.join(uploads, `${hash}.json`), lock: path.join(uploads, hash) }; };
  const readLease = async (file) => {
    const handle = await safeFile(file);
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 4096) throw fail('上传租约无效'); return JSON.parse(await handle.readFile('utf8')); }
    finally { await handle.close(); }
  };
  const checkQuota = async (additional) => {
    let used = 0, count = 0;
    for (const entry of await fs.readdir(objects, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw fail('对象库结构无效', 500);
      used += (await fs.lstat(path.join(objects, entry.name))).size;
    }
    for (const entry of await fs.readdir(uploads, { withFileTypes: true })) {
      if (!entry.name.endsWith('.json')) continue;
      const hash = entry.name.slice(0, -5);
      if (!/^[a-f0-9]{64}$/.test(hash)) throw fail('上传租约路径无效');
      await withWorkspaceWriteLock(path.join(uploads, hash), async () => {
        const filename = path.join(uploads, entry.name);
        if (!await fileExists(filename)) return;
        const lease = await readLease(filename);
        if (Date.now() - lease.updatedAt > 7 * 86400_000) {
          await fs.rm(path.join(uploads, `${hash}.part`), { force: true });
          await fs.rm(filename, { force: true });
        } else { used += lease.metadata.byteLength; count++; }
      });
    }
    if (count >= 32 || used + additional > quotaBytes) throw fail('远端附件空间或并发租约配额已满，本机原件仍保留', 507, 'asset_quota');
  };
  const begin = async (assetId, metadata) => {
    validateAttachmentMetadata(metadata);
    const target = paths(assetId);
    return withWorkspaceWriteLock(path.join(root, 'quota'), () => withWorkspaceWriteLock(target.lock, async () => {
      if (await fileExists(target.object)) {
        const current = await verifyFile(target.object, assetId);
        if (current.valid && current.size === metadata.byteLength) {
          if (['mediaType', 'width', 'height'].some((key) => current.metadata[key] !== metadata[key])) throw fail('附件格式与清单不一致', 422, 'asset_metadata');
          await fs.rm(target.partial, { force: true }); await fs.rm(target.lease, { force: true });
          return { complete: true, offset: current.size, byteLength: current.size };
        }
      }
      if (await fileExists(target.lease)) {
        const lease = await readLease(target.lease);
        if (['byteLength', 'mediaType', 'width', 'height'].some((key) => lease.metadata[key] !== metadata[key])) throw fail('上传元数据与已有租约不同', 409);
        const partial = await fileExists(target.partial);
        if (partial && (!partial.isFile() || partial.isSymbolicLink() || partial.size > metadata.byteLength)) throw fail('上传临时文件无效', 422);
        if (!partial) { const handle = await safeFile(target.partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL); await handle.close(); }
        await writeFileAtomically(target.lease, JSON.stringify({ ...lease, updatedAt: Date.now() }));
        return { complete: false, uploadId: lease.id, offset: partial?.size ?? 0, byteLength: metadata.byteLength };
      }
      await checkQuota(metadata.byteLength);
      const lease = { id: randomUUID(), metadata, updatedAt: Date.now() };
      await writeFileAtomically(target.lease, JSON.stringify(lease));
      const handle = await safeFile(target.partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL); await handle.close();
      return { complete: false, uploadId: lease.id, offset: 0, byteLength: metadata.byteLength };
    }));
  };
  const leaseFor = async (target, uploadId) => {
    const lease = await readLease(target.lease);
    if (typeof uploadId !== 'string' || lease.id !== uploadId) throw fail('上传租约已失效', 409, 'stale_upload');
    return lease;
  };
  const writeChunk = async (assetId, { uploadId, offset, bytes }) => {
    const target = paths(assetId);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Buffer.isBuffer(bytes) || bytes.length > OPERATION_LIMITS.attachmentChunkBytes) throw fail('续传块超过预算或偏移无效');
    return withWorkspaceWriteLock(target.lock, async () => {
      const lease = await leaseFor(target, uploadId);
      if (offset + bytes.length > lease.metadata.byteLength) throw fail('续传块超过文件长度');
      const file = await safeFile(target.partial, constants.O_RDWR);
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw fail('上传临时对象无效');
        if (offset < stat.size && offset + bytes.length <= stat.size) {
          const existing = Buffer.alloc(bytes.length); await file.read(existing, 0, existing.length, offset);
          if (!existing.equals(bytes)) throw fail('同一续传偏移携带不同字节', 409, 'chunk_mismatch');
          return { offset: stat.size, byteLength: lease.metadata.byteLength };
        }
        if (offset !== stat.size) throw fail(`续传偏移不一致，当前偏移 ${stat.size}`, 409, 'offset_mismatch');
        let written = 0;
        while (written < bytes.length) {
          const result = await file.write(bytes, written, bytes.length - written, offset + written);
          if (!result.bytesWritten) throw fail('附件写入未前进', 507);
          written += result.bytesWritten;
        }
        await file.sync();
        await writeFileAtomically(target.lease, JSON.stringify({ ...lease, updatedAt: Date.now() }));
        return { offset: offset + written, byteLength: lease.metadata.byteLength };
      } finally { await file.close(); }
    });
  };
  const finish = async (assetId, uploadId) => {
    const target = paths(assetId);
    return withWorkspaceWriteLock(path.join(root, 'quota'), () => withWorkspaceWriteLock(target.lock, async () => {
      if (await fileExists(target.object)) {
        const previous = await verifyFile(target.object, assetId);
        if (previous.valid) { await fs.rm(target.partial, { force: true }); await fs.rm(target.lease, { force: true }); return { complete: true, assetId, byteLength: previous.size }; }
      }
      const lease = await leaseFor(target, uploadId), verified = await verifyFile(target.partial, assetId);
      if (!verified.valid || verified.size !== lease.metadata.byteLength) throw fail('上传附件哈希或长度校验失败，请重新传输', 422, 'asset_integrity');
      const handle = await safeFile(target.partial);
      let header;
      try { header = Buffer.alloc(Math.min(1024 * 1024, verified.size)); await handle.read(header, 0, header.length, 0); }
      finally { await handle.close(); }
      const actual = { ...metadataFor(header), byteLength: verified.size };
      if (['byteLength', 'mediaType', 'width', 'height'].some((key) => actual[key] !== lease.metadata[key])) throw fail('附件格式与清单不一致', 422, 'asset_metadata');
      if (await fileExists(target.object)) {
        if ((await verifyFile(target.object, assetId)).valid) {
          await fs.rm(target.partial, { force: true });
        } else {
          await fs.rename(target.object, `${target.object}.corrupt-${randomUUID()}`);
          await fs.rename(target.partial, target.object);
        }
      } else await fs.rename(target.partial, target.object);
      const folder = await fs.open(objects, 'r'); try { await folder.sync(); } finally { await folder.close(); }
      await fs.rm(target.lease, { force: true });
      return { complete: true, assetId, byteLength: verified.size };
    }));
  };
  const reset = async (assetId, uploadId) => {
    const target = paths(assetId);
    return withWorkspaceWriteLock(target.lock, async () => {
      await leaseFor(target, uploadId);
      await fs.rm(target.partial, { force: true }); await fs.rm(target.lease, { force: true });
      return { reset: true };
    });
  };
  const openChunk = async (assetId, offset, length = OPERATION_LIMITS.attachmentChunkBytes) => {
    const target = paths(assetId);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > OPERATION_LIMITS.attachmentChunkBytes) throw fail('下载块偏移或长度无效');
    let file;
    try { file = await safeFile(target.object); } catch (error) { if (error.code === 'ENOENT') throw fail('附件字节尚未上传', 404, 'asset_missing'); throw error; }
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES || offset > stat.size) { await file.close(); throw fail('下载对象或偏移无效'); }
    const size = Math.min(length, stat.size - offset);
    return { file, offset, length: size, byteLength: stat.size };
  };
  return { begin, writeChunk, finish, reset, openChunk, quotaBytes };
};
