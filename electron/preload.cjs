const { contextBridge, ipcRenderer } = require("electron");

const bikeBridge = {
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
