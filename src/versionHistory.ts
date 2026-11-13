import type { OutlineDocument, OutlineNode } from "./types";
import { countNodes } from "./tree";
import { documentSignature } from "./documentSignature";
import { migrateDocument } from "./migrations";
import { uuid } from "./id";
import { workspaceAttachmentAssets } from "../shared/bike-attachments.mjs";
import { localMigrationDigest } from "../shared/bike-local-migration.mjs";
import type { LocalMigrationHistory } from "../shared/bike-local-migration.mjs";

export type SnapshotReason = "auto" | "manual" | "before-restore" | "sync";

export interface DocumentSnapshot {
  id: string;
  documentId: string;
  title: string;
  createdAt: string;
  reason: SnapshotReason;
  nodeCount: number;
  signature: string;
  size: number;
  document: OutlineDocument;
}

export interface SnapshotDiff {
  added: number;
  removed: number;
  changed: number;
}

const DB_NAME = "bike-history-db";
const STORE_NAME = "snapshots";
const MAX_SNAPSHOTS = 50;
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_TOTAL_SIZE = 20 * 1024 * 1024;
export const MAX_HISTORY_SIZE = 128 * 1024 * 1024;
const INDEX_KEY = "history-retention-index-v1";
type HistoryIndex = Record<string, Array<{ id: string; createdAt: string; size: number }>>;
const historyWarnings = new Map<string, string>();
export const getHistoryWarning = (documentId: string) => historyWarnings.get(documentId) ?? "";
const MIGRATION_KEY = "bike-full-copy-history-import";
const migrationHistoryDigest = (rows: LocalMigrationHistory[]) => localMigrationDigest(rows.map((row) => ({
  ...row, snapshots: row.snapshots.map(({ size: _size, ...snapshot }) => snapshot),
})));
export interface HistoryMigrationJournal {
  id: string; archiveId: string; before: LocalMigrationHistory[]; after: LocalMigrationHistory[];
}
const pendingMigrationError = () => new Error("版本历史正在安装本机副本，请先完成或恢复导入");

const snapshotKey = (documentId: string) => `document:${documentId}`;

const readSnapshots = (value: unknown, documentId: string, tolerant = false): DocumentSnapshot[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("版本历史数据损坏，已保留原始记录");
  let invalid = 0;
  const snapshots = value.flatMap((raw: unknown) => {
    try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("版本历史数据损坏，已保留原始记录");
    }
    const snapshot = raw as DocumentSnapshot;
    if (
      typeof snapshot.id !== "string" || !snapshot.id ||
      snapshot.documentId !== documentId ||
      !Number.isFinite(Date.parse(snapshot.createdAt)) ||
      !["auto", "manual", "before-restore", "sync"].includes(snapshot.reason) ||
      !snapshot.document || snapshot.document.id !== documentId ||
      !Array.isArray(snapshot.document.nodes)
    ) throw new Error("版本历史数据损坏，已保留原始记录");
    const document = migrateDocument(snapshot.document);
    return [{
      ...snapshot,
      document,
      signature: documentSignature(document),
      size: new TextEncoder().encode(JSON.stringify(snapshot)).byteLength,
    }];
    } catch (error) {
      if (!tolerant) throw error;
      invalid++;
      return [];
    }
  });
  if (tolerant) {
    if (invalid) historyWarnings.set(documentId, `${invalid} 条损坏快照已隔离显示，原始记录仍保留；可继续使用其余历史`);
    else historyWarnings.delete(documentId);
  }
  return snapshots;
};

export const retainGlobalHistory = (index: HistoryIndex): HistoryIndex => {
  const entries = Object.entries(index).flatMap(([documentId, snapshots]) => snapshots.map(snapshot => ({ documentId, ...snapshot })));
  entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  const retained: HistoryIndex = Object.fromEntries(Object.keys(index).map(id => [id, []]));
  let size = 0;
  for (const entry of entries) {
    if (size + entry.size > MAX_HISTORY_SIZE) continue;
    retained[entry.documentId].push({ id: entry.id, createdAt: entry.createdAt, size: entry.size });
    size += entry.size;
  }
  return retained;
};

const openDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined" || !indexedDB) {
      reject(new Error("当前环境无法使用 IndexedDB"));
      return;
    }
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

export const listHistoryAttachmentIds = async (): Promise<string[]> => {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const ids = new Set<string>();
      const tx = db.transaction(STORE_NAME, "readonly");
      const migration = tx.objectStore(STORE_NAME).get(MIGRATION_KEY);
      const cursor = tx.objectStore(STORE_NAME).openCursor();
      let failure: unknown;
      cursor.onsuccess = () => {
        try {
          const item = cursor.result;
          if (!item) return;
          if (migration.result) throw pendingMigrationError();
          if (item.key === MIGRATION_KEY || item.key === INDEX_KEY) { item.continue(); return; }
          if (typeof item.key !== "string" || !item.key.startsWith("document:")) throw new Error("历史记录键无效");
          for (const snapshot of readSnapshots(item.value, item.key.slice(9))) {
            for (const asset of workspaceAttachmentAssets({ documents: [snapshot.document] })) ids.add(asset.assetId);
          }
          if (ids.size > 100_000) throw new Error("历史附件保护清单超过扫描预算");
          item.continue();
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve([...ids]);
      tx.onerror = () => reject(failure ?? tx.error);
      tx.onabort = () => reject(failure ?? tx.error);
    });
  } finally { db.close(); }
};

export const createSnapshot = (
  document: OutlineDocument,
  reason: SnapshotReason,
  at = new Date().toISOString(),
): DocumentSnapshot => {
  const snapshot: DocumentSnapshot = {
  id: `snapshot_${uuid()}`,
  documentId: document.id,
  title: document.title,
  createdAt: at,
  reason,
  nodeCount: countNodes(document.nodes),
  signature: documentSignature(document),
  size: 0,
  document,
  };
  snapshot.size = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  return snapshot;
};

export const appendSnapshot = (
  snapshots: DocumentSnapshot[],
  snapshot: DocumentSnapshot,
  at: number = Date.now(),
): DocumentSnapshot[] => {
  const next = (snapshots[0]?.signature === snapshot.signature
    ? snapshots
    : [snapshot, ...snapshots]).slice(0, MAX_SNAPSHOTS);
  const recent = next.slice(0, 3);
  const byAge = next.filter((item) => {
    const created = Date.parse(item.createdAt);
    return Number.isFinite(created) && at - created < MAX_AGE_MS;
  });
  const keepIds = new Set([
    ...recent.map((item) => item.id),
    ...byAge.map((item) => item.id),
  ]);
  const byAgeOrRecent = next.filter((item) => keepIds.has(item.id));
  const retained: DocumentSnapshot[] = [];
  let total = 0;
  for (const item of byAgeOrRecent) {
    if (retained.length && total + item.size > MAX_TOTAL_SIZE) continue;
    retained.push(item);
    total += item.size;
  }
  return retained;
};

export const listDocumentSnapshots = async (
  documentId: string,
): Promise<DocumentSnapshot[]> => {
  const db = await openDb();
  try {
    return await new Promise<DocumentSnapshot[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(snapshotKey(documentId));
      const migration = tx.objectStore(STORE_NAME).get(MIGRATION_KEY);
      tx.oncomplete = () => {
        try {
          if (migration.result) throw pendingMigrationError();
          resolve(readSnapshots(request.result, documentId, true));
        } catch (error) {
          reject(error);
        }
      };
      tx.onerror = () => reject(tx.error ?? request.error);
      tx.onabort = () => reject(tx.error ?? new Error("版本历史读取被中止"));
    });
  } finally {
    db.close();
  }
};

export const captureSnapshot = async (
  document: OutlineDocument,
  reason: SnapshotReason,
): Promise<DocumentSnapshot[]> => {
  const db = await openDb();
  try {
    const snapshot = createSnapshot(document, reason);
    return await new Promise<DocumentSnapshot[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const key = snapshotKey(document.id);
      const request = store.get(key);
      const migration = store.get(MIGRATION_KEY);
      const budget = store.get(INDEX_KEY);
      let written: DocumentSnapshot[] = [];
      budget.onsuccess = () => {
        try {
          if (migration.result) throw pendingMigrationError();
          const previous = readSnapshots(request.result, document.id, true);
          written = appendSnapshot(previous, snapshot);
          const invalid = (Array.isArray(request.result) ? request.result : []).filter((item: unknown) => {
            try { readSnapshots([item], document.id); return false; } catch { return true; }
          });
          const applyBudget = (index: HistoryIndex) => {
            Object.defineProperty(index, document.id, { value: written.map(({ id, createdAt, size }) => ({ id, createdAt, size })), enumerable: true, writable: true, configurable: true });
            const retained = retainGlobalHistory(index);
            const allowed = new Set(retained[document.id].map(item => item.id));
            written = written.filter(item => allowed.has(item.id));
            store.put([...written, ...invalid], key);
            for (const [documentId, metadata] of Object.entries(index)) {
              if (documentId === document.id || retained[documentId].length === metadata.length) continue;
              const read = store.get(snapshotKey(documentId));
              const keep = new Set(retained[documentId].map(item => item.id));
              read.onsuccess = () => {
                try {
                  const valid = new Set(readSnapshots(read.result, documentId, true).map(item => item.id));
                  store.put(read.result.filter((item: DocumentSnapshot) => !item || !valid.has(item.id) || keep.has(item.id)), snapshotKey(documentId));
                } catch (error) { tx.abort(); reject(error); }
              };
            }
            store.put(retained, INDEX_KEY);
          };
          if (budget.result && typeof budget.result === "object" && !Array.isArray(budget.result) &&
              Object.values(budget.result).every(rows => Array.isArray(rows) && rows.every(item =>
                item && typeof item.id === "string" && Number.isFinite(Date.parse(item.createdAt)) && Number.isSafeInteger(item.size) && item.size >= 0))) applyBudget(budget.result);
          else {
            const index: HistoryIndex = Object.create(null);
            const cursor = store.openCursor();
            cursor.onsuccess = () => {
              try {
                const row = cursor.result;
                if (!row) { applyBudget(index); return; }
                if (typeof row.key === "string" && row.key.startsWith("document:")) {
                  const id = row.key.slice(9);
                  // Whole corrupt rows stay intact and do not block other documents.
                  if (Array.isArray(row.value)) index[id] = readSnapshots(row.value, id, true).map(({ id, createdAt, size }) => ({ id, createdAt, size }));
                }
                row.continue();
              } catch (error) { tx.abort(); reject(error); }
            };
          }
        } catch (error) {
          tx.abort();
          reject(error);
        }
      };
      tx.oncomplete = () => resolve(written);
      tx.onerror = () => reject(tx.error ?? request.error);
      tx.onabort = () => reject(tx.error ?? new Error("版本历史写入被中止"));
    });
  } finally {
    db.close();
  }
};

export const normalizeMigrationHistory = (rows: LocalMigrationHistory[]): LocalMigrationHistory[] => {
  if (!Array.isArray(rows)) throw new Error("完整本机副本缺少版本历史");
  const ids = new Set<string>();
  return rows.map((row) => {
    if (!row || typeof row.documentId !== "string" || !row.documentId || ids.has(row.documentId)) throw new Error("版本历史文档身份无效或重复");
    ids.add(row.documentId);
    const snapshots = readSnapshots(row.snapshots, row.documentId);
    if (new Set(snapshots.map((snapshot) => snapshot.id)).size !== snapshots.length) throw new Error("版本快照身份重复");
    return { documentId: row.documentId, snapshots };
  }).sort((left, right) => left.documentId.localeCompare(right.documentId));
};

// All document keys are enumerated, including history for documents that have
// already left both the live workspace and trash.
const historyTransaction = async (
  mode: IDBTransactionMode,
  action: (rows: LocalMigrationHistory[], journal: HistoryMigrationJournal | null, store: IDBObjectStore) => void,
): Promise<{ rows: LocalMigrationHistory[]; journal: HistoryMigrationJournal | null }> => {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      const marker = store.get(MIGRATION_KEY);
      const cursor = store.openCursor();
      const rows: LocalMigrationHistory[] = [];
      let failure: unknown;
      cursor.onsuccess = () => {
        try {
          const item = cursor.result;
          if (!item) {
            rows.sort((left, right) => left.documentId.localeCompare(right.documentId));
            if (mode === "readwrite") store.put(null, INDEX_KEY);
            action(rows, marker.result ?? null, store);
            return;
          }
          if (item.key !== MIGRATION_KEY && item.key !== INDEX_KEY) {
            if (typeof item.key !== "string" || !item.key.startsWith("document:")) throw new Error("版本历史包含未知记录，原数据已保留");
            const documentId = item.key.slice(9);
            const snapshots = readSnapshots(item.value, documentId);
            if (snapshots.length) rows.push({ documentId, snapshots });
          }
          item.continue();
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve({ rows, journal: marker.result ?? null });
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("版本历史导入事务已中止"));
      tx.onerror = () => reject(failure ?? tx.error);
    });
  } finally { db.close(); }
};
export const listAllDocumentSnapshots = async (): Promise<LocalMigrationHistory[]> =>
  (await historyTransaction("readonly", (_rows, journal) => { if (journal) throw pendingMigrationError(); })).rows;
export const readHistoryMigrationJournal = async (): Promise<HistoryMigrationJournal | null> => {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(MIGRATION_KEY);
      tx.oncomplete = () => resolve(request.result ?? null);
      tx.onabort = () => reject(tx.error ?? new Error("导入历史日志读取失败"));
      tx.onerror = () => reject(tx.error ?? request.error);
    });
  } finally { db.close(); }
};

export const installMigrationHistory = async (
  id: string, archiveId: string, expected: LocalMigrationHistory[], imported: LocalMigrationHistory[],
) => {
  const incoming = normalizeMigrationHistory(imported);
  await historyTransaction("readwrite", (rows, journal, store) => {
    if (journal) throw pendingMigrationError();
    if (migrationHistoryDigest(rows) !== migrationHistoryDigest(expected)) throw new Error("版本历史在导入期间变化，请重新导入");
    const byId = new Map(rows.map((row) => [row.documentId, row]));
    const before = [...rows];
    for (const row of incoming) {
      const current = byId.get(row.documentId);
      const snapshots = new Map((current?.snapshots ?? []).map((snapshot) => [snapshot.id, snapshot]));
      if (!current) before.push({ documentId: row.documentId, snapshots: [] });
      for (const snapshot of row.snapshots) {
        const existing = snapshots.get(snapshot.id);
        if (existing && localMigrationDigest({ ...existing, size: 0 }) !== localMigrationDigest({ ...snapshot, size: 0 }))
          throw new Error("相同版本快照身份具有不同内容，已停止导入");
        snapshots.set(snapshot.id, snapshot);
      }
      byId.set(row.documentId, { documentId: row.documentId, snapshots: [...snapshots.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)) });
    }
    const after = [...byId.values()].sort((left, right) => left.documentId.localeCompare(right.documentId));
    store.put({ id, archiveId, before, after } satisfies HistoryMigrationJournal, MIGRATION_KEY);
    for (const row of after) store.put(row.snapshots, snapshotKey(row.documentId));
  });
};

export const finishMigrationHistory = async (id: string, rollback: boolean) => {
  await historyTransaction("readwrite", (rows, journal, store) => {
    if (!journal) return;
    if (journal.id !== id) throw new Error("另一版本历史导入会话尚未完成");
    if (migrationHistoryDigest(rows) !== migrationHistoryDigest(journal.after.filter((row) => row.snapshots.length)))
      throw new Error("导入历史已被外部改变，已保留日志等待恢复");
    if (rollback) for (const row of journal.before) store.put(row.snapshots, snapshotKey(row.documentId));
    store.put(null, MIGRATION_KEY);
  });
};

const nodeIndex = (
  nodes: OutlineNode[],
  parentId: string | null = null,
  index = new Map<string, string>(),
) => {
  nodes.forEach((node, position) => {
    const { children, ...fields } = node;
    index.set(node.id, JSON.stringify({ fields, parentId, position }));
    nodeIndex(children, node.id, index);
  });
  return index;
};

export const diffDocuments = (
  current: OutlineDocument,
  snapshot: OutlineDocument,
): SnapshotDiff => {
  const currentIndex = nodeIndex(current.nodes);
  const snapshotIndex = nodeIndex(snapshot.nodes);
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [id, signature] of currentIndex) {
    const before = snapshotIndex.get(id);
    if (!before) added += 1;
    else if (before !== signature) changed += 1;
  }
  for (const id of snapshotIndex.keys()) {
    if (!currentIndex.has(id)) removed += 1;
  }
  return { added, removed, changed };
};

export const previewLines = (
  nodes: OutlineNode[],
  limit = 120,
): { depth: number; text: string }[] => {
  const lines: { depth: number; text: string }[] = [];
  const walk = (items: OutlineNode[], depth: number) => {
    for (const node of items) {
      if (lines.length >= limit) return;
      lines.push({ depth, text: node.text || "未命名主题" });
      walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return lines;
};
