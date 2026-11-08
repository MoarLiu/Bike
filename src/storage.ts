import type { Workspace } from "./types";
import { uuid } from "./id";
import { migrateWorkspace } from "./migrations";

const DB_NAME = "bike-db";
const LEGACY_DB_NAME = "local-outline-db";
const STORE_NAME = "workspace-store";
const WORKSPACE_KEY = "workspace";
const WORKSPACE_META_KEY = "workspace-meta";
const FALLBACK_KEY = "bike-workspace";
const FALLBACK_META_KEY = "bike-workspace-meta";
const LEGACY_FALLBACK_KEY = "local-outline-workspace";
const LEGACY_FALLBACK_META_KEY = "local-outline-workspace-meta";
const CHANNEL_NAME = "bike-workspace";

export type WorkspaceLoadResult =
  | { status: "loaded"; workspace: Workspace; source: "indexeddb" | "localstorage" }
  | { status: "empty" }
  | { status: "error"; error: Error; source?: "indexeddb" | "localstorage" };

export type WorkspaceSaveResult =
  | { ok: true; target: "indexeddb" | "localstorage" }
  | { ok: false; error: Error; conflict?: boolean };

type StoredMeta = { revision: number; savedAt: number; writer: string | null };

type DatabaseRead =
  | { status: "loaded"; workspace: Workspace; meta: StoredMeta }
  | { status: "empty"; meta: StoredMeta }
  | { status: "error"; error: Error };

type FallbackSnapshot = {
  status: "loaded";
  workspace: Workspace;
  savedAt: number;
  baseRevision: number | null;
  writer: string | null;
};

type FallbackRead = FallbackSnapshot | { status: "empty" } | { status: "error"; error: Error };

type ReadResult =
  | {
      status: "loaded";
      workspace: Workspace;
      source: "indexeddb" | "localstorage";
      revision: number | null;
      persisted: boolean;
    }
  | { status: "empty"; revision: number }
  | { status: "error"; error: Error; source: "indexeddb" | "localstorage" };

type WriteOutcome =
  | { status: "saved"; revision: number }
  | { status: "unchanged" }
  | { status: "conflict" }
  | { status: "superseded" };

type SavedMessage = { type: "workspace-saved"; revision: number; pageId: string };

const CONFLICT_MESSAGE = "工作区已在其他标签页或窗口中更新，为避免互相覆盖，本页已暂停保存";
const SUPERSEDED_MESSAGE = "工作区已从其他标签页刷新，本次保存已取消，请重试";

// Identifies this page (tab or window) in stored metadata and broadcasts.
const pageId = uuid();
// Revision of the IndexedDB copy this page last loaded or wrote. Writes are
// compare-and-swap against it, so a page holding an older copy (another tab,
// a stale window) can never silently overwrite newer data. null means the
// base is unknown (IndexedDB was unavailable when the page loaded).
let knownRevision: number | null = null;
// The workspace object currently stored at knownRevision, if this page has it.
let persistedWorkspace: Workspace | null = null;
// Bumped whenever the page adopts a stored copy. A save requested before that
// belongs to the replaced copy and must not be written.
let adoptEpoch = 0;
let writeQueue: Promise<unknown> = Promise.resolve();
const conflictListeners = new Set<() => void>();
let channel: BroadcastChannel | null | undefined;

const toError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

const timestamp = (value: string | undefined) => {
  const time = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(time) ? time : 0;
};

const workspaceUpdatedAt = (workspace: Workspace) =>
  Math.max(0, ...workspace.documents.map((document) => timestamp(document.updatedAt)));

const isRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {};

const parseStoredMeta = (value: unknown): StoredMeta => {
  const meta = asRecord(value);
  return {
    // Copies written before revisions existed count as revision 0.
    revision: isRevision(meta.revision) ? meta.revision : 0,
    savedAt: typeof meta.savedAt === "string" ? timestamp(meta.savedAt) : 0,
    writer: typeof meta.writer === "string" ? meta.writer : null,
  };
};

const indexedDbFactory = (): IDBFactory | null => {
  try {
    return typeof indexedDB === "undefined" || !indexedDB ? null : indexedDB;
  } catch {
    return null;
  }
};

const openDb = (dbName = DB_NAME) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const factory = indexedDbFactory();
    if (!factory) {
      reject(new Error("当前环境无法使用 IndexedDB"));
      return;
    }
    const request = factory.open(dbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const readDatabase = async (dbName: string): Promise<DatabaseRead> => {
  let db: IDBDatabase;
  try {
    db = await openDb(dbName);
  } catch (error) {
    return { status: "error", error: toError(error) };
  }

  try {
    const stored = await new Promise<{ value: unknown; meta: unknown }>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(WORKSPACE_KEY);
      const metaRequest = store.get(WORKSPACE_META_KEY);
      tx.oncomplete = () => resolve({ value: request.result, meta: metaRequest.result });
      tx.onerror = () => reject(tx.error ?? request.error ?? metaRequest.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 读取被中止"));
    });
    const meta = parseStoredMeta(stored.meta);
    if (!stored.value) return { status: "empty", meta };
    const workspace = migrateWorkspace(stored.value);
    return {
      status: "loaded",
      workspace,
      meta: { ...meta, savedAt: meta.savedAt || workspaceUpdatedAt(workspace) },
    };
  } catch (error) {
    return { status: "error", error: toError(error) };
  } finally {
    db.close();
  }
};

const readFallbackWorkspace = (workspaceKey: string, metaKey: string): FallbackRead => {
  try {
    const raw = localStorage.getItem(workspaceKey);
    if (!raw) return { status: "empty" };
    const workspace = migrateWorkspace(JSON.parse(raw));
    let meta: Record<string, unknown> = {};
    try {
      meta = asRecord(JSON.parse(localStorage.getItem(metaKey) ?? "null"));
    } catch {}
    return {
      status: "loaded",
      workspace,
      savedAt: typeof meta.savedAt === "string" ? timestamp(meta.savedAt) : 0,
      baseRevision: isRevision(meta.baseRevision) ? meta.baseRevision : null,
      writer: typeof meta.writer === "string" ? meta.writer : null,
    };
  } catch (error) {
    return { status: "error", error: toError(error) };
  }
};

const readBestFallbackWorkspace = (): FallbackRead => {
  const current = readFallbackWorkspace(FALLBACK_KEY, FALLBACK_META_KEY);
  const legacy = readFallbackWorkspace(LEGACY_FALLBACK_KEY, LEGACY_FALLBACK_META_KEY);
  if (current.status === "loaded" && legacy.status === "loaded") {
    return current.savedAt >= legacy.savedAt ? current : legacy;
  }
  if (current.status !== "empty") return current;
  return legacy;
};

// Whether a localStorage snapshot (written when a page closed with unsaved
// edits, or when IndexedDB failed) is newer than the stored copy it would replace.
const snapshotIsNewer = (
  snapshot: FallbackSnapshot,
  stored: StoredMeta,
  storedWorkspace: Workspace | null,
) => {
  if (snapshot.baseRevision !== null) {
    // The snapshot records the stored revision its page was editing.
    if (snapshot.baseRevision === stored.revision) return true;
    if (snapshot.baseRevision < stored.revision) {
      // Later revisions are the snapshot's own ancestors only if its page wrote
      // them (a save still in flight while it closed). Otherwise another tab or
      // window saved newer data after this snapshot's page last loaded.
      return snapshot.writer !== null && snapshot.writer === stored.writer;
    }
    // The database is behind the snapshot's base: it was cleared or replaced,
    // so only timestamps can tell which copy is newer.
  }
  // Snapshots from older versions only carry a timestamp. Also require their
  // newest edit to be at least as new as the stored copy's, so a stale page
  // that happened to close last cannot win.
  return snapshot.savedAt > stored.savedAt &&
    (!storedWorkspace || workspaceUpdatedAt(snapshot.workspace) >= workspaceUpdatedAt(storedWorkspace));
};

const readWorkspace = async (): Promise<ReadResult> => {
  if (!indexedDbFactory()) {
    // Without IndexedDB the localStorage snapshot is the only copy, so loading
    // it cannot put an older copy on top of a newer database.
    const fallback = readBestFallbackWorkspace();
    if (fallback.status === "loaded") {
      return {
        status: "loaded",
        workspace: fallback.workspace,
        source: "localstorage",
        revision: fallback.baseRevision,
        persisted: false,
      };
    }
    if (fallback.status === "error") return { ...fallback, source: "localstorage" };
    return { status: "error", source: "indexeddb", error: new Error("当前环境无法使用 IndexedDB") };
  }

  const current = await readDatabase(DB_NAME);
  if (current.status === "error") {
    // Do not fall back to the legacy database or a localStorage snapshot here:
    // autosave would then write that older copy over the unreadable database.
    return { status: "error", source: "indexeddb", error: current.error };
  }

  const fallback = readBestFallbackWorkspace();
  if (current.status === "loaded") {
    if (fallback.status === "loaded" && snapshotIsNewer(fallback, current.meta, current.workspace)) {
      return {
        status: "loaded",
        workspace: fallback.workspace,
        source: "localstorage",
        revision: current.meta.revision,
        persisted: false,
      };
    }
    return {
      status: "loaded",
      workspace: current.workspace,
      source: "indexeddb",
      revision: current.meta.revision,
      persisted: true,
    };
  }

  // The current database is empty: migrate the legacy database or snapshot.
  const legacy = await readDatabase(LEGACY_DB_NAME);
  if (legacy.status === "loaded") {
    const legacyMeta = { ...legacy.meta, revision: current.meta.revision };
    const useSnapshot = fallback.status === "loaded" && snapshotIsNewer(fallback, legacyMeta, legacy.workspace);
    return {
      status: "loaded",
      workspace: useSnapshot ? fallback.workspace : legacy.workspace,
      source: useSnapshot ? "localstorage" : "indexeddb",
      revision: current.meta.revision,
      persisted: false,
    };
  }
  if (fallback.status === "loaded") {
    return {
      status: "loaded",
      workspace: fallback.workspace,
      source: "localstorage",
      revision: current.meta.revision,
      persisted: false,
    };
  }
  if (fallback.status === "error") return { ...fallback, source: "localstorage" };
  if (legacy.status === "error") return { status: "error", source: "indexeddb", error: legacy.error };
  return { status: "empty", revision: current.meta.revision };
};

const adopt = (result: ReadResult): WorkspaceLoadResult => {
  if (result.status === "error") {
    return { status: "error", error: result.error, source: result.source };
  }
  adoptEpoch += 1;
  knownRevision = result.revision;
  if (result.status === "empty") {
    persistedWorkspace = null;
    return { status: "empty" };
  }
  persistedWorkspace = result.persisted ? result.workspace : null;
  return { status: "loaded", workspace: result.workspace, source: result.source };
};

const settledWrites = () => writeQueue.then(() => undefined, () => undefined);

export const loadWorkspace = async (): Promise<WorkspaceLoadResult> => {
  await settledWrites();
  return adopt(await readWorkspace());
};

// Reloads the stored workspace (after another page saved) if canApply() still
// allows it once the read finishes, i.e. the page has no unsaved edits by then.
export const reloadWorkspaceIf = async (canApply: () => boolean): Promise<Workspace | null> => {
  await settledWrites();
  const result = await readWorkspace();
  if (result.status !== "loaded" || !canApply()) return null;
  adopt(result);
  return result.workspace;
};

// True when the workspace object is exactly what this page last loaded from or
// wrote to IndexedDB, i.e. it has no unsaved edits.
export const isWorkspacePersisted = (workspace: Workspace | null | undefined) =>
  Boolean(workspace) && workspace === persistedWorkspace;

const clearFallback = () => {
  try {
    localStorage.removeItem(FALLBACK_KEY);
    localStorage.removeItem(FALLBACK_META_KEY);
    localStorage.removeItem(LEGACY_FALLBACK_KEY);
    localStorage.removeItem(LEGACY_FALLBACK_META_KEY);
  } catch {}
};

const workspaceChannel = () => {
  if (channel === undefined) {
    try {
      channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL_NAME) : null;
    } catch {
      channel = null;
    }
  }
  return channel;
};

const broadcastSaved = (revision: number) => {
  const message: SavedMessage = { type: "workspace-saved", revision, pageId };
  try {
    workspaceChannel()?.postMessage(message);
  } catch {}
};

// Calls listener when another tab or window saves a newer workspace.
export const subscribeToWorkspaceChanges = (listener: () => void) => {
  const activeChannel = workspaceChannel();
  if (!activeChannel) return () => {};
  const handleMessage = (event: MessageEvent) => {
    const message = asRecord(event.data);
    if (message.type !== "workspace-saved" || message.pageId === pageId) return;
    if (isRevision(message.revision) && knownRevision !== null && message.revision <= knownRevision) return;
    listener();
  };
  activeChannel.addEventListener("message", handleMessage);
  return () => activeChannel.removeEventListener("message", handleMessage);
};

// Calls listener when a save is refused because another page saved first.
export const subscribeToWorkspaceConflicts = (listener: () => void) => {
  conflictListeners.add(listener);
  return () => {
    conflictListeners.delete(listener);
  };
};

const writeWorkspace = async (
  workspace: Workspace,
  overwrite: boolean,
  epoch: number,
): Promise<WorkspaceSaveResult> => {
  let db: IDBDatabase | null = null;
  let outcome: WriteOutcome;
  try {
    const activeDb = await openDb();
    db = activeDb;
    outcome = await new Promise<WriteOutcome>((resolve, reject) => {
      const tx = activeDb.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      let result: WriteOutcome | null = null;
      let failure: unknown = null;
      // Read the stored revision inside the write transaction, so the check and
      // the write are atomic even across tabs.
      const metaRequest = store.get(WORKSPACE_META_KEY);
      metaRequest.onsuccess = () => {
        // The page may have adopted another stored copy while this save waited
        // for the database; knownRevision then belongs to that copy, not to
        // the one this save was requested for.
        if (epoch !== adoptEpoch) {
          result = { status: "superseded" };
          tx.abort();
          return;
        }
        const stored = parseStoredMeta(metaRequest.result);
        if (!overwrite && stored.revision !== (knownRevision ?? 0)) {
          result = { status: "conflict" };
          tx.abort();
          return;
        }
        if (!overwrite && workspace === persistedWorkspace) {
          result = { status: "unchanged" };
          return;
        }
        const revision = stored.revision + 1;
        try {
          store.put(workspace, WORKSPACE_KEY);
          store.put({ savedAt: new Date().toISOString(), revision, writer: pageId }, WORKSPACE_META_KEY);
          result = { status: "saved", revision };
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        if (result) resolve(result);
        else reject(new Error("IndexedDB 保存未完成"));
      };
      tx.onabort = () => {
        if (result?.status === "conflict" || result?.status === "superseded") resolve(result);
        else reject(failure ?? tx.error ?? new Error("IndexedDB 保存被中止"));
      };
    });
  } catch (indexedDbError) {
    const fallback = saveWorkspaceFallback(workspace);
    if (fallback.ok) return fallback;
    return {
      ok: false,
      error: new Error(
        `IndexedDB 保存失败：${toError(indexedDbError).message}；localStorage 备份也失败：${fallback.error.message}`,
      ),
    };
  } finally {
    db?.close();
  }

  if (outcome.status === "superseded") {
    return { ok: false, conflict: true, error: new Error(SUPERSEDED_MESSAGE) };
  }
  if (outcome.status === "conflict") {
    conflictListeners.forEach((listener) => {
      try {
        listener();
      } catch {}
    });
    return { ok: false, conflict: true, error: new Error(CONFLICT_MESSAGE) };
  }
  if (outcome.status === "saved") {
    knownRevision = outcome.revision;
    persistedWorkspace = workspace;
    clearFallback();
    broadcastSaved(outcome.revision);
  }
  return { ok: true, target: "indexeddb" };
};

// Saves are serialized per page. A save only succeeds while IndexedDB still
// holds the revision this page last loaded or wrote; otherwise it reports a
// conflict instead of overwriting. `overwrite` skips that check and is only
// for an explicit user decision.
export const saveWorkspace = (
  workspace: Workspace,
  options: { overwrite?: boolean } = {},
): Promise<WorkspaceSaveResult> => {
  const epoch = adoptEpoch;
  const run = (): Promise<WorkspaceSaveResult> => {
    if (epoch !== adoptEpoch) {
      return Promise.resolve({ ok: false, conflict: true, error: new Error(SUPERSEDED_MESSAGE) });
    }
    return writeWorkspace(workspace, options.overwrite === true, epoch);
  };
  const result = writeQueue.then(run, run);
  writeQueue = result;
  return result;
};

// Synchronous last-resort copy, used while the page unloads and when IndexedDB
// fails. It records which stored revision it is based on, so it can never win
// over data another page saved later.
export const saveWorkspaceFallback = (workspace: Workspace): WorkspaceSaveResult => {
  try {
    const savedAt = new Date(Math.max(Date.now(), workspaceUpdatedAt(workspace) + 1)).toISOString();
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(workspace));
    try {
      localStorage.setItem(
        FALLBACK_META_KEY,
        JSON.stringify({ savedAt, baseRevision: knownRevision, writer: pageId }),
      );
    } catch (error) {
      // Never leave a snapshot paired with another snapshot's metadata.
      localStorage.removeItem(FALLBACK_KEY);
      throw error;
    }
    return { ok: true, target: "localstorage" };
  } catch (error) {
    return {
      ok: false,
      error: toError(error),
    };
  }
};
