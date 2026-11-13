import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { attempt, field, notarizedAssessment, validTeam } from './signing-tools.mjs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';

// 核对正式签名产物：Developer ID 身份、hardened runtime、公证票据、Gatekeeper 评估，
// 以及 latest-mac.yml 与 ZIP/DMG 的版本、大小和 SHA-512 一致性。
// 用法：npm run release:verify:signed -- [产物目录] [--json]
// 只在 macOS 上运行；不依赖网络，可离线核对已装订票据。

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const emitJson = process.argv.includes('--json');
const directory = path.resolve(root, args[0] ?? 'release');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const expectedTeam = process.env.BIKE_EXPECTED_TEAM_ID?.trim();
const expectedIdentifier = 'com.bike.app';
const results = [];
const record = (ok, name, detail = '') => {
  results.push({ ok, name, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sha512 = (buffer) => createHash('sha512').update(buffer).digest('base64');
const clean = (output) => output.split('\n').filter(Boolean).slice(-3).join(' | ');

if (process.platform !== 'darwin') {
  console.error('正式签名产物核对只能在 macOS 上执行。');
  process.exit(1);
}
if (!validTeam(expectedTeam)) throw new Error('请设置 BIKE_EXPECTED_TEAM_ID 为预期的 10 位 Team ID；禁止从候选产物自动信任身份');

const dmg = path.join(directory, `Bike-${version}-arm64.dmg`);
const zip = path.join(directory, `Bike-${version}-arm64.zip`);
const manifestPath = path.join(directory, 'latest-mac.yml');

const verifyApp = (app, label) => {
  const verify = attempt('codesign', ['--verify', '--deep', '--strict', app]);
  record(verify.ok, `${label} 严格签名校验`, verify.ok ? '通过' : clean(verify.output));
  const info = attempt('codesign', ['-d', '--verbose=4', app]);
  const authority = field(info.output, 'Authority');
  const team = field(info.output, 'TeamIdentifier');
  record(/^Developer ID Application:/u.test(authority ?? ''), `${label} 签名身份`, authority ?? '未发现 Developer ID Application');
  record(team === expectedTeam, `${label} TeamIdentifier`, `${team ?? '缺失'}（期望 ${expectedTeam}）`);
  const plist = attempt('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')]);
  let bundle = {};
  try { if (plist.ok) bundle = JSON.parse(plist.stdout); } catch { /* recorded below */ }
  record(bundle.CFBundleIdentifier === expectedIdentifier, `${label} Bundle ID`, bundle.CFBundleIdentifier ?? '缺失');
  record(bundle.CFBundleShortVersionString === version, `${label} 应用版本`, bundle.CFBundleShortVersionString ?? '缺失');
  record(bundle.CFBundleVersion === version, `${label} 构建号`, `${bundle.CFBundleVersion ?? '缺失'}（期望 ${version}）`);
  record(/flags=0x[0-9a-f]*\([^)]*\bruntime\b[^)]*\)/u.test(info.output), `${label} hardened runtime`, info.output.match(/flags=[^\n]*/u)?.[0] ?? '未启用');
  const staple = attempt('xcrun', ['stapler', 'validate', app]);
  record(staple.ok, `${label} 公证票据装订`, staple.ok ? '通过' : clean(staple.output));
  const assess = attempt('spctl', ['--assess', '--type', 'exec', '-vvv', app]);
  record(notarizedAssessment(assess), `${label} Gatekeeper 评估`, assess.output.match(/source=.+/u)?.[0] ?? clean(assess.output));
  return team ?? null;
};

const mountedApps = async (mountpoint, label) => {
  const entries = await fs.readdir(mountpoint);
  const appName = entries.find((name) => name.endsWith('.app'));
  if (!appName) {
    record(false, `${label} 包含 App`, `未在 ${mountpoint} 找到 .app`);
    return null;
  }
  return verifyApp(path.join(mountpoint, appName), `${label}内应用`);
};

try {
  const existing = [];
  for (const file of [dmg, zip, manifestPath]) {
    try {
      await fs.access(file);
      existing.push(file);
    } catch {
      record(false, `产物存在：${path.basename(file)}`, `缺少 ${path.relative(root, file)}`);
    }
  }
  if (existing.length !== 3) throw new Error('release artifacts are incomplete');

  const manifest = yaml.load(await fs.readFile(manifestPath, 'utf8'));
  record(manifest.version === version, '更新清单版本', `${manifest.version}（期望 ${version}）`);
  const entries = new Map((manifest.files ?? []).map((entry) => [entry.url, entry]));
  record(manifest.path === path.basename(zip) && manifest.sha512 === sha512(await fs.readFile(zip)), '更新清单顶层 ZIP 与 SHA-512', manifest.path ?? '缺失');
  for (const [file, name] of [[zip, path.basename(zip)], [dmg, path.basename(dmg)]]) {
    const entry = entries.get(name);
    if (!entry) {
      record(false, `更新清单包含 ${name}`, 'missing');
      continue;
    }
    const buffer = await fs.readFile(file);
    record(entry.sha512 === sha512(buffer), `更新清单 SHA-512：${name}`, entry.sha512 === sha512(buffer) ? '一致' : `清单 ${String(entry.sha512).slice(0, 16)}… 实际 ${sha512(buffer).slice(0, 16)}…`);
    record(entry.size === buffer.length, `更新清单大小：${name}`, `${entry.size} / ${buffer.length}`);
    const checksum = (await fs.readFile(`${file}.sha256`, 'utf8')).trim().split(/\s+/u)[0];
    record(checksum === createHash('sha256').update(buffer).digest('hex'), `独立 SHA-256：${name}`, '与实际文件比较');
    const blockmap = await fs.readFile(`${file}.blockmap`);
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-blockmap-'));
    try {
      const rebuilt = path.join(temporary, 'rebuilt.blockmap');
      const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap.js');
      await buildBlockMap(file, 'gzip', rebuilt);
      record(gunzipSync(blockmap).equals(gunzipSync(await fs.readFile(rebuilt))), `差分更新索引：${name}`, '使用实际产物重新计算并比较全部块');
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }

  let dmgTeam = null;
  const dmgInfo = attempt('codesign', ['-d', '--verbose=4', dmg]);
  record(/^Developer ID Application:/mu.test(field(dmgInfo.output, 'Authority') ?? ''), 'DMG 签名身份', field(dmgInfo.output, 'Authority') ?? '未签名');
  record(field(dmgInfo.output, 'TeamIdentifier') === expectedTeam, 'DMG Team ID', field(dmgInfo.output, 'TeamIdentifier') ?? '缺失');
  const dmgAssess = attempt('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-vvv', dmg]);
  record(notarizedAssessment(dmgAssess), 'DMG Gatekeeper 评估', dmgAssess.output.match(/source=.+/u)?.[0] ?? clean(dmgAssess.output));
  const dmgStaple = attempt('xcrun', ['stapler', 'validate', dmg]);
  record(dmgStaple.ok, 'DMG 票据装订', dmgStaple.ok ? '通过' : clean(dmgStaple.output));

  const mountpoint = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-dmg-'));
  try {
    const attach = attempt('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountpoint, dmg]);
    record(attach.ok, 'DMG 只读挂载', attach.ok ? '通过' : clean(attach.output));
    if (attach.ok) dmgTeam = await mountedApps(mountpoint, 'DMG ');
  } finally {
    attempt('hdiutil', ['detach', '-force', mountpoint]);
    await fs.rm(mountpoint, { recursive: true, force: true });
  }

  const extract = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-zip-'));
  try {
    const unzip = attempt('ditto', ['-x', '-k', zip, extract]);
    record(unzip.ok, 'ZIP 解压', unzip.ok ? '通过' : clean(unzip.output));
    if (unzip.ok) {
      const zipTeam = await mountedApps(extract, 'ZIP ');
      record(zipTeam != null && zipTeam === dmgTeam, 'ZIP 与 DMG 身份一致', `${zipTeam ?? '缺失'} / ${dmgTeam ?? '缺失'}`);
    }
  } finally {
    await fs.rm(extract, { recursive: true, force: true });
  }

  const failures = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failures.length}/${results.length} 项通过。`);
  if (emitJson) {
    const evidencePath = path.join(directory, 'signature-verification.json');
    await fs.writeFile(evidencePath, `${JSON.stringify({ version, directory: path.relative(root, directory), verifiedAt: new Date().toISOString(), results }, null, 2)}\n`);
    console.log(`证据已写入 ${path.relative(root, evidencePath)}`);
  }
  if (failures.length > 0) {
    console.log('存在未通过的签名/公证检查；该候选不能作为正式发布验证。');
    process.exit(1);
  }
  console.log('正式签名、公证、装订、更新清单一致性全部通过。');
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
