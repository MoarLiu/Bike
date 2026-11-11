const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const wait = async (check, label, timeout = 20000) => {
  const start = performance.now();
  while (!await check()) {
    if (performance.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await pause(20);
  }
};
const checkpoint = (value) => window.mygo.call('Layout.Checkpoint', value);
const result = { configuration: config, timings: [], revisions: [], errors: [], scrollHeightReads: [] };
let database;
const open = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('bike-db');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const get = (key) => new Promise((resolve, reject) => {
  const request = database.transaction('workspace-store').objectStore('workspace-store').get(key);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const value = (input, text) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const geometry = () => [...document.querySelectorAll('.outline-row')].map((row) => {
  const rect = row.getBoundingClientRect();
  const textarea = row.querySelector('textarea').getBoundingClientRect();
  return { id: row.dataset.nodeId, row: [rect.x, rect.y, rect.width, rect.height], textarea: [textarea.x, textarea.y, textarea.width, textarea.height] };
});
try {
  await wait(() => document.querySelector('.shell') && document.querySelector('.outline-list'), 'outline application');
  await frame();
  database = await open();
  if (config.mode === 'seed') {
    const node = (id, children = []) => ({ id, text: `主题 ${id} 搜索标记`, note: '固定样本备注', checked: false, color: 'plain', collapsed: children.length > 0, children });
    const stamp = '2026-11-11T00:00:00.000Z';
    const workspace = { version: 1, activeDocumentId: 'layout-large', documents: [{ id: 'layout-large', title: '原生大纲布局验收', createdAt: stamp, updatedAt: stamp, nodes: [node('layout-root', Array.from({ length: config.count - 1 }, (_, i) => node(`layout-${i}`)))] }] };
    await new Promise((resolve, reject) => {
      const tx = database.transaction('workspace-store', 'readwrite');
      tx.objectStore('workspace-store').clear();
      tx.objectStore('workspace-store').put(workspace, 'workspace');
      tx.objectStore('workspace-store').put({ revision: 100 }, 'workspace-meta');
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    localStorage.clear();
    result.seeded = true;
    return result;
  }
  if (config.mode === 'verify') {
    const workspace = await get('workspace');
    result.meta = await get('workspace-meta');
    result.text = workspace.documents[0].nodes[0].text;
    result.topics = 1 + workspace.documents[0].nodes[0].children.length;
    result.ok = result.text === `原生布局独立编辑 ${config.edits - 1} 中文🙂` && result.topics === config.count;
    return result;
  }
  if (config.css === 'block') {
    const override = document.createElement('style');
    override.textContent = '.outline-list { display: block; }';
    document.head.append(override);
  }
  await document.fonts.ready;
  await pause(300);
  const started = performance.now();
  if (config.expanded) document.querySelector('[data-node-id="layout-root"] .disclosure').click();
  await wait(() => document.querySelectorAll('.outline-row').length === (config.expanded ? config.count : 1), 'mounted rows', 60000);
  await frame();
  result.mountMs = performance.now() - started;
  result.mountedRows = document.querySelectorAll('.outline-row').length;
  result.listDisplay = getComputedStyle(document.querySelector('.outline-list')).display;
  result.geometry = geometry();
  await checkpoint({ phase: 'mounted', mountMs: result.mountMs, rows: result.mountedRows, listDisplay: result.listDisplay });
  let revision = (await get('workspace-meta')).revision;
  result.initialRevision = revision;
  result.documentFocused = document.hasFocus();
  result.visibilityState = document.visibilityState;
  for (let index = 0; index < config.edits; index++) {
    const input = document.querySelector('[data-node-id="layout-root"] textarea');
    const text = `原生布局独立编辑 ${index} 中文🙂`;
    const start = performance.now();
    await checkpoint({ phase: 'before-input', index, revision });
    input.focus();
    if (document.activeElement !== input) throw new Error('Outline input did not receive DOM focus');
    value(input, text);
    await frame();
    input.blur();
    await wait(async () => (await get('workspace-meta')).revision > revision, `persisted revision ${index}`);
    const workspace = await get('workspace');
    if (workspace.documents[0].nodes[0].text !== text) throw new Error('Persisted text mismatch');
    revision = (await get('workspace-meta')).revision;
    result.revisions.push(revision);
    await frame();
    result.timings.push(performance.now() - start);
    await checkpoint({ phase: 'saved', index, revision, elapsedMs: result.timings.at(-1) });
  }
  result.finalRevision = revision;
  result.finalGeometry = geometry();
  await window.mygo.call('Layout.Capture');
  const sorted = [...result.timings].sort((a, b) => a - b);
  result.editP95Ms = sorted[Math.ceil(sorted.length * .95) - 1];
  result.ok = result.revisions.length === config.edits && revision >= result.initialRevision + config.edits;
} catch (error) {
  result.ok = false;
  result.error = String(error);
  result.stack = error?.stack;
} finally {
  database?.close();
}
return result;
