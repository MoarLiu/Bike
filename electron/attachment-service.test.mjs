import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAttachmentService } from "./attachment-service.cjs";

test("attachments deduplicate concurrent imports and verify bytes after restart", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bike-assets-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "library");
  const service = createAttachmentService({ directory });
  const bytes = Buffer.from("same bytes 中文");
  const imported = await Promise.all([service.putBytes(bytes, "一.txt"), service.putBytes(bytes, "二.txt")]);
  assert.equal(imported[0].assetId, imported[1].assetId);
  assert.notEqual(imported[0].name, imported[1].name);
  assert.deepEqual(await createAttachmentService({ directory }).read(imported[0].assetId), bytes);
  const digest = imported[0].assetId.slice(7);
  assert.deepEqual((await fs.readdir(path.join(directory, digest.slice(0, 2)))).sort(), [digest]);
  await fs.writeFile(path.join(directory, digest.slice(0, 2), digest), "corrupted");
  await assert.rejects(service.read(imported[0].assetId), /完整性/);
  await assert.rejects(service.putBytes(bytes), /完整性/);
});

test("attachment reads reject escaping ids and symlinked objects or directories", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bike-assets-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createAttachmentService({ directory: path.join(root, "library") });
  await assert.rejects(service.read("../../outside"), /标识/);
  const asset = await service.putBytes(Buffer.from("hello"));
  const digest = asset.assetId.slice(7);
  const object = path.join(root, "library", digest.slice(0, 2), digest);
  const outside = path.join(root, "outside");
  await fs.writeFile(outside, "hello");
  await fs.rm(object);
  await fs.symlink(outside, object);
  await assert.rejects(service.read(asset.assetId));
  const linked = path.join(root, "linked");
  await fs.symlink(path.join(root, "library"), linked);
  await assert.rejects(createAttachmentService({ directory: linked }).initialize(), /符号链接/);
});

test("attachment backup copies only live and trash roots and verifies metadata", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bike-assets-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createAttachmentService({ directory: path.join(root, "library") });
  const asset = await service.putBytes(Buffer.from("a file"), "file.txt");
  await service.putBytes(Buffer.from("orphan"));
  const item = { nodes: [{ children: [], attachmentRefs: [{ assetId: asset.assetId, name: asset.name }] }], attachments: { version: 1, items: { [asset.assetId]: asset.metadata } } };
  const destination = path.join(root, "backup");
  const manifest = await service.copyWorkspaceAssets({ documents: [], trash: [{ document: item }] }, destination);
  assert.equal(manifest.length, 1);
  assert.deepEqual(await createAttachmentService({ directory: destination }).read(asset.assetId, asset.metadata), Buffer.from("a file"));
  await assert.rejects(service.read(asset.assetId, { ...asset.metadata, byteLength: 99 }), /元数据/);
  assert.ok(await service.transferSource(asset.assetId, asset.metadata));
  await assert.rejects(service.transferSource(asset.assetId, { ...asset.metadata, mediaType: "application/pdf" }), /格式与清单/);
});

test("cleanup protects session imports, rechecks new roots, and restores quarantine on read", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bike-gc-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "library");
  const imported = createAttachmentService({ directory });
  const asset = await imported.putBytes(Buffer.from("recoverable"));
  assert.equal((await imported.scan([])).candidates.length, 0);
  const reopened = createAttachmentService({ directory });
  assert.equal((await reopened.scan([])).candidates.length, 1);
  assert.equal((await reopened.quarantine([asset.assetId], [asset.assetId])).moved, 0);
  assert.equal((await reopened.quarantine([], [asset.assetId])).moved, 1);
  const later = createAttachmentService({ directory });
  assert.deepEqual(await later.read(asset.assetId), Buffer.from("recoverable"));
  assert.equal((await later.purge([], Date.now() + 31 * 86400000)).removed, 0);
  const unpinned = createAttachmentService({ directory });
  assert.equal((await unpinned.quarantine([], [asset.assetId])).moved, 1);
  assert.equal((await unpinned.purge([asset.assetId], Date.now() + 31 * 86400000)).removed, 0);
  assert.equal((await unpinned.purge([], Date.now() + 31 * 86400000)).removed, 1);
  await assert.rejects(unpinned.read(asset.assetId), { code: "ENOENT" });
});
