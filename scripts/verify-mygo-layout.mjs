import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const productVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const evidence = path.resolve(option('--output', path.join(root, 'docs/evidence-mygo-2026-11-11-integration/webkit-layout')));
const css = option('--css', 'block');
const count = Number(option('--count', '20000'));
const edits = Number(option('--edits', '2'));
const expanded = option('--expanded', 'true') === 'true';
const go = process.env.BIKE_MYGO_GO ?? 'go';
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-mygo-layout-'));
const app = path.join(temporary, 'Bike MyGO Layout Acceptance.app');
const binary = path.join(app, 'Contents/MacOS/bike-mygo-layout-acceptance');
const environment = { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: 'arm64', GOTOOLCHAIN: 'local', GOEXPERIMENT: 'jsonv2' };
const run = (command, args, options = {}) => {
  const value = spawnSync(command, args, { cwd: root, env: environment, encoding: 'utf8', ...options });
  if (value.error || value.status !== 0) throw new Error(`${command} failed ${value.error ?? value.stderr}`);
  return value.stdout;
};
await fs.mkdir(evidence, { recursive: true });
const staged = path.join(root, 'desktop-mygo/internal/frontend/dist');
const hashDirectory = async (directory) => {
  const digest = crypto.createHash('sha256');
  for (const name of (await fs.readdir(directory, { recursive: true })).sort()) {
    const file = path.join(directory, name);
    if ((await fs.stat(file)).isFile()) digest.update(name).update(await fs.readFile(file));
  }
  return digest.digest('hex');
};
const frontendSHA256 = await hashDirectory(staged);
await fs.mkdir(path.dirname(binary), { recursive: true });
const identifier = 'com.bike.mygo.layout-acceptance';
const flags = `-s -w -X github.com/egoist/mygo.production=1 -X github.com/egoist/mygo.packageIdentifier=${identifier} -X github.com/egoist/mygo.packageVersion=${productVersion}`;
run(go, ['build', '-mod=readonly', '-trimpath', '-tags', 'mygo_noinspector,mygo_frontend', '-ldflags', flags, '-o', binary, './cmd/bike-mygo-layout-acceptance'], { cwd: path.join(root, 'desktop-mygo') });
const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleName</key><string>Bike MyGO Layout Acceptance</string><key>CFBundleExecutable</key><string>bike-mygo-layout-acceptance</string><key>CFBundlePackageType</key><string>APPL</string><key>NSPrincipalClass</key><string>NSApplication</string><key>LSMinimumSystemVersion</key><string>12.0</string></dict></plist>`;
await fs.writeFile(path.join(app, 'Contents/Info.plist'), plist);
run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
const marker = option('--run-ready', '');
if (marker) assert.equal(JSON.parse(await fs.readFile(marker, 'utf8')).ready, true, 'Run marker has not released native layout execution');
const command = (mode) => [ '--mode', mode, '--output', evidence, '--css', css, '--count', String(count), '--edits', String(edits), '--expanded=' + expanded ];
const reports = {};
try {
  for (const mode of ['seed', 'measure', 'verify']) {
    const result = spawnSync(binary, command(mode), { env: { ...environment, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 130000, killSignal: 'SIGKILL' });
    await fs.writeFile(path.join(evidence, mode + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
    assert.equal(result.status, 0, `${mode} failed ${result.error ?? result.stderr}`);
    reports[mode] = JSON.parse(await fs.readFile(path.join(evidence, 'result-' + mode + '.json')));
    assert.equal(reports[mode].error, undefined);
    assert.equal(reports[mode].production, true);
    assert.equal(reports[mode].result.seeded ?? reports[mode].result.ok, true);
  }
} finally {
  const cleanup = spawnSync(binary, command('cleanup'), { env: { ...environment, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  await fs.writeFile(path.join(evidence, 'cleanup.log'), (cleanup.stdout ?? '') + (cleanup.stderr ?? ''));
}
assert.equal(await hashDirectory(staged), frontendSHA256, 'Staged frontend changed during the diagnostic');
const reportSummaries = Object.fromEntries(Object.entries(reports).map(([mode, report]) => {
  const { geometry, finalGeometry, ...metrics } = report.result;
  return [mode, { ...report, result: { ...metrics, geometryRows: geometry?.length, finalGeometryRows: finalGeometry?.length }, rawReport: `result-${mode}.json` }];
}));
const summary = { frontendSHA256, cssOverride: css, fixtureTopics: count, expanded, edits, reports: reportSummaries, limitations: ['Production-linked development-only helper', 'Synthetic DOM input, real IndexedDB save and restart readback', 'Real OS IME remains a separate acceptance item'] };
await fs.writeFile(path.join(evidence, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ evidence, frontendSHA256, css, count, expanded, edits, mountMs: reports.measure.result.mountMs, editP95Ms: reports.measure.result.editP95Ms, finalRevision: reports.measure.result.finalRevision }));
await fs.rm(temporary, { recursive: true, force: true });
