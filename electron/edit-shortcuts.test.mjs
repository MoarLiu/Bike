import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { editCommandForInput } = require("./edit-shortcuts.cjs");

test("desktop history shortcuts handle Command and Control without duplicate keyup", () => {
  const input = { type: "keyDown", key: "z", meta: true };
  assert.equal(editCommandForInput(input), "undo");
  assert.equal(editCommandForInput({ ...input, shift: true }), "redo");
  assert.equal(editCommandForInput({ ...input, meta: false, control: true }), "undo");
  assert.equal(editCommandForInput({ ...input, key: "y", meta: false, control: true }), "redo");
  assert.equal(editCommandForInput({ ...input, type: "keyUp" }), null);
  assert.equal(editCommandForInput({ ...input, isComposing: true }), null);
  assert.equal(editCommandForInput({ ...input, alt: true }), null);
  assert.equal(editCommandForInput({ ...input, meta: false }), null);
});
