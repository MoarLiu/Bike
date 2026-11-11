import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { loadTypescriptIsolated } from './helpers/typescript.mjs';

function fixture(t, { resizeObserver = true } = {}) {
  const originalWindow = globalThis.window;
  const originalObserver = globalThis.ResizeObserver;
  const frames = new Map();
  const timers = new Map();
  const listeners = new Map();
  const fontListeners = new Map();
  const observers = [];
  const events = [];
  let now = 0;
  let nextId = 0;
  let resolveFonts;
  const fonts = {
    ready: new Promise((resolve) => { resolveFonts = resolve; }),
    addEventListener: (name, callback) => fontListeners.set(name, callback),
    removeEventListener: (name) => fontListeners.delete(name),
  };
  const document = { fonts };
  globalThis.window = {
    performance: { now: () => now },
    requestAnimationFrame: (callback) => { const id = nextId++; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
    setTimeout: (callback, delay) => { const id = nextId++; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
  };
  globalThis.ResizeObserver = resizeObserver ? class {
    targets = new Set();
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(element) { this.targets.add(element); }
    unobserve(element) { this.targets.delete(element); }
    disconnect() { this.targets.clear(); }
    notify(element, width) { this.callback([{ target: element, contentRect: { width } }]); }
  } : undefined;
  t.after(() => {
    globalThis.window = originalWindow;
    globalThis.ResizeObserver = originalObserver;
  });
  const layout = loadTypescriptIsolated('src/textareaLayout.ts');
  return {
    ...layout, events, frames, timers, listeners, fontListeners, observers, resolveFonts, document,
    element(id, text = 'abcdefghij', columns = 10) {
      let height = '160px';
      const element = {
        ownerDocument: document, isConnected: true, columns, value: text,
        selectionStart: 2, selectionEnd: 4,
        style: {
          get height() { return height; },
          set height(value) { height = value; events.push([id, 'write', value]); },
        },
        get scrollHeight() {
          assert.equal(height, 'auto', 'reset the previous height before measuring shrinking content');
          events.push([id, 'read']);
          return Math.max(1, Math.ceil(element.value.length / element.columns)) * 20;
        },
        get clientWidth() { throw new Error('observer width must not force a synchronous layout read'); },
      };
      return element;
    },
    frame() {
      now += 16;
      const batch = [...frames.values()];
      frames.clear();
      for (const callback of batch) callback();
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > end) break;
        now = Math.max(now, next[1].due);
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
  };
}

test('outline height resets, reads and final writes stay in separate batches across rows', (t) => {
  const f = fixture(t);
  const elements = ['a', 'b', 'c'].map((id) => f.element(id));
  const cleanups = elements.map((element) => f.observeTextareaLayout(element));
  for (const element of elements) f.requestTextareaResize(element);
  assert.deepEqual(f.events, []);
  f.frame();
  assert.deepEqual(f.events, [
    ['a', 'write', 'auto'], ['b', 'write', 'auto'], ['c', 'write', 'auto'],
    ['a', 'read'], ['b', 'read'], ['c', 'read'],
    ['a', 'write', '20px'], ['b', 'write', '20px'], ['c', 'write', '20px'],
  ]);
  assert.equal(f.frames.size, 1, 'rows share their settling frame');
  assert.equal(f.timers.size, 1, 'rows share their delayed correction timer');
  assert.equal(f.observers.length, 1);
  for (const cleanup of cleanups) cleanup();
});

test('a queued edit measures the latest text and can shrink without touching text or selection', (t) => {
  const f = fixture(t);
  const element = f.element('editing', 'long wrapped content', 4);
  const cleanup = f.observeTextareaLayout(element);
  f.frame();
  assert.equal(element.style.height, '100px');
  element.value = '中';
  f.requestTextareaResize(element);
  f.requestTextareaResize(element);
  f.frame();
  assert.equal(element.style.height, '20px');
  assert.equal(element.value, '中');
  assert.deepEqual([element.selectionStart, element.selectionEnd], [2, 4]);
  cleanup();
});

test('unmount removes pending rows before DOM removal and cancels remaining callbacks and listeners', (t) => {
  const f = fixture(t);
  const a = f.element('removed'), b = f.element('kept');
  const removeA = f.observeTextareaLayout(a), removeB = f.observeTextareaLayout(b);
  removeA();
  f.frame();
  assert.ok(f.events.length);
  assert.ok(f.events.every(([id]) => id === 'kept'));
  removeB();
  f.events.length = 0;
  f.frame();
  f.advance(1000);
  assert.deepEqual(f.events, []);
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.fontListeners.size, 0);
  assert.equal(f.observers[0].targets.size, 0);
});

test('width notifications resize wrapping while height-only notifications do not create a feedback loop', (t) => {
  const f = fixture(t);
  const element = f.element('wrap');
  const cleanup = f.observeTextareaLayout(element);
  const observer = f.observers[0];
  observer.notify(element, 100);
  f.frame();
  f.frame();
  f.advance(140);
  f.frame();
  assert.equal(element.style.height, '20px');
  assert.equal(f.frames.size, 0);
  observer.notify(element, 100);
  assert.equal(f.frames.size, 0);
  element.columns = 4;
  observer.notify(element, 40);
  assert.equal(element.style.height, '20px', 'observer callback only queues the measurement');
  f.frame();
  assert.equal(element.style.height, '60px');
  cleanup();
});

test('late layout correction follows the most recent edit and also corrects intrinsic font changes', (t) => {
  const f = fixture(t);
  const element = f.element('late');
  const cleanup = f.observeTextareaLayout(element);
  f.frame();
  f.frame();
  f.advance(60);
  f.requestTextareaResize(element);
  f.frame();
  f.frame();
  f.advance(20);
  assert.equal(f.frames.size, 0, 'the obsolete deadline must not measure the newer edit early');
  element.columns = 2;
  f.advance(100);
  f.frame();
  assert.equal(element.style.height, '100px');
  cleanup();
});

test('font readiness and subsequent font loads remeasure active rows and ignore unmounted rows', async (t) => {
  const f = fixture(t);
  const element = f.element('font');
  const cleanup = f.observeTextareaLayout(element);
  f.frame();
  f.frame();
  element.columns = 5;
  f.resolveFonts();
  await Promise.resolve();
  f.frame();
  assert.equal(element.style.height, '40px');
  element.columns = 2;
  f.fontListeners.get('loadingdone')();
  f.frame();
  assert.equal(element.style.height, '100px');
  cleanup();
  f.events.length = 0;
  f.observers[0].notify(element, 10);
  f.frame();
  assert.deepEqual(f.events, []);
});

test('window resize still corrects wrapping when ResizeObserver is unavailable', (t) => {
  const f = fixture(t, { resizeObserver: false });
  const element = f.element('fallback');
  const cleanup = f.observeTextareaLayout(element);
  f.frame();
  element.columns = 3;
  f.listeners.get('resize')();
  f.frame();
  assert.equal(element.style.height, '80px');
  cleanup();
});

test('a disconnected textarea is never measured while its unmount cleanup is pending', (t) => {
  const f = fixture(t);
  const element = f.element('disconnected');
  const cleanup = f.observeTextareaLayout(element);
  element.isConnected = false;
  f.frame();
  f.advance(200);
  f.frame();
  assert.deepEqual(f.events, []);
  cleanup();
});

test('font readiness from a disposed subscription cannot restart measurements for a later mount', async (t) => {
  const f = fixture(t);
  const removeOld = f.observeTextareaLayout(f.element('old'));
  removeOld();
  f.document.fonts = { ready: new Promise(() => {}), addEventListener() {}, removeEventListener() {} };
  const removeNew = f.observeTextareaLayout(f.element('new'));
  f.frame();
  f.frame();
  f.advance(200);
  f.frame();
  f.events.length = 0;
  f.resolveFonts();
  await Promise.resolve();
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.events, []);
  removeNew();
});

test('all 20,000 registered rows are measured in one batch and share scheduler resources', (t) => {
  const f = fixture(t);
  const cleanups = Array.from({ length: 20000 }, (_, index) => f.observeTextareaLayout(f.element(String(index))));
  assert.equal(f.frames.size, 1);
  assert.equal(f.timers.size, 1);
  assert.equal(f.observers.length, 1);
  assert.equal(f.observers[0].targets.size, 20000);
  f.frame();
  assert.equal(f.events.length, 60000);
  assert.ok(f.events.slice(0, 20000).every((event) => event[1] === 'write' && event[2] === 'auto'));
  assert.ok(f.events.slice(20000, 40000).every((event) => event[1] === 'read'));
  assert.ok(f.events.slice(40000).every((event) => event[1] === 'write' && event[2] === '20px'));
  for (const cleanup of cleanups) cleanup();
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
});

test('the actual row input handler resizes before link suggestions read its geometry', () => {
  const filename = new URL('../src/App.tsx', import.meta.url).pathname;
  const ast = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = ast.statements.flatMap((statement) => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []);
  const row = declarations.find((declaration) => declaration.name.getText(ast) === 'OutlineNodeRow').initializer.arguments[0];
  const callbacks = row.body.statements.flatMap((statement) => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []);
  const load = (name, bindings) => {
    let callback = callbacks.find((declaration) => declaration.name.getText(ast) === name).initializer;
    if (ts.isCallExpression(callback)) callback = callback.arguments[0];
    const compiled = ts.transpileModule(`(${callback.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return vm.runInNewContext(compiled, bindings, { filename });
  };
  const element = { value: 'wrapped [[topic', selectionStart: 15, style: { height: '20px' }, scrollHeight: 80 };
  const calls = [];
  const synchronouslyResizedTextRef = { current: null };
  const autoResize = load('autoResize', { synchronouslyResizedTextRef });
  const handleChange = load('handleChange', {
    autoResize,
    setLocalText: (value) => calls.push(['text', value]),
    refreshLinkChoices: (value, caret) => {
      assert.equal(element.style.height, '80px', 'popup placement must see the new wrapped height in the input event');
      calls.push(['suggestions', value, caret]);
    },
  });
  handleChange({ target: element });
  assert.deepEqual(calls, [['text', 'wrapped [[topic'], ['suggestions', 'wrapped [[topic', 15]]);
  assert.equal(element.value, 'wrapped [[topic');
  assert.equal(element.selectionStart, 15);
  const effects = row.body.statements.filter((statement) => ts.isExpressionStatement(statement)
    && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(ast) === 'useLayoutEffect');
  const textEffect = effects.find((statement) => statement.expression.arguments[0].getText(ast).includes('synchronouslyResizedTextRef'));
  let queued = 0;
  const effectBindings = { synchronouslyResizedTextRef, localText: element.value, textareaRef: { current: element }, requestTextareaResize: () => { queued++; } };
  const compiled = ts.transpileModule(`(${textEffect.expression.arguments[0].getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, effectBindings)();
  assert.equal(queued, 0, 'the synchronously measured input must not queue settling reflows');
  effectBindings.localText = 'external update';
  vm.runInNewContext(compiled, effectBindings)();
  effectBindings.localText = element.value;
  vm.runInNewContext(compiled, effectBindings)();
  assert.equal(queued, 2, 'external edits and undo must still resize, including a previously measured value');
});
