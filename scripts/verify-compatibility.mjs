import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import { createAttachmentService } from '../electron/attachment-service.cjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const candidate = process.env.BIKE_ELECTRON_EXECUTABLE;
const legacy = process.env.BIKE_LEGACY_EXECUTABLE;
if (!candidate || !legacy) throw new Error('请设置 BIKE_ELECTRON_EXECUTABLE 和 BIKE_LEGACY_EXECUTABLE，分别指向打包候选和 1.7.0 可执行文件');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-compatibility-'));
const apps = [], errors = [];
const stamp = '2026-11-09T00:00:00Z';
const bytes = Buffer.from('Original compatibility attachment 中文\n');
const data = path.join(temporary, 'candidate');
const asset = await createAttachmentService({ directory: path.join(data, 'attachments') }).putBytes(bytes, 'compatibility.txt');
const link = '[[Rollback#Topic B]]';
const workspace = { version: 3, activeDocumentId: 'doc', documents: [{
  id: 'doc', title: 'Rollback', createdAt: stamp, updatedAt: stamp, extension: { retained: true },
  markdownSource: '# Rollback\n\n- Topic A\n  - Child\n- Topic B\n',
  markdownUpdatedAt: stamp,
  attachments: { version: 1, items: { [asset.assetId]: asset.metadata } },
  knowledge: { version: 1, references: [{ id: 'reference', source: { kind: 'node-field', nodeId: 'a', field: 'note',
    start: 0, end: link.length, raw: link }, target: { documentId: 'doc', nodeId: 'b' }, labelMode: 'auto' }],
  relations: [{ id: 'relation', fromNodeId: 'a', toNodeId: 'b', label: 'supports' }] },
  nodes: [{ id: 'a', text: 'Topic A', note: link, attachmentRefs: [{ assetId: asset.assetId, name: asset.name }],
    extension: { node: true }, children: [{ id: 'child', text: 'Child', codeBlock: 'const value = 1;', children: [] }] },
  { id: 'b', text: 'Topic B', isTodo: true, checked: true, table: [['列', '值'], ['A', '1']], children: [] }],
}], trash: [{ id: 'trash-entry', deletedAt: stamp, originalIndex: 1, document: {
  id: 'deleted-document', title: 'Deleted', createdAt: stamp, updatedAt: stamp,
  nodes: [{ id: 'deleted-topic', text: 'Recoverable', children: [] }],
} }] };
const stored = (page, key = 'workspace') => page.evaluate(async (key) => {
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open('bike-db'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction('workspace-store'), request = tx.objectStore('workspace-store').get(key);
    tx.oncomplete = () => resolve(request.result); tx.onabort = () => reject(tx.error);
  }); } finally { db.close(); }
}, key);
const launch = async (executablePath, userData) => {
  const app = await _electron.launch({ executablePath, args: [], cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', VITE_DEV_SERVER_URL: '', BIKE_TEST_USER_DATA: userData } });
  apps.push(app);
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.message().startsWith('将当前同步空间升级到 2.0') ? dialog.dismiss() : dialog.accept());
  await page.locator('.shell').waitFor();
  await app.evaluate(({ session }, directory) => {
    session.defaultSession.on('will-download', (_event, item) => item.setSavePath(`${directory}/${item.getFilename()}`));
  }, temporary);
  return { app, page, userData };
};
const seed = async (page, value) => {
  await page.evaluate(async (workspace) => {
    const db = await new Promise((resolve) => { const request = indexedDB.open('bike-db'); request.onsuccess = () => resolve(request.result); });
    try { await new Promise((resolve, reject) => {
      const tx = db.transaction('workspace-store', 'readwrite'), store = tx.objectStore('workspace-store');
      store.put(workspace, 'workspace'); store.put({ revision: 100 }, 'workspace-meta');
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    }); } finally { db.close(); }
  }, value);
  await page.reload();
  await page.locator('[data-node-id=a] textarea').waitFor();
};
const dialogs = (app, open, save) => app.evaluate(({ dialog }, paths) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.open] });
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.save });
}, { open, save });
const verifyContents = (actual, version) => {
  assert.equal(actual.version, version);
  const document = actual.documents.find((item) => item.id === 'doc');
  assert.equal(document.title, workspace.documents[0].title);
  assert.equal(document.markdownSource, workspace.documents[0].markdownSource);
  assert.deepEqual(document.nodes.map((node) => node.id), ['a', 'b']);
  assert.equal(document.nodes[0].children[0].id, 'child');
  assert.equal(document.nodes[0].children[0].codeBlock, 'const value = 1;');
  assert.equal(document.nodes[0].note, link);
  assert.deepEqual(document.nodes[1].table, [['列', '值'], ['A', '1']]);
  assert.equal(document.nodes[1].checked, true);
  assert.equal(document.extension.retained, true);
  assert.equal(document.nodes[0].extension.node, true);
  assert.equal(document.knowledge.references[0].target.nodeId, 'b');
  assert.equal(document.knowledge.relations[0].label, 'supports');
  assert.equal(actual.trash[0].document.id, 'deleted-document');
  assert.equal(document.nodes[0].attachmentRefs[0].assetId, asset.assetId);
};
try {
  const modern = await launch(candidate, data);
  const version = await modern.app.evaluate(({ app }) => app.getVersion());
  await seed(modern.page, workspace);
  const archive = path.join(temporary, 'compatible.zip');
  await dialogs(modern.app, archive, archive);
  await modern.page.getByRole('button', { name: '导出 1.7 兼容 ZIP 副本', exact: true }).click();
  await modern.page.locator('.toast').getByText('已导出 1.7 兼容 ZIP 副本，操作日志与本机副本身份保留在当前数据库', { exact: true }).waitFor();
  assert.ok((await fs.stat(archive)).size > 0);
  verifyContents(await stored(modern.page), 3);
  await modern.app.close();

  const old = await launch(legacy, path.join(temporary, 'legacy'));
  const legacyVersion = await old.app.evaluate(({ app }) => app.getVersion());
  assert.equal(legacyVersion, '1.7.0');
  await dialogs(old.app, archive, path.join(temporary, 'legacy-backup.zip'));
  await old.page.getByRole('button', { name: '载入 ZIP', exact: true }).click();
  await old.page.locator('[data-node-id=a] textarea').waitFor();
  const restored = await stored(old.page);
  verifyContents(restored, 2);
  assert.deepEqual(await createAttachmentService({ directory: path.join(old.userData, 'attachments') }).read(asset.assetId, asset.metadata), bytes);
  await old.app.close();

  const upgradeData = path.join(temporary, 'upgrade');
  await createAttachmentService({ directory: path.join(upgradeData, 'attachments') }).putBytes(bytes, asset.name);
  const upgrade = await launch(candidate, upgradeData);
  await seed(upgrade.page, restored);
  const preUpgradeArchive = path.join(temporary, 'pre-upgrade.zip');
  await dialogs(upgrade.app, preUpgradeArchive, preUpgradeArchive);
  await upgrade.page.getByRole('button', { name: '备份并启用 2.0 工作区', exact: true }).click();
  await upgrade.page.getByRole('button', { name: '2.0 节点同步 · 协议设置', exact: true }).waitFor();
  verifyContents(await stored(upgrade.page), 3);
  verifyContents(await stored(upgrade.page, 'pre-operation-workspace'), 2);
  assert.ok((await fs.stat(preUpgradeArchive)).size > 0);
  assert.deepEqual(await createAttachmentService({ directory: path.join(upgradeData, 'attachments') }).read(asset.assetId, asset.metadata), bytes);
  assert.deepEqual(errors, []);
  const report = { version, legacyVersion, isolatedProfiles: true, checks: [
    'candidate v3 exports a 1.7-compatible ZIP through the real sidebar entry',
    'actual 1.7.0 imports the ZIP into a fresh profile',
    'IDs, Markdown, notes, code, tables, tasks, links, relations, extension fields and trash survive',
    'the original attachment bytes and SHA-256 identity survive the downgrade',
    'candidate upgrades the restored v2 body through the real ZIP backup and migration entry',
    'pre-operation v2 body, pre-upgrade ZIP and original attachment remain available',
  ], errors };
  const output = path.join(root, 'output/playwright');
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'bike-2.0-compatibility.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const app of apps.reverse()) await app.close().catch(() => {});
  await fs.rm(temporary, { recursive: true, force: true });
}
