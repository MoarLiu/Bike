/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __RELEASE_PAGE_URL__: string;

interface BikeDesktopBridge {
  saveICloudBackup: (payload: unknown) => Promise<{
    ok: boolean;
    path?: string;
    revision?: string;
    error?: string;
  }>;
  loadICloudBackup: () => Promise<{
    ok: boolean;
    payload?: unknown;
    path?: string;
    revision?: string;
    error?: string;
  }>;
  checkForUpdates?: () => Promise<{
    ok: boolean;
    currentVersion: string;
    latestVersion: string;
    updateAvailable: boolean;
    releaseName?: string;
    releaseUrl?: string;
    publishedAt?: string;
    error?: string;
  }>;
  invokeAiProvider?: (payload: {
    endpoint: "chat_completions" | "responses";
    baseUrl: string;
    apiKey: string;
    body: unknown;
  }) => Promise<{
    ok: boolean;
    data?: unknown;
    error?: string;
  }>;
  onOpenApiConfig?: (callback: () => void) => () => void;
}

interface Window {
  bike?: BikeDesktopBridge;
  localOutline?: BikeDesktopBridge;
}
