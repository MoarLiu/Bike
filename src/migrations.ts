import type { OutlineDocument, OutlineNode, TrashEntry, Workspace } from "./types";
import { createNode, normalizeColor, uid } from "./tree";
import { uuid } from "./id";
import { assertDocumentBudget, assertWorkspaceBudget } from "../shared/bike-limits.mjs";
import { validateDocumentAttachments, workspaceFormatVersion } from "../shared/bike-attachments.mjs";

export const CURRENT_WORKSPACE_VERSION = 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
    ...rawNode,
    text: textOr(rawNode.text, fallbackText),
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
    imageAlt:
      typeof rawNode.imageAlt === "string" ? rawNode.imageAlt : undefined,
    table: normalizeTable(rawNode.table),
    codeBlock:
      typeof rawNode.codeBlock === "string"
        ? rawNode.codeBlock.replace(/\r\n?/g, "\n")
        : undefined,
    codeLanguage:
      typeof rawNode.codeLanguage === "string" && rawNode.codeLanguage.trim()
        ? rawNode.codeLanguage.trim().slice(0, 80)
        : undefined,
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
  if (!Array.isArray(rawDocument.nodes)) throw new Error("文档缺少有效的主题数组，原数据未被替换");
  assertDocumentBudget(rawDocument);
  validateDocumentAttachments(rawDocument as unknown as OutlineDocument);

  const now = new Date().toISOString();
  const updatedAt = typeof rawDocument.updatedAt === "string" && Number.isFinite(Date.parse(rawDocument.updatedAt))
    ? rawDocument.updatedAt : now;
  const markdownSource =
    typeof rawDocument.markdownSource === "string"
      ? rawDocument.markdownSource.replace(/\r\n?/g, "\n")
      : undefined;
  const markdownUpdatedAt =
    typeof rawDocument.markdownUpdatedAt === "string" &&
    rawDocument.markdownUpdatedAt.trim()
      ? rawDocument.markdownUpdatedAt
      : markdownSource !== undefined
        ? updatedAt
        : undefined;
  const nodes = Array.isArray(rawDocument.nodes)
    ? rawDocument.nodes.map((node) => normalizeNode(node, usedIds))
    : [];

  return {
    ...rawDocument,
    id: uniqueId(rawDocument.id, usedIds),
    title: textOr(rawDocument.title, "").trim() || "未命名文档",
    createdAt: textOr(rawDocument.createdAt, now),
    updatedAt,
    markdownSource,
    markdownUpdatedAt,
    isShortcut: typeof rawDocument.isShortcut === "boolean" ? rawDocument.isShortcut : undefined,
    nodes,
  };
};

const isValidTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

export const migrateTrash = (
  rawTrash: unknown,
): TrashEntry[] => {
  if (!Array.isArray(rawTrash)) return [];
  const entryIds = new Set<string>();
  return rawTrash.flatMap((rawEntry) => {
    if (
      !isRecord(rawEntry) ||
      !isValidTimestamp(rawEntry.deletedAt) ||
      !isRecord(rawEntry.document) ||
      !textOr(rawEntry.document.id, "").trim() ||
      !Array.isArray(rawEntry.document.nodes)
    ) throw new Error("回收站包含无效记录，原工作区未被替换");
    let document: OutlineDocument;
    try {
      document = migrateDocument(rawEntry.document);
    } catch (error) {
      throw new Error(`回收站文档无法读取：${error instanceof Error ? error.message : String(error)}`);
    }
    const candidate = textOr(rawEntry.id, "").trim();
    const id = candidate && !entryIds.has(candidate) ? candidate : `trash_${uuid()}`;
    entryIds.add(id);
    const index = rawEntry.originalIndex;
    return [{
      id,
      document,
      deletedAt: rawEntry.deletedAt,
      originalIndex: typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : 0,
    }];
  });
};

export const migrateWorkspace = (rawWorkspace: unknown): Workspace => {
  if (!isRecord(rawWorkspace) || !Array.isArray(rawWorkspace.documents)) {
    throw new Error("导入文件不是有效工作区");
  }
  if (rawWorkspace.version !== undefined && rawWorkspace.version !== 1 && rawWorkspace.version !== 2 && rawWorkspace.version !== CURRENT_WORKSPACE_VERSION) {
    throw new Error(`工作区版本 ${String(rawWorkspace.version)} 暂不支持，原数据已保留`);
  }
  assertWorkspaceBudget(rawWorkspace);

  const usedIds = new Set<string>();
  const documents = rawWorkspace.documents.map((document, index) => {
    try {
      return migrateDocument(document, usedIds);
    } catch (error) {
      throw new Error(`第 ${index + 1} 个文档无法读取：${error instanceof Error ? error.message : String(error)}；原工作区未被替换`);
    }
  });
  if (!documents.length) throw new Error("工作区至少需要一个文档");

  const requestedActiveId = textOr(rawWorkspace.activeDocumentId, "");
  const activeDocumentId = documents.some(
    (document) => document.id === requestedActiveId,
  )
    ? requestedActiveId
    : documents[0].id;

  const workspace: Workspace = {
    ...rawWorkspace,
    version: rawWorkspace.version === 3 ? 3 : rawWorkspace.version === 2 ? 2 : 1,
    activeDocumentId,
    documents,
  };
  if ("trash" in rawWorkspace) {
    const trash = migrateTrash(rawWorkspace.trash);
    if (trash.length) workspace.trash = trash;
    else delete workspace.trash;
  }
  if (workspaceFormatVersion(workspace) !== workspace.version) {
    throw new Error("附件数据需要 version 2 工作区，请通过升级流程载入，原数据已保留");
  }
  return workspace;
};

export const firstDocument = (workspace: Workspace) =>
  workspace.documents.find(
    (document) => document.id === workspace.activeDocumentId,
  ) ?? workspace.documents[0];
