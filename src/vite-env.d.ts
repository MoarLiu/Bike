/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __RELEASE_PAGE_URL__: string;

interface BikeUpdateState {
  status: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "preparing" | "installing" | "error" | "unsupported";
  currentVersion: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  progress?: number;
  error?: string;
}

interface BikeDesktopBridge {
  openAttachment?: (assetId: string, name: string) => Promise<{ ok: boolean; error?: string }>;
  scanAttachments?: (protectedAssets: string[]) => Promise<{ ok: boolean; error?: string; ticket?: string; candidates?: Array<{ assetId: string; byteLength: number }>; byteLength?: number; protectedCount?: number }>;
  cleanAttachments?: (protectedAssets: string[], ticket: string) => Promise<{ ok: boolean; error?: string; moved?: number; removed?: number }>;
  importAttachments?: (payload: { requestId: string; choose?: boolean; files?: Array<{ name: string; bytes: ArrayBuffer }> }) => Promise<{
    ok: boolean; cancelled?: boolean; error?: string;
    assets?: Array<{ assetId: string; name: string; metadata: import("../shared/bike-attachments.mjs").AttachmentMetadata }>;
    failures?: Array<{ name: string; error: string }>;
  }>;
  cancelAttachmentImport?: (requestId: string) => Promise<unknown>;
  readAttachment?: (assetId: string, thumbnail?: boolean) => Promise<{ ok: boolean; error?: string; dataUrl?: string; previewable?: boolean; metadata?: import("../shared/bike-attachments.mjs").AttachmentMetadata }>;
  saveAttachment?: (assetId: string, name: string) => Promise<{ ok: boolean; error?: string; cancelled?: boolean; path?: string }>;
  exportWorkspaceArchive?: (workspace: unknown, readable?: { name: "document.md" | "index.html"; content: string }) => Promise<{ ok: boolean; error?: string; cancelled?: boolean; path?: string; attachmentCount?: number }>;
  importWorkspaceArchive?: () => Promise<{ ok: boolean; error?: string; cancelled?: boolean; workspace?: unknown; attachmentCount?: number }>;
  saveICloudBackup: (payload: unknown) => Promise<{
    ok: boolean;
    code?: string;
    path?: string;
    revision?: string;
    error?: string;
    ticket?: number;
  }>;
  loadICloudBackup: () => Promise<{
    ok: boolean;
    payload?: unknown;
    path?: string;
    revision?: string;
    error?: string;
  }>;
  getBackupStatus?: () => Promise<Record<string, unknown>>;
  setBackupAuto?: (enabled: boolean) => Promise<Record<string, unknown>>;
  pauseBackup?: () => Promise<Record<string, unknown>>;
  enqueueBackup?: (payload: unknown) => Promise<{ ok: boolean; code?: string; path?: string; revision?: string; error?: string; ticket?: number }>;
  inspectBackup?: () => Promise<{ ok: boolean; exists?: boolean; path?: string; fileHash?: string | null; baselineHash?: string | null; paused?: string | null; error?: string; code?: string }>;
  replaceBackupWithLocal?: (payload: unknown) => Promise<{ ok: boolean; code?: string; path?: string; revision?: string; error?: string }>;
  acceptBackupBaseline?: (hash: string, saved?: { workspace: unknown; sourceRevision?: number; semanticHash?: string; ticket?: number }) => Promise<Record<string, unknown>>;
  onBackupFlush?: (callback: () => void) => () => void;
  finishBackupFlush?: () => void;
  checkForUpdates?: () => Promise<BikeUpdateState & { ok: boolean }>;
  onUpdateState?: (callback: (state: BikeUpdateState) => void) => () => void;
  onPrepareUpdate?: (callback: () => Promise<{ ok: boolean }>) => () => void;
  invokeAiProvider?: (payload: {
    requestId?: string;
    endpoint: "chat_completions" | "responses";
    baseUrl: string;
    apiKey: string;
    body: unknown;
  }) => Promise<{
    ok: boolean;
    data?: unknown;
    error?: string;
  }>;
  cancelAiRequest?: (requestId: string) => Promise<unknown>;
  invokeSyncRequest?: (payload: {
    serverUrl: string;
    pathname: string;
    method?: string;
    token?: string;
    body?: unknown;
  }) => Promise<{
    ok: boolean;
    status: number;
    data?: unknown;
    error?: string;
  }>;
  onEditCommand?: (callback: (action: "undo" | "redo") => void) => () => void;
  onOpenApiConfig?: (callback: () => void) => () => void;
}

interface Window {
  bike?: BikeDesktopBridge;
  localOutline?: BikeDesktopBridge;
}
