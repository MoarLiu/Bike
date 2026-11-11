import type { Workspace } from '../src/types';
import type { DocumentSnapshot } from '../src/versionHistory';
import type { WorkspaceRecoverySnapshot, WorkspaceRecoveryFile } from '../src/storage';
import type { ReplicaState } from './bike-replica.mjs';
import type { AttachmentMetadata } from './bike-attachments.mjs';
export interface LocalMigrationHistory { documentId: string; snapshots: DocumentSnapshot[] }
export interface LocalMigrationPreferences { theme?: string; 'bike.navigation.v1'?: string; 'bike.mindmap.relations'?: string; ai?: { endpoint?: string; baseUrl?: string; model?: string } }
export interface LocalMigrationCopy {
  format: 'bike-local-copy'; version: 1; id: string; createdAt: string; contentSha256: string;
  source: { actorId: string | null; revision: number; workspaceSha256: string };
  history: LocalMigrationHistory[]; recovery: WorkspaceRecoverySnapshot[]; recoveryFiles: WorkspaceRecoveryFile[];
  preAttachment: Workspace | null; preOperation: Workspace | null;
  sourceAudit: Pick<ReplicaState, 'audit' | 'outbox' | 'receipts' | 'conflicts'>;
  archives: LocalMigrationCopy[]; assets: Array<{ assetId: string; metadata: AttachmentMetadata }>;
  preferences?: LocalMigrationPreferences; credentials?: { aiApiKey: string };
}
export type LocalMigrationWorkspace = Workspace & { localMigration: LocalMigrationCopy };
export const LOCAL_MIGRATION_FORMAT: 'bike-local-copy';
export const LOCAL_MIGRATION_VERSION: 1;
export const LOCAL_MIGRATION_PREFERENCES: readonly string[];
export function withoutLocalMigration(workspace: Workspace): Workspace;
export function localMigrationDigest(value: unknown): string;
export function localMigrationAssetReferences(value: unknown): { ids: string[]; assets: Array<{ assetId: string; metadata: AttachmentMetadata }> };
export function localMigrationAttachmentAssets(workspace: Workspace): Array<{ assetId: string; metadata: AttachmentMetadata }>;
export function sealLocalMigration(workspace: Workspace, copy: Omit<LocalMigrationCopy, 'contentSha256'>): LocalMigrationWorkspace;
export function readLocalMigration(workspace: unknown): LocalMigrationCopy | null;
