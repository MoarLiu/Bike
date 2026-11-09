import type { EditHistory, HistoryEntry } from "./editHistory";

export const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
type Retained = { references: number; bytes: number; children: object[] };
type Pool = { owner: EditHistory; objects: Map<object, Retained>; bytes: number };
const pools = new WeakMap<EditHistory, Pool>();

const shallowSize = (value: object) => {
  const entries = Object.entries(value);
  let bytes = Array.isArray(value) ? 32 + entries.length * 8 : 32 + entries.length * 24;
  for (const [key, item] of entries) {
    if (!Array.isArray(value)) bytes += key.length * 2;
    if (typeof item === "string") bytes += 24 + item.length * 2;
  }
  return { bytes, children: entries.map(([, item]) => item).filter((item): item is object => Boolean(item) && typeof item === "object") };
};

const retain = (pool: Pool, root: object) => {
  const stack = [root];
  while (stack.length) {
    const value = stack.pop()!;
    const retained = pool.objects.get(value);
    if (retained) { retained.references += 1; continue; }
    const sized = shallowSize(value);
    pool.objects.set(value, { references: 1, ...sized });
    pool.bytes += sized.bytes;
    for (const child of sized.children) stack.push(child);
  }
};
const release = (pool: Pool, root: object) => {
  const stack = [root];
  while (stack.length) {
    const value = stack.pop()!;
    const retained = pool.objects.get(value)!;
    if (--retained.references > 0) continue;
    pool.objects.delete(value);
    pool.bytes -= retained.bytes;
    for (const child of retained.children) stack.push(child);
  }
};
const entryRoots = (entry: HistoryEntry) => entry.changes.flatMap((change) => [change.before, change.after]);
const poolFor = (history: EditHistory): Pool => {
  const cached = pools.get(history);
  if (cached?.owner === history) return cached;
  const pool: Pool = { owner: history, objects: new Map(), bytes: 0 };
  for (const entry of [...history.past, ...history.future]) for (const root of entryRoots(entry)) retain(pool, root);
  pools.set(history, pool);
  return pool;
};

export const withHistoryBudget = (previous: EditHistory, next: EditHistory, budget = MAX_HISTORY_BYTES): EditHistory => {
  const pool = poolFor(previous);
  const previousEntries = new Set([...previous.past, ...previous.future]);
  const nextEntries = new Set([...next.past, ...next.future]);
  for (const entry of previousEntries) if (!nextEntries.has(entry)) for (const root of entryRoots(entry)) release(pool, root);
  for (const entry of nextEntries) if (!previousEntries.has(entry)) for (const root of entryRoots(entry)) retain(pool, root);
  let past = next.past;
  while (pool.bytes > budget && past.length > 1) {
    const oldest = past[0];
    for (const root of entryRoots(oldest)) release(pool, root);
    past = past.slice(1);
  }
  // Keep the nearest undo even when that single operation exceeds the budget.
  const result = past === next.past ? next : { ...next, past };
  pool.owner = result;
  pools.set(result, pool);
  return result;
};

export const historyMemoryUsage = (history: EditHistory) => {
  const pool = poolFor(history);
  return { estimatedBytes: pool.bytes, retainedObjects: pool.objects.size, overBudget: pool.bytes > MAX_HISTORY_BYTES };
};
