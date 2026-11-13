import os from 'node:os';
import { attempt, validTeam } from './signing-tools.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 正式签名/公证的本地与 CI 前置检查。只读，不修改任何产物。
// 用法：CSC_NAME="Developer ID Application: ..." APPLE_KEYCHAIN_PROFILE=... npm run release:preflight:signed

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const record = (status, name, detail) => {
  checks.push({ status, name, detail });
  const symbol = status === 'pass' ? '✓' : status === 'warn' ? '!' : '✗';
  console.log(`${symbol} ${name} — ${detail}`);
};

const identity = process.env.CSC_NAME?.trim();
const profile = process.env.APPLE_KEYCHAIN_PROFILE?.trim();
const keychain = process.env.APPLE_KEYCHAIN?.trim();
const certificateArchive = process.env.CSC_LINK?.trim();
const entitlements = path.join(root, 'config/entitlements.mac.plist');
const scripts = path.join(root, 'scripts');
const expectedTeam = process.env.BIKE_EXPECTED_TEAM_ID?.trim();
record(validTeam(expectedTeam) ? 'pass' : 'fail', '预期 Team ID', validTeam(expectedTeam) ? expectedTeam : '请设置 BIKE_EXPECTED_TEAM_ID');

record(process.platform === 'darwin' ? 'pass' : 'fail', '运行平台', `${process.platform}（Developer ID 签名与公证只能在 macOS 上执行）`);

const developerDirectory = attempt('xcode-select', ['-p']);
if (!developerDirectory.ok) {
  record('fail', 'Xcode 工具链', developerDirectory.output);
} else if (developerDirectory.output.includes('CommandLineTools')) {
  record('warn', 'Xcode 工具链', `${developerDirectory.output.trim()}（codesign/notarytool/stapler 仍可用，但建议 sudo xcode-select -s /Applications/Xcode.app/Contents/Developer）`);
} else {
  record('pass', 'Xcode 工具链', developerDirectory.output.trim());
}

const notarytool = attempt('xcrun', ['notarytool', '--version']);
record(notarytool.ok ? 'pass' : 'fail', 'notarytool 可用', notarytool.ok ? notarytool.output.trim() : notarytool.output);

if (!identity) {
  record('fail', 'CSC_NAME', '未设置；需要完整身份名，例如 "Developer ID Application: 姓名 (TEAMID)"');
} else if (!identity.startsWith('Developer ID Application:')) {
  record('fail', 'CSC_NAME', `"${identity}" 不是 Developer ID Application 身份；自签或 Apple Development 证书无法公证`);
} else {
  record('pass', 'CSC_NAME', identity);
}

let certificates = '';
if (certificateArchive) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bike-signing-preflight-'));
  try {
    fs.chmodSync(temporary, 0o700);
    const filename = path.join(temporary, 'identity.p12');
    const encoded = certificateArchive.replace(/^data:[^,]*;base64,/u, '');
    const contents = fs.existsSync(certificateArchive) ? fs.readFileSync(certificateArchive) : Buffer.from(encoded, 'base64');
    if (!contents.length || contents.length > 16 * 1024 * 1024) throw new Error('p12 大小无效');
    fs.writeFileSync(filename, contents, { mode: 0o600 });
    if (!process.env.CSC_KEY_PASSWORD) throw new Error('CSC_KEY_PASSWORD 未设置');
    const decoded = attempt('openssl', ['pkcs12', '-in', filename, '-nokeys', '-clcerts', '-passin', 'env:CSC_KEY_PASSWORD']);
    if (!decoded.ok) throw new Error('p12 无法解码，请检查证书格式和密码');
    certificates = decoded.stdout;
    record('pass', 'p12 解码', '证书包与密码有效');
  } catch (error) { record('fail', 'p12 解码', error.message); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
} else {
  const identities = attempt('security', ['find-identity', '-v', '-p', 'codesigning']);
  const active = identities.output.split('\n').find(line => line.trim().endsWith(`"${identity}"`));
  const fingerprint = active?.match(/\b([A-F0-9]{40})\b/iu)?.[1]?.toUpperCase();
  const found = identity ? attempt('security', ['find-certificate', '-a', '-c', identity, '-p']) : { ok: false, stdout: '' };
  if (fingerprint && found.ok) {
    for (const pem of found.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) ?? []) {
      const hash = attempt('openssl', ['x509', '-noout', '-fingerprint', '-sha1'], { input: pem });
      if (hash.ok && hash.stdout.split('=').at(-1).replaceAll(':', '').trim().toUpperCase() === fingerprint) certificates = pem;
    }
  }
  record(certificates ? 'pass' : 'fail', '钥匙串签名身份', certificates ? '使用有效签名身份对应的证书指纹' : '未找到匹配的有效 Developer ID 身份');
}
let matchingCertificate = false;
for (const pem of certificates.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) ?? []) {
  const subject = attempt('openssl', ['x509', '-noout', '-subject', '-nameopt', 'sep_multiline'], { input: pem });
  const fields = subject.stdout.split('\n').map(line => line.trim().replace(/\s*=\s*/u, '='));
  if (!fields.includes(`CN=${identity}`) || !fields.includes(`OU=${expectedTeam}`)) continue;
  const expiry = attempt('openssl', ['x509', '-noout', '-checkend', '86400'], { input: pem });
  if (expiry.ok) matchingCertificate = true;
}
record(matchingCertificate ? 'pass' : 'fail', '证书身份、Team ID 与有效期', matchingCertificate ? '精确匹配预期身份，至少还有 24 小时有效期' : '没有同时满足身份、Team ID 和有效期的证书');

if (!profile) {
  record('fail', 'APPLE_KEYCHAIN_PROFILE', '未设置；先执行 xcrun notarytool store-credentials 保存公证凭据');
} else {
  const args = ['notarytool', 'history', '--keychain-profile', profile];
  if (keychain) args.push('--keychain', keychain);
  const history = attempt('xcrun', args);
  const output = history.output.trim();
  if (history.ok) {
    record('pass', '公证凭据', `notarytool 可读取 profile "${profile}"`);
  } else if (output.includes('No Keychain password item')) {
    record('fail', '公证凭据', `profile "${profile}" 不存在；执行：xcrun notarytool store-credentials "${profile}" --apple-id <账号> --team-id <TEAMID>（省略 --password 后按交互提示输入密码）`);
  } else {
    record('fail', '公证凭据', '公证凭据或网络验证失败，请检查后重试');
  }
}

if (!fs.existsSync(entitlements)) {
  record('fail', 'entitlements', `${path.relative(root, entitlements)} 不存在`);
} else {
  const parsed = attempt('plutil', ['-convert', 'json', '-o', '-', entitlements]);
  let plist;
  try { if (parsed.ok) plist = JSON.parse(parsed.stdout); } catch {}
  record(plist && plist['com.apple.security.get-task-allow'] !== true ? 'pass' : 'fail', 'entitlements', '验证有效 plist，禁止调试授权');
  record(plist?.['com.apple.security.cs.allow-jit'] === true ? 'pass' : 'fail', 'entitlements allow-jit', 'Electron hardened runtime 必须启用 JIT');
}

record(fs.existsSync(path.join(scripts, 'build-signed-mac.mjs')) ? 'pass' : 'fail', '签名构建脚本', 'scripts/build-signed-mac.mjs');

const failures = checks.filter((check) => check.status === 'fail').length;
const warnings = checks.filter((check) => check.status === 'warn').length;
console.log(`\n通过 ${checks.length - failures - warnings} 项，警告 ${warnings} 项，失败 ${failures} 项。`);
if (failures > 0) {
  console.log('正式签名前置条件未满足；在上述失败项修复前，只能产出 ad-hoc 产物。');
  process.exit(1);
}
console.log('前置条件满足，可以执行 npm run electron:dist:signed。');
