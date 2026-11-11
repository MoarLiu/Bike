import { useState } from "react";
import type { LocalMigrationCopy } from "../../shared/bike-local-migration.mjs";
import type { LocalMigrationOptions } from "../localMigration";

export function LocalMigrationDialog({ copy, documentCount, onConfirm, onClose }: {
  copy?: LocalMigrationCopy; documentCount: number;
  onConfirm: (options: LocalMigrationOptions) => void; onClose: () => void;
}) {
  const [preferences, setPreferences] = useState(false);
  const [credentials, setCredentials] = useState(false);
  const importing = Boolean(copy);
  return <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="api-config-dialog" role="dialog" aria-modal="true" aria-labelledby="local-copy-title">
      <header><h3 id="local-copy-title">{importing ? "导入完整本机副本" : "导出完整本机副本"}</h3><button type="button" className="dialog-close" onClick={onClose} aria-label="关闭">×</button></header>
      <div style={{ overflow: "auto", display: "grid", gap: 16, minHeight: 0, overflowWrap: "anywhere" }}>
        <p>包含正文、原附件、回收站、可迁移版本历史、备用副本和带来源的只读操作档案。</p>
        {copy && <p>{documentCount} 个正文文档，{copy.history.reduce((count, row) => count + row.snapshots.length, 0)} 个历史版本，{copy.recovery.length} 个备用副本，{copy.assets.length} 个附件。源副本时间 {new Date(copy.createdAt).toLocaleString()}。</p>}
        <p>新端会生成独立副本身份，同步和自动备份默认关闭。原端待同步操作、冲突和回执以只读档案保存，连接令牌、远端游标、待确认提案与内存撤销栈不作为活动状态迁移。</p>
        {importing ? <p>确认后会先保存当前完整本机副本，再安装所选副本。来源档案与备用副本可在导入后查看。导入会校验正文和附件哈希。</p> : <p>请先结束中文输入，并暂停其他窗口的编辑。导出过程会保存草稿并校验正文、历史和备用副本的一致版本。此 ZIP 包含私有历史，请妥善保存。</p>}
        {(!copy || copy.preferences) && <label className="config-field checkbox-field"><input type="checkbox" checked={preferences} onChange={(event) => setPreferences(event.target.checked)} />{importing ? "载入" : "包含"}外观、导航和 AI 服务偏好</label>}
        {(!copy || copy.credentials) && <label className="config-field checkbox-field"><input type="checkbox" checked={credentials} onChange={(event) => setCredentials(event.target.checked)} />{importing ? "载入" : "明文导出"} AI API 密钥</label>}
        {credentials && <p role="alert">API 密钥会以明文保存在完整副本中，请仅通过可信方式保存和传输。</p>}
      </div>
      <footer><button type="button" className="secondary" onClick={onClose}>取消</button><button type="button" className="primary" onClick={() => onConfirm({ preferences, credentials })}>{importing ? "备份当前副本并导入" : "选择完整副本保存位置"}</button></footer>
    </section>
  </div>;
}

export function LocalMigrationArchivesDialog({ archives, onDownload, onClose }: {
  archives: LocalMigrationCopy[]; onDownload: (copy: LocalMigrationCopy) => void; onClose: () => void;
}) {
  return <div className="modal-overlay"><section className="api-config-dialog" role="dialog" aria-modal="true" aria-labelledby="source-archives-title">
    <header><h3 id="source-archives-title">本机来源档案</h3><button type="button" className="dialog-close" onClick={onClose} aria-label="关闭">×</button></header>
    <div style={{ overflow: "auto", display: "grid", gap: 16, minHeight: 0, overflowWrap: "anywhere" }}><p>源设备操作以只读记录保存。历史版本可以从版本历史恢复，备用内容可以从备用副本入口恢复。</p>
      {!archives.length && <p>尚未导入完整本机副本。</p>}
      {archives.map((archive) => <article key={archive.id}><h3>{new Date(archive.createdAt).toLocaleString()}</h3>
        <p>源身份 {archive.source.actorId ?? "旧版独立副本"}，源修订 {archive.source.revision}。操作档案 {archive.sourceAudit.audit.length} 项，源待传操作 {archive.sourceAudit.outbox.length} 项，源冲突 {archive.sourceAudit.conflicts.length} 项。</p>
        <p>正文 SHA-256 <code>{archive.source.workspaceSha256}</code></p>
        <button type="button" onClick={() => onDownload(archive)}>下载只读源记录</button></article>)}
    </div><footer><button type="button" onClick={onClose}>关闭</button></footer>
  </section></div>;
}
