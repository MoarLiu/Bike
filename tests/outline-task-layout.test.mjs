import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import React from 'react';
import ts from 'typescript';

const filename = new URL('../src/App.tsx', import.meta.url);
const ast = ts.createSourceFile(filename.pathname, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const row = ast.statements.flatMap((statement) => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
  .find((declaration) => declaration.name.getText(ast) === 'OutlineNodeRow');
const compiled = ts.transpileModule(`const ${row.getText(ast)};\nOutlineNodeRow;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;

const all = (element, predicate) => {
  if (!React.isValidElement(element)) return [];
  return [
    ...(predicate(element) ? [element] : []),
    ...[element.props.children].flat(Infinity).flatMap((child) => all(child, predicate)),
  ];
};

function render(node, onPatch = () => {}) {
  const empty = () => null;
  const component = vm.runInNewContext(compiled, {
    React,
    useState: (value) => [value, () => {}],
    useRef: (value) => ({ current: value }),
    useCallback: (callback) => callback,
    useLayoutEffect: () => {},
    useEffect: () => {},
    classNames: (...values) => values.filter(Boolean).join(' '),
    normalizeColor: (value) => value || 'plain',
    extractTags: () => [], scanLinks: () => [],
    AiInlineMenu: empty, AttachmentItems: empty, LinkAutocomplete: empty,
    ChevronRight: empty, ChevronDown: empty, CheckCircle2: empty, Circle: empty,
    Plus: empty, Indent: empty, Trash2: empty, Image: empty, Table: empty,
  }, { filename: filename.pathname });
  return component.type({ node, depth: 1, isActive: false, onPatch, isAiBusy: false });
}

const node = (properties = {}) => ({
  id: 'task', text: '任务 中文', children: [], note: '', color: 'plain',
  checked: false, collapsed: false, isTodo: true, ...properties,
});

test('task completion button stays in the text flex cell with native button semantics', () => {
  const tree = render(node());
  const cell = all(tree, (element) => element.props.className === 'outline-text-cell')[0];
  const checkbox = all(cell, (element) => element.props.className?.includes('task-checkbox'))[0];
  assert.equal(checkbox.type, 'button');
  assert.ok(checkbox.props.className.split(' ').includes('check-button'));
  assert.equal(checkbox.props.title, '设为已完成');
  assert.equal(checkbox.props.onKeyDown, undefined);
  assert.equal(all(tree, (element) => element.props.className?.includes('task-checkbox')).length, 1);
  const children = React.Children.toArray(cell.props.children);
  const checkboxIndex = children.findIndex((element) => element.props.className?.includes('task-checkbox'));
  assert.ok(checkboxIndex >= 0 && checkboxIndex < children.findIndex((element) => element.type === 'textarea'));
});

test('task completion button toggles only checked and keeps row event isolation', () => {
  for (const checked of [false, true]) {
    const changes = [];
    const tree = render(node({ checked }), (...args) => changes.push(args));
    const checkbox = all(tree, (element) => element.props.className?.includes('task-checkbox'))[0];
    let stopped = 0;
    checkbox.props.onClick({ stopPropagation: () => stopped++ });
    assert.equal(stopped, 1);
    assert.deepEqual(changes.map(([id, patch]) => [id, { ...patch }]), [['task', { checked: !checked }]]);
    assert.equal(checkbox.props.title, checked ? '设为未完成' : '设为已完成');
  }
});

test('ordinary outline topics retain the bullet and omit the completion button', () => {
  const tree = render(node({ isTodo: false }));
  assert.equal(all(tree, (element) => element.props.className?.includes('task-checkbox')).length, 0);
  assert.equal(all(tree, (element) => element.props.title === '主题操作').length, 1);
  assert.equal(all(tree, (element) => element.type === 'textarea').length, 1);
});
