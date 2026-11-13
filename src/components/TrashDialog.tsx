import { Modal } from "./Modal";
import { ArchiveRestore, Trash2, X } from "lucide-react";
import type { TrashEntry } from "../types";

const formatTime = (value: string) => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "时间未知";
  return new Date(time).toLocaleString("zh-CN", { hour12: false });
};

export function TrashDialog({
  entries,
  busy,
  onRestore,
  onDelete,
  onEmpty,
  onClose,
}: {
  entries: TrashEntry[];
  busy?: boolean;
  onRestore: (entryId: string) => void;
  onDelete: (entryId: string) => void;
  onEmpty: () => void;
  onClose: () => void;
}) {
  return (
    <Modal onDismiss={() => !busy && onClose()} className="modal-overlay" role="dialog" aria-modal="true" aria-label="回收站" onClick={() => !busy && onClose()}>
      <section className="workspace-dialog trash-dialog" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h3>回收站</h3>
            <p>删除的文档会保留 30 天，可恢复或彻底删除。回收站只保存在本机。</p>
          </div>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="关闭" disabled={busy}>
            <X size={16} />
          </button>
        </header>

        <div className="trash-list">
          {entries.map((entry) => (
            <article key={entry.id} className="trash-item">
              <div>
                <strong>{entry.document.title}</strong>
                <span>删除于 {formatTime(entry.deletedAt)}</span>
              </div>
              <div className="trash-item-actions">
                <button type="button" onClick={() => onRestore(entry.id)} disabled={busy}>
                  <ArchiveRestore size={15} />
                  恢复
                </button>
                <button type="button" className="danger" onClick={() => onDelete(entry.id)} disabled={busy}>
                  <Trash2 size={15} />
                  彻底删除
                </button>
              </div>
            </article>
          ))}
          {!entries.length && <p className="empty-text">回收站为空。</p>}
        </div>

        <footer>
          <button
            type="button"
            className="danger"
            onClick={onEmpty}
            disabled={busy || !entries.length}
          >
            <Trash2 size={15} />
            下载并清空回收站
          </button>
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            关闭
          </button>
        </footer>
      </section>
    </Modal>
  );
}
