import { useMemo, useState } from "react";

export function NodeTargetSelect({ label, targets, value, onChange, excludeId }: {
  label: string; targets: Array<{ id: string; label: string }>; value: string;
  onChange: (id: string) => void; excludeId?: string | null;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return targets.filter(item => item.id !== excludeId &&
      (!needle || item.label.toLocaleLowerCase().includes(needle) || item.id.includes(needle)));
  }, [targets, excludeId, query]);
  const selected = targets.find(item => item.id === value);
  const visible = matches.slice(0, 100);
  if (selected && !visible.some(item => item.id === value)) visible.unshift(selected);
  return <span className="node-target-select">
    {targets.length > 100 && <input className="control-input" aria-label={`${label}搜索`} placeholder="搜索主题名称" value={query} onChange={event => setQuery(event.target.value)} />}
    <select className="control-input" value={value} onChange={event => onChange(event.target.value)} aria-label={label}>
      <option value="">选择同文档主题</option>
      {value && !selected && <option value={value}>缺失主题</option>}
      {visible.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
    </select>
    {matches.length > 100 && <small>显示前 100 项，请搜索缩小范围</small>}
  </span>;
}
