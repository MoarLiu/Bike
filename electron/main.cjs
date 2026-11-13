const { app, BrowserWindow, dialog, ipcMain, Menu, shell, session, nativeImage } = require("electron");
const { installAttachmentIpc } = require("./attachment-ipc.cjs");
const { createAttachmentService } = require("./attachment-service.cjs");
const { verifySavedBackupSource } = require("./backup-source.cjs");
const { isTrustedIpcSender, configuredNetworkRequest } = require("./ipc-guard.cjs");
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
} = require("./update-checker.cjs");
const { createUpdateController, requestInstallPreparation } = require("./app-updater.cjs");
const { resolveDevServer } = require("./dev-server.cjs");
const { editCommandForInput } = require("./edit-shortcuts.cjs");
const { createBackupService, MESSAGES: backupMessages } = require("./backup-service.cjs");

const devServer = resolveDevServer({ env: process.env, isPackaged: app.isPackaged });
if (devServer.warning) console.warn(devServer.warning);
const isDev = devServer.isDev;
if (!process.env.BIKE_TEST_USER_DATA && app.getVersion().includes("-")) app.setPath("userData", path.join(app.getPath("appData"), "Bike-2-preview"));
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
let liveService;
const liveRendererRequests = new Map();
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
      prepareAssets: async (workspace, directory, revision) => {
        if (workspace.version < 2) return;
        const assets = await attachmentIpc.library().copyWorkspaceAssets(workspace, path.join(directory, "attachments"));
        const manifestDirectory = path.join(directory, "attachment-manifests");
        await fs.mkdir(manifestDirectory, { recursive: true, mode: 0o700 });
        await writeFileAtomically(path.join(manifestDirectory, "current.json"), JSON.stringify({ version: 1, revision, assets }));
      },
      verifySavedSource: async (receipt) => {
        const origin = mainWindow;
        const valid = await verifySavedBackupSource({ ...receipt, window: origin, migrate: migrateWorkspacePayload, hash: hashContent });
        return origin === mainWindow && valid;
      },
      requireSavedSources: true,
      maintainAssets: require("./backup-maintenance.cjs").maintainBackupAssets,
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

let updateController;
let updateFlow;
const updates = () => {
  if (updateController) return updateController;
  const { autoUpdater } = require("electron-updater");
  autoUpdater.logger = null;
  updateController = createUpdateController({
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    supported: app.isPackaged && process.platform === "darwin",
    resolveRelease: require("./update-checker.cjs").fetchLatestRelease,
    manualOnly: app.isPackaged && process.platform === "darwin" && !require("node:child_process").spawnSync(
      "/usr/bin/codesign", ["-d", "--verbose=4", path.resolve(process.execPath, "../../..")], { encoding: "utf8", timeout: 5000 },
    ).stderr?.includes("Authority=Developer ID Application:"),
    onState: (state) => {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("update-state", state);
    },
    prepareInstall: () => requestInstallPreparation({
      ipcMain, window: mainWindow,
      isTrusted: (event, window) => isTrustedIpcSender(event, window, isAllowedAppUrl),
    }),
  });
  return updateController;
};
const showMessageBox = (window, options) =>
  window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
const runUpdateDialog = async () => {
  const service = updates();
  let state = await service.check();
  const reportError = async () => {
    const choice = await showMessageBox(focusedAppWindow(), { type: "warning", buttons: ["打开发布页手动下载", "关闭"], defaultId: 1, cancelId: 1, title: "应用更新", message: state.error || "更新未完成，请稍后重试" });
    if (choice.response === 0) await shell.openExternal(DEFAULT_RELEASES_PAGE_URL);
  };
  if (["error", "unsupported"].includes(state.status)) {
    await reportError();
  } else if (state.status === "manual") {
    const choice = await showMessageBox(focusedAppWindow(), { type: "info", buttons: ["打开发布页下载", "稍后"], defaultId: 0, cancelId: 1,
      title: "应用更新", message: `发现新版本 ${state.latestVersion}`, detail: "当前应用使用本地签名，请下载并替换安装；你的工作区会保留。" });
    if (choice.response === 0) await shell.openExternal(DEFAULT_RELEASES_PAGE_URL);
  } else if (state.status === "not-available") {
    await showMessageBox(focusedAppWindow(), { type: "info", buttons: ["好"], title: "检查更新", message: "已是最新版本", detail: `当前版本 ${state.currentVersion}` });
  } else if (state.status === "available") {
    const choice = await showMessageBox(focusedAppWindow(), {
      type: "info", buttons: ["下载更新", "稍后"], defaultId: 0, cancelId: 1,
      title: "应用更新", message: `发现新版本 ${state.latestVersion}`,
      detail: `当前版本 ${state.currentVersion}\n更新将在应用内下载，完成后可选择重启安装。`,
    });
    if (choice.response === 0) {
      state = await service.download();
      if (state.error) await reportError();
    }
  }
  if (state.status === "downloaded") {
    const choice = await showMessageBox(focusedAppWindow(), {
      type: "info", buttons: ["重启并安装", "稍后"], defaultId: 0, cancelId: 1,
      title: "应用更新", message: `更新 ${state.latestVersion} 已下载`, detail: "重启前会保存当前工作区。",
    });
    if (choice.response === 0) {
      state = await service.install();
      if (state.error) await reportError();
    }
  }
  return { ...state, ok: !state.error };
};
const showUpdateDialog = () => {
  updateFlow ??= runUpdateDialog().catch(() => ({ ok: false, status: "error", currentVersion: app.getVersion(), error: "更新未完成，请稍后重试" }))
    .finally(() => { updateFlow = undefined; });
  return updateFlow;
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
  if (/^\/api\/v2\/(?:status|checkpoint|events)$/.test(pathname)) return method === "GET";
  if (/^\/api\/v2\/(?:enable|operations|operation-chunks)$/.test(pathname)) return method === "POST";
  if (/^\/api\/v2\/operation-chunks\/[^/]+\/\d+$/.test(pathname)) return method === "GET";
  if (/^\/api\/v2\/receipts\/[^/]+$/.test(pathname)) return method === "GET";
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
  if (parsedPath.origin !== "http://bike.local" || parsedPath.hash) {
    throw new Error("同步 API 路径无效");
  }
  for (const [key, value] of parsedPath.searchParams) {
    if (key === "bikeOrdering" && value === "2" && parsedPath.pathname.startsWith("/api/v2/")) continue;
    if (!/^\/api\/v2\/(?:events|checkpoint)$/.test(parsedPath.pathname) ||
        !["after", "limit", "expectedCursor"].includes(key) || !/^\d{1,16}$/.test(value)) throw new Error("同步分页参数无效");
  }
  const pathname = parsedPath.pathname;
  if (!allowedSyncMethodForPath(pathname, method)) {
    throw new Error("同步 API 路径或方法不在允许范围内");
  }
  return {
    method,
    token: typeof payload.token === "string" ? payload.token.trim() : "",
    body: "body" in payload ? payload.body : undefined,
    url: `${baseUrl.toString().replace(/\/+$/, "")}${pathname}${parsedPath.search}`,
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
  const permissionAllowed = (contents, permission, details) =>
    Boolean(contents) && contents === mainWindow?.webContents && details?.isMainFrame === true &&
    isAllowedAppUrl(details.requestingUrl ?? contents.getURL()) &&
    ["clipboard-sanitized-write", "fullscreen"].includes(permission);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(permissionAllowed(contents, permission, details)));
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    permissionAllowed(contents, permission, details));
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

app.whenReady().then(async () => {
  if (!ownsInstance) return;
  await fs.rm(path.join(app.getPath("userData"), "live-mcp.json"), { force: true });
  removeLegacySyncSecret().catch((error) => {
    console.warn("Failed to remove legacy sync secret:", error);
  });
  installContentSecurityPolicy();
  installApplicationMenu();
  createWindow();
});

app.on("before-quit", () => {
  void liveService?.stop();
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
const getLiveService = () => {
  if (liveService) return liveService;
  const { createLiveMcpService } = require("./live-mcp-service.cjs");
  liveService = createLiveMcpService({ directory: app.getPath("userData"),
    handle: (request) => new Promise((resolve, reject) => {
      const owner = mainWindow;
      if (!owner || owner.webContents.isDestroyed() || owner.webContents.isLoadingMainFrame()) { reject(new Error("Bike 窗口未就绪")); return; }
      if (liveRendererRequests.size >= 16) { reject(new Error("Live 请求繁忙，请稍后重试")); return; }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { liveRendererRequests.delete(id); reject(new Error("读取屏障超时，请检查应用保存状态")); }, 20_000);
      liveRendererRequests.set(id, { owner, resolve, reject, timer });
      owner.webContents.send("live-mcp-request", { id, ...request });
    }),
    onRevoke: () => {
      for (const request of liveRendererRequests.values()) { clearTimeout(request.timer); request.reject(new Error("Live 授权已失效")); }
      liveRendererRequests.clear();
      if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("live-mcp-revoked");
    },
  });
  return liveService;
};
ipcMain.on("live-mcp-response", (event, payload) => {
  const request = liveRendererRequests.get(payload?.id);
  if (!request || request.owner !== mainWindow || !isTrustedIpcSender(event, request.owner, isAllowedAppUrl)) return;
  clearTimeout(request.timer); liveRendererRequests.delete(payload.id);
  if (payload.ok) request.resolve(payload.result); else request.reject(new Error(String(payload.error ?? "Live 请求失败").slice(0, 500)));
});
registerIpc("live-mcp-state", async () => ({ ...getLiveService().state(), command: process.execPath, args: app.isPackaged ? ["--mcp-live"] : [app.getAppPath(), "--mcp-live"] }));
registerIpc("live-mcp-start", async (_event, payload) => getLiveService().start(payload ?? {}));
registerIpc("live-mcp-stop", async () => getLiveService().stop());
app.on("web-contents-created", (_event, contents) => {
  contents.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace && mainWindow?.webContents === contents) void liveService?.stop();
  });
  contents.on("destroyed", () => { if (mainWindow?.webContents === contents) void liveService?.stop(); });
});

const attachmentIpc = installAttachmentIpc({ registerIpc, app, dialog, nativeImage, shell, getWindow: () => mainWindow, migrate: migrateWorkspacePayload });
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
    const payload = await migrateWorkspacePayload(JSON.parse(raw));
    if (payload.version >= 2) {
      const cloudAssets = createAttachmentService({ directory: path.join(path.dirname(latestPath), "attachments") });
      await cloudAssets.copyWorkspaceAssets(payload, path.join(app.getPath("userData"), "attachments"));
    }
    return { ok: true, payload, path: latestPath, revision: hashContent(raw) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

let attachmentSync;
registerIpc("attachment-sync", async (_event, payload) => {
  try {
    const config = await savedNetworkConfig("sync");
    if (!config?.token) throw new Error("请先保存同步服务地址和设备密钥");
    attachmentSync ??= require("./attachment-sync.cjs").createAttachmentSync({ library: attachmentIpc.library(),
      directory: path.join(app.getPath("userData"), "attachment-transfers"), onProgress: (progress) => {
        if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("attachment-sync-progress", progress);
      } });
    const { MAX_IMPORT_BYTES } = await import("../shared/bike-attachments.mjs");
    if (!Array.isArray(payload?.assets)) throw new Error("附件清单无效");
    const batches = []; let batch = [], bytes = 0;
    for (const item of payload.assets) {
      if (batch.length && (batch.length >= 1000 || bytes + item.metadata.byteLength > MAX_IMPORT_BYTES)) { batches.push(batch); batch = []; bytes = 0; }
      batch.push(item); bytes += item.metadata.byteLength;
    }
    if (batch.length) batches.push(batch);
    const result = { complete: true, completed: 0, total: payload.assets.length, errors: [] };
    for (const assets of batches) {
      const current = await attachmentSync.run({ assets, config });
      result.completed += current.completed; result.errors.push(...current.errors);
      if (!current.complete) { result.complete = false; break; }
    }
    return { ok: true, ...result };
  } catch (error) { return { ok: false, error: error.message }; }
});
registerIpc("attachment-sync-cancel", async () => { attachmentSync?.cancel(); return { ok: true }; });

registerIpc("check-for-updates", async () => showUpdateDialog());

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
    const { OPERATION_LIMITS } = await import("../shared/bike-operations.mjs");
    const response = await requestJson({ url: request.url, method: request.method, headers, body: request.body,
      timeoutMs: Math.max(1, deadline - Date.now()), maxBytes: request.url.includes("/api/v2/checkpoint") ? OPERATION_LIMITS.checkpointBytes : 80 * 1024 * 1024, requireJson: true });
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
