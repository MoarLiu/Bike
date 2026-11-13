import { migrateDocument } from '../mcp/bike-core.mjs';
import { createOperationPayloadStore } from './operation-payloads.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { OPERATION_CAPABILITY, OPERATION_LIMITS, OPERATION_PROTOCOL, applyWorkspaceOperation, canonicalJson, canonicalOperationDocument, initialPositions, validateWorkspaceOperation } from '../shared/bike-operations.mjs';

const error = (message, statusCode = 400, code = 'invalid_operation') => Object.assign(new Error(message), { statusCode, code });
const parse = (value) => JSON.parse(value);
const stamp = () => new Date().toISOString();
const number = (value, label) => {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result) || result < 0) throw error(`${label} 必须是非负整数`);
  return result;
};

export const createOperationStore = ({ db, transaction, getManifest, getDocument, updatePresence, updateOrder }) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS replica_meta (
      id INTEGER PRIMARY KEY CHECK(id = 1), space_id TEXT NOT NULL, clock INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS replica_legacy_backup (document_id TEXT PRIMARY KEY, document_json TEXT NOT NULL, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS replica_positions (
      document_id TEXT PRIMARY KEY, positions_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS replica_receipts (
      operation_id TEXT PRIMARY KEY, digest TEXT NOT NULL, sequence INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL, operation_json TEXT NOT NULL, conflicts_json TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS replica_events (
      sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
      FOREIGN KEY(operation_id) REFERENCES replica_receipts(operation_id)
    );
  `);
  const payloads = createOperationPayloadStore({ db, transaction });
  const isEnabled = () => Boolean(db.prepare('SELECT id FROM replica_meta WHERE id = 1').get());
  const assertEnabled = () => { if (!isEnabled()) throw error('请先确认升级此同步空间到 2.0 协议', 426, 'protocol_upgrade_required'); };
  const assertLegacyWritable = () => { if (isEnabled()) throw error('此空间已启用 2.0 节点操作，请升级客户端后写入', 426, 'client_upgrade_required'); };
  const cursor = () => db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM replica_receipts').get().value;
  const minimumCursor = () => db.prepare('SELECT COALESCE(MIN(sequence) - 1, 0) AS value FROM replica_events').get().value;
  const status = () => ({ protocol: OPERATION_PROTOCOL, capability: OPERATION_CAPABILITY, enabled: isEnabled(),
    spaceId: db.prepare('SELECT space_id FROM replica_meta WHERE id = 1').get()?.space_id ?? null,
    cursor: cursor(), minimumCursor: minimumCursor(), capabilities: ['atomic-commit-chunks-v1', 'document-order-v1', 'operation-ordering-v2'],
    retention: '5000-events; receipts retained; checkpoint required after compaction' });
  const enable = ({ expectedRevision }) => transaction(() => {
    if (isEnabled()) return status();
    if (getManifest().workspaceRevision !== expectedRevision) throw error('空间在升级期间发生变化，请重新比较', 409, 'revision_conflict');
    db.prepare('INSERT INTO replica_meta(id, space_id, clock) VALUES (1, ?, 0)').run(randomUUID());
    for (const row of db.prepare('SELECT * FROM documents').all()) {
      const raw = parse(row.document_json);
      const beforeIds = Object.keys(initialPositions({ documents: [raw] })[raw.id]);
      const document = migrateDocument({ ...raw, createdAt: raw.createdAt ?? row.created_at, updatedAt: raw.updatedAt ?? row.updated_at });
      const afterIds = Object.keys(initialPositions({ documents: [document] })[document.id]);
      if (document.id !== row.id || canonicalJson(beforeIds.sort()) !== canonicalJson(afterIds.sort())) throw error('旧文档身份无效，升级已停止，请先导出并修复');
      db.prepare('INSERT OR IGNORE INTO replica_legacy_backup(document_id, document_json, revision) VALUES (?, ?, ?)').run(row.id, row.document_json, row.revision);
      db.prepare('UPDATE documents SET document_json=? WHERE id=?').run(JSON.stringify(document), row.id);
      db.prepare('INSERT INTO replica_positions(document_id, positions_json) VALUES (?, ?)').run(row.id,
        JSON.stringify(initialPositions({ documents: [document] })[row.id]));
    }
    return status();
  });
  const receiptFrom = (row, includeOperation = true) => row ? {
    id: row.operation_id, digest: row.digest, sequence: row.sequence, status: row.status, conflicts: parse(row.conflicts_json),
    ...(includeOperation ? { operation: parse(row.operation_json) } : {}), resolved: Boolean(row.resolved), createdAt: row.created_at,
  } : null;
  const receipt = (id) => receiptFrom(db.prepare('SELECT * FROM replica_receipts WHERE operation_id = ?').get(id));
  const wireReceipt = (row) => {
    const operationRef = payloads.reference(row);
    return { ...receiptFrom(row, !operationRef), ...(operationRef ? { operationRef } : {}) };
  };
  const unresolved = () => db.prepare("SELECT * FROM replica_receipts WHERE status = 'conflict' AND resolved = 0 ORDER BY sequence").all().map((row) => receiptFrom(row));
  const checkpoint = ({ expectedCursor, after = 0, limit = 20 } = {}) => transaction(() => {
    assertEnabled();
    const currentCursor = cursor();
    if (expectedCursor !== undefined && number(expectedCursor, 'expectedCursor') !== currentCursor) throw error('checkpoint 在分页期间发生变化，请重试', 409, 'checkpoint_changed');
    const offset = number(after, 'after'), count = number(limit, 'limit');
    if (count < 1 || count > 100) throw error('checkpoint limit 必须是 1–100');
    const rows = db.prepare('SELECT id, revision, document_json, deleted_at FROM documents ORDER BY id LIMIT ? OFFSET ?').all(count + 1, offset);
    const documents = [];
    let size = 0;
    for (const row of rows.slice(0, count)) {
      const item = { id: row.id, revision: row.revision, deletedAt: row.deleted_at ?? null,
        document: row.deleted_at ? null : parse(row.document_json), positions: row.deleted_at ? {} : parse(db.prepare('SELECT positions_json FROM replica_positions WHERE document_id = ?').get(row.id)?.positions_json ?? '{}') };
      const bytes = Buffer.byteLength(JSON.stringify(item));
      if (documents.length && size + bytes > OPERATION_LIMITS.pageBytes) break;
      if (bytes > 96 * 1024 * 1024) throw error('单文档 checkpoint 超过 96 MiB，请缩小文档', 413);
      documents.push(item); size += bytes;
    }
    const nextAfter = rows.length > documents.length ? offset + documents.length : null;
    return { ...status(), clock: db.prepare('SELECT clock FROM replica_meta WHERE id = 1').get().clock,
      cursor: currentCursor, documents, nextAfter, ...(offset === 0 ? { manifest: { documentOrder: getManifest().documentOrder } } : {}),
      conflicts: offset === 0 ? db.prepare("SELECT * FROM replica_receipts WHERE status='conflict' AND resolved=0 ORDER BY sequence").all().map(wireReceipt) : [] };
  });
  const events = ({ after = 0, limit = OPERATION_LIMITS.pageSize } = {}) => transaction(() => {
    assertEnabled();
    const position = number(after, 'after'), count = number(limit, 'limit');
    if (count < 1 || count > OPERATION_LIMITS.pageSize) throw error('操作分页 limit 超过预算');
    if (position < minimumCursor()) throw error('操作日志已压缩，请保护本机 outbox 后重新取得 checkpoint', 410, 'checkpoint_required');
    if (position > cursor()) throw error('接收游标超过服务端状态', 409, 'invalid_cursor');
    const rows = db.prepare(`SELECT r.* FROM replica_events e JOIN replica_receipts r ON e.operation_id = r.operation_id
      WHERE e.sequence > ? ORDER BY e.sequence LIMIT ?`).all(position, count + 1);
    const result = []; let size = 0;
    for (const row of rows.slice(0, count)) {
      const item = wireReceipt(row), bytes = Buffer.byteLength(JSON.stringify(item));
      if (result.length && size + bytes > OPERATION_LIMITS.pageBytes) break;
      result.push(item); size += bytes;
    }
    return { ...status(), events: result, after: result.at(-1)?.sequence ?? position, hasMore: rows.length > result.length };
  });
  const submit = (operation) => transaction(() => {
    assertEnabled();
    try { validateWorkspaceOperation(operation, { commit: true }); } catch (issue) { throw error(issue.message); }
    const serialized = canonicalJson(operation);
    const digest = createHash('sha256').update(serialized).digest('hex');
    const prior = db.prepare('SELECT * FROM replica_receipts WHERE operation_id = ?').get(operation.id);
    if (prior) {
      if (prior.digest !== digest) throw error('相同操作身份携带了不同内容', 409, 'idempotency_mismatch');
      return { ...receiptFrom(prior), replayed: true, spaceId: status().spaceId };
    }
    const ids = [...new Set([...operation.changes.map((change) => change.documentId), ...Object.keys(operation.resolutionBaselines ?? {})])];
    const existing = new Map(ids.map((id) => [id, getDocument(id)]));
    const documents = ids.flatMap((id) => existing.get(id) && !existing.get(id).deletedAt ? [existing.get(id).document] : []);
    const positions = Object.fromEntries(ids.map((id) => [id, parse(db.prepare('SELECT positions_json FROM replica_positions WHERE document_id = ?').get(id)?.positions_json ?? '{}')]));
    const workspace = { version: 3, activeDocumentId: documents[0]?.id ?? '', documents };
    const tombstoneConflict = operation.changes.find((change) => change.type === 'create-document' && existing.get(change.documentId)?.deletedAt &&
      !(change.restore === true && ['undo', 'redo', 'restore', 'conflict'].includes(operation.source.kind)));
    let merged = tombstoneConflict ? { status: 'conflict', conflicts: [{ documentId: tombstoneConflict.documentId, nodeId: null, field: 'document', message: '远端文档已删除，须显式恢复为新操作' }] }
      : applyWorkspaceOperation(workspace, positions, operation);
    for (const conflictId of operation.resolves) {
      const target = receipt(conflictId);
      if (!target || target.status !== 'conflict' || target.resolved) { merged = { status: 'conflict', conflicts: [{ documentId: ids[0], nodeId: null, field: 'resolution', message: '冲突已变化，请重新比较' }] }; continue; }
      if (!target.operation.changes.every((change) => ids.includes(change.documentId))) throw error('冲突解决缺少完整文档范围');
    }
    for (const [id, digest] of Object.entries(operation.resolutionBaselines ?? {})) {
      const document = existing.get(id)?.deletedAt ? null : existing.get(id)?.document;
      const current = document ? createHash('sha256').update(operation.orderingVersion === 2 ? canonicalOperationDocument(document) : canonicalJson(document)).digest('hex') : null;
      if (digest !== current) merged = { status: 'conflict', conflicts: [{ documentId: id, nodeId: null, field: 'resolution', message: '解决期间目标再次变化，请重新比较' }] };
    }
    // Before/after bodies already live in the immutable operation. Keep the
    // transport's comparison metadata bounded, including huge field conflicts.
    let conflictBytes = 0;
    const conflicts = [];
    for (const item of merged.conflicts ?? []) {
      const compact = { ...item };
      for (const key of ['baseline', 'current', 'candidate']) {
        const encoded = JSON.stringify(compact[key]);
        if (encoded && encoded.length > 2048) compact[key] = { preview: encoded.slice(0, 2048), truncated: true };
      }
      const size = Buffer.byteLength(JSON.stringify(compact));
      if (conflictBytes + size > 512 * 1024) {
        conflicts.push({ documentId: item.documentId, nodeId: null, field: 'summary', message: `另有 ${merged.conflicts.length - conflicts.length} 项冲突；完整候选保留在操作记录中` });
        break;
      }
      conflicts.push(compact); conflictBytes += size;
    }
    merged.conflicts = conflicts;
    const sequence = cursor() + 1;
    if (merged.status === 'applied') {
      const nextById = new Map(merged.workspace.documents.map((document) => [document.id, document]));
      for (const id of ids) {
        const old = existing.get(id), next = nextById.get(id), at = stamp();
        if (next) {
          db.prepare(`INSERT INTO documents(id, revision, title, document_json, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET
            revision=excluded.revision, title=excluded.title, document_json=excluded.document_json, updated_at=excluded.updated_at, deleted_at=NULL`)
            .run(id, (old?.revision ?? 0) + 1, next.title, JSON.stringify(next), next.createdAt ?? at, at);
          db.prepare('INSERT INTO replica_positions(document_id, positions_json) VALUES (?, ?) ON CONFLICT(document_id) DO UPDATE SET positions_json=excluded.positions_json')
            .run(id, JSON.stringify(merged.positions[id]));
          if (!old || old.deletedAt) updatePresence(id, true);
        } else if (old && !old.deletedAt) {
          db.prepare('UPDATE documents SET revision=revision+1, deleted_at=?, updated_at=? WHERE id=?').run(at, at, id);
          updatePresence(id, false);
        }
      }
      for (const id of operation.resolves) db.prepare('UPDATE replica_receipts SET resolved=1 WHERE operation_id=?').run(id);
      if (operation.documentOrder) updateOrder(operation.documentOrder.after);
    } else {
      const pending = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(operation_json AS BLOB))+length(CAST(conflicts_json AS BLOB))),0) AS bytes FROM replica_receipts WHERE status='conflict' AND resolved=0").get();
      const incomingBytes = Buffer.byteLength(serialized) + conflictBytes;
      if (pending.count >= 1000 || (pending.count > 0 && pending.bytes + incomingBytes > Math.max(32 * 1024 * 1024, incomingBytes)))
        throw error('未处理冲突达到保留预算，请先处理冲突，本机操作仍保留', 507, 'conflict_quota');
    }
    db.prepare(`INSERT INTO replica_receipts(operation_id, digest, sequence, status, operation_json, conflicts_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(operation.id, digest, sequence, merged.status, serialized, JSON.stringify(merged.conflicts), stamp());
    payloads.remember(operation.id, serialized);
    db.prepare('INSERT INTO replica_events(sequence, operation_id) VALUES (?, ?)').run(sequence, operation.id);
    db.prepare('UPDATE replica_meta SET clock=MAX(clock, ?) WHERE id=1').run(operation.clock);
    db.prepare('DELETE FROM replica_events WHERE sequence <= ?').run(Math.max(0, sequence - 5000));
    db.prepare("UPDATE replica_receipts SET operation_json='null', conflicts_json='[]' WHERE sequence <= ? AND operation_json != 'null' AND (status='applied' OR resolved=1)").run(Math.max(0, sequence - 5000));
    payloads.prune();
    return { ...receipt(operation.id), spaceId: status().spaceId, replayed: false };
  });
  return { isEnabled, assertLegacyWritable, status, enable, checkpoint, events, submit, receipt, unresolved,
    receiveChunk: (body) => { assertEnabled(); return payloads.receive(body, { submit, receipt }); },
    readChunk: (id, index) => { assertEnabled(); return payloads.read(id, index); },
  };
};
