import assert from "node:assert/strict";
import test from "node:test";
import { loadTypescript } from "./helpers/typescript.mjs";

const { safeMarkdownUrl } = loadTypescript("src/safeUrl.ts");

test("link filter rejects script URLs the browser would still run", () => {
  for (const value of [
    "javascript:alert(1)",
    " JAVASCRIPT:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "javascript\r:alert(1)",
    "\u0001javascript:alert(1)",
    "\u0000 javascript:alert(1)",
    " javascript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
  ]) {
    assert.equal(safeMarkdownUrl(value, "link"), "", JSON.stringify(value));
  }
});

test("link filter keeps ordinary links and image data URLs", () => {
  assert.equal(safeMarkdownUrl(" https://example.com/a?b=1 ", "link"), "https://example.com/a?b=1");
  assert.equal(safeMarkdownUrl("http://example.com", "link"), "http://example.com");
  assert.equal(safeMarkdownUrl("mailto:me@example.com", "link"), "mailto:me@example.com");
  assert.equal(safeMarkdownUrl("tel:+8610", "link"), "tel:+8610");
  assert.equal(safeMarkdownUrl("#section", "link"), "#section");
  assert.equal(safeMarkdownUrl("docs/readme.md", "link"), "docs/readme.md");
  assert.equal(safeMarkdownUrl("data:image/png;base64,AAAA", "image"), "data:image/png;base64,AAAA");
  assert.equal(safeMarkdownUrl("data:image/png;base64,AAAA", "link"), "");
  assert.equal(safeMarkdownUrl("   ", "link"), "");
});
