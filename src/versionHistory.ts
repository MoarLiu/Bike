import type { OutlineDocument, OutlineNode } from "./types";
import { countNodes } from "./tree";
import { documentSignature } from "./documentSignature";
import { migrateDocument } from "./migrations";
import { uuid } from "./id";
import { workspaceAttachmentAssets } from "../shared/bike-attachments.mjs";

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

const snapshotKey = (documentId: string) => `document:${documentId}`;

const readSnapshots = (value: unknown, documentId: string): DocumentSnapshot[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("版本历史数据损坏，已保留原始记录");
  return value.map((raw: unknown) => {
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
    return {
      ...snapshot,
      document,
      signature: documentSignature(document),
      size: new TextEncoder().encode(JSON.stringify(snapshot)).byteLength,
    };
  });
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
      const cursor = tx.objectStore(STORE_NAME).openCursor();
      let failure: unknown;
      cursor.onsuccess = () => {
        try {
          const item = cursor.result;
          if (!item) return;
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
    if (retained.length && total + item.size > MAX_TOTAL_SIZE) break;
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
      tx.oncomplete = () => {
        try {
          resolve(readSnapshots(request.result, documentId));
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
      let written: DocumentSnapshot[] = [];
      request.onsuccess = () => {
        try {
          written = appendSnapshot(readSnapshots(request.result, document.id), snapshot);
          store.put(written, key);
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
