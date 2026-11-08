import assert from "node:assert/strict";
import test from "node:test";
import { loadTypescript } from "./helpers/typescript.mjs";

const { emptyEditHistory, recordChange, undo, redo } = loadTypescript("src/editHistory.ts");
const { migrateWorkspace } = loadTypescript("src/migrations.ts");

const OLD = "2026-01-01T00:00:00.000Z";
const NEW = "2026-01-02T00:00:00.000Z";

const workspace = () => migrateWorkspace({
  version: 1,
  activeDocumentId: "doc",
  documents: [
    { id: "doc", title: "Doc", createdAt: OLD, updatedAt: OLD, nodes: [{ id: "node", text: "one", children: [] }] },
    { id: "other", title: "Other", createdAt: OLD, updatedAt: OLD, nodes: [{ id: "node2", text: "two", children: [] }] },
  ],
});

const editDocument = (current, id, text, updatedAt = NEW) => ({
  ...current,
  documents: current.documents.map((document) =>
    document.id === id
      ? { ...document, updatedAt, nodes: document.nodes.map((node) => ({ ...node, text })) }
      : document,
  ),
});

test("records a document change and undoes it", () => {
  const before = workspace();
  const after = editDocument(before, "doc", "changed");
  let history = recordChange({
    history: emptyEditHistory(),
    before,
    after,
    selection: { documentId: "doc", nodeId: "node" },
    label: "编辑主题",
  });

  const result = undo({ history, workspace: after, now: NEW });
  assert.equal(result.status, "applied");
  assert.equal(result.workspace.documents[0].nodes[0].text, "one");
  assert.equal(result.workspace.documents[0].updatedAt, NEW);
  assert.equal(result.entry.label, "编辑主题");
});

test("coalesces rapid edits in the same text group", () => {
  const first = workspace();
  const second = editDocument(first, "doc", "o");
  const third = editDocument(second, "doc", "on");
  const selection = { documentId: "doc", nodeId: "node" };
  let history = recordChange({ history: emptyEditHistory(), before: first, after: second, selection, label: "编辑主题", group: "text:node", at: 1000 });
  history = recordChange({ history, before: second, after: third, selection, label: "编辑主题", group: "text:node", at: 2000 });
  assert.equal(history.past.length, 1);

  const result = undo({ history, workspace: third, now: NEW });
  assert.equal(result.status, "applied");
  assert.equal(result.workspace.documents[0].nodes[0].text, "one");
});

test("refuses undo when the document changed externally", () => {
  const before = workspace();
  const after = editDocument(before, "doc", "changed");
  const history = recordChange({
    history: emptyEditHistory(),
    before,
    after,
    selection: { documentId: "doc", nodeId: "node" },
    label: "编辑主题",
  });
  const external = editDocument(after, "doc", "external");
  const result = undo({ history, workspace: external, now: NEW });
  assert.equal(result.status, "stale");
});

test("redoes an undone change and refuses stale redo", () => {
  const before = workspace();
  const after = editDocument(before, "doc", "changed");
  const selection = { documentId: "doc", nodeId: "node" };
  const history = recordChange({
    history: emptyEditHistory(),
    before,
    after,
    selection,
    label: "编辑主题",
  });
  const undone = undo({ history, workspace: after, now: NEW });
  assert.equal(undone.status, "applied");

  const redone = redo({ history: undone.history, workspace: undone.workspace, now: NEW });
  assert.equal(redone.status, "applied");
  assert.equal(redone.workspace.documents[0].nodes[0].text, "changed");

  const stale = editDocument(undone.workspace, "doc", "external");
  const staleRedo = redo({ history: undone.history, workspace: stale, now: NEW });
  assert.equal(staleRedo.status, "stale");
});

test("an edit after undo is not merged into an earlier typing group", () => {
  const initial = workspace();
  const second = editDocument(initial, "doc", "second");
  const third = editDocument(second, "doc", "third");
  const selection = { documentId: "doc", nodeId: "node" };
  let history = recordChange({ history: emptyEditHistory(), before: initial, after: second, selection, label: "Text", group: "text:node", at: 100 });
  history = recordChange({ history, before: second, after: third, selection, label: "Format", at: 200 });
  const undone = undo({ history, workspace: third, now: NEW });
  const next = editDocument(undone.workspace, "doc", "replacement");
  history = recordChange({ history: undone.history, before: undone.workspace, after: next, selection, label: "Text", group: "text:node", at: 300 });
  assert.equal(history.past.length, 2);
  assert.equal(history.future.length, 0);
  const final = undo({ history, workspace: next, now: NEW });
  assert.equal(final.workspace.documents[0].nodes[0].text, "second");
});

test("one cross-document cut operation is undone and redone atomically", () => {
  const before = workspace();
  const after = editDocument(editDocument(before, "doc", "source"), "other", "target");
  const history = recordChange({
    history: emptyEditHistory(), before, after,
    selection: { documentId: "other", nodeId: "node2" }, label: "Cut",
  });
  assert.equal(history.past[0].changes.length, 2);
  const undone = undo({ history, workspace: after, now: NEW });
  assert.deepEqual(undone.workspace.documents.map((document) => document.nodes[0].text), ["one", "two"]);
  const redone = redo({ history: undone.history, workspace: undone.workspace, now: NEW });
  assert.deepEqual(redone.workspace.documents.map((document) => document.nodes[0].text), ["source", "target"]);
});

test("equivalent server-normalized nodes and timestamps do not invalidate history", () => {
  const before = workspace();
  const after = {
    ...before,
    documents: [{ ...before.documents[0], nodes: [{ id: "node", text: "changed", children: [] }] }, before.documents[1]],
  };
  const history = recordChange({
    history: emptyEditHistory(), before, after,
    selection: { documentId: "doc", nodeId: "node" }, label: "Text",
  });
  const normalized = migrateWorkspace(after);
  normalized.documents[0].updatedAt = NEW;
  assert.equal(undo({ history, workspace: normalized, now: NEW }).status, "applied");
});
