import type { Workspace } from "./types";
import type { AttachmentMetadata } from "../shared/bike-attachments.mjs";
import type { LocalMigrationCopy, LocalMigrationPreferences } from "../shared/bike-local-migration.mjs";
import { localMigrationAssetReferences, localMigrationDigest, readLocalMigration, sealLocalMigration, withoutLocalMigration } from "../shared/bike-local-migration.mjs";
import { AI_CONFIG_KEY, LEGACY_AI_CONFIG_KEY } from "../shared/bike-settings.mjs";
import { loadAiConfig } from "./ai";
import { migrateWorkspace } from "./migrations";
import { uuid } from "./id";
import { abortLocalMigration, beginLocalMigration, claimLocalMigrationRecovery, commitLocalMigration, finalizeLocalMigration, localMigrationWasInstalled, readLocalMigrationJournal, readLocalMigrationRecovery, readLocalMigrationStorage, renewLocalMigrationLease } from "./storage";
import { finishMigrationHistory, installMigrationHistory, listAllDocumentSnapshots, normalizeMigrationHistory, readHistoryMigrationJournal } from "./versionHistory";

export interface LocalMigrationOptions { preferences: boolean; credentials: boolean }
const preferenceKeys = ["theme", "bike.navigation.v1", "bike.mindmap.relations"];
const syncConfigKey = "bike-sync-config";
const offlineGuardKey = "bike-local-copy-offline";
let activeSession: string | null = null;
let recoveryFlight: Promise<boolean> | null = null;

const selectedPreferences = (): LocalMigrationPreferences => {
  const ai = loadAiConfig();
  return { ...Object.fromEntries(preferenceKeys.flatMap((key) => {
    const value = localStorage.getItem(key);
    return value === null ? [] : [[key, value]];
  })), ai: { endpoint: ai.endpoint, baseUrl: ai.baseUrl, model: ai.model } };
};
const settingsSnapshot = () => {
  const keys = new Set([...preferenceKeys, AI_CONFIG_KEY, LEGACY_AI_CONFIG_KEY, syncConfigKey, offlineGuardKey]);
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith("bike-sync-")) keys.add(key);
  }
  return Object.fromEntries([...keys].map((key) => [key, localStorage.getItem(key)]));
};
const disableSync = () => {
  localStorage.setItem(offlineGuardKey, "1");
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(localStorage.getItem(syncConfigKey) ?? "{}"); } catch { /* Replace unreadable configuration with an offline copy. */ }
  localStorage.setItem(syncConfigKey, JSON.stringify({ ...config, token: "", autoSync: false }));
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  for (const key of keys) if (key?.startsWith("bike-sync-") && key !== syncConfigKey) localStorage.removeItem(key);
};
const restoreSettings = (before: Record<string, string | null>) => {
  for (const [key, value] of Object.entries(before)) {
    if (key === syncConfigKey) {
      let config: Record<string, unknown> = {};
      try { config = JSON.parse(value ?? "{}"); } catch { /* Keep synchronization off if the old settings are unreadable. */ }
      localStorage.setItem(key, JSON.stringify({ ...config, autoSync: false }));
    } else if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
};
const applyImportedSettings = (copy: LocalMigrationCopy, options: LocalMigrationOptions) => {
  if (options.preferences && copy.preferences) {
    for (const key of preferenceKeys) {
      const value = copy.preferences[key as keyof LocalMigrationPreferences];
      if (typeof value === "string") localStorage.setItem(key, value);
    }
  }
  if ((options.preferences && copy.preferences?.ai) || (options.credentials && copy.credentials)) {
    const current = loadAiConfig();
    const ai = options.preferences ? copy.preferences?.ai : undefined;
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify({ ...current, ...ai,
      apiKey: options.credentials ? copy.credentials?.aiApiKey ?? current.apiKey : current.apiKey }));
  }
  disableSync();
};
const historyFingerprint = (rows: ReturnType<typeof normalizeMigrationHistory>) =>
  localMigrationDigest(rows.map((row) => ({ ...row, snapshots: row.snapshots.map(({ size: _size, ...snapshot }) => snapshot) })));

export const createLocalMigrationExport = async (
  workspace: Workspace, options: LocalMigrationOptions,
  resolveMetadata?: (assetId: string) => Promise<AttachmentMetadata>,
) => {
  const source = await readLocalMigrationStorage(workspace);
  const history = await listAllDocumentSnapshots();
  const recovery = readLocalMigrationRecovery();
  const preferences = options.preferences ? selectedPreferences() : undefined;
  const credentials = options.credentials ? { aiApiKey: loadAiConfig().apiKey } : undefined;
  const body = withoutLocalMigration(source.workspace);
  const copy: Omit<LocalMigrationCopy, "contentSha256"> = {
    format: "bike-local-copy", version: 1, id: `local-copy_${uuid()}`, createdAt: new Date().toISOString(),
    source: { actorId: source.replica?.actorId ?? null, revision: source.revision, workspaceSha256: localMigrationDigest(body) },
    history, recovery: recovery.recovery, recoveryFiles: recovery.recoveryFiles,
    preAttachment: source.preAttachment, preOperation: source.preOperation,
    sourceAudit: { audit: source.replica?.audit ?? [], outbox: source.replica?.outbox ?? [],
      receipts: source.replica?.receipts ?? {}, conflicts: source.replica?.conflicts ?? [] },
    archives: source.archives, assets: [], ...(preferences ? { preferences } : {}), ...(credentials ? { credentials } : {}),
  };
  const references = localMigrationAssetReferences({ workspace: body, history, recovery,
    preAttachment: source.preAttachment, preOperation: source.preOperation, sourceAudit: copy.sourceAudit, archives: source.archives });
  const metadata = new Map(references.assets.map((item) => [item.assetId, item.metadata]));
  for (const assetId of references.ids) {
    const existing = metadata.get(assetId);
    if (!existing && !resolveMetadata) throw new Error(`源审计附件 ${assetId} 缺少元数据，完整副本未导出`);
    copy.assets.push({ assetId, metadata: existing ?? await resolveMetadata!(assetId) });
  }
  const verify = await readLocalMigrationStorage(workspace);
  if (verify.fingerprint !== source.fingerprint || historyFingerprint(await listAllDocumentSnapshots()) !== historyFingerprint(history) ||
      readLocalMigrationRecovery().fingerprint !== recovery.fingerprint ||
      (options.preferences && localMigrationDigest(selectedPreferences()) !== localMigrationDigest(preferences)) ||
      (options.credentials && loadAiConfig().apiKey !== credentials?.aiApiKey))
    throw new Error("源正文、历史或设置在快照期间变化，请停止其他窗口写入后重新导出");
  return sealLocalMigration(body, copy);
};

export const validateLocalMigrationImport = (raw: unknown) => {
  // Validate original bytes/identities before the general migration can repair
  // duplicate IDs or fill missing fields. The source digest covers every field.
  const copy = readLocalMigration(raw);
  if (!copy) throw new Error("所选归档不是完整本机副本，请使用普通 ZIP 导入");
  const workspace = migrateWorkspace(withoutLocalMigration(raw as Workspace));
  if (localMigrationDigest(workspace) !== copy.source.workspaceSha256) throw new Error("本机副本需要修改身份或内容才能读取，已停止导入");
  normalizeMigrationHistory(copy.history);
  const validateArchives = (archive: LocalMigrationCopy) => {
    for (const snapshot of archive.recovery) migrateWorkspace(snapshot.workspace);
    for (const before of [archive.preAttachment, archive.preOperation]) if (before) migrateWorkspace(before);
    normalizeMigrationHistory(archive.history);
    archive.archives.forEach(validateArchives);
  };
  validateArchives(copy);
  return { workspace, copy };
};

// The main-store journal exists before the history transaction. The final
// main transaction installs body + fresh replica + archive + receipt together.
// A crash before that receipt rolls history back. A crash after it only needs
// to remove the history lock. Neither path can expose half an import to sync.
export const recoverInterruptedLocalMigration = (disableAutomaticBackup: () => Promise<void>): Promise<boolean> => {
  if (recoveryFlight) return recoveryFlight;
  recoveryFlight = (async () => {
    try { if (typeof indexedDB === "undefined" || !indexedDB) return false; } catch { return false; }
    const main = await readLocalMigrationJournal();
    if (!main) return false;
    if (activeSession === main.id || Date.now() - main.startedAt < 60_000)
      throw new Error("另一窗口可能正在导入本机副本。请等待一分钟后重试加载");
    const owner = await claimLocalMigrationRecovery(main.id, main.startedAt);
    const history = await readHistoryMigrationJournal();
    await disableAutomaticBackup();
    disableSync();
    const installed = await localMigrationWasInstalled(main.archiveId, main.id);
    if (history) {
      if (main.id !== history.id) throw new Error("导入日志不一致，已保留所有数据并暂停加载");
      await finishMigrationHistory(history.id, !installed);
    }
    if (installed) await finalizeLocalMigration(main.id, owner);
    else { restoreSettings(main.settingsBefore); await abortLocalMigration(main.id, owner); }
    return true;
  })().finally(() => { recoveryFlight = null; });
  return recoveryFlight;
};

export const installLocalMigrationExport = async (
  raw: unknown, expectedWorkspace: Workspace, options: LocalMigrationOptions,
  disableAutomaticBackup: () => Promise<void>,
): Promise<Workspace> => {
  const { workspace, copy } = validateLocalMigrationImport(raw);
  if (await localMigrationWasInstalled(copy.id)) throw new Error("此本机副本已经导入，当前编辑已保留");
  const source = await readLocalMigrationStorage(expectedWorkspace);
  const history = await listAllDocumentSnapshots();
  const id = `local-import_${uuid()}`;
  const settingsBefore = settingsSnapshot();
  let staged = false;
  let leaseTimer: ReturnType<typeof setInterval> | undefined;
  let leaseFailure: unknown;
  if (activeSession) throw new Error("另一完整本机副本导入尚未结束");
  activeSession = id;
  try {
    await beginLocalMigration({ id, archiveId: copy.id, sourceDigest: source.fingerprint, expectedRevision: source.revision, settingsBefore, startedAt: Date.now() });
    staged = true;
    leaseTimer = setInterval(() => { void renewLocalMigrationLease(id).catch((error: unknown) => { leaseFailure = error; }); }, 10_000);
    await disableAutomaticBackup();
    disableSync();
    await renewLocalMigrationLease(id);
    await installMigrationHistory(id, copy.id, history, copy.history);
    applyImportedSettings(copy, options);
    if (leaseFailure) throw leaseFailure;
    await renewLocalMigrationLease(id);
    await commitLocalMigration(id, workspace, copy);
    // Cleanup is idempotent. A failure retains the completion receipt and lock
    // for startup recovery and must not claim complete success to the user.
    await finishMigrationHistory(id, false);
    return await finalizeLocalMigration(id);
  } catch (error) {
    if (staged) {
      try {
        if (!await localMigrationWasInstalled(copy.id, id)) {
          await finishMigrationHistory(id, true);
          restoreSettings(settingsBefore);
          await abortLocalMigration(id);
        }
      } catch (recoveryError) {
        throw new Error(`导入未完成，日志已保留。重试加载将恢复导入前状态。${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
      }
    }
    throw error;
  } finally { if (leaseTimer !== undefined) clearInterval(leaseTimer); activeSession = null; }
};
