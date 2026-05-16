const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("localOutline", {
  saveICloudBackup: (payload) => ipcRenderer.invoke("save-icloud-backup", payload),
  loadICloudBackup: () => ipcRenderer.invoke("load-icloud-backup"),
});
