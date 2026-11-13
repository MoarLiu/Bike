import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { createAttachmentService } from '../electron/attachment-service.cjs';
import { createAttachmentSync } from '../electron/attachment-sync.cjs';
import { exportWorkspaceArchive, importWorkspaceArchive } from '../electron/workspace-archive.cjs';
import { migrateWorkspace } from '../mcp/bike-core.mjs';
import { createSecretHash } from '../server/password.mjs';
import { createReplicaState, recordReplicaCommit } from '../shared/bike-replica.mjs';
import { localMigrationAttachmentAssets, localMigrationDigest, readLocalMigration, sealLocalMigration } from '../shared/bike-local-migration.mjs';
import { loadTypescript } from '../tests/helpers/typescript.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-mygo-interop-'));
const product = JSON.parse(await fs.readFile(path.join(root, 'desktop-mygo/internal/product/product.json')));
const go = process.env.BIKE_MYGO_GO ?? 'go';
const environment = { ...process.env, GOTOOLCHAIN: 'local', GOEXPERIMENT: product.goExperiment, CGO_ENABLED: '0' };
const binary = path.join(temporary, 'bike-mygo-interop');
const report = { go: product.go, node: process.version, nodeFreeGoPath: '/usr/bin:/bin', archive: [], sync: [] };
let serverChild;
let proxy;
let serverOutput = '';
const previousWindow = globalThis.window;
// Cross-process JSON omits undefined object properties in the JS migration.
const jsonValue = (value) => JSON.parse(JSON.stringify(value));

function runGo(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { env: { PATH: report.nodeFreeGoPath }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const deadline = setTimeout(() => child.kill('SIGKILL'), 100_000);
    child.once('error', reject);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.once('close', (code) => {
      clearTimeout(deadline);
      if (code !== 0) reject(new Error(errors || `Go helper exited with ${code}`));
      else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } }
    });
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify(input));
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const deadline = setTimeout(() => { child.kill('SIGKILL'); }, 2000);
    child.once('exit', () => { clearTimeout(deadline); resolve(); });
    child.kill('SIGTERM');
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(configPath, serverUrl) {
  serverChild = spawn(process.execPath, ['server/sync-server.mjs'], {
    cwd: root, env: { ...process.env, BIKE_SYNC_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverChild.stdout.on('data', (chunk) => { serverOutput += chunk; });
  serverChild.stderr.on('data', (chunk) => { serverOutput += chunk; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (serverChild.exitCode !== null) throw new Error(serverOutput);
    try {
      if ((await fetch(`${serverUrl}/healthz`, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch { /* The child is still binding its port. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Sync server did not start. ${serverOutput}`);
}

async function zipEntries(filename) {
  const zip = await yauzl.openPromise(filename, { lazyEntries: true });
  const entries = [];
  try {
    for await (const entry of zip.eachEntry()) {
      const chunks = [];
      for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk);
      entries.push({ name: entry.fileName, bytes: Buffer.concat(chunks) });
    }
  } finally { zip.close(); }
  return entries;
}

async function writeZip(filename, entries) {
  const zip = new yazl.ZipFile();
  const writing = pipeline(zip.outputStream, createWriteStream(filename));
  for (const entry of entries) zip.addBuffer(entry.bytes, entry.name, { mode: entry.mode ?? 0o100600 });
  zip.end();
  await writing;
}

try {
  const version = spawnSync(go, ['env', 'GOVERSION'], { env: environment, encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), product.go, 'Use the pinned toolchain through BIKE_MYGO_GO');
  const build = spawnSync(go, ['build', '-mod=readonly', '-o', binary, './cmd/bike-mygo-interop'], {
    cwd: path.join(root, 'desktop-mygo'), env: environment, encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr);
  assert.notEqual(spawnSync('/usr/bin/env', ['node', '--version'], { env: { PATH: report.nodeFreeGoPath } }).status, 0);
  const jsLibrary = createAttachmentService({ directory: path.join(temporary, 'js-library') });
  const fixtures = [
    { name: '原件🙂.bin', bytes: randomBytes(2 * 1024 * 1024 + 73) },
    { name: '空.txt', bytes: Buffer.alloc(0) },
    { name: '文档.pdf', bytes: Buffer.from('%PDF-1.7\n中文🙂') },
    { name: '像素.png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9eUAAAAASUVORK5CYII=', 'base64') },
  ];
  const assets = [];
  for (const fixture of fixtures) assets.push(await jsLibrary.putBytes(fixture.bytes, fixture.name));
  const stamp = '2026-11-11T00:00:00.000Z';
  const document = { id: 'interop-doc', title: '互通中文🙂', createdAt: stamp, updatedAt: stamp,
    nodes: [{ id: 'node-a', text: 'A', children: [], attachmentRefs: assets.map(({ assetId, name }) => ({ assetId, name })) }, { id: 'node-b', text: 'B', children: [] }],
    attachments: { version: 1, items: Object.fromEntries(assets.map(({ assetId, metadata }) => [assetId, metadata])) } };
  let goLibrary;
  let goArchive;
  let workspace;
  for (const version of [1, 2, 3]) {
    const doc = structuredClone(document);
    if (version === 1) { delete doc.attachments; delete doc.nodes[0].attachmentRefs; }
    const expected = jsonValue(migrateWorkspace({ version, activeDocumentId: doc.id, documents: [doc],
      trash: [{ id: 'trash-entry', document: { ...doc, id: 'trash-doc' }, deletedAt: stamp, originalIndex: 0 }] }));
    expected.opaqueScalar = String.fromCharCode(0xd800);
    const jsArchive = path.join(temporary, `js-v${version}.zip`);
    await exportWorkspaceArchive({ workspace: expected, filename: jsArchive, attachments: jsLibrary, migrate: migrateWorkspace, readable: { name: 'document.md', content: '# 互通中文🙂' } });
    goLibrary = path.join(temporary, `go-library-v${version}`);
    const imported = await runGo({ action: 'importArchive', filename: jsArchive, directory: goLibrary });
    assert.deepEqual(imported.workspace, expected);
    assert.equal(imported.attachmentCount, version === 1 ? 0 : assets.length);
    goArchive = path.join(temporary, `go-v${version}.zip`);
    await runGo({ action: 'exportArchive', filename: goArchive, workspace: expected, directory: goLibrary, readable: { name: 'index.html', content: '<h1>互通中文🙂</h1>' } });
    const restored = createAttachmentService({ directory: path.join(temporary, `js-restored-v${version}`) });
    const result = await importWorkspaceArchive({ filename: goArchive, attachments: restored, migrate: migrateWorkspace });
    assert.deepEqual(jsonValue(result.workspace), expected);
    if (version !== 1) {
      for (let index = 0; index < assets.length; index++) {
        assert.deepEqual(await restored.read(assets[index].assetId, assets[index].metadata), fixtures[index].bytes);
        assert.deepEqual(await runGo({ action: 'inspect', directory: goLibrary, assetId: assets[index].assetId }), { assetId: assets[index].assetId, metadata: assets[index].metadata });
      }
    }
    workspace = expected;
    report.archive.push({ version, jsToGo: true, goToJs: true, trash: true, verifiedAttachmentCount: imported.attachmentCount });
  }
  const damagedObject = path.join(goLibrary, assets[0].assetId.slice(7, 9), assets[0].assetId.slice(7));
  const damagedBytes = Buffer.from('corrupted local original');
  await fs.writeFile(damagedObject, damagedBytes);
  await runGo({ action: 'importArchive', filename: path.join(temporary, 'js-v3.zip'), directory: goLibrary });
  const retained = (await fs.readdir(goLibrary)).filter((name) => name.startsWith('.corrupt-'));
  assert.equal(retained.length, 1);
  assert.deepEqual(await fs.readFile(path.join(goLibrary, retained[0])), damagedBytes);
  assert.deepEqual(await runGo({ action: 'inspect', directory: goLibrary, assetId: assets[0].assetId }), { assetId: assets[0].assetId, metadata: assets[0].metadata });
  report.archive.push({ corruptLocalObjectRepaired: true, damagedBytesPreserved: true });
  const entries = await zipEntries(goArchive);
  for (const kind of ['corrupt-last-asset', 'duplicate', 'symlink', 'null-assets']) {
    const malformed = entries.map((entry) => ({ ...entry }));
    if (kind === 'corrupt-last-asset') {
      const last = malformed.findLast((entry) => entry.name.startsWith('attachments/') && entry.bytes.length);
      last.bytes = Buffer.alloc(last.bytes.length);
    } else if (kind === 'duplicate') malformed.push({ ...malformed[0] });
    else if (kind === 'symlink') malformed.find((entry) => entry.name === 'workspace.json').mode = 0o120777;
    else {
      const manifest = malformed.find((entry) => entry.name === 'manifest.json');
      manifest.bytes = Buffer.from(JSON.stringify({ ...JSON.parse(manifest.bytes), assets: null }));
    }
    const filename = path.join(temporary, `${kind}.zip`);
    const directory = path.join(temporary, `${kind}-library`);
    await writeZip(filename, malformed);
    await assert.rejects(runGo({ action: 'importArchive', filename, directory }), /归档/);
    await assert.rejects(fs.access(directory), { code: 'ENOENT' });
    report.archive.push({ rejected: kind, nothingInstalled: true });
  }

  const historicalFixtures = ['history', 'recovery', 'archived', 'audit', 'pre-attachment', 'pre-operation', 'archived-index-only'].map((name) => ({
    name: `${name}-only.bin`, bytes: Buffer.from(`retained original ${name} 中文🙂`),
  }));
  const historicalAssets = [];
  for (const fixture of historicalFixtures) historicalAssets.push(await jsLibrary.putBytes(fixture.bytes, fixture.name));
  const historicalWorkspace = (asset, id) => jsonValue(migrateWorkspace({ version: 3, activeDocumentId: id, documents: [{
    ...document, id, nodes: [{ id: `${id}-node`, text: id, children: [], attachmentRefs: [{ assetId: asset.assetId, name: asset.name }] }],
    attachments: { version: 1, items: { [asset.assetId]: asset.metadata } },
  }] }));
  const makeCopy = (body, id, indexed, extra = {}) => ({
    format: 'bike-local-copy', version: 1, id, createdAt: stamp,
    source: { actorId: 'source-electron-actor', revision: 19, workspaceSha256: localMigrationDigest(body) },
    history: [], recovery: [], recoveryFiles: [], preAttachment: null, preOperation: null,
    sourceAudit: { audit: [], outbox: [], receipts: {}, conflicts: [] }, archives: [], assets: indexed, ...extra,
  });
  const archivedBody = historicalWorkspace(historicalAssets[2], 'archived-document');
  // These originals survive solely in the nested archive's asset index. The
  // outer index must be excluded from closure, while this nested index counts.
  archivedBody.archivedExtension = { [historicalAssets[6].assetId]: historicalAssets[6].metadata };
  const archivedCopy = sealLocalMigration(archivedBody, makeCopy(archivedBody, 'previous-copy', [historicalAssets[2], historicalAssets[6]])).localMigration;
  const copyBody = { ...structuredClone(workspace), futureExtension: {
    z: String.fromCharCode(0xd800), '￿': 'BMP', '𐀀': 'astral 中文🙂', '10': 1e21, '2': -0, exponent: 1e-7, safe: Number.MAX_SAFE_INTEGER, optional: null,
  } };
  copyBody.documents[0].nodes[1].text = `sha256:${'f'.repeat(64)}`;
  copyBody.futureExtension[`sha256:${'e'.repeat(64)}`] = 'plain user text';
  const historyWorkspace = historicalWorkspace(historicalAssets[0], 'orphan-history');
  const recoveryWorkspace = historicalWorkspace(historicalAssets[1], 'recovery-document');
  const completeAssets = [...assets, ...historicalAssets].map(({ assetId, metadata }) => ({ assetId, metadata }));
  // Extension properties on metadata are inert and checksum-covered too.
  completeAssets.at(-1).metadata = { ...completeAssets.at(-1).metadata, futureExtension: { z: String.fromCharCode(0xdfff), omittedDimension: true } };
  const completeWorkspace = jsonValue(sealLocalMigration(copyBody, makeCopy(copyBody, 'complete-copy', completeAssets, {
    history: [{ documentId: 'orphan-history', snapshots: [{ id: 'old-snapshot', document: historyWorkspace.documents[0], reason: 'manual', createdAt: stamp }] }],
    recovery: [{ id: 'saved-recovery', workspace: recoveryWorkspace, savedAt: Date.parse(stamp), baseRevision: null }],
    recoveryFiles: [{ id: 'raw-recovery', content: JSON.stringify(recoveryWorkspace) }],
    preAttachment: historicalWorkspace(historicalAssets[4], 'pre-attachment-document'),
    preOperation: historicalWorkspace(historicalAssets[5], 'pre-operation-document'),
    sourceAudit: { audit: [{ id: 'retained-audit', before: historicalAssets[3] }], outbox: [], receipts: {}, conflicts: [] },
    archives: [archivedCopy], preferences: { theme: 'dark', ai: { endpoint: 'responses', model: 'fixture-model' } },
    credentials: { aiApiKey: 'local-interop-explicit-key' },
    futureExtension: { unknownProperties: ['retained', null, 1.5, String.fromCharCode(0xd800)] },
  })));
  const jsCompleteArchive = path.join(temporary, 'js-complete-copy.zip');
  await exportWorkspaceArchive({ workspace: completeWorkspace, filename: jsCompleteArchive, attachments: jsLibrary, migrate: migrateWorkspace });
  const completeLibrary = path.join(temporary, 'go-complete-copy-library');
  const completeImport = await runGo({ action: 'importArchive', filename: jsCompleteArchive, directory: completeLibrary });
  assert.deepEqual(completeImport.workspace, completeWorkspace);
  assert.equal(readLocalMigration(completeImport.workspace).id, 'complete-copy');
  assert.equal(completeImport.attachmentCount, completeAssets.length);
  const goCompleteArchive = path.join(temporary, 'go-complete-copy.zip');
  await runGo({ action: 'exportArchive', workspace: completeImport.workspace, filename: goCompleteArchive, directory: completeLibrary });
  const completeRestored = createAttachmentService({ directory: path.join(temporary, 'js-complete-copy-restored') });
  const restoredComplete = await importWorkspaceArchive({ filename: goCompleteArchive, attachments: completeRestored, migrate: migrateWorkspace });
  assert.deepEqual(jsonValue(restoredComplete.workspace), completeWorkspace);
  assert.deepEqual(localMigrationAttachmentAssets(restoredComplete.workspace), localMigrationAttachmentAssets(completeWorkspace));
  for (let index = 0; index < historicalAssets.length; index++) {
    const asset = historicalAssets[index];
    assert.deepEqual(await completeRestored.read(asset.assetId, asset.metadata), historicalFixtures[index].bytes);
    assert.deepEqual(await runGo({ action: 'inspect', directory: completeLibrary, assetId: asset.assetId }), { assetId: asset.assetId, metadata: asset.metadata });
  }
  const goCompleteEntries = await zipEntries(goCompleteArchive);
  const archivedJson = goCompleteEntries.find((entry) => entry.name === 'workspace.json').bytes.toString('utf8');
  assert.equal(archivedJson.includes(String.fromCharCode(92) + 'ud800'), true);
  assert.deepEqual(Object.keys(JSON.parse(archivedJson).localMigration), Object.keys(completeWorkspace.localMigration));
  report.archive.push({ fullLocalCopy: true, jsToGo: true, goToJs: true, verifiedAttachmentCount: completeAssets.length,
    historyOnly: true, recoveryOnly: true, archivedOnly: true, nestedArchiveIndexOnly: true, auditOnly: true, preMigrationOnly: true,
    canonicalUnicodeNumbersOptionalFields: true, unknownExtensionsAndPropertyOrder: true });

  const resealCopy = (value) => {
    const { localMigration, ...body } = value;
    localMigration.source.workspaceSha256 = localMigrationDigest(body);
    const { contentSha256: _checksum, ...contents } = localMigration;
    localMigration.contentSha256 = localMigrationDigest({ workspace: body, localMigration: contents });
  };
  const malformedCopies = {
    'source-checksum': (value) => { value.documents[0].title = 'changed source'; },
    'content-checksum': (value) => { value.localMigration.futureExtension.unknownProperties.push('tampered'); },
    'missing-content-checksum': (value) => { delete value.localMigration.contentSha256; },
    'missing-history': (value) => { delete value.localMigration.history; resealCopy(value); },
    'nested-copy-shape': (value) => { value.localMigration.archives[0].sourceAudit.receipts = []; resealCopy(value); },
    'pre-copy-document-array': (value) => { value.localMigration.preOperation.documents = {}; resealCopy(value); },
    'duplicate-history': (value) => { value.localMigration.history.push(value.localMigration.history[0]); resealCopy(value); },
    'unknown-preference': (value) => { value.localMigration.preferences.sync = {}; resealCopy(value); },
    'audit-active-token': (value) => { value.localMigration.sourceAudit.token = 'inert-fixture-token'; resealCopy(value); },
    'missing-historical-asset': (value) => { value.localMigration.assets = value.localMigration.assets.filter(({ assetId }) => assetId !== historicalAssets[0].assetId); resealCopy(value); },
    'extra-index-only-asset': (value) => { value.localMigration.assets.push({ assetId: `sha256:${'a'.repeat(64)}`, metadata: { mediaType: 'application/octet-stream', byteLength: 3 } }); resealCopy(value); },
    'duplicate-asset-index': (value) => { value.localMigration.assets.push(value.localMigration.assets[0]); resealCopy(value); },
    'historical-metadata-collision': (value) => { value.localMigration.history[0].snapshots[0].document.attachments.items[historicalAssets[0].assetId].byteLength++; resealCopy(value); },
    'null-optional-dimension': (value) => { value.localMigration.assets[0].metadata.width = null; resealCopy(value); },
  };
  const rejectionLibrary = path.join(temporary, 'go-complete-copy-rejections');
  const sentinelFile = path.join(temporary, 'sentinel-original.bin');
  const sentinelBytes = Buffer.from('existing destination original must survive');
  await fs.writeFile(sentinelFile, sentinelBytes);
  const sentinel = await runGo({ action: 'import', filename: sentinelFile, directory: rejectionLibrary });
  const treeState = async (directory, prefix = '') => {
    const result = [];
    for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = path.join(prefix, item.name);
      if (item.isDirectory()) result.push(...await treeState(path.join(directory, item.name), relative));
      else result.push({ path: relative, sha256: createHash('sha256').update(await fs.readFile(path.join(directory, item.name))).digest('hex') });
    }
    return result;
  };
  const beforeRejections = await treeState(rejectionLibrary);
  for (const [kind, mutate] of Object.entries(malformedCopies)) {
    const value = structuredClone(completeWorkspace);
    mutate(value);
    assert.throws(() => readLocalMigration(value), /完整本机副本|附件|iterable/);
    const malformed = goCompleteEntries.map((entry) => ({ ...entry }));
    const workspaceEntry = malformed.find((entry) => entry.name === 'workspace.json');
    workspaceEntry.bytes = Buffer.from(JSON.stringify(value, null, 2) + String.fromCharCode(10));
    const manifestEntry = malformed.find((entry) => entry.name === 'manifest.json');
    const manifest = JSON.parse(manifestEntry.bytes);
    manifest.workspaceSha256 = createHash('sha256').update(workspaceEntry.bytes).digest('hex');
    manifestEntry.bytes = Buffer.from(JSON.stringify(manifest));
    const filename = path.join(temporary, `full-copy-${kind}.zip`);
    await writeZip(filename, malformed);
    const pristineLibrary = path.join(temporary, `full-copy-${kind}-pristine`);
    await assert.rejects(runGo({ action: 'importArchive', filename, directory: pristineLibrary }));
    await assert.rejects(fs.access(pristineLibrary), { code: 'ENOENT' });
    await assert.rejects(runGo({ action: 'importArchive', filename, directory: rejectionLibrary }));
    assert.deepEqual(await treeState(rejectionLibrary), beforeRejections);
    const jsRejected = createAttachmentService({ directory: path.join(temporary, `js-rejected-${kind}`) });
    let installed = 0;
    jsRejected.importFile = async () => { installed++; throw new Error('invalid complete copy reached live installation'); };
    await assert.rejects(importWorkspaceArchive({ filename, attachments: jsRejected, migrate: migrateWorkspace }));
    assert.equal(installed, 0);
    // Failed export must preserve the selected pre-existing destination too.
    const exportTarget = path.join(temporary, `rejected-export-${kind}.zip`);
    await fs.writeFile(exportTarget, sentinelBytes);
    await assert.rejects(runGo({ action: 'exportArchive', filename: exportTarget, workspace: value, directory: completeLibrary }));
    assert.deepEqual(await fs.readFile(exportTarget), sentinelBytes);
    report.archive.push({ fullLocalCopyRejected: kind, goAndJsRejected: true, nothingInstalled: true, existingFilesPreserved: true });
  }
  assert.deepEqual(await runGo({ action: 'inspect', directory: rejectionLibrary, assetId: sentinel.assetId }), { assetId: sentinel.assetId, metadata: sentinel.metadata });
  const damagedHistoricalEntries = goCompleteEntries.map((entry) => ({ ...entry }));
  const damagedHistorical = damagedHistoricalEntries.find((entry) => entry.name === `attachments/${historicalAssets[2].assetId.slice(7)}`);
  damagedHistorical.bytes = Buffer.alloc(damagedHistorical.bytes.length);
  const damagedHistoricalArchive = path.join(temporary, 'full-copy-damaged-history-original.zip');
  await writeZip(damagedHistoricalArchive, damagedHistoricalEntries);
  await assert.rejects(runGo({ action: 'importArchive', filename: damagedHistoricalArchive, directory: rejectionLibrary }), /归档附件/);
  assert.deepEqual(await treeState(rejectionLibrary), beforeRejections);
  report.archive.push({ fullLocalCopyRejected: 'corrupt-archived-only-original', nothingInstalled: true, existingFilesPreserved: true });

  const port = await freePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const token = 'bike-mygo-interop-local-fixture';
  const databasePath = path.join(temporary, 'sync.sqlite');
  const configPath = path.join(temporary, 'sync-config.json');
  await fs.writeFile(configPath, JSON.stringify({ host: '127.0.0.1', port, databasePath,
    deviceTokenHashes: [createSecretHash(token, { iterations: 100000 })] }), { mode: 0o600 });
  await startServer(configPath, serverUrl);
  const requests = [];
  proxy = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    const upstream = httpRequest(`${serverUrl}${request.url}`, { method: request.method, headers: request.headers }, (source) => {
      response.writeHead(source.statusCode, source.headers);
      source.pipe(response);
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const config = { serverUrl: `http://127.0.0.1:${proxy.address().port}`, token, autoSync: false, autoSyncIntervalSeconds: 60 };
  const transfer = (directory, selected, extra = {}) => runGo({ action: 'sync', directory, transfers: `${directory}-transfers`, assets: selected, config, ...extra });
  const interrupted = await transfer(goLibrary, [assets[0]], { cancelPhase: 'upload' });
  assert.equal(interrupted.result.complete, false);
  requests.length = 0;
  assert.equal((await transfer(goLibrary, [assets[0]])).result.complete, true);
  assert.ok(requests.some(({ url }) => url.includes('/chunks?') && url.includes('offset=1048576')));
  const jsDownloaded = createAttachmentService({ directory: path.join(temporary, 'js-downloaded') });
  const receive = createAttachmentSync({ library: jsDownloaded, directory: path.join(temporary, 'js-download-transfers') });
  assert.equal((await receive.run({ assets: [assets[0]], config })).complete, true);
  assert.deepEqual(await jsDownloaded.read(assets[0].assetId, assets[0].metadata), fixtures[0].bytes);
  const send = createAttachmentSync({ library: jsLibrary, directory: path.join(temporary, 'js-upload-transfers') });
  assert.equal((await send.run({ assets, config })).complete, true);
  const goDownloaded = path.join(temporary, 'go-downloaded');
  assert.equal((await transfer(goDownloaded, [assets[0]], { cancelPhase: 'download' })).result.complete, false);
  requests.length = 0;
  assert.equal((await transfer(goDownloaded, assets)).result.complete, true);
  assert.ok(requests.some(({ url }) => url.includes('?offset=1048576')));
  for (const asset of assets) assert.deepEqual(await runGo({ action: 'inspect', directory: goDownloaded, assetId: asset.assetId }), { assetId: asset.assetId, metadata: asset.metadata });
  report.sync.push({ authenticatedStandaloneServer: true, jsToGo: true, goToJs: true, emptyAndImageMetadata: true, goUploadResume: true, goDownloadResume: true });

  const resumedBytes = randomBytes(2 * 1024 * 1024 + 51);
  const resumedAsset = await jsLibrary.putBytes(resumedBytes, '跨端续传.bin');
  const resumedFile = path.join(temporary, 'resume-original.bin');
  await fs.writeFile(resumedFile, resumedBytes);
  await runGo({ action: 'import', filename: resumedFile, directory: goLibrary });
  let cancelUpload = true;
  const cancelSend = createAttachmentSync({ library: jsLibrary, directory: path.join(temporary, 'js-resume-transfers'), onProgress(event) {
    if (cancelUpload && event.phase === 'upload') { cancelUpload = false; cancelSend.cancel(); }
  } });
  assert.equal((await cancelSend.run({ assets: [resumedAsset], config })).complete, false);
  requests.length = 0;
  assert.equal((await transfer(goLibrary, [resumedAsset])).result.complete, true);
  assert.ok(requests.some(({ url }) => url.includes('/chunks?') && url.includes('offset=1048576')));
  const damaged = Buffer.from(resumedBytes); damaged[0] ^= 255;
  const remoteObject = path.join(`${databasePath}.assets`, 'objects', resumedAsset.assetId.slice(7));
  await fs.writeFile(remoteObject, damaged);
  const brokenTarget = path.join(temporary, 'corrupt-download');
  assert.equal((await transfer(brokenTarget, [resumedAsset])).result.complete, false);
  await assert.rejects(runGo({ action: 'inspect', directory: brokenTarget, assetId: resumedAsset.assetId }));
  assert.equal((await transfer(goLibrary, [resumedAsset])).result.complete, true);
  assert.equal((await transfer(brokenTarget, [resumedAsset])).result.complete, true);
  report.sync.push({ jsLeaseResumedByGo: true, corruptDownloadRejected: true, corruptRemoteRepairedFromOriginal: true });

  const { syncOperationWorkspace } = loadTypescript('src/operationSync.ts');
  const { migrateWorkspace: migrateBrowserWorkspace } = loadTypescript('src/migrations.ts');
  const operationWorkspace = migrateBrowserWorkspace(workspace);
  const network = (pathname, method = 'GET', body) => runGo({ action: 'network', config, request: { ...config, pathname: pathname.startsWith('/api/v2/') ? pathname + (pathname.includes('?') ? '&' : '?') + 'bikeOrdering=2' : pathname, method, body } });
  const manifest = await network('/api/sync/manifest');
  assert.equal((await network('/api/v2/enable', 'POST', { expectedRevision: manifest.data.workspaceRevision })).ok, true);
  const unauthorized = await runGo({ action: 'network', config: { ...config, token: 'wrong' }, request: { ...config, token: 'wrong', pathname: '/api/v2/status', method: 'GET' } });
  assert.equal(unauthorized.status, 401);
  let dropAcknowledgement = false;
  async function sync(workspace, replica, useGo) {
    globalThis.window = useGo ? { bike: { invokeSyncRequest: async (request) => {
      const response = await runGo({ action: 'network', config, request });
      if (dropAcknowledgement && request.method === 'POST' && response.ok) {
        dropAcknowledgement = false;
        return { ok: false, status: 503, data: { message: 'fixture lost acknowledgement' } };
      }
      return response;
    } } } : {};
    return syncOperationWorkspace(workspace, config, replica);
  }
  let a = await sync(operationWorkspace, createReplicaState(operationWorkspace, 'mygo-interop-a'), true);
  let b = await sync(operationWorkspace, createReplicaState(operationWorkspace, 'web-interop-b'), false);
  assert.notEqual(a.replica.actorId, b.replica.actorId);
  function edit(client, index, text, id) {
    const workspace = structuredClone(client.workspace);
    workspace.documents[0].nodes[index].text = text;
    const committed = recordReplicaCommit(client.replica, client.workspace, workspace, { requestId: id, digest: id, source: { kind: 'user', label: '互通编辑' }, at: stamp });
    return { workspace, replica: committed.replica };
  }
  a = edit(a, 0, 'Go transport offline edit 中文🙂', 'interop-a-edit');
  b = edit(b, 1, 'Web fetch offline edit', 'interop-b-edit');
  dropAcknowledgement = true;
  await assert.rejects(sync(a.workspace, a.replica, true), /lost acknowledgement/);
  const cursorBeforeRestart = (await network('/api/v2/status')).data.cursor;
  await stopChild(serverChild);
  await startServer(configPath, serverUrl);
  a = await sync(a.workspace, a.replica, true);
  assert.equal((await network('/api/v2/status')).data.cursor, cursorBeforeRestart);
  b = await sync(b.workspace, b.replica, false);
  a = await sync(a.workspace, a.replica, true);
  assert.deepEqual(a.workspace.documents[0].nodes, b.workspace.documents[0].nodes);
  assert.equal(a.replica.outbox.length, 0);
  assert.equal(b.replica.outbox.length, 0);
  const receipt = await network('/api/v2/receipts/interop-a-edit');
  assert.equal(receipt.data.id, 'interop-a-edit');
  a = edit(a, 0, 'MyGO conflicting candidate', 'interop-a-conflict');
  b = edit(b, 0, 'Web conflicting candidate', 'interop-b-conflict');
  a = await sync(a.workspace, a.replica, true);
  b = await sync(b.workspace, b.replica, false);
  a = await sync(a.workspace, a.replica, true);
  assert.deepEqual(a.workspace.documents[0].nodes, b.workspace.documents[0].nodes);
  assert.ok(a.replica.conflicts.some(({ id }) => id === 'interop-b-conflict'));
  assert.ok(b.replica.conflicts.some(({ id }) => id === 'interop-b-conflict'));
  report.sync.push({ sharedFrontendThroughGoAndWeb: true, distinctActors: true, offlineFieldConvergence: true, visibleSameFieldConflict: true, lostAcknowledgementAndServerRestart: true, receiptDeduplication: true });
  report.limitations = ['Local fixtures and a temporary standalone Sync Server', 'No real provider, iCloud, GUI or physical macOS 12/13 verification'];
  console.log(JSON.stringify(report, null, 2));
} finally {
  globalThis.window = previousWindow;
  if (proxy) { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); }
  await stopChild(serverChild);
  await fs.rm(temporary, { recursive: true, force: true });
}
