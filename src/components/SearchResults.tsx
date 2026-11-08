import type { ReactNode } from "react";
import type { SearchResult } from "../knowledge";

const highlightText = (text: string, ranges: Array<{ start: number; end: number }>): ReactNode[] => {
  if (!ranges.length) return [text];
  const nodes: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    const start = Math.max(0, Math.min(text.length, range.start));
    const end = Math.max(start, Math.min(text.length, range.end));
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(<mark key={`${index}-${start}`}>{text.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
};

export function SearchResults({
  result,
  onOpen,
  onLoadMore,
}: {
  result: SearchResult;
  onOpen: (documentId: string, nodeId: string | null) => void;
  onLoadMore: () => void;
}) {
  if (!result.total) return <p className="empty-text search-empty">没有匹配的主题</p>;
  return (
    <div className="search-results">
      <div className="document-list-title">
        <span>搜索结果</span>
        <small>{result.total} 条</small>
      </div>
      {result.groups.map((group) => (
        <section key={group.documentId}>
          <button type="button" className="search-document" onClick={() => onOpen(group.documentId, null)}>
            {group.title}
          </button>
          {group.hits.map((hit, index) => (
            <button
              key={`${hit.nodeId ?? "title"}-${hit.field}-${index}`}
              type="button"
              className="search-hit"
              onClick={() => onOpen(hit.documentId, hit.nodeId)}
            >
              <strong>{hit.pathLabel}</strong>
              <small>{hit.field === "title" ? "标题" : hit.field === "note" ? "备注" : hit.field === "code" ? "代码" : "正文"}</small>
              <span>{highlightText(hit.text, hit.ranges)}</span>
            </button>
          ))}
        </section>
      ))}
      {result.truncated && (
        <button className="control-button compact" type="button" onClick={onLoadMore}>加载更多</button>
      )}
    </div>
  );
}
