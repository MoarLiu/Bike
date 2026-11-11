import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import ts from 'typescript';
import { loadTypescript } from './helpers/typescript.mjs';

const filename = new URL('../src/App.tsx', import.meta.url);
const source = readFileSync(filename, 'utf8');
const ast = ts.createSourceFile(filename.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = ast.statements.flatMap((statement) => {
  if (!ts.isVariableStatement(statement)) return [];
  return statement.declarationList.declarations
    .filter((declaration) => ['OutlineView', 'useEventCallback'].includes(declaration.name.getText(ast)))
    .map((declaration) => `const ${declaration.getText(ast)};`);
}).join('\n');
const compiled = ts.transpileModule(`${declarations}\nOutlineView;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const rowFields = ast.statements.find((statement) => ts.isInterfaceDeclaration(statement)
  && statement.name.text === 'OutlineNodeRowProps').members.map((member) => member.name.getText(ast)).sort();
const { flattenNodes, findNode } = loadTypescript('src/tree.ts');

function harness() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let createdRows = 0;
  const Row = React.memo(() => null);
  const Menu = () => null;
  const useMemo = (factory, dependencies) => {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || previous.dependencies.length !== dependencies.length
      || dependencies.some((value, offset) => !Object.is(value, previous.dependencies[offset]))) {
      slots[index] = { dependencies, value: factory() };
    }
    return slots[index].value;
  };
  const useState = (initial) => {
    const index = cursor++;
    slots[index] ??= { value: initial, set(next) {
      slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;
    } };
    return [slots[index].value, slots[index].set];
  };
  const useRef = (value) => {
    const index = cursor++;
    slots[index] ??= { current: value };
    return slots[index];
  };
  const useEffect = (effect, dependencies) => {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || dependencies.some((value, offset) => !Object.is(value, previous.dependencies[offset]))) {
      slots[index] = { dependencies, cleanup: previous?.cleanup };
      effects.push(() => {
        slots[index].cleanup?.();
        slots[index].cleanup = effect();
      });
    }
  };
  const component = vm.runInNewContext(compiled, {
    React: { ...React, createElement(type, ...args) {
      if (type === Row) createdRows++;
      return React.createElement(type, ...args);
    } },
    useMemo, useState, useRef, useEffect,
    useCallback: (callback, dependencies) => useMemo(() => callback, dependencies),
    OutlineNodeRow: Row, NodeMenu: Menu, flattenNodes, findNode,
    window: { addEventListener() {}, removeEventListener() {} },
    HTMLElement: class HTMLElement {},
  }, { filename: filename.pathname });
  const render = (props) => {
    cursor = 0;
    effects = [];
    const tree = component.type(props);
    for (const effect of effects) effect();
    return tree;
  };
  return { component, Row, Menu, render, createdRows: () => createdRows };
}

const all = (element, predicate) => {
  if (!React.isValidElement(element)) return [];
  return [
    ...(predicate(element) ? [element] : []),
    ...[element.props.children].flat(Infinity).flatMap((child) => all(child, predicate)),
  ];
};
const rows = (h, tree) => all(tree, (element) => element.type === h.Row);
const byId = (h, tree) => new Map(rows(h, tree).map((element) => [element.props.node.id, element]));
const changed = (before, after) => [...after.keys()].filter((id) => before.get(id) !== after.get(id));
const node = (id, children = []) => ({
  id, text: id, note: '', checked: false, collapsed: false, color: 'plain', children,
});
const callbacks = [
  'onSelect', 'onText', 'onKeyDown', 'onPatch', 'onInsertAfter', 'onInsertChild', 'onRemove',
  'setNodeRef', 'onCopyLink', 'onExportNode', 'onUpdateNodes', 'onAiAction',
  'onSuggestLinks', 'onBindLink', 'onCreateLink', 'onPublishLabel', 'onLabelFocus', 'onFollowLink',
];
const propsFor = (nodes) => ({
  nodes, activeNodeId: 'root', locatedNodeId: null, isAiBusy: () => false,
  ...Object.fromEntries(callbacks.map((name) => [name, () => {}])),
});
const smallProps = () => propsFor([node('root', [node('a'), node('b'), node('c')])]);
const dragEvent = (source = '', clientY = 101) => ({
  preventDefault() {}, clientY,
  currentTarget: { getBoundingClientRect: () => ({ top: 100, height: 90 }) },
  dataTransfer: { setData() {}, getData: () => source },
});

test('OutlineView uses the default memo boundary and retains every declared row prop', () => {
  const h = harness();
  assert.equal(h.component.$$typeof, Symbol.for('react.memo'));
  assert.equal(h.component.compare, null);
  const props = smallProps();
  for (const row of rows(h, h.render(props))) {
    assert.deepEqual(Object.keys(row.props).sort(), rowFields);
    assert.equal(row.key, row.props.node.id);
  }
});

test('an immutable root edit creates one row element and reuses unchanged leaf elements', () => {
  const h = harness();
  const count = process.env.BIKE_OUTLINE_LARGE_TEST === '1' ? 20000 : 200;
  const root = node('root', Array.from({ length: count - 1 }, (_, index) => node(`leaf-${index}`)));
  const props = propsFor([root]);
  const initial = byId(h, h.render(props));
  assert.equal(initial.size, count);
  assert.equal(h.createdRows(), count);
  const edited = { ...root, text: '修改根主题 中文' };
  const next = { ...props, nodes: [edited] };
  const updated = byId(h, h.render(next));
  assert.deepEqual(changed(initial, updated), ['root']);
  assert.equal(h.createdRows(), count + 1);
  assert.equal(updated.get('root').props.node, edited);
  assert.equal(updated.get('leaf-0').props.node, root.children[0]);
  assert.equal(updated.get('leaf-0').props.depth, 1);
  const repeated = byId(h, h.render({ ...next }));
  assert.deepEqual(changed(updated, repeated), []);
  assert.equal(h.createdRows(), count + 1);
});

test('selection, location and AI busy changes invalidate only affected rows', () => {
  const h = harness();
  const props = smallProps();
  const initial = byId(h, h.render(props));
  const selectedProps = { ...props, activeNodeId: 'a' };
  const selected = byId(h, h.render(selectedProps));
  assert.deepEqual(changed(initial, selected), ['root', 'a']);
  assert.equal(selected.get('a').props.isActive, true);
  const locatedProps = { ...selectedProps, locatedNodeId: 'b' };
  const located = byId(h, h.render(locatedProps));
  assert.deepEqual(changed(selected, located), ['b']);
  assert.equal(located.get('b').props.located, true);
  const busyProps = { ...locatedProps, isAiBusy: (id) => id === 'c' };
  const busy = byId(h, h.render(busyProps));
  assert.deepEqual(changed(located, busy), ['c']);
  assert.equal(busy.get('c').props.isAiBusy, true);
});

test('every parent row callback replacement invalidates its cached closure', () => {
  const names = callbacks.filter((name) => !['onCopyLink', 'onExportNode', 'onUpdateNodes'].includes(name));
  for (const name of names) {
    const h = harness();
    const props = smallProps();
    const initial = byId(h, h.render(props));
    const calls = [];
    const replacement = (...args) => calls.push(args);
    const updated = byId(h, h.render({ ...props, [name]: replacement }));
    assert.deepEqual(changed(initial, updated), ['root', 'a', 'b', 'c'], name);
    assert.equal(updated.get('a').props[name], replacement, name);
    updated.get('a').props[name]('a', 'latest');
    assert.deepEqual(calls, [['a', 'latest']], name);
  }
});

test('node identity, move depth, collapse and removal preserve current tree rows', () => {
  const h = harness();
  const child = node('child');
  const a = node('a', [child]);
  const b = node('b');
  const root = node('root', [a, b]);
  const props = propsFor([root]);
  const initial = byId(h, h.render(props));
  const movedRoot = { ...root, children: [{ ...a, children: [] }, child, b] };
  const moved = byId(h, h.render({ ...props, nodes: [movedRoot] }));
  assert.equal(moved.get('child').props.depth, 1);
  assert.notEqual(moved.get('child'), initial.get('child'));
  assert.equal(moved.get('b'), initial.get('b'));
  const collapsed = rows(h, h.render({ ...props, nodes: [{ ...movedRoot, collapsed: true }] }));
  assert.deepEqual(collapsed.map((row) => row.props.node.id), ['root']);
  const removed = byId(h, h.render({ ...props, nodes: [{ ...movedRoot, children: [b] }] }));
  assert.deepEqual([...removed.keys()], ['root', 'b']);
  assert.equal(removed.get('b'), initial.get('b'));
  assert.ok(declarations.includes('new WeakMap<OutlineNode,'));
});

test('drag state updates only its target and cached drop handlers use the latest callback', () => {
  const h = harness();
  const props = smallProps();
  const initial = byId(h, h.render(props));
  initial.get('a').props.onDragStart(dragEvent(), 'a');
  initial.get('b').props.onDragOver(dragEvent('', 101), 'b');
  const dragged = byId(h, h.render(props));
  assert.deepEqual(changed(initial, dragged), ['b']);
  assert.equal(dragged.get('b').props.dropZone, 'before');
  const calls = [];
  const next = { ...props, onUpdateNodes: (...args) => calls.push(args) };
  const latest = byId(h, h.render(next));
  assert.deepEqual(changed(dragged, latest), []);
  latest.get('b').props.onDrop(dragEvent('a'), 'b');
  assert.deepEqual(calls, [['a', 'b', 'before']]);
  const cleared = byId(h, h.render(next));
  assert.deepEqual(changed(latest, cleared), ['b']);
  assert.equal(cleared.get('b').props.dropZone, null);
});

test('menu-only state and callbacks keep row elements stable and retain latest actions', () => {
  const h = harness();
  const props = smallProps();
  const initial = byId(h, h.render(props));
  initial.get('a').props.onOpenMenu('a', { left: 10, width: 20, bottom: 50 });
  const tree = h.render(props);
  assert.deepEqual(changed(initial, byId(h, tree)), []);
  let menu = all(tree, (element) => element.type === h.Menu)[0];
  assert.equal(menu.props.node, props.nodes[0].children[0]);
  assert.equal(menu.props.x, 20);
  assert.equal(menu.props.y, 58);
  const calls = [];
  const next = { ...props, onCopyLink: (id) => calls.push(['copy', id]), onExportNode: (id) => calls.push(['export', id]) };
  const nextTree = h.render(next);
  assert.deepEqual(changed(initial, byId(h, nextTree)), []);
  menu = all(nextTree, (element) => element.type === h.Menu)[0];
  menu.props.onCopyLink();
  assert.deepEqual(calls, [['copy', 'a']]);
  byId(h, h.render(next)).get('a').props.onOpenMenu('a', { left: 10, width: 20, bottom: 50 });
  const reopened = all(h.render(next), (element) => element.type === h.Menu)[0];
  reopened.props.onExport();
  assert.deepEqual(calls, [['copy', 'a'], ['export', 'a']]);
});
