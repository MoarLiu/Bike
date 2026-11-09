export interface AttachmentMetadata {
  mediaType: string;
  byteLength: number;
  width?: number;
  height?: number;
  [key: string]: unknown;
}
export interface AttachmentRef {
  assetId: string;
  name: string;
  alt?: string;
  [key: string]: unknown;
}
export interface DocumentAttachments {
  version: 1;
  items: Record<string, AttachmentMetadata>;
  [key: string]: unknown;
}
export interface AttachmentNode {
  attachmentRefs?: AttachmentRef[];
  children?: AttachmentNode[];
}
export interface AttachmentDocument {
  attachments?: DocumentAttachments;
  nodes: AttachmentNode[];
}
export interface AttachmentWorkspace {
  version?: number;
  documents: AttachmentDocument[];
  trash?: Array<{ document: AttachmentDocument }>;
}
export const ATTACHMENT_VERSION: 1;
export const MAX_ATTACHMENT_BYTES: number;
export const MAX_IMAGE_BYTES: number;
export const MAX_IMAGE_PIXELS: number;
export const MAX_IMPORT_FILES: number;
export const MAX_IMPORT_BYTES: number;
export function attachmentDigest(assetId: unknown): string;
export function validateAttachmentMetadata(metadata: unknown): AttachmentMetadata;
export function collectAttachmentRefs(nodes: AttachmentNode[]): AttachmentRef[];
export function validateDocumentAttachments(document: AttachmentDocument): void;
export function workspaceAttachmentAssets(workspace: AttachmentWorkspace): Array<{ assetId: string; metadata: AttachmentMetadata }>;
export function workspaceFormatVersion(workspace: AttachmentWorkspace): 1 | 2;
export function mergeAttachmentMetadata<T extends AttachmentDocument>(target: T, source: AttachmentDocument | undefined): T;
export function isPreviewableImage(metadata: AttachmentMetadata | undefined): boolean;
