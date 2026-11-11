const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const { createWriteStream } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const yauzl = require("yauzl");
const yazl = require("yazl");
const { assertRegularWriteTarget } = require("./workspace-lock.cjs");
const { metadataFor } = require("./attachment-service.cjs");

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const contracts = () => import("../shared/bike-attachments.mjs");
const archiveAssets = async (workspace) => {
  const { readLocalMigration, localMigrationAttachmentAssets } = await import("../shared/bike-local-migration.mjs");
  readLocalMigration(workspace);
  return localMigrationAttachmentAssets(workspace);
};

const exportWorkspaceArchive = async ({ workspace, filename, attachments, migrate, readable }) => {
  const normalized = await migrate(workspace);
  const assets = await archiveAssets(normalized);
  const json = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`);
  if (readable && (!["document.md", "index.html"].includes(readable.name) || typeof readable.content !== "string")) throw new Error("导出正文参数无效");
  const readableBytes = readable ? Buffer.from(readable.content) : null;
  if (json.length > 64 * 1024 * 1024 || (readableBytes && readableBytes.length > 64 * 1024 * 1024)) throw new Error("归档正文超过 64 MiB");
  const manifest = Buffer.from(JSON.stringify({
    format: "bike-workspace",
    version: 1,
    complete: true,
    workspaceVersion: normalized.version,
    workspaceSha256: hash(json),
    assets,
    ...(readable ? { readable: { name: readable.name, sha256: hash(readableBytes) } } : {}),
  }, null, 2));
  const total = json.length + manifest.length + (readableBytes?.length ?? 0) + assets.reduce((sum, item) => sum + item.metadata.byteLength, 0);
  // Account for uncompressed ZIP headers, names and central-directory records.
  if (manifest.length > 4 * 1024 * 1024 || assets.length + 3 > MAX_ENTRIES || total + (assets.length + 3) * 512 > MAX_ARCHIVE_BYTES) {
    throw new Error("工作区超过本版 512 MiB 或 10,000 条目的归档预算");
  }
  const original = await assertRegularWriteTarget(filename);
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
  const zip = new yazl.ZipFile();
  zip.on("error", (error) => zip.outputStream.destroy(error));
  const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  let written = 0;
  const budget = new Transform({
    transform(chunk, _encoding, callback) {
      written += chunk.length;
      callback(written > MAX_ARCHIVE_BYTES ? new Error("归档超过 512 MiB 输出预算") : null, chunk);
    },
  });
  const writing = pipeline(zip.outputStream, budget, output);
  try {
    zip.addBuffer(manifest, "manifest.json");
    zip.addBuffer(json, "workspace.json");
    if (readable) zip.addBuffer(readableBytes, readable.name);
    for (const { assetId, metadata } of assets) {
      zip.addReadStreamLazy(`attachments/${assetId.slice(7)}`, { compress: false, size: metadata.byteLength }, (callback) => {
        attachments.read(assetId, metadata).then((bytes) => callback(null, Readable.from(bytes)), callback);
      });
    }
    zip.end();
    await writing;
    const handle = await fs.open(temporary, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    const latest = await assertRegularWriteTarget(filename);
    if (original ? !latest || ["ino", "dev", "mtimeMs", "size"].some((key) => original[key] !== latest[key]) : latest) {
      throw new Error("导出期间目标文件已变化，请重新选择保存位置");
    }
    await fs.rename(temporary, filename);
    return { path: filename, attachmentCount: assets.length, byteLength: written };
  } catch (error) {
    zip.outputStream.destroy(error);
    await writing.catch(() => {});
    await fs.rm(temporary, { force: true });
    throw error;
  }
};

const importWorkspaceArchive = async ({ filename, attachments, migrate }) => {
  const { MAX_ATTACHMENT_BYTES } = await contracts();
  let zip;
  let staging;
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) throw new Error("归档无效或超过 512 MiB");
    zip = await yauzl.openPromise(filename, { autoClose: true, lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
    // The async iterator observes parse errors, while this listener also
    // covers an asynchronous descriptor-close error during early cleanup.
    zip.on("error", () => {});
    if (zip.entryCount > MAX_ENTRIES) throw new Error("归档条目超过 10,000 项");
    staging = await fs.mkdtemp(path.join(os.tmpdir(), "bike-archive-"));
    const entries = new Map();
    let total = 0;
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      if ((mode !== 0 && mode !== 0o100000) || entry.isEncrypted() ||
          !["manifest.json", "workspace.json", "document.md", "index.html"].includes(name) && !/^attachments\/[a-f0-9]{64}$/u.test(name)) {
        throw new Error("归档包含不支持的路径、加密条目或特殊文件");
      }
      if (entries.has(name)) throw new Error("归档包含重复路径");
      const maximum = name === "manifest.json" ? 4 * 1024 * 1024 : !name.startsWith("attachments/") ? 64 * 1024 * 1024 : MAX_ATTACHMENT_BYTES;
      if (entry.uncompressedSize > maximum || total + entry.uncompressedSize > MAX_EXTRACTED_BYTES) {
        throw new Error("归档解压内容超过处理预算");
      }
      const target = path.join(staging, crypto.randomUUID());
      const digest = crypto.createHash("sha256");
      let size = 0;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          total += chunk.length;
          if (size > maximum || total > MAX_EXTRACTED_BYTES) {
            callback(new Error("归档解压内容超过处理预算"));
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      const stream = await zip.openReadStreamPromise(entry);
      await pipeline(stream, meter, createWriteStream(target, { flags: "wx", mode: 0o600 }));
      entries.set(name, { target, size, digest: digest.digest("hex") });
    }
    const manifestEntry = entries.get("manifest.json");
    const workspaceEntry = entries.get("workspace.json");
    if (!manifestEntry || !workspaceEntry) throw new Error("归档缺少工作区或清单");
    const manifest = JSON.parse(await fs.readFile(manifestEntry.target, "utf8"));
    if (manifest.format !== "bike-workspace" || manifest.version !== 1 || manifest.complete !== true ||
        !Array.isArray(manifest.assets) || manifest.workspaceSha256 !== workspaceEntry.digest) {
      throw new Error("归档版本或完整性校验失败");
    }
    const workspace = await migrate(JSON.parse(await fs.readFile(workspaceEntry.target, "utf8")));
    if (manifest.workspaceVersion !== workspace.version) throw new Error("归档工作区版本不一致");
    const expected = await archiveAssets(workspace);
    if (expected.length !== manifest.assets.length || entries.size !== expected.length + 2 + (manifest.readable ? 1 : 0)) throw new Error("归档附件清单不闭合");
    if (manifest.readable && (!["document.md", "index.html"].includes(manifest.readable.name) || entries.get(manifest.readable.name)?.digest !== manifest.readable.sha256)) throw new Error("归档可读正文校验失败");
    const listed = new Set();
    for (const item of manifest.assets) {
      if (!item || typeof item.assetId !== "string" || listed.has(item.assetId)) throw new Error("归档附件清单无效或重复");
      listed.add(item.assetId);
    }
    // Complete validation precedes any installation into the live library.
    for (const { assetId, metadata } of expected) {
      const entry = entries.get(`attachments/${assetId.slice(7)}`);
      const item = manifest.assets.find((item) => item.assetId === assetId);
      if (!entry || !item || entry.digest !== assetId.slice(7) || entry.size !== metadata.byteLength ||
          item.metadata?.byteLength !== metadata.byteLength || item.metadata?.mediaType !== metadata.mediaType) {
        throw new Error("归档附件缺失或摘要不一致");
      }
      const actual = metadataFor(await fs.readFile(entry.target));
      if (["byteLength", "mediaType", "width", "height"].some((key) => actual[key] !== metadata[key] || item.metadata[key] !== metadata[key])) {
        throw new Error("归档附件媒体类型或尺寸不一致");
      }
    }
    for (const { assetId } of expected) {
      const entry = entries.get(`attachments/${assetId.slice(7)}`);
      const installed = await attachments.importFile(entry.target, { repairCorrupt: true });
      if (installed.assetId !== assetId) throw new Error("安装附件时完整性校验失败");
    }
    return { workspace, attachmentCount: expected.length, byteLength: total };
  } finally {
    if (zip) zip.close();
    if (staging) await fs.rm(staging, { recursive: true, force: true });
  }
};

module.exports = { exportWorkspaceArchive, importWorkspaceArchive };
