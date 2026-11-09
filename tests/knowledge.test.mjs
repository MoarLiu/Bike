import assert from "node:assert/strict";
import test from "node:test";
import {
  activeLinkQuery,
  addRelation,
  attachReference,
  backlinksFor,
  canonicalText,
  buildKnowledgeIndex,
  copiedKnowledgeFragment,
  createBackupSchedule,
  deleteRelation,
  encodeBikeMetadata,
  extractKnowledgeTags,
  finalizeMarkdownExport,
  formatWikiLink,
  insertLinkAtQuery,
  moveSubtreeConnections,
  normalizeNavigation,
  pruneNavigation,
  readBikeMetadata,
  reduceBackupSchedule,
  rekeyNodes,
  remapCollidingIds,
  renameTarget,
  resetRecentOpens,
  resolveDocumentConnections,
  resolveWikiLink,
  restoreMarkdownIdentity,
  reverseRelation,
  saveNavigationFilter,
  scanLinks,
  searchKnowledge,
  sha256Hex,
  suggestLinkTargets,
  toggleFavorite,
  withFieldText,
} from "../shared/bike-knowledge.mjs";

const node = (id, text, extra = {}) => ({ id, text, note: "", children: extra.children ?? [], ...extra });
const doc = (id, title, nodes, extra = {}) => ({
  id, title, createdAt: "2026-11-08T00:00:00.000Z", updatedAt: "2026-11-08T00:00:00.000Z", nodes, ...extra,
});

test("Markdown clicks retain distinct id bindings for identical visible names", () => {
  const raw = "[[方案]]";
  const markdownSource = `# Note\n\n- ${raw}\n- ${raw}`;
  const starts = [markdownSource.indexOf(raw), markdownSource.lastIndexOf(raw)];
  const source = doc("source", "Note", [], { markdownSource, knowledge: { version: 1, references: starts.map((start, index) => ({
    id: `r${index}`, source: { kind: "markdown", start, end: start + raw.length, raw }, target: { documentId: `target${index}` }, labelMode: "auto",
  })), relations: [] } });
  const workspace = { documents: [source, doc("target0", "方案", []), doc("target1", "方案", [])] };
  for (const [index, start] of starts.entries()) {
    const resolved = resolveWikiLink(workspace, raw, { documentId: "source", kind: "markdown", start, end: start + raw.length });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.documentId, `target${index}`);
  }
});

test("externally edited metadata remaps self-links consistently with document identity", () => {
  const raw = "[[Old#Child]]";
  const original = doc("original", "Old", [node("parent", "Parent", { note: raw }), node("child", "Child")], { knowledge: { version: 1, references: [{
    id: "ref", source: { kind: "node-field", nodeId: "parent", field: "note", start: 0, end: raw.length, raw }, target: { documentId: "original", nodeId: "child" }, labelMode: "auto",
  }], relations: [] } });
  const metadata = readBikeMetadata(finalizeMarkdownExport("# Old\n\n- Parent\n  > [[Old#Child]]\n- Child", original, { metadata: true }).content).metadata;
  const restored = restoreMarkdownIdentity(doc("new-id", "Edited", [node("new-p", "Parent", { note: raw }), node("new-c", "Child")]), metadata, { matched: false });
  assert.equal(restored.id, "new-id");
  assert.equal(restored.knowledge.references[0].target.documentId, restored.id);
  assert.equal(restored.nodes[1].id, "child");
  assert.equal(resolveDocumentConnections({ documents: [restored] }, restored)[0].status, "resolved");
});

test("sha256 matches the known abc vector", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("wiki links honor escapes, code and aliases without guessing duplicates", () => {
  assert.equal(formatWikiLink({ documentName: "A|B", nodeName: "C#D", alias: "显示" }), "[[A\\|B#C\\#D|显示]]");
  const links = scanLinks("前 [[A\\\\|B#C\\#D|显示]] `[[忽略]]` \\[[不是]]\n```\n[[代码]]\n```\n<script>[[x]]</script>");
  assert.equal(links.length, 2);
  assert.equal(links[0].documentName, "A\\");
  assert.deepEqual(extractKnowledgeTags("正文 #标签 ` #code ` https://example.com/#anchor\n# 标题"), ["标签"]);
  const open = activeLinkQuery("写 [[项目", 6);
  assert.equal(open.query, "项目");
  assert.equal(activeLinkQuery("写 [[项目]]", 8), null);
});

test("autocomplete requires an explicit choice when titles collide", () => {
  const workspace = {
    documents: [
      doc("a", "方案", [node("a1", "范围")]),
      doc("b", "方案", [node("b1", "范围")]),
      doc("c", "读书", [node("c1", "范围"), node("c2", "范围")]),
    ],
  };
  const documents = suggestLinkTargets(workspace, "方案");
  assert.equal(documents.requiresExplicit, true);
  assert.equal(documents.highlight, -1);
  assert.equal(documents.items.every((item) => item.kind !== "create"), true);
  const topics = suggestLinkTargets(workspace, "读书#范围");
  assert.equal(topics.items.length, 2);
  assert.equal(topics.requiresExplicit, true);
  const created = suggestLinkTargets(workspace, "新文档");
  assert.equal(created.items.at(-1).kind, "create");
});

test("bound links survive text edits and do not retarget a recycled name", () => {
  const reference = {
    id: "ref",
    source: { kind: "node-field", nodeId: "n1", field: "text", start: 0, end: 6, raw: "[[方案]]" },
    target: { documentId: "plan" },
    labelMode: "auto",
  };
  let source = doc("note", "笔记", [node("n1", "[[方案]]")], { knowledge: { version: 1, references: [reference], relations: [] } });
  source = withFieldText(source, { nodeId: "n1", field: "text", text: "见 [[方案]]。" });
  assert.equal(source.knowledge.references[0].source.raw, "[[方案]]");
  assert.equal(source.knowledge.references[0].target.documentId, "plan");
  source = withFieldText(source, { nodeId: "n1", field: "text", text: "没有链接" });
  assert.equal(source.knowledge.references.length, 0);

  const workspace = {
    documents: [
      doc("note", "笔记", [node("n1", "[[方案]]")], { knowledge: { version: 1, references: [reference], relations: [] } }),
      doc("plan", "方案", [node("p", "正文")]),
    ],
    trash: [{ id: "t", document: doc("plan", "方案", [node("p", "正文")]), deletedAt: "2026-11-08T00:00:00.000Z" }],
  };
  workspace.documents = [workspace.documents[0], doc("new", "方案", [node("x", "新")])];
  workspace.trash = [];
  const [connection] = resolveDocumentConnections(workspace, workspace.documents[0]);
  assert.equal(connection.status, "missing");
  assert.equal(connection.reference.target.documentId, "plan");
});

test("renaming updates bound and unique weak labels once, preserving aliases", () => {
  const workspace = {
    documents: [
      doc("plan", "方案", [node("p", "目标")]),
      doc("note", "笔记", [
        node("n1", "见 [[方案]] 和 [[方案|别名]]"),
        node("n2", "[[方案#目标]]"),
      ]),
      doc("other", "其他", [node("o", "[[方案]]")]),
    ],
  };
  const renamed = renameTarget(workspace, { documentId: "plan", nextLabel: "项目方案" });
  assert.equal(renamed.workspace.documents[0].title, "项目方案");
  assert.equal(renamed.workspace.documents[1].nodes[0].text, "见 [[项目方案]] 和 [[方案|别名]]");
  assert.equal(renamed.workspace.documents[1].nodes[1].text, "[[项目方案#目标]]");
  assert.equal(renamed.workspace.documents[2].nodes[0].text, "[[项目方案]]");
  assert.equal(workspace.documents[1].nodes[0].text, "见 [[方案]] 和 [[方案|别名]]");

  const topic = renameTarget(renamed.workspace, { documentId: "plan", nodeId: "p", nextLabel: "里程碑" });
  assert.equal(topic.workspace.documents[0].nodes[0].text, "里程碑");
  assert.equal(topic.workspace.documents[1].nodes[1].text, "[[项目方案#里程碑]]");

  const ambiguous = renameTarget({
    documents: [
      doc("a", "同名", [node("a1", "甲")]),
      doc("b", "同名", [node("b1", "乙")]),
      doc("c", "引用", [node("c1", "[[同名]]")]),
    ],
  }, { documentId: "a", nextLabel: "甲文档" });
  assert.equal(ambiguous.workspace.documents[2].nodes[0].text, "[[同名]]");
  assert.equal(ambiguous.ambiguous.length, 1);
});

test("copy and cross-document move remap only internal connections", () => {
  const knowledge = {
    version: 1,
    references: [
      { id: "r1", source: { kind: "node-field", nodeId: "n1", field: "text", start: 0, end: 5, raw: "[[外]]" }, target: { documentId: "outside" }, labelMode: "auto" },
      { id: "r2", source: { kind: "node-field", nodeId: "n1", field: "note", start: 0, end: 7, raw: "[[内#子]]" }, target: { documentId: "doc", nodeId: "n2" }, labelMode: "auto" },
    ],
    relations: [
      { id: "rel", fromNodeId: "n1", toNodeId: "n2", label: "依赖" },
      { id: "edge", fromNodeId: "n1", toNodeId: "outside-node", label: "外部" },
    ],
  };
  const { idMap } = rekeyNodes([node("n1", "父", { children: [node("n2", "子")] })]);
  const copied = copiedKnowledgeFragment(knowledge, { sourceDocumentId: "doc", nextDocumentId: "copy", idMap });
  assert.equal(copied.references[0].target.documentId, "outside");
  assert.equal(copied.references[1].target.documentId, "copy");
  assert.equal(copied.references[1].target.nodeId, idMap.get("n2"));
  assert.equal(copied.relations.length, 1);
  assert.equal(copied.relations[0].fromNodeId, idMap.get("n1"));

  const moved = moveSubtreeConnections(
    doc("left", "左", [node("keep", "留")], { knowledge }),
    doc("right", "右", []),
    ["n1", "n2"],
  );
  assert.equal(moved.target.knowledge.relations.length, 1);
  assert.equal(moved.source.knowledge.relations[0].id, "edge");
  assert.equal(moved.target.knowledge.references.length, 2);
});

test("metadata roundtrip keeps identity and rejects unsafe payloads", () => {
  const document = doc("doc", "方案", [node("n1", "目标")], {
    knowledge: {
      version: 1,
      references: [{ id: "r", source: { kind: "node-field", nodeId: "n1", field: "text", start: 0, end: 2, raw: "目标" }, target: { documentId: "other" }, labelMode: "auto" }],
      relations: [{ id: "rel", fromNodeId: "n1", toNodeId: "n1", label: "坏" }],
    },
  });
  const plain = "# 方案\n\n- 目标";
  const exported = finalizeMarkdownExport(plain, document, { metadata: true });
  const read = readBikeMetadata(exported.content);
  assert.equal(read.status, "matched");
  assert.equal(read.metadata.documentId, "doc");
  const restored = restoreMarkdownIdentity({ ...document, id: "temp", nodes: [node("generated", "目标")] }, read.metadata, { matched: true });
  assert.equal(restored.nodes[0].id, "n1");
  assert.equal(restored.knowledge.references[0].target.documentId, "other");
  const lossy = finalizeMarkdownExport(plain, document, { metadata: false });
  assert.match(lossy.content, /稳定 id/);
  assert.equal(readBikeMetadata(lossy.content).status, "absent");
  assert.equal(readBikeMetadata("<!-- bike:document:v3 AAAA -->").status, "unknown-version");
  assert.equal(readBikeMetadata("<!-- bike:document:v1 not valid -->").status, "invalid");
  const huge = `<!-- bike:document:v1 ${"A".repeat(3 * 1024 * 1024)} -->`;
  assert.equal(readBikeMetadata(huge).status, "too-large");
  void encodeBikeMetadata;
});

test("search, tags and backlinks stay scoped and ranked", () => {
  const workspace = {
    documents: [
      doc("d1", "项目方案", [node("n1", "交付范围 #重点", { note: "见备注", isTodo: true, checked: false })]),
      doc("d2", "读书", [node("n2", "[[项目方案]]", { note: "普通备注" })], {
        knowledge: { version: 1, references: [], relations: [] },
      }),
    ],
  };
  const inserted = attachReference(workspace.documents[1], {
    source: { kind: "node-field", nodeId: "n2", field: "text", start: 0, end: "[[项目方案]]".length, raw: "[[项目方案]]" },
    target: { documentId: "d1" },
    labelMode: "auto",
  });
  workspace.documents[1] = inserted.document;
  const index = buildKnowledgeIndex(workspace);
  const found = searchKnowledge(index, { query: "项目方案" });
  assert.equal(found.groups[0].hits[0].field, "title");
  assert.equal(found.groups[0].hits[0].nodeId, null);
  const tasks = searchKnowledge(index, { task: "open", tags: ["重点"] });
  assert.deepEqual(tasks.groups[0].hits.map((hit) => hit.nodeId), ["n1"]);
  assert.equal(searchKnowledge(index, { task: "done" }).total, 0);
  assert.equal(index.tags[0].count, 1);
  assert.equal(index.tags[0].documentCount, 1);
  assert.equal(backlinksFor(index, "d1").length, 1);
  assert.equal(backlinksFor(index, "d1")[0].nodeId, "n2");
});

test("relations reject self, duplicate and overlong labels without changing the tree", () => {
  let document = doc("d", "图", [node("a", "甲"), node("b", "乙")]);
  const created = addRelation(document, { fromNodeId: "a", toNodeId: "b", label: "依赖" });
  assert.equal(created.error, null);
  document = created.document;
  assert.equal(addRelation(document, { fromNodeId: "a", toNodeId: "a", label: "自" }).error.includes("自己"), true);
  assert.equal(addRelation(document, { fromNodeId: "a", toNodeId: "b", label: "另一条" }).error.includes("同方向"), true);
  assert.equal(addRelation(document, { fromNodeId: "b", toNodeId: "a", label: "反向" }).error, null);
  assert.equal(addRelation(document, { fromNodeId: "a", toNodeId: "b", label: "超".repeat(41) }).error.includes("40"), true);
  const reversed = reverseRelation(document, created.relation.id);
  assert.equal(reversed.relation.fromNodeId, "b");
  assert.equal(deleteRelation(reversed.document, reversed.relation.id).knowledge.relations.length, 0);
  assert.equal(document.nodes.length, 2);
});

test("navigation preferences do not invent documents and backup scheduling orders W2 after W1", () => {
  let navigation = normalizeNavigation(null);
  navigation = toggleFavorite(navigation, "doc");
  navigation = toggleFavorite(navigation, "doc");
  assert.deepEqual(navigation.favorites, []);
  navigation = saveNavigationFilter(toggleFavorite(navigation, "doc"), { name: "未完成", query: "方案", tags: ["重点"], task: "open" });
  navigation = pruneNavigation(navigation, { liveIds: [], trashIds: ["doc"] });
  assert.deepEqual(navigation.favorites, ["doc"]);
  assert.equal(navigation.filters[0].broken, false);
  navigation = resetRecentOpens(pruneNavigation(navigation, { liveIds: [], trashIds: [] }));
  assert.deepEqual(navigation.favorites, []);

  let schedule = { ...createBackupSchedule(), enabled: true };
  let step = reduceBackupSchedule(schedule, { type: "saved", ticket: 1, hash: "A", authoritative: true }, 0);
  schedule = step.state;
  assert.equal(step.enqueue, null);
  step = reduceBackupSchedule(schedule, { type: "tick" }, 5000);
  assert.equal(step.enqueue.ticket, 1);
  schedule = reduceBackupSchedule(step.state, { type: "saved", ticket: 2, hash: "B", authoritative: true }, 6000).state;
  const finished = reduceBackupSchedule(schedule, { type: "write-finished", ticket: 1, hash: "A", ok: true }, 7000);
  assert.equal(finished.enqueue.ticket, 2);
  assert.equal(finished.enqueue.hash, "B");
  const ignored = reduceBackupSchedule(schedule, { type: "saved", ticket: 3, hash: "C", authoritative: false }, 8000);
  assert.equal(ignored.enqueue, null);
  const link = insertLinkAtQuery("[[项目", { start: 0, end: 4 }, { documentName: "项目方案" });
  assert.equal(link.text, "[[项目方案]]");
});

test("import id collisions remap internal links only", () => {
  const used = new Set(["doc", "n1"]);
  const incoming = doc("doc", "方案", [node("n1", "甲"), node("n2", "乙")], {
    knowledge: {
      version: 1,
      references: [{ id: "r", source: { kind: "node-field", nodeId: "n1", field: "text", start: 0, end: 1, raw: "甲" }, target: { documentId: "doc", nodeId: "n2" }, labelMode: "auto" }],
      relations: [],
    },
  });
  let counter = 0;
  const remapped = remapCollidingIds(incoming, used, (prefix) => `${prefix}-${++counter}`);
  assert.notEqual(remapped.document.id, "doc");
  assert.notEqual(remapped.document.nodes[0].id, "n1");
  assert.equal(remapped.document.nodes[1].id, "n2");
  assert.equal(remapped.document.knowledge.references[0].target.documentId, remapped.document.id);
  assert.equal(remapped.document.knowledge.references[0].target.nodeId, "n2");
  assert.equal(remapped.document.knowledge.references[0].source.nodeId, remapped.document.nodes[0].id);
});


test("renaming a same-named document does not retarget a deleted binding", () => {
  const raw = "[[方案]]";
  const source = doc("note", "笔记", [node("n", raw)], {
    knowledge: {
      version: 1,
      references: [{ id: "r", source: { kind: "node-field", nodeId: "n", field: "text", start: 0, end: raw.length, raw }, target: { documentId: "old" }, labelMode: "auto" }],
      relations: [],
    },
  });
  const workspace = {
    documents: [source, doc("fresh", "方案", [node("fresh-node", "新")])],
    trash: [{ document: doc("old", "方案", [node("old-node", "旧")]) }],
  };
  const renamed = renameTarget(workspace, { documentId: "fresh", nextLabel: "新方案" });
  const note = renamed.workspace.documents[0];
  assert.equal(note.nodes[0].text, raw);
  assert.equal(note.knowledge.references[0].target.documentId, "old");
  assert.deepEqual(resolveDocumentConnections(renamed.workspace, note).map((item) => item.status), ["deleted"]);
});

test("malformed knowledge metadata is rejected before import", () => {
  const body = "# 方案\n\n- 目标";
  const payload = { v: 1, documentId: "doc", digest: sha256Hex(canonicalText(body)), nodes: [{ id: "n", path: [0], text: "目标" }], knowledge: { version: 1, references: [null], relations: [] } };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  assert.equal(readBikeMetadata(`${body}\n\n<!-- bike:document:v1 ${encoded} -->`).status, "invalid");
});

test("canonical text trimming stays linear for deep indentation", () => {
  const started = performance.now();
  assert.equal(canonicalText(`${" ".repeat(20000)}x`).endsWith("x"), true);
  assert.ok(performance.now() - started < 50);
});

test("unclosed wiki openers are scanned linearly without hiding a later code-separated link", () => {
  const start = performance.now();
  assert.deepEqual(scanLinks("[[".repeat(100000)), []);
  assert.ok(performance.now() - start < 1000);
  assert.deepEqual(scanLinks("[[[[ `code` [[Target]]").map((link) => link.documentName), ["Target"]);
});


test("editing a markdown topic keeps its node id when the tree shape is unchanged", async () => {
  const { loadTypescript } = await import("./helpers/typescript.mjs");
  const { parseMarkdownDocument } = loadTypescript("src/markdown.ts");
  const before = parseMarkdownDocument("# Plan\n\n- Old topic", { documentId: "plan", now: "2026-11-08T00:00:00.000Z" });
  const after = parseMarkdownDocument("# Plan\n\n- New topic", {
    previousDocument: before,
    documentId: "plan",
    now: "2026-11-08T00:00:00.000Z",
  });
  assert.equal(after.nodes[0].id, before.nodes[0].id);
  assert.equal(after.nodes[0].text, "New topic");
});


test("editing around a bound note link keeps the original deleted target", () => {
  const raw = "[[方案]]";
  const document = doc("note", "笔记", [node("n", "主题", { note: raw })], {
    knowledge: {
      version: 1,
      references: [{ id: "r", source: { kind: "node-field", nodeId: "n", field: "note", start: 0, end: raw.length, raw }, target: { documentId: "old" }, labelMode: "auto" }],
      relations: [],
    },
  });
  const edited = withFieldText(document, { nodeId: "n", field: "note", text: `见 ${raw}` });
  const workspace = {
    documents: [edited, doc("fresh", "方案", [node("fresh-node", "新")])],
    trash: [{ document: doc("old", "方案", [node("old-node", "旧")]) }],
  };
  const connections = resolveDocumentConnections(workspace, edited);
  assert.deepEqual(connections.map((item) => item.status), ["deleted"]);
  assert.equal(connections[0].reference.target.documentId, "old");
});

test("mixed Markdown edits preserve anchored identity while ambiguous replacements do not", async () => {
  const { loadTypescript } = await import("./helpers/typescript.mjs");
  const { parseMarkdownDocument } = loadTypescript("src/markdown.ts");
  const before = parseMarkdownDocument("# Document\n\n- Alpha\n- Beta");
  const after = parseMarkdownDocument("# Document\n\n- Alpha edited\n- Beta\n- Added", { previousDocument: before });
  assert.equal(after.nodes[0].id, before.nodes[0].id);
  assert.equal(after.nodes[1].id, before.nodes[1].id);
  assert.equal(new Set([...before.nodes.map((node) => node.id)]).has(after.nodes[2].id), false);
  const replaced = parseMarkdownDocument("# Document\n\n- Gamma\n- Delta", { previousDocument: before });
  assert.equal(replaced.nodes.some((node) => before.nodes.some((old) => old.id === node.id)), false);
  const duplicates = parseMarkdownDocument("# Document\n\n- Same\n- Same\n- Tail");
  const reordered = parseMarkdownDocument("# Document\n\n- Same\n- Tail\n- Same", { previousDocument: duplicates });
  assert.equal(reordered.nodes.filter((node) => node.text === "Same").some((node) => duplicates.nodes.some((old) => old.id === node.id)), false);
});
