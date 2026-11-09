export const KNOWLEDGE_VERSION: 1;
export const MAX_METADATA_BYTES: number;
export const MAX_RELATION_LABEL: number;
export const MAX_RELATIONS: number;
export const MAX_DRAWN_RELATIONS: number;
export const MAX_SEARCH_PAGE: number;

export interface WikiLink {
  start: number;
  end: number;
  raw: string;
  documentName: string;
  nodeName: string | null;
  alias: string | null;
  labelMode: "auto" | "custom";
  label: string;
}

export interface LinkQuery {
  start: number;
  end: number;
  query?: string;
}

export interface KnowledgeReference {
  id: string;
  source: {
    kind: "node-field" | "markdown";
    nodeId?: string;
    field?: "text" | "note" | string;
    start: number;
    end: number;
    raw: string;
    sourceNodeId?: string;
    groupId?: string;
  };
  target: { documentId: string; nodeId?: string };
  labelMode: "auto" | "custom";
}

export interface NodeRelation {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  label: string;
}

export interface DocumentKnowledge {
  version: number;
  references: KnowledgeReference[];
  relations: NodeRelation[];
  sourceGroups?: Record<string, { raw: string; candidates: Array<{ nodeId: string; field: string }> }>;
}

export interface KnowledgeNode {
  id: string;
  text?: string;
  note?: string;
  children?: KnowledgeNode[];
  isTodo?: boolean;
  checked?: boolean;
  collapsed?: boolean;
  codeBlock?: string;
  table?: string[][];
}

export interface KnowledgeDocument {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  markdownSource?: string;
  nodes?: KnowledgeNode[];
  knowledge?: DocumentKnowledge | { version: number; references?: unknown[]; relations?: unknown[] };
}

export interface KnowledgeWorkspace {
  version?: number;
  activeDocumentId?: string;
  documents?: KnowledgeDocument[];
  trash?: Array<{ id?: string; document: KnowledgeDocument }>;
}

export interface ResolvedConnection {
  reference: KnowledgeReference | null;
  status: "resolved" | "missing" | "ambiguous" | "sourceMismatch" | "deleted";
  link?: WikiLink | null;
  origin?: { documentId: string; nodeId: string | null; field: string; kind: string };
  resolved?: { status: string; documentId?: string; nodeId?: string | null };
}

export interface KnowledgeIndex {
  nodesByDocument: Map<string, KnowledgeIndex["nodes"]>;
  documents: Array<{ id: string; title: string; updatedAt: string }>;
  nodes: Array<{
    documentId: string;
    nodeId: string;
    text: string;
    note: string;
    pathLabel: string;
    parentIds: string[];
    isTodo: boolean;
    checked: boolean;
    updatedAt: string;
    codeBlock: string;
    tableText: string;
    tags: string[];
    tagKeys: Set<string>;
    foldedText: string;
    foldedNote: string;
    foldedCode: string;
  }>;
  tags: Array<{ key: string; label: string; count: number; documentCount: number; nodes: Array<{ documentId: string; nodeId: string }> }>;
  backlinks: Map<string, BacklinkSource[]>;
}

export interface BacklinkSource {
  documentId: string;
  documentTitle: string;
  nodeId: string | null;
  field: string;
  raw: string;
  label: string;
  status: string;
  count?: number;
  pathLabel?: string;
  snippet?: string;
}

export interface SearchHit {
  documentId: string;
  nodeId: string | null;
  field: string;
  pathLabel: string;
  parentIds?: string[];
  updatedAt: string;
  rank: number;
  text: string;
  ranges: Array<{ start: number; end: number }>;
}

export interface SearchResult {
  groups: Array<{ documentId: string; title: string; hits: SearchHit[] }>;
  total: number;
  truncated: boolean;
  offset: number;
  limit: number;
}

export interface Suggestion {
  kind: "document" | "node" | "create";
  documentId?: string;
  nodeId?: string;
  title: string;
  documentTitle?: string;
  pathLabel?: string;
  ambiguous?: boolean;
  detail?: string;
}

export interface NavigationState {
  version: 1;
  favorites: string[];
  recent: Array<{ documentId: string; nodeId: string | null; view: string; openedAt: string }>;
  filters: Array<{
    id: string;
    name: string;
    query: string;
    tags: string[];
    documentIds: string[];
    task: "all" | "open" | "done";
    favoriteOnly: boolean;
    includeCode?: boolean;
    broken?: boolean;
  }>;
}

export interface BackupScheduleState {
  enabled: boolean;
  paused: string | null;
  dirtySince: number | null;
  pending: { ticket: number; hash: string } | null;
  dueAt: number | null;
  writing: { ticket: number; hash: string } | null;
  lastHash: string | null;
}

export function sha256Hex(message: string): string;
export function canonicalText(value: unknown): string;
export function identityKey(value: unknown): string;
export function foldKey(value: unknown): string;
export function createId(prefix: string): string;
export function codeMask(text: string): Uint8Array;
export function formatWikiLink(input: { documentName: string; nodeName?: string | null; alias?: string | null }): string;
export function scanLinks(text: string): WikiLink[];
export function activeLinkQuery(text: string, caret?: number): LinkQuery | null;
export function insertLinkAtQuery(text: string, query: LinkQuery, target: { documentName: string; nodeName?: string | null; alias?: string | null }): {
  text: string;
  start: number;
  end: number;
  raw: string;
  labelMode: "auto" | "custom";
};
export function extractKnowledgeTags(text: string): string[];
export function emptyKnowledge(): DocumentKnowledge;
export function knowledgeEditable(knowledge: unknown): knowledge is DocumentKnowledge;
export function walkNodes(nodes: KnowledgeNode[] | undefined, visit: (node: KnowledgeNode, ancestors: KnowledgeNode[]) => void, ancestors?: KnowledgeNode[]): void;
export function findKnowledgeNode(nodes: KnowledgeNode[] | undefined, id: string): { node: KnowledgeNode; ancestors: KnowledgeNode[] } | null;
export function relocateFieldReferences(knowledge: DocumentKnowledge, input: { nodeId: string; field: string; text: string; previousText?: string }): DocumentKnowledge;
export function relocateMarkdownReferences<T>(knowledge: T, text: string, previousText?: string): T;
export function anchorMarkdownReferences(document: KnowledgeDocument): KnowledgeDocument["knowledge"];
export function reconcileMarkdownReferences(before: KnowledgeDocument, after: KnowledgeDocument): KnowledgeDocument["knowledge"];
export function withFieldText<T extends KnowledgeDocument>(document: T, input: { nodeId: string; field: "text" | "note"; text: string }): T;
export function resolveDocumentConnections(workspace: KnowledgeWorkspace, document: KnowledgeDocument): ResolvedConnection[];
export interface LinkOrigin {
  documentId: string;
  kind: "node-field" | "markdown";
  nodeId?: string;
  field?: "text" | "note";
  start: number;
  end: number;
  sourceRaw?: string;
}
export function resolveWikiLink(workspace: KnowledgeWorkspace, raw: string, origin?: LinkOrigin | null): {
  status: string;
  ancestors?: KnowledgeNode[];
  documentId?: string;
  nodeId?: string | null;
  link?: WikiLink;
};
export function buildKnowledgeIndex(workspace: KnowledgeWorkspace): KnowledgeIndex;
export function knowledgeSearchStats(index: KnowledgeIndex): { scannedNodes: number; cacheHits: number };
export function knowledgeIndexCacheStats(): { documents: number; nodes: number };
export function backlinksFor(index: KnowledgeIndex, documentId: string, nodeId?: string | null): BacklinkSource[];
export function searchKnowledge(index: KnowledgeIndex, filters?: {
  query?: string;
  tags?: string[];
  documentIds?: string[];
  task?: "all" | "open" | "done";
  favoriteOnly?: boolean;
  favoriteIds?: string[];
  includeCode?: boolean;
  offset?: number;
  limit?: number;
}): SearchResult;
export function suggestLinkTargets(workspace: KnowledgeWorkspace, rawQuery: string, options?: { limit?: number }): {
  items: Suggestion[];
  requiresExplicit: boolean;
  highlight: number;
};
export function renameTarget<T extends KnowledgeWorkspace>(workspace: T, options: {
  documentId: string;
  nodeId?: string | null;
  nextLabel: string;
  previousLabel?: string | null;
  mutate?: boolean;
}): { workspace: T; updatedDocumentIds: string[]; ambiguous: Array<{ documentId: string; nodeId: string | null; field: string; raw: string }> };
export function addRelation<T extends KnowledgeDocument>(document: T, input: { id?: string; fromNodeId: string; toNodeId: string; label?: string }): {
  document: T;
  relation?: NodeRelation;
  error: string | null;
};
export function updateRelation<T extends KnowledgeDocument>(document: T, id: string, patch: Partial<NodeRelation>): {
  document: T;
  relation?: NodeRelation;
  error: string | null;
};
export function deleteRelation<T extends KnowledgeDocument>(document: T, id: string): T;
export function reverseRelation<T extends KnowledgeDocument>(document: T, id: string): {
  document: T;
  relation?: NodeRelation;
  error: string | null;
};
export function relationView(document: KnowledgeDocument): Array<NodeRelation & { fromMissing: boolean; toMissing: boolean }>;
export function readableRelations(document: KnowledgeDocument, options?: { separator?: string }): string[];
export function rekeyNodes<T extends KnowledgeNode>(nodes: T[], idFactory?: () => string): { nodes: T[]; idMap: Map<string, string> };
export function copiedKnowledgeFragment(knowledge: unknown, input: { sourceDocumentId: string; nextDocumentId: string; idMap: Map<string, string>; wholeDocument?: boolean }): {
  references: KnowledgeReference[];
  relations: NodeRelation[];
  locked: boolean;
  sourceGroups?: DocumentKnowledge["sourceGroups"];
};
export function moveSubtreeConnections<T extends KnowledgeDocument>(sourceDocument: T, targetDocument: T, movedIds: string[]): { source: T; target: T; error?: string };
export function retargetIncomingNodes<T extends KnowledgeDocument>(documents: T[], input: { sourceDocumentId: string; targetDocumentId: string; movedIds: string[] }): T[];
export function remapCollidingIds<T extends KnowledgeDocument>(document: T, usedIds: Set<string>, idFactory?: (prefix: string) => string): { document: T; idMap: Map<string, string> };
export function attachReference<T extends KnowledgeDocument>(document: T, input: {
  id?: string;
  source: KnowledgeReference["source"];
  target: KnowledgeReference["target"];
  labelMode?: "auto" | "custom";
}): { document: T; reference?: KnowledgeReference; error: string | null };
export function readBikeMetadata(markdown: string): {
  status: "absent" | "matched" | "digest-mismatch" | "invalid" | "unknown-version" | "too-large";
  body?: string;
  metadata?: { v: number; documentId: string; nodes: Array<{ id: string; path: number[]; text: string }>; knowledge?: DocumentKnowledge; digest: string };
  version?: number;
  error?: string;
};
export function encodeBikeMetadata(document: KnowledgeDocument, body: string): string;
export function finalizeMarkdownExport(body: string, document: KnowledgeDocument, options?: { metadata?: boolean }): {
  content: string;
  lossy: boolean;
  lossReasons?: string[];
  error?: string;
};
export function restoreMarkdownIdentity<T extends KnowledgeDocument>(document: T, metadata: NonNullable<ReturnType<typeof readBikeMetadata>["metadata"]>, options: { matched: boolean }): T;
export function summarizeKnowledge(workspace: KnowledgeWorkspace, document: KnowledgeDocument, options?: { limit?: number }): {
  references: { items: unknown[]; total: number; truncated: boolean };
  incoming: { items: BacklinkSource[]; total: number; truncated: boolean };
  relations: { items: unknown[]; total: number; truncated: boolean };
  truncated: boolean;
};
export function expandAncestors<T extends { id: string; collapsed?: boolean; children?: T[] }>(nodes: T[], nodeId: string): { nodes: T[]; found: boolean };
export function createNavigationState(): NavigationState;
export function normalizeNavigation(raw: unknown): NavigationState;
export function toggleFavorite(state: NavigationState, documentId: string): NavigationState;
export function rememberOpen(state: NavigationState, entry: { documentId: string; nodeId?: string | null; view?: string; openedAt?: string }): NavigationState;
export function saveNavigationFilter(state: NavigationState, filter: Partial<NavigationState["filters"][number]>): NavigationState;
export function deleteNavigationFilter(state: NavigationState, id: string): NavigationState;
export function renameNavigationFilter(state: NavigationState, id: string, name: string): NavigationState;
export function pruneNavigation(state: NavigationState, input: { liveIds: string[]; trashIds: string[] }): NavigationState;
export function resetRecentOpens(state: NavigationState): NavigationState;
export function createBackupSchedule(): BackupScheduleState;
export function pruneBackupPayloads<T>(payloads: Map<number, T>, state: BackupScheduleState): void;
export function backupContentHash(workspace: unknown): string;
export function reduceBackupSchedule(state: BackupScheduleState, event: {
  type: "set-enabled" | "pause" | "resume" | "saved" | "tick" | "flush" | "write-finished";
  enabled?: boolean;
  reason?: string;
  ticket?: number;
  hash?: string;
  authoritative?: boolean;
  ok?: boolean;
}, now: number): { state: BackupScheduleState; enqueue: { ticket: number; hash: string } | null };
