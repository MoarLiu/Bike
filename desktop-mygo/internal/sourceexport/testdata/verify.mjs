// Actual packaged Electron 2.0.0 profile -> production CLI -> Go ZIP import.
// Run from the repo with BIKE_MYGO_GO pointing at the pinned Go toolchain.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';
import { createAttachmentService } from '../../../../electron/attachment-service.cjs';
import { migrateWorkspace } from '../../../../mcp/bike-core.mjs';
import { createReplicaState } from '../../../../shared/bike-replica.mjs';
import { localMigrationDigest, readLocalMigration, sealLocalMigration } from '../../../../shared/bike-local-migration.mjs';
import { loadTypescript } from '../../../../tests/helpers/typescript.mjs';
import { buildSourceExporter } from '../../../../scripts/build-mygo-source-exporter.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-source-e2e-'));
const evidence = path.resolve(process.env.BIKE_MYGO_SOURCE_EXPORT_EVIDENCE ?? path.join(root, 'docs/evidence-mygo-2026-11-11-integration/source-export'));
const go = process.env.BIKE_MYGO_GO ?? 'go';
const environment = { ...process.env, GOTOOLCHAIN: 'local', GOEXPERIMENT: 'jsonv2', CGO_ENABLED: '0' };
const nodeFree = { PATH: '/usr/bin:/bin', HOME: os.homedir(), TMPDIR: os.tmpdir() };
const providedBinary = process.env.BIKE_MYGO_SOURCE_EXPORT_BINARY;
const binary = providedBinary ? path.resolve(providedBinary) : path.join(temporary, 'bike-mygo');
const interop = path.join(temporary, 'interop');
const profile = path.join(temporary, 'original-profile');
const appDirectory = path.join(temporary, 'formal');
const originalApp = path.join(appDirectory, 'Bike.app');
const originalExecutable = path.join(originalApp, 'Contents/MacOS/Bike');
const at = '2026-11-11T00:00:00.000Z';
const checksum = (value) => createHash('sha256').update(value).digest('hex');
const report = { runtimeVersion: '2.0.0', host: { platform: process.platform, architecture: process.arch, kernel: os.release() },
  nodeFreePATH: nodeFree.PATH, checks: {}, limitations: ['Physical macOS 12/13 source export remains unverified', 'ENOSPC is injected in the Go atomic-write test'] };
let application;
const runningChildren = new Set();

function startExporter(output) {
  const child = spawn(binary, ['--export-electron-profile', '--electron-app', originalApp, '--source-profile', profile, '--output', output], { env: nodeFree, stdio: ['ignore', 'pipe', 'pipe'] });
  runningChildren.add(child);
  child.once('close', () => runningChildren.delete(child));
  return child;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 180000, ...options });
  assert.equal(result.status, 0, `${executable} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

async function treeDigest(directory) {
  const hash = createHash('sha256');
  async function walk(relative) {
    const absolute = path.join(directory, relative);
    const info = await fs.lstat(absolute);
    hash.update(relative).update(String(info.mode)).update(String(info.mtimeNs ?? info.mtimeMs));
    if (info.isSymbolicLink()) hash.update(await fs.readlink(absolute));
    else if (info.isFile()) hash.update(await fs.readFile(absolute));
    else for (const name of (await fs.readdir(absolute)).sort()) await walk(path.join(relative, name));
  }
  await walk('');
  return hash.digest('hex');
}

function exportCLI(output, flags = []) {
  return run(binary, ['--export-electron-profile', '--electron-app', originalApp, '--source-profile', profile, '--output', output, ...flags], { env: nodeFree });
}

function importGo(filename, directory) {
  return JSON.parse(run(interop, [], { env: nodeFree, input: JSON.stringify({ action: 'importArchive', filename, directory }) }));
}

async function launchOriginal() {
  return _electron.launch({
    executablePath: originalExecutable,
    env: { ...process.env, BIKE_TEST_USER_DATA: profile, VITE_DEV_SERVER_URL: '' },
    timeout: 30000,
  });
}

async function closeOriginal() {
  if (!application) return;
  await application.close();
  application = undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fs.lstat(path.join(profile, 'SingletonLock')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Original profile did not gracefully release SingletonLock');
}

try {
  await fs.mkdir(evidence, { recursive: true });
  const zip = path.join(root, 'release/2.0.0/Bike-2.0.0-arm64.zip');
  const expected = (await fs.readFile(zip + '.sha256', 'utf8')).trim().split(/\s+/)[0];
  report.formalRuntimeZipSHA256 = checksum(await fs.readFile(zip));
  assert.equal(report.formalRuntimeZipSHA256, expected);
  await fs.mkdir(appDirectory);
  run('/usr/bin/ditto', ['-x', '-k', zip, appDirectory]);
  assert.equal(run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(originalApp, 'Contents/Info.plist')]), '2.0.0');
  assert.equal(run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(originalApp, 'Contents/Info.plist')]), 'com.bike.app');
  const appBefore = await treeDigest(originalApp);
  if (!providedBinary) {
    await buildSourceExporter();
    run(go, ['build', '-tags', 'mygo_noinspector,mygo_source_exporter', '-o', binary, './cmd/bike-mygo'], { cwd: path.join(root, 'desktop-mygo'), env: environment });
  }
  report.productIdentity = JSON.parse(run(binary, ['--version'], { env: nodeFree }));
  report.providedProductBinary = Boolean(providedBinary);
  run(go, ['build', '-o', interop, './cmd/bike-mygo-interop'], { cwd: path.join(root, 'desktop-mygo'), env: environment });
  assert.notEqual(spawnSync('/usr/bin/env', ['node', '--version'], { env: nodeFree }).status, 0);
  const library = createAttachmentService({ directory: path.join(profile, 'attachments') });
  const originals = [];
  for (const name of ['body', 'history', 'recovery', 'trash', 'audit', 'pre-attachment', 'pre-operation', 'prior-archive']) {
    const bytes = Buffer.from(`Electron profile original ${name} 中文🙂`);
    const filename = path.join(temporary, `${name}.bin`);
    await fs.writeFile(filename, bytes);
    const asset = await library.importFile(filename, `${name}.bin`);
    originals.push({ ...asset, bytes });
  }
  const document = (id, text, asset) => ({
    id, title: text, createdAt: at, updatedAt: at,
    attachments: { version: 1, items: { [asset.assetId]: asset.metadata } },
    nodes: [{ id: `node-${id}`, text, children: [], attachmentRefs: [{ assetId: asset.assetId, name: `${id}.bin` }] }],
  });
  const workspace = (text, asset = originals[0]) => migrateWorkspace({
    version: 3, activeDocumentId: 'doc', documents: [document('doc', text, asset)],
  });
  const body = workspace('Source body');
  body.trash = [{ id: 'trash-entry', document: document('trash', 'Trashed', originals[3]), originalIndex: 0, deletedAt: at }];
  const snapshot = loadTypescript('src/versionHistory.ts').createSnapshot(document('historical-orphan', 'Orphan history', originals[1]), 'manual', at);
  const recovery = workspace('Recovery only', originals[2]);
  const priorBody = workspace('Private prior archive', originals[7]);
  const prior = sealLocalMigration(priorBody, {
    format: 'bike-local-copy', version: 1, id: 'prior-copy', createdAt: at,
    source: { actorId: 'older-source', revision: 1, workspaceSha256: localMigrationDigest(priorBody) },
    history: [], recovery: [], recoveryFiles: [], preAttachment: null, preOperation: null,
    sourceAudit: { audit: [], outbox: [], receipts: {}, conflicts: [] }, archives: [], assets: [{ assetId: originals[7].assetId, metadata: originals[7].metadata }],
  }).localMigration;
  const replica = createReplicaState(body, 'original-source-actor');
  replica.audit = [{ id: 'source-audit', operation: { changes: [{ before: { assetId: originals[4].assetId } }] } }];
  replica.outbox = [{ id: 'source-unsent', changes: [] }];
  replica.receipts = { 'source-request': { status: 'committed' } };
  replica.conflicts = [{ id: 'source-conflict' }];
  const storageSource = await fs.readFile(path.join(root, 'src/storage.ts'), 'utf8');
  const key = (name) => storageSource.match(new RegExp(`const ${name} = "([^"]+)";`))[1];
  const values = {
    workspace: body, 'workspace-meta': { revision: 19, savedAt: Date.parse(at) + 60000 },
    [key('REPLICA_KEY')]: replica,
    [key('PRE_ATTACHMENT_KEY')]: workspace('Pre attachment', originals[5]),
    [key('PRE_OPERATION_KEY')]: workspace('Pre operation', originals[6]),
    [key('LOCAL_IMPORT_ARCHIVES')]: [prior],
  };
  application = await launchOriginal();
  let page = await application.firstWindow();
  await page.locator('.shell').waitFor();
  report.originalOrigin = await page.evaluate(() => ({ origin: location.origin, protocol: location.protocol }));
  await page.evaluate(async ({ values, snapshot, recovery, at }) => {
    async function put(database, storeName, entries) {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(database, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(storeName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        store.clear();
        for (const [key, value] of Object.entries(entries)) store.put(value, key);
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    }
    await put('bike-db', 'workspace-store', values);
    await put('bike-history-db', 'snapshots', { 'document:historical-orphan': [snapshot] });
    localStorage.clear();
    localStorage.setItem('bike-workspace-snapshot:source-recovery', JSON.stringify({ workspace: recovery, savedAt: at, baseRevision: 18, writer: 'source' }));
    localStorage.setItem('theme', 'dark');
    localStorage.setItem('bike.navigation.v1', JSON.stringify({ version: 1, favorites: ['doc'], recent: [], filters: [] }));
    localStorage.setItem('bike-ai-config', JSON.stringify({ endpoint: 'responses', baseUrl: 'https://provider.invalid/v1', model: 'source-model', apiKey: '{{SECRET_au7ccuwj}}' }));
    localStorage.setItem('bike-sync-config', JSON.stringify({ token: '{{SECRET_ey6hy4ow}}', autoSync: false }));
  }, { values, snapshot, recovery, at });
  // Reload the actual original application so its close barrier refers to the
  // seeded body and cannot flush the former empty UI over the source profile.
  await page.reload();
  await page.getByRole('button', { name: 'Source body', exact: true }).waitFor();
  await closeOriginal();
  const before = await treeDigest(profile);
  const legacyApp = path.join(root, 'release/mac-arm64/Bike.app');
  report.legacyRuntimeVersion = run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(legacyApp, 'Contents/Info.plist')]);
  assert.equal(report.legacyRuntimeVersion, '1.7.0');
  const legacy = spawnSync(binary, ['--export-electron-profile', '--electron-app', legacyApp, '--source-profile', profile, '--output', path.join(temporary, 'legacy.zip')], { env: nodeFree, encoding: 'utf8' });
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /2\.0\.0/);
  report.checks.legacyRuntimeRefused = true;
  const archive = path.join(temporary, 'full-copy.zip');
  report.defaultExport = JSON.parse(exportCLI(archive));
  const importedLibrary = path.join(temporary, 'imported-library');
  const imported = importGo(archive, importedLibrary);
  const exportedWorkspace = imported.workspace;
  const copy = readLocalMigration(exportedWorkspace);
  assert.equal(exportedWorkspace.documents[0].title, 'Source body');
  assert.equal(exportedWorkspace.trash[0].document.title, 'Trashed');
  assert.equal(copy.source.actorId, 'original-source-actor');
  assert.equal(copy.history[0].snapshots[0].document.title, 'Orphan history');
  assert.ok(copy.recovery.some((row) => row.workspace.documents[0].title === 'Recovery only'));
  assert.ok(copy.recoveryFiles.some((row) => row.content.includes('Recovery only')));
  assert.equal(copy.preAttachment.documents[0].title, 'Pre attachment');
  assert.equal(copy.preOperation.documents[0].title, 'Pre operation');
  assert.deepEqual(copy.sourceAudit.audit, replica.audit);
  assert.deepEqual(copy.sourceAudit.outbox, replica.outbox);
  assert.deepEqual(copy.sourceAudit.receipts, replica.receipts);
  assert.deepEqual(copy.sourceAudit.conflicts, replica.conflicts);
  assert.equal(copy.archives[0].id, 'prior-copy');
  assert.equal(copy.preferences, undefined);
  assert.equal(copy.credentials, undefined);
  assert.equal(copy.assets.length, originals.length);
  for (const original of originals) {
    const digest = original.assetId.slice(7);
    assert.deepEqual(await fs.readFile(path.join(importedLibrary, digest.slice(0, 2), digest)), original.bytes);
  }
  assert.equal(await treeDigest(profile), before);
  assert.equal(await treeDigest(originalApp), appBefore);
  report.checks = { ...report.checks, fullBody: true, orphanHistory: true, localStorageRecovery: true, trash: true, auditAndUnsent: true,
    preCopies: true, privatePriorArchive: true, originals: originals.length, credentialsDefaultOff: true,
    preferencesDefaultOff: true, sourceProfileUnchanged: true, sourceApplicationUnchanged: true };
  const selected = path.join(temporary, 'selected.zip');
  report.selectedExport = JSON.parse(exportCLI(selected, ['--include-preferences', '--include-credentials']));
  const selectedCopy = readLocalMigration(importGo(selected, path.join(temporary, 'selected-library')).workspace);
  assert.equal(selectedCopy.preferences.theme, 'dark');
  assert.deepEqual(JSON.parse(selectedCopy.preferences['bike.navigation.v1']).favorites, ['doc']);
  assert.equal(selectedCopy.preferences.ai.model, 'source-model');
  assert.equal(selectedCopy.credentials.aiApiKey, '{{SECRET_au7ccuwj}}');
  assert.ok(!JSON.stringify(selectedCopy).includes('{{SECRET_ey6hy4ow}}'));
  report.checks.preferencesAndAICredentialOptIn = true;
  report.checks.syncCredentialsExcluded = true;
  assert.equal(await treeDigest(profile), before);
  const protectedDestination = path.join(temporary, 'existing.zip');
  const sentinel = Buffer.from('existing destination must survive');
  await fs.writeFile(protectedDestination, sentinel);
  application = await launchOriginal();
  page = await application.firstWindow();
  await page.locator('.shell').waitFor();
  const active = spawnSync(binary, ['--export-electron-profile', '--electron-app', originalApp, '--source-profile', profile, '--output', protectedDestination], { env: nodeFree, encoding: 'utf8' });
  assert.notEqual(active.status, 0);
  assert.match(active.stderr, /Singleton/);
  assert.deepEqual(await fs.readFile(protectedDestination), sentinel);
  await closeOriginal();
  report.checks.activeProfileRefused = true;
  report.activeRefusal = active.stderr.trim();
  const afterActive = await treeDigest(profile);
  const dbDirectory = path.join(profile, 'IndexedDB');
  const databaseLock = (await fs.readdir(dbDirectory, { recursive: true })).find((name) => name.endsWith('/LOCK'));
  assert.ok(databaseLock);
  const handle = await fs.open(path.join(dbDirectory, databaseLock), 'r+');
  try {
    const opened = spawnSync(binary, ['--export-electron-profile', '--electron-app', originalApp, '--source-profile', profile, '--output', protectedDestination], { env: nodeFree, encoding: 'utf8' });
    assert.notEqual(opened.status, 0);
    assert.match(opened.stderr, /进程使用/);
    assert.deepEqual(await fs.readFile(protectedDestination), sentinel);
  } finally { await handle.close(); }
  assert.equal(await treeDigest(profile), afterActive);
  report.checks.openDatabaseWithoutSingletonRefused = true;
  const tempBefore = new Set(await fs.readdir(os.tmpdir()));
  const child = startExporter(protectedDestination);
  let childErrors = '';
  child.stderr.on('data', (value) => { childErrors += value; });
  const childClosed = new Promise((resolve) => child.once('close', (code) => resolve(code)));
  let ownedTemporary;
  for (let attempt = 0; attempt < 300; attempt++) {
    ownedTemporary = (await fs.readdir(os.tmpdir())).find((name) => name.startsWith('bike-source-export-') && !tempBefore.has(name));
    if (ownedTemporary) break;
    if (child.exitCode !== null) throw new Error(`Export ended before cancellation ${childErrors}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(ownedTemporary);
  child.kill('SIGTERM');
  assert.notEqual(await childClosed, 0);
  assert.deepEqual(await fs.readFile(protectedDestination), sentinel);
  await assert.rejects(fs.stat(path.join(os.tmpdir(), ownedTemporary)), { code: 'ENOENT' });
  assert.equal(await treeDigest(profile), afterActive);
  report.checks.cancellationPreservesExistingDestinationAndCleansTemporary = true;
  const raceBefore = new Set(await fs.readdir(os.tmpdir()));
  const racing = startExporter(protectedDestination);
  let raceErrors = '';
  racing.stderr.on('data', (value) => { raceErrors += value; });
  const racingClosed = new Promise((resolve) => racing.once('close', (code) => resolve(code)));
  for (let attempt = 0; attempt < 300; attempt++) {
    if ((await fs.readdir(os.tmpdir())).some((name) => name.startsWith('bike-source-export-') && !raceBefore.has(name))) break;
    if (racing.exitCode !== null) throw new Error(`Export ended before racing start ${raceErrors}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  application = await launchOriginal();
  assert.notEqual(await racingClosed, 0, 'Exporter succeeded while original source restarted');
  assert.deepEqual(await fs.readFile(protectedDestination), sentinel);
  await closeOriginal();
  report.checks.racingSourceStartRefused = true;
  report.racingStartRefusal = raceErrors.trim();
  const auditDigest = originals[4].assetId.slice(7);
  const auditPath = path.join(profile, 'attachments', auditDigest.slice(0, 2), auditDigest);
  await fs.writeFile(auditPath, Buffer.from('corrupt historical original'));
  const corruptBefore = await treeDigest(profile);
  const corrupt = spawnSync(binary, ['--export-electron-profile', '--electron-app', originalApp, '--source-profile', profile, '--output', protectedDestination], { env: nodeFree, encoding: 'utf8' });
  assert.notEqual(corrupt.status, 0);
  assert.deepEqual(await fs.readFile(protectedDestination), sentinel);
  assert.equal(await treeDigest(profile), corruptBefore);
  report.checks.corruptHistoricalOriginalFailsAtomically = true;
  report.corruptRefusal = corrupt.stderr.trim();
  assert.equal(await treeDigest(originalApp), appBefore);
  report.sourceProfileFingerprint = before;
  report.sourceApplicationFingerprint = appBefore;
  report.binarySHA256 = checksum(await fs.readFile(binary));
  report.payloadRendererSHA256 = checksum(await fs.readFile(path.join(root, 'desktop-mygo/internal/sourceexport/generated/renderer.js')));
  report.checks.nodeFreeCLI = true;
  report.checks.formalRuntimeChecksumVerified = true;
  await fs.writeFile(path.join(evidence, 'actual-electron-profile.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const child of runningChildren) {
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.kill('SIGTERM');
    await closed;
  }
  await closeOriginal();
  await fs.rm(temporary, { recursive: true, force: true });
}
