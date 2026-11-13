import { Modal } from "./Modal";
import { X } from 'lucide-react';
import { useState } from 'react';
import type { WorkspaceProposal } from '../../shared/bike-proposals.mjs';
import { proposalFreshness } from '../../shared/bike-proposals.mjs';
import type { Workspace } from '../types';

const typeLabels: Record<string, string> = { field: '字段修改', 'create-document': '新建文档', 'replace-document': '替换文档内容', 'reorder-documents': '调整文档顺序', 'delete-document': '删除文档', 'insert-node': '新增主题', 'delete-node': '删除主题', 'move-node': '移动主题' };
const showValue = (value: unknown) => value === undefined ? '无' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
export function ProposalDialog({ workspace, proposal, busy, error, onAccept, onReject }: {
  workspace: Workspace; proposal: WorkspaceProposal; busy: boolean; error: string | null;
  onAccept: (selected: string[]) => void; onReject: () => void;
}) {
  const [selected, setSelected] = useState(() => proposal.groups.map((group) => group.id));
  const freshness = proposalFreshness(workspace, proposal);
  return <Modal onDismiss={() => !busy && onReject()} className="modal-overlay" role="dialog" aria-modal="true" aria-label="修改提案">
    <section className="workspace-dialog proposal-dialog">
      <header><div><h3>{proposal.label}</h3><p>{proposal.source.kind.toUpperCase()} · {proposal.groups.length} 个修改组 · 确认后保存到本机</p></div>
        <button type="button" className="dialog-close" onClick={onReject} disabled={busy} aria-label="关闭提案"><X size={16} /></button></header>
      <div className="proposal-groups">{proposal.groups.map((group) => <section key={group.id} className="proposal-group">
        <label><input type="checkbox" checked={selected.includes(group.id)} disabled={busy} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, group.id] : ids.filter((id) => id !== group.id))} />
          <strong>{group.label}</strong><span>{group.summary.length} 项</span></label>
        {group.dependsOn.length > 0 && <p>依赖 {group.dependsOn.map((id) => proposal.groups.find((item) => item.id === id)?.label).join('、')}</p>}
        {group.summary.map((change, index) => <details key={index} className="proposal-change">
          <summary>{typeLabels[change.type] ?? change.type} · {change.targetPath ?? (workspace.documents.find((d) => d.id === change.documentId)?.title ?? '新文档')}{change.afterPath && change.afterPath !== change.targetPath ? ` → ${change.afterPath}` : ''}{change.field ? ` / ${change.field}` : ''}</summary>
          <div className="proposal-diff"><div><small>当前值</small><pre>{showValue(change.before)}</pre></div><div><small>候选值</small><pre>{showValue(change.after)}</pre></div></div>
        </details>)}
      </section>)}</div>
      {freshness !== 'current' && <p className="config-error">{freshness === 'expired' ? '提案已超过有效期，请重新生成。' : '目标内容已变化，请重新生成并比较。'}</p>}
      {error && <p className="config-error">{error}</p>}
      <footer><button type="button" className="primary" onClick={() => onAccept(selected)} disabled={busy || freshness !== 'current' || !selected.length}>{busy ? '正在持久保存…' : '应用所选修改'}</button>
        <button className="secondary" onClick={onReject} disabled={busy}>拒绝提案</button></footer>
    </section>
  </Modal>;
}
