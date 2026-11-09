import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

const sourceRoot = path.resolve(process.argv[2] ?? ".");
const edits = Number(process.argv[3] ?? 200);
const output = process.argv[4];
const { loadTypescript } = await import(pathToFileURL(path.join(sourceRoot, "tests/helpers/typescript.mjs")));
const k = await import(pathToFileURL(path.join(sourceRoot, "shared/bike-knowledge.mjs")));
const h = loadTypescript("src/editHistory.ts");
const stamp = "2026-11-09T00:00:00.000Z";
const topic = (id) => ({ id, text: `主题 ${id} 搜索标记`, note: "固定样本备注", checked: false, collapsed: false, color: "plain", children: [] });
const makeDoc = (id, count) => ({ id, title: id, createdAt: stamp, updatedAt: stamp, nodes: Array.from({ length: count }, (_, i) => topic(`${id}-${i}`)) });
const library = { version: 1, activeDocumentId: "d0", documents: Array.from({ length: 100 }, (_, i) => makeDoc(`d${i}`, 200)) };
const indexStart = performance.now();
const index = k.buildKnowledgeIndex(library);
const indexMs = performance.now() - indexStart;
const searches = [];
for (let i = 0; i < 20; i++) { const start = performance.now(); k.searchKnowledge(index, { query: "搜索标记", limit: 100 }); searches.push(performance.now() - start); }
let workspace = { version: 1, activeDocumentId: "large", documents: [makeDoc("large", 20_000)] };
let history = h.emptyEditHistory();
const editing = [], memory = [];
global.gc?.();
memory.push({ edit: 0, ...process.memoryUsage() });
for (let i = 0; i < edits; i++) {
  const start = performance.now();
  const changed = k.renameTarget(workspace, { documentId: "large", nodeId: "large-0", nextLabel: `独立编辑 ${i}` }).workspace;
  history = h.recordChange({ history, before: workspace, after: changed, selection: { documentId: "large", nodeId: "large-0" }, label: "独立编辑", group: null });
  workspace = changed;
  editing.push(performance.now() - start);
  if ((i + 1) % 20 === 0 || i === edits - 1) { global.gc?.(); memory.push({ edit: i + 1, ...process.memoryUsage(), ...(h.historyMemoryUsage?.(history) ?? {}) }); }
}
const stats = (values) => { const sorted = [...values].sort((a, b) => a - b); return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maximumMs: sorted.at(-1) }; };
const result = { runtime: process.version, platform: process.platform, arch: process.arch, machine: os.cpus()[0]?.model, collectedAt: new Date().toISOString(), evidence: "Node module measurement; excludes renderer paint and debounce", sample: { documents: 100, libraryNodes: 20_000, singleDocumentNodes: 20_000, independentEdits: edits, searches: 20 }, indexMs, searches: stats(searches), editing: stats(editing), historyEntries: history.past.length, memory };
if (output) await fs.writeFile(output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
