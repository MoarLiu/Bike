import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const executable = process.env.BIKE_ELECTRON_EXECUTABLE;
if (!executable) throw new Error("请设置 BIKE_ELECTRON_EXECUTABLE，指向已打包的 Bike 可执行文件");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "bike-update-runtime-"));
const output = path.join(root, "output/playwright/updates-1.7.0");
let app;
try {
  app = await _electron.launch({
    executablePath: executable, args: [], cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", BIKE_TEST_USER_DATA: temporary, VITE_DEV_SERVER_URL: "" },
  });
  const page = await app.firstWindow();
  await page.locator(".shell").waitFor();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  const sample = {
    version: 1, activeDocumentId: "update-proof",
    documents: [{ id: "update-proof", title: "更新保存验证", nodes: [{ id: "topic", text: "更新前", children: [] }] }],
  };
  await page.locator("input[type=file]").setInputFiles({
    name: "workspace.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(sample)),
  });
  await page.locator("[data-node-id=topic] textarea").waitFor();
  await app.evaluate(({ app, dialog }) => {
    const { createRequire } = process.getBuiltinModule("module");
    const localRequire = createRequire(app.getAppPath() + "/package.json");
    const { autoUpdater } = localRequire("electron-updater");
    globalThis.__updateProof = { calls: [], confirmations: [], choices: [0, 0, 0, 1] };
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      globalThis.__updateProof.confirmations.push(options.buttons);
      return { response: globalThis.__updateProof.choices.shift() ?? 1 };
    };
    autoUpdater.checkForUpdates = async () => {
      globalThis.__updateProof.calls.push("check");
      autoUpdater.emit("update-available", { version: "1.7.1" });
      return {};
    };
    autoUpdater.downloadUpdate = async () => {
      globalThis.__updateProof.calls.push("download");
      autoUpdater.emit("download-progress", { percent: 40 });
      await new Promise((resolve) => { globalThis.__finishUpdateDownload = resolve; });
      autoUpdater.emit("update-downloaded", { version: "1.7.1" });
      return [];
    };
    autoUpdater.quitAndInstall = () => { globalThis.__updateProof.calls.push("install"); };
  });
  await page.locator("[data-node-id=topic] textarea").fill("更新前必须保存的草稿");
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await page.waitForFunction(() => document.body.textContent.includes("正在下载更新 40%"));
  await app.evaluate(() => globalThis.__finishUpdateDownload());
  await page.waitForFunction(() => document.querySelector(".shell")?.inert === true);
  await page.waitForFunction(() => document.body.textContent.includes("正在安装更新"));
  const proof = await app.evaluate(() => globalThis.__updateProof);
  assert.deepEqual(proof.calls, ["check", "download", "install"]);
  assert.equal(proof.confirmations[0][0], "下载更新");
  assert.equal(proof.confirmations[1][0], "重启并安装");
  const stored = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("bike-db");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("workspace-store");
        const request = tx.objectStore("workspace-store").get("workspace");
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  });
  assert.equal(stored.documents[0].nodes[0].text, "更新前必须保存的草稿");
  await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule("module");
    createRequire(app.getAppPath() + "/package.json")("electron-updater").autoUpdater.emit(
      "error", Object.assign(new Error("fixture signature rejection"), { code: "ERR_UPDATER_INVALID_SIGNATURE" }),
    );
  });
  await page.waitForFunction(() => document.querySelector(".shell")?.inert === false);
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await page.waitForFunction(() => document.body.textContent.includes("正在下载更新 40%"));
  await app.evaluate(() => globalThis.__finishUpdateDownload());
  await page.waitForFunction(() => document.body.textContent.includes("更新已下载，可通过检查更新入口重启安装"));
  assert.equal((await app.evaluate(() => globalThis.__updateProof.calls)).filter((item) => item === "install").length, 1);
  assert.deepEqual(errors, []);
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, "downloaded.png") });
  const evidence = {
    version: await app.evaluate(({ app }) => app.getVersion()),
    updateBackend: "real electron-updater instance with controlled check, download and quit methods",
    checks: ["normal UI and trusted IPC entry", "native download and restart confirmations", "renderer download progress", "draft persisted before install", "editing frozen during install", "native signature failure unlocks editing", "retry and defer installation"],
    errors, realSignedUpgrade: "pending signing credentials and two signed releases",
  };
  await fs.writeFile(path.join(output, "results.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await app?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
