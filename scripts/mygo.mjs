import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { prepareMyGoSource } from './prepare-mygo-source.mjs';
import { buildSourceExporter } from './build-mygo-source-exporter.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const desktop = path.join(root, 'desktop-mygo');
const product = JSON.parse(await fs.readFile(path.join(desktop, 'internal/product/product.json')));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json')));
assert.equal(product.version, pkg.version);
assert.equal(product.form, 'mygo');
assert.equal(product.identifier, 'com.bike.mygo');
assert.equal(product.tagPrefix, 'mygo-v');
const command = process.argv[2] ?? 'build';
const channel = process.env.BIKE_MYGO_CHANNEL ?? 'preview';
assert.ok(['stable', 'preview'].includes(channel), 'BIKE_MYGO_CHANNEL must be stable or preview');
const build = process.env.BIKE_MYGO_BUILD ?? '1';
assert.match(build, /^[1-9]\d{0,8}$/, 'BIKE_MYGO_BUILD must be a positive build number');
const targetCompatible = Number.parseFloat(product.minimumSystemVersion) <= Number.parseFloat(product.targetMinimumSystemVersion);
if (channel === 'stable') assert.ok(targetCompatible, 'Stable builds are blocked until the macOS 12 target and Go runtime requirement are reconciled');
const go = process.env.BIKE_MYGO_GO ?? 'go';
const frameworkSource = await prepareMyGoSource(go);

const run = (executable, args, options = {}) => {
  const result = spawnSync(executable, args, { cwd: desktop, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} failed with status ${result.status}`);
  return result.stdout?.trim();
};
assert.equal(run(go, ['env', 'GOVERSION'], { encoding: 'utf8', stdio: 'pipe' }), product.go, 'Use the pinned Go toolchain via BIKE_MYGO_GO');
const environment = { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: 'arm64', GOTOOLCHAIN: 'local', GOEXPERIMENT: product.goExperiment };
if (command === 'package') {
  await packageCandidate();
} else if (command === 'test') {
  // The SDK and protocol packages are platform-independent. Race requires cgo.
  run(go, ['test', './internal/...'], { env: { ...process.env, GOTOOLCHAIN: 'local', GOEXPERIMENT: product.goExperiment, CGO_ENABLED: '0' } });
} else if (command === 'test:race') {
  run(go, ['test', '-race', './internal/mcp', './internal/contracts', './internal/product', './internal/services', './internal/sourceexport'], { env: { ...process.env, GOTOOLCHAIN: 'local', GOEXPERIMENT: product.goExperiment, CGO_ENABLED: '1' } });
} else if (command === 'build' || command === 'dev' || command === 'probe') {
  assert.equal(process.platform, 'darwin', 'MyGO bundle builds currently require macOS');
  const generatorDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-mygo-bindings-'));
  try {
    const generator = path.join(generatorDirectory, 'generate');
    run(go, ['build', '-mod=readonly', '-tags', 'mygo_noinspector', '-o', generator, './cmd/bike-mygo'], { env: environment });
    run(generator, [], { env: { ...environment, MYGO_GENERATE: path.join(desktop, 'bindings/mygo.ts') } });
  } finally { await fs.rm(generatorDirectory, { recursive: true, force: true }); }
  run(process.execPath, ['scripts/mygo-contracts.mjs'], { cwd: root });
  run(process.execPath, ['node_modules/typescript/bin/tsc'], { cwd: root });
  const staged = path.join(desktop, 'internal/frontend/dist');
  run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', staged, '--emptyOutDir'], { cwd: root });
  const indexPath = path.join(staged, 'index.html');
  const indexHTML = await fs.readFile(indexPath, 'utf8');
  assert.ok(indexHTML.includes("connect-src &#39;self&#39; http: https:"), 'Shared CSP changed. Review the MyGO network boundary.');
  await fs.writeFile(indexPath, indexHTML.replace("connect-src &#39;self&#39; http: https:", "connect-src &#39;self&#39;"));
  // Embed the one-time reader code before compilation/signing. No runtime is
  // shipped, and the diagnostic probe has no source-exporter payload.
  if (command !== 'probe') await buildSourceExporter();
  const commit = run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' });
  const suffix = channel === 'preview' ? ' Preview' : '';
  const identifier = product.identifier + (channel === 'preview' ? '.preview' : '');
  const output = path.join(root, 'release/mygo', product.version, `build-${build}-${channel}`);
  const appName = product.name + suffix + (command === 'probe' ? ' Runtime Test' : '');
  await fs.mkdir(output, { recursive: true });
  const staging = await fs.mkdtemp(path.join(output, '.staging-'));
  const finalBundle = path.join(output, appName + '.app');
  let installationStarted = false;
  try {
    const bundle = path.join(staging, appName + '.app');
    const contents = path.join(bundle, 'Contents');
    await fs.mkdir(path.join(contents, 'MacOS'), { recursive: true });
    await fs.mkdir(path.join(contents, 'Resources'), { recursive: true });
    const binary = path.join(contents, 'MacOS', product.executable);
    const productPackage = 'github.com/MoarLiu/Bike/desktop-mygo/internal/product';
    const bundleIdentifier = identifier + (command === 'probe' ? '.runtime-test' : '');
    const sourceFingerprint = await buildSourceFingerprint();
    const ldflags = `-s -w -X ${productPackage}.Build=${build} -X ${productPackage}.Commit=${commit} -X ${productPackage}.Channel=${channel} -X github.com/egoist/mygo.production=1 -X github.com/egoist/mygo.packageIdentifier=${bundleIdentifier} -X github.com/egoist/mygo.packageVersion=${product.version}`;
    const target = command === 'probe' ? './cmd/bike-mygo-probe' : './cmd/bike-mygo';
    const buildTags = 'mygo_noinspector,mygo_frontend' + (command === 'probe' ? '' : ',mygo_source_exporter');
    run(go, ['build', '-mod=readonly', '-trimpath', '-tags', buildTags, '-ldflags', ldflags, '-o', binary, target], { env: environment });
    const loadCommands = run('/usr/bin/otool', ['-l', binary], { stdio: 'pipe', encoding: 'utf8' });
    const binaryMinimumSystemVersion = loadCommands.match(/\bminos\s+(\d+\.\d+(?:\.\d+)?)/)?.[1];
    assert.ok(binaryMinimumSystemVersion, 'Mach-O deployment target is missing');
    assert.equal(Number.parseFloat(binaryMinimumSystemVersion), Number.parseFloat(product.minimumSystemVersion), 'Mach-O and configured runtime minimum differ');
    const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const plist = { CFBundleName: appName, CFBundleDisplayName: appName, CFBundleIdentifier: bundleIdentifier,
      CFBundleExecutable: product.executable, CFBundlePackageType: 'APPL', CFBundleShortVersionString: product.version,
      CFBundleVersion: build, LSMinimumSystemVersion: product.minimumSystemVersion, NSPrincipalClass: 'NSApplication',
      NSHighResolutionCapable: true, NSSupportsAutomaticGraphicsSwitching: true };
    await fs.writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${Object.entries(plist).map(([key, value]) => `<key>${key}</key>${typeof value === 'boolean' ? `<${value}/>` : `<string>${escape(value)}</string>`}`).join('\n')}\n</dict></plist>\n`);
    const actual = JSON.parse(run(binary, ['--version'], { stdio: 'pipe', encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } }));
    assert.equal(actual.version, product.version);
    assert.equal(actual.identifier, identifier);
    assert.equal(actual.build, build);
    const modulesText = run(go, ['list', '-m', '-json', 'all'], { env: environment, stdio: 'pipe', encoding: 'utf8' });
    const modules = modulesText.split(/\n(?=\{)/).map((entry) => JSON.parse(entry));
    const linkedModules = new Set(run(go, ['list', '-deps', '-tags', buildTags, '-f', '{{if .Module}}{{.Module.Path}}{{end}}', target], { env: environment, stdio: 'pipe', encoding: 'utf8' }).split('\n'));
    const dependencies = modules.filter((module) => !module.Main && linkedModules.has(module.Path));
    for (const module of dependencies) {
      if (module.Replace) {
        assert.equal(module.Path, frameworkSource.module, 'Unexpected local dependency replacement');
        assert.equal(path.resolve(module.Replace.Dir), frameworkSource.directory, 'Unexpected MyGO source replacement');
      }
      const notices = (await fs.readdir(module.Dir)).filter((file) => /^(LICENSE|LICENCE|COPYING|NOTICE)([.-]|$)/i.test(file));
      assert.ok(notices.length, `Missing license notice for ${module.Path}`);
      const destination = path.join(contents, 'Resources/third-party', module.Path + '@' + module.Version);
      await fs.mkdir(destination, { recursive: true });
      for (const file of notices) {
        const source = path.join(module.Dir, file);
        if ((await fs.stat(source)).isFile()) await fs.copyFile(source, path.join(destination, file));
      }
    }
    const goRoot = run(go, ['env', 'GOROOT'], { env: environment, stdio: 'pipe', encoding: 'utf8' });
    const goNotices = path.join(contents, 'Resources/third-party/go', product.go);
    await fs.mkdir(goNotices, { recursive: true });
    await fs.copyFile(path.join(goRoot, 'LICENSE'), path.join(goNotices, 'LICENSE'));
    await fs.copyFile(path.join(goRoot, 'PATENTS'), path.join(goNotices, 'PATENTS'));
    const frontendNotices = await copyFrontendNotices(contents);
    const modulesName = command === 'probe' ? 'runtime-go-modules.json' : 'go-modules.json';
    await fs.writeFile(path.join(staging, modulesName), JSON.stringify(dependencies.map(({ Path: module, Version: version, Sum: sum, GoModSum: goModSum }) => ({ module, version, sum, goModSum })), null, 2) + '\n');
    // Resources belong to the signed bundle, so sign after copying notices.
    run('/usr/bin/codesign', ['--force', '--sign', '-', bundle]);
    run('/usr/bin/codesign', ['--verify', '--strict', bundle]);
    assert.equal(await buildSourceFingerprint(), sourceFingerprint, 'Build inputs changed during compilation. Retry after the concurrent edits finish.');
    const dirty = Boolean(run('git', ['status', '--porcelain'], { cwd: root, stdio: 'pipe', encoding: 'utf8' }));
    const data = await fs.readFile(binary);
    const manifest = { ...actual, bundleIdentifier, stage: 'local-candidate', sourceFingerprint, sourceFingerprintScope: 'build-input-files-v2', dirty,
      compiler: product.go, goExperiment: product.goExperiment, frameworkSource: { module: frameworkSource.module, version: frameworkSource.version, sum: frameworkSource.sum, zipSHA256: frameworkSource.zipSHA256, patch: frameworkSource.patch }, cgo: false, os: 'darwin', arch: 'arm64', inspector: false,
      binaryMinimumSystemVersion, targetCompatible,
      binaryBytes: data.length, binarySHA256: crypto.createHash('sha256').update(data).digest('hex'),
      frontendSHA256: await frontendHash(staged), bundleContentSHA256: await frontendHash(bundle),
      frontendNotices, bundle: path.relative(root, finalBundle),
      signing: { kind: 'ad-hoc', notarized: false, installation: 'manual' },
      limitations: ['Physical macOS 12/13 runtime acceptance pending', 'Real IME, iCloud and provider acceptance pending', 'Ad-hoc signing with manual installation; no signed automatic replacement'] };
    const manifestName = command === 'probe' ? 'runtime-build-manifest.json' : 'build-manifest.json';
    await fs.writeFile(path.join(staging, manifestName), JSON.stringify(manifest, null, 2) + '\n');
    installationStarted = true;
    await installBuild(staging, [[bundle, finalBundle], [path.join(staging, manifestName), path.join(output, manifestName)], [path.join(staging, modulesName), path.join(output, modulesName)]]);
    installationStarted = false;
    console.log(finalBundle);
    if (!targetCompatible) console.warn(`Target blocked. This preview requires macOS ${product.minimumSystemVersion}, while the product target remains ${product.targetMinimumSystemVersion}.`);
    if (command === 'dev') run(path.join(finalBundle, 'Contents/MacOS', product.executable), []);
  } finally {
    if (!installationStarted) await fs.rm(staging, { recursive: true, force: true });
  }
} else {
  throw new Error(`Unknown MyGO command ${command}`);
}

async function copyFrontendNotices(contents) {
  const destination = path.join(contents, 'Resources/third-party/frontend');
  const inventory = [];
  const visited = new Set();
  const visit = async (name, from = root) => {
    const require = createRequire(path.join(from, 'package.json'));
    let directory = path.dirname(require.resolve(name));
    let dependency;
    while (directory !== path.dirname(directory)) {
      try {
        const candidate = JSON.parse(await fs.readFile(path.join(directory, 'package.json')));
        if (candidate.name === name) { dependency = candidate; break; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      directory = path.dirname(directory);
    }
    assert.ok(dependency, `Cannot resolve frontend dependency ${name}`);
    if (visited.has(directory)) return;
    visited.add(directory);
    const target = path.join(destination, `${name}@${dependency.version}`);
    await fs.mkdir(target, { recursive: true });
    const notices = (await fs.readdir(directory)).filter((file) => /^(LICENSE|LICENCE|COPYING|NOTICE|CopyrightNotice)([.-]|$)/i.test(file));
    for (const file of notices) await fs.copyFile(path.join(directory, file), path.join(target, file));
    if (name === '@pdf-lib/fontkit') {
      // The published package omits LICENSE and prebundles MIT/Apache code.
      const supplied = path.join(desktop, 'notices');
      for (const file of ['fontkit-LICENSE.txt', 'Apache-2.0.txt']) {
        await fs.copyFile(path.join(supplied, file), path.join(target, file));
        notices.push(file);
      }
      const source = await fs.readFile(path.join(directory, 'dist/fontkit.es.js'), 'utf8');
      const comments = [...source.matchAll(/\/\*[\s\S]*?\*\/|(?:^[ \t]*\/\/[^\n]*\n)+/gm)]
        .map(([comment]) => comment).filter((comment) => /copyright|permission is hereby|licensed under/i.test(comment));
      assert.ok(comments.length > 0, 'Fontkit embedded notices are missing');
      await fs.writeFile(path.join(target, 'EMBEDDED-NOTICES.txt'), [...new Set(comments)].join('\n\n') + '\n');
      await fs.copyFile(path.join(directory, 'README.md'), path.join(target, 'UPSTREAM-README.md'));
      notices.push('EMBEDDED-NOTICES.txt', 'UPSTREAM-README.md');
    }
    assert.ok(notices.length, `Missing frontend license for ${name}`);
    inventory.push({ name, version: dependency.version, license: dependency.license, notices });
    for (const child of Object.keys(dependency.dependencies ?? {}).sort()) await visit(child, directory);
  };
  for (const name of ['react', 'react-dom', 'lucide-react', 'mygo-runtime', 'pdf-lib', '@pdf-lib/fontkit']) await visit(name);
  const font = await fs.readFile(path.join(root, 'src/assets/NotoSansSC-ChineseSimplified.ttf'));
  const fontNotice = path.join(contents, 'Resources/third-party/fonts/NotoSansSC');
  await fs.mkdir(fontNotice, { recursive: true });
  await fs.copyFile(path.join(desktop, 'notices/NotoSansSC-OFL.txt'), path.join(fontNotice, 'OFL.txt'));
  inventory.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  const report = { packages: inventory, font: { name: 'Noto Sans SC', file: 'NotoSansSC-ChineseSimplified.ttf', sha256: crypto.createHash('sha256').update(font).digest('hex'), license: 'OFL-1.1', notices: ['fonts/NotoSansSC/OFL.txt'] } };
  await fs.writeFile(path.join(contents, 'Resources/third-party/frontend-inventory.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

async function packageCandidate() {
  assert.equal(process.platform, 'darwin', 'DMG creation requires macOS');
  const directory = path.join(root, 'release/mygo', product.version, `build-${build}-${channel}`);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'build-manifest.json')));
  const appName = product.name + (channel === 'preview' ? ' Preview' : '') + '.app';
  const bundle = path.join(directory, appName);
  assert.equal(manifest.build, build);
  assert.equal(manifest.channel, channel);
  assert.equal(manifest.stage, 'local-candidate', 'Rebuild the app with the current packaging metadata');
  assert.equal(await frontendHash(bundle), manifest.bundleContentSHA256, 'Bundle changed after build');
  run('/usr/bin/codesign', ['--verify', '--strict', bundle]);
  const stem = `bike-mygo-${product.version}${channel === 'preview' ? `-preview-build${build}` : ''}`;
  const dmgName = `${stem}-arm64.dmg`;
  const archiveName = `${stem}-darwin-arm64.tar.gz`;
  const staging = await fs.mkdtemp(path.join(directory, '.package-'));
  try {
    const payload = path.join(staging, 'payload');
    await fs.mkdir(payload);
    run('/usr/bin/ditto', ['--norsrc', bundle, path.join(payload, appName)]);
    await fs.symlink('/Applications', path.join(payload, 'Applications'));
    run('/usr/bin/hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-volname', product.name + (channel === 'preview' ? ' Preview' : ''), '-srcfolder', payload, '-format', 'UDZO', '-imagekey', 'zlib-level=9', path.join(staging, dmgName)]);
    run('/usr/bin/hdiutil', ['verify', '-quiet', path.join(staging, dmgName)]);
    run('/usr/bin/tar', ['-czf', path.join(staging, archiveName), '-C', directory, appName], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const assets = [];
    for (const [kind, file] of [['installer', dmgName], ['archive', archiveName]]) {
      const bytes = await fs.readFile(path.join(staging, file));
      assets.push({ kind, file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
    const update = { schemaVersion: 1, purpose: 'local-integrity-inventory', published: false, updaterConsumed: false,
      form: product.form, version: product.version, build, channel, tagPrefix: product.tagPrefix, releaseTag: `${product.tagPrefix}${product.version}`,
      platform: 'darwin', arch: 'arm64', bundleIdentifier: manifest.bundleIdentifier, minimumSystemVersion: product.minimumSystemVersion,
      commit: manifest.commit, sourceFingerprint: manifest.sourceFingerprint, binarySHA256: manifest.binarySHA256, bundleContentSHA256: manifest.bundleContentSHA256,
      installation: 'manual', automaticReplacement: false, signing: manifest.signing, updatePackageSignature: 'none', assets };
    const updateName = 'update-darwin-arm64.json';
    const updateBytes = Buffer.from(JSON.stringify(update, null, 2) + '\n');
    await fs.writeFile(path.join(staging, updateName), updateBytes);
    const sumsName = 'SHA256SUMS';
    await fs.writeFile(path.join(staging, sumsName), [...assets.map((asset) => `${asset.sha256}  ${asset.file}`), `${crypto.createHash('sha256').update(updateBytes).digest('hex')}  ${updateName}`].join('\n') + '\n');
    await installBuild(staging, [dmgName, archiveName, updateName, sumsName].map((name) => [path.join(staging, name), path.join(directory, name)]));
    console.log(JSON.stringify({ directory: path.relative(root, directory), assets, installation: 'manual', published: false }, null, 2));
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

async function frontendHash(directory) {
  const hash = crypto.createHash('sha256');
  for (const file of (await fs.readdir(directory, { recursive: true })).sort()) {
    const target = path.join(directory, file);
    if ((await fs.stat(target)).isFile()) hash.update(file).update(await fs.readFile(target));
  }
  return hash.digest('hex');
}

async function buildSourceFingerprint() {
  const listed = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, stdio: 'pipe', encoding: 'utf8' });
  const inputs = new Set(['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json',
    'scripts/mygo.mjs', 'scripts/mygo-contracts.mjs', 'scripts/prepare-mygo-source.mjs', 'scripts/build-mygo-source-exporter.mjs']);
  const hash = crypto.createHash('sha256');
  for (const file of [...new Set(listed.split('\0').filter(Boolean))].sort()) {
    if (!inputs.has(file) && !/^(src|shared|desktop-mygo)\//.test(file) && !/^docs\/evidence-mygo-2026-11-11-package\/notices\//.test(file)) continue;
    if (/^desktop-mygo\/(?:\.cache|internal\/frontend\/dist|internal\/sourceexport\/(?:generated|testdata)|tests)\//.test(file) || /_test\.go$/.test(file)) continue;
    if (file.startsWith('desktop-mygo/cmd/') && !/^desktop-mygo\/cmd\/bike-mygo(?:-probe)?\//.test(file)) continue;
    let bytes;
    try { bytes = await fs.readFile(path.join(root, file)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    hash.update(file).update('\0').update(crypto.createHash('sha256').update(bytes).digest('hex')).update('\n');
  }
  return hash.digest('hex');
}

async function installBuild(staging, files) {
  const moved = [];
  try {
    for (const [source, destination] of files) {
      const entry = { destination, backup: path.join(staging, `previous-${moved.length}`), backedUp: false, installed: false };
      moved.push(entry);
      try { await fs.rename(destination, entry.backup); entry.backedUp = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.rename(source, destination);
      entry.installed = true;
    }
  } catch (error) {
    for (const entry of moved.reverse()) {
      if (entry.installed) await fs.rm(entry.destination, { recursive: true, force: true });
      if (entry.backedUp) await fs.rename(entry.backup, entry.destination);
    }
    throw error;
  }
}
