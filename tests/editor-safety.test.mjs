import assert from "node:assert/strict";
import test from "node:test";
import { loadTypescript } from "./helpers/typescript.mjs";

const tree = loadTypescript("src/tree.ts");
const { documentSignature } = loadTypescript("src/documentSignature.ts");
const { expandAncestors } = loadTypescript("src/knowledge.ts");
const node = (id, children = []) => ({ ...tree.createNode(id), id, children });

test("content signatures are pure and stable for empty documents and missing defaults", () => {
  const document = { id: "empty", title: "Empty", nodes: [] };
  const before = JSON.stringify(document);
  assert.equal(documentSignature(document), documentSignature(document));
  assert.equal(JSON.stringify(document), before);
  const edited = { ...document, nodes: [node("new")] };
  assert.notEqual(documentSignature(document), documentSignature(edited));
  assert.equal(documentSignature(edited), documentSignature({ ...edited, updatedAt: "later", markdownUpdatedAt: "later" }));
});

test("navigation expansion retains unchanged tree references", () => {
  const nodes = [node("parent", [node("child")])];
  assert.equal(expandAncestors(nodes, "child").nodes, nodes);
  assert.equal(expandAncestors(nodes, "missing").nodes, nodes);
});

test("focused drag commands keep the full tree and reject focus boundary moves", () => {
  const outside = node("outside");
  const nodes = [outside, node("focus", [node("a"), node("b")])];
  const moved = tree.relocateNode(nodes, "b", "a", "before", "focus");
  assert.equal(moved[0], outside);
  assert.deepEqual(moved[1].children.map((item) => item.id), ["b", "a"]);
  assert.equal(tree.relocateNode(nodes, "a", "focus", "before", "focus"), nodes);
  assert.equal(tree.relocateNode(nodes, "focus", "a", "child", "focus"), nodes);
  assert.equal(tree.relocateNode(nodes, "outside", "a", "child", "focus"), nodes);
  const nested = tree.relocateNode(nodes, "b", "a", "child", "focus");
  assert.equal(nested[0], outside);
  assert.equal(nested[1].children[0].children[0].id, "b");
});

test("structural edits copy only their ancestor path and keep no-op identity", () => {
  const outside = node("outside", [node("untouched")]);
  const nodes = [outside, node("parent", [node("a"), node("b")])];
  for (const result of [
    tree.insertParent(nodes, "a", node("new-parent")),
    tree.removeNode(nodes, "a"),
    tree.insertSiblingAfter(nodes, "a", node("new")),
    tree.addChild(nodes, "a", node("new")),
  ]) assert.equal(result[0], outside);
  for (const operation of [tree.insertSiblingAfter, tree.insertSiblingBefore, tree.addChild]) {
    assert.equal(operation(nodes, "missing", node("new")), nodes);
  }
  assert.equal(tree.moveNode(nodes, "a", -1), nodes);
});
