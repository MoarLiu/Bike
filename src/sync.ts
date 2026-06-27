import { migrateDocument } from "./migrations";
import type { OutlineDocument, Workspace } from "./types";

export type SyncConfig = {
  serverUrl: string;
  token: string;
  autoSync: boolean;
  autoSyncIntervalSeconds: number;
};

export type SyncState = {
  serverUrl: string;
  workspaceRevision: number | null;
  documentRevisions: Record<string, number>;
  documentFingerprints: Record<string, string>;
  deletedDocumentRevisions: Record<string, number>;
  lastSyncedAt: string | null;
};

export type SyncDocumentSummary = {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
  deletedAt: string | null;
};

export type SyncManifest = {
  workspaceRevision: number;
  activeDocumentId: string | null;
  documentOrder: string[];
  documents: SyncDocumentSummary[];
};

export type SyncSummary = {
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: string[];
};

export type SyncCheckpointOptions = {
  onCheckpoint?: (state: SyncState) => void;
};

const CONFIG_KEY = "bike-sync-config";
const STATE_KEY = "bike-sync-state";
const LEGACY_TOKEN_KEY = "bike-sync-token";
const DEFAULT_AUTO_SYNC_INTERVAL_SECONDS = 60;
const MIN_AUTO_SYNC_INTERVAL_SECONDS = 15;

const defaultSyncServerUrl = () =>
  document
    .querySelector<HTMLMetaElement>('meta[name="bike-default-sync-server-url"]')
    ?.content.trim() || window.location.origin;

export class SyncApiError extends Error {
  status: number;
  payload: unknown;

  constructor(status: number, payload: unknown) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message?: unknown }).message)
        : `同步请求失败：${status}`;
    super(message);
    this.name = "SyncApiError";
    this.status = status;
    this.payload = payload;
  }
}

export const defaultSyncConfig = (): SyncConfig => ({
  serverUrl: defaultSyncServerUrl(),
  token: "",
  autoSync: false,
  autoSyncIntervalSeconds: DEFAULT_AUTO_SYNC_INTERVAL_SECONDS,
});

export const normalizeSyncServerUrl = (value: string) => {
  const trimmed = value.trim() || defaultSyncServerUrl();
  return trimmed.replace(/\/+$/, "");
};

export const normalizeAutoSyncInterval = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_AUTO_SYNC_INTERVAL_SECONDS;
  return Math.max(MIN_AUTO_SYNC_INTERVAL_SECONDS, Math.round(numeric));
};

export const loadSyncConfig = (): SyncConfig => {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const legacyToken =
      sessionStorage.getItem(LEGACY_TOKEN_KEY) ||
      localStorage.getItem(LEGACY_TOKEN_KEY) ||
      "";
    if (!raw) return { ...defaultSyncConfig(), token: legacyToken.trim() };
    const parsed = JSON.parse(raw) as Partial<SyncConfig>;
    const token = typeof parsed.token === "string" ? parsed.token : legacyToken;
    return {
      serverUrl: normalizeSyncServerUrl(parsed.serverUrl || defaultSyncServerUrl()),
      token: token.trim(),
      autoSync: parsed.autoSync === true,
      autoSyncIntervalSeconds: normalizeAutoSyncInterval(parsed.autoSyncIntervalSeconds),
    };
  } catch {
    return defaultSyncConfig();
  }
};

export const saveSyncConfig = (config: SyncConfig) => {
  localStorage.setItem(CONFIG_KEY, JSON.stringify({
    serverUrl: normalizeSyncServerUrl(config.serverUrl),
    token: config.token.trim(),
    autoSync: config.autoSync === true,
    autoSyncIntervalSeconds: normalizeAutoSyncInterval(config.autoSyncIntervalSeconds),
  }));
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  sessionStorage.removeItem(LEGACY_TOKEN_KEY);
};

export const emptySyncState = (serverUrl: string): SyncState => ({
  serverUrl: normalizeSyncServerUrl(serverUrl),
  workspaceRevision: null,
  documentRevisions: {},
  documentFingerprints: {},
  deletedDocumentRevisions: {},
  lastSyncedAt: null,
});

export const loadSyncState = (serverUrl: string): SyncState => {
  const normalizedServerUrl = normalizeSyncServerUrl(serverUrl);
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return emptySyncState(normalizedServerUrl);
    const parsed = JSON.parse(raw) as Partial<SyncState>;
    if (parsed.serverUrl !== normalizedServerUrl) {
      return emptySyncState(normalizedServerUrl);
    }
    return {
      serverUrl: normalizedServerUrl,
      workspaceRevision:
        typeof parsed.workspaceRevision === "number" ? parsed.workspaceRevision : null,
      documentRevisions:
        parsed.documentRevisions && typeof parsed.documentRevisions === "object"
          ? parsed.documentRevisions as Record<string, number>
          : {},
      documentFingerprints:
        parsed.documentFingerprints && typeof parsed.documentFingerprints === "object"
          ? parsed.documentFingerprints as Record<string, string>
          : {},
      deletedDocumentRevisions:
        parsed.deletedDocumentRevisions && typeof parsed.deletedDocumentRevisions === "object"
          ? parsed.deletedDocumentRevisions as Record<string, number>
          : {},
      lastSyncedAt:
        typeof parsed.lastSyncedAt === "string" ? parsed.lastSyncedAt : null,
    };
  } catch {
    return emptySyncState(normalizedServerUrl);
  }
};

export const saveSyncState = (state: SyncState) => {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
};

const apiUrl = (config: SyncConfig, pathname: string) =>
  `${normalizeSyncServerUrl(config.serverUrl)}${pathname}`;

const isLoopbackHost = (host: string) =>
  host === "localhost" || host === "127.0.0.1" || host === "::1";

const syncFetchFailurePayload = (config: SyncConfig, error: unknown) => {
  const serverUrl = normalizeSyncServerUrl(config.serverUrl);
  const fallbackMessage =
    error instanceof Error && error.message
      ? error.message
      : "Failed to fetch";

  try {
    const url = new URL(serverUrl);
    const currentHost = window.location.hostname;
    const configuredHostIsLoopback = isLoopbackHost(url.hostname);
    const pageHostIsLoopback = isLoopbackHost(currentHost);
    const defaultServerUrl = defaultSyncServerUrl();

    if (configuredHostIsLoopback && !pageHostIsLoopback) {
      return {
        message:
          `同步服务地址 ${serverUrl} 指向当前浏览器所在设备，不是服务器。` +
          `请改成 ${defaultServerUrl} 或其他可从浏览器访问的同步服务地址。`,
      };
    }

    if (window.location.protocol === "https:" && url.protocol === "http:") {
      return {
        message:
          `当前页面是 HTTPS，浏览器会拦截 HTTP 同步服务 ${serverUrl}。` +
          "请把同步服务也放到 HTTPS，或使用同源反向代理。",
      };
    }
  } catch {
    return {
      message: `同步服务地址无效：${serverUrl}`,
    };
  }

  return {
    message:
      `无法连接同步服务 ${serverUrl}。请检查地址、端口、防火墙和 CORS。` +
      `浏览器原始错误：${fallbackMessage}`,
  };
};

const bridgePayload = (result: {
  status?: number;
  data?: unknown;
  error?: string;
}) => {
  if (result.data !== undefined && result.data !== null) return result.data;
  return { message: result.error || "同步请求失败" };
};

const apiRequest = async <T>(
  config: SyncConfig,
  pathname: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> => {
  const electronSyncBridge = window.bike?.invokeSyncRequest;
  if (electronSyncBridge) {
    const result = await electronSyncBridge({
      serverUrl: normalizeSyncServerUrl(config.serverUrl),
      pathname,
      method: options.method || "GET",
      token: config.token.trim(),
      body: options.body,
    });
    if (!result.ok) {
      throw new SyncApiError(result.status || 0, bridgePayload(result));
    }
    return result.data as T;
  }

  const headers: Record<string, string> = {};
  if (config.token.trim()) headers.Authorization = `Bearer ${config.token.trim()}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(apiUrl(config, pathname), {
      method: options.method || "GET",
      headers,
      credentials: config.token.trim() ? "same-origin" : "include",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    throw new SyncApiError(0, syncFetchFailurePayload(config, error));
  }
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text.slice(0, 500) };
      if (response.ok) {
        throw new SyncApiError(response.status, {
          message: "同步服务返回了无效 JSON",
        });
      }
    }
  }
  if (!response.ok) throw new SyncApiError(response.status, payload);
  return payload as T;
};

export const fetchSyncManifest = (config: SyncConfig) =>
  apiRequest<SyncManifest>(config, "/api/sync/manifest");

export const fetchRemoteDocument = async (config: SyncConfig, id: string) => {
  const response = await apiRequest<{ revision: number; document: unknown }>(
    config,
    `/api/documents/${encodeURIComponent(id)}`,
  );
  return {
    revision: response.revision,
    document: migrateDocument(response.document),
  };
};

export const putRemoteDocument = async (
  config: SyncConfig,
  document: OutlineDocument,
  expectedRevision: number | null,
) => {
  const response = await apiRequest<{ revision: number; document: unknown }>(
    config,
    `/api/documents/${encodeURIComponent(document.id)}`,
    {
      method: "PUT",
      body: { expectedRevision, document },
    },
  );
  return {
    revision: response.revision,
    document: migrateDocument(response.document),
  };
};

export const deleteRemoteDocument = (
  config: SyncConfig,
  id: string,
  expectedRevision: number,
) =>
  apiRequest<{ id: string; revision: number; deletedAt: string }>(
    config,
    `/api/documents/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      body: { expectedRevision },
    },
  );

export const patchRemoteManifest = (
  config: SyncConfig,
  input: {
    expectedRevision: number;
    activeDocumentId: string | null;
    documentOrder: string[];
  },
) =>
  apiRequest<SyncManifest>(config, "/api/sync/manifest", {
    method: "PATCH",
    body: input,
  });

export const documentFingerprint = (document: OutlineDocument) => {
  const value = JSON.stringify(document);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
};

const syncTimestamp = () => new Date().toISOString();

const cloneSyncState = (state: SyncState): SyncState => ({
  serverUrl: state.serverUrl,
  workspaceRevision: state.workspaceRevision,
  documentRevisions: { ...state.documentRevisions },
  documentFingerprints: { ...state.documentFingerprints },
  deletedDocumentRevisions: { ...state.deletedDocumentRevisions },
  lastSyncedAt: state.lastSyncedAt,
});

const checkpointSyncState = (
  state: SyncState,
  options?: SyncCheckpointOptions,
) => {
  state.lastSyncedAt = syncTimestamp();
  options?.onCheckpoint?.(cloneSyncState(state));
};

const recordDocumentState = (
  state: SyncState,
  document: OutlineDocument,
  revision: number,
) => {
  state.documentRevisions[document.id] = revision;
  state.documentFingerprints[document.id] = documentFingerprint(document);
  delete state.deletedDocumentRevisions[document.id];
};

const recordDeletedState = (state: SyncState, id: string, revision: number) => {
  state.deletedDocumentRevisions[id] = revision;
  state.documentRevisions[id] = revision;
  delete state.documentFingerprints[id];
};

const orderedDocuments = (
  documents: OutlineDocument[],
  documentOrder: string[],
) => {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const ordered = documentOrder.flatMap((id) => {
    const document = byId.get(id);
    if (!document) return [];
    byId.delete(id);
    return [document];
  });
  return [...ordered, ...byId.values()];
};

const workspaceFromRemote = async (
  config: SyncConfig,
  manifest: SyncManifest,
  state: SyncState,
): Promise<Workspace | null> => {
  const documents: OutlineDocument[] = [];
  for (const summary of manifest.documents) {
    if (summary.deletedAt) {
      recordDeletedState(state, summary.id, summary.revision);
      continue;
    }
    const remote = await fetchRemoteDocument(config, summary.id);
    documents.push(remote.document);
    recordDocumentState(state, remote.document, remote.revision);
  }
  if (!documents.length) return null;
  const ordered = orderedDocuments(documents, manifest.documentOrder);
  return {
    version: 1,
    activeDocumentId:
      manifest.activeDocumentId && ordered.some((document) => document.id === manifest.activeDocumentId)
        ? manifest.activeDocumentId
        : ordered[0].id,
    documents: ordered,
  };
};

export const pullWorkspaceFromRemote = async (
  config: SyncConfig,
): Promise<{ workspace: Workspace | null; state: SyncState; manifest: SyncManifest }> => {
  const normalizedConfig = {
    ...config,
    serverUrl: normalizeSyncServerUrl(config.serverUrl),
  };
  const state = emptySyncState(normalizedConfig.serverUrl);
  const manifest = await fetchSyncManifest(normalizedConfig);
  const workspace = await workspaceFromRemote(normalizedConfig, manifest, state);
  state.workspaceRevision = manifest.workspaceRevision;
  state.lastSyncedAt = syncTimestamp();
  return { workspace, state, manifest };
};

export const pushWorkspaceToRemote = async (
  workspace: Workspace,
  config: SyncConfig,
  options?: SyncCheckpointOptions,
): Promise<{ state: SyncState; summary: SyncSummary }> => {
  const normalizedConfig = {
    ...config,
    serverUrl: normalizeSyncServerUrl(config.serverUrl),
  };
  const state = emptySyncState(normalizedConfig.serverUrl);
  const summary: SyncSummary = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: [] };
  let manifest = await fetchSyncManifest(normalizedConfig);
  const remoteById = new Map(manifest.documents.map((document) => [document.id, document]));

  for (const document of workspace.documents) {
    const remote = remoteById.get(document.id);
    const expectedRevision = remote && !remote.deletedAt ? remote.revision : remote?.revision ?? null;
    const result = await putRemoteDocument(normalizedConfig, document, expectedRevision);
    recordDocumentState(state, result.document, result.revision);
    checkpointSyncState(state, options);
    summary.uploaded += 1;
  }

  manifest = await fetchSyncManifest(normalizedConfig);
  const patchedManifest = await patchRemoteManifest(normalizedConfig, {
    expectedRevision: manifest.workspaceRevision,
    activeDocumentId: workspace.activeDocumentId,
    documentOrder: workspace.documents.map((document) => document.id),
  });
  state.workspaceRevision = patchedManifest.workspaceRevision;
  state.lastSyncedAt = syncTimestamp();
  return { state, summary };
};

export const syncWorkspaceWithRemote = async (
  workspace: Workspace,
  config: SyncConfig,
  previousState: SyncState,
  options?: SyncCheckpointOptions,
): Promise<{ workspace: Workspace; state: SyncState; summary: SyncSummary }> => {
  const normalizedConfig = {
    ...config,
    serverUrl: normalizeSyncServerUrl(config.serverUrl),
  };
  const state = {
    ...emptySyncState(normalizedConfig.serverUrl),
    ...previousState,
    serverUrl: normalizedConfig.serverUrl,
    documentRevisions: { ...previousState.documentRevisions },
    documentFingerprints: { ...previousState.documentFingerprints },
    deletedDocumentRevisions: { ...previousState.deletedDocumentRevisions },
  };
  const summary: SyncSummary = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: [] };
  const manifest = await fetchSyncManifest(normalizedConfig);
  const remoteById = new Map(manifest.documents.map((document) => [document.id, document]));
  const remoteLiveIds = new Set(
    manifest.documents
      .filter((document) => !document.deletedAt)
      .map((document) => document.id),
  );
  let documents = [...workspace.documents];
  const localById = () => new Map(documents.map((document) => [document.id, document]));

  for (const remote of manifest.documents) {
    const local = localById().get(remote.id);
    const knownRevision = state.documentRevisions[remote.id];
    const knownFingerprint = state.documentFingerprints[remote.id];
    const localChanged = Boolean(local && knownFingerprint !== documentFingerprint(local));

    if (remote.deletedAt) {
      recordDeletedState(state, remote.id, remote.revision);
      if (!local) continue;
      if (documents.length === 1) {
        summary.conflicts.push(`${local.title}：远端已删除，但本机至少需要保留一个文档`);
        continue;
      }
      if (knownRevision && !localChanged) {
        documents = documents.filter((document) => document.id !== remote.id);
        summary.deleted += 1;
      } else {
        summary.conflicts.push(`${local.title}：远端已删除，本机也有改动`);
      }
      continue;
    }

    if (!local) {
      if (knownRevision) {
        if (knownRevision === remote.revision) {
          const deleted = await deleteRemoteDocument(normalizedConfig, remote.id, remote.revision);
          recordDeletedState(state, remote.id, deleted.revision);
          checkpointSyncState(state, options);
          summary.deleted += 1;
        } else {
          summary.conflicts.push(`${remote.title}：本机已删除，但远端有更新`);
        }
      } else {
        const downloaded = await fetchRemoteDocument(normalizedConfig, remote.id);
        documents.push(downloaded.document);
        recordDocumentState(state, downloaded.document, downloaded.revision);
        summary.downloaded += 1;
      }
      continue;
    }

    if (!knownRevision) {
      const downloaded = await fetchRemoteDocument(normalizedConfig, remote.id);
      if (documentFingerprint(downloaded.document) === documentFingerprint(local)) {
        recordDocumentState(state, local, downloaded.revision);
      } else {
        summary.conflicts.push(`${local.title}：本机和远端都存在，尚未建立共同 revision`);
      }
      continue;
    }

    if (knownRevision === remote.revision) {
      if (localChanged) {
        const uploaded = await putRemoteDocument(normalizedConfig, local, knownRevision);
        documents = documents.map((document) =>
          document.id === uploaded.document.id ? uploaded.document : document,
        );
        recordDocumentState(state, uploaded.document, uploaded.revision);
        checkpointSyncState(state, options);
        summary.uploaded += 1;
      } else {
        recordDocumentState(state, local, remote.revision);
      }
      continue;
    }

    if (!localChanged) {
      const downloaded = await fetchRemoteDocument(normalizedConfig, remote.id);
      documents = documents.map((document) =>
        document.id === downloaded.document.id ? downloaded.document : document,
      );
      recordDocumentState(state, downloaded.document, downloaded.revision);
      summary.downloaded += 1;
    } else {
      summary.conflicts.push(`${local.title}：本机和远端都有新改动`);
    }
  }

  for (const local of documents) {
    if (remoteById.has(local.id)) continue;
    if (remoteLiveIds.has(local.id)) continue;
    const uploaded = await putRemoteDocument(normalizedConfig, local, null);
    documents = documents.map((document) =>
      document.id === uploaded.document.id ? uploaded.document : document,
    );
    recordDocumentState(state, uploaded.document, uploaded.revision);
    checkpointSyncState(state, options);
    summary.uploaded += 1;
  }

  const localOrder = workspace.documents.map((document) => document.id);
  const preferredOrder = [
    ...localOrder,
    ...manifest.documentOrder.filter((id) => !localOrder.includes(id)),
  ];
  const ordered = orderedDocuments(documents, preferredOrder);
  const activeDocumentId = ordered.some((document) => document.id === workspace.activeDocumentId)
    ? workspace.activeDocumentId
    : ordered[0]?.id ?? workspace.activeDocumentId;
  const nextWorkspace: Workspace = {
    version: 1,
    activeDocumentId,
    documents: ordered,
  };

  if (!summary.conflicts.length && nextWorkspace.documents.length) {
    const latestManifest = await fetchSyncManifest(normalizedConfig);
    const patchedManifest = await patchRemoteManifest(normalizedConfig, {
      expectedRevision: latestManifest.workspaceRevision,
      activeDocumentId: nextWorkspace.activeDocumentId,
      documentOrder: nextWorkspace.documents.map((document) => document.id),
    });
    state.workspaceRevision = patchedManifest.workspaceRevision;
  } else {
    state.workspaceRevision = manifest.workspaceRevision;
  }
  state.lastSyncedAt = syncTimestamp();
  return { workspace: nextWorkspace, state, summary };
};
