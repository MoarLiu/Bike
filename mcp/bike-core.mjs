import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  anchorMarkdownReferences,
  finalizeMarkdownExport,
  knowledgeEditable,
  relocateFieldReferences,
  renameTarget,
  summarizeKnowledge,
} from "../shared/bike-knowledge.mjs";
import { documentToMarkdown as renderDocumentMarkdown } from "../shared/bike-markdown.mjs";
import { assertDocumentBudget, assertTextBudget, assertTreeBudget, assertValueBudget, assertWorkspaceBudget, MAX_DOCUMENT_BYTES } from "../shared/bike-limits.mjs";
import { assertRegularWriteTarget, isProcessAlive } from "../electron/workspace-lock.cjs";

export const SERVER_NAME = "bike";
export const SERVER_DISPLAY_NAME = "Bike MCP";
export const DEFAULT_DOCUMENT_TITLE = "未命名文档";
export const DEFAULT_NODE_TEXT = "未命名主题";
export const CURRENT_WORKSPACE_VERSION = 1;

const VALID_COLORS = new Set(["plain", "blue", "green", "amber", "rose"]);
const DEFAULT_LIMIT = 20;
const HARD_LIMIT = 100;
const WRITE_LOCK_TIMEOUT_MS = 5000;
const WRITE_LOCK_STALE_MS = 10 * 60 * 1000;
const WRITE_LOCK_RETRY_MS = 50;
const MAX_WRITE_NODE_DEPTH = 64;
const ISO_UTC_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;

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
  `node_${crypto.randomUUID()}`;

const documentUid = () =>
  `doc_${crypto.randomUUID()}`;

const uniqueId = (value, usedIds) => {
  const candidate = textOr(value, "").trim();
  const id = candidate && !usedIds.has(candidate) ? candidate : uid();
  usedIds.add(id);
  return id;
};

const uniqueDocumentId = (value, usedIds) => {
  const candidate = textOr(value, "").trim();
  const id = candidate && !usedIds.has(candidate) ? candidate : documentUid();
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
    ...rawNode,
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
    codeBlock:
      typeof rawNode.codeBlock === "string"
        ? rawNode.codeBlock.replace(/\r\n?/g, "\n")
        : undefined,
    codeLanguage:
      typeof rawNode.codeLanguage === "string" && rawNode.codeLanguage.trim()
        ? rawNode.codeLanguage.trim().slice(0, 80)
        : undefined,
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
  if (!Array.isArray(rawDocument.nodes)) throw new Error("文档缺少有效主题数组，原文件已保留");
  assertTreeBudget(rawDocument.nodes, { maxDepth: 10_000 });

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
    ...rawDocument,
    id: uniqueId(rawDocument.id, usedIds),
    title: textOr(rawDocument.title, "").trim() || DEFAULT_DOCUMENT_TITLE,
    createdAt: textOr(rawDocument.createdAt, now),
    updatedAt,
    markdownSource,
    markdownUpdatedAt,
    isShortcut: typeof rawDocument.isShortcut === "boolean" ? rawDocument.isShortcut : undefined,
    ...(markdownSource !== undefined ? { markdownSource } : {}),
    ...(markdownUpdatedAt !== undefined ? { markdownUpdatedAt } : {}),
    nodes,
  };
};

export const migrateWorkspace = (rawWorkspace) => {
  if (!isRecord(rawWorkspace) || !Array.isArray(rawWorkspace.documents)) {
    throw new Error("导入文件不是有效工作区");
  }
  if (rawWorkspace.version !== undefined && rawWorkspace.version !== CURRENT_WORKSPACE_VERSION) throw new Error("工作区版本暂不支持，原文件已保留");

  const usedIds = new Set();
  const documents = rawWorkspace.documents.map((document, index) => {
    try {
      return migrateDocument(document, usedIds);
    } catch (error) {
      throw new Error(`第 ${index + 1} 个文档无法读取：${error.message}；原文件已保留`);
    }
  });
  if (!documents.length) throw new Error("工作区至少需要一个文档");

  const requestedActiveId = textOr(rawWorkspace.activeDocumentId, "");
  const activeDocumentId = documents.some(
    (document) => document.id === requestedActiveId,
  )
    ? requestedActiveId
    : documents[0].id;

  const workspace = {
    ...rawWorkspace,
    version: CURRENT_WORKSPACE_VERSION,
    activeDocumentId,
    documents,
  };
  if (Array.isArray(rawWorkspace.trash)) {
    const entryIds = new Set();
    const trash = rawWorkspace.trash.flatMap((rawEntry) => {
      if (
        !isRecord(rawEntry) || Array.isArray(rawEntry) ||
        typeof rawEntry.deletedAt !== "string" ||
        !Number.isFinite(Date.parse(rawEntry.deletedAt)) ||
        !isRecord(rawEntry.document) || Array.isArray(rawEntry.document) ||
        !textOr(rawEntry.document.id, "").trim() ||
        !Array.isArray(rawEntry.document.nodes)
      ) {
        throw new Error("回收站记录无效，原文件已保留");
      }
      let document;
      try {
        document = migrateDocument(rawEntry.document);
      } catch (error) {
        throw new Error(`回收站文档无法读取：${error.message}`);
      }
      const candidate = textOr(rawEntry.id, "").trim();
      const id = candidate && !entryIds.has(candidate)
        ? candidate
        : `trash_${crypto.randomUUID()}`;
      entryIds.add(id);
      const index = rawEntry.originalIndex;
      return [{
        id,
        document,
        deletedAt: rawEntry.deletedAt,
        originalIndex:
          typeof index === "number" && Number.isInteger(index) && index >= 0
            ? index
            : 0,
      }];
    });
    if (trash.length) workspace.trash = trash;
    else delete workspace.trash;
  } else {
    delete workspace.trash;
  }
  return workspace;
};

export const defaultWorkspacePath = ({
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) => {
  return defaultWorkspacePathCandidates({ homeDir, platform })[0];
};

export const defaultWorkspacePathCandidates = ({
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) => {
  if (platform === "darwin") {
    const baseDirectory = path.join(
      homeDir,
      "Library",
      "Mobile Documents",
      "com~apple~CloudDocs",
      "Bike",
    );
    const legacyBaseDirectory = path.join(
      homeDir,
      "Library",
      "Mobile Documents",
      "com~apple~CloudDocs",
      "LocalOutline",
    );
    return [
      path.join(baseDirectory, "bike-workspace.json"),
      path.join(legacyBaseDirectory, "localoutline-workspace.json"),
    ];
  }

  return [
    path.join(homeDir, ".bike", "bike-workspace.json"),
    path.join(homeDir, ".localoutline", "localoutline-workspace.json"),
  ];
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

const envString = (env, key, legacyKey) =>
  env[key]?.trim() || (legacyKey ? env[legacyKey]?.trim() : "");

const normalizeMode = (value) =>
  typeof value === "string" && value.trim().toLowerCase() === "write"
    ? "write"
    : "readonly";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const loadMcpConfig = async ({
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) => {
  const configPath = envString(env, "BIKE_MCP_CONFIG", "LOCAL_OUTLINE_MCP_CONFIG");
  const fileConfig = configPath
    ? await readJsonFile(expandHome(configPath, homeDir))
    : {};

  const configuredWorkspacePath =
    envString(env, "BIKE_WORKSPACE_PATH", "LOCAL_OUTLINE_WORKSPACE_PATH") ||
    (isRecord(fileConfig) && typeof fileConfig.workspacePath === "string"
      ? fileConfig.workspacePath
      : "");

  const rawMode =
    envString(env, "BIKE_MCP_MODE", "LOCAL_OUTLINE_MCP_MODE") ||
    (isRecord(fileConfig) && typeof fileConfig.mode === "string"
      ? fileConfig.mode
      : "readonly");

  const workspacePath = configuredWorkspacePath
    ? path.resolve(expandHome(configuredWorkspacePath, homeDir))
    : await firstExistingPath(
        defaultWorkspacePathCandidates({ homeDir, platform }).map((candidate) =>
          path.resolve(expandHome(candidate, homeDir)),
        ),
      );

  return {
    workspacePath,
    mode: normalizeMode(rawMode),
    debug: optionalBoolean(
      env.BIKE_MCP_DEBUG ?? env.LOCAL_OUTLINE_MCP_DEBUG,
      boolOr(isRecord(fileConfig) ? fileConfig.debug : undefined, false),
    ),
    maxSearchResults: optionalNumber(
      env.BIKE_MCP_MAX_SEARCH_RESULTS ??
        env.LOCAL_OUTLINE_MCP_MAX_SEARCH_RESULTS ??
        (isRecord(fileConfig) ? fileConfig.maxSearchResults : undefined),
      50,
      1,
      HARD_LIMIT,
    ),
    maxDocumentNodes: optionalNumber(
      env.BIKE_MCP_MAX_DOCUMENT_NODES ??
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
    this.mutationQueue = Promise.resolve();
  }

  async readSnapshot({ useCache = true, includeRaw = false } = {}) {
    const stats = await fs.stat(this.config.workspacePath);
    if (!stats.isFile() || stats.size > MAX_DOCUMENT_BYTES) throw new Error("工作区文件无效或超过 64 MiB 读取预算，原文件已保留");
    const cacheKey = `${stats.mtimeMs}:${stats.size}`;
    if (useCache && this.cache?.cacheKey === cacheKey) {
      if (!includeRaw) return this.cache.snapshot;
      return {
        ...this.cache.snapshot,
        raw: await fs.readFile(this.config.workspacePath, "utf8"),
      };
    }

    const raw = await fs.readFile(this.config.workspacePath, "utf8");
    assertTextBudget(raw);
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
    return includeRaw ? { ...snapshot, raw } : snapshot;
  }

  async load() {
    return this.readSnapshot();
  }

  async mutate({
    operation,
    expectedRevision,
    dryRun = true,
    reason = "",
    writeTimestamp = "",
    apply,
  }) {
    const run = () =>
      this.runMutation({
        operation,
        expectedRevision,
        dryRun,
        reason,
        writeTimestamp,
        apply,
      });
    const result = this.mutationQueue.then(run, run);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  async runMutation({
    operation,
    expectedRevision,
    dryRun = true,
    reason = "",
    writeTimestamp = "",
    apply,
  }) {
    if (typeof apply !== "function") throw new Error("缺少写入操作");
    if (!textOr(expectedRevision, "").trim()) {
      throw new Error("写入工具必须提供 expectedRevision");
    }
    const requestedTimestamp = normalizeWriteTimestamp(writeTimestamp);
    const normalizedDryRun = dryRun !== false;
    const run = () =>
      this.runMutationUnlocked({
        operation,
        expectedRevision,
        dryRun: normalizedDryRun,
        reason,
        writeTimestamp: requestedTimestamp,
        apply,
      });

    if (!normalizedDryRun && this.config.mode === "write") {
      return this.withWorkspaceWriteLock(run);
    }

    return run();
  }

  async runMutationUnlocked({
    operation,
    expectedRevision,
    dryRun,
    reason = "",
    writeTimestamp = "",
    apply,
  }) {
    const current = await this.readSnapshot({
      useCache: false,
      includeRaw: true,
    });
    if (expectedRevision !== current.revision) {
      throw new Error("workspace revision 冲突，请重新读取工作区后再写入");
    }

    const now = writeTimestamp || new Date().toISOString();
    assertWorkspaceBudget(current.workspace);
    const draft = cloneWorkspace(current.workspace);
    const preview = apply(draft, { now, current });
    const normalizedWorkspace = migrateWorkspace(draft);
    const nextRaw = `${JSON.stringify(normalizedWorkspace, null, 2)}\n`;
    const nextRevision = hashContent(nextRaw);
    const confirmationArgs = preview.confirmationArgs
      ? {
          ...preview.confirmationArgs,
          ...(textOr(reason, "") ? { reason: textOr(reason, "") } : {}),
          expectedRevision: current.revision,
          dryRun: false,
          writeTimestamp: now,
        }
      : undefined;
    const baseResult = {
      operation,
      dryRun,
      applied: false,
      mode: this.config.mode,
      workspaceRevision: current.revision,
      nextWorkspaceRevision: nextRevision,
      reason: textOr(reason, ""),
      ...preview,
      ...(confirmationArgs ? { confirmationArgs } : {}),
    };
    textToolResult(baseResult);

    if (dryRun) return baseResult;
    if (this.config.mode !== "write") {
      throw new Error("Bike MCP 当前为 readonly 模式，拒绝真实写入");
    }
    const latestRaw = await this.assertCurrentRevision(current.revision);

    const backup = await this.writeBackupSnapshot({
      operation,
      raw: latestRaw,
      now,
    });
    await this.writeWorkspaceAtomically(nextRaw, {
      expectedRevision: current.revision,
    });
    let backupWarning;
    try { await this.pruneBackupSnapshots(backup.filename); }
    catch { backupWarning = "工作区已保存，旧备份清理未完成；最近的恢复副本已保留"; }
    this.cache = null;
    const nextSnapshot = await this.load();

    return {
      ...baseResult,
      applied: true,
      ...(backupWarning ? { backupWarning } : {}),
      workspaceRevision: current.revision,
      nextWorkspaceRevision: nextSnapshot.revision,
      snapshot: backup,
    };
  }

  async withWorkspaceWriteLock(callback) {
    const release = await this.acquireWorkspaceWriteLock();
    try {
      return await callback();
    } finally {
      await release();
    }
  }

  async acquireWorkspaceWriteLock() {
    await assertRegularWriteTarget(this.config.workspacePath);
    const lockPath = workspaceLockPath(this.config.workspacePath);
    const startedAt = Date.now();
    while (Date.now() - startedAt <= WRITE_LOCK_TIMEOUT_MS) {
      const ownerToken = crypto.randomBytes(16).toString("hex");
      try {
        await fs.writeFile(lockPath, this.lockFileContent(ownerToken), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        return async () => {
          await releaseWorkspaceWriteLock(lockPath, ownerToken);
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        await removeStaleLock(lockPath);
        await delay(WRITE_LOCK_RETRY_MS);
      }
    }
    throw new Error("工作区正在被另一个 Bike MCP 写入，请稍后重试");
  }

  lockFileContent(ownerToken) {
    return `${JSON.stringify(
      {
        pid: process.pid,
        ownerToken,
        createdAt: new Date().toISOString(),
        workspacePath: path.basename(this.config.workspacePath),
      },
      null,
      2,
    )}\n`;
  }

  async assertCurrentRevision(expectedRevision) {
    const raw = await fs.readFile(this.config.workspacePath, "utf8");
    if (hashContent(raw) !== expectedRevision) {
      throw new Error("workspace revision 冲突，请重新读取工作区后再写入");
    }
    return raw;
  }

  async writeBackupSnapshot({ operation, raw, now }) {
    const backupDirectory = path.join(
      path.dirname(this.config.workspacePath),
      ".backups",
    );
    await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(backupDirectory, 0o700);
    const revisionPrefix = hashContent(raw).slice(0, 12);
    const randomSuffix = crypto.randomBytes(4).toString("hex");
    const filename = `bike-mcp-${backupTimestamp(now)}-${revisionPrefix}-${sanitizeOperationName(operation)}-${randomSuffix}.json`;
    const backupPath = path.join(backupDirectory, filename);
    await fs.writeFile(backupPath, raw, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return {
      filename,
      path: this.config.debug ? backupPath : path.join(".backups", filename),
      pathIsRedacted: !this.config.debug,
      createdAt: now,
    };
  }

  async pruneBackupSnapshots(keepFilename) {
    const directory = path.join(path.dirname(this.config.workspacePath), ".backups");
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.filter((entry) => entry.isFile() && /^bike-mcp-.*\.json$/u.test(entry.name)).map(async (entry) => ({ name: entry.name, ...(await fs.stat(path.join(directory, entry.name))) })));
    files.sort((left, right) => Number(right.name === keepFilename) - Number(left.name === keepFilename) || right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
    let bytes = 0;
    for (let i = 0; i < files.length; i++) {
      bytes += files[i].size;
      if (i > 0 && (i >= 20 || bytes > 64 * 1024 * 1024)) await fs.rm(path.join(directory, files[i].name));
    }
  }

  async writeWorkspaceAtomically(raw, { expectedRevision } = {}) {
    const directory = path.dirname(this.config.workspacePath);
    const basename = path.basename(this.config.workspacePath);
    const tempPath = path.join(
      directory,
      `.${basename}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`,
    );
    const original = await assertRegularWriteTarget(this.config.workspacePath);
    try {
      await writeFileDurably(tempPath, raw, original ? original.mode & 0o777 : 0o600);
      if (expectedRevision) await this.assertCurrentRevision(expectedRevision);
      await assertRegularWriteTarget(this.config.workspacePath);
      await fs.rename(tempPath, this.config.workspacePath);
      await fsyncDirectory(directory);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => {});
      throw error;
    }
  }
}

export const createWorkspaceStore = async (options = {}) =>
  new WorkspaceStore(options.config ?? (await loadMcpConfig(options)));

const hashContent = (value) => crypto.createHash("sha256").update(value).digest("hex");

const cloneWorkspace = (workspace) => JSON.parse(JSON.stringify(workspace));

const writeFileDurably = async (filePath, content, mode) => {
  const handle = await fs.open(filePath, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const fsyncDirectory = async (directory) => {
  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not supported on every platform/filesystem.
  }
};

const workspaceLockPath = (workspacePath) =>
  path.join(path.dirname(workspacePath), `.${path.basename(workspacePath)}.lock`);

const parseWorkspaceLock = (raw) => {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) && typeof parsed.ownerToken === "string"
      ? parsed
      : {};
  } catch {
    return {};
  }
};

const readWorkspaceLock = async (lockPath) => {
  const [raw, stats] = await Promise.all([
    fs.readFile(lockPath, "utf8"),
    fs.stat(lockPath),
  ]);
  return {
    raw,
    ownerToken: parseWorkspaceLock(raw).ownerToken,
    pid: parseWorkspaceLock(raw).pid,
    modifiedAt: stats.mtimeMs,
  };
};

const unlinkLockIfRawMatches = async (lockPath, raw) => {
  try {
    if ((await fs.readFile(lockPath, "utf8")) === raw) {
      await fs.unlink(lockPath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
};

const releaseWorkspaceWriteLock = async (lockPath, ownerToken) => {
  try {
    const lock = await readWorkspaceLock(lockPath);
    if (lock.ownerToken === ownerToken) await unlinkLockIfRawMatches(lockPath, lock.raw);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
};

const removeStaleLock = async (lockPath) => {
  try {
    const lock = await readWorkspaceLock(lockPath);
    if (Date.now() - lock.modifiedAt >= WRITE_LOCK_STALE_MS && !isProcessAlive(lock.pid)) {
      if (lock.ownerToken) {
        await releaseWorkspaceWriteLock(lockPath, lock.ownerToken);
      } else {
        await unlinkLockIfRawMatches(lockPath, lock.raw);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
};

const normalizeWriteTimestamp = (value) => {
  const requested = textOr(value, "").trim();
  if (!requested) return "";
  const match = ISO_UTC_TIMESTAMP_PATTERN.exec(requested);
  if (!match) {
    throw new Error(
      "writeTimestamp 必须是 ISO 8601 UTC 时间，例如 2026-06-05T08:00:00.000Z",
    );
  }
  const parsed = Date.parse(requested);
  const canonical = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== canonical) {
    throw new Error(
      "writeTimestamp 必须是 ISO 8601 UTC 时间，例如 2026-06-05T08:00:00.000Z",
    );
  }
  return canonical;
};

const backupTimestamp = (iso) =>
  new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "-$1Z");

const sanitizeOperationName = (value) =>
  textOr(value, "write")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "write";

const collectUsedIds = (workspace) => {
  const usedIds = new Set();
  const stack = [];
  for (const document of workspace.documents || []) {
    usedIds.add(document.id);
    for (const node of document.nodes || []) stack.push(node);
  }
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    usedIds.add(node.id);
    for (const child of nodeChildren(node)) stack.push(child);
  }
  return usedIds;
};

const createdNodeIds = (nodes) => {
  const ids = [];
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    ids.push(node.id);
    for (const child of nodeChildren(node)) stack.push(child);
  }
  return ids;
};

const subtreeMaxRelativeDepth = (node) => {
  let maxDepth = 0;
  const stack = [{ node, depth: 0 }];
  while (stack.length) {
    const frame = stack.pop();
    if (!frame?.node) continue;
    maxDepth = Math.max(maxDepth, frame.depth);
    const children = nodeChildren(frame.node);
    for (let index = 0; index < children.length; index += 1) {
      stack.push({ node: children[index], depth: frame.depth + 1 });
    }
  }
  return maxDepth;
};

const writeNodeLimits = (store) => ({
  maxDepth: MAX_WRITE_NODE_DEPTH,
  maxNodes: optionalNumber(store?.config?.maxDocumentNodes, 2000, 1, 50000),
});

const assertWritableNodeBudget = (
  rawNodes,
  { maxDepth = MAX_WRITE_NODE_DEPTH, maxNodes, existingNodes = 0, baseDepth = 0 },
) => {
  const roots = Array.isArray(rawNodes) ? rawNodes : [rawNodes];
  let addedNodes = 0;
  const stack = roots.map((node) => ({ node, depth: baseDepth }));

  while (stack.length) {
    const frame = stack.pop();
    addedNodes += 1;
    if (frame.depth > maxDepth) {
      throw new Error(`写入节点深度超过上限 ${maxDepth}`);
    }
    if (existingNodes + addedNodes > maxNodes) {
      throw new Error(`写入节点数量超过上限 ${maxNodes}`);
    }

    const children = isRecord(frame.node) && Array.isArray(frame.node.children)
      ? frame.node.children
      : [];
    for (let index = 0; index < children.length; index += 1) {
      stack.push({ node: children[index], depth: frame.depth + 1 });
    }
  }

  return addedNodes;
};

const nodeConfirmationFields = (node) => ({
  id: node.id,
  text: node.text,
  note: node.note,
  checked: node.checked === true,
  collapsed: node.collapsed === true,
  color: normalizeColor(node.color),
  codeBlock: typeof node.codeBlock === "string" ? node.codeBlock : undefined,
  codeLanguage: typeof node.codeLanguage === "string" ? node.codeLanguage : undefined,
  isTodo: node.isTodo === true,
  children: [],
});

const nodeConfirmationInput = (node) => {
  const root = nodeConfirmationFields(node);
  const stack = [{ source: node, target: root }];

  while (stack.length) {
    const { source, target } = stack.pop();
    const children = nodeChildren(source);
    for (let index = 0; index < children.length; index += 1) {
      const child = nodeConfirmationFields(children[index]);
      target.children[index] = child;
      stack.push({ source: children[index], target: child });
    }
  }

  return root;
};

const createWritableNodeShallow = (rawNode = {}, usedIds) => {
  const raw = isRecord(rawNode) ? rawNode : {};
  const node = {
    ...createNode(textOr(raw.text, DEFAULT_NODE_TEXT)),
    id: uniqueId(raw.id, usedIds),
    note: textOr(raw.note, ""),
    checked: raw.checked === true,
    collapsed: raw.collapsed === true,
    color: normalizeColor(textOr(raw.color, "plain")),
    codeBlock:
      typeof raw.codeBlock === "string"
        ? raw.codeBlock.replace(/\r\n?/g, "\n")
        : undefined,
    codeLanguage:
      typeof raw.codeLanguage === "string" && raw.codeLanguage.trim()
        ? raw.codeLanguage.trim().slice(0, 80)
        : undefined,
    isTodo: raw.isTodo === true || raw.checked === true,
    children: [],
  };

  return node;
};

const createWritableNode = (rawNode = {}, usedIds) => {
  const root = createWritableNodeShallow(rawNode, usedIds);
  const stack = [{ rawNode, target: root }];

  while (stack.length) {
    const frame = stack.pop();
    const children = isRecord(frame.rawNode) && Array.isArray(frame.rawNode.children)
      ? frame.rawNode.children
      : [];
    for (let index = 0; index < children.length; index += 1) {
      const child = createWritableNodeShallow(children[index], usedIds);
      frame.target.children[index] = child;
      stack.push({ rawNode: children[index], target: child });
    }
  }

  return root;
};

const workspaceDocumentById = (workspace, documentId) => {
  const document = workspace.documents.find((candidate) => candidate.id === documentId);
  if (!document) throw new Error(`找不到文档：${documentId}`);
  if (document.knowledge) document.knowledge = anchorMarkdownReferences(document);
  return document;
};

const locateNodeMutable = (nodes, nodeId) => {
  const stack = [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    stack.push({ node: nodes[index], path: [index] });
  }

  while (stack.length) {
    const frame = stack.pop();
    if (!frame?.node) continue;
    if (frame.node.id === nodeId) return { node: frame.node, path: frame.path };
    const children = nodeChildren(frame.node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: children[index],
        path: [...frame.path, index],
      });
    }
  }

  return null;
};

const siblingsAtPathMutable = (nodes, nodePath) => {
  if (nodePath.length === 1) return nodes;
  let parent = nodes[nodePath[0]];
  for (let index = 1; index < nodePath.length - 1; index += 1) {
    parent = parent.children[nodePath[index]];
  }
  return parent.children;
};

const insertNodes = ({ document, parentNodeId, nodes, position = "last" }) => {
  let container = document.nodes;
  let parent = null;
  if (parentNodeId) {
    const locatedParent = locateNodeMutable(document.nodes, parentNodeId);
    if (!locatedParent) throw new Error(`找不到父节点：${parentNodeId}`);
    parent = locatedParent.node;
    parent.collapsed = false;
    container = parent.children;
  }
  const index = position === "first" ? 0 : container.length;
  container.splice(index, 0, ...nodes);
  return {
    parentId: parent?.id ?? null,
    index,
    insertedNodeIds: createdNodeIds(nodes),
  };
};

const markDocumentUpdated = (document, now) => {
  if (document.knowledge) document.knowledge = anchorMarkdownReferences(document);
  document.updatedAt = now;
  delete document.markdownSource;
  delete document.markdownUpdatedAt;
};

const writeResult = ({
  operation,
  summary,
  documentIds = [],
  nodeIds = [],
  changes = [],
  confirmationArgs,
}) => ({
  summary,
  affected: {
    documentIds,
    nodeIds,
  },
  preview: {
    operation,
    changes,
  },
  ...(confirmationArgs ? { confirmationArgs } : {}),
});

const hasOwn = (value, key) =>
  Object.prototype.hasOwnProperty.call(isRecord(value) ? value : {}, key);

const updateNodeFields = (node, args) => {
  const changes = [];
  const setField = (field, value, normalizer = (next) => next) => {
    if (!hasOwn(args, field)) return;
    const nextValue = normalizer(value);
    if (node[field] === nextValue) return;
    changes.push({ field, before: node[field], after: nextValue });
    node[field] = nextValue;
  };

  setField("text", args.text, (value) => textOr(value, ""));
  setField("note", args.note, (value) => textOr(value, ""));
  setField("color", args.color, (value) => normalizeColor(textOr(value, "plain")));
  setField("collapsed", args.collapsed, (value) => value === true);
  setField("checked", args.checked, (value) => value === true);
  setField("isTodo", args.isTodo, (value) => value === true);
  setField("codeBlock", args.codeBlock, (value) =>
    typeof value === "string" ? value.replace(/\r\n?/g, "\n") : undefined,
  );
  setField("codeLanguage", args.codeLanguage, (value) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : undefined,
  );
  if (changes.some((change) => change.field === "checked") && node.checked) {
    node.isTodo = true;
  }
  return changes;
};

export const createDocumentForMcp = async (store, args = {}) =>
  store.mutate({
    operation: "create_document",
    expectedRevision: args.expectedRevision,
    dryRun: args.dryRun,
    reason: args.reason,
    writeTimestamp: args.writeTimestamp,
    apply: (workspace, { now }) => {
      const limits = writeNodeLimits(store);
      const usedIds = collectUsedIds(workspace);
      assertWritableNodeBudget(
        Array.isArray(args.initialNodes) && args.initialNodes.length
          ? args.initialNodes
          : [{ text: DEFAULT_NODE_TEXT }],
        limits,
      );
      const initialNodes = Array.isArray(args.initialNodes)
        ? args.initialNodes.map((node) => createWritableNode(node, usedIds))
        : [];
      const document = {
        id: uniqueDocumentId(args.documentId, usedIds),
        title: textOr(args.title, "").trim() || DEFAULT_DOCUMENT_TITLE,
        createdAt: now,
        updatedAt: now,
        nodes: initialNodes.length
          ? initialNodes
          : [createWritableNode({ text: DEFAULT_NODE_TEXT }, usedIds)],
      };
      workspace.documents.push(document);
      workspace.activeDocumentId = document.id;
      return writeResult({
        operation: "create_document",
        summary: `创建文档：${document.title}`,
        documentIds: [document.id],
        nodeIds: createdNodeIds(document.nodes),
        changes: [
          {
            type: "create_document",
            documentId: document.id,
            title: document.title,
            nodeCount: countNodes(document.nodes),
          },
        ],
        confirmationArgs: {
          documentId: document.id,
          title: document.title,
          initialNodes: document.nodes.map(nodeConfirmationInput),
        },
      });
    },
  });

export const updateDocumentTitleForMcp = async (store, args = {}) =>
  store.mutate({
    operation: "update_document_title",
    expectedRevision: args.expectedRevision,
    dryRun: args.dryRun,
    reason: args.reason,
    writeTimestamp: args.writeTimestamp,
    apply: (workspace, { now }) => {
      const document = workspaceDocumentById(workspace, args.documentId);
      const title = textOr(args.title, "").trim();
      if (!title) throw new Error("title 不能为空");
      const before = document.title;
      const renamed = renameTarget(workspace, { documentId: document.id, previousLabel: before, nextLabel: title, mutate: true });
      for (const id of renamed.updatedDocumentIds) {
        const updated = workspace.documents.find((item) => item.id === id);
        if (updated) markDocumentUpdated(updated, now);
      }
      if (!renamed.updatedDocumentIds.length) markDocumentUpdated(document, now);
      return writeResult({
        operation: "update_document_title",
        summary: `更新文档标题：${before} -> ${title}`,
        documentIds: [document.id],
        changes: [
          {
            type: "update_document_title",
            documentId: document.id,
            field: "title",
            before,
            after: title,
          },
        ],
        confirmationArgs: {
          documentId: document.id,
          title,
        },
      });
    },
  });

export const createNodeForMcp = async (store, args = {}) =>
  store.mutate({
    operation: "create_node",
    expectedRevision: args.expectedRevision,
    dryRun: args.dryRun,
    reason: args.reason,
    writeTimestamp: args.writeTimestamp,
    apply: (workspace, { now }) => {
      const document = workspaceDocumentById(workspace, args.documentId);
      const parent = args.parentNodeId
        ? locateNodeMutable(document.nodes, args.parentNodeId)
        : null;
      if (args.parentNodeId && !parent) {
        throw new Error(`找不到父节点：${args.parentNodeId}`);
      }
      const parentDepth = parent ? parent.path.length : 0;
      const limits = writeNodeLimits(store);
      assertWritableNodeBudget(args, {
        ...limits,
        existingNodes: countNodes(document.nodes),
        baseDepth: parentDepth,
      });
      const usedIds = collectUsedIds(workspace);
      const node = createWritableNode(args, usedIds);
      const insertion = insertNodes({
        document,
        parentNodeId: args.parentNodeId,
        nodes: [node],
        position: args.position,
      });
      markDocumentUpdated(document, now);
      return writeResult({
        operation: "create_node",
        summary: `创建节点：${node.text || DEFAULT_NODE_TEXT}`,
        documentIds: [document.id],
        nodeIds: insertion.insertedNodeIds,
        changes: [
          {
            type: "create_node",
            documentId: document.id,
            parentNodeId: insertion.parentId,
            index: insertion.index,
            nodeId: node.id,
            text: node.text,
          },
        ],
        confirmationArgs: {
          documentId: document.id,
          ...(insertion.parentId ? { parentNodeId: insertion.parentId } : {}),
          position: args.position === "first" ? "first" : "last",
          ...nodeConfirmationInput(node),
        },
      });
    },
  });

export const appendChildrenForMcp = async (store, args = {}) =>
  store.mutate({
    operation: "append_children",
    expectedRevision: args.expectedRevision,
    dryRun: args.dryRun,
    reason: args.reason,
    writeTimestamp: args.writeTimestamp,
    apply: (workspace, { now }) => {
      const document = workspaceDocumentById(workspace, args.documentId);
      if (!Array.isArray(args.children) || args.children.length === 0) {
        throw new Error("children 至少需要一个节点");
      }
      const parent = args.parentNodeId
        ? locateNodeMutable(document.nodes, args.parentNodeId)
        : null;
      if (args.parentNodeId && !parent) {
        throw new Error(`找不到父节点：${args.parentNodeId}`);
      }
      const parentDepth = parent ? parent.path.length : 0;
      const limits = writeNodeLimits(store);
      assertWritableNodeBudget(args.children, {
        ...limits,
        existingNodes: countNodes(document.nodes),
        baseDepth: parentDepth,
      });
      const usedIds = collectUsedIds(workspace);
      const nodes = args.children.map((node) => createWritableNode(node, usedIds));
      const insertion = insertNodes({
        document,
        parentNodeId: args.parentNodeId,
        nodes,
        position: "last",
      });
      markDocumentUpdated(document, now);
      return writeResult({
        operation: "append_children",
        summary: `追加 ${nodes.length} 个子节点`,
        documentIds: [document.id],
        nodeIds: insertion.insertedNodeIds,
        changes: [
          {
            type: "append_children",
            documentId: document.id,
            parentNodeId: insertion.parentId,
            index: insertion.index,
            count: nodes.length,
            nodeIds: insertion.insertedNodeIds,
          },
        ],
        confirmationArgs: {
          documentId: document.id,
          ...(insertion.parentId ? { parentNodeId: insertion.parentId } : {}),
          children: nodes.map(nodeConfirmationInput),
        },
      });
    },
  });

export const updateNodeForMcp = async (store, args = {}) =>
  store.mutate({
    operation: "update_node",
    expectedRevision: args.expectedRevision,
    dryRun: args.dryRun,
    reason: args.reason,
    writeTimestamp: args.writeTimestamp,
    apply: (workspace, { now }) => {
      const document = workspaceDocumentById(workspace, args.documentId);
      let located = locateNodeMutable(document.nodes, args.nodeId);
      if (!located) throw new Error(`找不到节点：${args.nodeId}`);
      const beforeText = located.node.text;
      if (hasOwn(args, "text") && textOr(args.text, "") !== beforeText) {
        const renamed = renameTarget(workspace, {
          documentId: document.id,
          nodeId: located.node.id,
          previousLabel: beforeText,
          nextLabel: textOr(args.text, ""),
          mutate: true,
        });
        for (const id of renamed.updatedDocumentIds) {
          const updated = workspace.documents.find((item) => item.id === id);
          if (updated && updated.id !== document.id) markDocumentUpdated(updated, now);
        }
        located = locateNodeMutable(document.nodes, args.nodeId);
      }
      const fieldChanges = updateNodeFields(located.node, args);
      if (!fieldChanges.length && beforeText === located.node.text) throw new Error("至少需要提供一个可更新字段");
      if (fieldChanges.some((change) => change.field === "note") && knowledgeEditable(document.knowledge)) {
        document.knowledge = relocateFieldReferences(document.knowledge, {
          nodeId: located.node.id,
          field: "note",
          text: located.node.note,
          previousText: fieldChanges.find((change) => change.field === "note")?.before,
        });
      }
      if (hasOwn(args, "text") && !fieldChanges.some((change) => change.field === "text")) {
        fieldChanges.unshift({ field: "text", before: beforeText, after: located.node.text });
      }
      markDocumentUpdated(document, now);
      return writeResult({
        operation: "update_node",
        summary: `更新节点：${located.node.text || DEFAULT_NODE_TEXT}`,
        documentIds: [document.id],
        nodeIds: [located.node.id],
        changes: [
          {
            type: "update_node",
            documentId: document.id,
            nodeId: located.node.id,
            path: located.path,
            fields: fieldChanges,
          },
        ],
        confirmationArgs: {
          documentId: document.id,
          nodeId: located.node.id,
          ...Object.fromEntries(
            fieldChanges.map((change) => [change.field, change.after]),
          ),
        },
      });
    },
  });

export const setNodeCheckedForMcp = async (store, args = {}) =>
  store.mutate({
    operation: "set_node_checked",
    expectedRevision: args.expectedRevision,
    dryRun: args.dryRun,
    reason: args.reason,
    writeTimestamp: args.writeTimestamp,
    apply: (workspace, { now }) => {
      const document = workspaceDocumentById(workspace, args.documentId);
      const located = locateNodeMutable(document.nodes, args.nodeId);
      if (!located) throw new Error(`找不到节点：${args.nodeId}`);
      const before = located.node.checked === true;
      const checked = args.checked === true;
      located.node.checked = checked;
      located.node.isTodo = true;
      markDocumentUpdated(document, now);
      return writeResult({
        operation: "set_node_checked",
        summary: `${checked ? "完成" : "取消完成"}节点：${located.node.text || DEFAULT_NODE_TEXT}`,
        documentIds: [document.id],
        nodeIds: [located.node.id],
        changes: [
          {
            type: "set_node_checked",
            documentId: document.id,
            nodeId: located.node.id,
            path: located.path,
            field: "checked",
            before,
            after: checked,
          },
        ],
        confirmationArgs: {
          documentId: document.id,
          nodeId: located.node.id,
          checked,
        },
      });
    },
  });

export const moveNodeForMcp = async (store, args = {}) =>
  store.mutate({
    operation: "move_node",
    expectedRevision: args.expectedRevision,
    dryRun: args.dryRun,
    reason: args.reason,
    writeTimestamp: args.writeTimestamp,
    apply: (workspace, { now }) => {
      const document = workspaceDocumentById(workspace, args.documentId);
      const source = locateNodeMutable(document.nodes, args.nodeId);
      if (!source) throw new Error(`找不到节点：${args.nodeId}`);
      if (args.targetParentNodeId === args.nodeId) {
        throw new Error("不能把节点移动到自身下面");
      }
      const targetBeforeMove = args.targetParentNodeId
        ? locateNodeMutable(document.nodes, args.targetParentNodeId)
        : null;
      if (args.targetParentNodeId && !targetBeforeMove) {
        throw new Error(`找不到目标父节点：${args.targetParentNodeId}`);
      }
      if (
        targetBeforeMove &&
        targetBeforeMove.path.length > source.path.length &&
        source.path.every((part, index) => targetBeforeMove.path[index] === part)
      ) {
        throw new Error("不能把节点移动到自己的子节点下面");
      }
      const targetBaseDepth = targetBeforeMove ? targetBeforeMove.path.length : 0;
      const nextMaxDepth = targetBaseDepth + subtreeMaxRelativeDepth(source.node);
      const { maxDepth } = writeNodeLimits(store);
      if (nextMaxDepth > maxDepth) {
        throw new Error(`写入节点深度超过上限 ${maxDepth}`);
      }

      const sourceSiblings = siblingsAtPathMutable(document.nodes, source.path);
      const [node] = sourceSiblings.splice(source.path[source.path.length - 1], 1);
      let targetContainer = document.nodes;
      let parentId = null;
      if (args.targetParentNodeId) {
        const target = locateNodeMutable(document.nodes, args.targetParentNodeId);
        if (!target) throw new Error(`找不到目标父节点：${args.targetParentNodeId}`);
        target.node.collapsed = false;
        targetContainer = target.node.children;
        parentId = target.node.id;
      }
      const index = args.position === "first" ? 0 : targetContainer.length;
      targetContainer.splice(index, 0, node);
      const moved = locateNodeMutable(document.nodes, node.id);
      markDocumentUpdated(document, now);
      return writeResult({
        operation: "move_node",
        summary: `移动节点：${node.text || DEFAULT_NODE_TEXT}`,
        documentIds: [document.id],
        nodeIds: [node.id],
        changes: [
          {
            type: "move_node",
            documentId: document.id,
            nodeId: node.id,
            beforePath: source.path,
            afterPath: moved?.path ?? [],
            targetParentNodeId: parentId,
            index,
          },
        ],
        confirmationArgs: {
          documentId: document.id,
          nodeId: node.id,
          ...(parentId ? { targetParentNodeId: parentId } : {}),
          position: args.position === "first" ? "first" : "last",
        },
      });
    },
  });

export const deleteNodeForMcp = async (store, args = {}) =>
  store.mutate({
    operation: "delete_node",
    expectedRevision: args.expectedRevision,
    dryRun: args.dryRun,
    reason: args.reason,
    writeTimestamp: args.writeTimestamp,
    apply: (workspace, { now }) => {
      const document = workspaceDocumentById(workspace, args.documentId);
      const located = locateNodeMutable(document.nodes, args.nodeId);
      if (!located) throw new Error(`找不到节点：${args.nodeId}`);
      const deletedIds = createdNodeIds([located.node]);
      const deletedText = located.node.text || DEFAULT_NODE_TEXT;
      const siblings = siblingsAtPathMutable(document.nodes, located.path);
      siblings.splice(located.path[located.path.length - 1], 1);
      if (document.nodes.length === 0) {
        document.nodes.push(createWritableNode({ text: DEFAULT_NODE_TEXT }, collectUsedIds(workspace)));
      }
      markDocumentUpdated(document, now);
      return writeResult({
        operation: "delete_node",
        summary: `删除节点：${deletedText}`,
        documentIds: [document.id],
        nodeIds: deletedIds,
        changes: [
          {
            type: "delete_node",
            documentId: document.id,
            nodeId: args.nodeId,
            path: located.path,
            deletedNodeCount: deletedIds.length,
          },
        ],
        confirmationArgs: {
          documentId: document.id,
          nodeId: args.nodeId,
        },
      });
    },
  });

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
      if (matches.length >= max) {
        return {
          query: trimmedQuery,
          limit: max,
          matches,
          truncated: true,
        };
      }
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
        if (matches.length >= max) {
          return {
            query: trimmedQuery,
            limit: max,
            matches,
            truncated: true,
          };
        }
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
  codeBlock: entry.node.codeBlock,
  codeLanguage: entry.node.codeLanguage,
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
    ...(() => {
      const knowledge = summarizeKnowledge(snapshot.workspace, document, { limit: 40 });
      return { knowledge, truncated: budget.truncated || knowledge.truncated };
    })(),
    nodes,
  };
};

export { markdownInlineForExport } from "../shared/bike-markdown.mjs";

export const documentToMarkdown = (document, options = {}) => {
  const exported = finalizeMarkdownExport(renderDocumentMarkdown(document), document, { metadata: options.metadata === true });
  if (options.metadata && exported.error) throw new Error(exported.error);
  return exported.content;
};

const sanitizeFilenameBase = (value) => {
  const sanitized = Array.from(textOr(value, "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .replace(/[.\s]+$/g, "")
    ).slice(0, 120).join("");

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
  { documentId, format = "compact", maxDepth = 6, metadata = false } = {},
) => {
  const document = documentById(snapshot, documentId);
  if (format !== "compact") assertDocumentBudget(document);
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
      content: documentToMarkdown(document, { metadata }),
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
  { documentId, format = "json", metadata = false } = {},
) => {
  const document = documentById(snapshot, documentId);
  assertDocumentBudget(document);
  if (format === "markdown") {
    return {
      filename: exportFilename(document.title, metadata ? "bike.md" : "md"),
      mime: "text/markdown",
      content: documentToMarkdown(document, { metadata }),
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
      ? `bike://document-markdown/${encodeURIComponent(document.id)}`
      : `bike://document/${encodeURIComponent(document.id)}`,
    name: isMarkdown ? `${document.title}.md` : document.title,
    title: isMarkdown ? `${document.title} Markdown` : document.title,
    description: isMarkdown
      ? "Bike 文档的 Markdown 视图"
      : "Bike 文档的 compact JSON 视图",
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

export const textToolResult = (data) => {
  assertValueBudget(data, { maxDepth: 600, maxBytes: 8 * 1024 * 1024 });
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  assertTextBudget(text, 8 * 1024 * 1024);
  return ({
  content: [
    {
      type: "text",
      text,
    },
  ],
  ...(typeof data === "string" ? {} : { structuredContent: data }),
  });
};
