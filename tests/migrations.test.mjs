import assert from "node:assert/strict";
import test from "node:test";
import { loadTypescript } from "./helpers/typescript.mjs";

const { migrateWorkspace } = loadTypescript("src/migrations.ts");
const OLD = "2026-01-01T00:00:00.000Z";

test("workspace migration retains extensions while validating known fields", () => {
  const workspace = migrateWorkspace({
    version: 1, activeDocumentId: "doc", extension: { keep: true },
    documents: [{
      id: "doc", title: "Document", isShortcut: true, extension: "document",
      markdownSource: 42, markdownUpdatedAt: false,
      nodes: [{ id: "node", text: "Text", checked: "true", color: "invalid", extension: [1, 2], children: [] }],
    }],
  });
  const restored = JSON.parse(JSON.stringify(workspace));
  assert.deepEqual(restored.extension, { keep: true });
  assert.equal(restored.documents[0].extension, "document");
  assert.equal(restored.documents[0].isShortcut, true);
  assert.equal(restored.documents[0].markdownSource, undefined);
  assert.equal(restored.documents[0].markdownUpdatedAt, undefined);
  assert.equal(restored.documents[0].nodes[0].checked, false);
  assert.equal(restored.documents[0].nodes[0].color, "plain");
  assert.deepEqual(restored.documents[0].nodes[0].extension, [1, 2]);
});

test("workspace migration preserves and validates trash entries", () => {
  const workspace = migrateWorkspace({
    version: 1,
    activeDocumentId: "doc",
    documents: [{
      id: "doc", title: "Document", createdAt: OLD, updatedAt: OLD,
      nodes: [{ id: "node", text: "Text", children: [] }],
    }],
    trash: [
      {
        id: "trash-1",
        deletedAt: "2026-01-02T00:00:00.000Z",
        originalIndex: 1,
        document: {
          id: "deleted", title: "Deleted", createdAt: OLD, updatedAt: OLD,
          nodes: [{ id: "deleted-node", text: "Old", children: [] }],
        },
      },
      { id: "bad", deletedAt: "not-a-date", document: null },
    ],
  });

  assert.equal(workspace.trash.length, 1);
  assert.equal(workspace.trash[0].id, "trash-1");
  assert.equal(workspace.trash[0].document.id, "deleted");
  assert.equal(workspace.trash[0].originalIndex, 1);
});

test("trash migration keeps document and node ids even when a live document has the same ids", () => {
  const document = { id: "doc", title: "Document", createdAt: OLD, updatedAt: OLD, nodes: [{ id: "node", text: "Text", children: [] }] };
  const migrated = migrateWorkspace({
    version: 1, activeDocumentId: "doc", documents: [document],
    trash: [{ id: "trash", deletedAt: OLD, originalIndex: 0, document }],
  });
  assert.equal(migrated.trash[0].document.id, "doc");
  assert.equal(migrated.trash[0].document.nodes[0].id, "node");
  const reopened = migrateWorkspace(migrated);
  assert.deepEqual(reopened.trash, migrated.trash);
});
