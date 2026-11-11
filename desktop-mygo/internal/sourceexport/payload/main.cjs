// Only this application runs in the private runtime copy. Never load source code.
const { app, BrowserWindow, ipcMain, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const argument = process.argv.find((value) => value.startsWith("--bike-export-config="));
if (!argument) process.exit(2);
const config = JSON.parse(fs.readFileSync(argument.slice("--bike-export-config=".length), "utf8"));
app.setPath("userData", config.profile);
app.setPath("sessionData", config.profile);
app.setPath("appData", config.scratch);
app.setPath("logs", config.scratch);
app.setPath("crashDumps", config.scratch);
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-sync");
app.commandLine.appendSwitch("no-first-run");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("disable-breakpad");
let finished = false;
const fail = (message) => {
  if (finished) return;
  finished = true;
  fs.writeFileSync(config.error, String(message).slice(0, 4096), { flag: "wx", mode: 0o600 });
  app.exit(1);
};
process.on("uncaughtException", (error) => fail(error.message));
process.on("unhandledRejection", (error) => fail(error?.message ?? error));
app.whenReady().then(async () => {
  const index = pathToFileURL(path.join(__dirname, "index.html")).href;
  const renderer = pathToFileURL(path.join(__dirname, "renderer.js")).href;
  session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: details.url !== index && details.url !== renderer }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: false,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (url !== index) event.preventDefault(); });
  window.webContents.on("render-process-gone", () => fail("源副本读取进程意外退出"));
  const trusted = (event) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== index) throw new Error("导出器消息来源无效");
  };
  ipcMain.handle("source-export:options", (event) => { trusted(event); return config.options; });
  ipcMain.handle("source-export:metadata", (event, id) => {
    trusted(event);
    if (typeof id !== "string" || !Object.hasOwn(config.metadata, id))
      throw new Error("源审计附件缺少可验证的原件");
    return config.metadata[id];
  });
  ipcMain.handle("source-export:fail", (event, message) => { trusted(event); fail(message); });
  ipcMain.handle("source-export:complete", (event, json) => {
    trusted(event);
    if (finished || typeof json !== "string" || Buffer.byteLength(json) > 64 * 1024 * 1024)
      throw new Error("源副本超过处理预算");
    const file = fs.openSync(config.output, "wx", 0o600);
    try { fs.writeFileSync(file, json); fs.fsyncSync(file); }
    finally { fs.closeSync(file); }
    finished = true;
    // Exit only after Chromium has flushed the cloned storage.
    setImmediate(() => app.quit());
    return true;
  });
  await window.loadFile(path.join(__dirname, "index.html"));
}).catch((error) => fail(error.message));
