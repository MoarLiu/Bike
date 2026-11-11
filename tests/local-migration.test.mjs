import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { installFakeBrowserStorage } from './helpers/fake-browser.mjs';
import { loadAppCallback, loadTypescript, loadTypescriptIsolated } from './helpers/typescript.mjs';
import { AI_CONFIG_KEY } from '../shared/bike-settings.mjs';
import { localMigrationAttachmentAssets, localMigrationDigest, readLocalMigration, sealLocalMigration } from '../shared/bike-local-migration.mjs';

const storage = loadTypescript('src/storage.ts');
const history = loadTypescript('src/versionHistory.ts');
const migration = loadTypescript('src/localMigration.ts');
const { migrateWorkspace } = loadTypescript('src/migrations.ts');
const knowledge = loadTypescript('src/knowledge.ts');
const preferences = loadTypescript('src/navigationStore.ts');
const { loadAiConfig } = loadTypescript('src/ai.ts');
const at = '2026-11-11T00:00:00.000Z';
const offlineOptions = { preferences: false, credentials: false };

// Cursor requests use the existing fake's real transaction queue and staged
// writes. Its quota, abort, competing-tab and connection checks stay enabled.
function withCursors(env) {
  const open = env.idb.indexedDB.open;
  env.idb.indexedDB.open = (...args) => {
    const request = open(...args);
    let success;
    Object.defineProperty(request, 'onsuccess', {
      get: () => (event) => {
        const db = request.result;
        const transaction = db.transaction.bind(db);
        db.transaction = (...parameters) => {
          const tx = transaction(...parameters);
          const objectStore = tx.objectStore.bind(tx);
          tx.objectStore = (name) => {
            const store = objectStore(name);
            store.openCursor = () => {
              let entries;
              let root;
              const next = (index) => tx._request(store, () => {
                entries ??= [...tx.db._data.stores.get(name)].sort(([left], [right]) => left.localeCompare(right));
                const item = entries[index];
                if (!item) return null;
                return { key: item[0], value: structuredClone(item[1]), continue() {
                  const step = next(index + 1);
                  step.onsuccess = (event) => { root._result = step.result; root.onsuccess?.(event); };
                } };
              });
              root = next(0);
              return root;
            };
            return store;
          };
          return tx;
        };
        success?.(event);
      },
      set: (callback) => { success = callback; }, configurable: true,
    });
    return request;
  };
  return env;
}
const asset = (name) => {
  const bytes = Buffer.from(name);
  return { assetId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, metadata: { mediaType: 'application/octet-stream', byteLength: bytes.length } };
};
const document = (id, text, attachment) => ({
  id, title: text, createdAt: at, updatedAt: at,
  ...(attachment ? { attachments: { version: 1, items: { [attachment.assetId]: attachment.metadata } } } : {}),
  nodes: [{ id: `node-${id}`, text, children: [], ...(attachment ? { attachmentRefs: [{ assetId: attachment.assetId, name: `${text}.bin` }] } : {}) }],
});
const workspace = (text, attachment) => migrateWorkspace({ version: 3, activeDocumentId: 'doc', documents: [document('doc', text, attachment)] });
const edit = (body, text) => ({ ...body, documents: [{ ...body.documents[0], title: text, nodes: [{ ...body.documents[0].nodes[0], text }] }] });

async function fixture(t) {
  const env = withCursors(installFakeBrowserStorage(t));
  const original = workspace('Destination');
  env.idb.seed('bike-db', { workspace: original, 'workspace-meta': { revision: 4 } });
  const current = (await storage.loadWorkspace({ includeFallback: false })).workspace;
  await storage.saveWorkspace(current);
  const before = (await storage.loadWorkspace({ includeFallback: false })).workspace;
  return { ...env, before, disableBackup: async () => {} };
}

function copyFixture() {
  const live = asset('live'), old = asset('history'), backup = asset('recovery'), trashed = asset('trash');
  const body = workspace('Source', live);
  body.trash = [{ id: 'trash-entry', document: migrateWorkspace({ version: 3, activeDocumentId: 'deleted', documents: [document('deleted', 'Deleted', trashed)] }).documents[0], originalIndex: 0, deletedAt: at }];
  const snapshot = history.createSnapshot(migrateWorkspace({ version: 3, activeDocumentId: 'orphan', documents: [document('orphan', 'Old orphan', old)] }).documents[0], 'manual', at);
  const recovery = workspace('Recovery', backup);
  const copy = {
    format: 'bike-local-copy', version: 1, id: 'source-archive', createdAt: at,
    source: { actorId: 'source-actor', revision: 19, workspaceSha256: localMigrationDigest(body) },
    history: [{ documentId: 'orphan', snapshots: [snapshot] }],
    recovery: [{ id: 'source-recovery', workspace: recovery, savedAt: Date.parse(at), baseRevision: 18 }],
    recoveryFiles: [{ id: 'source-raw', content: JSON.stringify(recovery) }],
    preAttachment: null, preOperation: null,
    sourceAudit: { audit: [{ id: 'source-audit', operation: { changes: [{ before: snapshot.document }] } }],
      outbox: [{ id: 'source-unsent', changes: [] }], receipts: { 'source-request': { status: 'committed' } }, conflicts: [{ id: 'source-conflict' }] },
    archives: [], assets: [live, old, backup, trashed].sort((left, right) => left.assetId.localeCompare(right.assetId)),
    preferences: { theme: 'dark', ai: { endpoint: 'responses', baseUrl: 'https://provider.invalid/v1', model: 'fixture-model' } },
    credentials: { aiApiKey: 'explicit-fixture-ai-key' },
  };
  return sealLocalMigration(body, copy);
}

test('full-copy contract covers live, trash, orphan history, recovery and audit assets', () => {
  const raw = copyFixture();
  assert.equal(readLocalMigration(raw).id, 'source-archive');
  assert.equal(localMigrationAttachmentAssets(raw).length, 4);
  const changedHistory = structuredClone(raw);
  changedHistory.localMigration.history[0].snapshots[0].document.title = 'Tampered';
  assert.throws(() => readLocalMigration(changedHistory), /校验/);
  const missing = structuredClone(raw);
  missing.localMigration.assets.pop();
  assert.throws(() => readLocalMigration(missing), /清单不闭合/);
  const duplicate = structuredClone(raw);
  duplicate.localMigration.assets.push(duplicate.localMigration.assets[0]);
  assert.throws(() => readLocalMigration(duplicate), /校验/);
  const conflicting = structuredClone(raw);
  conflicting.localMigration.assets[0].metadata.byteLength += 1;
  assert.throws(() => readLocalMigration(conflicting), /校验/);
});

test('complete source export retains both migration backups and leaves its replica/outbox untouched', async (t) => {
  const env = withCursors(installFakeBrowserStorage(t));
  const initial = { ...workspace('Original'), version: 1 };
  env.idb.seed('bike-db', { workspace: initial, 'workspace-meta': { revision: 1 } });
  const loaded = (await storage.loadWorkspace()).workspace;
  const v2 = { ...loaded, version: 2 };
  assert.equal((await storage.saveWorkspace(v2)).ok, true);
  const v3 = { ...v2, version: 3 };
  assert.equal((await storage.saveWorkspace(v3)).ok, true);
  const next = edit(v3, 'Pending source edit');
  await storage.saveWorkspace(next);
  await history.captureSnapshot(next.documents[0], 'manual');
  await history.captureSnapshot(document('orphan', 'Orphan history', asset('orphan attachment')), 'manual');
  storage.saveWorkspaceFallback(edit(next, 'Uncommitted fallback'));
  const beforeReplica = await storage.readReplicaState();
  const beforeBody = env.idb.read('bike-db', 'workspace');
  env.localStorage.storage.setItem('bike-sync-config', JSON.stringify({ token: 'source-sync-token-fixture', autoSync: true }));
  env.localStorage.storage.setItem(AI_CONFIG_KEY, JSON.stringify({ apiKey: 'private-ai-fixture', model: 'source-model' }));
  const exported = await migration.createLocalMigrationExport(next, offlineOptions);
  assert.equal(exported.localMigration.preAttachment.version, 1);
  assert.equal(exported.localMigration.preOperation.version, 2);
  assert.equal(exported.localMigration.history.length, 2);
  assert.equal(exported.localMigration.recovery.length, 1);
  assert.equal(exported.localMigration.sourceAudit.outbox.length, 1);
  assert.equal(exported.localMigration.preferences, undefined);
  assert.equal(exported.localMigration.credentials, undefined);
  assert.equal(JSON.stringify(exported).includes('source-sync-token-fixture'), false);
  assert.equal(JSON.stringify(exported).includes('private-ai-fixture'), false);
  assert.deepEqual(await storage.readReplicaState(), beforeReplica);
  assert.deepEqual(env.idb.read('bike-db', 'workspace'), beforeBody);
  const optedIn = await migration.createLocalMigrationExport(next, { preferences: true, credentials: true });
  assert.equal(optedIn.localMigration.preferences.ai.model, 'source-model');
  assert.equal(optedIn.localMigration.credentials.aiApiKey, 'private-ai-fixture');
  assert.equal(JSON.stringify(optedIn).includes('source-sync-token-fixture'), false);
});

test('source export detects a replica/workspace CAS change while resolving audit assets', async (t) => {
  const f = await fixture(t);
  const auditAsset = asset('expired-document-asset');
  const originalReplica = await storage.readReplicaState();
  const altered = { ...originalReplica, audit: [{ id: 'old', operation: { changes: [{ assetId: auditAsset.assetId }] } }] };
  const key = f.idb.log.commits.flatMap((item) => item.keys).find((item) => item !== 'workspace' && item !== 'workspace-meta');
  await put('bike-db', 'workspace-store', key, altered);
  const next = edit(f.before, 'A concurrent source edit');
  await assert.rejects(migration.createLocalMigrationExport(f.before, offlineOptions, async () => {
    assert.equal((await storage.saveWorkspace(next)).ok, true);
    return auditAsset.metadata;
  }), /版本已变化|快照期间变化/);
  assert.equal(f.idb.read('bike-db', 'workspace').documents[0].title, 'A concurrent source edit');
});

test('full import installs history and private recovery with an independent actor and offline defaults', async (t) => {
  const f = await fixture(t);
  const oldActor = (await storage.readReplicaState()).actorId;
  f.localStorage.storage.setItem('bike-sync-config', JSON.stringify({ serverUrl: 'http://fixture.invalid', token: 'old-destination-token', autoSync: true }));
  f.localStorage.storage.setItem('bike-sync-state', JSON.stringify({ workspaceRevision: 78 }));
  f.localStorage.storage.setItem('theme', 'light');
  let disabled = 0;
  const raw = copyFixture();
  const original = structuredClone(raw);
  const installed = await migration.installLocalMigrationExport(raw, f.before, offlineOptions, async () => { disabled++; });
  assert.equal(installed.documents[0].title, 'Source');
  assert.equal('localMigration' in installed, false);
  const replica = await storage.readReplicaState();
  assert.notEqual(replica.actorId, oldActor);
  assert.notEqual(replica.actorId, raw.localMigration.source.actorId);
  assert.equal(replica.cursor, 0); assert.equal(replica.remote, null); assert.equal(replica.remoteId, null);
  assert.deepEqual(replica.outbox, []); assert.deepEqual(replica.receipts, {}); assert.deepEqual(replica.audit, []); assert.deepEqual(replica.conflicts, []);
  assert.equal((await history.listDocumentSnapshots('orphan'))[0].document.title, 'Old orphan');
  assert.equal((await storage.listLocalMigrationArchives())[0].sourceAudit.outbox[0].id, 'source-unsent');
  assert.equal((await storage.listLocalMigrationArchives())[0].credentials, undefined);
  assert.equal(storage.listWorkspaceRecoverySnapshots().find((item) => item.id.includes('source-recovery')).workspace.documents[0].title, 'Recovery');
  assert.equal((await storage.listLocalMigrationProtectedAssetIds()).length, 4);
  assert.equal(storage.listWorkspaceRecoveryFiles()[0].content, raw.localMigration.recoveryFiles[0].content);
  assert.equal(JSON.parse(f.localStorage.storage.getItem('bike-sync-config')).autoSync, false);
  assert.equal(JSON.parse(f.localStorage.storage.getItem('bike-sync-config')).token, '');
  assert.equal(f.localStorage.storage.getItem('bike-sync-state'), null);
  assert.equal(f.localStorage.storage.getItem('theme'), 'light');
  assert.equal(f.localStorage.storage.getItem('bike-local-copy-offline'), '1');
  assert.equal(disabled, 1);
  assert.equal(await storage.readLocalMigrationJournal(), null);
  assert.equal(await history.readHistoryMigrationJournal(), null);
  assert.deepEqual(raw, original);
});

test('an explicit preference/credential import remains offline and is excluded from later default exports', async (t) => {
  const f = await fixture(t);
  const installed = await migration.installLocalMigrationExport(copyFixture(), f.before, { preferences: true, credentials: true }, f.disableBackup);
  assert.equal(f.localStorage.storage.getItem('theme'), 'dark');
  assert.equal(JSON.parse(f.localStorage.storage.getItem(AI_CONFIG_KEY)).apiKey, 'explicit-fixture-ai-key');
  const exported = await migration.createLocalMigrationExport(installed, offlineOptions);
  assert.equal(exported.localMigration.archives.length, 1);
  assert.equal(JSON.stringify(exported).includes('explicit-fixture-ai-key'), false);
});

test('repeat import is refused after new edits and preserves the new outbox', async (t) => {
  const f = await fixture(t);
  const copy = copyFixture();
  const installed = await migration.installLocalMigrationExport(copy, f.before, offlineOptions, f.disableBackup);
  const changed = edit(installed, 'New destination edit');
  await storage.saveWorkspace(changed);
  const before = await storage.readReplicaState();
  await assert.rejects(migration.installLocalMigrationExport(copy, changed, offlineOptions, f.disableBackup), /已经导入/);
  assert.deepEqual(await storage.readReplicaState(), before);
  assert.equal(f.idb.read('bike-db', 'workspace').documents[0].title, 'New destination edit');
});

for (const failure of ['stage', 'history-put', 'history-commit', 'main-install']) {
  test(`failure at ${failure} preserves both databases and permits a retry`, async (t) => {
    const f = await fixture(t);
    await history.captureSnapshot(f.before.documents[0], 'manual');
    const originalReplica = await storage.readReplicaState();
    const originalHistory = await history.listAllDocumentSnapshots();
    if (failure === 'stage') f.idb.failPut({ db: 'bike-db', key: 'local-migration-journal-v1', times: 1 });
    if (failure === 'history-put') f.idb.failPut({ db: 'bike-history-db', key: 'document:orphan', times: 1 });
    if (failure === 'history-commit') f.idb.failCommit({ db: 'bike-history-db', times: 1 });
    if (failure === 'main-install') f.idb.failPut({ db: 'bike-db', key: 'workspace', times: 1 });
    await assert.rejects(migration.installLocalMigrationExport(copyFixture(), f.before, offlineOptions, f.disableBackup));
    assert.deepEqual(f.idb.read('bike-db', 'workspace'), f.before);
    assert.deepEqual(await storage.readReplicaState(), originalReplica);
    assert.deepEqual(await history.listAllDocumentSnapshots(), originalHistory);
    assert.equal(await storage.readLocalMigrationJournal(), null);
    assert.equal(await history.readHistoryMigrationJournal(), null);
    f.idb.resetFailures();
    assert.equal((await migration.installLocalMigrationExport(copyFixture(), f.before, offlineOptions, f.disableBackup)).documents[0].title, 'Source');
    await f.settle();
    assert.equal(f.idb.openConnections, 0);
  });
}

async function put(dbName, storeName, key, value) {
  const db = await new Promise((resolve, reject) => { const req = indexedDB.open(dbName, 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  try {
    await new Promise((resolve, reject) => { const tx = db.transaction(storeName, 'readwrite'); tx.objectStore(storeName).put(value, key); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
  } finally { db.close(); }
}
async function stagedImport(f, settingsBefore = {}) {
  const raw = copyFixture();
  const source = await storage.readLocalMigrationStorage(f.before);
  const before = await history.listAllDocumentSnapshots();
  await storage.beginLocalMigration({ id: 'crashed-session', archiveId: raw.localMigration.id, expectedRevision: source.revision, sourceDigest: source.fingerprint, settingsBefore, startedAt: Date.now() - 61_000 });
  await history.installMigrationHistory('crashed-session', raw.localMigration.id, before, raw.localMigration.history);
  return raw;
}

function initializationFixture(f, overrides = {}) {
  const state = {
    theme: preferences.readPreference('theme', 'light'),
    showRelations: preferences.readPreference('bike.mindmap.relations', '1') !== '0',
    navigation: knowledge.normalizeNavigation(JSON.parse(preferences.readPreference('bike.navigation.v1', 'null'))),
    ai: loadAiConfig(), ready: false, loadError: null, workspace: null,
  };
  const bindings = {
    ...storage, ...migration, ...knowledge, ...preferences, loadAiConfig,
    workspaceRef: { current: null }, backupLocalPauseRef: { current: null },
    localCopyPreferencesPendingRef: { current: false },
    backupScheduleRef: { current: knowledge.createBackupSchedule() }, backupPayloadsRef: { current: new Map() },
    lastAutoSnapshotRef: { current: new Map() }, disableLocalCopyAutomaticBackup: f.disableBackup,
    setTheme: (value) => { state.theme = value; },
    setShowRelations: (value) => { state.showRelations = value; },
    setNavigation: (value) => { state.navigation = typeof value === 'function' ? value(state.navigation) : value; },
    setAiConfig: (value) => { state.ai = value; },
    setReady: (value) => { state.ready = value; },
    setLoadError: (value) => { state.loadError = value; },
    loadSyncConfig: () => JSON.parse(localStorage.getItem('bike-sync-config') ?? '{}'),
    emptySyncState: (serverUrl) => ({ serverUrl }),
    saveSyncState() {}, setSyncState() {}, setSyncConfig() {},
    clearEditHistory() {}, refreshRecoverySnapshots() {}, setActiveNodeId() {},
    firstNodeIdInWorkspace: (body) => body.documents[0].nodes[0].id,
    replaceWorkspace: (body) => { bindings.workspaceRef.current = body; state.workspace = body; },
    showNotice: (message) => assert.fail(message),
    ...overrides,
  };
  bindings.pauseLocalBackup = loadAppCallback('pauseLocalBackup', bindings);
  bindings.reloadLocalCopyPreferences = loadAppCallback('reloadLocalCopyPreferences', bindings);
  return { state, initialize: loadAppCallback('initializeWorkspace', bindings) };
}

test('startup rolls back a crash between the separate history and main database commits', async (t) => {
  const f = await fixture(t);
  await history.captureSnapshot(f.before.documents[0], 'manual');
  const before = await history.listAllDocumentSnapshots();
  await stagedImport(f);
  assert.equal((await storage.loadWorkspace()).status, 'error');
  assert.equal((await storage.saveWorkspace(edit(f.before, 'Must be blocked'))).ok, false);
  await assert.rejects(history.captureSnapshot(f.before.documents[0], 'manual'), /正在安装/);
  assert.equal(await migration.recoverInterruptedLocalMigration(f.disableBackup), true);
  assert.deepEqual((await storage.loadWorkspace()).workspace, f.before);
  assert.deepEqual(await history.listAllDocumentSnapshots(), before);
  assert.equal(await storage.readLocalMigrationJournal(), null);
  assert.equal(await history.readHistoryMigrationJournal(), null);
});

test('startup completes cleanup after the atomic main install and retains its new identity', async (t) => {
  const f = await fixture(t);
  const raw = await stagedImport(f);
  await storage.commitLocalMigration('crashed-session', raw, raw.localMigration);
  const journal = await storage.readLocalMigrationJournal();
  await put('bike-db', 'workspace-store', 'local-migration-journal-v1', { ...journal, startedAt: Date.now() - 61_000 });
  await assert.rejects(storage.readReplicaState(), /尚未完成/);
  assert.equal((await storage.loadWorkspace()).status, 'error');
  assert.ok(await history.readHistoryMigrationJournal());
  assert.equal(await migration.recoverInterruptedLocalMigration(f.disableBackup), true);
  assert.equal((await storage.loadWorkspace()).workspace.documents[0].title, 'Source');
  assert.notEqual((await storage.readReplicaState()).actorId, raw.localMigration.source.actorId);
  assert.equal((await history.listDocumentSnapshots('orphan')).length, 1);
  assert.equal(await history.readHistoryMigrationJournal(), null);
});

test('startup rollback reloads UI preferences after a transient body-load failure and retry', async (t) => {
  const f = await fixture(t);
  const originalNavigation = knowledge.pruneNavigation(knowledge.saveNavigationFilter({
    ...knowledge.createNavigationState(), favorites: ['doc'],
    recent: [{ documentId: 'doc', nodeId: 'node-doc', view: 'mindmap', openedAt: at }],
  }, { id: 'destination-filter', name: 'Destination filter', documentIds: ['doc'], query: 'Destination', tags: ['saved'], task: 'open', favoriteOnly: true, includeCode: true }), { liveIds: ['doc'], trashIds: [] });
  const before = {
    theme: 'light', 'bike.mindmap.relations': '1',
    'bike.navigation.v1': JSON.stringify(originalNavigation),
    [AI_CONFIG_KEY]: JSON.stringify({ model: 'destination-model' }),
  };
  for (const [key, value] of Object.entries(before)) localStorage.setItem(key, value);
  await stagedImport(f, before);
  localStorage.setItem('theme', 'dark');
  localStorage.setItem('bike.mindmap.relations', '0');
  localStorage.setItem('bike.navigation.v1', JSON.stringify({ ...knowledge.createNavigationState(), favorites: ['source-only'] }));
  localStorage.setItem(AI_CONFIG_KEY, JSON.stringify({ model: 'source-model' }));
  let failFirstLoad = true;
  const notices = [];
  const app = initializationFixture(f, {
    loadWorkspace: async (options) => {
      if (failFirstLoad) {
        failFirstLoad = false;
        return { status: 'error', error: new Error('temporary body-load failure') };
      }
      return storage.loadWorkspace(options);
    },
    showNotice: (message) => notices.push(message),
  });
  assert.equal(app.state.theme, 'dark');
  assert.deepEqual(app.state.navigation.favorites, ['source-only']);
  assert.equal(await app.initialize(), false);
  assert.equal(await storage.readLocalMigrationJournal(), null);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /temporary body-load failure/);
  assert.equal(await app.initialize(), true);
  assert.equal(app.state.ready, true);
  assert.equal(app.state.loadError, null);
  assert.equal(app.state.workspace.documents[0].title, 'Destination');
  assert.equal(app.state.theme, 'light');
  assert.equal(app.state.showRelations, true);
  assert.equal(app.state.ai.model, 'destination-model');
  assert.deepEqual(JSON.parse(JSON.stringify(app.state.navigation)), originalNavigation);
  // The existing preference effects now write the restored state.
  preferences.writePreference('theme', app.state.theme);
  preferences.writePreference('bike.mindmap.relations', app.state.showRelations ? '1' : '0');
  preferences.writePreference('bike.navigation.v1', JSON.stringify(app.state.navigation));
  for (const [key, value] of Object.entries(before)) assert.equal(localStorage.getItem(key), value);
  assert.equal(await storage.readLocalMigrationJournal(), null);
  assert.equal(await history.readHistoryMigrationJournal(), null);
});

test('startup completion reloads installed preferences and prunes navigation against the installed body', async (t) => {
  const f = await fixture(t);
  const raw = await stagedImport(f);
  await storage.commitLocalMigration('crashed-session', raw, raw.localMigration);
  const journal = await storage.readLocalMigrationJournal();
  await put('bike-db', 'workspace-store', 'local-migration-journal-v1', { ...journal, startedAt: Date.now() - 61_000 });
  const importedNavigation = {
    ...knowledge.createNavigationState(), favorites: ['doc', 'deleted', 'missing'],
    recent: [{ documentId: 'doc', nodeId: 'node-doc', view: 'outline', openedAt: at },
      { documentId: 'missing', nodeId: null, view: 'outline', openedAt: at }],
  };
  const app = initializationFixture(f);
  localStorage.setItem('theme', 'dark');
  localStorage.setItem('bike.mindmap.relations', '0');
  localStorage.setItem('bike.navigation.v1', JSON.stringify(importedNavigation));
  localStorage.setItem(AI_CONFIG_KEY, JSON.stringify({ model: 'installed-model' }));
  assert.equal(await app.initialize(), true);
  assert.equal(app.state.workspace.documents[0].title, 'Source');
  assert.equal(app.state.theme, 'dark');
  assert.equal(app.state.showRelations, false);
  assert.equal(app.state.ai.model, 'installed-model');
  assert.deepEqual(Array.from(app.state.navigation.favorites), ['doc', 'deleted']);
  assert.deepEqual(Array.from(app.state.navigation.recent, (entry) => entry.documentId), ['doc']);
  assert.equal(await storage.readLocalMigrationJournal(), null);
  assert.equal(await history.readHistoryMigrationJournal(), null);
});

test('persistent quota failure retains the import journal and recovers on the next retry', async (t) => {
  const f = await fixture(t);
  const originalHistory = await history.listAllDocumentSnapshots();
  f.localStorage.storage.setItem('theme', 'light');
  f.localStorage.failSetItem('theme');
  f.localStorage.storage.setItem('bike-sync-config', JSON.stringify({ autoSync: true, token: 'destination-fixture' }));
  await assert.rejects(migration.installLocalMigrationExport(copyFixture(), f.before, { preferences: true, credentials: false }, f.disableBackup), /日志已保留/);
  const journal = await storage.readLocalMigrationJournal();
  assert.ok(journal);
  assert.equal((await storage.loadWorkspace()).status, 'error');
  assert.deepEqual(f.idb.read('bike-db', 'workspace'), f.before);
  f.localStorage.resetFailures();
  await put('bike-db', 'workspace-store', 'local-migration-journal-v1', { ...journal, startedAt: Date.now() - 61_000 });
  assert.equal(await migration.recoverInterruptedLocalMigration(f.disableBackup), true);
  assert.deepEqual((await storage.loadWorkspace()).workspace, f.before);
  assert.deepEqual(await history.listAllDocumentSnapshots(), originalHistory);
});

test('a recent foreign import remains protected instead of being rolled back by another page', async (t) => {
  const f = await fixture(t);
  const source = await storage.readLocalMigrationStorage(f.before);
  await storage.beginLocalMigration({ id: 'active-foreign-session', archiveId: 'foreign', expectedRevision: source.revision, sourceDigest: source.fingerprint, startedAt: Date.now(), settingsBefore: {} });
  await assert.rejects(migration.recoverInterruptedLocalMigration(f.disableBackup), /另一窗口/);
  assert.equal((await storage.readLocalMigrationJournal()).id, 'active-foreign-session');
  assert.deepEqual(f.idb.read('bike-db', 'workspace'), f.before);
});

test('automatic sync observes the persistent offline import guard before any network work', async () => {
  const sync = loadAppCallback('syncNow', { readPreference: () => '1' });
  await sync(undefined, { silent: true });
});

test('an unrelated history database failure does not prevent an ordinary workspace load', async (t) => {
  const f = await fixture(t);
  f.idb.failOpen('bike-history-db');
  assert.equal(await migration.recoverInterruptedLocalMigration(f.disableBackup), false);
  assert.equal((await storage.loadWorkspace()).status, 'loaded');
});

test('ordinary fallback-only browsers keep their existing startup path', async (t) => {
  installFakeBrowserStorage(t, { indexedDB: false });
  assert.equal(await migration.recoverInterruptedLocalMigration(async () => { throw new Error('Unexpected native call'); }), false);
});

test('a second page cannot write through a staged import or create a misleading fallback commit', async (t) => {
  const f = await fixture(t);
  const other = loadTypescriptIsolated('src/storage.ts');
  const secondPage = (await other.loadWorkspace()).workspace;
  const source = await storage.readLocalMigrationStorage(f.before);
  await storage.beginLocalMigration({ id: 'held', archiveId: 'archive', expectedRevision: source.revision, sourceDigest: source.fingerprint, startedAt: Date.now(), settingsBefore: {} });
  const result = await other.saveWorkspace(edit(secondPage, 'Concurrent write'));
  assert.equal(result.ok, false);
  assert.match(result.error.message, /尚未完成/);
  assert.equal(other.listWorkspaceRecoverySnapshots().length, 0);
  assert.deepEqual(f.idb.read('bike-db', 'workspace'), f.before);
});

test('same snapshot identity with differing source content is rejected without replacing either copy', async (t) => {
  const f = await fixture(t);
  const raw = copyFixture();
  const original = raw.localMigration.history[0].snapshots[0];
  await history.listAllDocumentSnapshots();
  await put('bike-history-db', 'snapshots', 'document:orphan', [{ ...original, document: { ...original.document, title: 'Different destination version' } }]);
  await assert.rejects(migration.installLocalMigrationExport(raw, f.before, offlineOptions, f.disableBackup), /相同版本快照身份/);
  assert.equal((await history.listDocumentSnapshots('orphan'))[0].document.title, 'Different destination version');
  assert.deepEqual(f.idb.read('bike-db', 'workspace'), f.before);
});

test('restoring a migrated version creates a normal new operation under the destination actor', async (t) => {
  const f = await fixture(t);
  const raw = copyFixture();
  const { contentSha256: _checksum, ...copy } = raw.localMigration;
  const oldDocument = structuredClone(raw.documents[0]);
  oldDocument.title = 'Restorable source history';
  copy.history.push({ documentId: 'doc', snapshots: [history.createSnapshot(oldDocument, 'manual', at)] });
  const bundle = sealLocalMigration(raw, copy);
  const installed = await migration.installLocalMigrationExport(bundle, f.before, offlineOptions, f.disableBackup);
  const actor = (await storage.readReplicaState()).actorId;
  const saved = await storage.saveWorkspace({ ...installed, documents: [(await history.listDocumentSnapshots('doc'))[0].document] });
  assert.equal(saved.ok, true);
  const replica = await storage.readReplicaState();
  assert.equal(replica.actorId, actor);
  assert.equal(replica.outbox.length, 1);
  assert.equal(replica.outbox[0].actorId, actor);
  assert.equal(replica.audit.length, 1);
  assert.notEqual(replica.audit[0].id, 'source-audit');
});

test('ordinary save rejects a private full-copy extension before changing active storage', async (t) => {
  const f = await fixture(t);
  const result = await storage.saveWorkspace(copyFixture());
  assert.equal(result.ok, false);
  assert.match(result.error.message, /专用导入入口/);
  assert.deepEqual(f.idb.read('bike-db', 'workspace'), f.before);
});

test('recovery atomically takes ownership and a resumed stale importer cannot commit', async (t) => {
  const f = await fixture(t);
  const raw = await stagedImport(f);
  const journal = await storage.readLocalMigrationJournal();
  const owner = await storage.claimLocalMigrationRecovery(journal.id, journal.startedAt);
  await assert.rejects(storage.renewLocalMigrationLease(journal.id), /接管/);
  await assert.rejects(storage.commitLocalMigration(journal.id, raw, raw.localMigration), /会话或正文基线/);
  await assert.rejects(storage.claimLocalMigrationRecovery(journal.id, journal.startedAt), /仍在进行/);
  await history.finishMigrationHistory(journal.id, true);
  await storage.abortLocalMigration(journal.id, owner);
  assert.deepEqual((await storage.loadWorkspace()).workspace, f.before);
});

test('a saved legacy body with missing default fields exports without rewriting its source', async (t) => {
  const f = withCursors(installFakeBrowserStorage(t));
  const raw = { version: 1, activeDocumentId: 'legacy', documents: [{ id: 'legacy', title: 'Legacy', createdAt: at, updatedAt: at, nodes: [{ id: 'old-node', text: 'Old content', children: [] }] }] };
  f.idb.seed('bike-db', { workspace: raw, 'workspace-meta': { revision: 2 } });
  const loaded = (await storage.loadWorkspace()).workspace;
  assert.equal((await storage.saveWorkspace(loaded)).ok, true);
  const exported = await migration.createLocalMigrationExport(loaded, offlineOptions);
  assert.equal(exported.documents[0].nodes[0].id, 'old-node');
  assert.equal(exported.documents[0].nodes[0].text, 'Old content');
  assert.deepEqual(f.idb.read('bike-db', 'workspace'), raw);
  assert.equal(f.idb.read('bike-db', 'workspace-meta').revision, 2);
});

test('failure of the last completion marker remains protected and retries without reinstalling', async (t) => {
  const f = await fixture(t);
  const raw = await stagedImport(f);
  await storage.commitLocalMigration('crashed-session', raw, raw.localMigration);
  await history.finishMigrationHistory('crashed-session', false);
  const revision = f.idb.read('bike-db', 'workspace-meta').revision;
  f.idb.failPut({ db: 'bike-db', key: 'local-migration-journal-v1', times: 1 });
  await assert.rejects(storage.finalizeLocalMigration('crashed-session'));
  assert.equal((await storage.loadWorkspace()).status, 'error');
  f.idb.resetFailures();
  const journal = await storage.readLocalMigrationJournal();
  await put('bike-db', 'workspace-store', 'local-migration-journal-v1', { ...journal, startedAt: Date.now() - 61_000 });
  assert.equal(await migration.recoverInterruptedLocalMigration(f.disableBackup), true);
  assert.equal((await storage.loadWorkspace()).workspace.documents[0].title, 'Source');
  assert.equal(f.idb.read('bike-db', 'workspace-meta').revision, revision);
});

test('archive credentials are stripped recursively before another default full-copy export', async (t) => {
  const f = await fixture(t);
  const raw = copyFixture();
  const { contentSha256: _checksum, ...copy } = raw.localMigration;
  copy.id = 'outer-copy';
  copy.archives = [structuredClone(raw.localMigration)];
  const bundle = sealLocalMigration(raw, copy);
  const installed = await migration.installLocalMigrationExport(bundle, f.before, offlineOptions, f.disableBackup);
  const archive = (await storage.listLocalMigrationArchives())[0];
  assert.equal(archive.credentials, undefined);
  assert.equal(archive.archives[0].credentials, undefined);
  const exported = await migration.createLocalMigrationExport(installed, offlineOptions);
  assert.equal(JSON.stringify(exported).includes('explicit-fixture-ai-key'), false);
});

test('the recovery UI restores an imported legacy copy as a new v3 operation and keeps its source archive', async (t) => {
  const f = await fixture(t);
  const snapshot = { id: 'import:source:legacy', workspace: { ...workspace('Legacy source recovery'), version: 1 }, savedAt: Date.parse(at), baseRevision: null };
  const before = structuredClone(snapshot);
  let removed = 0;
  const bindings = {
    ...storage, recoveryBusyRef: { current: false }, syncBusyRef: { current: false }, storageConflictRef: { current: false },
    workspaceRef: { current: f.before }, window: { confirm: () => true },
    setRecoveryBusy() {}, setStorageConflict() {}, clearAutoSyncTimer() {},
    flushPendingEdits: () => bindings.workspaceRef.current, downloadWorkspaceBackup: async () => {},
    replaceWorkspace: (body) => { bindings.workspaceRef.current = body; }, clearEditHistory() {},
    firstNodeIdInWorkspace: (body) => body.documents[0].nodes[0].id, setActiveNodeId() {}, setFocusNodeId() {},
    discardWorkspaceRecoverySnapshot: () => { removed++; }, setShowRecoverySnapshots() {}, refreshRecoverySnapshots() {}, showNotice() {},
  };
  await loadAppCallback('restoreRecoverySnapshot', bindings)(snapshot);
  assert.equal(f.idb.read('bike-db', 'workspace').version, 3);
  assert.equal(f.idb.read('bike-db', 'workspace').documents[0].title, 'Legacy source recovery');
  assert.equal((await storage.readReplicaState()).outbox[0].source.kind, 'restore');
  assert.equal(removed, 0);
  assert.deepEqual(snapshot, before);
});
