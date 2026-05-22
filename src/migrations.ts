import type { OutlineDocument, OutlineNode, Workspace } from "./types";
import { createNode, normalizeColor, uid } from "./tree";

export const CURRENT_WORKSPACE_VERSION = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const textOr = (value: unknown, fallback: string) =>
  typeof value === "string" ? value : fallback;

const uniqueId = (value: unknown, usedIds: Set<string>) => {
  const candidate = textOr(value, "").trim();
  const id = candidate && !usedIds.has(candidate) ? candidate : uid();
  usedIds.add(id);
  return id;
};

const normalizeHeadingLevel = (value: unknown): OutlineNode["headingLevel"] => {
  if (value === 1 || value === 2 || value === 3) return value;
  return 0;
};

const normalizeTable = (value: unknown) => {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter(Array.isArray)
    .map((row) => row.map((cell) => textOr(cell, "")));
};

const normalizeNode = (
  rawNode: unknown,
  usedIds: Set<string>,
  fallbackText = "未命名主题",
): OutlineNode => {
  if (!isRecord(rawNode)) {
    const node = createNode(fallbackText);
    usedIds.add(node.id);
    return node;
  }

  const node: OutlineNode = {
    ...createNode(textOr(rawNode.text, fallbackText)),
    id: uniqueId(rawNode.id, usedIds),
    note: textOr(rawNode.note, ""),
    checked: rawNode.checked === true,
    collapsed: rawNode.collapsed === true,
    color: normalizeColor(textOr(rawNode.color, "plain")),
    headingLevel: normalizeHeadingLevel(rawNode.headingLevel),
    bold: rawNode.bold === true,
    italic: rawNode.italic === true,
    underline: rawNode.underline === true,
    strike: rawNode.strike === true,
    highlight: rawNode.highlight === true,
    isTodo: rawNode.isTodo === true,
    icon: typeof rawNode.icon === "string" ? rawNode.icon : undefined,
    imageName:
      typeof rawNode.imageName === "string" ? rawNode.imageName : undefined,
    table: normalizeTable(rawNode.table),
    children: [],
  };

  node.children = Array.isArray(rawNode.children)
    ? rawNode.children.map((child) => normalizeNode(child, usedIds))
    : [];

  return node;
};

export const migrateDocument = (
  rawDocument: unknown,
  usedIds = new Set<string>(),
): OutlineDocument => {
  if (!isRecord(rawDocument)) throw new Error("导入文件不是有效文档");

  const now = new Date().toISOString();
  const nodes = Array.isArray(rawDocument.nodes)
    ? rawDocument.nodes.map((node) => normalizeNode(node, usedIds))
    : [];

  return {
    id: uniqueId(rawDocument.id, usedIds),
    title: textOr(rawDocument.title, "").trim() || "未命名文档",
    createdAt: textOr(rawDocument.createdAt, now),
    updatedAt: textOr(rawDocument.updatedAt, now),
    nodes: nodes.length ? nodes : [normalizeNode(null, usedIds)],
  };
};

export const migrateWorkspace = (rawWorkspace: unknown): Workspace => {
  if (!isRecord(rawWorkspace) || !Array.isArray(rawWorkspace.documents)) {
    throw new Error("导入文件不是有效工作区");
  }

  const usedIds = new Set<string>();
  const documents = rawWorkspace.documents.map((document) =>
    migrateDocument(document, usedIds),
  );
  if (!documents.length) throw new Error("工作区至少需要一个文档");

  const requestedActiveId = textOr(rawWorkspace.activeDocumentId, "");
  const activeDocumentId = documents.some(
    (document) => document.id === requestedActiveId,
  )
    ? requestedActiveId
    : documents[0].id;

  return {
    version: CURRENT_WORKSPACE_VERSION,
    activeDocumentId,
    documents,
  };
};

export const firstDocument = (workspace: Workspace) =>
  workspace.documents.find(
    (document) => document.id === workspace.activeDocumentId,
  ) ?? workspace.documents[0];
