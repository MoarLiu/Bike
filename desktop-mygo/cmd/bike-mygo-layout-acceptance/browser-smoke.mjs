import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const require = createRequire(root + '/package.json');
const { chromium } = require('playwright');
const { createServer } = require('vite');
const out = root + '/docs/evidence-mygo-2026-11-11-integration/webkit-layout/source-browser';
await fs.mkdir(out, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 960 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', dialog => dialog.accept());
const report = { scope: 'Current-source Chromium correctness smoke after native CSS diagnosis, separate from native/process performance evidence', checks: [], errors };
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const read = () => page.evaluate(async () => { const db = await new Promise(resolve => { const r = indexedDB.open('bike-db'); r.onsuccess = () => resolve(r.result); }); try {
    return await new Promise(resolve => { const tx = db.transaction('workspace-store'), r = tx.objectStore('workspace-store').get('workspace'); tx.oncomplete = () => resolve(r.result); });
}
finally {
    db.close();
} });
const measure = () => page.locator('[data-node-id="layout-task"] textarea').evaluate(element => ({ height: element.getBoundingClientRect().height, scrollHeight: element.scrollHeight, width: element.getBoundingClientRect().width, value: element.value, start: element.selectionStart, end: element.selectionEnd }));
try {
    await page.goto('http://127.0.0.1:' + server.httpServer.address().port);
    await page.locator('.shell').waitFor();
    await page.evaluate(async () => {
        const n = (id, text, extra = {}) => ({ id, text, note: '', checked: false, collapsed: false, color: 'plain', children: [], ...extra });
        const stamp = '2026-11-11T00:00:00.000Z';
        const workspace = { version: 1, activeDocumentId: 'layout-doc', documents: [{ id: 'layout-doc', title: '布局回归', createdAt: stamp, updatedAt: stamp, nodes: [n('layout-parent', '普通主题', { children: [n('layout-task', '任务主题 中文', { isTodo: true, checked: true })] })] }, { id: 'target-doc', title: '目标文档', createdAt: stamp, updatedAt: stamp, nodes: [n('target-topic', '链接目标')] }] };
        const db = await new Promise(resolve => { const r = indexedDB.open('bike-db'); r.onsuccess = () => resolve(r.result); });
        try {
            await new Promise((resolve, reject) => { const tx = db.transaction('workspace-store', 'readwrite'), s = tx.objectStore('workspace-store'); s.clear(); s.put(workspace, 'workspace'); s.put({ revision: 100 }, 'workspace-meta'); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
        }
        finally {
            db.close();
        }
    });
    await page.reload();
    const task = page.locator('[data-node-id="layout-task"]');
    const checkbox = task.locator('.task-checkbox');
    const input = task.locator('textarea');
    await checkbox.waitFor();
    await frame();
    report.taskGeometry = await task.evaluate(row => { const box = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; }; const c = row.querySelector('.task-checkbox'), t = row.querySelector('textarea'); return { button: box(c), textarea: box(t), inline: c.parentElement === t.parentElement, buttons: row.querySelectorAll('.task-checkbox').length, row: box(row) }; });
    assert.equal(report.taskGeometry.inline, true);
    assert.equal(report.taskGeometry.button.width, 22);
    assert.equal(report.taskGeometry.button.height, 28);
    assert.ok(report.taskGeometry.textarea.x >= report.taskGeometry.button.right);
    assert.ok(report.taskGeometry.textarea.y < report.taskGeometry.button.bottom);
    report.checks.push('task completion button is inline 22x28 beside its label with one native button');
    await checkbox.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('[data-node-id="layout-task"] .task-checkbox').title === '设为已完成');
    await checkbox.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-node-id="layout-task"] .task-checkbox').title === '设为未完成');
    assert.equal(await page.locator('.outline-row').count(), 2);
    report.checks.push('real browser Space and Enter activate task button and preserve row count and checked state');
    const multiline = ('中文自动折行 😀 ' + 'wrapping '.repeat(12) + '\n').repeat(4);
    await input.fill(multiline);
    await frame();
    const wide = await measure();
    assert.ok(wide.height > 30);
    assert.ok(wide.scrollHeight <= wide.height + 1);
    await page.setViewportSize({ width: 1000, height: 960 });
    await page.waitForTimeout(180);
    await frame();
    const narrow = await measure();
    assert.ok(narrow.height > wide.height);
    assert.ok(narrow.scrollHeight <= narrow.height + 1);
    await page.setViewportSize({ width: 1366, height: 960 });
    await page.waitForTimeout(180);
    await frame();
    const widened = await measure();
    assert.equal(widened.height, wide.height);
    await input.fill('短');
    await frame();
    const shrunk = await measure();
    assert.ok(shrunk.height < wide.height);
    report.wrap = { wide, narrow, widened, shrunk };
    report.checks.push('multiline CJK and emoji rewrap at narrower width and shrink again without clipping');
    await input.fill('font metrics '.repeat(25));
    await frame();
    await input.evaluate(e => e.setSelectionRange(3, 8));
    const beforeFont = await measure();
    await input.evaluate(e => { e.style.fontSize = '28px'; document.fonts.dispatchEvent(new Event('loadingdone')); });
    await frame();
    const afterFont = await measure();
    assert.ok(afterFont.height > beforeFont.height);
    assert.equal(afterFont.start, 3);
    assert.equal(afterFont.end, 8);
    await input.evaluate(e => { e.style.fontSize = ''; document.fonts.dispatchEvent(new Event('loadingdone')); });
    await frame();
    assert.equal((await measure()).height, beforeFont.height);
    report.font = { beforeFont, afterFont };
    report.checks.push('font-metric resize preserves text selection and restores original height');
    await input.fill('输入前 ');
    await input.focus();
    await input.evaluate(e => e.setSelectionRange(e.value.length, e.value.length));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '正在输入中文', selectionStart: 6, selectionEnd: 6 });
    await frame();
    const composing = await measure();
    await cdp.send('Input.insertText', { text: '完成中文' });
    await frame();
    const committed = await measure();
    assert.equal(composing.value, '输入前 正在输入中文');
    assert.equal(committed.value, '输入前 完成中文');
    assert.equal(committed.start, committed.value.length);
    assert.equal(committed.end, committed.value.length);
    report.composition = { composing, committed, scope: 'Chromium CDP composition, not a real OS input method' };
    report.checks.push('browser composition and committed caret survive queued textarea measurement');
    await input.fill('换行测试 '.repeat(35) + '[[目标');
    await input.evaluate(e => e.setSelectionRange(e.value.length, e.value.length));
    await input.press('End');
    // A final ordinary input refreshes suggestions with the exact caret position.
    await input.type('文');
    await page.locator('.outline-link-popup').waitFor();
    await frame();
    report.popup = await task.evaluate(row => { const t = row.querySelector('textarea').getBoundingClientRect(), p = row.querySelector('.outline-link-popup'), r = p.getBoundingClientRect(); return { top: p.style.top, bottom: p.style.bottom, inputTop: t.top, inputBottom: t.bottom, popupTop: r.top, popupBottom: r.bottom }; });
    if (report.popup.top === '100%')
        assert.ok(report.popup.popupTop >= report.popup.inputBottom - 2);
    else
        assert.ok(report.popup.popupBottom <= report.popup.inputTop + 2);
    report.checks.push('wrapped link autocomplete appears beyond the resized label without overlap');
    await input.press('Escape');
    await input.fill('任务布局回归保存');
    await page.locator('.title-input').click();
    await page.waitForFunction(async () => { const db = await new Promise(resolve => { const r = indexedDB.open('bike-db'); r.onsuccess = () => resolve(r.result); }); try {
        return await new Promise(resolve => { const tx = db.transaction('workspace-store'), r = tx.objectStore('workspace-store').get('workspace'); tx.oncomplete = () => resolve(r.result.documents[0].nodes[0].children[0].text === '任务布局回归保存'); });
    }
    finally {
        db.close();
    } });
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await page.waitForTimeout(100);
    const undone = await input.inputValue();
    assert.notEqual(undone, '任务布局回归保存');
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-node-id="layout-task"] textarea').value === '任务布局回归保存');
    report.history = { undone, redone: await input.inputValue() };
    report.checks.push('business undo and redo preserve the task editor after wrapped-link editing');
    await page.waitForTimeout(700);
    const saved = await read();
    const savedTask = saved.documents[0].nodes[0].children[0];
    assert.equal(savedTask.checked, true);
    assert.equal(savedTask.text, '任务布局回归保存');
    await page.screenshot({ path: out + '/source-outline-task.png' });
    await page.reload();
    await checkbox.waitFor();
    assert.equal(await input.inputValue(), '任务布局回归保存');
    assert.equal(await checkbox.getAttribute('title'), '设为未完成');
    report.checks.push('checked state and final label survive actual IndexedDB reload');
    assert.deepEqual(errors, []);
    report.ok = true;
}
catch (e) {
    report.error = String(e);
    report.stack = e.stack;
    report.ok = false;
    throw e;
}
finally {
    await fs.writeFile(out + '/results.json', JSON.stringify(report, null, 2) + '\n');
    await browser.close();
    await server.close();
}
console.log(JSON.stringify({ ok: report.ok, checks: report.checks }));
