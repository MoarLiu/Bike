const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const isDev = process.env.VITE_DEV_SERVER_URL || !app.isPackaged;

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
    },
  });

  if (isDev) {
    window.loadURL("http://127.0.0.1:5173");
  } else {
    window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
};

app.whenReady().then(createWindow);

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
