import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import ts from 'typescript';

const filename = new URL('../src/App.tsx', import.meta.url);
const source = readFileSync(filename, 'utf8');
const ast = ts.createSourceFile(filename.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = (names) => ast.statements.flatMap((statement) => {
  if (ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text)) return [statement.getText(ast)];
  if (!ts.isVariableStatement(statement)) return [];
  return statement.declarationList.declarations
    .filter((declaration) => names.includes(declaration.name.getText(ast)))
    .map((declaration) => `const ${declaration.getText(ast)};`);
}).join('\n');
const compiled = ts.transpileModule(`${declarations([
  'MINDMAP_ROOT_ID', 'MindMapNode', 'MindMap', 'createMindMapLayout', 'splitMindMapLines', 'mindMapMetrics',
])}
({ MindMap, MindMapNode, MINDMAP_ROOT_ID });`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;

// Keep real React elements and memo semantics while controlling only the hooks.
// This checks the props React reconciles without a browser dependency in npm test.
function harness() {
  const slots = [];
  let cursor = 0;
  const useMemo = (factory, dependencies) => {
    const index = cursor++;
    const previous = slots[index];
    if (!previous || dependencies.some((value, offset) => !Object.is(value, previous.dependencies[offset]))) {
      slots[index] = { dependencies, value: factory() };
    }
    return slots[index].value;
  };
  const useState = (initial) => {
    const index = cursor++;
    if (!slots[index]) {
      slots[index] = { value: initial, set: (next) => {
        slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;
      } };
    }
    return [slots[index].value, slots[index].set];
  };
  const useRef = (value) => {
    const index = cursor++;
    slots[index] ??= { current: value };
    return slots[index];
  };
  const bindings = vm.runInNewContext(compiled, {
    React, useState, useRef, useMemo, useCallback: (callback, dependencies) => useMemo(() => callback, dependencies),
    useEffect: () => {},
    classNames: (...values) => values.filter(Boolean).join(' '),
    normalizeColor: (color) => color || 'plain',
    AttachmentItems: () => null, AiInlineMenu: () => null, MindMapContextMenu: () => null, Plus: () => null,
    ZoomIn: () => null, ZoomOut: () => null, RotateCcw: () => null,
  }, { filename: filename.pathname });
  return { ...bindings, render: (props) => { cursor = 0; return bindings.MindMap(props); } };
}

const all = (element, predicate) => {
  if (!React.isValidElement(element)) return [];
  return [
    ...(predicate(element) ? [element] : []),
    ...[element.props.children].flat(Infinity).flatMap((child) => all(child, predicate)),
  ];
};
const sameProps = (left, right) => Object.keys(left).length === Object.keys(right).length
  && Object.keys(left).every((key) => Object.is(left[key], right[key]));
const node = (id, text = id, children = []) => ({ id, text, note: '', checked: false, collapsed: false, color: 'plain', children });
const propsFor = (nodes) => ({
  title: 'Map title', nodes, rootTargetId: null, viewportResetKey: 'doc', activeNodeId: null, canPaste: false,
  ...Object.fromEntries(['onSelect', 'onTitle', 'onText', 'onPatch', 'onInsertAfter', 'onInsertChild', 'onInsertParent',
    'onCopyNode', 'onCutNode', 'onPasteNode', 'onDuplicateNode', 'onRemove', 'onToggleSiblingCollapse',
    'onFocusNode', 'onAiAction'].map((name) => [name, () => {}])),
  isAiBusy: () => false,
});
const event = (extra = {}) => ({ stopPropagation() {}, preventDefault() {}, nativeEvent: {}, ...extra });
const rows = (tree, h) => all(tree, (element) => element.type === h.MindMapNode);
const body = (row) => row.type.type(row.props);
const textarea = (row) => all(body(row), (element) => element.type === 'textarea')[0];

test('20,001 mind-map node props stay stable through draft and selection changes', () => {
  const h = harness();
  const props = propsFor([node('root', 'Root', Array.from({ length: 19999 }, (_, index) => node(`child-${index}`)))]);
  const initialTree = h.render(props);
  const initial = rows(initialTree, h);
  assert.equal(initial.length, 20001);
  assert.equal(h.MindMapNode.$$typeof, Symbol.for('react.memo'));
  assert.equal(h.MindMapNode.compare, null);
  const root = initial.find((element) => element.props.item.node.id === 'root');
  body(root).props.onClick(event());
  const editingTree = h.render(props);
  const editing = rows(editingTree, h);
  const editingRoot = editing.find((element) => element.key === root.key);
  textarea(editingRoot).props.onChange(event({ target: { value: '输入中文' } }));
  const draftTree = h.render(props);
  const draft = rows(draftTree, h);
  const previousById = new Map(editing.map((element) => [element.key, element.props]));
  assert.deepEqual(draft.filter((element) => !sameProps(previousById.get(element.key), element.props)).map((element) => element.key), [root.key]);
  assert.equal(textarea(draft.find((element) => element.key === root.key)).props.value, '输入中文');
  const edges = (tree) => all(tree, (element) => element.type === 'path' && element.props.className?.startsWith('mindmap-edge'));
  assert.equal(edges(initialTree).length, 20000);
  assert.equal(edges(initialTree)[0], edges(draftTree)[0]);
  const selected = rows(h.render({ ...props, activeNodeId: 'child-12' }), h);
  const draftById = new Map(draft.map((element) => [element.key, element.props]));
  assert.deepEqual(selected.filter((element) => !sameProps(draftById.get(element.key), element.props)).map((element) => element.props.item.node.id), ['child-12']);
  assert.equal(selected.length, 20001);
});

test('memoized node keeps geometry, formatting, attachments and pointer/menu handlers', () => {
  const h = harness();
  const calls = [];
  const topic = { ...node('topic', 'Text'), bold: true, italic: true, underline: true, strike: true, highlight: true, headingLevel: 2, attachmentRefs: [{ assetId: 'asset' }] };
  const props = propsFor([topic]);
  props.onSelect = (id) => calls.push(['select', id]);
  let row = rows(h.render(props), h).find((element) => element.props.item.node.id === 'topic');
  const foreignObject = body(row);
  for (const key of ['x', 'y', 'width', 'height']) assert.equal(foreignObject.props[key], row.props.item[key]);
  const content = foreignObject.props.children;
  for (const name of ['is-bold', 'is-italic', 'is-underline', 'is-strike', 'is-highlighted', 'heading-2']) assert.ok(content.props.className.includes(name));
  assert.equal(React.Children.toArray(content.props.children).at(-1).props.node, topic);
  let stopped = 0;
  foreignObject.props.onPointerDown(event({ stopPropagation: () => stopped++ }));
  foreignObject.props.onContextMenu(event({ clientX: 10, clientY: 20, stopPropagation: () => stopped++ }));
  const menuTree = h.render(props);
  const menu = all(menuTree, (element) => element.props.x === 10 && element.props.y === 20)[0];
  assert.equal(menu.props.item.node.id, 'topic');
  assert.equal(stopped, 2);
  assert.deepEqual(calls, [['select', 'topic']]);
  row.props.suppressClickRef.current = true;
  body(row).props.onClick(event());
  assert.equal(calls.length, 1);
});

test('editor retains IME guard, Escape cancellation, blur and focused-root routing', () => {
  const h = harness();
  const calls = [];
  const props = propsFor([node('topic')]);
  props.rootTargetId = 'focused';
  props.onText = (...args) => calls.push(args);
  const findRoot = (tree) => rows(tree, h).find((element) => element.props.item.node.id === h.MINDMAP_ROOT_ID);
  body(findRoot(h.render(props))).props.onClick(event());
  textarea(findRoot(h.render(props))).props.onChange(event({ target: { value: '中文\n换行' } }));
  const input = textarea(findRoot(h.render(props)));
  input.props.onKeyDown(event({ key: 'Enter', nativeEvent: { isComposing: true } }));
  assert.equal(calls.length, 0);
  assert.ok(textarea(findRoot(h.render(props))));
  input.props.onKeyDown(event({ key: 'Escape' }));
  assert.equal(calls.length, 0);
  assert.equal(textarea(findRoot(h.render(props))), undefined);
  body(findRoot(h.render(props))).props.onClick(event());
  textarea(findRoot(h.render(props))).props.onChange(event({ target: { value: '中文\n换行' } }));
  textarea(findRoot(h.render(props))).props.onBlur();
  assert.deepEqual(calls, [['focused', '中文 换行']]);
  const next = { ...props, rootTargetId: 'next-focus' };
  body(findRoot(h.render(next))).props.onClick(event());
  textarea(findRoot(h.render(next))).props.onChange(event({ target: { value: '' } }));
  textarea(findRoot(h.render(next))).props.onKeyDown(event({ key: 'Enter' }));
  assert.deepEqual(calls.at(-1), ['next-focus', '未命名主题']);
});

test('committed text invalidates node layout and editor callbacks use the latest props', () => {
  const h = harness();
  const props = propsFor([node('topic', 'short')]);
  const initial = rows(h.render(props), h).find((element) => element.props.item.node.id === 'topic');
  const topic = node('topic', '长'.repeat(100));
  const calls = [];
  const next = { ...props, nodes: [topic], onText: (...args) => calls.push(args) };
  const changed = rows(h.render(next), h).find((element) => element.props.item.node.id === 'topic');
  assert.equal(changed.props.item.node, topic);
  assert.ok(changed.props.item.height > initial.props.item.height);
  assert.equal(changed.props.item.lines.join(''), topic.text);
  body(changed).props.onClick(event());
  const editing = rows(h.render(next), h).find((element) => element.props.item.node.id === 'topic');
  textarea(editing).props.onKeyDown(event({ key: 'Enter' }));
  assert.deepEqual(calls, [['topic', topic.text]]);
});


test('document-root editor keeps title fallback and AI/add-child action targets', () => {
  const h = harness();
  const calls = [];
  const props = propsFor([node('topic')]);
  props.onTitle = (text) => calls.push(['title', text]);
  props.onAiAction = (...args) => calls.push(['ai', ...args]);
  props.onInsertChild = (id) => calls.push(['child', id]);
  props.isAiBusy = (id) => id === h.MINDMAP_ROOT_ID;
  const rootRow = (tree) => rows(tree, h).find((element) => element.props.item.node.id === h.MINDMAP_ROOT_ID);
  body(rootRow(h.render(props))).props.onClick(event());
  const editor = body(rootRow(h.render(props)));
  const ai = all(editor, (element) => 'onAction' in element.props)[0];
  assert.equal(ai.props.busy, true);
  ai.props.onAction('polish');
  all(editor, (element) => element.props.className === 'map-node-add')[0].props.onClick(event());
  assert.deepEqual(calls, [['ai', 'polish', h.MINDMAP_ROOT_ID], ['child', h.MINDMAP_ROOT_ID]]);
  textarea(rootRow(h.render(props))).props.onChange(event({ target: { value: '' } }));
  textarea(rootRow(h.render(props))).props.onKeyDown(event({ key: 'Enter' }));
  assert.deepEqual(calls.at(-1), ['title', '未命名文档']);
});
