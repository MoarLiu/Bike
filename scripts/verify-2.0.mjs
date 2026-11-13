import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createSyncStore } from '../server/sync-store.mjs';
import { handleSyncApi, sendJson } from '../server/sync-api.mjs';
const require = createRequire(import.meta.url);
const { _electron } = require('playwright');
const { createAttachmentService } = require('../electron/attachment-service.cjs');
const root = path.resolve(new URL('..', import.meta.url).pathname);
const executable = process.env.BIKE_ELECTRON_EXECUTABLE;
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-200-runtime-'));
const apps = [], clients = [], errors = [], checks = [], phases = [];
const timingsMs = {};
const report = (value) => { phases.push(value); console.error(value); };
const timestamp = '2026-11-09T00:00:00.000Z';
const node = (id, text = id) => ({ id, text, note: '', checked: false, collapsed: false, color: 'plain', children: [] });
const parse = (result) => { if (result.isError) throw new Error(result.content.map((item) => item.text ?? '').join('\n')); return result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === 'text').text); };
let provider, syncServer, store, providerResponseAt;
let providerResult = { tasks: [{ text: '任务一' }, { text: '任务二' }] };
const startHttp = async (handler) => { const server = createServer(handler); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return server; };
const closeHttp = async (server) => { if (!server) return; server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); };
const readStored = (page) => page.evaluate(async () => {
  const db = await new Promise((resolve) => { const request = indexedDB.open('bike-db'); request.onsuccess = () => resolve(request.result); });
  try { return await new Promise((resolve) => { const tx = db.transaction('workspace-store'), request = tx.objectStore('workspace-store').get('workspace'); tx.oncomplete = () => resolve(request.result); }); }
  finally { db.close(); }
});
const seed = async (page, workspace) => {
  await page.locator('.shell').waitFor();
  await page.evaluate(async (workspace) => {
    const db = await new Promise((resolve) => { const request = indexedDB.open('bike-db'); request.onsuccess = () => resolve(request.result); });
    try { await new Promise((resolve, reject) => {
      const tx = db.transaction('workspace-store', 'readwrite'), target = tx.objectStore('workspace-store');
      target.put(workspace, 'workspace'); target.put({ revision: 100, savedAt: new Date().toISOString() }, 'workspace-meta');
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    }); } finally { db.close(); }
  }, workspace);
  await page.reload(); await page.locator('[data-node-id=a] textarea').waitFor();
};
const launch = async (userData, workspace) => {
  const app = await _electron.launch({ ...(executable ? { executablePath: executable } : {}), args: executable ? [] : [root], cwd: root,
    env: { ...process.env, BIKE_TEST_USER_DATA: userData, VITE_DEV_SERVER_URL: '', ELECTRON_RUN_AS_NODE: '' } });
  apps.push(app);
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await seed(page, workspace);
  return { app, page, userData };
};
const save = async (page) => { await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s'); await page.waitForFunction(() => document.body.textContent.includes('已保存到本地')); };
const edit = async (page, id, value, blur = true) => { const input = page.locator(`[data-node-id=${id}] textarea`); await input.fill(value); if (blur) await page.locator('.title-input').click(); };
const configureSync = async (page, url) => {
  await page.getByTitle('同步设置', { exact: true }).click();
  await page.getByLabel('服务地址').fill(url);
  await page.getByLabel('设备密钥').fill('runtime-device-token');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
};
const sync = async (page) => {
  await save(page);
  await page.getByTitle('立即同步', { exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[title="立即同步"]')?.disabled, { timeout: 30_000 });
  const text = await page.locator('body').innerText();
  assert.ok(!text.includes('同步失败') && !text.includes('附件待重试'), text.slice(-1200));
};
const connectMcp = async (app, userData) => {
  const executablePath = await app.evaluate(() => process.execPath);
  const transport = new StdioClientTransport({ command: executablePath, args: executable ? ['--mcp-live'] : [root, '--mcp-live'],
    env: { ...process.env, BIKE_LIVE_DISCOVERY: path.join(userData, 'live-mcp.json'), ELECTRON_RUN_AS_NODE: '' }, stderr: 'pipe' });
  const client = new Client({ name: 'Bike acceptance client', version: '2.0.0' });
  clients.push(client);
  await client.connect(transport);
  return client;
};
try {
  report('Starting isolated clients and real HTTP services');
  store = await createSyncStore(path.join(temporary, 'server.sqlite'));
  store.operations.enable({ expectedRevision: 0 });
  syncServer = await startHttp(async (request, response) => {
    try {
      if (request.headers.authorization !== 'Bearer runtime-device-token') { sendJson(response, 401, { error: 'unauthorized' }); return; }
      await handleSyncApi(request, response, { sync: { maxBodyBytes: 64 * 1024 * 1024 } }, store);
    } catch (error) { sendJson(response, 500, { message: error.message }); }
  });
  provider = await startHttp(async (request, response) => { for await (const _chunk of request) { /* Drain the bounded fixture prompt. */ } response.writeHead(200, { 'Content-Type': 'application/json' }); providerResponseAt = performance.now(); response.end(JSON.stringify({ output_text: JSON.stringify(providerResult) })); });
  const aData = path.join(temporary, 'a'), bData = path.join(temporary, 'b');
  const assetLibrary = createAttachmentService({ directory: path.join(aData, 'attachments') });
  const bytes = Buffer.from('Bike 2.0 original attachment bytes 中文\n');
  const asset = await assetLibrary.putBytes(bytes, 'original.txt');
  const workspace = { version: 3, activeDocumentId: 'doc', documents: [{ id: 'doc', title: '验收文档', createdAt: timestamp, updatedAt: timestamp,
    attachments: { version: 1, items: { [asset.assetId]: asset.metadata } }, nodes: [{ ...node('a'), attachmentRefs: [{ assetId: asset.assetId, name: 'original.txt' }] }, node('b')] }] };
  const a = await launch(aData, workspace), b = await launch(bData, workspace);
  const url = `http://127.0.0.1:${syncServer.address().port}`;
  await configureSync(a.page, url); await configureSync(b.page, url);
  report('Checking node sync and original attachment delivery');
  await sync(a.page); await sync(b.page);
  const bLibrary = createAttachmentService({ directory: path.join(bData, 'attachments') });
  assert.deepEqual(await bLibrary.read(asset.assetId), bytes);
  checks.push('two isolated Electron clients receive original attachment bytes automatically over real HTTP');
  await edit(a.page, 'a', 'Offline A'); await edit(b.page, 'b', 'Offline B');
  const convergenceStarted = performance.now();
  await sync(a.page); await sync(b.page); await sync(a.page);
  assert.equal(await a.page.locator('[data-node-id=b] textarea').inputValue(), 'Offline B');
  assert.equal(await b.page.locator('[data-node-id=a] textarea').inputValue(), 'Offline A');
  timingsMs.offlineEditsThroughThreeManualSyncs = performance.now() - convergenceStarted;
  checks.push('independent offline node edits converge in both actual Electron renderers');

  report('Checking node conflict preview and resolution');
  await edit(a.page, 'a', 'Conflict A'); await edit(b.page, 'a', 'Conflict B');
  await sync(a.page); await sync(b.page); await sync(a.page);
  await b.page.getByRole('button', { name: '版本历史', exact: true }).click();
  await b.page.getByRole('button', { name: /节点冲突/ }).click();
  await b.page.getByRole('button', { name: '预览采用候选值' }).first().click();
  await b.page.getByRole('dialog', { name: '修改提案', exact: true }).waitFor();
  await b.page.getByRole('button', { name: '应用所选修改' }).click();
  await b.page.getByRole('dialog', { name: '修改提案', exact: true }).waitFor({ state: 'hidden' });
  await sync(b.page); await sync(a.page);
  assert.equal(await a.page.locator('[data-node-id=a] textarea').inputValue(), 'Conflict B');
  assert.equal(store.operations.unresolved().length, 0);
  checks.push('same-field conflict is visible, previews candidate and resolves through the ordinary operation stream');

  report('Checking compensation after a later remote edit');
  await edit(a.page, 'a', 'Undo local'); await sync(a.page); await sync(b.page);
  await edit(b.page, 'b', 'Keep remote'); await sync(b.page); await sync(a.page);
  await a.page.getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal(await a.page.locator('[data-node-id=a] textarea').inputValue(), 'Conflict B');
  assert.equal(await a.page.locator('[data-node-id=b] textarea').inputValue(), 'Keep remote');
  checks.push('actual UI undo compensates its own field while preserving a later remote edit');

  report('Checking AI proposal partial acceptance and rejection');
  await a.app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); window.webContents.send('open-api-config'); });
  const aiConfigDialog = a.page.getByRole('dialog', { name: 'AI 配置', exact: true });
  await aiConfigDialog.getByLabel('API baseurl').fill(`http://127.0.0.1:${provider.address().port}/v1`);
  await aiConfigDialog.locator('.api-key-input button').click();
  await aiConfigDialog.locator('.api-key-input input').fill('runtime-provider-fixture');
  await aiConfigDialog.getByLabel('大模型', { exact: true }).fill('deterministic-fixture');
  assert.equal(await aiConfigDialog.locator('.api-key-input input').inputValue(), 'runtime-provider-fixture');
  await aiConfigDialog.locator('.config-error').waitFor({ state: 'hidden' });
  await aiConfigDialog.getByRole('button', { name: '保存', exact: true }).click();
  await aiConfigDialog.waitFor({ state: 'hidden' });
  await a.page.locator('[data-node-id=a] textarea').click();
  await a.page.getByRole('button', { name: 'AI 知识操作', exact: true }).click();
  await a.page.getByRole('dialog', { name: 'AI 知识操作', exact: true }).locator('select').first().selectOption('tasks');
  await a.page.getByRole('button', { name: '生成提案' }).click();
  const dialog = a.page.getByRole('dialog', { name: '修改提案', exact: true }); await dialog.waitFor();
  timingsMs.providerResponseToProposalVisible = performance.now() - providerResponseAt;
  assert.equal((await readStored(a.page)).documents[0].nodes[0].children.length, 0);
  await dialog.getByRole('checkbox').first().uncheck();
  await fs.mkdir(path.join(root, 'output/playwright'), { recursive: true });
  await a.page.screenshot({ animations: 'disabled', path: path.join(root, 'output/playwright/bike-2.0-proposal.png') });
  await dialog.getByRole('button', { name: '应用所选修改' }).click(); await dialog.waitFor({ state: 'hidden' });
  let saved = await readStored(a.page);
  assert.deepEqual(saved.documents[0].nodes[0].children.map((node) => node.text), ['任务二']);
  providerResult = { text: 'A summary candidate' };
  await a.page.getByRole('button', { name: 'AI 知识操作', exact: true }).click();
  await a.page.getByRole('dialog', { name: 'AI 知识操作', exact: true }).locator('select').first().selectOption('summary');
  await a.page.getByRole('button', { name: '生成提案' }).click(); await dialog.waitFor();
  const beforeReject = JSON.stringify(await readStored(a.page));
  await dialog.getByRole('button', { name: '拒绝提案' }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(JSON.stringify(await readStored(a.page)), beforeReject);
  checks.push('deterministic HTTP provider, no mutation before approval, partial task acceptance and summary rejection');

  report('Checking bundled stdio MCP read barrier and application confirmation');
  await a.page.getByRole('button', { name: /Live MCP ·/ }).click();
  await a.page.getByRole('dialog', { name: 'Live MCP 授权', exact: true }).getByRole('checkbox').check();
  await a.page.getByRole('button', { name: '启用所选授权' }).click();
  await a.page.getByRole('dialog', { name: 'Live MCP 授权', exact: true }).waitFor({ state: 'hidden' });
  const client = await connectMcp(a.app, aData);
  await edit(a.page, 'a', 'Live latest without blur', false);
  const readStarted = performance.now();
  const summary = parse(await client.callTool({ name: 'get_workspace_summary', arguments: {} }));
  timingsMs.focusedTopicReadBarrierRoundtrip = performance.now() - readStarted;
  const read = parse(await client.callTool({ name: 'get_document', arguments: { documentId: 'doc', format: 'compact' } }));
  assert.ok(JSON.stringify(read).includes('Live latest without blur'));
  const revision = summary.revision;
  assert.ok(revision, JSON.stringify(summary));
  const preview = parse(await client.callTool({ name: 'update_node', arguments: { documentId: 'doc', nodeId: 'a', text: 'MCP approved', expectedRevision: revision, dryRun: true } }));
  assert.equal(preview.applied, false);
  assert.equal(await dialog.count(), 0);
  const pending = parse(await client.callTool({ name: 'update_node', arguments: preview.confirmationArgs }));
  assert.equal(pending.applied, false); assert.equal(pending.status, 'pending'); await dialog.waitFor();
  const approvalStarted = performance.now();
  await dialog.getByRole('button', { name: '应用所选修改' }).click(); await dialog.waitFor({ state: 'hidden' });
  const status = parse(await client.callTool({ name: 'get_proposal_status', arguments: { requestId: pending.requestId } }));
  timingsMs.applicationApprovalToQueriedPersistentReceipt = performance.now() - approvalStarted;
  if (status.status !== 'committed') {
    const receipts = await a.page.evaluate(async () => {
      const db = await new Promise((resolve) => { const request = indexedDB.open('bike-db'); request.onsuccess = () => resolve(request.result); });
      try { return await new Promise((resolve) => { const tx = db.transaction('workspace-store'), request = tx.objectStore('workspace-store').getAll(); tx.oncomplete = () => resolve(request.result.filter((value) => value?.receipts).map((value) => Object.keys(value.receipts))); }); } finally { db.close(); }
    });
    console.error('MCP receipt inspection', JSON.stringify({ previewRequestId: preview.requestId, pending, status, receipts, nodeText: (await readStored(a.page)).documents[0].nodes[0].text, body: (await a.page.locator('body').innerText()).slice(-1200) }));
  }
  assert.equal(status.status, 'committed');
  assert.equal(await a.page.locator('[data-node-id=a] textarea').inputValue(), 'MCP approved');
  const retried = parse(await client.callTool({ name: 'update_node', arguments: preview.confirmationArgs }));
  assert.equal(retried.status, 'committed'); assert.equal(await dialog.count(), 0);
  const discovery = JSON.parse(await fs.readFile(path.join(aData, 'live-mcp.json'), 'utf8'));
  const directRequest = (method, payload = {}) => new Promise((resolve, reject) => {
    const socket = createConnection(discovery.socketPath);
    let response = '';
    socket.setTimeout(30_000, () => { socket.destroy(); reject(new Error('Live direct request timed out')); });
    socket.on('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify({ id: 'direct-retry', token: discovery.token, method, payload }) + '\n'));
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.includes('\n')) { socket.destroy(); resolve(JSON.parse(response.slice(0, response.indexOf('\n')))); }
    });
  });
  const snapshot = (await directRequest('snapshot')).result;
  const changedCandidate = structuredClone(snapshot.workspace);
  changedCandidate.documents[0].nodes[0].text = 'Reused identity with altered content';
  const invalidRetry = await directRequest('proposal', { requestId: pending.requestId, workspaceId: snapshot.workspaceId,
    expectedRevision: snapshot.revision, candidate: changedCandidate, dryRun: false });
  assert.equal(invalidRetry.ok, false);
  assert.match(invalidRetry.error, /相同请求身份携带了不同内容/);
  assert.equal(await a.page.locator('[data-node-id=a] textarea').inputValue(), 'MCP approved');
  checks.push('actual MCP SDK client via bundled Electron stdio, latest focused input, dry-run, approval, receipt, UI refresh and idempotent retry');
  checks.push('direct Live transport refuses a committed request identity with altered candidate content');
  const duplicates = ['Concurrent candidate one', 'Concurrent candidate two'].map((text) => {
    const candidate = structuredClone(snapshot.workspace);
    candidate.documents[0].nodes[0].text = text;
    return { requestId: 'concurrent-reused-id', workspaceId: snapshot.workspaceId,
      expectedRevision: snapshot.revision, candidate, dryRun: false };
  });
  const concurrent = await Promise.all(duplicates.map((payload) => directRequest('proposal', payload)));
  assert.equal(concurrent.filter((result) => result.ok).length, 1);
  assert.match(concurrent.find((result) => !result.ok).error, /相同请求身份携带了不同内容/);
  await dialog.getByRole('button', { name: '拒绝提案' }).click();
  const queuedIndex = concurrent.findIndex((result) => result.ok);
  const rejectedRetry = await directRequest('proposal', duplicates[queuedIndex]);
  assert.equal(rejectedRetry.ok, true, JSON.stringify({ response: rejectedRetry, focus: await a.page.evaluate(() => ({tag:document.activeElement?.tagName, className:document.activeElement?.className, value:document.activeElement?.value})) }));
  assert.equal(rejectedRetry.result.status, 'rejected');
  assert.equal((await directRequest('proposal', duplicates[1 - queuedIndex])).ok, false);
  assert.equal(await dialog.count(), 0);
  assert.equal((await readStored(a.page)).documents[0].nodes[0].text, 'MCP approved');
  checks.push('concurrent reuse of one Live request identity registers only one candidate and rejected requests cannot be requeued');

  report('Checking title and note read barriers, IME protection and competing MCP clients');
  await a.page.locator('.title-input').fill('Live title without blur');
  const editingTitle = await client.callTool({ name: 'get_document', arguments: { documentId: 'doc', format: 'json' } });
  assert.equal(editingTitle.isError, true);
  assert.match(JSON.stringify(editingTitle), /正在编辑文档标题/);
  assert.equal(await a.page.locator('.title-input').evaluate(element => document.activeElement === element), true);
  await a.page.locator('.title-input').press('Tab');
  const titled = parse(await client.callTool({ name: 'get_document', arguments: { documentId: 'doc', format: 'json' } }));
  assert.ok(JSON.stringify(titled).includes('Live title without blur'));
  assert.equal((await readStored(a.page)).documents[0].title, 'Live title without blur');
  await a.page.locator('[data-node-id=a] textarea').click();
  await a.page.getByTitle('显示节点详情', { exact: true }).click();
  await a.page.getByLabel('备注', { exact: true }).fill('Live note without blur');
  const noted = parse(await client.callTool({ name: 'get_document', arguments: { documentId: 'doc', format: 'json' } }));
  assert.ok(JSON.stringify(noted).includes('Live note without blur'));
  assert.equal((await readStored(a.page)).documents[0].nodes[0].note, 'Live note without blur');
  const beforeComposition = JSON.stringify(await readStored(a.page));
  await a.page.getByLabel('备注', { exact: true }).evaluate((element) => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'zhong' })));
  try {
    const composing = await client.callTool({ name: 'get_workspace_summary', arguments: {} });
    assert.equal(composing.isError, true);
    assert.match(JSON.stringify(composing), /忙碌或受保护/);
    assert.equal(JSON.stringify(await readStored(a.page)), beforeComposition);
  } finally {
    await a.page.getByLabel('备注', { exact: true }).evaluate((element) => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' })));
  }
  const otherClient = await connectMcp(a.app, aData);
  const common = parse(await client.callTool({ name: 'get_workspace_summary', arguments: {} })).revision;
  const firstPreview = parse(await client.callTool({ name: 'update_node', arguments: { documentId: 'doc', nodeId: 'a', text: 'First MCP client', expectedRevision: common } }));
  const secondPreview = parse(await otherClient.callTool({ name: 'update_node', arguments: { documentId: 'doc', nodeId: 'a', text: 'Second MCP client', expectedRevision: common } }));
  const firstPending = parse(await client.callTool({ name: 'update_node', arguments: firstPreview.confirmationArgs }));
  const secondPending = parse(await otherClient.callTool({ name: 'update_node', arguments: secondPreview.confirmationArgs }));
  await dialog.getByRole('button', { name: '应用所选修改' }).click();
  await dialog.getByText('目标内容已变化，请重新生成并比较。', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '应用所选修改' }).isDisabled(), true);
  assert.equal(parse(await client.callTool({ name: 'get_proposal_status', arguments: { requestId: firstPending.requestId } })).status, 'committed');
  assert.equal(parse(await otherClient.callTool({ name: 'get_proposal_status', arguments: { requestId: secondPending.requestId } })).status, 'stale');
  assert.equal((await readStored(a.page)).documents[0].nodes[0].text, 'First MCP client');
  await dialog.getByRole('button', { name: '拒绝提案' }).click();
  checks.push('Live reads preserve title focus and wait for user completion; note drafts persist, composition blocks the barrier, competing approvals invalidate the later proposal');

  report('Checking Markdown read barrier and revoked-session protection');
  await a.page.locator('.segmented').getByRole('button', { name: 'Markdown', exact: true }).click();
  const source = a.page.getByRole('textbox', { name: 'Markdown 源码', exact: true });
  await source.fill(`${await source.inputValue()}\n\nLive Markdown draft without blur\n`);
  const markdownRead = parse(await client.callTool({ name: 'get_document', arguments: { documentId: 'doc', format: 'markdown' } }));
  assert.ok(JSON.stringify(markdownRead).includes('Live Markdown draft without blur'));
  assert.ok((await readStored(a.page)).documents[0].markdownSource.includes('Live Markdown draft without blur'));
  await a.page.getByRole('button', { name: /Live MCP ·/ }).click();
  const authorization = a.page.getByRole('dialog', { name: 'Live MCP 授权', exact: true });
  await authorization.getByRole('button', { name: '撤销并关闭', exact: true }).click();
  await a.page.waitForFunction(() => document.body.textContent.includes('Live MCP · 已关闭'));
  const revoked = await client.callTool({ name: 'get_workspace_summary', arguments: {} });
  assert.equal(revoked.isError, true);
  assert.match(JSON.stringify(revoked), /断开/);
  await authorization.getByRole('checkbox').uncheck();
  await authorization.getByRole('button', { name: '启用所选授权', exact: true }).click();
  await authorization.waitFor({ state: 'hidden' });
  const readOnlyClient = await connectMcp(a.app, aData);
  const reconnected = parse(await readOnlyClient.callTool({ name: 'get_workspace_summary', arguments: {} }));
  const readonlyPreview = parse(await readOnlyClient.callTool({ name: 'create_node', arguments: { documentId: 'doc', text: 'Readonly must not write', expectedRevision: reconnected.revision } }));
  const readonlyWrite = await readOnlyClient.callTool({ name: 'create_node', arguments: readonlyPreview.confirmationArgs });
  assert.equal(readonlyWrite.isError, true);
  assert.match(JSON.stringify(readonlyWrite), /只读/);
  checks.push('focused Markdown is visible through Live, revocation disconnects the old session, reconnected read-only access refuses real writes');
  assert.ok(Object.values(timingsMs).every((value) => Number.isFinite(value) && value >= 0));
  assert.deepEqual(errors, []);
  report('Completed the 2.0 runtime matrix');
  const result = { version: JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version,
    packaged: Boolean(executable), runtime: await a.app.evaluate(() => process.versions), checks, errors, timingsMs,
    limitations: ['two isolated processes on one macOS host', 'deterministic provider fixture', 'does not replace two physical devices or a real provider account'],
    attachmentSha256: createHash('sha256').update(bytes).digest('hex') };
  await fs.writeFile(path.join(root, 'output/playwright/bike-2.0-runtime.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await fs.mkdir(path.join(root, 'output/playwright'), { recursive: true });
  const page = apps[0] && await apps[0].firstWindow().catch(() => null);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, 'output/playwright/bike-2.0-runtime-failure.png') }).catch(() => {});
  console.error('Phases', phases); throw error;
} finally {
  for (const client of clients) await client.close().catch(() => {});
  for (const app of apps.reverse()) await app.close().catch(() => {});
  await closeHttp(provider); await closeHttp(syncServer); store?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
