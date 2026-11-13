import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSyncStore } from '../server/sync-store.mjs';
import { createReplicaState, recordReplicaCommit } from '../shared/bike-replica.mjs';
import { applyWorkspaceOperation, createWorkspaceOperation, initialPositions, sameOperationDocument } from '../shared/bike-operations.mjs';
import { loadTypescript } from './helpers/typescript.mjs';

// Captured by replaying the actual 575331f engine. It is a valid, persisted
// 2.0.0 state whose tombstone traversal differs from the repaired engine.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/legacy-replica-order.json', import.meta.url)));
const at = '2026-11-13T00:00:00.000Z';
const { migrateWorkspace } = loadTypescript('src/migrations.ts');
const upgradedEdit = () => {
  const before = migrateWorkspace(structuredClone(fixture.workspace));
  const after = structuredClone(before);
  after.documents[0].nodes[0].note = 'new edit after upgrade';
  const replica = { ...createReplicaState(before, 'legacy'), clock: fixture.clock,
    initialWorkspace: fixture.initialWorkspace, positions: fixture.positions, outbox: fixture.operations };
  return { before, after, committed: recordReplicaCommit(replica, before, after, {
    requestId:'upgrade-edit',digest:'upgrade',source:{kind:'user',label:'upgrade'},at,
  }) };
};

test('immutable legacy operations still replay to their original visible order', () => {
  let workspace = fixture.initialWorkspace, positions = initialPositions(workspace);
  for (const operation of fixture.operations) {
    assert.equal(operation.orderingVersion, undefined);
    const result = applyWorkspaceOperation(workspace, positions, operation);
    assert.equal(result.status,'applied',JSON.stringify(result.conflicts));
    workspace=result.workspace;positions=result.positions;
  }
  assert.ok(sameOperationDocument(workspace.documents[0],fixture.workspace.documents[0]));
});

test('editing an upgraded legacy replica repairs anchors without changing its visible tree', () => {
  const { before, after, committed } = upgradedEdit();
  assert.equal(committed.operation.orderingVersion,2);
  assert.equal(committed.operation.changes.length,1);
  const result=applyWorkspaceOperation(before,fixture.positions,committed.operation);
  assert.equal(result.status,'applied');
  assert.ok(sameOperationDocument(result.workspace.documents[0],after.documents[0]));
});

test('metadata-only anchor repair does not invalidate a saved move baseline',()=>{
  const {after,committed}=upgradedEdit();
  const id=after.documents[0].nodes[0].id;
  const operation={protocol:2,orderingVersion:2,id:'saved-move',actorId:'new',batchId:'saved-move',clock:1000,createdAt:at,source:{kind:'restore',label:'restore'},
    resolves:[],changes:[{type:'move-node',documentId:'doc',nodeId:id,before:fixture.positions.doc[id],position:{parentId:null,afterId:after.documents[0].nodes[2].id}}]};
  const result=applyWorkspaceOperation(after,committed.replica.positions,operation);
  assert.equal(result.status,'applied',JSON.stringify(result.conflicts));
  assert.equal(result.workspace.documents[0].nodes.at(-1).id,id);
  const stale=structuredClone(operation);stale.changes[0].before.stamp='a different move';
  assert.equal(applyWorkspaceOperation(after,committed.replica.positions,stale).status,'conflict');
});

test('server upgrade replays old pending identities before applying a new-engine edit',async t=>{
  const store=await createSyncStore(':memory:');t.after(()=>store.close());
  const document=fixture.initialWorkspace.documents[0];
  store.putDocument({id:document.id,document,expectedRevision:null});
  store.operations.enable({expectedRevision:store.getManifest().workspaceRevision});
  for(const operation of fixture.operations) assert.equal(store.operations.submit(operation).status,'applied',operation.id);
  assert.ok(sameOperationDocument(store.getDocument(document.id).document,fixture.workspace.documents[0]));
  const {after,committed}=upgradedEdit();
  assert.equal(store.operations.submit(committed.operation).status,'applied');
  assert.ok(sameOperationDocument(store.getDocument(document.id).document,after.documents[0]));
  assert.equal(store.operations.submit(fixture.operations[0]).replayed,true);
});

test('new-engine title edits do not invalidate queued legacy subtree moves',()=>{
  let expected=fixture.initialWorkspace, expectedPositions=initialPositions(expected);
  let mixed=structuredClone(expected), mixedPositions=initialPositions(mixed);
  for(const [index,operation] of fixture.operations.entries()){
    const original=applyWorkspaceOperation(expected,expectedPositions,operation);
    assert.equal(original.status,'applied');
    expected=original.workspace;expectedPositions=original.positions;
    const incoming=applyWorkspaceOperation(mixed,mixedPositions,operation);
    assert.equal(incoming.status,'applied',JSON.stringify(incoming.conflicts));
    mixed=incoming.workspace;mixedPositions=incoming.positions;
    assert.ok(sameOperationDocument({...expected.documents[0],title:mixed.documents[0].title},mixed.documents[0]));
    const edited={...mixed,documents:[{...mixed.documents[0],title:`title ${index}`}]};
    const update=createWorkspaceOperation(mixed,edited,{id:`engine-two-${index}`,actorId:'new',clock:1000+index,positions:mixedPositions});
    const saved=applyWorkspaceOperation(mixed,mixedPositions,update);
    assert.equal(saved.status,'applied');
    mixed=saved.workspace;mixedPositions=saved.positions;
  }
});

test('seed requests retain their pre-upgrade shape for lost-acknowledgement recovery',()=>{
  const workspace=fixture.initialWorkspace,document=workspace.documents[0];
  const seed=createWorkspaceOperation({...workspace,documents:[]},{...workspace,documents:[document]},{
    id:'seed',actorId:'legacy',clock:1,source:{kind:'import',label:'首次接入的本机基线'},createdAt:document.updatedAt,
    includeOrder:false,commit:true,orderingVersion:1,
  });
  assert.deepEqual(seed,{protocol:2,id:'seed',actorId:'legacy',clock:1,batchId:'seed',source:{kind:'import',label:'首次接入的本机基线'},
    createdAt:document.updatedAt,changes:[{type:'create-document',documentId:document.id,document,restore:false}],resolves:[],resolutionBaselines:{}});
});

test('a queued legacy field edit cannot reorder nodes created by the repaired engine',()=>{
  const node=id=>({id,text:id,note:'',children:[]});
  let workspace={version:3,activeDocumentId:'doc',documents:[{id:'doc',title:'Doc',nodes:[node('p'),node('x')]}]};
  let replica=createReplicaState(workspace,'new');
  const [p,x]=workspace.documents[0].nodes,y=node('y'),z=node('z');
  let oldField;
  for(const [index,nodes] of [[p,y,x],[p,y,x,z],[p,y,z]].entries()){
    if(index===2){
      const note=structuredClone(workspace);note.documents[0].nodes[0].note='legacy note';
      oldField=createWorkspaceOperation(workspace,note,{id:'old-field',actorId:'old',clock:10,positions:replica.positions,orderingVersion:1});
    }
    const next={...workspace,documents:[{...workspace.documents[0],nodes}]};
    replica=recordReplicaCommit(replica,workspace,next,{requestId:`new-${index}`,digest:String(index),source:{kind:'user',label:'edit'},at}).replica;
    workspace=next;
  }
  const result=applyWorkspaceOperation(workspace,replica.positions,oldField);
  assert.equal(result.status,'applied');
  assert.deepEqual(result.workspace.documents[0].nodes.map(node=>node.id),['p','y','z']);
  assert.equal(result.workspace.documents[0].nodes[0].note,'legacy note');
});
