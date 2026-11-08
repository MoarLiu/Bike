import { useState } from "react";
import type { BacklinkSource, NodeRelation, ResolvedConnection } from "../knowledge";

export function KnowledgePanel({
  locked,
  connections,
  documentBacklinks,
  nodeBacklinks,
  relations,
  targets,
  activeNodeId,
  onOpen,
  onOpenNode,
  onFollow,
  onAddRelation,
  onDeleteRelation,
  onReverseRelation,
  onUpdateRelation,
}: {
  locked: boolean;
  connections: ResolvedConnection[];
  documentBacklinks: BacklinkSource[];
  nodeBacklinks: BacklinkSource[];
  relations: Array<NodeRelation & { fromMissing?: boolean; toMissing?: boolean }>;
  targets: Array<{ id: string; label: string }>;
  activeNodeId: string | null;
  onOpen: (documentId: string, nodeId: string | null) => void;
  onOpenNode: (nodeId: string) => void;
  onFollow: (connection: ResolvedConnection) => void;
  onAddRelation: (toNodeId: string, label: string) => void;
  onDeleteRelation: (id: string) => void;
  onReverseRelation: (id: string) => void;
  onUpdateRelation: (id: string, patch: Partial<NodeRelation>) => boolean;
}) {
  const [scope, setScope] = useState<"document" | "node">("document");
  const [targetId, setTargetId] = useState("");
  const [label, setLabel] = useState("依赖");
  const [limits, setLimits] = useState({ key: "", incoming: 100, outgoing: 100, invalid: 100, relations: 100 });
  const key = `${scope}:${activeNodeId ?? ""}`;
  const page = limits.key === key ? limits : { key, incoming: 100, outgoing: 100, invalid: 100, relations: 100 };
  const more = (kind: "incoming" | "outgoing" | "invalid" | "relations") => setLimits({ ...page, [kind]: page[kind] + 100 });
  const visibleBacklinks = scope === "node" ? nodeBacklinks : documentBacklinks;
  const outgoing = connections.filter((item) => item.status === "resolved" && item.origin?.nodeId === activeNodeId);
  const problems = connections.filter((item) => item.status !== "resolved");
  const visibleRelations = relations.filter((relation) => relation.fromMissing || relation.toMissing || !activeNodeId || relation.fromNodeId === activeNodeId || relation.toNodeId === activeNodeId);
  return (
    <section className="knowledge-panel">
      <div className="section-title">知识连接</div>
      {locked && <p className="empty-text">连接数据版本较新，当前版本只保留不修改。请升级后再编辑链接。</p>}
      <div className="link-list">
        {outgoing.slice(0, page.outgoing).map((item, index) => (
          <button key={`out-${index}`} type="button" className="link-row link-row-button" onClick={() => onFollow(item)}>
            <span>{item.origin?.field === "note" ? "备注链接" : "正文链接"}</span>
            <strong>{item.link?.raw ?? item.reference?.source.raw}</strong>
          </button>
        ))}
        {outgoing.length > page.outgoing && <button className="control-button compact" type="button" onClick={() => more("outgoing")}>显示更多出链（{page.outgoing} / {outgoing.length}）</button>}
      </div>
      <div className="segmented knowledge-scope">
        <button type="button" className={scope === "document" ? "selected" : ""} onClick={() => setScope("document")}>引用此文档</button>
        <button type="button" className={scope === "node" ? "selected" : ""} onClick={() => setScope("node")} disabled={!activeNodeId}>引用此主题</button>
      </div>
      <div className="link-list">
        {problems.slice(0, page.invalid).map((item, index) => (
          <div key={`state-${index}`} className="link-row warning">
            <span>{item.origin?.field === "note" ? "备注" : "正文"}</span>
            <strong>
              {item.status === "deleted" ? "目标已删除" : item.status === "ambiguous" ? "需要选择目标" : item.status === "sourceMismatch" ? "需要重新选择" : "未找到目标"}
            </strong>
            <small>{(item.link?.raw ?? item.reference?.source.raw ?? "").slice(0, 160)}</small>
          </div>
        ))}
        {problems.length > page.invalid && <button className="control-button compact" type="button" onClick={() => more("invalid")}>显示更多待处理链接（{page.invalid} / {problems.length}）</button>}
        {visibleBacklinks.slice(0, page.incoming).map((item, index) => (
          <button key={`${item.documentId}-${item.nodeId}-${index}`} data-backlink-source={item.nodeId ?? item.documentId} title={`${item.documentId}#${item.nodeId ?? ""}`} type="button" className="link-row link-row-button" onClick={() => onOpen(item.documentId, item.nodeId)}>
            <span>{item.documentTitle}{item.field === "note" ? " · 备注" : ""}</span>
            <strong>{(item.pathLabel || item.raw).slice(0, 140)}{item.count && item.count > 1 ? ` ×${item.count}` : ""}</strong>
            <small>{item.field === "note" ? item.snippet || item.raw : item.raw}</small>
          </button>
        ))}
        {visibleBacklinks.length > page.incoming && <button className="control-button compact" type="button" onClick={() => more("incoming")}>显示更多反向链接（{page.incoming} / {visibleBacklinks.length}）</button>}
        {!visibleBacklinks.length && <p className="empty-text">还没有解析到的反向链接</p>}
      </div>
      <div className="section-title">主题关系</div>
      <div className="relation-editor">
        <select className="control-input" value={targetId} onChange={(event) => setTargetId(event.target.value)} aria-label="关系目标">
          <option value="">选择同文档主题</option>
          {targets.filter((item) => item.id !== activeNodeId).map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
        <input className="control-input" value={label} onChange={(event) => setLabel(event.target.value)} aria-label="关系标签" maxLength={80} />
        <button
          type="button"
          className="control-button compact"
          disabled={!activeNodeId || !targetId || targetId === activeNodeId || locked}
          onClick={() => {
            onAddRelation(targetId, label.trim());
            setTargetId("");
          }}
        >
          添加关系
        </button>
      </div>
      <div className="link-list">
        {visibleRelations.slice(0, page.relations).map((relation) => (
          <RelationRow key={relation.id} relation={relation} targets={targets} locked={locked} onOpenNode={onOpenNode} onUpdate={onUpdateRelation} onReverse={onReverseRelation} onDelete={onDeleteRelation} />
        ))}
        {visibleRelations.length > page.relations && <button className="control-button compact" type="button" onClick={() => more("relations")}>显示更多关系（{page.relations} / {visibleRelations.length}）</button>}
        {!relations.length && <p className="empty-text">当前文档还没有关系线</p>}
      </div>
    </section>
  );
}

function RelationRow({ relation, targets, locked, onOpenNode, onUpdate, onReverse, onDelete }: {
  relation: NodeRelation & { fromMissing?: boolean; toMissing?: boolean };
  targets: Array<{ id: string; label: string }>;
  locked: boolean;
  onOpenNode: (nodeId: string) => void;
  onUpdate: (id: string, patch: Partial<NodeRelation>) => boolean;
  onReverse: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [from, setFrom] = useState(relation.fromNodeId);
  const [to, setTo] = useState(relation.toNodeId);
  const [label, setLabel] = useState(relation.label);
  const name = (id: string) => targets.find((item) => item.id === id)?.label ?? "缺失主题";
  return <div className="relation-row">
    <span><button type="button" className="wiki-link-chip relation-endpoint" disabled={relation.fromMissing} onClick={() => onOpenNode(relation.fromNodeId)}>{name(relation.fromNodeId)}</button> → <button type="button" className="wiki-link-chip relation-endpoint" disabled={relation.toMissing} onClick={() => onOpenNode(relation.toNodeId)}>{name(relation.toNodeId)}</button>：{relation.label || "关联"}{relation.fromMissing || relation.toMissing ? " · 端点缺失，请重新连接" : ""}</span>
    {editing ? <div className="relation-editor">
      <select className="control-input" aria-label="编辑关系来源" value={from} onChange={(event) => setFrom(event.target.value)}>
        {!targets.some((item) => item.id === from) && <option value={from}>缺失主题</option>}
        {targets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
      <select className="control-input" aria-label="编辑关系目标" value={to} onChange={(event) => setTo(event.target.value)}>
        {!targets.some((item) => item.id === to) && <option value={to}>缺失主题</option>}
        {targets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
      <input className="control-input" aria-label="编辑关系标签" maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} />
      <button className="control-button compact" type="button" disabled={locked} onClick={() => { if (onUpdate(relation.id, { fromNodeId: from, toNodeId: to, label })) setEditing(false); }}>保存关系</button>
      <button className="control-button compact" type="button" onClick={() => setEditing(false)}>取消</button>
    </div> : <span className="relation-actions">
      <button className="control-button compact" type="button" disabled={locked} onClick={() => { setFrom(relation.fromNodeId); setTo(relation.toNodeId); setLabel(relation.label); setEditing(true); }}>编辑关系</button>
      <button className="control-button compact" type="button" disabled={locked} onClick={() => onReverse(relation.id)}>反转</button>
      <button className="control-button compact danger" type="button" disabled={locked} onClick={() => onDelete(relation.id)}>删除</button>
    </span>}
  </div>;
}
