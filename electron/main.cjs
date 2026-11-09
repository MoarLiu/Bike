const { app, BrowserWindow, dialog, ipcMain, Menu, shell, session } = require("electron");
const { verifySavedBackupSource } = require("./backup-source.cjs");
const { isTrustedIpcSender, configuredNetworkRequest, safeReleaseUrl } = require("./ipc-guard.cjs");
const { requestJson } = require("./network-proxy.cjs");
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
const { resolveDevServer } = require("./dev-server.cjs");
const { editCommandForInput } = require("./edit-shortcuts.cjs");
const { createBackupService, MESSAGES: backupMessages } = require("./backup-service.cjs");

const devServer = resolveDevServer({ env: process.env, isPackaged: app.isPackaged });
if (devServer.warning) console.warn(devServer.warning);
const isDev = devServer.isDev;
if (process.env.BIKE_TEST_USER_DATA) app.setPath("userData", path.resolve(process.env.BIKE_TEST_USER_DATA));
const ownsInstance = isDev || app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
const maxStampedBackups = 20;
const cloudFolderName = "Bike";
const workspaceFilename = "bike-workspace.json";
const stampedBackupPrefix = "bike-workspace-";
const legacyCloudFolderName = "LocalOutline";
const legacyWorkspaceFilename = "localoutline-workspace.json";
let coreModulePromise;
let backupServicePromise;
let mainWindow = null;
let quitting = false;
const aiRequests = new Map();
const cancelledAiRequests = new Map();
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: file:",
  "font-src 'self'",
  isDev ? `connect-src 'self' ${new URL(devServer.url).origin} ${new URL(devServer.url).origin.replace(/^http/u, "ws")}` : "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

const iCloudDirectory = async (folderName = cloudFolderName) => {
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

const removeLegacySyncSecret = async () => {
  await fs.rm(path.join(app.getPath("userData"), "sync-secret.json"), { force: true });
};

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


const backupService = () => {
  backupServicePromise ??= (async () => {
    const service = createBackupService({
      fs,
      path,
      getDirectory: () => iCloudDirectory(),
      workspaceFilename,
      stampedPrefix: stampedBackupPrefix,
      maxStamped: maxStampedBackups,
      lock: withWorkspaceWriteLock,
      writeAtomic: writeFileAtomically,
      hash: hashContent,
      now: () => Date.now(),
      readSettings: () => fs.readFile(path.join(app.getPath("userData"), "backup-settings.json"), "utf8").catch((error) => {
        if (error?.code === "ENOENT") return "";
        throw error;
      }),
      writeSettings: (value) => writeFileAtomically(path.join(app.getPath("userData"), "backup-settings.json"), value),
      migrate: migrateWorkspacePayload,
      verifySavedSource: async (receipt) => {
        const origin = mainWindow;
        const valid = await verifySavedBackupSource({ ...receipt, window: origin, migrate: migrateWorkspacePayload, hash: hashContent });
        return origin === mainWindow && valid;
      },
      requireSavedSources: true,
      readPending: () => fs.readFile(path.join(app.getPath("userData"), "backup-pending.json"), "utf8").then(JSON.parse).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
      writePending: (value) => value == null ? fs.rm(path.join(app.getPath("userData"), "backup-pending.json"), { force: true })
        : writeFileAtomically(path.join(app.getPath("userData"), "backup-pending.json"), `${JSON.stringify(value)}\n`),
    });
    await service.load();
    return service;
  })();
  return backupServicePromise;
};

const backupResult = (result) => ({
  ...result,
  error: result?.ok ? undefined : result?.error || backupMessages[result?.code] || "备份失败",
});

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1366,
    height: 960,
    minWidth: 1366,
    minHeight: 960,
    title: "Bike",
    webPreferences: {
      devTools: isDev,
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  let allowWindowClose = false;
  let closing = false;
  mainWindow = window;
  window.on("close", (event) => {
    if (allowWindowClose) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    let settled = false;
    const finish = (reply) => {
      if (reply?.sender && !isTrustedIpcSender(reply, window, isAllowedAppUrl)) return;
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ipcMain.removeListener("backup-flush-done", finish);
      allowWindowClose = true;
      window.close();
    };
    const timeout = setTimeout(() => {
      void backupService().then((service) => service.recordCloseTimeout()).catch((error) => console.error("Backup close receipt:", error.message)).finally(() => finish());
    }, 3000);
    ipcMain.on("backup-flush-done", finish);
    if (window.webContents.isDestroyed()) finish();
    else window.webContents.send("backup-flush-request");
  });
  window.webContents.on("before-input-event", (event, input) => {
    const command = editCommandForInput(input);
    if (!command) return;
    event.preventDefault();
    window.webContents.send("app-edit", command);
  });

  window.on("closed", () => {
    for (const request of aiRequests.values()) if (request.ownerId === window.webContents.id) request.controller.abort();
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
    window.loadURL(devServer.url);
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
    const result = await fetchLatestRelease({ currentVersion });
    return { ...result, releaseUrl: safeReleaseUrl(result.releaseUrl) };
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
        {
          label: "撤销",
          accelerator: "CmdOrCtrl+Z",
          click: () => mainWindow?.webContents.send("app-edit", "undo"),
        },
        {
          label: "重做",
          accelerator: "Shift+CmdOrCtrl+Z",
          click: () => mainWindow?.webContents.send("app-edit", "redo"),
        },
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
        ...(isDev ? [{ role: "reload", label: "重新载入" }, { role: "toggleDevTools", label: "开发者工具" }, { type: "separator" }] : []),
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

const allowedSyncMethodForPath = (pathname, method) => {
  if (pathname === "/api/sync/manifest") return method === "GET" || method === "PATCH";
  if (pathname === "/api/documents") return method === "GET";
  if (/^\/api\/documents\/[^/]+\/operations$/.test(pathname)) {
    return method === "GET" || method === "POST";
  }
  if (/^\/api\/documents\/[^/]+$/.test(pathname)) {
    return method === "GET" || method === "PUT" || method === "DELETE";
  }
  return false;
};

const createSyncRequestUrl = (payload) => {
  if (!isRecord(payload)) throw new Error("同步请求参数无效");
  const rawServerUrl = typeof payload.serverUrl === "string" ? payload.serverUrl.trim() : "";
  const rawPathname = typeof payload.pathname === "string" ? payload.pathname.trim() : "";
  const method = typeof payload.method === "string" ? payload.method.toUpperCase() : "GET";
  const baseUrl = new URL(rawServerUrl.replace(/\/+$/, ""));
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("同步服务地址需要以 http:// 或 https:// 开头");
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error("同步服务地址不应包含用户名、密码、查询参数或锚点");
  }
  const parsedPath = new URL(rawPathname, "http://bike.local");
  if (parsedPath.origin !== "http://bike.local" || parsedPath.search || parsedPath.hash) {
    throw new Error("同步 API 路径无效");
  }
  const pathname = parsedPath.pathname;
  if (!allowedSyncMethodForPath(pathname, method)) {
    throw new Error("同步 API 路径或方法不在允许范围内");
  }
  return {
    method,
    token: typeof payload.token === "string" ? payload.token.trim() : "",
    body: "body" in payload ? payload.body : undefined,
    url: `${baseUrl.toString().replace(/\/+$/, "")}${pathname}`,
  };
};

const isExternalUrl = (value) => {
  try {
    const url = new URL(value);
    if (isDev && url.origin === devServer.origin) return false;
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" || url.protocol === "tel:";
  } catch {
    return false;
  }
};

const isAllowedAppUrl = (value) => {
  try {
    const url = new URL(value);
    if (isDev) return url.origin === devServer.origin;
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
  if (!ownsInstance) return;
  removeLegacySyncSecret().catch((error) => {
    console.warn("Failed to remove legacy sync secret:", error);
  });
  installContentSecurityPolicy();
  installApplicationMenu();
  createWindow();
});

app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || quitting) app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("second-instance", () => {
  if (!mainWindow) createWindow();
  else { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
});

const registerIpc = (channel, handler) => ipcMain.handle(channel, async (event, payload) => {
  if (!isTrustedIpcSender(event, mainWindow, isAllowedAppUrl)) return { ok: false, status: 403, code: "untrusted-sender", error: "请求来源无效，请重新打开 Bike" };
  return handler(event, payload);
});
const savedNetworkConfig = async (kind) => {
  const { AI_CONFIG_KEY, LEGACY_AI_CONFIG_KEY } = await import("../shared/bike-settings.mjs");
  const script = kind === "sync" ? 'JSON.parse(localStorage.getItem("bike-sync-config") || "null")'
    : `JSON.parse(localStorage.getItem(${JSON.stringify(AI_CONFIG_KEY)}) || localStorage.getItem(${JSON.stringify(LEGACY_AI_CONFIG_KEY)}) || "null")`;
  let timer;
  try {
    return await Promise.race([mainWindow.webContents.executeJavaScript(script), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("服务配置读取超时")), 2000); })]);
  } finally { clearTimeout(timer); }
};

registerIpc("save-icloud-backup", async (event, payload) => {
  try {
    const request = isRecord(payload) && "workspace" in payload ? payload : { workspace: payload };
    const service = await backupService();
    return backupResult(await service.enqueue({
      workspace: request.workspace,
      ownerId: event.sender.id,
      ticket: Number.isInteger(request.ticket) ? request.ticket : undefined,
      sourceRevision: request.sourceRevision,
      semanticHash: request.semanticHash,
      manual: true,
      wait: true,
    }));
  } catch (error) {
    return { ok: false, code: "write-failed", error: error instanceof Error ? error.message : String(error) };
  }
});

registerIpc("backup-status", async () => {
  try {
    const service = await backupService();
    return { ok: true, ...service.status() };
  } catch (error) {
    return { ok: false, code: "unavailable", error: error instanceof Error ? error.message : String(error) };
  }
});

registerIpc("backup-set-auto", async (_event, payload) => {
  try {
    const service = await backupService();
    return { ok: true, ...(await service.setAuto(isRecord(payload) && payload.enabled === true)) };
  } catch (error) {
    return { ok: false, code: "write-failed", error: error instanceof Error ? error.message : String(error) };
  }
});
registerIpc("backup-pause-source", async () => {
  try { return { ok: true, ...(await (await backupService()).pauseSource()) }; }
  catch (error) { return { ok: false, code: "write-failed", error: String(error) }; }
});

registerIpc("backup-enqueue", async (event, payload) => {
  try {
    const request = isRecord(payload) ? payload : {};
    const service = await backupService();
    return backupResult(await service.enqueue({
      workspace: request.workspace,
      ownerId: event.sender.id,
      ticket: Number.isInteger(request.ticket) ? request.ticket : undefined,
      sourceRevision: request.sourceRevision,
      semanticHash: request.semanticHash,
      allocateNext: request.allocateNext === true,
      resumeSource: request.resumeSource === true,
      manual: request.manual === true,
      wait: request.wait !== false,
    }));
  } catch (error) {
    return { ok: false, code: "write-failed", error: error instanceof Error ? error.message : String(error) };
  }
});

registerIpc("backup-inspect", async () => {
  try {
    return await (await backupService()).inspect();
  } catch (error) {
    return { ok: false, code: "unavailable", error: error instanceof Error ? error.message : String(error) };
  }
});

registerIpc("backup-replace-local", async (event, payload) => {
  try {
    const request = isRecord(payload) ? payload : {};
    return backupResult(await (await backupService()).replaceWithLocal({
      workspace: request.workspace,
      ownerId: event.sender.id,
      expectedFileHash: typeof request.expectedFileHash === "string" ? request.expectedFileHash : null,
      sourceRevision: request.sourceRevision,
      semanticHash: request.semanticHash,
      ticket: Number.isInteger(request.ticket) ? request.ticket : undefined,
    }));
  } catch (error) {
    return { ok: false, code: "write-failed", error: error instanceof Error ? error.message : String(error) };
  }
});

registerIpc("backup-accept-baseline", async (event, payload) => {
  try {
    const hashValue = isRecord(payload) && typeof payload.hash === "string" ? payload.hash : "";
    if (!hashValue) return { ok: false, code: "write-failed", error: "缺少备份基线" };
    if (!payload.workspace || !Number.isSafeInteger(payload.sourceRevision)) return { ok: false, code: "stale-source", error: backupMessages["stale-source"] };
    return await (await backupService()).acceptBaseline(hashValue, { workspace: payload.workspace, sourceRevision: payload.sourceRevision, semanticHash: payload.semanticHash, ticket: payload.ticket, ownerId: event.sender.id });
  } catch (error) {
    return { ok: false, code: "write-failed", error: error instanceof Error ? error.message : String(error) };
  }
});

registerIpc("load-icloud-backup", async () => {
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

registerIpc("check-for-updates", async () => checkForUpdates());

registerIpc("invoke-sync-request", async (_event, payload) => {
  const deadline = Date.now() + 60_000;
  try {
    if (!isRecord(payload)) throw new Error("同步请求参数无效");
    configuredNetworkRequest("sync", payload, await savedNetworkConfig("sync"));
    const request = createSyncRequestUrl(payload);
    const headers = {
      Accept: "application/json",
      ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(request.token ? { Authorization: `Bearer ${request.token}` } : {}),
    };
    const response = await requestJson({ url: request.url, method: request.method, headers, body: request.body,
      timeoutMs: Math.max(1, deadline - Date.now()), maxBytes: 80 * 1024 * 1024, requireJson: true });
    const data = response.data;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data,
        error: providerErrorMessage(data) || `同步请求失败：HTTP ${response.status}`,
      };
    }
    return { ok: true, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

registerIpc("invoke-ai-provider", async (event, payload) => {
  const deadline = Date.now() + 90_000;
  let key;
  try {
    if (!isRecord(payload)) throw new Error("AI 请求参数无效");
    configuredNetworkRequest("ai", payload, await savedNetworkConfig("ai"));
    const endpoint = payload.endpoint === "chat_completions" ? "chat_completions" : "responses";
    const baseUrl = typeof payload.baseUrl === "string" ? payload.baseUrl : "";
    const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
    if (!apiKey) throw new Error("请输入 API key");
    const body = isRecord(payload.body) ? payload.body : {};
    const controller = new AbortController();
    if (typeof payload.requestId !== "string" || payload.requestId.length > 100) throw new Error("AI 请求编号无效");
    key = `${event.sender.id}:${payload.requestId}`;
    for (const [id, expiry] of cancelledAiRequests) if (expiry < Date.now()) cancelledAiRequests.delete(id);
    if (cancelledAiRequests.has(key)) throw new Error("AI 请求已取消");
    if (aiRequests.has(key)) throw new Error("AI 请求已在进行中");
    aiRequests.set(key, { controller, ownerId: event.sender.id });
    const response = await requestJson({ url: createAiEndpointUrl(baseUrl, endpoint), method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body, signal: controller.signal, timeoutMs: Math.max(1, deadline - Date.now()), maxBytes: 2 * 1024 * 1024 });
    const data = response.data;
    if (response.ok && /^text\/html\b/i.test(response.contentType)) {
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
  } finally { if (key) { aiRequests.delete(key); cancelledAiRequests.delete(key); } }
});

registerIpc("cancel-ai-provider", async (event, payload) => {
  if (typeof payload?.requestId !== "string" || payload.requestId.length > 100) return { ok: false };
  const key = `${event.sender.id}:${payload.requestId}`;
  cancelledAiRequests.set(key, Date.now() + 90_000);
  while (cancelledAiRequests.size > 100) cancelledAiRequests.delete(cancelledAiRequests.keys().next().value);
  aiRequests.get(key)?.controller.abort(new Error("AI 请求已取消"));
  return { ok: true };
});
