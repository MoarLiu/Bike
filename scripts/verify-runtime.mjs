import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { createSyncStore } from '../server/sync-store.mjs';
import { createServer as createHttpServer } from 'node:http';
const require = createRequire(import.meta.url);
const { chromium, _electron } = require('playwright');
const root = path.resolve(new URL('..', import.meta.url).pathname);
const node = (id, children = []) => ({ id, text: id, note: '', checked: false, collapsed: false, color: 'plain', children });
const sample = () => ({ version: 1, activeDocumentId: 'safe', documents: [{ id: 'safe', title: '安全回归', createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z', nodes: [node('outside'), node('focus', [node('child-a'), node('child-b')])] }] });
const readStored = (page) => page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open('bike-db'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  try { return await new Promise((resolve) => { const tx = db.transaction('workspace-store'); const store = tx.objectStore('workspace-store'); const request = store.get('workspace'), meta = store.get('workspace-meta'); tx.oncomplete = () => resolve({ workspace: request.result, revision: meta.result.revision }); }); }
  finally { db.close(); }
});
const importSample = async (page) => {
  await page.locator('.shell').waitFor();
  await page.locator('input[type=file]').setInputFiles({ name: 'runtime-workspace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(sample())) });
  await page.locator('[data-node-id=outside]').waitFor();
};
const save = async (page) => { await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s'); await page.waitForFunction(() => document.body.textContent.includes('已保存到本地')); };

export async function verifyBrowser() {
  const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  const store = await createSyncStore(':memory:');
  const results = [];
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1366, height: 960 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  const address = server.httpServer.address();
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await page.goto(url);
    await importSample(page);
    await page.locator('[data-node-id=focus] textarea').click();
    await page.getByRole('button', { name: '聚焦', exact: true }).click();
    await page.locator('[data-node-id=child-b] [draggable=true]').dragTo(page.locator('[data-node-id=child-a]'), { targetPosition: { x: 120, y: 3 } });
    assert.deepEqual(await page.locator('.outline-row').evaluateAll((rows) => rows.map((row) => row.dataset.nodeId)), ['focus', 'child-b', 'child-a']);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await page.getByRole('button', { name: '退出', exact: true }).click();
    await save(page);
    await page.reload();
    await page.locator('[data-node-id=outside]').waitFor();
    let saved = await readStored(page);
    assert.deepEqual(saved.workspace.documents[0].nodes.map((item) => item.id), ['outside', 'focus']);
    assert.deepEqual(saved.workspace.documents[0].nodes[1].children.map((item) => item.id), ['child-b', 'child-a']);
    results.push('focused mouse drag, undo/redo, IndexedDB save and reload');
    await page.locator('[data-node-id=focus] .disclosure').click();
    await page.locator('[data-node-id=outside] textarea').fill('outside edited');
    await page.getByPlaceholder('搜索文档、主题、备注').fill('child-a');
    await page.getByText('child-a', { exact: true }).last().click();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(await page.locator('[data-node-id=outside] textarea').inputValue(), 'outside');
    results.push('search navigation into collapsed ancestors preserves undo');
    await page.getByPlaceholder('搜索文档、主题、备注').fill('');
    const formats = await page.evaluate(async () => {
      const { exportDocument, importDocument } = await import('/src/exporters.ts');
      const item = { id: 'formats', title: '格式 😀', createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z', extension: { keep: true }, nodes: [{ id: 'n', text: 'Topic', note: 'line 1\nline 2\t末尾', children: [], checked: false, collapsed: false, color: 'plain', table: [['', 'A|B'], ['C', '']], codeBlock: '<code>中文</code>', codeLanguage: 'xml' }] };
      const opml = exportDocument(item, 'opml');
      const restored = importDocument(opml.content, opml.filename);
      const metadata = exportDocument(item, 'markdown', { metadata: true });
      const exact = importDocument(metadata.content, metadata.filename);
      const mm = exportDocument(item, 'freemind');
      const freemind = importDocument(mm.content, mm.filename);
      return { note: restored.nodes[0].note, table: restored.nodes[0].table, code: restored.nodes[0].codeBlock, exactNodes: exact.nodes, originalNodes: item.nodes, extension: exact.extension, freemindText: freemind.nodes[0].text, freemindLoss: mm.lossy };
    });
    assert.equal(formats.note, 'line 1\nline 2\t末尾'); assert.deepEqual(formats.table, [['', 'A|B'], ['C', '']]);
    assert.equal(formats.code, '<code>中文</code>'); assert.deepEqual(formats.exactNodes, formats.originalNodes); assert.deepEqual(formats.extension, { keep: true }); assert.equal(formats.freemindText, 'Topic'); assert.equal(formats.freemindLoss, true);
    results.push('real DOMParser OPML and FreeMind roundtrip, metadata Markdown exact tree and extension roundtrip');
    const interopSamples = await Promise.all(['opml', 'md'].map(async (extension) => ({ extension, content: await fs.readFile(path.join(root, 'tests/fixtures', `outline-interop.${extension}`), 'utf8') })));
    const importedSamples = await page.evaluate(async (samples) => {
      const { importDocument } = await import('/src/exporters.ts');
      return samples.map(({ content, extension }) => {
        const document = importDocument(content, `sample.${extension}`);
        return { title: document.title, roots: document.nodes.length, note: document.nodes[0].note, checked: document.nodes[0].children[0].checked, url: document.nodes[0].children[1].text };
      });
    }, interopSamples);
    for (const sample of importedSamples) {
      assert.equal(sample.title, '导入兼容样本 😀'); assert.equal(sample.roots, 2);
      assert.equal(sample.note, '第一行\n第二行'); assert.equal(sample.checked, true); assert.equal(sample.url, 'https://example.com/阅读');
    }
    results.push('handwritten OPML and Markdown interchange fixtures preserve nested outlines, multiline notes, tasks, URLs and Unicode');

    const calls = [];
    await page.route('**/api/**', async (route) => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      const method = request.method();
      const body = request.postData() ? request.postDataJSON() : null;
      calls.push({ method, pathname });
      const id = decodeURIComponent(pathname.split('/')[3]);
      const data = pathname === '/api/sync/manifest' ? method === 'GET' ? store.getManifest() : store.patchManifest(body)
        : method === 'GET' ? store.getDocument(id) : method === 'PUT' ? store.putDocument({ id, ...body }) : store.deleteDocument({ id, ...body });
      await route.fulfill({ json: data });
    });
    await page.clock.install();
    await page.getByRole('button', { name: '同步设置', exact: true }).click();
    await page.getByLabel('服务地址').fill(url);
    await page.locator('.sync-toggle-row input').check();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    const input = page.locator('[data-node-id=outside] textarea');
    await input.fill('同步编辑');
    await input.press('Tab');
    await input.click();
    await page.clock.runFor(6000);
    await page.waitForFunction(() => !document.querySelector('[title="立即同步"]')?.disabled && document.body.textContent.includes('同步'));
    for (let i = 0; i < 100 && store.getDocument('safe')?.revision !== 1; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(store.getDocument('safe')?.document.nodes[0].text, '同步编辑', JSON.stringify({ calls, body: await page.locator('body').innerText(), errors }));
    for (let i = 0; i < 100 && await page.locator('[title="立即同步"]').isDisabled(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const first = calls.filter((call) => call.pathname === '/api/sync/manifest').length;
    assert.equal(first, 1);
    await page.clock.runFor(10000);
    assert.equal(calls.filter((call) => call.pathname === '/api/sync/manifest').length, first);
    assert.equal(await input.evaluate((element) => document.activeElement === element), true);
    await page.clock.runFor(45000);
    for (let i = 0; i < 100 && calls.filter((call) => call.pathname === '/api/sync/manifest').length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.filter((call) => call.pathname === '/api/sync/manifest').length, 2);
    assert.equal(store.getDocument('safe').revision, 1);
    results.push('real React edit debounce, independent 60-second polling, no 5-second sync loop and preserved input focus');
    assert.deepEqual(errors, []);
    return { runtime: process.version, browser: browser.version(), checks: results, errors };
  } finally { await browser.close(); store.close(); await server.close(); }
}

export async function verifyElectron() {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-1.6.1-electron-'));
  let app;
  let aiServer;
  try {
    const executable = process.env.BIKE_ELECTRON_EXECUTABLE;
    app = await _electron.launch({ ...(executable ? { executablePath: executable } : {}), args: executable ? [] : [root], cwd: root, env: { ...process.env, BIKE_TEST_USER_DATA: userData, VITE_DEV_SERVER_URL: '' } });
    const page = await app.firstWindow();
    await page.locator('.shell').waitFor();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await importSample(page);
    await save(page);
    const info = await app.evaluate(({ app, BrowserWindow, Menu }) => ({ versions: process.versions, version: app.getVersion(), arch: process.arch, runningUnderARM64Translation: app.runningUnderARM64Translation, size: BrowserWindow.getAllWindows()[0].getSize(), menuRoles: Menu.getApplicationMenu().items.flatMap((item) => item.submenu?.items.map((entry) => entry.role) ?? []) }));
    assert.equal(info.version, JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version);
    assert.ok(!info.menuRoles.includes('reload') && !info.menuRoles.includes('toggledevtools'));
    const blocked = await page.evaluate(async () => {
      window.__cspProbe = false;
      const script = document.createElement('script'); script.textContent = 'window.__cspProbe = true'; document.body.append(script);
      await new Promise((resolve) => setTimeout(resolve, 30)); return !window.__cspProbe;
    });
    assert.equal(blocked, true);
    const { spawn } = await import('node:child_process');
    const second = spawn(executable ?? require('electron'), executable ? [] : [root], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '', BIKE_TEST_USER_DATA: userData, VITE_DEV_SERVER_URL: '' }, stdio: 'ignore' });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => { second.kill(); reject(new Error('second instance did not exit')); }, 10000); second.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`second instance exit ${code}`)); }); second.once('error', reject); });
    assert.equal((await app.windows()).length, 1);
    await page.evaluate(async () => {
      const db = await new Promise((resolve) => { const request = indexedDB.open('bike-db'); request.onsuccess = () => resolve(request.result); });
      await new Promise((resolve) => { const tx = db.transaction('workspace-store', 'readwrite'), store = tx.objectStore('workspace-store'), request = store.get('workspace'); request.onsuccess = () => store.put({ ...request.result, version: 3 }, 'workspace'); tx.oncomplete = resolve; }); db.close();
    });
    await page.reload(); await page.locator('[data-node-id=outside]').waitFor();
    let sawRequest;
    const requestStarted = new Promise((resolve) => { sawRequest = resolve; });
    aiServer = createHttpServer((request, response) => { request.resume(); response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"output_text":'); sawRequest(); });
    await new Promise((resolve) => aiServer.listen(0, '127.0.0.1', resolve));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-api-config'));
    const configDialog = page.getByRole('dialog', { name: 'AI 配置', exact: true });
    await configDialog.waitFor();
    await configDialog.getByLabel('API baseurl').fill(`http://127.0.0.1:${aiServer.address().port}/v1`);
    await configDialog.locator('.api-key-input input').fill('local-fixture');
    await configDialog.getByLabel('大模型', { exact: true }).fill('fixture');
    await configDialog.locator('.config-error').waitFor({ state: 'hidden' });
    await configDialog.getByRole('button', { name: '保存', exact: true }).click();
    await configDialog.waitFor({ state: 'hidden' });
    await page.locator('[data-node-id=outside] [title="AI 助手"]').click();
    await page.getByRole('button', { name: '生成', exact: true }).click();
    await requestStarted;
    await page.getByRole('button', { name: '取消 AI', exact: true }).click();
    await page.locator('[data-node-id=outside] textarea').fill('取消后仍可编辑');
    await page.locator('[data-node-id=outside] textarea').press('Tab');
    assert.equal(await page.locator('[data-node-id=outside] textarea').inputValue(), '取消后仍可编辑');
    assert.equal(await page.getByRole('button', { name: '取消 AI', exact: true }).count(), 0);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    assert.equal(await page.locator('[data-node-id=outside] textarea').inputValue(), 'outside');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
    assert.equal(await page.locator('[data-node-id=outside] textarea').inputValue(), '取消后仍可编辑');
    const before = await app.windows();
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    await page.waitForEvent('close');
    const nextWindow = app.waitForEvent('window');
    await app.evaluate(({ app }) => app.emit('activate'));
    const reopened = await nextWindow;
    await reopened.locator('[data-node-id=outside]').waitFor();
    assert.deepEqual(errors, []);
    return { ...info, packaged: Boolean(executable), checks: ['production file URL startup', 'inline CSP interception', 'production menu', 'real second process exits and leaves one window', 'configured custom AI endpoint, hanging body, actual UI cancellation and continued editing', 'native undo/redo shortcuts', 'save, close, activate and reopen'], errors, windowsBeforeClose: before.length };
  } finally { await app?.close(); if (aiServer) { aiServer.closeAllConnections(); await new Promise((resolve) => aiServer.close(resolve)); } await fs.rm(userData, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = process.argv.includes('--electron') ? await verifyElectron() : await verifyBrowser();
  console.log(JSON.stringify(result, null, 2));
}
