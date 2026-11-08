export function SearchControls({ documents, documentIds, favoriteOnly, includeCode, onDocuments, onFavorite, onCode, onSave, onClear }: {
  documents: Array<{ id: string; title: string }>;
  documentIds: string[];
  favoriteOnly: boolean;
  includeCode: boolean;
  onDocuments: (ids: string[]) => void;
  onFavorite: (enabled: boolean) => void;
  onCode: (enabled: boolean) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  return <div className="search-controls">
    <details>
      <summary>更多筛选</summary>
      <label>文档范围（多选，空选表示全部）
        <select className="control-input" multiple aria-label="筛选文档范围" value={documentIds} onChange={(event) => onDocuments(Array.from(event.target.selectedOptions, (option) => option.value))}>
          {documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}
        </select>
      </label>
      <label><input type="checkbox" checked={favoriteOnly} onChange={(event) => onFavorite(event.target.checked)} />仅收藏文档</label>
      <label><input type="checkbox" checked={includeCode} onChange={(event) => onCode(event.target.checked)} />包含代码和表格</label>
      <small>多个标签按“同时包含”筛选。</small>
    </details>
    <div className="search-control-actions"><button className="control-button compact" type="button" onClick={onSave}>保存当前筛选</button><button className="control-button compact" type="button" onClick={onClear}>清除筛选</button></div>
  </div>;
}
