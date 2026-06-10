export type ViewMode = "outline" | "mindmap" | "presentation" | "markdown";

export interface OutlineNode {
  id: string;
  text: string;
  note: string;
  checked: boolean;
  collapsed: boolean;
  color: string;
  headingLevel?: 0 | 1 | 2 | 3;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  highlight?: boolean;
  icon?: string;
  imageName?: string;
  imageAlt?: string;
  table?: string[][];
  codeBlock?: string;
  codeLanguage?: string;
  isTodo?: boolean;
  children: OutlineNode[];
}

export interface OutlineDocument {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  markdownSource?: string;
  markdownUpdatedAt?: string;
  nodes: OutlineNode[];
}

export interface Workspace {
  version: 1;
  activeDocumentId: string;
  documents: OutlineDocument[];
}

export interface FlatNode {
  node: OutlineNode;
  depth: number;
  parentId: string | null;
  path: number[];
}

export interface BackupResult {
  ok: boolean;
  path?: string;
  revision?: string;
  error?: string;
}
