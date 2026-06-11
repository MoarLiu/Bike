const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("localOutline", {
  saveICloudBackup: (payload) => ipcRenderer.invoke("save-icloud-backup", payload),
  loadICloudBackup: () => ipcRenderer.invoke("load-icloud-backup"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  invokeAiProvider: (payload) => ipcRenderer.invoke("invoke-ai-provider", payload),
  onOpenApiConfig: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("open-api-config", handler);
    return () => ipcRenderer.removeListener("open-api-config", handler);
  },
});
