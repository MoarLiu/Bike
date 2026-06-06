const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const defaultLockOptions = {
  timeoutMs: 5000,
  staleMs: 10 * 60 * 1000,
  retryMs: 50,
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const workspaceLockPath = (workspacePath) =>
  path.join(path.dirname(workspacePath), `.${path.basename(workspacePath)}.lock`);

const parseWorkspaceLock = (raw) => {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && typeof parsed.ownerToken === "string"
      ? parsed
      : {};
  } catch {
    return {};
  }
};

const readWorkspaceLock = async (lockPath) => {
  const [raw, stats] = await Promise.all([
    fs.readFile(lockPath, "utf8"),
    fs.stat(lockPath),
  ]);
  return {
    raw,
    ownerToken: parseWorkspaceLock(raw).ownerToken,
    modifiedAt: stats.mtimeMs,
  };
};

const unlinkLockIfRawMatches = async (lockPath, raw) => {
  try {
    if ((await fs.readFile(lockPath, "utf8")) === raw) {
      await fs.unlink(lockPath);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};

const releaseWorkspaceWriteLock = async (lockPath, ownerToken) => {
  try {
    const lock = await readWorkspaceLock(lockPath);
    if (lock.ownerToken === ownerToken) await fs.unlink(lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};

const removeStaleLock = async (lockPath, options = {}) => {
  const { staleMs } = { ...defaultLockOptions, ...options };
  try {
    const lock = await readWorkspaceLock(lockPath);
    if (Date.now() - lock.modifiedAt >= staleMs) {
      if (lock.ownerToken) {
        await releaseWorkspaceWriteLock(lockPath, lock.ownerToken);
      } else {
        await unlinkLockIfRawMatches(lockPath, lock.raw);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};

const lockFileContent = (workspacePath, ownerToken) =>
  `${JSON.stringify(
    {
      pid: process.pid,
      ownerToken,
      createdAt: new Date().toISOString(),
      workspacePath: path.basename(workspacePath),
    },
    null,
    2,
  )}\n`;

const acquireWorkspaceWriteLock = async (workspacePath, options = {}) => {
  const { timeoutMs, retryMs } = { ...defaultLockOptions, ...options };
  const lockPath = workspaceLockPath(workspacePath);
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const ownerToken = crypto.randomBytes(16).toString("hex");
    try {
      await fs.writeFile(lockPath, lockFileContent(workspacePath, ownerToken), {
        encoding: "utf8",
        flag: "wx",
      });
      return async () => releaseWorkspaceWriteLock(lockPath, ownerToken);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await removeStaleLock(lockPath, options);
      await delay(retryMs);
    }
  }
  throw new Error("工作区正在被另一个 LocalOutline 写入，请稍后重试");
};

const withWorkspaceWriteLock = async (workspacePath, callback, options = {}) => {
  const release = await acquireWorkspaceWriteLock(workspacePath, options);
  try {
    return await callback();
  } finally {
    await release();
  }
};

const writeFileAtomically = async (filePath, content) => {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const tempPath = path.join(
    directory,
    `.${basename}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  await fs.writeFile(tempPath, content, "utf8");
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
};

module.exports = {
  acquireWorkspaceWriteLock,
  readWorkspaceLock,
  releaseWorkspaceWriteLock,
  removeStaleLock,
  withWorkspaceWriteLock,
  workspaceLockPath,
  writeFileAtomically,
};
