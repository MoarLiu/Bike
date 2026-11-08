import assert from "node:assert/strict";
import test from "node:test";
import { installFakeBrowserStorage } from "./helpers/fake-browser.mjs";
import { loadTypescript, loadTypescriptIsolated } from "./helpers/typescript.mjs";

const { migrateWorkspace } = loadTypescript("src/migrations.ts");

const DB = "bike-db";
const LEGACY_DB = "local-outline-db";
const SNAPSHOT = "bike-workspace";
const SNAPSHOT_META = "bike-workspace-meta";
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

// Each tab is an independent instance of src/storage.ts over shared fakes.
function browser(t, options) {
  const env = installFakeBrowserStorage(t, options);
  const ls = env.localStorage.storage;
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
    snapshotMeta: () => JSON.parse(ls.getItem(SNAPSHOT_META) ?? "null"),
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
  for (const key of [SNAPSHOT, SNAPSHOT_META, "local-outline-workspace", "local-outline-workspace-meta"]) {
    assert.equal(b.ls.getItem(key), null, key);
  }
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
  assert.equal(textOf(JSON.parse(b.ls.getItem(SNAPSHOT))), "edited offline");

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
    assert.equal(textOf(JSON.parse(b.ls.getItem(SNAPSHOT))), "kept in the snapshot");
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
    assert.equal(b.ls.getItem(SNAPSHOT), null);
    await b.done();
  });
}

test("a snapshot whose metadata cannot be written is removed, never mispaired", async (t) => {
  const b = browser(t);
  b.seedDb(workspace("original"), { savedAt: OLD, revision: 1, writer: "earlier-page" });
  const tab = b.tab();
  const { workspace: initial } = await loaded(tab);
  // An older snapshot pair from another page is already there.
  const olderMeta = { savedAt: OLD, baseRevision: 1, writer: "other-page" };
  b.seedSnapshot(workspace("other page's snapshot"), olderMeta);
  b.localStorage.failSetItem(SNAPSHOT_META);

  const direct = tab.saveWorkspaceFallback(edit(initial, "unpaired"));
  assert.equal(direct.ok, false);
  assert.equal(direct.error.name, "QuotaExceededError");
  assert.equal(b.ls.getItem(SNAPSHOT), null);
  assert.deepEqual(b.snapshotMeta(), olderMeta);

  // Same through a failed IndexedDB save: both copies failed, so it reports
  // an error and leaves no snapshot to be paired with the old metadata.
  b.idb.failCommit({ db: DB });
  const saved = await tab.saveWorkspace(edit(initial, "unpaired again"));
  assert.equal(saved.ok, false);
  assert.equal(saved.conflict, undefined);
  assert.match(saved.error.message, /Injected quota failure/);
  assert.equal(b.ls.getItem(SNAPSHOT), null);
  assert.equal(textOf(b.stored()), "original");

  // The workspace key itself failing leaves the older pair untouched.
  b.localStorage.resetFailures();
  b.seedSnapshot(workspace("other page's snapshot"), olderMeta);
  b.localStorage.failSetItem(SNAPSHOT);
  assert.equal(tab.saveWorkspaceFallback(edit(initial, "too big")).ok, false);
  assert.equal(textOf(JSON.parse(b.ls.getItem(SNAPSHOT))), "other page's snapshot");
  assert.deepEqual(b.snapshotMeta(), olderMeta);
  await b.done();
});
