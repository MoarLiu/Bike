import { migrateDocument } from "./migrations";
import type { OutlineDocument, Workspace } from "./types";
import { documentSignature, legacyDocumentSignature, sameDocumentContent } from "./documentSignature";
import { SYNC_TIMEOUT_MS, MAX_SYNC_RESPONSE_BYTES, readResponseText, withRequestBudget } from "../shared/bike-network.mjs";
import { workspaceFormatVersion } from "../shared/bike-attachments.mjs";

export type SyncConfig = {
  serverUrl: string;
  token: string;
  autoSync: boolean;
  autoSyncIntervalSeconds: number;
};

export type SyncState = {
  fingerprintVersion?: number;
  serverUrl: string;
  workspaceRevision: number | null;
  documentRevisions: Record<string, number>;
  documentFingerprints: Record<string, string>;
  deletedDocumentRevisions: Record<string, number>;
  // Server document order after the last successful sync: the merge base.
  documentOrder: string[] | null;
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
  capabilities?: string[];
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
  checkpointErrors?: string[];
};

export type SyncCheckpointOptions = {
  onCheckpoint?: (state: SyncState) => void;
  onCheckpointError?: (error: unknown, state: SyncState) => void;
};

const CONFIG_KEY = "bike-sync-config";
const STATE_KEY = "bike-sync-states.v2";
const LEGACY_STATE_KEY = "bike-sync-state";
const pendingSyncStates = new Map<string, SyncState>();
export const FINGERPRINT_VERSION = 3;
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
  try {
    const url = new URL(trimmed);
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch { return trimmed.replace(/\/+$/, ""); }
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
  fingerprintVersion: FINGERPRINT_VERSION,
  serverUrl: normalizeSyncServerUrl(serverUrl),
  workspaceRevision: null,
  documentRevisions: {},
  documentFingerprints: {},
  deletedDocumentRevisions: {},
  documentOrder: null,
  lastSyncedAt: null,
});

const documentOrderOrNull = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((id) => typeof id === "string")
    ? [...value]
    : null;

export const loadSyncState = (serverUrl: string): SyncState => {
  const normalizedServerUrl = normalizeSyncServerUrl(serverUrl);
  const pending = pendingSyncStates.get(normalizedServerUrl);
  if (pending) return cloneSyncState(pending);
  try {
    const raw = localStorage.getItem(STATE_KEY);
    const states = raw ? JSON.parse(raw) as Record<string, Partial<SyncState>> : {};
    const legacy = localStorage.getItem(LEGACY_STATE_KEY);
    const parsed = states[normalizedServerUrl] ?? (legacy ? JSON.parse(legacy) : null) as Partial<SyncState> | null;
    if (!parsed || typeof parsed.serverUrl !== "string" || normalizeSyncServerUrl(parsed.serverUrl) !== normalizedServerUrl) {
      return emptySyncState(normalizedServerUrl);
    }
    return {
      fingerprintVersion: parsed.fingerprintVersion ?? 1,
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
      documentOrder: documentOrderOrNull(parsed.documentOrder),
      lastSyncedAt:
        typeof parsed.lastSyncedAt === "string" ? parsed.lastSyncedAt : null,
    };
  } catch {
    return emptySyncState(normalizedServerUrl);
  }
};

export const saveSyncState = (state: SyncState) => {
  const serverUrl = normalizeSyncServerUrl(state.serverUrl);
  const next = cloneSyncState({ ...state, serverUrl });
  // Keep usable progress before attempting quota-sensitive persistence.
  pendingSyncStates.set(serverUrl, next);
  let states: Record<string, SyncState> = {};
  const raw = localStorage.getItem(STATE_KEY);
  if (raw) states = JSON.parse(raw);
  const legacy = localStorage.getItem(LEGACY_STATE_KEY);
  if (legacy) {
    const previous = JSON.parse(legacy) as SyncState;
    if (typeof previous.serverUrl === "string") {
      const key = normalizeSyncServerUrl(previous.serverUrl);
      if (!states[key]) states[key] = previous;
    }
  }
  localStorage.setItem(STATE_KEY, JSON.stringify({ ...states, [serverUrl]: next }));
  pendingSyncStates.delete(serverUrl);
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

export const apiRequest = async <T>(
  config: SyncConfig,
  pathname: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number; maxResponseBytes?: number } = {},
): Promise<T> => {
  return withRequestBudget({ signal: options.signal, timeoutMs: options.timeoutMs ?? SYNC_TIMEOUT_MS }, async (signal) => {
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
      signal,
    });
  } catch (error) {
    throw new SyncApiError(0, syncFetchFailurePayload(config, error));
  }
  const text = await readResponseText(response, { signal, maxBytes: options.maxResponseBytes ?? MAX_SYNC_RESPONSE_BYTES });
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
  });
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
  if (document.attachments) {
    const manifest = await fetchSyncManifest(config);
    if (!manifest.capabilities?.includes("attachments-v1")) {
      throw new SyncApiError(426, { message: "当前同步服务尚未支持附件保护，请先升级服务或通过 ZIP 迁移" });
    }
  }
  const response = await apiRequest<{ revision: number; document: unknown }>(
    config,
    `/api/documents/${encodeURIComponent(document.id)}`,
    {
      method: "PUT",
      body: { expectedRevision, document, capabilities: ["attachments-v1"] },
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

const legacyDocumentFingerprint = (document: OutlineDocument) => {
  const value = JSON.stringify(document);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
};

export const documentFingerprint = (document: OutlineDocument) =>
  `v${FINGERPRINT_VERSION}:${documentSignature(document)}`;

const fingerprintMatches = (fingerprint: string | undefined, document: OutlineDocument) =>
  fingerprint === (fingerprint?.startsWith(`v${FINGERPRINT_VERSION}:`) ? documentFingerprint(document)
    : fingerprint?.startsWith("v2:") ? `v2:${legacyDocumentSignature(document)}` : legacyDocumentFingerprint(document));

const syncTimestamp = () => new Date().toISOString();

const cloneSyncState = (state: SyncState): SyncState => ({
  fingerprintVersion: state.fingerprintVersion ?? 1,
  serverUrl: state.serverUrl,
  workspaceRevision: state.workspaceRevision,
  documentRevisions: { ...state.documentRevisions },
  documentFingerprints: { ...state.documentFingerprints },
  deletedDocumentRevisions: { ...state.deletedDocumentRevisions },
  documentOrder: documentOrderOrNull(state.documentOrder),
  lastSyncedAt: state.lastSyncedAt,
});

const checkpointSyncState = (
  state: SyncState,
  options?: SyncCheckpointOptions,
  summary?: SyncSummary,
) => {
  state.lastSyncedAt = syncTimestamp();
  const checkpoint = cloneSyncState(state);
  try { options?.onCheckpoint?.(checkpoint); }
  catch (error) {
    if (summary) (summary.checkpointErrors ??= []).push(error instanceof Error ? error.message : String(error));
    try { options?.onCheckpointError?.(error, checkpoint); } catch { /* Progress stays usable. */ }
  }
};

const recordDocumentState = (
  state: SyncState,
  document: OutlineDocument,
  revision: number,
) => {
  state.fingerprintVersion = FINGERPRINT_VERSION;
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

const isRevisionConflict = (error: unknown) =>
  error instanceof SyncApiError && error.status === 409;

const sameSequence = (left: string[], right: string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const sameRelativeOrder = (left: string[], right: string[]) => {
  const leftIds = new Set(left);
  const rightIds = new Set(right);
  return sameSequence(
    left.filter((id) => rightIds.has(id)),
    right.filter((id) => leftIds.has(id)),
  );
};

// Adds the ids only `secondary` has right after their nearest preceding
// neighbour from `secondary`, so a document keeps its place on the side
// that has it (new documents are inserted at the top, not appended).
const weaveOrder = (primary: string[], secondary: string[]) => {
  const result = [...primary];
  let anchor = -1;
  for (const id of secondary) {
    const index = result.indexOf(id);
    if (index >= 0) {
      anchor = index;
      continue;
    }
    anchor += 1;
    result.splice(anchor, 0, id);
  }
  return result;
};

// Three-way merge of the document order. A side "changed" when the relative
// order of the documents base, local and remote all share differs from base.
// Only a remote change with no local change adopts the remote order; anything
// else keeps the local order, so local reorders are never silently dropped.
const mergeDocumentOrder = (
  base: string[] | null,
  local: string[],
  remote: string[],
) => {
  if (!base) return [...local, ...remote.filter((id) => !local.includes(id))];
  const localIds = new Set(local);
  const remoteIds = new Set(remote);
  const common = new Set(base.filter((id) => localIds.has(id) && remoteIds.has(id)));
  const baseCommon = [...new Set(base)].filter((id) => common.has(id));
  const unchanged = (order: string[]) =>
    sameSequence(order.filter((id) => common.has(id)), baseCommon);
  return unchanged(local) && !unchanged(remote)
    ? weaveOrder(remote, local)
    : weaveOrder(local, remote);
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
    version: workspaceFormatVersion({ documents: ordered }),
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
  state.documentOrder = [...manifest.documentOrder];
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
    checkpointSyncState(state, options, summary);
    summary.uploaded += 1;
  }

  // An explicit, user-confirmed overwrite: last writer wins on purpose here.
  manifest = await fetchSyncManifest(normalizedConfig);
  const patchedManifest = await patchRemoteManifest(normalizedConfig, {
    expectedRevision: manifest.workspaceRevision,
    activeDocumentId: workspace.activeDocumentId,
    documentOrder: workspace.documents.map((document) => document.id),
  });
  state.workspaceRevision = patchedManifest.workspaceRevision;
  state.documentOrder = [...patchedManifest.documentOrder];
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
  const baseOrder = documentOrderOrNull(previousState.documentOrder);
  const state: SyncState = {
    ...emptySyncState(normalizedConfig.serverUrl),
    ...previousState,
    serverUrl: normalizedConfig.serverUrl,
    documentRevisions: { ...previousState.documentRevisions },
    documentFingerprints: { ...previousState.documentFingerprints },
    deletedDocumentRevisions: { ...previousState.deletedDocumentRevisions },
    documentOrder: baseOrder,
  };
  // Downloads are not durable until the caller saves the returned workspace.
  const checkpointState = cloneSyncState(state);
  const summary: SyncSummary = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: [] };
  const manifest = await fetchSyncManifest(normalizedConfig);
  const remoteById = new Map(manifest.documents.map((document) => [document.id, document]));
  const remoteLiveIds = new Set(
    manifest.documents
      .filter((document) => !document.deletedAt)
      .map((document) => document.id),
  );
  // The manifest as this sync's own creates, resurrects and deletes leave it:
  // each bumps workspaceRevision and moves the id like the server does.
  let expectedWorkspaceRevision = manifest.workspaceRevision;
  let serverOrder = [...manifest.documentOrder];
  const notePresenceChange = (id: string, present: boolean) => {
    expectedWorkspaceRevision += 1;
    serverOrder = serverOrder.filter((item) => item !== id);
    if (present) serverOrder.push(id);
  };
  let documents = workspace.documents;
  const localById = () => new Map(documents.map((document) => [document.id, document]));
  const recordUpload = (uploaded: { revision: number; document: OutlineDocument }) => {
    if (documents.some((document) => document.id === uploaded.document.id && !sameDocumentContent(document, uploaded.document))) {
      documents = documents.map((document) => document.id === uploaded.document.id ? uploaded.document : document);
    }
    recordDocumentState(state, uploaded.document, uploaded.revision);
    recordDocumentState(checkpointState, uploaded.document, uploaded.revision);
    checkpointSyncState(checkpointState, options, summary);
    summary.uploaded += 1;
  };
  // Edits win over deletes: bring a remotely deleted document back with the
  // local copy. A conflict leaves its sync state untouched, so the next round
  // retries against the newer remote revision instead of conflicting forever.
  const resurrect = async (local: OutlineDocument, deletedRevision: number) => {
    let uploaded: Awaited<ReturnType<typeof putRemoteDocument>>;
    try {
      uploaded = await putRemoteDocument(normalizedConfig, local, deletedRevision);
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
      summary.conflicts.push(`${local.title}：远端已删除，恢复本机版本时远端又有变化，将在下次同步重试`);
      return;
    }
    notePresenceChange(local.id, true);
    recordUpload(uploaded);
  };
  const unchangedRemoteDeletions: SyncDocumentSummary[] = [];

  for (const remote of manifest.documents) {
    const local = localById().get(remote.id);
    const knownRevision = state.documentRevisions[remote.id];
    const knownFingerprint = state.documentFingerprints[remote.id];
    const localChanged = Boolean(local && !fingerprintMatches(knownFingerprint, local));

    if (remote.deletedAt) {
      if (!local) {
        recordDeletedState(state, remote.id, remote.revision);
      } else if (localChanged) {
        await resurrect(local, remote.revision);
      } else {
        // Provably unchanged since the last sync: the delete wins, unless it
        // would leave this device without documents (decided after downloads).
        unchangedRemoteDeletions.push(remote);
      }
      continue;
    }

    if (!local) {
      if (knownRevision === remote.revision) {
        const deleted = await deleteRemoteDocument(normalizedConfig, remote.id, remote.revision);
        notePresenceChange(remote.id, false);
        recordDeletedState(state, remote.id, deleted.revision);
        recordDeletedState(checkpointState, remote.id, deleted.revision);
        checkpointSyncState(checkpointState, options, summary);
        summary.deleted += 1;
      } else {
        // New remotely, or changed there since this device deleted it: remote
        // edits win over the local delete, so the document is restored.
        const downloaded = await fetchRemoteDocument(normalizedConfig, remote.id);
        documents = [...documents, downloaded.document];
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
        // An unversioned fingerprint may differ only because of old timestamp
        // or key ordering rules. Reconcile its real content before uploading.
        const remoteContent = !knownFingerprint?.startsWith(`v${FINGERPRINT_VERSION}:`)
          ? await fetchRemoteDocument(normalizedConfig, remote.id) : null;
        if (remoteContent && sameDocumentContent(remoteContent.document, local)) {
          recordDocumentState(state, local, remoteContent.revision);
        } else recordUpload(await putRemoteDocument(normalizedConfig, local, knownRevision));
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
      // Covers a successful upload whose checkpoint could not be persisted.
      // A newer revision alone is never sufficient to overwrite the server.
      const remoteContent = await fetchRemoteDocument(normalizedConfig, remote.id);
      if (sameDocumentContent(remoteContent.document, local)) {
        recordDocumentState(state, local, remoteContent.revision);
      } else summary.conflicts.push(`${local.title}：本机和远端都有新改动`);
    }
  }

  for (const remote of unchangedRemoteDeletions) {
    const local = localById().get(remote.id);
    if (!local) continue;
    if (documents.length > 1) {
      documents = documents.filter((document) => document.id !== remote.id);
      recordDeletedState(state, remote.id, remote.revision);
      summary.deleted += 1;
    } else {
      // The device must keep at least one document; keep it on the server too.
      await resurrect(local, remote.revision);
    }
  }

  for (const local of documents) {
    if (remoteById.has(local.id)) continue;
    if (remoteLiveIds.has(local.id)) continue;
    const uploaded = await putRemoteDocument(normalizedConfig, local, null);
    notePresenceChange(local.id, true);
    recordUpload(uploaded);
  }

  const localOrder = workspace.documents.map((document) => document.id);
  const preferredOrder = mergeDocumentOrder(baseOrder, localOrder, manifest.documentOrder);
  const ordered = orderedDocuments(documents, preferredOrder);
  const activeDocumentId = ordered.some((document) => document.id === workspace.activeDocumentId)
    ? workspace.activeDocumentId
    : ordered[0]?.id ?? workspace.activeDocumentId;
  const unchanged = ordered.length === workspace.documents.length &&
    ordered.every((document, index) => document === workspace.documents[index]) &&
    activeDocumentId === workspace.activeDocumentId;
  const nextWorkspace: Workspace = unchanged ? workspace : {
    ...workspace,
    version: workspaceFormatVersion({ ...workspace, documents: ordered }),
    activeDocumentId,
    documents: ordered,
  };

  // Guard the order with the revision this sync observed (plus its own
  // presence changes), and only write it when the server's order differs.
  const desiredOrder = ordered.map((document) => document.id);
  let recordedOrder = serverOrder;
  if (desiredOrder.length && !sameRelativeOrder(desiredOrder, serverOrder)) {
    try {
      const patchedManifest = await patchRemoteManifest(normalizedConfig, {
        expectedRevision: expectedWorkspaceRevision,
        activeDocumentId,
        documentOrder: desiredOrder,
      });
      expectedWorkspaceRevision = patchedManifest.workspaceRevision;
      recordedOrder = patchedManifest.documentOrder;
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
      // Another device changed the manifest meanwhile. Keep the document
      // results; the base stays the order this sync saw, so the next round
      // merges against that device's change instead of overwriting it.
    }
  }
  state.documentOrder = [...recordedOrder];
  state.workspaceRevision = expectedWorkspaceRevision;
  state.lastSyncedAt = syncTimestamp();
  return { workspace: nextWorkspace, state, summary };
};
