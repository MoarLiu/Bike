import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Image, Paperclip, RefreshCw, Trash2, X } from "lucide-react";
import type { AttachmentRef } from "../../shared/bike-attachments.mjs";
import type { OutlineNode } from "../types";

export const AttachmentActionsContext = createContext<{ add: (nodeId: string) => void; available: boolean; busy: boolean; generation: number } | null>(null);
export const useAttachmentActions = () => useContext(AttachmentActionsContext);
const bridge = () => window.bike ?? window.localOutline;

export function AttachmentItem({ reference, compact = false }: { reference: AttachmentRef; compact?: boolean }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [full, setFull] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useAttachmentActions()?.generation ?? 0;
  useEffect(() => {
    let active = true;
    setPreview(null);
    setError(null);
    const read = bridge()?.readAttachment;
    if (!read) {
      setError("此环境尚未取得附件，可在桌面版导入 ZIP 补齐");
      return;
    }
    read(reference.assetId).then((result) => {
      if (!active) return;
      if (!result.ok) setError(result.error || "此设备缺少附件");
      else setPreview(result.dataUrl ?? null);
    }).catch((failure) => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [reference.assetId, retry, generation]);
  useEffect(() => {
    if (full && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [full]);
  const save = async () => {
    try {
      const result = await bridge()?.saveAttachment?.(reference.assetId, reference.name);
      if (result && !result.ok) setError(result.error || "另存附件失败");
    } catch (failure) { setError(String(failure)); }
  };
  return (
    <span className={`attachment-item${compact ? " compact" : ""}`} onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
      {preview && <button type="button" className="attachment-thumbnail" aria-label={`预览 ${reference.name}`} onClick={async () => {
        try {
          const result = await bridge()?.readAttachment?.(reference.assetId, false);
          if (result?.ok && result.dataUrl) setFull(result.dataUrl);
          else setError(result?.error || "图片暂时不可用");
        } catch (failure) { setError(String(failure)); }
      }}><img src={preview} alt={reference.alt || reference.name} onError={() => { setPreview(null); setError("图片无法解码，可另存原始文件"); }} /></button>}
      <span className="attachment-caption">
        {preview ? <Image size={14} /> : <Paperclip size={14} />}
        <span title={reference.name}>{reference.name}</span>
        {!compact && bridge()?.openAttachment && <button type="button" title={`打开 ${reference.name}`} onClick={() => {
          void bridge()?.openAttachment?.(reference.assetId, reference.name).then((result) => { if (!result.ok) setError(result.error || "打开附件失败"); }).catch((failure) => setError(String(failure)));
        }}>打开</button>}
        {bridge()?.saveAttachment && <button type="button" title={`另存 ${reference.name}`} onClick={() => void save()}><Download size={13} /></button>}
      </span>
      {error && <span className="attachment-error"><span>{error}</span><button type="button" aria-label={`重试 ${reference.name}`} onClick={() => setRetry((value) => value + 1)}><RefreshCw size={12} /></button></span>}
      {full && createPortal(<dialog ref={dialog} className="attachment-preview-dialog" onClose={() => setFull(null)} onCancel={() => setFull(null)} onKeyDown={(event) => event.stopPropagation()}>
        <header><strong>{reference.name}</strong><button type="button" aria-label="关闭图片预览" onClick={() => { dialog.current?.close(); setFull(null); }}><X size={18} /></button></header>
        <img src={full} alt={reference.alt || reference.name} />
      </dialog>, document.body)}
    </span>
  );
}

export function AttachmentItems({ node, compact = false }: { node: Pick<OutlineNode, "attachmentRefs">; compact?: boolean }) {
  const refs = node.attachmentRefs ?? [];
  if (!refs.length) return null;
  return <div className={`attachment-items${compact ? " compact" : ""}`}>
    {(compact ? refs.slice(0, 1) : refs).map((reference, index) => <AttachmentItem key={`${reference.assetId}-${index}`} reference={reference} compact={compact} />)}
    {compact && refs.length > 1 && <small>另有 {refs.length - 1} 个附件</small>}
  </div>;
}

export function AttachmentPanel({ node, onPatch, onCancel, onDownloadMigration }: {
  node: OutlineNode;
  onPatch: (references: AttachmentRef[]) => void;
  onCancel: () => void;
  onDownloadMigration: () => void;
}) {
  const actions = useAttachmentActions();
  const refs = node.attachmentRefs ?? [];
  const patch = (index: number, key: "name" | "alt", value: string) => {
    if (key === "name" && !value.trim()) return;
    if (refs[index][key] === value) return;
    onPatch(refs.map((reference, at) => at === index ? { ...reference, [key]: value } : reference));
  };
  return <section className="attachment-panel" aria-label="主题附件">
    <div className="section-title">附件</div>
    <button type="button" className="control-button" disabled={!actions?.available || actions.busy} onClick={() => actions?.add(node.id)}><Paperclip size={14} />添加图片或文件</button>
    {actions?.busy && <button type="button" className="control-button" onClick={onCancel}>取消导入</button>}
    {!actions?.available && <p className="empty-text">附件导入通过 macOS 桌面版使用</p>}
    {refs.map((reference, index) => <div key={`${reference.assetId}-${index}`} className="attachment-editor">
      <AttachmentItem reference={reference} />
      <label className="field"><span>显示名</span><input key={reference.name} defaultValue={reference.name} maxLength={1024} aria-label={`附件显示名 ${index + 1}`} onBlur={(event) => patch(index, "name", event.target.value)} /></label>
      <label className="field"><span>替代文字</span><input key={reference.alt || ""} defaultValue={reference.alt || ""} maxLength={10000} aria-label={`附件替代文字 ${index + 1}`} onBlur={(event) => patch(index, "alt", event.target.value)} /></label>
      <button type="button" className="control-button danger" onClick={() => onPatch(refs.filter((_, at) => at !== index))}><Trash2 size={13} />移除引用</button>
    </div>)}
    <button type="button" className="control-button attachment-migration-download" onClick={onDownloadMigration}>下载附件格式升级前副本</button>
  </section>;
}
