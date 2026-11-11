import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createLiveWorkspaceStore } from '../mcp/bike-live.mjs';
import { appendChildrenForMcp } from '../mcp/bike-core.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const desktop = path.join(root, 'desktop-mygo');
const source = path.join(desktop, 'cmd/bike-mygo-performance');
const LF = String.fromCharCode(10);
const options = new Set(process.argv.slice(2));
const option = (name, fallback) => process.argv.find((item) => item.startsWith(name + '='))?.slice(name.length + 1) ?? fallback;
const engines = option('--engines', 'mygo,electron').split(',');
const cases = option('--cases', 'startup,library,outline-collapsed,mindmap-collapsed,outline-expanded,mindmap-expanded').split(',');
const coreCases = ['startup', 'library', 'outline-collapsed', 'mindmap-collapsed', 'outline-expanded', 'mindmap-expanded'];
const peakCases = new Set(['proposal-peak', 'attachment-peak']);
const hasPeaks = cases.some((name) => peakCases.has(name));
const candidatePath = option('--candidate-ready', '');
const diagnosticLabel = option('--diagnostic-label', '');
const candidate = candidatePath ? JSON.parse(await fs.readFile(path.resolve(candidatePath), 'utf8')) : null;
const evidence = path.resolve(option('--output', path.join(root, 'docs/evidence-mygo-2026-11-11-performance')));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-mygo-performance-'));
const go = process.env.BIKE_MYGO_GO ?? 'go';
let electronExecutable = process.env.BIKE_ELECTRON_EXECUTABLE ?? path.join(root, 'release/mac-arm64/Bike.app/Contents/MacOS/Bike');
const electronArchive = option('--electron-archive', '');
const timeoutMs = Number(option('--timeout-ms', '480000'));
const renderDeadlineMs = Number(option('--render-deadline-ms', '150000'));
const edits = Number(option('--edits', '50'));
const profilePhases = options.has('--profile-phases');
const peakScript = await fs.readFile(path.join(source, 'peaks.js'), 'utf8');
const script = `const runPeak=async(config,helpers)=>{${peakScript}};` + await fs.readFile(path.join(source, 'performance.js'), 'utf8');
const metricsPython = await fs.readFile(path.join(source, 'process_metrics.py'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const fixtureFunction = new AsyncFunction('config', script);
const environment = { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: 'arm64', GOTOOLCHAIN: 'local', GOEXPERIMENT: 'jsonv2' };
const binary = path.join(scratch, 'Bike MyGO Performance.app/Contents/MacOS/bike-mygo-performance');
const reportPath = path.join(evidence, 'results.json');
await fs.mkdir(evidence, { recursive: true });
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
assert.ok(engines.every((engine) => ['mygo', 'electron'].includes(engine)));
assert.ok(cases.every((name) => coreCases.includes(name) || peakCases.has(name)));
if (hasPeaks && engines.includes('mygo')) assert.ok(candidate?.frozen || diagnosticLabel, 'Native peaks require --candidate-ready or an explicit --diagnostic-label');
assert.equal(new Set(cases).size, cases.length, 'Scenarios must be unique');
assert.ok(Number.isInteger(edits) && edits > 0 && edits <= 50);
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const run = (executable, args, configuration = {}) => {
  const child = spawnSync(executable, args, { cwd: root, encoding: 'utf8', ...configuration });
  if (child.error || child.status !== 0) throw new Error(`${executable} ${args.join(' ')} failed ${child.error ?? child.stderr}`);
  return child.stdout.trim();
};
const hashDirectory = async (directory) => {
  const digest = crypto.createHash('sha256');
  for (const file of (await fs.readdir(directory, { recursive: true })).sort()) {
    const target = path.join(directory, file);
    if ((await fs.stat(target)).isFile()) digest.update(file).update(await fs.readFile(target));
  }
  return digest.digest('hex');
};
const nativeSourceFingerprint = async () => {
  const digest = crypto.createHash('sha256');
  for (const directory of [path.join(desktop, 'internal'), source]) {
    const files = (await fs.readdir(directory, { recursive: true })).filter((file) => !file.startsWith('frontend/dist/') && !file.endsWith('_test.go')).sort();
    for (const file of files) {
      const target = path.join(directory, file);
      if ((await fs.stat(target)).isFile()) digest.update(path.relative(desktop, target)).update(await fs.readFile(target));
    }
  }
  for (const file of ['go.mod', 'go.sum', '.cache/mygo-v0.8.3-go126/go.mod']) digest.update(file).update(await fs.readFile(path.join(desktop, file)));
  return digest.digest('hex');
};
// Match the candidate build's published build-input-files-v2 fingerprint.
const candidateSourceFingerprint = async () => {
  const listed = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  const inputs = new Set(['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json',
    'scripts/mygo.mjs', 'scripts/mygo-contracts.mjs', 'scripts/prepare-mygo-source.mjs', 'scripts/build-mygo-source-exporter.mjs']);
  const digest = crypto.createHash('sha256');
  for (const file of [...new Set(listed.split('\0').filter(Boolean))].sort()) {
    if (!inputs.has(file) && !/^(src|shared|desktop-mygo)\//.test(file) && !/^docs\/evidence-mygo-2026-11-11-package\/notices\//.test(file)) continue;
    if (/^desktop-mygo\/(?:\.cache|internal\/frontend\/dist|internal\/sourceexport\/(?:generated|testdata)|tests)\//.test(file) || /_test\.go$/.test(file)) continue;
    if (file.startsWith('desktop-mygo/cmd/') && !/^desktop-mygo\/cmd\/bike-mygo(?:-probe)?\//.test(file)) continue;
    let bytes;
    try { bytes = await fs.readFile(path.join(root, file)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    digest.update(file).update('\0').update(hash(bytes)).update('\n');
  }
  return digest.digest('hex');
};
const log = async (text) => {
  console.error(text);
  await fs.writeFile(path.join(evidence, 'progress.md'), ['# MG11 performance progress', '', new Date().toISOString(), '', text, '', `Evidence ${evidence}`, `Scratch ${scratch}`, ''].join(LF));
};
const report = { collectedAt: new Date().toISOString(), commit: run('git', ['rev-parse', 'HEAD']), runnerSHA256: hash(await fs.readFile(fileURLToPath(import.meta.url))), diagnosticLabel, profilePhases, host: { macOS: run('/usr/bin/sw_vers', ['-productVersion']), release: os.release(), machine: os.cpus()[0]?.model, arch: os.arch(), physicalMemoryBytes: os.totalmem() }, fixtures: {}, engines: {}, cases, edits, limitations: [
  'Cold startup means first launch with clean isolated app storage. OS file caches are not flushed and reboot-cold startup is unmeasured.',
  'Both engines use identical synthetic DOM input/focus/blur events in the actual production React frontend, persisted revision/text readback and two animation frames.',
  'The native launcher activates its exact ready bundle with a standard AppleEvent and restores foreground when independent samples detect focus loss. Electron uses app/window focus restoration. All restorations and focus flags are recorded.',
  'RSS is summed per attributed OS process and may count shared pages multiple times. Shared WebKit services owned by other applications cannot be apportioned.',
  'Concurrent agents and other applications may affect scheduling. One run per scenario, 20 searches per theme and 50 edits per view/state by default.',
  'Real IME, macOS 12/13, iCloud and real providers are outside this performance run.',
  'The native binary is a separate production-linked helper with the production frontend and desktop services. It omits the shipping window menu and close lifecycle wiring.',
  'The supplied release/mac-arm64/Bike.app identifies as 1.7.0 and rejects v3. Its diagnostic runs are separate. The --electron-archive option measures the checksummed formal 2.0.0 artifact without changing that app.',
  'Process startup clocks differ slightly. Go records time since main, Electron reports process.uptime through Playwright. Navigation-to-ready includes harness dispatch overhead in both engines.',
  'Large proposal and attachment peak workloads are separate acceptance items and are not covered by the default UI workload.'
] };
if (hasPeaks) {
  report.peakMethod = { operationsPerScenario: 1, residentSampleIntervalMs: 250, coreCasesRequested: cases.filter((name) => !peakCases.has(name)), candidate, diagnosticLabel, finalCandidateEvidence: Boolean(candidate?.frozen && !diagnosticLabel),
    implementations: 'Native uses production Go LiveStore/native LiveServer and bounded attachment bridge. Formal Electron uses production Live service and its single ArrayBuffer IPC attachment import. Same bytes/budgets, different transfer implementations.',
    memoryAccounting: 'Same process_metrics.py and app PID roles as core runs. Go client is in native main. External Node controller/client RSS is separately reported and excluded from app totals in both hosts.',
    instrumentation: 'The diagnostic native Go Desktop wrapper forwards the original context/payload to production Invoke/Reply and then parses existing chunk JSON for byte/offset dimensions. It records resident samples at chunks 1/64/128 and after native finish. The frozen JS runtime is untouched. Stage samples, repeated JSON parsing and 250 ms resident sampling perturb workload and may miss shorter transients.',
  };
  report.limitations.push('Peak proposal uses 32 note-bearing nodes in one Live proposal group. Notes appear in both operation and summary, so generated proposal bytes approach the 2 MiB budget while source notes are about 0.72 MiB. This does not cover 100-group proposals.');
}
for (const scenario of ['library', 'single']) {
  for (const expanded of [false, true]) {
    const fixture = JSON.stringify(await fixtureFunction({ action: 'fixture', scenario, expanded }));
    report.fixtures[`${scenario}-${expanded ? 'expanded' : 'collapsed'}`] = { sha256: hash(fixture), utf8Bytes: Buffer.byteLength(fixture), documents: scenario === 'library' ? 100 : 1, topics: 20000, stamp: '2026-11-11T00:00:00.000Z', workspaceVersion: 1 };
  }
}
for (const name of cases.filter((name) => peakCases.has(name))) {
  const fixture = JSON.stringify(await fixtureFunction({ action: 'fixture', scenario: name }));
  report.fixtures[name] = { sha256: hash(fixture), utf8Bytes: Buffer.byteLength(fixture), documents: 1, topics: 1, workspaceVersion: 3, stamp: '2026-11-11T00:00:00.000Z' };
}
const persist = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2) + LF);
const deadline = (promise, milliseconds, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds); })]).finally(() => clearTimeout(timer));
};
const native = async (configuration, label, profile) => {
  const directory = path.join(scratch, 'native', label);
  await fs.mkdir(directory, { recursive: true });
  const started = performance.now();
  const child = spawn(binary, ['--config', JSON.stringify({ ...configuration, engine: 'mygo', controllerPID: process.pid }), '--output', directory, '--timeout', `${timeoutMs}ms`, ...(profile ? ['--profile', profile] : [])], { env: { ...environment, PATH: '/usr/bin:/bin', MYGO_ENV: 'development' } });
  let renderDeadlineExceeded = false;
  let viewReady = false;
  let windowActivation = null;
  let activationPending = false;
  const activationGuard = configuration.action === 'measure' ? setInterval(async () => {
    if (activationPending || child.exitCode !== null) return;
    if (windowActivation && performance.now() - started - windowActivation.completedAtMs < 2000) return;
    activationPending = true;
    try {
      await fs.access(path.join(directory, 'window-ready.json'));
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (windowActivation) {
        const lines = (await fs.readFile(path.join(directory, 'resident-samples.jsonl'), 'utf8')).trim().split(LF);
        let latest;
        try { latest = JSON.parse(lines.at(-1)); } catch { return; }
        if (latest.applicationActive !== false && latest.windowFocused !== false) return;
      }
      const requestedAtMs = performance.now() - started;
      const appBundle = path.dirname(path.dirname(path.dirname(binary)));
      const activated = spawnSync('/usr/bin/osascript', ['-e', `tell application ${JSON.stringify(appBundle)} to activate`], {
        encoding: 'utf8', timeout: 5000,
      });
      const attempt = {
        method: 'standard AppleEvent to the exact ready helper bundle',
        requestedAtMs,
        completedAtMs: performance.now() - started,
        status: activated.status,
        stderr: activated.stderr,
        ...(activated.error ? { error: String(activated.error) } : {}),
      };
      windowActivation = { ...attempt, attempts: [...(windowActivation?.attempts ?? []), attempt] };
      await fs.writeFile(path.join(directory, 'window-activation.json'), JSON.stringify(windowActivation, null, 2) + LF);
      if (activated.status !== 0) child.kill('SIGKILL');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        windowActivation = { error: String(error) };
        child.kill('SIGKILL');
      }
    } finally { activationPending = false; }
  }, 500) : null;
  const renderGuard = configuration.action === 'measure' && configuration.scenario === 'single' ? setInterval(async () => {
    try {
      const lines = (await fs.readFile(path.join(directory, 'checkpoints.jsonl'), 'utf8')).trim().split(LF).filter(Boolean);
      viewReady = lines.some((line) => JSON.parse(line).render);
    } catch {}
    if (!viewReady && performance.now() - started > renderDeadlineMs) { renderDeadlineExceeded = true; child.kill('SIGKILL'); }
  }, 1000) : null;
  let output = '';
  child.stdout.on('data', (bytes) => { output += bytes; });
  child.stderr.on('data', (bytes) => { output += bytes; });
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 3000);
    child.once('exit', (code, signal) => { clearTimeout(timer); clearInterval(renderGuard); clearInterval(activationGuard); resolve({ code, signal }); });
    child.once('error', (error) => { clearTimeout(timer); clearInterval(renderGuard); clearInterval(activationGuard); resolve({ error: String(error) }); });
  });
  await fs.writeFile(path.join(evidence, `mygo-${label}.log`), output);
  let payload;
  try { payload = JSON.parse(await fs.readFile(path.join(directory, 'result.json'))); } catch {}
  let checkpoints = [];
  try { checkpoints = (await fs.readFile(path.join(directory, 'checkpoints.jsonl'), 'utf8')).trim().split(LF).filter(Boolean).map((line) => JSON.parse(line)); } catch {}
  if (checkpoints.length) await fs.writeFile(path.join(evidence, `mygo-${label}-checkpoints.json`), JSON.stringify(checkpoints, null, 2) + LF);
  for (const filename of ['proposal-pending.png', 'window-activation.json']) {
    try { await fs.copyFile(path.join(directory, filename), path.join(evidence, `mygo-${label}-${filename}`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let residentSamples = [];
  try { residentSamples = (await fs.readFile(path.join(directory, 'resident-samples.jsonl'), 'utf8')).trim().split(LF).filter(Boolean).map((line) => JSON.parse(line)); } catch {}
  const residentSamplingErrors = checkpoints.filter((value) => value.residentSamplingError).map((value) => value.residentSamplingError);
  return { ...payload, exit, residentSamples, ...(configuration.action === 'measure' ? { windowActivation } : {}), ...(peakCases.has(configuration.scenario) ? { residentSamplingErrors } : {}), renderDeadlineExceeded, renderDeadlineMs, launchThroughExitMs: performance.now() - started, hardDeadlineMs: timeoutMs, ...(payload ? {} : { error: renderDeadlineExceeded ? 'Expanded view did not finish rendering before external deadline' : 'No final result before exit', partial: checkpoints.at(-1) ?? null }) };
};
const collect = (mainPid, known, peak = false) => JSON.parse(run('/usr/bin/python3', ['-c', metricsPython, String(mainPid), JSON.stringify(known), ...(peak ? [String(process.pid)] : [])]));
const configurationFor = (name, engine) => peakCases.has(name)
  ? { action: 'measure', scenario: name, engine, operationTimeoutMs: 60000 }
  : { action: 'measure', scenario: name === 'library' ? 'library' : 'single', view: name.startsWith('mindmap') ? 'mindmap' : 'outline', expanded: name.endsWith('-expanded'), edits, profilePhases, renderTimeoutMs: 90000, operationTimeoutMs: 20000 };
const restartConfiguration = (configuration, result) => ({ ...configuration, action: 'verify-peak', expected: configuration.scenario === 'proposal-peak'
  ? { operationId: result.status.operationId, contentSHA256: result.content.contentSHA256 }
  : { assetId: result.asset.assetId, sha256: result.sourceSHA256 } });
const verifyElectronOriginal = async (profile, assetId, expectedSHA256) => {
  assert.match(assetId, /^sha256:[a-f0-9]{64}$/);
  const digest = assetId.slice(7);
  const filename = path.join(profile, 'attachments', digest.slice(0, 2), digest);
  const stat = await fs.lstat(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  const sha = crypto.createHash('sha256');
  const pattern = Buffer.alloc(65536);
  for (let i = 0; i < pattern.length; i++) pattern[i] = (i * 31 + (i >>> 8)) & 255;
  let count = 0;
  for await (const chunk of createReadStream(filename, { highWaterMark: 1024 * 1024 })) {
    sha.update(chunk);
    for (let offset = 0; offset < chunk.length; offset += pattern.length) assert.ok(chunk.subarray(offset, offset + pattern.length).equals(pattern.subarray(0, Math.min(pattern.length, chunk.length - offset))), `Original byte mismatch at ${count + offset}`);
    count += chunk.length;
  }
  const actual = sha.digest('hex');
  assert.equal(actual, expectedSHA256); assert.equal(actual, digest); assert.equal(count, 128 * 1024 * 1024); assert.equal(stat.size, count);
  const temporaryFiles = (await fs.readdir(path.join(profile, 'attachments'))).filter((name) => /^\.(?:import|upload)-.*\.tmp$/.test(name));
  return { sha256: actual, byteLength: count, originalBytesVerified: true, metadata: { byteLength: count, mediaType: 'application/octet-stream' }, temporaryFiles, implementation: 'direct streamed read of formal Electron installed original with full byte-pattern and SHA256 comparison' };
};
let nativeBuilt = false;
let frozenNativeInputs;
try {
  if (engines.includes('mygo')) {
    await log('Building independent production-mode WKWebView performance helper from the staged frontend.');
    assert.equal(run(go, ['env', 'GOVERSION'], { env: environment }), 'go1.26.10');
    const staged = path.join(desktop, 'internal/frontend/dist');
    const frontendBefore = await hashDirectory(staged);
    if (candidate) assert.equal(frontendBefore, candidate.frontendSHA256, 'Staged frontend differs from frozen candidate');
    const sourceFingerprint = await nativeSourceFingerprint();
    const candidateFingerprint = candidate ? await candidateSourceFingerprint() : null;
    if (candidate) assert.equal(candidateFingerprint, candidate.sourceFingerprint, 'Current build inputs differ from frozen candidate');
    frozenNativeInputs = { frontendSHA256: frontendBefore, sourceFingerprint, candidateSourceFingerprint: candidateFingerprint };
    await fs.mkdir(path.dirname(binary), { recursive: true });
    const identifier = hasPeaks ? 'com.bike.mygo.performance.peaks' : 'com.bike.mygo.performance';
    const flags = `-s -w -X github.com/egoist/mygo.production=1 -X github.com/egoist/mygo.packageIdentifier=${identifier} -X github.com/egoist/mygo.packageVersion=2.0.0 -X github.com/MoarLiu/Bike/desktop-mygo/internal/product.Build=${candidate?.build ?? '1'} -X github.com/MoarLiu/Bike/desktop-mygo/internal/product.Channel=${candidate?.channel ?? 'preview'} -X github.com/MoarLiu/Bike/desktop-mygo/internal/product.Commit=${report.commit}`;
    run(go, ['build', '-mod=readonly', '-trimpath', '-tags', 'mygo_noinspector,mygo_frontend', '-ldflags', flags, '-o', binary, './cmd/bike-mygo-performance'], { cwd: desktop, env: environment });
    assert.equal(await hashDirectory(staged), frontendBefore, 'Staged frontend changed during compilation');
    assert.equal(await nativeSourceFingerprint(), sourceFingerprint, 'Native sources changed during compilation');
    const plist = `<?xml version='1.0' encoding='UTF-8'?><plist version='1.0'><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleName</key><string>Bike MyGO Performance</string><key>CFBundleExecutable</key><string>bike-mygo-performance</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>2.0.0</string><key>CFBundleVersion</key><string>1</string><key>LSMinimumSystemVersion</key><string>12.0</string><key>NSPrincipalClass</key><string>NSApplication</string><key>NSHighResolutionCapable</key><true/></dict></plist>`;
    await fs.writeFile(path.join(path.dirname(path.dirname(binary)), 'Info.plist'), plist);
    run('/usr/bin/codesign', ['--force', '--sign', '-', path.dirname(path.dirname(path.dirname(binary)))]);
    const otool = run('/usr/bin/otool', ['-l', binary]);
    const minimumSystemVersion = otool.split(LF).find((line) => line.trim().startsWith('minos '))?.trim().split(' ').filter(Boolean)[1];
    report.engines.mygo = { compiler: 'go1.26.10', goExperiment: 'jsonv2', cgo: false, buildTags: ['mygo_noinspector', 'mygo_frontend'], productionLinkFlag: true, identifier, sourceFingerprint, sourceFingerprintScope: 'local desktop internal sources, performance helper and Go metadata, excluding tests and staged dist; staged dist separately hashed', frontendSHA256: frontendBefore, testScriptSHA256: hash(script), binarySHA256: hash(await fs.readFile(binary)), minimumSystemVersion, results: {} };
    await fs.writeFile(path.join(evidence, 'mygo-build-info.txt'), run(go, ['version', '-m', binary], { env: environment }) + LF);
    assert.equal(minimumSystemVersion, '12.0');
    nativeBuilt = true;
    await native({ action: 'cleanup' }, 'initial-cleanup');
    for (const name of cases) {
      await log(`Running MyGO ${name}. Completed cases ${Object.keys(report.engines.mygo.results).join(', ')}.`);
      if (name === 'startup') {
        const results = [];
        for (let i = 0; i < 4; i++) results.push({ kind: i === 0 ? 'cold-clean-profile' : 'warm-repeat', ...await native({ action: 'startup' }, `startup-${i}`) });
        report.engines.mygo.results.startup = results;
      } else {
        const configuration = configurationFor(name, 'mygo');
        const profile = peakCases.has(name) ? path.join(scratch, 'native-profiles', name) : undefined;
        const seed = await native({ ...configuration, action: 'seed' }, `${name}-seed`, profile);
        const measured = seed.result?.fixture ? await native(configuration, name, profile) : { error: 'Fixture seed failed', seed };
        if (peakCases.has(name) && measured.result?.peakAccepted) measured.restartVerification = await native(restartConfiguration(configuration, measured.result), `${name}-restart`, profile);
        if (name === 'attachment-peak' && measured.restartVerification?.result?.peakAccepted) measured.cleanupVerification = await native({ ...restartConfiguration(configuration, measured.result), action: 'cleanup-peak' }, `${name}-cleanup`, profile);
        report.engines.mygo.results[name] = measured;
      }
      await persist();
    }
  }
  if (engines.includes('electron')) {
    const { _electron } = createRequire(import.meta.url)('playwright');
    let archiveIdentity;
    if (electronArchive) {
      const archive = path.resolve(electronArchive);
      const archiveSHA256 = hash(await fs.readFile(archive));
      const expectedSHA256 = (await fs.readFile(archive + '.sha256', 'utf8')).trim().split(' ')[0];
      assert.equal(archiveSHA256, expectedSHA256, 'Electron baseline archive checksum differs');
      const unpacked = path.join(scratch, 'electron-release');
      await fs.mkdir(unpacked);
      run('/usr/bin/ditto', ['-xk', archive, unpacked]);
      electronExecutable = path.join(unpacked, 'Bike.app/Contents/MacOS/Bike');
      archiveIdentity = { archive: path.relative(root, archive), sha256: archiveSHA256, checksumVerified: true };
    }
    const asar = path.resolve(electronExecutable, '../../Resources/app.asar');
    report.engines.electron = { executable: path.relative(root, electronExecutable), archiveIdentity, bundleVersion: run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', path.resolve(electronExecutable, '../../Info.plist')]), binarySHA256: hash(await fs.readFile(electronExecutable)), appAsarSHA256: hash(await fs.readFile(asar)), testScriptSHA256: hash(script), results: {} };
    const electronRun = async (configuration, name, profile) => {
      let app;
      let payload;
      let launchError;
      const checkpoints = [];
      const residentSamples = [];
      const errors = [];
      let residentTimer;
      let residentPending;
      let renderTimer;
      let renderDeadlineExceeded = false;
      const started = performance.now();
      const operation = async () => {
        app = await _electron.launch({ executablePath: electronExecutable, args: [], env: { ...process.env, BIKE_TEST_USER_DATA: profile, VITE_DEV_SERVER_URL: '' }, timeout: 30000 });
        const page = await app.firstWindow();
        await app.evaluate(({ app, BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          window.setContentSize(1366, 932);
          app.focus({ steal: true });
          window.focus();
        });
        page.on('pageerror', (error) => errors.push(String(error)));
        page.on('dialog', (dialog) => dialog.accept());
        const takeSample = async (label) => {
          const { metrics, processUptimeMs, windowFocused } = await app.evaluate(({ app, BrowserWindow }) => ({
            metrics: app.getAppMetrics(),
            processUptimeMs: process.uptime() * 1000,
            windowFocused: Boolean(BrowserWindow.getFocusedWindow()?.isFocused()),
          }));
          const known = {};
          for (const process of metrics) {
            const role = process.type === 'Tab' ? 'webContent' : process.type === 'GPU' ? 'gpu' : process.serviceName?.includes('network') ? 'network' : process.type;
            (known[role] ??= []).push(process.pid);
          }
          return { ...collect(app.process().pid, known, peakCases.has(configuration.scenario)), label, appMetrics: metrics, processToSampleMs: processUptimeMs, windowFocused };
        };
        await page.exposeFunction('__performanceSample', takeSample);
        if (peakCases.has(configuration.scenario)) {
          await page.exposeFunction('__performanceCapture', async (name) => {
            assert.equal(name, 'proposal-pending');
            await page.screenshot({ path: path.join(evidence, `electron-${name}.png`) });
          });
          await page.exposeFunction('__performanceLiveTool', async (operation, encoded) => {
            const store = await createLiveWorkspaceStore({ discoveryPath: path.join(profile, 'live-mcp.json'), clientName: 'Bike peak performance fixture' });
            try {
              const args = JSON.parse(encoded);
              const result = operation === 'snapshot' ? await store.load() : operation === 'status' ? await store.status(args.requestId) : await appendChildrenForMcp(store, args);
              return JSON.stringify(operation === 'snapshot' ? { workspace: result.workspace, revision: result.revision } : result);
            } finally { store.close(); }
          });
          await page.exposeFunction('__performanceAttachmentEvidence', (assetId, digest) => verifyElectronOriginal(profile, assetId, digest));
        }
        if (configuration.action === 'measure') {
          let sampling = false;
          residentTimer = setInterval(async () => {
            if (sampling) return;
            sampling = true;
            residentPending = (async () => {
              try {
                const sample = await takeSample('resident-interval');
                if (!sample.windowFocused) {
                  sample.focusRestoration = await app.evaluate(({ app, BrowserWindow }) => {
                    app.focus({ steal: true });
                    const window = BrowserWindow.getAllWindows()[0];
                    window.focus();
                    return { method: 'Electron app/window focus', windowFocused: window.isFocused() };
                  });
                }
                residentSamples.push(sample);
              }
              catch (error) { if (peakCases.has(configuration.scenario)) errors.push(`Resident sampling failed: ${error}`); }
              finally { sampling = false; }
            })();
            await residentPending;
          }, peakCases.has(configuration.scenario) ? 250 : 2000);
        }
        await page.exposeFunction('__performanceCheckpoint', async (value) => {
          checkpoints.push(structuredClone(value));
          await fs.writeFile(path.join(evidence, `electron-${name}-checkpoints.json`), JSON.stringify(checkpoints, null, 2) + LF);
        });
        await page.evaluate(() => { window.__performanceErrors = []; window.addEventListener('error', (event) => window.__performanceErrors.push({ message: event.message, stack: event.error?.stack })); window.addEventListener('unhandledrejection', (event) => window.__performanceErrors.push({ rejection: String(event.reason) })); });
        payload = { result: await page.evaluate(`(async()=>{const config=${JSON.stringify(configuration)};${script}})()`) };
        payload.runtime = await app.evaluate(() => process.versions);
      };
      const renderDeadline = new Promise((_, reject) => {
        if (configuration.action === 'measure' && configuration.scenario === 'single') {
          renderTimer = setTimeout(() => {
            if (!checkpoints.some((value) => value.render)) { renderDeadlineExceeded = true; reject(new Error('Expanded view did not finish rendering before external deadline')); }
          }, renderDeadlineMs);
        }
      });
      try { await deadline(Promise.race([operation(), renderDeadline]), timeoutMs, name); } catch (error) { launchError = String(error); }
      finally {
        clearInterval(residentTimer); clearTimeout(renderTimer);
        await residentPending;
        if (app) {
          try { await deadline(app.close(), 5000, 'Electron close'); } catch { app.process().kill('SIGKILL'); }
        }
      }
      return { ...payload, errors, residentSamples, renderDeadlineMs, renderDeadlineExceeded, launchThroughExitMs: performance.now() - started, ...(launchError ? { error: launchError, partial: checkpoints.at(-1) ?? null } : {}) };
    };
    for (const name of cases) {
      await log(`Running packaged Electron ${name}. Completed cases ${Object.keys(report.engines.electron.results).join(', ')}.`);
      const profile = path.join(scratch, 'electron', name);
      await fs.mkdir(profile, { recursive: true });
      if (name === 'startup') {
        const results = [];
        for (let i = 0; i < 4; i++) results.push({ kind: i === 0 ? 'cold-clean-profile' : 'warm-repeat', ...await electronRun({ action: 'startup' }, `startup-${i}`, profile) });
        report.engines.electron.results.startup = results;
      } else {
        const configuration = configurationFor(name, 'electron');
        const seed = await electronRun({ ...configuration, action: 'seed' }, `${name}-seed`, profile);
        const measured = seed.result?.fixture ? await electronRun(configuration, name, profile) : { error: 'Fixture seed failed', seed };
        if (peakCases.has(name) && measured.result?.peakAccepted) measured.restartVerification = await electronRun(restartConfiguration(configuration, measured.result), `${name}-restart`, profile);
        if (name === 'attachment-peak' && measured.restartVerification?.result?.peakAccepted) measured.cleanupVerification = await electronRun({ ...restartConfiguration(configuration, measured.result), action: 'cleanup-peak' }, `${name}-cleanup`, profile);
        report.engines.electron.results[name] = measured;
      }
      await persist();
    }
  }
} finally {
  if (nativeBuilt) report.nativeCleanup = await native({ action: 'cleanup' }, 'final-cleanup');
  if (frozenNativeInputs) {
    report.frozenInputVerification = { before: frozenNativeInputs, after: { frontendSHA256: await hashDirectory(path.join(desktop, 'internal/frontend/dist')), sourceFingerprint: await nativeSourceFingerprint(), candidateSourceFingerprint: candidate ? await candidateSourceFingerprint() : null } };
    report.frozenInputVerification.matched = JSON.stringify(report.frozenInputVerification.before) === JSON.stringify(report.frozenInputVerification.after);
  }
  report.runnerSourceUnchanged = hash(await fs.readFile(fileURLToPath(import.meta.url))) === report.runnerSHA256;
  await persist();
  if (!options.has('--keep-temp')) await fs.rm(scratch, { recursive: true, force: true });
  if (hasPeaks) report.temporaryProfileCleanup = { scratchRemoved: !options.has('--keep-temp'), retainedByExplicitOption: options.has('--keep-temp') };
}
const failedCases = [];
const incompleteCases = [];
for (const [engine, data] of Object.entries(report.engines)) {
  for (const [name, measurement] of Object.entries(data.results)) {
    const runs = Array.isArray(measurement) ? measurement : [measurement];
    if (runs.some((run) => run.error || !run.result || run.result.error || run.result.ok === false || run.errors?.length || run.residentSamplingErrors?.length || run.exit?.code !== undefined && run.exit.code !== 0)) failedCases.push(`${engine}/${name}`);
    if (engine === 'mygo' && name !== 'startup' && measurement.windowActivation?.status !== 0) failedCases.push(`${engine}/${name}/activation`);
    if (peakCases.has(name)) {
      const restart = measurement.restartVerification;
      const laterPhases = [restart, measurement.cleanupVerification].filter(Boolean);
      if (laterPhases.some((phase) => phase.error || phase.errors?.length || phase.residentSamplingErrors?.length || !phase.result || phase.result.error || phase.result.ok === false || phase.result.errors?.length || phase.exit?.code !== undefined && phase.exit.code !== 0)) failedCases.push(`${engine}/${name}`);
      if (!measurement.result?.peakAccepted || !restart?.result?.peakAccepted || restart.error || restart.result.error || restart.errors?.length || restart.exit?.code !== undefined && restart.exit.code !== 0) incompleteCases.push(`${engine}/${name}`);
      if (name === 'attachment-peak' && !measurement.cleanupVerification?.result?.peakAccepted) incompleteCases.push(`${engine}/${name}`);
      const requiredStages = name === 'proposal-peak'
        ? ['proposal-idle', 'proposal-command-ready', 'proposal-preview-returned', 'proposal-pending-ui', 'proposal-commit-confirmed', 'proposal-readback-validated']
        : ['attachment-idle', 'attachment-source-allocated', 'attachment-source-hashed', 'attachment-import-returned', 'attachment-original-validated', 'attachment-source-released'];
      const stages = measurement.result?.memory ?? [];
      const roles = new Set([...stages, ...(measurement.residentSamples ?? [])].flatMap((sample) => sample.processes.map((process) => process.role)));
      measurement.peakMemoryVerified = requiredStages.every((label) => stages.some((sample) => sample.label === label)) && measurement.residentSamples?.length > 0 && ['main', 'webContent', 'gpu', 'network'].every((role) => roles.has(role)) && (engine !== 'mygo' || stages.every((sample) => sample.goMemory));
      if (!measurement.peakMemoryVerified) incompleteCases.push(`${engine}/${name}`);
    } else if (name !== 'startup' && name !== 'library') {
      const result = measurement.result;
      const expectedNodes = name.endsWith('-expanded') ? (name.startsWith('mindmap') ? 20001 : 20000) : (name.startsWith('mindmap') ? 2 : 1);
      if (!result?.commitVerified || result.edits?.length !== edits || result.editStats?.count !== edits || result.finalRevision < result.initialRevision + edits || !result.memory?.some((sample) => sample.label === `edit-${edits}`) || result.render?.mountedNodes !== expectedNodes) incompleteCases.push(`${engine}/${name}`);
    }
  }
  for (const name of cases) if (!data.results[name]) incompleteCases.push(`${engine}/${name}`);
}
for (const engine of engines) if (!report.engines[engine]) incompleteCases.push(`${engine}/all`);
if (report.frozenInputVerification && !report.frozenInputVerification.matched) failedCases.push('mygo/frozen-inputs');
if (!report.runnerSourceUnchanged) failedCases.push('harness/changed-runner');
report.failedCases = failedCases;
report.incompleteCases = [...new Set(incompleteCases)];
report.complete50EditComparison = edits === 50 && engines.length === 2 && cases.length === 6 && coreCases.every((name) => cases.includes(name)) && failedCases.length === 0 && incompleteCases.length === 0 && report.engines.electron?.bundleVersion === '2.0.0';
if (hasPeaks) {
  report.completePeakCases = cases.filter((name) => peakCases.has(name)).every((name) => engines.every((engine) => report.engines[engine]?.results[name]?.result?.peakAccepted && report.engines[engine]?.results[name]?.restartVerification?.result?.peakAccepted)) && !failedCases.length && !incompleteCases.length;
  report.completePeakComparison = report.completePeakCases && engines.length === 2 && ['proposal-peak', 'attachment-peak'].every((name) => cases.includes(name)) && report.engines.electron?.bundleVersion === '2.0.0' && report.peakMethod.finalCandidateEvidence;
  const runs = Object.values(report.engines).flatMap((engine) => Object.values(engine.results).flatMap((run) => Array.isArray(run) ? run : [run]));
  const samples = runs.flatMap((run) => [run, run.restartVerification, run.cleanupVerification].filter(Boolean).flatMap((measurement) => [...(measurement.result?.memory ?? []), ...(measurement.residentSamples ?? [])]));
  const processIds = [...new Set(samples.flatMap((sample) => sample.processes.map((process) => process.pid)))].sort((a, b) => a - b);
  let alive;
  const cleanupStarted = performance.now();
  do {
    alive = processIds.length ? spawnSync('/bin/ps', ['-p', processIds.join(','), '-o', 'pid=,comm='], { encoding: 'utf8' }) : null;
    if (alive?.error || alive && ![0, 1].includes(alive.status)) throw new Error('Process cleanup verification failed');
    if (!alive?.stdout.trim()) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (performance.now() - cleanupStarted < 5000);
  report.processCleanup = { processIds, remainingSampledProcesses: alive?.stdout.trim() ?? '', allSampledProcessesExited: !alive?.stdout.trim() };
  if (!report.processCleanup.allSampledProcessesExited || !report.temporaryProfileCleanup.scratchRemoved) {
    report.completePeakCases = false; report.completePeakComparison = false;
    report.incompleteCases.push('peak-cleanup');
  }
}
await persist();
if (report.failedCases.length || report.incompleteCases.length) process.exitCode = 1;
await log(`Measurement finished. Raw results are in ${reportPath}.`);
console.log(reportPath);
