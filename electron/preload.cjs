const { contextBridge, ipcRenderer } = require("electron");

const bikeBridge = {
  saveICloudBackup: (payload) => ipcRenderer.invoke("save-icloud-backup", payload),
  loadICloudBackup: () => ipcRenderer.invoke("load-icloud-backup"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  invokeAiProvider: (payload) => ipcRenderer.invoke("invoke-ai-provider", payload),
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
