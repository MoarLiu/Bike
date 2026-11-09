const fs = require("node:fs/promises");
const path = require("node:path");
const { createAttachmentService, metadataFor } = require("./attachment-service.cjs");
const { exportWorkspaceArchive, importWorkspaceArchive } = require("./workspace-archive.cjs");
const { writeFileAtomically } = require("./workspace-lock.cjs");

const fileErrorMessages = {
  ENOENT: "此设备缺少所需附件或归档文件，请重新导入",
  EACCES: "没有附件库或目标文件的访问权限",
  EPERM: "没有附件库或目标文件的访问权限",
  ENOSPC: "存储空间不足，请释放空间后重试",
};

const installAttachmentIpc = ({ registerIpc, app, dialog, nativeImage, shell, getWindow, migrate }) => {
  let service;
  let readQueue = Promise.resolve();
  const imports = new Map();
  const scans = new Map();
  const openDirectories = new Set();
  app.once("will-quit", () => { for (const directory of openDirectories) void fs.rm(directory, { recursive: true, force: true }); });
  const library = () => service ??= createAttachmentService({ directory: path.join(app.getPath("userData"), "attachments") });
  const handle = (channel, callback) => registerIpc(channel, async (_event, payload) => {
    try { return { ok: true, ...(await callback(payload ?? {})) }; }
    catch (error) {
      const message = fileErrorMessages[error.code] ?? (error instanceof Error ? error.message : String(error));
      return { ok: false, error: message };
    }
  });
  const showOpen = (options) => getWindow() ? dialog.showOpenDialog(getWindow(), options) : dialog.showOpenDialog(options);
  const showSave = (options) => getWindow() ? dialog.showSaveDialog(getWindow(), options) : dialog.showSaveDialog(options);

  handle("attachment-import", async (payload) => {
    const { MAX_IMPORT_FILES, MAX_IMPORT_BYTES, MAX_ATTACHMENT_BYTES } = await import("../shared/bike-attachments.mjs");
    if (typeof payload.requestId !== "string" || !/^[\w-]{1,100}$/u.test(payload.requestId) || imports.has(payload.requestId)) {
      throw new Error("附件导入任务标识无效");
    }
    const controller = new AbortController();
    imports.set(payload.requestId, controller);
    try {
      let files = payload.files;
      if (payload.choose === true) {
        const selected = await showOpen({ title: "选择主题附件", properties: ["openFile", "multiSelections"] });
        if (selected.canceled) return { cancelled: true, assets: [], failures: [] };
        if (selected.filePaths.length > MAX_IMPORT_FILES) throw new Error("单批最多选择 100 个文件");
        files = await Promise.all(selected.filePaths.map(async (filename) => {
          const file = { filename, name: path.basename(filename), size: 0 };
          try { return { ...file, size: (await fs.lstat(filename)).size }; }
          catch (error) { return { ...file, error: fileErrorMessages[error.code] ?? error.message }; }
        }));
      } else {
        if (!Array.isArray(files)) throw new Error("附件批次无效");
        files = files.map((file) => {
          if (!file || !(file.bytes instanceof ArrayBuffer) && !(file.bytes instanceof Uint8Array)) throw new Error("附件内容无效");
          return { name: file.name, bytes: file.bytes, size: file.bytes.byteLength };
        });
      }
      if (!files.length || files.length > MAX_IMPORT_FILES ||
          files.reduce((sum, file) => sum + file.size, 0) > MAX_IMPORT_BYTES) {
        throw new Error("单批最多 100 个文件、合计 512 MiB");
      }
      const assets = [];
      const failures = [];
      for (const file of files) {
        if (controller.signal.aborted) return { cancelled: true, assets: [], failures };
        try {
          if (file.error) throw new Error(file.error);
          if (file.size > MAX_ATTACHMENT_BYTES) throw new Error("文件超过 128 MiB");
          assets.push(file.filename ? await library().importFile(file.filename) : await library().putBytes(file.bytes, file.name));
        } catch (error) { failures.push({ name: file.name, error: error.message }); }
      }
      return controller.signal.aborted ? { cancelled: true, assets: [], failures } : { assets, failures };
    } finally { imports.delete(payload.requestId); }
  });
  handle("attachment-cancel", async ({ requestId }) => {
    imports.get(requestId)?.abort();
    return {};
  });
  const readAttachment = async ({ assetId, thumbnail = true }) => {
    const { isPreviewableImage, MAX_IMAGE_PIXELS } = await import("../shared/bike-attachments.mjs");
    const bytes = await library().read(assetId);
    const metadata = metadataFor(bytes);
    if (!isPreviewableImage(metadata)) return { previewable: false, metadata };
    if (!thumbnail) return { previewable: true, metadata, dataUrl: `data:${metadata.mediaType};base64,${bytes.toString("base64")}` };
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error("图片解码失败，可将原始文件另存");
    const size = image.getSize();
    if (size.width * size.height > MAX_IMAGE_PIXELS) throw new Error("图片解码尺寸超过预算");
    const scale = Math.min(1, 512 / Math.max(size.width, size.height));
    const preview = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) });
    return { previewable: true, metadata, dataUrl: preview.toDataURL() };
  };
  handle("attachment-read", (payload) => {
    const result = readQueue.then(() => readAttachment(payload));
    readQueue = result.catch(() => {});
    return result;
  });
  handle("attachment-save", async ({ assetId, name }) => {
    const bytes = await library().read(assetId);
    const choice = await showSave({ title: "另存附件", defaultPath: path.basename(typeof name === "string" ? name : "附件") });
    if (choice.canceled || !choice.filePath) return { cancelled: true };
    await writeFileAtomically(choice.filePath, bytes);
    return { path: choice.filePath };
  });
  handle("attachment-open", async ({ assetId, name }) => {
    const bytes = await library().read(assetId);
    const directory = await fs.mkdtemp(path.join(app.getPath("temp"), "bike-open-"));
    const target = path.join(directory, path.basename(typeof name === "string" && name.trim() ? name : "附件"));
    try {
      await writeFileAtomically(target, bytes);
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      openDirectories.add(directory);
    } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
    return {};
  });
  handle("workspace-archive-export", async ({ workspace, readable }) => {
    const choice = await showSave({ title: "导出完整归档", defaultPath: readable ? "bike-document.zip" : "bike-workspace.zip", filters: [{ name: "Bike 归档", extensions: ["zip"] }] });
    if (choice.canceled || !choice.filePath) return { cancelled: true };
    return exportWorkspaceArchive({ workspace, filename: choice.filePath, attachments: library(), migrate, readable });
  });
  handle("workspace-archive-import", async () => {
    const choice = await showOpen({ title: "载入 Bike 工作区归档", properties: ["openFile"], filters: [{ name: "Bike 工作区", extensions: ["zip"] }] });
    if (choice.canceled || !choice.filePaths[0]) return { cancelled: true };
    return importWorkspaceArchive({ filename: choice.filePaths[0], attachments: library(), migrate });
  });
  handle("attachment-scan", async ({ protectedAssets }) => {
    if (!Array.isArray(protectedAssets) || protectedAssets.length > 100_000) throw new Error("附件保护清单无效");
    const result = await library().scan(protectedAssets);
    const ticket = require("node:crypto").randomUUID();
    scans.clear();
    scans.set(ticket, { ids: result.candidates.map((item) => item.assetId), expires: Date.now() + 60_000 });
    return { ...result, ticket };
  });
  handle("attachment-clean", async ({ protectedAssets, ticket }) => {
    const scan = scans.get(ticket);
    scans.delete(ticket);
    if (!scan || scan.expires < Date.now() || imports.size || !Array.isArray(protectedAssets)) throw new Error("清理扫描已过期或有在途导入，请重新扫描");
    const isolated = await library().quarantine(protectedAssets, scan.ids);
    const purged = await library().purge(protectedAssets);
    return { ...isolated, ...purged };
  });
  return { library };
};

module.exports = { installAttachmentIpc };
