/// <reference types="vite/client" />

interface Window {
  localOutline?: {
    saveICloudBackup: (payload: unknown) => Promise<{
      ok: boolean;
      path?: string;
      error?: string;
    }>;
    loadICloudBackup: () => Promise<{
      ok: boolean;
      payload?: unknown;
      path?: string;
      error?: string;
    }>;
  };
}
