import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as knowledge from "../shared/bike-knowledge.mjs";
import { loadAppCallback, loadTypescript } from "./helpers/typescript.mjs";

const markdown = loadTypescript("src/markdown.ts");

function preview(content, onClick) {
  const filename = new URL("../src/App.tsx", import.meta.url);
  const ast = ts.createSourceFile("App.tsx", readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(["MarkdownPreview", "renderInlineMarkdown", "renderMarkdownPreviewList", "buildMarkdownPreviewList", "markdownCellOffset", "splitMarkdownTableRow", "splitEscapedPipe", "isTableSeparator", "isTableStart"]);
  const source = ast.statements.filter((node) => names.has(node.name?.text) || (ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => names.has(item.name.getText(ast))))).map((node) => node.getText(ast)).join("\n");
  const code = ts.transpileModule(`${source}\nMarkdownPreview({ content, documentId: "source" });`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const result = vm.runInNewContext(code, { require: createRequire(import.meta.url), exports: {}, ...markdown, assertTreeBudget: () => {}, scanLinks: knowledge.scanLinks, useMemo: (callback) => callback(), content, openWikiLinkHandler: onClick });
  const buttons = [];
  const walk = (element) => {
    if (Array.isArray(element)) { element.forEach(walk); return; }
    if (!element || typeof element !== "object") return;
    if (typeof element.type === "function") { walk(element.type(element.props)); return; }
    if (element.type === "button" && element.props.className === "wiki-link-chip") buttons.push(element);
    walk(element.props?.children);
  };
  walk(result);
  return buttons;
}

test("actual Markdown preview buttons retain UTF-16 source spans across blocks", () => {
  const raw = "[[方案]]";
  const content = `# 📚 ${raw}\n\n- ${raw}\n  - **子项** ${raw}\n\n> 见 ${raw}\n\n| 主题 | 备注 |\n| --- | --- |\n| ${raw} | ${raw} |\n\n一行 ${raw}\n第二行 ${raw}\n\n\`\`\`\n${raw}\n\`\`\`\n\`行内 ${raw}\``;
  const links = knowledge.scanLinks(content);
  const document = markdown.parseMarkdownDocument(content, { documentId: "source" });
  document.knowledge = { version: 1, references: links.map((link, i) => ({ id: `r${i}`, source: { kind: "markdown", start: link.start, end: link.end, raw: link.raw }, target: { documentId: `target${i}` }, labelMode: "auto" })), relations: [] };
  const workspace = { documents: [document, ...links.map((_, i) => ({ id: `target${i}`, title: "方案", nodes: [] }))] };
  const opened = [];
  const follow = loadAppCallback("followWikiLink", { ...knowledge, ...markdown, flushPendingEdits: () => workspace, workspaceRef: { current: workspace }, openKnowledgeTarget: (id) => opened.push(id), showNotice: (message) => assert.fail(message) });
  const buttons = preview(content, follow);
  assert.equal(buttons.length, links.length);
  buttons.forEach((button) => button.props.onClick({ preventDefault() {} }));
  assert.deepEqual(opened, links.map((_, i) => `target${i}`));
});

test("preview of structured notes uses each node's saved binding", () => {
  const raw = "[[方案]]";
  const document = { id: "source", title: "Source", nodes: [
    { id: "one", text: "First", note: raw, children: [] },
    { id: "two", text: "Second", note: raw, children: [] },
  ], knowledge: { version: 1, references: ["one", "two"].map((nodeId, i) => ({
    id: `r${i}`, source: { kind: "node-field", nodeId, field: "note", start: 0, end: raw.length, raw }, target: { documentId: `target${i}` }, labelMode: "auto",
  })), relations: [] } };
  const workspace = { documents: [document, { id: "target0", title: "方案", nodes: [] }, { id: "target1", title: "方案", nodes: [] }] };
  const opened = [];
  const follow = loadAppCallback("followWikiLink", { ...knowledge, ...markdown, flushPendingEdits: () => workspace, workspaceRef: { current: workspace }, openKnowledgeTarget: (id) => opened.push(id), showNotice: (message) => assert.fail(message) });
  const buttons = preview(markdown.documentToMarkdown(document), follow);
  assert.equal(buttons.length, 2);
  buttons.forEach((button) => button.props.onClick({ preventDefault() {} }));
  assert.deepEqual(opened, ["target0", "target1"]);
});

test('BOM, CRLF and escaped table pipes retain exact source ranges and bound identities', () => {
  const raw = '[[方案|别名]]';
  const content = `\uFEFF# 文档\r\n\r\n| 名称 | 链接 |\r\n| --- | --- |\r\n| A\\|B | ${raw.replace('|', '\\|')} |\r\n\r\n后续段落 ${raw}`;
  const document = markdown.parseMarkdownDocument(content, { documentId: 'source' });
  // The actual persisted editor normalizes BOM/CRLF during parse; preview also
  // accepts raw imported text and must describe the original submitted bytes.
  document.markdownSource = content;
  const last = content.lastIndexOf(raw);
  const escaped = raw.replace('|', '\\|');
  document.knowledge = { version: 1, references: [
    { id: 'table', source: { kind: 'markdown', start: content.indexOf(escaped), end: content.indexOf(escaped) + escaped.length, raw: escaped }, target: { documentId: 'table-target' }, labelMode: 'custom' },
    { id: 'paragraph', source: { kind: 'markdown', start: last, end: last + raw.length, raw }, target: { documentId: 'paragraph-target' }, labelMode: 'custom' },
  ], relations: [] };
  const workspace = { documents: [document, { id: 'table-target', title: '方案', nodes: [] }, { id: 'paragraph-target', title: '方案', nodes: [] }] };
  const spans = [], targets = [];
  const buttons = preview(content, (raw, source) => { spans.push(source); targets.push(knowledge.resolveWikiLink(workspace, raw, source)); });
  assert.equal(buttons.length, 2);
  buttons.forEach((button) => button.props.onClick({ preventDefault() {} }));
  assert.equal(content.slice(spans[0].start, spans[0].end), escaped);
  assert.equal(content.slice(spans[1].start, spans[1].end), raw);
  assert.deepEqual(targets.map((target) => target.documentId), ['table-target', 'paragraph-target']);
  assert.deepEqual(targets.map((target) => target.status), ['resolved', 'resolved']);
});
