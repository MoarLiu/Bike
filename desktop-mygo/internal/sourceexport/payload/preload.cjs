const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("bikeSourceExport", Object.freeze({
  options: () => ipcRenderer.invoke("source-export:options"),
  metadata: (id) => ipcRenderer.invoke("source-export:metadata", id),
  complete: (json) => ipcRenderer.invoke("source-export:complete", json),
  fail: (message) => ipcRenderer.invoke("source-export:fail", message),
}));
