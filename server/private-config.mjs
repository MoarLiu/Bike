import { stat, chmod } from 'node:fs/promises';

export const ensurePrivateConfig = async (filename) => {
  const metadata = await stat(filename);
  if ((metadata.mode & 0o077) === 0) return; // private read-only mounts need no chmod
  try { await chmod(filename, 0o600); }
  catch { throw new Error('配置可以读取，但权限不是 0600 且无法自动加固。请由管理员将配置属主设为服务用户，并设置 chmod 600 后重试。'); }
};
