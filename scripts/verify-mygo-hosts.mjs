import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createSyncStore } from '../server/sync-store.mjs';
import { handleSyncApi, sendJson } from '../server/sync-api.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const { _electron } = require('playwright');
const { createAttachmentService } = require('../electron/attachment-service.cjs');
const option = (name, fallback) => process.argv.find((value) => value.startsWith(name + '='))?.slice(name.length + 1) ?? fallback;
const evidence = path.resolve(option('--output', path.join(root, 'docs/evidence-mygo-2026-11-11-integration/native-hosts')));
const readyPath = option('--run-ready', '');
const candidatePath = option('--candidate-ready', '');
assert.ok(candidatePath || process.argv.includes('--prepare-only'), 'Provide --candidate-ready=<frozen candidate JSON>');
const electronBundle = option('--electron-app', '');
const helperDirectory = path.join(root, 'output/mygo/native-host-helper');
const appPath = path.join(helperDirectory, 'Bike MyGO Host Acceptance.app');
const binary = path.join(appPath, 'Contents/MacOS/bike-mygo-host-acceptance');
const go = process.env.BIKE_MYGO_GO ?? 'go';
const env = { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: 'arm64', GOEXPERIMENT: 'jsonv2', GOTOOLCHAIN: 'local' };
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed ${result.error ?? result.stderr}`);
  return result.stdout.trim();
};
const hashDirectory = async (directory) => {
  const hash = crypto.createHash('sha256');
  for (const name of (await fs.readdir(directory, { recursive: true })).sort()) {
    const target = path.join(directory, name);
    if ((await fs.stat(target)).isFile()) hash.update(name).update(await fs.readFile(target));
  }
  return hash.digest('hex');
};
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const deadline = (promise, milliseconds, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds);
  })]).finally(() => clearTimeout(timer));
};
const wait = async (check, label, milliseconds = 30_000) => {
  const end = Date.now() + milliseconds;
  let lastError;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await pause(40);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? ` (${lastError.message})` : ''}`);
};
await fs.mkdir(path.join(appPath, 'Contents/MacOS'), { recursive: true });
run(go, ['build', '-mod=readonly', '-trimpath', '-tags', 'mygo_noinspector,mygo_frontend', '-ldflags',
  '-s -w -X github.com/egoist/mygo.production=1 -X github.com/egoist/mygo.packageIdentifier=com.bike.mygo.host-acceptance -X github.com/egoist/mygo.packageVersion=2.0.0',
  '-o', binary, './cmd/bike-mygo-host-acceptance'], { cwd: path.join(root, 'desktop-mygo'), env });
await fs.writeFile(path.join(appPath, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.bike.mygo.host-acceptance</string>
<key>CFBundleExecutable</key><string>bike-mygo-host-acceptance</string>
<key>CFBundleName</key><string>Bike MyGO Host Acceptance</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>2.0.0</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
run('/usr/bin/codesign', ['--force', '--sign', '-', appPath]);
if (process.argv.includes('--prepare-only')) {
  console.log(JSON.stringify({ prepared: true, binary, frontendSHA256: await hashDirectory(path.join(root, 'desktop-mygo/internal/frontend/dist')) }));
  process.exit(0);
}
if (readyPath) assert.ok(JSON.parse(await fs.readFile(readyPath, 'utf8')).ready, 'Run marker must indicate an idle performance window');
const candidate = JSON.parse(await fs.readFile(candidatePath, 'utf8'));
assert.equal(candidate.frozen, true);
const candidateManifest = JSON.parse(await fs.readFile(candidate.mainManifest, 'utf8'));
assert.equal(await hashDirectory(path.join(root, 'desktop-mygo/internal/frontend/dist')), candidate.frontendSHA256);
const productBinary = path.join(root, candidateManifest.bundle, 'Contents/MacOS/bike-mygo');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-mygo-host-acceptance-'));
const fixtureToken = crypto.randomBytes(24).toString('hex');
await fs.mkdir(evidence, { recursive: true });
const nativeDirectory = path.join(temporary, 'native');
const electronDirectory = path.join(temporary, 'electron');
const phases = [], checks = [], clients = [], errors = [];
let native, electronApp, server, store;
const progress = async (message) => {
  phases.push(message);
  console.error(message);
  await fs.writeFile(path.join(evidence, 'progress.md'), `# Native host acceptance\n\n${new Date().toISOString()}\n\n${message}\n`);
};
const launchNative = async (reset = false) => {
  const child = spawn(binary, ['--output', nativeDirectory, ...(reset ? ['--reset'] : [])], { env: { ...env, PATH: '/usr/bin:/bin', MYGO_ENV: 'development' } });
  let output = '', stdout = '', ready;
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    for (const line of stdout.split('\n')) {
      try { const parsed = JSON.parse(line); if (parsed.type === 'ready') ready = parsed; } catch {}
    }
  });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  try { await wait(() => ready, 'native controller startup'); }
  catch (error) { child.kill('SIGKILL'); await exited; throw new Error(`${error.message}\n${output}`); }
  const request = async (pathname, body) => {
    const response = await fetch(ready.url + pathname, {
      method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + ready.token },
      body, signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`Native control HTTP ${response.status}`);
    const result = await response.json();
    if (result.ok === false) throw new Error(result.error ?? 'Native diagnostic failed');
    return result;
  };
  const evaluate = async (fn, argument = null) => {
    const code = `(async()=>{try{return JSON.stringify({ok:true,value:await (${fn.toString()})(${JSON.stringify(argument)})});}catch(error){return JSON.stringify({ok:false,error:String(error),stack:error?.stack});}})()`;
    return (await request('/eval', code)).value;
  };
  return { child, ready, request, evaluate, exited, output: () => output };
};
function initializePage() {
  const api = window.__hostAcceptance = {
    pause: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    async wait(check, label, milliseconds = 30_000) {
      const end = Date.now() + milliseconds;
      while (!await check()) {
        if (Date.now() > end) throw new Error('Timed out waiting for ' + label);
        await api.pause(25);
      }
    },
    async read() {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('bike-db');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction('workspace-store'), store = tx.objectStore('workspace-store');
          const keys = store.getAllKeys(), values = store.getAll();
          tx.oncomplete = () => {
            const records = Object.fromEntries(keys.result.map((key, index) => [key, values.result[index]]));
            resolve({ workspace: records.workspace, meta: records['workspace-meta'], replica: values.result.find((value) => value?.protocol === 2 && typeof value.actorId === 'string') ?? null });
          };
          tx.onabort = () => reject(tx.error);
        });
      } finally { db.close(); }
    },
    click(text, scope = document, prefix = false) {
      const button = [...scope.querySelectorAll('button')].find((item) => {
        const labels = [item.textContent.trim(), item.getAttribute('aria-label') ?? '', item.getAttribute('title') ?? ''];
        return labels.some((label) => prefix ? label.startsWith(text) : label === text);
      });
      if (!button || button.disabled) throw new Error('Missing or disabled button ' + text);
      button.click();
    },
    fill(element, value) {
      if (!element) throw new Error('Missing input');
      element.focus();
      const type = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
      Object.getOwnPropertyDescriptor(type.prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    },
    async edit(id, text) {
      const input = document.querySelector(`[data-node-id="${id}"] textarea`);
      api.fill(input, text);
      document.querySelector('.title-input').focus();
      input.blur();
      await api.wait(async () => {
        const nodes = (await api.read()).workspace.documents[0].nodes;
        const find = (items) => items.find((item) => item.id === id) ?? items.map((item) => find(item.children)).find(Boolean);
        return find(nodes)?.text === text;
      }, 'persisted edit');
    },
    async sync() {
      document.querySelector('.title-input').focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }));
      await api.pause(100);
      const button = document.querySelector('[title="立即同步"]');
      if (!button || button.disabled) throw new Error('Sync control unavailable');
      button.click();
      await api.pause(40);
      await api.wait(() => !document.querySelector('[title="立即同步"]')?.disabled, 'sync completion');
      await api.pause(50);
      if (/同步失败|附件待重试/.test(document.body.textContent)) throw new Error(document.body.textContent.slice(-1800));
      return api.read();
    },
  };
  return { initialized: true };
}
const initialize = async (page) => {
  await wait(() => page.evaluate(() => Boolean(document.querySelector('.shell'))), 'renderer shell');
  await page.evaluate(initializePage);
};
const seed = async (page, workspace, reload) => {
  await page.evaluate(async (workspace) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('bike-db'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('workspace-store', 'readwrite'), store = tx.objectStore('workspace-store');
        store.clear(); store.put(workspace, 'workspace'); store.put({ revision: 100, savedAt: Date.now() }, 'workspace-meta');
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
    localStorage.removeItem('bike-sync-config');
  }, workspace);
  await reload();
  await initialize(page);
  await wait(() => page.evaluate(() => Boolean(document.querySelector('[data-node-id="a"] textarea'))), 'seeded nodes');
};
const configure = async (page, serverUrl) => page.evaluate(async ({ serverUrl, token }) => {
  const api = window.__hostAcceptance;
  document.querySelector('[title="同步设置"]').click();
  await api.wait(() => document.querySelector('[aria-label="文档同步"]'), 'sync configuration');
  const dialog = document.querySelector('[aria-label="文档同步"]');
  const field = (label) => [...dialog.querySelectorAll('label')].find((item) => item.querySelector('span')?.textContent === label)?.querySelector('input');
  api.fill(field('服务地址'), serverUrl); api.fill(field('设备密钥'), token);
  await api.pause(0);
  api.click('保存', dialog);
  await api.pause(0);
  dialog.querySelector('[title="关闭"]').click();
  await api.wait(() => !document.querySelector('[aria-label="文档同步"]'), 'sync configuration dismissal');
}, { serverUrl, token: fixtureToken });
const edit = (page, id, text) => page.evaluate(({ id, text }) => window.__hostAcceptance.edit(id, text), { id, text });
const sync = (page) => page.evaluate(() => window.__hostAcceptance.sync());
const read = (page) => page.evaluate(() => window.__hostAcceptance.read());
const click = (page, text) => page.evaluate((text) => window.__hostAcceptance.click(text), text);
const parseTool = (result) => {
  if (result.isError) throw new Error(result.content?.map((entry) => entry.text ?? '').join('\n'));
  return result.structuredContent ?? JSON.parse(result.content.find((entry) => entry.type === 'text').text);
};
const tool = async (client, name, args = {}) => parseTool(await client.callTool({ name, arguments: args }));
const connect = async (discovery) => {
  const transport = new StdioClientTransport({ command: productBinary, args: ['--mcp-live', '--live-discovery', discovery], env: { PATH: '/usr/bin:/bin' }, stderr: 'pipe' });
  const client = new Client({ name: 'Native host acceptance client ' + clients.length, version: '2.0.0' });
  await client.connect(transport); clients.push(client); return client;
};
const captureNative = async (name) => {
  await native.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  return native.request('/capture?name=' + encodeURIComponent(name));
};
let result;
try {
  await progress('Starting native WKWebView and independent Electron GUI with the current production frontend');
  native = await launchNative(true);
  const nativePage = { evaluate: native.evaluate };
  await initialize(nativePage);
  electronApp = await _electron.launch({
    ...(electronBundle ? { executablePath: path.join(electronBundle, 'Contents/MacOS/Bike') } : {}),
    args: electronBundle ? [] : [root], cwd: root,
    env: { ...process.env, BIKE_TEST_USER_DATA: electronDirectory, VITE_DEV_SERVER_URL: '', ELECTRON_RUN_AS_NODE: '' },
  });
  const electronPage = await electronApp.firstWindow();
  electronPage.on('pageerror', (error) => errors.push(error.message));
  electronPage.on('dialog', (dialog) => dialog.accept());
  await initialize(electronPage);
  const original = Buffer.from('Cross-host attachment original 中文🙂\n');
  const imported = await nativePage.evaluate(async (bytes) => window.bike.importAttachments({
    requestId: 'host-attachment-fixture', files: [{ name: 'host-original.txt', bytes: new Uint8Array(bytes).buffer }],
  }), [...original]);
  assert.equal(imported.ok, true); assert.equal(imported.assets.length, 1);
  const asset = imported.assets[0];
  const node = (id) => ({ id, text: id, note: '', checked: false, collapsed: false, color: 'plain', children: [] });
  const workspace = { version: 3, activeDocumentId: 'doc', documents: [{
    id: 'doc', title: '跨宿主验收文档', createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z',
    attachments: { version: 1, items: { [asset.assetId]: asset.metadata } },
    nodes: [{ ...node('a'), attachmentRefs: [{ assetId: asset.assetId, name: 'host-original.txt' }] }, node('b'), node('c')],
  }] };
  await seed(nativePage, workspace, async () => {
    const before = (await native.request('/state')).generation;
    await native.request('/reload');
    await wait(async () => (await native.request('/state')).generation > before, 'native reload');
  });
  await seed(electronPage, workspace, () => electronPage.reload());
  store = await createSyncStore(path.join(temporary, 'server.sqlite'));
  store.operations.enable({ expectedRevision: 0 });
  server = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== 'Bearer ' + fixtureToken) { sendJson(response, 401, { error: 'unauthorized' }); return; }
      await handleSyncApi(request, response, { sync: { maxBodyBytes: 64 * 1024 * 1024 } }, store);
    } catch (error) { sendJson(response, 500, { message: error.message }); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  await configure(nativePage, serverUrl); await configure(electronPage, serverUrl);
  await sync(nativePage); await sync(electronPage);
  const electronLibrary = createAttachmentService({ directory: path.join(electronDirectory, 'attachments') });
  assert.deepEqual(await electronLibrary.read(asset.assetId), original);
  const initialNative = await read(nativePage), initialElectron = await read(electronPage);
  assert.ok(initialNative.replica?.actorId && initialElectron.replica?.actorId);
  assert.notEqual(initialNative.replica.actorId, initialElectron.replica.actorId);
  checks.push('Independent native and Electron GUI replicas have distinct actors and transfer SHA-256 original attachment bytes over the real Sync Server');

  await progress('Checking cross-host offline field convergence and visible same-field conflict resolution');
  await edit(nativePage, 'a', 'Native offline A'); await edit(electronPage, 'b', 'Electron offline B');
  await sync(nativePage); await sync(electronPage); await sync(nativePage);
  assert.equal((await read(nativePage)).workspace.documents[0].nodes[1].text, 'Electron offline B');
  assert.equal((await read(electronPage)).workspace.documents[0].nodes[0].text, 'Native offline A');
  checks.push('Different fields edited offline converge through both renderer commit paths and Go/Electron network bridges');
  await edit(nativePage, 'a', 'Native conflict A'); await edit(electronPage, 'a', 'Electron conflict B');
  await sync(nativePage); await sync(electronPage); await sync(nativePage);
  assert.ok(store.operations.unresolved().length > 0);
  await click(electronPage, '版本历史');
  await electronPage.evaluate(() => window.__hostAcceptance.click('节点冲突', document, true));
  await click(electronPage, '预览采用候选值');
  await wait(() => electronPage.locator('.proposal-dialog').count(), 'Electron conflict proposal');
  await click(electronPage, '应用所选修改');
  await wait(async () => await electronPage.locator('.proposal-dialog').count() === 0, 'conflict proposal commit');
  await sync(electronPage); await sync(nativePage);
  assert.equal((await read(nativePage)).workspace.documents[0].nodes[0].text, 'Electron conflict B');
  assert.equal(store.operations.unresolved().length, 0);
  checks.push('Same-field cross-host conflict is visible and resolves through the ordinary proposal and sync operation stream');

  await progress('Checking compensation, receipt deduplication and structural competition');
  await edit(nativePage, 'a', 'Native undo target'); await sync(nativePage); await sync(electronPage);
  await edit(electronPage, 'b', 'Keep later Electron field'); await sync(electronPage); await sync(nativePage);
  await click(nativePage, '撤销');
  await wait(async () => (await read(nativePage)).workspace.documents[0].nodes[0].text === 'Electron conflict B', 'native compensation');
  assert.equal((await read(nativePage)).workspace.documents[0].nodes[1].text, 'Keep later Electron field');
  await sync(nativePage); await sync(electronPage); await sync(nativePage);
  const beforeRepeat = { native: await read(nativePage), electron: await read(electronPage) };
  const receiptCount = (state) => Object.keys(state.replica.receipts).length;
  await sync(nativePage); await sync(electronPage); await sync(nativePage);
  const afterRepeat = { native: await read(nativePage), electron: await read(electronPage) };
  for (const host of ['native', 'electron']) {
    assert.equal(afterRepeat[host].replica.outbox.length, 0);
    assert.equal(receiptCount(afterRepeat[host]), receiptCount(beforeRepeat[host]));
    assert.deepEqual(afterRepeat[host].workspace, beforeRepeat[host].workspace);
  }
  checks.push('Native UI undo compensates its own field while preserving the later Electron edit, and repeated sync creates no receipts or duplicate operations');
  await nativePage.evaluate(async () => {
    const input = document.querySelector('[data-node-id="c"] textarea'); input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await window.__hostAcceptance.wait(async () => (await window.__hostAcceptance.read()).workspace.documents[0].nodes[1].children.some((node) => node.id === 'c'), 'native indentation commit');
  });
  await electronPage.evaluate(async () => {
    document.querySelector('[data-node-id="c"] textarea').focus();
    await window.__hostAcceptance.pause(0);
    window.__hostAcceptance.click('上移');
  });
  await wait(async () => (await read(electronPage)).workspace.documents[0].nodes[1].id === 'c', 'Electron reorder commit');
  await sync(nativePage); await sync(electronPage); await sync(nativePage);
  const structuralConflicts = store.operations.unresolved();
  assert.ok(structuralConflicts.length > 0);
  await click(nativePage, '版本历史');
  await nativePage.evaluate(() => window.__hostAcceptance.click('节点冲突', document, true));
  await wait(() => nativePage.evaluate(() => Boolean(document.querySelector('.operation-history .proposal-diff'))), 'native structural conflict comparison');
  await captureNative('native-structural-conflict.png');
  await click(nativePage, '预览保留当前值');
  await wait(() => nativePage.evaluate(() => Boolean(document.querySelector('.proposal-dialog'))), 'native structure resolution preview');
  await click(nativePage, '应用所选修改');
  await wait(() => nativePage.evaluate(() => !document.querySelector('.proposal-dialog')), 'native structure resolution commit');
  await sync(nativePage); await sync(electronPage); await sync(nativePage);
  assert.equal(store.operations.unresolved().length, 0);
  assert.deepEqual((await read(nativePage)).workspace.documents[0].nodes, (await read(electronPage)).workspace.documents[0].nodes);
  checks.push('Competing native indentation and Electron reorder produce a visible structural comparison and resolve through a native approved proposal');

  await progress('Checking two shipping-Go stdio clients competing against the native GUI, followed by revocation and read-only reconnect');
  await nativePage.evaluate(async () => {
    document.querySelector('.history-dialog [aria-label="关闭"]')?.click();
    document.querySelector('.history-dialog [title="关闭"]')?.click();
    window.__hostAcceptance.click('Live MCP ·', document, true);
    await window.__hostAcceptance.wait(() => document.querySelector('[aria-label="Live MCP 授权"]'), 'native Live authorization');
    const dialog = document.querySelector('[aria-label="Live MCP 授权"]'), checkbox = dialog.querySelector('input[type="checkbox"]');
    if (!checkbox.checked) checkbox.click();
    await window.__hostAcceptance.pause(0);
    window.__hostAcceptance.click('启用所选授权', dialog);
    await window.__hostAcceptance.wait(() => !document.querySelector('[aria-label="Live MCP 授权"]'), 'native Live start');
  });
  const discovery = path.join(native.ready.profile, 'live-mcp.json');
  const first = await connect(discovery), second = await connect(discovery);
  const revision = (await tool(first, 'get_workspace_summary')).revision;
  const previews = await Promise.all([
    tool(first, 'update_node', { documentId: 'doc', nodeId: 'a', text: 'First native MCP client', expectedRevision: revision }),
    tool(second, 'update_node', { documentId: 'doc', nodeId: 'a', text: 'Second native MCP client', expectedRevision: revision }),
  ]);
  const pendings = await Promise.all(previews.map((preview, index) => tool(index === 0 ? first : second, 'update_node', preview.confirmationArgs)));
  await wait(() => nativePage.evaluate(() => Boolean(document.querySelector('.proposal-dialog'))), 'native competing proposal');
  await click(nativePage, '应用所选修改');
  await wait(() => nativePage.evaluate(() => document.querySelector('.proposal-dialog')?.textContent.includes('目标内容已变化')), 'native competing proposal invalidation');
  const statuses = await Promise.all(pendings.map((pending, index) => tool(index === 0 ? first : second, 'get_proposal_status', { requestId: pending.requestId })));
  assert.equal(statuses.filter((item) => item.status === 'committed').length, 1);
  assert.equal(statuses.filter((item) => item.status === 'stale').length, 1);
  const winner = statuses.findIndex((item) => item.status === 'committed');
  const winnerText = winner === 0 ? 'First native MCP client' : 'Second native MCP client';
  assert.equal((await read(nativePage)).workspace.documents[0].nodes[0].text, winnerText);
  const receipt = await tool(winner === 0 ? first : second, 'update_node', previews[winner].confirmationArgs);
  assert.equal(receipt.status, 'committed');
  assert.equal(receipt.operationId, statuses[winner].operationId);
  await captureNative('native-competing-live.png');
  await click(nativePage, '拒绝提案');
  checks.push('Two actual shipping Go MCP stdio clients propose at one native GUI revision, exactly one approval commits, the competitor becomes stale, and the winner replays its durable receipt');
  await nativePage.evaluate(async () => {
    const api = window.__hostAcceptance;
    api.click('Live MCP ·', document, true);
    await api.wait(() => document.querySelector('[aria-label="Live MCP 授权"]'), 'Live authorization');
    const dialog = document.querySelector('[aria-label="Live MCP 授权"]');
    api.click('撤销并关闭', dialog);
    await api.wait(() => document.body.textContent.includes('Live MCP · 已关闭'), 'native Live revocation');
  });
  const revoked = await first.callTool({ name: 'get_workspace_summary', arguments: {} });
  assert.equal(revoked.isError, true);
  assert.match(JSON.stringify(revoked), /断开|启用/);
  await nativePage.evaluate(async () => {
    const api = window.__hostAcceptance, dialog = document.querySelector('[aria-label="Live MCP 授权"]');
    const checkbox = dialog.querySelector('input[type="checkbox"]'); if (checkbox.checked) checkbox.click();
    await api.pause(0);
    api.click('启用所选授权', dialog);
    await api.wait(() => !document.querySelector('[aria-label="Live MCP 授权"]'), 'read-only Live start');
  });
  const readonly = await connect(discovery);
  const summary = await tool(readonly, 'get_workspace_summary');
  const readonlyPreview = await tool(readonly, 'update_node', { documentId: 'doc', nodeId: 'a', text: 'Must refuse readonly', expectedRevision: summary.revision });
  const denied = await readonly.callTool({ name: 'update_node', arguments: readonlyPreview.confirmationArgs });
  assert.equal(denied.isError, true); assert.match(JSON.stringify(denied), /只读/);
  assert.equal((await read(nativePage)).workspace.documents[0].nodes[0].text, winnerText);
  checks.push('Native GUI revocation disconnects existing stdio clients and a fresh read-only session refuses confirmed writes');
  await nativePage.evaluate(() => window.bike.stopLiveMcp());
  const finalNative = await read(nativePage);
  const nativeErrors = await nativePage.evaluate(() => window.__hostErrors);
  assert.deepEqual(nativeErrors, []); assert.deepEqual(errors, []);
  for (const client of clients) await client.close();
  clients.length = 0;
  const quitStarted = performance.now();
  assert.equal((await native.request('/quit')).closeBarrier, true);
  const exit = await deadline(native.exited, 30_000, 'Native helper quit');
  assert.equal(exit.code, 0);
  const helperExitMs = performance.now() - quitStarted;
  native = await launchNative();
  await initialize({ evaluate: native.evaluate });
  const restarted = await read({ evaluate: native.evaluate });
  assert.deepEqual(restarted.workspace, finalNative.workspace);
  assert.deepEqual(restarted.replica.receipts, finalNative.replica.receipts);
  assert.equal(await native.evaluate(() => Object.keys(window.bike).length), 36);
  checks.push('Native GUI restart preserves the committed workspace and Live operation receipts after the close/save barrier');
  result = {
    collectedAt: new Date().toISOString(), candidateBuild: candidate.build, sourceFingerprint: candidate.sourceFingerprint,
    frontendSHA256: candidate.frontendSHA256, host: { macOS: run('/usr/bin/sw_vers', ['-productVersion']), arch: os.arch() },
    native: { renderer: 'WKWebView', controller: 'separate production-linked diagnostic helper', bridgeMembers: await native.evaluate(() => Object.keys(window.bike).length), mainPID: native.ready.pid },
    electron: { packaged: Boolean(electronBundle), bundle: electronBundle || null, runtime: await electronApp.evaluate(() => process.versions), sourceFrontend: 'current production dist' },
    actors: { native: initialNative.replica.actorId, electron: initialElectron.replica.actorId },
    checks, errors: { native: nativeErrors, electron: errors }, structuralConflictCount: structuralConflicts.length,
    liveStatuses: statuses.map((item) => ({ status: item.status, operationId: item.operationId })),
    attachment: { bytes: original.length, sha256: crypto.createHash('sha256').update(original).digest('hex'), originalsMatch: true },
    helperCloseBarrierThroughProcessExitMs: helperExitMs,
    limitations: [
      'One macOS host with an isolated WKWebView helper and a separate current-source Electron GUI, not two physical devices.',
      'The helper uses the production frontend, Desktop services, native LiveServer and actual shipping build11 Go MCP stdio clients. Its HTTP test controller is absent from the shipping app.',
      'Fixtures are seeded directly only before the test. Subsequent edits, sync, conflicts, compensation and approvals use normal renderer UI and IndexedDB commit paths.',
      'DOM input and keyboard events are synthetic. Real OS IME, clipboard, drag/drop and shipping window lifecycle remain separate acceptance items.',
      'The measured exit duration is the diagnostic helper close/save barrier through exit and does not establish the shipping application exit latency.',
    ],
  };
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  for (const name of ['native-structural-conflict.png', 'native-competing-live.png']) await fs.copyFile(path.join(nativeDirectory, name), path.join(evidence, name));
  await progress(`Passed ${checks.length} native/Electron GUI and competing Live checks`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await fs.writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ collectedAt: new Date().toISOString(), phases, error: String(error), stack: error.stack }, null, 2) + '\n');
  if (native) {
    await captureNative('failure.png').catch(() => {});
    await fs.copyFile(path.join(nativeDirectory, 'failure.png'), path.join(evidence, 'failure.png')).catch(() => {});
    await fs.writeFile(path.join(evidence, 'native-stderr.log'), native.output());
  }
  throw error;
} finally {
  for (const client of clients) await client.close().catch(() => {});
  if (native) {
    await native.request('/quit').catch(() => {});
    const stopped = await deadline(native.exited, 3000, 'Native cleanup close').then(() => true, () => false);
    if (!stopped) native.child.kill('SIGKILL');
    await fs.writeFile(path.join(evidence, 'native-stderr.log'), native.output());
  }
  await electronApp?.close().catch(() => {});
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  store?.close();
  run(binary, ['--output', nativeDirectory, '--cleanup'], { env: { ...env, PATH: '/usr/bin:/bin' }, timeout: 30_000 });
  await fs.rm(temporary, { recursive: true, force: true });
}
