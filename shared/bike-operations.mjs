import { assertDocumentBudget, assertValueBudget } from './bike-limits.mjs';
import { validateDocumentAttachments } from './bike-attachments.mjs';

export const OPERATION_PROTOCOL = 2;
export const OPERATION_CAPABILITY = 'node-operations-v2';
export const OPERATION_LIMITS = Object.freeze({
  bytes: 4 * 1024 * 1024, changes: 4000, pageBytes: 16 * 1024 * 1024, checkpointBytes: 160 * 1024 * 1024,
  pageSize: 100, outboxBytes: 32 * 1024 * 1024, auditEntries: 200,
  proposalBytes: 2 * 1024 * 1024, proposalGroups: 100, proposalTtlMs: 15 * 60 * 1000,
  attachmentChunkBytes: 1024 * 1024, attachmentConcurrent: 2,
});

export const canonicalJson = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
export const equalValue = (left, right) => canonicalJson(left) === canonicalJson(right);
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const setOwn = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
const identity = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
const documentFields = (document) => Object.fromEntries(Object.entries(document).filter(([key, value]) =>
  !['id', 'nodes', 'updatedAt', 'markdownUpdatedAt'].includes(key) && value !== undefined));
const nodeFields = (node) => Object.fromEntries(Object.entries(node).filter(([key, value]) => !['id', 'children'].includes(key) && value !== undefined));
export const sameOperationDocument = (left, right) => left === right || Boolean(left && right &&
  equalValue({ ...documentFields(left), id: left.id, nodes: left.nodes }, { ...documentFields(right), id: right.id, nodes: right.nodes }));

export const indexOperationNodes = (document) => {
  const result = new Map();
  const walk = (nodes, parentId) => {
    let afterId = null;
    for (const node of nodes) {
      if (!identity(node.id) || result.has(node.id)) throw new Error('主题身份无效或重复');
      if (typeof node.text !== 'string' || !Array.isArray(node.children) || (node.note !== undefined && typeof node.note !== 'string')) throw new Error('主题内容格式无效');
      for (const field of ['checked', 'collapsed', 'bold', 'italic', 'underline', 'strike', 'highlight', 'isTodo'])
        if (node[field] !== undefined && typeof node[field] !== 'boolean') throw new Error('主题布尔字段格式无效');
      if (node.table !== undefined && (!Array.isArray(node.table) || node.table.some((row) => !Array.isArray(row) || row.some((cell) => typeof cell !== 'string')))) throw new Error('表格格式无效');
      result.set(node.id, { value: nodeFields(node), parentId, afterId });
      afterId = node.id;
      walk(node.children, node.id);
    }
  };
  if (document) { assertDocumentBudget(document); walk(document.nodes, null); }
  return result;
};

export const initialPositions = (workspace) => Object.fromEntries(workspace.documents.map((document) => [document.id,
  Object.fromEntries([...indexOperationNodes(document)].map(([id, node]) => [id, {
    parentId: node.parentId, afterId: node.afterId, clock: 0, stamp: id,
  }]))]));

// The longest stationary subsequence prevents an insertion or a move from
// producing an update for every later sibling.
const stationaryIds = (before, after) => {
  const indices = new Map(before.map((id, index) => [id, index]));
  const items = after.filter((id) => indices.has(id));
  const tails = [], previous = new Array(items.length).fill(-1);
  for (let index = 0; index < items.length; index++) {
    const value = indices.get(items[index]);
    let low = 0, high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (indices.get(items[tails[middle]]) < value) low = middle + 1;
      else high = middle;
    }
    if (low) previous[index] = tails[low - 1];
    tails[low] = index;
  }
  const stable = new Set();
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]) stable.add(items[index]);
  return stable;
};
const siblingGroups = (nodes) => {
  const result = new Map();
  for (const [id, item] of nodes) {
    if (!result.has(item.parentId)) result.set(item.parentId, []);
    result.get(item.parentId).push(id);
  }
  return result;
};
const valueSlot = (value, field) => own(value, field) ? { present: true, value: clone(value[field]) } : { present: false };
const fieldChanges = (documentId, nodeId, before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .sort().filter((field) => !equalValue(valueSlot(before, field), valueSlot(after, field)))
  .map((field) => ({ type: 'field', documentId, nodeId, field, before: valueSlot(before, field), after: valueSlot(after, field) }));

export const createWorkspaceOperation = (before, after, {
  id, actorId, clock = 1, batchId = id, source = { kind: 'user', label: '编辑' },
  createdAt = new Date().toISOString(), positions = initialPositions(before), resolves = [], resolutionBaselines = {},
}) => {
  const changes = [];
  const oldDocuments = new Map(before.documents.map((document) => [document.id, document]));
  const newDocuments = new Map(after.documents.map((document) => [document.id, document]));
  for (const documentId of new Set([...oldDocuments.keys(), ...newDocuments.keys()])) {
    const oldDocument = oldDocuments.get(documentId), document = newDocuments.get(documentId);
    if (oldDocument === document) continue;
    if (!oldDocument) { changes.push({ type: 'create-document', documentId, document: clone(document), restore: ['undo', 'redo', 'restore', 'conflict'].includes(source.kind) }); continue; }
    if (!document) { changes.push({ type: 'delete-document', documentId, before: clone(oldDocument) }); continue; }
    changes.push(...fieldChanges(documentId, null, documentFields(oldDocument), documentFields(document)));
    const oldNodes = indexOperationNodes(oldDocument), nodes = indexOperationNodes(document);
    const oldGroups = siblingGroups(oldNodes), groups = siblingGroups(nodes);
    const stable = new Set();
    for (const [parent, ids] of groups) {
      for (const nodeId of stationaryIds(oldGroups.get(parent) ?? [], ids)) stable.add(nodeId);
    }
    for (const [nodeId, node] of oldNodes) {
      if (!nodes.has(nodeId)) changes.push({ type: 'delete-node', documentId, nodeId, before: clone(node.value),
        parentId: node.parentId, position: clone(positions[documentId]?.[nodeId] ?? { parentId: node.parentId, afterId: node.afterId, clock: 0, stamp: nodeId }) });
    }
    for (const [nodeId, node] of nodes) {
      const oldNode = oldNodes.get(nodeId);
      if (!oldNode) changes.push({ type: 'insert-node', documentId, nodeId, value: clone(node.value),
        position: { parentId: node.parentId, afterId: node.afterId }, restore: ['undo', 'redo', 'restore', 'conflict'].includes(source.kind) });
      else {
        changes.push(...fieldChanges(documentId, nodeId, oldNode.value, node.value));
        if (!stable.has(nodeId) || oldNode.parentId !== node.parentId) changes.push({ type: 'move-node', documentId, nodeId,
          before: { parentId: oldNode.parentId, ...(positions[documentId]?.[nodeId] ?? {}) },
          position: { parentId: node.parentId, afterId: node.afterId } });
      }
    }
  }
  const operation = { protocol: OPERATION_PROTOCOL, id, actorId, clock, batchId, source: clone(source), createdAt, changes, resolves, resolutionBaselines };
  validateWorkspaceOperation(operation);
  return operation;
};

export const validateWorkspaceOperation = (operation) => {
  assertValueBudget(operation, { maxDepth: 600, maxBytes: OPERATION_LIMITS.bytes, maxValues: 200_000 });
  if (!operation || operation.protocol !== OPERATION_PROTOCOL) throw new Error('操作协议需要升级');
  for (const field of ['id', 'actorId', 'batchId']) if (!identity(operation[field])) throw new Error(`无效操作身份 ${field}`);
  if (!Number.isSafeInteger(operation.clock) || operation.clock < 1) throw new Error('无效逻辑时钟');
  if (!['user', 'ai', 'mcp', 'undo', 'redo', 'restore', 'import', 'conflict'].includes(operation.source?.kind) ||
      typeof operation.source.label !== 'string' || operation.source.label.length > 300) throw new Error('无效操作来源');
  if (Object.keys(operation.source).some((key) => !['kind', 'label', 'template', 'version'].includes(key))) throw new Error('操作来源包含私有字段');
  if (!Number.isFinite(Date.parse(operation.createdAt))) throw new Error('无效操作时间');
  if (!Array.isArray(operation.resolves) || operation.resolves.length > 100 || !operation.resolves.every(identity)) throw new Error('无效冲突关联');
  if (operation.resolutionBaselines !== undefined && (!operation.resolutionBaselines || typeof operation.resolutionBaselines !== 'object' || Array.isArray(operation.resolutionBaselines) || Object.entries(operation.resolutionBaselines).some(([id, digest]) => !identity(id) || !(digest === null || /^[a-f0-9]{64}$/.test(digest))))) throw new Error('无效解决基线');
  if (!Array.isArray(operation.changes) || operation.changes.length > OPERATION_LIMITS.changes) throw new Error('操作超过变更预算');
  const targets = new Set();
  for (const change of operation.changes) {
    if (!identity(change.documentId)) throw new Error('无效目标文档');
    if (!['field', 'create-document', 'delete-document', 'insert-node', 'delete-node', 'move-node'].includes(change.type)) throw new Error('不支持的操作');
    if (change.nodeId != null && !identity(change.nodeId)) throw new Error('无效目标主题');
    const target = canonicalJson([change.documentId, change.nodeId ?? null, change.type, change.field ?? null]);
    if (targets.has(target)) throw new Error('操作包含重复目标');
    targets.add(target);
    if (change.type === 'field') {
      if (!identity(change.field) || ['id', 'children', 'nodes', 'updatedAt', 'markdownUpdatedAt'].includes(change.field)) throw new Error('受保护的字段');
      for (const slot of [change.before, change.after]) {
        if (!slot || typeof slot.present !== 'boolean' || (slot.present && !own(slot, 'value'))) throw new Error('无效字段候选');
      }
    }
    if (change.type.endsWith('-node') && !identity(change.nodeId)) throw new Error('缺少主题身份');
    if (['insert-node', 'move-node'].includes(change.type)) {
      if (!change.position || [change.position.parentId, change.position.afterId].some((id) => id !== null && !identity(id)) ||
          change.position.parentId === change.nodeId || change.position.afterId === change.nodeId) throw new Error('无效主题位置');
    }
    if (['insert-node', 'delete-node'].includes(change.type)) {
      const value = change.type === 'insert-node' ? change.value : change.before;
      if (!value || typeof value !== 'object' || Array.isArray(value) || own(value, 'id') || own(value, 'children')) throw new Error('无效主题内容');
    }
    if (change.type === 'create-document') validateOperationDocument(change.document, change.documentId);
    if (change.type === 'delete-document') validateOperationDocument(change.before, change.documentId);
  }
  return operation;
};
const validateOperationDocument = (document, id) => {
  if (!document || document.id !== id || typeof document.title !== 'string' || !document.title.trim()) throw new Error('无效文档内容');
  indexOperationNodes(document);
  validateDocumentAttachments(document);
};

const rebuildDocument = (document, nodes, positions) => {
  const byParent = new Map();
  for (const [id, item] of nodes) {
    const position = positions[id];
    if (!position || (position.parentId !== null && !nodes.has(position.parentId))) throw new Error('主题父级已删除或不存在');
    if (!byParent.has(position.parentId)) byParent.set(position.parentId, []);
    byParent.get(position.parentId).push(id);
  }
  const ordered = (parent) => {
    const ids = byParent.get(parent) ?? [];
    const idSet = new Set(ids), byAnchor = new Map();
    const anchorFor = (id) => {
      let anchor = positions[id].afterId;
      const visited = new Set([id]);
      while (anchor !== null && !idSet.has(anchor)) {
        if (visited.has(anchor) || !positions[anchor] || positions[anchor].parentId !== parent) throw new Error('主题排序锚点已变化或无效');
        visited.add(anchor);
        anchor = positions[anchor].afterId;
      }
      return anchor;
    };
    for (const id of ids) {
      const anchor = anchorFor(id);
      if (!byAnchor.has(anchor)) byAnchor.set(anchor, []);
      byAnchor.get(anchor).push(id);
    }
    const compare = (a, b) => positions[b].clock - positions[a].clock ||
      (positions[a].stamp < positions[b].stamp ? -1 : positions[a].stamp > positions[b].stamp ? 1 : a < b ? -1 : 1);
    for (const items of byAnchor.values()) items.sort(compare);
    const result = [], visited = new Set();
    const stack = [...(byAnchor.get(null) ?? [])].reverse();
    while (stack.length) {
      const id = stack.pop();
      if (visited.has(id)) throw new Error('主题顺序形成环');
      visited.add(id); result.push(id);
      const following = byAnchor.get(id) ?? [];
      for (let index = following.length - 1; index >= 0; index--) stack.push(following[index]);
    }
    if (result.length !== ids.length) throw new Error('主题顺序形成环');
    return result;
  };
  const visited = new Set();
  const build = (parent, depth) => {
    if (depth > 256) throw new Error('主题层级超过预算');
    return ordered(parent).map((id) => {
      if (visited.has(id)) throw new Error('主题形成环或重复父级');
      visited.add(id);
      return { id, ...nodes.get(id).value, children: build(id, depth + 1) };
    });
  };
  const result = { ...document, nodes: build(null, 0) };
  if (visited.size !== nodes.size) throw new Error('并发移动形成环');
  validateOperationDocument(result, document.id);
  return result;
};

export const applyWorkspaceOperation = (workspace, originalPositions, operation) => {
  validateWorkspaceOperation(operation);
  const documents = new Map(workspace.documents.map((document) => [document.id, clone(document)]));
  const positions = clone(originalPositions);
  const nodeMaps = new Map();
  const conflicts = [];
  const conflict = (change, current, message) => conflicts.push({
    documentId: change.documentId, nodeId: change.nodeId ?? null, field: change.field ?? change.type,
    baseline: clone(change.before), current: clone(current), candidate: clone(change.after ?? change.value ?? change.position ?? null), message,
  });
  for (const change of operation.changes) {
    const document = documents.get(change.documentId);
    if (change.type === 'create-document') {
      if (document) { if (!sameOperationDocument(document, change.document)) conflict(change, document, '文档身份已存在'); }
      else {
        documents.set(change.documentId, clone(change.document));
        setOwn(positions, change.documentId, initialPositions({ documents: [change.document] })[change.documentId]);
      }
      continue;
    }
    if (!document) { conflict(change, null, '目标文档已删除'); continue; }
    if (change.type === 'delete-document') {
      if (!sameOperationDocument(document, change.before)) conflict(change, document, '删除与远端编辑冲突');
      else documents.delete(change.documentId);
      continue;
    }
    if (!nodeMaps.has(change.documentId)) nodeMaps.set(change.documentId, indexOperationNodes(document));
    const nodes = nodeMaps.get(change.documentId);
    const node = change.nodeId ? nodes.get(change.nodeId) : null;
    if (!own(positions, change.documentId)) setOwn(positions, change.documentId, initialPositions({ documents: [document] })[change.documentId]);
    const documentPositions = positions[change.documentId];
    if (change.type === 'field') {
      const fields = change.nodeId === null ? document : node?.value;
      if (!fields) { conflict(change, null, '目标主题已删除'); continue; }
      const current = valueSlot(fields, change.field);
      if (!equalValue(current, change.before) && !equalValue(current, change.after)) { conflict(change, current, '同一字段有并发修改'); continue; }
      if (change.after.present) Object.defineProperty(fields, change.field, { value: clone(change.after.value), enumerable: true, writable: true, configurable: true });
      else delete fields[change.field];
    } else if (change.type === 'insert-node') {
      if (node) { if (!equalValue(node.value, change.value)) conflict(change, node.value, '主题身份已存在'); continue; }
      if (own(documentPositions, change.nodeId) && !(change.restore === true && ['undo', 'redo', 'restore', 'conflict'].includes(operation.source.kind))) { conflict(change, null, '已删除的主题需要显式恢复'); continue; }
      nodes.set(change.nodeId, { value: clone(change.value) });
      setOwn(documentPositions, change.nodeId, { ...change.position, clock: operation.clock, stamp: operation.id });
    } else if (change.type === 'delete-node') {
      if (!node) continue;
      if (!equalValue(node.value, change.before) || documentPositions[change.nodeId]?.parentId !== change.parentId) {
        conflict(change, node.value, '删除与编辑或移动冲突'); continue;
      }
      nodes.delete(change.nodeId);
    } else if (change.type === 'move-node') {
      if (!node) { conflict(change, null, '移动的主题已删除'); continue; }
      const current = documentPositions[change.nodeId];
      if (!equalValue(originalPositions[change.documentId]?.[change.nodeId] ?? current, change.before)) { conflict(change, current, '同一主题有并发移动'); continue; }
      // Detach the moving item without dragging its old following siblings.
      for (const [id, position] of Object.entries(documentPositions)) {
        if (id !== change.nodeId && position.parentId === current.parentId && position.afterId === change.nodeId)
          position.afterId = current.afterId;
      }
      setOwn(documentPositions, change.nodeId, { ...change.position, clock: operation.clock, stamp: operation.id });
    }
  }
  if (!conflicts.length) {
    try {
      for (const [id, nodes] of nodeMaps) {
        const document = documents.get(id);
        if (document) documents.set(id, rebuildDocument(document, nodes, positions[id]));
      }
      for (const change of operation.changes) {
        const document = documents.get(change.documentId);
        if (document) {
          document.updatedAt = operation.createdAt;
          if (document.markdownSource !== undefined) document.markdownUpdatedAt = operation.createdAt;
        }
      }
    } catch (error) { conflicts.push({ documentId: operation.changes[0]?.documentId, nodeId: null, field: 'structure', message: error.message }); }
  }
  if (conflicts.length) return { status: 'conflict', workspace, positions: originalPositions, conflicts };
  const nextDocuments = workspace.documents.filter((document) => documents.has(document.id)).map((document) => documents.get(document.id));
  const existing = new Set(nextDocuments.map((document) => document.id));
  for (const [id, document] of documents) if (!existing.has(id)) nextDocuments.push(document);
  return { status: 'applied', workspace: { ...workspace, documents: nextDocuments,
    activeDocumentId: documents.has(workspace.activeDocumentId) ? workspace.activeDocumentId : nextDocuments[0]?.id ?? '' }, positions, conflicts: [] };
};

// Generate a compensating operation against the latest state. Only fields
// touched by the original action are reverted. Remote changes remain intact.
export const compensateWorkspaceChange = (current, before, after, options) => {
  const inverse = createWorkspaceOperation(after, before, options);
  return { operation: inverse, ...applyWorkspaceOperation(current, options.positions ?? initialPositions(current), inverse) };
};

export const operationSummary = (operation) => operation.changes.map((change) => ({
  type: change.type, documentId: change.documentId, nodeId: change.nodeId ?? null, field: change.field,
  before: clone(change.before), after: clone(change.after ?? change.value ?? change.position ?? change.document ?? null),
}));

export const invertWorkspaceOperation = (operation, { id, actorId, clock, createdAt = new Date().toISOString() }) => ({
  protocol: OPERATION_PROTOCOL, id, actorId, clock, batchId: id, createdAt, source: { kind: 'restore', label: `恢复 ${operation.source.label}`.slice(0, 300) }, resolves: [], resolutionBaselines: {},
  changes: [...operation.changes].reverse().map((change) => {
    if (change.type === 'field') return { ...change, before: clone(change.after), after: clone(change.before) };
    if (change.type === 'create-document') return { type: 'delete-document', documentId: change.documentId, before: clone(change.document) };
    if (change.type === 'delete-document') return { type: 'create-document', documentId: change.documentId, document: clone(change.before), restore: true };
    if (change.type === 'insert-node') return { type: 'delete-node', documentId: change.documentId, nodeId: change.nodeId, before: clone(change.value), parentId: change.position.parentId };
    if (change.type === 'delete-node') return { type: 'insert-node', documentId: change.documentId, nodeId: change.nodeId, value: clone(change.before), position: { parentId: change.position.parentId, afterId: change.position.afterId }, restore: true };
    if (change.type === 'move-node') return { ...change, before: { ...change.position, clock: operation.clock, stamp: operation.id }, position: { parentId: change.before.parentId, afterId: change.before.afterId } };
    throw new Error('此操作暂不支持恢复');
  }),
});
