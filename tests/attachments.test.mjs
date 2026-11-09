import assert from "node:assert/strict";
import test from "node:test";
import { collectAttachmentRefs, validateDocumentAttachments, workspaceFormatVersion, workspaceAttachmentAssets, mergeAttachmentMetadata } from "../shared/bike-attachments.mjs";
import { loadAppCallback, loadTypescript } from "./helpers/typescript.mjs";
import { migrateWorkspace as migrateMcp } from "../mcp/bike-core.mjs";
import { documentToMarkdown, parseMarkdownDocument } from "../shared/bike-markdown.mjs";
import { reconcileMarkdownReferences } from "../shared/bike-knowledge.mjs";

const { migrateWorkspace } = loadTypescript("src/migrations.ts");
const { exportDocument, importDocument } = loadTypescript("src/exporters.ts");
const assetId = `sha256:${"a".repeat(64)}`;
const metadata = { mediaType: "image/png", byteLength: 100, width: 1, height: 1 };
const document = () => ({
  id: "doc", title: "图片", createdAt: "2026-11-09T00:00:00Z", updatedAt: "2026-11-09T00:00:00Z",
  attachments: { version: 1, items: { [assetId]: metadata } },
  nodes: [{ id: "node", text: "主题", children: [], attachmentRefs: [{ assetId, name: "中文 😀.png" }] }],
});

test("desktop and MCP preserve v1 text and v2 attachment identities", () => {
  for (const migrate of [migrateWorkspace, migrateMcp]) {
    const text = { version: 1, activeDocumentId: "text", documents: [{ id: "text", title: "Text", nodes: [] }] };
    assert.equal(migrate(text).version, 1);
    const workspace = { version: 2, activeDocumentId: "doc", documents: [document()] };
    const loaded = migrate(workspace);
    assert.equal(loaded.version, 2);
    assert.equal(loaded.documents[0].nodes[0].id, "node");
    assert.deepEqual(loaded.documents[0].attachments, workspace.documents[0].attachments);
    assert.deepEqual(loaded.documents[0].nodes[0].attachmentRefs, workspace.documents[0].nodes[0].attachmentRefs);
    assert.throws(() => migrate({ ...workspace, version: 1 }), /version 2/);
    assert.throws(() => migrate({ ...workspace, version: 3 }), /版本/);
    const unknown = document();
    unknown.attachments.version = 99;
    const before = JSON.stringify(unknown);
    assert.throws(() => migrate({ ...workspace, documents: [unknown] }), /附件格式/);
    assert.equal(JSON.stringify(unknown), before);
  }
});

test("attachment validation rejects missing metadata, traversal ids and invalid sizes", () => {
  const item = document();
  validateDocumentAttachments(item);
  assert.equal(collectAttachmentRefs(item.nodes).length, 1);
  delete item.attachments.items[assetId];
  assert.throws(() => validateDocumentAttachments(item), /缺少元数据/);
  item.nodes[0].attachmentRefs[0].assetId = "../../outside";
  assert.throws(() => validateDocumentAttachments(item), /标识无效/);
  item.nodes[0].attachmentRefs[0].assetId = assetId;
  item.attachments.items[assetId] = { ...metadata, byteLength: -1 };
  assert.throws(() => validateDocumentAttachments(item), /元数据/);
});

test("archive roots include trash and metadata merges preserve shared blob identity", () => {
  const item = document();
  const text = { id: "text", nodes: [] };
  const workspace = { version: 1, documents: [text], trash: [{ document: item }] };
  assert.equal(workspaceFormatVersion(workspace), 2);
  assert.deepEqual(workspaceAttachmentAssets(workspace), [{ assetId, metadata }]);
  const merged = mergeAttachmentMetadata(text, item);
  assert.equal(merged.attachments.items[assetId], metadata);
  assert.equal(text.attachments, undefined);
  assert.throws(() => mergeAttachmentMetadata(merged, { ...item, attachments: { version: 1, items: { [assetId]: { ...metadata, byteLength: 101 } } } }), /冲突/);
});

test("Markdown source retains attachment ids and source removal removes the reference", () => {
  const item = migrateWorkspace({ version: 2, activeDocumentId: "doc", documents: [document()] }).documents[0];
  const source = documentToMarkdown(item);
  assert.match(source, /bike-attachment:sha256:/);
  const parsed = parseMarkdownDocument(source, { previousDocument: item });
  assert.equal(parsed.nodes[0].id, item.nodes[0].id);
  assert.equal(parsed.nodes[0].attachmentRefs[0].assetId, assetId);
  assert.equal(parsed.nodes[0].attachmentRefs[0].name, item.nodes[0].attachmentRefs[0].name);
  const removed = parseMarkdownDocument(source.split("\n").filter((line) => !line.includes("bike-attachment:")).join("\n"), { previousDocument: item });
  assert.deepEqual(removed.nodes[0].attachmentRefs, []);
});

test("Markdown source retains attachment references with escaped labels", () => {
  for (const image of [true, false]) {
    const item = document();
    item.nodes[0].attachmentRefs = [{
      assetId, name: "截图 [1] (终稿)\\备份.png", ...(image ? { alt: "路线 [A] \\ [B]" } : {}),
    }];
    if (!image) item.attachments.items[assetId] = { mediaType: "application/octet-stream", byteLength: 100 };
    const source = documentToMarkdown(item);
    const parsed = parseMarkdownDocument(source, { previousDocument: item });
    assert.deepEqual(parsed.nodes[0].attachmentRefs, item.nodes[0].attachmentRefs);
    assert.equal(parsed.nodes.length, 1);
  }
});

test("the first Markdown source edit preserves the displayed topic identity and attachment", () => {
  const item = migrateWorkspace({ version: 2, activeDocumentId: "doc", documents: [document()] }).documents[0];
  item.nodes[0].attachmentRefs[0].alt = "路线 [A]";
  const parse = loadAppCallback("parseMarkdownIntoDocument", {
    now: () => item.updatedAt, documentToMarkdown, parseMarkdownDocument, reconcileMarkdownReferences,
  });
  const parsed = parse(item, documentToMarkdown(item).replace("主题", "主题已修改"));
  assert.equal(parsed.nodes[0].id, item.nodes[0].id);
  assert.equal(parsed.nodes[0].text, "主题已修改");
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.nodes[0].attachmentRefs)), item.nodes[0].attachmentRefs);
  assert.equal(item.markdownSource, undefined);
});

test("metadata Markdown preserves the full attachment manifest and per-use names", () => {
  const item = migrateWorkspace({ version: 2, activeDocumentId: "doc", documents: [document()] }).documents[0];
  item.nodes[0].attachmentRefs.push({ assetId, name: "第二次使用.png", alt: "替代文字" });
  const result = exportDocument(item, "markdown", { metadata: true });
  assert.equal(result.error, undefined);
  const restored = importDocument(result.content, result.filename);
  assert.deepEqual(restored.attachments, item.attachments);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.nodes)), JSON.parse(JSON.stringify(item.nodes)));
  const parsed = parseMarkdownDocument(documentToMarkdown(item), { previousDocument: item });
  assert.deepEqual(parsed.nodes[0].attachmentRefs.map((ref) => ref.name), ["中文 😀.png", "第二次使用.png"]);
});
