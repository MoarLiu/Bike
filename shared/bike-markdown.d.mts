import type { OutlineDocument, OutlineNode } from "../src/types";
export const DEFAULT_DOCUMENT_TITLE: string;
export function markdownSourceMap(content: string): { text: string; offsets: number[] };
export function markdownPlainText(value: string): string;
export function markdownTableCells(row: string): Array<{ text: string; offsets: number[] }>;
export function rewriteMarkdownLabel(document: import("./bike-knowledge.mjs").KnowledgeDocument, input: { nodeId?: string | null; nextLabel: string }): string | undefined;
export const DEFAULT_NODE_TEXT: string;
export function markdownInlineForExport(value: string): string;
export function markdownTextForExport(value: string): string;
export function documentToMarkdown(document: OutlineDocument): string;
export function parseMarkdownToNodes(content: string, previousDocument?: OutlineDocument): { title: string; nodes: OutlineNode[] };
export function markdownLinkOrigins(document: OutlineDocument, content: string): Map<number, { nodeId: string; field: "text" | "note"; start: number; end: number }>;
export function parseMarkdownDocument(content: string, options?: {
  filename?: string; previousDocument?: OutlineDocument; documentId?: string; now?: string | (() => string);
}): OutlineDocument;
