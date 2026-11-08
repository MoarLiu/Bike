import { useEffect, useState } from "react";
import { History, RotateCcw, Save, X } from "lucide-react";
import type { OutlineDocument } from "../types";
import {
  diffDocuments,
  previewLines,
  type DocumentSnapshot,
} from "../versionHistory";

const REASON_LABELS: Record<DocumentSnapshot["reason"], string> = {
  auto: "自动",
  manual: "手动",
  "before-restore": "恢复前",
  sync: "同步前",
};

const formatTime = (value: string) => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "时间未知";
  return new Date(time).toLocaleString("zh-CN", { hour12: false });
};

export function VersionHistoryDialog({
  document,
  snapshots,
  loading,
  error,
  busy,
  onRestore,
  onSaveNow,
  onClose,
}: {
  document: OutlineDocument;
  snapshots: DocumentSnapshot[];
  loading: boolean;
  error: string | null;
  busy?: boolean;
  onRestore: (snapshot: DocumentSnapshot) => void;
  onSaveNow: () => void;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState(snapshots[0]?.id ?? null);

  useEffect(() => {
    setSelectedId((current) =>
      snapshots.some((snapshot) => snapshot.id === current)
        ? current
        : snapshots[0]?.id ?? null,
    );
  }, [snapshots]);

  const selected = snapshots.find((snapshot) => snapshot.id === selectedId) ?? null;
  const diff = selected ? diffDocuments(document, selected.document) : null;
  const preview = selected ? previewLines(selected.document.nodes) : [];
  const titleChanged = selected && selected.document.title !== document.title;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="版本历史" onClick={() => !busy && onClose()}>
      <section className="workspace-dialog history-dialog" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h3>版本历史</h3>
            <p>{document.title} · 版本历史保存在本机，不参与同步。</p>
          </div>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="关闭" disabled={busy}>
            <X size={16} />
          </button>
        </header>

        <div className="history-body">
          <div className="history-list">
            {snapshots.map((snapshot) => (
              <button
                key={snapshot.id}
                type="button"
                className={snapshot.id === selectedId ? "selected" : ""}
                onClick={() => setSelectedId(snapshot.id)}
                disabled={busy || loading}
              >
                <strong>{REASON_LABELS[snapshot.reason]} · {formatTime(snapshot.createdAt)}</strong>
                <span>
                  {snapshot.title} · {snapshot.nodeCount} 个主题
                </span>
              </button>
            ))}
            {!snapshots.length && !loading && (
              <p className="empty-text">暂无版本快照。继续编辑后会自动生成。</p>
            )}
            {loading && <p className="empty-text">正在读取版本历史...</p>}
          </div>

          <div className="history-preview">
            {selected && diff ? (
              <>
                <div className="history-diff">
                  相对当前版本：新增 {diff.added} · 删除 {diff.removed} · 修改 {diff.changed}
                  {titleChanged ? " · 标题已改变" : ""}
                </div>
                <pre>
                  {preview
                    .map((line) => `${"  ".repeat(line.depth)}${line.text}`)
                    .join("\n")}
                </pre>
              </>
            ) : (
              <p className="empty-text">选择一个版本查看预览。</p>
            )}
          </div>
        </div>

        {error && <p className="config-error">{error}</p>}

        <footer>
          <button
            type="button"
            onClick={() => selected && onRestore(selected)}
            disabled={!selected || busy || loading}
          >
            <RotateCcw size={15} />
            恢复此版本
          </button>
          <button type="button" onClick={onSaveNow} disabled={busy || loading}>
            <Save size={15} />
            保存当前版本
          </button>
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            <History size={15} />
            关闭
          </button>
        </footer>
      </section>
    </div>
  );
}
