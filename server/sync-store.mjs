import { createAssetStore } from './asset-store.mjs';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createOperationStore } from './operation-store.mjs';
import { mkdir, chmod, open } from "node:fs/promises";
import path from "node:path";
import { assertDocumentBudget, assertValueBudget } from "../shared/bike-limits.mjs";
import { validateDocumentAttachments } from "../shared/bike-attachments.mjs";

const singletonWorkspaceId = "default";
let DatabaseSync;

export class SyncConflictError extends Error {
  constructor(message, currentRevision) {
    super(message);
    this.name = "SyncConflictError";
    this.statusCode = 409;
    this.currentRevision = currentRevision;
  }
}

export class SyncNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "SyncNotFoundError";
    this.statusCode = 404;
  }
}

export class SyncValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SyncValidationError";
    this.statusCode = 400;
  }
}
export class SyncPayloadTooLargeError extends Error {
  constructor(maxBytes) { super(`请求体超过 ${Math.floor(maxBytes / 1024 / 1024)} MiB 上限`); this.name = "SyncPayloadTooLargeError"; this.statusCode = 413; this.maxBytes = maxBytes; }
}
export class SyncCapabilityError extends SyncValidationError {
  constructor() { super("此文档包含附件，请升级客户端后再写入"); this.statusCode = 426; }
}
export class SyncBusyError extends Error {
  constructor() { super("同步数据库暂时被占用，请稍后重试"); this.name = "SyncBusyError"; this.statusCode = 503; }
}

const now = () => new Date().toISOString();

const parseJson = (value, fallback) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const stringifyDocument = (document) => JSON.stringify(document);

const assertRecord = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyncValidationError(`${label} must be an object`);
  }
};

const normalizeExpectedRevision = (value) => {
  if (value === null || value === undefined) return null;
  if (Number.isInteger(value) && value >= 0) return value;
  throw new SyncValidationError("expectedRevision must be a non-negative integer or null");
};

const validateDocument = (id, document) => {
  assertRecord(document, "document");
  if (typeof document.id !== "string" || !document.id.trim()) {
    throw new SyncValidationError("document.id is required");
  }
  if (document.id !== id) {
    throw new SyncValidationError("document.id must match the request path");
  }
  if (typeof document.title !== "string" || !document.title.trim()) {
    throw new SyncValidationError("document.title is required");
  }
  if (!Array.isArray(document.nodes)) {
    throw new SyncValidationError("document.nodes must be an array");
  }
  try { assertDocumentBudget(document); validateDocumentAttachments(document); } catch (error) { throw new SyncValidationError(error.message); }
  return document;
};

const normalizeOperationSequence = (value) => {
  if (value === null || value === undefined || value === "") return 0;
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric) && numeric >= 0) return numeric;
  throw new SyncValidationError("after must be a non-negative integer");
};

const validateOperations = (operations) => {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new SyncValidationError("operations must be a non-empty array");
  }
  if (operations.length > 100) {
    throw new SyncValidationError("operations must contain at most 100 items");
  }
  return operations.map((operation) => {
    assertRecord(operation, "operation");
    if (typeof operation.type !== "string" || !operation.type.trim()) {
      throw new SyncValidationError("operation.type is required");
    }
    try { assertValueBudget(operation, { maxDepth: 64, maxBytes: 1024 * 1024 }); }
    catch (error) { throw new SyncValidationError(error.message); }
    return operation;
  });
};

const normalizeActorId = (value) => {
  const actorId = typeof value === "string" ? value.trim() : "";
  if (!actorId) throw new SyncValidationError("actorId is required");
  return actorId.slice(0, 120);
};

const rowToDocumentSummary = (row) => ({
  id: row.id,
  title: row.title,
  revision: row.revision,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at ?? null,
});

export const createSyncStore = async (databasePath, {
  busyTimeoutMs = 1500, assetQuotaBytes = Number(process.env.BIKE_ASSET_QUOTA_BYTES || 2 * 1024 * 1024 * 1024),
} = {}) => {
  if (!databasePath) {
    throw new Error("sync.databasePath is required");
  }
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 10_000) throw new Error("busyTimeoutMs 必须是 1 到 10000 的整数");
  if (!DatabaseSync) {
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch (error) {
      throw new Error(
        `Bike 同步服务需要 Node.js 22.13.0 或更新版本的 node:sqlite 支持：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (databasePath !== ":memory:") {
    await mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    const file = await open(databasePath, "a", 0o600);
    await file.close();
    await chmod(databasePath, 0o600);
  }

  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  if (databasePath !== ":memory:") {
    for (const suffix of ["-wal", "-shm"]) await chmod(`${databasePath}${suffix}`, 0o600).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_meta (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      active_document_id TEXT,
      document_order_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      document_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS document_operations (
      document_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      base_revision INTEGER NOT NULL,
      actor_id TEXT NOT NULL,
      operation_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (document_id, sequence),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS document_operations_document_sequence
      ON document_operations (document_id, sequence);
  `);

  const meta = db
    .prepare("SELECT id FROM workspace_meta WHERE id = ?")
    .get(singletonWorkspaceId);
  if (!meta) {
    db.prepare(`
      INSERT INTO workspace_meta (
        id,
        revision,
        active_document_id,
        document_order_json,
        updated_at
      ) VALUES (?, 0, NULL, ?, ?)
    `).run(singletonWorkspaceId, "[]", now());
  }

  const transaction = (callback) => {
    let started = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      started = true;
      const result = callback();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (started) try { db.exec("ROLLBACK"); } catch {}
      if (/database is (?:locked|busy)/iu.test(error.message)) throw new SyncBusyError();
      throw error;
    }
  };

  const readMeta = () => {
    const row = db
      .prepare("SELECT * FROM workspace_meta WHERE id = ?")
      .get(singletonWorkspaceId);
    return {
      revision: row.revision,
      activeDocumentId: row.active_document_id,
      documentOrder: parseJson(row.document_order_json, []),
      updatedAt: row.updated_at,
    };
  };

  const readDocumentSummaries = () =>
    db
      .prepare(`
        SELECT id, title, revision, updated_at, deleted_at
        FROM documents
        ORDER BY updated_at DESC, id ASC
      `)
      .all()
      .map(rowToDocumentSummary);

  const readNonDeletedIds = () =>
    db
      .prepare("SELECT id FROM documents WHERE deleted_at IS NULL ORDER BY updated_at DESC, id ASC")
      .all()
      .map((row) => row.id);

  const writeMeta = ({ revision, activeDocumentId, documentOrder, updatedAt }) => {
    db.prepare(`
      UPDATE workspace_meta
      SET revision = ?,
          active_document_id = ?,
          document_order_json = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      revision,
      activeDocumentId ?? null,
      JSON.stringify(documentOrder),
      updatedAt,
      singletonWorkspaceId,
    );
  };

  const normalizeOrder = (requestedOrder, activeDocumentId) => {
    const existingIds = readNonDeletedIds();
    const existing = new Set(existingIds);
    const order = [];
    const ordered = new Set();
    for (const id of Array.isArray(requestedOrder) ? requestedOrder : []) {
      if (typeof id === "string" && existing.has(id) && !ordered.has(id)) {
        order.push(id);
        ordered.add(id);
      }
    }
    for (const id of existingIds) {
      if (!ordered.has(id)) { order.push(id); ordered.add(id); }
    }
    const active = activeDocumentId && existing.has(activeDocumentId)
      ? activeDocumentId
      : order[0] ?? null;
    return { activeDocumentId: active, documentOrder: order };
  };

  const updateManifestForDocumentPresence = (documentId, present) => {
    const meta = readMeta();
    const order = meta.documentOrder.filter((id) => id !== documentId);
    if (present) order.push(documentId);
    const normalized = normalizeOrder(order, meta.activeDocumentId);
    writeMeta({
      revision: meta.revision + 1,
      activeDocumentId: normalized.activeDocumentId,
      documentOrder: normalized.documentOrder,
      updatedAt: now(),
    });
  };

  let operationStore;
  const getManifest = () => {
    const meta = readMeta();
    const normalized = normalizeOrder(meta.documentOrder, meta.activeDocumentId);
    const documents = readDocumentSummaries();
    return {
      workspaceRevision: meta.revision,
      activeDocumentId: normalized.activeDocumentId,
      documentOrder: normalized.documentOrder,
      documents,
      capabilities: ["attachments-v1", "node-operations-v2", "operation-ordering-v2"],
      ...(operationStore?.isEnabled() ? { requiredCapabilities: ["node-operations-v2", "operation-ordering-v2"], protocol: 2 } : {}),
    };
  };

  const getDocument = (id) => {
    const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
    if (!row) return null;
    return {
      id: row.id,
      revision: row.revision,
      document: parseJson(row.document_json, null),
      deletedAt: row.deleted_at ?? null,
      updatedAt: row.updated_at,
    };
  };

  const putDocument = ({ id, expectedRevision, document, capabilities = [] }) => transaction(() => {
    operationStore?.assertLegacyWritable();
    const safeExpectedRevision = normalizeExpectedRevision(expectedRevision);
    const safeDocument = validateDocument(id, document);
    const existing = db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
    const previous = existing ? parseJson(existing.document_json, null) : null;
    if ((safeDocument.attachments || previous?.attachments) &&
        (!Array.isArray(capabilities) || !capabilities.includes("attachments-v1"))) {
      throw new SyncCapabilityError();
    }
    const stampedAt = typeof safeDocument.updatedAt === "string" && safeDocument.updatedAt
      ? safeDocument.updatedAt
      : now();
    if (!existing) {
      if (safeExpectedRevision !== null) {
        throw new SyncConflictError("Document does not exist", null);
      }
      db.prepare(`
        INSERT INTO documents (
          id,
          revision,
          title,
          document_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (?, 1, ?, ?, ?, ?, NULL)
      `).run(
        id,
        safeDocument.title,
        stringifyDocument(safeDocument),
        typeof safeDocument.createdAt === "string" ? safeDocument.createdAt : stampedAt,
        stampedAt,
      );
      updateManifestForDocumentPresence(id, true);
      return getDocument(id);
    }

    if (safeExpectedRevision !== existing.revision) {
      throw new SyncConflictError("Document revision conflict", existing.revision);
    }
    db.prepare(`
      UPDATE documents
      SET revision = ?,
          title = ?,
          document_json = ?,
          updated_at = ?,
          deleted_at = NULL
      WHERE id = ?
    `).run(
      existing.revision + 1,
      safeDocument.title,
      stringifyDocument(safeDocument),
      stampedAt,
      id,
    );
    if (existing.deleted_at) updateManifestForDocumentPresence(id, true);
    return getDocument(id);
  });

  const deleteDocument = ({ id, expectedRevision }) => transaction(() => {
    operationStore?.assertLegacyWritable();
    const safeExpectedRevision = normalizeExpectedRevision(expectedRevision);
    const existing = db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
    if (!existing) throw new SyncNotFoundError("Document not found");
    if (safeExpectedRevision !== existing.revision) {
      throw new SyncConflictError("Document revision conflict", existing.revision);
    }
    const deletedAt = now();
    db.prepare(`
      UPDATE documents
      SET revision = ?,
          updated_at = ?,
          deleted_at = ?
      WHERE id = ?
    `).run(existing.revision + 1, deletedAt, deletedAt, id);
    updateManifestForDocumentPresence(id, false);
    const deleted = getDocument(id);
    return {
      id,
      revision: deleted.revision,
      deletedAt: deleted.deletedAt,
    };
  });

  const patchManifest = ({ expectedRevision, activeDocumentId, documentOrder }) =>
    transaction(() => {
      operationStore?.assertLegacyWritable();
      const safeExpectedRevision = normalizeExpectedRevision(expectedRevision);
      const meta = readMeta();
      if (safeExpectedRevision !== meta.revision) {
        throw new SyncConflictError("Workspace manifest revision conflict", meta.revision);
      }
      const normalized = normalizeOrder(documentOrder, activeDocumentId);
      writeMeta({
        revision: meta.revision + 1,
        activeDocumentId: normalized.activeDocumentId,
        documentOrder: normalized.documentOrder,
        updatedAt: now(),
      });
      return getManifest();
    });

  const getDocumentOperations = ({ id, after, limit = 100 }) => {
    const document = getDocument(id);
    if (!document) throw new SyncNotFoundError("Document not found");
    if (document.deletedAt) throw new SyncNotFoundError("Document is deleted");
    const safeAfter = normalizeOperationSequence(after);
    const safeLimit = Number(limit);
    if (!Number.isSafeInteger(safeLimit) || safeLimit < 1 || safeLimit > 500) throw new SyncValidationError("limit must be an integer between 1 and 500");
    const rows = db.prepare(`
      SELECT sequence, base_revision, actor_id, operation_json, created_at
      FROM document_operations
      WHERE document_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `).iterate(id, safeAfter, safeLimit + 1);
    const operations = [];
    let bytes = 256 + Buffer.byteLength(id), truncated = false;
    for (const row of rows) {
      const item = {
        sequence: row.sequence, baseRevision: row.base_revision, actorId: row.actor_id,
        operation: parseJson(row.operation_json, null), createdAt: row.created_at,
      };
      const size = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (operations.length >= safeLimit || bytes + size > 2 * 1024 * 1024) { truncated = true; break; }
      operations.push(item); bytes += size;
    }
    return {
      documentId: id,
      currentRevision: document.revision,
      operations,
      truncated,
      hasMore: truncated,
      nextAfter: truncated ? operations.at(-1)?.sequence ?? safeAfter : null,
    };
  };

  const appendDocumentOperations = ({ id, baseRevision, actorId, operations }) =>
    transaction(() => {
      operationStore?.assertLegacyWritable();
      const document = getDocument(id);
      if (!document) throw new SyncNotFoundError("Document not found");
      if (document.deletedAt) throw new SyncNotFoundError("Document is deleted");
      const safeBaseRevision = normalizeExpectedRevision(baseRevision);
      if (safeBaseRevision !== document.revision) {
        throw new SyncConflictError("Document operation base revision conflict", document.revision);
      }
      const safeActorId = normalizeActorId(actorId);
      const safeOperations = validateOperations(operations);
      const maxRow = db.prepare(`
        SELECT COALESCE(MAX(sequence), 0) AS sequence
        FROM document_operations
        WHERE document_id = ?
      `).get(id);
      let nextSequence = maxRow.sequence;
      const createdAt = now();
      const insert = db.prepare(`
        INSERT INTO document_operations (
          document_id,
          sequence,
          base_revision,
          actor_id,
          operation_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      const inserted = safeOperations.map((operation) => {
        nextSequence += 1;
        insert.run(
          id,
          nextSequence,
          safeBaseRevision,
          safeActorId,
          JSON.stringify(operation),
          createdAt,
        );
        return {
          sequence: nextSequence,
          baseRevision: safeBaseRevision,
          actorId: safeActorId,
          operation,
          createdAt,
        };
      });
      return {
        documentId: id,
        currentRevision: document.revision,
        operations: inserted,
      };
    });

  operationStore = createOperationStore({ db, transaction, getManifest, getDocument, updatePresence: updateManifestForDocumentPresence,
    updateOrder: (order) => {
      const meta = readMeta();
      const normalized = normalizeOrder(order, meta.activeDocumentId);
      writeMeta({ ...meta, ...normalized, revision: meta.revision + 1, updatedAt: now() });
    },
  });

  const temporaryAssetDirectory = databasePath === ":memory:" ? await fs.mkdtemp(path.join(os.tmpdir(), "bike-sync-assets-")) : null;
  const assets = await createAssetStore({ directory: temporaryAssetDirectory ?? `${databasePath}.assets`, quotaBytes: assetQuotaBytes });
  const collectUnusedAssets = async ({ apply = false, retentionDays = 30 } = {}) => {
    if (!Number.isInteger(retentionDays) || retentionDays < 30) throw new Error("附件维护至少保留 30 天缓冲期");
    const cutoff = Date.now() - retentionDays * 86400000;
    // The maintenance CLI holds the SQLite writer lock while inspecting roots
    // and deleting objects, so another process cannot publish a new reference.
    db.exec("BEGIN IMMEDIATE");
    try {
      const protectedAssets = new Set();
      const visit = (value) => {
        const stack = [value];
        while (stack.length) {
          const item = stack.pop();
          if (typeof item === "string" && /^sha256:[a-f0-9]{64}$/u.test(item)) protectedAssets.add(item);
          else if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) { stack.push(key, child); }
        }
      };
      for (const row of db.prepare("SELECT document_json FROM documents WHERE deleted_at IS NULL OR deleted_at >= ?").iterate(new Date(cutoff).toISOString())) visit(JSON.parse(row.document_json));
      for (const row of db.prepare("SELECT document_json FROM replica_legacy_backup").iterate()) visit(JSON.parse(row.document_json));
      for (const row of db.prepare("SELECT operation_json FROM replica_receipts WHERE operation_json != 'null'").iterate()) visit(JSON.parse(row.operation_json));
      const result = await assets.collectUnused({ protectedAssets, before: cutoff, apply });
      db.exec("COMMIT");
      return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  return {
    assets,
    collectUnusedAssets,
    operations: operationStore,
    close: () => { db.close(); if (temporaryAssetDirectory) void fs.rm(temporaryAssetDirectory, { recursive: true, force: true }); },
    getManifest,
    getDocument,
    putDocument,
    deleteDocument,
    patchManifest,
    getDocumentOperations,
    appendDocumentOperations,
  };
};
