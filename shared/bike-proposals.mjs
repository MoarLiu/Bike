import { sha256Hex } from './bike-knowledge.mjs';
import { OPERATION_LIMITS, canonicalJson, canonicalOperationDocument, createWorkspaceOperation, applyWorkspaceOperation, initialPositions, operationSummary, indexOperationNodes } from './bike-operations.mjs';
import { assertValueBudget } from './bike-limits.mjs';

const documentDigest = (document) => {
  if (!document) return null;
  return sha256Hex(canonicalOperationDocument(document));
};
export const createWorkspaceProposal = (workspace, candidates, {
  id, source, label, reason = '', workspaceId = '', targetDocumentIds = [], resolves = [], at = Date.now(),
}) => {
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > OPERATION_LIMITS.proposalGroups) throw new Error('提案组数量超过预算');
  const positions = initialPositions(workspace);
  const targets = new Set(targetDocumentIds);
  const ids = new Set(candidates.map((candidate) => candidate.id));
  if (ids.size !== candidates.length) throw new Error('提案组身份重复');
  const pathIndexes = new WeakMap();
  const pathFor = (source, change) => {
    const document = source.documents.find((item) => item.id === change.documentId);
    if (!document) return '新文档';
    if (!change.nodeId) return document.title;
    let nodes = pathIndexes.get(document);
    if (!nodes) { nodes = indexOperationNodes(document); pathIndexes.set(document, nodes); }
    const labels = [], seen = new Set();
    let id = change.nodeId;
    while (id && nodes.has(id) && !seen.has(id)) { seen.add(id); const node = nodes.get(id); labels.unshift(node.value.text || id); id = node.parentId; }
    return [document.title, ...labels].join(' / ');
  };
  const groups = candidates.map((candidate) => {
    if (!candidate.id || (candidate.dependsOn ?? []).some((dependency) => !ids.has(dependency) || dependency === candidate.id)) throw new Error('无效提案依赖');
    const operation = createWorkspaceOperation(workspace, candidate.workspace, {
      id: `${id}-${candidate.id}`, actorId: 'proposal', clock: 1, positions, source,
      createdAt: new Date(at).toISOString(), commit: true,
    });
    for (const change of operation.changes) targets.add(change.documentId);
    return { id: candidate.id, label: candidate.label, dependsOn: candidate.dependsOn ?? [], operation,
      summary: operationSummary(operation).map((change) => ({ ...change, targetPath: pathFor(workspace, change), afterPath: pathFor(candidate.workspace, change) })) };
  });
  const visited = new Set(), active = new Set();
  const visit = (id) => {
    if (active.has(id)) throw new Error('提案依赖形成环');
    if (visited.has(id)) return;
    active.add(id);
    for (const dependency of groups.find((group) => group.id === id).dependsOn) visit(dependency);
    active.delete(id); visited.add(id);
  };
  for (const group of groups) visit(group.id);
  const dependencyOrder = new Map([...visited].map((id, index) => [id, index]));
  groups.sort((left, right) => dependencyOrder.get(left.id) - dependencyOrder.get(right.id));
  if (!resolves.length && !groups.some((group) => group.operation.changes.length || group.operation.documentOrder)) throw new Error('提案没有可应用的修改');
  const proposal = { id, workspaceId, source, label, reason: reason.slice(0, 300), at,
    orderBaseline: groups.some(group => group.operation.documentOrder) ? workspace.documents.map(document => document.id) : null,
    expiresAt: at + OPERATION_LIMITS.proposalTtlMs, status: 'preview',
    resolves, resolutionBaselines: resolves.length ? Object.fromEntries([...targets].map((target) => { const document = workspace.documents.find((item) => item.id === target); return [target, documentDigest(document)]; })) : {}, baselines: Object.fromEntries([...targets].map((target) => [target, documentDigest(workspace.documents.find((document) => document.id === target))])), groups };
  assertValueBudget(proposal, { maxBytes: OPERATION_LIMITS.proposalBytes, maxDepth: 256 });
  return proposal;
};

export const proposalFreshness = (workspace, proposal, at = Date.now()) => {
  if (at >= proposal.expiresAt) return 'expired';
  if (proposal.orderBaseline && canonicalJson(proposal.orderBaseline) !== canonicalJson(workspace.documents.map(document => document.id))) return 'stale';
  for (const [id, digest] of Object.entries(proposal.baselines)) {
    if (documentDigest(workspace.documents.find((document) => document.id === id)) !== digest) return 'stale';
  }
  return 'current';
};

export const acceptProposalGroups = (workspace, proposal, selectedIds, at = Date.now()) => {
  if (proposalFreshness(workspace, proposal, at) !== 'current') throw new Error('提案已过期或目标内容已变化，请重新比较');
  const selected = new Set(selectedIds);
  if (!selected.size || [...selected].some((id) => !proposal.groups.some((group) => group.id === id))) throw new Error('请选择有效修改组');
  for (const group of proposal.groups) if (selected.has(group.id) && group.dependsOn.some((id) => !selected.has(id))) throw new Error('选中组缺少依赖，请一起接受');
  let result = workspace, positions = initialPositions(workspace);
  for (const group of proposal.groups) {
    if (!selected.has(group.id)) continue;
    const applied = applyWorkspaceOperation(result, positions, group.operation);
    if (applied.status !== 'applied') throw new Error(`提案组不能安全组合 ${applied.conflicts.map((item) => item.message).join('、')}`);
    result = applied.workspace; positions = applied.positions;
  }
  return result;
};
