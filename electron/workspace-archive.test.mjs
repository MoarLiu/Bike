import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import yazl from "yazl";
import { createAttachmentService } from "./attachment-service.cjs";
import { exportWorkspaceArchive, importWorkspaceArchive } from "./workspace-archive.cjs";
import { migrateWorkspace } from "../mcp/bike-core.mjs";
import { sealLocalMigration, localMigrationDigest } from "../shared/bike-local-migration.mjs";

const fixture = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bike-zip-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const attachments = createAttachmentService({ directory: path.join(root, "original") });
  const bytes = Buffer.from("portable attachment 中文");
  const asset = await attachments.putBytes(bytes, "示例.txt");
  const doc = {
    id: "doc", title: "归档", createdAt: "2026-11-09T00:00:00Z", updatedAt: "2026-11-09T00:00:00Z",
    nodes: [{ id: "node", text: "主题", children: [], attachmentRefs: [{ assetId: asset.assetId, name: asset.name }] }],
    attachments: { version: 1, items: { [asset.assetId]: asset.metadata } },
  };
  return { root, attachments, bytes, asset, workspace: { version: 2, activeDocumentId: "doc", documents: [doc], trash: [{ id: "deleted", document: { ...doc, id: "trashed" }, deletedAt: "2026-11-09T00:00:00Z", originalIndex: 0 }] } };
};

test("workspace archive restores identities, trash and original bytes in an empty library", async (t) => {
  const item = await fixture(t);
  const filename = path.join(item.root, "工作区.zip");
  const result = await exportWorkspaceArchive({ workspace: item.workspace, filename, attachments: item.attachments, migrate: migrateWorkspace });
  assert.equal(result.attachmentCount, 1);
  const target = createAttachmentService({ directory: path.join(item.root, "restored") });
  const restored = await importWorkspaceArchive({ filename, attachments: target, migrate: migrateWorkspace });
  assert.deepEqual(restored.workspace, migrateWorkspace(item.workspace));
  assert.deepEqual(await target.read(item.asset.assetId), item.bytes);
});

test("incomplete export preserves an existing destination and removes partial output", async (t) => {
  const item = await fixture(t);
  const filename = path.join(item.root, "keep.zip");
  await fs.writeFile(filename, "keep original");
  const empty = createAttachmentService({ directory: path.join(item.root, "empty") });
  await assert.rejects(exportWorkspaceArchive({ workspace: item.workspace, filename, attachments: empty, migrate: migrateWorkspace }));
  assert.equal(await fs.readFile(filename, "utf8"), "keep original");
  assert.deepEqual((await fs.readdir(item.root)).filter((name) => name.endsWith(".tmp")), []);
});

test("a validated archive repairs corrupted objects and preserves the damaged bytes", async (t) => {
  const item = await fixture(t);
  const filename = path.join(item.root, "repair.zip");
  await exportWorkspaceArchive({ workspace: item.workspace, filename, attachments: item.attachments, migrate: migrateWorkspace });
  const digest = item.asset.assetId.slice(7);
  const library = path.join(item.root, "original");
  const damaged = Buffer.from("damaged object");
  await fs.writeFile(path.join(library, digest.slice(0, 2), digest), damaged);
  await assert.rejects(item.attachments.read(item.asset.assetId), { code: "ATTACHMENT_INTEGRITY" });
  const restored = await importWorkspaceArchive({ filename, attachments: item.attachments, migrate: migrateWorkspace });
  assert.equal(restored.attachmentCount, 1);
  assert.deepEqual(await item.attachments.read(item.asset.assetId), item.bytes);
  const retained = (await fs.readdir(library)).filter((name) => name.startsWith(".corrupt-"));
  assert.equal(retained.length, 1);
  assert.deepEqual(await fs.readFile(path.join(library, retained[0])), damaged);
});

test("archive rejects duplicate entries and symlinks before installing any assets", async (t) => {
  const item = await fixture(t);
  for (const kind of ["duplicate", "symlink"]) {
    const filename = path.join(item.root, `${kind}.zip`);
    const zip = new yazl.ZipFile();
    const writing = pipeline(zip.outputStream, createWriteStream(filename));
    zip.addBuffer(Buffer.from("{}"), "manifest.json");
    if (kind === "duplicate") zip.addBuffer(Buffer.from("{}"), "manifest.json");
    else zip.addBuffer(Buffer.from("outside"), "workspace.json", { mode: 0o120777 });
    zip.end();
    await writing;
    const targetDirectory = path.join(item.root, `target-${kind}`);
    await assert.rejects(importWorkspaceArchive({ filename, attachments: createAttachmentService({ directory: targetDirectory }), migrate: migrateWorkspace }), /重复|特殊文件/);
    await assert.rejects(fs.access(targetDirectory), { code: "ENOENT" });
  }
});

test("portable document archives include readable content and retain the recovery contract", async (t) => {
  const item = await fixture(t);
  const filename = path.join(item.root, "portable.zip");
  await exportWorkspaceArchive({ workspace: item.workspace, filename, attachments: item.attachments, migrate: migrateWorkspace, readable: { name: "document.md", content: "# Portable\n" } });
  const target = createAttachmentService({ directory: path.join(item.root, "portable-restored") });
  const restored = await importWorkspaceArchive({ filename, attachments: target, migrate: migrateWorkspace });
  assert.equal(restored.workspace.documents[0].id, "doc");
  assert.deepEqual(await target.read(item.asset.assetId), item.bytes);
});

test("full local archives retain assets referenced only by version history", async (t) => {
  const item = await fixture(t);
  const body = migrateWorkspace(item.workspace);
  const bytes = Buffer.from("history-only original bytes");
  const historical = await item.attachments.putBytes(bytes, "history.txt");
  const document = migrateWorkspace({ version: 2, documents: [{
    id: "history-doc", title: "History", createdAt: "2026-11-11T00:00:00.000Z", updatedAt: "2026-11-11T00:00:00.000Z",
    nodes: [{ id: "old-node", text: "Old", children: [], attachmentRefs: [{ assetId: historical.assetId, name: "history.txt" }] }],
    attachments: { version: 1, items: { [historical.assetId]: historical.metadata } },
  }] }).documents[0];
  const workspace = sealLocalMigration(body, {
    format: "bike-local-copy", version: 1, id: "local-copy-fixture", createdAt: "2026-11-11T00:00:00.000Z",
    source: { actorId: null, revision: 1, workspaceSha256: localMigrationDigest(body) },
    history: [{ documentId: document.id, snapshots: [{ id: "old-snapshot", documentId: document.id, document }] }],
    recovery: [], recoveryFiles: [], preAttachment: null, preOperation: null, archives: [],
    sourceAudit: { audit: [], outbox: [], receipts: {}, conflicts: [] },
    assets: [item.asset, historical].map(({ assetId, metadata }) => ({ assetId, metadata })),
  });
  const filename = path.join(item.root, "local-copy.zip");
  assert.equal((await exportWorkspaceArchive({ workspace, filename, attachments: item.attachments, migrate: migrateWorkspace })).attachmentCount, 2);
  const target = createAttachmentService({ directory: path.join(item.root, "local-restored") });
  const restored = await importWorkspaceArchive({ filename, attachments: target, migrate: migrateWorkspace });
  assert.equal(restored.attachmentCount, 2);
  assert.deepEqual(await target.read(historical.assetId), bytes);
  assert.equal(restored.workspace.localMigration.id, "local-copy-fixture");
  const invalid = structuredClone(workspace); invalid.localMigration.assets = [];
  const prior = await fs.readFile(filename);
  await assert.rejects(exportWorkspaceArchive({ workspace: invalid, filename, attachments: item.attachments, migrate: migrateWorkspace }), /校验|闭合/);
  assert.deepEqual(await fs.readFile(filename), prior);
});
