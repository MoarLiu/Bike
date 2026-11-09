import type { OutlineDocument, OutlineNode, Workspace } from './types';
import { uuid } from './id';
import { createNode, findNode, flattenNodes, removeNode, updateNode } from './tree';
import { addRelation, anchorMarkdownReferences, knowledgeEditable, renameTarget, withFieldText } from './knowledge';
import { assertValueBudget } from '../shared/bike-limits.mjs';
import { BIKE_TEMPLATES, BIKE_TEMPLATE_VERSION } from '../shared/bike-templates.mjs';
import { applyWorkspaceOperation, initialPositions } from '../shared/bike-operations.mjs';
import { createWorkspaceProposal } from '../shared/bike-proposals.mjs';
import type { WorkspaceProposal } from '../shared/bike-proposals.mjs';

export type KnowledgeAction = 'summary' | 'reorder' | 'dedupe' | 'tasks' | 'relations' | 'prd-template' | 'tasks-template' | 'meeting-template';
export const KNOWLEDGE_ACTIONS: Array<{ id: KnowledgeAction; label: string }> = [
  { id: 'summary', label: '子树总结' }, { id: 'reorder', label: '结构重排' }, { id: 'dedupe', label: '去重合并' },
  { id: 'tasks', label: '任务拆解' }, { id: 'relations', label: '关系建议' },
  { id: 'prd-template', label: 'PRD 模板' }, { id: 'tasks-template', label: '任务模板' }, { id: 'meeting-template', label: '会议纪要模板' },
];
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, maximum = 10_000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error('模型返回了空文本或超限文本');
  return value.trim();
};
const array = (value: unknown, maximum = 100): unknown[] => {
  if (!Array.isArray(value) || !value.length || value.length > maximum) throw new Error('模型候选数量无效或超过预算');
  return value;
};
const clearSource = (document: OutlineDocument): OutlineDocument => {
  const next = { ...document, knowledge: anchorMarkdownReferences(document) as OutlineDocument['knowledge'] };
  delete next.markdownSource; delete next.markdownUpdatedAt;
  return next;
};
const replace = (workspace: Workspace, document: OutlineDocument): Workspace => ({ ...workspace, documents: workspace.documents.map((item) => item.id === document.id ? document : item) });
export const workflowContext = (document: OutlineDocument, nodeId: string | null) => {
  const selected = nodeId ? findNode(document.nodes, nodeId) : null;
  if (nodeId && !selected) throw new Error('选择的主题已不存在');
  const nodes = selected ? [selected] : document.nodes;
  const flat = flattenNodes(nodes);
  if (flat.length > 2000) throw new Error('选中内容超过 2,000 个主题，请缩小 AI 范围');
  const context = { documentTitle: document.title, selectedNodeId: nodeId, nodes: flat.map(({ node, parentId }) => ({
    id: node.id, parentId, text: node.text, note: node.note, isTodo: node.isTodo, checked: node.checked,
  })) };
  assertValueBudget(context, { maxBytes: 256 * 1024, maxValues: 30_000 });
  return context;
};
const templateId = (action: KnowledgeAction) => action === 'prd-template' ? 'outline_to_prd' : action === 'tasks-template' ? 'outline_to_tasks' : 'outline_to_meeting';
export const workflowInstructions = (action: KnowledgeAction) => {
  const instructions: Record<string, string> = {
    summary: `${BIKE_TEMPLATES.summarize_outline.instruction}\n输出 {"text":"总结"}。`,
    reorder: '仅提出已有主题的移动，保持主题身份和集合。输出 {"moves":[{"nodeId":"已有id","parentId":null,"afterId":null,"reason":"依据"}]}。parentId 为 null 表示选中范围根部，afterId 为 null 表示第一个位置。禁止形成环。',
    dedupe: '识别语义重复候选，同名本身不足以判断重复。输出 {"merges":[{"keepId":"保留id","removeIds":["合并id"],"reason":"重复依据"}]}。不得删除独有信息，程序会保留原备注和子主题，并展示引用影响。',
    tasks: '根据给定资料拆解可勾选的任务。保留原任务状态，不编造已确认的负责人或日期。输出 {"tasks":[{"text":"任务（未明确项标待确认）","children":[{"text":"验收标准"}]}]}。',
    relations: '只建议给定同文档主题之间的有向关系。输出 {"relations":[{"fromNodeId":"已有id","toNodeId":"已有id","label":"关系标签","reason":"资料依据"}]}。排除自身关系和重复关系。',
  };
  return instructions[action] ?? `${BIKE_TEMPLATES[templateId(action)].instruction}\n输出 {"title":"文档标题","nodes":[{"text":"主题","children":[]}]}。默认作为新文档预览。`;
};
const generatedNodes = (input: unknown, task = false, depth = 0): OutlineNode[] => {
  if (depth > 16) throw new Error('模型主题超过 16 层');
  return array(input).map((item) => {
    if (!record(item) || Object.keys(item).some((key) => !['text', 'children'].includes(key))) throw new Error('模型主题含有不允许的字段');
    const node = createNode(text(item.text, 5000));
    node.isTodo = task; node.checked = false;
    node.children = item.children === undefined || (Array.isArray(item.children) && item.children.length === 0) ? [] : generatedNodes(item.children, task, depth + 1);
    return node;
  });
};

export const buildKnowledgeProposal = (workspace: Workspace, documentId: string, nodeId: string | null,
  action: KnowledgeAction, output: unknown, destination: 'child' | 'note' = 'child'): WorkspaceProposal => {
  assertValueBudget(output, { maxBytes: 2 * 1024 * 1024, maxDepth: 64, maxValues: 20_000 });
  if (!record(output)) throw new Error('模型候选必须为结构化对象');
  const document = workspace.documents.find((item) => item.id === documentId);
  if (!document) throw new Error('目标文档已不存在');
  const context = workflowContext(document, nodeId), allowed = new Set(context.nodes.map((node) => node.id));
  const requireId = (value: unknown) => { if (typeof value !== 'string' || !allowed.has(value)) throw new Error('模型候选使用了范围外主题'); return value; };
  const label = KNOWLEDGE_ACTIONS.find((item) => item.id === action)!.label;
  const candidates: Array<{ id: string; label: string; workspace: Workspace; dependsOn?: string[] }> = [];
  if (action === 'summary') {
    const summary = text(output.text);
    let updated: OutlineDocument;
    if (destination === 'note') {
      if (!nodeId) throw new Error('写入备注需要选择一个主题');
      const node = findNode(document.nodes, nodeId)!;
      updated = withFieldText(document, { nodeId, field: 'note', text: `${node.note ? `${node.note}\n\n` : ''}摘要\n${summary}` }) as OutlineDocument;
    } else {
      const node = createNode(`摘要 · ${nodeId ? findNode(document.nodes, nodeId)!.text : document.title}`); node.note = summary;
      updated = { ...document, nodes: nodeId ? updateNode(document.nodes, nodeId, (target) => { target.children = [...target.children, node]; target.collapsed = false; }) : [...document.nodes, node] };
    }
    candidates.push({ id: 'summary', label, workspace: replace(workspace, clearSource(updated)) });
  } else if (action === 'tasks') {
    const nodes = generatedNodes(output.tasks, true);
    nodes.forEach((node, index) => {
      const updated = { ...document, nodes: nodeId ? updateNode(document.nodes, nodeId, (target) => { target.children = [...target.children, node]; target.collapsed = false; }) : [...document.nodes, node] };
      candidates.push({ id: `task-${String(index).padStart(3, '0')}`, label: node.text, workspace: replace(workspace, clearSource(updated)) });
    });
  } else if (action === 'reorder') {
    const positions = initialPositions(workspace);
    const moves = array(output.moves).map((item) => {
      if (!record(item)) throw new Error('移动候选无效');
      const id = requireId(item.nodeId); if (id === nodeId) throw new Error('不能将选中范围根节点移出范围');
      const parentId = item.parentId === null ? nodeId : requireId(item.parentId);
      const afterId = item.afterId === null ? null : requireId(item.afterId);
      text(item.reason, 1000);
      return { type: 'move-node', documentId, nodeId: id, before: positions[documentId][id], position: { parentId, afterId } };
    });
    const result = applyWorkspaceOperation(workspace, positions, { protocol: 2, id: uuid(), actorId: 'proposal', batchId: uuid(), clock: 1,
      createdAt: new Date().toISOString(), source: { kind: 'ai', label }, changes: moves, resolves: [] });
    if (result.status !== 'applied') throw new Error(result.conflicts.map((item) => item.message).join('、'));
    const updated = result.workspace.documents.find((item) => item.id === documentId)!;
    candidates.push({ id: 'reorder', label, workspace: replace(result.workspace, clearSource(updated)) });
  } else if (action === 'relations') {
    if (document.knowledge && !knowledgeEditable(document.knowledge)) throw new Error('未知知识格式受到保护，请升级后编辑关系');
    let updated = document;
    for (const item of array(output.relations)) {
      if (!record(item)) throw new Error('关系候选无效');
      text(item.reason, 1000);
      const result = addRelation(updated, { fromNodeId: requireId(item.fromNodeId), toNodeId: requireId(item.toNodeId), label: text(item.label, 300), id: uuid() });
      if (result.error) throw new Error(result.error);
      updated = result.document as OutlineDocument;
    }
    candidates.push({ id: 'relations', label, workspace: replace(workspace, updated) });
  } else if (action === 'dedupe') {
    let result = workspace;
    const removed = new Set<string>();
    for (const item of array(output.merges, 20)) {
      if (!record(item)) throw new Error('合并候选无效');
      const keepId = requireId(item.keepId), removeIds = array(item.removeIds, 20).map(requireId);
      text(item.reason, 1000);
      if (removeIds.includes(keepId) || removed.has(keepId)) throw new Error('合并目标互相冲突');
      for (const removeId of removeIds) {
        const current = result.documents.find((entry) => entry.id === documentId)!;
        const keep = findNode(current.nodes, keepId), remove = findNode(current.nodes, removeId);
        if (!keep || !remove || removed.has(removeId) || findNode(remove.children, keepId) || findNode(keep.children, removeId)) throw new Error('合并目标不能有祖先关系或重复使用');
        const anchored = anchorMarkdownReferences(current);
        if (current.knowledge && !knowledgeEditable(anchored)) throw new Error('此文档包含未知知识格式，请升级后再合并');
        const sourceReferences = knowledgeEditable(anchored) ? anchored.references.filter((reference) => reference.source.kind === 'node-field' && reference.source.nodeId === removeId) : [];
        const notePrefix = keep.note ? `${keep.note}\n\n` : '';
        const textOffset = notePrefix.length + '合并来源 · '.length;
        const noteOffset = notePrefix.length + `合并来源 · ${remove.text}`.length + (remove.note ? 2 : 0);
        result = renameTarget(result, { documentId, nodeId: removeId, nextLabel: keep.text }).workspace as Workspace;
        result = { ...result, documents: result.documents.map((entry) => {
          let next = entry;
          const knowledge = anchorMarkdownReferences(next);
          if (knowledgeEditable(knowledge)) {
            const outgoing = new Map(sourceReferences.map((reference) => [reference.id, reference]));
            const references = knowledge.references.filter((reference) => !outgoing.has(reference.id)).concat(entry.id === documentId ? sourceReferences : []).map((reference) => {
              const target = reference.target.documentId === documentId && reference.target.nodeId === removeId ? { ...reference.target, nodeId: keepId } : reference.target;
              if (entry.id !== documentId || !outgoing.has(reference.id)) return { ...reference, target };
              const original = outgoing.get(reference.id)!;
              const offset = original.source.field === 'text' ? textOffset : noteOffset;
              return { ...original, target, source: { ...original.source, nodeId: keepId, field: 'note',
                start: original.source.start < 0 ? -1 : original.source.start + offset,
                end: original.source.end < 0 ? -1 : original.source.end + offset } };
            });
            const relations = knowledge.relations.map((relation) => ({ ...relation,
              fromNodeId: entry.id === documentId && relation.fromNodeId === removeId ? keepId : relation.fromNodeId,
              toNodeId: entry.id === documentId && relation.toNodeId === removeId ? keepId : relation.toNodeId,
            })).filter((relation, index, all) => relation.fromNodeId !== relation.toNodeId && all.findIndex((other) => other.fromNodeId === relation.fromNodeId && other.toNodeId === relation.toNodeId) === index);
            const sourceGroups = knowledge.sourceGroups && Object.fromEntries(Object.entries(knowledge.sourceGroups).map(([id, group]) => [id,
              entry.id === documentId ? { ...group, candidates: group.candidates.map((candidate) => candidate.nodeId === removeId ? { nodeId: keepId, field: 'note' } : candidate) } : group]));
            next = { ...next, knowledge: { ...knowledge, references, relations, ...(sourceGroups ? { sourceGroups } : {}) } };
          }
          if (entry.id === documentId) {
            let nodes = removeNode(next.nodes, removeId);
            nodes = updateNode(nodes, keepId, (target) => {
              target.children = [...target.children, ...remove.children];
              target.note = [target.note, `合并来源 · ${remove.text}`, remove.note].filter(Boolean).join('\n\n');
              const refs = [...(target.attachmentRefs ?? []), ...(remove.attachmentRefs ?? [])];
              if (refs.length) target.attachmentRefs = refs;
              const extended = target as OutlineNode & { mergedNodeData?: Record<string, unknown> };
              const { children, ...retainedFields } = remove;
              extended.mergedNodeData = { ...extended.mergedNodeData, [removeId]: retainedFields };
            });
            next = clearSource({ ...next, nodes });
          }
          return next;
        }) };
        removed.add(removeId);
      }
    }
    candidates.push({ id: 'dedupe', label: '合并主题及引用迁移', workspace: result });
  } else {
    const nodes = generatedNodes(output.nodes), id = uuid(), at = new Date().toISOString();
    const document: OutlineDocument = { id, title: text(output.title, 300), createdAt: at, updatedAt: at, nodes };
    candidates.push({ id: 'template', label: `新建 ${document.title}`, workspace: { ...workspace, documents: [...workspace.documents, document] } });
  }
  return createWorkspaceProposal(workspace, candidates, { id: uuid(), label, source: { kind: 'ai', label,
    ...(action.endsWith('-template') ? { template: templateId(action), version: BIKE_TEMPLATE_VERSION } : {}) }, targetDocumentIds: [documentId] });
};
