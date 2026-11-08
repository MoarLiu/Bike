import assert from "node:assert/strict";
import test from "node:test";
import { installFakeBrowserStorage } from "./helpers/fake-browser.mjs";
import { loadTypescript, loadTypescriptIsolated } from "./helpers/typescript.mjs";

const { migrateWorkspace } = loadTypescript("src/migrations.ts");
const pure = loadTypescript("src/versionHistory.ts");

const OLD = "2026-01-01T00:00:00.000Z";
const workspace = () => migrateWorkspace({
  version: 1,
  activeDocumentId: "doc",
  documents: [{
    id: "doc", title: "Doc", createdAt: OLD, updatedAt: OLD,
    nodes: [{ id: "node", text: "one", children: [] }],
  }],
});

const documentAt = (text, createdAt) => ({
  ...workspace().documents[0],
  updatedAt: createdAt,
  nodes: [{ id: "node", text, children: [] }],
});

test("appendSnapshot skips a duplicate latest version", () => {
  const first = pure.createSnapshot(documentAt("one", OLD), "auto", OLD);
  const second = pure.createSnapshot(documentAt("two", OLD), "auto", "2026-01-02T00:00:00.000Z");
  const duplicate = pure.createSnapshot(documentAt("one", OLD), "auto", "2026-01-03T00:00:00.000Z");
  const result = pure.appendSnapshot([first, second], duplicate, Date.parse("2026-01-03T00:00:00.000Z"));
  assert.equal(result.length, 2);
  assert.equal(result[0].signature, duplicate.signature);
  assert.equal(result[1].signature, second.signature);
});

test("revisiting an older version retains the intervening history", () => {
  const first = pure.createSnapshot(documentAt("one", OLD), "auto", OLD);
  const second = pure.createSnapshot(documentAt("two", OLD), "manual", "2026-01-02T00:00:00.000Z");
  const third = pure.createSnapshot(documentAt("one", OLD), "before-restore", "2026-01-03T00:00:00.000Z");
  const result = pure.appendSnapshot([second, first], third, Date.parse(third.createdAt));
  assert.deepEqual(result.map((snapshot) => snapshot.id), [third.id, second.id, first.id]);
});

test("snapshot retention enforces count, age, and byte limits", () => {
  const at = new Date().toISOString();
  const snapshots = Array.from({ length: 60 }, (_, index) => ({
    ...pure.createSnapshot(documentAt(`version ${index}`, at), "auto", at),
    size: 1024,
  }));
  assert.equal(pure.appendSnapshot(snapshots.slice(1), snapshots[0]).length, 50);
  const old = snapshots.slice(0, 5).map((snapshot) => ({ ...snapshot, createdAt: OLD }));
  assert.equal(pure.appendSnapshot(old.slice(1), old[0]).length, 3);
  const large = snapshots.slice(0, 5).map((snapshot) => ({ ...snapshot, size: 8 * 1024 * 1024 }));
  assert.equal(pure.appendSnapshot(large.slice(1), large[0]).length, 2);
  const oversized = { ...large[0], size: 30 * 1024 * 1024 };
  assert.equal(pure.appendSnapshot([], oversized).length, 1);
  const chinese = pure.createSnapshot(documentAt("中文".repeat(20), at), "auto");
  assert.ok(chinese.size > JSON.stringify(chinese.document).length);
});

test("diffDocuments counts added, removed and changed nodes", () => {
  const current = {
    ...workspace().documents[0],
    nodes: [
      { id: "keep", text: "same", children: [] },
      { id: "changed", text: "new text", children: [] },
      { id: "added", text: "new", children: [] },
    ],
  };
  const snapshot = {
    ...workspace().documents[0],
    nodes: [
      { id: "keep", text: "same", children: [] },
      { id: "changed", text: "old text", children: [] },
      { id: "removed", text: "gone", children: [] },
    ],
  };
  assert.deepEqual(pure.diffDocuments(current, snapshot), { added: 1, removed: 1, changed: 1 });
});

test("previewLines limits output and records depth", () => {
  const nodes = [
    { id: "1", text: "root", children: [
      { id: "2", text: "child", children: [] },
    ] },
  ];
  const lines = pure.previewLines(nodes, 2);
  assert.deepEqual(lines, [
    { depth: 0, text: "root" },
    { depth: 1, text: "child" },
  ]);
});

test("captureSnapshot persists snapshots in IndexedDB", async (t) => {
  const env = installFakeBrowserStorage(t);
  const history = loadTypescriptIsolated("src/versionHistory.ts");
  const first = await history.captureSnapshot(documentAt("one", OLD), "auto");
  assert.equal(first.length, 1);

  const second = await history.captureSnapshot(documentAt("two", OLD), "auto");
  assert.equal(second.length, 2);
  assert.equal(second[0].document.nodes[0].text, "two");

  const listed = await history.listDocumentSnapshots("doc");
  assert.equal(listed.length, 2);
  await env.settle();
  assert.deepEqual(env.idb.handlerErrors, []);
});

test("two tabs capturing concurrently retain both versions", async (t) => {
  const env = installFakeBrowserStorage(t);
  const firstTab = loadTypescriptIsolated("src/versionHistory.ts");
  const secondTab = loadTypescriptIsolated("src/versionHistory.ts");
  await Promise.all([
    firstTab.captureSnapshot(documentAt("first tab", OLD), "auto"),
    secondTab.captureSnapshot(documentAt("second tab", OLD), "manual"),
  ]);
  const snapshots = await firstTab.listDocumentSnapshots("doc");
  assert.equal(snapshots.length, 2);
  assert.deepEqual(new Set(snapshots.map((snapshot) => snapshot.document.nodes[0].text)), new Set(["first tab", "second tab"]));
  await env.settle();
  assert.equal(env.idb.openConnections, 0);
  assert.deepEqual(env.idb.handlerErrors, []);
});

test("snapshot write failures reject without replacing stored history", async (t) => {
  const env = installFakeBrowserStorage(t);
  const history = loadTypescriptIsolated("src/versionHistory.ts");
  await history.captureSnapshot(documentAt("original", OLD), "auto");
  env.idb.failPut({ db: "bike-history-db", key: "document:doc", times: 1 });
  await assert.rejects(history.captureSnapshot(documentAt("new", OLD), "manual"));
  env.idb.resetFailures();
  const snapshots = await history.listDocumentSnapshots("doc");
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].document.nodes[0].text, "original");
  await env.settle();
  assert.deepEqual(env.idb.handlerErrors, []);
});

test("malformed history is reported and retained instead of replaced by an empty list", async (t) => {
  const env = installFakeBrowserStorage(t);
  const original = { broken: true };
  env.idb.seed("bike-history-db", { "document:doc": original }, "snapshots");
  const history = loadTypescriptIsolated("src/versionHistory.ts");
  await assert.rejects(history.listDocumentSnapshots("doc"), /版本历史数据损坏/);
  await assert.rejects(history.captureSnapshot(documentAt("new", OLD), "manual"), /版本历史数据损坏/);
  assert.deepEqual(env.idb.read("bike-history-db", "document:doc", "snapshots"), original);
  await env.settle();
  assert.deepEqual(env.idb.handlerErrors, []);
});
