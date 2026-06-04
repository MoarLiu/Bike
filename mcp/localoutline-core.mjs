import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SERVER_NAME = "localoutline";
export const SERVER_DISPLAY_NAME = "LocalOutline MCP";
export const DEFAULT_DOCUMENT_TITLE = "未命名文档";
export const DEFAULT_NODE_TEXT = "未命名主题";
export const CURRENT_WORKSPACE_VERSION = 1;

const VALID_COLORS = new Set(["plain", "blue", "green", "amber", "rose"]);
const DEFAULT_LIMIT = 20;
const HARD_LIMIT = 100;

const isRecord = (value) => typeof value === "object" && value !== null;

const textOr = (value, fallback) =>
  typeof value === "string" ? value : fallback;

const boolOr = (value, fallback = false) =>
  typeof value === "boolean" ? value : fallback;

const normalizeColor = (value) => (VALID_COLORS.has(value) ? value : "plain");

const normalizeHeadingLevel = (value) => {
  if (value === 1 || value === 2 || value === 3) return value;
  return 0;
};

const normalizeTable = (value) => {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter(Array.isArray)
    .map((row) => row.map((cell) => textOr(cell, "")));
};

const uid = () =>
  `node_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

const uniqueId = (value, usedIds) => {
  const candidate = textOr(value, "").trim();
  const id = candidate && !usedIds.has(candidate) ? candidate : uid();
  usedIds.add(id);
  return id;
};

const createNode = (text = DEFAULT_NODE_TEXT) => ({
  id: uid(),
  text,
  note: "",
  checked: false,
  collapsed: false,
  color: "plain",
  children: [],
});

const normalizeNodeShallow = (rawNode, usedIds, fallbackText = DEFAULT_NODE_TEXT) => {
  if (!isRecord(rawNode)) {
    const node = createNode(fallbackText);
    usedIds.add(node.id);
    return node;
  }

  const node = {
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
    icon: typeof rawNode.icon === "string" ? rawNode.icon : undefined,
    imageName:
      typeof rawNode.imageName === "string" ? rawNode.imageName : undefined,
    imageAlt:
      typeof rawNode.imageAlt === "string" ? rawNode.imageAlt : undefined,
    table: normalizeTable(rawNode.table),
    isTodo: rawNode.isTodo === true,
    children: [],
  };

  return node;
};

const normalizeNode = (rawNode, usedIds, fallbackText = DEFAULT_NODE_TEXT) => {
  const root = normalizeNodeShallow(rawNode, usedIds, fallbackText);
  const stack = [
    {
      rawChildren: isRecord(rawNode) && Array.isArray(rawNode.children)
        ? rawNode.children
        : [],
      targetChildren: root.children,
    },
  ];

  while (stack.length) {
    const frame = stack.pop();
    for (let index = 0; index < frame.rawChildren.length; index += 1) {
      const rawChild = frame.rawChildren[index];
      const child = normalizeNodeShallow(rawChild, usedIds);
      frame.targetChildren[index] = child;
      if (isRecord(rawChild) && Array.isArray(rawChild.children)) {
        stack.push({
          rawChildren: rawChild.children,
          targetChildren: child.children,
        });
      }
    }
  }

  return root;
};

export const migrateDocument = (rawDocument, usedIds = new Set()) => {
  if (!isRecord(rawDocument)) throw new Error("导入文件不是有效文档");

  const now = new Date().toISOString();
  const updatedAt = textOr(rawDocument.updatedAt, now);
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
    id: uniqueId(rawDocument.id, usedIds),
    title: textOr(rawDocument.title, "").trim() || DEFAULT_DOCUMENT_TITLE,
    createdAt: textOr(rawDocument.createdAt, now),
    updatedAt,
    ...(markdownSource !== undefined ? { markdownSource } : {}),
    ...(markdownUpdatedAt !== undefined ? { markdownUpdatedAt } : {}),
    nodes: nodes.length ? nodes : [normalizeNode(null, usedIds)],
  };
};

export const migrateWorkspace = (rawWorkspace) => {
  if (!isRecord(rawWorkspace) || !Array.isArray(rawWorkspace.documents)) {
    throw new Error("导入文件不是有效工作区");
  }

  const usedIds = new Set();
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

export const defaultWorkspacePath = ({
  homeDir = os.homedir(),
  platform = process.platform,
  env = process.env,
} = {}) => {
  return defaultWorkspacePathCandidates({ homeDir, platform, env })[0];
};

export const defaultWorkspacePathCandidates = ({
  homeDir = os.homedir(),
  platform = process.platform,
  env = process.env,
} = {}) => {
  if (platform === "darwin") {
    const baseDirectory = path.join(
      homeDir,
      "Library",
      "Mobile Documents",
      "com~apple~CloudDocs",
      "LocalOutline",
    );
    return [
      path.join(baseDirectory, "localoutline-workspace.json"),
      path.join(baseDirectory, ".backups", "localoutline-workspace.json"),
    ];
  }

  if (platform === "win32") {
    return [
      path.join(
        env.APPDATA || path.join(homeDir, "AppData", "Roaming"),
        "LocalOutline",
        "localoutline-workspace.json",
      ),
    ];
  }

  return [path.join(homeDir, ".localoutline", "localoutline-workspace.json")];
};

const expandHome = (value, homeDir = os.homedir()) =>
  value === "~" || value.startsWith("~/")
    ? path.join(homeDir, value.slice(2))
    : value;

const readJsonFile = async (filePath) => {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
};

const firstExistingPath = async (paths) => {
  for (const filePath of paths) {
    try {
      await fs.access(filePath);
      return filePath;
    } catch {}
  }
  return paths[0];
};

const optionalNumber = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
};

const optionalBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return fallback;
};

export const loadMcpConfig = async ({
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) => {
  const configPath = env.LOCAL_OUTLINE_MCP_CONFIG?.trim();
  const fileConfig = configPath
    ? await readJsonFile(expandHome(configPath, homeDir))
    : {};

  const configuredWorkspacePath =
    env.LOCAL_OUTLINE_WORKSPACE_PATH?.trim() ||
    (isRecord(fileConfig) && typeof fileConfig.workspacePath === "string"
      ? fileConfig.workspacePath
      : "");

  const mode =
    env.LOCAL_OUTLINE_MCP_MODE?.trim() ||
    (isRecord(fileConfig) && typeof fileConfig.mode === "string"
      ? fileConfig.mode
      : "readonly");

  const workspacePath = configuredWorkspacePath
    ? path.resolve(expandHome(configuredWorkspacePath, homeDir))
    : await firstExistingPath(
        defaultWorkspacePathCandidates({ homeDir, platform, env }).map((candidate) =>
          path.resolve(expandHome(candidate, homeDir)),
        ),
      );

  return {
    workspacePath,
    mode,
    debug: optionalBoolean(
      env.LOCAL_OUTLINE_MCP_DEBUG,
      boolOr(isRecord(fileConfig) ? fileConfig.debug : undefined, false),
    ),
    maxSearchResults: optionalNumber(
      env.LOCAL_OUTLINE_MCP_MAX_SEARCH_RESULTS ??
        (isRecord(fileConfig) ? fileConfig.maxSearchResults : undefined),
      50,
      1,
      HARD_LIMIT,
    ),
    maxDocumentNodes: optionalNumber(
      env.LOCAL_OUTLINE_MCP_MAX_DOCUMENT_NODES ??
        (isRecord(fileConfig) ? fileConfig.maxDocumentNodes : undefined),
      2000,
      1,
      50000,
    ),
  };
};

const nodeChildren = (node) =>
  Array.isArray(node?.children) ? node.children : [];

const countNodes = (nodes = []) => {
  let total = 0;
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    total += 1;
    const children = nodeChildren(node);
    for (let index = 0; index < children.length; index += 1) {
      stack.push(children[index]);
    }
  }
  return total;
};

const normalizeForSearch = (value) => value.toLowerCase();

const compactWhitespace = (value) => value.replace(/\s+/g, " ").trim();

const snippetFor = (value, query, maxLength = 180) => {
  const compact = compactWhitespace(value);
  if (compact.length <= maxLength) return compact;
  const index = normalizeForSearch(compact).indexOf(normalizeForSearch(query));
  if (index === -1) return `${compact.slice(0, maxLength - 1)}…`;
  const start = Math.max(0, index - Math.floor(maxLength / 2));
  const end = Math.min(compact.length, start + maxLength);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
};

const collectNodeEntries = ({ document, nodes }) => {
  const entries = [];
  const byNodeId = new Map();
  const stack = [];

  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    stack.push({
      node: nodes[index],
      parentId: null,
      parentEntryIndex: null,
      depth: 0,
      path: [index],
      breadcrumb: [document.title, nodes[index]?.text || DEFAULT_NODE_TEXT],
    });
  }

  while (stack.length) {
    const frame = stack.pop();
    if (!frame?.node) continue;

    const children = nodeChildren(frame.node);
    const entry = {
      documentId: document.id,
      documentTitle: document.title,
      node: frame.node,
      nodeId: frame.node.id,
      parentId: frame.parentId,
      depth: frame.depth,
      path: frame.path,
      breadcrumb: frame.breadcrumb,
      childCount: children.length,
      descendantCount: 0,
      subtreeCount: 1,
      parentEntryIndex: frame.parentEntryIndex,
    };
    const entryIndex = entries.length;
    entries.push(entry);
    byNodeId.set(frame.node.id, entry);

    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      stack.push({
        node: child,
        parentId: frame.node.id,
        parentEntryIndex: entryIndex,
        depth: frame.depth + 1,
        path: [...frame.path, index],
        breadcrumb: [...frame.breadcrumb, child?.text || DEFAULT_NODE_TEXT],
      });
    }
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    entry.descendantCount = entry.subtreeCount - 1;
    if (entry.parentEntryIndex !== null) {
      entries[entry.parentEntryIndex].subtreeCount += entry.subtreeCount;
    }
    delete entry.subtreeCount;
    delete entry.parentEntryIndex;
  }

  return { entries, byNodeId };
};

export const buildWorkspaceIndex = (workspace) => {
  const documentsById = new Map();
  const nodesByDocumentId = new Map();
  let nodeCount = 0;

  workspace.documents.forEach((document) => {
    documentsById.set(document.id, document);
    const { entries, byNodeId } = collectNodeEntries({
      document,
      nodes: document.nodes || [],
    });
    nodesByDocumentId.set(document.id, {
      entries,
      byNodeId,
    });
    nodeCount += entries.length;
  });

  const updatedAt =
    workspace.documents
      .map((document) => Date.parse(document.updatedAt))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0] ?? 0;

  return {
    workspace,
    documentsById,
    nodesByDocumentId,
    nodeCount,
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
  };
};

export class WorkspaceStore {
  constructor(config) {
    this.config = config;
    this.cache = null;
  }

  async load() {
    const stats = await fs.stat(this.config.workspacePath);
    const cacheKey = `${stats.mtimeMs}:${stats.size}`;
    if (this.cache?.cacheKey === cacheKey) return this.cache.snapshot;

    const raw = await fs.readFile(this.config.workspacePath, "utf8");
    const workspace = migrateWorkspace(JSON.parse(raw));
    const index = buildWorkspaceIndex(workspace);
    const revision = crypto.createHash("sha256").update(raw).digest("hex");
    const snapshot = {
      workspace,
      index,
      workspacePath: this.config.workspacePath,
      workspacePathDisplay: this.config.debug
        ? this.config.workspacePath
        : path.basename(this.config.workspacePath),
      workspacePathIsRedacted: !this.config.debug,
      revision,
      file: {
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      },
      config: this.config,
    };
    this.cache = { cacheKey, snapshot };
    return snapshot;
  }
}

export const createWorkspaceStore = async (options = {}) =>
  new WorkspaceStore(options.config ?? (await loadMcpConfig(options)));

const boundedLimit = (value, fallback, hardMax = HARD_LIMIT) =>
  optionalNumber(value, fallback, 1, hardMax);

const documentStats = (document) => ({
  id: document.id,
  title: document.title,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
  nodeCount: countNodes(document.nodes || []),
  topLevelNodeCount: Array.isArray(document.nodes) ? document.nodes.length : 0,
});

export const getWorkspaceSummary = (snapshot) => ({
  version: snapshot.workspace.version,
  activeDocumentId: snapshot.workspace.activeDocumentId,
  documentCount: snapshot.workspace.documents.length,
  nodeCount: snapshot.index.nodeCount,
  updatedAt: snapshot.index.updatedAt,
  revision: snapshot.revision,
  mode: snapshot.config.mode,
  workspacePath: snapshot.workspacePathDisplay,
  workspacePathIsRedacted: snapshot.workspacePathIsRedacted,
  file: snapshot.file,
});

export const listDocuments = (
  snapshot,
  { query = "", limit = DEFAULT_LIMIT, includeStats = true } = {},
) => {
  const normalizedQuery = normalizeForSearch(query.trim());
  const max = boundedLimit(limit, DEFAULT_LIMIT);
  const documents = snapshot.workspace.documents
    .filter((document) =>
      normalizedQuery
        ? normalizeForSearch(document.title).includes(normalizedQuery)
        : true,
    )
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, max)
    .map((document) =>
      includeStats
        ? documentStats(document)
        : {
            id: document.id,
            title: document.title,
            createdAt: document.createdAt,
            updatedAt: document.updatedAt,
          },
    );

  return {
    query,
    documents,
  };
};

const validateFields = (fields = ["title", "text", "note"]) => {
  const requested = new Set(fields);
  return ["title", "text", "note"].filter((field) => requested.has(field));
};

export const searchOutline = (
  snapshot,
  {
    query,
    documentId,
    fields = ["title", "text", "note"],
    limit = DEFAULT_LIMIT,
  } = {},
) => {
  const trimmedQuery = textOr(query, "").trim();
  if (!trimmedQuery) throw new Error("query 不能为空");

  const selectedFields = validateFields(fields);
  const normalizedQuery = normalizeForSearch(trimmedQuery);
  const max = boundedLimit(
    limit,
    DEFAULT_LIMIT,
    snapshot.config.maxSearchResults,
  );
  const matches = [];

  const documents = documentId
    ? [snapshot.index.documentsById.get(documentId)].filter(Boolean)
    : snapshot.workspace.documents;

  if (documentId && documents.length === 0) {
    throw new Error(`找不到文档：${documentId}`);
  }

  for (const document of documents) {
    if (
      selectedFields.includes("title") &&
      normalizeForSearch(document.title).includes(normalizedQuery)
    ) {
      matches.push({
        documentId: document.id,
        documentTitle: document.title,
        nodeId: null,
        field: "title",
        snippet: snippetFor(document.title, trimmedQuery),
        breadcrumb: [document.title],
        path: [],
      });
    }

    const entries = snapshot.index.nodesByDocumentId.get(document.id)?.entries ?? [];
    for (const entry of entries) {
      if (
        selectedFields.includes("text") &&
        normalizeForSearch(entry.node.text || "").includes(normalizedQuery)
      ) {
        matches.push({
          documentId: document.id,
          documentTitle: document.title,
          nodeId: entry.node.id,
          field: "text",
          snippet: snippetFor(entry.node.text || "", trimmedQuery),
          breadcrumb: entry.breadcrumb,
          path: entry.path,
        });
      }

      if (
        selectedFields.includes("note") &&
        entry.node.note &&
        normalizeForSearch(entry.node.note).includes(normalizedQuery)
      ) {
        matches.push({
          documentId: document.id,
          documentTitle: document.title,
          nodeId: entry.node.id,
          field: "note",
          snippet: snippetFor(entry.node.note, trimmedQuery),
          breadcrumb: entry.breadcrumb,
          path: entry.path,
        });
      }

      if (matches.length >= max) {
        return {
          query: trimmedQuery,
          limit: max,
          matches,
          truncated: true,
        };
      }
    }
  }

  return {
    query: trimmedQuery,
    limit: max,
    matches,
    truncated: false,
  };
};

const entryForNode = (snapshot, documentId, nodeId) => {
  const document = snapshot.index.documentsById.get(documentId);
  if (!document) throw new Error(`找不到文档：${documentId}`);
  const entry = snapshot.index.nodesByDocumentId
    .get(documentId)
    ?.byNodeId.get(nodeId);
  if (!entry) throw new Error(`找不到节点：${nodeId}`);
  return { document, entry };
};

const fieldsForNode = (entry) => ({
  id: entry.node.id,
  text: entry.node.text,
  note: entry.node.note,
  checked: entry.node.checked,
  collapsed: entry.node.collapsed,
  color: entry.node.color,
  headingLevel: entry.node.headingLevel ?? 0,
  bold: entry.node.bold === true,
  italic: entry.node.italic === true,
  underline: entry.node.underline === true,
  strike: entry.node.strike === true,
  highlight: entry.node.highlight === true,
  icon: entry.node.icon,
  imageName: entry.node.imageName,
  imageAlt: entry.node.imageAlt,
  table: entry.node.table,
  isTodo: entry.node.isTodo === true,
  path: entry.path,
  breadcrumb: entry.breadcrumb,
  parentId: entry.parentId,
  depth: entry.depth,
  childCount: entry.childCount,
  descendantCount: entry.descendantCount,
});

const childEntriesFor = (snapshot, documentId, entry) =>
  nodeChildren(entry.node)
    .map((child) =>
      snapshot.index.nodesByDocumentId.get(documentId)?.byNodeId.get(child.id),
    )
    .filter(Boolean);

const appendCompactChildren = (
  snapshot,
  documentId,
  node,
  entry,
  childrenDepth,
  budget,
) => {
  if (childrenDepth <= 0) return;

  for (const childEntry of childEntriesFor(snapshot, documentId, entry)) {
    if (budget?.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    const child = compactNode(
      snapshot,
      documentId,
      childEntry,
      childrenDepth - 1,
      budget,
    );
    if (child) node.children.push(child);
  }
};

const compactNode = (snapshot, documentId, entry, childrenDepth, budget) => {
  if (budget) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      return null;
    }
    budget.remaining -= 1;
  }

  const node = {
    ...fieldsForNode(entry),
    children: [],
  };
  appendCompactChildren(snapshot, documentId, node, entry, childrenDepth, budget);
  return node;
};

const documentById = (snapshot, documentId) => {
  const document = snapshot.index.documentsById.get(documentId);
  if (!document) throw new Error(`找不到文档：${documentId}`);
  return document;
};

const compactDocument = (snapshot, document, maxDepth = 6) => {
  const entriesById = snapshot.index.nodesByDocumentId.get(document.id)?.byNodeId;
  const topEntries = (document.nodes || [])
    .map((node) => entriesById?.get(node.id))
    .filter(Boolean);
  const boundedDepth = optionalNumber(maxDepth, 6, 0, 20);
  const nodeCount = countNodes(document.nodes || []);
  const budget = {
    remaining: snapshot.config.maxDocumentNodes,
    truncated: false,
  };
  const nodes = topEntries
    .map((entry) => compactNode(snapshot, document.id, entry, boundedDepth, budget))
    .filter(Boolean);

  return {
    id: document.id,
    title: document.title,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    markdownUpdatedAt: document.markdownUpdatedAt,
    nodeCount,
    topLevelNodeCount: document.nodes.length,
    maxDepth: boundedDepth,
    maxDocumentNodes: snapshot.config.maxDocumentNodes,
    truncated: budget.truncated,
    nodes,
  };
};

export const markdownInlineForExport = (value) => {
  const inline = textOr(value, "").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  const text = inline || DEFAULT_NODE_TEXT;
  return text.replace(/([\\`*_[\]{}()#+\-.!>])/g, "\\$1");
};

const markdownNoteForExport = (value, indent = "") =>
  textOr(value, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `${indent}> ${line}`)
    .join("\n");

const markdownTableCellForExport = (value) =>
  markdownInlineForExport(value).replace(/\|/g, "\\|");

const tableToMarkdown = (table, indent = "") => {
  const rows = table.filter((row) => row.length);
  if (!rows.length) return [];

  const columnCount = Math.max(...rows.map((row) => row.length));
  const paddedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => row[index] ?? ""),
  );
  const cells = paddedRows.map(
    (row) => `${indent}| ${row.map(markdownTableCellForExport).join(" | ")} |`,
  );
  const separator = `${indent}| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`;
  return [cells[0], separator, ...cells.slice(1)];
};

const appendNodeMarkdown = (lines, node, listDepth, insideList) => {
  const text = markdownInlineForExport(node.text);
  const headingLevel = node.headingLevel ?? 0;
  const shouldWriteHeading = headingLevel > 0 && !insideList;

  if (shouldWriteHeading) {
    lines.push(`${"#".repeat(Math.min(headingLevel + 1, 6))} ${text}`);
    if (node.note) lines.push(markdownNoteForExport(node.note));
    if (node.imageName) {
      lines.push(
        `![${markdownInlineForExport(node.imageAlt || node.imageName)}](${node.imageName})`,
      );
    }
    if (node.table) lines.push(...tableToMarkdown(node.table));
    return { childListDepth: 0, childInsideList: false };
  }

  const indent = "  ".repeat(listDepth);
  const marker = node.isTodo || node.checked ? `- [${node.checked ? "x" : " "}]` : "-";
  lines.push(`${indent}${marker} ${text}`);

  const childIndent = `${indent}  `;
  if (node.note) lines.push(markdownNoteForExport(node.note, childIndent));
  if (node.imageName) {
    lines.push(
      `${childIndent}![${markdownInlineForExport(node.imageAlt || node.imageName)}](${node.imageName})`,
    );
  }
  if (node.table) lines.push(...tableToMarkdown(node.table, childIndent));

  return { childListDepth: listDepth + 1, childInsideList: true };
};

const nodesToMarkdown = (nodes) => {
  const lines = [];
  const stack = [];

  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    stack.push({ node: nodes[index], listDepth: 0, insideList: false });
  }

  while (stack.length) {
    const frame = stack.pop();
    if (!frame?.node) continue;
    const childContext = appendNodeMarkdown(
      lines,
      frame.node,
      frame.listDepth,
      frame.insideList,
    );
    const children = nodeChildren(frame.node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: children[index],
        listDepth: childContext.childListDepth,
        insideList: childContext.childInsideList,
      });
    }
  }

  return lines;
};

export const documentToMarkdown = (document) => {
  if (typeof document.markdownSource === "string") {
    return document.markdownSource.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  }
  const title = markdownInlineForExport(document.title || DEFAULT_DOCUMENT_TITLE);
  const body = nodesToMarkdown(document.nodes);
  return [`# ${title}`, "", ...body].join("\n").trimEnd();
};

const sanitizeFilenameBase = (value) => {
  const sanitized = textOr(value, "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .replace(/[.\s]+$/g, "")
    .slice(0, 120);

  if (!sanitized) return DEFAULT_DOCUMENT_TITLE;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(sanitized)) {
    return `_${sanitized}`;
  }
  return sanitized;
};

const exportFilename = (title, extension) =>
  `${sanitizeFilenameBase(title || DEFAULT_DOCUMENT_TITLE)}.${extension}`;

export const getDocument = (
  snapshot,
  { documentId, format = "compact", maxDepth = 6 } = {},
) => {
  const document = documentById(snapshot, documentId);
  if (format === "json") {
    return {
      documentId: document.id,
      title: document.title,
      format,
      content: document,
    };
  }
  if (format === "markdown") {
    return {
      documentId: document.id,
      title: document.title,
      format,
      content: documentToMarkdown(document),
    };
  }
  return {
    documentId: document.id,
    title: document.title,
    format: "compact",
    content: compactDocument(snapshot, document, maxDepth),
  };
};

const ancestorEntries = (snapshot, documentId, entry) => {
  const entriesById = snapshot.index.nodesByDocumentId.get(documentId)?.byNodeId;
  const ancestors = [];
  let parentId = entry.parentId;
  while (parentId) {
    const parent = entriesById?.get(parentId);
    if (!parent) break;
    ancestors.unshift(parent);
    parentId = parent.parentId;
  }
  return ancestors;
};

const siblingEntries = (snapshot, documentId, entry) => {
  const allEntries = snapshot.index.nodesByDocumentId.get(documentId)?.entries ?? [];
  return allEntries.filter(
    (candidate) =>
      candidate.parentId === entry.parentId && candidate.node.id !== entry.node.id,
  );
};

const budgetedFlatEntries = (entries, budget, { preferNearest = false } = {}) => {
  if (!budget) return entries.map(fieldsForNode);
  if (entries.length === 0) return [];
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return [];
  }

  const selected = preferNearest
    ? entries.slice(-budget.remaining)
    : entries.slice(0, budget.remaining);
  if (selected.length < entries.length) budget.truncated = true;
  budget.remaining -= selected.length;
  return selected.map(fieldsForNode);
};

export const getNode = (
  snapshot,
  {
    documentId,
    nodeId,
    includeAncestors = true,
    includeSiblings = false,
    childrenDepth = 2,
  } = {},
) => {
  const { document, entry } = entryForNode(snapshot, documentId, nodeId);
  const depth = optionalNumber(childrenDepth, 2, 0, 8);
  const budget = {
    remaining: snapshot.config.maxDocumentNodes,
    truncated: false,
  };
  const node = compactNode(snapshot, document.id, entry, 0, budget);
  const ancestors = includeAncestors
    ? budgetedFlatEntries(ancestorEntries(snapshot, document.id, entry), budget, {
        preferNearest: true,
      })
    : [];
  if (node) {
    appendCompactChildren(snapshot, document.id, node, entry, depth, budget);
  }
  const siblings = includeSiblings
    ? siblingEntries(snapshot, document.id, entry)
        .map((sibling) => compactNode(snapshot, document.id, sibling, 0, budget))
        .filter(Boolean)
    : [];

  return {
    documentId: document.id,
    documentTitle: document.title,
    format: "compact",
    maxDocumentNodes: snapshot.config.maxDocumentNodes,
    truncated: budget.truncated,
    node,
    ancestors,
    siblings,
  };
};

export const exportDocumentForMcp = (
  snapshot,
  { documentId, format = "json" } = {},
) => {
  const document = documentById(snapshot, documentId);
  if (format === "markdown") {
    return {
      filename: exportFilename(document.title, "md"),
      mime: "text/markdown",
      content: documentToMarkdown(document),
    };
  }
  return {
    filename: exportFilename(document.title, "json"),
    mime: "application/json",
    content: JSON.stringify(document, null, 2),
  };
};

export const resourceForDocument = (snapshot, document, format = "compact") => {
  const result = getDocument(snapshot, {
    documentId: document.id,
    format,
  });
  const isMarkdown = format === "markdown";
  return {
    uri: isMarkdown
      ? `localoutline://document-markdown/${encodeURIComponent(document.id)}`
      : `localoutline://document/${encodeURIComponent(document.id)}`,
    name: isMarkdown ? `${document.title}.md` : document.title,
    title: isMarkdown ? `${document.title} Markdown` : document.title,
    description: isMarkdown
      ? "LocalOutline 文档的 Markdown 视图"
      : "LocalOutline 文档的 compact JSON 视图",
    mimeType: isMarkdown ? "text/markdown" : "application/json",
    annotations: {
      audience: ["assistant"],
      priority: 0.8,
      lastModified: document.updatedAt,
    },
    text: isMarkdown
      ? result.content
      : JSON.stringify(result.content, null, 2),
  };
};

export const textToolResult = (data) => ({
  content: [
    {
      type: "text",
      text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
    },
  ],
  ...(typeof data === "string" ? {} : { structuredContent: data }),
});
