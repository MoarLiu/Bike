import type { Workspace, OutlineDocument } from '../src/types';
import type { OperationSource, WorkspaceOperation, WorkspacePositions, OperationConflict } from './bike-operations.mjs';
export interface OperationReceipt { remoteStatus?: "applied" | "conflict"; targetDocumentIds?: string[]; clientDigest?: string; candidateDigest?: string; requestId: string; digest: string; operationId: string | null; at: string; status: 'committed'; pendingSync: boolean }
export interface OperationAudit { origin?: Record<string, string>; id: string; operation: WorkspaceOperation; reason?: string; acceptedGroups?: string[]; clientDigest?: string; candidateDigest?: string; resolves?: string[]; resolutionBaselines?: Record<string, string | null>; at: string; direction: 'local' | 'remote'; status: 'pending' | 'synced' | 'conflict'; recoveryAvailable: boolean }
export interface ReplicaConflict { id: string; operation: WorkspaceOperation; conflicts: OperationConflict[]; resolved?: boolean }
export interface ReplicaState { syncStarted?: boolean; unpublishedSafe?: boolean; generation: number; initialWorkspace?: Workspace; protocol: 2; actorId: string; clock: number; positions: WorkspacePositions; outbox: WorkspaceOperation[]; receipts: Record<string, OperationReceipt>; audit: OperationAudit[]; cursor: number; remoteId: string | null; remote: { workspace: Workspace; positions: WorkspacePositions; clock: number } | null; conflicts: ReplicaConflict[] }
export function createReplicaState(workspace: Workspace, actorId: string): ReplicaState;
export function trimReplicaAudit(replica: ReplicaState): ReplicaState;
export function recordReplicaCommit(replica: ReplicaState, before: Workspace, after: Workspace, input: { retainReceipt?: boolean; requestId: string; digest: string; source: OperationSource; reason?: string; acceptedGroups?: string[]; clientDigest?: string; candidateDigest?: string; origin?: Record<string, string>; resolves?: string[]; resolutionBaselines?: Record<string, string | null>; at: string }): { replayed: boolean; replica: ReplicaState; receipt: OperationReceipt; operation?: WorkspaceOperation };
export function replicaAttachmentRoots(replica: ReplicaState | null): OutlineDocument[];
export function replicaProtectedAssetIds(replica: ReplicaState | null): string[];
export interface ReplicaEvent { digest: string; id: string; sequence: number; status: 'applied' | 'conflict'; operation: WorkspaceOperation; conflicts: OperationConflict[]; resolved?: boolean; createdAt: string }
export function applyReplicaEvents(replica: ReplicaState, events: ReplicaEvent[]): ReplicaState;
export function projectReplicaWorkspace(localWorkspace: Workspace, replica: ReplicaState): { workspace: Workspace; replica: ReplicaState; pendingConflicts: ReplicaConflict[] };
