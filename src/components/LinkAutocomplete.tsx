import { useEffect, useRef } from "react";
import type { Suggestion } from "../knowledge";

export function LinkAutocomplete({
  items,
  highlight,
  requiresExplicit,
  onHighlight,
  onSelect,
  onCancel,
}: {
  items: Suggestion[];
  highlight: number;
  requiresExplicit: boolean;
  onHighlight: (index: number) => void;
  onSelect: (item: Suggestion) => void;
  onCancel: () => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>(`[data-index="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlight]);
  if (!items.length) return null;
  return (
    <div className="link-autocomplete" role="listbox" aria-label="链接候选" ref={listRef} onMouseDown={(event) => event.preventDefault()}>
      {requiresExplicit && <p>有重名结果，请明确选择一个目标</p>}
      {items.map((item, index) => (
        <button
          key={`${item.kind}-${item.documentId ?? "new"}-${item.nodeId ?? item.title}-${index}`}
          type="button"
          role="option"
          data-index={index}
          aria-selected={index === highlight}
          title={item.nodeId ? `${item.documentId}#${item.nodeId}` : item.documentId}
          className={index === highlight ? "selected" : ""}
          onMouseEnter={() => onHighlight(index)}
          onClick={() => onSelect(item)}
        >
          <strong>{item.kind === "create" ? `创建文档并链接“${item.title}”` : item.title}</strong>
          <small>
            {item.kind === "node"
              ? `${item.documentTitle} / ${item.pathLabel}${item.ambiguous ? ` · ${item.detail ? `${item.detail} · ` : ""}${item.nodeId?.slice(-8)}` : ""}`
              : item.kind === "document"
                ? `文档${item.ambiguous ? ` · ${item.detail} · ${item.documentId?.slice(-8)}` : ""}`
                : "新文档会保留，撤销只移除链接"}
          </small>
        </button>
      ))}
      <button type="button" className="link-autocomplete-cancel" onClick={onCancel}>取消</button>
    </div>
  );
}
