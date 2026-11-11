// The once-only source reader runs in a private copy of an Electron profile.
// It imports no application entry point and starts no sync or backup services.
import { createLocalMigrationExport } from "./localMigration";
import { loadWorkspace } from "./storage";
import type { AttachmentMetadata } from "../shared/bike-attachments.mjs";

declare global {
  interface Window {
    bikeSourceExport: {
      options(): Promise<{ preferences: boolean; credentials: boolean }>;
      metadata(assetId: string): Promise<AttachmentMetadata>;
      complete(json: string): Promise<void>;
      fail(message: string): Promise<void>;
    };
  }
}

async function exportSource() {
  const loaded = await loadWorkspace({ includeFallback: false });
  if (loaded.status === "error") throw loaded.error;
  if (loaded.status !== "loaded") throw new Error("源 profile 中没有已提交工作区");
  const workspace = await createLocalMigrationExport(
    loaded.workspace,
    await window.bikeSourceExport.options(),
    (assetId) => window.bikeSourceExport.metadata(assetId),
  );
  const json = JSON.stringify(workspace);
  if (new TextEncoder().encode(json).byteLength > 64 * 1024 * 1024)
    throw new Error("完整本机副本超过 64 MiB");
  await window.bikeSourceExport.complete(json);
}

exportSource().catch((error) => window.bikeSourceExport.fail(
  error instanceof Error ? error.message : String(error),
));
