export const MAX_DOCUMENT_NODES: number;
export const MAX_DESKTOP_DEPTH: number;
export const MAX_DOCUMENT_BYTES: number;
export const MAX_JSON_DEPTH: number;
export class BikeResourceError extends Error { code: string; constructor(message: string, code?: string); }
export function utf8ByteLength(value: string): number;
export function assertTextBudget(text: string, maximum?: number): void;
export function assertTreeBudget(nodes: unknown, options?: { maxNodes?: number; maxDepth?: number }): { nodes: number; depth: number };
export function assertValueBudget(value: unknown, options?: { maxDepth?: number; maxBytes?: number; maxValues?: number }): { bytes: number; values: number };
export function assertDocumentBudget(value: unknown, options?: { maxNodes?: number; maxDepth?: number; maxBytes?: number }): void;
export function assertWorkspaceBudget(value: unknown): void;
