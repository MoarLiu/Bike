const storedSourceScript = `(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("bike-db", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("workspace-store", "readonly");
      const store = tx.objectStore("workspace-store");
      const workspace = store.get("workspace"), meta = store.get("workspace-meta");
      tx.oncomplete = () => resolve({ workspace: workspace.result, revision: meta.result?.revision });
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
})()`;

const verifySavedBackupSource = async ({ window, ownerId, workspace, sourceRevision, migrate, hash }) => {
  if (!window || window.isDestroyed?.() || window.webContents.isDestroyed() ||
    window.webContents.id !== ownerId || !Number.isSafeInteger(sourceRevision) || sourceRevision <= 0) return false;
  let timeout;
  try {
    const stored = await Promise.race([
      window.webContents.executeJavaScript(storedSourceScript),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("本机保存凭据读取超时")), 1500); }),
    ]);
    if (stored?.revision !== sourceRevision || !stored.workspace) return false;
    const content = `${JSON.stringify(await migrate(workspace), null, 2)}\n`;
    const saved = `${JSON.stringify(await migrate(stored.workspace), null, 2)}\n`;
    return hash(content) === hash(saved);
  } catch { return false; }
  finally { clearTimeout(timeout); }
};

module.exports = { verifySavedBackupSource };
