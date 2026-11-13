import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript, loadTypescriptIsolated } from './helpers/typescript.mjs';
import { installFakeBrowserStorage } from './helpers/fake-browser.mjs';
import { createReplicaState, recordReplicaCommit } from '../shared/bike-replica.mjs';
import { createWorkspaceOperation } from '../shared/bike-operations.mjs';
import { createLiveCandidatePatch, applyLiveCandidatePatch } from '../shared/bike-live-patch.mjs';
const { migrateWorkspace } = loadTypescript('src/migrations.ts');
const { createNode } = loadTypescript('src/tree.ts');
const at = '2026-11-13T00:00:00.000Z';
const base = () => migrateWorkspace({ version: 3, activeDocumentId: 'doc', documents: [
  { id: 'doc', title: 'Doc', createdAt: at, updatedAt: at, nodes: ['p', 'x'].map(id => ({ id, text: id, children: [] })) },
] });
const withNodes = (workspace, nodes) => ({ ...workspace, documents: [{ ...workspace.documents[0], nodes }] });

test('insertions followed by anchor deletion remain durable across reload', async t => {
  const env = installFakeBrowserStorage(t);
  env.idb.seed('bike-db', { workspace: base(), 'workspace-meta': { revision: 1 } });
  const storage = loadTypescriptIsolated('src/storage.ts');
  let current = (await storage.loadWorkspace()).workspace;
  const [p,x] = current.documents[0].nodes;
  const y = { ...createNode('y'), id: 'y' }, z = { ...createNode('z'), id: 'z' };
  for (const nodes of [[p,y,x], [p,y,x,z], [p,y,z]]) {
    current = withNodes(current, nodes);
    const result = await storage.saveWorkspace(current);
    assert.equal(result.ok, true, result.error?.message);
  }
  assert.equal(env.idb.read('bike-db', 'workspace-meta').revision, 4);
  const restarted = loadTypescriptIsolated('src/storage.ts');
  assert.deepEqual((await restarted.loadWorkspace()).workspace.documents[0].nodes.map(n => n.id), ['p','y','z']);
});

test('600 pre-2.0.1 sparse nodes do not become default-field edits after restart', async t => {
  const env = installFakeBrowserStorage(t);
  env.idb.seed('bike-db', { workspace: base(), 'workspace-meta': { revision: 1 } });
  const first = loadTypescriptIsolated('src/storage.ts');
  const original = (await first.loadWorkspace()).workspace;
  const added = withNodes(original, [...original.documents[0].nodes, ...Array.from({ length: 600 }, (_,i) => ({
    id:`new-${i}`,text:'new',note:'',checked:false,collapsed:false,color:'plain',children:[],
  }))]);
  assert.equal((await first.saveWorkspace(added)).ok, true);
  const second = loadTypescriptIsolated('src/storage.ts');
  const reloaded = (await second.loadWorkspace()).workspace;
  const edited = structuredClone(reloaded); edited.documents[0].nodes[0].text = 'one edit';
  const saved = await second.saveWorkspace(edited);
  assert.equal(saved.ok, true, saved.error?.message);
  assert.equal((await second.readReplicaState()).outbox.at(-1).changes.length, 1);
});

test('single-client deterministic insert/delete/move sequences project exactly', () => {
  for (let seed = 1; seed <= 80; seed++) {
    let random = seed, before = base(), replica = createReplicaState(before, `actor-${seed}`);
    const nextRandom = n => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % n; };
    for (let step = 0; step < 60; step++) {
      const list = [...before.documents[0].nodes];
      const action = nextRandom(3);
      if (action === 0 || list.length < 2) {
        list.splice(nextRandom(list.length+1),0,{id:`n-${seed}-${step}`,text:'insert',children:[]});
      } else if (action === 1) list.splice(nextRandom(list.length),1);
      else { const [node] = list.splice(nextRandom(list.length),1); list.splice(nextRandom(list.length+1),0,node); }
      const after = withNodes(before,list);
      const result = recordReplicaCommit(replica,before,after,{requestId:`op-${seed}-${step}`,digest:`d-${step}`,source:{kind:'user',label:'edit'},at});
      replica = result.replica; before = after;
    }
  }
});

test('escaped text cannot exceed the actual operation transport byte budget', () => {
  const before = base(), after = structuredClone(before);
  after.documents[0].nodes[0].text = '\u0001'.repeat(750000);
  assert.throws(() => createWorkspaceOperation(before, after, { id: 'escaped', actorId: 'a' }), /预算/);
});

test('nested insert/delete/subtree moves project without corrupting sibling anchors', () => {
  for (let seed = 1; seed <= 40; seed++) {
    let before = base(), replica = createReplicaState(before, `nested-${seed}`), random = seed;
    const pick = n => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % n; };
    const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children)]);
    for (let step = 0; step < 50; step++) {
      const after = structuredClone(before), roots = after.documents[0].nodes;
      const nodes = flatten(roots), action = pick(3);
      if (action === 0 || nodes.length < 2) {
        const list = !nodes.length || pick(2) ? roots : nodes[pick(nodes.length)].children;
        list.splice(pick(list.length + 1), 0, { id: `nested-${seed}-${step}`, text: 'new', children: [] });
      } else {
        const node = nodes[pick(nodes.length)];
        const parent = nodes.find(item => item.children.includes(node));
        const list = parent?.children ?? roots;
        list.splice(list.indexOf(node), 1);
        if (action === 2) {
          const remaining = flatten(roots);
          const target = remaining.length && pick(2) ? remaining[pick(remaining.length)].children : roots;
          target.splice(pick(target.length + 1), 0, node);
        }
      }
      replica = recordReplicaCommit(replica, before, after, { requestId: `nested-op-${seed}-${step}`, digest: String(step), source: { kind: 'user', label: 'edit' }, at }).replica;
      before = after;
    }
  }
});

test('Live candidate patches omit unchanged large documents and retain ordering', () => {
  const before = base();
  before.documents.push({ id: 'large', title: 'Untouched', nodes: [{ id: 'large-node', text: 'x'.repeat(5 * 1024 * 1024), children: [] }] });
  const after = structuredClone(before); after.documents[0].nodes[0].text = 'changed';
  const patch = createLiveCandidatePatch(before, after);
  assert.ok(JSON.stringify(patch).length < 2000);
  assert.deepEqual(applyLiveCandidatePatch(before, patch), after);
  assert.throws(() => applyLiveCandidatePatch(before, { ...patch, documentOrder: ['doc','doc'] }), /顺序/);
});

test('old receipt counts no longer impose a local save failure', () => {
  const before = base(), replica = createReplicaState(before, 'many-receipts');
  replica.receipts = Object.fromEntries(Array.from({ length: 100001 }, (_,index) => [`receipt-${index}`, { requestId: `receipt-${index}`, operationId: null, digest: String(index), status: 'committed', pendingSync: false }]));
  const after = structuredClone(before); after.documents[0].nodes[0].text = 'still editable';
  const result = recordReplicaCommit(replica, before, after, { requestId: 'new', digest: 'new', source: { kind: 'user', label: 'edit' }, at });
  assert.equal(result.receipt.status, 'committed');
  assert.ok(result.replica.receipts['receipt-100000']);
});

test('only never-published outboxes are compacted; attempted operation identities remain intact', () => {
  const run = syncStarted => {
    let before = base(), replica = { ...createReplicaState(before, 'offline'), syncStarted };
    for (let index = 0; index < 6; index++) {
      const after = structuredClone(before); after.documents[0].nodes[0].note = String(index).repeat(1024 * 1024);
      replica = recordReplicaCommit(replica, before, after, { requestId: `edit-${index}`, digest: `${index}`, source: { kind: 'user', label: 'edit' }, at }).replica;
      before = after;
    }
    return replica;
  };
  const unpublished = run(false), attempted = run(true);
  assert.ok(unpublished.outbox.length < 6);
  assert.equal(attempted.outbox.length, 6);
  assert.equal(attempted.outbox[0].id, 'edit-0');
  for (const receipt of Object.values(unpublished.receipts)) assert.ok(unpublished.outbox.some(operation => operation.id === receipt.operationId));
});
