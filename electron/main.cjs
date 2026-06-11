const { app, BrowserWindow, dialog, ipcMain, Menu, shell, session } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { fileURLToPath, pathToFileURL } = require("node:url");
const {
  withWorkspaceWriteLock,
  writeFileAtomically,
} = require("./workspace-lock.cjs");
const {
  DEFAULT_RELEASES_PAGE_URL,
  fetchLatestRelease,
} = require("./update-checker.cjs");

const isDev = process.env.VITE_DEV_SERVER_URL || !app.isPackaged;
const maxStampedBackups = 20;
const cloudFolderName = "Bike";
const workspaceFilename = "bike-workspace.json";
const stampedBackupPrefix = "bike-workspace-";
const legacyCloudFolderName = "LocalOutline";
const legacyWorkspaceFilename = "localoutline-workspace.json";
let coreModulePromise;
let mainWindow = null;
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

const iCloudDirectory = async (folderName = cloudFolderName) => {
  if (process.platform === "win32") {
    const iCloudRoot = process.env.ICLOUDDRIVE || path.join(os.homedir(), "iCloudDrive");
    try {
      const stats = await fs.stat(iCloudRoot);
      if (!stats.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error("未找到 iCloud for Windows 的 iCloudDrive 目录，请先安装并登录 iCloud for Windows，或使用“导出工作区”手动保存。");
    }
    return path.join(iCloudRoot, folderName);
  }

  if (process.platform !== "darwin") {
    throw new Error("当前平台不支持自动 iCloud 备份，请使用“导出工作区”手动保存。");
  }

  return path.join(
    os.homedir(),
    "Library",
    "Mobile Documents",
    "com~apple~CloudDocs",
    folderName,
  );
};

const legacyICloudDirectory = () => iCloudDirectory(legacyCloudFolderName);

const migrateWorkspacePayload = async (payload) => {
  coreModulePromise ??= import(pathToFileURL(path.join(__dirname, "..", "mcp", "bike-core.mjs")).href);
  const { migrateWorkspace } = await coreModulePromise;
  return migrateWorkspace(payload);
};

const isRecord = (value) => typeof value === "object" && value !== null;

const hashContent = (value) => crypto.createHash("sha256").update(value).digest("hex");

const providerErrorMessage = (data) => {
  if (!isRecord(data)) return undefined;
  if (isRecord(data.error) && typeof data.error.message === "string") return data.error.message;
  if (typeof data.error === "string") return data.error;
  if (typeof data.detail === "string") return data.detail;
  if (Array.isArray(data.detail)) {
    const details = data.detail
      .map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item) && typeof item.msg === "string") return item.msg;
        if (isRecord(item) && typeof item.message === "string") return item.message;
        return "";
      })
      .filter(Boolean);
    if (details.length) return details.join("; ");
  }
  if (typeof data.message === "string") return data.message;
  return undefined;
};

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1366,
    height: 960,
    minWidth: 980,
    minHeight: 640,
    title: "Bike",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
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

const focusedAppWindow = () =>
  BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;

const openApiConfig = () => {
  focusedAppWindow()?.webContents.send("open-api-config");
};

const checkForUpdates = async () => {
  const currentVersion = app.getVersion();
  try {
    return await fetchLatestRelease({ currentVersion });
  } catch (error) {
    return {
      ok: false,
      currentVersion,
      latestVersion: "",
      updateAvailable: false,
      releaseUrl: DEFAULT_RELEASES_PAGE_URL,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const showMessageBox = (window, options) =>
  window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);

const showUpdateDialog = async () => {
  const result = await checkForUpdates();
  const window = focusedAppWindow();
  if (!result.ok) {
    await showMessageBox(window, {
      type: "warning",
      buttons: ["好", "打开发布页"],
      defaultId: 0,
      cancelId: 0,
      title: "检查更新",
      message: "检查更新失败",
      detail: `${result.error}\n\n当前版本：${result.currentVersion}`,
    }).then(({ response }) => {
      if (response === 1) shell.openExternal(result.releaseUrl || DEFAULT_RELEASES_PAGE_URL);
    });
    return result;
  }

  if (!result.updateAvailable) {
    await showMessageBox(window, {
      type: "info",
      buttons: ["好"],
      defaultId: 0,
      title: "检查更新",
      message: "已是最新版本",
      detail: `当前版本：${result.currentVersion}`,
    });
    return result;
  }

  await showMessageBox(window, {
    type: "info",
    buttons: ["打开发布页", "稍后"],
    defaultId: 0,
    cancelId: 1,
    title: "检查更新",
    message: `发现新版本 ${result.latestVersion}`,
    detail: `当前版本：${result.currentVersion}\n最新版本：${result.latestVersion}\n${result.releaseName ? `\n${result.releaseName}` : ""}`,
  }).then(({ response }) => {
    if (response === 0) shell.openExternal(result.releaseUrl || DEFAULT_RELEASES_PAGE_URL);
  });
  return result;
};

const installApplicationMenu = () => {
  const isMac = process.platform === "darwin";
  const configItem = {
    label: "配置API密钥",
    accelerator: "CmdOrCtrl+,",
    click: openApiConfig,
  };
  const checkUpdatesItem = {
    label: "检查更新",
    click: showUpdateDialog,
  };
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            checkUpdatesItem,
            { type: "separator" },
            configItem,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }]
      : []),
    {
      label: "文件",
      submenu: [
        ...(isMac ? [] : [configItem, { type: "separator" }]),
        { role: "close", label: isMac ? "关闭窗口" : "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新载入" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "切换全屏" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        ...(isMac ? [] : [checkUpdatesItem, { type: "separator" }]),
        {
          label: "打开发布页",
          click: () => shell.openExternal(DEFAULT_RELEASES_PAGE_URL),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

const aiEndpointPath = (endpoint) =>
  endpoint === "chat_completions" ? "chat/completions" : "responses";

const createAiEndpointUrl = (baseUrl, endpoint) => {
  const url = new URL(String(baseUrl ?? "").trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API baseurl 需要以 http:// 或 https:// 开头");
  }
  const pathName = url.pathname.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(pathName) || /\/responses$/i.test(pathName)) {
    return url.toString();
  }
  url.pathname = `${pathName}/${aiEndpointPath(endpoint)}`.replace(/\/{2,}/g, "/");
  return url.toString();
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

const pruneStampedBackups = async (directory, prefix = stampedBackupPrefix) => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const backups = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".json"))
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
  installApplicationMenu();
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
    const latestPath = path.join(directory, workspaceFilename);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const stampedPath = path.join(directory, `${stampedBackupPrefix}${stamp}.json`);
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
    const currentPath = path.join(await iCloudDirectory(), workspaceFilename);
    const legacyPath = path.join(await legacyICloudDirectory(), legacyWorkspaceFilename);
    const latestPath = await fs.access(currentPath)
      .then(() => currentPath)
      .catch(() => legacyPath);
    const raw = await fs.readFile(latestPath, "utf8");
    return { ok: true, payload: JSON.parse(raw), path: latestPath, revision: hashContent(raw) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle("check-for-updates", async () => checkForUpdates());

ipcMain.handle("invoke-ai-provider", async (_event, payload) => {
  try {
    if (!isRecord(payload)) throw new Error("AI 请求参数无效");
    const endpoint = payload.endpoint === "chat_completions" ? "chat_completions" : "responses";
    const baseUrl = typeof payload.baseUrl === "string" ? payload.baseUrl : "";
    const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
    if (!apiKey) throw new Error("请输入 API key");
    const body = isRecord(payload.body) ? payload.body : {};
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    const response = await fetch(createAiEndpointUrl(baseUrl, endpoint), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    const data = text
      ? (() => {
          try {
            return JSON.parse(text);
          } catch {
            return { text };
          }
        })()
      : null;
    if (response.ok && /^text\/html\\b/i.test(contentType)) {
      throw new Error("AI 端点返回了 HTML 页面，请检查 API baseurl 和协议端点是否匹配");
    }
    if (!response.ok) {
      const providerError = providerErrorMessage(data);
      throw new Error(providerError || `AI 请求失败：HTTP ${response.status}`);
    }
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});
