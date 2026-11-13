import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CSC_|APPLE_|NOTARY_)/u.test(key)));
const run = (command, args, env) => {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', timeout: 45 * 60 * 1000 });
  if (result.error || result.status !== 0) throw new Error(`签名候选检查失败：${command}（${result.status ?? result.error?.code}）`);
};
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'check'], clean);
run(process.execPath, ['scripts/preflight-signing.mjs'], process.env);
run(process.execPath, ['scripts/build-signed-mac.mjs'], process.env);
