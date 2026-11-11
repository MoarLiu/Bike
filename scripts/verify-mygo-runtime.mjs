import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const product = JSON.parse(await fs.readFile(path.join(root, 'desktop-mygo/internal/product/product.json')));
const build = process.env.BIKE_MYGO_BUILD ?? '1';
const channel = process.env.BIKE_MYGO_CHANNEL ?? 'preview';
const suffix = channel === 'preview' ? ' Preview' : '';
const buildDirectory = path.join(root, 'release/mygo', product.version, `build-${build}-${channel}`);
const binary = path.join(buildDirectory, `${product.name}${suffix} Runtime Test.app/Contents/MacOS/${product.executable}`);
const manifest = JSON.parse(await fs.readFile(path.join(buildDirectory, 'runtime-build-manifest.json')));
assert.equal(manifest.build, build);
assert.equal(manifest.channel, channel);
assert.equal(manifest.binarySHA256, crypto.createHash('sha256').update(await fs.readFile(binary)).digest('hex'));
const nodeFreePath = '/usr/bin:/bin';
const lookup = spawnSync('/usr/bin/env', ['node', '--version'], { encoding: 'utf8', env: { PATH: nodeFreePath } });
assert.notEqual(lookup.status, 0, 'The probe PATH unexpectedly contains Node');
const directory = path.join(root, 'output/mygo', `runtime-${Date.now()}`);
await fs.mkdir(directory, { recursive: true });
const results = [];
const run = async (mode) => {
  const result = spawnSync(binary, ['--mode', mode, '--output', directory], {
    encoding: 'utf8', timeout: 55000, killSignal: 'SIGKILL', env: { ...process.env, PATH: nodeFreePath, MYGO_ENV: 'development' },
  });
  await fs.writeFile(path.join(directory, mode + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  assert.equal(result.status, 0, `${mode} failed. ${result.stderr}`);
  return JSON.parse(await fs.readFile(path.join(directory, `result-${mode}.json`)));
};
try {
  results.push(await run('seed'));
  results.push(await run('ui'));
  results.push(await run('verify'));
  results.push(await run('isolate'));
  results.push(await run('isolate-control'));
} finally {
  await run('cleanup');
  console.log(directory);
}
assert.equal(results[0].seeded, true);
const ui = results[1];
assert.equal(ui.marker, 'persisted');
assert.equal(ui.rendered, true);
assert.equal(ui.editPersisted, true);
assert.equal(ui.views.length, 4);
assert.equal(ui.bridgeMembers, 36);
const nativeAssertions = ['attachmentProtected', 'unsubscribe', 'backupRoundTrip', 'backupUnicode', 'savedUnicode', 'aiProxy', 'aiCancellation', 'syncProxy', 'liveSnapshot', 'liveUnicode', 'closeBarrier'];
for (const field of nativeAssertions) assert.equal(ui[field], true, `Native runtime check missing ${field}`);
assert.deepEqual(ui.liveWorkflow, { dryRun: true, pending: true, approved: true, rejected: true, status: true, pendingReplay: true, committedReplay: true, rejectedReplay: true, changedPayloadRejected: true });
assert.equal(results[2].workspace.documents[0].nodes[0].text, 'WKWebView 原生桥编辑持久化验证');
assert.equal(results[2].savedUnicode, true);
assert.equal(results[2].workspace.documents[0].nodes[0].note, 'Live native payload ' + String.fromCharCode(0xd800) + ' / ' + String.fromCharCode(0xdc00));
const markdown = ui.downloads.find((name) => name.endsWith('.md'));
assert.ok(markdown, 'Markdown export was not produced');
const markdownBytes = await fs.readFile(path.join(directory, 'downloads', markdown));
assert.match(markdownBytes.toString('utf8'), /WKWebView 原生桥编辑持久化验证/);
const control = results.pop();
assert.equal(control.mode, 'isolate-control');
assert.equal(control.errors.length, 1);
assert.equal(control.errors[0].message, 'Script error.');
for (const result of results) {
  assert.equal(result.origin, 'mygo://localhost');
  assert.equal(result.secure, true);
  assert.equal(result.production, true);
  if (!result.mode.startsWith('isolate')) {
    assert.match(result.cspPolicy, /(?:^|;)\s*connect-src 'self'(?:;|$)/);
    assert.doesNotMatch(result.cspPolicy, /connect-src[^;]*(?:http:|https:)/);
  }
  assert.deepEqual(result.bridge, { text: '中文🙂', number: 42 });
  assert.deepEqual(result.csp, []);
  assert.deepEqual(result.errors, [], `${result.mode} startup errors require investigation`);
}
const report = { build, channel, sourceFingerprint: manifest.sourceFingerprint, binarySHA256: manifest.binarySHA256,
  host: { release: os.release(), arch: os.arch() }, environment: { PATH: nodeFreePath, MYGO_ENV: 'development', productionLinkFlag: true },
  checks: { nodeFreePATH: true, productionMode: true, cspSelfOnly: true, bridgeMembers: ui.bridgeMembers,
    nativeAssertions: Object.fromEntries(nativeAssertions.map((name) => [name, ui[name]])), liveWorkflow: ui.liveWorkflow,
    defaultSessionRestartPersistence: true, fourViews: true, editedMarkdownFile: true, metadataDimensionsOmitted: true, isolatedStatementControl: true },
  markdownBytes: markdownBytes.length, results: [...results, control],
  limitations: ['Physical macOS 12/13 pending', 'Composition events are synthetic; real IME pending', 'Backup and provider use isolated local fixtures; real iCloud/provider pending'] };
await fs.writeFile(path.join(directory, 'runtime-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log('MyGO WKWebView passed. Production scheme and self-only CSP, Node-free PATH, restart persistence, four views, edited Markdown, isolated UTF-16 backup and native Live approval/rejection/replay verified.');
