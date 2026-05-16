import type { BackupResult, Workspace } from "./types";
import { exportWorkspace } from "./exporters";

export const saveICloudBackup = async (workspace: Workspace): Promise<BackupResult> => {
  if (window.localOutline) {
    return window.localOutline.saveICloudBackup(workspace);
  }

  const picker = (window as unknown as {
    showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<{
      getFileHandle: (
        name: string,
        options: { create: boolean },
      ) => Promise<{
        createWritable: () => Promise<{
          write: (content: string) => Promise<void>;
          close: () => Promise<void>;
        }>;
      }>;
    }>;
  }).showDirectoryPicker;

  if (!picker) {
    return {
      ok: false,
      error: "当前浏览器不支持直接写入文件夹，请使用“导出工作区”保存到 iCloud Drive。",
    };
  }

  const directory = await picker({ mode: "readwrite" });
  const backup = exportWorkspace(workspace);
  const file = await directory.getFileHandle(backup.filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(backup.content);
  await writable.close();
  return {
    ok: true,
    path: `所选 iCloud Drive 文件夹/${backup.filename}`,
  };
};
