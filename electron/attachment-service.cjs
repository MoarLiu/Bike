const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { withWorkspaceWriteLock, writeFileAtomically } = require("./workspace-lock.cjs");

const contracts = () => import("../shared/bike-attachments.mjs");

// Read dimensions before allowing an image decoder to allocate pixel memory.
const imageDimensions = (bytes, mediaType) => {
  if (mediaType === "image/png" && bytes.length >= 24 &&
      bytes.toString("ascii", 12, 16) === "IHDR") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mediaType === "image/jpeg") {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
      }
      offset += length;
    }
  }
  if (mediaType === "image/webp" && bytes.length >= 25) {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X" && bytes.length >= 30) {
      return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    }
    if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return {};
};

const metadataFor = (bytes) => {
  const header = bytes.subarray(0, 1024 * 1024);
  let mediaType = "application/octet-stream";
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mediaType = "image/png";
  else if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) mediaType = "image/jpeg";
  else if (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") mediaType = "image/webp";
  else if (header.toString("ascii", 0, 5) === "%PDF-") mediaType = "application/pdf";
  const dimensions = imageDimensions(header, mediaType);
  if (mediaType.startsWith("image/") && (!dimensions.width || !dimensions.height)) mediaType = "application/octet-stream";
  return { mediaType, byteLength: bytes.length, ...(mediaType.startsWith("image/") ? dimensions : {}) };
};

const createAttachmentService = ({ directory }) => {
  const root = path.resolve(directory);
  let initialized;
  const pinned = new Set();
  const quarantinePath = async (assetId) => {
    const { attachmentDigest } = await contracts();
    await initialize();
    const directory = path.join(root, "quarantine");
    await fs.mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("附件隔离目录无效");
    return path.join(directory, attachmentDigest(assetId));
  };
  const initialize = () => {
    initialized ??= (async () => {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("附件库目录无效或是符号链接");
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (!/^\.import-[a-f0-9-]+\.tmp$/u.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue;
        const filename = path.join(root, entry.name);
        if (Date.now() - (await fs.lstat(filename)).mtimeMs > 86400000) await fs.rm(filename);
      }
    })().catch((error) => { initialized = undefined; throw error; });
    return initialized;
  };
  const objectPath = async (assetId, create = false) => {
    const { attachmentDigest } = await contracts();
    const digest = attachmentDigest(assetId);
    await initialize();
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("附件库目录已变化");
    const parent = path.join(root, digest.slice(0, 2));
    if (create) await fs.mkdir(parent, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("附件子目录无效或是符号链接");
    return path.join(parent, digest);
  };
  const read = async (assetId, expected) => {
    const { attachmentDigest, MAX_ATTACHMENT_BYTES } = await contracts();
    attachmentDigest(assetId);
    pinned.add(assetId);
    const target = await objectPath(assetId, true);
    try { await fs.lstat(target); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const isolated = await quarantinePath(assetId);
      try { await fs.link(isolated, target); await fs.rm(isolated); }
      catch (failure) { if (failure.code !== "EEXIST") throw failure; }
    }
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) throw new Error("附件文件无效或超过大小预算");
      const chunks = [];
      let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > MAX_ATTACHMENT_BYTES) throw new Error("附件读取超过大小预算");
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, size);
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== attachmentDigest(assetId)) {
        const error = new Error("附件完整性校验失败，请从工作区 ZIP 备份重新导入");
        error.code = "ATTACHMENT_INTEGRITY";
        throw error;
      }
      const actual = metadataFor(bytes);
      if (expected && ["byteLength", "mediaType", "width", "height"].some((key) => actual[key] !== expected[key])) {
        throw new Error("附件文件与元数据不一致");
      }
      return bytes;
    } finally { await handle.close(); }
  };
  const putBytes = async (value, name = "附件") => {
    const { MAX_ATTACHMENT_BYTES } = await contracts();
    if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) throw new Error("附件内容无效");
    if (value.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("附件超过 128 MiB 大小预算");
    const bytes = Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    if (typeof name !== "string" || !name.trim() || name.length > 1024) throw new Error("附件名称无效");
    const assetId = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    const target = await objectPath(assetId, true);
    await withWorkspaceWriteLock(path.join(root, "library"), async () => {
      try { await read(assetId); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        await writeFileAtomically(target, bytes);
      }
    });
    pinned.add(assetId);
    return { assetId, name: path.basename(name), metadata: metadataFor(bytes) };
  };
  const importFile = async (filename, { repairCorrupt = false } = {}) => {
    const { MAX_ATTACHMENT_BYTES } = await contracts();
    await initialize();
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const temporary = path.join(root, `.import-${crypto.randomUUID()}.tmp`);
    let output;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) throw new Error("所选文件无效或超过 128 MiB");
      output = await fs.open(temporary, "wx", 0o600);
      const digest = crypto.createHash("sha256");
      const header = [];
      let headerSize = 0;
      let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > MAX_ATTACHMENT_BYTES) throw new Error("所选文件超过 128 MiB");
        digest.update(chunk);
        if (headerSize < 1024 * 1024) {
          const part = chunk.subarray(0, 1024 * 1024 - headerSize);
          header.push(part);
          headerSize += part.length;
        }
        await output.writeFile(chunk);
      }
      const final = await handle.stat();
      if (final.size !== stat.size || final.mtimeMs !== stat.mtimeMs || size !== stat.size) {
        throw new Error("所选文件在导入期间发生变化，请重试");
      }
      await output.sync();
      await output.close();
      output = null;
      const assetId = `sha256:${digest.digest("hex")}`;
      const target = await objectPath(assetId, true);
      await withWorkspaceWriteLock(path.join(root, "library"), async () => {
        try { await read(assetId); }
        catch (error) {
          if (error.code === "ENOENT") await fs.link(temporary, target);
          else if (repairCorrupt && error.code === "ATTACHMENT_INTEGRITY") {
            const retained = path.join(root, `.corrupt-${assetId.slice(7)}-${crypto.randomUUID()}.bak`);
            await fs.link(target, retained);
            await fs.rename(temporary, target);
          } else throw error;
          const directoryHandle = await fs.open(path.dirname(target), "r");
          try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
        }
      });
      pinned.add(assetId);
      const name = path.basename(filename);
      return { assetId, name: name.trim() ? name : "附件", metadata: { ...metadataFor(Buffer.concat(header, headerSize)), byteLength: size } };
    } finally {
      await output?.close();
      await handle.close();
      await fs.rm(temporary, { force: true });
    }
  };
  const transferSource = async (assetId, expected, signal) => {
    const { attachmentDigest } = await contracts();
    const target = await objectPath(assetId, true);
    pinned.add(assetId);
    if (!await fs.lstat(target).catch((error) => { if (error.code === "ENOENT") return null; throw error; })) {
      const isolated = await quarantinePath(assetId);
      await fs.link(isolated, target).catch((error) => { if (error.code !== "EEXIST") throw error; });
    }
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== expected.byteLength) throw Object.assign(new Error("本机附件长度与清单不一致"), { code: "ATTACHMENT_INTEGRITY" });
      const hash = crypto.createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false })) { signal?.throwIfAborted(); hash.update(chunk); }
      if (hash.digest("hex") !== attachmentDigest(assetId)) throw Object.assign(new Error("本机附件哈希校验失败"), { code: "ATTACHMENT_INTEGRITY" });
      const header = Buffer.alloc(Math.min(1024 * 1024, stat.size));
      await handle.read(header, 0, header.length, 0);
      const actual = { ...metadataFor(header), byteLength: stat.size };
      if (["mediaType", "width", "height"].some((key) => actual[key] !== expected[key])) throw Object.assign(new Error("本机附件格式与清单不一致"), { code: "ATTACHMENT_INTEGRITY" });
      return target;
    } finally { await handle.close(); }
  };
  const copyWorkspaceAssets = async (workspace, destination) => {
    const { workspaceAttachmentAssets } = await contracts();
    const assets = workspaceAttachmentAssets(workspace);
    const target = createAttachmentService({ directory: destination });
    for (const { assetId, metadata } of assets) {
      const bytes = await read(assetId, metadata);
      const installed = await target.putBytes(bytes);
      if (installed.assetId !== assetId) throw new Error("备份附件摘要不一致");
    }
    return assets;
  };
  const scan = async (protectedAssets) => {
    const { attachmentDigest } = await contracts();
    const protectedIds = new Set([...protectedAssets, ...pinned]);
    for (const id of protectedIds) attachmentDigest(id);
    await initialize();
    const candidates = [];
    for (const directory of await fs.readdir(root, { withFileTypes: true })) {
      if (!/^[a-f0-9]{2}$/u.test(directory.name)) continue;
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("附件库结构无效，已停止清理");
      for (const entry of await fs.readdir(path.join(root, directory.name), { withFileTypes: true })) {
        if (!/^[a-f0-9]{64}$/u.test(entry.name) || !entry.name.startsWith(directory.name) || !entry.isFile() || entry.isSymbolicLink()) throw new Error("附件对象无效，已停止清理");
        const assetId = `sha256:${entry.name}`;
        if (protectedIds.has(assetId)) continue;
        const stat = await fs.lstat(path.join(root, directory.name, entry.name));
        candidates.push({ assetId, byteLength: stat.size });
      }
    }
    return { candidates, protectedCount: protectedIds.size, byteLength: candidates.reduce((sum, item) => sum + item.byteLength, 0) };
  };
  const quarantine = async (protectedAssets, expectedCandidates) => {
    await initialize();
    return withWorkspaceWriteLock(path.join(root, "library"), async () => {
      const current = await scan(protectedAssets);
      const allowed = new Set(expectedCandidates);
      let moved = 0;
      for (const candidate of current.candidates) {
        if (!allowed.has(candidate.assetId)) continue;
        const source = await objectPath(candidate.assetId);
        const target = await quarantinePath(candidate.assetId);
        await fs.link(source, target);
        // mtime starts the retention window. The immutable object's contents
        // are unchanged and a future read can restore the hard link.
        const now = new Date();
        await fs.utimes(target, now, now);
        await fs.rm(source);
        moved++;
      }
      return { moved };
    });
  };
  const purge = async (protectedAssets, now = Date.now()) => {
    await initialize();
    const protectedIds = new Set([...protectedAssets, ...pinned]);
    const { attachmentDigest } = await contracts();
    for (const id of protectedIds) attachmentDigest(id);
    return withWorkspaceWriteLock(path.join(root, "library"), async () => {
      const folder = path.dirname(await quarantinePath(`sha256:${"0".repeat(64)}`));
      let removed = 0;
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        if (!/^[a-f0-9]{64}$/u.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) throw new Error("隔离区内容无效，已停止清理");
        const assetId = `sha256:${entry.name}`;
        const filename = path.join(folder, entry.name);
        const stat = await fs.lstat(filename);
        if (!protectedIds.has(assetId) && now - stat.mtimeMs >= 30 * 24 * 60 * 60 * 1000) { await fs.rm(filename); removed++; }
      }
      return { removed };
    });
  };
  return { initialize, read, putBytes, importFile, transferSource, copyWorkspaceAssets, scan, quarantine, purge };
};

module.exports = { createAttachmentService, metadataFor };
