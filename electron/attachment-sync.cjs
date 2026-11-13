const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeFileAtomically } = require('./workspace-lock.cjs');

const createAttachmentSync = ({ library, directory, onProgress = () => {} }) => {
  let active = null;
  const cancel = () => { active?.abort(new Error('附件同步已取消')); };
  const transfer = async ({ assets, config, signal: externalSignal }, controller) => {
    const { attachmentDigest, validateAttachmentMetadata, MAX_IMPORT_BYTES } = await import('../shared/bike-attachments.mjs');
    const { OPERATION_LIMITS } = await import('../shared/bike-operations.mjs');
    const { withRequestBudget, readResponseText } = await import('../shared/bike-network.mjs');
    if (!Array.isArray(assets) || assets.length > 1000) throw new Error('附件同步单批最多 1,000 个对象');
    const unique = new Map(); let total = 0;
    for (const item of assets) { attachmentDigest(item.assetId); validateAttachmentMetadata(item.metadata); unique.set(item.assetId, item); }
    for (const item of unique.values()) total += item.metadata.byteLength;
    if (total > MAX_IMPORT_BYTES) throw new Error('附件同步单批超过 512 MiB，请分批同步');
    const base = new URL(config.serverUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('同步服务地址无效');
    const abort = () => controller.abort(externalSignal.reason);
    externalSignal?.addEventListener('abort', abort, { once: true });
    if (externalSignal?.aborted) abort();
    const report = (assetId, phase, transferred, byteLength) => onProgress({ assetId, phase, transferred, byteLength });
    const request = (suffix, { method = 'GET', body, binary = false } = {}) => withRequestBudget({ signal: controller.signal, timeoutMs: 60_000 }, async (signal) => {
      const response = await fetch(`${config.serverUrl.replace(/\/+$/, '')}/api/v2/assets/${suffix}`, {
        method, signal, headers: { Authorization: `Bearer ${String(config.token ?? '').trim()}`,
          ...(body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }) },
        body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
      });
      if (!response.ok) {
        const raw = await readResponseText(response, { signal, maxBytes: 64 * 1024 });
        let data; try { data = JSON.parse(raw); } catch { data = {}; }
        throw Object.assign(new Error(data.message ?? `附件传输失败 HTTP ${response.status}`), { status: response.status, code: data.error });
      }
      if (binary && method === 'GET') {
        const chunks = []; let count = 0;
        for await (const chunk of response.body) {
          count += chunk.byteLength;
          if (count > OPERATION_LIMITS.attachmentChunkBytes) throw new Error('附件下载块超过 1 MiB');
          chunks.push(Buffer.from(chunk));
        }
        return { bytes: Buffer.concat(chunks, count), byteLength: Number(response.headers.get('x-bike-asset-length')) };
      }
      return JSON.parse(await readResponseText(response, { signal, maxBytes: 64 * 1024 }));
    });
    const upload = async (item, filename) => {
      const hash = attachmentDigest(item.assetId);
      const lease = await request(`${hash}/lease`, { method: 'POST', body: item.metadata });
      if (lease.complete) { report(item.assetId, 'complete', item.metadata.byteLength, item.metadata.byteLength); return; }
      if (!Number.isSafeInteger(lease.offset) || lease.offset < 0 || lease.offset > item.metadata.byteLength || typeof lease.uploadId !== 'string') throw new Error('远端上传租约无效');
      const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        let offset = lease.offset;
        const buffer = Buffer.alloc(OPERATION_LIMITS.attachmentChunkBytes);
        while (offset < item.metadata.byteLength) {
          controller.signal.throwIfAborted();
          const wanted = Math.min(buffer.length, item.metadata.byteLength - offset);
          const { bytesRead } = await file.read(buffer, 0, wanted, offset);
          if (bytesRead !== wanted) throw new Error('本机附件在上传期间发生变化');
          const result = await request(`${hash}/chunks?uploadId=${encodeURIComponent(lease.uploadId)}&offset=${offset}`, { method: 'PUT', body: buffer.subarray(0, bytesRead), binary: true });
          if (!Number.isSafeInteger(result.offset) || result.offset <= offset || result.offset > item.metadata.byteLength) throw new Error('远端续传偏移无效');
          offset = result.offset; report(item.assetId, 'upload', offset, item.metadata.byteLength);
        }
        await request(`${hash}/finish`, { method: 'POST', body: { uploadId: lease.uploadId } });
      } catch (error) {
        if (['asset_integrity', 'asset_metadata'].includes(error.code)) await request(`${hash}/lease`, { method: 'DELETE', body: { uploadId: lease.uploadId } }).catch(() => {});
        throw error;
      } finally { await file.close(); }
      report(item.assetId, 'complete', item.metadata.byteLength, item.metadata.byteLength);
    };
    const download = async (item) => {
      const hash = attachmentDigest(item.assetId), temporary = path.join(directory, `${hash}.part`), metadataFile = path.join(directory, `${hash}.json`);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryStat = await fs.lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('下载暂存目录无效');
      await writeFileAtomically(metadataFile, JSON.stringify({ assetId: item.assetId, metadata: item.metadata }));
      const file = await fs.open(temporary, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        let offset = (await file.stat()).size;
        if (offset > item.metadata.byteLength) { await file.truncate(0); offset = 0; }
        while (offset < item.metadata.byteLength || item.metadata.byteLength === 0) {
          controller.signal.throwIfAborted();
          const result = await request(`${hash}?offset=${offset}&length=${OPERATION_LIMITS.attachmentChunkBytes}`, { binary: true });
          if (result.byteLength !== item.metadata.byteLength || offset + result.bytes.length > result.byteLength || (!result.bytes.length && result.byteLength > 0)) throw new Error('下载长度与附件清单不一致');
          let written = 0;
          while (written < result.bytes.length) {
            const next = await file.write(result.bytes, written, result.bytes.length - written, offset + written);
            if (!next.bytesWritten) throw new Error('下载写入未前进'); written += next.bytesWritten;
          }
          offset += written; await file.sync(); report(item.assetId, 'download', offset, result.byteLength);
          if (item.metadata.byteLength === 0) break;
        }
      } finally { await file.close(); }
      const check = await fs.open(temporary, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let digest;
      try { const hash = crypto.createHash('sha256'); for await (const chunk of check.createReadStream({ autoClose: false })) { controller.signal.throwIfAborted(); hash.update(chunk); } digest = hash.digest('hex'); }
      finally { await check.close(); }
      if (digest !== hash) { await fs.rm(temporary, { force: true }); throw new Error('下载哈希不匹配，损坏对象未安装'); }
      const headerHandle = await fs.open(temporary, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let header;
      try { header = Buffer.alloc(Math.min(1024 * 1024, item.metadata.byteLength)); await headerHandle.read(header, 0, header.length, 0); }
      finally { await headerHandle.close(); }
      const actual = { ...require('./attachment-service.cjs').metadataFor(header), byteLength: item.metadata.byteLength };
      if (['byteLength', 'mediaType', 'width', 'height'].some((key) => actual[key] !== item.metadata[key])) throw new Error('下载格式与清单不一致，候选对象未安装');
      controller.signal.throwIfAborted();
      const installed = await library.importFile(temporary, { repairCorrupt: true });
      if (installed.assetId !== item.assetId || ['byteLength', 'mediaType', 'width', 'height'].some((key) => installed.metadata[key] !== item.metadata[key])) throw new Error('下载格式与清单不一致');
      await fs.rm(temporary, { force: true }); await fs.rm(metadataFile, { force: true });
      report(item.assetId, 'complete', item.metadata.byteLength, item.metadata.byteLength);
    };
    const errors = [], items = [...unique.values()]; let index = 0, completed = 0;
    const worker = async () => {
      while (index < items.length) {
        const item = items[index++];
        try {
          controller.signal.throwIfAborted();
          let source;
          try { source = await library.transferSource(item.assetId, item.metadata, controller.signal); }
          catch (error) { if (!['ENOENT', 'ATTACHMENT_INTEGRITY'].includes(error.code)) throw error; }
          if (source) await upload(item, source); else await download(item);
          completed++;
        } catch (error) { errors.push({ assetId: item.assetId, message: error.code === 'ENOSPC' ? '本机磁盘空间不足，传输状态和原件已保留' : error.message }); report(item.assetId, 'error', 0, item.metadata.byteLength); }
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(OPERATION_LIMITS.attachmentConcurrent, items.length) }, worker)); return { complete: completed === items.length, completed, total: items.length, errors }; }
    finally { externalSignal?.removeEventListener('abort', abort); }
  };
  const run = async (options) => {
    if (active) throw new Error('附件同步仍在进行');
    const controller = new AbortController();
    active = controller;
    try { await require("./temporary-files.cjs").cleanupTransferFiles(directory); return await transfer(options, controller); }
    finally { active = null; }
  };
  return { run, cancel };
};
module.exports = { createAttachmentSync };
