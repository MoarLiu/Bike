import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceProposal, acceptProposalGroups, proposalFreshness } from '../shared/bike-proposals.mjs';
import { loadTypescript } from './helpers/typescript.mjs';
const { migrateWorkspace } = loadTypescript('src/migrations.ts');
const { buildKnowledgeProposal, workflowContext } = loadTypescript('src/knowledgeWorkflow.ts');
const { resolveDocumentConnections, attachReference } = loadTypescript('src/knowledge.ts');
const history = loadTypescript('src/editHistory.ts');
const sample = () => migrateWorkspace({ version: 3, activeDocumentId: 'doc', documents: [{ id: 'doc', title: 'Doc', nodes: [
  { id: 'a', text: 'A', note: 'original', extension: { retained: true }, children: [] }, { id: 'b', text: 'B', children: [] },
] }] });

test('summary defaults to an added child and leaves the original note intact', () => {
  const base = sample();
  const proposal = buildKnowledgeProposal(base, 'doc', 'a', 'summary', { text: 'Summary, pending verification' });
  assert.equal(base.documents[0].nodes[0].children.length, 0);
  const result = acceptProposalGroups(base, proposal, [proposal.groups[0].id]);
  assert.equal(result.documents[0].nodes[0].note, 'original');
  assert.equal(result.documents[0].nodes[0].children[0].note, 'Summary, pending verification');
});

test('task groups can be partially accepted without changing original task status', () => {
  const base = sample(); base.documents[0].nodes[0].checked = true;
  const proposal = buildKnowledgeProposal(base, 'doc', 'a', 'tasks', { tasks: [{ text: 'First' }, { text: 'Second' }] });
  const result = acceptProposalGroups(base, proposal, [proposal.groups[1].id]);
  assert.deepEqual(result.documents[0].nodes[0].children.map((node) => node.text), ['Second']);
  assert.equal(result.documents[0].nodes[0].checked, true);
  assert.equal(result.documents[0].nodes[0].children[0].isTodo, true);
  assert.equal(result.documents[0].nodes[0].children[0].checked, false);
});

test('reordering preserves all IDs and extension fields and rejects cycles or unknown IDs', () => {
  const base = sample();
  const p = buildKnowledgeProposal(base, 'doc', null, 'reorder', { moves: [{ nodeId: 'b', parentId: null, afterId: null, reason: 'B should lead' }] });
  const result = acceptProposalGroups(base, p, [p.groups[0].id]);
  assert.deepEqual(result.documents[0].nodes.map((node) => node.id), ['b', 'a']);
  assert.deepEqual(result.documents[0].nodes[1].extension, { retained: true });
  assert.throws(() => buildKnowledgeProposal(base, 'doc', null, 'reorder', { moves: [{ nodeId: 'outside', parentId: null, afterId: null, reason: 'bad' }] }), /范围外/);
  assert.throws(() => buildKnowledgeProposal(base, 'doc', null, 'reorder', { moves: [{ nodeId: 'a', parentId: 'b', afterId: null, reason: 'one' }, { nodeId: 'b', parentId: 'a', afterId: null, reason: 'two' }] }), /环/);
});

test('dedupe remaps incoming and outgoing references and preserves removed fields and descendants', () => {
  const base = sample();
  const target = base.documents[0];
  target.nodes[1].text = 'B [[Doc#A]]';
  target.nodes[1].note = 'Unique note'; target.nodes[1].extension = { unique: true };
  target.nodes[1].children.push({ ...structuredClone(target.nodes[0]), id: 'child', text: 'Child', children: [] });
  const raw = '[[Doc#A]]', start = target.nodes[1].text.indexOf(raw);
  const bound = attachReference(target, { source: { kind: 'node-field', nodeId: 'b', field: 'text', start, end: start + raw.length, raw }, target: { documentId: 'doc', nodeId: 'a' } });
  base.documents[0] = bound.document;
  const incoming = { ...structuredClone(target), id: 'incoming', title: 'Incoming', nodes: [{ ...structuredClone(target.nodes[0]), id: 'link', text: '[[Doc#B [[Doc#A]]]]', children: [] }] };
  base.documents.push(incoming);
  const p = buildKnowledgeProposal(base, 'doc', null, 'dedupe', { merges: [{ keepId: 'a', removeIds: ['b'], reason: 'same concept, preserve unique note' }] });
  const result = acceptProposalGroups(base, p, [p.groups[0].id]);
  assert.deepEqual(result.documents[0].nodes.map((node) => node.id), ['a']);
  assert.equal(result.documents[0].nodes[0].children[0].id, 'child');
  assert.match(result.documents[0].nodes[0].note, /Unique note/);
  assert.deepEqual(result.documents[0].nodes[0].mergedNodeData.b.extension, { unique: true });
  const connections = resolveDocumentConnections(result, result.documents[0]);
  assert.ok(connections.some((connection) => connection.reference?.target.nodeId === 'a' && connection.status === 'resolved'));
});

test('relation suggestions require valid endpoints and preserve the tree', () => {
  const base = sample(), p = buildKnowledgeProposal(base, 'doc', null, 'relations', { relations: [{ fromNodeId: 'a', toNodeId: 'b', label: 'supports', reason: 'source evidence' }] });
  const result = acceptProposalGroups(base, p, [p.groups[0].id]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.documents[0].nodes)), JSON.parse(JSON.stringify(base.documents[0].nodes)));
  assert.equal(result.documents[0].knowledge.relations.length, 1);
  assert.throws(() => buildKnowledgeProposal(result, 'doc', null, 'relations', { relations: [{ fromNodeId: 'a', toNodeId: 'b', label: 'duplicate', reason: 'bad' }] }), /已经/);
});

for (const action of ['prd-template', 'tasks-template', 'meeting-template']) test(`${action} creates a new identity and supports document creation undo and redo`, () => {
  const base = sample(), p = buildKnowledgeProposal(base, 'doc', null, action, { title: 'Generated', nodes: [{ text: '待确认', children: [] }] });
  const result = acceptProposalGroups(base, p, [p.groups[0].id]);
  assert.equal(result.documents.length, 2); assert.notEqual(result.documents[1].id, base.documents[0].id);
  assert.equal(p.source.version, '2.0.0');
  const recorded = history.recordChange({ history: history.emptyEditHistory(), before: base, after: result, selection: { documentId: 'doc', nodeId: 'a' }, label: action });
  const undone = history.undo({ history: recorded, workspace: result, now: new Date().toISOString() });
  assert.equal(undone.status, 'applied'); assert.equal(undone.workspace.documents.length, 1);
  const redone = history.redo({ history: undone.history, workspace: undone.workspace, now: new Date().toISOString() });
  assert.equal(redone.status, 'applied'); assert.equal(redone.workspace.documents[1].id, result.documents[1].id);
});

test('stale, expired and dependency-incomplete acceptance cannot modify body', () => {
  const base = sample(), next = structuredClone(base); next.documents[0].title = 'New';
  const p = createWorkspaceProposal(base, [{ id: 'parent', label: 'parent', workspace: next }, { id: 'child', label: 'child', workspace: next, dependsOn: ['parent'] }], { id: 'proposal', label: 'test', source: { kind: 'ai', label: 'test' } });
  assert.throws(() => acceptProposalGroups(base, p, ['child']), /依赖/);
  assert.equal(proposalFreshness(next, p), 'stale');
  assert.equal(proposalFreshness(base, p, p.expiresAt), 'expired');
  assert.throws(() => acceptProposalGroups(next, p, ['parent']), /过期|变化/);
  assert.equal(base.documents[0].title, 'Doc');
});

test('oversized contexts and unapproved structured fields are refused without truncation', () => {
  const base = sample(); base.documents[0].nodes[0].note = 'x'.repeat(300_000);
  assert.throws(() => workflowContext(base.documents[0], 'a'), /预算|超过/);
  assert.throws(() => buildKnowledgeProposal(sample(), 'doc', null, 'tasks', { tasks: [{ text: 'task', script: 'execute()' }] }), /不允许/);
});

test('dependency groups execute in topological order even when supplied in reverse order', () => {
  const base = sample(), parent = structuredClone(base), child = structuredClone(base);
  parent.documents[0].nodes.push({ ...structuredClone(base.documents[0].nodes[0]), id: 'parent', children: [] });
  child.documents[0].nodes.push({ ...structuredClone(base.documents[0].nodes[0]), id: 'child', children: [] });
  const p = createWorkspaceProposal(base, [{ id: 'child', label: 'Child', workspace: child, dependsOn: ['parent'] }, { id: 'parent', label: 'Parent', workspace: parent }], { id: 'ordered', label: 'Ordered', source: { kind: 'ai', label: 'Ordered' } });
  assert.deepEqual(p.groups.map((group) => group.id), ['parent', 'child']);
  assert.equal(acceptProposalGroups(base, p, ['child', 'parent']).documents[0].nodes.length, 4);
});
