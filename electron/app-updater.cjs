const crypto = require("node:crypto");

const UPDATE_FEED = Object.freeze({ provider: "github", owner: "MoarLiu", repo: "Bike" });
const updateError = (error) => {
  if (error.code === "ERR_UPDATE_SAVE") return error.message;
  if (error.code === "ERR_UPDATER_ZIP_FILE_NOT_FOUND") return "发布版本缺少 macOS ZIP 更新包，请等待发布者补齐";
  if (error.code === "ERR_UPDATER_INVALID_SIGNATURE") return "更新签名校验失败，请稍后重试";
  return "更新检查或下载失败，请检查网络后重试";
};

const createUpdateController = ({ updater, currentVersion, supported, onState = () => {}, prepareInstall }) => {
  let state = { status: "idle", currentVersion, latestVersion: "", updateAvailable: false, progress: 0 };
  let checking;
  let downloading;
  let installing;
  let cancellationToken;
  const snapshot = () => ({ ...state });
  const publish = (patch) => {
    state = { ...state, error: undefined, ...patch };
    onState(snapshot());
    return snapshot();
  };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.setFeedURL(UPDATE_FEED);
  updater.on("update-available", (info) => publish({
    status: "available", latestVersion: info.version, updateAvailable: true, progress: 0,
  }));
  updater.on("update-not-available", () => publish({ status: "not-available", updateAvailable: false }));
  updater.on("download-progress", (info) => {
    if (state.status === "downloading") publish({ progress: Math.max(0, Math.min(100, Number(info.percent) || 0)) });
  });
  updater.on("update-downloaded", (info) => publish({
    status: "downloaded", latestVersion: info.version, updateAvailable: true, progress: 100,
  }));
  updater.on("error", (error) => publish({ status: "error", error: updateError(error) }));

  const check = () => {
    if (!supported) return Promise.resolve(publish({ status: "unsupported", error: "应用内更新通过已安装的 macOS 桌面版使用" }));
    if (checking) return checking;
    if (["downloading", "downloaded", "preparing", "installing"].includes(state.status)) return Promise.resolve(snapshot());
    publish({ status: "checking", latestVersion: "", updateAvailable: false, progress: 0 });
    checking = Promise.resolve().then(() => updater.checkForUpdates()).then((result) => {
      cancellationToken = result?.cancellationToken;
      if (state.status === "checking") throw new Error("Update check did not complete");
      return snapshot();
    }).catch((error) => publish({ status: "error", error: updateError(error) }))
      .finally(() => { checking = undefined; });
    return checking;
  };
  const download = () => {
    if (downloading) return downloading;
    if (state.status === "downloaded") return Promise.resolve(snapshot());
    if (state.status !== "available") return Promise.resolve(snapshot());
    publish({ status: "downloading", progress: 0 });
    downloading = Promise.resolve().then(() => updater.downloadUpdate(cancellationToken)).then(() => {
      if (state.status === "downloading") throw new Error("Update download did not complete");
      return snapshot();
    }).catch((error) => publish({ status: "error", error: updateError(error) }))
      .finally(() => { downloading = undefined; });
    return downloading;
  };
  const install = () => {
    if (installing) return installing;
    if (state.status !== "downloaded") return Promise.resolve(snapshot());
    publish({ status: "preparing" });
    installing = Promise.resolve().then(() => prepareInstall()).then(() => {
      if (state.status !== "preparing") throw new Error("Update preparation was interrupted");
      publish({ status: "installing" });
      updater.quitAndInstall();
      return snapshot();
    }).catch((error) => publish({
      status: "downloaded", error: error.code === "ERR_UPDATE_SAVE" ? error.message : "更新安装未完成，请稍后重试",
    })).finally(() => { installing = undefined; });
    return installing;
  };
  return { check, download, install, snapshot };
};

const requestInstallPreparation = ({ ipcMain, window, isTrusted, timeoutMs = 30_000 }) => new Promise((resolve, reject) => {
  const failure = (message) => Object.assign(new Error(message), { code: "ERR_UPDATE_SAVE" });
  if (!window || window.webContents.isDestroyed()) {
    reject(failure("请先打开工作区，再重试安装更新"));
    return;
  }
  const requestId = crypto.randomUUID();
  const finish = (error) => {
    clearTimeout(timer);
    ipcMain.removeListener("update-install-ready", receipt);
    window.removeListener("closed", closed);
    if (error) reject(error);
    else resolve();
  };
  const receipt = (event, payload) => {
    if (!isTrusted(event, window) || payload?.requestId !== requestId) return;
    finish(payload.ok === true ? null : failure("工作区尚未安全保存，请处理保存冲突或在途任务后重试"));
  };
  const closed = () => finish(failure("工作区窗口已关闭，请重新打开后安装"));
  const timer = setTimeout(() => finish(failure("保存工作区超时，已停止安装，请重试")), timeoutMs);
  ipcMain.on("update-install-ready", receipt);
  window.once("closed", closed);
  try { window.webContents.send("update-prepare-install", requestId); }
  catch { finish(failure("无法联系工作区窗口，请重新打开后安装")); }
});

module.exports = { UPDATE_FEED, createUpdateController, requestInstallPreparation };
