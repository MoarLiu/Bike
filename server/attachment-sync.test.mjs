import assert from "node:assert/strict";
import test from "node:test";
import { createSyncStore, SyncCapabilityError } from "./sync-store.mjs";

test("sync rejects old clients creating or overwriting attachment documents inside the transaction", async (t) => {
  const store = await createSyncStore(":memory:");
  t.after(() => store.close());
  const assetId = `sha256:${"a".repeat(64)}`;
  const document = {
    id: "doc", title: "Attached", nodes: [{ id: "node", text: "Text", children: [], attachmentRefs: [{ assetId, name: "a" }] }],
    attachments: { version: 1, items: { [assetId]: { mediaType: "application/octet-stream", byteLength: 1 } } },
  };
  assert.ok(store.getManifest().capabilities.includes("attachments-v1"));
  assert.throws(() => store.putDocument({ id: "doc", document, expectedRevision: null }), SyncCapabilityError);
  const created = store.putDocument({ id: "doc", document, expectedRevision: null, capabilities: ["attachments-v1"] });
  const stripped = { ...document, nodes: [{ id: "node", text: "old client", children: [] }] };
  delete stripped.attachments;
  assert.throws(() => store.putDocument({ id: "doc", document: stripped, expectedRevision: created.revision }), SyncCapabilityError);
  assert.deepEqual(store.getDocument("doc").document, document);
  assert.equal(store.getDocument("doc").revision, 1);
  assert.equal(store.putDocument({ id: "doc", document: { ...document, title: "new" }, expectedRevision: 1, capabilities: ["attachments-v1"] }).revision, 2);
});
