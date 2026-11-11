const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const waitFor = async (check, label) => {
  const deadline = Date.now() + 60000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label);
    await pause(30);
  }
};
const require = (condition, label) => { if (!condition) throw new Error(label); };
const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const click = (label, container = document) => {
  const button = [...container.querySelectorAll('button')].find((element) => element.textContent.trim() === label);
  require(button && !button.disabled, 'Missing enabled button ' + label);
  button.click();
};
const openDB = (name, storeName) => new Promise((resolve, reject) => {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(storeName);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const readStore = async (name, storeName) => {
  const db = await openDB(name, storeName);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const keys = store.getAllKeys(), values = store.getAll();
      tx.oncomplete = () => resolve(Object.fromEntries(keys.result.map((key, index) => [key, values.result[index]])));
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
};
const writeStore = async (name, storeName, values, clear = false) => {
  const db = await openDB(name, storeName);
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      if (clear) store.clear();
      for (const [key, value] of Object.entries(values)) store.put(value, key);
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
};
const mainStore = () => readStore('bike-db', 'workspace-store');
const historyStore = () => readStore('bike-history-db', 'snapshots');
const fixture = JSON.parse(await window.mygo.call('Migration.Fixture'));
const keys = fixture.keys;
const result = { mode, origin: location.origin, production: await window.mygo.call('Migration.Production'), checks: {} };
const capture = async (name) => {
  await frame();
  await pause(300);
  await window.mygo.call('Migration.Capture', name);
};
const installFileSelection = () => {
  // The diagnostic substitutes only the two file-dialog boundaries. The normal
  // UI still performs preview, backup, journal, history and atomic installation.
  window.bike.importWorkspaceArchive = async () => {
    const { workspaceJSON, ...value } = JSON.parse(await window.mygo.call('Migration.ImportFixture'));
    return { ...value, workspace: JSON.parse(workspaceJSON) };
  };
  window.bike.exportWorkspaceArchive = async (workspace) =>
    JSON.parse(await window.mygo.call('Migration.ExportCurrent', JSON.stringify(workspace)));
};
const assertInstalled = async () => {
  const state = await mainStore(), history = await historyStore();
  const workspace = state.workspace, replica = state[keys.replica], archives = state[keys.archives];
  require(JSON.stringify(workspace) === JSON.stringify(fixture.body), 'Imported body differs from the source');
  require(!('localMigration' in workspace), 'Private source archive leaked into the live body');
  require(replica.actorId && replica.actorId !== fixture.sourceActor && replica.actorId !== fixture.destinationActor, 'Replica identity was copied');
  require(replica.cursor === 0 && replica.remote === null && replica.remoteId === null, 'Imported replica acquired a remote baseline');
  for (const field of ['outbox', 'audit', 'conflicts']) require(replica[field].length === 0, 'Source ' + field + ' became active');
  require(Object.keys(replica.receipts).length === 0, 'Source receipts became active');
  require(archives.length === 1 && archives[0].id === fixture.copyId, 'Private source archive missing');
  const archive = archives[0];
  require(archive.sourceAudit.outbox[0].id === 'source-unsent', 'Unsent source operation was lost');
  require(archive.sourceAudit.audit[0].id === 'source-audit', 'Source audit was lost');
  require(archive.sourceAudit.receipts['source-request'].status === 'committed', 'Source receipt was lost');
  require(archive.sourceAudit.conflicts[0].id === 'source-conflict', 'Source conflict was lost');
  require(archive.archives[0].id === 'older-native-copy', 'Prior private source archive was lost');
  require(archive.preAttachment.documents[0].title === '源附件升级前副本', 'Pre-attachment backup was lost');
  require(archive.preOperation.documents[0].title === '源操作升级前副本', 'Pre-operation backup was lost');
  require(archive.recovery[0].workspace.documents[0].title === fixture.recoveryTitle, 'Source recovery body was lost');
  require(archive.recoveryFiles[0].content.includes(fixture.recoveryTitle), 'Source raw recovery file was lost');
  require(!('credentials' in archive) && !('preferences' in archive), 'Private source retained opt-in secrets or preferences');
  require(history['document:' + fixture.documentId].some((snapshot) => snapshot.id === fixture.historyId), 'Active-document imported history was lost');
  require(history['document:orphan-native'].some((snapshot) => snapshot.id === fixture.orphanHistoryId), 'Orphan imported history was lost');
  require(state[keys.journal] === null && history[keys.historyJournal] == null, 'Completed import left a journal lock');
  require(state[keys.receipts][fixture.copyId]?.sessionId, 'Import completion receipt missing');
  const sync = JSON.parse(localStorage.getItem('bike-sync-config'));
  require(sync.autoSync === false && sync.token === '', 'Synchronization remained enabled');
  require(localStorage.getItem('bike-local-copy-offline') === '1', 'Offline guard missing');
  require(localStorage.getItem('theme') === 'light', 'Unselected theme was imported');
  require(JSON.parse(localStorage.getItem('bike-ai-config')).model === 'destination-model', 'Unselected AI preferences changed');
  const backup = await window.bike.getBackupStatus();
  require(backup.auto === false, 'Automatic backup remained enabled');
  for (const asset of fixture.assets) {
    const original = await window.bike.readAttachment(asset.assetId, false);
    require(original.ok && original.metadata.byteLength === asset.metadata.byteLength, 'Historical original cannot be read');
  }
  return { state, history, actor: replica.actorId };
};
try {
  if (mode === 'cleanup') return JSON.stringify({ ...result, checks: { cleanup: true } });
  await waitFor(() => document.querySelector('.shell'), 'Bike shell');
  require(location.origin === 'mygo://localhost', 'Unexpected renderer origin');
  if (mode === 'seed') {
    await writeStore('bike-db', 'workspace-store', {
      workspace: fixture.destination, 'workspace-meta': { revision: 100, savedAt: Date.now() },
      [keys.replica]: fixture.destinationReplica,
    }, true);
    await writeStore('bike-history-db', 'snapshots', { ['document:' + fixture.destination.documents[0].id]: [fixture.destinationHistory] }, true);
    localStorage.clear();
    localStorage.setItem('theme', 'light');
    localStorage.setItem('bike-ai-config', JSON.stringify({ endpoint: 'responses', baseUrl: 'https://destination.invalid/v1', model: 'destination-model', apiKey: 'native-test-destination-value' }));
    localStorage.setItem('bike-sync-config', JSON.stringify({ serverUrl: 'https://destination.invalid', token: 'native-test-destination-token', autoSync: true }));
    localStorage.setItem('bike-local-copy-offline', '1');
    require((await window.bike.setBackupAuto(true)).auto === true, 'Initial automatic backup was not enabled');
    result.checks = { destinationSeeded: true, automaticBackupInitiallyEnabled: true };
  } else if (mode === 'import') {
    installFileSelection();
    require((await mainStore()).workspace.documents[0].title === fixture.destination.documents[0].title, 'Destination baseline was not loaded');
    require((await window.bike.getBackupStatus()).auto === true, 'Import did not begin with automatic backup enabled');
    click('导入本机副本');
    await waitFor(() => document.querySelector('#local-copy-title'), 'complete-copy preview');
    require(document.querySelector('#local-copy-title').textContent === '导入完整本机副本', 'Wrong import preview');
    require([...document.querySelectorAll('.api-config-dialog input[type=checkbox]')].every((input) => !input.checked), 'Opt-in fields were selected automatically');
    require((await mainStore()).workspace.documents[0].title === fixture.destination.documents[0].title, 'Preview changed destination body');
    await capture('import-confirmation');
    click('取消', document.querySelector('.api-config-dialog'));
    await waitFor(() => !document.querySelector('#local-copy-title'), 'cancelled preview');
    require((await mainStore()).workspace.documents[0].title === fixture.destination.documents[0].title, 'Cancel changed destination body');
    click('导入本机副本');
    await waitFor(() => document.querySelector('#local-copy-title'), 'second complete-copy preview');
    click('备份当前副本并导入', document.querySelector('.api-config-dialog'));
    await waitFor(() => document.body.textContent.includes('完整本机副本已导入。已生成新副本身份'), 'completed import notice');
    const installed = await assertInstalled();
    await capture('import-completed');
    result.actor = installed.actor;
    click('来源档案');
    await waitFor(() => document.querySelector('#source-archives-title'), 'source archive dialog');
    const sourceDialog = document.querySelector('#source-archives-title').closest('section');
    require(sourceDialog.textContent.includes(fixture.sourceActor) && sourceDialog.textContent.includes('源待传操作 1 项'), 'Source audit summary missing');
    require(sourceDialog.querySelectorAll('button').length === 3, 'Source audit unexpectedly exposes write actions');
    await capture('source-archives');
    click('下载只读源记录', sourceDialog);
    click('关闭', sourceDialog);
    document.querySelector('button[aria-label="版本历史"]').click();
    await waitFor(() => document.querySelector('.history-dialog .history-list button'), 'imported version history');
    require(document.querySelector('.history-dialog').textContent.includes(fixture.historyTitle), 'Imported current-document version missing from UI');
    await capture('imported-history');
    click('关闭', document.querySelector('.history-dialog'));
    const recoveryButton = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('份备用副本 · 查看与恢复'));
    require(recoveryButton, 'Imported recovery entry missing');
    recoveryButton.click();
    await waitFor(() => document.querySelector('.workspace-recovery'), 'recovery copies');
    const recovery = [...document.querySelectorAll('.recovery-snapshot')].find((entry) => entry.textContent.includes(fixture.recoveryTitle));
    require(recovery && !recovery.textContent.includes('下载并删除'), 'Source recovery is missing or mutable');
    await capture('imported-recovery');
    click('返回工作区');
    await waitFor(() => document.querySelector('.shell'), 'returned workspace');
    click('导入本机副本');
    await waitFor(() => document.body.textContent.includes('此本机副本已经导入，当前编辑已保留'), 'duplicate-import refusal');
    require(!document.querySelector('#local-copy-title'), 'Duplicate import opened a second install preview');
    const repeated = await assertInstalled();
    require(repeated.actor === installed.actor, 'Duplicate import replaced replica identity');
    await capture('duplicate-refused');
    result.checks = { actualUIImport: true, previewAndCancel: true, defaultsOff: true, currentCopyBackup: true,
      body: true, trash: true, history: true, orphanHistory: true, recovery: true, readonlySourceAudit: true,
      originalAttachments: fixture.assets.length, independentActor: true, emptyActiveOutbox: true,
      syncDisabled: true, automaticBackupDisabled: true, privateOptionsExcluded: true, duplicateRefused: true, journalsFinalized: true };
  } else if (mode === 'verify' || mode === 'verify-recovery') {
    const installed = await assertInstalled();
    require(document.querySelector('[data-node-id="' + fixture.nodeId + '"]'), 'Imported node did not render after restart');
    result.actor = installed.actor;
    result.checks = { restartBody: true, restartHistory: true, restartArchive: true, restartOriginals: fixture.assets.length,
      restartIdentity: true, restartOffline: true, restartJournalsClear: true, recoveredInstalledJournal: mode === 'verify-recovery' };
  } else if (mode === 'seed-recovery') {
    const installed = await assertInstalled();
    const receipt = installed.state[keys.receipts][fixture.copyId];
    const rows = Object.entries(installed.history).filter(([key]) => key.startsWith('document:')).map(([key, snapshots]) => ({ documentId: key.slice(9), snapshots }));
    await writeStore('bike-history-db', 'snapshots', { [keys.historyJournal]: { id: receipt.sessionId, archiveId: fixture.copyId, before: rows, after: rows } });
    await writeStore('bike-db', 'workspace-store', { [keys.journal]: {
      id: receipt.sessionId, archiveId: fixture.copyId, sourceDigest: 'diagnostic-installed-completion', expectedRevision: 100,
      startedAt: Date.now() - 120000, phase: 'installed', settingsBefore: {},
    } });
    result.checks = { staleInstalledJournalSeeded: true };
  } else if (mode === 'restore') {
    const installed = await assertInstalled();
    installFileSelection();
    const confirmations = [];
    window.confirm = (message) => { confirmations.push(message); return true; };
    document.querySelector('button[aria-label="版本历史"]').click();
    await waitFor(() => document.querySelector('.history-dialog .history-list button'), 'version restore list');
    const version = [...document.querySelectorAll('.history-list button')].find((button) => button.textContent.includes(fixture.historyTitle));
    require(version, 'Imported historical version missing');
    version.click();
    click('恢复此版本', document.querySelector('.history-dialog'));
    await waitFor(async () => (await mainStore()).workspace.documents[0].title === fixture.historyTitle, 'restored historical body');
    click('关闭', document.querySelector('.history-dialog'));
    const afterHistory = await mainStore();
    require(afterHistory[keys.replica].actorId === installed.actor && afterHistory[keys.replica].outbox.length > 0, 'History restore did not create a normal new-actor operation');
    const recoveryButton = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('份备用副本 · 查看与恢复'));
    require(recoveryButton, 'Imported recovery entry missing after history restore');
    recoveryButton.click();
    await waitFor(() => document.querySelector('.workspace-recovery'), 'source recovery restore');
    const recovery = [...document.querySelectorAll('.recovery-snapshot')].find((entry) => entry.textContent.includes(fixture.recoveryTitle));
    click('恢复这个副本', recovery);
    await waitFor(async () => (await mainStore()).workspace.documents[0].title === fixture.recoveryTitle, 'restored source recovery body');
    await waitFor(() => document.querySelector('.shell'), 'restored workspace');
    const after = await mainStore();
    require(after[keys.replica].actorId === installed.actor, 'Recovery restore changed the independent actor');
    require(after[keys.replica].outbox.length > afterHistory[keys.replica].outbox.length, 'Recovery restore did not create a new operation');
    require(after[keys.replica].audit.at(-1).operation.source.kind === 'restore', 'Recovery operation lost its restore source');
    require(after[keys.archives][0].sourceAudit.outbox[0].id === 'source-unsent', 'Restore changed the readonly source archive');
    require(confirmations.length === 2, 'Restore confirmation boundary changed');
    await capture('source-recovery-restored');
    result.actor = installed.actor;
    result.checks = { historyRestoreThroughUI: true, sourceRecoveryThroughUI: true, restoreNewOperations: true,
      independentActorRetained: true, readonlyArchiveRetained: true, confirmations: confirmations.length };
  } else if (mode === 'verify-restored') {
    const state = await mainStore();
    require(state.workspace.documents[0].title === fixture.recoveryTitle, 'Restored body was not durable');
    require(state[keys.replica].outbox.length >= 2, 'Restored operations were not durable');
    require(state[keys.archives][0].id === fixture.copyId, 'Private archive was not durable after restore');
    require(state[keys.replica].actorId !== fixture.sourceActor && state[keys.replica].actorId !== fixture.destinationActor, 'Restored identity regressed');
    result.actor = state[keys.replica].actorId;
    result.checks = { restoredBodyRestart: true, restoredOperationsRestart: true, archiveRestart: true };
  }
  await pause(200);
  result.errors = window.__migrationErrors;
  result.csp = window.__migrationCSP;
  require(result.errors.length === 0 && result.csp.length === 0, 'Renderer reported an error or CSP violation');
  return JSON.stringify(result);
} catch (error) {
  return JSON.stringify({ ...result, failure: String(error), stack: error?.stack,
    errors: window.__migrationErrors, csp: window.__migrationCSP,
    uiText: document.body.textContent.slice(-8000) });
}
