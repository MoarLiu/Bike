import { OPERATION_LIMITS, OPERATION_PROTOCOL, applyWorkspaceOperation, createWorkspaceOperation, initialPositions, sameOperationDocument } from './bike-operations.mjs';

export const createReplicaState = (workspace, actorId) => ({
  protocol: OPERATION_PROTOCOL, actorId, generation: 0, clock: 0, positions: initialPositions(workspace),
  outbox: [], receipts: {}, audit: [], cursor: 0, remoteId: null, remote: null, conflicts: [], unpublishedSafe: true, initialWorkspace: { ...workspace, version: 3 },
});

const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const trimReplicaAudit = (replica) => {
  const audit = replica.audit.slice(-OPERATION_LIMITS.auditEntries);
  let retained = bytes(audit);
  while (retained > 16 * 1024 * 1024 && audit.length > 1) retained -= bytes(audit.shift());
  return { ...replica, audit };
};

export const recordReplicaCommit = (replica, before, after, { requestId, digest, source, reason = '', acceptedGroups = [], clientDigest, candidateDigest, origin, resolves = [], resolutionBaselines = {}, at, retainReceipt = true }) => {
  if (replica.protocol !== OPERATION_PROTOCOL) throw new Error('本机操作协议暂不支持');
  if (Object.hasOwn(replica.receipts, requestId)) {
    if (replica.receipts[requestId].digest !== digest) throw new Error('相同请求身份携带了不同内容');
    return { replayed: true, replica, receipt: replica.receipts[requestId] };
  }
  const operation = createWorkspaceOperation(before, after, {
    id: requestId, actorId: replica.actorId, clock: replica.clock + 1, positions: replica.positions,
    source, createdAt: at, resolves, resolutionBaselines, commit: true,
  });
  const projected = applyWorkspaceOperation(before, replica.positions, operation);
  if (projected.status !== 'applied') throw new Error(`本机操作无法应用 ${projected.conflicts.map((item) => item.message).join('、')}`);
  const candidates = new Map(after.documents.map((document) => [document.id, document]));
  if (projected.workspace.documents.length !== candidates.size ||
      projected.workspace.documents.some((document) => !sameOperationDocument(document, candidates.get(document.id)))) throw new Error('本机操作投影与候选内容不一致');
  const meaningful = operation.changes.length > 0 || operation.resolves.length > 0 || Boolean(operation.documentOrder);
  let outbox = meaningful ? [...replica.outbox, operation] : replica.outbox;
  let positions = projected.positions;
  // The wire/page budget is not a local durability quota. IndexedDB remains
  // atomic, and quota errors retain an explicit recovery copy in storage.ts.
  const receipt = { requestId, digest, operationId: meaningful ? operation.id : null, at,
    targetDocumentIds: [...new Set([...operation.changes.map((change) => change.documentId), ...Object.keys(operation.resolutionBaselines ?? {})])],
    status: 'committed', ...(clientDigest ? { clientDigest } : {}), ...(candidateDigest ? { candidateDigest } : {}), pendingSync: meaningful };
  const receipts = { ...replica.receipts, ...(retainReceipt ? { [requestId]: receipt } : {}) };
  // Before the first network attempt, no peer can have seen these operation
  // identities. Compact this unpublished queue against its retained baseline.
  // Once syncStarted is durably set, identities are immutable even after a
  // lost acknowledgement.
  if (replica.unpublishedSafe && !replica.remote && !replica.syncStarted && !resolves.length && !replica.conflicts.length &&
      replica.initialWorkspace && bytes(outbox) > 8 * 1024 * 1024) {
    try {
      const baseline = replica.initialWorkspace;
      const combined = createWorkspaceOperation(baseline, after, {
        id: requestId, actorId: replica.actorId, clock: replica.clock + 1,
        positions: initialPositions(baseline), source: { kind: 'user', label: '本机未同步编辑（合并传输）' }, createdAt: at, commit: true,
      });
      const projection = applyWorkspaceOperation(baseline, initialPositions(baseline), combined);
      if (projection.status !== 'applied' || projection.workspace.documents.length !== after.documents.length ||
          projection.workspace.documents.some((document, index) => !sameOperationDocument(document, after.documents[index]))) throw new Error('压缩投影不一致');
      const superseded = new Set(outbox.map(item => item.id));
      for (const [id, entry] of Object.entries(receipts)) {
        if (entry.pendingSync && superseded.has(entry.operationId)) receipts[id] = { ...entry, operationId: requestId };
      }
      outbox = [combined];
      positions = projection.positions;
    } catch { /* Optional compaction must never refuse an already valid local commit. */ }
  }
  // Keep idempotency identities instead of refusing future local edits at an
  // arbitrary count. Non-content navigation is skipped by the storage layer.
  const audit = meaningful ? [...replica.audit, {
    id: operation.id, operation, reason: reason.slice(0, 300), acceptedGroups, at,
    direction: 'local', status: 'pending', recoveryAvailable: true, ...(origin ? { origin } : {}),
  }] : replica.audit;
  return { replayed: false, receipt, operation, replica: trimReplicaAudit({ ...replica, clock: operation.clock, generation: (replica.generation ?? 0) + 1,
    positions, outbox, receipts, audit }) };
};

export const replicaAttachmentRoots = (replica) => {
  if (!replica) return [];
  const documents = [];
  for (const operation of [...replica.outbox, ...replica.audit.map((entry) => entry.operation), ...replica.conflicts.map((entry) => entry.operation)]) {
    for (const change of operation?.changes ?? []) {
      if (change.type === 'delete-document') documents.push(change.before);
      if (change.type === 'create-document') documents.push(change.document);
      if (change.type === 'replace-document') documents.push(change.before, change.document);
      // Field and node changes retain content hashes even if the original
      // snapshot has expired. Return them separately to the cleanup scanner.
    }
  }
  return documents.filter(Boolean);
};

export const replicaProtectedAssetIds = (replica) => {
  const assets = new Set();
  const visit = (value) => {
    if (typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)) assets.add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { visit(key); visit(item); }
  };
  visit(replica?.outbox); visit(replica?.audit); visit(replica?.conflicts);
  return [...assets];
};

export const applyReplicaEvents = (replica, events) => {
  if (!replica.remote) throw new Error('缺少经过校验的远端 checkpoint');
  let workspace = replica.remote.workspace, positions = replica.remote.positions, cursor = replica.cursor;
  let clock = replica.clock;
  const acknowledged = new Set();
  const conflicts = new Map(replica.conflicts.map((item) => [item.id, item]));
  const audit = new Map(replica.audit.map((item) => [item.id, item]));
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new Error('无效服务端顺序');
    if (event.sequence <= cursor) continue;
    if (event.sequence !== cursor + 1) throw new Error('操作消息存在缺口，请重新拉取');
    if (!event.operation || event.operation.id !== event.id || !['applied', 'conflict'].includes(event.status)) throw new Error('无效操作回执');
    if (event.status === 'applied') {
      const applied = applyWorkspaceOperation(workspace, positions, event.operation);
      if (applied.status !== 'applied') throw new Error('远端操作与 checkpoint 不一致，已停止接收');
      workspace = applied.workspace; positions = applied.positions;
      for (const id of event.operation.resolves) if (conflicts.has(id)) conflicts.set(id, { ...conflicts.get(id), resolved: true });
    } else conflicts.set(event.id, { id: event.id, operation: event.operation, conflicts: event.conflicts, resolved: event.resolved });
    clock = Math.max(clock, event.operation.clock);
    acknowledged.add(event.id);
    const previous = audit.get(event.id);
    audit.set(event.id, { ...previous, id: event.id, operation: event.operation, at: event.createdAt,
      direction: previous?.direction ?? 'remote', status: event.status === 'applied' ? 'synced' : 'conflict', recoveryAvailable: true });
    cursor = event.sequence;
  }
  const receipts = { ...replica.receipts };
  const statuses = new Map(events.filter(event => acknowledged.has(event.id)).map(event => [event.id, event.status]));
  for (const [id, entry] of Object.entries(receipts)) if (statuses.has(entry.operationId)) {
    const remoteStatus = statuses.get(entry.operationId);
    receipts[id] = { ...entry, pendingSync: false, remoteStatus };
    if (audit.has(id)) audit.set(id, { ...audit.get(id), status: remoteStatus === 'applied' ? 'synced' : 'conflict' });
  }
  return trimReplicaAudit({ ...replica, cursor, clock, receipts,
    remote: { workspace, positions, clock }, outbox: replica.outbox.filter((operation) => !acknowledged.has(operation.id)),
    conflicts: [...conflicts.values()], audit: [...audit.values()] });
};

export const projectReplicaWorkspace = (localWorkspace, replica) => {
  if (!replica.remote) throw new Error('缺少远端基线');
  let workspace = { ...replica.remote.workspace, activeDocumentId: localWorkspace.activeDocumentId, trash: localWorkspace.trash };
  let positions = replica.remote.positions;
  const pendingConflicts = [];
  for (const operation of replica.outbox) {
    const applied = applyWorkspaceOperation(workspace, positions, operation);
    if (applied.status === 'applied') { workspace = applied.workspace; positions = applied.positions; }
    else pendingConflicts.push({ id: operation.id, operation, conflicts: applied.conflicts });
  }
  // Keep a last visible document until its pending deletion can be resolved.
  // The original content remains in the operation and recovery history.
  if (!workspace.documents.length) throw new Error('远端已删除所有文档，请先从冲突或备份恢复一篇文档');
  if (!workspace.documents.some((document) => document.id === workspace.activeDocumentId)) workspace = { ...workspace, activeDocumentId: workspace.documents[0].id };
  return { workspace, replica: { ...replica, positions }, pendingConflicts };
};
