import { attachmentDigest, validateAttachmentMetadata, workspaceAttachmentAssets } from './bike-attachments.mjs';
import { assertValueBudget, assertWorkspaceBudget } from './bike-limits.mjs';
import { canonicalJson } from './bike-operations.mjs';
import { sha256Hex } from './bike-knowledge.mjs';

export const LOCAL_MIGRATION_FORMAT = 'bike-local-copy';
export const LOCAL_MIGRATION_VERSION = 1;
export const LOCAL_MIGRATION_PREFERENCES = Object.freeze(['theme', 'bike.navigation.v1', 'bike.mindmap.relations', 'ai']);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value) => typeof value === 'string' && value.length > 0 && value.length <= 300;
const digest = (value) => sha256Hex(canonicalJson(value));
const fail = () => { throw new Error('完整本机副本格式或校验无效，原数据已保留'); };

export const withoutLocalMigration = (workspace) => {
  const { localMigration: _migration, ...body } = workspace;
  return body;
};

// Audit entries can reference assets whose document snapshot has expired. Scan
// every retained value, including before/after fields and old private archives.
export const localMigrationAssetReferences = (value) => {
  assertValueBudget(value);
  const ids = new Set();
  const metadata = new Map();
  const addMetadata = (assetId, item) => {
    attachmentDigest(assetId);
    validateAttachmentMetadata(item);
    const previous = metadata.get(assetId);
    if (previous && ['byteLength', 'mediaType', 'width', 'height'].some((key) => previous[key] !== item[key])) {
      throw new Error('完整本机副本的附件元数据冲突');
    }
    metadata.set(assetId, item);
  };
  const stack = [value];
  while (stack.length) {
    const item = stack.pop();
    if (Array.isArray(item)) for (const child of item) stack.push(child);
    else if (record(item)) {
      if (typeof item.assetId === 'string' && /^sha256:[a-f0-9]{64}$/u.test(item.assetId)) ids.add(item.assetId);
      if (typeof item.assetId === 'string' && record(item.metadata)) addMetadata(item.assetId, item.metadata);
      for (const [key, child] of Object.entries(item)) {
        if (/^sha256:[a-f0-9]{64}$/u.test(key) && record(child) && 'byteLength' in child && 'mediaType' in child) {
          ids.add(key);
          addMetadata(key, child);
        }
        stack.push(child);
      }
    }
  }
  return { ids: [...ids].sort(), assets: [...metadata].map(([assetId, item]) => ({ assetId, metadata: item })) };
};

const validateArchive = (copy, depth = 0) => {
  if (!record(copy) || copy.format !== LOCAL_MIGRATION_FORMAT || copy.version !== LOCAL_MIGRATION_VERSION ||
      !identity(copy.id) || !Number.isFinite(Date.parse(copy.createdAt)) || depth > 16 ||
      !record(copy.source) || (copy.source.actorId !== null && !identity(copy.source.actorId)) ||
      !Number.isSafeInteger(copy.source.revision) || copy.source.revision < 0 ||
      !/^[a-f0-9]{64}$/u.test(copy.source.workspaceSha256) ||
      !Array.isArray(copy.history) || !Array.isArray(copy.recovery) || !Array.isArray(copy.recoveryFiles) ||
      !record(copy.sourceAudit) || !Array.isArray(copy.sourceAudit.audit) || !Array.isArray(copy.sourceAudit.outbox) ||
      !record(copy.sourceAudit.receipts) || !Array.isArray(copy.sourceAudit.conflicts) ||
      !Array.isArray(copy.archives) || !Array.isArray(copy.assets)) fail();
  const documentIds = new Set();
  for (const row of copy.history) {
    if (!record(row) || !identity(row.documentId) || documentIds.has(row.documentId) || !Array.isArray(row.snapshots)) fail();
    documentIds.add(row.documentId);
  }
  const recoveryIds = new Set();
  for (const snapshot of copy.recovery) {
    if (!record(snapshot) || !identity(snapshot.id) || recoveryIds.has(snapshot.id) || !Number.isFinite(snapshot.savedAt) ||
        (snapshot.baseRevision !== null && (!Number.isSafeInteger(snapshot.baseRevision) || snapshot.baseRevision < 0))) fail();
    assertWorkspaceBudget(snapshot.workspace);
    recoveryIds.add(snapshot.id);
  }
  for (const file of copy.recoveryFiles) if (!record(file) || !identity(file.id) || typeof file.content !== 'string') fail();
  for (const key of ['preAttachment', 'preOperation']) if (copy[key] !== null) assertWorkspaceBudget(copy[key]);
  for (const archive of copy.archives) validateArchive(archive, depth + 1);
  if (copy.preferences !== undefined && (!record(copy.preferences) || Object.keys(copy.preferences).some((key) => !LOCAL_MIGRATION_PREFERENCES.includes(key)))) fail();
  if (copy.preferences?.ai !== undefined && (!record(copy.preferences.ai) || Object.keys(copy.preferences.ai).some((key) => !['endpoint', 'baseUrl', 'model'].includes(key)))) fail();
  for (const key of ['theme', 'bike.navigation.v1', 'bike.mindmap.relations']) if (copy.preferences?.[key] !== undefined && typeof copy.preferences[key] !== 'string') fail();
  if (copy.credentials !== undefined && (!record(copy.credentials) || Object.keys(copy.credentials).some((key) => key !== 'aiApiKey') || typeof copy.credentials.aiApiKey !== 'string')) fail();
  // Source journal fields are inert data. Connection tokens, cursor, checkpoint
  // and replica identity are deliberately absent from the executable state.
  if (Object.keys(copy.sourceAudit).some((key) => !['audit', 'outbox', 'receipts', 'conflicts'].includes(key))) fail();
};

export const localMigrationAttachmentAssets = (workspace) => {
  const live = workspaceAttachmentAssets(workspace);
  const copy = workspace.localMigration;
  if (copy === undefined) return live;
  assertWorkspaceBudget(workspace);
  validateArchive(copy);
  const { assets: _index, preferences: _preferences, credentials: _credentials, source: _source, ...contents } = copy;
  const references = localMigrationAssetReferences({ workspace: withoutLocalMigration(workspace), contents });
  const assets = new Map();
  for (const item of copy.assets) {
    if (!record(item) || assets.has(item.assetId)) fail();
    attachmentDigest(item.assetId);
    validateAttachmentMetadata(item.metadata);
    assets.set(item.assetId, item.metadata);
  }
  if (assets.size !== references.ids.length || references.ids.some((id) => !assets.has(id))) {
    throw new Error('完整本机副本的历史或备用附件清单不闭合');
  }
  for (const item of [...live, ...references.assets]) {
    const indexed = assets.get(item.assetId);
    if (!indexed || ['byteLength', 'mediaType', 'width', 'height'].some((key) => indexed[key] !== item.metadata[key])) fail();
  }
  return [...assets].map(([assetId, metadata]) => ({ assetId, metadata })).sort((left, right) => left.assetId.localeCompare(right.assetId));
};

export const sealLocalMigration = (workspace, copy) => {
  const body = withoutLocalMigration(workspace);
  const { contentSha256: _checksum, ...contents } = copy;
  const sealed = { ...contents, contentSha256: digest({ workspace: body, localMigration: contents }) };
  const result = { ...body, localMigration: sealed };
  readLocalMigration(result);
  return result;
};

export const readLocalMigration = (workspace) => {
  const copy = workspace?.localMigration;
  if (copy === undefined) return null;
  const body = withoutLocalMigration(workspace);
  localMigrationAttachmentAssets(workspace);
  const { contentSha256, ...contents } = copy;
  if (digest(body) !== copy.source.workspaceSha256 || digest({ workspace: body, localMigration: contents }) !== contentSha256) fail();
  return copy;
};

export const localMigrationDigest = digest;
