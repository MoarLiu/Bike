import { createHash } from 'node:crypto';
import { OPERATION_LIMITS, splitOperationPayload } from '../shared/bike-operations.mjs';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, code: 'invalid_commit_transport' });
const digestOf = (text) => createHash('sha256').update(text).digest('hex');
const chunkSize = OPERATION_LIMITS.chunkCharacters;
const referenceThreshold = OPERATION_LIMITS.pageBytes / 2;
const maxParts = Math.ceil(OPERATION_LIMITS.commitBytes / chunkSize);

// Transport fragments are never visible as document edits. Only a complete,
// digest-verified logical commit enters the existing atomic submit transaction.
export function createOperationPayloadStore({ db, transaction }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS replica_uploads (
      id TEXT PRIMARY KEY, digest TEXT NOT NULL, bytes INTEGER NOT NULL,
      parts INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS replica_upload_parts (
      id TEXT NOT NULL, part INTEGER NOT NULL, content TEXT NOT NULL,
      PRIMARY KEY(id, part)
    );
    CREATE TABLE IF NOT EXISTS replica_payload_parts (
      id TEXT NOT NULL, part INTEGER NOT NULL, content TEXT NOT NULL,
      PRIMARY KEY(id, part)
    );
  `);
  const clear = (id) => {
    db.prepare('DELETE FROM replica_upload_parts WHERE id=?').run(id);
    db.prepare('DELETE FROM replica_uploads WHERE id=?').run(id);
  };
  const remember = (id, text) => {
    if (Buffer.byteLength(text) <= referenceThreshold) return;
    splitOperationPayload(text).forEach((content, part) =>
      db.prepare('INSERT OR REPLACE INTO replica_payload_parts(id, part, content) VALUES (?, ?, ?)').run(id, part, content));
  };
  const reference = (row) => row.operation_json !== 'null' && Buffer.byteLength(row.operation_json) > referenceThreshold
    ? { id: row.operation_id, digest: row.digest, parts: db.prepare('SELECT COUNT(*) AS count FROM replica_payload_parts WHERE id=?').get(row.operation_id).count, bytes: Buffer.byteLength(row.operation_json) } : null;
  const read = (id, index) => {
    if (typeof id !== 'string' || !id || id.length > 200 || !Number.isSafeInteger(Number(index)) || Number(index) < 0) throw fail('操作分片身份无效');
    const row = db.prepare('SELECT content FROM replica_payload_parts WHERE id=? AND part=?').get(id, Number(index));
    if (!row) throw fail('操作分片已过期，请重新读取 checkpoint', 410);
    return { id, index: Number(index), text: row.content };
  };
  const receive = (body, { submit, receipt }) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('操作分片必须是对象');
    const { id, digest, bytes, parts, index, text } = body;
    if (typeof id !== 'string' || !id || id.length > 200 || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) ||
        !Number.isSafeInteger(bytes) || bytes < 1 || bytes > OPERATION_LIMITS.commitBytes ||
        !Number.isSafeInteger(parts) || parts < 1 || parts > maxParts || parts > Math.ceil(bytes / chunkSize) ||
        !Number.isSafeInteger(index) || index < 0 || index >= parts ||
        typeof text !== 'string' || !text.length || text.length > chunkSize) throw fail('操作分片超过预算或格式无效', 413);
    const prior = receipt(id);
    if (prior) {
      if (prior.digest !== digest) throw fail('相同操作身份携带了不同内容', 409);
      transaction(() => clear(id));
      const { operation, ...result } = prior;
      return { ...result, complete: true };
    }
    const complete = transaction(() => {
      db.prepare('DELETE FROM replica_uploads WHERE updated_at < ?').run(Date.now() - 24 * 60 * 60 * 1000);
      db.prepare('DELETE FROM replica_upload_parts WHERE id NOT IN (SELECT id FROM replica_uploads)').run();
      const upload = db.prepare('SELECT * FROM replica_uploads WHERE id=?').get(id);
      if (upload && (upload.digest !== digest || upload.bytes !== bytes || upload.parts !== parts)) throw fail('操作分片元数据不一致', 409);
      if (!upload) {
        const reserved = db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes, COUNT(*) AS count FROM replica_uploads').get();
        if (reserved.count >= 16 || reserved.bytes + bytes > 2 * OPERATION_LIMITS.commitBytes) throw fail('传输暂存空间繁忙，请稍后重试', 503);
        db.prepare('INSERT INTO replica_uploads(id,digest,bytes,parts,updated_at) VALUES (?,?,?,?,?)').run(id,digest,bytes,parts,Date.now());
      }
      const previous = db.prepare('SELECT content FROM replica_upload_parts WHERE id=? AND part=?').get(id,index);
      if (previous && previous.content !== text) throw fail('重复操作分片内容不一致',409);
      const stored = db.prepare('SELECT COALESCE(SUM(length(CAST(content AS BLOB))),0) AS bytes FROM replica_upload_parts WHERE id=?').get(id).bytes;
      if (!previous && stored + Buffer.byteLength(text) > bytes + 2 * parts) throw fail('操作分片实际数据超过声明预算',413);
      db.prepare('INSERT OR IGNORE INTO replica_upload_parts(id,part,content) VALUES (?,?,?)').run(id,index,text);
      db.prepare('UPDATE replica_uploads SET updated_at=? WHERE id=?').run(Date.now(),id);
      return db.prepare('SELECT COUNT(*) AS count FROM replica_upload_parts WHERE id=?').get(id).count === parts;
    });
    if (!complete) return { id, complete: false };
    const joined = db.prepare('SELECT content FROM replica_upload_parts WHERE id=? ORDER BY part').all(id).map(row => row.content).join('');
    if (Buffer.byteLength(joined) !== bytes || digestOf(joined) !== digest) { transaction(() => clear(id)); throw fail('完整操作摘要或长度不一致',409); }
    let operation;
    try { operation = JSON.parse(joined); } catch { transaction(() => clear(id)); throw fail('完整操作 JSON 无效'); }
    if (!operation || typeof operation !== 'object' || Array.isArray(operation) || operation.id !== id) { transaction(() => clear(id)); throw fail('完整操作身份不一致',409); }
    const committed = submit(operation);
    transaction(() => clear(id));
    const { operation: omitted, ...result } = committed;
    return { ...result, complete: true };
  };
  const prune = () => db.prepare("DELETE FROM replica_payload_parts WHERE id IN (SELECT operation_id FROM replica_receipts WHERE operation_json='null')").run();
  return { remember, reference, read, receive, prune };
}
