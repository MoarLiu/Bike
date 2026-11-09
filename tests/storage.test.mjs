import assert from "node:assert/strict";
import test from "node:test";
import { installFakeBrowserStorage } from "./helpers/fake-browser.mjs";
import { loadTypescript, loadTypescriptIsolated } from "./helpers/typescript.mjs";

const { migrateWorkspace } = loadTypescript("src/migrations.ts");

const DB = "bike-db";
const LEGACY_DB = "local-outline-db";
const SNAPSHOT = "bike-workspace";
const SNAPSHOT_META = "bike-workspace-meta";
const SNAPSHOT_PREFIX = "bike-workspace-snapshot:";
const OLD = "2020-01-01T00:00:00.000Z";

const workspace = (text, updatedAt = OLD) => migrateWorkspace({
  version: 1,
  activeDocumentId: "doc",
  documents: [{
    id: "doc", title: "Doc", createdAt: OLD, updatedAt,
    nodes: [{ id: "node", text, children: [] }],
  }],
});
const edit = (base, text, updatedAt = new Date().toISOString()) => ({
  ...base,
  documents: [{ ...base.documents[0], updatedAt, nodes: [{ ...base.documents[0].nodes[0], text }] }],
});
const textOf = (value) => value.documents[0].nodes[0].text;

test("v1 to v2 save atomically retains the pre-attachment workspace", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("before attachments"), { savedAt: OLD, revision: 1 });
  const tab = b.tab();
  const base = await tab.loadWorkspace();
  const next = { ...base.workspace, version: 2 };
  assert.deepEqual(await tab.saveWorkspace(next), { ok: true, target: "indexeddb" });
  assert.deepEqual(await tab.loadPreAttachmentWorkspace(), base.workspace);
  assert.equal(b.stored().version, 2);
  assert.equal(b.storedMeta().revision, 2);
  await b.done();
});

// Each tab is an independent instance of src/storage.ts over shared fakes.
function browser(t, options) {
  const env = installFakeBrowserStorage(t, options);
  const ls = env.localStorage.storage;
  const snapshots = () => Array.from({ length: ls.length }, (_, index) => ls.key(index))
    .filter((key) => key?.startsWith(SNAPSHOT_PREFIX))
    .map((id) => ({ id, ...JSON.parse(ls.getItem(id)) }))
    .sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt));
  return {
    ...env,
    ls,
    tab: () => loadTypescriptIsolated("src/storage.ts"),
    seedDb: (value, meta, name = DB) => env.idb.seed(name, meta === undefined
      ? { workspace: value }
      : { workspace: value, "workspace-meta": meta }),
    seedSnapshot: (value, meta) => {
      ls.setItem(SNAPSHOT, JSON.stringify(value));
      if (meta !== undefined) ls.setItem(SNAPSHOT_META, JSON.stringify(meta));
    },
    stored: () => env.idb.read(DB, "workspace"),
    storedMeta: () => env.idb.read(DB, "workspace-meta"),
    snapshots,
    snapshotMeta: () => snapshots()[0] ?? JSON.parse(ls.getItem(SNAPSHOT_META) ?? "null"),
    snapshotWorkspace: () => snapshots()[0]?.workspace ?? JSON.parse(ls.getItem(SNAPSHOT) ?? "null"),
    dbCommits: () => env.idb.log.commits.filter((commit) => commit.db === DB),
    // Lets every pending fake event run, then checks nothing was left broken.
    done: async ({ openConnections = 0 } = {}) => {
      await env.settle();
      assert.deepEqual(env.idb.handlerErrors, []);
      assert.deepEqual(env.channels.listenerErrors, []);
      assert.equal(env.idb.openConnections, openConnections);
    },
  };
}

const counter = () => {
  const fn = () => { fn.calls += 1; };
  fn.calls = 0;
  return fn;
};

test("backup save receipts follow committed IndexedDB revisions across windows", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("initial"), { revision: 10 });
  const a = b.tab();
  const initial = await loaded(a);
  assert.equal(a.getWorkspaceSaveRevision(initial.workspace), 10);
  const first = edit(initial.workspace, "first");
  await a.saveWorkspace(first);
  assert.equal(a.getWorkspaceSaveRevision(first), 11);
  const other = b.tab();
  const latest = await loaded(other);
  const second = edit(latest.workspace, "second");
  await other.saveWorkspace(second);
  assert.equal(other.getWorkspaceSaveRevision(second), 12);
  assert.equal(a.getWorkspaceSaveRevision(first), 11);
  const rejected = edit(first, "stale");
  assert.equal((await a.saveWorkspace(rejected)).ok, false);
  assert.equal(a.getWorkspaceSaveRevision(rejected), undefined);
  await b.done();
});

const loaded = async (tab) => {
  const result = await tab.loadWorkspace();
  assert.equal(result.status, "loaded", result.error?.message);
  return result;
};

for (const staleEdit of [false, true]) {
  test(`a stale tab closing ${staleEdit ? "with" : "without"} an unsaved edit cannot replace newer data`, async (t) => {
    const b = browser(t);
    b.seedDb(workspace("original"), { savedAt: OLD, revision: 1, writer: "earlier-page" });
    const tabA = b.tab();
    const tabB = b.tab();
    const aConflicts = counter();
    tabA.subscribeToWorkspaceConflicts(aConflicts);
    const a = await loaded(tabA);
    const fromB = await loaded(tabB);

    const bEdit = edit(fromB.workspace, "B's edit");
    assert.deepEqual(await tabB.saveWorkspace(bEdit), { ok: true, target: "indexeddb" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    // A closes later; its snapshot is newer by timestamp than B's save, which
    // is what used to make the next load prefer it.
    const aCopy = staleEdit ? edit(a.workspace, "A's unsaved edit") : a.workspace;
    assert.deepEqual(tabA.saveWorkspaceFallback(aCopy), { ok: true, target: "localstorage" });
    assert.ok(Date.parse(b.snapshotMeta().savedAt) > Date.parse(b.storedMeta().savedAt));
    assert.equal(b.snapshotMeta().baseRevision, 1);

    const fresh = await loaded(b.tab());
    assert.equal(fresh.source, "indexeddb");
    assert.equal(textOf(fresh.workspace), "B's edit");

    const save = await tabA.saveWorkspace(aCopy);
    assert.equal(save.ok, false);
    assert.equal(save.conflict, true);
    assert.equal(aConflicts.calls, 1);
    assert.equal(textOf(b.stored()), "B's edit");
    assert.equal(b.storedMeta().revision, 2);
    await b.done();
  });
}

test("a tab's unload snapshot of an unsaved edit is restored, then saved and cleared", async (t) => {
  const b = browser(t);
  const first = b.tab();
  assert.deepEqual(await first.loadWorkspace(), { status: "empty" });
  const initial = workspace("first save");
  assert.deepEqual(await first.saveWorkspace(initial), { ok: true, target: "indexeddb" });
  assert.equal(b.storedMeta().revision, 1);

  // The page closes before autosave writes the edit.
  first.saveWorkspaceFallback(edit(initial, "unsaved edit"));
  assert.equal(b.snapshotMeta().baseRevision, 1);
  b.ls.setItem("local-outline-workspace", JSON.stringify(workspace("legacy snapshot")));
  b.ls.setItem("local-outline-workspace-meta", JSON.stringify({ savedAt: OLD }));

  const next = b.tab();
  const restored = await loaded(next);
  assert.equal(restored.source, "localstorage");
  assert.equal(textOf(restored.workspace), "unsaved edit");
  assert.equal(next.isWorkspacePersisted(restored.workspace), false);

  assert.deepEqual(await next.saveWorkspace(restored.workspace), { ok: true, target: "indexeddb" });
  assert.equal(textOf(b.stored()), "unsaved edit");
  assert.equal(b.storedMeta().revision, 2);
  assert.equal(next.isWorkspacePersisted(restored.workspace), true);
  assert.equal(b.snapshots().length, 0);
  for (const key of [SNAPSHOT, SNAPSHOT_META]) {
    assert.equal(b.ls.getItem(key), null, key);
  }
  // Saving the recovered copy must not delete an unrelated legacy backup.
  assert.notEqual(b.ls.getItem("local-outline-workspace"), null);
  const again = await loaded(b.tab());
  assert.equal(again.source, "indexeddb");
  assert.equal(textOf(again.workspace), "unsaved edit");
  await b.done();
});

test("a snapshot written while the page's own save was in flight still wins", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("original"), { savedAt: OLD, revision: 1, writer: "earlier-page" });
  const tab = b.tab();
  const { workspace: initial } = await loaded(tab);

  // The save has done its reads and writes but not committed when the page
  // unloads with a newer edit; the browser finishes the commit afterwards.
  const gate = b.idb.holdCommits();
  const saving = edit(initial, "being saved");
  tab.saveWorkspace(saving);
  const tx = await gate.reached();
  tab.saveWorkspaceFallback(edit(saving, "edited after the save started"));
  b.idb.orphan(tx);
  gate.release();
  await b.settle();
  assert.equal(b.storedMeta().revision, 2);
  assert.equal(b.storedMeta().writer, b.snapshotMeta().writer);
  assert.equal(b.snapshotMeta().baseRevision, 1);

  const next = await loaded(b.tab());
  assert.equal(next.source, "localstorage");
  assert.equal(textOf(next.workspace), "edited after the save started");
  await b.done({ openConnections: 1 });
});

test("a snapshot based on an older revision only wins over revisions its own page wrote", async (t) => {
  for (const [writer, expected] of [["page-a", "snapshot"], ["page-b", "database"], [null, "database"]]) {
    const b = browser(t);
    b.seedDb(workspace("database"), { savedAt: OLD, revision: 4, ...(writer ? { writer } : {}) });
    b.seedSnapshot(workspace("snapshot"), { savedAt: new Date().toISOString(), baseRevision: 3, writer: "page-a" });
    const result = await loaded(b.tab());
    assert.equal(textOf(result.workspace), expected, `stored revision written by ${writer}`);
    assert.equal(result.source, expected === "snapshot" ? "localstorage" : "indexeddb");
    await b.done();
  }
});

test("an old-format snapshot needs both a newer timestamp and edits at least as new", async (t) => {
  const t1 = "2026-01-01T00:00:00.000Z";
  const t2 = "2026-02-01T00:00:00.000Z";
  const t3 = "2026-03-01T00:00:00.000Z";
  const cases = [
    // A stale page that closed last: newer snapshot timestamp, older edits.
    { snapshot: workspace("stale snapshot", t1), meta: { savedAt: t3 }, expected: "database" },
    { snapshot: workspace("newer snapshot", t3), meta: { savedAt: t3 }, expected: "newer snapshot" },
    { snapshot: workspace("same-age edits", t2), meta: { savedAt: t3 }, expected: "same-age edits" },
    { snapshot: workspace("older timestamp", t3), meta: { savedAt: t1 }, expected: "database" },
    { snapshot: workspace("no metadata", t3), meta: undefined, expected: "database" },
  ];
  for (const { snapshot, meta, expected } of cases) {
    const b = browser(t);
    // Written by an older version: no revision or writer.
    b.seedDb(workspace("database", t2), { savedAt: t2 });
    b.seedSnapshot(snapshot, meta);
    const result = await loaded(b.tab());
    assert.equal(textOf(result.workspace), expected, textOf(snapshot));
    await b.done();
  }
});

for (const failure of ["open", "get"]) {
  test(`an unreadable current database (${failure} fails) is an error, not an older copy`, async (t) => {
    const b = browser(t);
    b.seedDb(workspace("current data"), { savedAt: OLD, revision: 3, writer: "page" });
    b.seedDb(workspace("legacy data"), undefined, LEGACY_DB);
    b.seedSnapshot(workspace("snapshot data", new Date().toISOString()), { savedAt: new Date().toISOString() });
    if (failure === "open") b.idb.failOpen(DB);
    else b.idb.failGet(DB);

    const tab = b.tab();
    const result = await tab.loadWorkspace();
    assert.equal(result.status, "error");
    assert.equal(result.source, "indexeddb");
    assert.match(result.error.message, /Injected/);
    assert.equal(b.idb.log.opens.includes(LEGACY_DB), false);
    assert.equal(await tab.reloadWorkspaceIf(() => true), null);
    b.idb.resetFailures();
    assert.deepEqual(b.dbCommits(), []);
    assert.equal(textOf(b.stored()), "current data");
    assert.notEqual(b.ls.getItem(SNAPSHOT), null);
    await b.done();
  });
}

test("without IndexedDB the snapshot is loaded", async (t) => {
  const b = browser(t, { indexedDB: false });
  b.seedSnapshot(workspace("snapshot only"), { savedAt: OLD, baseRevision: 2, writer: "page" });
  const tab = b.tab();
  const result = await loaded(tab);
  assert.equal(result.source, "localstorage");
  assert.equal(textOf(result.workspace), "snapshot only");
  // Saving keeps working through the snapshot.
  const save = await tab.saveWorkspace(edit(result.workspace, "edited offline"));
  assert.deepEqual(save, { ok: true, target: "localstorage" });
  assert.equal(textOf(b.snapshotWorkspace()), "edited offline");

  const empty = browser(t, { indexedDB: false });
  const none = await empty.tab().loadWorkspace();
  assert.equal(none.status, "error");
  await b.done();
});

test("an empty current database migrates the legacy database on the first save", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("legacy data"), { savedAt: OLD }, LEGACY_DB);
  const tab = b.tab();
  const result = await loaded(tab);
  assert.equal(result.source, "indexeddb");
  assert.equal(textOf(result.workspace), "legacy data");
  assert.equal(b.stored(), undefined);
  // The legacy copy is not the current database's persisted copy yet.
  assert.equal(tab.isWorkspacePersisted(result.workspace), false);

  assert.deepEqual(await tab.saveWorkspace(result.workspace), { ok: true, target: "indexeddb" });
  assert.equal(textOf(b.stored()), "legacy data");
  assert.equal(b.storedMeta().revision, 1);
  assert.equal(b.idb.read(LEGACY_DB, "workspace-meta").revision, undefined);
  const next = await loaded(b.tab());
  assert.equal(next.source, "indexeddb");
  assert.equal(textOf(next.workspace), "legacy data");
  await b.done();
});

test("saving the persisted copy is a no-op and overwrite replaces a newer revision", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("original"), { savedAt: OLD, revision: 1, writer: "earlier-page" });
  const tabA = b.tab();
  const tabB = b.tab();
  const bChanges = counter();
  tabB.subscribeToWorkspaceChanges(bChanges);
  const a = await loaded(tabA);
  const fromB = await loaded(tabB);
  assert.equal(tabA.isWorkspacePersisted(a.workspace), true);

  assert.deepEqual(await tabA.saveWorkspace(a.workspace), { ok: true, target: "indexeddb" });
  await b.settle();
  assert.deepEqual(b.dbCommits(), []);
  assert.equal(b.storedMeta().revision, 1);
  assert.deepEqual(b.channels.messages, []);
  assert.equal(bChanges.calls, 0);

  assert.deepEqual(await tabB.saveWorkspace(edit(fromB.workspace, "B's edit")), { ok: true, target: "indexeddb" });
  const conflicts = counter();
  tabA.subscribeToWorkspaceConflicts(conflicts);
  const mine = edit(a.workspace, "A's edit");
  assert.equal((await tabA.saveWorkspace(mine)).conflict, true);
  assert.deepEqual(await tabA.saveWorkspace(mine, { overwrite: true }), { ok: true, target: "indexeddb" });
  assert.equal(conflicts.calls, 1);
  assert.equal(textOf(b.stored()), "A's edit");
  assert.equal(b.storedMeta().revision, 3);
  // A now holds revision 3, so its next edit saves normally.
  assert.deepEqual(await tabA.saveWorkspace(edit(mine, "A again")), { ok: true, target: "indexeddb" });
  assert.equal(b.storedMeta().revision, 4);
  await b.done();
});

test("saves are broadcast to other pages, which reload only when allowed", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("original"), { savedAt: OLD, revision: 1, writer: "earlier-page" });
  const tabA = b.tab();
  const tabB = b.tab();
  const aChanges = counter();
  const bChanges = counter();
  const aConflicts = counter();
  tabA.subscribeToWorkspaceChanges(aChanges);
  const unsubscribeB = tabB.subscribeToWorkspaceChanges(bChanges);
  tabA.subscribeToWorkspaceConflicts(aConflicts);
  const a = await loaded(tabA);
  const fromB = await loaded(tabB);

  const bEdit = edit(fromB.workspace, "B's edit");
  await tabB.saveWorkspace(bEdit);
  await b.settle();
  assert.equal(aChanges.calls, 1);
  assert.equal(bChanges.calls, 0, "a page is not notified of its own saves");
  assert.deepEqual(b.channels.messages.map((message) => message.data.revision), [2]);

  // A has unsaved edits by the time the read finishes: keep them.
  const aEdit = edit(a.workspace, "A's edit");
  assert.equal(await tabA.reloadWorkspaceIf(() => false), null);
  assert.equal(tabA.isWorkspacePersisted(a.workspace), true);
  assert.equal((await tabA.saveWorkspace(aEdit)).conflict, true);
  assert.equal(aConflicts.calls, 1);
  assert.equal(textOf(b.stored()), "B's edit");

  const reloaded = await tabA.reloadWorkspaceIf(() => true);
  assert.equal(textOf(reloaded), "B's edit");
  assert.equal(tabA.isWorkspacePersisted(reloaded), true);
  assert.deepEqual(await tabA.saveWorkspace(edit(reloaded, "A after reload")), { ok: true, target: "indexeddb" });
  assert.equal(b.storedMeta().revision, 3);
  await b.settle();
  assert.equal(bChanges.calls, 1);
  assert.equal(aChanges.calls, 1);

  // Messages about revisions a page already has are ignored.
  const stray = new BroadcastChannel("bike-workspace");
  stray.postMessage({ type: "workspace-saved", revision: 3, pageId: "elsewhere" });
  stray.postMessage({ type: "something-else", revision: 9, pageId: "elsewhere" });
  await b.settle();
  assert.equal(aChanges.calls, 1);
  assert.equal(bChanges.calls, 2, "B only has revision 2");
  unsubscribeB();
  stray.postMessage({ type: "workspace-saved", revision: 4, pageId: "elsewhere" });
  await b.settle();
  assert.equal(aChanges.calls, 2);
  assert.equal(bChanges.calls, 2, "unsubscribed");
  await b.done();
});

test("a save requested before a reload adopts newer data is not written", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("original"), { savedAt: OLD, revision: 1, writer: "earlier-page" });
  const tabA = b.tab();
  const tabB = b.tab();
  const aConflicts = counter();
  tabA.subscribeToWorkspaceConflicts(aConflicts);
  const a = await loaded(tabA);
  const fromB = await loaded(tabB);
  await tabB.saveWorkspace(edit(fromB.workspace, "B's edit"));

  // A starts catching up on B's save. Once its read transaction is queued
  // (held), A saves the copy it still shows, e.g. via Cmd+S. That save is
  // queued behind nothing, so it starts before the reload adopts B's copy.
  b.idb.hold();
  const reload = tabA.reloadWorkspaceIf(() => true);
  const [readTx] = await b.idb.whenQueued(1);
  assert.equal(readTx.mode, "readonly");
  const save = tabA.saveWorkspace(a.workspace);
  const [, writeTx] = await b.idb.whenQueued(2);
  assert.equal(writeTx.mode, "readwrite");
  b.idb.release();

  const reloaded = await reload;
  assert.equal(textOf(reloaded), "B's edit");
  const result = await save;
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.equal(textOf(b.stored()), "B's edit");
  assert.equal(b.storedMeta().revision, 2);
  assert.equal(aConflicts.calls, 0, "superseded, not a conflict with another page");
  // A carries on from B's copy.
  assert.equal(tabA.isWorkspacePersisted(reloaded), true);
  assert.deepEqual(await tabA.saveWorkspace(edit(reloaded, "A's edit")), { ok: true, target: "indexeddb" });
  assert.equal(b.storedMeta().revision, 3);
  await b.done();
});

for (const failure of ["put", "commit", "open"]) {
  test(`an IndexedDB write failure (${failure}) falls back to the snapshot`, async (t) => {
    const b = browser(t);
    b.seedDb(workspace("original"), { savedAt: OLD, revision: 2, writer: "earlier-page" });
    const tab = b.tab();
    const { workspace: initial } = await loaded(tab);
    if (failure === "put") b.idb.failPut({ db: DB, key: "workspace" });
    if (failure === "commit") b.idb.failCommit({ db: DB });
    if (failure === "open") b.idb.failOpen(DB);

    const changed = edit(initial, "kept in the snapshot");
    assert.deepEqual(await tab.saveWorkspace(changed), { ok: true, target: "localstorage" });
    assert.equal(textOf(b.snapshotWorkspace()), "kept in the snapshot");
    assert.equal(b.snapshotMeta().baseRevision, 2);
    assert.equal(textOf(b.stored()), "original");
    assert.equal(b.storedMeta().revision, 2);
    assert.deepEqual(b.channels.messages, []);
    assert.equal(tab.isWorkspacePersisted(changed), false);

    b.idb.resetFailures();
    const next = b.tab();
    const restored = await loaded(next);
    assert.equal(textOf(restored.workspace), "kept in the snapshot");
    // Once IndexedDB works again the snapshot is written back and cleared.
    assert.deepEqual(await tab.saveWorkspace(changed), { ok: true, target: "indexeddb" });
    assert.equal(textOf(b.stored()), "kept in the snapshot");
    assert.equal(b.snapshots().length, 0);
    await b.done();
  });
}

test("a snapshot write is atomic and quota failures retain previous and other-page copies", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("original"), { savedAt: OLD, revision: 1, writer: "earlier-page" });
  const tab = b.tab();
  const { workspace: initial } = await loaded(tab);
  // An older snapshot pair from another page must remain untouched.
  const olderMeta = { savedAt: OLD, baseRevision: 1, writer: "other-page" };
  b.seedSnapshot(workspace("other page's snapshot"), olderMeta);
  tab.saveWorkspaceFallback(edit(initial, "last successful snapshot"));
  const retained = b.snapshots()[0];
  b.localStorage.failSetItem(undefined);

  const direct = tab.saveWorkspaceFallback(edit(initial, "unpaired"));
  assert.equal(direct.ok, false);
  assert.equal(direct.error.name, "QuotaExceededError");
  assert.deepEqual(b.snapshots(), [retained]);
  assert.equal(textOf(JSON.parse(b.ls.getItem(SNAPSHOT))), "other page's snapshot");
  assert.deepEqual(JSON.parse(b.ls.getItem(SNAPSHOT_META)), olderMeta);

  // The failed database write must also report failure and retain both copies.
  b.idb.failCommit({ db: DB });
  const saved = await tab.saveWorkspace(edit(initial, "unpaired again"));
  assert.equal(saved.ok, false);
  assert.equal(saved.conflict, undefined);
  assert.match(saved.error.message, /Injected quota failure/);
  assert.deepEqual(b.snapshots(), [retained]);
  assert.equal(textOf(b.stored()), "original");

  // Once storage works, a new envelope replaces only this page's older copy.
  b.localStorage.resetFailures();
  assert.equal(tab.saveWorkspaceFallback(edit(initial, "new atomic snapshot")).ok, true);
  assert.equal(b.snapshots().length, 1);
  assert.notEqual(b.snapshots()[0].id, retained.id);
  assert.equal(textOf(b.snapshotWorkspace()), "new atomic snapshot");
  assert.equal(textOf(JSON.parse(b.ls.getItem(SNAPSHOT))), "other page's snapshot");
  assert.deepEqual(JSON.parse(b.ls.getItem(SNAPSHOT_META)), olderMeta);
  await b.done();
});

test("another page's successful save retains fallback edits and exposes them after reopening", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("original"), { savedAt: OLD, revision: 1, writer: "earlier-page" });
  const tabA = b.tab();
  const tabB = b.tab();
  const a = (await loaded(tabA)).workspace;
  const fromB = (await loaded(tabB)).workspace;
  b.idb.failPut({ db: DB, key: "workspace", times: 1 });
  assert.deepEqual(await tabA.saveWorkspace(edit(a, "A's fallback edit")), { ok: true, target: "localstorage" });
  const snapshotId = b.snapshots()[0].id;
  b.idb.resetFailures();
  assert.deepEqual(await tabB.saveWorkspace(edit(fromB, "B's saved edit")), { ok: true, target: "indexeddb" });
  assert.equal(b.snapshots()[0].id, snapshotId);
  assert.equal(textOf(b.snapshotWorkspace()), "A's fallback edit");

  const reopened = b.tab();
  const latest = await loaded(reopened);
  assert.equal(textOf(latest.workspace), "B's saved edit");
  const copies = reopened.listWorkspaceRecoverySnapshots(latest.workspace);
  assert.equal(copies.length, 1);
  assert.equal(textOf(copies[0].workspace), "A's fallback edit");
  assert.equal((await tabA.saveWorkspace(edit(a, "A's retry"))).conflict, true);
  await b.done();
});

test("two pages keep separate fallback envelopes and distinct edits require a recovery choice", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("original"), { savedAt: OLD, revision: 1 });
  const a = b.tab();
  const fromA = (await loaded(a)).workspace;
  const tabB = b.tab();
  const fromB = (await loaded(tabB)).workspace;
  a.saveWorkspaceFallback(edit(fromA, "A's snapshot"));
  tabB.saveWorkspaceFallback(edit(fromB, "B's snapshot"));
  assert.equal(b.snapshots().length, 2);
  assert.equal(new Set(b.snapshots().map((snapshot) => snapshot.writer)).size, 2);
  const reopened = b.tab();
  const current = await loaded(reopened);
  assert.equal(current.source, "indexeddb");
  assert.equal(textOf(current.workspace), "original");
  assert.deepEqual(reopened.listWorkspaceRecoverySnapshots().map((item) => textOf(item.workspace)).sort(), ["A's snapshot", "B's snapshot"]);
  await b.done();
});

test("a completed older save cannot delete the newer snapshot written while it was pending", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("original"), { savedAt: OLD, revision: 1 });
  const tab = b.tab();
  const base = (await loaded(tab)).workspace;
  const gate = b.idb.holdCommits();
  const saving = tab.saveWorkspace(edit(base, "older edit being saved"));
  await gate.reached();
  tab.saveWorkspaceFallback(edit(base, "newer unsaved edit"));
  const snapshotId = b.snapshots()[0].id;
  gate.release();
  assert.equal((await saving).ok, true);
  assert.equal(b.snapshots()[0].id, snapshotId);
  assert.equal(textOf(b.stored()), "older edit being saved");
  const recovered = await loaded(b.tab());
  assert.equal(textOf(recovered.workspace), "newer unsaved edit");
  await b.done();
});

test("a failed older save cannot replace a newer unload snapshot with stale edits", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("original"), { savedAt: OLD, revision: 1 });
  const tab = b.tab();
  const base = (await loaded(tab)).workspace;
  b.idb.hold();
  const saving = tab.saveWorkspace(edit(base, "older failed edit"));
  await b.idb.whenQueued(1);
  tab.saveWorkspaceFallback(edit(base, "newer unload edit"));
  b.idb.failCommit({ db: DB });
  b.idb.release();
  const cancelled = await saving;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.conflict, true);
  assert.equal(textOf(b.snapshotWorkspace()), "newer unload edit");
  b.idb.resetFailures();
  assert.equal(textOf((await loaded(b.tab())).workspace), "newer unload edit");
  await b.done();
});

test("a different same-page save retains previous snapshots for manual recovery without rolling back newer data", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("original"), { savedAt: OLD, revision: 1 });
  const tabA = b.tab();
  const a = (await loaded(tabA)).workspace;
  const tabB = b.tab();
  const fromB = (await loaded(tabB)).workspace;
  tabA.saveWorkspaceFallback(edit(a, "A's earlier fallback"));
  tabB.saveWorkspaceFallback(edit(fromB, "B's fallback"));
  await tabA.saveWorkspace(edit(a, "A's newer saved edit"));
  assert.equal(b.snapshots().length, 2);
  const reopened = await loaded(b.tab());
  assert.equal(textOf(reopened.workspace), "A's newer saved edit");
  assert.equal(reopened.source, "indexeddb");
  await b.done();
});

test("saving an adopted snapshot cannot remove a new snapshot its original page wrote meanwhile", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("original"), { savedAt: OLD, revision: 1 });
  const tabA = b.tab();
  const a = (await loaded(tabA)).workspace;
  tabA.saveWorkspaceFallback(edit(a, "first snapshot"));
  const recovering = b.tab();
  const adopted = await loaded(recovering);
  tabA.saveWorkspaceFallback(edit(a, "new snapshot while recovering"));
  await recovering.saveWorkspace(adopted.workspace);
  assert.equal(b.snapshots().length, 1);
  assert.equal(textOf(b.snapshotWorkspace()), "new snapshot while recovering");
  assert.equal(textOf(b.stored()), "first snapshot");
  await b.done();
});

test("recovery deletion affects only the selected immutable snapshot and never a changed legacy copy", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("original"), { savedAt: OLD, revision: 1 });
  const a = b.tab();
  const base = (await loaded(a)).workspace;
  a.saveWorkspaceFallback(edit(base, "A's snapshot"));
  const fromB = b.tab();
  await loaded(fromB);
  fromB.saveWorkspaceFallback(edit(base, "B's snapshot"));
  const selected = a.listWorkspaceRecoverySnapshots().find((item) => textOf(item.workspace) === "A's snapshot");
  assert.equal(a.discardWorkspaceRecoverySnapshot(selected), true);
  assert.equal(b.snapshots().length, 1);
  assert.equal(textOf(b.snapshotWorkspace()), "B's snapshot");

  b.seedSnapshot(workspace("legacy snapshot"), { savedAt: OLD });
  const old = a.listWorkspaceRecoverySnapshots().find((item) => item.id === SNAPSHOT);
  b.seedSnapshot(workspace("changed legacy snapshot"), { savedAt: OLD });
  assert.equal(a.discardWorkspaceRecoverySnapshot(old), false);
  assert.equal(textOf(JSON.parse(b.ls.getItem(SNAPSHOT))), "changed legacy snapshot");
  await b.done();
});

test("explicit latest loads and cross-page reloads never adopt pending snapshots", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("saved version"), { savedAt: OLD, revision: 1 });
  const tab = b.tab();
  const base = (await loaded(tab)).workspace;
  tab.saveWorkspaceFallback(edit(base, "pending version"));
  const other = b.tab();
  const latest = await other.loadWorkspace({ includeFallback: false });
  assert.equal(textOf(latest.workspace), "saved version");
  assert.equal(textOf(await other.reloadWorkspaceIf(() => true)), "saved version");
  assert.equal(other.listWorkspaceRecoverySnapshots(latest.workspace).length, 1);
  assert.equal(b.snapshots().length, 1);
  await b.done();
});

test("recovery recognizes equivalent contents across migration defaults and object key order", async (t) => {
  const b = browser(t);
  const tab = b.tab();
  await tab.loadWorkspace();
  const minimal = { version: 1, activeDocumentId: "doc", documents: [{
    id: "doc", title: "minimal", createdAt: OLD, updatedAt: OLD,
    nodes: [{ id: "node", text: "text", note: "", checked: false, collapsed: false, color: "plain", children: [] }],
  }] };
  tab.saveWorkspaceFallback(minimal);
  const normalized = migrateWorkspace(minimal);
  normalized.documents[0].nodes[0] = Object.fromEntries(Object.entries(normalized.documents[0].nodes[0]).reverse());
  assert.deepEqual(tab.listWorkspaceRecoverySnapshots(normalized), []);
  await tab.saveWorkspace(normalized);
  assert.equal(b.snapshots().length, 0);
  await b.done();
});

test("a save requested after a newer snapshot cannot delete or automatically replace that snapshot", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("base"), { savedAt: OLD, revision: 1 });
  const tab = b.tab();
  const base = (await loaded(tab)).workspace;
  tab.saveWorkspaceFallback(edit(base, "newer snapshot"));
  await tab.saveWorkspace(edit(base, "older delayed save"));
  const reopened = b.tab();
  const current = await loaded(reopened);
  assert.equal(textOf(current.workspace), "older delayed save");
  assert.equal(current.source, "indexeddb");
  assert.equal(reopened.listWorkspaceRecoverySnapshots(current.workspace)[0].workspace.documents[0].nodes[0].text, "newer snapshot");
  await b.done();
});

test("successive queued database failures keep the newest requested edits in fallback storage", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("base"), { savedAt: OLD, revision: 1 });
  const tab = b.tab();
  const base = (await loaded(tab)).workspace;
  b.idb.hold();
  const earlier = tab.saveWorkspace(edit(base, "earlier requested edit"));
  const later = tab.saveWorkspace(edit(base, "newest requested edit"));
  await b.idb.whenQueued(1);
  b.idb.failCommit({ db: DB });
  b.idb.release();
  assert.deepEqual(await earlier, { ok: true, target: "localstorage" });
  assert.deepEqual(await later, { ok: true, target: "localstorage" });
  assert.equal(textOf(b.snapshotWorkspace()), "newest requested edit");
  b.idb.resetFailures();
  assert.equal(textOf((await loaded(b.tab())).workspace), "newest requested edit");
  await b.done();
});
