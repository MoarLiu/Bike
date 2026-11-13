import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FlatNode } from "./types";

export const outlineWindow = (offsets: number[], top: number, height: number, pinned: number[] = []) => {
  const count = offsets.length - 1;
  const at = (position: number) => {
    let lo = 0, hi = count;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (offsets[mid + 1] <= position) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const start = Math.max(0, at(Math.max(0, top)) - 12), end = Math.min(count, at(top + height) + 13);
  const indices = new Set<number>();
  for (let index = start; index < end; index++) indices.add(index);
  for (const index of pinned) if (index >= 0 && index < count) indices.add(index);
  return [...indices].sort((a, b) => a - b);
};

export function useVirtualOutline(rows: FlatNode[], activeId: string | null, draggedId: string | null) {
  const containerRef = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const elements = useRef(new Map<string, HTMLElement>());
  const observer = useRef<ResizeObserver | null>(null);
  const [revision, setRevision] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 1000 });
  const frame = useRef<number | null>(null);
  const enabled = rows.length > 1000;
  const offsets = useMemo(() => {
    const values = [0];
    for (const { node } of rows) values.push(values[values.length - 1] + (heights.current.get(node.id) ?? 32));
    return values;
  }, [rows, revision]);
  const indicesById = useMemo(() => new Map(rows.map(({ node }, index) => [node.id, index])), [rows]);
  const live = useRef({ rows, offsets, viewport, indicesById });
  live.current = { rows, offsets, viewport, indicesById };
  const pendingAnchor = useRef<{ id: string; offset: number } | null>(null);
  const previousActive = useRef<string | null>(null);
  const refresh = useCallback(() => {
    const list = containerRef.current, pane = list?.closest<HTMLElement>(".editor-pane");
    if (!list || !pane) return;
    const top = pane.getBoundingClientRect().top - list.getBoundingClientRect().top;
    setViewport(previous => previous.top === top && previous.height === pane.clientHeight ? previous : { top, height: pane.clientHeight });
  }, []);
  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => { frame.current = null; refresh(); });
  }, [refresh]);
  const measure = useCallback((id: string, element: HTMLElement | null) => {
    const old = elements.current.get(id);
    if (old && old !== element) observer.current?.unobserve(old);
    if (element) { elements.current.set(id, element); observer.current?.observe(element); }
    else elements.current.delete(id);
  }, []);
  useLayoutEffect(() => {
    const list = containerRef.current, pane = list?.closest<HTMLElement>(".editor-pane");
    if (!list || !pane || !enabled) return;
    const measureRows = () => {
      let changed = false;
      for (const [id, element] of elements.current) {
        const height = Math.max(32, element.getBoundingClientRect().height);
        if (Math.abs((heights.current.get(id) ?? 32) - height) > 0.5) { heights.current.set(id, height); changed = true; }
      }
      if (changed) {
        const current = live.current;
        const index = current.offsets.findIndex((offset, at) => at < current.rows.length && offset >= Math.max(0, current.viewport.top));
        if (index >= 0) pendingAnchor.current = { id: current.rows[index].node.id, offset: current.offsets[index] };
        setRevision(value => value + 1);
      }
    };
    if (typeof ResizeObserver !== "undefined") {
      observer.current = new ResizeObserver(measureRows);
      for (const element of elements.current.values()) observer.current.observe(element);
    }
    measureRows(); refresh();
    pane.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      observer.current?.disconnect(); observer.current = null;
      pane.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [enabled, refresh, schedule]);
  useLayoutEffect(() => {
    const pane = containerRef.current?.closest<HTMLElement>(".editor-pane");
    const anchor = pendingAnchor.current;
    pendingAnchor.current = null;
    if (enabled && pane && anchor && previousActive.current === activeId) {
      const index = indicesById.get(anchor.id);
      if (index !== undefined) pane.scrollTop += offsets[index] - anchor.offset;
      refresh();
    }
  }, [offsets, indicesById, activeId, enabled, refresh]);
  useLayoutEffect(() => {
    if (!enabled || previousActive.current === activeId) return;
    previousActive.current = activeId;
    const list = containerRef.current, pane = list?.closest<HTMLElement>(".editor-pane");
    const index = activeId ? indicesById.get(activeId) : undefined;
    if (!pane || !list || index === undefined) return;
    const start = pane.getBoundingClientRect().top - list.getBoundingClientRect().top;
    if (offsets[index] < start || offsets[index + 1] > start + pane.clientHeight) pane.scrollTop += offsets[index] - start;
    refresh();
  }, [activeId, indicesById, offsets, enabled, refresh]);
  useLayoutEffect(() => {
    for (const id of heights.current.keys()) if (!indicesById.has(id)) heights.current.delete(id);
  }, [indicesById]);
  const indices = enabled ? outlineWindow(offsets, viewport.top, viewport.height, [
    activeId ? indicesById.get(activeId) ?? -1 : -1, draggedId ? indicesById.get(draggedId) ?? -1 : -1,
  ]) : rows.map((_, index) => index);
  let previousEnd = 0;
  const visible = indices.map(index => {
    const gap = enabled ? offsets[index] - previousEnd : 0;
    previousEnd = offsets[index + 1];
    return { row: rows[index], gap };
  });
  return { containerRef, visible, trailing: enabled ? offsets[offsets.length - 1] - previousEnd : 0, measure };
}
