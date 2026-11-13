const fs = require("node:fs/promises");
const path = require("node:path");
const cleanupTransferFiles = async (directory, now = Date.now()) => {
  let entries;
  try {
    const root = await fs.lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("附件暂存目录无效");
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}\.(part|json)$/.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name), stat = await fs.lstat(file);
    if (now - stat.mtimeMs >= 7 * 86400000) await fs.rm(file);
  }
};
const cleanupOpenFiles = async (directory, now = Date.now()) => {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!/^bike-(?:mygo-)?open-/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name), stat = await fs.lstat(file);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) continue;
    if (now - stat.mtimeMs >= 7 * 86400000) await fs.rm(file, { recursive: true, force: true });
  }
};
module.exports = { cleanupTransferFiles, cleanupOpenFiles };
