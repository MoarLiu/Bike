import assert from "node:assert/strict";
import test from "node:test";
import { loadAppCallback, loadTypescript } from "./helpers/typescript.mjs";

const editHistory = loadTypescript("src/editHistory.ts");
const tree = loadTypescript("src/tree.ts");
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
    ...editHistory,
    workspaceRef: { current: workspace },
    historyRef: { current: editHistory.emptyEditHistory() },
    activeNodeIdRef: { current: "one" },
    ready: true,
    syncBusyRef: { current: false },
    historyBusyRef: { current: false },
    recoveryBusyRef: { current: false },
    storageConflictRef: { current: false },
    modeRef: { current: "outline" },
    focusNodeId: null,
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
    setPendingCaretFocus: () => {},
    flushFocusedStructuredInput: () => bindings.workspaceRef.current,
    flushPendingEdits: () => bindings.workspaceRef.current,
    document: { activeElement: null },
    HTMLElement: class {},
    MINDMAP_ROOT_ID: "__bike_mindmap_root__",
  };
  bindings.commitWorkspace = loadAppCallback("commitWorkspace", bindings);
  bindings.patchActiveDocumentStable = loadAppCallback("patchActiveDocument", bindings);
  bindings.updateActiveNodesStable = loadAppCallback("updateActiveNodes", bindings);
  bindings.clearEditHistory = () => { bindings.historyRef.current = editHistory.emptyEditHistory(); };
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
  f.callback("setActiveNodes")([...f.workspace.documents[0].nodes].reverse());
  f.callback("handleNodePatch")("two", { bold: true, color: "green" });
  f.callback("performHistoryStep")("undo");
  assert.equal(f.bindings.workspaceRef.current.documents[0].nodes[0].bold, false);
  f.callback("performHistoryStep")("undo");
  assert.deepEqual(f.bindings.workspaceRef.current.documents[0].nodes.map((node) => node.id), ["one", "two"]);
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
