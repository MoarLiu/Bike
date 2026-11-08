import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export const sessionStateFileName = "auth-session.json";

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

// auth.sessionStatePath (relative to the project root) wins; otherwise use the
// directory systemd provides through StateDirectory= (the variable may list
// several colon-separated paths, the first one is ours); otherwise data/.
export const resolveSessionStatePath = ({ configuredPath, projectRoot, env = process.env }) => {
  const configured = typeof configuredPath === "string" ? configuredPath.trim() : configuredPath;
  if (configured) return path.resolve(projectRoot, String(configured));
  const stateDirectory = String(env.STATE_DIRECTORY || "")
    .split(":")
    .map((entry) => entry.trim())
    .find(Boolean);
  if (stateDirectory) return path.resolve(projectRoot, stateDirectory, sessionStateFileName);
  return path.join(projectRoot, "data", sessionStateFileName);
};

// A missing file means no logout has been recorded yet. A file that exists but
// cannot be read or parsed fails safe: every session issued before startup is
// treated as revoked, because a logged-out session must never come back.
export const loadSessionRevokedBefore = async (
  statePath,
  { now = Date.now, logger = console } = {},
) => {
  let text;
  try {
    text = await readFile(statePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    logger.error(
      `无法读取会话状态文件：${statePath}（${errorMessage(error)}）。为安全起见，启动前签发的登录会话全部失效。`,
    );
    return now();
  }
  try {
    const value = JSON.parse(text)?.sessionRevokedBefore;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("sessionRevokedBefore 不是有效的时间戳");
    }
    return value;
  } catch (error) {
    logger.error(
      `会话状态文件已损坏：${statePath}（${errorMessage(error)}）。为安全起见，启动前签发的登录会话全部失效；下次退出登录时会重写该文件。`,
    );
    return now();
  }
};

// Write to a private temp file in the same directory, flush it, then rename it
// over the old file so readers only ever see a complete state file.
export const saveSessionRevokedBefore = async (statePath, sessionRevokedBefore) => {
  const directory = path.dirname(statePath);
  await mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(statePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ sessionRevokedBefore })}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, statePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
};

export const createSessionStateStore = (statePath, { now = Date.now, logger = console } = {}) => {
  let writes = Promise.resolve();
  return {
    path: statePath,
    load: () => loadSessionRevokedBefore(statePath, { now, logger }),
    // Writes are serialized so a slower, older write can never land last.
    save(sessionRevokedBefore) {
      const write = writes.then(() => saveSessionRevokedBefore(statePath, sessionRevokedBefore));
      writes = write.catch(() => {});
      return write;
    },
  };
};
