// Both hosts evaluate this exact async function body in their production UI.
const stamp = '2026-11-11T00:00:00.000Z';
const topic = (id, children = [], collapsed = false) => ({ id, text: `主题 ${id} 搜索标记`, note: '固定样本备注', checked: false, collapsed, color: 'plain', children });
const makeDocument = (id, count) => ({ id, title: id, createdAt: stamp, updatedAt: stamp, nodes: [topic(`${id}-root`, Array.from({ length: count - 1 }, (_, i) => topic(`${id}-${i}`)), config.action === 'seed' || !config.expanded)] });
const isPeak = ['proposal-peak', 'attachment-peak'].includes(config.scenario);
const fixture = isPeak ? { version: 3, activeDocumentId: 'perf-peak', documents: [makeDocument('perf-peak', 1)] } : { version: config.workspaceVersion ?? 1, activeDocumentId: config.scenario === 'library' ? 'perf-d0' : 'perf-large', documents: config.scenario === 'library' ? Array.from({ length: 100 }, (_, i) => makeDocument(`perf-d${i}`, 200)) : [makeDocument('perf-large', 20000)] };
if (config.action === 'fixture') return fixture;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const waitFor = async (check, label, timeout = config.operationTimeoutMs ?? 20000) => {
  const start = performance.now();
  while (!await check()) {
    if (performance.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await pause(20);
  }
};
const statistics = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maximumMs: sorted.at(-1) };
};
const sample = (label) => globalThis.__performanceSample ? globalThis.__performanceSample(label) : window.mygo.call('Performance.Sample', label);
const checkpoint = (value) => globalThis.__performanceCheckpoint ? globalThis.__performanceCheckpoint(value) : window.mygo.call('Performance.Checkpoint', value);
const result = { action: config.action, scenario: config.scenario, expanded: Boolean(config.expanded), view: config.view ?? 'outline', url: location.href, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, visibilityState: document.visibilityState, documentHasFocusAtStart: document.hasFocus(), errors: window.__performanceErrors ?? [], memory: [], edits: [], committedRevisions: [], search: {} };
let database;
let restoreLayoutProbe;
let layoutReads;
const open = () => new Promise((resolve, reject) => { const request = indexedDB.open('bike-db'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const get = (key) => new Promise((resolve, reject) => { const transaction = database.transaction('workspace-store', 'readonly'); const request = transaction.objectStore('workspace-store').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const savedPair = () => new Promise((resolve, reject) => {
  const transaction = database.transaction('workspace-store', 'readonly');
  const store = transaction.objectStore('workspace-store');
  const workspace = store.get('workspace');
  const meta = store.get('workspace-meta');
  transaction.oncomplete = () => resolve({ workspace: workspace.result, meta: meta.result });
  transaction.onabort = () => reject(transaction.error);
});
const click = (label) => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === label); if (!button) throw new Error(`Missing button ${label}`); button.click(); };
const setValue = (input, value) => { const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); };
try {
  await waitFor(() => document.querySelector('.shell') && document.querySelector('.outline-list'), 'loaded outline');
  await frame();
  result.navigationToReadyMs = performance.now();
  if (config.action === 'startup') { result.memory.push(await sample('startup-ready')); return result; }
  database = await open();
  if (config.action === 'seed') {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('workspace-store', 'readwrite');
      const store = transaction.objectStore('workspace-store');
      store.clear(); store.put(fixture, 'workspace'); store.put({ revision: 100 }, 'workspace-meta');
      transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
    });
    localStorage.clear();
    result.fixture = { documents: fixture.documents.length, topics: isPeak ? 1 : 20000, utf8Bytes: new TextEncoder().encode(JSON.stringify(fixture)).length, revision: 100 };
    return result;
  }
  if (config.action === 'cleanup') {
    database.close(); database = null;
    localStorage.clear();
    await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('bike-db'); request.onsuccess = resolve; request.onerror = () => reject(request.error); request.onblocked = resolve; });
    return { ...result, cleaned: true };
  }
  const loaded = await get('workspace');
  if (loaded.documents.length !== fixture.documents.length || loaded.activeDocumentId !== fixture.activeDocumentId) throw new Error('Fixture did not survive process restart');
  result.initialRevision = (await get('workspace-meta')).revision;
  if (isPeak) {
    Object.assign(result, await runPeak(config, { sample, checkpoint, waitFor, frame, click, get, database }));
    result.ok = result.errors.length === 0;
    await checkpoint(result);
    return result;
  }
  await pause(1000);
  result.memory.push(await sample('idle-before'));
  await pause(config.idleMs ?? 2000);
  result.memory.push(await sample('idle-after'));
  if (config.scenario === 'library') {
    const input = [...document.querySelectorAll('input')].find((item) => item.placeholder === '搜索文档、主题、备注');
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') document.querySelector('button[title=切换到暗黑模式]').click();
      const times = [];
      for (let i = 0; i < 20; i++) {
        setValue(input, '');
        await waitFor(() => !document.querySelector('.search-results'), 'search clear');
        const query = i % 2 ? '搜索标记' : '主题';
        const start = performance.now();
        setValue(input, query);
        await waitFor(() => [...document.querySelectorAll('.search-hit mark')].some((mark) => mark.textContent === query), 'matching search DOM');
        await frame(); times.push(performance.now() - start);
      }
      result.search[theme] = { ...statistics(times), timingsMs: times, includes: 'same DOM input event, debounce, matching result DOM, two animation frames' };
      await checkpoint(result);
    }
    result.memory.push(await sample('search-complete'));
  } else {
    const rootId = 'perf-large-root';
    const expectedNodes = config.expanded ? 20000 : 1;
    const rootSelector = `[data-node-id=${rootId}]`;
    const renderStart = performance.now();
    if (config.view === 'mindmap') click('脑图');
    await frame();
    await checkpoint({ ...result, phase: 'before-view-expansion' });
    if (config.expanded) {
      if (config.view === 'mindmap') {
        document.querySelector(`svg.mindmap ${rootSelector}`).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
        await frame();
        const expansion = [...document.querySelectorAll('button')].find((button) => button.querySelector('span')?.textContent === '展开下级主题');
        if (!expansion) throw new Error('Mind map expansion menu missing');
        expansion.click();
      } else {
        document.querySelector(`${rootSelector} .disclosure`).click();
      }
    }
    const countNodes = () => document.querySelectorAll(config.view === 'mindmap' ? 'svg.mindmap .map-node-object' : '.outline-list .outline-row').length;
    const expectedDOM = expectedNodes + (config.view === 'mindmap' ? 1 : 0);
    await waitFor(() => countNodes() === expectedDOM, `all ${expectedDOM} mounted ${config.view} nodes`, config.renderTimeoutMs ?? 90000);
    await frame();
    result.render = { navigationToReadyMs: result.navigationToReadyMs, switchAndPaintMs: performance.now() - renderStart, mountedNodes: countNodes(), expectedNodes: expectedDOM, semantics: 'all expanded data mounted and laid out, viewport painted through two animation frames' };
    result.memory.push(await sample('view-ready'));
    await checkpoint(result);
    let previousRevision = (await get('workspace-meta')).revision;
    result.initialEditRevision = previousRevision;
    if (config.profilePhases) {
      result.editPhases = [];
      result.profiling = 'diagnostic phase timings and textarea scrollHeight getter observation; getter instrumentation perturbs timing';
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
      if (descriptor?.configurable && descriptor.get) {
        Object.defineProperty(Element.prototype, 'scrollHeight', { ...descriptor, get() {
          const started = performance.now();
          const value = descriptor.get.call(this);
          if (layoutReads && this instanceof HTMLTextAreaElement) {
            const elapsed = performance.now() - started;
            layoutReads.count++;
            layoutReads.totalMs += elapsed;
            layoutReads.maximumMs = Math.max(layoutReads.maximumMs, elapsed);
          }
          return value;
        } });
        restoreLayoutProbe = () => Object.defineProperty(Element.prototype, 'scrollHeight', descriptor);
      }
    }
    for (let i = 0; i < (config.edits ?? 50); i++) {
      const start = performance.now();
      const phases = {};
      let phaseStart = start;
      const phase = (name) => {
        if (!config.profilePhases) return;
        const now = performance.now();
        phases[name] = now - phaseStart;
        phaseStart = now;
      };
      if (config.profilePhases) layoutReads = { count: 0, totalMs: 0, maximumMs: 0 };
      if (config.view === 'mindmap') { document.querySelector(`svg.mindmap ${rootSelector}`).dispatchEvent(new MouseEvent('click', { bubbles: true })); await frame(); }
      const input = document.querySelector(`${rootSelector} textarea`);
      if (!input) throw new Error('DOM editing textarea missing');
      const text = `独立主题编辑 ${config.view} ${i}`;
      result.pendingPersistence = { edit: i + 1, expectedText: text, previousRevision };
      input.focus();
      phase('focusMs');
      setValue(input, text);
      phase('inputDispatchMs');
      await frame();
      phase('draftFramesMs');
      input.blur();
      phase('blurDispatchMs');
      let saved;
      let observedRevision = previousRevision;
      await waitFor(async () => {
        if ((await get('workspace-meta')).revision <= observedRevision) return false;
        saved = await savedPair();
        observedRevision = saved.meta?.revision ?? observedRevision;
        result.pendingPersistence.observedRevision = observedRevision;
        result.pendingPersistence.observedText = saved.workspace?.documents[0]?.nodes[0]?.text;
        return saved.meta?.revision > previousRevision && saved.workspace?.documents[0]?.nodes[0]?.text === text;
      }, `matching persisted revision and text for edit ${i + 1}`);
      previousRevision = saved.meta.revision;
      phase('persistenceMs');
      delete result.pendingPersistence;
      result.committedRevisions.push(previousRevision);
      await frame();
      phase('savedFramesMs');
      result.edits.push(performance.now() - start);
      if (config.profilePhases) result.editPhases.push({ edit: i + 1, ...phases, layoutReads: { ...layoutReads } });
      if ((i + 1) % 20 === 0 || i + 1 === (config.edits ?? 50)) { result.memory.push(await sample(`edit-${i + 1}`)); await checkpoint(result); }
    }
    result.editStats = { ...statistics(result.edits), includes: 'synthetic input/focus/blur, autosave delay, persisted revision and saved-text readback, two animation frames' };
    result.finalRevision = previousRevision;
    result.persistenceReadback = 'workspace and revision from one completed readonly IndexedDB transaction, both matching before the next edit';
    result.commitVerified = result.edits.length === (config.edits ?? 50) && result.committedRevisions.every((revision, index) => revision > (index ? result.committedRevisions[index - 1] : result.initialEditRevision)) && previousRevision >= result.initialEditRevision + result.edits.length;
  }
  result.ok = result.errors.length === 0;
} catch (error) {
  result.ok = false; result.error = String(error); result.stack = error?.stack;
  result.failureDOM = { shell: Boolean(document.querySelector('.shell')), outlineRows: document.querySelectorAll('.outline-row').length, bodyText: document.body.innerText.slice(0, 3000) };
  result.editStats = statistics(result.edits);
  try { result.memory.push(await sample('failure')); } catch (sampleError) { result.sampleError = String(sampleError); }
} finally {
  restoreLayoutProbe?.();
  result.documentHasFocusAtEnd = document.hasFocus();
  result.visibilityStateAtEnd = document.visibilityState;
  database?.close();
}
await checkpoint(result);
return result;
