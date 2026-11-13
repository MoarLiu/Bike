import { Modal } from "./Modal";
import { X } from "lucide-react";

export function BackupSettingsDialog({
  available,
  status,
  onToggle,
  onBackupNow,
  onInspect,
  onLoad,
  onReplace,
  onClose,
}: {
  available: boolean;
  status: { auto?: boolean; paused?: string | null; lastSuccessAt?: string | null; lastError?: { message?: string } | null };
  onToggle: (enabled: boolean) => void;
  onBackupNow: () => void;
  onInspect: () => void;
  onLoad: () => void;
  onReplace: () => void;
  onClose: () => void;
}) {
  return (
    <Modal onDismiss={onClose} className="modal-overlay" role="dialog" aria-modal="true" aria-label="桌面备份" onClick={onClose}>
      <form className="api-config-dialog backup-settings-dialog" onClick={(event) => event.stopPropagation()} onSubmit={(event) => event.preventDefault()}>
        <header>
          <div>
            <h3>桌面备份</h3>
            <p>自动备份默认关闭。写入 iCloud 文件夹不等于云端已经上传完成。</p>
          </div>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>
        {!available && <p>浏览器版只能手动导出工作区，不能在后台写入 iCloud 文件夹。</p>}
        {available && (
          <>
            <label className="config-field checkbox-field">
              <input type="checkbox" checked={status.auto === true} onChange={(event) => onToggle(event.target.checked)} />
              <span>保存到本机后自动更新 iCloud 备份</span>
            </label>
            <p>状态：{status.paused === "external-change" ? "发现外部变更，已暂停" : status.paused ? "已暂停" : status.auto ? "等待保存" : "未开启"}</p>
            <p>最近写入：{status.lastSuccessAt || "还没有成功的自动备份"}</p>
            {status.lastError?.message && <p>{status.lastError.message}</p>}
            <footer className="backup-dialog-actions">
              <button type="button" className="primary" onClick={onBackupNow}>立即备份</button>
              <button type="button" className="secondary" onClick={onInspect}>查看外部变更</button>
              <button type="button" className="secondary" onClick={onLoad}>载入备份</button>
              <button type="button" className="secondary" onClick={onReplace}>用本机内容替换</button>
            </footer>
          </>
        )}
      </form>
    </Modal>
  );
}
