import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const executable = process.env.BIKE_ELECTRON_EXECUTABLE;
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-ui-200-'));
const artifacts = path.join(root, 'output/playwright/ui-2.0');
const errors = [], results = [];
let app;
const frame = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const style = (locator) => locator.evaluate((element) => {
  const css = getComputedStyle(element), box = element.getBoundingClientRect();
  return { font: css.fontFamily, fontSize: css.fontSize, weight: css.fontWeight, minHeight: css.minHeight, radius: css.borderRadius,
    width: Math.round(box.width), height: Math.round(box.height), x: box.x, y: box.y, right: box.right, bottom: box.bottom, color: css.color, background: css.backgroundColor, borderWidth: css.borderWidth };
});
const modalMetrics = async (page, name, width) => {
  const dialog = page.getByRole('dialog', { name, exact: true });
  await dialog.waitFor(); await frame(page);
  const panel = dialog.locator('.api-config-dialog, .workspace-dialog, .confirm-dialog');
  await panel.evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {}))); });
  const box = await style(panel), title = await style(panel.locator('h3').first());
  const close = panel.locator('.dialog-close');
  assert.equal(box.width, width);
  assert.equal(title.fontSize, '18px');
  assert.ok(box.y >= 20 && box.bottom <= await page.evaluate(() => innerHeight) - 20, JSON.stringify(box));
  if (await close.count()) { const button = await style(close); assert.equal(button.width, 30); assert.equal(button.height, 30); }
  const footer = panel.locator('footer button, .confirm-actions button');
  for (let index = 0; index < await footer.count(); index++) {
    const button = await style(footer.nth(index));
    assert.equal(button.fontSize, '13px'); assert.equal(button.height, 38); assert.equal(button.radius, '6px'); assert.equal(button.weight, '620');
  }
  return { name, panel: box, title, footerButtons: await footer.count() };
};
try {
  await fs.mkdir(artifacts, { recursive: true });
  app = await _electron.launch({ ...(executable ? { executablePath: executable } : {}), args: executable ? [] : [root], cwd: root,
    env: { ...process.env, BIKE_TEST_USER_DATA: path.join(temporary, 'profile'), VITE_DEV_SERVER_URL: '', ELECTRON_RUN_AS_NODE: '' } });
  const page = await app.firstWindow(); page.on('pageerror', (error) => errors.push(error.message)); page.on('dialog', (dialog) => dialog.accept());
  await page.locator('.shell').waitFor();
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => { const request = indexedDB.open('bike-db'); request.onsuccess = () => resolve(request.result); });
    const node = { id: 'topic', text: '界面一致性验收', note: '保留原有内容层级', checked: false, collapsed: false, color: 'plain', children: [] };
    const workspace = { version: 3, activeDocumentId: 'ui-doc', documents: [{ id: 'ui-doc', title: '本地化大纲产品蓝图', createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z', nodes: [node] }] };
    await new Promise((resolve) => { const tx = db.transaction('workspace-store', 'readwrite'), store = tx.objectStore('workspace-store'); store.put(workspace, 'workspace'); store.put({ revision: 100 }, 'workspace-meta'); tx.oncomplete = resolve; }); db.close();
  });
  await page.reload(); await page.locator('[data-node-id=topic]').waitFor();
  await app.evaluate(({ session }, directory) => {
    globalThis.__uiDownloads = [];
    session.defaultSession.on('will-download', (_event, item) => {
      const entry = { filename: `${directory}/${item.getFilename()}`, state: 'progressing' };
      globalThis.__uiDownloads.push(entry); item.setSavePath(entry.filename);
      item.once('done', (_event, state) => { entry.state = state; });
    });
  }, temporary);
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByTitle('切换到暗黑模式', { exact: true }).click();
    for (const [width, height] of [[1366, 960], [1728, 1117]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
      if (!await page.locator('.search-controls details').evaluate((element) => element.open)) await page.locator('.search-controls summary').click();
      assert.equal(await page.getByRole('button', { name: '保存当前筛选', exact: true }).isVisible(), true);
      assert.equal(await page.getByRole('button', { name: '清除筛选', exact: true }).isVisible(), true);
      await page.locator('.search-controls summary').click();
      assert.equal(await page.getByRole('button', { name: '保存当前筛选', exact: true }).isHidden(), true);
      assert.equal(await page.getByRole('button', { name: '清除筛选', exact: true }).isHidden(), true);
      await page.locator('.search-controls summary').click();
      const toolbar = await style(page.locator('.toolstrip button').first());
      const filter = await style(page.locator('.search-control-actions button').first());
      const select = await style(page.getByLabel('筛选文档范围'));
      assert.equal(toolbar.font, filter.font); assert.equal(select.font, toolbar.font);
      for (const button of [toolbar, filter]) { assert.equal(button.fontSize, '12px'); assert.equal(button.weight, '620'); assert.equal(button.height, 32); assert.equal(button.radius, '6px'); }
      assert.equal(select.fontSize, '13px');
      const checkboxes = await page.locator('.search-controls input[type=checkbox]').evaluateAll((elements) => elements.map((element) => ({ width: getComputedStyle(element).width, height: getComputedStyle(element).height })));
      assert.ok(checkboxes.every((box) => box.width === '16px' && box.height === '16px'));
      const trigger = page.getByRole('button', { name: '导出', exact: true });
      assert.equal(await trigger.evaluate((element) => element.nextElementSibling.textContent.trim()), 'iCloud 备份');
      const restore = await style(page.getByRole('button', { name: '载入备份', exact: true }));
      const remove = await style(page.getByTitle('删除文档', { exact: true }));
      assert.ok(Math.abs(restore.right - remove.right) <= 1, JSON.stringify({ restore, remove }));
      assert.ok(Math.abs(restore.y - toolbar.y) <= 1, JSON.stringify({ restore, toolbar }));
      const leftTools = page.locator('.toolstrip-tools');
      await leftTools.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      assert.equal((await style(page.getByRole('button', { name: '载入备份', exact: true }))).right, restore.right);
      await leftTools.evaluate((element) => { element.scrollLeft = 0; });
      await trigger.click(); const menu = page.getByRole('menu', { name: '导出文档' });
      await menu.waitFor();
      assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['导出 MD', '带元数据', 'OPML', 'FreeMind', 'HTML', 'PDF', '工作区']);
      const menuBox = await style(menu);
      assert.ok(menuBox.x >= 0 && menuBox.right <= width && menuBox.y >= 0 && menuBox.bottom <= height, JSON.stringify(menuBox));
      await page.screenshot({ path: path.join(artifacts, `export-${theme}-${width}.png`), animations: 'disabled' });
      await page.keyboard.press('End'); assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), '工作区');
      await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
      assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
      await trigger.click(); await page.getByPlaceholder('搜索文档、主题、备注').click(); await menu.waitFor({ state: 'hidden' });
      results.push({ theme, viewport: [width, height], toolbar, filter, select, menu: menuBox, checkboxes, rightAlignment: { restore: restore.right, remove: remove.right } });
    }
    const utilities = page.locator('.sidebar-utility-actions button');
    assert.ok(await utilities.count() >= 3);
    assert.equal(await utilities.getByText('导出 1.7 兼容 ZIP 副本', { exact: true }).count(), 1);
    for (let index = 0; index < await utilities.count(); index++) {
      const button = await style(utilities.nth(index));
      assert.equal(button.fontSize, '12px');
      assert.equal(button.weight, '620');
      assert.equal(button.borderWidth, '0px');
      assert.ok(button.height >= 32);
      assert.equal(button.background, 'rgba(0, 0, 0, 0)');
    }
    await page.locator('.sidebar').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.locator('.sidebar').screenshot({ path: path.join(artifacts, `sidebar-utilities-${theme}.png`), animations: 'disabled' });
    await page.locator('.sidebar-utility-actions').screenshot({ path: path.join(artifacts, `utilities-${theme}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: 'AI 知识操作', exact: true }).click();
    results.push({ theme, modal: await modalMetrics(page, 'AI 知识操作', 540) });
    await page.screenshot({ path: path.join(artifacts, `workflow-${theme}.png`), animations: 'disabled' });
    await page.getByRole('dialog', { name: 'AI 知识操作', exact: true }).getByLabel('关闭', { exact: true }).click();
    await page.getByRole('button', { name: /Live MCP ·/ }).click();
    results.push({ theme, modal: await modalMetrics(page, 'Live MCP 授权', 540) });
    await page.getByRole('dialog', { name: 'Live MCP 授权', exact: true }).getByLabel('关闭', { exact: true }).click();
    await page.getByTitle('同步设置', { exact: true }).click();
    results.push({ theme, modal: await modalMetrics(page, '文档同步', 540) });
    await page.getByRole('dialog', { name: '文档同步', exact: true }).locator('.dialog-close').click();
    await page.getByTitle('备份设置', { exact: true }).click();
    results.push({ theme, modal: await modalMetrics(page, '桌面备份', 540) });
    await page.getByRole('dialog', { name: '桌面备份', exact: true }).locator('.dialog-close').click();
    await page.getByRole('button', { name: '版本历史', exact: true }).click();
    results.push({ theme, modal: await modalMetrics(page, '版本历史', 960) });
    await page.getByRole('button', { name: '操作与同步历史', exact: true }).click();
    await page.screenshot({ path: path.join(artifacts, `history-${theme}.png`), animations: 'disabled' });
    await page.getByRole('dialog', { name: '版本历史', exact: true }).locator('.dialog-close').click();
    await page.getByTitle('回收站', { exact: true }).click();
    results.push({ theme, modal: await modalMetrics(page, '回收站', 720) });
    await page.getByRole('dialog', { name: '回收站', exact: true }).locator('.dialog-close').click();
    await page.getByTitle('删除文档', { exact: true }).click();
    results.push({ theme, modal: await modalMetrics(page, '删除文档', 380) });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('open-api-config'));
    results.push({ theme, modal: await modalMetrics(page, 'AI 配置', 540) });
    await page.getByRole('dialog', { name: 'AI 配置', exact: true }).locator('.dialog-close').click();
  }
  const downloadFromMenu = async (label) => {
    const index = await app.evaluate(() => globalThis.__uiDownloads.length);
    await page.getByRole('button', { name: '导出', exact: true }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = await app.evaluate((_electron, index) => globalThis.__uiDownloads[index], index);
      if (current?.state === 'completed') return current.filename;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`导出未完成 ${label}`);
  };
  assert.match(await fs.readFile(await downloadFromMenu('导出 MD'), 'utf8'), /界面一致性验收/);
  assert.equal(JSON.parse(await fs.readFile(await downloadFromMenu('工作区'), 'utf8')).documents[0].nodes[0].text, '界面一致性验收');
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => { const request = indexedDB.open('bike-db'); request.onsuccess = () => resolve(request.result); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('workspace-store', 'readwrite'), store = tx.objectStore('workspace-store');
      const request = store.get('workspace-meta');
      request.onsuccess = () => store.put({ ...request.result, revision: request.result.revision + 1, writer: 'other-window' }, 'workspace-meta');
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  await page.locator('[data-node-id=topic] textarea').fill('冲突窗口的未保存修改');
  await page.keyboard.press('Tab');
  await page.getByRole('heading', { name: '工作区已在其他标签页或窗口中更新', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /Live MCP ·|2.0 节点同步 · 协议设置|备份并启用 2.0 工作区/ }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '载入最新内容', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: '用本页内容覆盖', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: '导出 1.7 兼容 ZIP 副本', exact: true }).isVisible(), true);
  for (const button of await page.locator('.loading-error-actions button').all()) {
    const metrics = await style(button);
    assert.equal(metrics.height, 38);
    assert.equal(metrics.fontSize, '13px');
    assert.equal(metrics.weight, '620');
  }
  await page.screenshot({ path: path.join(artifacts, 'storage-conflict.png'), animations: 'disabled' });
  results.push({ recoveryScreen: 'conflict recovery and compatible export actions available' });
  assert.deepEqual(errors, []);
  const report = { packaged: Boolean(executable), results, downloads: ['Markdown', 'workspace JSON'], errors };
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const page = app && await app.firstWindow().catch(() => null);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, 'failure.png'), animations: 'disabled' }).catch(() => {});
  throw error;
} finally { await app?.close(); await fs.rm(temporary, { recursive: true, force: true }); }
