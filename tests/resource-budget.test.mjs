import assert from "node:assert/strict";
import test from "node:test";
import { loadTypescript } from "./helpers/typescript.mjs";
import { assertTreeBudget } from "../shared/bike-limits.mjs";
import { withFieldText, buildKnowledgeIndex, knowledgeIndexCacheStats } from "../shared/bike-knowledge.mjs";
const { recordChange, emptyEditHistory, historyMemoryUsage, MAX_HISTORY_BYTES, undo } = loadTypescript("src/editHistory.ts");
const { withHistoryBudget } = loadTypescript("src/historyBudget.ts");
const { migrateWorkspace } = loadTypescript("src/migrations.ts");
const topic = (id) => ({ id, text: id, note: "", checked: false, collapsed: false, color: "plain", children: [] });
const makeWorkspace = (nodes) => ({ version: 1, activeDocumentId: "doc", documents: [{ id: "doc", title: "Doc", createdAt: "fixed", updatedAt: "fixed", nodes }] });

test("200 independent edits retain shared structure and keep the most recent undo", () => {
  let workspace = makeWorkspace(Array.from({ length: 3000 }, (_, i) => topic(`n${i}`)));
  let history = emptyEditHistory();
  for (let i = 0; i < 200; i++) {
    const document = withFieldText(workspace.documents[0], { nodeId: "n0", field: "text", text: `edit ${i}` });
    const next = { ...workspace, documents: [document] };
    history = recordChange({ history, before: workspace, after: next, selection: { documentId: "doc", nodeId: "n0" }, label: "Edit", group: null });
    workspace = next;
    buildKnowledgeIndex(workspace);
    assert.equal(knowledgeIndexCacheStats().nodes, 3000, 'undo must not retain a full index for every prior document version');
  }
  const usage = historyMemoryUsage(history);
  assert.ok(usage.estimatedBytes < MAX_HISTORY_BYTES);
  assert.ok(usage.retainedObjects < 15_000);
  assert.equal(undo({ history, workspace, now: "later" }).workspace.documents[0].nodes[0].text, "edit 198");
});

test("byte eviction preserves the nearest undo even for a single over-budget operation", () => {
  const before = makeWorkspace([topic("n")]);
  const after = makeWorkspace([{ ...topic("n"), text: "x".repeat(20_000) }]);
  const first = recordChange({ history: emptyEditHistory(), before, after, selection: { documentId: "doc", nodeId: "n" }, label: "Large", group: null });
  const constrained = withHistoryBudget(first, first, 1024);
  assert.equal(constrained.past.length, 1);
  assert.ok(historyMemoryUsage(constrained).estimatedBytes > 1024);
  assert.equal(undo({ history: constrained, workspace: after, now: "later" }).status, "applied");
});

test("deep and wide documents are rejected without discarding the other documents", () => {
  const root = topic("deep");
  let cursor = root;
  for (let i = 0; i < 5000; i++) { const child = topic(`deep-${i}`); cursor.children = [child]; cursor = child; }
  const original = makeWorkspace([topic("safe")]);
  const deep = { ...original, documents: [...original.documents, { ...original.documents[0], id: "deep-doc", nodes: [root] }] };
  assert.throws(() => migrateWorkspace(deep), /层|预算/);
  assert.equal(deep.documents[1].nodes[0], root);
  assert.equal(original.documents[0].nodes[0].id, "safe");
  const wide = [{ ...topic("wide"), children: Array.from({ length: 200_000 }, (_, i) => topic(`wide-${i}`)) }];
  assert.throws(() => assertTreeBudget(wide), /主题数/);
  assert.throws(() => migrateWorkspace({ ...original, version: 2 }), /版本.*不支持/);
  assert.throws(() => migrateWorkspace({ ...original, documents: [...original.documents, null] }), /第 2 个文档/);
});
