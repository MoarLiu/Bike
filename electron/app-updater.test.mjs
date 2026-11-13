import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createUpdateController, requestInstallPreparation, UPDATE_FEED } from "./app-updater.cjs";

const fixture = (options = {}) => {
  const updater = new EventEmitter();
  let checks = 0, downloads = 0, installs = 0, saves = 0;
  updater.setFeedURL = (feed) => { updater.feed = feed; };
  updater.checkForUpdates = async () => {
    checks++;
    updater.emit("update-available", { version: "1.7.1" });
    return { cancellationToken: {} };
  };
  updater.downloadUpdate = async () => {
    downloads++;
    updater.emit("download-progress", { percent: 51.2 });
    updater.emit("update-downloaded", { version: "1.7.1" });
  };
  updater.quitAndInstall = () => { installs++; };
  const states = [];
  const service = createUpdateController({
    updater, currentVersion: "1.7.0", supported: true, onState: (state) => states.push(state),
    prepareInstall: async () => { saves++; }, ...options,
  });
  return { updater, service, states, counts: () => ({ checks, downloads, installs, saves }) };
};

test("updates use the owning repository and require explicit download and installation", async () => {
  const f = fixture();
  assert.deepEqual(f.updater.feed, UPDATE_FEED);
  assert.equal(f.updater.autoDownload, false);
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.allowPrerelease, false);
  assert.equal(f.updater.allowDowngrade, false);
  assert.equal((await f.service.check()).status, "available");
  assert.equal(f.counts().downloads, 0);
  assert.equal((await f.service.download()).status, "downloaded");
  assert.equal(f.counts().installs, 0);
  assert.ok(f.states.some((s) => s.progress === 51.2));
  assert.equal((await f.service.install()).status, "installing");
  assert.deepEqual(f.counts(), { checks: 1, downloads: 1, installs: 1, saves: 1 });
});

test("repeated checks, downloads and install clicks share their in-flight operation", async () => {
  const f = fixture();
  const check = f.service.check();
  assert.equal(f.service.check(), check);
  await check;
  const download = f.service.download();
  assert.equal(f.service.download(), download);
  await download;
  await f.service.check();
  const install = f.service.install();
  assert.equal(f.service.install(), install);
  await install;
  assert.deepEqual(f.counts(), { checks: 1, downloads: 1, installs: 1, saves: 1 });
});

test("up-to-date and development environments do not download an update", async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => { f.updater.emit("update-not-available"); return {}; };
  assert.equal((await f.service.check()).status, "not-available");
  await f.service.download();
  assert.equal(f.counts().downloads, 0);
  const dev = fixture({ supported: false });
  assert.equal((await dev.service.check()).status, "unsupported");
  assert.equal(dev.counts().checks, 0);
});

test("ad-hoc installations use an explicit manual release path", async () => {
  const f = fixture({ manualOnly: true, fetchRelease: async () => ({ latestVersion: "2.0.1", updateAvailable: true }) });
  assert.equal((await f.service.check()).status, "manual");
  await f.service.download(); await f.service.install();
  assert.deepEqual(f.counts(), { checks: 0, downloads: 0, installs: 0, saves: 0 });
});

test("signed updates pin a filtered stable tag and reject mismatched manifests", async () => {
  const f = fixture({ resolveRelease: async () => ({ latestVersion: "2.0.1", updateAvailable: true }) });
  assert.equal((await f.service.check()).status, "error");
  assert.deepEqual(f.updater.feed, { provider: "generic", url: "https://github.com/MoarLiu/Bike/releases/download/v2.0.1/", useMultipleRangeRequest: false });
  await f.service.download();
  assert.equal(f.counts().downloads, 0);
});

test("network and download failures can be retried and never expose local cache paths", async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => { throw new Error("/private/local-cache"); };
  assert.equal((await f.service.check()).status, "error");
  assert.ok(!f.service.snapshot().error.includes("/private"));
  f.updater.checkForUpdates = async () => { f.updater.emit("update-available", { version: "1.7.1" }); return {}; };
  await f.service.check();
  f.updater.downloadUpdate = async () => { throw new Error("download failed"); };
  assert.equal((await f.service.download()).status, "error");
  assert.equal(f.counts().installs, 0);
  assert.equal((await f.service.check()).status, "available");
});

test("save failure keeps the downloaded update available and prevents quit", async () => {
  const f = fixture({ prepareInstall: async () => { throw Object.assign(new Error("save failed"), { code: "ERR_UPDATE_SAVE" }); } });
  await f.service.check();
  await f.service.download();
  assert.equal((await f.service.install()).status, "downloaded");
  assert.equal(f.service.snapshot().error, "save failed");
  assert.equal(f.counts().installs, 0);
});

test("a native installer error returns an error state instead of a success message", async () => {
  const f = fixture();
  await f.service.check();
  await f.service.download();
  await f.service.install();
  f.updater.emit("error", Object.assign(new Error("invalid signature"), { code: "ERR_UPDATER_INVALID_SIGNATURE" }));
  assert.equal(f.service.snapshot().status, "error");
  assert.match(f.service.snapshot().error, /签名/);
});

test("install preparation accepts only the current trusted window and matching request", async () => {
  const ipcMain = new EventEmitter(), window = new EventEmitter();
  let requestId;
  window.webContents = { isDestroyed: () => false, send: (_channel, id) => { requestId = id; } };
  const operation = requestInstallPreparation({ ipcMain, window, isTrusted: (event) => event.sender === window.webContents });
  ipcMain.emit("update-install-ready", { sender: {} }, { requestId, ok: true });
  ipcMain.emit("update-install-ready", { sender: window.webContents }, { requestId: "stale", ok: true });
  assert.equal(ipcMain.listenerCount("update-install-ready"), 1);
  ipcMain.emit("update-install-ready", { sender: window.webContents }, { requestId, ok: true });
  await operation;
  assert.equal(ipcMain.listenerCount("update-install-ready"), 0);
  assert.equal(window.listenerCount("closed"), 0);
});

test("install preparation aborts on timeout or a window closing", async () => {
  const ipcMain = new EventEmitter(), window = new EventEmitter();
  window.webContents = { isDestroyed: () => false, send() {} };
  await assert.rejects(requestInstallPreparation({ ipcMain, window, isTrusted: () => true, timeoutMs: 5 }), /超时/);
  const operation = requestInstallPreparation({ ipcMain, window, isTrusted: () => true });
  window.emit("closed");
  await assert.rejects(operation, /已关闭/);
  assert.equal(ipcMain.listenerCount("update-install-ready"), 0);
});
