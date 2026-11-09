import type { Workspace } from "./types";
import { uuid } from "./id";
import { migrateWorkspace } from "./migrations";
import { assertWorkspaceBudget } from "../shared/bike-limits.mjs";
import { sha256Hex } from "./knowledge";
import { workspaceAttachmentAssets, workspaceFormatVersion } from "../shared/bike-attachments.mjs";

const DB_NAME = "bike-db";
const LEGACY_DB_NAME = "local-outline-db";
const STORE_NAME = "workspace-store";
const WORKSPACE_KEY = "workspace";
const WORKSPACE_META_KEY = "workspace-meta";
const PRE_ATTACHMENT_KEY = "workspace-before-attachments-v1";
const PRE_ATTACHMENT_FALLBACK_KEY = "bike-workspace-before-attachments-v1";
const FALLBACK_KEY = "bike-workspace";
const FALLBACK_META_KEY = "bike-workspace-meta";
const LEGACY_FALLBACK_KEY = "local-outline-workspace";
const LEGACY_FALLBACK_META_KEY = "local-outline-workspace-meta";
const FALLBACK_SNAPSHOT_PREFIX = "bike-workspace-snapshot:";
const CHANNEL_NAME = "bike-workspace";

export type WorkspaceLoadResult =
  | { status: "loaded"; workspace: Workspace; source: "indexeddb" | "localstorage" }
  | { status: "empty" }
  | { status: "error"; error: Error; source?: "indexeddb" | "localstorage" };

export type WorkspaceSaveResult =
  | { ok: true; target: "indexeddb" | "localstorage" }
  | { ok: false; error: Error; conflict?: boolean };

export type WorkspaceRecoverySnapshot = {
  id: string;
  workspace: Workspace;
  savedAt: number;
  baseRevision: number | null;
};
export type WorkspaceRecoveryFile = { id: string; content: string };

type StoredMeta = { revision: number; savedAt: number; writer: string | null; saveId: string | null };

type DatabaseRead =
  | { status: "loaded"; workspace: Workspace; meta: StoredMeta }
  | { status: "empty"; meta: StoredMeta }
  | { status: "error"; error: Error };

type FallbackSnapshot = WorkspaceRecoverySnapshot & {
  status: "loaded";
  writer: string | null;
  raw: string;
  metaKey?: string;
  rawMeta?: string | null;
  pendingSaveIds?: string[];
};

type FallbackRead = FallbackSnapshot | { status: "empty" } | { status: "error"; error: Error };

type ReadResult =
  | {
      status: "loaded";
      workspace: Workspace;
      source: "indexeddb" | "localstorage";
      revision: number | null;
      persisted: boolean;
      snapshot?: FallbackSnapshot;
    }
  | { status: "empty"; revision: number }
  | { status: "error"; error: Error; source: "indexeddb" | "localstorage" };

type WriteOutcome =
  | { status: "saved"; revision: number }
  | { status: "unchanged"; revision: number }
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
// A receipt belongs to the exact object committed by IndexedDB. Its revision
// orders saves across windows, unlike a renderer's private request counter.
const savedRevisions = new WeakMap<Workspace, number>();
export const getWorkspaceSaveRevision = (workspace: Workspace): number | undefined => savedRevisions.get(workspace);
let ownFallback: FallbackSnapshot | null = null;
let saveSequence = 0;
let ownFallbackSequence = 0;
let adoptedFallback: FallbackSnapshot | null = null;
// Bumped whenever the page adopts a stored copy. A save requested before that
// belongs to the replaced copy and must not be written.
let adoptEpoch = 0;
let writeQueue: Promise<unknown> = Promise.resolve();
const pendingSaveIds = new Set<string>();
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

const workspaceSignatures = new WeakMap<Workspace, string>();
const workspaceSignature = (workspace: Workspace) => {
  const cached = workspaceSignatures.get(workspace);
  if (cached) return cached;
  const signature = sha256Hex(JSON.stringify(workspace, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
      : value));
  workspaceSignatures.set(workspace, signature);
  return signature;
};

const sameWorkspace = (left: Workspace, right: Workspace) =>
  workspaceSignature(left) === workspaceSignature(right);

const parseStoredMeta = (value: unknown): StoredMeta => {
  const meta = asRecord(value);
  return {
    // Copies written before revisions existed count as revision 0.
    revision: isRevision(meta.revision) ? meta.revision : 0,
    savedAt: typeof meta.savedAt === "string" ? timestamp(meta.savedAt) : 0,
    writer: typeof meta.writer === "string" ? meta.writer : null,
    saveId: typeof meta.saveId === "string" ? meta.saveId : null,
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

const recoveryCache = new Map<string, { raw: string; meta: string | null; result: FallbackRead }>();
const cacheRecovery = (key: string, raw: string, meta: string | null, read: () => FallbackRead): FallbackRead => {
  const cached = recoveryCache.get(key);
  if (cached?.raw === raw && cached.meta === meta) return cached.result;
  let result: FallbackRead;
  try { result = read(); } catch (error) { result = { status: "error", error: toError(error) }; }
  recoveryCache.delete(key);
  recoveryCache.set(key, { raw, meta, result });
  let retained = 0;
  for (const entry of recoveryCache.values()) retained += entry.raw.length * 2;
  while (recoveryCache.size > 16 || retained > 16 * 1024 * 1024) {
    const oldest = recoveryCache.keys().next().value!;
    retained -= recoveryCache.get(oldest)!.raw.length * 2;
    recoveryCache.delete(oldest);
  }
  return result;
};

const readFallbackWorkspace = (workspaceKey: string, metaKey: string): FallbackRead => {
  try {
    const raw = localStorage.getItem(workspaceKey);
    if (!raw) return { status: "empty" };
    const rawMeta = localStorage.getItem(metaKey);
    return cacheRecovery(workspaceKey, raw, rawMeta, () => {
    const workspace = migrateWorkspace(JSON.parse(raw));
    let meta: Record<string, unknown> = {};
    try {
      meta = asRecord(JSON.parse(rawMeta ?? "null"));
    } catch {}
    return {
      status: "loaded",
      id: workspaceKey,
      workspace,
      savedAt: typeof meta.savedAt === "string" ? timestamp(meta.savedAt) : 0,
      baseRevision: isRevision(meta.baseRevision) ? meta.baseRevision : null,
      writer: typeof meta.writer === "string" ? meta.writer : null,
      raw,
      metaKey,
      rawMeta,
    };
    });
  } catch (error) {
    return { status: "error", error: toError(error) };
  }
};

const readFallbackSnapshots = (): { snapshots: FallbackSnapshot[]; error?: Error } => {
  const snapshots: FallbackSnapshot[] = [];
  let error: Error | undefined;
  try {
    // Snapshot contents and metadata share one immutable key. Each page writes
    // a new key before removing its previous one, so a failed write retains it.
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    const present = new Set(keys);
    for (const key of recoveryCache.keys()) if (!present.has(key)) recoveryCache.delete(key);
    for (const id of keys) {
      if (!id?.startsWith(FALLBACK_SNAPSHOT_PREFIX)) continue;
      const raw = localStorage.getItem(id);
      if (!raw) continue;
      try {
        const cached = cacheRecovery(id, raw, null, () => {
        const envelope = asRecord(JSON.parse(raw));
        return {
          status: "loaded", id, raw,
          workspace: migrateWorkspace(envelope.workspace),
          savedAt: typeof envelope.savedAt === "string" ? timestamp(envelope.savedAt) : 0,
          baseRevision: isRevision(envelope.baseRevision) ? envelope.baseRevision : null,
          writer: typeof envelope.writer === "string" ? envelope.writer : null,
          pendingSaveIds: Array.isArray(envelope.pendingSaveIds)
            ? envelope.pendingSaveIds.filter((id): id is string => typeof id === "string")
            : undefined,
        };
        });
        if (cached.status === "loaded") snapshots.push(cached);
        else if (cached.status === "error") error ??= cached.error;
      } catch (cause) {
        error ??= toError(cause);
      }
    }
    // Older copies are read for migration, never overwritten by new snapshots.
    for (const [key, metaKey] of [
      [FALLBACK_KEY, FALLBACK_META_KEY],
      [LEGACY_FALLBACK_KEY, LEGACY_FALLBACK_META_KEY],
    ]) {
      const result = readFallbackWorkspace(key, metaKey);
      if (result.status === "loaded") snapshots.push(result);
      else if (result.status === "error") error ??= result.error;
    }
  } catch (cause) {
    error ??= toError(cause);
  }
  snapshots.sort((left, right) => right.savedAt - left.savedAt);
  return { snapshots, error };
};

// Raw download remains available even when migration or IndexedDB cannot read
// the workspace. This function never adopts or writes any recovery copy.
export const listWorkspaceRecoveryFiles = (): WorkspaceRecoveryFile[] => {
  const files: WorkspaceRecoveryFile[] = [];
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    for (const id of keys) {
      if (!id || (!id.startsWith(FALLBACK_SNAPSHOT_PREFIX) && ![FALLBACK_KEY, LEGACY_FALLBACK_KEY].includes(id))) continue;
      const raw = localStorage.getItem(id);
      if (!raw) continue;
      let content = raw;
      if (id.startsWith(FALLBACK_SNAPSHOT_PREFIX)) {
        try { const envelope = JSON.parse(raw); if (envelope.workspace) content = JSON.stringify(envelope.workspace, null, 2); } catch { /* Preserve the complete original file. */ }
      }
      files.push({ id, content });
    }
  } catch { /* Existing download entries remain usable. */ }
  return files;
};

export const listWorkspaceRecoverySnapshots = (current?: Workspace | null): WorkspaceRecoverySnapshot[] =>
  readFallbackSnapshots().snapshots
    .filter((snapshot) => !current || !sameWorkspace(snapshot.workspace, current))
    .map(({ id, workspace, savedAt, baseRevision }) => ({ id, workspace, savedAt, baseRevision }));

export const attachmentRecoveryRoots = async (): Promise<Workspace[]> => {
  const result = readFallbackSnapshots();
  if (result.error) throw result.error;
  const original = await loadPreAttachmentWorkspace();
  return [...result.snapshots.map((snapshot) => snapshot.workspace), ...(original ? [original] : [])];
};

const removeFallbackSnapshot = (snapshot: FallbackSnapshot) => {
  try {
    if (localStorage.getItem(snapshot.id) !== snapshot.raw) return false;
    if (snapshot.metaKey && localStorage.getItem(snapshot.metaKey) !== snapshot.rawMeta) return false;
    localStorage.removeItem(snapshot.id);
    if (snapshot.metaKey) localStorage.removeItem(snapshot.metaKey);
    if (ownFallback?.id === snapshot.id) ownFallback = null;
    if (adoptedFallback?.id === snapshot.id) adoptedFallback = null;
    return true;
  } catch {
    return false;
  }
};

// Used only after the user downloads and confirms deleting this exact copy.
export const discardWorkspaceRecoverySnapshot = (selected: WorkspaceRecoverySnapshot) => {
  const snapshot = readFallbackSnapshots().snapshots.find((item) => item.id === selected.id);
  return Boolean(snapshot && snapshot.savedAt === selected.savedAt &&
    sameWorkspace(snapshot.workspace, selected.workspace) && removeFallbackSnapshot(snapshot));
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
      // Only saves already queued when this snapshot was created may be its
      // ancestors. Newer requests, even from this page, must not be rolled back.
      return snapshot.writer !== null && snapshot.writer === stored.writer &&
        (snapshot.pendingSaveIds === undefined ||
          (stored.saveId !== null && snapshot.pendingSaveIds.includes(stored.saveId)));
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

const newerFallback = (snapshots: FallbackSnapshot[], meta: StoredMeta, workspace: Workspace) => {
  const eligible = snapshots.filter((snapshot) => snapshotIsNewer(snapshot, meta, workspace));
  // Several distinct pending copies need a user choice, even with the same base.
  return new Set(eligible.map((snapshot) => workspaceSignature(snapshot.workspace))).size === 1
    ? eligible[0]
    : undefined;
};

const readWorkspace = async ({ includeFallback = true } = {}): Promise<ReadResult> => {
  if (!indexedDbFactory()) {
    // Without IndexedDB the localStorage snapshot is the only copy, so loading
    // it cannot put an older copy on top of a newer database.
    const { snapshots, error } = includeFallback ? readFallbackSnapshots() : { snapshots: [] };
    const fallback = snapshots[0];
    if (fallback) {
      return {
        status: "loaded",
        workspace: fallback.workspace,
        source: "localstorage",
        revision: fallback.baseRevision,
        persisted: false,
        snapshot: fallback,
      };
    }
    if (error) return { status: "error", error, source: "localstorage" };
    return { status: "error", source: "indexeddb", error: new Error("当前环境无法使用 IndexedDB") };
  }

  const current = await readDatabase(DB_NAME);
  if (current.status === "error") {
    // Do not fall back to the legacy database or a localStorage snapshot here:
    // autosave would then write that older copy over the unreadable database.
    return { status: "error", source: "indexeddb", error: current.error };
  }

  const { snapshots, error } = includeFallback ? readFallbackSnapshots() : { snapshots: [] };
  if (current.status === "loaded") {
    const fallback = newerFallback(snapshots, current.meta, current.workspace);
    if (fallback) {
      return {
        status: "loaded",
        workspace: fallback.workspace,
        source: "localstorage",
        revision: current.meta.revision,
        persisted: false,
        snapshot: fallback,
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
    const fallback = newerFallback(snapshots, legacyMeta, legacy.workspace);
    return {
      status: "loaded",
      workspace: fallback ? fallback.workspace : legacy.workspace,
      source: fallback ? "localstorage" : "indexeddb",
      revision: current.meta.revision,
      persisted: false,
      snapshot: fallback,
    };
  }
  const fallback = snapshots[0];
  if (fallback) {
    return {
      status: "loaded",
      workspace: fallback.workspace,
      source: "localstorage",
      revision: current.meta.revision,
      persisted: false,
      snapshot: fallback,
    };
  }
  if (error) return { status: "error", error, source: "localstorage" };
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
    adoptedFallback = null;
    return { status: "empty" };
  }
  persistedWorkspace = result.persisted ? result.workspace : null;
  if (result.persisted && result.revision !== null) savedRevisions.set(result.workspace, result.revision);
  adoptedFallback = result.snapshot ?? null;
  return { status: "loaded", workspace: result.workspace, source: result.source };
};

const settledWrites = () => writeQueue.then(() => undefined, () => undefined);

export const loadWorkspace = async (options: { includeFallback?: boolean } = {}): Promise<WorkspaceLoadResult> => {
  await settledWrites();
  return adopt(await readWorkspace(options));
};

// Reloads the stored workspace (after another page saved) if canApply() still
// allows it once the read finishes, i.e. the page has no unsaved edits by then.
export const reloadWorkspaceIf = async (canApply: () => boolean): Promise<Workspace | null> => {
  await settledWrites();
  const result = await readWorkspace({ includeFallback: false });
  if (result.status !== "loaded" || !canApply()) return null;
  adopt(result);
  return result.workspace;
};

// True when the workspace object is exactly what this page last loaded from or
// wrote to IndexedDB, i.e. it has no unsaved edits.
export const isWorkspacePersisted = (workspace: Workspace | null | undefined) =>
  Boolean(workspace) && workspace === persistedWorkspace;

const clearSavedFallbacks = (workspace: Workspace) => {
  if (ownFallback && sameWorkspace(ownFallback.workspace, workspace)) {
    removeFallbackSnapshot(ownFallback);
  }
  if (adoptedFallback && sameWorkspace(adoptedFallback.workspace, workspace)) {
    removeFallbackSnapshot(adoptedFallback);
  }
  // Immutable copies of exactly the committed contents are safe to remove,
  // including duplicates left when a recovery itself used fallback storage.
  for (const snapshot of readFallbackSnapshots().snapshots) {
    if (snapshot.id.startsWith(FALLBACK_SNAPSHOT_PREFIX) && sameWorkspace(snapshot.workspace, workspace)) {
      removeFallbackSnapshot(snapshot);
    }
  }
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
  sequence: number,
  saveId: string,
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
          result = { status: "unchanged", revision: stored.revision };
          return;
        }
        const revision = stored.revision + 1;
        const commit = (previous?: Workspace) => {
          try {
            if (previous?.version === 1 && workspace.version === 2) {
              store.put(previous, PRE_ATTACHMENT_KEY);
            }
            store.put(workspace, WORKSPACE_KEY);
            store.put({ savedAt: new Date().toISOString(), revision, writer: pageId, saveId }, WORKSPACE_META_KEY);
            result = { status: "saved", revision };
          } catch (error) {
            failure = error;
            tx.abort();
          }
        };
        if (workspace.version === 2) {
          const previousRequest = store.get(WORKSPACE_KEY);
          previousRequest.onsuccess = () => commit(previousRequest.result);
        } else commit();
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
    if (epoch !== adoptEpoch) {
      return { ok: false, conflict: true, error: new Error(SUPERSEDED_MESSAGE) };
    }
    // A newer edit was snapshotted while this older save was waiting. Keep it.
    if (ownFallback && ownFallbackSequence > sequence) {
      return { ok: false, conflict: true, error: new Error(SUPERSEDED_MESSAGE) };
    }
    const fallback = writeFallback(workspace, sequence);
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
    clearSavedFallbacks(workspace);
    broadcastSaved(outcome.revision);
  }
  savedRevisions.set(workspace, outcome.revision);
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
  try {
    assertWorkspaceBudget(workspace);
    workspaceAttachmentAssets(workspace);
    if (workspaceFormatVersion(workspace) !== workspace.version) throw new Error("附件工作区需要先升级到 version 2");
  }
  catch (error) { return Promise.resolve({ ok: false, error: toError(error) }); }
  const epoch = adoptEpoch;
  const sequence = ++saveSequence;
  const saveId = uuid();
  pendingSaveIds.add(saveId);
  const run = (): Promise<WorkspaceSaveResult> => {
    if (epoch !== adoptEpoch) {
      return Promise.resolve({ ok: false, conflict: true, error: new Error(SUPERSEDED_MESSAGE) });
    }
    return writeWorkspace(workspace, options.overwrite === true, epoch, sequence, saveId);
  };
  const result = writeQueue.then(run, run).finally(() => pendingSaveIds.delete(saveId));
  writeQueue = result;
  return result;
};

// Synchronous last-resort copy, used while the page unloads and when IndexedDB
// fails. It records which stored revision it is based on, so it can never win
// over data another page saved later.
const writeFallback = (workspace: Workspace, sequence: number): WorkspaceSaveResult => {
  try {
    if (workspace.version === 2 && persistedWorkspace?.version === 1) {
      localStorage.setItem(PRE_ATTACHMENT_FALLBACK_KEY, JSON.stringify(persistedWorkspace));
    }
    const savedAt = new Date(Math.max(Date.now(), workspaceUpdatedAt(workspace) + 1)).toISOString();
    const id = `${FALLBACK_SNAPSHOT_PREFIX}${pageId}:${uuid()}`;
    const pending = [...pendingSaveIds];
    const raw = JSON.stringify({ workspace, savedAt, baseRevision: knownRevision, writer: pageId, pendingSaveIds: pending });
    localStorage.setItem(id, raw);
    const previous = ownFallback;
    ownFallback = { status: "loaded", id, raw, workspace, savedAt: timestamp(savedAt), baseRevision: knownRevision, writer: pageId, pendingSaveIds: pending };
    ownFallbackSequence = sequence;
    if (previous) removeFallbackSnapshot(previous);
    return { ok: true, target: "localstorage" };
  } catch (error) {
    return {
      ok: false,
      error: toError(error),
    };
  }
};

export const saveWorkspaceFallback = (workspace: Workspace): WorkspaceSaveResult =>
  writeFallback(workspace, ++saveSequence);

export const loadPreAttachmentWorkspace = async (): Promise<Workspace | null> => {
  let db: IDBDatabase | null = null;
  let stored: unknown;
  let failure: unknown;
  try {
    const activeDb = await openDb();
    db = activeDb;
    stored = await new Promise<unknown>((resolve, reject) => {
      const tx = activeDb.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(PRE_ATTACHMENT_KEY);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (error) { failure = error; }
  finally { db?.close(); }
  if (!stored) {
    const raw = localStorage.getItem(PRE_ATTACHMENT_FALLBACK_KEY);
    if (raw) stored = JSON.parse(raw);
  }
  if (!stored && failure) throw toError(failure);
  if (!stored) return null;
  const workspace = migrateWorkspace(stored);
  if (workspace.version !== 1) throw new Error("升级前副本格式无效，原记录已保留");
  return workspace;
};
