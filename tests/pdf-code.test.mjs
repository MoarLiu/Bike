import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { loadTypescript, projectRoot } from "./helpers/typescript.mjs";

test("PDF export draws code language and multiline Chinese code through the normal export entry", async () => {
  const filename = path.join(projectRoot, "src/exporters.ts");
  const require = createRequire(filename);
  const pdf = require("pdf-lib");
  const fontkit = require("@pdf-lib/fontkit");
  const source = await fs.readFile(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const font = await fs.readFile(path.join(projectRoot, "src/assets/NotoSansSC-ChineseSimplified.ttf"));
  const text = [];
  let downloaded;
  const drawText = pdf.PDFPage.prototype.drawText;
  pdf.PDFPage.prototype.drawText = function (value, options) {
    text.push(value);
    return drawText.call(this, value, options);
  };
  const module = { exports: {} };
  const context = {
    require(name) {
      if (name === "@pdf-lib/fontkit") return { default: fontkit };
      if (name.endsWith("?url")) return { default: name.slice(0, -4) };
      if (!name.startsWith(".")) return require(name);
      const target = path.resolve(path.dirname(filename), name);
      return /\.(mjs|cjs|js)$/.test(name) ? require(target) : loadTypescript(`${target}.ts`);
    },
    module,
    exports: module.exports,
    Blob,
    fetch: async (url) => new Response(await fs.readFile(path.resolve(path.dirname(filename), url))),
    URL: { createObjectURL(blob) { downloaded = blob; return "blob:pdf-code-test"; }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } },
    window: { setTimeout(callback) { callback(); } },
  };
  try {
    const execute = vm.runInThisContext(
      `(function(require, module, exports, Blob, fetch, URL, document, window) {\n${compiled}\n})`,
      { filename },
    );
    execute(
      context.require, module, module.exports, Blob,
      context.fetch, context.URL, context.document, context.window,
    );
    const document = {
      id: "pdf-code",
      title: "代码导出验证",
      createdAt: "2026-11-11T00:00:00.000Z",
      updatedAt: "2026-11-11T00:00:00.000Z",
      nodes: [{
        id: "code",
        text: "代码主题🙂 ★ → ✓ ℃ 日本語 한국어",
        icon: "★",
        note: "保留备注",
        checked: true,
        collapsed: false,
        color: "plain",
        codeLanguage: "javascript",
        codeBlock: 'const 中文 = "验证";\n\n  console.log(中文);',
        children: [],
      }],
    };
    assert.equal(await module.exports.exportDocumentAsPdf(document), "代码导出验证.pdf");
    assert.ok(text.includes("代码（javascript）"));
    assert.ok(text.join("").includes("[x] ★ 代码主题🙂 ★ → ✓ ℃ 日本語 한국어"));
    assert.ok(!text.join("").includes("[U+"));
    assert.ok(text.includes('const 中文 = "验证";'));
    assert.ok(text.includes("  console.log(中文);"));
    assert.ok(text.includes(""));
    assert.equal(downloaded.type, "application/pdf");
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    assert.equal((await pdf.PDFDocument.load(bytes)).getPageCount(), 1);
    if (process.env.BIKE_PDF_EVIDENCE) { await fs.mkdir(path.dirname(process.env.BIKE_PDF_EVIDENCE), {recursive:true}); await fs.writeFile(process.env.BIKE_PDF_EVIDENCE,bytes); }
  } finally {
    pdf.PDFPage.prototype.drawText = drawText;
  }
});
