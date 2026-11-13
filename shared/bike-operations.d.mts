import type { Workspace, OutlineDocument } from '../src/types';
export interface OperationSource { kind: 'user' | 'ai' | 'mcp' | 'undo' | 'redo' | 'restore' | 'import' | 'conflict'; label: string; template?: string; version?: string }
export interface NodePosition { parentId: string | null; afterId: string | null; clock: number; stamp: string; previousAfterId?: string | null }
export type WorkspacePositions = Record<string, Record<string, NodePosition>>;
export interface ValueSlot { present: boolean; value?: unknown }
export interface OperationChange { type: string; documentId: string; nodeId?: string | null; field?: string; before?: unknown; after?: unknown; value?: unknown; position?: unknown; document?: OutlineDocument; restore?: boolean; [key: string]: unknown }
export interface WorkspaceOperation { orderingVersion?: 2; documentOrder?: { before: string[]; after: string[] }; protocol: 2; id: string; actorId: string; clock: number; batchId: string; source: OperationSource; createdAt: string; changes: OperationChange[]; resolves: string[]; resolutionBaselines?: Record<string, string | null> }
export interface OperationConflict { documentId?: string; nodeId: string | null; field: string; baseline?: unknown; current?: unknown; candidate?: unknown; message: string }
export interface OperationOptions { orderingVersion?: 1 | 2; includeOrder?: boolean; commit?: boolean; id: string; actorId: string; clock?: number; batchId?: string; source?: OperationSource; createdAt?: string; positions?: WorkspacePositions; resolves?: string[]; resolutionBaselines?: Record<string, string | null> }
export interface OperationResult { status: 'applied' | 'conflict'; workspace: Workspace; positions: WorkspacePositions; conflicts: OperationConflict[] }
export const OPERATION_PROTOCOL: 2;
export const OPERATION_CAPABILITY: 'node-operations-v2';
export const OPERATION_LIMITS: { commitBytes: number; commitChanges: number; chunkCharacters: number; bytes: number; changes: number; pageBytes: number; checkpointBytes: number; pageSize: number; outboxBytes: number; auditEntries: number; proposalBytes: number; proposalGroups: number; proposalTtlMs: number; attachmentChunkBytes: number; attachmentConcurrent: number };
export function canonicalJson(value: unknown): string;
export function splitOperationPayload(text: string): string[];
export function equalValue(left: unknown, right: unknown): boolean;
export function sameOperationDocument(left: OutlineDocument | null | undefined, right: OutlineDocument | null | undefined): boolean;
export function canonicalOperationDocument(document: OutlineDocument): string;
export function indexOperationNodes(document: OutlineDocument): Map<string, { value: Record<string, unknown>; parentId: string | null; afterId: string | null }>;
export function initialPositions(workspace: Pick<Workspace, 'documents'>): WorkspacePositions;
export function createWorkspaceOperation(before: Workspace, after: Workspace, options: OperationOptions): WorkspaceOperation;
export function validateWorkspaceOperation(operation: unknown, options?: { commit?: boolean }): WorkspaceOperation;
export function applyWorkspaceOperation(workspace: Workspace, positions: WorkspacePositions, operation: WorkspaceOperation): OperationResult;
export function compensateWorkspaceChange(current: Workspace, before: Workspace, after: Workspace, options: OperationOptions): OperationResult & { operation: WorkspaceOperation };
export function operationSummary(operation: WorkspaceOperation): Array<{ type: string; documentId: string; nodeId: string | null; field?: string; before?: unknown; after?: unknown }>;

export function invertWorkspaceOperation(operation: WorkspaceOperation, options: { id: string; actorId: string; clock: number; createdAt?: string }): WorkspaceOperation;
