import assert from "node:assert/strict";
import test from "node:test";
import * as knowledge from "../shared/bike-knowledge.mjs";
import { loadTypescript } from "./helpers/typescript.mjs";
const { exportDocument, importDocument } = loadTypescript("src/exporters.ts");
const { parseMarkdownDocument, documentToMarkdown } = loadTypescript("src/markdown.ts");
const { restoreTrashEntry } = loadTypescript("src/trash.ts");
const node = (id, text, extra = {}) => ({ id, text, note: "", checked: false, collapsed: false, color: "plain", children: [], ...extra });
const doc = (id, nodes, extra = {}) => ({ id, title: id, createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z", nodes, ...extra });
const data = (references = [], relations = [], sourceGroups) => ({ version: 1, references, relations, ...(sourceGroups ? { sourceGroups } : {}) });

test("Markdown tables retain empty cells, a single column and escaped pipes", () => {
  for (const table of [[["", "B"], ["", "a|b"]], [["Only"]], [["H"], [""]]]) {
    const original = doc("table", [node("n", "Table", { table })]);
    const exported = exportDocument(original, "markdown");
    assert.ok(!exported.content.includes("未命名主题"));
    const parsed = parseMarkdownDocument(exported.content);
    assert.deepEqual(parsed.nodes[0].table, table);
  }
});

test("metadata export preserves user lookalike comments and document extensions", () => {
  const original = doc("comments", [node("n", "Topic", { note: "before\n<!-- bike:document:x -->\nafter", codeBlock: "<!-- bike:document:v1 AAAA -->" })], { extension: { keep: "原样" } });
  const exported = exportDocument(original, "markdown", { metadata: true });
  assert.equal(exported.lossy, false);
  assert.equal(knowledge.readBikeMetadata(exported.content).status, "matched");
  const restored = importDocument(exported.content, exported.filename);
  assert.deepEqual(restored.nodes, original.nodes);
  assert.deepEqual(restored.extension, original.extension);
  assert.equal(knowledge.readBikeMetadata(`${exported.content}\n${knowledge.encodeBikeMetadata(original, "body")}`).status, "invalid");
});

test("structural rename updates the target's maintained Markdown while reusing unrelated content", () => {
  const source = "# Original\n\n+ Old\n  > Keep **format**\n\n```js\nconst old = 1;\n```";
  const original = parseMarkdownDocument(source, { documentId: "target" });
  const outside = doc("outside", [node("outside-node", "Unchanged")]);
  const renamed = knowledge.renameTarget({ documents: [original, outside] }, {
    documentId: original.id, nodeId: original.nodes[0].id, previousLabel: "Old", nextLabel: "New",
  }).workspace;
  assert.equal(documentToMarkdown(renamed.documents[0]), source.replace("+ Old", "+ New"));
  assert.equal(renamed.documents[1], outside);
  const titleRenamed = knowledge.renameTarget(renamed, { documentId: original.id, nextLabel: "Renamed title" }).workspace.documents[0];
  assert.ok(documentToMarkdown(titleRenamed).startsWith("# Renamed title\n"));
});

test("partially moved provenance groups refer only to candidate nodes on their own side", () => {
  const raw = "[[Target]]";
  const reference = { id: "r", source: { kind: "node-field", nodeId: "stay", field: "text", start: -1, end: -1, raw, groupId: "g" }, target: { documentId: "linked" }, labelMode: "auto" };
  const source = doc("source", [node("stay", raw), node("move", raw)], { knowledge: data([reference], [], { g: { raw, candidates: [{ nodeId: "stay", field: "text" }, { nodeId: "move", field: "text" }] } }) });
  const target = doc("destination", [node("other", "Other")]);
  const moved = knowledge.moveSubtreeConnections(source, target, ["move"]);
  assert.equal(moved.source.knowledge.references[0].source.nodeId, "stay");
  assert.equal(moved.target.knowledge.references[0].source.nodeId, "move");
  const destinationGroup = moved.target.knowledge.references[0].source.groupId;
  assert.deepEqual(moved.target.knowledge.sourceGroups[destinationGroup].candidates, [{ nodeId: "move", field: "text" }]);
  assert.equal(moved.target.knowledge.references[0].source.start, -1);
  assert.equal(source.knowledge.references[0].source.nodeId, "stay");
});

test("trash collisions remap internal identities and preserve external document/node pairs", () => {
  const raw = "[[deleted#B]]";
  const deleted = doc("deleted", [node("a", raw), node("b", "B")], { knowledge: data([
    { id: "self", source: { kind: "node-field", nodeId: "a", sourceNodeId: "a", field: "text", start: 0, end: raw.length, raw }, target: { documentId: "deleted", nodeId: "b" }, labelMode: "auto" },
    { id: "external", source: { kind: "node-field", nodeId: "b", field: "note", start: -1, end: -1, raw: "[[External]]" }, target: { documentId: "external", nodeId: "a" }, labelMode: "auto" },
  ], [{ id: "relation", fromNodeId: "a", toNodeId: "b", label: "Edge" }]) });
  const workspace = { version: 1, activeDocumentId: "deleted", documents: [doc("deleted", [node("a", "Live")])], trash: [{ id: "entry", document: deleted, originalIndex: 0, deletedAt: "2026-11-09T00:00:00.000Z" }] };
  const restored = restoreTrashEntry(workspace, "entry").document;
  const [a, b] = restored.nodes;
  const [self, external] = restored.knowledge.references;
  assert.notEqual(restored.id, deleted.id);
  assert.equal(self.source.nodeId, a.id);
  assert.equal(self.source.sourceNodeId, a.id);
  assert.deepEqual(self.target, { documentId: restored.id, nodeId: b.id });
  assert.deepEqual(external.target, { documentId: "external", nodeId: "a" });
  assert.equal(restored.knowledge.relations[0].fromNodeId, a.id);
  assert.equal(restored.knowledge.relations[0].toNodeId, b.id);
});

test("OPML attributes encode newlines, XML controls report loss, and filenames keep Unicode boundaries", () => {
  const original = doc("a".repeat(119) + "😀", [node("n", "Topic", { note: "first\nsecond\tlast\u0001" })]);
  const opml = exportDocument(original, "opml");
  assert.match(opml.content, /first&#10;second&#9;last/);
  assert.equal(opml.content.includes("\u0001"), false);
  assert.equal(opml.lossy, true);
  assert.ok(opml.filename.endsWith("😀.opml"));
  const html = exportDocument(doc("HTML", [node("n", "Table", { table: [["", "B"]], codeBlock: "<script>" })]), "html");
  assert.match(html.content, /<table>/);
  assert.match(html.content, /<td><\/td>/);
  assert.match(html.content, /<pre><code>&lt;script&gt;<\/code><\/pre>/);
});

test("tags inside wiki target names are not indexed as content tags", () => {
  assert.deepEqual(knowledge.extractKnowledgeTags("[[文档 #主题]] #真实"), ["真实"]);
});
