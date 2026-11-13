import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const output = path.join(root, "output/playwright/review-2.0.1");
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1366, height: 960 } });
const page = await context.newPage(), errors = [], checks = [];
page.on("pageerror", error => errors.push(error.message));
page.on("dialog", dialog => dialog.accept());
try {
  await fs.mkdir(output, { recursive: true });
  await page.route("**/__seed", route => route.fulfill({ contentType: "text/html", body: "<html><body>Isolated regression fixture</body></html>" }));
  await page.goto(`${origin}/__seed`);
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("bike-db", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("workspace-store");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const at = "2026-11-13T00:00:00.000Z";
    const workspace = { version: 3, activeDocumentId: "large", documents: [
      { id: "large", title: "20,000 topics", createdAt: at, updatedAt: at, nodes: Array.from({ length: 20000 }, (_, index) => ({ id: `virtual-${index}`, text: `Topic ${index}`, children: [] })) },
      { id: "other", title: "Parallel document", createdAt: at, updatedAt: at, nodes: [{ id: "other-node", text: "Independent", children: [] }] },
    ] };
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("workspace-store", "readwrite"), store = transaction.objectStore("workspace-store");
      store.put(workspace, "workspace"); store.put({ revision: 100, savedAt: Date.now() }, "workspace-meta");
      transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  });
  const started = performance.now();
  await page.goto(origin);
  await page.locator('[data-node-id="virtual-0"] textarea').waitFor();
  const loadMs = Math.round(performance.now() - started);
  const initial = await page.evaluate(() => ({ rows: document.querySelectorAll(".outline-row").length, elements: document.querySelectorAll("*").length }));
  assert.ok(initial.rows < 100 && initial.elements < 5000, JSON.stringify(initial));
  await page.locator(".editor-pane").evaluate(element => { element.scrollTop = 320000; });
  await page.waitForFunction(() => [...document.querySelectorAll(".outline-row")].some(row => Number(row.dataset.nodeId?.slice(8)) > 9000));
  const target = await page.evaluate(() => [...document.querySelectorAll(".outline-row")].find(row => {
    const bounds = row.getBoundingClientRect();
    return bounds.top > 200 && bounds.bottom < innerHeight - 150;
  }).dataset.nodeId);
  const row = page.locator(`[data-node-id="${target}"]`);
  const editStart = performance.now();
  await row.locator("textarea").fill("Edited after virtual scrolling");
  await row.locator('button[title="主题操作"]').click();
  await page.locator(".node-menu").waitFor();
  const editMenuMs = performance.now() - editStart;
  const bounds = await page.locator(".node-menu").boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1367 && bounds.y + bounds.height <= 961, JSON.stringify(bounds));
  await page.screenshot({ path: path.join(output, "virtual-menu.png") });
  await page.locator(".node-menu-close").click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  await page.waitForFunction(() => document.body.textContent.includes("已保存到本地"));
  checks.push({ name: "20,000 rows virtualize, edit and open a clamped menu", ...initial, loadMs, editMenuMs: Math.round(editMenuMs), target, menuBounds: bounds });
  await page.getByRole("button", { name: "同步设置", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), true);
  for (let index = 0; index < 25; index++) {
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement)), true);
  }
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  checks.push({ name: "modal takes focus, contains 25 Tab advances and dismisses with Escape" });
  const second = await context.newPage();
  second.on("pageerror", error => errors.push(error.message));
  await second.goto(origin);
  await second.locator('[data-node-id="virtual-0"]').waitFor();
  await page.getByRole("button", { name: "Parallel document", exact: true }).first().click();
  await page.locator('[data-node-id="other-node"]').waitFor();
  assert.equal(await second.locator(".title-input").inputValue(), "20,000 topics");
  checks.push({ name: "two tabs keep independent active documents" });
  await page.setViewportSize({ width: 1366, height: 760 });
  await page.locator(".segmented").getByRole("button", { name: "脑图", exact: true }).click();
  await page.locator('[data-node-id="other-node"]').waitFor();
  await page.locator('[data-node-id="other-node"]').evaluate(element => element.dispatchEvent(
    new MouseEvent("contextmenu", { clientX: 1360, clientY: 754, bubbles: true, cancelable: true }),
  ));
  await page.locator(".mindmap-context-menu").waitFor();
  const mapBounds = await page.locator(".mindmap-context-menu").boundingBox();
  assert.ok(mapBounds.x > 900 && mapBounds.y > 200, `Menu did not use the requested pointer position: ${JSON.stringify(mapBounds)}`);
  assert.ok(mapBounds.x >= 0 && mapBounds.y >= 0 && mapBounds.x + mapBounds.width <= 1367 && mapBounds.y + mapBounds.height <= 761, JSON.stringify(mapBounds));
  await page.screenshot({ path: path.join(output, "mindmap-menu.png") });
  checks.push({ name: "mind-map context menu remains within a 760px viewport at the bottom-right edge", bounds: mapBounds });
  await page.keyboard.press("Escape");
  await page.reload();
  await page.locator(".shell").waitFor();
  const saved = await page.evaluate(async id => {
    const db = await new Promise(resolve => { const request = indexedDB.open("bike-db"); request.onsuccess = () => resolve(request.result); });
    try {
      return await new Promise(resolve => { const transaction = db.transaction("workspace-store"), read = transaction.objectStore("workspace-store").get("workspace"); transaction.oncomplete = () => resolve(read.result.documents[0].nodes.find(node => node.id === id).text); });
    } finally { db.close(); }
  }, target);
  assert.equal(saved, "Edited after virtual scrolling");
  assert.deepEqual(errors, []);
  const result = { version: "2.0.1", runtime: process.version, browser: browser.version(), checks, errors };
  await fs.writeFile(path.join(output, "results.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  await server.close();
}
