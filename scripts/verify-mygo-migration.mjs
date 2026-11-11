import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAttachmentService } from '../electron/attachment-service.cjs';
import { exportWorkspaceArchive, importWorkspaceArchive } from '../electron/workspace-archive.cjs';
import { migrateWorkspace } from '../mcp/bike-core.mjs';
import { createReplicaState } from '../shared/bike-replica.mjs';
import { localMigrationDigest, sealLocalMigration, withoutLocalMigration } from '../shared/bike-local-migration.mjs';
import { loadTypescript } from '../tests/helpers/typescript.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const option = (name, fallback) => process.argv.find((argument) => argument.startsWith(name + '='))?.slice(name.length + 1) ?? fallback;
const build = option('--build', process.env.BIKE_MYGO_BUILD ?? '1');
const channel = process.env.BIKE_MYGO_CHANNEL ?? 'preview';
const evidence = path.resolve(option('--output', path.join(root, 'docs/evidence-mygo-2026-11-11-integration/native-migration')));
const go = process.env.BIKE_MYGO_GO ?? 'go';
const environment = { ...process.env, GOTOOLCHAIN: 'local', GOEXPERIMENT: 'jsonv2', CGO_ENABLED: '0' };
const readyMarker = option('--ready-marker', '');
const lockPath = option('--gui-lock', path.join(os.tmpdir(), 'bike-mygo-native-acceptance.lock'));
const progressFile = option('--progress-file', path.join(evidence, 'progress.md'));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-mygo-migration-'));
const runDirectory = path.join(temporary, 'run');
const bundle = path.join(temporary, 'Bike MyGO Migration Acceptance.app');
const binary = path.join(bundle, 'Contents/MacOS/bike-mygo-migration');
const at = '2026-11-11T00:00:00.000Z';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const report = { build, host: { release: os.release(), architecture: os.arch() }, phases: [],
  automation: { userProfile: 'isolated fixture', input: 'DOM clicks in the actual WKWebView renderer',
    fileDialogs: 'diagnostic paths call production Go ImportArchive and ExportArchive', restoreConfirmation: 'diagnostic affirmative answers' },
  limitations: ['Physical macOS 12/13 remains unverified', 'Finder selection and real OS IME are outside this diagnostic'] };
let ownsLock = false;
let startedGUI = false;

function run(executable, arguments_, options = {}) {
  const result = spawnSync(executable, arguments_, { encoding: 'utf8', timeout: 120000, ...options });
  assert.equal(result.status, 0, `${executable} ${arguments_.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

async function frontendHash(directory) {
  const hash = createHash('sha256');
  for (const filename of (await fs.readdir(directory, { recursive: true })).sort()) {
    const absolute = path.join(directory, filename);
    if ((await fs.stat(absolute)).isFile()) hash.update(filename).update(await fs.readFile(absolute));
  }
  return hash.digest('hex');
}

async function fixture() {
  const sourceLibrary = createAttachmentService({ directory: path.join(temporary, 'source-library') });
  const assets = [];
  for (const name of ['body', 'history', 'recovery', 'trash', 'audit', 'pre-attachment', 'pre-operation', 'prior-archive']) {
    const bytes = Buffer.from(`native migration original ${name} 中文🙂`);
    const filename = path.join(temporary, name + '.bin');
    await fs.writeFile(filename, bytes);
    const item = await sourceLibrary.importFile(filename, name + '.bin');
    assets.push({ assetId: item.assetId, metadata: item.metadata, originalSHA256: digest(bytes) });
  }
  const document = (id, title, attachment) => ({
    id, title, createdAt: at, updatedAt: at,
    ...(attachment ? { attachments: { version: 1, items: { [attachment.assetId]: attachment.metadata } } } : {}),
    nodes: [{ id: 'node-' + id, text: title, note: '原生本机完整副本 中文🙂', children: [],
      ...(attachment ? { attachmentRefs: [{ assetId: attachment.assetId, name: id + '.bin' }] } : {}) }],
  });
  const workspace = (title, attachment = assets[0], id = 'native-source-doc') =>
    migrateWorkspace({ version: 3, activeDocumentId: id, documents: [document(id, title, attachment)] });
  let body = workspace('原生完整导入源正文');
  body.documents[0].nativeExtension = { z: String.fromCharCode(0xd800), a: ['中文🙂', String.fromCharCode(0xdc00)] };
  body.trash = [{ id: 'native-trash', document: document('trashed-native', '源回收站文档', assets[3]), originalIndex: 0, deletedAt: at }];
  // An actual source profile has already normalized both live and trashed
  // documents. Seal the same stable renderer shape in this synthetic fixture.
  const rendererMigration = loadTypescript('src/migrations.ts').migrateWorkspace;
  body = rendererMigration(body);
  const history = loadTypescript('src/versionHistory.ts');
  const currentHistory = history.createSnapshot(document('native-source-doc', '导入前的源历史', assets[1]), 'manual', at);
  const orphanHistory = history.createSnapshot(document('orphan-native', '源孤立历史', assets[1]), 'manual', at);
  const recovery = workspace('导入的源备用副本', assets[2]);
  const priorBody = workspace('源私有旧档案', assets[7]);
  const prior = sealLocalMigration(priorBody, {
    format: 'bike-local-copy', version: 1, id: 'older-native-copy', createdAt: at,
    source: { actorId: 'older-native-source', revision: 1, workspaceSha256: localMigrationDigest(priorBody) },
    history: [], recovery: [], recoveryFiles: [], preAttachment: null, preOperation: null,
    sourceAudit: { audit: [], outbox: [], receipts: {}, conflicts: [] }, archives: [], assets: [{ assetId: assets[7].assetId, metadata: assets[7].metadata }],
  }).localMigration;
  const copy = {
    format: 'bike-local-copy', version: 1, id: 'native-source-complete-copy', createdAt: at,
    source: { actorId: 'native-source-actor', revision: 19, workspaceSha256: localMigrationDigest(body) },
    history: [{ documentId: 'native-source-doc', snapshots: [currentHistory] }, { documentId: 'orphan-native', snapshots: [orphanHistory] }],
    recovery: [{ id: 'native-source-recovery', workspace: recovery, savedAt: Date.parse(at), baseRevision: 18 }],
    recoveryFiles: [{ id: 'native-source-recovery-file', content: JSON.stringify(recovery) }],
    preAttachment: workspace('源附件升级前副本', assets[5]), preOperation: workspace('源操作升级前副本', assets[6]),
    sourceAudit: { audit: [{ id: 'source-audit', operation: { changes: [{ before: { assetId: assets[4].assetId } }] } }],
      outbox: [{ id: 'source-unsent', changes: [] }], receipts: { 'source-request': { status: 'committed' } }, conflicts: [{ id: 'source-conflict' }] },
    archives: [prior], assets: assets.map(({ assetId, metadata }) => ({ assetId, metadata })),
    preferences: { theme: 'dark', ai: { endpoint: 'responses', baseUrl: 'https://source.invalid/v1', model: 'source-model' } },
    credentials: { aiApiKey: 'native-test-source-value' },
  };
  const full = sealLocalMigration(body, copy);
  assert.equal(localMigrationDigest(rendererMigration(withoutLocalMigration(full))), copy.source.workspaceSha256);
  await exportWorkspaceArchive({ workspace: full, filename: path.join(runDirectory, 'source-full-copy.zip'), attachments: sourceLibrary, migrate: (value) => value });
  const destination = migrateWorkspace({ version: 3, activeDocumentId: 'native-destination-doc',
    documents: [document('native-destination-doc', '原生导入前正文')] });
  const storageSource = await fs.readFile(path.join(root, 'src/storage.ts'), 'utf8');
  const key = (name) => {
    const matched = storageSource.match(new RegExp(`const ${name} = "([^"]+)";`));
    assert.ok(matched, `Missing storage key ${name}`);
    return matched[1];
  };
  const historySource = await fs.readFile(path.join(root, 'src/versionHistory.ts'), 'utf8');
  const value = {
    body: withoutLocalMigration(full), sourceActor: copy.source.actorId, copyId: copy.id, documentId: body.documents[0].id, nodeId: body.documents[0].nodes[0].id,
    assets, historyId: currentHistory.id, historyTitle: currentHistory.title, orphanHistoryId: orphanHistory.id,
    recoveryTitle: recovery.documents[0].title, destination, destinationActor: 'native-destination-actor',
    destinationReplica: createReplicaState(destination, 'native-destination-actor'),
    destinationHistory: history.createSnapshot(destination.documents[0], 'manual', at),
    keys: { replica: key('REPLICA_KEY'), archives: key('LOCAL_IMPORT_ARCHIVES'), journal: key('LOCAL_IMPORT_JOURNAL'),
      receipts: key('LOCAL_IMPORT_RECEIPTS'), historyJournal: historySource.match(/const MIGRATION_KEY = "([^"]+)";/)[1] },
  };
  await fs.writeFile(path.join(runDirectory, 'fixture.json'), JSON.stringify(value));
  report.fixture = { sourceActor: value.sourceActor, documents: body.documents.length, originals: assets.length,
    sourceArchiveSHA256: digest(await fs.readFile(path.join(runDirectory, 'source-full-copy.zip'))), workspaceSHA256: copy.source.workspaceSha256,
    unicodeExtension: 'isolated UTF-16 high/low surrogates and object property order' };
}

async function waitForGUI() {
  const deadline = Date.now() + 3600000;
  while (Date.now() < deadline) {
    try {
      if (readyMarker) await fs.access(readyMarker);
      const lock = await fs.open(lockPath, 'wx', 0o600);
      await lock.writeFile(JSON.stringify({ task: 'native-migration', pid: process.pid, startedAt: new Date().toISOString() }));
      await lock.close();
      ownsLock = true;
      return;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  throw new Error('Timed out waiting for the native acceptance marker or GUI lock');
}

function phase(mode) {
  startedGUI = true;
  const result = spawnSync(binary, ['--mode', mode, '--output', runDirectory], {
    encoding: 'utf8', timeout: 105000, killSignal: 'SIGKILL', env: { ...process.env, PATH: '/usr/bin:/bin', MYGO_ENV: 'development' },
  });
  return fs.writeFile(path.join(evidence, mode + '.log'), (result.stdout ?? '') + (result.stderr ?? '')).then(async () => {
    assert.equal(result.status, 0, `${mode} native process failed\n${result.stderr}`);
    const value = JSON.parse(await fs.readFile(path.join(runDirectory, 'result-' + mode + '.json')));
    await fs.writeFile(path.join(evidence, 'result-' + mode + '.json'), JSON.stringify(value, null, 2) + '\n');
    assert.equal(value.failure, undefined, `${mode} renderer failed\n${value.failure}\n${value.stack}\n${value.uiText}`);
    assert.equal(value.origin, 'mygo://localhost');
    assert.equal(value.production, true);
    if (mode !== 'cleanup') {
      assert.deepEqual(value.errors, []);
      assert.deepEqual(value.csp, []);
      report.phases.push(value);
    }
    return value;
  });
}

try {
  await fs.mkdir(evidence, { recursive: true });
  await fs.mkdir(runDirectory);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'release/mygo/2.0.0', `build-${build}-${channel}/build-manifest.json`)));
  const staged = path.join(root, 'desktop-mygo/internal/frontend/dist');
  assert.equal(await frontendHash(staged), manifest.frontendSHA256, 'Staged frontend differs from the product candidate');
  report.sourceFingerprint = manifest.sourceFingerprint;
  report.frontendSHA256 = manifest.frontendSHA256;
  await fixture();
  await fs.mkdir(path.dirname(binary), { recursive: true });
  const identifier = 'com.bike.mygo.preview.migration-acceptance';
  await fs.writeFile(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleName</key><string>Bike MyGO Migration Acceptance</string><key>CFBundleExecutable</key><string>bike-mygo-migration</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>12.0</string></dict></plist>\n`);
  run(go, ['build', '-mod=readonly', '-trimpath', '-tags', 'mygo_noinspector,mygo_frontend',
    '-ldflags', `-s -w -X github.com/egoist/mygo.production=1 -X github.com/egoist/mygo.packageIdentifier=${identifier} -X github.com/egoist/mygo.packageVersion=2.0.0`,
    '-o', binary, './cmd/bike-mygo-migration-acceptance'], { cwd: path.join(root, 'desktop-mygo'), env: environment });
  run('/usr/bin/codesign', ['--force', '--sign', '-', bundle]);
  report.binarySHA256 = digest(await fs.readFile(binary));
  await fs.writeFile(progressFile, `Harness compiled for build ${build}. Waiting for the configured readiness marker and shared GUI lock. No GUI started. Evidence directory ${evidence}.\n`);
  await waitForGUI();
  assert.equal(await frontendHash(staged), manifest.frontendSHA256, 'Frontend changed before native acceptance');
  await phase('seed');
  const imported = await phase('import');
  const importBackups = (await fs.readdir(path.join(runDirectory, 'backups'))).filter((name) => name.startsWith('import-'));
  assert.equal(importBackups.length, 1, 'Preview cancel or duplicate import produced another backup');
  const restarted = await phase('verify');
  assert.equal(restarted.actor, imported.actor);
  await phase('seed-recovery');
  const recovered = await phase('verify-recovery');
  assert.equal(recovered.actor, imported.actor);
  const restored = await phase('restore');
  const restoredRestart = await phase('verify-restored');
  assert.equal(restored.actor, imported.actor);
  assert.equal(restoredRestart.actor, imported.actor);
  const backupFiles = await fs.readdir(path.join(runDirectory, 'backups'));
  assert.equal(backupFiles.filter((name) => name.startsWith('restore-')).length, 2, 'Source recovery did not preserve current and saved backups');
  const backupLibrary = createAttachmentService({ directory: path.join(temporary, 'verified-backup-library') });
  const currentBackup = await importWorkspaceArchive({ filename: path.join(runDirectory, 'backups', importBackups[0]), attachments: backupLibrary, migrate: (value) => value });
  assert.equal(currentBackup.workspace.documents[0].title, '原生导入前正文');
  assert.ok(currentBackup.workspace.localMigration?.history.length > 0);
  report.currentBackup = { completeCopy: true, destinationBodyAndHistory: true,
    sha256: digest(await fs.readFile(path.join(runDirectory, 'backups', importBackups[0]))) };
  const downloads = await fs.readdir(path.join(runDirectory, 'downloads'));
  const sourceRecord = downloads.find((name) => name.startsWith('bike-source-') && name.endsWith('.json'));
  assert.ok(sourceRecord, 'Readonly source record was not downloaded');
  const downloaded = JSON.parse(await fs.readFile(path.join(runDirectory, 'downloads', sourceRecord)));
  assert.equal(downloaded.id, 'native-source-complete-copy');
  assert.equal(downloaded.credentials, undefined);
  assert.equal(downloaded.sourceAudit.outbox[0].id, 'source-unsent');
  report.readonlySourceDownload = { verified: true, sourceAudit: true, credentialsExcluded: true };
  report.originalHashes = [];
  const expected = JSON.parse(await fs.readFile(path.join(runDirectory, 'fixture.json')));
  for (const asset of expected.assets) {
    const hash = asset.assetId.slice(7);
    const original = await fs.readFile(path.join(runDirectory, 'profile/attachments', hash.slice(0, 2), hash));
    assert.equal(digest(original), asset.originalSHA256);
    report.originalHashes.push({ assetId: asset.assetId, sha256: digest(original), byteLength: original.length });
  }
  await fs.cp(path.join(runDirectory, 'captures'), path.join(evidence, 'captures'), { recursive: true });
  report.complete = true;
  await fs.writeFile(path.join(evidence, 'native-migration.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(progressFile, `PASS build ${build}. Actual WKWebView UI import/cancel/confirm, complete pre-import backup, eight originals, body/trash/history/recovery/private audit, new actor/empty outbox/offline defaults, duplicate refusal, restart, installed-journal recovery, version and recovery UI restores all verified. Evidence ${evidence}/native-migration.json.\n`);
  console.log(JSON.stringify({ complete: true, evidence, phases: report.phases.length, originals: report.originalHashes.length }, null, 2));
} finally {
  try { await fs.cp(path.join(runDirectory, 'captures'), path.join(evidence, 'captures'), { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') console.error('Capture preservation failed', String(error)); }
  if (startedGUI) {
    try { await phase('cleanup'); } catch (error) { console.error('Isolated session cleanup failed', String(error)); }
  }
  if (ownsLock) await fs.rm(lockPath, { force: true });
  await fs.rm(temporary, { recursive: true, force: true });
}
