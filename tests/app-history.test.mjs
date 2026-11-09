import assert from "node:assert/strict";
import test from "node:test";
import { loadAppCallback, loadTypescript } from "./helpers/typescript.mjs";
import * as attachments from "../shared/bike-attachments.mjs";

const editHistory = loadTypescript("src/editHistory.ts");
const signatures = loadTypescript("src/documentSignature.ts");
const tree = loadTypescript("src/tree.ts");
const knowledge = loadTypescript("src/knowledge.ts");
const { migrateWorkspace } = loadTypescript("src/migrations.ts");

const timestamp = "2026-11-08T06:00:00.000Z";
const initialWorkspace = () => migrateWorkspace({
  version: 1, activeDocumentId: "doc", documents: [{
    id: "doc", title: "Document", createdAt: timestamp, updatedAt: timestamp,
    nodes: [{ id: "one", text: "One", children: [] }, { id: "two", text: "Two", children: [] }],
  }],
});

function fixture() {
  const workspace = initialWorkspace();
  const notices = [];
  const bindings = {
    ...tree,
    ...knowledge,
    ...editHistory,
    ...signatures,
    ...attachments,
    assertTreeBudget: () => {},
    workspaceRef: { current: workspace },
    cleanupBusyRef: { current: false },
    updateInstallRef: { current: null },
    backupLocalPauseRef: { current: null },
    backupScheduleRef: { current: knowledge.createBackupSchedule() },
    backupPayloadsRef: { current: new Map() },
    backupErrorNoticeRef: { current: null },
    backupTicketRef: { current: 0 },
    historyRef: { current: editHistory.emptyEditHistory() },
    activeNodeIdRef: { current: "one" },
    ready: true,
    modalOpenRef: { current: false },
    syncBusyRef: { current: false },
    historyBusyRef: { current: false },
    recoveryBusyRef: { current: false },
    storageConflictRef: { current: false },
    modeRef: { current: "outline" },
    focusNodeId: null,
    selectedTags: [], filterDocumentIds: [], favoriteOnly: false, includeCode: false, navigation: { favorites: [] },
    now: () => timestamp,
    bumpHistoryVersion: () => {},
    maybeCaptureAutoSnapshots: () => {},
    replaceWorkspace: (next) => { bindings.workspaceRef.current = next; return next; },
    showNotice: (message) => { notices.push(message); },
    clearDocumentMarkdown: (document) => {
      const { markdownSource, markdownUpdatedAt, ...rest } = document;
      return rest;
    },
    setActiveNodeId: (id) => { bindings.activeNodeIdRef.current = id; },
    setFocusNodeId: () => {},
    setNavigationTarget: () => {},
    setPendingCaretFocus: () => {},
    setNodeClipboard: () => {},
    flushFocusedStructuredInput: () => bindings.workspaceRef.current,
    flushPendingEdits: () => bindings.workspaceRef.current,
    document: { activeElement: null },
    HTMLElement: class {},
    MINDMAP_ROOT_ID: "__bike_mindmap_root__",
    subtreeIds: (node) => [node.id, ...(node.children ?? []).flatMap((child) => bindings.subtreeIds(child))],
    rekeyKnowledgeNodes: knowledge.rekeyNodes,
    getWorkspaceSaveRevision: () => 1,
    migrateWorkspace,
  };
  bindings.pauseLocalBackup = loadAppCallback("pauseLocalBackup", bindings);
  bindings.commitWorkspace = loadAppCallback("commitWorkspace", bindings);
  bindings.patchActiveDocumentStable = loadAppCallback("patchActiveDocument", bindings);
  bindings.updateActiveNodesStable = loadAppCallback("updateActiveNodes", bindings);
  bindings.clearEditHistory = () => { bindings.historyRef.current = editHistory.emptyEditHistory(); };
  bindings.pasteNodeAsChild = loadAppCallback("pasteNodeAsChild", bindings);
  return { bindings, notices, workspace, callback: (name) => loadAppCallback(name, bindings) };
}

test("structural editor commands enter the same undo stack without leaking text groups", () => {
  const f = fixture();
  f.callback("handleNodeText")("one", "One");
  f.callback("insertAfter")("one");
  assert.equal(f.bindings.historyRef.current.past.length, 1);
  assert.equal(f.bindings.historyRef.current.past[0].group, null);
  const addedId = f.bindings.workspaceRef.current.documents[0].nodes[1].id;
  f.callback("removeActiveNode")(addedId);
  assert.equal(f.bindings.historyRef.current.past.length, 2);
  f.callback("performHistoryStep")("undo");
  assert.equal(f.bindings.workspaceRef.current.documents[0].nodes[1].id, addedId);
  f.callback("performHistoryStep")("undo");
  assert.deepEqual(f.bindings.workspaceRef.current.documents[0].nodes.map((node) => node.id), ["one", "two"]);
  f.callback("performHistoryStep")("redo");
  assert.equal(f.bindings.workspaceRef.current.documents[0].nodes[1].id, addedId);
});

test("dragged tree updates and format changes are individually reversible", () => {
  const f = fixture();
  f.callback("setActiveNodes")("two", "one", "before");
  f.callback("handleNodePatch")("two", { bold: true, color: "green" });
  f.callback("performHistoryStep")("undo");
  assert.equal(f.bindings.workspaceRef.current.documents[0].nodes[0].bold, false);
  f.callback("performHistoryStep")("undo");
  assert.deepEqual(f.bindings.workspaceRef.current.documents[0].nodes.map((node) => node.id), ["one", "two"]);
});

test("navigation reveals a collapsed ancestor without persisting it or invalidating undo", () => {
  const f = fixture();
  f.bindings.workspaceRef.current.documents[0].nodes = [{
    ...tree.createNode("Parent"), id: "one", collapsed: true,
    children: [{ ...tree.createNode("Child"), id: "child" }],
  }, f.workspace.documents[0].nodes[1]];
  f.callback("handleNodeText")("two", "Edited");
  const edited = f.bindings.workspaceRef.current;
  Object.assign(f.bindings, {
    window: { setTimeout: () => 0 },
    setLocatedNodeId: () => {}, rememberNavigation: () => {},
    setMode: () => {},
  });
  f.callback("openKnowledgeTarget")("doc", "child");
  assert.equal(f.bindings.workspaceRef.current.documents, edited.documents);
  assert.equal(f.bindings.workspaceRef.current.documents[0].nodes[0].collapsed, true);
  f.callback("performHistoryStep")("undo");
  assert.equal(f.bindings.workspaceRef.current.documents[0].nodes[1].text, "Two");
  assert.ok(!f.notices.some((notice) => notice.includes("已清空撤销")));
});

test("version restoration refuses to overwrite edits made while its snapshot is pending", async () => {
  const f = fixture();
  let finishSnapshot;
  const pending = new Promise((resolve) => { finishSnapshot = resolve; });
  Object.assign(f.bindings, {
    window: { confirm: () => true },
    setHistoryBusy: () => {},
    setHistoryError: () => {},
    captureSnapshot: () => pending,
    listDocumentSnapshots: async () => [],
    setHistorySnapshots: () => {},
  });
  const operation = f.callback("restoreVersionSnapshot")({
    documentId: "doc", title: "Old version", document: f.workspace.documents[0],
  });
  f.callback("handleNodeText")("one", "Newer edit");
  const edited = f.bindings.workspaceRef.current;
  finishSnapshot([]);
  await operation;
  assert.equal(f.bindings.workspaceRef.current, edited);
  assert.ok(f.notices.some((notice) => notice.includes("已取消恢复")));
  assert.equal(f.bindings.historyBusyRef.current, false);
});


test("cutting a node across documents retargets incoming links", () => {
  const f = fixture();
  const sourceNode = {
    id: "moving", text: "Moving", note: "", checked: false, collapsed: false, color: "plain", children: [],
  };
  const reference = {
    id: "ref", source: { kind: "node-field", nodeId: "source-node", field: "text", start: 0, end: 10, raw: "[[Moving]]" },
    target: { documentId: "doc", nodeId: "moving" }, labelMode: "auto",
  };
  f.bindings.workspaceRef.current = {
    version: 1, activeDocumentId: "target",
    documents: [
      { id: "doc", title: "Source", createdAt: timestamp, updatedAt: timestamp, nodes: [{ id: "source-node", text: "[[Moving]]", note: "", checked: false, collapsed: false, color: "plain", children: [] }, sourceNode], knowledge: { version: 1, references: [reference], relations: [] } },
      { id: "target", title: "Target", createdAt: timestamp, updatedAt: timestamp, nodes: [{ id: "target-node", text: "Target", note: "", checked: false, collapsed: false, color: "plain", children: [] }] },
    ],
  };
  f.bindings.nodeClipboard = { mode: "cut", sourceDocumentId: "doc", sourceId: "moving", node: sourceNode };
  f.callback("pasteNodeAsChild")("target-node");
  const source = f.bindings.workspaceRef.current.documents[0];
  const target = f.bindings.workspaceRef.current.documents[1];
  assert.equal(source.knowledge.references[0].target.documentId, "target");
  assert.equal(target.nodes[0].children[0].id, "moving");
});

test("a link inside the destination document follows a moved node", () => {
  const f = fixture();
  const sourceNode = {
    id: "moving", text: "Moving", note: "", checked: false, collapsed: false, color: "plain", children: [],
  };
  const destinationReference = {
    id: "dest-ref", source: { kind: "node-field", nodeId: "target-node", field: "text", start: 0, end: 10, raw: "[[Moving]]" },
    target: { documentId: "doc", nodeId: "moving" }, labelMode: "auto",
  };
  f.bindings.workspaceRef.current = {
    version: 1, activeDocumentId: "target",
    documents: [
      { id: "doc", title: "Source", createdAt: timestamp, updatedAt: timestamp, nodes: [sourceNode] },
      { id: "target", title: "Target", createdAt: timestamp, updatedAt: timestamp, nodes: [{ id: "target-node", text: "[[Moving]]", note: "", checked: false, collapsed: false, color: "plain", children: [] }], knowledge: { version: 1, references: [destinationReference], relations: [] } },
    ],
  };
  f.bindings.nodeClipboard = { mode: "cut", sourceDocumentId: "doc", sourceId: "moving", node: sourceNode };
  f.callback("pasteNodeAsChild")("target-node");
  const target = f.bindings.workspaceRef.current.documents[1];
  assert.equal(target.knowledge.references[0].target.documentId, "target");
  assert.equal(target.knowledge.references[0].target.nodeId, "moving");
});

test("duplicating a topic remaps connections that stay inside the copy", () => {
  const f = fixture();
  const reference = {
    id: "ref", source: { kind: "node-field", nodeId: "parent", field: "note", start: 0, end: 8, raw: "[[Child]]" },
    target: { documentId: "doc", nodeId: "child" }, labelMode: "auto",
  };
  f.bindings.workspaceRef.current.documents[0].nodes = [{
    id: "parent", text: "Parent", note: "[[Child]]", checked: false, collapsed: false, color: "plain",
    children: [{ id: "child", text: "Child", note: "", checked: false, collapsed: false, color: "plain", children: [] }],
  }];
  f.bindings.workspaceRef.current.documents[0].knowledge = { version: 1, references: [reference], relations: [] };
  f.callback("duplicateNode")("parent");
  const knowledge = f.bindings.workspaceRef.current.documents[0].knowledge;
  assert.equal(knowledge.references.length, 2);
  const copied = knowledge.references[1];
  assert.notEqual(copied.source.nodeId, "parent");
  assert.notEqual(copied.target.nodeId, "child");
  assert.equal(copied.target.documentId, "doc");
});


test("closing waits for the in-flight backup and then writes the pending version", async () => {
  const f = fixture();
  let releaseFirst;
  const writes = [];
  const saved = { version: 1, documents: [{ id: "saved" }] };
  const pending = { version: 1, documents: [{ id: "pending" }] };
  Object.assign(f.bindings, {
    backupScheduleRef: { current: knowledge.createBackupSchedule() },
    backupPayloadsRef: { current: new Map([[1, saved], [2, pending]]) },
    backupTicketRef: { current: 2 },
    backupTicketReadyRef: { current: true },
    backupFlightRef: { current: null },
    window: { bike: { enqueueBackup: (request) => {
      writes.push(request.workspace.documents[0].id);
      if (writes.length === 1) return new Promise((resolve) => { releaseFirst = () => resolve({ ok: true, ticket: request.ticket }); });
      return Promise.resolve({ ok: true, ticket: request.ticket });
    }, getBackupStatus: async () => ({ auto: true, paused: null }) } },
    setBackupStatus: () => {},
  });
  f.bindings.backupScheduleRef.current = {
    ...knowledge.createBackupSchedule(),
    enabled: true,
    writing: { ticket: 1, hash: "1" },
    pending: { ticket: 2, hash: "2" },
  };
  f.bindings.runBackupJob = f.callback("runBackupJob");
  f.bindings.dispatchBackup = f.callback("dispatchBackup");
  f.bindings.applyBackupStatus = () => {};
  const firstWrite = f.bindings.dispatchBackup({ ticket: 1, hash: "1" });
  const closing = f.callback("flushScheduledBackup")();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(writes, ["saved"]);
  releaseFirst();
  await closing;
  await firstWrite;
  assert.deepEqual(writes, ["saved", "pending"]);
});

test("link clicks honor the exact bound occurrence and never recycle deleted targets", () => {
  const f = fixture();
  const raw = "[[方案]]";
  const source = f.workspace.documents[0];
  source.nodes[0].text = `${raw} ${raw}`;
  source.knowledge = { version: 1, references: [
    { id: "r1", source: { kind: "node-field", nodeId: "one", field: "text", start: 0, end: raw.length, raw }, target: { documentId: "deleted" }, labelMode: "auto" },
    { id: "r2", source: { kind: "node-field", nodeId: "one", field: "text", start: raw.length + 1, end: raw.length * 2 + 1, raw }, target: { documentId: "chosen" }, labelMode: "auto" },
  ], relations: [] };
  f.workspace.documents.push({ ...source, id: "chosen", title: "方案", nodes: [] }, { ...source, id: "other", title: "方案", nodes: [] });
  f.workspace.trash = [{ document: { ...source, id: "deleted", title: "方案" } }];
  const opened = [];
  f.bindings.openKnowledgeTarget = (id) => opened.push(id);
  const click = f.callback("followWikiLink");
  click(raw, { documentId: "doc", kind: "node-field", nodeId: "one", field: "text", start: 0, end: raw.length });
  assert.deepEqual(opened, []);
  assert.match(f.notices.at(-1), /已删除/);
  click(raw, { documentId: "doc", kind: "node-field", nodeId: "one", field: "text", start: raw.length + 1, end: raw.length * 2 + 1 });
  assert.deepEqual(opened, ["chosen"]);
});

test("ordinary note patches relocate their bindings and undo restores both", () => {
  const f = fixture();
  const raw = "[[方案]]";
  const document = f.workspace.documents[0];
  document.nodes[0].note = raw;
  document.knowledge = { version: 1, references: [{ id: "r", source: { kind: "node-field", nodeId: "one", field: "note", start: 0, end: raw.length, raw }, target: { documentId: "original" }, labelMode: "auto" }], relations: [] };
  f.callback("handleNodePatch")("one", { note: `见 ${raw}` });
  const changed = f.bindings.workspaceRef.current.documents[0];
  assert.equal(changed.knowledge.references[0].source.start, 2);
  assert.equal(changed.knowledge.references[0].target.documentId, "original");
  f.callback("performHistoryStep")("undo");
  assert.equal(f.bindings.workspaceRef.current.documents[0].knowledge.references[0].source.start, 0);
});

test("cross-document cuts preserve and refuse unknown knowledge formats", () => {
  const f = fixture();
  const source = { ...f.workspace.documents[0], knowledge: { version: 2, payload: { preserve: "source" } } };
  const target = { ...f.workspace.documents[0], id: "target", knowledge: { version: 2, payload: { preserve: "target" } } };
  const before = { ...f.workspace, activeDocumentId: "target", documents: [source, target] };
  f.bindings.workspaceRef.current = before;
  f.bindings.nodeClipboard = { mode: "cut", sourceDocumentId: "doc", sourceId: "one", node: source.nodes[0] };
  f.callback("pasteNodeAsChild")("two");
  assert.equal(f.bindings.workspaceRef.current, before);
  assert.match(f.notices.at(-1), /更新版本/);
});

test("clipboard text and bindings remain one snapshot after a target rename", async () => {
  const f = fixture();
  const raw = "[[方案]]";
  const source = f.workspace.documents[0];
  source.nodes[0].note = raw;
  source.knowledge = { version: 1, references: [{ id: "r", source: { kind: "node-field", nodeId: "one", field: "note", start: 0, end: raw.length, raw }, target: { documentId: "original" }, labelMode: "auto" }], relations: [] };
  f.workspace.documents.push({ ...source, id: "original", title: "方案", nodes: [] });
  f.bindings.navigator = { clipboard: { writeText: async () => {} } };
  f.bindings.setNodeClipboard = (value) => { f.bindings.nodeClipboard = value; };
  await f.callback("copyNodeToClipboard")("one");
  f.bindings.workspaceRef.current = knowledge.renameTarget(f.workspace, { documentId: "original", nextLabel: "新方案" }).workspace;
  f.callback("pasteNodeAsChild")("two");
  const pastedDocument = f.bindings.workspaceRef.current.documents[0];
  const pasted = pastedDocument.nodes[1].children[0];
  assert.equal(pasted.note, raw);
  const reference = pastedDocument.knowledge.references.find((item) => item.source.nodeId === pasted.id);
  assert.equal(reference.source.raw, raw);
  assert.equal(reference.target.documentId, "original");
  assert.equal(knowledge.resolveDocumentConnections(f.bindings.workspaceRef.current, pastedDocument).some((item) => item.status === "sourceMismatch"), false);
});

test("superseded renderer backup payloads are released across saves and pause", () => {
  const f = fixture();
  Object.assign(f.bindings, { refreshRecoverySnapshots: () => {}, backupScheduleRef: { current: { ...knowledge.createBackupSchedule(), enabled: true } },
    backupTicketRef: { current: 0 }, backupPayloadsRef: { current: new Map() }, backupTicketReadyRef: { current: true },
    window: { bike: { enqueueBackup: async () => ({ ok: true }) } }, dispatchBackup: () => {}, armBackupTimer: () => {}, setBackupStatus: () => {},
  });
  const save = f.callback("showSaveResult");
  for (let i = 0; i < 100; i++) save({ ok: true, target: "indexeddb" }, { ...f.workspace, revision: i });
  assert.equal(f.bindings.backupPayloadsRef.current.size, 1);
  f.callback("applyBackupStatus")({ auto: true, paused: "external-change", lastTicket: 100 });
  assert.equal(f.bindings.backupPayloadsRef.current.size, 0);
});

test("search load-more accumulates pages past one hundred matches", () => {
  const f = fixture();
  Object.assign(f.bindings, { knowledgeIndex: knowledge.buildKnowledgeIndex({ documents: [{ ...f.workspace.documents[0], nodes: Array.from({ length: 150 }, (_, i) => ({ ...f.workspace.documents[0].nodes[0], id: `n${i}`, text: `Match ${i}` })) }] }),
    debouncedSearch: "Match", selectedTag: null, taskFilter: "all", searchLimit: 100 });
  const count = (result) => result.groups.flatMap((group) => group.hits).length;
  assert.equal(count(f.callback("searchResult")()), 100);
  f.bindings.searchLimit = 200;
  const loaded = f.callback("searchResult")();
  assert.equal(count(loaded), 150);
  assert.equal(loaded.truncated, false);
});

for (const target of ["indexeddb", "localstorage"]) {
  test(`loading an external backup acknowledges its baseline only after ${target} saving`, async () => {
    const f = fixture();
    const external = { ...f.workspace, documents: [{ ...f.workspace.documents[0], title: "External" }] };
    let resolveSave;
    const calls = [];
    Object.assign(f.bindings, {
      backupScheduleRef: { current: { ...knowledge.createBackupSchedule(), enabled: true, paused: "external-change" } },
      backupPayloadsRef: { current: new Map() }, backupTicketRef: { current: 4 }, backupTicketReadyRef: { current: true },
      window: { confirm: () => true, bike: {
        loadICloudBackup: async () => ({ ok: true, payload: external, revision: "external-hash", path: "/test-only/bike.json" }),
        acceptBackupBaseline: async (hash, saved) => {
          calls.push({ hash, saved });
          assert.equal(saved.workspace.documents[0].title, "External");
          return { ok: true, auto: true, paused: null, lastTicket: 4 };
        },
      } },
      saveWorkspace: () => new Promise((resolve) => { resolveSave = resolve; }),
      downloadWorkspaceBackup: () => {}, firstNodeIdInWorkspace: () => "one", setBackupStatus: () => {},
      localStorage: { setItem() {}, removeItem() {} }, ICLOUD_REVISION_KEY: "revision", LEGACY_ICLOUD_REVISION_KEY: "legacy",
    });
    f.bindings.applyBackupStatus = f.callback("applyBackupStatus");
    const loading = f.callback("loadCloudBackup")();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.bindings.backupScheduleRef.current.paused, "restoring");
    assert.equal(calls.length, 0);
    resolveSave({ ok: true, target });
    await loading;
    assert.equal(calls.length, target === "indexeddb" ? 1 : 0);
    assert.equal(f.bindings.backupScheduleRef.current.paused, target === "indexeddb" ? null : "restoring");
  });
}
