import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { isTrustedIpcSender } from './ipc-guard.cjs';

test('each reopened macOS window waits for its own backup flush', () => {
  const source = readFileSync(new URL('./main.cjs', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('main.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = ast.statements.flatMap((item) => ts.isVariableStatement(item) ? [...item.declarationList.declarations] : []).find((item) => item.name.getText(ast) === 'createWindow');
  const windows = [];
  const ipcMain = new EventEmitter();
  class Window {
    constructor(options) {
      this.options = options;
      windows.push(this); this.handlers = new Map(); this.messages = []; this.closed = false;
      this.webContents = { id: windows.length, mainFrame: { routingId: 1, processId: 1, url: 'file:///app/index.html' }, on() {}, setWindowOpenHandler() {}, isDestroyed: () => false, send: (message) => this.messages.push(message) };
    }
    on(name, callback) { this.handlers.set(name, callback); }
    loadFile() {}
    close() {
      let prevented = false;
      this.handlers.get('close')?.({ preventDefault: () => { prevented = true; } });
      if (!prevented) { this.closed = true; this.handlers.get('closed')?.(); }
    }
  }
  const create = vm.runInNewContext(`(${declaration.initializer.getText(ast)})`, {
    BrowserWindow: Window, path: { join: (...parts) => parts.join('/') }, __dirname: '/electron', mainWindow: null, ipcMain,
    setTimeout: () => ({}), clearTimeout() {}, isDev: false,
    isTrustedIpcSender, isAllowedAppUrl: () => true, aiRequests: new Map(), liveService: null,
  });
  for (let i = 0; i < 2; i++) {
    create();
    const window = windows[i];
    assert.equal(window.options.width, 1366);
    assert.equal(window.options.height, 960);
    assert.equal(window.options.minWidth, window.options.width);
    assert.equal(window.options.minHeight, window.options.height);
    window.close(); window.close();
    assert.equal(window.closed, false);
    assert.deepEqual(window.messages, ['backup-flush-request']);
    ipcMain.emit('backup-flush-done', { sender: {} });
    assert.equal(window.closed, false);
    ipcMain.emit('backup-flush-done', { sender: window.webContents, senderFrame: { ...window.webContents.mainFrame, routingId: 2 } });
    assert.equal(window.closed, false);
    ipcMain.emit('backup-flush-done', { sender: window.webContents, senderFrame: window.webContents.mainFrame });
    assert.equal(window.closed, true);
    assert.equal(ipcMain.listenerCount('backup-flush-done'), 0);
  }
});

test('close deadline records a durable timeout receipt before allowing the window to close', async () => {
  const source = readFileSync(new URL('./main.cjs', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('main.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = ast.statements.flatMap((item) => ts.isVariableStatement(item) ? [...item.declarationList.declarations] : []).find((item) => item.name.getText(ast) === 'createWindow');
  const ipcMain = new EventEmitter();
  let window, deadline, releaseReceipt;
  const events = [];
  class Window extends EventEmitter {
    constructor() { super(); window = this; this.webContents = { on() {}, setWindowOpenHandler() {}, isDestroyed: () => false, send() {} }; }
    loadFile() {}
    close() { let prevented = false; this.emit('close', { preventDefault: () => { prevented = true; } }); if (!prevented) events.push('closed'); }
  }
  const create = vm.runInNewContext(`(${declaration.initializer.getText(ast)})`, {
    BrowserWindow: Window, path: { join: (...parts) => parts.join('/') }, __dirname: '/electron', mainWindow: null, ipcMain,
    setTimeout: (callback) => { deadline = callback; return {}; }, clearTimeout() {}, isDev: false,
    isTrustedIpcSender, isAllowedAppUrl: () => true, aiRequests: new Map(), liveService: null, console,
    backupService: async () => ({ recordCloseTimeout: async () => { events.push('receipt-start'); await new Promise((resolve) => { releaseReceipt = resolve; }); events.push('receipt-saved'); } }),
  });
  create(); window.close(); deadline();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['receipt-start']);
  releaseReceipt();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['receipt-start', 'receipt-saved', 'closed']);
  assert.equal(ipcMain.listenerCount('backup-flush-done'), 0);
});

test('macOS quit resumes after backup flush while ordinary window close permits reopening', () => {
  const source = readFileSync(new URL('./main.cjs', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('main.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = ast.statements.flatMap((item) => ts.isVariableStatement(item) ? [...item.declarationList.declarations] : []).find((item) => item.name.getText(ast) === 'createWindow');
  const lifecycle = ast.statements.filter((item) => ts.isExpressionStatement(item)
    && ts.isCallExpression(item.expression) && item.expression.expression.getText(ast) === 'app.on'
    && ['before-quit', 'window-all-closed', 'activate'].includes(item.expression.arguments[0]?.text));
  const app = new EventEmitter();
  const ipcMain = new EventEmitter();
  const windows = [];
  let exited = false;
  class Window extends EventEmitter {
    static getAllWindows() { return windows.filter((window) => !window.closed); }
    constructor() {
      super(); windows.push(this); this.closed = false; this.messages = [];
      this.webContents = { id: windows.length, mainFrame: { routingId: 1, processId: 1, url: 'file:///app/index.html' }, on() {}, setWindowOpenHandler() {}, isDestroyed: () => false, send: (message) => this.messages.push(message) };
    }
    loadFile() {}
    close() {
      let prevented = false;
      this.emit('close', { preventDefault: () => { prevented = true; } });
      if (prevented) return;
      this.closed = true; this.emit('closed');
      if (!Window.getAllWindows().length) app.emit('window-all-closed');
    }
  }
  app.quit = () => {
    app.emit('before-quit');
    const open = Window.getAllWindows();
    for (const window of open) window.close();
    if (!Window.getAllWindows().length) exited = true;
  };
  const context = vm.createContext({
    app, ipcMain, BrowserWindow: Window, path: { join: (...parts) => parts.join('/') }, __dirname: '/electron',
    mainWindow: null, process: { platform: 'darwin' }, setTimeout: () => ({}), clearTimeout() {}, isDev: false,
    isTrustedIpcSender, isAllowedAppUrl: () => true, aiRequests: new Map(), liveService: null,
  });
  vm.runInContext(`let quitting = false; const createWindow = ${declaration.initializer.getText(ast)};\n${lifecycle.map((item) => item.getText(ast)).join('\n')}\ncreateWindow();`, context);
  windows[0].close();
  assert.equal(exited, false);
  ipcMain.emit('backup-flush-done', { sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame });
  assert.equal(windows[0].closed, true);
  assert.equal(exited, false);
  app.emit('activate');
  assert.equal(windows.length, 2);
  app.quit();
  assert.equal(exited, false);
  assert.equal(windows[1].closed, false);
  assert.deepEqual(windows[1].messages, ['backup-flush-request']);
  ipcMain.emit('backup-flush-done', { sender: windows[1].webContents, senderFrame: windows[1].webContents.mainFrame });
  assert.equal(windows[1].closed, true);
  assert.equal(exited, true);
  assert.equal(ipcMain.listenerCount('backup-flush-done'), 0);
});
