import type { Workspace } from './types';
import type { SyncConfig } from './sync';
import { apiRequest, fetchSyncManifest } from './sync';
import { sha256Hex } from './knowledge';
import { OPERATION_CAPABILITY, OPERATION_LIMITS, canonicalJson, createWorkspaceOperation, indexOperationNodes, splitOperationPayload, sameOperationDocument } from '../shared/bike-operations.mjs';
import type { WorkspacePositions, OperationConflict, WorkspaceOperation } from '../shared/bike-operations.mjs';
import { applyReplicaEvents, projectReplicaWorkspace } from '../shared/bike-replica.mjs';
import type { ReplicaState, ReplicaEvent, ReplicaConflict } from '../shared/bike-replica.mjs';
import { validateDocumentAttachments } from '../shared/bike-attachments.mjs';
import { assertValueBudget, assertWorkspaceBudget, MAX_DOCUMENT_BYTES, utf8ByteLength } from '../shared/bike-limits.mjs';

interface ProtocolStatus { protocol: number; enabled: boolean; spaceId: string; cursor: number; minimumCursor: number; capabilities?: string[] }
interface Checkpoint extends ProtocolStatus {
  clock: number;
  documents: Array<{ id: string; document: unknown; positions: WorkspacePositions[string]; revision: number; deletedAt: string | null }>;
  nextAfter: number | null;
  conflicts: Array<{ id: string; operation: ReplicaEvent['operation']; conflicts: OperationConflict[]; resolved?: boolean }>;
  manifest: { documentOrder: string[] };
}
interface EventPage extends ProtocolStatus { events: ReplicaEvent[]; after: number; hasMore: boolean }
const checkStatus = (status: ProtocolStatus) => {
  if (status.protocol !== 2 || !status.enabled || !status.spaceId) throw new Error('同步空间尚未启用受支持的 2.0 协议');
};

const receiveOperation = async <T extends { id: string; operation?: WorkspaceOperation }>(
  config: SyncConfig, event: T & { operationRef?: { id: string; digest: string; parts: number; bytes: number } },
): Promise<T> => {
  const reference = event.operationRef;
  if (!reference) return event;
  if (reference.id !== event.id || !/^[a-f0-9]{64}$/.test(reference.digest) ||
      !Number.isSafeInteger(reference.parts) || reference.parts < 1 ||
      reference.parts > Math.ceil(OPERATION_LIMITS.commitBytes / OPERATION_LIMITS.chunkCharacters) ||
      !Number.isSafeInteger(reference.bytes) || reference.bytes < 1 || reference.bytes > OPERATION_LIMITS.commitBytes) throw new Error("远端操作分片描述无效");
  const parts: string[] = [];
  let characters = 0;
  for (let index = 0; index < reference.parts; index++) {
    const part = await apiRequest<{ id: string; index: number; text: string }>(config,
      `/api/v2/operation-chunks/${encodeURIComponent(event.id)}/${index}`, { maxResponseBytes: 2 * 1024 * 1024 });
    if (part.id !== event.id || part.index !== index || typeof part.text !== "string" ||
        part.text.length > OPERATION_LIMITS.chunkCharacters) throw new Error("远端操作分片不一致");
    characters += part.text.length;
    if (characters > OPERATION_LIMITS.commitBytes) throw new Error("远端操作超过接收预算");
    parts.push(part.text);
  }
  const text = parts.join("");
  if (utf8ByteLength(text) !== reference.bytes || sha256Hex(text) !== reference.digest) throw new Error("远端完整操作校验失败");
  const operation = JSON.parse(text) as WorkspaceOperation;
  if (operation.id !== event.id) throw new Error("远端完整操作身份不一致");
  return { ...event, operation };
};

const sendOperation = async (config: SyncConfig, operation: WorkspaceOperation, status: ProtocolStatus): Promise<ReplicaEvent> => {
  const text = canonicalJson(operation), bytes = utf8ByteLength(text);
  if (bytes <= OPERATION_LIMITS.bytes && operation.changes.length <= OPERATION_LIMITS.changes)
    return apiRequest<ReplicaEvent>(config, '/api/v2/operations', { method: 'POST', body: operation });
  if (!status.capabilities?.includes("atomic-commit-chunks-v1")) throw new Error("本机修改已保存；同步此批量操作需要将 Sync Server 升级到 2.0.1");
  if (bytes > OPERATION_LIMITS.commitBytes) throw new Error("完整提交超过传输预算，本机修改仍保留");
  const fragments = splitOperationPayload(text), parts = fragments.length, digest = sha256Hex(text);
  for (let index = 0; index < parts; index++) {
    const result = await apiRequest<ReplicaEvent & { complete: boolean }>(config, '/api/v2/operation-chunks', { method: 'POST', body: {
      id: operation.id, digest, bytes, parts, index,
      text: fragments[index],
    } });
    if (result.complete) return result;
  }
  throw new Error("远端提交尚未完成，本机操作已保留，可安全重试");
};

export const enableOperationSync = async (config: SyncConfig) => {
  const manifest = await fetchSyncManifest(config);
  if (!manifest.capabilities?.includes(OPERATION_CAPABILITY) || !manifest.capabilities.includes('operation-ordering-v2'))
    throw new Error('请先将 Sync Server 升级到 2.0.1，再启用节点同步');
  return apiRequest<ProtocolStatus>(config, '/api/v2/enable', { method: 'POST', body: { expectedRevision: manifest.workspaceRevision } });
};

const fetchCheckpoint = async (config: SyncConfig, replica: ReplicaState): Promise<ReplicaState> => {
  const documents = new Map<string, Workspace['documents'][number]>();
  const positions: WorkspacePositions = Object.create(null);
  const seen = new Set<string>();
  let responseBytes = 0, documentBytes = 0;
  let after = 0, expectedCursor: number | undefined;
  let first: Checkpoint | null = null;
  for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
    const page = await apiRequest<Checkpoint>(config, `/api/v2/checkpoint?after=${after}${expectedCursor === undefined ? '' : `&expectedCursor=${expectedCursor}`}`, { maxResponseBytes: OPERATION_LIMITS.checkpointBytes });
    checkStatus(page);
    responseBytes += utf8ByteLength(JSON.stringify(page));
    if (responseBytes > OPERATION_LIMITS.checkpointBytes) throw new Error('checkpoint 累计响应超过 160 MiB，请缩小远端空间后重试，本机待传操作已保留');
    if (replica.remoteId && page.spaceId !== replica.remoteId) throw new Error('同步空间身份已变化，请先导出本机副本，再明确连接新空间');
    if (!first) first = page;
    if (expectedCursor !== undefined && expectedCursor !== page.cursor) throw new Error('checkpoint 分页期间发生变化，请重试');
    expectedCursor = page.cursor;
    for (const item of page.documents) {
      if (typeof item.id !== 'string' || !item.id || item.id.length > 200 || seen.has(item.id)) throw new Error('checkpoint 文档身份重复或不一致');
      seen.add(item.id);
      if (!item.deletedAt) {
        // A checkpoint is an operation baseline, not an import. Migration
        // must never rewrite fields/identities behind the server's back.
        const document = item.document as Workspace['documents'][number];
        indexOperationNodes(document);
        validateDocumentAttachments(document);
        if (document.id !== item.id) throw new Error('checkpoint 文档身份重复或不一致');
        documentBytes += assertValueBudget(document).bytes;
        if (documentBytes > MAX_DOCUMENT_BYTES) throw new Error('checkpoint 工作区超过 64 MiB，请缩小远端空间后重试，本机待传操作已保留');
        documents.set(item.id, document);
      }
      positions[item.id] = item.positions;
    }
    if (page.nextAfter === null) {
      const order = first.manifest.documentOrder;
      const rank = new Map(order.map((id, index) => [id, index]));
      const ordered = [...documents.values()].sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length));
      const workspace: Workspace = { version: 3, activeDocumentId: ordered[0]?.id ?? '', documents: ordered };
      assertWorkspaceBudget(workspace);
      const conflicts = [];
      for (const conflict of first.conflicts) conflicts.push(await receiveOperation(config, conflict));
      return { ...replica, remoteId: first.spaceId, cursor: first.cursor, clock: Math.max(replica.clock, first.clock),
        remote: { workspace, positions, clock: first.clock }, conflicts: conflicts as ReplicaConflict[] };
    }
    if (!Number.isSafeInteger(page.nextAfter) || page.nextAfter <= after) throw new Error('checkpoint 分页没有前进');
    after = page.nextAfter;
  }
  throw new Error('checkpoint 超过有界读取预算，请稍后重试');
};

export const syncOperationWorkspace = async (workspace: Workspace, config: SyncConfig, original: ReplicaState, options: { allowInitialCollision?: boolean } = {}) => {
  if (workspace.version !== 3) throw new Error('请先备份并升级本机工作区');
  const status = await apiRequest<ProtocolStatus>(config, '/api/v2/status');
  checkStatus(status);
  if (!status.capabilities?.includes("atomic-commit-chunks-v1") || !status.capabilities.includes("document-order-v1") || !status.capabilities.includes("operation-ordering-v2"))
    throw new Error("本机修改已保存；请将 Sync Server 升级到 2.0.1 后继续同步");
  if (original.remoteId && original.remoteId !== status.spaceId) throw new Error('远端空间身份发生变化，请明确重新连接');
  let replica = original;
  const firstConnection = !replica.remote;
  if (firstConnection || replica.cursor < status.minimumCursor) replica = await fetchCheckpoint(config, replica);
  if (!replica.remote) throw new Error('缺少同步基线');
  if (firstConnection) {
    const remoteById = new Map(replica.remote.workspace.documents.map(document => [document.id, document]));
    const collisions = (replica.initialWorkspace?.documents ?? []).filter(document => {
      const remote = remoteById.get(document.id);
      return remote && !sameOperationDocument(remote, document);
    });
    for (const document of options.allowInitialCollision ? [] : collisions) {
      const seed = createWorkspaceOperation({ ...workspace, documents: [] }, { ...workspace, documents: [document] }, {
        id: `seed-${replica.actorId}-${sha256Hex(document.id).slice(0, 24)}`, actorId: replica.actorId, clock: 1,
        source: { kind: 'import', label: '首次接入的本机基线' }, createdAt: document.updatedAt, includeOrder: false, commit: true, orderingVersion: 1,
      });
      let receipt: ReplicaEvent | null = null;
      try { receipt = await apiRequest<ReplicaEvent>(config, `/api/v2/receipts/${encodeURIComponent(seed.id)}`); }
      catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
      // A lost first-sync acknowledgement is not a new collision. Retry the
      // exact original seed identity instead of inventing a fresh baseline.
      if (receipt?.status !== "applied" || receipt.digest !== sha256Hex(canonicalJson(seed)))
        throw Object.assign(new Error(`首次接入发现同 ID 文档「${document.title}」内容不同。继续会显示远端正文，并把本机版本保留为待比较冲突；也可以取消并连接空同步空间。`), { code: "initial-collision" });
    }
    const seeds = [];
    for (const document of replica.initialWorkspace?.documents ?? []) {
      const seed = createWorkspaceOperation({ ...workspace, documents: [] }, { ...workspace, documents: [document] }, {
        id: `seed-${replica.actorId}-${sha256Hex(document.id).slice(0, 24)}`, actorId: replica.actorId, clock: 1,
        source: { kind: 'import', label: '首次接入的本机基线' }, createdAt: document.updatedAt, includeOrder: false, commit: true, orderingVersion: 1,
      });
      seeds.push(seed);
    }
    replica = { ...replica, outbox: [...seeds, ...replica.outbox] };
  }
  let uploaded = 0, uploadError: string | undefined;
  const uploadBatch = replica.outbox.slice(0, 100);
  for (const operation of replica.outbox.filter(operation => operation.resolves.length).slice(0, 16))
    if (!uploadBatch.some(item => item.id === operation.id)) uploadBatch.push(operation);
  for (const operation of uploadBatch) {
    let receipt: ReplicaEvent;
    try { receipt = await sendOperation(config, operation, status); }
    catch (error) {
      if ((error as { status?: number }).status !== 507) throw error;
      // Read already accepted conflicts so the user can free conflict capacity.
      // Otherwise a full queue would prevent the very UI needed to resolve it.
      uploadError = (error as Error).message; continue;
    }
    if (receipt.id !== operation.id || !Number.isSafeInteger(receipt.sequence) || !["applied", "conflict"].includes(receipt.status) || receipt.digest !== sha256Hex(canonicalJson(operation))) throw new Error('上传回执身份不一致');
    if (receipt.sequence <= replica.cursor) {
      replica = { ...replica,
        receipts: Object.fromEntries(Object.entries(replica.receipts).map(([id, entry]) => [id,
          entry.operationId === operation.id ? { ...entry, pendingSync: false, remoteStatus: receipt.status } : entry])),
        outbox: replica.outbox.filter((item) => item.id !== operation.id),
        audit: replica.audit.map((item) => item.id === operation.id || replica.receipts[item.id]?.operationId === operation.id
          ? { ...item, status: receipt.status === 'applied' ? 'synced' : 'conflict' } : item) };
    }
    uploaded++;
  }
  let hasMore = false, downloaded = 0;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await apiRequest<EventPage>(config, `/api/v2/events?after=${replica.cursor}`, { maxResponseBytes: OPERATION_LIMITS.pageBytes });
    checkStatus(page);
    if (page.spaceId !== replica.remoteId) throw new Error('接收期间同步空间发生变化');
    const events = [];
    for (const event of page.events) events.push(await receiveOperation(config, event));
    const next = events.length ? applyReplicaEvents(replica, events) : replica;
    assertWorkspaceBudget(next.remote!.workspace);
    if (page.hasMore && next.cursor <= replica.cursor) throw new Error('操作流没有前进');
    replica = next; downloaded += page.events.length; hasMore = page.hasMore;
    if (!hasMore) break;
  }
  if (replica === original && !uploaded && !downloaded && !hasMore && !replica.outbox.length) {
    return { workspace, replica, pendingConflicts: [], hasMore: false, unchanged: true,
      summary: { uploaded, downloaded, deleted: 0, conflicts: replica.conflicts.filter(item => !item.resolved).flatMap(item => item.conflicts.map(conflict => conflict.message)) } };
  }
  const result = projectReplicaWorkspace(workspace, { ...replica, initialWorkspace: undefined });
  assertWorkspaceBudget(result.workspace);
  return { ...result, unchanged: false, hasMore: hasMore || result.replica.outbox.length > 0,
    summary: { uploaded, downloaded, deleted: 0,
      conflicts: [...[...result.replica.conflicts.filter((item) => !item.resolved), ...result.pendingConflicts]
        .map((item) => item.conflicts.map((conflict) => conflict.message).join('、')), ...(uploadError ? [uploadError] : [])] } };
};
