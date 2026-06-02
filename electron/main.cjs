const { app, BrowserWindow, ipcMain, shell, session } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const isDev = process.env.VITE_DEV_SERVER_URL || !app.isPackaged;
const maxStampedBackups = 20;
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

const iCloudDirectory = () =>
  path.join(
    os.homedir(),
    "Library",
    "Mobile Documents",
    "com~apple~CloudDocs",
    "LocalOutline",
  );

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
    return url.protocol === "file:";
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
    const directory = iCloudDirectory();
    await fs.mkdir(directory, { recursive: true });
    const latestPath = path.join(directory, "localoutline-workspace.json");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const stampedPath = path.join(directory, `localoutline-workspace-${stamp}.json`);
    const content = JSON.stringify(payload, null, 2);
    await fs.writeFile(latestPath, content, "utf8");
    await fs.writeFile(stampedPath, content, "utf8");
    pruneStampedBackups(directory).catch((error) => {
      console.warn("Failed to prune old iCloud backups:", error);
    });
    return { ok: true, path: latestPath };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle("load-icloud-backup", async () => {
  try {
    const latestPath = path.join(iCloudDirectory(), "localoutline-workspace.json");
    const raw = await fs.readFile(latestPath, "utf8");
    return { ok: true, payload: JSON.parse(raw), path: latestPath };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});
