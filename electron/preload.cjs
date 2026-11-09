const { contextBridge, ipcRenderer } = require("electron");

const bikeBridge = {
  syncAttachments: (assets) => ipcRenderer.invoke("attachment-sync", { assets }),
  cancelAttachmentSync: () => ipcRenderer.invoke("attachment-sync-cancel"),
  onAttachmentSyncProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on("attachment-sync-progress", handler);
    return () => ipcRenderer.removeListener("attachment-sync-progress", handler);
  },
  getLiveMcpState: () => ipcRenderer.invoke("live-mcp-state"),
  startLiveMcp: (grant) => ipcRenderer.invoke("live-mcp-start", grant),
  stopLiveMcp: () => ipcRenderer.invoke("live-mcp-stop"),
  onLiveMcpRequest: (callback) => {
    const handler = (_event, request) => Promise.resolve().then(() => callback(request)).then(
      (result) => ipcRenderer.send("live-mcp-response", { id: request.id, ok: true, result }),
      (error) => ipcRenderer.send("live-mcp-response", { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    ipcRenderer.on("live-mcp-request", handler);
    return () => ipcRenderer.removeListener("live-mcp-request", handler);
  },
  onLiveMcpRevoke: (callback) => {
    ipcRenderer.on("live-mcp-revoked", callback);
    return () => ipcRenderer.removeListener("live-mcp-revoked", callback);
  },
  scanAttachments: (protectedAssets) => ipcRenderer.invoke("attachment-scan", { protectedAssets }),
  cleanAttachments: (protectedAssets, ticket) => ipcRenderer.invoke("attachment-clean", { protectedAssets, ticket }),
  importAttachments: (payload) => ipcRenderer.invoke("attachment-import", payload),
  cancelAttachmentImport: (requestId) => ipcRenderer.invoke("attachment-cancel", { requestId }),
  readAttachment: (assetId, thumbnail = true) => ipcRenderer.invoke("attachment-read", { assetId, thumbnail }),
  saveAttachment: (assetId, name) => ipcRenderer.invoke("attachment-save", { assetId, name }),
  openAttachment: (assetId, name) => ipcRenderer.invoke("attachment-open", { assetId, name }),
  exportWorkspaceArchive: (workspace, readable) => ipcRenderer.invoke("workspace-archive-export", { workspace, readable }),
  importWorkspaceArchive: () => ipcRenderer.invoke("workspace-archive-import"),
  saveICloudBackup: (payload) => ipcRenderer.invoke("save-icloud-backup", payload),
  loadICloudBackup: () => ipcRenderer.invoke("load-icloud-backup"),
  getBackupStatus: () => ipcRenderer.invoke("backup-status"),
  setBackupAuto: (enabled) => ipcRenderer.invoke("backup-set-auto", { enabled }),
  pauseBackup: () => ipcRenderer.invoke("backup-pause-source"),
  enqueueBackup: (payload) => ipcRenderer.invoke("backup-enqueue", payload),
  inspectBackup: () => ipcRenderer.invoke("backup-inspect"),
  replaceBackupWithLocal: (payload) => ipcRenderer.invoke("backup-replace-local", payload),
  acceptBackupBaseline: (hash, saved) => ipcRenderer.invoke("backup-accept-baseline", { hash, ...saved }),
  onBackupFlush: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("backup-flush-request", handler);
    return () => ipcRenderer.removeListener("backup-flush-request", handler);
  },
  finishBackupFlush: () => ipcRenderer.send("backup-flush-done"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  onUpdateState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("update-state", handler);
    return () => ipcRenderer.removeListener("update-state", handler);
  },
  onPrepareUpdate: (callback) => {
    const handler = (_event, requestId) => {
      Promise.resolve().then(callback).then(
        (result) => ipcRenderer.send("update-install-ready", { requestId, ok: result?.ok === true }),
        () => ipcRenderer.send("update-install-ready", { requestId, ok: false }),
      );
    };
    ipcRenderer.on("update-prepare-install", handler);
    return () => ipcRenderer.removeListener("update-prepare-install", handler);
  },
  invokeAiProvider: (payload) => ipcRenderer.invoke("invoke-ai-provider", payload),
  cancelAiRequest: (requestId) => ipcRenderer.invoke("cancel-ai-provider", { requestId }),
  invokeSyncRequest: (payload) => ipcRenderer.invoke("invoke-sync-request", payload),
  onEditCommand: (callback) => {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on("app-edit", handler);
    return () => ipcRenderer.removeListener("app-edit", handler);
  },
  onOpenApiConfig: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("open-api-config", handler);
    return () => ipcRenderer.removeListener("open-api-config", handler);
  },
};

contextBridge.exposeInMainWorld("bike", bikeBridge);
contextBridge.exposeInMainWorld("localOutline", bikeBridge);
