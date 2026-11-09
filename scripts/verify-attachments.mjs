import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright";
import yauzl from "yauzl";
import { PDFDocument, PDFRawStream, PDFName } from "pdf-lib";
import { createAttachmentService } from "../electron/attachment-service.cjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const { version } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const artifacts = path.join(root, "output", "playwright", `attachments-${version}`);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "bike-attachments-runtime-"));
const errors = [];
const checks = [];
let app;

const readStored = (page) => page.evaluate(async () => {
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
const waitForSavedRefs = async (page, count) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const workspace = await readStored(page);
    if (workspace?.documents[0]?.nodes[0]?.attachmentRefs?.length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`附件引用尚未持久保存，期望数量 ${count}`);
};
const launch = async (userData) => {
  const executable = process.env.BIKE_ELECTRON_EXECUTABLE;
  app = await _electron.launch({
    ...(executable ? { executablePath: executable } : {}),
    args: executable ? [] : [root],
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", BIKE_TEST_USER_DATA: userData, VITE_DEV_SERVER_URL: "" },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator(".shell").waitFor();
  await app.evaluate(({ session }, directory) => {
    globalThis.__attachmentDownloads = [];
    session.defaultSession.on("will-download", (_event, item) => {
      const download = { filename: `${directory}/${item.getFilename()}`, state: "pending" };
      globalThis.__attachmentDownloads.push(download);
      item.setSavePath(download.filename);
      item.once("done", (_event, state) => { download.state = state; });
    });
  }, temporary);
  return page;
};
const nativeDialogs = async (openFile, saveFile) => app.evaluate(({ dialog }, values) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [values.openFile] });
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: values.saveFile });
}, { openFile, saveFile });
const downloadFrom = async (page, button, role = "button") => {
  const at = await app.evaluate(() => globalThis.__attachmentDownloads.length);
  await page.getByRole(role, { name: button, exact: true }).click();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const entry = await app.evaluate((_electron, index) => globalThis.__attachmentDownloads[index], at);
    if (entry?.state === "completed") return entry.filename;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`下载未完成 ${button}`);
};

try {
  await fs.mkdir(artifacts, { recursive: true });
  let page = await launch(path.join(temporary, "original"));
  const sample = {
    version: 1, activeDocumentId: "attachment-runtime",
    documents: [{
      id: "attachment-runtime", title: "附件运行时验证",
      createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z",
      nodes: [{ id: "image-topic", text: "离线图片", note: "", checked: false, collapsed: false, color: "plain", children: [] }],
    }],
  };
  await page.locator("input[type=file]").setInputFiles({ name: "workspace.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(sample)) });
  await page.locator("[data-node-id=image-topic] textarea").click();
  const image = path.join(temporary, "路线截图 [1].png");
  await page.screenshot({ path: image });
  const assetId = `sha256:${crypto.createHash("sha256").update(await fs.readFile(image)).digest("hex")}`;
  const archive = path.join(temporary, "workspace.zip");
  await nativeDialogs(image, archive);
  await page.getByRole("button", { name: "添加附件", exact: true }).click();
  await page.locator(".outline-row .attachment-thumbnail img").waitFor();
  await waitForSavedRefs(page, 1);
  const first = await readStored(page);
  assert.equal(first.version, 2, JSON.stringify(first));
  assert.equal(first.documents[0].nodes[0].attachmentRefs[0].assetId, assetId);
  checks.push("file chooser entry with a controlled dialog selection imports a PNG, upgrades v1 to v2 and persists its original hash");

  await page.getByRole("button", { name: "显示节点详情", exact: true }).click();
  const downloadCount = await app.evaluate(() => globalThis.__attachmentDownloads.length);
  await page.getByRole("button", { name: "下载附件格式升级前副本", exact: true }).click();
  let downloaded;
  const downloadDeadline = Date.now() + 15_000;
  while (Date.now() < downloadDeadline) {
    downloaded = await app.evaluate((_electron, at) => globalThis.__attachmentDownloads[at], downloadCount);
    if (downloaded?.state === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(downloaded?.state, "completed", "the migration backup must reach the native download completion event");
  const beforeFile = downloaded.filename;
  const before = JSON.parse(await fs.readFile(beforeFile, "utf8"));
  assert.equal(before.version, 1);
  assert.equal(before.documents[0].nodes[0].attachmentRefs, undefined);
  checks.push("the UI downloads a valid v1 pre-migration copy");
  await page.getByRole("button", { name: "移除引用", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".outline-row .attachment-items"));
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.locator(".outline-row .attachment-thumbnail img").waitFor();
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".outline-row .attachment-items"));
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await waitForSavedRefs(page, 1);
  checks.push("removing an attachment participates in the normal undo/redo stack and preserves its bytes");
  const imageBase64 = (await fs.readFile(image)).toString("base64");
  for (const eventName of ["paste", "drop"]) {
    const transfer = await page.evaluateHandle(({ base64, name }) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))], `${name}.png`, { type: "image/png" }));
      return data;
    }, { base64: imageBase64, name: eventName });
    await page.locator("[data-node-id=image-topic] textarea").evaluate((element, { data, name }) => {
      const event = name === "paste" ? new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
        : new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
    }, { data: transfer, name: eventName });
    await transfer.dispose();
    await waitForSavedRefs(page, 2);
    const pasted = await readStored(page);
    assert.equal(pasted.documents[0].nodes[0].attachmentRefs[1].assetId, assetId);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await waitForSavedRefs(page, 1);
  }
  checks.push("synthetic paste and file drop traverse the normal editor handlers, deduplicate bytes and undo correctly");
  await page.screenshot({ path: path.join(artifacts, "outline.png"), animations: "disabled" });

  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page.locator(".markdown-preview .attachment-thumbnail img").waitFor();
  const markdownSource = page.getByRole("textbox", { name: "Markdown 源码", exact: true });
  await markdownSource.fill((await markdownSource.inputValue()).replace("离线图片", "离线图片已编辑"));
  await page.getByRole("button", { name: "大纲", exact: true }).click();
  assert.equal(await page.locator("[data-node-id=image-topic] textarea").inputValue(), "离线图片已编辑");
  await page.locator(".outline-row .attachment-thumbnail img").waitFor();
  await page.getByRole("button", { name: "Markdown", exact: true }).click();
  await page.locator(".markdown-preview .attachment-thumbnail img").waitFor();
  checks.push("Markdown preview and source edits retain attachments with bracketed filenames");
  await page.screenshot({ path: path.join(artifacts, "markdown.png"), animations: "disabled" });
  await page.getByRole("button", { name: "脑图", exact: true }).click();
  await page.locator(".mindmap .attachment-thumbnail img").waitFor();
  await page.screenshot({ path: path.join(artifacts, "mindmap.png"), animations: "disabled" });
  const svgFile = await downloadFrom(page, "SVG");
  const svg = await fs.readFile(svgFile, "utf8");
  assert.ok(svg.includes("data:image/png;base64,") && !svg.includes("foreignObject"));
  assert.equal(await page.evaluate((source) => new DOMParser().parseFromString(source, "image/svg+xml").querySelector("parsererror")?.textContent ?? null, svg), null);
  const pngFile = await downloadFrom(page, "PNG");
  assert.deepEqual([...(await fs.readFile(pngFile)).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  await fs.copyFile(svgFile, path.join(artifacts, "mindmap-export.svg"));
  await fs.copyFile(pngFile, path.join(artifacts, "mindmap-export.png"));
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const pdfFile = await downloadFrom(page, "PDF", "menuitem");
  const pdf = await PDFDocument.load(await fs.readFile(pdfFile));
  assert.ok(pdf.context.enumerateIndirectObjects().some(([, value]) => value instanceof PDFRawStream && value.dict.get(PDFName.of("Subtype"))?.toString() === "/Image"));
  await fs.copyFile(pdfFile, path.join(artifacts, "document.pdf"));
  checks.push("SVG contains embedded image data, PNG decodes, and PDF contains an image XObject");
  for (const [button, name, field] of [["带元数据", "document.md", "markdown"], ["HTML", "index.html", "html"]]) {
    const filename = path.join(temporary, `${field}.zip`);
    await nativeDialogs(image, filename);
    await page.getByRole("button", { name: "导出", exact: true }).click();
    await page.getByRole("menuitem", { name: button, exact: true }).click();
    await page.waitForFunction(() => document.body.textContent.includes("已导出携图 ZIP"));
    const exportDeadline = Date.now() + 15_000;
    while (!(await fs.access(filename).then(() => true, () => false)) && Date.now() < exportDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const zip = await yauzl.openPromise(filename);
    const content = new Map();
    for await (const entry of zip.eachEntry()) {
      const chunks = [];
      for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk);
      content.set(entry.fileName, Buffer.concat(chunks));
    }
    assert.ok(content.get(name).toString().includes(`attachments/${assetId.slice(7)}`));
    assert.deepEqual(content.get(`attachments/${assetId.slice(7)}`), await fs.readFile(image));
    if (field === "markdown") assert.match(content.get(name).toString(), /bike:document:v2/);
  }
  checks.push("Markdown and HTML packages contain relative image paths and exact original attachment bytes");
  await nativeDialogs(image, archive);
  await page.getByRole("button", { name: "演示", exact: true }).click();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.locator(".slide-content .attachment-thumbnail img").waitFor();
  checks.push("outline, Markdown preview, mind map and presentation display the same stored image");
  await page.getByRole("button", { name: "大纲", exact: true }).click();
  await page.getByRole("button", { name: "工作区 ZIP", exact: true }).click();
  await page.waitForFunction(() => document.body.textContent.includes("已导出完整 ZIP"));
  assert.ok((await fs.stat(archive)).size > 0);
  const archived = await readStored(page);
  checks.push("the toolbar exports a complete workspace ZIP");
  await app.close();
  app = null;

  const orphan = await createAttachmentService({ directory: path.join(temporary, "original", "attachments") }).putBytes(Buffer.from("unreferenced from an earlier session"));

  page = await launch(path.join(temporary, "original"));
  await page.locator(".outline-row .attachment-thumbnail img").waitFor();
  assert.equal((await readStored(page)).documents[0].nodes[0].attachmentRefs[0].assetId, assetId);
  checks.push("application restart retains both the IndexedDB reference and the disk object");
  const liveDigest = assetId.slice(7);
  const liveObject = path.join(temporary, "original", "attachments", liveDigest.slice(0, 2), liveDigest);
  await fs.writeFile(liveObject, "damaged attachment");
  await nativeDialogs(archive, path.join(temporary, "unused.zip"));
  await page.getByRole("button", { name: "补齐附件", exact: true }).click();
  await page.waitForFunction(() => document.body.textContent.includes("附件库已补齐并完成校验"));
  assert.deepEqual(await fs.readFile(liveObject), await fs.readFile(image));
  await page.locator(".outline-row .attachment-thumbnail img").waitFor();
  checks.push("the repair entry restores a corrupted object from a verified ZIP and retains the current document");
  await page.getByRole("button", { name: "清理附件", exact: true }).click();
  await page.waitForFunction(() => document.body.textContent.includes("已隔离 1 个附件"));
  assert.equal(await fs.readFile(path.join(temporary, "original", "attachments", "quarantine", orphan.assetId.slice(7)), "utf8"), "unreferenced from an earlier session");
  await fs.access(path.join(temporary, "original", "attachments", liveDigest.slice(0, 2), liveDigest));
  checks.push("cleanup scans persistent history and recovery roots, quarantines the orphan and protects the active image");
  await app.close();
  app = null;

  page = await launch(path.join(temporary, "restored"));
  await nativeDialogs(archive, path.join(temporary, "before-restore.zip"));
  await page.getByRole("button", { name: "载入 ZIP", exact: true }).click();
  await page.locator("[data-node-id=image-topic] .attachment-thumbnail img").waitFor();
  await waitForSavedRefs(page, 1);
  const restored = await readStored(page);
  assert.equal(restored.documents[0].id, archived.documents[0].id);
  assert.deepEqual(restored.documents[0].nodes, archived.documents[0].nodes);
  const digest = assetId.slice(7);
  const restoredBytes = await fs.readFile(path.join(temporary, "restored", "attachments", digest.slice(0, 2), digest));
  assert.deepEqual(restoredBytes, await fs.readFile(image));
  await page.screenshot({ path: path.join(artifacts, "restored.png"), animations: "disabled" });
  checks.push("the ZIP import entry restores identities and exact image bytes in a fresh application data directory");
  assert.deepEqual(errors, []);
  const application = await app.evaluate(({ app }) => ({ version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, arch: process.arch, runningUnderARM64Translation: app.runningUnderARM64Translation, packaged: app.isPackaged }));
  const evidence = { date: new Date().toISOString(), runtime: process.version, application, checks, errors, artifacts };
  await fs.writeFile(path.join(artifacts, application.packaged ? `results-packaged-${application.arch}.json` : "results.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  const page = app ? (await app.windows())[0] : null;
  if (page) {
    await page.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => {});
    console.error(JSON.stringify({ checks, errors, body: (await page.locator("body").innerText()).slice(-5000) }, null, 2));
  }
  throw error;
} finally {
  await app?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
