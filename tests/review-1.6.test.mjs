import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import * as k from "../shared/bike-knowledge.mjs";
import { loadAppCallback, loadTypescript, projectRoot } from "./helpers/typescript.mjs";
import { createBackupService } from "../electron/backup-service.cjs";
import { WorkspaceStore, setNodeCheckedForMcp } from "../mcp/bike-core.mjs";
import { installFakeBrowserStorage } from "./helpers/fake-browser.mjs";
import { loadTypescriptIsolated } from "./helpers/typescript.mjs";

const root = projectRoot;
const tree = loadTypescript("src/tree.ts");
const md = loadTypescript("src/markdown.ts");
const history = loadTypescript("src/editHistory.ts");
const migrations = loadTypescript("src/migrations.ts");
const ids = loadTypescript("src/id.ts");
const timestamp = "2026-11-08T06:00:00.000Z";
const node = (id, text, extra = {}) => ({ id, text, note: "", checked: false, collapsed: false, color: "plain", headingLevel: 0, children: [], ...extra });
const doc = (id, title, nodes, extra = {}) => ({ id, title, nodes, createdAt: timestamp, updatedAt: timestamp, ...extra });
const ref = (id, nodeId, field, raw, target, start = 0) => ({ id, source: { kind: "node-field", nodeId, field, raw, start, end: start + raw.length }, target, labelMode: "auto" });
const knowledge = (references = [], relations = []) => ({ version: 1, references, relations });
const workspace = (documents) => ({ version: 1, activeDocumentId: documents[0].id, documents });

test("navigation preference quota failure keeps editing available and reports once", (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { setItem: () => { throw new Error("quota"); } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "localStorage", original); else delete globalThis.localStorage; });
  const f = fixture(workspace([doc("d", "D", [node("n", "N")])]));
  Object.assign(f.b, { ...loadTypescript("src/navigationStore.ts"), preferenceFailureRef: { current: false } });
  const persist = f.callback("persistPreference");
  assert.doesNotThrow(() => { persist("bike.navigation.v1", "{}"); persist("bike.navigation.v1", "{}"); });
  assert.equal(f.notices.length, 1);
  assert.equal(f.b.workspaceRef.current.documents[0].nodes[0].text, "N");
});

test("actual HTML and metadata export preserve readable relations and spaced identities", () => {
  const exporters = loadTypescript("src/exporters.ts");
  const original = doc("d", "D", [node("a", "Alpha  Beta"), node("b", "Child")], { knowledge: knowledge([], [{ id: "r", fromNodeId: "a", toNodeId: "b", label: "依赖 <script>" }]) });
  const html = exporters.exportDocument(original, "html");
  assert.match(html.content, /主题关系/);
  assert.match(html.content, /Alpha  Beta → Child/);
  assert.match(html.content, /&lt;script&gt;/);
  assert.match(k.readableRelations(original, { separator: " 指向 " })[0], /Alpha  Beta 指向 Child/);
  const exported = exporters.exportDocument(original, "markdown", { metadata: true });
  assert.equal(exported.lossy, false);
  const restored = exporters.importDocument(exported.content, exported.filename);
  assert.equal(restored.nodes[0].id, "a");
  assert.equal(restored.nodes[0].text, "Alpha  Beta");
  assert.equal(k.relationView(restored)[0].fromMissing, false);
});

test("saved filters persist every supported criterion", () => {
  const filter = { name: "Research", query: "term", tags: ["一", "二"], documentIds: ["d"], task: "open", favoriteOnly: true, includeCode: true };
  const saved = k.saveNavigationFilter(k.createNavigationState(), filter);
  const restored = k.normalizeNavigation(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(restored.filters[0], saved.filters[0]);
  assert.equal(k.deleteNavigationFilter(restored, saved.filters[0].id).filters.length, 0);
  assert.equal(k.renameNavigationFilter(restored, saved.filters[0].id, "改名").filters[0].name, "改名");
});

test("search gate: raw keystrokes do not run a second full-tree document search", () => {
  const value = workspace([doc("a", "A", [node("n", "Needle")]), doc("b", "B", [node("m", "Other")])]);
  const f = fixture(value);
  Object.assign(f.b, { workspace: value, sidebarView: "all", search: "Needle", selectedTag: null,
    collectDocumentText: () => assert.fail("raw input rescanned the entire document") });
  assert.equal(f.callback("matchingDocuments")().length, 2);
});

test("navigation gate: missing targets do not open a different topic and repeated locations get a new event", () => {
  const value = workspace([doc("d", "D", [node("n", "N")])]);
  const f = fixture(value);
  f.callback("openKnowledgeTarget")("d", "missing");
  assert.equal(f.b.workspaceRef.current, value);
  assert.ok(f.notices.includes("目标主题已不存在"));
  let location = { nodeId: null, documentId: null, version: 0 };
  f.b.setLocation = (update) => { location = update(location); };
  const locate = f.callback("setLocatedNodeId");
  locate("n", "d"); locate("n", "d");
  assert.equal(location.version, 2);
  assert.equal(location.nodeId, "n");
});

test("navigation gate: a distant mind-map item is fitted and centered inside the viewport", () => {
  const center = topLevel("centerMindMapItem", { clampNumber: (n, low, high) => Math.min(high, Math.max(low, n)) });
  const item = { x: 900, y: 22000, width: 360, height: 79 }, bounds = { width: 317, height: 520 };
  const viewport = center(bounds, item, 1);
  assert.ok(item.width * viewport.scale <= bounds.width - 48);
  assert.equal(viewport.x + (item.x + item.width / 2) * viewport.scale, bounds.width / 2);
  assert.equal(viewport.y + (item.y + item.height / 2) * viewport.scale, bounds.height / 2);
});

test("hub gate: the actual knowledge panel renders a bounded first page without losing the total", () => {
  const require = createRequire(import.meta.url);
  const React = require("react"), { renderToStaticMarkup } = require("react-dom/server");
  const module = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(path.join(root, "src/components/KnowledgePanel.tsx"), "utf8"), {
    fileName: "KnowledgePanel.tsx", compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`)(require, module, module.exports);
  const html = renderToStaticMarkup(React.createElement(module.exports.KnowledgePanel, {
    locked: false, activeNodeId: "n", connections: [], nodeBacklinks: [], relations: [], targets: [],
    documentBacklinks: Array.from({ length: 20000 }, (_,i) => ({ documentId: "source", documentTitle: "Source", nodeId: `n-${i}`, field: "text", raw: "[[D]]", pathLabel: `Topic ${i}`, status: "resolved" })),
    onOpen() {}, onOpenNode() {}, onFollow() {}, onAddRelation() {}, onDeleteRelation() {}, onReverseRelation() {}, onUpdateRelation: () => true,
  }));
  assert.equal((html.match(/data-backlink-source=/gu) ?? []).length, 100);
  assert.ok(html.includes("显示更多反向链接（100 / 20000）"));
  assert.ok(html.includes("Topic 99"));
  assert.equal(html.includes("Topic 100<"), false);
});

test("topic autocomplete starts at the hash and remains explicit for duplicate topics", () => {
  const result = k.suggestLinkTargets(workspace([doc("d", "Doc", [node("a", "Same"), node("b", "Same")])]), "Doc#");
  assert.equal(result.items.length, 2);
  assert.equal(result.requiresExplicit, true);
  assert.equal(result.highlight, -1);
});

test("closing saves the final draft before flushing its authoritative backup", async () => {
  const initial = workspace([doc("d", "D", [node("n", "before")])]);
  const latest = workspace([doc("d", "D", [node("n", "final draft")])]);
  const f = fixture(initial);
  const events = [];
  let commit;
  const gate = new Promise((resolve) => { commit = resolve; });
  Object.assign(f.b, {
    backupScheduleRef: { current: { ...k.createBackupSchedule(), enabled: true } }, backupPayloadsRef: { current: new Map() },
    backupTicketRef: { current: 0 }, backupTicketReadyRef: { current: true }, backupFlightRef: { current: null },
    flushPendingEditsRef: { current: () => { events.push("draft"); f.b.workspaceRef.current = latest; return latest; } },
    refreshRecoverySnapshots() {}, armBackupTimer() {}, getWorkspaceSaveRevision: () => 2,
    saveWorkspaceToStorage: async (value) => { assert.equal(value, latest); events.push("save-start"); await gate; events.push("saved"); return { ok: true, target: "indexeddb" }; },
    window: { bike: { enqueueBackup: async (request) => { events.push("backup"); assert.equal(request.workspace, latest); return { ok: true, ticket: request.ticket }; } } },
  });
  for (const name of ["showSaveResult", "saveWorkspace", "runBackupJob", "dispatchBackup", "flushScheduledBackup"]) f.b[name] = f.callback(name);
  const closing = f.callback("flushBackupBeforeClose")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["draft", "save-start"]);
  commit();
  await closing;
  assert.deepEqual(events, ["draft", "save-start", "saved", "backup"]);
  assert.equal(f.b.backupPayloadsRef.current.size, 0);
});

test("duplicate links retain identities through a known prefix edit and can be explicitly rebound", () => {
  const raw = "[[Plan]]";
  const before = doc("s", "S", [node("n", `${raw} ${raw}`)], { knowledge: knowledge([
    ref("a", "n", "text", raw, { documentId: "A" }), ref("b", "n", "text", raw, { documentId: "B" }, raw.length + 1),
  ]) });
  const shifted = k.withFieldText(before, { nodeId: "n", field: "text", text: `See ${raw} ${raw}` });
  assert.deepEqual(shifted.knowledge.references.map((item) => item.source.start), [4, 4 + raw.length + 1]);
  const ambiguous = k.withFieldText(shifted, { nodeId: "n", field: "text", text: raw });
  const rebound = k.attachReference(ambiguous, { source: { kind: "node-field", nodeId: "n", field: "text", start: 0, end: raw.length, raw }, target: { documentId: "B" } });
  assert.equal(rebound.error, null);
  assert.equal(k.resolveWikiLink(workspace([rebound.document, doc("B", "Plan", [])]), raw, { documentId: "s", kind: "node-field", nodeId: "n", field: "text", start: 0, end: raw.length }).documentId, "B");
});

test("backup coalescing ignores navigation but retains unknown nested content fields", () => {
  const before = workspace([doc("d", "D", [node("n", "N")], { knowledge: { version: 2, updatedAt: "opaque-1", collapsed: "opaque" } })]);
  const navigation = structuredClone(before);
  navigation.activeDocumentId = "other";
  navigation.documents[0].updatedAt = "later";
  navigation.documents[0].nodes[0].collapsed = true;
  assert.equal(k.backupContentHash(before), k.backupContentHash(navigation));
  navigation.documents[0].knowledge.updatedAt = "opaque-2";
  assert.notEqual(k.backupContentHash(before), k.backupContentHash(navigation));
});

test("an authoritative saved copy can resume a main-process source pause", () => {
  const value = workspace([doc("d", "D", [node("n", "N")])]);
  const f = fixture(value);
  Object.assign(f.b, {
    backupTicketRef: { current: 0 }, backupTicketReadyRef: { current: true },
    backupScheduleRef: { current: { ...k.createBackupSchedule(), enabled: true, paused: "local-source", lastHash: k.backupContentHash(value) } },
    isWorkspacePersisted: () => true, getWorkspaceSaveRevision: () => 5, setBackupStatus() {},
  });
  f.callback("applyBackupStatus")({ auto: true, paused: "local-source", lastSemanticHash: k.backupContentHash(value) });
  assert.equal(f.b.backupScheduleRef.current.paused, null);
  assert.equal(f.b.backupScheduleRef.current.lastHash, null);
});

test("autocomplete bindings contain a source span without embedding the whole editor draft", () => {
  const raw = "[[Plan]]";
  const document = doc("d", "D", [node("n", raw)]);
  const attached = k.attachReference(document, {
    source: { kind: "node-field", nodeId: "n", field: "text", start: 0, end: raw.length, raw, text: "large editor draft", labelMode: "auto" },
    target: { documentId: "target" },
  });
  assert.deepEqual(attached.reference.source, { kind: "node-field", nodeId: "n", field: "text", start: 0, end: raw.length, raw });
});

test("renaming a recycled name preserves the original Markdown occurrence binding", () => {
  const raw = "[[Plan]]";
  const body = `# Source\n\n- ${raw}`;
  const source = doc("source", "Source", [node("s", raw)], { markdownSource: body, knowledge: knowledge([{
    id: "ref", source: { kind: "markdown", start: body.indexOf(raw), end: body.indexOf(raw) + raw.length, raw }, target: { documentId: "original" }, labelMode: "auto",
  }]) });
  const value = { ...workspace([source, doc("replacement", "Plan", [node("p", "P")])]), trash: [{ document: doc("original", "Plan", []) }] };
  const renamed = k.renameTarget(value, { documentId: "replacement", nextLabel: "New plan" });
  const after = renamed.workspace.documents[0];
  assert.equal(after.markdownSource, body);
  assert.equal(after.nodes[0].text, raw);
  assert.deepEqual(after.knowledge, source.knowledge);
  assert.deepEqual(k.resolveDocumentConnections(renamed.workspace, after).map((item) => item.status), ["deleted"]);
});

test("MCP writes leave unrelated Markdown knowledge representations unchanged", async () => {
  const raw = "[[Other]]";
  const body = `# Source\n\n- ${raw}`;
  const source = doc("source", "Source", [node("s", raw)], { markdownSource: body, knowledge: knowledge([{
    id: "r", source: { kind: "markdown", start: body.indexOf(raw), end: body.indexOf(raw) + raw.length, raw }, target: { documentId: "other" }, labelMode: "auto",
  }]) });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bike-mcp-local-mutation-"));
  try {
    const workspacePath = path.join(directory, "workspace.json");
    await fs.writeFile(workspacePath, JSON.stringify(workspace([source, doc("other", "Other", [node("o", "O", { isTodo: true })])])));
    const store = new WorkspaceStore({ workspacePath, mode: "write" });
    const before = await store.load();
    await setNodeCheckedForMcp(store, { documentId: "other", nodeId: "o", checked: true, expectedRevision: before.revision, dryRun: false });
    const after = await store.load();
    assert.deepEqual(after.workspace.documents[0], before.workspace.documents[0]);
  } finally { await fs.rm(directory, { recursive: true }); }
});

function topLevel(name, bindings, filename = "src/App.tsx") {
  const source = readFileSync(path.join(root, filename), "utf8");
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const statement = ast.statements.find((item) => item.name?.text === name || (ts.isVariableStatement(item) && item.declarationList.declarations.some((item) => item.name.getText(ast) === name)));
  const declaration = ts.isVariableStatement(statement) ? statement.declarationList.declarations.find((item) => item.name.getText(ast) === name) : null;
  const expression = declaration ? declaration.initializer.getText(ast) : statement.getText(ast).replace(/^export\s+/, "");
  const code = ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(code, bindings);
}

function fixture(value) {
  const notices = [];
  const b = { ...k, ...tree, ...md, ...history, ...migrations, ...ids,
    ready: true, backupStatus: { auto: true }, backupLocalPauseRef: { current: null },
    backupScheduleRef: { current: k.createBackupSchedule() }, backupPayloadsRef: { current: new Map() },
    workspaceRef: { current: value }, historyRef: { current: history.emptyEditHistory() },
    activeNodeIdRef: { current: value.documents[0].nodes[0]?.id }, focusNodeId: null, modeRef: { current: "outline" },
    storageConflictRef: { current: false }, recoveryBusyRef: { current: false }, syncBusyRef: { current: false },
    now: () => timestamp, bumpHistoryVersion() {}, maybeCaptureAutoSnapshots() {},
    showNotice: (message) => notices.push(message), setActiveNodeId() {}, setFocusNodeId() {}, setPendingCaretFocus() {},
    flushPendingEdits: () => b.workspaceRef.current, flushFocusedStructuredInput: () => b.workspaceRef.current,
    replaceWorkspace: (next) => { b.workspaceRef.current = next; return next; },
    subtreeIds: (n) => [n.id, ...n.children.flatMap(b.subtreeIds)], rekeyKnowledgeNodes: k.rekeyNodes,
    setNodeClipboard: (value) => { b.nodeClipboard = value; }, MINDMAP_ROOT_ID: "__bike_mindmap_root__",
  };
  b.pauseLocalBackup = loadAppCallback("pauseLocalBackup", b);
  b.clearDocumentMarkdown = topLevel("clearDocumentMarkdown", b);
  b.commitWorkspace = loadAppCallback("commitWorkspace", b);
  b.patchActiveDocumentStable = loadAppCallback("patchActiveDocument", b);
  b.updateActiveNodesStable = loadAppCallback("updateActiveNodes", b);
  return { b, notices, callback: (name) => loadAppCallback(name, b) };
}

function memoryService() {
  const files = new Map();
  const timers = [];
  let settings = "";
  const service = createBackupService({
    fs: { mkdir: async () => {}, readFile: async (name) => {
      if (!files.has(name)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files.get(name);
    }, readdir: async () => [], stat: async () => ({ mtimeMs: 0 }), rm: async () => {} },
    path, getDirectory: async () => "/isolated-icloud",
    workspaceFilename: "bike-workspace.json", stampedPrefix: "bike-workspace-",
    hash: (text) => `hash:${text}`, migrate: async (value) => value,
    lock: async (_name, callback) => callback(), writeAtomic: async (name, content) => { files.set(name, content); },
    readSettings: async () => settings, writeSettings: async (text) => { settings = text; },
    setTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer: (timer) => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); },
  });
  return { service, files, timers };
}

test("review regression: duplicate deletion keeps ambiguous targets invalid", async () => {
  const raw = "[[Plan]]";
  const source = doc("source", "Note", [node("s", `${raw} ${raw}`)], { knowledge: knowledge([
    ref("rA", "s", "text", raw, { documentId: "A" }),
    ref("rB", "s", "text", raw, { documentId: "B" }, raw.length + 1),
  ]) });
  const edited = k.withFieldText(source, { nodeId: "s", field: "text", text: raw });
  assert.equal(edited.knowledge.references.length, 2);
  assert.ok(edited.knowledge.references.every((ref) => ref.source.start < 0));
  assert.equal(k.resolveDocumentConnections(workspace([edited, doc("A", "Plan", []), doc("B", "Plan", [])]), edited).some((item) => item.status === "resolved"), false);
});


test("review regression: Markdown is indexed once without recycled backlinks", async () => {
  const raw = "[[Plan]]";
  const source = doc("source", "Note", [node("s", raw)], { markdownSource: `# Note\n\n- ${raw}`, knowledge: knowledge([ref("r", "s", "text", raw, { documentId: "old" })]) });
  const value = { ...workspace([source, doc("new", "Plan", [node("n", "New")])]), trash: [{ document: doc("old", "Plan", [node("o", "Old")]) }] };
  const states = k.resolveDocumentConnections(value, source).map((item) => item.status);
  const falseBacklinks = k.backlinksFor(k.buildKnowledgeIndex(value), "new");
  assert.deepEqual(states, ["deleted"]);
  assert.equal(falseBacklinks.length, 0);
});


test("review regression: document copies remap Markdown self-targets", async () => {
  const raw = "[[Source#Child]]";
  const body = `# Source\n\n- Parent\n  > ${raw}\n  - Child`;
  const source = doc("source", "Source", [node("p", "Parent", { note: raw, children: [node("c", "Child")] })], { markdownSource: body, knowledge: knowledge([{
    id: "r", source: { kind: "markdown", start: body.indexOf(raw), end: body.indexOf(raw) + raw.length, raw }, target: { documentId: "source", nodeId: "c" }, labelMode: "auto",
  }]) });
  const f = fixture(workspace([source]));
  f.callback("duplicateDocument")();
  const copy = f.b.workspaceRef.current.documents[0];
  assert.notEqual(copy.id, "source");
  assert.equal(copy.knowledge.references[0].target.documentId, copy.id);
  assert.equal(copy.knowledge.references[0].target.nodeId, copy.nodes[0].children[0].id);
});


test("review regression: Markdown cuts retain their bound target", async () => {
  const raw = "[[Plan]]";
  const body = `# Source\n\n- ${raw}\n- Stay`;
  const source = doc("source", "Source", [node("moving", raw), node("stay", "Stay")], { markdownSource: body, knowledge: knowledge([{
    id: "r", source: { kind: "markdown", start: body.indexOf(raw), end: body.indexOf(raw) + raw.length, raw }, target: { documentId: "old" }, labelMode: "auto",
  }]) });
  const target = doc("target", "Target", [node("t", "Target")]);
  const f = fixture({ ...workspace([source, target, doc("new", "Plan", [node("n", "New")])]), activeDocumentId: "target", trash: [{ document: doc("old", "Plan", [node("o", "Old")]) }] });
  f.b.nodeClipboard = { mode: "cut", sourceDocumentId: "source", sourceId: "moving", node: source.nodes[0] };
  f.callback("pasteNodeAsChild")("t");
  const after = f.b.workspaceRef.current.documents.find((item) => item.id === "target");
  const links = k.resolveDocumentConnections(f.b.workspaceRef.current, after);
  assert.equal(links[0].reference.target.documentId, "old");
  assert.equal(links[0].status, "deleted");
});


test("review regression: import preserves external target identities", async () => {
  const raw = "[[Outside#Target]]";
  const incoming = doc("incoming", "Incoming", [node("collision", "Internal", { note: raw })], { knowledge: knowledge([ref("r", "collision", "note", raw, { documentId: "outside", nodeId: "collision" })]) });
  const remapped = k.remapCollidingIds(incoming, new Set(["outside", "collision"]), () => "new-node");
  assert.equal(remapped.document.knowledge.references[0].target.documentId, "outside");
  assert.equal(remapped.document.knowledge.references[0].target.nodeId, "collision");
});


test("review regression: unknown metadata refuses lossless export", async () => {
  const original = doc("d", "D", [node("n", "N")], { knowledge: { version: 2, opaque: { keep: "future-data" } } });
  const exported = k.finalizeMarkdownExport(md.documentToMarkdown(original), original, { metadata: true });
  const read = k.readBikeMetadata(exported.content);
  assert.equal(exported.lossy, true);
  assert.match(exported.error, /JSON/);
  assert.equal(read.status, "absent");
});


test("review regression: metadata restores spaced identities and relations", async () => {
  const original = doc("d", "D", [node("a", "Alpha  Beta"), node("b", "Child")], { knowledge: knowledge([], [{ id: "r", fromNodeId: "a", toNodeId: "b", label: "rel" }]) });
  const exported = k.finalizeMarkdownExport(md.documentToMarkdown(original), original, { metadata: true });
  const read = k.readBikeMetadata(exported.content);
  assert.equal(read.status, "matched");
  const restored = k.restoreMarkdownIdentity(md.parseMarkdownDocument(read.body), read.metadata, { matched: true });
  assert.equal(restored.nodes[0].id, "a");
  assert.equal(k.relationView(restored)[0].fromMissing, false);
});


test("review regression: MCP checkbox updates preserve source bindings", async () => {
  const raw = "[[Plan]]";
  const body = `# Source\n\n- ${raw}`;
  const source = doc("source", "Source", [node("s", raw, { isTodo: true })], { markdownSource: body, knowledge: knowledge([{
    id: "r", source: { kind: "markdown", start: body.indexOf(raw), end: body.indexOf(raw) + raw.length, raw }, target: { documentId: "old" }, labelMode: "auto",
  }]) });
  const value = { ...workspace([source, doc("new", "Plan", [node("n", "New")])]), trash: [{ id: "trash-old", document: doc("old", "Plan", [node("o", "Old")]), deletedAt: timestamp, originalIndex: 0 }] };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bike-full-review-mcp-"));
  const workspacePath = path.join(directory, "bike-workspace.json");
  await fs.writeFile(workspacePath, JSON.stringify(value));
  const store = new WorkspaceStore({ workspacePath, mode: "write", debug: true });
  const before = await store.load();
  await setNodeCheckedForMcp(store, { documentId: "source", nodeId: "s", checked: true, expectedRevision: before.revision, dryRun: false });
  const after = await store.load();
  const document = after.workspace.documents[0];
  assert.equal(document.markdownSource, undefined);
  const states = k.resolveDocumentConnections(after.workspace, document);
  assert.equal(states[0].reference.target.documentId, "old");
  assert.equal(states[0].status, "deleted");
  await fs.rm(directory, { recursive: true });
});


test("review regression: save failures pause queued backups", async () => {
  const value = workspace([doc("d", "D", [node("n", "saved-v1")])]);
  const f = fixture(value);
  const writes = [];
  Object.assign(f.b, {
    backupScheduleRef: { current: { ...k.createBackupSchedule(), enabled: true } },
    backupPayloadsRef: { current: new Map() }, backupTicketRef: { current: 0 }, backupTicketReadyRef: { current: true },
    refreshRecoverySnapshots() {}, getWorkspaceSaveRevision: () => 1, dispatchBackup() {}, armBackupTimer() {},
    window: { bike: { enqueueBackup: async (request) => { writes.push(request.workspace); return { ok: true, ticket: request.ticket }; } } },
  });
  const save = f.callback("showSaveResult");
  save({ ok: true, target: "indexeddb" }, value);
  save({ ok: false, error: new Error("disk failure") }, workspace([doc("d", "D", [node("n", "unsaved-v2")])]));
  const step = k.reduceBackupSchedule(f.b.backupScheduleRef.current, { type: "flush" }, Date.now());
  assert.equal(step.enqueue, null);
  f.b.backupScheduleRef.current = step.state;
  f.b.runBackupJob = f.callback("runBackupJob");
  await f.b.runBackupJob(step.enqueue);
  assert.equal(writes.length, 0);
});


test("review regression: startup recovers a saved unflushed backup", async () => {
  const { service, files } = memoryService();
  await service.setAuto(true);
  const value = workspace([doc("d", "D", [node("n", "saved-before-exit")])]);
  const old = fixture(value);
  Object.assign(old.b, {
    backupScheduleRef: { current: { ...k.createBackupSchedule(), enabled: true } }, backupPayloadsRef: { current: new Map() },
    backupTicketRef: { current: 0 }, backupTicketReadyRef: { current: true }, refreshRecoverySnapshots() {},
    getWorkspaceSaveRevision: () => 1, window: { bike: { enqueueBackup: async () => ({ ok: true }) } }, dispatchBackup() {}, armBackupTimer() {},
  });
  old.callback("showSaveResult")({ ok: true, target: "indexeddb" }, value);
  assert.ok(old.b.backupScheduleRef.current.pending);
  const f = fixture(value);
  Object.assign(f.b, {
    backupScheduleRef: { current: k.createBackupSchedule() }, backupPayloadsRef: { current: new Map() },
    backupTicketRef: { current: 0 }, backupTicketReadyRef: { current: false }, setBackupStatus() {},
    backupFlightRef: { current: null }, runBackupJob() {}, dispatchBackup: async () => {},
    isWorkspacePersisted: () => true, ready: true, storageConflict: false, recoveryBusy: false,
    getWorkspaceSaveRevision: () => 1, refreshRecoverySnapshots() {}, armBackupTimer() {},
    window: { bike: { enqueueBackup: async () => ({ ok: true }) } },
  });
  f.callback("applyBackupStatus")({ ...service.status() });
  f.b.showSaveResult = f.callback("showSaveResult");
  f.callback("resumePersistedBackup")();
  assert.ok(f.b.backupScheduleRef.current.pending);
  assert.equal(files.has("/isolated-icloud/bike-workspace.json"), false);
});


test("review regression: source edits relocate existing field bindings", async () => {
  const raw = "[[Plan]]";
  const before = md.parseMarkdownDocument(`# Source\n\n- ${raw}`, { documentId: "source" });
  before.knowledge = knowledge([ref("r", before.nodes[0].id, "text", raw, { documentId: "old" })]);
  const f = fixture(workspace([before]));
  const parse = f.callback("parseMarkdownIntoDocument");
  const after = parse(before, `# Source\n\n- See ${raw}`);
  const connections = k.resolveDocumentConnections({ ...workspace([after, doc("new", "Plan", [node("n", "New")])]), trash: [{ document: doc("old", "Plan", []) }] }, after);
  assert.deepEqual(connections.map((item) => item.status), ["deleted"]);
  assert.equal(connections[0].reference.target.documentId, "old");
});


test("review regression: document navigation exits subtree focus", async () => {
  const value = workspace([doc("d", "Document", [node("parent", "Parent", { children: [node("child", "Child")] })])]);
  const f = fixture(value);
  let focusCleared = false;
  Object.assign(f.b, { focusNodeId: "parent", setFocusNodeId: () => { focusCleared = true; }, setLocatedNodeId() {}, rememberNavigation() {}, window: { setTimeout: () => {} } });
  f.callback("openKnowledgeTarget")("d", null);
  assert.equal(focusCleared, true);
});


test("review regression: title hits obey node filter conditions", async () => {
  const value = workspace([doc("d", "Needle", [node("n", "Not a task, no tag")])]);
  const result = k.searchKnowledge(k.buildKnowledgeIndex(value), { query: "Needle", tags: ["not-present"], task: "done" });
  assert.equal(result.total, 0);
});


test("review regression: relation commands update document time", async () => {
  const document = doc("d", "D", [node("a", "A"), node("b", "B")]);
  const f = fixture(workspace([document]));
  f.b.activeDocument = document;
  f.b.activeNode = document.nodes[0];
  f.b.now = () => "2026-11-08T18:00:00.000Z";
  f.callback("changeRelation")("add", { fromNodeId: "a", toNodeId: "b", label: "depends" });
  const after = f.b.workspaceRef.current.documents[0];
  assert.equal(after.knowledge.relations.length, 1);
  assert.equal(after.updatedAt, f.b.now());
});

test("C01: saved A-B-A backs up the final receipt through storage and both queues", async (t) => {
  installFakeBrowserStorage(t);
  const storage = loadTypescriptIsolated("src/storage.ts");
  await storage.loadWorkspace();
  const { service, files } = memoryService();
  await service.setAuto(true);
  const value = (text) => workspace([doc("d", "D", [node("n", text)])]);
  const first = value("A"), middle = value("B"), latest = value("A");
  const f = fixture(first);
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  Object.assign(f.b, {
    ...storage, backupScheduleRef: { current: { ...k.createBackupSchedule(), enabled: true } },
    backupTicketRef: { current: 0 }, backupFlightRef: { current: null }, backupTicketReadyRef: { current: true },
    refreshRecoverySnapshots() {}, armBackupTimer() {}, saveWorkspaceToStorage: storage.saveWorkspace,
    window: { bike: { enqueueBackup: async (request) => {
      if (++requests === 1) { entered(); await gate; }
      return service.enqueue(request);
    } } },
  });
  for (const name of ["showSaveResult", "saveWorkspace", "runBackupJob", "dispatchBackup", "flushScheduledBackup"]) f.b[name] = f.callback(name);
  await f.b.saveWorkspace(first);
  const step = k.reduceBackupSchedule(f.b.backupScheduleRef.current, { type: "flush" }, Date.now());
  f.b.backupScheduleRef.current = step.state;
  const flight = f.b.dispatchBackup(step.enqueue);
  await started;
  await f.b.saveWorkspace(middle);
  await f.b.saveWorkspace(latest);
  release(); await flight;
  assert.equal(JSON.parse(files.get("/isolated-icloud/bike-workspace.json")).documents[0].nodes[0].text, "A");
  assert.equal(f.b.backupPayloadsRef.current.size, 0);
  assert.equal(f.b.backupScheduleRef.current.pending, null);
  assert.equal((await service.enqueue({ workspace: middle, sourceRevision: storage.getWorkspaceSaveRevision(middle), wait: true })).code, "stale-source");
});

test("C02: metadata restores the exact mixed tree, attributes and remapped connections", () => {
  const exporters = loadTypescript("src/exporters.ts");
  const raw = "[[D#List]]";
  const original = doc("d", "D", [
    node("h", "Heading", { headingLevel: 1, codeBlock: "const n = 1;", codeLanguage: "js" }),
    node("l", "List", { note: raw, bold: true, extension: { keep: 42 }, children: [node("child", "Child", { headingLevel: 2 })] }),
  ], { knowledge: knowledge([ref("r", "l", "note", raw, { documentId: "d", nodeId: "l" })], [{ id: "edge", fromNodeId: "h", toNodeId: "l", label: "依赖" }]) });
  const exported = exporters.exportDocument(original, "markdown", { metadata: true });
  assert.equal(exported.lossy, false);
  const restored = exporters.importDocument(exported.content, exported.filename);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.nodes)), JSON.parse(JSON.stringify(original.nodes)));
  let id = 0;
  const copy = k.remapCollidingIds(restored, new Set(["d", "h", "l", "child"]), (prefix) => `${prefix}-copy-${++id}`).document;
  assert.equal(copy.knowledge.references[0].target.documentId, copy.id);
  assert.equal(copy.knowledge.references[0].target.nodeId, copy.nodes[1].id);
  assert.equal(k.relationView(copy).some((edge) => edge.fromMissing || edge.toMissing), false);
  assert.deepEqual(k.resolveDocumentConnections(workspace([copy]), copy).map((item) => item.status), ["resolved"]);
});

test("C02: unsafe original-tree topology is rejected and external edits cannot replay attributes", () => {
  const exporters = loadTypescript("src/exporters.ts");
  const original = doc("d", "D", [node("n", "N", { bold: true })]);
  const exported = exporters.exportDocument(original, "markdown", { metadata: true });
  const edited = exporters.importDocument(exported.content.replace("- N", "- Different"), exported.filename);
  assert.equal(edited.nodes[0].text, "Different");
  assert.notEqual(edited.nodes[0].id, "n");
  const read = k.readBikeMetadata(exported.content);
  read.metadata.nodes[0].path = [1, 0];
  const corrupt = `${read.body}\n\n<!-- bike:document:v1 ${Buffer.from(JSON.stringify(read.metadata)).toString("base64url")} -->`;
  assert.equal(k.readBikeMetadata(corrupt).status, "invalid");
});

test("C03: the actual JSON import handler remaps self targets and preserves external pairs", async () => {
  const exporters = loadTypescript("src/exporters.ts");
  const raw = "[[Original#Child]]", external = "[[Outside#Child]]";
  const original = doc("original", "Original", [node("parent", raw, { note: external }), node("child", "Child")], { knowledge: knowledge([
    ref("self", "parent", "text", raw, { documentId: "original", nodeId: "child" }),
    ref("external", "parent", "note", external, { documentId: "outside", nodeId: "outside-child" }),
  ]) });
  const f = fixture(workspace([original, doc("outside", "Outside", [node("outside-child", "Child")])]));
  f.b.importDocument = exporters.importDocument;
  const exported = exporters.exportDocument(original, "json");
  await f.callback("handleImport")({ target: { value: "file", files: [{ name: exported.filename, text: async () => exported.content }] } });
  const copy = f.b.workspaceRef.current.documents[0];
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.knowledge.references[0].target.documentId, copy.id);
  assert.equal(copy.knowledge.references[0].target.nodeId, copy.nodes[1].id);
  assert.deepEqual(copy.knowledge.references[1].target, { documentId: "outside", nodeId: "outside-child" });
  assert.deepEqual(k.resolveDocumentConnections(f.b.workspaceRef.current, copy).map((item) => item.status), ["resolved", "resolved"]);
});

test("C04: special wiki names survive source parsing, structural editing and metadata import", () => {
  const exporters = loadTypescript("src/exporters.ts");
  for (const title of ["Doc#A", "Doc|A", "Doc]A", "Doc `A`", String.raw`Doc\A`]) {
    const raw = k.formatWikiLink({ documentName: title });
    const body = `# Source\n\n- ${raw}`;
    const source = md.parseMarkdownDocument(body, { documentId: "s" });
    source.knowledge = knowledge([{ id: "r", source: { kind: "markdown", start: body.indexOf(raw), end: body.indexOf(raw) + raw.length, raw }, target: { documentId: "target" }, labelMode: "auto" }]);
    assert.equal(source.nodes[0].text, raw);
    const f = fixture(workspace([source]));
    const changed = f.b.clearDocumentMarkdown({ ...source, nodes: source.nodes.map((n) => ({ ...n, checked: true })) });
    const target = doc("target", title, []);
    const value = workspace([changed, target, doc("wrong", "Doc", [node("a", "A")])]);
    assert.deepEqual(k.resolveDocumentConnections(value, changed).map((item) => item.reference?.target.documentId), ["target"]);
    const exported = exporters.exportDocument(changed, "markdown", { metadata: true });
    const restored = exporters.importDocument(exported.content, exported.filename);
    assert.equal(restored.nodes[0].text, raw);
    assert.equal(k.resolveDocumentConnections(workspace([restored, target]), restored)[0].status, "resolved");
  }
});

test("C04/C08: escaped literals and multi-backtick code never become backlinks or rename edits", () => {
  for (const literal of [String.raw`\[[Plan]]`, "Use ``[[Plan]]`` as a literal", "Use ``one ` [[Plan]] two``", "Use `one\n[[Plan]] two`"]) {
    const source = md.parseMarkdownDocument(`# Source\n\n- ${literal}`, { documentId: "s" });
    const value = workspace([source, doc("plan", "Plan", [])]);
    assert.equal(k.resolveDocumentConnections(value, source).length, 0, literal);
    assert.equal(k.backlinksFor(k.buildKnowledgeIndex(value), "plan").length, 0, literal);
    const renamed = k.renameTarget(value, { documentId: "plan", nextLabel: "New" });
    assert.equal(renamed.workspace.documents[0].nodes[0].text, source.nodes[0].text);
    assert.equal(renamed.workspace.documents[0].markdownSource, source.markdownSource);
  }
});

test("C05: Markdown title rename updates all sources in one undo step and keeps raw formatting", () => {
  const raw = "[[Old]]";
  const target = md.parseMarkdownDocument("# Old\n\n* Target", { documentId: "target" });
  const source = doc("source", "Source", [node("s", raw)], { knowledge: knowledge([ref("r", "s", "text", raw, { documentId: "target" })]) });
  const weak = doc("weak", "Weak", [node("w", raw)]);
  const before = workspace([target, source, weak]);
  const f = fixture(before);
  f.b.modeRef.current = "markdown";
  f.b.parseMarkdownIntoDocument = f.callback("parseMarkdownIntoDocument");
  f.b.replaceMarkdownTitle = topLevel("replaceMarkdownTitle", f.b);
  f.callback("updateTitle")("New");
  const after = f.b.workspaceRef.current;
  assert.equal(after.documents[0].markdownSource, "# New\n\n* Target");
  assert.equal(after.documents[1].nodes[0].text, "[[New]]");
  assert.equal(after.documents[2].nodes[0].text, "[[New]]");
  const undone = history.undo({ history: f.b.historyRef.current, workspace: after, now: timestamp });
  assert.equal(undone.workspace.documents[0].title, "Old");
  assert.equal(undone.workspace.documents[1].nodes[0].text, raw);
  assert.equal(undone.workspace.documents[2].nodes[0].text, raw);
});

test("C06: one-line duplicate edits keep both ids while reorder remains unbound", () => {
  const before = md.parseMarkdownDocument("# D\n\n- Same\n- Same", { documentId: "d" });
  const after = md.parseMarkdownDocument("# D\n\n- Same edited\n- Same", { documentId: "d", previousDocument: before });
  assert.deepEqual(after.nodes.map((n) => n.id), before.nodes.map((n) => n.id));
  const raw = "[[D#Same]]";
  const source = doc("s", "S", [node("n", raw)], { knowledge: knowledge([ref("r", "n", "text", raw, { documentId: "d", nodeId: before.nodes[0].id })]) });
  assert.equal(k.resolveDocumentConnections(workspace([after, source]), source)[0].status, "resolved");
});

test("source edit gate: raw Markdown title and topic renames follow references and undo together", () => {
  const target = md.parseMarkdownDocument("# Old\n\n- Topic", { documentId: "d" });
  const id = target.nodes[0].id;
  const source = doc("s", "Source", [node("n", "[[Old]]", { note: "[[Old#Topic]]" })]);
  const f = fixture(workspace([target, source]));
  Object.assign(f.b, { markdownParseTimerRef: { current: null }, markdownDraftRef: { current: null }, window: { clearTimeout() {} } });
  f.b.parseMarkdownIntoDocument = f.callback("parseMarkdownIntoDocument");
  const commit = f.callback("flushMarkdownDraft");
  f.b.markdownDraftRef.current = { documentId: "d", value: "# New\n\n- Topic", dirty: true };
  commit();
  assert.equal(f.b.workspaceRef.current.documents[1].nodes[0].text, "[[New]]");
  assert.equal(f.b.workspaceRef.current.documents[1].nodes[0].note, "[[New#Topic]]");
  f.b.markdownDraftRef.current = { documentId: "d", value: "# New\n\n- Topic edited", dirty: true };
  commit();
  const after = f.b.workspaceRef.current;
  assert.equal(after.documents[0].nodes[0].id, id);
  assert.equal(after.documents[1].nodes[0].note, "[[New#Topic edited]]");
  const undone = history.undo({ history: f.b.historyRef.current, workspace: after, now: timestamp });
  assert.equal(undone.workspace.documents[0].title, "New");
  assert.equal(undone.workspace.documents[1].nodes[0].note, "[[New#Topic]]");
  const original = history.undo({ history: undone.history, workspace: undone.workspace, now: timestamp });
  assert.equal(original.workspace.documents[0].title, "Old");
  assert.equal(original.workspace.documents[1].nodes[0].note, "[[Old#Topic]]");
});

test("C07: an ambiguous field does not disable identical weak links in another field or node", () => {
  const raw = "[[Plan]]";
  const before = doc("s", "S", [node("one", `${raw} ${raw}`, { note: raw }), node("two", raw)], { knowledge: knowledge([
    ref("r1", "one", "text", raw, { documentId: "p" }), ref("r2", "one", "text", raw, { documentId: "p" }, raw.length + 1),
  ]) });
  const after = k.withFieldText(before, { nodeId: "one", field: "text", text: raw });
  const value = workspace([after, doc("p", "Plan", [])]);
  for (const [nodeId, field] of [["one", "note"], ["two", "text"]]) {
    assert.equal(k.resolveWikiLink(value, raw, { documentId: "s", kind: "node-field", nodeId, field, start: 0, end: raw.length }).status, "resolved");
  }
  assert.equal(k.resolveWikiLink(value, raw, { documentId: "s", kind: "node-field", nodeId: "one", field: "text", start: 0, end: raw.length }).status, "sourceMismatch");
  assert.equal(k.resolveDocumentConnections(value, after).filter((item) => item.status === "resolved").length, 2);
});

test("C07 cross-flow: reordered bindings stay guarded through copy, move and rebind", () => {
  const raw = "[[Plan]]";
  const markdown = (rows) => ["# Source", "", ...rows].join(String.fromCharCode(10));
  const before = md.parseMarkdownDocument(markdown([`- Same ${raw}`, `- Same ${raw}`, "- Tail", `- Independent ${raw}`]), { documentId: "s" });
  before.knowledge = knowledge(before.nodes.slice(0, 2).map((n, i) => ref(`r${i}`, n.id, "text", raw, { documentId: "old" }, 5)));
  const after = md.parseMarkdownDocument(markdown([`- Same ${raw}`, "- Tail", `- Same ${raw}`, `- Independent ${raw}`]), { previousDocument: before });
  after.knowledge = k.reconcileMarkdownReferences(before, after);
  const value = { ...workspace([after, doc("new", "Plan", []), doc("destination", "Destination", [node("root", "Root")])]), trash: [{ document: doc("old", "Plan", []) }] };
  const resolved = (w, d) => k.resolveDocumentConnections(w, d).filter((item) => item.status === "resolved");
  assert.equal(resolved(value, after).length, 1);
  assert.equal(Object.keys(after.knowledge.sourceGroups).length, 1);
  const renamed = k.renameTarget(value, { documentId: "new", nextLabel: "New plan" }).workspace.documents[0];
  assert.equal(renamed.nodes[0].text, `Same ${raw}`);
  assert.equal(renamed.nodes[3].text, "Independent [[New plan]]");
  assert.ok(renamed.markdownSource.includes("Independent [[New plan]]"));
  const copyFixture = fixture(value);
  copyFixture.callback("duplicateDocument")();
  const copy = copyFixture.b.workspaceRef.current.documents[0];
  assert.equal(resolved(copyFixture.b.workspaceRef.current, copy).length, 1);
  const moveFixture = fixture({ ...value, activeDocumentId: "destination" });
  moveFixture.b.nodeClipboard = { mode: "cut", sourceDocumentId: "s", sourceId: after.nodes[0].id, node: after.nodes[0] };
  moveFixture.callback("pasteNodeAsChild")("root");
  const movedWorkspace = moveFixture.b.workspaceRef.current;
  const moved = movedWorkspace.documents.find((d) => d.id === "destination");
  assert.equal(resolved(movedWorkspace, moved).length, 0);
  const rebound = k.attachReference(moved, { source: { kind: "node-field", nodeId: after.nodes[0].id, field: "text", start: 5, end: 5 + raw.length, raw }, target: { documentId: "new" } }).document;
  assert.equal(resolved({ ...movedWorkspace, documents: movedWorkspace.documents.map((d) => d.id === moved.id ? rebound : d) }, rebound).length, 1);
  assert.equal(rebound.knowledge.references.some((r) => r.source.groupId), false);
  let removed = after;
  for (const n of after.nodes.filter((n) => n.text === `Same ${raw}`)) removed = k.withFieldText(removed, { nodeId: n.id, field: "text", text: "Removed" });
  assert.equal(removed.knowledge.references.length, 0);
  const exporters = loadTypescript("src/exporters.ts");
  const exported = exporters.exportDocument(after, "markdown", { metadata: true });
  assert.equal(exported.error, undefined);
  for (const content of [exported.content, exported.content.replace("# Source", "# External title")]) {
    const restored = exporters.importDocument(content, exported.filename);
    assert.equal(resolved({ ...value, documents: [restored, ...value.documents.slice(1)] }, restored).length, 1);
  }
});

test("export gates: protocol examples in code remain content and whitespace identity survives external title edits", () => {
  const exporters = loadTypescript("src/exporters.ts");
  const code = ["<!-- bike:document:v1 AAAA -->", "<!-- bike-export:lossy -->"].join(String.fromCharCode(10));
  const document = doc("d", "D", [node("n", "Alpha  Beta", { codeBlock: code })]);
  const plain = exporters.exportDocument(document, "markdown");
  assert.ok(plain.content.includes("bike-export:lossy"));
  assert.equal(k.readBikeMetadata(plain.content).status, "absent");
  const exported = exporters.exportDocument(document, "markdown", { metadata: true });
  const restored = exporters.importDocument(exported.content, exported.filename);
  assert.equal(restored.nodes[0].codeBlock, code);
  const edited = exporters.importDocument(exported.content.replace("# D", "# External title"), exported.filename);
  assert.equal(edited.nodes[0].id, "n");
  const metadata = k.readBikeMetadata(exported.content).metadata;
  metadata.knowledge = knowledge([{ id: "bad", source: { kind: "node-field", raw: "x", start: 0, end: 1 }, target: { documentId: "d", nodeId: {} }, labelMode: "auto" }]);
  const broken = `# D${String.fromCharCode(10)}<!-- bike:document:v1 ${Buffer.from(JSON.stringify(metadata)).toString("base64url")} -->`;
  assert.equal(k.readBikeMetadata(broken).status, "invalid");
});

test("lexer gate: escaped tags stay literal while real tags survive structural Markdown export", () => {
  assert.equal(md.parseMarkdownDocument(String.raw`# Doc \#A`).title, "Doc #A");
  assert.equal(md.parseMarkdownDocument(String.raw`# Doc \[[A]]`).title, "Doc [[A]]");
  const text = String.raw`#real \#literal ` + '`#code`';
  const source = md.parseMarkdownDocument(["# D", "", `- ${text}`].join(String.fromCharCode(10)), { documentId: "d" });
  assert.deepEqual(k.buildKnowledgeIndex(workspace([source])).tags.map((tag) => tag.label), ["real"]);
  delete source.markdownSource;
  const restored = md.parseMarkdownDocument(md.documentToMarkdown(source), { documentId: "d" });
  assert.deepEqual(k.buildKnowledgeIndex(workspace([restored])).tags.map((tag) => tag.label), ["real"]);
});
