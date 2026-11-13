import type { Workspace } from './types';
import type { ReplicaState, ReplicaConflict } from '../shared/bike-replica.mjs';
import type { WorkspaceOperation, OperationChange } from '../shared/bike-operations.mjs';
import { applyWorkspaceOperation, invertWorkspaceOperation, indexOperationNodes, initialPositions, canonicalJson } from '../shared/bike-operations.mjs';
import { createWorkspaceProposal } from '../shared/bike-proposals.mjs';
import { uuid } from './id';

export const operationRecoveryProposal = (workspace: Workspace, replica: ReplicaState, operation: WorkspaceOperation) => {
  const inverse = invertWorkspaceOperation(operation, { id: uuid(), actorId: replica.actorId, clock: replica.clock + 1 });
  const applied = applyWorkspaceOperation(workspace, replica.positions, inverse);
  if (applied.status !== 'applied') throw new Error(`恢复涉及后续修改，需先比较或恢复为副本 ${applied.conflicts.map((item) => item.message).join('、')}`);
  return createWorkspaceProposal(workspace, [{ id: 'restore', label: '补偿本次操作', workspace: applied.workspace }], {
    id: uuid(), source: { kind: 'restore', label: `恢复 ${operation.source.label}` }, label: `恢复 ${operation.source.label}`,
    targetDocumentIds: operation.changes.map((change) => change.documentId),
  });
};
const slot = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key) ? { present: true, value: value[key] } : { present: false };
export const conflictResolutionProposal = (workspace: Workspace, replica: ReplicaState, conflict: ReplicaConflict, choice: 'current' | 'candidate') => {
  if (conflict.resolved) throw new Error('此冲突已解决，请刷新历史');
  let candidate = workspace;
  const positions = initialPositions(workspace);
  if (choice === 'candidate') {
    const changes: OperationChange[] = [];
    for (const original of conflict.operation.changes) {
      const document = workspace.documents.find((item) => item.id === original.documentId);
      const node = document && original.nodeId ? indexOperationNodes(document).get(original.nodeId) : null;
      if (original.type === 'create-document' && document) {
        candidate = { ...candidate, documents: candidate.documents.map((item) => item.id === document.id ? original.document! : item) }; continue;
      }
      if (original.type === 'replace-document') {
        if (!document) throw new Error('候选文档已删除，请先恢复为副本');
        changes.push({ ...original, before: document });
      } else if (original.type === 'field') {
        const value = original.nodeId === null ? document as unknown as Record<string, unknown> : node?.value;
        if (!value) throw new Error('候选主题已删除，请先在编辑器中恢复为副本，再保留当前值解决冲突');
        changes.push({ ...original, before: slot(value, original.field!) });
      } else if (original.type === 'delete-node') {
        if (node) changes.push({ ...original, before: node.value, parentId: positions[original.documentId][original.nodeId!].parentId });
      } else if (original.type === 'delete-document') {
        if (document) changes.push({ ...original, before: document });
      } else if (original.type === 'move-node') {
        if (!node) throw new Error('移动目标已删除，请手动整理');
        changes.push({ ...original, before: positions[original.documentId][original.nodeId!] });
      } else changes.push({ ...original, restore: true });
    }
    const result = applyWorkspaceOperation(candidate, positions, { ...conflict.operation, id: uuid(), batchId: uuid(),
      source: { kind: 'conflict', label: '选择冲突候选' }, changes, resolves: [] });
    if (result.status !== 'applied') throw new Error(result.conflicts.map((item) => item.message).join('、'));
    candidate = result.workspace;
  }
  const targets = [...new Set([...conflict.operation.changes.map((change) => change.documentId), ...Object.keys(conflict.operation.resolutionBaselines ?? {})])];
  const proposal = createWorkspaceProposal(workspace, [{ id: 'resolution', label: choice === 'current' ? '保留当前内容并解决' : '应用候选并解决', workspace: candidate }], {
    id: uuid(), source: { kind: 'conflict', label: '处理节点冲突' }, label: '处理节点冲突', targetDocumentIds: targets, resolves: [conflict.id],
  });
  if (!proposal.groups[0].summary.length) proposal.groups[0].summary.push({ type: 'resolve-conflict', documentId: targets[0], nodeId: null, after: { conflictId: conflict.id, choice: 'current' } });
  return proposal;
};
