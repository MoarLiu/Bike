const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const settleAnimations = async () => {
  const running = document.getAnimations().filter(animation => {
    const timing = animation.effect?.getComputedTiming();
    return animation.playState === 'running' && timing && Number.isFinite(timing.endTime) && timing.endTime <= 2000;
  });
  await Promise.race([Promise.all(running.map(animation => animation.finished.catch(() => {}))), pause(800)]);
  await frame();
};
const waitFor = async (check, label, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > end) throw new Error('Timed out waiting for ' + label);
    await pause(30);
  }
};
const assert = (value, message) => { if (!value) throw new Error(message); };
const click = (label, root = document) => {
  const button = [...root.querySelectorAll('button')].find(element => element.textContent.trim() === label);
  assert(button && !button.disabled, 'Missing enabled button ' + label);
  button.click();
};
await waitFor(() => document.querySelector('.shell'), 'Bike shell');
const result = { mode, origin: location.origin, secure: isSecureContext, cspPolicy: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content };
const db = await new Promise((resolve, reject) => {
  const request = indexedDB.open('bike-db');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const read = () => new Promise((resolve, reject) => {
  const transaction = db.transaction('workspace-store', 'readonly');
  const request = transaction.objectStore('workspace-store').get('workspace');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
if (mode === 'seed') {
  const canvas = document.createElement('canvas');
  canvas.width = 48;
  canvas.height = 32;
  const context = canvas.getContext('2d');
  context.fillStyle = '#4466dd';
  context.fillRect(0, 0, 48, 32);
  context.fillStyle = '#ffbb33';
  context.fillRect(4, 4, 24, 24);
  const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const original = await png.arrayBuffer();
  const imported = await window.bike.importAttachments({ requestId: 'native-ui-image', files: [{ name: '原生图片 [1].png', bytes: original }] });
  assert(imported.ok && imported.assets.length === 1, imported.error || 'PNG native import failed');
  const asset = imported.assets[0];
  const node = (id, text, extra = {}) => ({ id, text, note: '', checked: false, collapsed: false, color: 'plain', children: [], ...extra });
  const link = '[[联调目标#图片主题]]';
  const note = '双链 ' + link + ' 与链接 https://example.org/report';
  const workspace = { version: 3, activeDocumentId: 'native-fidelity', documents: [
    { id: 'native-fidelity', title: '原生多格式验收', createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z',
      nodes: [node('fidelity-root', '原生验收 中文🙂', { note, bold: true, headingLevel: 1, children: [
        node('fidelity-table', '表格主题', { table: [['列一', '列二'], ['内容甲', '内容乙']] }),
        node('fidelity-code', '代码主题', { codeLanguage: 'javascript', codeBlock: ['const 中文 = "验证";', '', '  console.log(中文);'].join('\n') }),
        node('fidelity-task', '任务主题 #验收', { checked: true, isTodo: true }),
      ] })],
      knowledge: { version: 1, references: [{ id: 'native-reference', source: { kind: 'node-field', nodeId: 'fidelity-root', field: 'note', start: note.indexOf(link), end: note.indexOf(link) + link.length, raw: link }, target: { documentId: 'native-images', nodeId: 'image-root' }, labelMode: 'auto' }],
        relations: [{ id: 'native-relation', fromNodeId: 'fidelity-table', toNodeId: 'fidelity-code', label: '验证依赖' }] } },
    { id: 'native-images', title: '联调目标', createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z',
      attachments: { version: 1, items: { [asset.assetId]: asset.metadata } },
      nodes: [node('image-root', '图片主题', { note: '嵌图 PDF SVG PNG 验证', attachmentRefs: [{ assetId: asset.assetId, name: '原生图片 [1].png' }] })] },
  ] };
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('workspace-store', 'readwrite');
    const store = transaction.objectStore('workspace-store');
    store.clear();
    store.put(workspace, 'workspace');
    store.put({ revision: 100 }, 'workspace-meta');
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
  localStorage.setItem('theme', 'light');
  result.seeded = true;
  result.asset = asset;
  result.originalBase64 = btoa(String.fromCharCode(...new Uint8Array(original)));
} else if (mode !== 'cleanup') {
  const stored = await read();
  assert(stored.documents.length === 2, 'Acceptance fixture was not retained');
  const download = async (label, fromMenu = false) => {
    const at = (await window.mygo.call('Acceptance.Downloads')).length;
    if (fromMenu) { click('导出'); await waitFor(() => document.querySelector('[role=menu]'), 'export menu'); }
    click(label, fromMenu ? document.querySelector('[role=menu]') : document);
    let entry;
    await waitFor(async () => {
      entry = (await window.mygo.call('Acceptance.Downloads'))[at];
      if (entry?.error) throw new Error(entry.error);
      return entry?.completed && entry.bytes > 0;
    }, label + ' actual download', 60000);
    return { label, ...entry };
  };
  const chooseDocument = async (id, title) => {
    if ((await read()).activeDocumentId === id && document.querySelector('[data-node-id=' + (id === 'native-fidelity' ? 'fidelity-root' : 'image-root') + ']')) return;
    const heading = [...document.querySelectorAll('.document-list button')].find(element => element.textContent.includes(title));
    assert(heading, 'Document sidebar entry missing ' + title);
    heading.click();
    await waitFor(() => document.querySelector('[data-node-id=' + (id === 'native-fidelity' ? 'fidelity-root' : 'image-root') + ']'), 'selected document');
  };
  if (mode === 'text') {
    await chooseDocument('native-fidelity', '原生多格式验收');
    result.views = [];
    result.taskLayout = [];
    for (const theme of ['light', 'dark']) {
      if (document.documentElement.dataset.theme !== theme) {
        document.querySelector('button[title="' + (theme === 'dark' ? '切换到暗黑模式' : '切换到明亮模式') + '"]').click();
      }
      await waitFor(() => document.documentElement.dataset.theme === theme, 'theme ' + theme);
      for (const [width, height] of [[1366, 960], [1728, 1117]]) {
        await window.mygo.call('Acceptance.Resize', width, height);
        await pause(150);
        for (const [label, selector, name] of [['大纲', '.outline-list', 'outline'], ['脑图', 'svg.mindmap', 'mindmap'], ['演示', '.presentation-view', 'presentation'], ['Markdown', '.markdown-editor', 'markdown']]) {
          click(label);
          await waitFor(() => document.querySelector(selector), label);
          await frame();
          await pause(250);
          await settleAnimations();
          if (name === 'outline') {
            const row = document.querySelector('[data-node-id=fidelity-task]');
            const button = row.querySelector('.task-checkbox');
            const input = row.querySelector('.outline-text-cell textarea');
            const box = element => {
              const rect = element.getBoundingClientRect();
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
            };
            assert(button && input, 'Task controls missing');
            result.taskLayout.push({ theme, requestedWindow: [width, height], button: box(button), text: box(input), buttonClass: button.className });
          }
          if (name === 'markdown') {
            const rendered = document.querySelector('[aria-label="Markdown 源码"]')?.value ?? document.querySelector(selector).textContent;
            assert(rendered.includes('原生验收'), 'Markdown view lost fixture');
          }
          await window.mygo.call('Acceptance.Capture', `${theme}-${width}-${name}`);
          result.views.push({ theme, requestedWindow: [width, height], viewport: [innerWidth, innerHeight], devicePixelRatio,
            name, selector, screenshot: `${theme}-${width}-${name}.png`, scroll: [document.documentElement.scrollWidth, document.documentElement.clientWidth] });
        }
        click('大纲');
        click('导出');
        await waitFor(() => document.querySelector('[role=menu]'), 'menu');
        const menu = document.querySelector('[role=menu]');
        const bounds = menu.getBoundingClientRect();
        assert(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight, 'Export menu outside viewport');
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
        assert(document.activeElement.textContent.trim() === '工作区', 'Export menu End navigation failed');
        await settleAnimations();
        await window.mygo.call('Acceptance.Capture', `${theme}-${width}-menu`);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await waitFor(() => !document.querySelector('[role=menu]'), 'menu close');
        assert(document.activeElement.classList.contains('export-trigger'), 'Export menu focus not restored');
      }
    }
    click('大纲');
    const taskChecked = async () => (await read()).documents.find(item => item.id === 'native-fidelity').nodes[0].children.find(item => item.id === 'fidelity-task').checked;
    assert(await taskChecked() === true, 'Initial task state missing');
    document.querySelector('[data-node-id=fidelity-task] .task-checkbox').click();
    await waitFor(async () => await taskChecked() === false, 'persisted task uncheck');
    document.querySelector('[data-node-id=fidelity-task] .task-checkbox').click();
    await waitFor(async () => await taskChecked() === true, 'persisted task recheck');
    result.taskTogglePersisted = true;
    result.exports = [];
    for (const label of ['导出 MD', '带元数据', 'OPML', 'FreeMind', 'HTML', 'PDF', '工作区']) result.exports.push(await download(label, true));
    click('脑图');
    await waitFor(() => document.querySelector('svg.mindmap'), 'mindmap export');
    for (const label of ['SVG', 'PNG', '透明 PNG']) result.exports.push(await download(label));
    result.relationPaths = document.querySelectorAll('.mindmap .mindmap-relation').length;
    assert(result.relationPaths === 1, 'Mindmap relation path missing');
    result.caretAndUndo = 'Covered by separate native keyboard acceptance, not repeated here';
  } else {
    click('大纲');
    await chooseDocument('native-images', '联调目标');
    await waitFor(() => document.querySelector('.attachment-thumbnail img')?.complete, 'stored image preview');
    if (mode === 'images') {
      result.exports = [await download('PDF', true)];
      click('脑图');
      await waitFor(() => document.querySelector('svg.mindmap .attachment-thumbnail img')?.complete, 'mindmap stored image');
      result.exports.push(await download('SVG'), await download('PNG'), await download('透明 PNG'));
    } else {
      result.before = await read();
      click('导出');
      await waitFor(() => document.querySelector('[role=menu]'), 'portable export menu');
      click(mode === 'portable-html' ? 'HTML' : '带元数据', document.querySelector('[role=menu]'));
      await waitFor(() => document.body.textContent.includes('已导出携图 ZIP'), 'normal portable archive save', 180000);
      result.portableExportNotice = [...document.querySelectorAll('[role=status], .notice')].map(element => element.textContent);
      result.after = await read();
    }
  }
}
db.close();
await pause(100);
result.errors = window.__uiErrors;
result.csp = window.__uiCSP;
assert(result.errors.length === 0, JSON.stringify(result.errors));
assert(result.csp.length === 0, JSON.stringify(result.csp));
return JSON.stringify(result);
