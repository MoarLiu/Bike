import type { Workspace } from "./types";
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

export type WorkspaceLoadResult =
  | { status: "loaded"; workspace: Workspace; source: "indexeddb" | "localstorage" }
  | { status: "empty" }
  | { status: "error"; error: Error; source?: "indexeddb" | "localstorage" };

export type WorkspaceSaveResult =
  | { ok: true; target: "indexeddb" | "localstorage" }
  | { ok: false; error: Error };

const toError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

const timestamp = (value: string | undefined) => {
  const time = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(time) ? time : 0;
};

const workspaceUpdatedAt = (workspace: Workspace) =>
  Math.max(0, ...workspace.documents.map((document) => timestamp(document.updatedAt)));

const fallbackSavedAt = (metaKey = FALLBACK_META_KEY) => {
  try {
    const raw = localStorage.getItem(metaKey);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { savedAt?: unknown };
    return typeof parsed.savedAt === "string" ? timestamp(parsed.savedAt) : 0;
  } catch {
    return 0;
  }
};

const savedAtFromMeta = (value: unknown) => {
  if (!value || typeof value !== "object") return 0;
  const savedAt = (value as { savedAt?: unknown }).savedAt;
  return typeof savedAt === "string" ? timestamp(savedAt) : 0;
};

const readFallbackWorkspace = (
  workspaceKey = FALLBACK_KEY,
): WorkspaceLoadResult => {
  try {
    const raw = localStorage.getItem(workspaceKey);
    if (!raw) return { status: "empty" };
    return {
      status: "loaded",
      source: "localstorage",
      workspace: migrateWorkspace(JSON.parse(raw)),
    };
  } catch (error) {
    return { status: "error", source: "localstorage", error: toError(error) };
  }
};

const readBestFallbackWorkspace = (): WorkspaceLoadResult => {
  const current = readFallbackWorkspace();
  const legacy = readFallbackWorkspace(LEGACY_FALLBACK_KEY);
  if (current.status === "loaded" && legacy.status === "loaded") {
    return fallbackSavedAt() >= fallbackSavedAt(LEGACY_FALLBACK_META_KEY)
      ? current
      : legacy;
  }
  if (current.status !== "empty") return current;
  return legacy;
};

const openDb = (dbName = DB_NAME) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const loadWorkspaceFromDb = async (dbName: string): Promise<WorkspaceLoadResult> => {
  let db: IDBDatabase;
  try {
    db = await openDb(dbName);
  } catch (error) {
    return { status: "error", source: "indexeddb", error: toError(error) };
  }

  try {
    return await new Promise<WorkspaceLoadResult>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(WORKSPACE_KEY);
      const metaRequest = store.get(WORKSPACE_META_KEY);
      tx.oncomplete = () => {
        if (!request.result) {
          resolve({ status: "empty" });
          return;
        }
        try {
          const workspace = migrateWorkspace(request.result);
          const fallback = readBestFallbackWorkspace();
          const indexedDbSavedAt = savedAtFromMeta(metaRequest.result) || workspaceUpdatedAt(workspace);
          if (
            fallback.status === "loaded" &&
            Math.max(fallbackSavedAt(), fallbackSavedAt(LEGACY_FALLBACK_META_KEY)) > indexedDbSavedAt
          ) {
            resolve(fallback);
            return;
          }
          resolve({
            status: "loaded",
            source: "indexeddb",
            workspace,
          });
        } catch (error) {
          resolve({ status: "error", source: "indexeddb", error: toError(error) });
        }
      };
      tx.onerror = () => reject(tx.error ?? request.error ?? metaRequest.error);
    });
  } catch (error) {
    return { status: "error", source: "indexeddb", error: toError(error) };
  } finally {
    db.close();
  }
};

export const loadWorkspace = async (): Promise<WorkspaceLoadResult> => {
  const current = await loadWorkspaceFromDb(DB_NAME);
  if (current.status === "loaded") return current;

  const legacy = await loadWorkspaceFromDb(LEGACY_DB_NAME);
  if (legacy.status === "loaded") return legacy;

  const fallback = readBestFallbackWorkspace();
  if (fallback.status !== "empty") return fallback;

  if (current.status === "error") return current;
  if (legacy.status === "error") return legacy;
  return { status: "empty" };
};

export const saveWorkspace = async (workspace: Workspace): Promise<WorkspaceSaveResult> => {
  let db: IDBDatabase | null = null;
  try {
    const activeDb = await openDb();
    db = activeDb;
    await new Promise<void>((resolve, reject) => {
      const tx = activeDb.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(workspace, WORKSPACE_KEY);
      tx.objectStore(STORE_NAME).put({ savedAt: new Date().toISOString() }, WORKSPACE_META_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    try {
      localStorage.removeItem(FALLBACK_KEY);
      localStorage.removeItem(FALLBACK_META_KEY);
      localStorage.removeItem(LEGACY_FALLBACK_KEY);
      localStorage.removeItem(LEGACY_FALLBACK_META_KEY);
    } catch {}
    return { ok: true, target: "indexeddb" };
  } catch (indexedDbError) {
    const fallback = saveWorkspaceFallback(workspace);
    if (fallback.ok) return fallback;
    const localStorageError = fallback.error;
    return {
      ok: false,
      error: new Error(
        `IndexedDB 保存失败：${toError(indexedDbError).message}；localStorage 备份也失败：${toError(localStorageError).message}`,
      ),
    };
  } finally {
    db?.close();
  }
};

export const saveWorkspaceFallback = (workspace: Workspace): WorkspaceSaveResult => {
  try {
    const savedAt = new Date(Math.max(Date.now(), workspaceUpdatedAt(workspace) + 1)).toISOString();
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(workspace));
    localStorage.setItem(FALLBACK_META_KEY, JSON.stringify({ savedAt }));
    return { ok: true, target: "localstorage" };
  } catch (error) {
    return {
      ok: false,
      error: toError(error),
    };
  }
};
