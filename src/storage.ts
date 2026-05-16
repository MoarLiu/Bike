import type { Workspace } from "./types";

const DB_NAME = "local-outline-db";
const STORE_NAME = "workspace-store";
const WORKSPACE_KEY = "workspace";
const FALLBACK_KEY = "local-outline-workspace";

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

export const loadWorkspace = async (): Promise<Workspace | null> => {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(WORKSPACE_KEY);
      request.onsuccess = () => resolve((request.result as Workspace) ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    const raw = localStorage.getItem(FALLBACK_KEY);
    return raw ? (JSON.parse(raw) as Workspace) : null;
  }
};

export const saveWorkspace = async (workspace: Workspace) => {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(workspace, WORKSPACE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(workspace));
  }
};
