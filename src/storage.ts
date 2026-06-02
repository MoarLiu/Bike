import type { Workspace } from "./types";
import { migrateWorkspace } from "./migrations";

const DB_NAME = "local-outline-db";
const STORE_NAME = "workspace-store";
const WORKSPACE_KEY = "workspace";
const FALLBACK_KEY = "local-outline-workspace";
const FALLBACK_META_KEY = "local-outline-workspace-meta";

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

const fallbackSavedAt = () => {
  try {
    const raw = localStorage.getItem(FALLBACK_META_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { savedAt?: unknown };
    return typeof parsed.savedAt === "string" ? timestamp(parsed.savedAt) : 0;
  } catch {
    return 0;
  }
};

const readFallbackWorkspace = (): WorkspaceLoadResult => {
  try {
    const raw = localStorage.getItem(FALLBACK_KEY);
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

const openDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export const loadWorkspace = async (): Promise<WorkspaceLoadResult> => {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch (error) {
    const fallback = readFallbackWorkspace();
    if (fallback.status !== "empty") return fallback;
    return { status: "error", source: "indexeddb", error: toError(error) };
  }

  try {
    return await new Promise<WorkspaceLoadResult>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(WORKSPACE_KEY);
      request.onsuccess = () => {
        if (!request.result) {
          resolve(readFallbackWorkspace());
          return;
        }
        try {
          const workspace = migrateWorkspace(request.result);
          const fallback = readFallbackWorkspace();
          if (
            fallback.status === "loaded" &&
            fallbackSavedAt() > workspaceUpdatedAt(workspace)
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
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    const fallback = readFallbackWorkspace();
    if (fallback.status !== "empty") return fallback;
    return { status: "error", source: "indexeddb", error: toError(error) };
  }
};

export const saveWorkspace = async (workspace: Workspace): Promise<WorkspaceSaveResult> => {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(workspace, WORKSPACE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    try {
      localStorage.removeItem(FALLBACK_KEY);
      localStorage.removeItem(FALLBACK_META_KEY);
    } catch {}
    return { ok: true, target: "indexeddb" };
  } catch (indexedDbError) {
    try {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(workspace));
      localStorage.setItem(FALLBACK_META_KEY, JSON.stringify({ savedAt: new Date().toISOString() }));
      return { ok: true, target: "localstorage" };
    } catch (localStorageError) {
      return {
        ok: false,
        error: new Error(
          `IndexedDB 保存失败：${toError(indexedDbError).message}；localStorage 备份也失败：${toError(localStorageError).message}`,
        ),
      };
    }
  }
};
