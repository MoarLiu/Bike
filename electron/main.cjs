const { app, BrowserWindow, ipcMain, shell, session } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { fileURLToPath, pathToFileURL } = require("node:url");
const {
  withWorkspaceWriteLock,
  writeFileAtomically,
} = require("./workspace-lock.cjs");

const isDev = process.env.VITE_DEV_SERVER_URL || !app.isPackaged;
const maxStampedBackups = 20;
let coreModulePromise;
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: file:",
  "font-src 'self'",
  "connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

const iCloudDirectory = async () => {
  if (process.platform === "win32") {
    const iCloudRoot = process.env.ICLOUDDRIVE || path.join(os.homedir(), "iCloudDrive");
    try {
      const stats = await fs.stat(iCloudRoot);
      if (!stats.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error("未找到 iCloud for Windows 的 iCloudDrive 目录，请先安装并登录 iCloud for Windows，或使用“导出工作区”手动保存。");
    }
    return path.join(iCloudRoot, "LocalOutline");
  }

  if (process.platform !== "darwin") {
    throw new Error("当前平台不支持自动 iCloud 备份，请使用“导出工作区”手动保存。");
  }

  return path.join(
    os.homedir(),
    "Library",
    "Mobile Documents",
    "com~apple~CloudDocs",
    "LocalOutline",
  );
};

const migrateWorkspacePayload = async (payload) => {
  coreModulePromise ??= import(pathToFileURL(path.join(__dirname, "..", "mcp", "localoutline-core.mjs")).href);
  const { migrateWorkspace } = await coreModulePromise;
  return migrateWorkspace(payload);
};

const isRecord = (value) => typeof value === "object" && value !== null;

const hashContent = (value) => crypto.createHash("sha256").update(value).digest("hex");

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: "Local Outline",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    const current = window.webContents.getURL();
    if (url === current || isAllowedAppUrl(url)) return;
    event.preventDefault();
    if (isExternalUrl(url)) {
      shell.openExternal(url);
    }
  });

  window.webContents.on("will-redirect", (event, url) => {
    if (!isAllowedAppUrl(url)) {
      event.preventDefault();
      if (isExternalUrl(url)) shell.openExternal(url);
    }
  });

  if (isDev) {
    window.loadURL("http://127.0.0.1:5173");
  } else {
    window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
};

const isExternalUrl = (value) => {
  try {
    const url = new URL(value);
    if (isDev && url.origin === "http://127.0.0.1:5173") return false;
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" || url.protocol === "tel:";
  } catch {
    return false;
  }
};

const isAllowedAppUrl = (value) => {
  try {
    const url = new URL(value);
    if (isDev) return url.origin === "http://127.0.0.1:5173";
    if (url.protocol !== "file:") return false;
    return path.normalize(fileURLToPath(url)) === path.normalize(path.join(__dirname, "..", "dist", "index.html"));
  } catch {
    return false;
  }
};

const installContentSecurityPolicy = () => {
  if (isDev) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [contentSecurityPolicy],
      },
    });
  });
};

const pruneStampedBackups = async (directory) => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const backups = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith("localoutline-workspace-") && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const filePath = path.join(directory, entry.name);
        const stats = await fs.stat(filePath);
        return { filePath, modifiedAt: stats.mtimeMs };
      }),
  );
  await Promise.all(
    backups
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .slice(maxStampedBackups)
      .map((backup) => fs.rm(backup.filePath, { force: true })),
  );
};

app.whenReady().then(() => {
  installContentSecurityPolicy();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle("save-icloud-backup", async (_event, payload) => {
  try {
    const request = isRecord(payload) && "workspace" in payload
      ? payload
      : { workspace: payload };
    const expectedRevision = typeof request.expectedRevision === "string" && request.expectedRevision.trim()
      ? request.expectedRevision
      : undefined;
    const workspace = await migrateWorkspacePayload(request.workspace);
    const directory = await iCloudDirectory();
    await fs.mkdir(directory, { recursive: true });
    const latestPath = path.join(directory, "localoutline-workspace.json");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const stampedPath = path.join(directory, `localoutline-workspace-${stamp}.json`);
    const content = JSON.stringify(workspace, null, 2);
    const nextRevision = hashContent(content);
    await withWorkspaceWriteLock(latestPath, async () => {
      const existingRaw = await fs.readFile(latestPath, "utf8").catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      const existingRevision = existingRaw ? hashContent(existingRaw) : undefined;
      if (
        existingRevision &&
        existingRevision !== nextRevision &&
        existingRevision !== expectedRevision
      ) {
        throw new Error("iCloud 文件有外部修改，已取消覆盖。请先“载入备份”确认最新内容后再备份。");
      }
      await writeFileAtomically(stampedPath, content);
      await writeFileAtomically(latestPath, content);
    });
    pruneStampedBackups(directory).catch((error) => {
      console.warn("Failed to prune old iCloud backups:", error);
    });
    return { ok: true, path: latestPath, revision: nextRevision };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle("load-icloud-backup", async () => {
  try {
    const latestPath = path.join(await iCloudDirectory(), "localoutline-workspace.json");
    const raw = await fs.readFile(latestPath, "utf8");
    return { ok: true, payload: JSON.parse(raw), path: latestPath, revision: hashContent(raw) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});
