import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { _electron } = require('playwright');
const root = path.resolve(new URL('..', import.meta.url).pathname);
const executablePath = process.env.BIKE_ELECTRON_EXECUTABLE;
if (!executablePath) throw new Error('BIKE_ELECTRON_EXECUTABLE must point to the packaged app');
const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-renderer-measure-'));
const node = (id, extra = {}) => ({ id, text: `主题 ${id} 搜索标记`, note: '', checked: false, collapsed: false, color: 'plain', children: [], ...extra });
const document = (id, nodes) => ({ id, title: id, createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z', nodes });
const workspace = (documents) => ({ version: 1, activeDocumentId: documents[0].id, documents });
const app = await _electron.launch({ executablePath, args: ['--js-flags=--expose-gc'], env: { ...process.env, BIKE_TEST_USER_DATA: userData, VITE_DEV_SERVER_URL: '' } });
const results = { sample: { libraryDocuments: 100, libraryNodes: 20000, singleDocumentNodes: 20000, edits: 200, outline: 'large document children collapsed; root edited via UI' }, machine: os.cpus()[0]?.model, platform: process.platform, arch: process.arch, searches: {}, edits: [], memory: [], errors: [] };
const stats = (times) => { const sorted = [...times].sort((a, b) => a - b); return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maximumMs: sorted.at(-1) }; };
try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => results.errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.locator('.shell').waitFor();
  const cdp = await page.context().newCDPSession(page);
  const importWorkspace = async (payload) => {
    await page.locator('input[type=file]').setInputFiles({ name: 'performance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) });
    await page.getByRole('button', { name: payload.documents[0].title, exact: true }).waitFor();
  };
  const library = Array.from({ length: 100 }, (_, i) => document(`d${i}`, [node(`root${i}`, {
    collapsed: true, children: Array.from({ length: 199 }, (_, n) => node(`n${i}-${n}`)),
  })]));
  await importWorkspace(workspace(library));
  const search = page.getByPlaceholder('搜索文档、主题、备注');
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByTitle('切换到暗黑模式', { exact: true }).click();
    const times = [];
    for (let i = 0; i < 20; i++) {
      await search.fill('');
      await page.locator('.search-results').waitFor({ state: 'hidden' });
      const start = performance.now();
      await search.fill(i % 2 ? '搜索标记' : '主题');
      await page.locator('.search-hit').first().waitFor();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      times.push(performance.now() - start);
    }
    results.searches[theme] = { ...stats(times), timingsMs: times, includes: 'input fill, 180 ms debounce, search, first-page DOM and two animation frames; two alternating queries' };
    console.error(`Search ${theme} p95 ${stats(times).p95Ms.toFixed(1)} ms`);
  }
  await search.fill('');
  await page.locator('.search-results').waitFor({ state: 'hidden' });
  await importWorkspace(workspace([document('large', [node('root', { collapsed: true, children: Array.from({ length: 19999 }, (_, i) => node(`large-${i}`)) })])]));
  await page.locator('[data-node-id=root] textarea').waitFor();
  const sampleMemory = async (edit) => {
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const processes = await app.evaluate(({ app }) => app.getAppMetrics().filter((process) => process.type === 'Tab').map((process) => ({ pid: process.pid, memory: process.memory })));
    const history = await page.evaluate(() => {
      const container = document.querySelector('#root');
      const key = Object.keys(container).find((key) => key.startsWith('__reactContainer$'));
      const root = container[key].stateNode.current;
      const stack = [root];
      while (stack.length) {
        const fiber = stack.pop();
        if (!fiber) continue;
        let hook = fiber.memoizedState;
        while (hook && typeof hook === 'object') {
          const value = hook.memoizedState?.current;
          if (value && Array.isArray(value.past) && Array.isArray(value.future)) {
            const seen = new WeakSet(), objects = value.past.flatMap((entry) => entry.changes.flatMap((change) => [change.before, change.after]));
            let bytes = 0, count = 0;
            while (objects.length) {
              const item = objects.pop();
              if (!item || typeof item !== 'object' || seen.has(item)) continue;
              seen.add(item); count++;
              const entries = Object.entries(item); bytes += Array.isArray(item) ? 32 + entries.length * 8 : 32 + entries.length * 24;
              for (const [key, child] of entries) { if (!Array.isArray(item)) bytes += key.length * 2; if (typeof child === 'string') bytes += 24 + child.length * 2; else if (child && typeof child === 'object') objects.push(child); }
            }
            return { entries: value.past.length, estimatedBytes: bytes, retainedObjects: count };
          }
          hook = hook.next;
        }
        if (fiber.child) stack.push(fiber.child); if (fiber.sibling) stack.push(fiber.sibling);
      }
      return null;
    });
    results.memory.push({ edit, heap, processes, history });
  };
  await sampleMemory(0);
  const input = page.locator('[data-node-id=root] textarea');
  for (let i = 0; i < 200; i++) {
    const start = performance.now();
    await input.fill(`独立主题编辑 ${i}`);
    await input.press('Tab');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    results.edits.push(performance.now() - start);
    if ((i + 1) % 20 === 0) { await sampleMemory(i + 1); console.error(`Edits ${i + 1}, heap ${Math.round(results.memory.at(-1).heap.usedSize / 1024 / 1024)} MiB`); }
  }
  results.editStats = stats(results.edits);
  results.runtime = await app.evaluate(() => process.versions);
  assert.deepEqual(results.errors, []);
  assert.ok(results.memory.at(-1).history.entries > 0);
  assert.ok(results.memory.at(-1).history.estimatedBytes <= 64 * 1024 * 1024);
  console.log(JSON.stringify(results, null, 2));
  if (process.argv[2]) await fs.writeFile(process.argv[2], JSON.stringify(results, null, 2) + '\n');
} finally { await app.close(); await fs.rm(userData, { recursive: true, force: true }); }
