const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const waitFor = async (check, label) => {
  const deadline = Date.now() + 15000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label);
    await pause(25);
  }
};
await waitFor(() => document.querySelector('.shell'), 'Bike shell');
const result = { mode, url: location.href, origin: location.origin, secure: isSecureContext,
  bridge: await window.mygo.call('Probe.Echo', { text: '中文🙂', number: 42 }), session: 'default',
  production: await window.mygo.call('Probe.Production'),
  cspPolicy: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null,
};
if (mode.startsWith('isolate')) {
  await pause(500);
  return JSON.stringify({ ...result, errors: window.__probeErrors, csp: window.__probeCSP });
}
const open = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('bike-db');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const database = await open();
const read = () => new Promise((resolve, reject) => {
  const transaction = database.transaction('workspace-store', 'readonly');
  const request = transaction.objectStore('workspace-store').get('workspace');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const unicodeExtension = { z: String.fromCharCode(0xd800), a: ['tail' + String.fromCharCode(0xdc00), '中文🙂'] };
const assertUnicode = (workspace, label) => {
  if (JSON.stringify(workspace.documents[0].runtimeExtension) !== JSON.stringify(unicodeExtension)) {
    throw new Error(label + ' changed isolated UTF-16 or extension property order');
  }
};
if (mode === 'seed') {
  const node = (id, text, children = []) => ({ id, text, note: '中文备注', checked: false, collapsed: false, color: 'plain', children });
  const workspace = { version: 3, activeDocumentId: 'm0-document', documents: [{
    id: 'm0-document', title: 'MyGO 原生桥测试', createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z',
    runtimeExtension: unicodeExtension,
    nodes: [node('m0-root', '中文🙂 根主题', [node('m0-child', '子主题'), node('m0-task', '待办')])],
  }] };
  await new Promise((resolve, reject) => {
    const transaction = database.transaction('workspace-store', 'readwrite');
    const store = transaction.objectStore('workspace-store');
    store.clear();
    store.put(workspace, 'workspace');
    store.put({ revision: 100 }, 'workspace-meta');
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
  localStorage.setItem('bike-mygo-m0-test', 'persisted');
  result.seeded = true;
} else {
  result.marker = localStorage.getItem('bike-mygo-m0-test');
  result.workspace = await read();
  assertUnicode(result.workspace, 'Saved workspace');
  result.savedUnicode = true;
  result.rendered = Boolean(document.querySelector('[data-node-id=m0-root]'));
}
if (mode === 'ui') {
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const click = (label) => {
    const button = [...document.querySelectorAll('button')].find((element) => element.textContent.trim() === label);
    if (!button) throw new Error('Missing button ' + label);
    button.click();
  };
  result.views = [];
  for (const [label, selector, name] of [['大纲', '.outline-list', 'outline'], ['脑图', 'svg.mindmap', 'mindmap'], ['演示', '.presentation-view', 'presentation'], ['Markdown', '.markdown-editor', 'markdown']]) {
    click(label);
    await waitFor(() => document.querySelector(selector), label);
    await frame();
    await window.mygo.call('Probe.Capture', name);
    result.views.push({ name, rendered: true });
  }
  click('大纲');
  await frame();
  const input = document.querySelector('[data-node-id=m0-root] textarea');
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'WKWebView 原生桥编辑持久化验证');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.blur();
  await waitFor(async () => (await read()).documents[0].nodes[0].text === 'WKWebView 原生桥编辑持久化验证', 'committed edit');
  result.editPersisted = true;
  result.bridgeMembers = Object.keys(window.bike).length;
  if (result.bridgeMembers !== 36) throw new Error('Desktop bridge coverage differs');
  const original = new TextEncoder().encode('native attachment 中文🙂');
  const imported = await window.bike.importAttachments({ requestId: 'runtime-attachment', files: [{ name: 'fixture.txt', bytes: original.buffer }] });
  if (!imported.ok || imported.assets.length !== 1) throw new Error(imported.error || 'Native attachment failed');
  result.attachment = imported.assets[0];
  if ('width' in result.attachment.metadata || 'height' in result.attachment.metadata) throw new Error('Non-image metadata acquired dimensions');
  const scan = await window.bike.scanAttachments([result.attachment.assetId]);
  if (!scan.ok || scan.candidates.length) throw new Error('Attachment protection failed');
  result.attachmentProtected = true;
  let progressCount = 0;
  const removeProgress = window.bike.onAttachmentSyncProgress(() => progressCount++);
  await window.mygo.call('Probe.Progress');
  await waitFor(() => progressCount === 1, 'native progress event');
  removeProgress();
  await window.mygo.call('Probe.Progress');
  await pause(50);
  if (progressCount !== 1) throw new Error('Unsubscribed native event repeated');
  result.unsubscribe = true;
  const current = await read();
  const meta = await new Promise((resolve, reject) => { const transaction = database.transaction('workspace-store', 'readonly'); const request = transaction.objectStore('workspace-store').get('workspace-meta'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const backup = await window.bike.enqueueBackup({ workspace: current, sourceRevision: meta.revision, semanticHash: 'runtime-fixture', manual: true, wait: true });
  if (!backup.ok) throw new Error(backup.error || 'Native backup failed');
  const loaded = await window.bike.loadICloudBackup();
  if (!loaded.ok || loaded.payload.documents[0].nodes[0].text !== current.documents[0].nodes[0].text) throw new Error('Native backup readback failed');
  assertUnicode(loaded.payload, 'Native backup');
  result.backupRoundTrip = true;
  result.backupUnicode = true;
  const fixtureURL = await window.mygo.call('Probe.FixtureURL');
  const aiConfig = { baseUrl: fixtureURL + '/v1', endpoint: 'chat_completions', apiKey: 'fixture-key' };
  localStorage.setItem('bike-ai-config', JSON.stringify(aiConfig));
  const ai = await window.bike.invokeAiProvider({ ...aiConfig, requestId: 'runtime-ai', body: { model: 'fixture' } });
  if (!ai.ok || ai.data.choices[0].message.content !== 'fixture 中文🙂') throw new Error(ai.error || 'AI proxy failed');
  const mismatch = await window.bike.invokeAiProvider({ ...aiConfig, baseUrl: fixtureURL + '/other', requestId: 'runtime-forbidden', body: {} });
  if (mismatch.ok) throw new Error('Unconfigured AI endpoint accepted');
  result.aiProxy = true;
  const slowConfig = { baseUrl: fixtureURL + '/slow', endpoint: 'responses', apiKey: 'fixture-key' };
  localStorage.setItem('bike-ai-config', JSON.stringify(slowConfig));
  const pending = window.bike.invokeAiProvider({ ...slowConfig, requestId: 'runtime-cancel', body: {} });
  await pause(100);
  await window.bike.cancelAiRequest('runtime-cancel');
  if ((await pending).ok) throw new Error('Canceled AI request succeeded');
  result.aiCancellation = true;
  localStorage.setItem('bike-sync-config', JSON.stringify({ serverUrl: fixtureURL, token: 'fixture-key' }));
  const sync = await window.bike.invokeSyncRequest({ serverUrl: fixtureURL, token: 'fixture-key', pathname: '/api/v2/status' });
  if (!sync.ok || sync.data.fixture !== true) throw new Error(sync.error || 'Sync proxy failed');
  result.syncProxy = true;
  const liveTool = async (operation, arguments = {}) => JSON.parse(await window.mygo.call('Probe.LiveTool', operation, JSON.stringify(arguments)));
  const live = await window.bike.startLiveMcp({ scope: 'document', documentIds: ['m0-document'], writable: true });
  if (!live.enabled) throw new Error('Native Live MCP did not start');
  const liveSnapshot = await liveTool('snapshot');
  if (liveSnapshot.workspace.documents[0].nodes[0].text !== current.documents[0].nodes[0].text) throw new Error('Live snapshot bypassed saved data');
  assertUnicode(liveSnapshot.workspace, 'Live snapshot');
  result.liveSnapshot = true;
  const note = 'Live native payload ' + String.fromCharCode(0xd800) + ' / ' + String.fromCharCode(0xdc00);
  const preview = await liveTool('update_node', {
    documentId: 'm0-document', nodeId: 'm0-root', note, expectedRevision: liveSnapshot.revision, dryRun: true,
    writeTimestamp: '2026-11-11T00:00:01.000Z', reason: 'Native renderer UTF-16 approval verification',
  });
  if (preview.status !== 'preview' || document.querySelector('.proposal-dialog') || (await read()).documents[0].nodes[0].note === note) throw new Error('Live dry-run changed saved state');
  if (preview.proposal.groups[0].summary.find((change) => change.field === 'note')?.after?.value !== note) throw new Error('Native Live preview changed isolated UTF-16 payload');
  const proposalPending = await liveTool('update_node', preview.confirmationArgs);
  if (proposalPending.status !== 'pending') throw new Error('Live proposal was not queued');
  await waitFor(() => document.querySelector('.proposal-dialog'), 'native Live proposal dialog');
  const status = () => liveTool('status', { requestId: preview.requestId });
  if ((await status()).status !== 'pending') throw new Error('Live pending status missing');
  const replay = await liveTool('update_node', preview.confirmationArgs);
  if (replay.status !== 'pending' || document.querySelectorAll('.proposal-dialog').length !== 1) throw new Error('Pending Live retry duplicated proposal');
  let changedPayloadRejected = false;
  try { await liveTool('update_node', { ...preview.confirmationArgs, note: note + 'different' }); }
  catch (error) { changedPayloadRejected = String(error).includes('相同请求身份'); }
  if (!changedPayloadRejected) throw new Error('Live request identity accepted changed payload');
  click('应用所选修改');
  await waitFor(async () => (await status()).status === 'committed', 'native Live approved receipt');
  const committed = await status();
  if (!committed.operationId || committed.applied !== true || (await read()).documents[0].nodes[0].note !== note) throw new Error('Approved native Live change did not persist');
  assertUnicode(await read(), 'Approved Live workspace');
  const committedReplay = await liveTool('update_node', preview.confirmationArgs);
  if (committedReplay.status !== 'committed' || committedReplay.operationId !== committed.operationId) throw new Error('Committed Live retry changed receipt');
  await waitFor(() => !document.querySelector('.proposal-dialog'), 'approved proposal dismissal');
  const nextSnapshot = await liveTool('snapshot');
  const rejectedPreview = await liveTool('update_node', {
    documentId: 'm0-document', nodeId: 'm0-root', note: 'must remain rejected', expectedRevision: nextSnapshot.revision, dryRun: true,
    writeTimestamp: '2026-11-11T00:00:02.000Z', reason: 'Native renderer rejection verification',
  });
  await liveTool('update_node', rejectedPreview.confirmationArgs);
  await waitFor(() => document.querySelector('.proposal-dialog'), 'rejectable native Live proposal');
  click('拒绝提案');
  await waitFor(async () => (await liveTool('status', { requestId: rejectedPreview.requestId })).status === 'rejected', 'native Live rejected status');
  const rejectedReplay = await liveTool('update_node', rejectedPreview.confirmationArgs);
  if (rejectedReplay.status !== 'rejected' || (await read()).documents[0].nodes[0].note !== note) throw new Error('Rejected Live retry changed saved state');
  result.liveWorkflow = { dryRun: true, pending: true, approved: true, rejected: true, status: true, pendingReplay: true, committedReplay: true, rejectedReplay: true, changedPayloadRejected };
  result.liveUnicode = true;
  await window.bike.stopLiveMcp();
  document.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' }));
  if (await window.mygo.call('Probe.CloseBarrier')) throw new Error('Close barrier accepted composition');
  document.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
  if (!await window.mygo.call('Probe.CloseBarrier')) throw new Error('Close barrier failed after save');
  await waitFor(() => !document.querySelector('.shell').inert, 'released close test lock');
  result.closeBarrier = true;
  click('导出');
  await frame();
  click('导出 MD');
  await waitFor(async () => (await window.mygo.call('Probe.Downloads')).some((name) => name.endsWith('.md')), 'Markdown download');
  result.downloads = await window.mygo.call('Probe.Downloads');
}
database.close();
await pause(200);
return JSON.stringify({ ...result, errors: window.__probeErrors, csp: window.__probeCSP });
