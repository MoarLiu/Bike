import type { Workspace } from './types';
import type { SyncConfig } from './sync';
import { apiRequest, fetchSyncManifest } from './sync';
import { sha256Hex } from './knowledge';
import { OPERATION_CAPABILITY, OPERATION_LIMITS, canonicalJson, createWorkspaceOperation } from '../shared/bike-operations.mjs';
import type { WorkspacePositions, OperationConflict } from '../shared/bike-operations.mjs';
import { applyReplicaEvents, projectReplicaWorkspace } from '../shared/bike-replica.mjs';
import type { ReplicaState, ReplicaEvent, ReplicaConflict } from '../shared/bike-replica.mjs';
import { migrateDocument } from './migrations';
import { assertValueBudget, assertWorkspaceBudget, MAX_DOCUMENT_BYTES, utf8ByteLength } from '../shared/bike-limits.mjs';

interface ProtocolStatus { protocol: number; enabled: boolean; spaceId: string; cursor: number; minimumCursor: number }
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

export const enableOperationSync = async (config: SyncConfig) => {
  const manifest = await fetchSyncManifest(config);
  if (!manifest.capabilities?.includes(OPERATION_CAPABILITY)) throw new Error('请先升级 Sync Server，再启用 2.0 同步');
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
        const document = migrateDocument(item.document);
        if (document.id !== item.id) throw new Error('checkpoint 文档身份重复或不一致');
        documentBytes += assertValueBudget(document).bytes;
        if (documentBytes > MAX_DOCUMENT_BYTES) throw new Error('checkpoint 工作区超过 64 MiB，请缩小远端空间后重试，本机待传操作已保留');
        documents.set(item.id, document);
      }
      positions[item.id] = item.positions;
    }
    if (page.nextAfter === null) {
      const order = first.manifest.documentOrder;
      const ordered = [...documents.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      const workspace: Workspace = { version: 3, activeDocumentId: ordered[0]?.id ?? '', documents: ordered };
      assertWorkspaceBudget(workspace);
      return { ...replica, remoteId: first.spaceId, cursor: first.cursor, clock: Math.max(replica.clock, first.clock),
        remote: { workspace, positions, clock: first.clock }, conflicts: first.conflicts as ReplicaConflict[] };
    }
    if (!Number.isSafeInteger(page.nextAfter) || page.nextAfter <= after) throw new Error('checkpoint 分页没有前进');
    after = page.nextAfter;
  }
  throw new Error('checkpoint 超过有界读取预算，请稍后重试');
};

export const syncOperationWorkspace = async (workspace: Workspace, config: SyncConfig, original: ReplicaState) => {
  if (workspace.version !== 3) throw new Error('请先备份并升级本机工作区');
  const status = await apiRequest<ProtocolStatus>(config, '/api/v2/status');
  checkStatus(status);
  if (original.remoteId && original.remoteId !== status.spaceId) throw new Error('远端空间身份发生变化，请明确重新连接');
  let replica = original;
  const firstConnection = !replica.remote;
  if (firstConnection || replica.cursor < status.minimumCursor) replica = await fetchCheckpoint(config, replica);
  if (!replica.remote) throw new Error('缺少同步基线');
  if (firstConnection) {
    const seeds = [];
    for (const document of replica.initialWorkspace?.documents ?? []) {
      const seed = createWorkspaceOperation({ ...workspace, documents: [] }, { ...workspace, documents: [document] }, {
        id: `seed-${replica.actorId}-${sha256Hex(document.id).slice(0, 24)}`, actorId: replica.actorId, clock: 1,
        source: { kind: 'import', label: '首次接入的本机基线' }, createdAt: document.updatedAt,
      });
      seeds.push(seed);
    }
    replica = { ...replica, outbox: [...seeds, ...replica.outbox] };
  }
  let uploaded = 0;
  for (const operation of replica.outbox.slice(0, 100)) {
    const receipt = await apiRequest<ReplicaEvent>(config, '/api/v2/operations', { method: 'POST', body: operation });
    if (receipt.id !== operation.id || !Number.isSafeInteger(receipt.sequence) || !["applied", "conflict"].includes(receipt.status) || receipt.digest !== sha256Hex(canonicalJson(operation))) throw new Error('上传回执身份不一致');
    if (receipt.sequence <= replica.cursor) {
      replica = { ...replica, receipts: { ...replica.receipts, ...(Object.prototype.hasOwnProperty.call(replica.receipts, operation.id) ? { [operation.id]: { ...replica.receipts[operation.id], pendingSync: false, remoteStatus: receipt.status } } : {}) }, outbox: replica.outbox.filter((item) => item.id !== operation.id),
        audit: replica.audit.map((item) => item.id === operation.id ? { ...item, status: receipt.status === 'applied' ? 'synced' : 'conflict' } : item) };
    }
    uploaded++;
  }
  let hasMore = false, downloaded = 0;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await apiRequest<EventPage>(config, `/api/v2/events?after=${replica.cursor}`, { maxResponseBytes: OPERATION_LIMITS.pageBytes });
    checkStatus(page);
    if (page.spaceId !== replica.remoteId) throw new Error('接收期间同步空间发生变化');
    const next = applyReplicaEvents(replica, page.events);
    assertWorkspaceBudget(next.remote!.workspace);
    if (page.hasMore && next.cursor <= replica.cursor) throw new Error('操作流没有前进');
    replica = next; downloaded += page.events.length; hasMore = page.hasMore;
    if (!hasMore) break;
  }
  const result = projectReplicaWorkspace(workspace, { ...replica, initialWorkspace: undefined });
  assertWorkspaceBudget(result.workspace);
  return { ...result, hasMore: hasMore || result.replica.outbox.length > 0,
    summary: { uploaded, downloaded, deleted: 0,
      conflicts: [...result.replica.conflicts.filter((item) => !item.resolved), ...result.pendingConflicts]
        .map((item) => item.conflicts.map((conflict) => conflict.message).join('、')) } };
};
