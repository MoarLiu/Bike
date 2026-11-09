export const AI_TIMEOUT_MS: number;
export const SYNC_TIMEOUT_MS: number;
export const MAX_AI_RESPONSE_BYTES: number;
export const MAX_SYNC_RESPONSE_BYTES: number;
export class BikeRequestError extends Error { code: string; constructor(message: string, code: string); }
export function withRequestBudget<T>(options: { timeoutMs: number; signal?: AbortSignal }, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
export function readResponseText(response: Response, options: { maxBytes: number; signal?: AbortSignal }): Promise<string>;
