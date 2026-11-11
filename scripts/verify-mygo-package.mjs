import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const product = JSON.parse(await fs.readFile(path.join(root, 'desktop-mygo/internal/product/product.json')));
const build = process.env.BIKE_MYGO_BUILD ?? '1';
const channel = process.env.BIKE_MYGO_CHANNEL ?? 'preview';
const development = process.argv.includes('--development');
const appOnly = process.argv.includes('--app-only');
assert.ok(!development || channel === 'preview', 'Development verification is limited to preview builds');
const directory = path.join(root, 'release/mygo', product.version, `build-${build}-${channel}`);
const manifest = JSON.parse(await fs.readFile(path.join(directory, 'build-manifest.json')));
const appName = product.name + (channel === 'preview' ? ' Preview' : '');
const bundle = path.join(directory, appName + '.app');
const binary = path.join(bundle, 'Contents/MacOS', product.executable);
const identifier = product.identifier + (channel === 'preview' ? '.preview' : '');
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, ...options }).trim();
const plist = (key) => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(bundle, 'Contents/Info.plist')]);
assert.equal(plist('CFBundleIdentifier'), identifier);
assert.equal(plist('CFBundleExecutable'), product.executable);
assert.equal(plist('CFBundleShortVersionString'), product.version);
assert.equal(plist('CFBundleVersion'), build);
assert.equal(plist('LSMinimumSystemVersion'), product.minimumSystemVersion);
assert.equal(run('/usr/bin/lipo', ['-archs', binary]), 'arm64');
run('/usr/bin/codesign', ['--verify', '--strict', bundle]);
const actual = JSON.parse(run(binary, ['--version']));
for (const key of ['version', 'form', 'build', 'commit', 'channel', 'identifier', 'tagPrefix', 'profile', 'minimumSystemVersion', 'targetMinimumSystemVersion']) assert.equal(actual[key], manifest[key]);
assert.equal(actual.identifier, identifier);
assert.equal(actual.tagPrefix, 'mygo-v');
assert.equal(manifest.binarySHA256, crypto.createHash('sha256').update(await fs.readFile(binary)).digest('hex'));
assert.equal(manifest.stage, 'local-candidate');
assert.equal(manifest.bundleContentSHA256, await directoryHash(bundle));
const files = (await fs.readdir(bundle, { recursive: true })).sort();
for (const file of files) {
  assert.ok(!/^(node|nodejs|bun|electron|chromium)(\.exe|\.app|\.framework)?$/i.test(path.basename(file)), `Unexpected packaged runtime ${file}`);
  assert.ok(!file.includes('Runtime Test'), 'Runtime test code must not ship');
}
assert.ok(files.some((file) => file.includes('third-party/github.com/egoist/mygo@v0.8.3/LICENSE')));
assert.ok(files.some((file) => file.includes('third-party/github.com/modelcontextprotocol/go-sdk@v1.8.0/LICENSE')));
for (const notice of [`go/${product.go}/LICENSE`, `go/${product.go}/PATENTS`, 'fonts/NotoSansSC/OFL.txt', 'frontend-inventory.json', 'frontend/@pdf-lib/fontkit@1.1.1/Apache-2.0.txt']) {
  assert.ok(files.includes('Contents/Resources/third-party/' + notice), `Missing bundled notice ${notice}`);
}
const frontendInventory = JSON.parse(await fs.readFile(path.join(bundle, 'Contents/Resources/third-party/frontend-inventory.json')));
assert.deepEqual(frontendInventory, manifest.frontendNotices);
for (const dependency of frontendInventory.packages) {
  for (const notice of dependency.notices) await fs.access(path.join(bundle, 'Contents/Resources/third-party/frontend', `${dependency.name}@${dependency.version}`, notice));
}
assert.equal(frontendInventory.font.license, 'OFL-1.1');
assert.equal(manifest.signing.kind, 'ad-hoc');
assert.equal(manifest.signing.notarized, false);
assert.equal(manifest.signing.installation, 'manual');
const nodeLookup = (() => { try { return run('/usr/bin/env', ['node', '--version']); } catch { return null; } })();
assert.equal(nodeLookup, null, 'The verification PATH unexpectedly contains Node');
const libraries = run('/usr/bin/otool', ['-L', binary]);
assert.doesNotMatch(libraries, /node|electron|chromium|bun\./i);
const loadCommands = run('/usr/bin/otool', ['-l', binary]);
const binaryMinimumSystemVersion = loadCommands.match(/\bminos\s+(\d+\.\d+(?:\.\d+)?)/)?.[1];
assert.ok(binaryMinimumSystemVersion, 'Mach-O deployment target is missing');
assert.equal(Number.parseFloat(binaryMinimumSystemVersion), Number.parseFloat(plist('LSMinimumSystemVersion')));
const targetCompatible = Number.parseFloat(binaryMinimumSystemVersion) <= Number.parseFloat(product.targetMinimumSystemVersion);
const bytes = (await Promise.all(files.map(async (file) => {
  const stat = await fs.stat(path.join(bundle, file));
  return stat.isFile() ? stat.size : 0;
}))).reduce((sum, size) => sum + size, 0);
const artifacts = appOnly ? null : await verifyArtifacts();
const report = { identity: actual, stage: manifest.stage, binarySHA256: manifest.binarySHA256, bundleContentSHA256: manifest.bundleContentSHA256, appBytes: bytes, files, libraries,
  binaryMinimumSystemVersion, targetCompatible,
  artifacts, signing: manifest.signing, host: { release: os.release(), arch: os.arch() },
  checks: { identity: true, arm64: true, adHocSignature: true, packagedRuntimeScan: true, goDependencyNotices: true, frontendAndFontNotices: true, nodeFreeCLI: true, minimumSystemTarget: targetCompatible, dmgAndArchive: Boolean(artifacts) },
  limitations: ['Physical macOS 12/13 runtime acceptance pending', 'GUI/native bridge and MCP functionality require separate runtime reports', 'Ad-hoc signing and manual installation; no notarization or signed automatic replacement', ...(appOnly ? ['Installer/archive verification skipped by --app-only'] : [])] };
await fs.writeFile(path.join(directory, 'package-verification.json'), JSON.stringify(report, null, 2) + '\n');
if (!targetCompatible) {
  const error = `macOS target blocked. Mach-O requires ${binaryMinimumSystemVersion}, target is ${product.targetMinimumSystemVersion}.`;
  if (!development) throw new Error(error);
  console.warn(error);
}
console.log(`MyGO ${appOnly ? 'app' : 'local candidate'} verified. ${identifier}, ${product.version} build ${build}, arm64, ${(bytes / 1024 / 1024).toFixed(2)} MiB app, ad-hoc signature.`);

async function directoryHash(directory) {
  const hash = crypto.createHash('sha256');
  for (const file of (await fs.readdir(directory, { recursive: true })).sort()) {
    const target = path.join(directory, file);
    const stat = await fs.lstat(target);
    assert.equal(stat.isSymbolicLink(), false, `Unexpected bundle symlink ${file}`);
    if (stat.isFile()) hash.update(file).update(await fs.readFile(target));
  }
  return hash.digest('hex');
}

async function verifyArtifacts() {
  const updatePath = path.join(directory, 'update-darwin-arm64.json');
  const update = JSON.parse(await fs.readFile(updatePath));
  assert.equal(update.schemaVersion, 1);
  assert.equal(update.purpose, 'local-integrity-inventory');
  for (const key of ['form', 'version', 'build', 'channel', 'tagPrefix', 'commit', 'sourceFingerprint', 'binarySHA256', 'bundleContentSHA256', 'bundleIdentifier']) assert.equal(update[key], manifest[key]);
  assert.equal(update.platform, 'darwin');
  assert.equal(update.arch, 'arm64');
  assert.equal(update.releaseTag, `${product.tagPrefix}${product.version}`);
  assert.equal(update.minimumSystemVersion, product.minimumSystemVersion);
  assert.equal(update.published, false);
  assert.equal(update.updaterConsumed, false);
  assert.equal(update.installation, 'manual');
  assert.equal(update.automaticReplacement, false);
  assert.equal(update.updatePackageSignature, 'none');
  assert.deepEqual(update.signing, manifest.signing);
  assert.equal(update.assets.length, 2);
  const sums = new Map((await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8')).trim().split('\n').map((line) => {
    const match = line.match(/^([a-f0-9]{64})  ([^/\\]+)$/);
    assert.ok(match, 'Invalid checksum entry');
    return [match[2], match[1]];
  }));
  assert.equal(sums.size, 3);
  for (const asset of update.assets) {
    assert.equal(path.basename(asset.file), asset.file);
    const data = await fs.readFile(path.join(directory, asset.file));
    assert.equal(data.length, asset.bytes);
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), asset.sha256);
    assert.equal(sums.get(asset.file), asset.sha256);
  }
  assert.equal(sums.get('update-darwin-arm64.json'), crypto.createHash('sha256').update(await fs.readFile(updatePath)).digest('hex'));
  const dmg = update.assets.find((asset) => asset.kind === 'installer');
  const archive = update.assets.find((asset) => asset.kind === 'archive');
  assert.ok(dmg?.file.endsWith('-arm64.dmg'));
  assert.ok(archive?.file.endsWith('-darwin-arm64.tar.gz'));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-mygo-package-verify-'));
  const mount = path.join(temporary, 'mounted');
  let mounted = false;
  try {
    run('/usr/bin/hdiutil', ['verify', '-quiet', path.join(directory, dmg.file)]);
    await fs.mkdir(mount);
    run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-quiet', '-mountpoint', mount, path.join(directory, dmg.file)]);
    mounted = true;
    const mountedFiles = (await fs.readdir(mount)).filter((name) => !name.startsWith('.')).sort();
    assert.deepEqual(mountedFiles, ['Applications', appName + '.app'].sort());
    assert.equal(await fs.readlink(path.join(mount, 'Applications')), '/Applications');
    const mountedBundle = path.join(mount, appName + '.app');
    await verifyCopy(mountedBundle);
    const installed = path.join(temporary, 'installed', appName + '.app');
    run('/usr/bin/ditto', ['--norsrc', mountedBundle, installed]);
    await verifyCopy(installed);
    const entries = run('/usr/bin/tar', ['-tzf', path.join(directory, archive.file)]).split('\n');
    for (const entry of entries) assert.ok(entry.startsWith(appName + '.app/') && !entry.split('/').includes('..'), `Unsafe archive entry ${entry}`);
    const unpacked = path.join(temporary, 'archive');
    await fs.mkdir(unpacked);
    run('/usr/bin/tar', ['-xzf', path.join(directory, archive.file), '-C', unpacked]);
    await verifyCopy(path.join(unpacked, appName + '.app'));
    return { assets: update.assets, checksums: true, dmgMountedReadOnly: true, installedCopy: true, archiveExtracted: true, identicalBundleContent: true, mountedAndExtractedCLI: true, installation: 'manual' };
  } finally {
    if (mounted) run('/usr/bin/hdiutil', ['detach', '-quiet', mount]);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function verifyCopy(copy) {
  assert.equal(await directoryHash(copy), manifest.bundleContentSHA256, 'Packaged bundle differs from the built app');
  run('/usr/bin/codesign', ['--verify', '--strict', copy]);
  assert.deepEqual(JSON.parse(run(path.join(copy, 'Contents/MacOS', product.executable), ['--version'])), actual);
}
