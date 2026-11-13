import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncStore } from '../server/sync-store.mjs';
import { createWorkspaceOperation, initialPositions, applyWorkspaceOperation, invertWorkspaceOperation } from '../shared/bike-operations.mjs';
import { createReplicaState, recordReplicaCommit } from '../shared/bike-replica.mjs';
import { acceptProposalGroups } from '../shared/bike-proposals.mjs';
import { loadTypescript } from './helpers/typescript.mjs';
const { conflictResolutionProposal } = loadTypescript('src/operationRecovery.ts');
const { migrateWorkspace } = loadTypescript('src/migrations.ts');
const { undo, recordChange, emptyEditHistory } = loadTypescript('src/editHistory.ts');
const date = '2026-11-09T00:00:00.000Z';
const base = () => migrateWorkspace({ version: 3, activeDocumentId: 'doc', documents: [{ id: 'doc', title: 'Doc', createdAt: date, updatedAt: date, nodes: [{ id: 'a', text: 'A', children: [] }, { id: 'b', text: 'B', children: [] }] }] });
const edit = (before, value, field = 'text') => { const next = structuredClone(before); next.documents[0].nodes[0][field] = value; return next; };
const op = (before, after, id) => createWorkspaceOperation(before, after, { id, actorId: id, createdAt: date });
const fixture = async (t) => {
  const store = await createSyncStore(':memory:'); t.after(() => store.close());
  store.putDocument({ id: 'doc', expectedRevision: null, document: base().documents[0] }); store.operations.enable({ expectedRevision: 1 });
  store.operations.submit(op(base(), edit(base(), 'remote'), 'one'));
  const conflict = store.operations.submit(op(base(), edit(base(), 'candidate'), 'two'));
  const checkpoint = store.operations.checkpoint();
  const workspace = { ...base(), documents: [store.getDocument('doc').document] };
  const replica = { ...createReplicaState(workspace, 'resolver'), positions: { doc: checkpoint.documents[0].positions }, clock: checkpoint.clock };
  return { store, conflict, workspace, replica };
};
for (const choice of ['candidate', 'current']) test(`conflict choice ${choice} is an audited operation and resolves on the server`, async (t) => {
  const { store, conflict, workspace, replica } = await fixture(t);
  const proposal = conflictResolutionProposal(workspace, replica, conflict, choice);
  const selected = acceptProposalGroups(workspace, proposal, ['resolution']);
  const local = recordReplicaCommit(replica, workspace, selected, { requestId: 'resolve', digest: 'resolve', source: proposal.source, at: date, resolves: proposal.resolves, resolutionBaselines: proposal.resolutionBaselines });
  assert.equal(local.replica.outbox.length, 1);
  assert.equal(store.operations.submit(local.operation).status, 'applied');
  assert.equal(store.operations.receipt('two').resolved, true);
  assert.equal(store.getDocument('doc').document.nodes[0].text, choice === 'candidate' ? 'candidate' : 'remote');
  assert.equal(local.replica.audit[0].operation.source.kind, 'conflict');
});

test('a later remote edit invalidates conflict resolution and retains both the candidate and current data', async (t) => {
  const { store, conflict, workspace, replica } = await fixture(t);
  const proposal = conflictResolutionProposal(workspace, replica, conflict, 'candidate');
  const selected = acceptProposalGroups(workspace, proposal, ['resolution']);
  const local = recordReplicaCommit(replica, workspace, selected, { requestId: 'resolve', digest: 'resolve', source: proposal.source, at: date, resolves: proposal.resolves, resolutionBaselines: proposal.resolutionBaselines });
  store.operations.submit(op(workspace, edit(workspace, 'later note', 'note'), 'later'));
  const result = store.operations.submit(local.operation);
  assert.equal(result.status, 'conflict');
  assert.equal(store.operations.receipt('two').resolved, false);
  assert.equal(store.getDocument('doc').document.nodes[0].note, 'later note');
  assert.match(result.conflicts[0].message, /再次变化/);
});

test('default fields added on restart do not invalidate a conflict resolution baseline', async t=>{
  const {store,conflict,workspace,replica}=await fixture(t);
  const sparse=structuredClone(workspace);
  for(const node of sparse.documents[0].nodes) for(const field of ['bold','italic','underline','strike','highlight','headingLevel','isTodo']) delete node[field];
  const proposal=conflictResolutionProposal(sparse,replica,conflict,'current');
  const selected=acceptProposalGroups(sparse,proposal,['resolution']);
  const local=recordReplicaCommit(replica,sparse,selected,{requestId:'resolve-sparse',digest:'resolve-sparse',source:proposal.source,at:date,resolves:proposal.resolves,resolutionBaselines:proposal.resolutionBaselines});
  assert.equal(store.operations.submit(local.operation).status,'applied');
  assert.equal(store.operations.receipt('two').resolved,true);
});

test('operation inversion restores deleted nodes without overwriting a later independent edit', () => {
  const original = base(), deleted = { ...original, documents: [{ ...original.documents[0], nodes: original.documents[0].nodes.slice(1) }] };
  const deletion = op(original, deleted, 'delete');
  const applied = applyWorkspaceOperation(original, initialPositions(original), deletion);
  applied.workspace.documents[0].nodes[0].note = 'remote';
  const inverse = invertWorkspaceOperation(deletion, { id: 'restore', actorId: 'me', clock: 2, createdAt: date });
  const restored = applyWorkspaceOperation(applied.workspace, applied.positions, inverse);
  assert.equal(restored.status, 'applied');
  assert.deepEqual(restored.workspace.documents[0].nodes.map((node) => node.id), ['a', 'b']);
  assert.equal(restored.workspace.documents[0].nodes[1].note, 'remote');
});

test('v3 undo preserves a remote edit to another field, and refuses a later edit to the same field', () => {
  const before = base(), after = edit(before, 'local');
  const history = recordChange({ history: emptyEditHistory(), before, after, label: 'edit', selection: { documentId: 'doc', nodeId: 'a' } });
  const remote = edit(after, 'remote note', 'note');
  const result = undo({ history, workspace: remote, now: date });
  assert.equal(result.status, 'applied');
  assert.equal(result.workspace.documents[0].nodes[0].text, 'A');
  assert.equal(result.workspace.documents[0].nodes[0].note, 'remote note');
  assert.equal(undo({ history, workspace: edit(after, 'remote text'), now: date }).status, 'stale');
});
