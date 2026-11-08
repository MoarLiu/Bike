import assert from "node:assert/strict";
import test from "node:test";
import { loadTypescript } from "./helpers/typescript.mjs";

const { migrateWorkspace } = loadTypescript("src/migrations.ts");
const {
  emptyTrash,
  moveDocumentToTrash,
  pruneTrash,
  removeTrashEntry,
  restoreTrashEntry,
} = loadTypescript("src/trash.ts");

const OLD = "2026-01-01T00:00:00.000Z";

const workspace = () => migrateWorkspace({
  version: 1,
  activeDocumentId: "first",
  documents: [
    { id: "first", title: "First", createdAt: OLD, updatedAt: OLD, nodes: [{ id: "n1", text: "one", children: [] }] },
    { id: "second", title: "Second", createdAt: OLD, updatedAt: OLD, nodes: [{ id: "n2", text: "two", children: [] }] },
    { id: "third", title: "Third", createdAt: OLD, updatedAt: OLD, nodes: [{ id: "n3", text: "three", children: [] }] },
  ],
});

test("moves a document to trash and restores it at its original index", () => {
  const current = workspace();
  const moved = moveDocumentToTrash(current, "second");
  assert.ok(moved);
  assert.deepEqual(moved.workspace.documents.map((document) => document.id), ["first", "third"]);
  assert.equal(moved.workspace.trash.length, 1);
  assert.equal(moved.workspace.trash[0].document.id, "second");
  assert.equal(moved.workspace.trash[0].originalIndex, 1);

  const restored = restoreTrashEntry(moved.workspace, moved.entry.id);
  assert.ok(restored);
  assert.deepEqual(restored.workspace.documents.map((document) => document.id), ["first", "second", "third"]);
  assert.equal(restored.workspace.activeDocumentId, "second");
  assert.equal(restored.workspace.trash.length, 0);
});

test("restores as a copy when the document id exists again", () => {
  const current = workspace();
  current.documents[1].markdownSource = "# Second\n\n- two";
  const moved = moveDocumentToTrash(current, "second");
  assert.ok(moved);
  const withCollision = {
    ...moved.workspace,
    documents: [
      ...moved.workspace.documents,
      { ...moved.entry.document, updatedAt: OLD },
    ],
  };
  const restored = restoreTrashEntry(withCollision, moved.entry.id);
  assert.ok(restored);
  assert.notEqual(restored.document.id, "second");
  assert.match(restored.document.title, /（恢复）/);
  assert.equal(restored.document.markdownSource, undefined);
  assert.notEqual(restored.document.nodes[0].id, "n2");
});

test("prunes expired entries and supports single and full deletion", () => {
  const current = workspace();
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const fresh = new Date().toISOString();
  const pruned = pruneTrash([
    { id: "old", document: current.documents[0], deletedAt: old, originalIndex: 0 },
    { id: "fresh", document: current.documents[1], deletedAt: fresh, originalIndex: 1 },
  ]);
  assert.deepEqual(pruned.map((entry) => entry.id), ["fresh"]);

  const withTrash = {
    ...current,
    trash: [
      { id: "a", document: current.documents[0], deletedAt: fresh, originalIndex: 0 },
      { id: "b", document: current.documents[1], deletedAt: fresh, originalIndex: 1 },
    ],
  };
  assert.deepEqual(removeTrashEntry(withTrash, "a").trash.map((entry) => entry.id), ["b"]);
  assert.deepEqual(emptyTrash(withTrash).trash, []);
});
