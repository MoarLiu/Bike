const fs = require("node:fs/promises");
const path = require("node:path");
const { createAttachmentService } = require("./attachment-service.cjs");

// Called while holding the backup's workspace write lock. Every retained
// snapshot is a GC root; malformed/unreadable files abort cleanup.
const maintainBackupAssets = async (directory, prefix = "bike-workspace-") => {
  const { workspaceAttachmentAssets, attachmentDigest } = await import("../shared/bike-attachments.mjs");
  const { assertTextBudget } = await import("../shared/bike-limits.mjs");
  const protectedIds = new Set();
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name !== "bike-workspace.json" && !(entry.name.startsWith(prefix) && entry.name.endsWith(".json"))) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("备份根文件无效，已停止附件清理");
    const filename = path.join(directory, entry.name);
    if ((await fs.lstat(filename)).size > 64 * 1024 * 1024) throw new Error("备份根文件超过读取预算");
    const raw = await fs.readFile(filename, "utf8");
    assertTextBudget(raw);
    for (const { assetId } of workspaceAttachmentAssets(JSON.parse(raw))) protectedIds.add(assetId);
  }
  const manifests = path.join(directory, "attachment-manifests");
  try {
    const raw = await fs.readFile(path.join(manifests, "current.json"), "utf8");
    assertTextBudget(raw);
    for (const { assetId } of JSON.parse(raw).assets) { attachmentDigest(assetId); protectedIds.add(assetId); }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const library = createAttachmentService({ directory: path.join(directory, "attachments") });
  const scan = await library.scan(protectedIds);
  await library.quarantine(protectedIds, scan.candidates.map(item => item.assetId));
  await library.purge(protectedIds);
  for (const entry of await fs.readdir(manifests, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    if (entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)) await fs.rm(path.join(manifests, entry.name));
  }
};
module.exports = { maintainBackupAssets };
