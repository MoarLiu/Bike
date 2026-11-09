import assert from "node:assert/strict";
import test from "node:test";
import { verifySavedBackupSource } from "./backup-source.cjs";

test("backup sources must match the current window's actual IndexedDB revision and content", async () => {
  const window = { webContents: { id: 7, isDestroyed: () => false, executeJavaScript: async () => ({ revision: 12, workspace: { id: "saved" } }) } };
  const base = { window, ownerId: 7, sourceRevision: 12, workspace: { id: "saved" }, migrate: async (value) => value, hash: (value) => value };
  assert.equal(await verifySavedBackupSource(base), true);
  assert.equal(await verifySavedBackupSource({ ...base, sourceRevision: Number.MAX_SAFE_INTEGER }), false);
  assert.equal(await verifySavedBackupSource({ ...base, ownerId: 8 }), false);
  assert.equal(await verifySavedBackupSource({ ...base, workspace: { id: "unsaved" } }), false);
});
