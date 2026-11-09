import { useEffect, useState } from "react";
import { History, RotateCcw, Save, X } from "lucide-react";
import type { OperationAudit, ReplicaConflict } from "../../shared/bike-replica.mjs";
import type { WorkspaceOperation } from "../../shared/bike-operations.mjs";
import { operationSummary } from "../../shared/bike-operations.mjs";
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
  operations = [], conflicts = [], onRecoverOperation, onResolveConflict, onNavigate, onRestoreCopy,
}: {
  document: OutlineDocument;
  snapshots: DocumentSnapshot[];
  loading: boolean;
  error: string | null;
  busy?: boolean;
  onRestore: (snapshot: DocumentSnapshot) => void;
  onSaveNow: () => void;
  onClose: () => void;
  operations?: OperationAudit[];
  conflicts?: ReplicaConflict[];
  onRecoverOperation?: (operation: WorkspaceOperation) => void;
  onResolveConflict?: (conflict: ReplicaConflict, choice: "current" | "candidate") => void;
  onNavigate?: (documentId: string, nodeId: string | null) => void;
  onRestoreCopy?: (snapshot: DocumentSnapshot) => void;
}) {
  const [tab, setTab] = useState<"versions" | "operations" | "conflicts">("versions");
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
            <p>{document.title} · 快照和私有审计保存在本机，节点操作来源随同步传输。</p>
          </div>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="关闭" disabled={busy}>
            <X size={16} />
          </button>
        </header>

        <nav className="workflow-actions" aria-label="历史分类">
          <button type="button" className="control-button compact" onClick={() => setTab("versions")}>版本快照</button><button type="button" className="control-button compact" onClick={() => setTab("operations")}>操作与同步历史</button>
          <button type="button" className="control-button compact" onClick={() => setTab("conflicts")}>节点冲突 {conflicts.filter((item) => !item.resolved).length}</button>
        </nav>
        {tab === "operations" && <div className="operation-history">{[...operations].reverse().map((entry) => <article key={entry.id}>
          <strong>{entry.operation.source.label}</strong><p>{entry.direction === "local" ? "本机" : "远端"} · {entry.operation.source.kind} · {entry.status} · {formatTime(entry.at)}</p>
          <small>操作 {entry.id} · 设备 {entry.operation.actorId}</small>
          {entry.origin && <p>{entry.origin.principalId ? `实际会话 ${entry.origin.principalId}` : ''}{entry.origin.reportedClientName ? ` · 客户端自报 ${entry.origin.reportedClientName}` : ''}{entry.origin.model ? ` · 模型 ${entry.origin.model}` : ''}</p>}
          {entry.reason && <p>{entry.reason}</p>}
          <details><summary>查看文本、结构和引用差异</summary><pre>{JSON.stringify(operationSummary(entry.operation), null, 2)}</pre></details>
          <button type="button" className="control-button" disabled={busy || !entry.recoveryAvailable} onClick={() => onRecoverOperation?.(entry.operation)}>{entry.recoveryAvailable ? "生成恢复提案" : "恢复数据已过期"}</button>
          <button type="button" className="control-button" onClick={() => { const change = entry.operation.changes[0]; if (change) onNavigate?.(change.documentId, change.nodeId ?? null); }}>定位目标</button>
        </article>)}{!operations.length && <p>暂无保留的操作记录。操作恢复记录最多保留 200 条和 16 MiB，以先达到的预算为准。</p>}</div>}
        {tab === "conflicts" && <div className="operation-history">{conflicts.filter((item) => !item.resolved).map((entry) => <article key={entry.id}>
          <strong>{entry.operation.source.label}</strong><p>候选来源设备 {entry.operation.actorId} · 操作 {entry.id}</p>
          {entry.conflicts.map((conflict, index) => <div key={index}><p>{conflict.documentId} / {conflict.nodeId ?? "文档"} / {conflict.field} · {conflict.message}</p>
            <div className="proposal-diff"><div><small>共同基线与当前值</small><pre>{JSON.stringify({ baseline: conflict.baseline, current: conflict.current }, null, 2)}</pre></div><div><small>候选值</small><pre>{JSON.stringify(conflict.candidate ?? entry.operation.changes, null, 2)}</pre></div></div></div>)}
          <button type="button" className="control-button" disabled={busy} onClick={() => onResolveConflict?.(entry, "current")}>预览保留当前值</button><button type="button" className="control-button" disabled={busy} onClick={() => onResolveConflict?.(entry, "candidate")}>预览采用候选值</button>
          <button type="button" className="control-button" onClick={() => { const target = entry.conflicts[0]; if (target?.documentId) onNavigate?.(target.documentId, target.nodeId); }}>定位后手动整理</button>
        </article>)}{!conflicts.some((item) => !item.resolved) && <p>暂无未解决的节点冲突。</p>}</div>}
        {tab === "versions" && <div className="history-body">
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
        </div>}

        {error && <p className="config-error">{error}</p>}

        <footer>
          <button
            type="button"
            onClick={() => selected && onRestore(selected)}
            disabled={tab !== "versions" || !selected || busy || loading}
          >
            <RotateCcw size={15} />
            恢复此版本
          </button>
          {onRestoreCopy && <button type="button" disabled={tab !== "versions" || !selected || busy || loading} onClick={() => selected && onRestoreCopy(selected)}>恢复为新副本</button>}
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
