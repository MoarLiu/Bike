import { migrateWorkspace } from '../migrations';
import { Desktop, events } from '../../desktop-mygo/bindings/mygo';
import { validateAttachmentMetadata } from '../../shared/bike-attachments.mjs';

type Result = { ok: boolean; error?: string };
type ImportedAsset = { assetId: string; name: string; metadata: import('../../shared/bike-attachments.mjs').AttachmentMetadata };

export function installMyGoBridge() {
  const runtime = window.mygo;
  if (!runtime || location.protocol !== 'mygo:' || location.hostname !== 'localhost' || window.bike) return;
  const listeners = new Map<string, Set<(payload: unknown, id?: string) => void>>();
  const imports = new Map<string, AbortController>();
  let flushRequest: string | undefined;
  const invoke = <T>(method: string, payload: unknown = {}): Promise<T> => Desktop.invoke(method, JSON.stringify(payload)) as Promise<T>;
  const reply = (id: string | undefined, value: unknown, error = '') => {
    if (id) void Desktop.reply(id, JSON.stringify(value ?? null), error).catch(() => {});
  };
  const subscribe = <T>(name: string, callback: (payload: T, id?: string) => void) => {
    const handler = (payload: unknown, id?: string) => callback(payload as T, id);
    const group = listeners.get(name) ?? new Set();
    group.add(handler);
    listeners.set(name, group);
    return () => { group.delete(handler); if (!group.size) listeners.delete(name); };
  };
  Object.defineProperty(window, "__bikeMyGoCloseSubscribed", {
    get: () => (listeners.get("prepareUpdate")?.size ?? 0) > 0,
  });
  events.bikeDesktop.on((event) => {
    if (event.name === 'backupFlush') flushRequest = event.id;
    for (const callback of [...(listeners.get(event.name) ?? [])]) callback(event.payload, event.id);
  });
  const checked = async (method: string, payload: unknown) => {
    const result = await invoke<Result>(method, payload);
    if (!result.ok) throw new Error(result.error || '桌面请求失败');
    return result;
  };
  const importAttachments: NonNullable<BikeDesktopBridge['importAttachments']> = async (payload) => {
    if (payload.choose) return invoke('importAttachments', { requestId: payload.requestId, choose: true });
    if (!Array.isArray(payload.files) || !payload.files.length || payload.files.length > 100) return { ok: false, error: '附件批次无效或超过 100 项' };
    const total = payload.files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    if (total > 512 * 1024 * 1024 || payload.files.some((file) => file.bytes.byteLength > 128 * 1024 * 1024)) return { ok: false, error: '附件超过处理预算' };
    if (imports.has(payload.requestId)) return { ok: false, error: '附件导入任务标识重复' };
    const controller = new AbortController();
    imports.set(payload.requestId, controller);
    const assets: ImportedAsset[] = [];
    const failures: Array<{ name: string; error: string }> = [];
    try {
      for (const file of payload.files) {
        if (controller.signal.aborted) break;
        const uploadId = crypto.randomUUID();
        try {
          await checked('beginAttachmentUpload', { uploadId, name: file.name, byteLength: file.bytes.byteLength });
          const bytes = new Uint8Array(file.bytes);
          for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
            controller.signal.throwIfAborted();
            const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + 1024 * 1024));
            let binary = '';
            for (let index = 0; index < chunk.length; index += 8192) binary += String.fromCharCode(...chunk.subarray(index, index + 8192));
            await checked('writeAttachmentChunk', { uploadId, offset, data: btoa(binary) });
          }
          controller.signal.throwIfAborted();
          const result = await invoke<Result & { asset?: ImportedAsset }>('finishAttachmentUpload', { uploadId });
          if (!result.ok || !result.asset) throw new Error(result.error || '附件安装失败');
          validateAttachmentMetadata(result.asset.metadata);
          assets.push(result.asset);
        } catch (error) {
          failures.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
        } finally { await invoke('cancelAttachmentUpload', { uploadId }); }
      }
      return { ok: true, cancelled: controller.signal.aborted, assets, failures };
    } finally { imports.delete(payload.requestId); }
  };
  const bridge: BikeDesktopBridge = {
    syncAttachments: (assets) => invoke('syncAttachments', { assets }),
    cancelAttachmentSync: () => invoke('cancelAttachmentSync'),
    onAttachmentSyncProgress: (callback) => subscribe('attachmentSyncProgress', callback),
    getLiveMcpState: () => invoke('getLiveMcpState'),
    startLiveMcp: (grant) => invoke('startLiveMcp', grant).then((value) => {
      const result = value as LiveMcpState & Result;
      if (result.ok === false) throw new Error(result.error || 'Live MCP 启动失败');
      return result;
    }),
    stopLiveMcp: () => invoke('stopLiveMcp'),
    onLiveMcpRequest: (callback) => subscribe<LiveMcpRequest & { payloadJSON?: string }>('liveMcpRequest', (request, id) => {
      Promise.resolve().then(() => {
        const { payloadJSON, ...decoded } = request;
        if (payloadJSON !== undefined) decoded.payload = JSON.parse(payloadJSON);
        return callback(decoded);
      }).then((result) => reply(id, result), (error) => reply(id, null, error instanceof Error ? error.message : String(error)));
    }),
    onLiveMcpRevoke: (callback) => subscribe('liveMcpRevoke', callback),
    scanAttachments: (protectedAssets) => invoke('scanAttachments', { protectedAssets }),
    cleanAttachments: (protectedAssets, ticket) => invoke('cleanAttachments', { protectedAssets, ticket }),
    importAttachments,
    cancelAttachmentImport: (requestId) => { imports.get(requestId)?.abort(); return invoke('cancelAttachmentImport', { requestId }); },
    readAttachment: (assetId, thumbnail = true) => invoke('readAttachment', { assetId, thumbnail }),
    saveAttachment: (assetId, name) => invoke('saveAttachment', { assetId, name }),
    openAttachment: (assetId, name) => invoke('openAttachment', { assetId, name }),
    exportWorkspaceArchive: (workspace, readable) => invoke('exportWorkspaceArchive', { workspace: migrateWorkspace(workspace), readable }),
    importWorkspaceArchive: async () => {
      const { workspaceJSON, ...result } = await invoke<Result & { cancelled?: boolean; workspace?: unknown; workspaceJSON?: string; attachmentCount?: number }>('importWorkspaceArchive');
      return result.ok && !result.cancelled ? { ...result, workspace: migrateWorkspace(workspaceJSON === undefined ? result.workspace : JSON.parse(workspaceJSON)) } : result;
    },
    saveICloudBackup: (payload) => invoke('saveICloudBackup', payload),
    loadICloudBackup: async () => {
      const { payloadJSON, ...result } = await invoke<Result & { payload?: unknown; payloadJSON?: string; path?: string; revision?: string }>('loadICloudBackup');
      return result.ok ? { ...result, payload: migrateWorkspace(payloadJSON === undefined ? result.payload : JSON.parse(payloadJSON)) } : result;
    },
    getBackupStatus: () => invoke('getBackupStatus'),
    setBackupAuto: (enabled) => invoke('setBackupAuto', { enabled }),
    pauseBackup: () => invoke('pauseBackup'),
    enqueueBackup: (payload) => invoke('enqueueBackup', payload),
    inspectBackup: () => invoke('inspectBackup'),
    replaceBackupWithLocal: (payload) => invoke('replaceBackupWithLocal', payload),
    acceptBackupBaseline: (hash, saved) => invoke('acceptBackupBaseline', { hash, ...saved }),
    onBackupFlush: (callback) => subscribe('backupFlush', callback),
    finishBackupFlush: () => { reply(flushRequest, { ok: true }); flushRequest = undefined; },
    checkForUpdates: () => invoke('checkForUpdates'),
    onUpdateState: (callback) => subscribe('updateState', callback),
    onPrepareUpdate: (callback) => subscribe('prepareUpdate', (_payload, id) => {
      Promise.resolve().then(callback).then((result) => reply(id, result), (error) => reply(id, null, error instanceof Error ? error.message : String(error)));
    }),
    invokeAiProvider: (payload) => invoke('invokeAiProvider', payload),
    cancelAiRequest: (requestId) => invoke('cancelAiRequest', { requestId }),
    invokeSyncRequest: (payload) => invoke('invokeSyncRequest', payload),
    onEditCommand: (callback) => subscribe('editCommand', callback),
    onOpenApiConfig: (callback) => subscribe('openApiConfig', callback),
  };
  window.bike = bridge;
  window.localOutline = bridge;
  document.addEventListener('keydown', (event) => {
    if (event.isComposing || !(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const command = key === 'y' || event.shiftKey ? 'redo' : 'undo';
    for (const callback of [...(listeners.get('editCommand') ?? [])]) callback(command);
  }, true);
}
