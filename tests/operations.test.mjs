import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceOperation, applyWorkspaceOperation, initialPositions, equalValue, compensateWorkspaceChange, OPERATION_LIMITS } from '../shared/bike-operations.mjs';

const date = '2026-11-09T00:00:00.000Z';
const node = (id, children = []) => ({ id, text: id, note: '', checked: false, collapsed: false, color: 'plain', children });
const workspace = (nodes = [node('a'), node('b'), node('c')]) => ({ version: 1, activeDocumentId: 'doc', documents: [{ id: 'doc', title: 'Doc', createdAt: date, updatedAt: date, extension: { retained: true }, nodes }] });
const copy = (value) => structuredClone(value);
const operation = (before, after, id, positions = initialPositions(before), clock = 1) => createWorkspaceOperation(before, after, { id, actorId: id, positions, clock, createdAt: date });
const apply = (base, op, positions = initialPositions(base)) => {
  const result = applyWorkspaceOperation(base, positions, op);
  assert.equal(result.status, 'applied', JSON.stringify(result.conflicts));
  return result;
};

test('different nodes and independent fields merge without losing extension fields', () => {
  const base = workspace(), a = copy(base), b = copy(base);
  a.documents[0].nodes[0].text = 'A';
  b.documents[0].nodes[0].note = 'B';
  b.documents[0].nodes[1].checked = true;
  const aop = operation(base, a, 'actor-a'), bop = operation(base, b, 'actor-b');
  const ar = apply(base, aop), abr = apply(ar.workspace, bop, ar.positions);
  const br = apply(base, bop), bar = apply(br.workspace, aop, br.positions);
  assert.deepEqual(abr.workspace, bar.workspace);
  assert.equal(abr.workspace.documents[0].nodes[0].text, 'A');
  assert.equal(abr.workspace.documents[0].nodes[0].note, 'B');
  assert.deepEqual(abr.workspace.documents[0].extension, { retained: true });
});

test('same field preserves the candidate and atomically refuses the whole batch', () => {
  const base = workspace(), a = copy(base), b = copy(base);
  a.documents[0].nodes[0].text = 'A';
  b.documents[0].nodes[0].text = 'B';
  b.documents[0].nodes[1].note = 'batch member';
  const ar = apply(base, operation(base, a, 'a'));
  const result = applyWorkspaceOperation(ar.workspace, ar.positions, operation(base, b, 'b'));
  assert.equal(result.status, 'conflict');
  assert.equal(result.workspace, ar.workspace);
  assert.deepEqual(result.conflicts[0].candidate, { present: true, value: 'B' });
  assert.equal(result.workspace.documents[0].nodes[1].note, '');
});

test('concurrent inserts at one anchor converge and do not rewrite the siblings', () => {
  const base = workspace(), a = copy(base), b = copy(base);
  a.documents[0].nodes.splice(1, 0, node('x'));
  b.documents[0].nodes.splice(1, 0, node('y'));
  const aop = operation(base, a, 'a'), bop = operation(base, b, 'b');
  assert.equal(aop.changes.length, 1);
  const ar = apply(base, aop), ab = apply(ar.workspace, bop, ar.positions);
  const br = apply(base, bop), ba = apply(br.workspace, aop, br.positions);
  assert.deepEqual(ab.workspace, ba.workspace);
  assert.deepEqual(ab.workspace.documents[0].nodes.map((n) => n.id), ['a', 'x', 'y', 'b', 'c']);
});

test('moves reproduce each permutation with stable identities', () => {
  const permutations = [['c', 'a', 'b'], ['a', 'c', 'b'], ['b', 'c', 'a'], ['c', 'b', 'a'], ['b', 'a', 'c']];
  for (const ids of permutations) {
    const base = workspace(), next = copy(base);
    next.documents[0].nodes = ids.map((id) => next.documents[0].nodes.find((n) => n.id === id));
    const result = apply(base, operation(base, next, ids.join('')));
    assert.deepEqual(result.workspace.documents[0].nodes.map((n) => n.id), ids);
  }
});

test('concurrent moves to two parents produce an explicit conflict', () => {
  const base = workspace([node('a', [node('x')]), node('b'), node('c')]);
  const a = copy(base), b = copy(base);
  a.documents[0].nodes[1].children.push(a.documents[0].nodes[0].children.pop());
  b.documents[0].nodes[2].children.push(b.documents[0].nodes[0].children.pop());
  const ar = apply(base, operation(base, a, 'a'));
  assert.equal(applyWorkspaceOperation(ar.workspace, ar.positions, operation(base, b, 'b')).status, 'conflict');
});

test('concurrent moves creating a tree cycle are retained as conflicts', () => {
  const base = workspace([node('p', [node('a')]), node('q', [node('b')])]), a = copy(base), b = copy(base);
  a.documents[0].nodes[1].children[0].children.push(a.documents[0].nodes[0].children.pop());
  b.documents[0].nodes[0].children[0].children.push(b.documents[0].nodes[1].children.pop());
  const ar = apply(base, operation(base, a, 'a'));
  const result = applyWorkspaceOperation(ar.workspace, ar.positions, operation(base, b, 'b'));
  assert.equal(result.status, 'conflict');
  assert.match(result.conflicts[0].message, /环/);
});

test('delete versus edit and delete versus new child both preserve content', () => {
  const base = workspace(), deleted = copy(base);
  deleted.documents[0].nodes.shift();
  for (const mode of ['edit', 'child']) {
    const edited = copy(base);
    if (mode === 'edit') edited.documents[0].nodes[0].note = 'keep';
    else edited.documents[0].nodes[0].children.push(node('new-child'));
    const er = apply(base, operation(base, edited, 'edit'));
    assert.equal(applyWorkspaceOperation(er.workspace, er.positions, operation(base, deleted, 'delete')).status, 'conflict');
    const dr = apply(base, operation(base, deleted, 'delete'));
    assert.equal(applyWorkspaceOperation(dr.workspace, dr.positions, operation(base, edited, 'edit')).status, 'conflict');
  }
});

test('compensation preserves later remote changes on unrelated nodes and refuses the same field', () => {
  const base = workspace(), local = copy(base);
  local.documents[0].nodes[0].text = 'local';
  const current = copy(local); current.documents[0].nodes[1].note = 'remote';
  const options = { id: 'undo', actorId: 'a', clock: 2, source: { kind: 'undo', label: '撤销' } };
  const result = compensateWorkspaceChange(current, base, local, options);
  assert.equal(result.status, 'applied');
  assert.equal(result.workspace.documents[0].nodes[0].text, 'a');
  assert.equal(result.workspace.documents[0].nodes[1].note, 'remote');
  current.documents[0].nodes[0].text = 'remote on same field';
  assert.equal(compensateWorkspaceChange(current, base, local, options).status, 'conflict');
});

test('multi-document batches either all apply or all conflict', () => {
  const base = workspace();
  base.documents.push({ ...copy(base.documents[0]), id: 'two' });
  const next = copy(base);
  next.documents.forEach((d) => { d.title = 'rename'; });
  const current = copy(base); current.documents[1].title = 'remote';
  const result = applyWorkspaceOperation(current, initialPositions(current), operation(base, next, 'batch'));
  assert.equal(result.status, 'conflict');
  assert.equal(result.workspace.documents[0].title, 'Doc');
});

test('incremental text edit fits a small packet for a 20,000-topic document', () => {
  const base = workspace(Array.from({ length: 20_000 }, (_, i) => node(`n${i}`))), next = copy(base);
  next.documents[0].nodes[10_000].text = 'edited';
  const op = operation(base, next, 'one-edit');
  assert.equal(op.changes.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(op)) < 700);
  assert.ok(Buffer.byteLength(JSON.stringify(base)) > 2_000_000);
  assert.ok(OPERATION_LIMITS.bytes > 0);
  assert.ok(equalValue(apply(base, op).workspace, next));
});

test('all 120 sibling permutations apply without rewriting stationary anchors', () => {
  const permutations = (items) => items.length < 2 ? [items] : items.flatMap((item, index) => permutations(items.filter((_, at) => at !== index)).map((tail) => [item, ...tail]));
  for (const ids of permutations(['a', 'b', 'c', 'd', 'e'])) {
    const base = workspace(['a', 'b', 'c', 'd', 'e'].map((id) => node(id))), next = copy(base);
    next.documents[0].nodes = ids.map((id) => next.documents[0].nodes.find((node) => node.id === id));
    const result = apply(base, operation(base, next, `perm-${ids.join('')}`));
    assert.deepEqual(result.workspace.documents[0].nodes.map((node) => node.id), ids);
  }
});

test('reserved JavaScript property names remain ordinary document and topic identities', () => {
  const empty = { version: 3, activeDocumentId: '', documents: [] };
  const next = workspace([node('__proto__'), node('constructor')]); next.version = 3; next.documents[0].id = '__proto__'; next.activeDocumentId = '__proto__';
  const created = apply(empty, operation(empty, next, 'create-reserved'));
  assert.equal(Object.prototype.hasOwnProperty.call(created.positions, '__proto__'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(created.positions.__proto__, '__proto__'), true);
  const updated = copy(created.workspace); updated.documents[0].nodes.push(node('prototype'));
  const result = apply(created.workspace, operation(created.workspace, updated, 'update-reserved', created.positions), created.positions);
  assert.deepEqual(result.workspace.documents[0].nodes.map((node) => node.id), ['__proto__', 'constructor', 'prototype']);
  assert.equal({}.parentId, undefined);
});
