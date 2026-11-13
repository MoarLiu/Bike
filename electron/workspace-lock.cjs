const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const processBirth = (pid) => {
  if (process.platform === "linux") {
    try {
      const { readFileSync } = require("node:fs");
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const started = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (/^\d+$/.test(started) && boot) return `linux:${boot}:${started}`;
    } catch { /* Fall back on hosts without procfs. */ }
  }
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1000, env: { ...process.env, LC_ALL: "C" } });
  return result.status === 0 ? result.stdout.trim() || null : null;
};
const ownBirth = processBirth(process.pid);

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
  const parsed = parseWorkspaceLock(raw);
  return {
    raw,
    ownerToken: parsed.ownerToken,
    pid: parsed.pid,
    processBirth: parsed.processBirth,
    hostname: parsed.hostname,
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
    if (lock.ownerToken === ownerToken) await unlinkLockIfRawMatches(lockPath, lock.raw);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};

const removeStaleLock = async (lockPath, options = {}) => {
  const { staleMs } = { ...defaultLockOptions, ...options };
  try {
    const lock = await readWorkspaceLock(lockPath);
    const validPid = Number.isSafeInteger(lock.pid) && lock.pid > 0;
    const sameHost = !lock.hostname || lock.hostname === os.hostname();
    let ownerAlive = validPid && (!sameHost || isProcessAlive(lock.pid));
    if (ownerAlive && sameHost && lock.processBirth) {
      const birth = processBirth(lock.pid);
      if (birth && birth !== lock.processBirth) ownerAlive = false;
    }
    if ((validPid && !ownerAlive) || (!validPid && Date.now() - lock.modifiedAt >= staleMs)) {
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
const isProcessAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
};

const lockFileContent = (workspacePath, ownerToken) =>
  `${JSON.stringify(
    {
      pid: process.pid,
      processBirth: ownBirth,
      hostname: os.hostname(),
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
        mode: 0o600,
      });
      return async () => releaseWorkspaceWriteLock(lockPath, ownerToken);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await removeStaleLock(lockPath, options);
      await delay(retryMs);
    }
  }
  throw Object.assign(new Error("工作区正在被另一个 Bike 写入，请稍后重试"), { code: "WORKSPACE_LOCK_BUSY", statusCode: 503 });
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
  const original = await assertRegularWriteTarget(filePath);
  try {
    await writeFileDurably(tempPath, content, original ? original.mode & 0o777 : 0o600);
    const latest = await assertRegularWriteTarget(filePath);
    if (original ? !latest || ["ino", "dev", "mtimeMs", "size", "mode"].some((key) => original[key] !== latest[key]) : latest) {
      throw new Error("写入期间目标文件已变化，已保留原文件，请重试");
    }
    await fs.rename(tempPath, filePath);
    await fsyncDirectory(directory);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
};

const writeFileDurably = async (filePath, content, mode) => {
  const handle = await fs.open(filePath, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
};
const assertRegularWriteTarget = async (filePath) => {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink()) throw new Error("工作区路径是符号链接，已拒绝写入；请配置实际文件路径");
    if (!stats.isFile()) throw new Error("写入目标不是普通文件");
    return stats;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
};

const fsyncDirectory = async (directory) => {
  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not available on every platform/filesystem.
  }
};

module.exports = {
  assertRegularWriteTarget,
  isProcessAlive,
  acquireWorkspaceWriteLock,
  readWorkspaceLock,
  releaseWorkspaceWriteLock,
  removeStaleLock,
  withWorkspaceWriteLock,
  workspaceLockPath,
  writeFileAtomically,
};
