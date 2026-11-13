import { useVirtualOutline } from "./virtualOutline";
import { applyLiveCandidatePatch } from "../shared/bike-live-patch.mjs";
import { lockWorkspaceInteraction } from "./interactionLock";
import { markdownInlineTokens } from "./markdownInline";
import { Modal } from "./components/Modal";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { observeTextareaLayout, requestTextareaResize } from "./textareaLayout";
import {
  ArrowDown,
  ArrowUp,
  Bold,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock,
  Cloud,
  Code2,
  Columns2,
  Copy,
  Download,
  Eye,
  FileDown,
  FileJson,
  FileText,
  Focus,
  FolderOpen,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  History,
  Image,
  Indent,
  Italic,
  LayoutList,
  List,
  ListChecks,
  Link2,
  ListTree,
  Maximize2,
  Moon,
  Palette,
  PanelRight,
  Pause,
  Pencil,
  Play,
  Plus,
  Presentation,
  Quote,
  RefreshCw,
  Redo2,
  RotateCcw,
  Search,
  Smile,
  Sparkles,
  Star,
  Strikethrough,
  Sun,
  Table,
  Tag,
  Trash2,
  Type,
  Underline,
  Undo2,
  Upload,
  WandSparkles,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  defaultAiConfig,
  generatedNodesToOutlineNodes,
  loadAiConfig,
  normalizeAiConfig,
  runAiNodeAction,
  requestAiJson,
  saveAiConfig,
  validateAiConfig,
  type AiApiConfig,
  type AiGeneratedNode,
  type AiNodeAction,
} from "./ai";
import { saveICloudBackup } from "./backup";
import { KNOWLEDGE_ACTIONS, workflowContext, workflowInstructions, buildKnowledgeProposal } from "./knowledgeWorkflow";
import { operationRecoveryProposal, conflictResolutionProposal } from "./operationRecovery";
import type { ReplicaState } from "../shared/bike-replica.mjs";
import type { KnowledgeAction } from "./knowledgeWorkflow";
import { ExportMenu } from "./components/ExportMenu";
import { ProposalDialog } from "./components/ProposalDialog";
import { createWorkspaceProposal, acceptProposalGroups, proposalFreshness } from "../shared/bike-proposals.mjs";
import type { WorkspaceProposal } from "../shared/bike-proposals.mjs";
import { replicaProtectedAssetIds } from "../shared/bike-replica.mjs";
import { canonicalJson } from "../shared/bike-operations.mjs";
import { sha256Hex } from "./knowledge";
import { syncOperationWorkspace, enableOperationSync } from "./operationSync";
import { BackupSettingsDialog } from "./components/BackupSettingsDialog";
import { KnowledgePanel } from "./components/KnowledgePanel";
import { LinkAutocomplete } from "./components/LinkAutocomplete";
import { LinkInput } from "./components/LinkInput";
import { SearchResults } from "./components/SearchResults";
import { SearchControls } from "./components/SearchControls";
import { TrashDialog } from "./components/TrashDialog";
import { VersionHistoryDialog } from "./components/VersionHistoryDialog";
import { LocalMigrationDialog, LocalMigrationArchivesDialog } from "./components/LocalMigrationDialog";
import { createLocalMigrationExport, installLocalMigrationExport, recoverInterruptedLocalMigration, validateLocalMigrationImport, type LocalMigrationOptions } from "./localMigration";
import { readLocalMigration } from "../shared/bike-local-migration.mjs";
import type { LocalMigrationCopy } from "../shared/bike-local-migration.mjs";
import { AttachmentActionsContext, AttachmentItems, AttachmentItem, AttachmentPanel, useAttachmentActions } from "./components/Attachments";
import { mergeAttachmentMetadata, workspaceFormatVersion, workspaceAttachmentAssets, MAX_IMPORT_BYTES, MAX_IMPORT_FILES, MAX_ATTACHMENT_BYTES } from "../shared/bike-attachments.mjs";
import type { AttachmentMetadata } from "../shared/bike-attachments.mjs";
import {
  activeLinkQuery,
  addRelation,
  anchorMarkdownReferences,
  attachReference,
  backlinksFor,
  backupContentHash,
  buildKnowledgeIndex,
  copiedKnowledgeFragment,
  createBackupSchedule,
  deleteRelation,
  deleteNavigationFilter,
  renameNavigationFilter,
  relationView,
  updateRelation,
  foldKey,
  expandAncestors,
  formatWikiLink,
  insertLinkAtQuery,
  knowledgeEditable,
  normalizeNavigation,
  pruneNavigation,
  pruneBackupPayloads,
  readBikeMetadata,
  reduceBackupSchedule,
  rekeyNodes as rekeyKnowledgeNodes,
  relocateMarkdownReferences,
  reconcileMarkdownReferences,
  rememberOpen,
  renameTarget,
  resetRecentOpens,
  moveSubtreeConnections,
  resolveDocumentConnections,
  resolveWikiLink,
  reverseRelation,
  remapCollidingIds,
  retargetIncomingNodes,
  scanLinks,
  saveNavigationFilter,
  searchKnowledge,
  suggestLinkTargets,
  toggleFavorite,
  withFieldText,
  type LinkOrigin,
  type NavigationState,
  type Suggestion,
} from "./knowledge";
import { sameDocumentContent, sameWorkspaceContent } from "./documentSignature";
import {
  emptyEditHistory,
  historyMemoryUsage,
  recordChange,
  redo,
  undo,
  type EditOptions,
  type EditHistory,
} from "./editHistory";
import {
  downloadText,
  exportDocument,
  exportDocumentAsPdf,
  exportWorkspace,
  importDocument,
} from "./exporters";
import { documentToMarkdown, markdownLinkOrigins, markdownPlainText, markdownSourceMap, markdownTableCells, parseMarkdownDocument } from "./markdown";
import { firstDocument, migrateWorkspace } from "./migrations";
import { createStarterWorkspace } from "./sample";
import {
  discardWorkspaceRecoverySnapshot,
  getWorkspaceSaveRevision,
  isWorkspacePersisted,
  listWorkspaceRecoverySnapshots,
  listWorkspaceRecoveryFiles,
  loadWorkspace,
  loadPreAttachmentWorkspace,
  readReplicaState,
  queryOperationReceipt,
  markWorkspaceOperation,
  attachmentRecoveryRoots,
  listLocalMigrationArchives,
  listLocalMigrationProtectedAssetIds,
  localMigrationWasInstalled,
  readLocalMigrationJournal,
  reloadWorkspaceIf,
  saveWorkspace as saveWorkspaceToStorage,
  saveWorkspaceFallback,
  subscribeToWorkspaceChanges,
  subscribeToWorkspaceConflicts,
  type WorkspaceRecoverySnapshot,
  type WorkspaceRecoveryFile,
  type WorkspaceSaveResult,
} from "./storage";
import { readPreference, writePreference } from "./navigationStore";
import { safeMarkdownUrl } from "./safeUrl";
import {
  loadSyncConfig,
  loadSyncState,
  emptySyncState,
  normalizeAutoSyncInterval,
  normalizeSyncServerUrl,
  pullWorkspaceFromRemote,
  pushWorkspaceToRemote,
  saveSyncConfig,
  saveSyncState,
  syncWorkspaceWithRemote,
  type SyncConfig,
  type SyncState,
  type SyncSummary,
} from "./sync";
import type { OutlineDocument, OutlineNode, ViewMode, Workspace } from "./types";
import { uuid } from "./id";
import { exportMindMap } from "./mindMapExport";
import { assertWorkspaceBudget, assertTreeBudget } from "../shared/bike-limits.mjs";
import {
  addChild,
  cloneNodes,
  countNodes,
  createNode,
  extractLinks,
  extractTags,
  findNode,
  firstNodeId,
  flattenNodes,
  indentNode,
  insertParent,
  insertSiblingAfter,
  insertSiblingBefore,
  mergeNodes,
  moveNode,
  nodeText,
  normalizeColor,
  outdentNode,
  removeNode,
  relocateNode,
  uid,
  updateNode,
} from "./tree";
import {
  emptyTrash,
  moveDocumentToTrash,
  pruneTrash,
  removeTrashEntry,
  retainLocalTrash,
  restoreTrashEntry,
} from "./trash";
import {
  captureSnapshot,
  listHistoryAttachmentIds,
  listDocumentSnapshots,
  type DocumentSnapshot,
} from "./versionHistory";

type ExportFormat = "json" | "markdown" | "opml" | "freemind" | "html";
type MindRelation = { id: string; fromNodeId: string; toNodeId: string; label: string };
type AppViewMode = ViewMode | "markdown";
type MarkdownPaneMode = "edit" | "preview" | "split";
type MarkdownDocument = OutlineDocument & {
  markdownSource?: string;
  markdownUpdatedAt?: string;
};
type MarkdownDraft = {
  documentId: string | null;
  value: string;
  dirty: boolean;
};
type InspectorNoteDraft = {
  nodeId: string;
  value: string;
  baseNote: string;
  dirty: boolean;
};
type NodeClipboard = {
  mode: "copy" | "cut";
  sourceDocumentId: string;
  sourceId: string;
  node: OutlineNode;
  knowledge?: OutlineDocument["knowledge"];
  attachments?: OutlineDocument["attachments"];
};
type OutlineDropZone = "before" | "after" | "child";
type StructuredAiTargetId = string;
type MarkdownAiTarget =
  | {
      kind: "heading";
      text: string;
      lineStart: number;
      lineEnd: number;
      level: number;
      subtreeEnd: number;
      prefix: string;
    }
  | {
      kind: "list";
      text: string;
      lineStart: number;
      lineEnd: number;
      indent: string;
      marker: string;
      subtreeEnd: number;
    }
  | {
      kind: "paragraph";
      text: string;
      lineStart: number;
      lineEnd: number;
      subtreeEnd: number;
    };

const now = () => new Date().toISOString();
const ICLOUD_REVISION_KEY = "bike-icloud-revision";
const LEGACY_ICLOUD_REVISION_KEY = "local-outline-icloud-revision";
const MINDMAP_ROOT_ID = "__bike_mindmap_root__";
const AUTO_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

const classNames = (...names: Array<string | false | undefined>) =>
  names.filter(Boolean).join(" ");

const isEditableEventTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  Boolean(target.closest("input, textarea, [contenteditable], dialog[open]"));

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const centerMindMapItem = (bounds: { width: number; height: number }, item: { x: number; y: number; width: number; height: number }, currentScale: number) => {
  const scale = clampNumber(Math.min(currentScale, (bounds.width - 48) / item.width, (bounds.height - 64) / item.height), 0.35, 2.5);
  return { scale, x: bounds.width / 2 - (item.x + item.width / 2) * scale, y: bounds.height / 2 - (item.y + item.height / 2) * scale };
};

const rekeyNodes = (nodes: OutlineNode[]): OutlineNode[] =>
  nodes.map((node) => ({
    ...node,
    id: uid(),
    children: rekeyNodes(node.children),
  }));

const collectDocumentText = (document: OutlineDocument) =>
  `${document.title} ${flattenNodes(document.nodes)
    .map((row) => nodeText(row.node))
    .join(" ")}`.toLowerCase();

const getDocumentMarkdown = (document: MarkdownDocument) => {
  const source = document.markdownSource ?? documentToMarkdown(document);
  const read = readBikeMetadata(source);
  return read.status === "unknown-version" ? source : read.body ?? source;
};

const replaceMarkdownTitle = (source: string, title: string) => {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const safeTitle = title.trim() || "未命名文档";
  const lines = normalized.split("\n");
  let inFence = false;
  let fenceMarker = "";
  const titleIndex = lines.findIndex((line) => {
    const fence = line.match(/^\s{0,3}(```+|~~~+)/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1];
      } else if (line.trimStart().startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = "";
      }
      return false;
    }
    return !inFence && /^\s{0,3}#(?!#)\s+/.test(line);
  });
  if (titleIndex >= 0) {
    lines[titleIndex] = `# ${safeTitle}`;
    return lines.join("\n");
  }
  return [`# ${safeTitle}`, "", normalized].join("\n").trimEnd();
};

let cachedMarkdownLines: { source: string; lines: Array<{ line: string; start: number; end: number }> } | null = null;
const markdownLineInfos = (source: string) => {
  if (cachedMarkdownLines?.source === source) return cachedMarkdownLines.lines;
  const lines = source.split("\n");
  let offset = 0;
  const result = lines.map((line) => {
    const info = {
      line,
      start: offset,
      end: offset + line.length,
    };
    offset += line.length + 1;
    return info;
  });
  cachedMarkdownLines = { source, lines: result };
  return result;
};

const indentationWidth = (value: string) =>
  Array.from(value).reduce((width, char) => width + (char === "\t" ? 4 : 1), 0);

const cleanMarkdownTopicText = (value: string) =>
  value
    .replace(/\s+#+\s*$/, "")
    .replace(/^\[(?: |x|X)\]\s+/, "")
    .replace(/[*_~`[\]()]/g, "")
    .trim();

const findMarkdownAiTarget = (source: string, cursor: number): MarkdownAiTarget | null => {
  const lines = markdownLineInfos(source);
  if (!lines.length) return null;
  const safeCursor = clampNumber(cursor, 0, source.length);
  let lineIndex = lines.findIndex((line) => safeCursor >= line.start && safeCursor <= line.end);
  if (lineIndex < 0) lineIndex = lines.length - 1;
  while (lineIndex > 0 && !lines[lineIndex].line.trim()) {
    lineIndex -= 1;
  }

  const lineInfo = lines[lineIndex];
  const heading = lineInfo.line.match(/^(\s{0,3})(#{1,6})\s+(.*?)\s*$/);
  if (heading) {
    const level = heading[2].length;
    let subtreeEnd = source.length;
    for (let index = lineIndex + 1; index < lines.length; index += 1) {
      const nextHeading = lines[index].line.match(/^\s{0,3}(#{1,6})\s+/);
      if (nextHeading && nextHeading[1].length <= level) {
        subtreeEnd = lines[index].start;
        break;
      }
    }
    return {
      kind: "heading",
      text: cleanMarkdownTopicText(heading[3]) || "未命名主题",
      lineStart: lineInfo.start,
      lineEnd: lineInfo.end,
      level,
      subtreeEnd,
      prefix: `${heading[1]}${heading[2]} `,
    };
  }

  const list = lineInfo.line.match(/^([ \t]*)([-*+]|\d+[.)])\s+((?:\[(?: |x|X)\]\s*)?)(.*)$/);
  if (list) {
    const baseIndent = indentationWidth(list[1]);
    let subtreeEnd = source.length;
    for (let index = lineIndex + 1; index < lines.length; index += 1) {
      const nextLine = lines[index].line;
      if (!nextLine.trim()) continue;
      if (/^\s{0,3}#{1,6}\s+/.test(nextLine)) {
        subtreeEnd = lines[index].start;
        break;
      }
      const nextList = nextLine.match(/^([ \t]*)([-*+]|\d+[.)])\s+/);
      const nextIndent = indentationWidth(nextLine.match(/^([ \t]*)/)?.[1] ?? "");
      if ((nextList && indentationWidth(nextList[1]) <= baseIndent) || (!nextList && nextIndent <= baseIndent)) {
        subtreeEnd = lines[index].start;
        break;
      }
    }
    return {
      kind: "list",
      text: cleanMarkdownTopicText(list[4]) || "未命名主题",
      lineStart: lineInfo.start,
      lineEnd: lineInfo.end,
      indent: list[1],
      marker: `${list[2]} ${list[3]}`,
      subtreeEnd,
    };
  }

  const text = lineInfo.line.trim();
  if (!text) return null;
  return {
    kind: "paragraph",
    text: cleanMarkdownTopicText(text) || "未命名主题",
    lineStart: lineInfo.start,
    lineEnd: lineInfo.end,
    subtreeEnd: lineInfo.end,
  };
};

const renderGeneratedMarkdownList = (
  nodes: AiGeneratedNode[],
  baseIndent = "",
  depth = 0,
): string[] =>
  nodes.flatMap((node) => [
    `${baseIndent}${"  ".repeat(depth)}- ${node.text}`,
    ...renderGeneratedMarkdownList(node.children ?? [], baseIndent, depth + 1),
  ]);

const renderGeneratedMarkdownHeadings = (
  nodes: AiGeneratedNode[],
  baseLevel: number,
  depth = 1,
): string[] =>
  nodes.flatMap((node) => {
    const level = Math.min(6, baseLevel + depth);
    return [
      `${"#".repeat(level)} ${node.text}`,
      ...renderGeneratedMarkdownHeadings(node.children ?? [], baseLevel, depth + 1),
    ];
  });

const formatGeneratedMarkdown = (target: MarkdownAiTarget, nodes: AiGeneratedNode[]) => {
  if (target.kind === "heading" && target.level <= 3) {
    return renderGeneratedMarkdownHeadings(nodes, target.level).join("\n");
  }
  const baseIndent = target.kind === "list" ? `${target.indent}  ` : "";
  return renderGeneratedMarkdownList(nodes, baseIndent).join("\n");
};

const replaceMarkdownTargetLine = (
  source: string,
  target: MarkdownAiTarget,
  text: string,
) => {
  const nextLine =
    target.kind === "heading"
      ? `${target.prefix}${text}`
      : target.kind === "list"
        ? `${target.indent}${target.marker}${text}`
        : text;
  return `${source.slice(0, target.lineStart)}${nextLine}${source.slice(target.lineEnd)}`;
};

const insertMarkdownChildren = (
  source: string,
  target: MarkdownAiTarget,
  children: AiGeneratedNode[],
) => {
  const block = formatGeneratedMarkdown(target, children);
  if (!block) return source;
  const before = source.slice(0, target.subtreeEnd);
  const after = source.slice(target.subtreeEnd);
  const prefix = before.endsWith("\n") ? "" : "\n";
  const suffix = !after || after.startsWith("\n") ? "" : "\n";
  return `${before}${prefix}${block}${suffix}${after}`;
};

const clearDocumentMarkdown = (document: MarkdownDocument): MarkdownDocument => {
  const next = { ...document };
  const knowledge = anchorMarkdownReferences(next);
  if (knowledge) next.knowledge = knowledge as MarkdownDocument["knowledge"];
  delete next.markdownSource;
  delete next.markdownUpdatedAt;
  return next;
};

const stampRenamedWorkspace = (workspace: Workspace, ids: string[]): Workspace => {
  const updated = new Set(ids);
  const timestamp = now();
  return {
    ...workspace,
    documents: workspace.documents.map((document) => (
      updated.has(document.id)
        ? clearDocumentMarkdown({ ...(document as MarkdownDocument), updatedAt: timestamp })
        : document
    )),
  };
};

let openWikiLinkHandler: ((raw: string, source: LinkOrigin) => void) | null = null;

function DocumentTitleInput({
  value,
  className,
  ariaLabel,
  onCommit,
}: {
  value: string;
  className: string;
  ariaLabel?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className={className}
      value={draft}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

const renderNodeMarkdown = (node: OutlineNode, depth = 0): string => {
  const indent = "  ".repeat(depth);
  const checked = node.checked ? "[x] " : "";
  const note = node.note ? `\n${indent}  > ${node.note.replace(/\n/g, `\n${indent}  > `)}` : "";
  return [
    `${indent}- ${checked}${node.text || "未命名主题"}${note}`,
    ...node.children.map((child) => renderNodeMarkdown(child, depth + 1)),
  ].join("\n");
};

const nodeContainsId = (node: OutlineNode, id: string): boolean =>
  node.id === id || node.children.some((child) => nodeContainsId(child, id));

const subtreeIds = (node: OutlineNode): string[] => [
  node.id,
  ...(node.children ?? []).flatMap(subtreeIds),
];

const firstNodeIdInWorkspace = (workspace: Workspace) =>
  firstNodeId(firstDocument(workspace).nodes);

// Downloads a JSON copy of a workspace before it gets replaced or overwritten.
const downloadWorkspaceBackup = async (workspace: Workspace, reason: string) => {
  if (workspace.version >= 2) {
    const bridge = (window.bike ?? window.localOutline)?.exportWorkspaceArchive;
    if (bridge) {
      const result = await bridge(workspace);
      if (!result.ok || result.cancelled) throw new Error(result.error || "完整备份已取消，工作区已保留");
      return;
    }
    if (workspaceAttachmentAssets(workspace).length &&
        !window.confirm("浏览器可备份全部正文和附件索引，但不包含附件文件。附件仍需从桌面版或同步服务保留。下载 JSON 副本并继续？")) throw new Error("备份已取消，原工作区已保留");
  }
  const backup = exportWorkspace(workspace);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadText(`bike-workspace-before-${reason}-${stamp}.json`, backup.content, backup.mime);
};

const formatTime = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const formatRecentTime = (iso: string) => {
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return "时间未知";
  const elapsed = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return "刚刚编辑";
  if (elapsed < hour) return `${Math.max(1, Math.floor(elapsed / minute))} 分钟前编辑`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)} 小时前编辑`;
  return `编辑于 ${formatTime(iso)}`;
};

const summarizeSyncResult = (summary: SyncSummary) => {
  const parts = [
    summary.uploaded ? `上传 ${summary.uploaded}` : "",
    summary.downloaded ? `下载 ${summary.downloaded}` : "",
    summary.deleted ? `删除 ${summary.deleted}` : "",
  ].filter(Boolean);
  if (summary.conflicts.length) {
    return `同步遇到 ${summary.conflicts.length} 个冲突：${summary.conflicts[0]}`;
  }
  return parts.length ? `同步完成：${parts.join("、")}` : "同步完成：没有新的改动";
};

const colorOptions = [
  { value: "plain", label: "默认" },
  { value: "blue", label: "蓝" },
  { value: "green", label: "绿" },
  { value: "amber", label: "黄" },
  { value: "rose", label: "红" },
];

const useEventCallback = <Args extends unknown[], Return>(
  callback: (...args: Args) => Return,
) => {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  return useCallback((...args: Args) => callbackRef.current(...args), []);
};

const usesDesktopSyncProxy = () =>
  Boolean((window.bike ?? window.localOutline)?.invokeSyncRequest);

const nodeMenuColors = [
  { value: "plain", label: "默认", swatch: "#5f6065" },
  { value: "blue", label: "蓝", swatch: "#3b73ad" },
  { value: "green", label: "绿", swatch: "#3f7f4f" },
  { value: "amber", label: "黄", swatch: "#a96f21" },
  { value: "rose", label: "红", swatch: "#b55562" },
];

const InspectorNoteField = React.memo(function InspectorNoteField({
  nodeId,
  note,
  onPatch,
  onDraftChange,
  onCommit,
  onSuggest, onBind, onCreate,
}: {
  nodeId: string;
  note: string;
  onPatch: (id: string, patch: Partial<OutlineNode>) => void;
  onDraftChange: (id: string, value: string, baseNote: string) => void;
  onCommit: (id: string, value: string) => boolean;
  onSuggest: React.ComponentProps<typeof LinkInput>["onSuggest"];
  onBind: React.ComponentProps<typeof LinkInput>["onBind"];
  onCreate: React.ComponentProps<typeof LinkInput>["onCreate"];
}) {
  const [draft, setDraft] = useState(note);
  const latestRef = useRef({ nodeId, note, draft, onPatch, onCommit });
  const focusedRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);

  useEffect(() => {
    latestRef.current = { nodeId, note, draft, onPatch, onCommit };
  }, [draft, nodeId, note, onPatch, onCommit]);

  useLayoutEffect(() => {
    if (!focusedRef.current) setDraft(note);
  }, [nodeId, note]);

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const commitDraft = useCallback(() => {
    clearDebounce();
    const latest = latestRef.current;
    if (latest.draft !== latest.note) {
      latest.onPatch(latest.nodeId, { note: latest.draft });
      if (latest.onCommit(latest.nodeId, latest.draft)) latestRef.current = { ...latest, note: latest.draft };
    } else {
      latest.onCommit(latest.nodeId, latest.note);
    }
  }, [clearDebounce]);

  useEffect(() => () => commitDraft(), [commitDraft]);

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setDraft(value);
    latestRef.current = { nodeId, note, draft: value, onPatch, onCommit };
    onDraftChange(nodeId, value, note);
    clearDebounce();
    debounceTimerRef.current = window.setTimeout(commitDraft, 500);
  };

  return (
    <LinkInput
      aria-label="备注"
      onSuggest={onSuggest}
      onBind={(text, span, target, mode) => { clearDebounce(); setDraft(text); latestRef.current = { ...latestRef.current, draft: text, note: text }; onBind(text, span, target, mode); onCommit(nodeId, text); }}
      onCreate={(text, query, title) => { clearDebounce(); const inserted = insertLinkAtQuery(text, query, { documentName: title }); setDraft(inserted.text); latestRef.current = { ...latestRef.current, draft: inserted.text, note: inserted.text }; onCreate(text, query, title); onCommit(nodeId, inserted.text); }}
      value={draft}
      onChange={handleChange}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        commitDraft();
      }}
      placeholder="补充说明、行动项或引用..."
    />
  );
});

function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [ready, setReady] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentGeneration, setAttachmentGeneration] = useState(0);
  const attachmentImportRef = useRef<string | null>(null);
  const cleanupBusyRef = useRef(false);
  const updateInstallRef = useRef<Workspace | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recoveryFiles, setRecoveryFiles] = useState<WorkspaceRecoveryFile[]>([]);
  const [mode, setMode] = useState<AppViewMode>("outline");
  const [markdownPaneMode, setMarkdownPaneMode] = useState<MarkdownPaneMode>("split");
  const [markdownDraft, setMarkdownDraft] = useState("");
  const [search, setSearch] = useState("");
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [navigationTarget, setNavigationTarget] = useState<{ documentId: string; nodeId: string } | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const selectedTag = selectedTags[0] ?? null;
  const setSelectedTag = (tag: string | null) => setSelectedTags(tag ? [tag] : []);
  const [filterDocumentIds, setFilterDocumentIds] = useState<string[]>([]);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [includeCode, setIncludeCode] = useState(false);
  const [showNodeInspector, setShowNodeInspector] = useState(false);
  const [nodeClipboard, setNodeClipboard] = useState<NodeClipboard | null>(null);
  const [notice, setNotice] = useState("本地自动保存已开启");
  const [noticeKey, setNoticeKey] = useState(0);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [sidebarView, setSidebarView] = useState<"all" | "recent" | "quick">("all");
  const [navigation, setNavigation] = useState<NavigationState>(() => {
    try {
      return normalizeNavigation(JSON.parse(localStorage.getItem("bike.navigation.v1") || "null"));
    } catch {
      return normalizeNavigation(null);
    }
  });
  const [location, setLocation] = useState<{ nodeId: string | null; documentId: string | null; version: number }>({ nodeId: null, documentId: null, version: 0 });
  const locatedNodeId = location.nodeId;
  const setLocatedNodeId = useCallback((nodeId: string | null, documentId: string) => setLocation((current) => ({ nodeId, documentId, version: current.version + 1 })), []);
  const [showRelations, setShowRelations] = useState(() => readPreference("bike.mindmap.relations", "1") !== "0");
  const [showBackupSettings, setShowBackupSettings] = useState(false);
  const [backupStatus, setBackupStatus] = useState<{ auto?: boolean; paused?: string | null; lastSuccessAt?: string | null; lastError?: { message?: string } | null }>({});
  const [taskFilter, setTaskFilter] = useState<"all" | "open" | "done">("all");
  const [searchLimit, setSearchLimit] = useState(100);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const labelBaselineRef = useRef(new Map<string, string>());
  const backupScheduleRef = useRef(createBackupSchedule());
  const backupLocalPauseRef = useRef<string | null>("loading");
  const preferenceFailureRef = useRef(false);
  const backupTicketRef = useRef(0);
  const backupTicketReadyRef = useRef(false);
  const backupTimerRef = useRef<number | null>(null);
  const backupPayloadsRef = useRef(new Map<number, Workspace>());
  const backupFlightRef = useRef<Promise<void> | null>(null);
  const backupErrorNoticeRef = useRef<string | null>(null);
  const navHistoryRef = useRef<{ entries: Array<{ documentId: string; nodeId: string | null }>; index: number }>({ entries: [], index: -1 });
  const [recentTicker, setRecentTicker] = useState(0);
  const [aiConfig, setAiConfig] = useState<AiApiConfig>(() => loadAiConfig());
  const [showAiConfig, setShowAiConfig] = useState(false);
  const [showKnowledgeWorkflow, setShowKnowledgeWorkflow] = useState(false);
  const [knowledgeAction, setKnowledgeAction] = useState<KnowledgeAction>("summary");
  const [knowledgeWholeDocument, setKnowledgeWholeDocument] = useState(false);
  const [summaryDestination, setSummaryDestination] = useState<"child" | "note">("child");
  const [templateAudience, setTemplateAudience] = useState("mixed");
  const [showLiveMcp, setShowLiveMcp] = useState(false);
  const [liveScope, setLiveScope] = useState<"document" | "workspace">("document");
  const [liveWritable, setLiveWritable] = useState(false);
  const [liveState, setLiveState] = useState<LiveMcpState>({ enabled: false, writable: false, documentIds: [], discoveryPath: null });
  const proposalRegistryRef = useRef(new Map<string, { proposal: WorkspaceProposal; digest: string }>());
  const [proposals, setProposals] = useState<WorkspaceProposal[]>([]);
  const proposal = proposals[0] ?? null;
  const [proposalBusy, setProposalBusy] = useState(false);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const operationCommitRef = useRef(false);
  const liveGrantEpochRef = useRef(0);
  const liveRequestStatusesRef = useRef(new Map<string, { status: string; clientDigest?: string; candidateDigest?: string; operationId?: string | null; error?: string }>());
  const compositionActiveRef = useRef(false);
  const [aiBusyKey, setAiBusyKey] = useState<string | null>(null);
  const aiRequestRef = useRef<{ controller: AbortController; key: string } | null>(null);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [syncConfig, setSyncConfig] = useState<SyncConfig>(() => loadSyncConfig());
  const [syncState, setSyncState] = useState<SyncState>(() => {
    const config = loadSyncConfig();
    return loadSyncState(config.serverUrl);
  });
  const [showSyncConfig, setShowSyncConfig] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [attachmentSyncProgress, setAttachmentSyncProgress] = useState<{ phase: string; transferred: number; byteLength: number } | null>(null);
  // Another tab or window saved over the copy this page was editing: autosave
  // is paused until the user picks which version to keep.
  const [storageConflict, setStorageConflict] = useState(false);
  const storageConflictRef = useRef(false);
  const [recoverySnapshots, setRecoverySnapshots] = useState<WorkspaceRecoverySnapshot[]>([]);
  const [showRecoverySnapshots, setShowRecoverySnapshots] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const recoveryBusyRef = useRef(false);
  const [localCopyDialog, setLocalCopyDialog] = useState<{ kind: "export" } | { kind: "import"; workspace: Workspace; baseline: Workspace; copy: LocalMigrationCopy } | null>(null);
  const [sourceArchives, setSourceArchives] = useState<LocalMigrationCopy[] | null>(null);
  const historyRef = useRef<EditHistory>(emptyEditHistory());
  const [, bumpHistoryVersion] = useState(0);
  const lastAutoSnapshotRef = useRef(new Map<string, number>());
  const [showTrash, setShowTrash] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [historyReplica, setHistoryReplica] = useState<ReplicaState | null>(null);
  const [historySnapshots, setHistorySnapshots] = useState<DocumentSnapshot[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const historyBusyRef = useRef(false);
  const historyRequestRef = useRef(0);
  // Last workspace reloaded from another page's save (that page syncs it).
  const refreshedWorkspaceRef = useRef<Workspace | null>(null);
  const syncBusyRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const workspaceRef = useRef<Workspace | null>(null);
  const modeRef = useRef<AppViewMode>("outline");
  const activeNodeIdRef = useRef<string | null>(null);
  const markdownDraftRef = useRef<MarkdownDraft>({ documentId: null, value: "", dirty: false });
  const inspectorNoteDraftRef = useRef<InspectorNoteDraft | null>(null);
  const markdownParseTimerRef = useRef<number | null>(null);
  const flushPendingEditsRef = useRef<() => Workspace | null>(() => null);
  const autoSyncTimerRef = useRef<number | null>(null);
  const autoSyncDirtyRef = useRef(false);
  const syncAppliedWorkspaceRef = useRef<Workspace | null>(null);
  const autoSyncObservedWorkspaceRef = useRef<Workspace | null>(null);
  const modalOpenRef = useRef(false);
  modalOpenRef.current = showTrash || showVersionHistory || showAiConfig || showSyncConfig ||
    showConfirmDelete || showRecoverySnapshots || showBackupSettings || Boolean(proposal) || showLiveMcp || showKnowledgeWorkflow || Boolean(localCopyDialog) || Boolean(sourceArchives);

  const [theme, setTheme] = useState<"light" | "dark">(
    () => readPreference("theme", "light") as "light" | "dark"
  );
  const [pendingCaretFocus, setPendingCaretFocus] = useState<{ id: string; position: number } | null>(null);

  const showNotice = useEventCallback((message: string) => {
    setNotice(message);
    setNoticeKey((k) => k + 1);
  });

  const refreshRecoverySnapshots = useEventCallback(() => {
    setRecoverySnapshots(listWorkspaceRecoverySnapshots(workspaceRef.current));
  });
  const persistPreference = useEventCallback((key: string, value: string) => {
    if (!writePreference(key, value) && !preferenceFailureRef.current) {
      preferenceFailureRef.current = true;
      showNotice("偏好设置暂时无法保存，当前编辑仍可继续");
    }
  });
  const pauseLocalBackup = useEventCallback((reason: string) => {
    const changed = backupLocalPauseRef.current !== reason;
    backupLocalPauseRef.current = reason;
    backupScheduleRef.current = reduceBackupSchedule(backupScheduleRef.current, { type: "pause", reason }, Date.now()).state;
    pruneBackupPayloads(backupPayloadsRef.current, backupScheduleRef.current);
    if (changed && ["loading", "load-error", "save-failed", "fallback", "storage-conflict", "recovering", "restoring"].includes(reason)) {
      const bridge = typeof window === "undefined" ? undefined : window.bike ?? window.localOutline;
      void bridge?.pauseBackup?.().catch(() => {});
    }
  });

  const applyBackupStatus = useEventCallback((status: { auto?: boolean; paused?: string | null; lastTicket?: number }) => {
    if (Number.isInteger(status.lastTicket)) {
      backupTicketRef.current = Math.max(backupTicketRef.current, status.lastTicket ?? 0);
      backupTicketReadyRef.current = true;
    }
    const mainPause = typeof status.paused === "string" ? status.paused : null;
    const source = workspaceRef.current;
    const canResumeSource = mainPause === "local-source" && source && isWorkspacePersisted(source) && getWorkspaceSaveRevision(source) != null && !storageConflictRef.current && !recoveryBusyRef.current;
    const paused = backupLocalPauseRef.current ?? (canResumeSource ? null : mainPause);
    let schedule = reduceBackupSchedule(backupScheduleRef.current, paused
      ? { type: "pause", reason: paused }
      : { type: "resume" }, Date.now()).state;
    if (status.auto !== undefined) {
      schedule = reduceBackupSchedule(schedule, { type: "set-enabled", enabled: status.auto === true }, Date.now()).state;
    }
    backupScheduleRef.current = schedule;
    const semanticHash = (status as { lastSemanticHash?: string }).lastSemanticHash;
    if (!schedule.writing && !schedule.pending) schedule.lastHash = canResumeSource ? null : semanticHash ?? schedule.lastHash;
    pruneBackupPayloads(backupPayloadsRef.current, schedule);
    setBackupStatus({ ...status, paused });
  });

  const runBackupJob = useEventCallback(async (job: { ticket: number; hash: string } | null): Promise<void> => {
    if (!job) return;
    const payload = backupPayloadsRef.current.get(job.ticket);
    // Preparation freezes edits while draining already authoritative backups.
    const preparingUpdate = updateInstallRef.current && workspaceRef.current === updateInstallRef.current &&
      payload && getWorkspaceSaveRevision(payload) != null;
    const paused = backupLocalPauseRef.current ?? backupScheduleRef.current.paused;
    if (paused || storageConflictRef.current || (recoveryBusyRef.current && !preparingUpdate)) {
      pauseLocalBackup(paused || "storage-conflict");
      backupScheduleRef.current = reduceBackupSchedule(backupScheduleRef.current, { type: "write-finished", ticket: job.ticket, ok: false }, Date.now()).state;
      pruneBackupPayloads(backupPayloadsRef.current, backupScheduleRef.current);
      return;
    }
    const bridge = window.bike ?? window.localOutline;
    if (!bridge?.enqueueBackup || !payload) return;
    // The source revision orders content; the main process owns request tickets
    // even when a re-opened renderer has not seen an interrupted issued ticket.
    const allocateNext = true;
    const backup = await bridge.enqueueBackup({
      workspace: payload,
      sourceRevision: getWorkspaceSaveRevision(payload),
      semanticHash: job.hash,
      ticket: allocateNext ? undefined : job.ticket,
      allocateNext,
      resumeSource: true,
      manual: false,
      wait: true,
    }).catch((error: unknown) => ({ ok: false, code: "write-failed", ticket: undefined, error: error instanceof Error ? error.message : String(error) }));
    if (Number.isInteger(backup.ticket)) {
      backupTicketRef.current = Math.max(backupTicketRef.current, backup.ticket ?? 0);
      backupTicketReadyRef.current = true;
    }
    const finished = reduceBackupSchedule(backupScheduleRef.current, {
      type: "write-finished",
      ticket: job.ticket,
      hash: job.hash,
      ok: backup.ok,
    }, Date.now());
    backupScheduleRef.current = finished.state;
    pruneBackupPayloads(backupPayloadsRef.current, finished.state);
    if (!backup.ok && backup.code === "external-change") {
      backupScheduleRef.current = reduceBackupSchedule(backupScheduleRef.current, { type: "pause", reason: "external-change" }, Date.now()).state;
      showNotice(backup.error || "发现外部备份变更，已暂停自动备份");
    } else if (!backup.ok && backup.code !== "stale-source" && backup.code !== "disabled") {
      const message = backup.error || "自动备份未完成，请查看备份状态";
      if (backupErrorNoticeRef.current !== message) { backupErrorNoticeRef.current = message; showNotice(message); }
    } else if (backup.ok) backupErrorNoticeRef.current = null;
    void bridge.getBackupStatus?.().then((status) => applyBackupStatus(status as typeof backupStatus)).catch(() => {});
    await runBackupJob(finished.enqueue);
  });

  const dispatchBackup = useEventCallback((job: { ticket: number; hash: string } | null): Promise<void> => {
    if (!job) return backupFlightRef.current ?? Promise.resolve();
    const flight = runBackupJob(job).finally(() => {
      if (backupFlightRef.current === flight) backupFlightRef.current = null;
    });
    backupFlightRef.current = flight;
    return flight;
  });

  const flushScheduledBackup = useEventCallback(async () => {
    while (backupFlightRef.current || backupScheduleRef.current.pending) {
      if (backupFlightRef.current) {
        await backupFlightRef.current;
        continue;
      }
      const step = reduceBackupSchedule(backupScheduleRef.current, { type: "flush" }, Date.now());
      backupScheduleRef.current = step.state;
      if (!step.enqueue) return;
      await dispatchBackup(step.enqueue);
    }
  });

  const armBackupTimer = useEventCallback(() => {
    if (backupTimerRef.current !== null) window.clearTimeout(backupTimerRef.current);
    backupTimerRef.current = null;
    const dueAt = backupScheduleRef.current.dueAt;
    if (dueAt == null || backupScheduleRef.current.writing) return;
    backupTimerRef.current = window.setTimeout(() => {
      backupTimerRef.current = null;
      const step = reduceBackupSchedule(backupScheduleRef.current, { type: "tick" }, Date.now());
      backupScheduleRef.current = step.state;
      dispatchBackup(step.enqueue);
      armBackupTimer();
    }, Math.max(0, dueAt - Date.now()));
  });

  const showSaveResult = useEventCallback((result: WorkspaceSaveResult, saved?: Workspace) => {
    refreshRecoverySnapshots();
    if (!result.ok) {
      pauseLocalBackup(result.conflict ? "storage-conflict" : "save-failed");
      // Conflicts are handled by the storage conflict listener.
      if (result.conflict) return;
      showNotice(`保存失败：${result.error.message}`);
      return;
    }
    if (result.target === "localstorage") {
      pauseLocalBackup("fallback");
      showNotice("IndexedDB 不可用，已临时保存到浏览器备用存储");
      return;
    }
    const bridge = window.bike ?? window.localOutline;
    const payload = saved ?? workspaceRef.current;
    const preparingUpdate = payload && updateInstallRef.current === payload && workspaceRef.current === payload;
    if (["save-failed", "fallback"].includes(backupLocalPauseRef.current ?? "") && !storageConflictRef.current && !recoveryBusyRef.current) {
      backupLocalPauseRef.current = null;
      backupScheduleRef.current = reduceBackupSchedule(backupScheduleRef.current, { type: "resume" }, Date.now()).state;
      backupScheduleRef.current.lastHash = null;
    }
    if (backupLocalPauseRef.current || storageConflictRef.current || (recoveryBusyRef.current && !preparingUpdate)) return;
    if (!bridge?.enqueueBackup || !backupScheduleRef.current.enabled || !payload) return;
    if (getWorkspaceSaveRevision(payload) == null) return;
    backupTicketRef.current += 1;
    const ticket = backupTicketRef.current;
    backupPayloadsRef.current.set(ticket, payload);
    const step = reduceBackupSchedule(backupScheduleRef.current, {
      type: "saved",
      ticket,
      hash: backupContentHash(payload),
      authoritative: true,
    }, Date.now());
    backupScheduleRef.current = step.state;
    pruneBackupPayloads(backupPayloadsRef.current, step.state);
    dispatchBackup(step.enqueue);
    armBackupTimer();
  });
  const saveWorkspace = useEventCallback(async (payload: Workspace): Promise<WorkspaceSaveResult> => {
    if (updateInstallRef.current && payload !== updateInstallRef.current) {
      return { ok: false as const, error: new Error("正在准备安装更新，请稍后保存") };
    }
    const result = await saveWorkspaceToStorage(payload);
    showSaveResult(result, payload);
    return result;
  });
  const flushBackupBeforeClose = useEventCallback(async () => {
    if (!backupLocalPauseRef.current && !storageConflictRef.current && !recoveryBusyRef.current) {
      const latest = flushPendingEditsRef.current() ?? workspaceRef.current;
      if (latest) await saveWorkspace(latest);
    }
    await flushScheduledBackup();
  });

  const replaceWorkspace = useEventCallback((next: Workspace) => {
    if (updateInstallRef.current) throw new Error("正在准备安装更新，请稍后更改工作区");
    const version = workspaceFormatVersion(next);
    if (next.version !== version) next = { ...next, version };
    workspaceRef.current = next;
    setWorkspace(next);
    return next;
  });
  const releaseUpdateLock = useEventCallback(() => {
    if (!updateInstallRef.current) return;
    updateInstallRef.current = null;
    recoveryBusyRef.current = false;
    setRecoveryBusy(false);
    const shell = document.querySelector<HTMLElement>(".shell");
    if (shell) shell.inert = false;
  });
  const prepareUpdateInstall = useEventCallback(async () => {
    if (!ready && !loadError) return { ok: false, loading: true };
    if (!ready || compositionActiveRef.current || operationCommitRef.current || storageConflictRef.current || recoveryBusyRef.current || syncBusyRef.current ||
        historyBusyRef.current || attachmentImportRef.current) return { ok: false };
    const current = flushPendingEditsRef.current() ?? workspaceRef.current;
    if (!current) return { ok: false };
    updateInstallRef.current = current;
    recoveryBusyRef.current = true;
    setRecoveryBusy(true);
    clearAutoSyncTimer();
    const shell = document.querySelector<HTMLElement>(".shell");
    if (shell) shell.inert = true;
    try {
      const requiredBackupHash = backupScheduleRef.current.enabled && !backupLocalPauseRef.current && !backupScheduleRef.current.paused
        ? backupContentHash(current) : null;
      const result = await saveWorkspace(current);
      await flushScheduledBackup();
      if (!result.ok || result.target !== "indexeddb" || storageConflictRef.current ||
          updateInstallRef.current !== current || workspaceRef.current !== current ||
          (requiredBackupHash !== null && backupScheduleRef.current.lastHash !== requiredBackupHash)) {
        releaseUpdateLock();
        return { ok: false };
      }
      return { ok: true };
    } catch {
      releaseUpdateLock();
      return { ok: false };
    }
  });

  useEffect(() => {
    const bridge = window.bike ?? window.localOutline;
    const removePreparation = bridge?.onPrepareUpdate?.(prepareUpdateInstall);
    const removeState = bridge?.onUpdateState?.((state) => {
      if (!["preparing", "installing"].includes(state.status)) releaseUpdateLock();
      const messages: Partial<Record<BikeUpdateState["status"], string>> = {
        checking: "正在检查更新...",
        manual: `发现新版本 ${state.latestVersion ?? ""}，请从发布页下载并替换安装`,
        downloading: `正在下载更新 ${Math.round(state.progress ?? 0)}%`,
        downloaded: "更新已下载，可通过检查更新入口重启安装",
        preparing: "正在保存工作区并准备更新...",
        installing: "正在安装更新，应用即将重启...",
        error: state.error || "更新失败，请重试",
      };
      const message = state.error || messages[state.status];
      if (message) showNotice(message);
    });
    return () => { removePreparation?.(); removeState?.(); };
  }, []);

  const clearEditHistory = useEventCallback(() => {
    historyRef.current = emptyEditHistory();
    bumpHistoryVersion((version) => version + 1);
  });

  const snapshotFailureNoticeRef = useRef(false);
  const reportSnapshotFailure = useEventCallback(() => {
    if (snapshotFailureNoticeRef.current) return;
    snapshotFailureNoticeRef.current = true;
    showNotice("版本快照保存失败，编辑不会受影响");
  });

  const maybeCaptureAutoSnapshots = useEventCallback((before: Workspace, after: Workspace) => {
    const afterById = new Map(after.documents.map((document) => [document.id, document]));
    before.documents.forEach((document) => {
      const next = afterById.get(document.id);
      if (!next || next === document) return;
      const at = Date.now();
      const last = lastAutoSnapshotRef.current.get(document.id);
      if (last !== undefined && at - last < AUTO_SNAPSHOT_INTERVAL_MS) return;
      lastAutoSnapshotRef.current.set(document.id, at);
      captureSnapshot(document, "auto").catch(reportSnapshotFailure);
    });
  });

  const captureSyncSnapshots = useEventCallback(async (before: Workspace, after: Workspace) => {
    const afterById = new Map(after.documents.map((document) => [document.id, document]));
    await Promise.all(before.documents.map(async (document) => {
      const next = afterById.get(document.id);
      if (!next || (next !== document && !sameDocumentContent(document, next))) {
        await captureSnapshot(document, "sync").catch(reportSnapshotFailure);
      }
    }));
  });

  const persistSyncConfig = useEventCallback((next: SyncConfig) => {
    const normalized = {
      serverUrl: normalizeSyncServerUrl(next.serverUrl),
      token: next.token.trim(),
      autoSync: next.autoSync === true,
      autoSyncIntervalSeconds: normalizeAutoSyncInterval(next.autoSyncIntervalSeconds),
    };
    saveSyncConfig(normalized);
    localStorage.removeItem("bike-local-copy-offline");
    setSyncConfig(normalized);
    const nextState = loadSyncState(normalized.serverUrl);
    setSyncState(nextState);
    return { config: normalized, state: nextState };
  });

  const persistSyncState = useEventCallback((next: SyncState) => {
    setSyncState(next);
    saveSyncState(next);
  });

  const clearAutoSyncTimer = useEventCallback(() => {
    if (autoSyncTimerRef.current !== null) {
      window.clearTimeout(autoSyncTimerRef.current);
      autoSyncTimerRef.current = null;
    }
  });
  const disableLocalCopyAutomaticBackup = useEventCallback(async () => {
    const bridge = window.bike ?? window.localOutline;
    if (!bridge?.setBackupAuto) throw new Error("当前桌面版无法确认自动备份已关闭，请升级后导入");
    const status = await bridge.setBackupAuto(false);
    if (status.auto !== false) throw new Error("自动备份尚未确认关闭，已停止导入");
    applyBackupStatus(status as typeof backupStatus);
  });
  const reloadLocalCopyPreferences = useEventCallback((next: Workspace) => {
    setAiConfig(loadAiConfig());
    setTheme(readPreference("theme", "light") === "dark" ? "dark" : "light");
    setShowRelations(readPreference("bike.mindmap.relations", "1") !== "0");
    let importedNavigation: unknown = null;
    try { importedNavigation = JSON.parse(readPreference("bike.navigation.v1", "null")); } catch { /* Follow the same fallback as ordinary preference loading. */ }
    setNavigation(pruneNavigation(normalizeNavigation(importedNavigation), { liveIds: next.documents.map((item) => item.id), trashIds: (next.trash ?? []).map((entry) => entry.document.id) }));
  });
  const localCopyPreferencesPendingRef = useRef(false);

  const initializeWorkspace = useEventCallback((
    isMounted: () => boolean = () => true,
    options: { includeFallback?: boolean } = {},
  ) => {
    pauseLocalBackup("loading");
    setLoadError(null);
    setReady(false);
    return recoverInterruptedLocalMigration(disableLocalCopyAutomaticBackup).then((recovered) => {
      if (recovered) {
        localCopyPreferencesPendingRef.current = true;
        setSyncConfig(loadSyncConfig());
        const offlineState = emptySyncState(loadSyncConfig().serverUrl);
        saveSyncState(offlineState);
        setSyncState(offlineState);
      }
      return loadWorkspace(options);
    }).then((result) => {
      if (!isMounted()) return false;
      if (result.status === "error") {
        pauseLocalBackup("load-error");
        const message = `数据加载失败，已暂停自动保存：${result.error.message}`;
        setLoadError(message);
        showNotice(message);
        return false;
      }
      const next = result.status === "loaded" ? result.workspace : createStarterWorkspace();
      if (localCopyPreferencesPendingRef.current) {
        reloadLocalCopyPreferences(next);
        localCopyPreferencesPendingRef.current = false;
      }
      replaceWorkspace(next);
      backupLocalPauseRef.current = null;
      backupScheduleRef.current = reduceBackupSchedule(backupScheduleRef.current, { type: "resume" }, Date.now()).state;
      clearEditHistory();
      lastAutoSnapshotRef.current.clear();
      refreshRecoverySnapshots();
      setActiveNodeId(firstNodeIdInWorkspace(next));
      setReady(true);
      return true;
    }).catch((error) => {
      if (!isMounted()) return false;
      pauseLocalBackup("load-error");
      const message = `数据加载失败，已暂停自动保存：${error instanceof Error ? error.message : String(error)}`;
      setLoadError(message);
      showNotice(message);
      return false;
    });
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    persistPreference("theme", theme);
  }, [theme]);

  useEffect(() => {
    persistPreference("bike.navigation.v1", JSON.stringify(navigation));
  }, [navigation]);

  useEffect(() => {
    persistPreference("bike.mindmap.relations", showRelations ? "1" : "0");
  }, [showRelations]);

  useEffect(() => { setSearchLimit(100); }, [debouncedSearch, selectedTags, taskFilter, filterDocumentIds, favoriteOnly, includeCode]);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedSearch(search), 150);
    return () => window.clearTimeout(handle);
  }, [search]);

  useEffect(() => {
    const bridge = window.bike ?? window.localOutline;
    void bridge?.getBackupStatus?.().then((status) => applyBackupStatus(status as typeof backupStatus));
  }, []);

  useEffect(() => {
    const bridge = window.bike ?? window.localOutline;
    if (!bridge?.onBackupFlush || !bridge.finishBackupFlush) return undefined;
    return bridge.onBackupFlush(() => {
      void flushBackupBeforeClose().finally(() => bridge.finishBackupFlush?.());
    });
  }, [flushScheduledBackup]);
  useEffect(() => {
    const bridge = window.bike ?? window.localOutline;
    if (!bridge?.getBackupStatus || (!showBackupSettings && !backupStatus.auto)) return;
    const timer = window.setInterval(() => { void bridge.getBackupStatus?.().then((status) => applyBackupStatus(status as typeof backupStatus)); }, 3000);
    return () => window.clearInterval(timer);
  }, [showBackupSettings, backupStatus.auto]);
  const resumePersistedBackup = useEventCallback(() => {
    if (storageConflict || recoveryBusy || !ready) {
      pauseLocalBackup(!ready ? "loading" : storageConflict ? "storage-conflict" : "recovering");
      return;
    }
    if (["storage-conflict", "recovering"].includes(backupLocalPauseRef.current ?? "")) {
      backupLocalPauseRef.current = null;
      const bridge = window.bike ?? window.localOutline;
      void bridge?.getBackupStatus?.().then((status) => {
        applyBackupStatus(status as typeof backupStatus);
        const latest = workspaceRef.current;
        if (latest && isWorkspacePersisted(latest)) showSaveResult({ ok: true, target: "indexeddb" }, latest);
      });
    }
    const saved = workspaceRef.current;
    if (ready && backupStatus.auto && saved && isWorkspacePersisted(saved) && !backupLocalPauseRef.current) {
      showSaveResult({ ok: true, target: "indexeddb" }, saved);
    }
  });
  useEffect(() => { resumePersistedBackup(); }, [ready, backupStatus.auto, storageConflict, recoveryBusy]);

  useEffect(() => {
    if (!workspace) return;
    setNavigation((state) => pruneNavigation(state, {
      liveIds: workspace.documents.map((document) => document.id),
      trashIds: (workspace.trash ?? []).map((entry) => entry.document.id),
    }));
  }, [workspace]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    activeNodeIdRef.current = activeNodeId;
  }, [activeNodeId]);

  useEffect(() => {
    const bikeBridge = window.bike ?? window.localOutline;
    if (!bikeBridge?.onOpenApiConfig) return;
    return bikeBridge.onOpenApiConfig(() => {
      setAiConfig(loadAiConfig());
      setShowAiConfig(true);
    });
  }, []);

  useEffect(() => {
    let mounted = true;
    initializeWorkspace(() => mounted);
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!workspace || !ready || storageConflict) return;
    // A copy just loaded from (or already written to) IndexedDB has nothing new.
    if (isWorkspacePersisted(workspace)) return;
    const handle = window.setTimeout(() => {
      if (storageConflictRef.current || recoveryBusyRef.current) return;
      void saveWorkspace(workspace);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [workspace, ready, storageConflict]);

  useEffect(() => {
    if (sidebarView !== "recent") return;
    const handle = window.setInterval(() => {
      setRecentTicker((value) => value + 1);
    }, 60 * 1000);
    return () => window.clearInterval(handle);
  }, [sidebarView]);

  useEffect(() => {
    if (!activeNodeId) return;
    const handle = window.setTimeout(() => {
      const input = inputRefs.current.get(activeNodeId);
      if (input) {
        input.focus();
        if (pendingCaretFocus && pendingCaretFocus.id === activeNodeId) {
          input.setSelectionRange(pendingCaretFocus.position, pendingCaretFocus.position);
          setPendingCaretFocus(null);
        }
      }
    }, 20);
    return () => window.clearTimeout(handle);
  }, [activeNodeId, mode, pendingCaretFocus]);

  const activeDocument = useMemo<MarkdownDocument | null>(() => {
    if (!workspace) return null;
    return (
      workspace.documents.find((document) => document.id === workspace.activeDocumentId) ??
      workspace.documents[0] ??
      null
    ) as MarkdownDocument | null;
  }, [workspace]);

  const activeNode = useMemo(() => {
    if (!activeDocument || !activeNodeId) return null;
    return findNode(activeDocument.nodes, activeNodeId);
  }, [activeDocument, activeNodeId]);

  const navigationNodes = useMemo(() => {
    if (!activeDocument) return [];
    return navigationTarget?.documentId === activeDocument.id
      ? expandAncestors(activeDocument.nodes, navigationTarget.nodeId).nodes as OutlineNode[]
      : activeDocument.nodes;
  }, [activeDocument, navigationTarget]);

  const focusNode = useMemo(() => {
    if (!activeDocument || !focusNodeId) return null;
    return findNode(navigationNodes, focusNodeId);
  }, [activeDocument, navigationNodes, focusNodeId]);

  const visibleNodes = focusNode ? [focusNode] : navigationNodes;

  const tags = useMemo(() => {
    if (!activeDocument) return [];
    const tagSet = new Set<string>();
    flattenNodes(activeDocument.nodes).forEach((row) => {
      extractTags(row.node.text).forEach((tag) => tagSet.add(tag));
      extractTags(row.node.note).forEach((tag) => tagSet.add(tag));
    });
    return Array.from(tagSet).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [activeDocument]);

  const knowledgeIndex = useMemo(() => (workspace ? buildKnowledgeIndex(workspace) : null), [workspace]);
  const globalTags = knowledgeIndex?.tags ?? [];
  const searchResult = useMemo(() => {
    if (!knowledgeIndex || (!debouncedSearch.trim() && !selectedTags.length && taskFilter === "all" && !favoriteOnly && !filterDocumentIds.length)) return null;
    const filters = { query: debouncedSearch, tags: selectedTags, task: taskFilter, documentIds: filterDocumentIds, favoriteOnly, favoriteIds: navigation.favorites, includeCode };
    const result = searchKnowledge(knowledgeIndex, { ...filters, limit: 100 });
    for (let offset = 100; offset < searchLimit && result.truncated; offset += 100) {
      const page = searchKnowledge(knowledgeIndex, { ...filters, offset, limit: 100 });
      for (const group of page.groups) {
        const existing = result.groups.find((item) => item.documentId === group.documentId);
        if (existing) existing.hits.push(...group.hits);
        else result.groups.push(group);
      }
      result.truncated = page.truncated;
    }
    return result;
  }, [debouncedSearch, knowledgeIndex, searchLimit, selectedTags, taskFilter, filterDocumentIds, favoriteOnly, navigation.favorites, includeCode]);
  const knowledgeConnections = useMemo(
    () => (workspace && activeDocument ? resolveDocumentConnections(workspace, activeDocument) : []),
    [activeDocument, workspace],
  );

  const tagHits = useMemo(() => mode !== "markdown" && activeDocument && selectedTags.length
    ? flattenNodes(activeDocument.nodes).filter(row => selectedTags.every(tag =>
      [...extractTags(row.node.text), ...extractTags(row.node.note)].map(foldKey).includes(foldKey(tag)))) : [],
    [mode, activeDocument, selectedTags]);
  const relationTargets = useMemo(() => (knowledgeIndex?.nodes ?? []).filter(node => node.documentId === activeDocument?.id)
    .map(node => ({ id: node.nodeId, label: node.pathLabel })), [knowledgeIndex, activeDocument?.id]);

  const matchingDocuments = useMemo(() => {
    if (!workspace) return [];
    // SearchResults owns indexed/debounced filtering. Do not rescan every
    // document on each raw keystroke just to prepare the idle document list.
    const filtered = workspace.documents;
    if (sidebarView === "recent") {
      return [...filtered]
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
        .slice(0, 12);
    }
    return filtered;
  }, [workspace, sidebarView, recentTicker]);

  const commitWorkspace = useEventCallback((
    updater: (workspace: Workspace) => Workspace,
    options: EditOptions = {},
  ) => {
    const current = workspaceRef.current;
    if (!current) return null;
    if (cleanupBusyRef.current || updateInstallRef.current || operationCommitRef.current) {
      showNotice("正在提交工作区，请稍后重试；输入草稿仍保留");
      return null;
    }
    let next = updater(current);
    if (next === current) return current;
    const version = workspaceFormatVersion(next);
    if (next.version !== version) next = { ...next, version };
    const history = recordChange({
      history: historyRef.current,
      before: current,
      after: next,
      selection: {
        documentId: current.activeDocumentId,
        nodeId: activeNodeIdRef.current,
      },
      afterSelection: {
        documentId: next.activeDocumentId,
        nodeId: options.nodeId ?? activeNodeIdRef.current,
      },
      label: options.label ?? "调整主题结构",
      group: options.group,
    });
    if (history !== historyRef.current) {
      historyRef.current = history;
      bumpHistoryVersion((version) => version + 1);
      const usage = historyMemoryUsage(history);
      if (usage.overBudget || usage.evictedEntries > 0) showNotice("撤销记录达到内存预算，较早的记录已释放；最近一次撤销仍保留，也可查看版本历史");
    }
    maybeCaptureAutoSnapshots(current, next);
    markWorkspaceOperation(next, { source: { kind: "user", label: options.label ?? "编辑" } });
    return replaceWorkspace(next);
  });

  const patchActiveDocument = (
    updater: (document: MarkdownDocument) => MarkdownDocument,
    options: EditOptions & { preserveMarkdown?: boolean } = {},
  ) => {
    return commitWorkspace((current) => {
      let changed = false;
      const documents = current.documents.map((document) => {
        if (document.id !== current.activeDocumentId) return document;
        const before = document as MarkdownDocument;
        const updated = updater(before);
        if (updated === before || sameDocumentContent(before, updated)) return document;
        try { assertTreeBudget(updated.nodes); }
        catch (error) { showNotice(error instanceof Error ? error.message : "主题结构超过处理预算"); return document; }
        changed = true;
        if (!options.preserveMarkdown && typeof before.markdownSource === "string") {
          showNotice("已切换为结构化编辑，原始 Markdown 将由当前大纲重新生成");
        } else if (options.preserveMarkdown && typeof before.markdownSource === "string" && updated.markdownSource === undefined) {
          showNotice("这个主题无法直接映射到原 Markdown 源码，已按当前大纲重建；撤销可恢复原格式");
        }
        const stamped = { ...updated, updatedAt: now() };
        return options.preserveMarkdown ? stamped : clearDocumentMarkdown(stamped);
      });
      return changed ? { ...current, documents } : current;
    }, options);
  };
  const patchActiveDocumentStable = useEventCallback(patchActiveDocument);

  const updateActiveNodes = (
    updater: (nodes: OutlineNode[], document: MarkdownDocument) => OutlineNode[],
    options: EditOptions = {},
  ) => {
    let nextNodes: OutlineNode[] | null = null;
    patchActiveDocumentStable((document) => {
      const nodes = updater(document.nodes, document);
      try { assertTreeBudget(nodes); }
      catch (error) { showNotice(error instanceof Error ? error.message : "主题结构超过处理预算"); return document; }
      nextNodes = nodes;
      return nodes === document.nodes ? document : { ...document, nodes };
    }, options);
    return nextNodes;
  };
  const updateActiveNodesStable = useEventCallback(updateActiveNodes);

  const setActiveNodes = useEventCallback((sourceId: string, targetId: string, zone: OutlineDropZone) => {
    flushPendingEdits();
    updateActiveNodesStable((nodes) => relocateNode(nodes, sourceId, targetId, zone, focusNodeId),
      { label: "拖拽主题", nodeId: sourceId });
  });

  const parseMarkdownIntoDocument = (
    document: MarkdownDocument,
    content: string,
  ): MarkdownDocument => {
    const timestamp = now();
    const parsed = parseMarkdownDocument(content, {
      previousDocument: document.markdownSource === undefined
        ? { ...document, markdownSource: documentToMarkdown(document) }
        : document,
      documentId: document.id,
      now: timestamp,
    });
    return {
      ...document,
      ...parsed,
      id: document.id,
      createdAt: document.createdAt,
      updatedAt: timestamp,
      markdownSource: content,
      markdownUpdatedAt: timestamp,
      knowledge: reconcileMarkdownReferences(document, parsed) as MarkdownDocument["knowledge"],
    };
  };

  const flushMarkdownDraft = useEventCallback(() => {
    if (markdownParseTimerRef.current) {
      window.clearTimeout(markdownParseTimerRef.current);
      markdownParseTimerRef.current = null;
    }

    const draft = markdownDraftRef.current;
    if (!draft.documentId || !draft.dirty) return workspaceRef.current;

    let nextDocument: MarkdownDocument | null = null;
    try {
      const nextWorkspace = commitWorkspace((current) => {
        const before = current.documents.find((document) => document.id === draft.documentId);
        if (!before) return current;
        const parsed = parseMarkdownIntoDocument(before as MarkdownDocument, draft.value);
        let next: Workspace = { ...current, documents: current.documents.map((document) => document.id === before.id ? parsed : document) };
        const changes: Array<{ nodeId?: string; previousLabel: string; nextLabel: string }> = [];
        if (before.title !== parsed.title) changes.push({ previousLabel: before.title, nextLabel: parsed.title });
        const previousNodes = new Map(flattenNodes(before.nodes).map(({ node }) => [node.id, node]));
        for (const { node } of flattenNodes(parsed.nodes)) {
          const previous = previousNodes.get(node.id);
          if (previous && previous.text !== node.text) changes.push({ nodeId: node.id, previousLabel: previous.text, nextLabel: node.text });
        }
        const updated = new Set<string>();
        for (const change of changes) {
          const renamed = renameTarget(next, { documentId: before.id, ...change });
          next = renamed.workspace as Workspace;
          renamed.updatedDocumentIds.forEach((id) => updated.add(id));
        }
        if (updated.size) {
          const timestamp = now();
          next = { ...next, documents: next.documents.map((document) => updated.has(document.id) ? { ...document, updatedAt: timestamp } : document) };
        }
        nextDocument = next.documents.find((document) => document.id === before.id) as MarkdownDocument;
        return next;
      }, { label: "编辑 Markdown", group: `markdown:${draft.documentId}` });

      if (!nextWorkspace || !nextDocument) return workspaceRef.current;
      markdownDraftRef.current = { ...draft, dirty: false };
      const nextNodes = nextDocument ? (nextDocument as MarkdownDocument).nodes : null;
      if (
        nextNodes &&
        nextWorkspace?.activeDocumentId === draft.documentId &&
        (!activeNodeIdRef.current || !findNode(nextNodes, activeNodeIdRef.current))
      ) {
        setActiveNodeId(firstNodeId(nextNodes));
      }
      return nextWorkspace ?? workspaceRef.current;
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Markdown 解析失败");
      return workspaceRef.current;
    }
  });

  const publishNodeLabel = useEventCallback((nodeId: string, previousLabel: string, nextLabel: string) => {
    if (previousLabel === nextLabel) return workspaceRef.current;
    const current = workspaceRef.current;
    const active = current?.documents.find((document) => document.id === current.activeDocumentId);
    if (labelBaselineRef.current.get(nodeId) === nextLabel && active && findNode(active.nodes, nodeId)?.text === nextLabel) return current;
    let ambiguous = 0;
    const result = commitWorkspace((workspace) => {
      const renamed = renameTarget(workspace, {
        documentId: workspace.activeDocumentId,
        nodeId,
        previousLabel,
        nextLabel,
      });
      ambiguous = renamed.ambiguous.length;
      return stampRenamedWorkspace(renamed.workspace as Workspace, renamed.updatedDocumentIds);
    }, { label: "重命名主题", group: null });
    if (result) labelBaselineRef.current.set(nodeId, nextLabel);
    if (ambiguous) showNotice(`有 ${ambiguous} 条重名链接没有自动改名`);
    return result ?? workspaceRef.current;
  });

  const flushFocusedStructuredInput = useEventCallback(() => {
    const element = document.activeElement;
    if (typeof HTMLInputElement !== "undefined" && element instanceof HTMLInputElement && element.matches(".title-input, .document-heading-input")) {
      const current = workspaceRef.current;
      const active = current?.documents.find(item => item.id === current.activeDocumentId);
      if (active && element.value !== active.title) return updateTitle(element.value, undefined, true) ?? current;
      return current;
    }
    if (!(element instanceof HTMLTextAreaElement)) return workspaceRef.current;

    const entry = Array.from(inputRefs.current.entries()).find(([, input]) => input === element);
    if (!entry) return workspaceRef.current;

    const [nodeId] = entry;
    const current = workspaceRef.current;
    const active = current?.documents.find((item) => item.id === current.activeDocumentId);
    const node = active ? findNode(active.nodes, nodeId) : null;
    if (!current || !active || !node) return current;
    const previous = labelBaselineRef.current.get(nodeId) ?? node.text;
    if (previous === element.value && node.text === element.value) return current;
    return publishNodeLabel(nodeId, previous, element.value);
  });

  const handleInspectorNoteDraftChange = useEventCallback((
    nodeId: string,
    value: string,
    baseNote: string,
  ) => {
    inspectorNoteDraftRef.current = {
      nodeId,
      value,
      baseNote,
      dirty: value !== baseNote,
    };
  });

  const handleInspectorNoteCommit = useEventCallback((nodeId: string, value: string) => {
    const draft = inspectorNoteDraftRef.current;
    if (!draft || draft.nodeId !== nodeId) return false;
    const current = workspaceRef.current;
    const active = current?.documents.find(item => item.id === current.activeDocumentId);
    if (!active || findNode(active.nodes, nodeId)?.note !== value) return false;
    inspectorNoteDraftRef.current = {
      nodeId,
      value,
      baseNote: value,
      dirty: false,
    };
    return true;
  });

  const flushInspectorNoteDraft = useEventCallback(() => {
    const draft = inspectorNoteDraftRef.current;
    if (!draft?.dirty) return workspaceRef.current;

    const current = workspaceRef.current;
    const active = current?.documents.find((item) => item.id === current.activeDocumentId);
    const node = active ? findNode(active.nodes, draft.nodeId) : null;
    if (!current || !active || !node) {
      inspectorNoteDraftRef.current = null;
      return current ?? null;
    }
    if (node.note === draft.value) {
      inspectorNoteDraftRef.current = {
        nodeId: draft.nodeId,
        value: draft.value,
        baseNote: draft.value,
        dirty: false,
      };
      return current;
    }

    const nextWorkspace = commitWorkspace((workspace) => ({
      ...workspace,
      documents: workspace.documents.map((document) =>
        document.id === workspace.activeDocumentId
          ? clearDocumentMarkdown({
              ...withFieldText(document, { nodeId: draft.nodeId, field: "note", text: draft.value }) as MarkdownDocument,
              updatedAt: now(),
            })
          : document,
      ),
    }), { label: "编辑备注", group: `note:${draft.nodeId}` });
    if (!nextWorkspace) return workspaceRef.current;
    inspectorNoteDraftRef.current = {
      nodeId: draft.nodeId,
      value: draft.value,
      baseNote: draft.value,
      dirty: false,
    };
    return nextWorkspace ?? workspaceRef.current;
  });

  const flushPendingEdits = useEventCallback(() => {
    flushMarkdownDraft();
    flushInspectorNoteDraft();
    return flushFocusedStructuredInput() ?? workspaceRef.current;
  });

  flushPendingEditsRef.current = flushPendingEdits;


  useEffect(() => {
    const start = () => { compositionActiveRef.current = true; };
    const end = () => { compositionActiveRef.current = false; };
    document.addEventListener("compositionstart", start, true);
    document.addEventListener("compositionend", end, true);
    return () => { document.removeEventListener("compositionstart", start, true); document.removeEventListener("compositionend", end, true); };
  }, []);

  const ensureOperationWorkspace = useEventCallback(async (): Promise<Workspace | null> => {
    if (compositionActiveRef.current || operationCommitRef.current || storageConflictRef.current || recoveryBusyRef.current || historyBusyRef.current) throw new Error("工作区忙碌或受保护，请稍后重试");
    if (document.activeElement instanceof HTMLInputElement && document.activeElement.matches(".title-input, .document-heading-input")) document.activeElement.blur();
    const current = flushPendingEdits() ?? workspaceRef.current;
    if (!current) return null;
    const saved = await saveWorkspace(current);
    if (!saved.ok || saved.target !== "indexeddb") throw new Error("请先恢复本机主存储，再使用 2.0 操作");
    if (current.version === 3) return current;
    const bridge = window.bike ?? window.localOutline;
    const backupKind = bridge?.exportWorkspaceArchive ? "完整工作区 ZIP"
      : workspaceAttachmentAssets(current).length ? "正文和附件索引 JSON（附件文件请另行保留，JSON 不包含附件二进制）" : "完整正文 JSON";
    if (!window.confirm(`启用 2.0 操作前将下载一份${backupKind}。升级后的原工作区需要 Bike 2.0，回退时请使用此备份。继续？`)) return null;
    if (bridge?.exportWorkspaceArchive) {
      const backup = await bridge.exportWorkspaceArchive(current);
      if (!backup.ok || backup.cancelled) throw new Error(backup.error || "升级前备份已取消");
    } else {
      const backup = exportWorkspace(current);
      downloadText(backup.filename, backup.content, backup.mime);
    }
    if (workspaceRef.current !== current) throw new Error("备份期间工作区发生变化，请重新备份后升级");
    const unlock = lockWorkspaceInteraction(typeof document !== "undefined" ? document.querySelector<HTMLElement>(".shell") : null);
    operationCommitRef.current = true;
    try {
      const upgraded: Workspace = { ...current, version: 3 };
      const result = await saveWorkspaceToStorage(upgraded, { expectedWorkspace: current, requireIndexedDB: true });
      if (!result.ok) throw result.error;
      replaceWorkspace(upgraded); showSaveResult(result, upgraded);
      showNotice("已备份并升级 2.0 工作区");
      return upgraded;
    } finally { operationCommitRef.current = false; unlock(); }
  });

  const enqueueProposal = useEventCallback((next: WorkspaceProposal) => {
    if (proposalRegistryRef.current.size >= 16 && !proposalRegistryRef.current.has(next.id)) throw new Error("待确认提案已满，请先处理现有提案");
    proposalRegistryRef.current.set(next.id, { proposal: next, digest: canonicalJson(next.groups) });
    setProposalError(null);
    setProposals((queue) => queue.some((item) => item.id === next.id) ? queue : [...queue, next].slice(0, 16));
  });
  const rejectProposal = useEventCallback(() => {
    if (!proposal || operationCommitRef.current) return;
    liveRequestStatusesRef.current.set(proposal.id, { status: "rejected", clientDigest: proposal.clientDigest, candidateDigest: proposal.candidateDigest });
    proposalRegistryRef.current.delete(proposal.id);
    setProposals((queue) => queue.filter((item) => item.id !== proposal.id));
    setProposalError(null);
    showNotice("已拒绝提案");
  });
  const acceptProposal = useEventCallback(async (selectedIds: string[]) => {
    if (!proposal || operationCommitRef.current) return;
    if (compositionActiveRef.current || storageConflictRef.current || recoveryBusyRef.current || syncBusyRef.current) { setProposalError("工作区忙碌或受保护，请稍后重试"); return; }
    if (proposal.source.kind === "mcp" && !proposalRegistryRef.current.has(proposal.id)) { setProposalError("Live 授权已撤销，提案已失效"); return; }
    const current = flushPendingEdits() ?? workspaceRef.current;
    if (!current || current.version !== 3) { setProposalError("请先备份并升级工作区"); return; }
    const unlock = lockWorkspaceInteraction(typeof document !== "undefined" ? document.querySelector<HTMLElement>(".shell") : null);
    operationCommitRef.current = true; setProposalBusy(true); setProposalError(null);
    try {
      const next = acceptProposalGroups(current, proposal, selectedIds);
      const result = await saveWorkspaceToStorage(next, { requestId: proposal.id, expectedWorkspace: current, requireIndexedDB: true,
        source: proposal.source, reason: proposal.reason, acceptedGroups: selectedIds, clientDigest: proposal.clientDigest, candidateDigest: proposal.candidateDigest, origin: proposal.origin, resolves: proposal.resolves, resolutionBaselines: proposal.resolutionBaselines });
      if (!result.ok) throw result.error;
      historyRef.current = recordChange({ history: historyRef.current, before: current, after: next,
        selection: { documentId: current.activeDocumentId, nodeId: activeNodeIdRef.current }, label: proposal.label });
      bumpHistoryVersion((version) => version + 1);
      replaceWorkspace(next); showSaveResult(result, next);
      liveRequestStatusesRef.current.set(proposal.id, { status: "committed", operationId: result.receipt?.operationId, clientDigest: proposal.clientDigest, candidateDigest: proposal.candidateDigest });
      proposalRegistryRef.current.delete(proposal.id);
      setProposals((queue) => queue.filter((item) => item.id !== proposal.id));
      showNotice("所选修改已持久保存，等待同步的内容会在联网后传输");
    } catch (error) { setProposalError(error instanceof Error ? error.message : "提案提交失败"); }
    finally { operationCommitRef.current = false; unlock(); setProposalBusy(false); }
  });


  const liveReadBarrier = useEventCallback(async (grant: LiveMcpGrant) => {
    if (!ready || compositionActiveRef.current || operationCommitRef.current || storageConflictRef.current || recoveryBusyRef.current || historyBusyRef.current || syncBusyRef.current || attachmentImportRef.current)
      throw new Error("工作区忙碌或受保护，请稍后读取");
    if (document.activeElement instanceof HTMLInputElement && document.activeElement.matches(".title-input, .document-heading-input"))
      throw new Error("正在编辑文档标题，请等待用户完成编辑后重试读取");
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = flushPendingEdits() ?? workspaceRef.current;
      if (!current || current.version !== 3) throw new Error("请在应用内备份并升级工作区");
      if (current.documents.some((item) => readBikeMetadata(item.markdownSource ?? "").status === "unknown-version")) throw new Error("工作区包含受保护的 Markdown 格式");
      const saved = await saveWorkspace(current);
      if (!saved.ok || saved.target !== "indexeddb") throw new Error("读取屏障无法持久保存，请检查存储状态");
      if (workspaceRef.current !== current) continue;
      const documents = current.documents.filter((item) => grant.scope === "workspace" || grant.documentIds.includes(item.id));
      if (!documents.length) throw new Error("授权目标已不存在，请重新授权");
      const scoped: Workspace = { version: 3, documents, activeDocumentId: documents.some((item) => item.id === current.activeDocumentId) ? current.activeDocumentId : documents[0].id };
      const replica = await readReplicaState();
      if (!replica) throw new Error("缺少本机副本身份");
      return { current, scoped, workspaceId: replica.actorId, revision: sha256Hex(canonicalJson(scoped.documents)),
        savedAt: now(), writable: grant.writable };
    }
    throw new Error("编辑仍在变化，请稍后重试读取屏障");
  });
  const handleLiveMcpRequest = useEventCallback(async (request: LiveMcpRequest) => {
    const grantEpoch = liveGrantEpochRef.current;
    if (request.method === "status") {
      const id = request.payload.requestId ?? "";
      const receipt = await queryOperationReceipt(id);
      if (grantEpoch !== liveGrantEpochRef.current) throw new Error("Live 授权已失效，请重新连接");
      if (receipt && request.grant.scope !== "workspace" && receipt.targetDocumentIds?.some((target) => !request.grant.documentIds.includes(target))) return { status: "unknown", applied: false };
      if (receipt) return { status: "committed", applied: true, operationId: receipt.operationId, pendingSync: receipt.pendingSync, remoteStatus: receipt.remoteStatus, clientDigest: receipt.clientDigest };
      const pending = proposalRegistryRef.current.get(id);
      if (pending && workspaceRef.current) {
        const freshness = proposalFreshness(workspaceRef.current, pending.proposal);
        if (freshness !== "current") return { status: freshness, applied: false, clientDigest: pending.proposal.clientDigest };
      }
      return liveRequestStatusesRef.current.get(id) ?? { status: "unknown", applied: false };
    }
    const barrier = await liveReadBarrier(request.grant);
    if (grantEpoch !== liveGrantEpochRef.current) throw new Error("Live 授权已失效，请重新连接");
    if (request.method === "snapshot") return { workspace: barrier.scoped, revision: barrier.revision, workspaceId: barrier.workspaceId, savedAt: barrier.savedAt, writable: barrier.writable, capabilities: ["candidate-patch-v1"] };
    if (request.payload.clientDigest !== undefined && (typeof request.payload.clientDigest !== "string" || !/^[a-f0-9]{64}$/.test(request.payload.clientDigest))) throw new Error("Live 请求摘要格式无效");
    if (!request.payload.requestId || request.payload.workspaceId !== barrier.workspaceId || request.payload.expectedRevision !== barrier.revision) throw new Error("Live 提案读取基线已变化，请重新读取");
    const id = request.payload.requestId;
    const candidate = (request.payload.candidatePatch
      ? applyLiveCandidatePatch(barrier.scoped, request.payload.candidatePatch) : request.payload.candidate) as Workspace;
    assertWorkspaceBudget(candidate);
    if (candidate?.version !== 3 || !Array.isArray(candidate.documents) || !candidate.documents.length) throw new Error("Live 候选工作区格式无效");
    workspaceAttachmentAssets(candidate);
    const permitted = new Set(barrier.scoped.documents.map((document) => document.id));
    if (request.grant.scope !== "workspace" && candidate.documents.some((document) => !permitted.has(document.id))) throw new Error("提案超出授权文档范围");
    const candidates = new Map(candidate.documents.map((document) => [document.id, document]));
    let merged: Workspace = { ...barrier.current,
      documents: barrier.current.documents.flatMap((document) => permitted.has(document.id) ? candidates.has(document.id) ? [candidates.get(document.id)!] : [] : [document]) };
    for (const document of candidate.documents) if (!barrier.current.documents.some((item) => item.id === document.id)) merged = { ...merged, documents: [...merged.documents, document] };
    if (request.grant.scope === "workspace") merged = { ...merged, documents: candidate.documents };
    if (request.grant.scope !== "workspace") {
      for (const document of candidate.documents) {
        const before = barrier.current.documents.find((item) => item.id === document.id);
        if (!before) continue;
        const renames = [{ nodeId: undefined, before: before.title, after: document.title },
          ...flattenNodes(before.nodes).flatMap(({ node }) => { const next = findNode(document.nodes, node.id); return next ? [{ nodeId: node.id, before: node.text, after: next.text }] : []; })];
        for (const rename of renames) if (rename.before !== rename.after) {
          const impact = renameTarget(barrier.current, { documentId: document.id, nodeId: rename.nodeId, nextLabel: rename.after });
          if (impact.updatedDocumentIds.some((target) => !permitted.has(target))) throw new Error("改名会影响未授权的入链，请授权完整影响范围后重试");
        }
      }
    }
    const digest = sha256Hex(canonicalJson(candidate));
    const committed = await queryOperationReceipt(id);
    if (grantEpoch !== liveGrantEpochRef.current) throw new Error("Live 授权已失效，请重新连接");
    if (committed) {
      if (committed.candidateDigest !== digest) throw new Error("相同请求身份携带了不同内容");
      return { status: "committed", applied: true, operationId: committed.operationId };
    }
    const existing = proposalRegistryRef.current.get(id);
    if (existing) {
      if (existing.digest !== digest) throw new Error("相同请求身份携带了不同内容");
      return { applied: false, status: "pending", proposalId: id };
    }
    const previous = liveRequestStatusesRef.current.get(id);
    if (previous && ["rejected", "invalidated"].includes(previous.status)) {
      if (previous.candidateDigest !== digest) throw new Error("相同请求身份携带了不同内容");
      return { ...previous, applied: false };
    }
    const label = `MCP ${String(request.payload.operation ?? "修改").slice(0, 100)}`;
    const next = createWorkspaceProposal(barrier.current, [{ id: "mcp", label, workspace: merged }], {
      id, workspaceId: barrier.workspaceId, source: { kind: "mcp", label }, label,
      reason: String(request.payload.reason ?? "").slice(0, 300), targetDocumentIds: [...permitted],
    });
    if (request.payload.dryRun !== false) return { applied: false, status: "preview", proposal: next };
    if (!request.grant.writable) throw new Error("Live 连接只读，请在应用内授权写入");
    next.clientDigest = request.payload.clientDigest;
    next.candidateDigest = digest;
    next.origin = { principalId: request.session.id, reportedClientName: request.session.clientName };
    enqueueProposal(next);
    proposalRegistryRef.current.set(id, { proposal: next, digest });
    liveRequestStatusesRef.current.set(id, { status: "pending", clientDigest: request.payload.clientDigest, candidateDigest: digest });
    return { applied: false, status: "pending", proposalId: id, principalId: request.session.id, reportedClientName: request.session.clientName };
  });
  useEffect(() => {
    const bridge = window.bike ?? window.localOutline;
    const off = bridge?.onLiveMcpRequest?.(handleLiveMcpRequest);
    const revoked = bridge?.onLiveMcpRevoke?.(() => {
      liveGrantEpochRef.current++;
      for (const [id, entry] of proposalRegistryRef.current) if (entry.proposal.source.kind === "mcp") {
        proposalRegistryRef.current.delete(id); liveRequestStatusesRef.current.set(id, { status: "invalidated", clientDigest: entry.proposal.clientDigest, candidateDigest: entry.proposal.candidateDigest });
      }
      setProposals((queue) => queue.filter((item) => item.source.kind !== "mcp"));
      setLiveState({ enabled: false, writable: false, documentIds: [], discoveryPath: null });
    });
    return () => { off?.(); revoked?.(); };
  }, []);

  const rememberNavigation = useEventCallback((documentId: string, nodeId: string | null) => {
    const history = navHistoryRef.current;
    const current = history.entries[history.index];
    if (current?.documentId === documentId && current.nodeId === nodeId) return;
    const entries = [...history.entries.slice(0, history.index + 1), { documentId, nodeId }].slice(-50);
    navHistoryRef.current = { entries, index: entries.length - 1 };
    setNavigation((state) => rememberOpen(state, { documentId, nodeId, view: modeRef.current, openedAt: now() }));
  });

  const openKnowledgeTarget = useEventCallback((documentId: string, nodeId: string | null) => {
    const current = flushPendingEdits() ?? workspaceRef.current;
    const targetDocument = current?.documents.find((item) => item.id === documentId);
    if (!current || !targetDocument) {
      showNotice(nodeId ? "目标主题已不存在" : "目标文档已不存在");
      return;
    }
    const nextNodes = targetDocument.nodes;
    if (nodeId && !findNode(nextNodes, nodeId)) { showNotice("目标主题已不存在"); return; }
    const targetExists = !nodeId || Boolean(findNode(nextNodes, nodeId));
    setNavigationTarget((previous) => nodeId ? previous?.documentId === documentId && previous.nodeId === nodeId ? previous : { documentId, nodeId } : null);
    if (!nodeId) setFocusNodeId(null);
    if (modeRef.current === "markdown") { modeRef.current = "outline"; setMode("outline"); }
    if (focusNodeId && nodeId) {
      const focusRoot = findNode(nextNodes, focusNodeId);
      if (!focusRoot || !findNode([focusRoot], nodeId)) setFocusNodeId(null);
    }
    if (current.activeDocumentId !== documentId) replaceWorkspace({ ...current, activeDocumentId: documentId });
    setActiveNodeId(targetExists && nodeId ? nodeId : firstNodeId(nextNodes));
    setLocatedNodeId(nodeId, documentId);
    rememberNavigation(documentId, nodeId);
    window.setTimeout(() => {
      if (modeRef.current === "mindmap") { window.document.querySelector(".editor-pane")?.scrollTo({ top: 0 }); return; }
      if (!nodeId) { window.document.querySelector(".editor-pane")?.scrollTo({ top: 0 }); return; }
      window.document.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`)?.scrollIntoView({ block: "center" });
    }, 30);
  });

  const followWikiLink = useEventCallback((raw: string, source: LinkOrigin) => {
    const current = flushPendingEdits() ?? workspaceRef.current;
    if (!current) return;
    if (source.kind === "markdown") {
      const document = current.documents.find((item) => item.id === source.documentId);
      const knowledge: unknown = document?.knowledge;
      const exactMarkdownBinding = knowledgeEditable(knowledge) && knowledge.references.some((reference) => reference.source.kind === "markdown" && reference.source.start === source.start && reference.source.end === source.end);
      if (document && !exactMarkdownBinding) {
        const fieldOrigin = markdownLinkOrigins(document, documentToMarkdown(document)).get(source.start);
        if (fieldOrigin) source = { documentId: document.id, kind: "node-field", ...fieldOrigin };
      }
    }
    const resolved = resolveWikiLink(current, raw, source);
    if (resolved.status !== "resolved" || !resolved.documentId) {
      showNotice(resolved.status === "ambiguous" ? "有多个同名目标，请从候选里选择" : resolved.status === "deleted" ? "链接目标已删除，可从回收站恢复" : resolved.status === "sourceMismatch" ? "链接位置已变化，请重新选择目标" : "找不到链接目标");
      return;
    }
    openKnowledgeTarget(resolved.documentId, resolved.nodeId ?? null);
  });

  useEffect(() => {
    openWikiLinkHandler = followWikiLink;
    return () => {
      if (openWikiLinkHandler === followWikiLink) openWikiLinkHandler = null;
    };
  }, [followWikiLink]);

  const travelNavigation = useEventCallback((direction: -1 | 1) => {
    const history = navHistoryRef.current;
    const nextIndex = history.index + direction;
    const entry = history.entries[nextIndex];
    if (!entry) return;
    navHistoryRef.current = { ...history, index: nextIndex };
    openKnowledgeTarget(entry.documentId, entry.nodeId);
    navHistoryRef.current = { ...history, index: nextIndex };
  });

  const bindNodeLink = useEventCallback((
    nodeId: string,
    text: string,
    source: { start: number; end: number; raw: string },
    target: { documentId: string; nodeId?: string },
    labelMode: "auto" | "custom",
    field: "text" | "note" | "markdown" = "text",
  ) => {
    const span = { start: source.start, end: source.end, raw: source.raw };
    const attached = commitWorkspace((workspace) => ({
      ...workspace,
      documents: workspace.documents.map((document) => {
        if (document.id !== workspace.activeDocumentId) return document;
        const withText = field === "markdown" ? parseMarkdownIntoDocument(document, text) : withFieldText(document, { nodeId, field, text }) as MarkdownDocument;
        const result = attachReference(withText, {
          source: field === "markdown" ? { kind: "markdown", ...span } : { kind: "node-field", nodeId, field, ...span },
          target,
          labelMode,
        });
        if (result.error) {
          showNotice(result.error);
          return clearDocumentMarkdown({ ...withText, updatedAt: now() });
        }
        const next = { ...(result.document as MarkdownDocument), updatedAt: now() };
        return field === "markdown" ? next : clearDocumentMarkdown(next);
      }),
    }), { label: "插入链接", group: null });
    if (field === "text") labelBaselineRef.current.set(nodeId, text);
    if (field === "markdown") {
      if (markdownParseTimerRef.current) window.clearTimeout(markdownParseTimerRef.current);
      markdownDraftRef.current = { documentId: workspaceRef.current?.activeDocumentId ?? null, value: text, dirty: false };
      setMarkdownDraft(text);
    }
    return attached;
  });

  const createLinkedDocument = useEventCallback((nodeId: string, text: string, query: { start: number; end: number }, title: string, field: "text" | "note" | "markdown" = "text") => {
    const inserted = insertLinkAtQuery(text, query, { documentName: title });
    const id = uuid();
    let bindingError: string | null = null;
    const committed = commitWorkspace((workspace) => {
      const created: OutlineDocument = {
        id,
        title,
        createdAt: now(),
        updatedAt: now(),
        nodes: [createNode("新主题")],
      };
      return {
        ...workspace,
        documents: [
          created,
          ...workspace.documents.map((document) => {
            if (document.id !== workspace.activeDocumentId) return document;
            const withText = field === "markdown" ? parseMarkdownIntoDocument(document, inserted.text) : withFieldText(document, { nodeId, field, text: inserted.text }) as MarkdownDocument;
            const result = attachReference(withText, {
              source: field === "markdown" ? { kind: "markdown", start: inserted.start, end: inserted.end, raw: inserted.raw } : { kind: "node-field", nodeId, field, start: inserted.start, end: inserted.end, raw: inserted.raw },
              target: { documentId: id },
              labelMode: "auto",
            });
            if (result.error) bindingError = result.error;
            const next = { ...(result.document as MarkdownDocument), updatedAt: now() };
        return field === "markdown" ? next : clearDocumentMarkdown(next);
          }),
        ],
      };
    }, { label: "创建文档并链接", group: null });
    if (!committed) return;
    if (field === "text") labelBaselineRef.current.set(nodeId, inserted.text);
    if (field === "markdown") {
      if (markdownParseTimerRef.current) window.clearTimeout(markdownParseTimerRef.current);
      markdownDraftRef.current = { documentId: workspaceRef.current?.activeDocumentId ?? null, value: inserted.text, dirty: false };
      setMarkdownDraft(inserted.text);
    }
    showNotice(bindingError ? `文档已创建，但稳定链接未建立：${bindingError}。可以从候选中重新选择这个文档。`
      : "已创建文档并插入链接。撤销会同时撤销链接和新建文档；重做可恢复。");
  });


  const handleMarkdownDraftChange = useEventCallback((value: string) => {
    if (!activeDocument) return;
    setMarkdownDraft(value);
    markdownDraftRef.current = {
      documentId: activeDocument.id,
      value,
      dirty: true,
    };

    if (markdownParseTimerRef.current) {
      window.clearTimeout(markdownParseTimerRef.current);
    }
    markdownParseTimerRef.current = window.setTimeout(() => {
      flushMarkdownDraft();
    }, 450);
  });

  const switchMode = useEventCallback((nextMode: AppViewMode) => {
    if (nextMode === "markdown") {
      flushFocusedStructuredInput();
    }
    if (modeRef.current === "markdown" && nextMode !== "markdown") {
      flushMarkdownDraft();
    }
    modeRef.current = nextMode;
    setMode(nextMode);
  });

  useEffect(() => {
    if (!activeDocument || mode !== "markdown") return;
    const nextValue = getDocumentMarkdown(activeDocument);
    const currentDraft = markdownDraftRef.current;
    if (
      currentDraft.documentId !== activeDocument.id ||
      (!currentDraft.dirty && currentDraft.value !== nextValue)
    ) {
      markdownDraftRef.current = {
        documentId: activeDocument.id,
        value: nextValue,
        dirty: false,
      };
      setMarkdownDraft(nextValue);
    }
  }, [activeDocument, mode]);

  const performHistoryStep = useEventCallback((direction: "undo" | "redo") => {
    if (!ready || modalOpenRef.current || storageConflictRef.current || recoveryBusyRef.current || syncBusyRef.current || historyBusyRef.current) return;
    if (document.querySelector?.("dialog[open]")) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    flushPendingEdits();
    const current = workspaceRef.current;
    if (!current) return;
    const result = direction === "undo"
      ? undo({ history: historyRef.current, workspace: current, now: now() })
      : redo({ history: historyRef.current, workspace: current, now: now() });
    if (result.status === "empty") {
      showNotice(direction === "undo" ? "没有可撤销的操作" : "没有可重做的操作");
      return;
    }
    if (result.status === "stale") {
      historyRef.current = direction === "undo"
        ? { ...historyRef.current, past: historyRef.current.past.slice(0, -1) }
        : { ...historyRef.current, future: historyRef.current.future.slice(1) };
      bumpHistoryVersion((version) => version + 1);
      showNotice("该撤销条目涉及后续修改，已跳过；可继续撤销其它条目，或在版本历史中恢复副本");
      return;
    }

    historyRef.current = result.history;
    const selection = direction === "undo"
      ? result.entry.beforeSelection
      : result.entry.afterSelection;
    const selectedDocument = result.workspace.documents.find((item) => item.id === selection.documentId)
      ?? result.workspace.documents[0];
    const nextWorkspace = { ...result.workspace, activeDocumentId: selectedDocument.id };
    markWorkspaceOperation(nextWorkspace, { source: { kind: direction, label: result.entry.label } });
    replaceWorkspace(nextWorkspace);
    bumpHistoryVersion((version) => version + 1);

    if (selectedDocument) {
      const selectedNode = selection.nodeId
        ? findNode(selectedDocument.nodes, selection.nodeId)
        : null;
      setActiveNodeId(selectedNode?.id ?? firstNodeId(selectedDocument.nodes));
      if (selectedNode) {
        setPendingCaretFocus({ id: selectedNode.id, position: selectedNode.text.length });
      }
      if (focusNodeId && !findNode(selectedDocument.nodes, focusNodeId)) {
        setFocusNodeId(null);
      }
    }
    showNotice(direction === "undo" ? `已撤销：${result.entry.label}` : `已重做：${result.entry.label}`);
  });

  const handleHistoryShortcut = useEventCallback((event: KeyboardEvent) => {
    if (window.bike ?? window.localOutline) return;
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    const isUndo = key === "z" && !event.shiftKey;
    const isRedo = (key === "z" && event.shiftKey) || key === "y";
    if (!isUndo && !isRedo) return;
    if (modalOpenRef.current) return;

    const element = event.target instanceof HTMLElement ? event.target : null;
    if (element?.closest('[role="dialog"]')) return;
    const isNodeInput = element instanceof HTMLTextAreaElement
      && Array.from(inputRefs.current.values()).includes(element);
    const isNativeEditor = element !== null
      && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable)
      && !isNodeInput;
    if (isNativeEditor) return;

    event.preventDefault();
    event.stopPropagation();
    performHistoryStep(isUndo ? "undo" : "redo");
  });

  const handleSaveShortcut = useEventCallback(async (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    event.stopPropagation();
    if (!ready || storageConflictRef.current || recoveryBusyRef.current) return;
    const nextWorkspace = flushPendingEditsRef.current() ?? workspaceRef.current;
    if (!nextWorkspace) return;
    const result = await saveWorkspace(nextWorkspace);
    if (result.ok) {
      showNotice(result.target === "indexeddb" ? "已保存到本地" : "IndexedDB 不可用，已临时保存到浏览器备用存储");
    } else {
      showNotice(`保存失败：${result.error.message}`);
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", handleSaveShortcut, { capture: true });
    return () => window.removeEventListener("keydown", handleSaveShortcut, { capture: true });
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleHistoryShortcut, { capture: true });
    return () => window.removeEventListener("keydown", handleHistoryShortcut, { capture: true });
  }, []);

  const handleEditCommand = useEventCallback((action: "undo" | "redo") => {
      const element = document.activeElement;
      const isNodeInput = element instanceof HTMLTextAreaElement
        && Array.from(inputRefs.current.values()).includes(element);
      const isNativeEditor = element instanceof HTMLElement
        && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable)
        && !isNodeInput;
      if (isNativeEditor) {
        document.execCommand(action);
        return;
      }
      if (modalOpenRef.current) return;
      performHistoryStep(action);
  });

  useEffect(() => {
    const bridge = window.bike ?? window.localOutline;
    return bridge?.onEditCommand?.(handleEditCommand);
  }, []);

  useEffect(() => {
    const flushAndPersistFallback = () => {
      const nextWorkspace = flushPendingEditsRef.current() ?? workspaceRef.current;
      // Only unsaved edits need the synchronous snapshot. Writing a copy that is
      // already in IndexedDB would leave an outdated snapshot behind for the
      // next load (for example when another tab saves newer data afterwards).
      if (nextWorkspace && !isWorkspacePersisted(nextWorkspace)) {
        saveWorkspaceFallback(nextWorkspace);
      }
    };

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      flushAndPersistFallback();
      if (storageConflictRef.current && !(window.bike ?? window.localOutline)) {
        // Let the browser confirm leaving an unresolved conflict. The page's
        // independent snapshot remains available through the recovery screen.
        event.preventDefault();
        event.returnValue = "";
        return;
      }
    };

    const preventFileDropNavigation = (event: DragEvent) => {
      event.preventDefault();
    };

    window.addEventListener("beforeunload", handleBeforeUnload, { capture: true });
    window.addEventListener("pagehide", flushAndPersistFallback, { capture: true });
    window.addEventListener("dragover", preventFileDropNavigation);
    window.addEventListener("drop", preventFileDropNavigation);
    return () => {
      flushAndPersistFallback();
      window.removeEventListener("beforeunload", handleBeforeUnload, { capture: true });
      window.removeEventListener("pagehide", flushAndPersistFallback, { capture: true });
      window.removeEventListener("dragover", preventFileDropNavigation);
      window.removeEventListener("drop", preventFileDropNavigation);
    };
  }, []);

  const selectDocument = useEventCallback((id: string) => {
    const currentWorkspace = flushPendingEdits() ?? workspaceRef.current;
    const document = currentWorkspace?.documents.find((item) => item.id === id);
    const nodeId = firstNodeId(document?.nodes ?? []);
    setFocusNodeId(null);
    setActiveNodeId(nodeId);
    commitWorkspace((current) => ({ ...current, activeDocumentId: id }));
    rememberNavigation(id, nodeId);
  });

  const createDocument = useEventCallback(() => {
    flushPendingEdits();
    const id = uuid();
    const document: OutlineDocument = {
      id,
      title: "未命名文档",
      createdAt: now(),
      updatedAt: now(),
      nodes: [createNode("新主题")],
    };
    setFocusNodeId(null);
    setActiveNodeId(document.nodes[0].id);
    commitWorkspace((current) => ({
      ...current,
      activeDocumentId: id,
      documents: [document, ...current.documents],
    }));
    showNotice("已创建新文档");
  });

  const duplicateDocument = useEventCallback(() => {
    const currentWorkspace = flushPendingEdits() ?? workspaceRef.current;
    const sourceDocument = currentWorkspace?.documents.find(
      (document) => document.id === currentWorkspace.activeDocumentId,
    ) as MarkdownDocument | undefined;
    if (!sourceDocument) return;
    const id = uuid();
    const rekeyed = rekeyKnowledgeNodes(sourceDocument.nodes, uid);
    const fragment = copiedKnowledgeFragment(anchorMarkdownReferences(sourceDocument), {
      sourceDocumentId: sourceDocument.id,
      nextDocumentId: id,
      idMap: rekeyed.idMap,
      wholeDocument: true,
    });
    if (fragment.locked) { showNotice("请升级后再复制这份文档，原知识数据已保留"); return; }
    const document = clearDocumentMarkdown({
      ...sourceDocument,
      id,
      title: `${sourceDocument.title} 副本`,
      createdAt: now(),
      updatedAt: now(),
      nodes: rekeyed.nodes as OutlineNode[],
      knowledge: { ...sourceDocument.knowledge, version: 1, references: fragment.references, relations: fragment.relations, sourceGroups: fragment.sourceGroups },
    });
    setActiveNodeId(firstNodeId(document.nodes));
    setFocusNodeId(null);
    commitWorkspace((current) => ({
      ...current,
      activeDocumentId: id,
      documents: [document, ...current.documents],
    }));
    showNotice(`已创建副本：${document.title}`);
  });

  const deleteDocument = useEventCallback(() => {
    if (syncBusyRef.current || operationCommitRef.current || recoveryBusyRef.current || historyBusyRef.current || storageConflictRef.current) { showNotice("工作区忙碌或受保护，请稍后重试"); return; }
    const currentWorkspace = flushPendingEdits() ?? workspaceRef.current;
    const currentDocument = currentWorkspace?.documents.find(
      (document) => document.id === currentWorkspace.activeDocumentId,
    );
    if (!currentDocument || !currentWorkspace || currentWorkspace.documents.length === 1) {
      showNotice("至少保留一个文档");
      return;
    }
    const result = moveDocumentToTrash(currentWorkspace, currentDocument.id);
    if (!result) return;
    const deletedTitle = currentDocument.title;
    clearEditHistory();
    setActiveNodeId(firstNodeId(result.workspace.documents[0].nodes));
    setFocusNodeId(null);
    replaceWorkspace(result.workspace);
    showNotice(`已移入回收站：${deletedTitle}`);
  });

  const openTrashDialog = useEventCallback(() => {
    const current = flushPendingEdits() ?? workspaceRef.current;
    if (!current) return;
    const trash = pruneTrash(current.trash);
    if (trash.length !== (current.trash?.length ?? 0)) {
      replaceWorkspace({ ...current, trash });
    }
    setShowTrash(true);
  });

  const restoreFromTrash = useEventCallback((entryId: string) => {
    if (syncBusyRef.current || operationCommitRef.current || recoveryBusyRef.current || historyBusyRef.current || storageConflictRef.current) { showNotice("工作区忙碌或受保护，请稍后重试"); return; }
    const current = flushPendingEdits() ?? workspaceRef.current;
    if (!current) return;
    let result;
    try { result = restoreTrashEntry(current, entryId); }
    catch (error) { showNotice(error instanceof Error ? error.message : "恢复失败，原副本已保留"); return; }
    if (!result) return;
    clearEditHistory();
    setActiveNodeId(firstNodeId(result.document.nodes));
    setFocusNodeId(null);
    replaceWorkspace(result.workspace);
    showNotice(`已恢复文档：${result.document.title}`);
  });

  const deleteFromTrash = useEventCallback((entryId: string) => {
    if (syncBusyRef.current || operationCommitRef.current || recoveryBusyRef.current || historyBusyRef.current || storageConflictRef.current) { showNotice("工作区忙碌或受保护，请稍后重试"); return; }
    const current = workspaceRef.current;
    if (!current) return;
    if (!window.confirm("彻底删除后无法从回收站恢复。继续？")) return;
    replaceWorkspace(removeTrashEntry(current, entryId));
    showNotice("已彻底删除文档");
  });

  const emptyTrashForever = useEventCallback(async () => {
    if (syncBusyRef.current || operationCommitRef.current || recoveryBusyRef.current || historyBusyRef.current || storageConflictRef.current) { showNotice("工作区忙碌或受保护，请稍后重试"); return; }
    const current = workspaceRef.current;
    if (!current?.trash?.length) return;
    if (!window.confirm("清空回收站会先下载一份包含回收站内容的工作区备份。继续？")) return;
    try { await downloadWorkspaceBackup(current, "empty-trash"); }
    catch (error) { showNotice(error instanceof Error ? error.message : "备份失败"); return; }
    if ((flushPendingEdits() ?? workspaceRef.current) !== current) { showNotice("备份期间内容已变化，请重新清空回收站"); return; }
    replaceWorkspace(emptyTrash(current));
    showNotice("回收站已下载备份并清空");
  });

  const openVersionHistory = useEventCallback(async () => {
    const current = flushPendingEdits() ?? workspaceRef.current;
    const document = current?.documents.find((item) => item.id === current.activeDocumentId);
    if (!document) return;
    const requestId = ++historyRequestRef.current;
    setShowVersionHistory(true);
    setHistorySnapshots([]);
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const [snapshots, replica] = await Promise.all([listDocumentSnapshots(document.id), readReplicaState()]);
      setHistoryReplica(replica);
      if (requestId !== historyRequestRef.current || workspaceRef.current?.activeDocumentId !== document.id) return;
      setHistorySnapshots(snapshots);
    } catch (error) {
      if (requestId === historyRequestRef.current) {
        setHistoryError(error instanceof Error ? error.message : String(error));
        setHistorySnapshots([]);
      }
    } finally {
      if (requestId === historyRequestRef.current) setHistoryLoading(false);
    }
  });

  const closeVersionHistory = useEventCallback(() => {
    if (historyBusyRef.current) return;
    historyRequestRef.current += 1;
    setShowVersionHistory(false);
  });

  const saveCurrentVersion = useEventCallback(async () => {
    if (historyBusyRef.current || storageConflictRef.current || recoveryBusyRef.current) return;
    const current = flushPendingEdits() ?? workspaceRef.current;
    const document = current?.documents.find((item) => item.id === current.activeDocumentId);
    if (!document) return;
    const requestId = historyRequestRef.current;
    historyBusyRef.current = true;
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      const snapshots = await captureSnapshot(document, "manual");
      if (requestId === historyRequestRef.current && workspaceRef.current?.activeDocumentId === document.id) {
        setHistorySnapshots(snapshots);
      }
      showNotice("已保存当前版本");
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
    } finally {
      historyBusyRef.current = false;
      setHistoryBusy(false);
    }
  });

  const restoreVersionSnapshot = useEventCallback(async (snapshot: DocumentSnapshot) => {
    if (historyBusyRef.current || syncBusyRef.current || storageConflictRef.current || recoveryBusyRef.current) return;
    const current = flushPendingEdits() ?? workspaceRef.current;
    const document = current?.documents.find((item) => item.id === current.activeDocumentId);
    if (!current || !document || snapshot.documentId !== document.id) return;
    if (!window.confirm(`恢复「${snapshot.title}」会替换当前文档内容。恢复前会先保存当前版本，且恢复后可以撤销。继续？`)) return;
    historyBusyRef.current = true;
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      await captureSnapshot(document, "before-restore");
      if (
        (flushPendingEdits() ?? workspaceRef.current) !== current ||
        storageConflictRef.current || syncBusyRef.current || recoveryBusyRef.current
      ) {
        showNotice("保存快照期间内容发生变化，已取消恢复，请重新查看版本历史");
        return;
      }
      const usedIds = new Set(current.documents.filter((item) => item.id !== document.id)
        .flatMap((item) => [item.id, ...flattenNodes(item.nodes).map(({ node }) => node.id)]));
      const collides = flattenNodes(snapshot.document.nodes).some(({ node }) => usedIds.has(node.id));
      if (collides && snapshot.document.knowledge && !knowledgeEditable(snapshot.document.knowledge)) throw new Error("历史主题身份冲突，无法安全重写当前版本不支持的知识数据；请先导出此历史副本");
      const restored = {
        ...(collides ? remapCollidingIds(snapshot.document, usedIds).document : snapshot.document),
        id: document.id,
        createdAt: document.createdAt,
        updatedAt: now(),
      };
      commitWorkspace((workspace) => ({
        ...workspace,
        documents: workspace.documents.map((item) => (item.id === document.id ? restored : item)),
      }), { label: "恢复历史版本", nodeId: firstNodeId(restored.nodes) });
      setActiveNodeId(firstNodeId(restored.nodes));
      setFocusNodeId(null);
      setHistorySnapshots(await listDocumentSnapshots(document.id));
      showNotice("已恢复历史版本，可立即撤销");
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
    } finally {
      historyBusyRef.current = false;
      setHistoryBusy(false);
    }
  });

  const handleNodeText = useEventCallback((id: string, text: string, options?: EditOptions) => {
    patchActiveDocumentStable((document) => withFieldText(document, { nodeId: id, field: "text", text }),
      { ...(options ?? { label: "编辑主题", group: `text:${id}` }), preserveMarkdown: true });
  });

  const handleNodePatch = useEventCallback((id: string, patch: Partial<OutlineNode>) => {
    if ("collapsed" in patch) setNavigationTarget(null);
    const keys = Object.keys(patch);
    const isNote = keys.length === 1 && keys[0] === "note";
    patchActiveDocumentStable((document) => {
      let next = document;
      for (const field of ["text", "note"] as const) {
        if (typeof patch[field] === "string") {
          next = withFieldText(next, { nodeId: id, field, text: patch[field] });
        }
      }
      return { ...next, nodes: updateNode(next.nodes, id, (node) => {
        Object.assign(node, patch);
        node.color = normalizeColor(node.color);
      }) };
    }, { label: isNote ? "编辑备注" : "修改主题", group: isNote ? `note:${id}` : null });
  });

  const ensureAiConfig = useEventCallback(() => {
    const latest = loadAiConfig();
    setAiConfig(latest);
    const error = validateAiConfig(latest);
    if (error) {
      setShowAiConfig(true);
      showNotice("请先配置 API 密钥");
      return null;
    }
    return normalizeAiConfig(latest);
  });

  const requestAiForTopic = useEventCallback(async (
    action: AiNodeAction,
    context: {
      documentTitle: string;
      topicText: string;
      note?: string;
      existingChildren?: string[];
    },
    signal?: AbortSignal,
  ) => {
    const config = ensureAiConfig();
    if (!config) return null;
    return runAiNodeAction(config, action, context, { signal });
  });

  const cancelAiAction = useEventCallback(() => {
    const request = aiRequestRef.current;
    if (!request) return;
    request.controller.abort(new Error("AI 请求已取消"));
    aiRequestRef.current = null;
    setAiBusyKey(null);
    showNotice("AI 请求已取消，可以继续编辑");
  });
  useEffect(() => () => aiRequestRef.current?.controller.abort(), []);

  const runKnowledgeWorkflow = useEventCallback(async () => {
    if (aiRequestRef.current) { showNotice("AI 请求仍在进行，可先取消"); return; }
    let initial: Workspace | null;
    try { initial = await ensureOperationWorkspace(); }
    catch (error) { showNotice(error instanceof Error ? error.message : "工作区未就绪"); return; }
    if (!initial) return;
    const document = initial.documents.find((item) => item.id === initial.activeDocumentId)!;
    const nodeId = knowledgeWholeDocument ? null : activeNodeIdRef.current;
    const config = ensureAiConfig(); if (!config) return;
    const request = { controller: new AbortController(), key: `knowledge:${knowledgeAction}` };
    aiRequestRef.current = request; setAiBusyKey(request.key); setShowKnowledgeWorkflow(false);
    try {
      const context = workflowContext(document, nodeId);
      const output = await requestAiJson(config, `${workflowInstructions(knowledgeAction)}\n读者参数 ${templateAudience}`, context, { signal: request.controller.signal });
      if (request.controller.signal.aborted || aiRequestRef.current !== request) return;
      const latest = flushPendingEdits() ?? workspaceRef.current;
      const target = latest?.documents.find((item) => item.id === document.id);
      if (!latest || !target || !sameDocumentContent(document, target)) throw new Error("生成期间目标内容已变化，请重新比较");
      const generatedProposal = buildKnowledgeProposal(latest, document.id, nodeId, knowledgeAction, output, summaryDestination);
      generatedProposal.origin = { model: config.model, documentId: document.id, ...(nodeId ? { nodeId } : {}) };
      enqueueProposal(generatedProposal);
      showNotice("知识操作提案已生成，请预览并接受");
    } catch (error) { showNotice(error instanceof Error ? error.message : "知识操作未完成"); }
    finally { if (aiRequestRef.current === request) { aiRequestRef.current = null; setAiBusyKey(null); } }
  });

  const handleStructuredAiAction = useEventCallback(async (
    action: AiNodeAction,
    targetId: StructuredAiTargetId,
  ) => {
    if (aiRequestRef.current) { showNotice("AI 请求仍在进行，可先取消"); return; }
    let currentWorkspace: Workspace | null;
    try { currentWorkspace = await ensureOperationWorkspace(); } catch (error) { showNotice(error instanceof Error ? error.message : "工作区未就绪"); return; }
    const document = currentWorkspace?.documents.find((item) => item.id === currentWorkspace.activeDocumentId) as MarkdownDocument | undefined;
    if (!document || !currentWorkspace) return;

    const isDocumentRoot = targetId === MINDMAP_ROOT_ID;
    const node = isDocumentRoot ? null : findNode(document.nodes, targetId);
    if (!isDocumentRoot && !node) return;

    const busyKey = `structured:${targetId}:${action}`;
    const request = { controller: new AbortController(), key: busyKey };
    aiRequestRef.current = request;
    setAiBusyKey(busyKey);
    showNotice(action === "generate" ? "AI 正在生成子主题..." : "AI 正在润色主题...");
    try {
      const result = await requestAiForTopic(action, {
        documentTitle: document.title,
        topicText: isDocumentRoot ? document.title : node?.text ?? "",
        note: node?.note,
        existingChildren: (isDocumentRoot ? document.nodes : node?.children ?? [])
          .map((child) => child.text)
          .filter(Boolean),
      }, request.controller.signal);
      if (!result) return;
      if (request.controller.signal.aborted || aiRequestRef.current !== request) return;

      const latestWorkspace = flushPendingEdits() ?? workspaceRef.current;
      const latestDocument = latestWorkspace?.documents.find((item) => item.id === document.id);
      if (
        storageConflictRef.current ||
        !latestDocument || !sameDocumentContent(document, latestDocument)
      ) throw new Error("AI 请求期间文档发生变化，已保留当前内容，请重新生成");

      let candidate: Workspace;
      if (action === "polish") {
        const text = result.text?.trim();
        if (!text) throw new Error("AI 没有返回润色文本");
        const renamed = renameTarget(latestWorkspace!, { documentId: document.id,
          ...(isDocumentRoot ? {} : { nodeId: targetId }), nextLabel: text });
        candidate = renamed.workspace as Workspace;
      } else {
        const generated = generatedNodesToOutlineNodes(result.children);
        if (!generated.length) throw new Error("AI 没有生成可用子主题");
        const nodes = isDocumentRoot ? [...latestDocument.nodes, ...generated] : updateNode(latestDocument.nodes, targetId, (target) => {
          target.collapsed = false; target.children = [...target.children, ...generated];
        });
        candidate = { ...latestWorkspace!, documents: latestWorkspace!.documents.map((item) => item.id === document.id ? clearDocumentMarkdown({ ...item, nodes }) : item) };
      }
      const label = action === "polish" ? "AI 润色" : "AI 生成子主题";
      enqueueProposal(createWorkspaceProposal(latestWorkspace!, [{ id: "changes", label, workspace: candidate }], {
        id: uuid(), source: { kind: "ai", label }, label, targetDocumentIds: [document.id],
      }));
      showNotice("AI 提案已生成，请预览并选择接受的修改");
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "AI 操作失败");
    } finally {
      if (aiRequestRef.current === request) { aiRequestRef.current = null; setAiBusyKey((current) => (current === busyKey ? null : current)); }
    }
  });

  const handleMarkdownAiAction = useEventCallback(async (
    action: AiNodeAction,
    target: MarkdownAiTarget,
    source: string,
  ) => {
    if (!activeDocument) return null;
    if (aiRequestRef.current) { showNotice("AI 请求仍在进行，可先取消"); return null; }
    const sourceDocumentId = activeDocument.id;
    const busyKey = `markdown:${action}`;
    const request = { controller: new AbortController(), key: busyKey };
    aiRequestRef.current = request;
    setAiBusyKey(busyKey);
    showNotice(action === "generate" ? "AI 正在生成 Markdown 子主题..." : "AI 正在润色 Markdown 主题...");
    try {
      const ensured = await ensureOperationWorkspace();
      if (!ensured) return null;
      const result = await requestAiForTopic(action, {
        documentTitle: activeDocument.title,
        topicText: target.text,
        existingChildren: [],
      }, request.controller.signal);
      if (!result) return null;
      if (request.controller.signal.aborted || aiRequestRef.current !== request) return null;

      const latestWorkspace = workspaceRef.current;
      const latestDocument = latestWorkspace?.documents.find((item) => item.id === sourceDocumentId);
      const latestSource = markdownDraftRef.current.documentId === sourceDocumentId
        ? markdownDraftRef.current.value
        : latestDocument ? getDocumentMarkdown(latestDocument) : null;
      if (
        storageConflictRef.current ||
        latestWorkspace?.activeDocumentId !== sourceDocumentId || latestSource !== source
      ) throw new Error("AI 请求期间 Markdown 发生变化，已保留当前内容，请重新生成");

      const current = flushPendingEdits() ?? workspaceRef.current;
      if (!current) return null;
      const bound = current.documents.find((item) => item.id === sourceDocumentId);
      if (!bound || getDocumentMarkdown(bound) !== source) throw new Error("Markdown 目标内容已变化，请重新生成");
      let next: string;
      if (action === "polish") {
        const text = result.text?.trim();
        if (!text) throw new Error("AI 没有返回润色文本");
        next = replaceMarkdownTargetLine(source, target, text);
      } else {
        if (!result.children?.length) throw new Error("AI 没有生成可用子主题");
        next = insertMarkdownChildren(source, target, result.children);
      }
      const parsed = parseMarkdownIntoDocument(bound, next);
      const candidate = { ...current, documents: current.documents.map((item) => item.id === bound.id ? parsed : item) };
      const label = action === "polish" ? "AI 润色 Markdown" : "AI 生成 Markdown 子主题";
      enqueueProposal(createWorkspaceProposal(current, [{ id: "markdown", label, workspace: candidate }], {
        id: uuid(), source: { kind: "ai", label }, label, targetDocumentIds: [bound.id],
      }));
      showNotice("Markdown 提案已生成，请预览后接受");
      return null;
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "AI 操作失败");
      return null;
    } finally {
      if (aiRequestRef.current === request) { aiRequestRef.current = null; setAiBusyKey((current) => (current === busyKey ? null : current)); }
    }
  });

  const handleSaveAiConfig = useEventCallback((config: AiApiConfig) => {
    const error = validateAiConfig(config);
    if (error) {
      showNotice(error);
      return false;
    }
    let saved;
    try { saved = saveAiConfig(config); }
    catch (error) { showNotice(`API 配置保存失败：${error instanceof Error ? error.message : String(error)}`); return false; }
    setAiConfig(saved);
    setShowAiConfig(false);
    showNotice("API 密钥配置已保存");
    return true;
  });

  const copyNodeLink = useEventCallback(async (nodeId: string) => {
    const node = activeDocument ? findNode(activeDocument.nodes, nodeId) : null;
    if (!activeDocument || !node) return;
    const link = `[[${activeDocument.title}#${node.text || "未命名主题"}]]`;
    try {
      await navigator.clipboard.writeText(link);
      showNotice("已复制主题链接");
    } catch {
      showNotice(link);
    }
  });

  const exportNodeMarkdown = useEventCallback((nodeId: string) => {
    const node = activeDocument ? findNode(activeDocument.nodes, nodeId) : null;
    if (!node) return;
    const title = node.text || "未命名主题";
    const content = [`# ${title}`, "", renderNodeMarkdown(node)].join("\n");
    downloadText(`${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")}.md`, content, "text/markdown");
    showNotice(`已导出主题：${title}`);
  });

  const insertAfter = useEventCallback((id: string) => {
    const node = createNode("");
    let didInsert = false;
    flushFocusedStructuredInput();
    updateActiveNodesStable((nodes) => {
      if (!findNode(nodes, id)) return nodes;
      didInsert = true;
      return insertSiblingAfter(nodes, id, node);
    });
    if (didInsert) setActiveNodeId(node.id);
  });

  const insertChild = useEventCallback((id: string) => {
    const node = createNode("");
    let didInsert = false;
    flushFocusedStructuredInput();
    updateActiveNodesStable((nodes) => {
      if (id === MINDMAP_ROOT_ID) {
        didInsert = true;
        return [...nodes, node];
      }
      if (!findNode(nodes, id)) return nodes;
      didInsert = true;
      return addChild(nodes, id, node);
    });
    if (didInsert) setActiveNodeId(node.id);
  });

  const removeActiveNode = useEventCallback((id: string) => {
    let nextNodes: OutlineNode[] | null = null;
    flushFocusedStructuredInput();
    updateActiveNodesStable((nodes) => {
      if (!findNode(nodes, id)) return nodes;
      nextNodes = removeNode(nodes, id);
      return nextNodes;
    });
    if (!nextNodes) return;
    setActiveNodeId(firstNodeId(nextNodes));
    if (focusNodeId === id) setFocusNodeId(null);
    showNotice("已删除主题");
  });

  const duplicateNode = useEventCallback((id: string) => {
    const currentWorkspace = flushFocusedStructuredInput() ?? workspaceRef.current;
    const currentDocument = currentWorkspace?.documents.find(
      (document) => document.id === currentWorkspace.activeDocumentId,
    );
    const node = currentDocument ? findNode(currentDocument.nodes, id) : null;
    if (!node || !currentDocument) return;
    const rekeyed = rekeyKnowledgeNodes([node], uid);
    const normalizedKnowledge = anchorMarkdownReferences(currentDocument);
    const fragment = copiedKnowledgeFragment(normalizedKnowledge, {
      sourceDocumentId: currentDocument.id,
      nextDocumentId: currentDocument.id,
      idMap: rekeyed.idMap,
    });
    if (fragment.locked) { showNotice("请升级后再复制这份文档的主题"); return; }
    const copy = rekeyed.nodes[0] as OutlineNode;
    commitWorkspace((workspace) => ({
      ...workspace,
      documents: workspace.documents.map((document) => {
        if (document.id !== currentDocument.id || !findNode(document.nodes, id)) return document;
        const base = knowledgeEditable(normalizedKnowledge)
          ? normalizedKnowledge
          : { version: 1 as const, references: [], relations: [] };
        return clearDocumentMarkdown({
          ...(document as MarkdownDocument),
          updatedAt: now(),
          nodes: insertSiblingAfter(document.nodes, id, copy),
          ...(fragment.references.length || fragment.relations.length ? {
            knowledge: {
              ...base,
              references: [...(base.references ?? []), ...fragment.references],
              relations: [...(base.relations ?? []), ...fragment.relations],
              sourceGroups: { ...base.sourceGroups, ...fragment.sourceGroups },
            },
          } : {}),
        });
      }),
    }), { label: "复制主题", group: null });
    setActiveNodeId(copy.id);
    showNotice("已创建主题副本");
  });

  const insertParentNode = useEventCallback((id: string) => {
    const parent = createNode("上级主题");
    let didInsert = false;
    flushFocusedStructuredInput();
    updateActiveNodesStable((nodes) => {
      if (!findNode(nodes, id)) return nodes;
      didInsert = true;
      return insertParent(nodes, id, parent);
    });
    if (!didInsert) return;
    setActiveNodeId(parent.id);
    showNotice("已插入上级主题");
  });

  const copyNodeToClipboard = useEventCallback(async (id: string) => {
    const currentWorkspace = flushFocusedStructuredInput() ?? workspaceRef.current;
    const document = currentWorkspace?.documents.find(
      (item) => item.id === currentWorkspace.activeDocumentId,
    );
    const node = document ? findNode(document.nodes, id) : null;
    if (!document || !node) return;
    setNodeClipboard({
      mode: "copy",
      sourceDocumentId: document.id,
      sourceId: id,
      node: cloneNodes([node])[0],
      knowledge: document.knowledge ? JSON.parse(JSON.stringify(anchorMarkdownReferences(document))) : undefined,
      attachments: document.attachments,
    });
    try {
      await navigator.clipboard.writeText(renderNodeMarkdown(node));
    } catch {
      // Browser clipboard permission is best-effort; the in-app clipboard still works.
    }
    showNotice("已复制主题，可在脑图中粘贴");
  });

  const cutNodeToClipboard = useEventCallback((id: string) => {
    const currentWorkspace = flushFocusedStructuredInput() ?? workspaceRef.current;
    const document = currentWorkspace?.documents.find(
      (item) => item.id === currentWorkspace.activeDocumentId,
    );
    const node = document ? findNode(document.nodes, id) : null;
    if (!document || !node) return;
    setNodeClipboard({
      mode: "cut",
      sourceDocumentId: document.id,
      sourceId: id,
      node: cloneNodes([node])[0],
      knowledge: document.knowledge ? JSON.parse(JSON.stringify(anchorMarkdownReferences(document))) : undefined,
      attachments: document.attachments,
    });
    showNotice("已剪切主题，选择目标后粘贴");
  });

  const pasteNodeAsChild = useEventCallback((targetId: string) => {
    if (!nodeClipboard) return;
    const clipboard = nodeClipboard;
    let pasted: OutlineNode | null = null;
    let pastedId: string | null = null;
    let didPaste = false;
    let blocked = false;
    let staleCut = false;
    let knowledgeError = "";
    flushFocusedStructuredInput();
    commitWorkspace((current) => {
      const activeDocumentId = current.activeDocumentId;
      const active = current.documents.find((document) => document.id === activeDocumentId) as MarkdownDocument | undefined;
      if (!active) return current;
      const sourceDocument = current.documents.find(
        (document) => document.id === clipboard.sourceDocumentId,
      ) as MarkdownDocument | undefined;
      const sourceNode = sourceDocument ? findNode(sourceDocument.nodes, clipboard.sourceId) : null;
      if (clipboard.mode === "cut" && !sourceNode) {
        staleCut = true;
        return current;
      }
      if (clipboard.mode === "cut" && sourceNode && activeDocumentId === clipboard.sourceDocumentId && nodeContainsId(sourceNode, targetId)) {
        blocked = true;
        return current;
      }
      if (targetId !== MINDMAP_ROOT_ID && !findNode(active.nodes, targetId)) return current;

      let documents = current.documents;
      let nextActive = active;
      let nextSource = sourceDocument;
      const movedIds = sourceNode ? subtreeIds(sourceNode) : [];
      if (clipboard.mode === "cut" && sourceNode && sourceDocument && sourceDocument.id !== active.id) {
        const moved = moveSubtreeConnections(sourceDocument, active, movedIds);
        if (moved.error) { knowledgeError = moved.error; return current; }
        documents = retargetIncomingNodes(current.documents.map((document) => {
          if (document.id === active.id) return moved.target as OutlineDocument;
          if (document.id === sourceDocument.id) return moved.source as OutlineDocument;
          return document;
        }), {
          sourceDocumentId: sourceDocument.id,
          targetDocumentId: active.id,
          movedIds,
        }) as OutlineDocument[];
        nextActive = documents.find((document) => document.id === active.id) as MarkdownDocument;
        nextSource = documents.find((document) => document.id === sourceDocument.id) as MarkdownDocument;
      }
      if (clipboard.mode === "copy") {
        const rekeyed = rekeyKnowledgeNodes([clipboard.node], uid);
        const fragment = copiedKnowledgeFragment(clipboard.knowledge, {
          sourceDocumentId: clipboard.sourceDocumentId,
          nextDocumentId: active.id,
          idMap: rekeyed.idMap,
        });
        if (fragment.locked || (nextActive.knowledge && !knowledgeEditable(nextActive.knowledge))) {
          knowledgeError = "这份文档的知识数据需要更新版本后才能复制主题";
          return current;
        }
        pasted = rekeyed.nodes[0] as OutlineNode;
        if (fragment.references.length || fragment.relations.length) {
          const base = knowledgeEditable(nextActive.knowledge)
            ? nextActive.knowledge
            : { version: 1 as const, references: [], relations: [] };
          nextActive = {
            ...nextActive,
            knowledge: {
              ...base,
              references: [...(base.references ?? []), ...fragment.references],
              relations: [...(base.relations ?? []), ...fragment.relations],
              sourceGroups: { ...base.sourceGroups, ...fragment.sourceGroups },
            },
          };
        }
      } else {
        pasted = cloneNodes([sourceNode ?? clipboard.node])[0];
      }
      pastedId = pasted.id;
      const activeBaseNodes =
        clipboard.mode === "cut" && sourceNode && activeDocumentId === clipboard.sourceDocumentId
          ? removeNode(active.nodes, clipboard.sourceId)
          : clipboard.mode === "cut" && sourceNode
            ? removeNode(nextActive.nodes, clipboard.sourceId)
            : active.nodes;
      const activeNodes = targetId === MINDMAP_ROOT_ID
        ? [...activeBaseNodes, pasted]
        : addChild(activeBaseNodes, targetId, pasted);
      nextActive = mergeAttachmentMetadata(nextActive, {
        nodes: [pasted],
        attachments: clipboard.mode === "copy" ? clipboard.attachments : sourceDocument?.attachments,
      });
      didPaste = true;

      return {
        ...current,
        documents: documents.map((document) => {
          if (document.id === activeDocumentId) {
            return clearDocumentMarkdown({
              ...(nextActive as MarkdownDocument),
              updatedAt: now(),
              nodes: activeNodes,
            });
          }
          if (clipboard.mode === "cut" && sourceNode && document.id === clipboard.sourceDocumentId && nextSource) {
            return clearDocumentMarkdown({
              ...(nextSource as MarkdownDocument),
              updatedAt: now(),
              nodes: removeNode(nextSource.nodes, clipboard.sourceId),
            });
          }
          return document;
        }),
      };
    });
    if (knowledgeError) { showNotice(knowledgeError); return; }
    if (blocked) {
      showNotice("不能把主题粘贴到自己或自己的子主题里");
      return;
    }
    if (staleCut) {
      setNodeClipboard(null);
      showNotice("剪切来源已不存在，已取消粘贴");
      return;
    }
    if (!didPaste) return;
    if (pastedId) setActiveNodeId(pastedId);
    if (nodeClipboard.mode === "cut") {
      setNodeClipboard(null);
    }
    showNotice("已粘贴为下级主题");
  });

  const toggleSiblingCollapse = useEventCallback((id: string) => {
    let didToggle = false;
    let collapsed = false;
    flushFocusedStructuredInput();
    updateActiveNodesStable((nodes) => {
      const rows = flattenNodes(nodes);
      const target = rows.find((row) => row.node.id === id);
      if (!target) return nodes;
      const siblings = rows.filter(
        (row) => row.parentId === target.parentId && row.node.children.length,
      );
      if (!siblings.length) return nodes;
      const shouldCollapse = siblings.some((row) => !row.node.collapsed);
      const siblingIds = new Set(siblings.map((row) => row.node.id));
      const apply = (items: OutlineNode[]): OutlineNode[] => {
        let changed = false;
        const result = items.map((node) => {
          const children = apply(node.children);
          const nextCollapsed = siblingIds.has(node.id) ? shouldCollapse : node.collapsed;
          if (children === node.children && nextCollapsed === node.collapsed) return node;
          changed = true;
          return { ...node, children, collapsed: nextCollapsed };
        });
        return changed ? result : items;
      };
      const next = apply(nodes);
      didToggle = true;
      collapsed = shouldCollapse;
      return next;
    });
    if (didToggle) showNotice(collapsed ? "已折叠同级主题" : "已展开同级主题");
  });

  const handleKeyDown = useEventCallback((
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    node: OutlineNode,
  ) => {
    if (event.nativeEvent.isComposing) return;
    const input = event.currentTarget;
    const { selectionStart, selectionEnd } = input;

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (selectionStart !== selectionEnd) return;
      const beforeCaret = selectionStart ?? 0;
      const arrowKey = event.key;
      const rows = flattenNodes(visibleNodes, { respectCollapsed: true });
      const index = rows.findIndex((row) => row.node.id === node.id);
      const nextIndex = arrowKey === "ArrowUp" ? index - 1 : index + 1;
      const nextNode = rows[nextIndex]?.node;
      if (nextNode) {
        window.requestAnimationFrame(() => {
          if (document.activeElement !== input) return;
          if (input.selectionStart !== beforeCaret || input.selectionEnd !== beforeCaret) return;
          setActiveNodeId(nextNode.id);
          const pos = arrowKey === "ArrowUp" ? nextNode.text.length : 0;
          setPendingCaretFocus({ id: nextNode.id, position: pos });
        });
      }
    }
    if (event.key === "Enter") {
      if (event.shiftKey) return;
      event.preventDefault();
      insertAfter(node.id);
    }
    if (event.key === "Tab") {
      event.preventDefault();
      flushFocusedStructuredInput();
      updateActiveNodesStable((nodes) =>
        event.shiftKey ? outdentNode(nodes, node.id) : indentNode(nodes, node.id),
      );
      setActiveNodeId(node.id);
      const pos = selectionStart ?? 0;
      setPendingCaretFocus({ id: node.id, position: pos });
    }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey) {
      const shortcutKey = event.key.toLowerCase();
      if (shortcutKey === "b") {
        event.preventDefault();
        flushFocusedStructuredInput();
        updateActiveNodesStable((nodes) => updateNode(nodes, node.id, (n) => { n.bold = !n.bold; }));
      } else if (shortcutKey === "i") {
        event.preventDefault();
        flushFocusedStructuredInput();
        updateActiveNodesStable((nodes) => updateNode(nodes, node.id, (n) => { n.italic = !n.italic; }));
      } else if (shortcutKey === "u") {
        event.preventDefault();
        flushFocusedStructuredInput();
        updateActiveNodesStable((nodes) => updateNode(nodes, node.id, (n) => { n.underline = !n.underline; }));
      }
    }
    if (event.key === "Backspace") {
      if (selectionStart === 0 && selectionEnd === 0) {
        const rows = flattenNodes(visibleNodes, { respectCollapsed: true });
        const index = rows.findIndex((row) => row.node.id === node.id);
        if (index > 0) {
          event.preventDefault();
          const targetNode = rows[index - 1].node;
          const originalTargetLength = targetNode.text.length;
          flushFocusedStructuredInput();
          updateActiveNodesStable((nodes) => mergeNodes(nodes, node.id, targetNode.id));
          setActiveNodeId(targetNode.id);
          setPendingCaretFocus({ id: targetNode.id, position: originalTargetLength });
          if (focusNodeId === node.id) setFocusNodeId(null);
        } else {
          const currentWorkspace = workspaceRef.current;
          const currentDocument = currentWorkspace?.documents.find(
            (item) => item.id === currentWorkspace.activeDocumentId,
          );
          if (input.value || countNodes(currentDocument?.nodes ?? []) <= 1) return;
          event.preventDefault();
          removeActiveNode(node.id);
        }
      }
    }
  });

  const updateTitle = useEventCallback((title: string, options?: EditOptions, fromFlush = false): Workspace | null => {
    const nextTitle = title || "未命名文档";
    if (!fromFlush) flushPendingEdits();
    let ambiguous = 0;
    const committed = commitWorkspace((workspace) => {
      const renamed = renameTarget(workspace, {
        documentId: workspace.activeDocumentId,
        previousLabel: workspace.documents.find((document) => document.id === workspace.activeDocumentId)?.title,
        nextLabel: nextTitle,
      });
      ambiguous = renamed.ambiguous.length;
      const updated = new Set(renamed.updatedDocumentIds);
      const timestamp = now();
      return {
        ...renamed.workspace,
        documents: renamed.workspace.documents.map((document) => {
          if (!updated.has(document.id)) return document;
          if (document.id === workspace.activeDocumentId && typeof document.markdownSource === "string") {
            return parseMarkdownIntoDocument(document as MarkdownDocument, replaceMarkdownTitle(document.markdownSource, nextTitle));
          }
          return { ...document, updatedAt: timestamp };
        }),
      } as Workspace;
    }, options ?? { label: "重命名文档", group: null });
    if (ambiguous) showNotice(`有 ${ambiguous} 条重名链接没有自动改名`);
    return committed;
  });

  const moveSelected = useEventCallback((direction: -1 | 1) => {
    if (!activeNodeId) return;
    flushFocusedStructuredInput();
    updateActiveNodesStable((nodes) => moveNode(nodes, activeNodeId, direction));
  });

  const exportActive = useEventCallback(async (format: ExportFormat, metadata: boolean = false) => {
    const currentWorkspace = flushPendingEdits() ?? workspaceRef.current;
    const document = currentWorkspace?.documents.find(
      (item) => item.id === currentWorkspace.activeDocumentId,
    ) as MarkdownDocument | undefined;
    if (!document) return;
    const archiveBridge = (window.bike ?? window.localOutline)?.exportWorkspaceArchive;
    if (document.attachments && (format === "markdown" || format === "html")) {
      try {
        if (!archiveBridge) throw new Error("请在桌面版导出携带附件的阅读包");
        const exported = exportDocument(document, format, { metadata, portable: true });
        if (exported.error) throw new Error(exported.error);
        const result = await archiveBridge({ version: 2, activeDocumentId: document.id, documents: [document] }, {
          name: format === "html" ? "index.html" : "document.md", content: exported.content,
        });
        if (!result.ok) throw new Error(result.error || "携图导出失败");
        if (!result.cancelled) showNotice(`已导出携图 ZIP，包含 ${result.attachmentCount ?? 0} 个原始附件`);
      } catch (error) { showNotice(error instanceof Error ? error.message : "携图导出失败"); }
      return;
    }
    if ((format === "opml" || format === "freemind") && knowledgeEditable(document.knowledge) && (document.knowledge.references.length || document.knowledge.relations.length)) {
      showNotice("这个格式不能完整保留链接身份和关系");
    }
    let result;
    try { result = exportDocument(document, format, { metadata }); }
    catch (error) { showNotice(error instanceof Error ? error.message : "导出失败，原数据已保留"); return; }
    if (metadata && result.error) { showNotice(result.error); return; }
    downloadText(result.filename, result.content, result.mime);
    const attachmentScope = document.attachments ? "，本次文件没有携带附件原始字节，完整备份请使用工作区 ZIP" : "";
    showNotice(result.error ? result.error : `已导出 ${result.filename}${result.lossy ? `：${result.lossReasons?.join("；") || "此格式无法完整保留原数据"}` : ""}${attachmentScope}`);
  });

  const exportActivePdf = useEventCallback(async () => {
    const currentWorkspace = flushPendingEdits() ?? workspaceRef.current;
    const document = currentWorkspace?.documents.find(
      (item) => item.id === currentWorkspace.activeDocumentId,
    );
    if (!document) return;
    try {
      showNotice("正在生成 PDF...");
      const filename = await exportDocumentAsPdf(document);
      showNotice(`已下载 PDF ${filename}`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "PDF 导出失败");
    }
  });

  const exportAll = useEventCallback(() => {
    const currentWorkspace = flushPendingEdits() ?? workspaceRef.current;
    if (!currentWorkspace) return;
    const result = exportWorkspace(currentWorkspace);
    downloadText(result.filename, result.content, result.mime);
    showNotice(currentWorkspace.version >= 2 ? "已导出 JSON 元数据，完整附件请使用工作区 ZIP" : `已导出 ${result.filename}`);
  });
  const exportMap = useEventCallback(async (format: "svg" | "png", transparent: boolean = false) => {
    const current = flushPendingEdits() ?? workspaceRef.current;
    const document = current?.documents.find((item) => item.id === current.activeDocumentId);
    if (!document) return;
    try { await exportMindMap(document, format, transparent); showNotice(`已导出脑图 ${format.toUpperCase()}`); }
    catch (error) { showNotice(error instanceof Error ? error.message : "脑图导出失败"); }
  });
  const cleanAttachments = useEventCallback(async () => {
    const bridge = window.bike ?? window.localOutline;
    if (!bridge?.scanAttachments || !bridge.cleanAttachments) { showNotice("请在桌面版管理附件库"); return; }
    if (attachmentImportRef.current || recoveryBusyRef.current || syncBusyRef.current || historyBusyRef.current || storageConflictRef.current) return;
    const current = flushPendingEdits() ?? workspaceRef.current;
    if (!current) return;
    const saved = await saveWorkspace(current);
    if (!saved.ok || saved.target !== "indexeddb") { showNotice("请先恢复本机主存储，再扫描附件"); return; }
    cleanupBusyRef.current = true;
    recoveryBusyRef.current = true;
    setRecoveryBusy(true);
    const shell = document.querySelector<HTMLElement>(".shell");
    if (shell) shell.inert = true;
    try {
      const roots = async () => {
        const historicalIds = await listHistoryAttachmentIds();
        const backups = await attachmentRecoveryRoots();
        const documents = [...current.documents, ...(current.trash ?? []).map((item) => item.document)];
        for (const entry of [...historyRef.current.past, ...historyRef.current.future]) {
          for (const change of entry.changes) documents.push(change.before, change.after);
          for (const creation of entry.creations ?? []) documents.push(creation.document);
        }
        if (nodeClipboard) documents.push({ ...current.documents[0], nodes: [nodeClipboard.node], attachments: nodeClipboard.attachments });
        for (const backup of backups) documents.push(...backup.documents, ...(backup.trash ?? []).map((item) => item.document));
        return [...new Set([...historicalIds, ...await listLocalMigrationProtectedAssetIds(), ...replicaProtectedAssetIds(await readReplicaState()), ...workspaceAttachmentAssets({ documents }).map((item) => item.assetId)])];
      };
      const scan = await bridge.scanAttachments(await roots());
      if (!scan.ok || !scan.ticket) throw new Error(scan.error || "附件扫描失败");
      const accepted = window.confirm(`找到 ${scan.candidates?.length ?? 0} 个未引用附件，共 ${((scan.byteLength ?? 0) / 1024 / 1024).toFixed(2)} MiB。清理后保留 30 天，可在恢复引用时自动取回。此前隔离满 30 天且仍未引用的文件将永久删除。继续？`);
      if (!accepted) return;
      if (workspaceRef.current !== current || storageConflictRef.current) throw new Error("工作区已变化，请重新扫描");
      const result = await bridge.cleanAttachments(await roots(), scan.ticket);
      if (!result.ok) throw new Error(result.error || "清理失败");
      showNotice(`已隔离 ${result.moved ?? 0} 个附件，清除 ${result.removed ?? 0} 个过期文件`);
    } catch (error) { showNotice(`附件清理已停止 ${error instanceof Error ? error.message : "无法读取全部保护记录"}`); }
    finally {
      if (shell) shell.inert = false;
      cleanupBusyRef.current = false;
      recoveryBusyRef.current = false;
      setRecoveryBusy(false);
    }
  });

  const addAttachments = useEventCallback(async (nodeId?: string, files?: File[]) => {
    const bridge = window.bike ?? window.localOutline;
    if (!bridge?.importAttachments) { showNotice("请在 macOS 桌面版导入附件"); return; }
    if (attachmentBusy || attachmentImportRef.current || storageConflictRef.current || syncBusyRef.current || recoveryBusyRef.current || historyBusyRef.current) return;
    const current = flushPendingEdits() ?? workspaceRef.current;
    const document = current?.documents.find((item) => item.id === current.activeDocumentId);
    const targetId = nodeId ?? activeNodeIdRef.current;
    if (!current || !document || !targetId || !findNode(document.nodes, targetId)) { showNotice("请先选择附件所属主题"); return; }
    if (files && (files.length > MAX_IMPORT_FILES || files.reduce((sum, file) => sum + file.size, 0) > MAX_IMPORT_BYTES)) {
      showNotice("单批最多 100 个文件、合计 512 MiB");
      return;
    }
    const requestId = uuid();
    attachmentImportRef.current = requestId;
    setAttachmentBusy(true);
    try {
      const saved = await saveWorkspace(current);
      if (!saved.ok || saved.target !== "indexeddb") throw new Error("请先完成本机主存储保存，再导入附件");
      let assets: Array<{ assetId: string; name: string; metadata: AttachmentMetadata }> = [];
      const failures: Array<{ name: string; error: string }> = [];
      if (files) {
        for (let index = 0; index < files.length; index++) {
          if (attachmentImportRef.current !== requestId) return;
          const file = files[index];
          if (file.size > MAX_ATTACHMENT_BYTES) { failures.push({ name: file.name, error: "文件超过 128 MiB" }); continue; }
          showNotice(`正在导入附件 ${index + 1}/${files.length}`);
          const result = await bridge.importAttachments({ requestId, files: [{ name: file.name, bytes: await file.arrayBuffer() }] });
          if (!result.ok) throw new Error(result.error || "附件导入失败");
          if (result.cancelled) return;
          assets.push(...(result.assets ?? []));
          failures.push(...(result.failures ?? []));
        }
      } else {
        const result = await bridge.importAttachments({ requestId, choose: true });
        if (!result.ok) throw new Error(result.error || "附件导入失败");
        if (result.cancelled) return;
        assets = result.assets ?? [];
        failures.push(...(result.failures ?? []));
      }
      if (attachmentImportRef.current !== requestId) return;
      if (storageConflictRef.current || recoveryBusyRef.current || syncBusyRef.current) throw new Error("导入期间工作区状态改变，请重试");
      const latest = flushPendingEdits() ?? workspaceRef.current;
      const target = latest?.documents.find((item) => item.id === document.id);
      if (!target || !findNode(target.nodes, targetId)) throw new Error("原主题已被删除，附件未加入正文");
      if (assets.length) {
        commitWorkspace((workspace) => ({
          ...workspace,
          documents: workspace.documents.map((item) => {
            if (item.id !== document.id) return item;
            const items = { ...(item.attachments?.items ?? {}) };
            for (const asset of assets) items[asset.assetId] = asset.metadata;
            return clearDocumentMarkdown({
              ...item, updatedAt: now(), attachments: { version: 1, items },
              nodes: updateNode(item.nodes, targetId, (node) => {
                node.attachmentRefs = [...(node.attachmentRefs ?? []), ...assets.map(({ assetId, name }) => ({ assetId, name }))];
              }),
            });
          }),
        }), { label: "导入附件", group: null, nodeId: targetId });
        setAttachmentGeneration((value) => value + 1);
      }
      showNotice(`已添加 ${assets.length} 个附件${failures.length ? `，${failures.length} 项失败\n${failures.map((item) => `${item.name} ${item.error}`).join("\n")}` : ""}`);
    } catch (error) { showNotice(error instanceof Error ? error.message : "附件导入失败"); }
    finally {
      if (attachmentImportRef.current === requestId) attachmentImportRef.current = null;
      setAttachmentBusy(false);
    }
  });
  const cancelAttachmentImport = useEventCallback(() => {
    const requestId = attachmentImportRef.current;
    attachmentImportRef.current = null;
    if (requestId) void (window.bike ?? window.localOutline)?.cancelAttachmentImport?.(requestId);
    showNotice("正在取消附件导入");
  });
  const downloadMigrationBackup = useEventCallback(async () => {
    try {
      const original = await loadPreAttachmentWorkspace();
      if (!original) { showNotice("当前环境没有附件格式升级前副本"); return; }
      const result = exportWorkspace(original);
      downloadText("bike-workspace-before-attachments-v1.json", result.content, result.mime);
    } catch (error) { showNotice(error instanceof Error ? error.message : "读取升级前副本失败"); }
  });
  const exportArchive = useEventCallback(async () => {
    const bridge = window.bike ?? window.localOutline;
    if (!bridge?.exportWorkspaceArchive) { showNotice("请在 macOS 桌面版导出工作区 ZIP"); return; }
    const current = flushPendingEdits() ?? workspaceRef.current;
    if (!current || storageConflictRef.current || recoveryBusyRef.current) return;
    try {
      const saved = await saveWorkspace(current);
      if (!saved.ok || saved.target !== "indexeddb") showNotice("主存储尚未保存，将直接导出当前编辑内容和附件作为恢复归档");
      const result = await bridge.exportWorkspaceArchive(current);
      if (!result.ok) throw new Error(result.error || "工作区归档失败");
      if (!result.cancelled) showNotice(`已导出完整 ZIP，包含 ${result.attachmentCount ?? 0} 个附件`);
    } catch (error) { showNotice(error instanceof Error ? error.message : "工作区归档失败"); }
  });
  const closeLocalCopyDialog = useEventCallback(() => {
    if (localCopyDialog?.kind === "import") { recoveryBusyRef.current = false; setRecoveryBusy(false); }
    setLocalCopyDialog(null);
  });
  const executeLocalCopyDialog = useEventCallback(async (options: LocalMigrationOptions) => {
    const dialog = localCopyDialog;
    const bridge = window.bike ?? window.localOutline;
    if (!dialog || !bridge?.exportWorkspaceArchive) return;
    if (compositionActiveRef.current || operationCommitRef.current || storageConflictRef.current || syncBusyRef.current || historyBusyRef.current || attachmentImportRef.current || updateInstallRef.current) {
      showNotice("请先结束输入或等待当前操作完成，再处理本机副本"); return;
    }
    const current = flushPendingEdits() ?? workspaceRef.current;
    if (!current) return;
    if (dialog.kind === "import" && current !== dialog.baseline) { showNotice("预览期间工作区已变化，请重新选择本机副本"); closeLocalCopyDialog(); return; }
    setLocalCopyDialog(null);
    recoveryBusyRef.current = true;
    cleanupBusyRef.current = true;
    setRecoveryBusy(true);
    clearAutoSyncTimer();
    pauseLocalBackup("local-copy");
    aiRequestRef.current?.controller.abort();
    const shell = document.querySelector<HTMLElement>(".shell");
    if (shell) shell.inert = true;
    let attemptedImport = false;
    let needsReload = false;
    try {
      const saved = await saveWorkspaceToStorage(current, { requireIndexedDB: true });
      if (!saved.ok || saved.target !== "indexeddb") throw new Error(saved.ok ? "完整本机副本需要主存储保存成功" : saved.error.message);
      if (workspaceRef.current !== current || storageConflictRef.current) throw new Error("快照期间工作区已变化，请重试");
      const backup = await createLocalMigrationExport(current, dialog.kind === "export" ? options : { preferences: false, credentials: false }, async (assetId) => {
        const result = await bridge.readAttachment?.(assetId);
        if (!result?.ok || !result.metadata) throw new Error(result?.error || "源审计附件无法读取，已停止完整副本导出");
        return result.metadata;
      });
      const exported = await bridge.exportWorkspaceArchive(backup);
      if (exported.cancelled) return;
      if (!exported.ok) throw new Error(exported.error || "完整本机副本备份失败");
      if (exported.attachmentCount !== backup.localMigration.assets.length) throw new Error("当前桌面归档服务未包含全部历史附件，请升级后重新导出");
      if (dialog.kind === "export") { showNotice(`已导出完整本机副本，包含 ${backup.localMigration.assets.length} 个附件，源修订 ${backup.localMigration.source.revision}`); return; }
      if (workspaceRef.current !== current || storageConflictRef.current) throw new Error("备份期间有新编辑，已停止导入");
      liveGrantEpochRef.current += 1;
      if (bridge.stopLiveMcp) setLiveState(await bridge.stopLiveMcp());
      if (backupFlightRef.current) await backupFlightRef.current;
      attemptedImport = true;
      const installed = await installLocalMigrationExport(dialog.workspace, current, options, disableLocalCopyAutomaticBackup);
      const config = loadSyncConfig();
      const offlineState = emptySyncState(config.serverUrl);
      saveSyncState(offlineState);
      setSyncConfig(config); setSyncState(offlineState);
      autoSyncDirtyRef.current = false;
      replaceWorkspace(installed);
      clearEditHistory(); lastAutoSnapshotRef.current.clear();
      proposalRegistryRef.current.clear(); liveRequestStatusesRef.current.clear(); setProposals([]);
      setActiveNodeId(firstNodeIdInWorkspace(installed)); setFocusNodeId(null);
      setNodeClipboard(null);
      reloadLocalCopyPreferences(installed);
      refreshRecoverySnapshots();
      setAttachmentGeneration((value) => value + 1);
      showNotice("完整本机副本已导入。已生成新副本身份，同步和自动备份已关闭，源操作保存在只读来源档案中");
    } catch (error) {
      const message = error instanceof Error ? error.message : "完整本机副本处理失败";
      showNotice(message);
      if (attemptedImport) {
        needsReload = true;
        try { needsReload = Boolean(await readLocalMigrationJournal()) || !isWorkspacePersisted(current); } catch { /* Keep loading protected until the journal can be checked. */ }
        if (needsReload) { setReady(false); setLoadError(`完整本机副本尚未确认完成。${message}。请重试加载以恢复或完成导入`); }
      }
    } finally {
      if (shell) shell.inert = false;
      cleanupBusyRef.current = false; recoveryBusyRef.current = false; setRecoveryBusy(false);
      backupLocalPauseRef.current = needsReload ? "load-error" : null;
      void bridge.getBackupStatus?.().then((status) => applyBackupStatus(status as typeof backupStatus));
    }
  });
  const importArchive = useEventCallback(async (assetsOnly = false, completeCopyOnly = false) => {
    const bridge = window.bike ?? window.localOutline;
    if (!bridge?.importWorkspaceArchive) { showNotice("请在 macOS 桌面版载入工作区 ZIP"); return; }
    if (compositionActiveRef.current || operationCommitRef.current || recoveryBusyRef.current || syncBusyRef.current || historyBusyRef.current || storageConflictRef.current || attachmentImportRef.current || updateInstallRef.current) return;
    const current = flushPendingEdits() ?? workspaceRef.current;
    if (!current) return;
    recoveryBusyRef.current = true;
    setRecoveryBusy(true);
    let previewOpen = false;
    try {
      const saved = await saveWorkspace(current);
      if (!saved.ok || saved.target !== "indexeddb") throw new Error("请先完成本机主存储保存");
      const result = await bridge.importWorkspaceArchive();
      if (!result.ok) throw new Error(result.error || "工作区归档导入失败");
      if (result.cancelled) return;
      if (assetsOnly) { setAttachmentGeneration((value) => value + 1); showNotice("附件库已补齐并完成校验"); return; }
      const copy = readLocalMigration(result.workspace);
      if (copy) {
        if (result.attachmentCount !== copy.assets.length) throw new Error("本机副本的历史附件尚未完整校验，已停止导入");
        const validated = validateLocalMigrationImport(result.workspace);
        if (await localMigrationWasInstalled(validated.copy.id)) throw new Error("此本机副本已经导入，当前编辑已保留");
        setLocalCopyDialog({ kind: "import", workspace: result.workspace as Workspace, baseline: current, copy: validated.copy });
        previewOpen = true;
        return;
      }
      if (completeCopyOnly) throw new Error("所选文件是普通工作区 ZIP，请使用载入 ZIP 入口");
      let imported = migrateWorkspace(result.workspace);
      if (current.version === 3) imported = { ...imported, version: 3 };
      markWorkspaceOperation(imported, { source: { kind: "import", label: "从 ZIP 恢复工作区" } });
      if (!window.confirm(`归档包含 ${imported.documents.length} 个文档和 ${result.attachmentCount ?? 0} 个附件。替换前请保存当前工作区副本，继续？`)) return;
      if ((flushPendingEdits() ?? workspaceRef.current) !== current || storageConflictRef.current) throw new Error("导入期间有新编辑，已保留当前工作区");
      if (current.version >= 2) {
        const backup = await bridge.exportWorkspaceArchive?.(current);
        if (!backup?.ok || backup.cancelled) throw new Error("当前工作区完整备份尚未完成，已停止替换");
      } else await downloadWorkspaceBackup(current, "archive-import");
      if ((flushPendingEdits() ?? workspaceRef.current) !== current || storageConflictRef.current) throw new Error("备份期间有新编辑，已停止替换");
      replaceWorkspace(imported);
      clearEditHistory();
      setActiveNodeId(firstNodeIdInWorkspace(imported));
      setFocusNodeId(null);
      setNavigation((state) => resetRecentOpens(pruneNavigation(state, { liveIds: imported.documents.map((item) => item.id), trashIds: (imported.trash ?? []).map((entry) => entry.document.id) })));
      const persisted = await saveWorkspace(imported);
      if (!persisted.ok) throw persisted.error;
      if (persisted.target !== "indexeddb") throw new Error("恢复内容暂存于备用存储，请恢复主存储后重试保存");
      setAttachmentGeneration((value) => value + 1);
      showNotice("工作区和附件已恢复");
    } catch (error) { showNotice(error instanceof Error ? error.message : "工作区归档导入失败"); }
    finally { if (!previewOpen) { recoveryBusyRef.current = false; setRecoveryBusy(false); } }
  });

  const backupToCloud = useEventCallback(async () => {
    const currentWorkspace = flushPendingEdits() ?? workspaceRef.current;
    if (!currentWorkspace) return;
    try {
      const expectedRevision =
        localStorage.getItem(ICLOUD_REVISION_KEY) ??
        localStorage.getItem(LEGACY_ICLOUD_REVISION_KEY) ??
        undefined;
      const bridge = window.bike ?? window.localOutline;
      let result;
      if (bridge?.enqueueBackup) {
        const saved = await saveWorkspace(currentWorkspace);
        if (!saved.ok || saved.target !== "indexeddb") {
          showNotice("本机保存未完成，未写入备份");
          return;
        }
        result = await bridge.enqueueBackup({ workspace: currentWorkspace, sourceRevision: getWorkspaceSaveRevision(currentWorkspace), semanticHash: backupContentHash(currentWorkspace), manual: true, wait: true });
      } else {
        result = await saveICloudBackup(currentWorkspace, expectedRevision);
      }
      if (result.ok && result.revision) {
        localStorage.setItem(ICLOUD_REVISION_KEY, result.revision);
        localStorage.removeItem(LEGACY_ICLOUD_REVISION_KEY);
      }
      showNotice(result.ok ? `iCloud 备份已保存：${result.path}` : result.error ?? "备份失败");
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
    }
  });

  const loadCloudBackup = useEventCallback(async () => {
    flushPendingEdits();
    const bikeBridge = window.bike ?? window.localOutline;
    if (!bikeBridge) {
      showNotice("浏览器版请用“导入”选择 iCloud Drive 里的 bike-workspace.json");
      return;
    }
    const result = await bikeBridge.loadICloudBackup();
    if (
      !result.ok ||
      !result.payload ||
      typeof result.payload !== "object" ||
      !("documents" in result.payload)
    ) {
      showNotice(result.error ?? "没有找到可用的 iCloud 备份");
      return;
    }
    let next: Workspace;
    try {
      if ("localMigration" in result.payload) throw new Error("完整本机副本需要从导入本机副本入口选择原始 ZIP");
      next = migrateWorkspace(result.payload);
    } catch (error) {
      showNotice(`载入备份失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    // Same protection as importing a workspace or pulling from the server:
    // confirm the replacement and keep a copy of what is being replaced.
    const confirmed = window.confirm(
      `载入 iCloud 备份「${result.path ?? "bike-workspace.json"}」（${next.documents.length} 个文档）会替换当前所有文档。继续前会先下载一份当前工作区备份。`,
    );
    if (!confirmed) {
      showNotice("已取消载入备份");
      return;
    }
    const currentWorkspace = flushPendingEdits() ?? workspaceRef.current;
    try { if (currentWorkspace) await downloadWorkspaceBackup(currentWorkspace, "load-backup"); }
    catch (error) { showNotice(error instanceof Error ? error.message : "备份失败"); return; }
    if ((flushPendingEdits() ?? workspaceRef.current) !== currentWorkspace) { showNotice("备份期间内容已变化，请重新载入"); return; }
    if (currentWorkspace?.version === 3) next = { ...next, version: 3 };
    markWorkspaceOperation(next, { source: { kind: "restore", label: "载入外部备份" } });
    pauseLocalBackup("restoring");
    pruneBackupPayloads(backupPayloadsRef.current, backupScheduleRef.current);
    replaceWorkspace(next);
    clearEditHistory();
    setActiveNodeId(firstNodeIdInWorkspace(next));
    setFocusNodeId(null);
    const saved = await saveWorkspace(next);
    if (!saved.ok || saved.target !== "indexeddb") {
      showNotice("备份已载入，但本机保存未成功，自动备份仍暂停");
      return;
    }
    if (result.revision && bikeBridge.acceptBackupBaseline) {
      const accepted = await bikeBridge.acceptBackupBaseline(result.revision, { workspace: next, sourceRevision: getWorkspaceSaveRevision(next), semanticHash: backupContentHash(next), ticket: ++backupTicketRef.current });
      if (accepted.ok !== true) {
        showNotice("外部备份再次变化，自动备份仍暂停，请重新查看外部变更");
        return;
      }
      localStorage.setItem(ICLOUD_REVISION_KEY, result.revision);
      localStorage.removeItem(LEGACY_ICLOUD_REVISION_KEY);
      backupLocalPauseRef.current = null;
      applyBackupStatus(accepted as typeof backupStatus);
      const latest = workspaceRef.current;
      if (latest && latest !== next) {
        await saveWorkspace(latest);
      }
    }
    showNotice(`已载入 iCloud 备份：${result.path}`);
  });

  const applySyncedWorkspace = useEventCallback((next: Workspace) => {
    const current = workspaceRef.current;
    const previousById = new Map(current?.documents.map((document) => [document.id, document]));
    const documents = next.documents.map((document) => {
      const previous = previousById.get(document.id);
      return previous && sameDocumentContent(previous, document) ? previous : document;
    });
    const activeDocumentId = documents.some((document) => document.id === current?.activeDocumentId)
      ? current!.activeDocumentId : next.activeDocumentId;
    const unchanged = current && activeDocumentId === current.activeDocumentId &&
      documents.length === current.documents.length && documents.every((document, index) => document === current.documents[index]) &&
      next.trash === current.trash;
    const merged = unchanged ? current : { ...next, documents, activeDocumentId };
    syncAppliedWorkspaceRef.current = merged;
    if (merged === current) return merged;
    replaceWorkspace(merged);
    const activeDocument = documents.find((document) => document.id === activeDocumentId);
    if (!activeDocument || !activeNodeIdRef.current || !findNode(activeDocument.nodes, activeNodeIdRef.current)) {
      setActiveNodeId(firstNodeIdInWorkspace(merged));
    }
    if (focusNodeId && (!activeDocument || !findNode(activeDocument.nodes, focusNodeId))) setFocusNodeId(null);
    return merged;
  });

  // Another tab or window saved a newer workspace: catch up, but only while this
  // page has no unsaved edits. With unsaved edits the next save is refused as a
  // conflict instead, so nothing is overwritten either way.
  const refreshFromStorage = useEventCallback(async () => {
    if (!ready || storageConflictRef.current || syncBusyRef.current) return;
    const current = flushPendingEdits() ?? workspaceRef.current;
    if (!current) return;
    if (!isWorkspacePersisted(current)) {
      // A fallback save may have succeeded without scheduling another IDB
      // write. A newer broadcast must still surface the conflict immediately.
      handleStorageConflict();
      return;
    }
    const next = await reloadWorkspaceIf(() =>
      !storageConflictRef.current &&
      !syncBusyRef.current &&
      (flushPendingEdits() ?? workspaceRef.current) === current &&
      isWorkspacePersisted(current),
    );
    if (!next) return;
    const retained = next.documents.some((item) => item.id === current.activeDocumentId)
      ? { ...next, activeDocumentId: current.activeDocumentId } : next;
    refreshedWorkspaceRef.current = retained;
    replaceWorkspace(retained);
    refreshRecoverySnapshots();
    setSyncState(loadSyncState(syncConfig.serverUrl));
    const activeDocument = retained.documents.find((item) => item.id === retained.activeDocumentId) ?? retained.documents[0];
    const activeId = activeNodeIdRef.current;
    if (!activeDocument || !activeId || !findNode(activeDocument.nodes, activeId)) {
      setActiveNodeId(firstNodeIdInWorkspace(retained));
    }
  });

  const handleStorageConflict = useEventCallback(() => {
    const current = flushPendingEdits() ?? workspaceRef.current;
    if (current && isWorkspacePersisted(current)) {
      // Nothing unsaved here (e.g. a missed broadcast): just catch up.
      void refreshFromStorage();
      return;
    }
    storageConflictRef.current = true;
    pauseLocalBackup("storage-conflict");
    setStorageConflict(true);
    clearAutoSyncTimer();
    if (current) {
      const snapshot = saveWorkspaceFallback(current);
      if (!snapshot.ok) showNotice(`备用副本保存失败：${snapshot.error.message}`);
    }
    refreshRecoverySnapshots();
  });

  useEffect(() => subscribeToWorkspaceConflicts(handleStorageConflict), []);

  useEffect(() => {
    if (!ready) return;
    return subscribeToWorkspaceChanges(() => {
      refreshRecoverySnapshots();
      void refreshFromStorage();
    });
  }, [ready]);

  useEffect(() => {
    // Other pages adding or clearing snapshots should update the recovery entry
    // without adopting any of their pending edits.
    const handleStorage = () => refreshRecoverySnapshots();
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const reloadAfterConflict = useEventCallback(async () => {
    if (recoveryBusyRef.current || syncBusyRef.current) return;
    recoveryBusyRef.current = true;
    setRecoveryBusy(true);
    try {
      const current = flushPendingEdits() ?? workspaceRef.current;
      if (current && !isWorkspacePersisted(current)) {
        await downloadWorkspaceBackup(current, "reload");
      }
      const loaded = await initializeWorkspace(() => true, { includeFallback: false });
      if (!loaded) return;
      storageConflictRef.current = false;
      setStorageConflict(false);
      showNotice("已载入最新内容，本页未保存的修改已下载为备份文件");
    } catch (error) { showNotice(error instanceof Error ? error.message : "备份或恢复失败"); } finally {
      recoveryBusyRef.current = false;
      setRecoveryBusy(false);
    }
  });

  const overwriteAfterConflict = useEventCallback(async () => {
    if (recoveryBusyRef.current || syncBusyRef.current) return;
    const current = flushPendingEdits() ?? workspaceRef.current;
    if (!current) return;
    const confirmed = window.confirm(
      "用本页内容覆盖会替换其他标签页或窗口已保存的修改。继续前会先下载一份已保存版本的备份。",
    );
    if (!confirmed) return;
    recoveryBusyRef.current = true;
    setRecoveryBusy(true);
    try {
      const latest = await loadWorkspace({ includeFallback: false });
      if (latest.status === "error") {
        showNotice(`读取已保存版本失败：${latest.error.message}`);
        return;
      }
      if (latest.status === "loaded") await downloadWorkspaceBackup(latest.workspace, "overwrite");
      // Refuse the replacement if another save lands after this backed-up read.
      const result = await saveWorkspace(current);
      if (!result.ok) {
        showNotice(result.conflict ? "下载备份后工作区再次更新，已停止覆盖；请重新读取最新版本后重试" : `保存失败：${result.error.message}`);
        return;
      }
      storageConflictRef.current = false;
      setStorageConflict(false);
      refreshRecoverySnapshots();
      showNotice(result.target === "indexeddb"
        ? "已用本页内容覆盖已保存的工作区"
        : "IndexedDB 不可用，本页内容仍保存在备用存储中");
    } catch (error) { showNotice(error instanceof Error ? error.message : "备份或恢复失败"); } finally {
      recoveryBusyRef.current = false;
      setRecoveryBusy(false);
    }
  });

  const restoreRecoverySnapshot = useEventCallback(async (snapshot: WorkspaceRecoverySnapshot) => {
    if (recoveryBusyRef.current || syncBusyRef.current) return;
    if (!window.confirm("恢复这个备用副本会替换当前工作区。继续前会先下载当前内容和已保存版本的备份。")) return;
    recoveryBusyRef.current = true;
    setRecoveryBusy(true);
    storageConflictRef.current = true;
    setStorageConflict(true);
    clearAutoSyncTimer();
    try {
      const current = flushPendingEdits() ?? workspaceRef.current;
      if (current) await downloadWorkspaceBackup(current, "recovery-current");
      const latest = await loadWorkspace({ includeFallback: false });
      if (latest.status === "error") throw latest.error;
      if (latest.status === "loaded") await downloadWorkspaceBackup(latest.workspace, "recovery-saved");
      const importedSource = snapshot.id.startsWith("import:");
      const restored = importedSource && (current?.version === 3 || (latest.status === "loaded" && latest.workspace.version === 3))
        ? { ...snapshot.workspace, version: 3 as const } : snapshot.workspace;
      if (importedSource) markWorkspaceOperation(restored, { source: { kind: "restore", label: "恢复导入的源备用副本" } });
      const saved = await saveWorkspace(restored);
      if (!saved.ok) throw saved.error;
      replaceWorkspace(restored);
      clearEditHistory();
      setActiveNodeId(firstNodeIdInWorkspace(restored));
      setFocusNodeId(null);
      // Keep the selected copy until it is durable in IndexedDB. A temporary
      // fallback save must not be mistaken for a completed recovery.
      if (saved.target === "indexeddb" && !importedSource) discardWorkspaceRecoverySnapshot(snapshot);
      storageConflictRef.current = false;
      setStorageConflict(false);
      setShowRecoverySnapshots(false);
      refreshRecoverySnapshots();
      showNotice(saved.target === "indexeddb"
        ? "已恢复备用副本，替换前的工作区已下载为备份"
        : "已恢复备用副本，IndexedDB 不可用，内容仍保存在备用存储中");
    } catch (error) {
      showNotice(`恢复备用副本失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      recoveryBusyRef.current = false;
      setRecoveryBusy(false);
    }
  });

  const discardRecoverySnapshot = useEventCallback(async (snapshot: WorkspaceRecoverySnapshot) => {
    if (!window.confirm("删除这个备用副本前会先下载它的备份文件。继续？")) return;
    try { await downloadWorkspaceBackup(snapshot.workspace, "discard-recovery"); }
    catch (error) { showNotice(error instanceof Error ? error.message : "备份失败"); return; }
    const removed = discardWorkspaceRecoverySnapshot(snapshot);
    refreshRecoverySnapshots();
    showNotice(removed ? "备用副本已下载并删除" : "备用副本已有变化或无法删除，请重新查看");
  });

  const syncErrorMessage = (error: unknown) => {
    const status = typeof error === "object" && error && "status" in error
      ? (error as { status?: unknown }).status
      : null;
    if (status === 401) return "同步认证失败，请检查登录状态或设备密钥";
    if (status === 404) return "同步服务不可用，请确认 Web 服务已启用同步";
    return error instanceof Error ? error.message : "同步失败";
  };

  const syncNow = useEventCallback(async (
    overrideConfig?: SyncConfig,
    options: { silent?: boolean } = {},
  ) => {
    if (options.silent && readPreference("bike-local-copy-offline", "") === "1") return;
    if (syncBusyRef.current || storageConflictRef.current || recoveryBusyRef.current || historyBusyRef.current) return;
    const currentWorkspace = flushPendingEdits() ?? workspaceRef.current;
    if (!currentWorkspace) return;
    // Read the sync state from storage rather than React state: another tab may
    // have synced (and this page reloaded its documents) since it last rendered.
    const activeSync = overrideConfig
      ? persistSyncConfig(overrideConfig)
      : { config: syncConfig, state: loadSyncState(syncConfig.serverUrl) };
    if (usesDesktopSyncProxy() && !activeSync.config.token.trim()) {
      if (!options.silent) showNotice("Electron 同步需要设备密钥。");
      return;
    }
    syncBusyRef.current = true;
    setSyncBusy(true);
    autoSyncDirtyRef.current = false;
    let retryAfterEdit = false;
    if (!options.silent) showNotice("正在同步文档...");
    try {
      const initialSave = await saveWorkspace(currentWorkspace);
      if (!initialSave.ok) throw initialSave.error;
      if (currentWorkspace.version === 3) {
        let replica = await readReplicaState();
        if (!replica) throw new Error("缺少本机操作记录");
        if (replica.initialWorkspace && !replica.syncStarted && !replica.remote) {
          const marked = await saveWorkspaceToStorage(currentWorkspace, {
            expectedWorkspace: currentWorkspace, replicaUpdate: { ...replica, syncStarted: true }, requireIndexedDB: true,
          });
          if (!marked.ok) throw marked.error;
          replica = await readReplicaState();
          if (!replica) throw new Error("本机同步标记未保存");
        }
        let result: Awaited<ReturnType<typeof syncOperationWorkspace>>;
        try { result = await syncOperationWorkspace(currentWorkspace, activeSync.config, replica); }
        catch (error) {
          if ((error as { code?: string }).code !== "initial-collision" || options.silent) throw error;
          if (!window.confirm(`${(error as Error).message}\n\n继续前会下载本机备份。是否继续比较？`)) throw new Error("已取消首次接入，本机内容保持不变");
          await downloadWorkspaceBackup(currentWorkspace, "initial-sync-collision");
          if (!sameWorkspaceContent(flushPendingEdits() ?? workspaceRef.current!, currentWorkspace)) {
            retryAfterEdit = true; throw new Error("备份期间出现新编辑，请重新比较");
          }
          result = await syncOperationWorkspace(currentWorkspace, activeSync.config, replica, { allowInitialCollision: true });
        }
        if (!result.unchanged) {
        const latest = flushPendingEdits() ?? workspaceRef.current;
        if (!latest || !sameWorkspaceContent(latest, currentWorkspace)) { retryAfterEdit = true; showNotice("同步期间有新编辑，已保留内容，下一轮会继续同步"); return; }
        await captureSyncSnapshots(latest, result.workspace);
        const afterSnapshots = flushPendingEdits() ?? workspaceRef.current;
        if (!afterSnapshots || !sameWorkspaceContent(afterSnapshots, latest) || storageConflictRef.current ||
            (typeof compositionActiveRef !== "undefined" && compositionActiveRef.current)) { retryAfterEdit = true; return; }
        const received = { ...result.workspace, activeDocumentId: afterSnapshots.activeDocumentId };
        if (!received.documents.some((document) => document.id === received.activeDocumentId)) received.activeDocumentId = received.documents[0]?.id ?? "";
        const shell = typeof document !== "undefined" ? document.querySelector<HTMLElement>(".shell") : null;
        const unlock = lockWorkspaceInteraction(shell);
        operationCommitRef.current = true;
        try {
          const saved = await saveWorkspaceToStorage(received, { expectedWorkspace: afterSnapshots, replicaUpdate: result.replica, requireIndexedDB: true });
          if (!saved.ok) throw saved.error;
          applySyncedWorkspace(received); syncAppliedWorkspaceRef.current = workspaceRef.current;
          showSaveResult(saved, received);
        } finally { operationCommitRef.current = false; unlock(); }
        }
        persistSyncState({ ...activeSync.state, lastSyncedAt: now() });
        retryAfterEdit = result.hasMore; autoSyncDirtyRef.current = result.hasMore;
        const bridge = window.bike ?? window.localOutline;
        const assets = workspaceAttachmentAssets(result.workspace);
        if (assets.length && bridge?.syncAttachments) {
          const transferred = await bridge.syncAttachments(assets);
          setAttachmentGeneration((value) => value + 1);
          if (!transferred.ok || !transferred.complete) { showNotice(`正文已同步，附件待重试 ${transferred.error ?? transferred.errors?.map((item) => item.message).join("、") ?? "传输未完成"}`); return; }
          showNotice(`${summarizeSyncResult(result.summary)}${result.hasMore ? " · 正文仍有待同步操作" : ""} · 附件同步完成 ${transferred.completed}/${transferred.total}`);
        } else showNotice(`${summarizeSyncResult(result.summary)}${assets.length ? " · 附件需要桌面版补齐" : ""}`);
        return;
      }
      const result = await syncWorkspaceWithRemote(
        currentWorkspace,
        activeSync.config,
        activeSync.state,
        { onCheckpoint: persistSyncState },
      );
      if (!sameWorkspaceContent(flushPendingEdits() ?? workspaceRef.current!, currentWorkspace)) {
        retryAfterEdit = true;
        showNotice("同步期间有新编辑，已保留本机内容，请稍后再次同步");
        return;
      }
      await captureSyncSnapshots(currentWorkspace, result.workspace);
      if (!sameWorkspaceContent(flushPendingEdits() ?? workspaceRef.current!, currentWorkspace) || storageConflictRef.current) {
        retryAfterEdit = true;
        showNotice("保存同步前快照期间有新编辑，已保留本机内容，请稍后再次同步");
        return;
      }
      const retained = retainLocalTrash(workspaceRef.current ?? currentWorkspace, result.workspace);
      const nextWorkspace = applySyncedWorkspace(retained) ?? retained;
      if (nextWorkspace !== currentWorkspace) {
        const saved = await saveWorkspace(nextWorkspace);
        if (!saved.ok) throw saved.error;
        if (saved.target === "localstorage") throw new Error("同步内容暂存于备用存储，尚未确认下载基线；请恢复本机主存储后重试");
      }
      persistSyncState(result.state);
      retryAfterEdit = !sameWorkspaceContent(workspaceRef.current!, nextWorkspace);
      autoSyncDirtyRef.current = retryAfterEdit;
      const changed =
        result.summary.uploaded > 0 ||
        result.summary.downloaded > 0 ||
        result.summary.deleted > 0 ||
        result.summary.conflicts.length > 0;
      if (result.summary.checkpointErrors?.length) showNotice(`同步已完成，进度保存曾失败 ${result.summary.checkpointErrors.length} 次；本次进度已重新保存`);
      else if (!options.silent || changed) showNotice(summarizeSyncResult(result.summary));
    } catch (error) {
      showNotice(options.silent ? `后台同步失败：${syncErrorMessage(error)}` : syncErrorMessage(error));
    } finally {
      syncBusyRef.current = false;
      setSyncBusy(false);
      if (retryAfterEdit) scheduleAutoSync();
    }
  });

  useEffect(() => (window.bike ?? window.localOutline)?.onAttachmentSyncProgress?.(setAttachmentSyncProgress), []);

  const canAutoSync = useEventCallback(() => (
    ready &&
    !storageConflictRef.current &&
    !recoveryBusyRef.current &&
    !syncBusyRef.current &&
    syncConfig.autoSync &&
    (!usesDesktopSyncProxy() || Boolean(syncConfig.token.trim())) &&
    Boolean(normalizeSyncServerUrl(syncConfig.serverUrl))
  ));

  const scheduleAutoSync = useEventCallback((delayMs: number = 5000) => {
    clearAutoSyncTimer();
    if (!canAutoSync()) return;
    autoSyncTimerRef.current = window.setTimeout(() => {
      autoSyncTimerRef.current = null;
      if (!canAutoSync()) return;
      syncNow(undefined, { silent: true });
    }, delayMs);
  });

  useEffect(() => {
    const previous = autoSyncObservedWorkspaceRef.current;
    autoSyncObservedWorkspaceRef.current = workspace;
    if (!workspace || !ready || storageConflict || !syncConfig.autoSync) return;
    // A copy reloaded from another page's save is that page's to sync.
    if (workspace === refreshedWorkspaceRef.current || workspace === syncAppliedWorkspaceRef.current) return;
    if (!previous || !sameWorkspaceContent(previous, workspace)) autoSyncDirtyRef.current = true;
    if (!autoSyncDirtyRef.current) return;
    scheduleAutoSync();
  }, [workspace, ready, storageConflict, syncConfig.autoSync, syncConfig.serverUrl]);

  useEffect(() => {
    if (!ready || !syncConfig.autoSync) return;
    const intervalMs = normalizeAutoSyncInterval(syncConfig.autoSyncIntervalSeconds) * 1000;
    const handle = window.setInterval(() => {
      syncNow(undefined, { silent: true });
    }, intervalMs);
    return () => window.clearInterval(handle);
  }, [
    ready,
    syncConfig.autoSync,
    syncConfig.autoSyncIntervalSeconds,
    syncConfig.serverUrl,
    syncConfig.token,
  ]);

  const pushLocalWorkspace = useEventCallback(async (overrideConfig?: SyncConfig) => {
    if (workspaceRef.current?.version === 3) { await syncNow(overrideConfig); return; }
    if (syncBusyRef.current) return;
    const currentWorkspace = flushPendingEdits() ?? workspaceRef.current;
    if (!currentWorkspace) return;
    const confirmed = window.confirm(
      "上传本机文档会用当前本机版本更新服务端同名文档。确定继续？",
    );
    if (!confirmed) {
      showNotice("已取消上传");
      return;
    }
    const activeSync = overrideConfig
      ? persistSyncConfig(overrideConfig)
      : { config: syncConfig, state: syncState };
    if (usesDesktopSyncProxy() && !activeSync.config.token.trim()) {
      showNotice("Electron 上传需要设备密钥。");
      return;
    }
    syncBusyRef.current = true;
    setSyncBusy(true);
    showNotice("正在上传本机文档...");
    try {
      const initialSave = await saveWorkspace(currentWorkspace);
      if (!initialSave.ok) throw initialSave.error;
      const result = await pushWorkspaceToRemote(currentWorkspace, activeSync.config, {
        onCheckpoint: persistSyncState,
      });
      persistSyncState(result.state);
      showNotice(summarizeSyncResult(result.summary));
    } catch (error) {
      showNotice(syncErrorMessage(error));
    } finally {
      syncBusyRef.current = false;
      setSyncBusy(false);
    }
  });

  const pullRemoteWorkspace = useEventCallback(async (overrideConfig?: SyncConfig) => {
    if (workspaceRef.current?.version === 3) { await syncNow(overrideConfig); return; }
    if (syncBusyRef.current || historyBusyRef.current || recoveryBusyRef.current || storageConflictRef.current) return;
    const currentWorkspace = flushPendingEdits() ?? workspaceRef.current;
    if (!currentWorkspace) return;
    const confirmed = window.confirm(
      "从服务端拉取会替换当前本机工作区。继续前会先下载一份本机备份。",
    );
    if (!confirmed) {
      showNotice("已取消拉取");
      return;
    }
    try { await downloadWorkspaceBackup(currentWorkspace, "sync-pull"); }
    catch (error) { showNotice(error instanceof Error ? error.message : "备份失败"); return; }
    const activeSync = overrideConfig
      ? persistSyncConfig(overrideConfig)
      : { config: syncConfig, state: syncState };
    if (usesDesktopSyncProxy() && !activeSync.config.token.trim()) {
      showNotice("Electron 拉取需要设备密钥。");
      return;
    }
    syncBusyRef.current = true;
    setSyncBusy(true);
    showNotice("正在从服务端拉取...");
    try {
      const result = await pullWorkspaceFromRemote(activeSync.config);
      if (!result.workspace) {
        showNotice("服务端暂无文档");
        return;
      }
      if ((flushPendingEdits() ?? workspaceRef.current) !== currentWorkspace) {
        showNotice("拉取期间有新编辑，已保留本机内容，未替换工作区");
        return;
      }
      await captureSyncSnapshots(currentWorkspace, result.workspace);
      if ((flushPendingEdits() ?? workspaceRef.current) !== currentWorkspace || storageConflictRef.current) {
        showNotice("保存拉取前快照期间有新编辑，已保留本机内容，未替换工作区");
        return;
      }
      const retained = retainLocalTrash(currentWorkspace, result.workspace);
      const nextWorkspace = applySyncedWorkspace(retained) ?? retained;
      clearEditHistory();
      const saved = await saveWorkspace(nextWorkspace);
      if (!saved.ok) throw saved.error;
      if (saved.target === "localstorage") throw new Error("拉取内容暂存于备用存储，尚未确认下载基线；请恢复本机主存储后重试");
      persistSyncState(result.state);
      showNotice(`已从服务端拉取 ${result.workspace.documents.length} 个文档`);
    } catch (error) {
      showNotice(syncErrorMessage(error));
    } finally {
      syncBusyRef.current = false;
      setSyncBusy(false);
    }
  });

  const checkUpdates = useEventCallback(async () => {
    if (isCheckingUpdates) return;
    setIsCheckingUpdates(true);
    showNotice("正在检查更新...");
    try {
      const bikeBridge = window.bike ?? window.localOutline;
      if (!bikeBridge?.checkForUpdates) {
        const shouldOpen = window.confirm(
          `当前版本：${__APP_VERSION__}\n\n浏览器版无法自动读取桌面发布信息，是否打开发布页查看更新？`,
        );
        if (shouldOpen) {
          window.open(__RELEASE_PAGE_URL__, "_blank", "noopener,noreferrer");
          showNotice("已打开发布页查看更新");
        } else {
          showNotice("已取消检查更新");
        }
        return;
      }

      const result = await bikeBridge.checkForUpdates();
      if (!result.ok) {
        showNotice(`更新未完成 ${result.error ?? "请稍后重试"}`);
        return;
      }
      if (result.status === "not-available") {
        showNotice(`已是最新版本：${result.currentVersion}`);
      }
    } catch (error) {
      showNotice(`更新失败 ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsCheckingUpdates(false);
    }
  });

  const handleImport = useEventCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    flushPendingEdits();
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const source = await file.text();
      let imported: OutlineDocument | Workspace;
      try {
        imported = importDocument(source, file.name);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("BIKE_METADATA:")) throw error;
        const accepted = window.confirm(`${error.message.slice("BIKE_METADATA:".length)}\n\n可以只导入正文，或取消并保留原文件。`);
        if (!accepted) {
          showNotice("已取消导入");
          return;
        }
        imported = importDocument(source, file.name, { dropMetadata: true });
      }
      if ("documents" in imported) {
        if ("localMigration" in imported) throw new Error("完整本机副本需要从导入本机副本入口选择原始 ZIP，以校验历史与附件");
        const currentWorkspace = flushPendingEdits() ?? workspaceRef.current;
        const shouldReplace = window.confirm(
          `导入工作区「${file.name}」会替换当前所有文档。继续前会先下载一份当前工作区备份。`,
        );
        if (!shouldReplace) {
          showNotice("已取消导入工作区");
          return;
        }
        if (currentWorkspace) await downloadWorkspaceBackup(currentWorkspace, "import");
        if ((flushPendingEdits() ?? workspaceRef.current) !== currentWorkspace) throw new Error("备份期间内容已变化，已停止替换");
        if (currentWorkspace?.version === 3) imported = { ...imported, version: 3 as const };
        markWorkspaceOperation(imported, { source: { kind: "import", label: "导入工作区副本" } });
        const acceptedWorkspace = imported;
        replaceWorkspace(imported);
        clearEditHistory();
        setNavigation((state) => resetRecentOpens(pruneNavigation(state, {
          liveIds: acceptedWorkspace.documents.map((document) => document.id),
          trashIds: (acceptedWorkspace.trash ?? []).map((entry) => entry.document.id),
        })));
        setActiveNodeId(firstNodeIdInWorkspace(imported));
        setFocusNodeId(null);
        showNotice(`已导入工作区：${file.name}`);
        return;
      }
      setFocusNodeId(null);
      let importedId = imported.id;
      const placed = commitWorkspace((current) => {
        const usedIds = new Set<string>();
        const addTree = (nodes: OutlineNode[]) => {
          nodes.forEach((node) => {
            usedIds.add(node.id);
            addTree(node.children ?? []);
          });
        };
        current.documents.forEach((document) => {
          usedIds.add(document.id);
          addTree(document.nodes);
        });
        (current.trash ?? []).forEach((entry) => {
          usedIds.add(entry.document.id);
          addTree(entry.document.nodes);
        });
        const remapped = remapCollidingIds(imported, usedIds, (prefix) => prefix === "doc" ? uuid() : uid());
        importedId = remapped.document.id;
        return {
          ...current,
          activeDocumentId: remapped.document.id,
          documents: [remapped.document as OutlineDocument, ...current.documents],
        };
      });
      if (placed) setActiveNodeId(firstNodeId(placed.documents.find((document) => document.id === importedId)?.nodes ?? []));
      showNotice(`已导入文档：${file.name}`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "导入失败");
    }
  });

  const saveCurrentFilter = useEventCallback(() => {
    const name = window.prompt("筛选名称", search || selectedTags.join("、") || "未命名筛选");
    if (name) setNavigation((state) => saveNavigationFilter(state, { name, query: search, tags: selectedTags, task: taskFilter, documentIds: filterDocumentIds, favoriteOnly, includeCode }));
  });

  const changeRelation = useEventCallback((action: "add" | "update" | "delete" | "reverse", input: Partial<MindRelation>) => {
    flushPendingEdits();
    let success = false;
    patchActiveDocumentStable((document) => {
      if (document.knowledge && !knowledgeEditable(document.knowledge)) { showNotice("请升级后再修改这份文档的关系"); return document; }
      const result = action === "add" ? addRelation(document, { fromNodeId: input.fromNodeId || "", toNodeId: input.toNodeId || "", label: input.label })
        : action === "update" ? updateRelation(document, input.id || "", input)
        : action === "reverse" ? reverseRelation(document, input.id || "")
        : { document: deleteRelation(document, input.id || ""), error: null };
      if (result.error) { showNotice(result.error); return document; }
      success = true;
      return result.document;
    }, { label: action === "add" ? "添加关系" : action === "delete" ? "删除关系" : action === "reverse" ? "反转关系" : "编辑关系", group: null, preserveMarkdown: true });
    return success;
  });

  const setNodeRef = useEventCallback((id: string, element: HTMLTextAreaElement | null) => {
    if (element) {
      inputRefs.current.set(id, element);
    } else {
      inputRefs.current.delete(id);
      labelBaselineRef.current.delete(id);
    }
  });
  const handleLabelFocus = useEventCallback((id: string, value: string) => { labelBaselineRef.current.set(id, value); });
  const handleLinkSuggestions = useEventCallback((query: string) => workspaceRef.current ? suggestLinkTargets(workspaceRef.current, query) : { items: [], requiresExplicit: false, highlight: -1 });
  const handleNodeLinkFollow = useEventCallback((raw: string, source: Omit<LinkOrigin, "documentId">) => {
    const current = workspaceRef.current;
    if (current) followWikiLink(raw, { ...source, documentId: current.activeDocumentId });
  });
  const handleMindMapLabel = useEventCallback((id: string, value: string) => {
    const document = workspaceRef.current?.documents.find((item) => item.id === workspaceRef.current?.activeDocumentId);
    publishNodeLabel(id, document ? findNode(document.nodes, id)?.text ?? value : value, value);
  });
  const isStructuredAiBusy = useCallback((id: StructuredAiTargetId) => Boolean(aiBusyKey?.startsWith(`structured:${id}:`)), [aiBusyKey]);
  const attachmentsAvailable = Boolean((window.bike ?? window.localOutline)?.importAttachments);
  const attachmentActions = useMemo(() => ({
    add: (id: string) => void addAttachments(id),
    available: attachmentsAvailable,
    busy: attachmentBusy,
    generation: attachmentGeneration,
  }), [addAttachments, attachmentsAvailable, attachmentBusy, attachmentGeneration]);

  if (loadError) {
    return (
      <main className="loading loading-error">
        <section>
          <h1>无法打开本地工作区</h1>
          <p>{loadError}</p>
          <button type="button" onClick={() => initializeWorkspace()}>
            重试
          </button>
          <button type="button" onClick={() => setRecoveryFiles(listWorkspaceRecoveryFiles())}>查找备用副本</button>
          {recoveryFiles.map((file, index) => <p key={file.id}><button type="button" onClick={() => downloadText(`bike-recovery-${index + 1}.json`, file.content, "application/json")}>下载备用副本 {index + 1}</button></p>)}
        </section>
      </main>
    );
  }

  if (showRecoverySnapshots) {
    return (
      <main className="loading loading-error workspace-recovery">
        <section>
          <h1>未保存的备用副本</h1>
          <p>其他标签页保存后留下的修改会保留在这里。可以先下载查看，再决定恢复或删除。</p>
          {!recoverySnapshots.length && <p>没有其他备用副本。</p>}
          {recoverySnapshots.map((snapshot) => (
            <article className="recovery-snapshot" key={snapshot.id}>
              <strong>{snapshot.workspace.documents[0]?.title || "工作区"}</strong>
              <p>{snapshot.workspace.documents.length} 个文档 · {snapshot.savedAt ? formatTime(new Date(snapshot.savedAt).toISOString()) : "时间未知"}</p>
              <div className="loading-error-actions">
                <button type="button" onClick={() => void downloadWorkspaceBackup(snapshot.workspace, "recovery").catch((error) => showNotice(error.message))} disabled={recoveryBusy}>下载副本</button>
                <button type="button" onClick={() => void restoreRecoverySnapshot(snapshot)} disabled={recoveryBusy || syncBusy}>恢复这个副本</button>
                {!snapshot.id.startsWith("import:") && <button type="button" onClick={() => discardRecoverySnapshot(snapshot)} disabled={recoveryBusy}>下载并删除</button>}
              </div>
            </article>
          ))}
          <button type="button" onClick={() => setShowRecoverySnapshots(false)} disabled={recoveryBusy}>返回工作区</button>
          {noticeKey > 0 && <p role="status">{notice}</p>}
        </section>
      </main>
    );
  }

  if (storageConflict) {
    return (
      <main className="loading loading-error">
        <section>
          <h1>工作区已在其他标签页或窗口中更新</h1>
          <p>
            为避免互相覆盖，本页已暂停自动保存，本页还有未保存的修改。可以载入最新内容（会先下载本页内容的备份），
            或用本页内容覆盖已保存的版本（会先下载已保存版本的备份）。
          </p>
          <div className="loading-error-actions">
            <button type="button" onClick={() => void reloadAfterConflict()} disabled={recoveryBusy || syncBusy}>
              载入最新内容
            </button>
            <button type="button" onClick={() => void overwriteAfterConflict()} disabled={recoveryBusy || syncBusy}>
              用本页内容覆盖
            </button>
            {workspace?.version === 3 && <button type="button" onClick={() => {
              const current = flushPendingEdits() ?? workspaceRef.current; if (!current) return;
              const compatible = { ...current, version: workspaceFormatVersion({ ...current, version: 1 }) };
              void (window.bike ?? window.localOutline)?.exportWorkspaceArchive?.(compatible).then((result) => { if (result.ok && !result.cancelled) showNotice("已导出 1.7 兼容 ZIP 副本，操作日志与本机副本身份保留在当前数据库"); });
            }}>导出 1.7 兼容 ZIP 副本</button>}
            {recoverySnapshots.length > 0 && (
              <button type="button" onClick={() => setShowRecoverySnapshots(true)}>查看备用副本</button>
            )}
          </div>
          {noticeKey > 0 && <p role="status">{notice}</p>}
        </section>
      </main>
    );
  }

  if (!workspace || !activeDocument) {
    return <div className="loading">正在打开本地工作区...</div>;
  }

  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;

  return (
    <AttachmentActionsContext.Provider value={attachmentActions}>
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <ListTree size={20} />
          </div>
          <div>
            <strong>Bike</strong>
            <span>本地优先大纲</span>
          </div>
        </div>

        <label className="search">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => { setSearch(event.target.value); setSidebarView("all"); }}
            placeholder="搜索文档、主题、备注"
          />
        </label>

        <SearchControls documents={workspace.documents} documentIds={filterDocumentIds} favoriteOnly={favoriteOnly} includeCode={includeCode}
          onDocuments={(ids) => { setFilterDocumentIds(ids); setSidebarView("all"); }}
          onFavorite={(value) => { setFavoriteOnly(value); setSidebarView("all"); }}
          onCode={(value) => { setIncludeCode(value); setSidebarView("all"); }} onSave={saveCurrentFilter}
          onClear={() => { setSearch(""); setSelectedTags([]); setTaskFilter("all"); setFilterDocumentIds([]); setFavoriteOnly(false); setIncludeCode(false); }} />

        <div className="sidebar-actions knowledge-entry"><button type="button" onClick={() => setShowKnowledgeWorkflow(true)}><Sparkles size={16} />AI 知识操作</button></div>
        <div className="sidebar-actions">
          <button onClick={createDocument}>
            <Plus size={16} />
            新文档
          </button>
          <button onClick={() => {
            flushPendingEdits();
            fileInputRef.current?.click();
          }}>
            <Upload size={16} />
            导入
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="工作区导航">
          <button className={sidebarView === "recent" ? "selected" : ""} onClick={() => setSidebarView("recent")}>
            <Clock size={16} />
            最近编辑
          </button>
          <button className={sidebarView === "quick" ? "selected" : ""} onClick={() => setSidebarView("quick")}>
            <Zap size={16} />
            快速访问
          </button>
          <button className={sidebarView === "all" ? "selected" : ""} onClick={() => setSidebarView("all")}>
            <FolderOpen size={16} />
            我的文档
          </button>
        </nav>

        <div className={classNames("document-list", sidebarView === "recent" && "recent-list")}>
          {sidebarView === "quick" ? (
            <>
              <div className="document-list-title"><span>收藏</span><small>{navigation.favorites.length}</small></div>
              {navigation.favorites.filter((id) => workspace.documents.some((document) => document.id === id)).map((id) => {
                const document = workspace.documents.find((item) => item.id === id);
                if (!document) return null;
                return (
                  <button key={id} className="document-item" onClick={() => selectDocument(id)}>
                    <Star size={16} />
                    <span>{document.title}</span>
                  </button>
                );
              })}
              <div className="document-list-title"><span>最近打开</span></div>
              {navigation.recent.map((item) => {
                const document = workspace.documents.find((entry) => entry.id === item.documentId);
                if (!document) return null;
                return (
                  <button key={item.documentId} className="document-item" onClick={() => openKnowledgeTarget(item.documentId, item.nodeId)}>
                    <Clock size={16} />
                    <span>{document.title}</span>
                  </button>
                );
              })}
              <div className="document-list-title"><span>保存的筛选</span></div>
              {navigation.filters.map((filter) => (
                <div key={filter.id} className="saved-filter-row">
                  <button type="button" className="document-item" onClick={() => {
                    setSearch(filter.query); setSelectedTags(filter.tags); setTaskFilter(filter.task);
                    setFilterDocumentIds(filter.documentIds); setFavoriteOnly(filter.favoriteOnly); setIncludeCode(filter.includeCode === true); setSidebarView("all");
                  }}><Search size={16} /><span>{filter.name}{filter.broken ? "（需修复）" : ""}</span></button>
                  <button className="control-button compact" type="button" aria-label={`重命名筛选 ${filter.name}`} onClick={() => { const name = window.prompt("筛选名称", filter.name); if (name) setNavigation((state) => renameNavigationFilter(state, filter.id, name)); }}>改名</button>
                  <button className="control-button compact danger" type="button" aria-label={`删除筛选 ${filter.name}`} onClick={() => setNavigation((state) => deleteNavigationFilter(state, filter.id))}>删除</button>
                </div>
              ))}
            </>
          ) : searchResult ? (
            <SearchResults result={searchResult} onOpen={openKnowledgeTarget} onLoadMore={() => setSearchLimit((limit) => limit + 100)} />
          ) : (
            <>
              <div className="document-list-title">
                <span>{sidebarView === "recent" ? "最近编辑" : "我的文档"}</span>
                <small>{matchingDocuments.length} 个文档</small>
              </div>
              {matchingDocuments.map((document) => (
                <div
                  key={document.id}
                  className={classNames("document-item", "document-entry", document.id === activeDocument.id && "active", sidebarView === "recent" && "show-time")}
                >
                  <button type="button" className="document-item-main" onClick={() => selectDocument(document.id)}><FileText size={16} /><span>{document.title}</span></button>
                  <button type="button" title={navigation.favorites.includes(document.id) ? "取消收藏" : "收藏"} onClick={(event) => {
                    event.stopPropagation();
                    setNavigation((state) => toggleFavorite(state, document.id));
                  }}>
                    <Star size={14} />
                  </button>
                  <small>{sidebarView === "recent" ? formatRecentTime(document.updatedAt) : formatTime(document.updatedAt)}</small>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="sidebar-section">
          <div className="section-title">
            <Tag size={15} />
            标签
          </div>
          <div className="tag-list">
            {globalTags.map((tag) => (
              <button
                key={tag.key}
                className={classNames("tag-pill", selectedTags.some((value) => foldKey(value) === foldKey(tag.label)) && "selected")}
                onClick={() => { setSidebarView("all"); setSelectedTags((tags) => tags.some((value) => foldKey(value) === foldKey(tag.label)) ? tags.filter((value) => foldKey(value) !== foldKey(tag.label)) : [...tags, tag.label]); }}
              >
                #{tag.label} {tag.count}/{tag.documentCount}
              </button>
            ))}
            {!globalTags.length && <span className="empty-text">暂无标签</span>}
          </div>
          <div className="tag-list">
            {(["all", "open", "done"] as const).map((task) => (
              <button key={task} className={classNames("tag-pill", taskFilter === task && "selected")} onClick={() => { setSidebarView("all"); setTaskFilter(task); }}>
                {task === "all" ? "全部" : task === "open" ? "未完成" : "已完成"}
              </button>
            ))}
          </div>
        </div>

        <div className="sidebar-dock">
          <button title="本地会员功能" onClick={() => showNotice("会员功能开发中，敬请期待")}>
            <Star size={16} />
          </button>
          <button title="标签" onClick={() => { const el = document.querySelector(".sidebar-section"); if (el) el.scrollIntoView({ behavior: "smooth" }); }}>
            <Tag size={16} />
          </button>
          <button title="备份设置" onClick={() => {
            const bridge = window.bike ?? window.localOutline;
            void bridge?.getBackupStatus?.().then((status) => setBackupStatus(status as typeof backupStatus));
            setShowBackupSettings(true);
          }}>
            <Cloud size={16} />
          </button>
          <button
            className={classNames(isCheckingUpdates && "spinning")}
            title="检查更新"
            onClick={checkUpdates}
            disabled={isCheckingUpdates}
          >
            <RefreshCw size={16} />
          </button>
          <button title="回收站" onClick={openTrashDialog}>
            <Trash2 size={16} />
          </button>
          <button title={theme === "light" ? "切换到暗黑模式" : "切换到明亮模式"} onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </div>

        {syncBusy && attachmentSyncProgress && <div className="recovery-entry">附件 {attachmentSyncProgress.phase} · {Math.round(attachmentSyncProgress.transferred / Math.max(1, attachmentSyncProgress.byteLength) * 100)}% <button onClick={() => { void (window.bike ?? window.localOutline)?.cancelAttachmentSync?.(); }}>取消传输</button></div>}
        <div className="sync-panel">
          <button
            className={classNames("sync-status-button", syncBusy && "spinning")}
            onClick={() => syncNow()}
            disabled={syncBusy}
            title="立即同步"
          >
            {syncBusy ? <RefreshCw size={17} /> : <Cloud size={17} />}
            <div>
              <strong>{syncState.lastSyncedAt ? "文档同步" : "本地保存"}</strong>
              <span>
                {syncBusy
                  ? "正在同步..."
                  : syncState.lastSyncedAt
                    ? `${formatRecentTime(syncState.lastSyncedAt)}${syncConfig.autoSync ? " · 自动" : ""}`
                    : notice}
              </span>
            </div>
          </button>
          <button
            className="sync-settings-button"
            onClick={() => setShowSyncConfig(true)}
            title="同步设置"
          >
            <Link2 size={15} />
          </button>
        </div>
        <div className="sidebar-utility-actions">
          {workspace?.version === 3 && <button type="button"
            disabled={!(window.bike ?? window.localOutline)?.exportWorkspaceArchive}
            title={(window.bike ?? window.localOutline)?.exportWorkspaceArchive ? "导出兼容旧版本的完整附件副本" : "完整 ZIP 需要桌面版；浏览器可通过导出工作区 JSON 保留正文和附件索引"}
            onClick={() => {
            const current = flushPendingEdits() ?? workspaceRef.current; if (!current) return;
            const compatible = { ...current, version: workspaceFormatVersion({ ...current, version: 1 }) };
            void (window.bike ?? window.localOutline)?.exportWorkspaceArchive?.(compatible).then((result) => { if (result.ok && !result.cancelled) showNotice("已导出 1.7 兼容 ZIP 副本，操作日志与本机副本身份保留在当前数据库"); });
          }}><FileDown size={16} /><span>导出 1.7 兼容 ZIP 副本</span></button>}
          <button type="button" onClick={() => { void (window.bike ?? window.localOutline)?.getLiveMcpState?.().then(setLiveState); setShowLiveMcp(true); }}><Link2 size={16} /><span>Live MCP · {liveState.enabled ? (liveState.writable ? "等待应用确认写入" : "只读") : "已关闭"}</span></button>
          <button type="button" onClick={() => {
            void ensureOperationWorkspace().then(async (current) => {
              if (!current) return;
              if (window.confirm("将当前同步空间升级到 2.0 后，旧客户端将受保护读取。请确认已升级 Sync Server，并保留升级前 ZIP。继续？")) {
                await enableOperationSync(syncConfig); showNotice("已启用 2.0 同步协议");
              }
            }).catch((error) => showNotice(error instanceof Error ? error.message : "升级未完成"));
          }}><RefreshCw size={16} /><span>{workspace?.version === 3 ? "2.0 节点同步 · 协议设置" : "备份并启用 2.0 工作区"}</span></button>
          {recoverySnapshots.length > 0 && (
            <button type="button" onClick={() => {
              refreshRecoverySnapshots();
              setShowRecoverySnapshots(true);
            }}>
              {recoverySnapshots.length} 份备用副本 · 查看与恢复
            </button>
          )}
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="title-block">
            <DocumentTitleInput className="title-input" value={activeDocument.title} onCommit={updateTitle} />
            <div className="breadcrumb">
              {focusNode ? (
                <>
                  <Focus size={14} />
                  正在聚焦：{focusNode.text || "未命名主题"}
                  <button onClick={() => setFocusNodeId(null)}>
                    <X size={14} />
                    退出
                  </button>
                </>
              ) : (
                <>
                  <FolderOpen size={14} />
                  {countNodes(activeDocument.nodes)} 个主题
                </>
              )}
            </div>
          </div>

          <div className="topbar-actions">
            <div className="segmented">
              <button
                className={mode === "outline" ? "selected" : ""}
                onClick={() => switchMode("outline")}
              >
                <LayoutList size={16} />
                大纲
              </button>
              <button
                className={mode === "mindmap" ? "selected" : ""}
                onClick={() => switchMode("mindmap")}
              >
                <Brain size={16} />
                脑图
              </button>
              <button
                className={mode === "presentation" ? "selected" : ""}
                onClick={() => switchMode("presentation")}
              >
                <Presentation size={16} />
                演示
              </button>
              <button
                className={mode === "markdown" ? "selected" : ""}
                onClick={() => switchMode("markdown")}
              >
                <FileText size={16} />
                Markdown
              </button>
            </div>

            {aiBusyKey && <button type="button" onClick={cancelAiAction} title="取消 AI 请求"><X size={16} />取消 AI</button>}
            <button
              className="icon-button"
              type="button"
              onClick={() => performHistoryStep("undo")}
              disabled={!canUndo || syncBusy || historyBusy || recoveryBusy}
              title="撤销 (⌘Z / Ctrl+Z)"
              aria-label="撤销"
            >
              <Undo2 size={17} />
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={() => performHistoryStep("redo")}
              disabled={!canRedo || syncBusy || historyBusy || recoveryBusy}
              title="重做 (⇧⌘Z / Ctrl+Shift+Z)"
              aria-label="重做"
            >
              <Redo2 size={17} />
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={() => void openVersionHistory()}
              title="版本历史"
              aria-label="版本历史"
            >
              <History size={17} />
            </button>

            {mode !== "markdown" && (
              <button
                className="icon-button"
                type="button"
                title={showNodeInspector ? "隐藏节点详情" : "显示节点详情"}
                aria-label={showNodeInspector ? "隐藏节点详情" : "显示节点详情"}
                aria-expanded={showNodeInspector}
                aria-controls="node-inspector"
                onClick={() => {
                  flushPendingEdits();
                  setShowNodeInspector((shown) => !shown);
                }}
              >
                <PanelRight size={17} />
              </button>
            )}
            <button className="icon-button" type="button" onClick={() => travelNavigation(-1)} title="后退">
            <ChevronLeft size={17} />
          </button>
          <button className="icon-button" type="button" onClick={() => travelNavigation(1)} title="前进">
            <ChevronRight size={17} />
          </button>
          <button className="icon-button" onClick={duplicateDocument} title="复制文档">
              <Copy size={17} />
            </button>
            <button className="icon-button danger" onClick={() => setShowConfirmDelete(true)} title="删除文档">
              <Trash2 size={17} />
            </button>
          </div>
        </header>

        <div className="toolstrip">
          <div className="toolstrip-tools">
            {mode !== "markdown" && (
              <>
                <button onClick={() => activeNodeId ? insertAfter(activeNodeId) : insertChild(MINDMAP_ROOT_ID)}>
                  <Plus size={16} />
                  同级
                </button>
                <button onClick={() => insertChild(activeNodeId ?? MINDMAP_ROOT_ID)}>
                  <Indent size={16} />
                  子级
                </button>
                <button onClick={() => activeNodeId && setFocusNodeId(activeNodeId)}>
                  <Focus size={16} />
                  聚焦
                </button>
                <button onClick={() => activeNodeId && moveSelected(-1)}>
                  <ArrowUp size={16} />
                  上移
                </button>
                <button onClick={() => activeNodeId && moveSelected(1)}>
                  <ArrowDown size={16} />
                  下移
                </button>
                <span className="separator" />
              </>
            )}
            {mode === "mindmap" && <><button onClick={() => void exportMap("svg")}>SVG</button><button onClick={() => void exportMap("png")}>PNG</button><button onClick={() => void exportMap("png", true)}>透明 PNG</button></>}
            <button disabled={attachmentBusy || recoveryBusy || !(window.bike ?? window.localOutline)?.importAttachments} onClick={() => void addAttachments()}>添加附件</button>
            {attachmentBusy && <button onClick={cancelAttachmentImport}>取消附件导入</button>}
            <button disabled={recoveryBusy} onClick={() => void exportArchive()}>工作区 ZIP</button>
            <button disabled={recoveryBusy} onClick={() => void importArchive()}>载入 ZIP</button>
            <button disabled={recoveryBusy || !(window.bike ?? window.localOutline)?.exportWorkspaceArchive} onClick={() => setLocalCopyDialog({ kind: "export" })}>完整本机副本</button>
            <button disabled={recoveryBusy || !(window.bike ?? window.localOutline)?.importWorkspaceArchive} onClick={() => void importArchive(false, true)}>导入本机副本</button>
            <button disabled={recoveryBusy} onClick={() => { void listLocalMigrationArchives().then(setSourceArchives).catch((error) => showNotice(error instanceof Error ? error.message : "无法读取来源档案")); }}>来源档案</button>
            <button disabled={recoveryBusy} onClick={() => void importArchive(true)}>补齐附件</button>
            <button disabled={recoveryBusy || attachmentBusy} onClick={() => void cleanAttachments()}>清理附件</button>
          </div>
          <div className="toolstrip-actions">
            <span className="separator" />
            <ExportMenu onDocument={exportActive} onPdf={exportActivePdf} onWorkspace={exportAll} />
            <button onClick={backupToCloud}>
              <Cloud size={16} />
              iCloud 备份
            </button>
            <button onClick={loadCloudBackup}>载入备份</button>
          </div>
        </div>

        <div
          className={classNames(
            "content",
            !showNodeInspector && "inspector-hidden",
            mode === "markdown" && "markdown-active",
            mode === "markdown" && `markdown-${markdownPaneMode}`,
          )}
        >
          <section className={classNames("editor-pane", mode === "markdown" && "markdown-editor-pane")}
            onPaste={(event) => {
              const files = event.clipboardData?.files;
              if (!files?.length || (event.nativeEvent as ClipboardEvent & { isComposing?: boolean }).isComposing) return;
              event.preventDefault();
              const row = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
              void addAttachments(row?.dataset.nodeId, [...files]);
            }}
            onDropCapture={(event) => {
              const files = event.dataTransfer?.files;
              if (!files?.length) return;
              event.preventDefault(); event.stopPropagation();
              const row = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
              void addAttachments(row?.dataset.nodeId, [...files]);
            }}>
            {selectedTag && mode !== "markdown" && (
              <div className="filter-banner">
                <Tag size={15} />
                {selectedTags.map((tag) => `#${tag}`).join(" + ")} 命中 {tagHits.length} 个主题
                <button onClick={() => setSelectedTag(null)}>
                  <X size={14} />
                </button>
              </div>
            )}

            {mode === "outline" && !focusNode && (
              <DocumentTitleInput className="document-heading-input" value={activeDocument.title} ariaLabel="文档标题" onCommit={updateTitle} />
            )}

            {mode === "outline" && (
              <OutlineView
                nodes={visibleNodes}
                activeNodeId={activeNodeId}
                setNodeRef={setNodeRef}
                onSelect={setActiveNodeId}
                onText={handleNodeText}
                onKeyDown={handleKeyDown}
                onPatch={handleNodePatch}
                onInsertAfter={insertAfter}
                onInsertChild={insertChild}
                onRemove={removeActiveNode}
                onCopyLink={copyNodeLink}
                onExportNode={exportNodeMarkdown}
                onUpdateNodes={setActiveNodes}
                onAiAction={handleStructuredAiAction}
                isAiBusy={isStructuredAiBusy}
                onSuggestLinks={handleLinkSuggestions}
                onBindLink={bindNodeLink}
                onCreateLink={createLinkedDocument}
                onPublishLabel={publishNodeLabel}
                onLabelFocus={handleLabelFocus}
                onFollowLink={handleNodeLinkFollow}
                locatedNodeId={locatedNodeId}
              />
            )}

            {mode === "mindmap" && (
              <MindMap
                title={focusNode?.text || activeDocument.title}
                nodes={focusNode ? focusNode.children : navigationNodes}
                rootTargetId={focusNode?.id ?? null}
                viewportResetKey={focusNode?.id ?? activeDocument.id}
                activeNodeId={activeNodeId}
                locatedNodeId={location.documentId === activeDocument.id ? locatedNodeId : null}
                locationVersion={location.documentId === activeDocument.id ? location.version : 0}
                onSelect={setActiveNodeId}
                onTitle={updateTitle}
                onText={handleMindMapLabel}
                onPatch={handleNodePatch}
                onInsertAfter={insertAfter}
                onInsertChild={insertChild}
                onInsertParent={insertParentNode}
                onCopyNode={copyNodeToClipboard}
                onCutNode={cutNodeToClipboard}
                onPasteNode={pasteNodeAsChild}
                canPaste={Boolean(nodeClipboard)}
                onDuplicateNode={duplicateNode}
                onRemove={removeActiveNode}
                onToggleSiblingCollapse={toggleSiblingCollapse}
                onFocusNode={setFocusNodeId}
                relations={knowledgeEditable(activeDocument.knowledge) ? activeDocument.knowledge.relations as MindRelation[] : []}
                showRelations={showRelations}
                onToggleRelations={() => setShowRelations((value) => !value)}
                onAiAction={handleStructuredAiAction}
                isAiBusy={isStructuredAiBusy}
              />
            )}

            {mode === "presentation" && (
              <PresentationView
                title={focusNode?.text || activeDocument.title}
                nodes={visibleNodes}
                onSelect={setActiveNodeId}
              />
            )}

            {mode === "markdown" && (
              <MarkdownView
                documentId={activeDocument.id}
                onSuggest={(query) => suggestLinkTargets(workspace, query)}
                onBind={(text, span, target, mode) => bindNodeLink("", text, span, target, mode, "markdown")}
                onCreate={(text, query, title) => createLinkedDocument("", text, query, title, "markdown")}
                value={markdownDraft}
                viewMode={markdownPaneMode}
                onChange={handleMarkdownDraftChange}
                onViewModeChange={setMarkdownPaneMode}
                onAiAction={handleMarkdownAiAction}
                isAiBusy={Boolean(aiBusyKey?.startsWith("markdown:"))}
              />
            )}
          </section>

          {mode !== "markdown" && showNodeInspector && (
            <aside className="inspector" id="node-inspector" aria-label="节点详情">
              <section>
                <div className="section-title">节点详情</div>
                {activeNode ? (
                  <>
                    <label className="field">
                      <span>备注</span>
                      <InspectorNoteField
                        key={activeNode.id}
                        nodeId={activeNode.id}
                        note={activeNode.note}
                        onPatch={handleNodePatch}
                        onDraftChange={handleInspectorNoteDraftChange}
                        onCommit={handleInspectorNoteCommit}
                        onSuggest={(query) => suggestLinkTargets(workspace, query)}
                        onBind={(text, span, target, mode) => bindNodeLink(activeNode.id, text, span, target, mode, "note")}
                        onCreate={(text, query, title) => createLinkedDocument(activeNode.id, text, query, title, "note")}
                      />
                    </label>
                    <label className="field">
                      <span>颜色</span>
                      <select
                        value={activeNode.color}
                        onChange={(event) =>
                          handleNodePatch(activeNode.id, { color: event.target.value })
                        }
                      >
                        {colorOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="stats-row">
                      <span>子主题</span>
                      <strong>{activeNode.children.length}</strong>
                    </div>
                    <AttachmentPanel node={activeNode} onPatch={(attachmentRefs) => handleNodePatch(activeNode.id, { attachmentRefs })} onCancel={cancelAttachmentImport} onDownloadMigration={() => void downloadMigrationBackup()} />
                  </>
                ) : (
                  <p className="empty-text">选择一个主题查看详情</p>
                )}
              </section>

              <KnowledgePanel
                key={activeDocument.id}
                locked={Boolean(activeDocument.knowledge && !knowledgeEditable(activeDocument.knowledge))}
                connections={knowledgeConnections}
                documentBacklinks={knowledgeIndex ? backlinksFor(knowledgeIndex, activeDocument.id) : []}
                nodeBacklinks={knowledgeIndex && activeNode ? backlinksFor(knowledgeIndex, activeDocument.id, activeNode.id) : []}
                relations={relationView(activeDocument)}
                targets={relationTargets}
                activeNodeId={activeNode?.id ?? null}
                onOpen={openKnowledgeTarget}
                onOpenNode={(id) => openKnowledgeTarget(activeDocument.id, id)}
                onFollow={(connection) => {
                  const span = connection.link ?? connection.reference?.source;
                  const origin = connection.origin;
                  if (!span || !origin) return;
                  if (origin.kind === "markdown") followWikiLink(span.raw, { documentId: activeDocument.id, kind: "markdown", start: span.start, end: span.end });
                  else if (origin.nodeId && (origin.field === "text" || origin.field === "note")) followWikiLink(span.raw, { documentId: activeDocument.id, kind: "node-field", nodeId: origin.nodeId, field: origin.field, start: span.start, end: span.end });
                }}
                onAddRelation={(toNodeId, label) => { if (activeNode) changeRelation("add", { fromNodeId: activeNode.id, toNodeId, label }); }}
                onDeleteRelation={(id) => { changeRelation("delete", { id }); }}
                onReverseRelation={(id) => { changeRelation("reverse", { id }); }}
                onUpdateRelation={(id, patch) => changeRelation("update", { ...patch, id })}
              />

              <section className="hint-panel">
                <strong>快捷键</strong>
                <span>Enter 新建同级</span>
                <span>Tab / Shift+Tab 调整层级</span>
                <span>Backspace 删除空主题</span>
              </section>
            </aside>
          )}
        </div>
      </section>

      <input
        ref={fileInputRef}
        className="hidden-input"
        type="file"
        accept=".json,.md,.markdown,.opml,.xml,.mm"
        onChange={handleImport}
      />

      {noticeKey > 0 && (
        <div key={noticeKey} className="toast" onAnimationEnd={(e) => { if (e.animationName === "toast-out") setNoticeKey(0); }}>
          <span>{notice}</span>
        </div>
      )}

      {showKnowledgeWorkflow && <Modal onDismiss={() => setShowKnowledgeWorkflow(false)} className="modal-overlay" role="dialog" aria-modal="true" aria-label="AI 知识操作" onClick={() => setShowKnowledgeWorkflow(false)}><section className="api-config-dialog" onClick={(event) => event.stopPropagation()}>
        <header><div><h3>AI 知识操作</h3><p>发送选中资料，生成结构化候选后预览。</p></div><button type="button" className="dialog-close" aria-label="关闭" onClick={() => setShowKnowledgeWorkflow(false)}><X size={16} /></button></header>
        <div className="config-body"><label className="config-field"><span>操作</span><select value={knowledgeAction} onChange={(event) => setKnowledgeAction(event.target.value as KnowledgeAction)}>{KNOWLEDGE_ACTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label className="checkbox-field"><input type="checkbox" checked={knowledgeWholeDocument} onChange={(event) => setKnowledgeWholeDocument(event.target.checked)} />使用当前整篇文档。默认使用选中子树。</label>
          {knowledgeAction === "summary" && <label className="config-field"><span>写入位置</span><select value={summaryDestination} onChange={(event) => setSummaryDestination(event.target.value as "child" | "note")}><option value="child">新增摘要主题</option><option value="note">追加到选中主题备注</option></select></label>}
          {knowledgeAction.endsWith("-template") && <><label className="config-field"><span>读者</span><select value={templateAudience} onChange={(event) => setTemplateAudience(event.target.value)}><option value="mixed">产品与研发</option><option value="engineering">研发</option><option value="product">产品</option></select></label><p>落点为新文档，可在接受后撤销创建。</p></>}
          <p>范围上限为 2,000 个主题和 256 KiB 文本。缺少依据的信息需标为待确认。</p></div>
        <footer><button type="button" className="primary" onClick={() => void runKnowledgeWorkflow()} disabled={Boolean(aiBusyKey)}>生成提案</button><button className="secondary" onClick={() => setShowKnowledgeWorkflow(false)}>取消</button></footer>
      </section></Modal>}
      {showLiveMcp && <Modal onDismiss={() => setShowLiveMcp(false)} className="modal-overlay" role="dialog" aria-modal="true" aria-label="Live MCP 授权" onClick={() => setShowLiveMcp(false)}><section className="api-config-dialog" onClick={(event) => event.stopPropagation()}>
        <header><div><h3>Live MCP 授权</h3><p>本机 stdio 客户端通过受保护的本机通道读取已提交内容。</p></div><button type="button" className="dialog-close" onClick={() => setShowLiveMcp(false)} aria-label="关闭"><X size={16} /></button></header>
        <div className="config-body"><label className="config-field"><span>读取范围</span><select value={liveScope} onChange={(event) => setLiveScope(event.target.value as "document" | "workspace")}><option value="document">当前文档</option><option value="workspace">整个工作区</option></select></label>
          <label className="checkbox-field"><input type="checkbox" checked={liveWritable} onChange={(event) => setLiveWritable(event.target.checked)} />允许提交写入提案，接受后生效</label>
          <p>实际会话身份由主进程生成，客户端名称由客户端自行报告。重载、退出和撤权会使未确认提案失效。</p>
          {liveState.discoveryPath && <p>发现文件 <code>{liveState.discoveryPath}</code></p>}
          <pre>{JSON.stringify({ command: liveState.command ?? "node", args: liveState.args ?? ["mcp/bike-server.mjs", "--live"], env: { BIKE_LIVE_DISCOVERY: liveState.discoveryPath ?? "启用后生成" } }, null, 2)}</pre></div>
        <footer><button type="button" className="primary" onClick={() => { void ensureOperationWorkspace().then(async (current) => { if (!current) return; const bridge = window.bike ?? window.localOutline; if (!bridge?.startLiveMcp) throw new Error("Live MCP 需要桌面版"); await bridge.startLiveMcp({ scope: liveScope, documentIds: [current.activeDocumentId], writable: liveWritable }); setLiveState(await bridge.getLiveMcpState!()); setShowLiveMcp(false); showNotice("Live MCP 已按所选范围启用"); }).catch((error) => showNotice(error instanceof Error ? error.message : "Live 启动失败")); }}>启用所选授权</button>
          <button className="secondary" onClick={() => { void (window.bike ?? window.localOutline)?.stopLiveMcp?.().then((state) => { setLiveState(state); showNotice("Live MCP 授权已撤销"); }); }}>撤销并关闭</button></footer>
      </section></Modal>}
      {proposal && <ProposalDialog key={proposal.id} workspace={workspace} proposal={proposal} busy={proposalBusy} error={proposalError} onAccept={acceptProposal} onReject={rejectProposal} />}
      {localCopyDialog && <LocalMigrationDialog copy={localCopyDialog.kind === "import" ? localCopyDialog.copy : undefined} documentCount={localCopyDialog.kind === "import" ? localCopyDialog.workspace.documents.length : workspace.documents.length} onClose={closeLocalCopyDialog} onConfirm={(options) => void executeLocalCopyDialog(options)} />}
      {sourceArchives && <LocalMigrationArchivesDialog archives={sourceArchives} onClose={() => setSourceArchives(null)} onDownload={(copy) => downloadText(`bike-source-${copy.id}.json`, JSON.stringify(copy, null, 2), "application/json")} />}
      {showAiConfig && (
        <AiConfigDialog
          initialConfig={aiConfig || defaultAiConfig}
          onSave={handleSaveAiConfig}
          onClose={() => setShowAiConfig(false)}
        />
      )}

      {showBackupSettings && (
        <BackupSettingsDialog
          available={Boolean((window.bike ?? window.localOutline)?.getBackupStatus)}
          status={backupStatus}
          onClose={() => setShowBackupSettings(false)}
          onToggle={(enabled) => {
            const bridge = window.bike ?? window.localOutline;
            void bridge?.setBackupAuto?.(enabled).then((status) => {
              applyBackupStatus(status as typeof backupStatus);
            });
          }}
          onBackupNow={() => void backupToCloud()}
          onInspect={() => {
            const bridge = window.bike ?? window.localOutline;
            void bridge?.inspectBackup?.().then((result) => {
              showNotice(result.exists ? `外部文件 ${result.paused === "external-change" || (result.fileHash && result.fileHash !== result.baselineHash) ? "与本机基线不同" : "与基线一致"}` : "备份文件还不存在");
            });
          }}
          onLoad={() => void loadCloudBackup()}
          onReplace={() => {
            const bridge = window.bike ?? window.localOutline;
            const current = flushPendingEdits() ?? workspaceRef.current;
            if (!bridge?.inspectBackup || !bridge.replaceBackupWithLocal || !current) return;
            void bridge.inspectBackup().then(async (inspected) => {
              if (!inspected.ok) {
                showNotice(inspected.error || "无法查看备份");
                return;
              }
              const saved = await saveWorkspace(current);
              if (!saved.ok || saved.target !== "indexeddb") { showNotice("本机保存未成功，未替换备份"); return; }
              const replaced = await bridge.replaceBackupWithLocal?.({
                workspace: current,
                sourceRevision: getWorkspaceSaveRevision(current),
                semanticHash: backupContentHash(current),
                expectedFileHash: inspected.fileHash,
                ticket: backupTicketRef.current + 1,
              });
              showNotice(replaced?.ok ? "已用本机内容替换备份" : replaced?.error || "没有替换备份");
              const status = await bridge.getBackupStatus?.();
              if (status) applyBackupStatus(status as typeof backupStatus);
            });
          }}
        />
      )}
      {showSyncConfig && (
        <SyncConfigDialog
          config={syncConfig}
          busy={syncBusy}
          lastSyncedAt={syncState.lastSyncedAt}
          onClose={() => setShowSyncConfig(false)}
          onSave={(next) => {
            persistSyncConfig(next);
            showNotice("同步设置已保存");
          }}
          onSyncNow={syncNow}
          onPushLocal={pushLocalWorkspace}
          onPullRemote={pullRemoteWorkspace}
        />
      )}

      {showConfirmDelete && (
        <Modal onDismiss={() => setShowConfirmDelete(false)} className="confirm-overlay" role="dialog" aria-modal="true" aria-label="删除文档" onClick={() => setShowConfirmDelete(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>确认删除</h3>
            <p>确定要将文档「{activeDocument.title}」移入回收站吗？回收站会保留 30 天，可随时恢复。</p>
            <div className="confirm-actions">
              <button className="confirm-cancel" onClick={() => setShowConfirmDelete(false)}>取消</button>
              <button className="confirm-delete" onClick={() => { setShowConfirmDelete(false); deleteDocument(); }}>删除</button>
            </div>
          </div>
        </Modal>
      )}

      {showTrash && (
        <TrashDialog
          entries={workspace.trash ?? []}
          busy={recoveryBusy || syncBusy}
          onRestore={restoreFromTrash}
          onDelete={deleteFromTrash}
          onEmpty={emptyTrashForever}
          onClose={() => setShowTrash(false)}
        />
      )}

      {showVersionHistory && (
        <VersionHistoryDialog
          document={activeDocument}
          snapshots={historySnapshots}
          loading={historyLoading}
          error={historyError}
          busy={historyBusy || syncBusy}
          operations={historyReplica?.audit ?? []}
          conflicts={historyReplica?.conflicts ?? []}
          onRecoverOperation={(operation) => { const current = flushPendingEdits() ?? workspaceRef.current; if (!current || !historyReplica) return; try { enqueueProposal(operationRecoveryProposal(current, historyReplica, operation)); closeVersionHistory(); } catch (error) { setHistoryError(error instanceof Error ? error.message : "恢复提案未完成"); } }}
          onResolveConflict={(conflict, choice) => { const current = flushPendingEdits() ?? workspaceRef.current; if (!current || !historyReplica) return; try { enqueueProposal(conflictResolutionProposal(current, historyReplica, conflict, choice)); closeVersionHistory(); } catch (error) { setHistoryError(error instanceof Error ? error.message : "请重新比较冲突"); } }}
          onNavigate={(documentId, nodeId) => { closeVersionHistory(); openKnowledgeTarget(documentId, nodeId); }}
          onRestoreCopy={(snapshot) => {
            const current = flushPendingEdits() ?? workspaceRef.current; if (!current) return;
            const id = uuid(), rekeyed = rekeyKnowledgeNodes(snapshot.document.nodes, uid);
            const fragment = copiedKnowledgeFragment(anchorMarkdownReferences(snapshot.document), { sourceDocumentId: snapshot.documentId, nextDocumentId: id, idMap: rekeyed.idMap, wholeDocument: true });
            if (fragment.locked) { setHistoryError("此版本包含未知知识格式，请升级后恢复"); return; }
            const copy = clearDocumentMarkdown({ ...snapshot.document, id, title: `${snapshot.title} 恢复副本`, nodes: rekeyed.nodes as OutlineNode[], createdAt: now(), updatedAt: now(),
              knowledge: { ...snapshot.document.knowledge, version: 1, references: fragment.references, relations: fragment.relations, sourceGroups: fragment.sourceGroups } });
            commitWorkspace((workspace) => ({ ...workspace, documents: [...workspace.documents, copy] }), { label: "恢复历史为副本" });
            closeVersionHistory(); showNotice("历史版本已恢复为新副本");
          }}
          onRestore={(snapshot) => void restoreVersionSnapshot(snapshot)}
          onSaveNow={() => void saveCurrentVersion()}
          onClose={closeVersionHistory}
        />
      )}
    </main>
    </AttachmentActionsContext.Provider>
  );
}

interface MarkdownViewProps {
  onSuggest: React.ComponentProps<typeof LinkInput>["onSuggest"];
  onBind: React.ComponentProps<typeof LinkInput>["onBind"];
  onCreate: React.ComponentProps<typeof LinkInput>["onCreate"];
  documentId: string;
  value: string;
  viewMode: MarkdownPaneMode;
  onChange: (value: string) => void;
  onViewModeChange: (mode: MarkdownPaneMode) => void;
  onAiAction: (
    action: AiNodeAction,
    target: MarkdownAiTarget,
    source: string,
  ) => Promise<{ value: string; cursor: number } | null>;
  isAiBusy: boolean;
}

interface AiInlineMenuProps {
  busy: boolean;
  onAction: (action: AiNodeAction) => void;
}

function AiButtonGlyph() {
  return <Sparkles className="ai-button-glyph" size={15} strokeWidth={2.25} aria-hidden="true" />;
}

function AiInlineMenu({ busy, onAction }: AiInlineMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (wrapperRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const run = (action: AiNodeAction) => {
    setOpen(false);
    onAction(action);
  };

  return (
    <div
      ref={wrapperRef}
      className={classNames("ai-inline", open && "open", busy && "busy")}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <button
        type="button"
        className="ai-inline-button"
        title={busy ? "AI 正在处理" : "AI 助手"}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <AiButtonGlyph />
      </button>
      {open && (
        <div className="ai-action-menu">
          <button type="button" onClick={() => run("generate")}>
            <Sparkles size={15} />
            生成
          </button>
          <button type="button" onClick={() => run("polish")}>
            <WandSparkles size={15} />
            润色
          </button>
        </div>
      )}
    </div>
  );
}

function AiConfigDialog({
  initialConfig,
  onSave,
  onClose,
}: {
  initialConfig: AiApiConfig;
  onSave: (config: AiApiConfig) => boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<AiApiConfig>(() => ({
    ...defaultAiConfig,
    ...initialConfig,
  }));
  const [showKey, setShowKey] = useState(false);
  const error = validateAiConfig(draft);

  const updateDraft = <Key extends keyof AiApiConfig>(key: Key, value: AiApiConfig[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <Modal onDismiss={onClose} className="modal-overlay" role="dialog" aria-modal="true" aria-label="AI 配置" onClick={onClose}>
      <form
        className="api-config-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(draft);
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h3>配置API密钥</h3>
            <p>用于大纲、思维导图和 Markdown 模式的 AI 生成与润色。</p>
          </div>
          <button type="button" className="dialog-close" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>

        <label className="config-field">
          <span>协议端点</span>
          <select
            value={draft.endpoint}
            onChange={(event) => updateDraft("endpoint", event.target.value as AiApiConfig["endpoint"])}
          >
            <option value="responses">Responses</option>
            <option value="chat_completions">Chat/completions</option>
          </select>
        </label>

        <label className="config-field">
          <span>API baseurl</span>
          <input
            value={draft.baseUrl}
            onChange={(event) => updateDraft("baseUrl", event.target.value)}
            placeholder="https://api.openai.com/v1"
            spellCheck={false}
          />
        </label>

        <label className="config-field">
          <span>API key</span>
          <div className="api-key-input">
            <input
              value={draft.apiKey}
              type={showKey ? "text" : "password"}
              onChange={(event) => updateDraft("apiKey", event.target.value)}
              placeholder="sk-..."
              spellCheck={false}
              autoComplete="off"
            />
            <button type="button" onClick={() => setShowKey((value) => !value)}>
              {showKey ? "隐藏" : "显示"}
            </button>
          </div>
        </label>

        <label className="config-field">
          <span>大模型</span>
          <input
            value={draft.model}
            onChange={(event) => updateDraft("model", event.target.value)}
            placeholder="gpt-5.5"
            spellCheck={false}
          />
        </label>

        {error && <p className="config-error">{error}</p>}

        <footer>
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary">
            保存
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function SyncConfigDialog({
  config,
  busy,
  lastSyncedAt,
  onSave,
  onSyncNow,
  onPushLocal,
  onPullRemote,
  onClose,
}: {
  config: SyncConfig;
  busy: boolean;
  lastSyncedAt: string | null;
  onSave: (config: SyncConfig) => void;
  onSyncNow: (config: SyncConfig) => void;
  onPushLocal: (config: SyncConfig) => void;
  onPullRemote: (config: SyncConfig) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<SyncConfig>(() => ({ ...config }));
  const [intervalText, setIntervalText] = useState(String(config.autoSyncIntervalSeconds));
  const [showToken, setShowToken] = useState(false);
  const normalizedDraft = () => ({
    serverUrl: normalizeSyncServerUrl(draft.serverUrl),
    token: draft.token.trim(),
    autoSync: draft.autoSync === true,
    autoSyncIntervalSeconds: normalizeAutoSyncInterval(intervalText),
  });
  const saveDraft = () => {
    const next = normalizedDraft();
    setDraft(next);
    setIntervalText(String(next.autoSyncIntervalSeconds));
    onSave(next);
    return next;
  };

  return (
    <Modal onDismiss={onClose} className="modal-overlay" role="dialog" aria-modal="true" aria-label="文档同步" onClick={onClose}>
      <form
        className="api-config-dialog sync-config-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          saveDraft();
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h3>文档同步</h3>
            <p>
              {lastSyncedAt
                ? `上次同步：${formatTime(lastSyncedAt)}`
                : "Electron 需填写设备密钥；密钥会明文保存在本机配置。"}
            </p>
          </div>
          <button type="button" className="dialog-close" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>

        <label className="config-field">
          <span>服务地址</span>
          <input
            value={draft.serverUrl}
            onChange={(event) => setDraft((current) => ({
              ...current,
              serverUrl: event.target.value,
            }))}
            placeholder={window.location.origin}
            spellCheck={false}
          />
        </label>

        <label className="config-field">
          <span>设备密钥</span>
          <div className="api-key-input">
            <input
              value={draft.token}
              type={showToken ? "text" : "password"}
              onChange={(event) => setDraft((current) => ({
                ...current,
                token: event.target.value,
              }))}
              placeholder="Electron 填设备密钥；本机明文保存"
              spellCheck={false}
              autoComplete="off"
            />
            <button type="button" onClick={() => setShowToken((value) => !value)}>
              {showToken ? "隐藏" : "显示"}
            </button>
          </div>
        </label>

        <label className="sync-toggle-row">
          <input
            type="checkbox"
            checked={draft.autoSync}
            onChange={(event) => setDraft((current) => ({
              ...current,
              autoSync: event.target.checked,
            }))}
          />
          <span>
            <strong>后台自动同步</strong>
            <small>保存本机修改后延迟同步，并按固定间隔拉取远端更新。</small>
          </span>
        </label>

        <label className="config-field">
          <span>同步间隔</span>
          <input
            value={intervalText}
            type="number"
            min={15}
            step={15}
            onChange={(event) => setIntervalText(event.target.value)}
            onBlur={() => setIntervalText(String(normalizeAutoSyncInterval(intervalText)))}
            disabled={!draft.autoSync}
          />
        </label>

        <footer className="sync-dialog-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => onPullRemote(saveDraft())}
          >
            <Download size={15} />
            拉取
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => onPushLocal(saveDraft())}
          >
            <Upload size={15} />
            上传
          </button>
          <button type="submit" className="secondary" disabled={busy}>
            保存
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => onSyncNow(saveDraft())}
          >
            {busy ? <RefreshCw size={15} /> : <Cloud size={15} />}
            同步
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function MarkdownView({
  onSuggest, onBind, onCreate,
  documentId,
  value,
  viewMode,
  onChange,
  onViewModeChange,
  onAiAction,
  isAiBusy,
}: MarkdownViewProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [isSourceFocused, setIsSourceFocused] = useState(false);
  const [cursorPosition, setCursorPosition] = useState(0);
  const editorToolsDisabled = viewMode === "preview";
  const markdownAiTarget = useMemo(
    () => findMarkdownAiTarget(value, cursorPosition),
    [cursorPosition, value],
  );

  const replaceRange = (
    start: number,
    end: number,
    replacement: string,
    selectionStart = start + replacement.length,
    selectionEnd = selectionStart,
  ) => {
    const next = `${value.slice(0, start)}${replacement}${value.slice(end)}`;
    onChange(next);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(selectionStart, selectionEnd);
    });
  };

  const selectionRange = () => {
    const textarea = textareaRef.current;
    return {
      start: textarea?.selectionStart ?? value.length,
      end: textarea?.selectionEnd ?? value.length,
    };
  };

  const wrapSelection = (before: string, after = before, fallback = "文本") => {
    const { start, end } = selectionRange();
    const selected = value.slice(start, end) || fallback;
    const replacement = `${before}${selected}${after}`;
    replaceRange(
      start,
      end,
      replacement,
      start + before.length,
      start + before.length + selected.length,
    );
  };

  const updateSelectedLines = (transform: (line: string) => string) => {
    const { start, end } = selectionRange();
    const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const nextBreak = value.indexOf("\n", end);
    const lineEnd = nextBreak === -1 ? value.length : nextBreak;
    const block = value.slice(lineStart, lineEnd);
    const replacement = block.split("\n").map(transform).join("\n");
    replaceRange(lineStart, lineEnd, replacement, lineStart, lineStart + replacement.length);
  };

  const setHeading = (level: 1 | 2 | 3) => {
    updateSelectedLines((line) => {
      const clean = line.replace(/^\s{0,3}#{1,6}\s*/, "").trim() || "标题";
      return `${"#".repeat(level)} ${clean}`;
    });
  };

  const prefixQuote = () => {
    updateSelectedLines((line) => `> ${line.replace(/^\s{0,3}>\s?/, "") || "引用"}`);
  };

  const prefixList = () => {
    updateSelectedLines((line) => {
      const match = line.match(/^(\s*)(?:[-*+]\s+(?:\[[ xX]\]\s*)?)?(.*)$/);
      return `${match?.[1] ?? ""}- ${match?.[2]?.trim() || "列表项"}`;
    });
  };

  const prefixTask = () => {
    updateSelectedLines((line) => {
      const match = line.match(/^(\s*)(?:[-*+]\s+(?:\[[ xX]\]\s*)?)?(.*)$/);
      return `${match?.[1] ?? ""}- [ ] ${match?.[2]?.trim() || "任务"}`;
    });
  };

  const insertLink = () => {
    const { start, end } = selectionRange();
    const selected = value.slice(start, end) || "链接文本";
    const replacement = `[${selected}](https://example.com)`;
    replaceRange(start, end, replacement, start + 1, start + 1 + selected.length);
  };

  const insertImage = () => {
    const { start, end } = selectionRange();
    const selected = value.slice(start, end) || "图片描述";
    const replacement = `![${selected}](image-url)`;
    replaceRange(start, end, replacement, start + 2, start + 2 + selected.length);
  };

  const insertCodeBlock = () => {
    const { start, end } = selectionRange();
    const selected = value.slice(start, end) || "code";
    const prefix = start > 0 && value[start - 1] !== "\n" ? "\n\n" : "";
    const suffix = end < value.length && value[end] !== "\n" ? "\n\n" : "";
    const replacement = `${prefix}\`\`\`\n${selected}\n\`\`\`${suffix}`;
    const codeStart = start + prefix.length + 4;
    replaceRange(start, end, replacement, codeStart, codeStart + selected.length);
  };

  const insertTable = () => {
    const { start, end } = selectionRange();
    const prefix = start > 0 && value[start - 1] !== "\n" ? "\n\n" : "";
    const suffix = end < value.length && value[end] !== "\n" ? "\n\n" : "";
    const table = [
      "| 列 A | 列 B |",
      "| --- | --- |",
      "| 内容 | 内容 |",
    ].join("\n");
    replaceRange(start, end, `${prefix}${table}${suffix}`);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Tab") {
      event.preventDefault();
      const { start, end } = selectionRange();
      replaceRange(start, end, "  ");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey) {
      if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        wrapSelection("**", "**", "加粗文本");
      } else if (event.key.toLowerCase() === "i") {
        event.preventDefault();
        wrapSelection("*", "*", "斜体文本");
      }
    }
  };

  const refreshCursorPosition = () => {
    setCursorPosition(textareaRef.current?.selectionStart ?? value.length);
  };

  const handleSourceBlur = () => {
    window.setTimeout(() => {
      const wrapper = textareaRef.current?.closest(".markdown-source-wrap");
      setIsSourceFocused(Boolean(wrapper?.contains(document.activeElement)));
    }, 0);
  };

  const runMarkdownAi = async (action: AiNodeAction) => {
    const target = findMarkdownAiTarget(
      value,
      textareaRef.current?.selectionStart ?? cursorPosition,
    );
    if (!target) return;
    const result = await onAiAction(action, target, value);
    if (!result) return;
    window.requestAnimationFrame(() => {
      const nextCursor = clampNumber(result.cursor, 0, result.value.length);
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
      setCursorPosition(nextCursor);
    });
  };

  return (
    <div className={classNames("markdown-editor", "markdown-view", `mode-${viewMode}`, `markdown-view-${viewMode}`)}>
      <div className="markdown-toolbar">
        <div className="markdown-toolbar-group">
          <button type="button" title="一级标题" disabled={editorToolsDisabled} onClick={() => setHeading(1)}>
            <Heading1 size={16} />
          </button>
          <button type="button" title="二级标题" disabled={editorToolsDisabled} onClick={() => setHeading(2)}>
            <Heading2 size={16} />
          </button>
          <button type="button" title="三级标题" disabled={editorToolsDisabled} onClick={() => setHeading(3)}>
            <Heading3 size={16} />
          </button>
        </div>
        <div className="markdown-toolbar-group">
          <button type="button" title="加粗" disabled={editorToolsDisabled} onClick={() => wrapSelection("**", "**", "加粗文本")}>
            <Bold size={16} />
          </button>
          <button type="button" title="斜体" disabled={editorToolsDisabled} onClick={() => wrapSelection("*", "*", "斜体文本")}>
            <Italic size={16} />
          </button>
          <button type="button" title="删除线" disabled={editorToolsDisabled} onClick={() => wrapSelection("~~", "~~", "删除线文本")}>
            <Strikethrough size={16} />
          </button>
          <button type="button" title="行内代码" disabled={editorToolsDisabled} onClick={() => wrapSelection("`", "`", "code")}>
            <Code2 size={16} />
          </button>
        </div>
        <div className="markdown-toolbar-group">
          <button type="button" title="引用" disabled={editorToolsDisabled} onClick={prefixQuote}>
            <Quote size={16} />
          </button>
          <button type="button" title="列表" disabled={editorToolsDisabled} onClick={prefixList}>
            <List size={16} />
          </button>
          <button type="button" title="任务" disabled={editorToolsDisabled} onClick={prefixTask}>
            <ListChecks size={16} />
          </button>
          <button type="button" title="链接" disabled={editorToolsDisabled} onClick={insertLink}>
            <Link2 size={16} />
          </button>
          <button type="button" title="图片" disabled={editorToolsDisabled} onClick={insertImage}>
            <Image size={16} />
          </button>
          <button type="button" title="代码块" disabled={editorToolsDisabled} onClick={insertCodeBlock}>
            <Code2 size={16} />
          </button>
          <button type="button" title="表格" disabled={editorToolsDisabled} onClick={insertTable}>
            <Table size={16} />
          </button>
        </div>
        <div className="markdown-toolbar-group markdown-mode-toggle markdown-view-toggle">
          <button
            type="button"
            title="编辑"
            className={viewMode === "edit" ? "selected" : ""}
            onClick={() => onViewModeChange("edit")}
          >
            <Pencil size={16} />
          </button>
          <button
            type="button"
            title="预览"
            className={viewMode === "preview" ? "selected" : ""}
            onClick={() => onViewModeChange("preview")}
          >
            <Eye size={16} />
          </button>
          <button
            type="button"
            title="分栏"
            className={viewMode === "split" ? "selected" : ""}
            onClick={() => onViewModeChange("split")}
          >
            <Columns2 size={16} />
          </button>
        </div>
      </div>

      <div className="markdown-workbench">
        {viewMode !== "preview" && (
          <div className={classNames("markdown-source-wrap", isSourceFocused && Boolean(markdownAiTarget) && "has-ai-target")}>
            <LinkInput
              onSuggest={onSuggest} onBind={onBind} onCreate={onCreate}
              inputRef={textareaRef}
              className="markdown-source"
              value={value}
              onChange={(event) => {
                onChange(event.target.value);
                setCursorPosition(event.target.selectionStart);
              }}
              onKeyDown={handleKeyDown}
              onKeyUp={refreshCursorPosition}
              onClick={refreshCursorPosition}
              onSelect={refreshCursorPosition}
              onFocus={() => {
                setIsSourceFocused(true);
                refreshCursorPosition();
              }}
              onBlur={handleSourceBlur}
              spellCheck={false}
              aria-label="Markdown 源码"
            />
            {isSourceFocused && markdownAiTarget && (
              <div className="markdown-ai-anchor">
                <AiInlineMenu
                  busy={isAiBusy}
                  onAction={runMarkdownAi}
                />
              </div>
            )}
          </div>
        )}
        {viewMode !== "edit" && (
          <MarkdownPreview content={value} documentId={documentId} />
        )}
      </div>
    </div>
  );
}

function MarkdownPreview({ content, documentId }: { content: string; documentId: string }) {
  const blocks = useMemo(() => {
  const blocks: React.ReactNode[] = [];
  try {
  const mapping = markdownSourceMap(content);
  const lines = mapping.text.split("\n");
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) { lineOffsets.push(offset); offset += line.length + 1; }
  const sourceFor = (text: string, start: number, projected?: number[]): MarkdownRenderSource => {
    const sourceOffsets = projected ?? mapping.offsets.slice(start, start + text.length + 1);
    return { documentId, kind: "markdown", start: sourceOffsets[0] ?? -1, end: sourceOffsets[sourceOffsets.length - 1] ?? -1, sourceOffsets, rawDocument: content };
  };
  const inline = (text: string, key: string, start: number, projected?: number[]) => renderInlineMarkdown(text, key, sourceFor(text, start, projected));
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s{0,3}(```+|~~~+)\s*(.*)$/);
    if (fence) {
      const marker = fence[1];
      const language = fence[2].trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith(marker)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre key={`code-${index}`} className="markdown-preview-code">
          <code data-language={language || undefined}>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*$/);
    if (heading) {
      const level = Math.min(heading[1].length, 6);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      const text = heading[2].replace(/\s+#+\s*$/u, "").trim();
      blocks.push(
        <Tag key={`heading-${index}`}>
          {inline(text, `heading-${index}`, lineOffsets[index] + line.indexOf(text, heading[1].length))}
        </Tag>,
      );
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const tableStart = index;
      const tableLines = [lines[index], lines[index + 1]];
      index += 2;
      const framed = tableLines[0].trimStart().startsWith("|");
      while (index < lines.length && lines[index].includes("|") && lines[index].trim() &&
        !/^\s{0,3}(?:#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|`{3,}|~{3,})/u.test(lines[index]) &&
        (!framed || lines[index].trimStart().startsWith("|"))) {
        tableLines.push(lines[index]);
        index += 1;
      }
      const headers = markdownTableCells(tableLines[0]);
      const rows = tableLines.slice(2).map((line) => {
        const cells = markdownTableCells(line).slice(0, headers.length);
        while (cells.length < headers.length) cells.push({ text: "", offsets: [] });
        return cells;
      });
      blocks.push(
        <table key={`table-${index}`} className="markdown-preview-table">
          <thead>
            <tr>
              {headers.map((cell, cellIndex) => (
                <th key={`head-${cellIndex}`}>
                  {inline(cell.text, `table-head-${index}-${cellIndex}`, lineOffsets[tableStart], cell.offsets.map((at) => mapping.offsets[lineOffsets[tableStart] + at]))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`}>
                {row.map((cell, cellIndex) => (
                  <td key={`cell-${rowIndex}-${cellIndex}`}>
                    {inline(cell.text, `table-cell-${index}-${rowIndex}-${cellIndex}`, lineOffsets[tableStart + rowIndex + 2], cell.offsets.map((at) => mapping.offsets[lineOffsets[tableStart + rowIndex + 2] + at]))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    const listItem = line.match(/^(\s*)([-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/);
    if (listItem) {
      const items: Array<{ indent: number; checked?: boolean; ordered?: boolean; start?: number; text: string; source: MarkdownRenderSource }> = [];
      const firstOrdered = /^\d/u.test(listItem[2]);
      while (index < lines.length) {
        const item = lines[index].match(/^(\s*)([-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/);
        if (!item || (items.length && item[1].length === listItem[1].length && /^\d/u.test(item[2]) !== firstOrdered)) break;
        items.push({
          indent: item[1].replace(/\t/g, "    ").length,
          ordered: /^\d/u.test(item[2]),
          start: /^\d/u.test(item[2]) ? Number.parseInt(item[2], 10) : undefined,
          checked: item[3] ? item[3].toLowerCase() === "x" : undefined,
          text: item[4],
          source: sourceFor(item[4], lineOffsets[index] + lines[index].length - item[4].length),
        });
        index += 1;
      }
      blocks.push(renderMarkdownPreviewList(buildMarkdownPreviewList(items), `list-${index}`));
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      const quoteLines: Array<{ text: string; start: number }> = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
        const text = lines[index].replace(/^\s{0,3}>\s?/, "");
        quoteLines.push({ text, start: lineOffsets[index] + lines[index].length - text.length });
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${index}`}>
          {quoteLines.map((quoteLine, quoteIndex) => (
            <p key={`quote-line-${quoteIndex}`}>
              {inline(quoteLine.text, `quote-${index}-${quoteIndex}`, quoteLine.start)}
            </p>
          ))}
        </blockquote>,
      );
      continue;
    }

    const paragraphStart = index;
    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s{0,3}(```|~~~)/.test(lines[index]) &&
      !/^\s{0,3}#{1,6}\s+/.test(lines[index]) &&
      !/^(\s*)(?:[-*+]|\d+[.)])\s+/.test(lines[index]) &&
      !/^\s{0,3}>\s?/.test(lines[index]) &&
      !isTableStart(lines, index)
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={`paragraph-${index}`}>
        {inline(paragraphLines.join("\n"), `paragraph-${index}`, lineOffsets[paragraphStart])}
      </p>,
    );
  }
  return blocks;
  } catch (error) {
    return [<p key="preview-error" role="alert">预览已停止：{error instanceof Error ? error.message : "内容超过处理预算"}。源码仍保留在编辑框中。</p>];
  }
  }, [content, documentId]);

  return (
    <div className="markdown-preview" aria-label="Markdown 预览">
      {blocks.length ? blocks : <p className="empty-text">暂无 Markdown 内容</p>}
    </div>
  );
}

// Transformed table text without an exact source span fails closed.
const markdownCellOffset = (row: string, cells: string[], index: number, offset: number) => {
  let cursor = 0;
  for (let i = 0; i <= index; i++) {
    const found = row.indexOf(cells[i], cursor);
    if (found < 0) return -1;
    if (i === index) return offset + found;
    cursor = found + cells[i].length;
  }
  return -1;
};

const splitMarkdownTableRow = (row: string) =>
  splitEscapedPipe(row.trim().replace(/^\|/, "").replace(/\|$/, "")).map((cell) => cell.trim());

const splitEscapedPipe = (value: string) => {
  const cells: string[] = [];
  let cell = "";
  let escaping = false;

  Array.from(value).forEach((char) => {
    if (escaping) {
      cell += char;
      escaping = false;
      return;
    }
    if (char === "\\") {
      escaping = true;
      return;
    }
    if (char === "|") {
      cells.push(cell);
      cell = "";
      return;
    }
    cell += char;
  });

  if (escaping) cell += "\\";
  cells.push(cell);
  return cells;
};

const isTableSeparator = (row: string) =>
  splitMarkdownTableRow(row).every((cell) => /^:?-{3,}:?$/.test(cell));

const isTableStart = (lines: string[], index: number) =>
  Boolean(lines[index]?.includes("|") && lines[index + 1]?.includes("|") && isTableSeparator(lines[index + 1]));

interface MarkdownPreviewListItem {
  ordered?: boolean;
  start?: number;
  text: string;
  source: LinkOrigin;
  checked?: boolean;
  children: MarkdownPreviewListItem[];
}

const buildMarkdownPreviewList = (
  items: Array<{ indent: number; checked?: boolean; ordered?: boolean; start?: number; text: string; source: LinkOrigin }>,
) => {
  const roots: MarkdownPreviewListItem[] = [];
  const stack: Array<{ indent: number; children: MarkdownPreviewListItem[] }> = [
    { indent: -1, children: roots },
  ];

  items.forEach((item) => {
    while (stack.length > 1 && item.indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const node: MarkdownPreviewListItem = {
      text: item.text,
      source: item.source,
      checked: item.checked,
      ordered: item.ordered,
      start: item.start,
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    stack.push({ indent: item.indent, children: node.children });
  });

  assertTreeBudget(roots);
  return roots;
};

const renderMarkdownPreviewList = (
  items: MarkdownPreviewListItem[], keyPrefix: string,
): React.ReactNode => {
  const groups: MarkdownPreviewListItem[][] = [];
  for (const item of items) {
    const previous = groups[groups.length - 1];
    if (previous && previous[0].ordered === item.ordered) previous.push(item);
    else groups.push([item]);
  }
  return groups.map((group, groupIndex) => {
    const Tag = group[0].ordered ? "ol" : "ul";
    return <Tag key={`${keyPrefix}-${groupIndex}`} className="markdown-preview-list" start={group[0].ordered ? group[0].start : undefined}>
      {group.map((item, itemIndex) => <li key={`${keyPrefix}-${groupIndex}-${itemIndex}`} className={item.checked !== undefined ? "task-item" : undefined}>
        <span className="markdown-preview-list-line">
          {item.checked !== undefined && <input type="checkbox" checked={item.checked} readOnly />}
          <span>{renderInlineMarkdown(item.text, `${keyPrefix}-${groupIndex}-${itemIndex}`, item.source)}</span>
        </span>
        {item.children.length > 0 && renderMarkdownPreviewList(item.children, `${keyPrefix}-${groupIndex}-${itemIndex}-children`)}
      </li>)}
    </Tag>;
  });
};

type MarkdownRenderSource = LinkOrigin & { sourceOffsets?: number[]; rawDocument?: string };
const renderInlineMarkdown = (text: string, keyPrefix: string, source: MarkdownRenderSource): React.ReactNode[] => {
  const wikiLinks = scanLinks(text);
  if (wikiLinks.length) {
    const linked: React.ReactNode[] = [];
    let cursor = 0;
    wikiLinks.forEach((link, index) => {
      if (link.start > cursor) linked.push(...renderInlineMarkdown(text.slice(cursor, link.start), `${keyPrefix}-${index}`, { ...source, start: source.sourceOffsets?.[cursor] ?? source.start + cursor, sourceOffsets: source.sourceOffsets?.slice(cursor, link.start + 1) }));
      linked.push(
        <button
          key={`${keyPrefix}-wiki-${link.start}`}
          type="button"
          className="wiki-link-chip"
          onClick={(event) => {
            event.preventDefault();
            const start = source.sourceOffsets?.[link.start] ?? (source.start < 0 ? -1 : source.start + link.start);
            const end = source.sourceOffsets?.[link.end] ?? source.start + link.end;
            const { sourceOffsets, rawDocument, ...origin } = source;
            openWikiLinkHandler?.(link.raw, { ...origin, start, end, sourceRaw: rawDocument?.slice(start, end) ?? link.raw });
          }}
        >
          {link.label}
        </button>,
      );
      cursor = link.end;
    });
    if (cursor < text.length) linked.push(...renderInlineMarkdown(text.slice(cursor), `${keyPrefix}-end`, { ...source, start: source.sourceOffsets?.[cursor] ?? source.start + cursor, sourceOffsets: source.sourceOffsets?.slice(cursor) }));
    return linked;
  }
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const token of markdownInlineTokens(text)) {
    const match = token.groups;
    if (token.index > lastIndex) nodes.push(markdownPlainText(text.slice(lastIndex, token.index)));

    const key = `${keyPrefix}-${token.index}`;
    if (match[2] !== undefined) {
      if (/^bike-attachment:sha256:[a-f0-9]{64}$/u.test(match[3]!)) {
        const label = markdownPlainText(match[2]);
        nodes.push(<AttachmentItem key={key} reference={{ assetId: match[3]!.slice("bike-attachment:".length), name: label || "图片", alt: label }} />);
        lastIndex = token.end;
        continue;
      }
      const source = safeMarkdownUrl(match[3]!, "image");
      nodes.push(
        source && /^https?:/u.test(source) ? (
          <span key={key} className="markdown-image-placeholder">远程图片未自动加载：<a href={source} target="_blank" rel="noreferrer">{match[2] || "查看图片"}</a></span>
        ) : source ? (
          <img key={key} src={source} alt={match[2]} className="markdown-preview-image" />
        ) : (
          <span key={key}>{match[2]}</span>
        ),
      );
    } else if (match[4] !== undefined) {
      if (/^bike-attachment:sha256:[a-f0-9]{64}$/u.test(match[5]!)) {
        nodes.push(<AttachmentItem key={key} reference={{ assetId: match[5]!.slice("bike-attachment:".length), name: markdownPlainText(match[4]) || "附件" }} />);
        lastIndex = token.end;
        continue;
      }
      const href = safeMarkdownUrl(match[5]!, "link");
      nodes.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer">
            {match[4]}
          </a>
        ) : (
          <span key={key}>{match[4]}</span>
        ),
      );
    } else if (match[6] !== undefined) {
      nodes.push(<code key={key}>{match[6]}</code>);
    } else if (match[7] !== undefined || match[8] !== undefined) {
      nodes.push(<strong key={key}>{match[7] ?? match[8]}</strong>);
    } else if (match[9] !== undefined) {
      nodes.push(<del key={key}>{match[9]}</del>);
    } else {
      nodes.push(<em key={key}>{match[10] ?? match[11]}</em>);
    }

    lastIndex = token.end;
  }

  if (lastIndex < text.length) {
    nodes.push(markdownPlainText(text.slice(lastIndex)));
  }

  return nodes;
};

interface OutlineViewProps {
  nodes: OutlineNode[];
  activeNodeId: string | null;
  setNodeRef: (id: string, element: HTMLTextAreaElement | null) => void;
  onSelect: (id: string) => void;
  onText: (id: string, text: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>, node: OutlineNode) => void;
  onPatch: (id: string, patch: Partial<OutlineNode>) => void;
  onInsertAfter: (id: string) => void;
  onInsertChild: (id: string) => void;
  onRemove: (id: string) => void;
  onCopyLink: (id: string) => void;
  onExportNode: (id: string) => void;
  onUpdateNodes: (sourceId: string, targetId: string, zone: OutlineDropZone) => void;
  onAiAction: (action: AiNodeAction, targetId: StructuredAiTargetId) => void;
  isAiBusy: (id: StructuredAiTargetId) => boolean;
  onSuggestLinks?: (query: string) => { items: Suggestion[]; requiresExplicit: boolean; highlight: number };
  onBindLink?: (nodeId: string, text: string, source: { start: number; end: number; raw: string }, target: { documentId: string; nodeId?: string }, labelMode: "auto" | "custom") => void;
  onCreateLink?: (nodeId: string, text: string, query: { start: number; end: number }, title: string) => void;
  onPublishLabel?: (nodeId: string, previous: string, next: string) => void;
  onLabelFocus?: (nodeId: string, text: string) => void;
  onFollowLink?: (raw: string, source: Omit<LinkOrigin, "documentId">) => void;
  locatedNodeId?: string | null;
}

interface OutlineNodeRowProps {
  node: OutlineNode;
  depth: number;
  isActive: boolean;
  onSelect: (id: string) => void;
  onText: (id: string, text: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>, node: OutlineNode) => void;
  onPatch: (id: string, patch: Partial<OutlineNode>) => void;
  onInsertAfter: (id: string) => void;
  onInsertChild: (id: string) => void;
  onRemove: (id: string) => void;
  setNodeRef: (id: string, element: HTMLTextAreaElement | null) => void;
  onOpenMenu: (nodeId: string, rect: DOMRect) => void;
  onDragStart: (event: React.DragEvent, id: string) => void;
  onDragOver: (event: React.DragEvent, id: string) => void;
  onDragLeave: (event: React.DragEvent, id: string) => void;
  onDragEnd: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent, id: string) => void;
  dropZone: OutlineDropZone | null;
  onAiAction: (action: AiNodeAction, targetId: StructuredAiTargetId) => void;
  isAiBusy: boolean;
  onSuggestLinks?: (query: string) => { items: Suggestion[]; requiresExplicit: boolean; highlight: number };
  onBindLink?: (nodeId: string, text: string, source: { start: number; end: number; raw: string }, target: { documentId: string; nodeId?: string }, labelMode: "auto" | "custom") => void;
  onCreateLink?: (nodeId: string, text: string, query: { start: number; end: number }, title: string) => void;
  onPublishLabel?: (nodeId: string, previous: string, next: string) => void;
  onLabelFocus?: (nodeId: string, text: string) => void;
  onFollowLink?: (raw: string, source: Omit<LinkOrigin, "documentId">) => void;
  located?: boolean;
}

const OutlineNodeRow = React.memo(function OutlineNodeRow({
  node,
  depth,
  isActive,
  onSelect,
  onText,
  onKeyDown,
  onPatch,
  onInsertAfter,
  onInsertChild,
  onRemove,
  setNodeRef,
  onOpenMenu,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDragEnd,
  onDrop,
  dropZone,
  onAiAction,
  isAiBusy,
  onSuggestLinks,
  onBindLink,
  onCreateLink,
  onPublishLabel,
  onLabelFocus,
  onFollowLink,
  located,
}: OutlineNodeRowProps) {
  const [localText, setLocalText] = useState(node.text);
  const committedTextRef = useRef(node.text);
  const baselineRef = useRef(node.text);
  const [linkChoices, setLinkChoices] = useState<{ items: Suggestion[]; requiresExplicit: boolean; highlight: number; query: { start: number; end: number } } | null>(null);
  const [linkPopupStyle, setLinkPopupStyle] = useState<React.CSSProperties>({});
  const isFocusedRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const synchronouslyResizedTextRef = useRef<string | null>(null);
  const attachTextarea = useCallback((element: HTMLTextAreaElement | null) => {
    textareaRef.current = element;
    setNodeRef(node.id, element);
  }, [node.id, setNodeRef]);

  // Link suggestions read the active input's geometry in the same input event.
  const autoResize = useCallback((element: HTMLTextAreaElement | null) => {
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
    synchronouslyResizedTextRef.current = element.value;
  }, []);

  useLayoutEffect(() => {
    if (!isFocusedRef.current || localText === committedTextRef.current) {
      setLocalText(node.text);
      baselineRef.current = node.text;
    }
    if (localText === node.text) baselineRef.current = node.text;
    committedTextRef.current = node.text;
  }, [node.text]);

  useLayoutEffect(() => {
    const element = textareaRef.current;
    return element ? observeTextareaLayout(element) : undefined;
  }, []);

  useLayoutEffect(() => {
    if (synchronouslyResizedTextRef.current === localText) {
      synchronouslyResizedTextRef.current = null;
      return;
    }
    requestTextareaResize(textareaRef.current);
  }, [localText]);

  useLayoutEffect(() => {
    requestTextareaResize(textareaRef.current);
  }, [node.headingLevel, node.bold, node.italic]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) window.clearTimeout(debounceTimerRef.current);
    };
  }, []);

  const refreshLinkChoices = (value: string, caret: number) => {
    const query = activeLinkQuery(value, caret);
    if (!query || !onSuggestLinks) {
      setLinkChoices(null);
      return;
    }
    const suggestion = onSuggestLinks(query.query ?? "");
    if (textareaRef.current) {
      const rect = textareaRef.current.getBoundingClientRect();
      const pane = textareaRef.current.closest(".editor-pane")?.getBoundingClientRect();
      const below = Math.min(window.innerHeight, pane?.bottom ?? window.innerHeight) - rect.bottom - 8;
      const above = rect.top - Math.max(0, pane?.top ?? 0) - 8;
      const up = below < 160 && above > below;
      setLinkPopupStyle({ top: up ? "auto" : "100%", bottom: up ? "100%" : "auto", maxHeight: Math.max(80, Math.min(240, up ? above : below)) });
    }
    setLinkChoices({ ...suggestion, query });
  };

  const chooseLink = (item: Suggestion) => {
    if (!linkChoices) return;
    if (item.kind === "create") {
      const inserted = insertLinkAtQuery(localText, linkChoices.query, { documentName: item.title });
      setLocalText(inserted.text);
      baselineRef.current = inserted.text;
      committedTextRef.current = inserted.text;
      onCreateLink?.(node.id, localText, linkChoices.query, item.title);
      setLinkChoices(null);
      return;
    }
    const inserted = insertLinkAtQuery(localText, linkChoices.query, {
      documentName: item.kind === "node" ? item.documentTitle || item.title : item.title,
      nodeName: item.kind === "node" ? item.title : null,
    });
    setLocalText(inserted.text);
    baselineRef.current = inserted.text;
    onBindLink?.(node.id, inserted.text, { start: inserted.start, end: inserted.end, raw: inserted.raw }, {
      documentId: item.documentId || "",
      ...(item.nodeId ? { nodeId: item.nodeId } : {}),
    }, inserted.labelMode);
    setLinkChoices(null);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setLocalText(val);
    autoResize(e.target);
    refreshLinkChoices(val, e.target.selectionStart ?? val.length);
  };

  const handleBlur = () => {
    isFocusedRef.current = false;
    setLinkChoices(null);
    onPublishLabel?.(node.id, baselineRef.current, localText);
  };

  const handleFocus = () => {
    isFocusedRef.current = true;
    baselineRef.current = node.text;
    onLabelFocus?.(node.id, node.text);
    onSelect(node.id);
  };

  const handleLinkKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!linkChoices) return false;
    if (event.nativeEvent.isComposing) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setLinkChoices((current) => current ? { ...current, highlight: Math.max(-1, Math.min(current.items.length - 1, current.highlight + delta)) } : current);
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (linkChoices.highlight >= 0) chooseLink(linkChoices.items[linkChoices.highlight]);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setLinkChoices(null);
      return true;
    }
    return false;
  };

  const handleBulletClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onSelect(node.id);
    const rect = event.currentTarget.getBoundingClientRect();
    onOpenMenu(node.id, rect);
  };

  const handleCheckboxToggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onPatch(node.id, { checked: !node.checked });
  };

  return (
    <div
      className={classNames(
        "outline-row",
        isActive && "active",
        located && "is-located",
        `node-${normalizeColor(node.color)}`,
        `heading-${node.headingLevel ?? 0}`,
        node.highlight && "is-highlighted",
        dropZone ? `drop-${dropZone}` : false,
      )}
      style={{ "--depth": depth } as React.CSSProperties}
      data-node-id={node.id}
      onClick={() => onSelect(node.id)}
      onDragOver={(e) => onDragOver(e, node.id)}
      onDragLeave={(e) => onDragLeave(e, node.id)}
      onDrop={(e) => onDrop(e, node.id)}
    >
      <button
        className="disclosure"
        onClick={(event) => {
          event.stopPropagation();
          onPatch(node.id, { collapsed: !node.collapsed });
        }}
        disabled={!node.children.length}
        title={node.collapsed ? "展开" : "折叠"}
      >
        {node.children.length ? (
          node.collapsed ? (
            <ChevronRight size={15} />
          ) : (
            <ChevronDown size={15} />
          )
        ) : (
          <span />
        )}
      </button>

      <button
        className={classNames(
          "check-button bullet-handle",
          node.children.length > 0 && "has-children",
          node.collapsed && "is-collapsed"
        )}
        draggable="true"
        onDragStart={(event) => {
          event.stopPropagation();
          onDragStart(event, node.id);
        }}
        onDragEnd={onDragEnd}
        onClick={handleBulletClick}
        title="主题操作"
      >
        <span className="bullet-dot" />
      </button>

      <div className="outline-text-cell">
        {node.isTodo && (
          <button
            className="check-button task-checkbox"
            onClick={handleCheckboxToggle}
            title={node.checked ? "设为未完成" : "设为已完成"}
          >
            {node.checked ? <CheckCircle2 size={16} className="checked" /> : <Circle size={16} />}
          </button>
        )}
        {node.icon && <span className="node-icon">{node.icon}</span>}
        <textarea
          ref={attachTextarea}
          value={localText}
          className={classNames(
            node.checked && node.isTodo && "checked",
            node.bold && "is-bold",
            node.italic && "is-italic",
            node.underline && "is-underline",
            node.strike && "is-strike",
          )}
          rows={1}
          onChange={handleChange}
          onDragStart={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (handleLinkKeyDown(event)) return;
            onKeyDown(event, node);
          }}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholder="输入主题"
        />
        <AiInlineMenu
          busy={isAiBusy}
          onAction={(action) => onAiAction(action, node.id)}
        />
        {node.imageName && (
          <span className="node-attachment">
            <Image size={13} />
            {node.imageAlt || node.imageName}
          </span>
        )}
        <AttachmentItems node={node} compact />
        {node.table && (
          <span className="node-attachment">
            <Table size={13} />
            表格 {node.table.length}x{node.table[0]?.length ?? 0}
          </span>
        )}
        {linkChoices && <div className="outline-link-popup" style={linkPopupStyle}>
          <LinkAutocomplete items={linkChoices.items} highlight={linkChoices.highlight} requiresExplicit={linkChoices.requiresExplicit}
            onHighlight={(index) => setLinkChoices((current) => current ? { ...current, highlight: index } : current)}
            onSelect={chooseLink} onCancel={() => setLinkChoices(null)} />
        </div>}
      </div>

      <div className="row-meta">
        {extractTags(localText).map((tag) => (
          <span key={tag}>#{tag}</span>
        ))}
        {scanLinks(localText).map((link) => (
          <button
            key={`${link.start}-${link.raw}`}
            type="button"
            className="wiki-link-chip"
            title="Cmd/Ctrl+点击打开链接"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              if (!(event.metaKey || event.ctrlKey)) return;
              event.stopPropagation();
              onFollowLink?.(link.raw, { kind: "node-field", nodeId: node.id, field: "text", start: link.start, end: link.end });
            }}
          >
            {link.raw}
          </button>
        ))}
      </div>

      <div className="row-actions">
        <button onClick={() => onInsertAfter(node.id)} title="新增同级">
          <Plus size={15} />
        </button>
        <button onClick={() => onInsertChild(node.id)} title="新增子级">
          <Indent size={15} />
        </button>
        <button onClick={() => onRemove(node.id)} title="删除">
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
});

const OutlineView = React.memo(function OutlineView(props: OutlineViewProps) {
  const rows = useMemo(
    () => flattenNodes(props.nodes, { respectCollapsed: true }),
    [props.nodes],
  );
  const [menuState, setMenuState] = useState<{
    nodeId: string;
    x: number;
    y: number;
  } | null>(null);

  const [dropState, setDropState] = useState<{
    id: string;
    zone: OutlineDropZone;
  } | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const virtual = useVirtualOutline(rows, props.activeNodeId, draggedId);
  const setVisibleNodeRef = useCallback((id: string, input: HTMLTextAreaElement | null) => {
    props.setNodeRef(id, input);
    virtual.measure(id, input?.closest<HTMLElement>(".outline-row") ?? null);
  }, [props.setNodeRef, virtual.measure]);
  const draggedIdRef = useRef<string | null>(null);
  const draggedNodeRef = useRef<OutlineNode | null>(null);

  useEffect(() => {
    if (!menuState) return;
    const handleCloseClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".node-menu")) {
        return;
      }
      setMenuState(null);
    };
    const handleCloseKey = () => setMenuState(null);
    const handleResize = () => setMenuState(null);

    window.addEventListener("click", handleCloseClick);
    window.addEventListener("keydown", handleCloseKey);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("click", handleCloseClick);
      window.removeEventListener("keydown", handleCloseKey);
      window.removeEventListener("resize", handleResize);
    };
  }, [menuState]);

  const menuNode = menuState
    ? rows.find((row) => row.node.id === menuState.nodeId)?.node ?? null
    : null;

  const closeMenu = useCallback(() => setMenuState(null), []);
  const patchFromMenu = useCallback((patch: Partial<OutlineNode>) => {
    if (!menuState) return;
    props.onPatch(menuState.nodeId, patch);
    closeMenu();
  }, [closeMenu, menuState, props.onPatch]);

  const handleOpenMenu = useCallback((nodeId: string, rect: DOMRect) => {
    setMenuState({
      nodeId,
      x: rect.left + rect.width / 2,
      y: rect.bottom + 8,
    });
  }, []);

  const handleDragStart = useEventCallback((e: React.DragEvent, id: string) => {
    draggedIdRef.current = id;
    setDraggedId(id);
    draggedNodeRef.current = findNode(props.nodes, id);
    setDropState(null);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  });

  const dropZoneForEvent = useCallback((e: React.DragEvent): OutlineDropZone => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relativeY = e.clientY - rect.top;
    if (relativeY < rect.height / 3) return "before";
    if (relativeY > (rect.height * 2) / 3) return "after";
    return "child";
  }, []);

  const handleDragOver = useEventCallback((e: React.DragEvent, id: string) => {
    const currentDraggedId = draggedIdRef.current;
    if (currentDraggedId === id) {
      setDropState((current) => (current?.id === id ? null : current));
      return;
    }
    const sourceNode = draggedNodeRef.current;
    if (sourceNode && findNode(sourceNode.children, id)) {
      setDropState((current) => (current?.id === id ? null : current));
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const zone = dropZoneForEvent(e);
    setDropState((current) =>
      current?.id === id && current.zone === zone ? current : { id, zone },
    );
  });

  const handleDragLeave = useCallback((e: React.DragEvent, id: string) => {
    const nextTarget = e.relatedTarget;
    if (nextTarget instanceof HTMLElement && e.currentTarget.contains(nextTarget)) return;
    setDropState((current) => (current?.id === id ? null : current));
  }, []);

  const handleDragEnd = useCallback(() => {
    draggedIdRef.current = null;
    setDraggedId(null);
    draggedNodeRef.current = null;
    setDropState(null);
  }, []);

  const handleDrop = useEventCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData("text/plain") || draggedIdRef.current;
    if (!sourceId || sourceId === targetId) return;

    const sourceNode = findNode(props.nodes, sourceId);
    if (!sourceNode) return;

    if (findNode(sourceNode.children, targetId)) return;

    const dropZone = dropState?.id === targetId ? dropState.zone : dropZoneForEvent(e);

    props.onUpdateNodes(sourceId, targetId, dropZone);
    draggedIdRef.current = null;
    setDraggedId(null);
    draggedNodeRef.current = null;
    setDropState(null);
  });

  const rowCallbacks = useMemo(() => ({
    onSelect: props.onSelect,
    onText: props.onText,
    onKeyDown: props.onKeyDown,
    onPatch: props.onPatch,
    onInsertAfter: props.onInsertAfter,
    onInsertChild: props.onInsertChild,
    onRemove: props.onRemove,
    setNodeRef: setVisibleNodeRef,
    onOpenMenu: handleOpenMenu,
    onDragStart: handleDragStart,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDragEnd: handleDragEnd,
    onDrop: handleDrop,
    onAiAction: props.onAiAction,
    onSuggestLinks: props.onSuggestLinks,
    onBindLink: props.onBindLink,
    onCreateLink: props.onCreateLink,
    onPublishLabel: props.onPublishLabel,
    onLabelFocus: props.onLabelFocus,
    onFollowLink: props.onFollowLink,
  }), [
    props.onSelect, props.onText, props.onKeyDown, props.onPatch,
    props.onInsertAfter, props.onInsertChild, props.onRemove, setVisibleNodeRef,
    handleOpenMenu, handleDragStart, handleDragOver, handleDragLeave, handleDragEnd, handleDrop,
    props.onAiAction, props.onSuggestLinks, props.onBindLink, props.onCreateLink,
    props.onPublishLabel, props.onLabelFocus, props.onFollowLink,
  ]);
  const rowCache = useMemo(() => new WeakMap<OutlineNode, {
    depth: number;
    isActive: boolean;
    dropZone: OutlineDropZone | null;
    isAiBusy: boolean;
    located: boolean;
    element: React.ReactElement;
  }>(), [rowCallbacks]);

  const renderRow = ({ node, depth }: (typeof rows)[number]) => {
        const isActive = props.activeNodeId === node.id;
        const dropZone = dropState?.id === node.id ? dropState.zone : null;
        const isAiBusy = props.isAiBusy(node.id);
        const located = props.locatedNodeId === node.id;
        const cached = rowCache.get(node);
        if (cached && cached.depth === depth && cached.isActive === isActive
          && cached.dropZone === dropZone && cached.isAiBusy === isAiBusy && cached.located === located) {
          return cached.element;
        }
        const element = (
          <OutlineNodeRow
            key={node.id}
            node={node}
            depth={depth}
            {...rowCallbacks}
            isActive={isActive}
            dropZone={dropZone}
            isAiBusy={isAiBusy}
            located={located}
          />
        );
        rowCache.set(node, { depth, isActive, dropZone, isAiBusy, located, element });
        return element;
  };

  return (
    <div className="outline-list" ref={virtual.containerRef}>
      {virtual.visible.map(({ row, gap }) => <React.Fragment key={row.node.id}>
        {gap > 0 && <div aria-hidden="true" style={{ height: gap }} />}
        {renderRow(row)}
      </React.Fragment>)}
      {virtual.trailing > 0 && <div aria-hidden="true" style={{ height: virtual.trailing }} />}
      {menuState && menuNode && (
        <NodeMenu
          node={menuNode}
          x={menuState.x}
          y={menuState.y}
          onClose={closeMenu}
          onPatch={patchFromMenu}
          onRemove={() => {
            props.onRemove(menuState.nodeId);
            closeMenu();
          }}
          onCopyLink={() => {
            props.onCopyLink(menuState.nodeId);
            closeMenu();
          }}
          onExport={() => {
            props.onExportNode(menuState.nodeId);
            closeMenu();
          }}
        />
      )}
    </div>
  );
});

interface NodeMenuProps {
  node: OutlineNode;
  x: number;
  y: number;
  onClose: () => void;
  onPatch: (patch: Partial<OutlineNode>) => void;
  onRemove: () => void;
  onCopyLink: () => void;
  onExport: () => void;
}

function useViewportMenuPosition(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      const menu = ref.current;
      if (!menu) return;
      menu.style.left = `${Math.max(12, Math.min(x, window.innerWidth - menu.offsetWidth - 12))}px`;
      menu.style.top = `${Math.max(12, Math.min(y, window.innerHeight - menu.offsetHeight - 12))}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [x, y]);
  return ref;
}

function NodeMenu({
  node,
  x,
  y,
  onClose,
  onPatch,
  onRemove,
  onCopyLink,
  onExport,
}: NodeMenuProps) {
  const menuRef = useViewportMenuPosition(x, y);
  const selectedWords = Array.from(node.text.trim()).length;
  const attachmentActions = useAttachmentActions();
  const nextIcon = node.icon ? undefined : "★";
  const nextTable = node.table
    ? undefined
    : [
        ["字段", "内容"],
        ["待补充", "待补充"],
      ];

  return (
    <div
      ref={menuRef}
      className="node-menu"
      style={{ left: x, top: y } as React.CSSProperties}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="node-menu-format">
        <button
          className={node.headingLevel === 1 ? "selected" : ""}
          title="一级标题"
          onClick={() => onPatch({ headingLevel: 1 })}
        >
          <Heading1 size={23} />
        </button>
        <button
          className={node.headingLevel === 2 ? "selected" : ""}
          title="二级标题"
          onClick={() => onPatch({ headingLevel: 2 })}
        >
          <Heading2 size={23} />
        </button>
        <button
          className={node.headingLevel === 3 ? "selected" : ""}
          title="三级标题"
          onClick={() => onPatch({ headingLevel: 3 })}
        >
          <Heading3 size={23} />
        </button>
        <button
          className={!node.headingLevel ? "selected" : ""}
          title="正文"
          onClick={() => onPatch({ headingLevel: 0 })}
        >
          <Type size={23} />
        </button>
        <button
          className={node.bold ? "selected" : ""}
          title="加粗"
          onClick={() => onPatch({ bold: !node.bold })}
        >
          <Bold size={23} />
        </button>
        <button
          className={node.italic ? "selected" : ""}
          title="斜体"
          onClick={() => onPatch({ italic: !node.italic })}
        >
          <Italic size={23} />
        </button>
        <button
          className={node.underline ? "selected" : ""}
          title="下划线"
          onClick={() => onPatch({ underline: !node.underline })}
        >
          <Underline size={23} />
        </button>
        <button
          className={node.strike ? "selected" : ""}
          title="删除线"
          onClick={() => onPatch({ strike: !node.strike })}
        >
          <Strikethrough size={23} />
        </button>
      </div>

      <div className="node-menu-section">
        <div className="node-menu-row has-submenu">
          <Palette size={19} />
          <span>字体颜色</span>
          <div className="node-menu-swatches">
            {nodeMenuColors.map((color) => (
              <button
                key={color.value}
                title={color.label}
                className={node.color === color.value ? "selected" : ""}
                style={{ "--swatch": color.swatch } as React.CSSProperties}
                onClick={() => onPatch({ color: color.value })}
              />
            ))}
          </div>
        </div>
        <button className="node-menu-row" onClick={() => onPatch({ highlight: !node.highlight })}>
          <Highlighter size={19} />
          <span>{node.highlight ? "取消荧光笔" : "荧光笔"}</span>
        </button>
        <button
          className="node-menu-row"
          onClick={() => {
            onPatch({ note: node.note || "补充描述" });
          }}
        >
          <ListTree size={19} />
          <span>编辑描述</span>
        </button>
        <button
          className="node-menu-row"
          disabled={!node.imageName && (!attachmentActions?.available || attachmentActions.busy)}
          onClick={() => node.imageName ? onPatch({ imageName: undefined, imageAlt: undefined }) : attachmentActions?.add(node.id)}
        >
          <Image size={19} />
          <span>{node.imageName ? "移除旧图片引用" : "添加图片或文件"}</span>
        </button>
        <button className="node-menu-row" onClick={() => onPatch({ isTodo: !node.isTodo })}>
          <CheckCircle2 size={19} />
          <span>{node.isTodo ? "转化为普通文本" : "转化为待办任务"}</span>
        </button>
        <button className="node-menu-row" onClick={() => onPatch({ icon: nextIcon })}>
          <Smile size={19} />
          <span>{node.icon ? "移除图标" : "添加图标"}</span>
        </button>
        <button className="node-menu-row" onClick={() => onPatch({ table: nextTable })}>
          <Table size={19} />
          <span>{node.table ? "移除表格" : "添加表格"}</span>
        </button>
        <button className="node-menu-row" onClick={onCopyLink}>
          <Copy size={19} />
          <span>复制主题链接</span>
        </button>
        <button className="node-menu-row" onClick={onExport}>
          <FileDown size={19} />
          <span>导出为</span>
        </button>
        <button className="node-menu-row danger" onClick={onRemove}>
          <Trash2 size={19} />
          <span>删除</span>
        </button>
      </div>

      <div className="node-menu-footer">
        <span>主题字符数：{selectedWords}</span>
      </div>

      <button className="node-menu-close" onClick={onClose} title="关闭">
        <X size={14} />
      </button>
    </div>
  );
}

interface MindMapProps {
  title: string;
  nodes: OutlineNode[];
  rootTargetId: string | null;
  viewportResetKey: string;
  activeNodeId: string | null;
  locatedNodeId?: string | null;
  locationVersion?: number;
  onSelect: (id: string) => void;
  onTitle: (title: string) => void;
  onText: (id: string, text: string) => void;
  onPatch: (id: string, patch: Partial<OutlineNode>) => void;
  onInsertAfter: (id: string) => void;
  onInsertChild: (id: string) => void;
  onInsertParent: (id: string) => void;
  onCopyNode: (id: string) => void;
  onCutNode: (id: string) => void;
  onPasteNode: (id: string) => void;
  canPaste: boolean;
  onDuplicateNode: (id: string) => void;
  onRemove: (id: string) => void;
  onToggleSiblingCollapse: (id: string) => void;
  onFocusNode: (id: string) => void;
  onAiAction: (action: AiNodeAction, targetId: StructuredAiTargetId) => void;
  isAiBusy: (id: StructuredAiTargetId) => boolean;
  relations?: Array<{ id: string; fromNodeId: string; toNodeId: string; label: string }>;
  showRelations?: boolean;
  onToggleRelations?: () => void;
}

interface MindMapItem {
  node: OutlineNode;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  parentId: string | null;
  lines: string[];
}

interface MindMapNodeProps {
  item: MindMapItem;
  active: boolean;
  draft: string | null;
  actionTargetId: string;
  suppressClickRef: React.MutableRefObject<boolean>;
  onSelect: MindMapProps["onSelect"];
  onEdit: (id: string, text: string) => void;
  onContextMenu: (menu: { nodeId: string; x: number; y: number }) => void;
  onDraft: (text: string) => void;
  onText: MindMapProps["onText"];
  onEditingNodeChange: (id: string | null) => void;
  onAiAction: MindMapProps["onAiAction"];
  aiBusy: boolean;
  onInsertChild: MindMapProps["onInsertChild"];
}

const MindMapNode = React.memo(function MindMapNode({
  item, active, draft, actionTargetId, suppressClickRef, onSelect, onEdit,
  onContextMenu, onDraft, onText, onEditingNodeChange, onAiAction, aiBusy, onInsertChild,
}: MindMapNodeProps) {
  const isRoot = item.node.id === MINDMAP_ROOT_ID;
  return (
    <foreignObject
      data-node-id={item.node.id}
      className="map-node-object"
      x={item.x}
      y={item.y}
      width={item.width}
      height={item.height}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        if (suppressClickRef.current) {
          event.stopPropagation();
          return;
        }
        if (!isRoot) onSelect(item.node.id);
        onEdit(item.node.id, item.node.text);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!isRoot) onSelect(item.node.id);
        onContextMenu({
          nodeId: item.node.id,
          x: event.clientX,
          y: event.clientY,
        });
      }}
    >
      <div
        className={classNames(
          "map-node",
          active && "active",
          draft !== null && "editing",
          `depth-${item.depth}`,
          `node-${normalizeColor(item.node.color)}`,
          `heading-${item.node.headingLevel ?? 0}`,
          item.node.highlight && "is-highlighted",
          item.node.bold && "is-bold",
          item.node.italic && "is-italic",
          item.node.underline && "is-underline",
          item.node.strike && "is-strike",
        )}
      >
        {draft !== null ? (
          <div className="map-node-edit-wrap">
            <textarea
              autoFocus
              value={draft}
              placeholder="输入文字"
              onChange={(event) => onDraft(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  onText(item.node.id, draft);
                  onEditingNodeChange(null);
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  onEditingNodeChange(null);
                }
              }}
              onBlur={() => {
                onText(item.node.id, draft);
                onEditingNodeChange(null);
              }}
            />
            <AiInlineMenu
              busy={aiBusy}
              onAction={(action) =>
                onAiAction(action, actionTargetId)
              }
            />
            <button
              className="map-node-add"
              title="新增下级主题"
              onClick={(event) => {
                event.stopPropagation();
                onInsertChild(actionTargetId);
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Plus size={18} />
            </button>
          </div>
        ) : (
          <span className="map-node-lines">
            {item.lines.map((line, index) => (
              <span key={`${item.node.id}-${index}`}>{line}</span>
            ))}
          </span>
        )}
        <AttachmentItems node={item.node} compact />
      </div>
    </foreignObject>
  );
});

function MindMap({
  title,
  nodes,
  rootTargetId,
  viewportResetKey,
  activeNodeId,
  locatedNodeId = null,
  locationVersion = 0,
  onSelect,
  onTitle,
  onText,
  onPatch,
  onInsertAfter,
  onInsertChild,
  onInsertParent,
  onCopyNode,
  onCutNode,
  onPasteNode,
  canPaste,
  onDuplicateNode,
  onRemove,
  onToggleSiblingCollapse,
  onFocusNode,
  onAiAction,
  isAiBusy,
  relations = [],
  showRelations = false,
  onToggleRelations,
}: MindMapProps) {
  const [selectedRelationsOnly, setSelectedRelationsOnly] = useState(false);
  const mapRootId = MINDMAP_ROOT_ID;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const lastLocationRef = useRef(0);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [viewport, setViewport] = useState({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    nodeId: string;
    x: number;
    y: number;
  } | null>(null);
  const mapNodes = useMemo<OutlineNode[]>(
    () => [
      {
        id: mapRootId,
        text: title,
        note: "",
        checked: false,
        collapsed: false,
        color: "plain",
        children: nodes,
      },
    ],
    [nodes, title],
  );
  const layout = useMemo(() => createMindMapLayout(mapNodes), [mapNodes]);
  const visibleRelations = useMemo(() => {
    const ids = new Set(layout.items.map((item) => item.node.id));
    return relations.filter((edge) => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId) && (!selectedRelationsOnly || edge.fromNodeId === activeNodeId || edge.toNodeId === activeNodeId));
  }, [layout, relations, selectedRelationsOnly, activeNodeId]);
  const renderedItems = useMemo(() => {
    if (!editingNodeId) return layout.items;
    const editingItems = layout.items.filter((item) => item.node.id === editingNodeId);
    if (editingItems.length === 0) return layout.items;
    return [
      ...layout.items.filter((item) => item.node.id !== editingNodeId),
      ...editingItems,
    ];
  }, [editingNodeId, layout.items]);
  const renderedActiveNodeId = rootTargetId && activeNodeId === rootTargetId ? mapRootId : activeNodeId;
  const contextItem = contextMenu
    ? layout.items.find((item) => item.node.id === contextMenu.nodeId) ?? null
    : null;

  const centeredViewport = () => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return { scale: 1, x: 0, y: 0 };
    const root = layout.items.find((item) => item.node.id === mapRootId);
    if (root) {
      const { scale } = centerMindMapItem(rect, root, 1);
      return {
        scale,
        x: clampNumber((rect.width - layout.width * scale) / 2, 24 - root.x * scale, rect.width - 24 - (root.x + root.width) * scale),
        y: clampNumber((rect.height - layout.height * scale) / 2, 24 - root.y * scale, rect.height - 24 - (root.y + root.height) * scale),
      };
    }
    return {
      scale: 1,
      x: Math.max(32, (rect.width - layout.width) / 2),
      y: Math.max(80, (rect.height - layout.height) / 2),
    };
  };

  useEffect(() => {
    setViewport(centeredViewport());
  }, [viewportResetKey]);

  useEffect(() => {
    if (!locationVersion || lastLocationRef.current === locationVersion) return;
    if (locatedNodeId && locatedNodeId !== activeNodeId && locatedNodeId !== rootTargetId) return;
    const id = !locatedNodeId || locatedNodeId === rootTargetId ? mapRootId : locatedNodeId;
    const item = layout.items.find((item) => item.node.id === id);
    const element = viewportRef.current;
    if (!item || !element) return;
    lastLocationRef.current = locationVersion;
    element.closest(".editor-pane")?.scrollTo({ top: 0 });
    const bounds = element.getBoundingClientRect();
    setViewport((current) => centerMindMapItem(bounds, item, current.scale));
    if (locatedNodeId) element.focus({ preventScroll: true });
  }, [locationVersion, locatedNodeId, layout, activeNodeId, rootTargetId]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      const factor = event.deltaY > 0 ? 0.9 : 1.1;
      const anchorX = event.clientX - rect.left;
      const anchorY = event.clientY - rect.top;
      setViewport((current) => {
        const scale = clampNumber(current.scale * factor, 0.35, 2.5);
        const contentX = (anchorX - current.x) / current.scale;
        const contentY = (anchorY - current.y) / current.scale;
        return {
          scale,
          x: anchorX - contentX * scale,
          y: anchorY - contentY * scale,
        };
      });
    };

    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const handleCloseClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".mindmap-context-menu")) {
        return;
      }
      setContextMenu(null);
    };
    const handleCloseKey = () => setContextMenu(null);
    const handleResize = () => setContextMenu(null);

    window.addEventListener("click", handleCloseClick);
    window.addEventListener("keydown", handleCloseKey);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("click", handleCloseClick);
      window.removeEventListener("keydown", handleCloseKey);
      window.removeEventListener("resize", handleResize);
    };
  }, [contextMenu]);

  const zoomBy = (factor: number) => {
    setViewport((current) => {
      const rect = viewportRef.current?.getBoundingClientRect();
      const anchorX = rect ? rect.width / 2 : 0;
      const anchorY = rect ? rect.height / 2 : 0;
      const scale = clampNumber(current.scale * factor, 0.35, 2.5);
      const contentX = (anchorX - current.x) / current.scale;
      const contentY = (anchorY - current.y) / current.scale;
      return {
        scale,
        x: anchorX - contentX * scale,
        y: anchorY - contentY * scale,
      };
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest("button, input, textarea, select, a, [contenteditable=true]")) return;
    if (editingNodeId) return;
    if (!renderedActiveNodeId) return;

    const currentItem = layout.items.find((item) => item.node.id === renderedActiveNodeId);
    if (!currentItem) return;

    if (event.key === "ArrowUp") {
      event.preventDefault();
      const sameDepth = layout.items.filter(
        (item) => item.depth === currentItem.depth && item.node.id !== renderedActiveNodeId
      );
      const above = sameDepth
        .filter((item) => item.y < currentItem.y)
        .sort((a, b) => b.y - a.y)[0];
      if (above) {
        selectMapNode(above.node.id);
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      const sameDepth = layout.items.filter(
        (item) => item.depth === currentItem.depth && item.node.id !== renderedActiveNodeId
      );
      const below = sameDepth
        .filter((item) => item.y > currentItem.y)
        .sort((a, b) => a.y - b.y)[0];
      if (below) {
        selectMapNode(below.node.id);
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (currentItem.parentId) {
        selectMapNode(currentItem.parentId);
      }
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (!currentItem.node.collapsed && currentItem.node.children.length > 0) {
        selectMapNode(currentItem.node.children[0].id);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) {
        if (event.shiftKey) { if (!isRootNode(renderedActiveNodeId)) onInsertParent(renderedActiveNodeId); }
        else onInsertChild(isRootNode(renderedActiveNodeId) ? rootTargetId ?? renderedActiveNodeId : renderedActiveNodeId);
      } else if (!isRootNode(renderedActiveNodeId)) onInsertAfter(renderedActiveNodeId);
      else onInsertChild(rootTargetId ?? renderedActiveNodeId);
    } else if (event.key === "Spacebar" || event.key === " ") {
      event.preventDefault();
      setEditingNodeId(renderedActiveNodeId);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      if (!isRootNode(renderedActiveNodeId)) {
        onRemove(renderedActiveNodeId);
      }
    }
  };

  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".mindmap-context-menu")) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewport.x,
      originY: viewport.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const pan = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    setViewport((current) => ({
      ...current,
      x: drag.originX + dx,
      y: drag.originY + dy,
    }));
  };

  const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  };

  const isRootNode = (id: string) => id === mapRootId;
  const rootActionTargetId = () => rootTargetId ?? mapRootId;
  const selectMapNode = (id: string) => {
    if (isRootNode(id)) {
      if (rootTargetId) onSelect(rootTargetId);
      return;
    }
    onSelect(id);
  };
  const editMapNode = useCallback((id: string, text: string) => {
    setEditingDraft(text);
    setEditingNodeId(id);
  }, []);
  const setMapNodeText = useCallback((id: string, text: string) => {
    const cleanText = text.replace(/\r?\n/g, " ");
    if (id === mapRootId) {
      if (rootTargetId) {
        onText(rootTargetId, cleanText || "未命名主题");
      } else {
        onTitle(cleanText || "未命名文档");
      }
      return;
    }
    onText(id, cleanText);
  }, [rootTargetId, onText, onTitle]);

  const copyMapNode = async (item: MindMapItem) => {
    try {
      await navigator.clipboard.writeText(item.node.text || title);
    } catch {
      // Clipboard may be unavailable in some browser contexts; the menu still closes.
    }
  };

  const renderedEdges = useMemo(() => layout.edges.map((edge) => (
    <path
      key={`${edge.from.node.id}-${edge.to.node.id}`}
      className={classNames("mindmap-edge", `edge-${normalizeColor(edge.to.node.color)}`)}
      d={`M ${edge.from.x + edge.from.width} ${edge.from.y + edge.from.height / 2} C ${
        edge.from.x + edge.from.width + 52
      } ${edge.from.y + edge.from.height / 2}, ${edge.to.x - 52} ${
        edge.to.y + edge.to.height / 2
      }, ${edge.to.x} ${edge.to.y + edge.to.height / 2}`}
    />
  )), [layout.edges]);

  return (
    <div
      ref={viewportRef}
      tabIndex={0}
      className={classNames("mindmap-scroll", dragging && "dragging")}
      onPointerDown={startPan}
      onPointerMove={pan}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onKeyDown={handleKeyDown}
    >
      <div className="mindmap-controls" onPointerDown={(event) => event.stopPropagation()}>
        <button onClick={() => zoomBy(1.18)} title="放大">
          <ZoomIn size={16} />
        </button>
        <span className="mindmap-zoom-label">{Math.round(viewport.scale * 100)}%</span>
        <button onClick={() => zoomBy(0.85)} title="缩小">
          <ZoomOut size={16} />
        </button>
        <button
          onClick={() => setViewport(centeredViewport())}
          title="复位视图"
        >
          <RotateCcw size={16} />
        </button>
        <button type="button" className={classNames("map-text-control", showRelations && "selected")} onClick={onToggleRelations} title="显示关系线">关系</button>
        {showRelations && <><button type="button" className={classNames("map-text-control", selectedRelationsOnly && "selected")} onClick={() => setSelectedRelationsOnly((value) => !value)}>仅选中主题</button>
          <span className="relation-count" role="status">共 {relations.length} 条，显示 {Math.min(200, visibleRelations.length)} 条，隐藏 {relations.length - visibleRelations.length} 条{visibleRelations.length > 200 ? `，另有 ${visibleRelations.length - 200} 条超过绘制上限，请筛选` : ""}</span></>}
      </div>

      <div
        className="mindmap-stage"
        style={{
          width: layout.width,
          height: layout.height,
          transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.scale})`,
        }}
      >
        {useMemo(() => (<svg
          className="mindmap"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label={`${title} 思维导图`}
        >
          {showRelations && visibleRelations.slice(0, 200).map((relation) => {
            const from = layout.items.find((item) => item.node.id === relation.fromNodeId);
            const to = layout.items.find((item) => item.node.id === relation.toNodeId);
            if (!from || !to) return null;
            const x1 = from.x + from.width / 2;
            const y1 = from.y + from.height;
            const x2 = to.x + to.width / 2;
            const y2 = to.y;
            return (
              <g key={relation.id} className="mindmap-relation-group">
                <path className="mindmap-relation" d={`M ${x1} ${y1} C ${x1} ${y1 + 36}, ${x2} ${y2 - 36}, ${x2} ${y2}`} markerEnd="url(#relation-arrow)" />
                <text className="mindmap-relation-label" x={(x1 + x2) / 2} y={(y1 + y2) / 2}>{relation.label}</text>
              </g>
            );
          })}
          <defs>
            <marker id="relation-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6" fill="currentColor" />
            </marker>
          </defs>
          {renderedEdges}
          {renderedItems.map((item) => (
            <MindMapNode
              key={item.node.id}
              item={item}
              active={renderedActiveNodeId === item.node.id}
              draft={editingNodeId === item.node.id ? editingDraft : null}
              actionTargetId={isRootNode(item.node.id) ? rootActionTargetId() : item.node.id}
              suppressClickRef={suppressClickRef}
              onSelect={onSelect}
              onEdit={editMapNode}
              onContextMenu={setContextMenu}
              onDraft={setEditingDraft}
              onText={setMapNodeText}
              onEditingNodeChange={setEditingNodeId}
              onAiAction={onAiAction}
              aiBusy={editingNodeId === item.node.id && isAiBusy(isRootNode(item.node.id) ? rootActionTargetId() : item.node.id)}
              onInsertChild={onInsertChild}
            />
          ))}
        </svg>), [layout, title, showRelations, visibleRelations, renderedItems, renderedActiveNodeId,
          editingNodeId, editingDraft, onSelect, onInsertChild, onAiAction, isAiBusy, rootTargetId, onText, onTitle])}
      </div>
      {contextMenu && contextItem && (
        <MindMapContextMenu
          item={contextItem}
          x={contextMenu.x}
          y={contextMenu.y}
          isRoot={isRootNode(contextItem.node.id)}
          onClose={() => setContextMenu(null)}
          onInsertAfter={() => {
            if (!isRootNode(contextItem.node.id)) onInsertAfter(contextItem.node.id);
            setContextMenu(null);
          }}
          onInsertChild={() => {
            onInsertChild(isRootNode(contextItem.node.id) ? rootActionTargetId() : contextItem.node.id);
            setContextMenu(null);
          }}
          onInsertParent={() => {
            if (!isRootNode(contextItem.node.id)) onInsertParent(contextItem.node.id);
            setContextMenu(null);
          }}
          onCopy={() => {
            if (isRootNode(contextItem.node.id)) {
              void copyMapNode(contextItem);
            } else {
              void onCopyNode(contextItem.node.id);
            }
            setContextMenu(null);
          }}
          onCut={() => {
            if (!isRootNode(contextItem.node.id)) onCutNode(contextItem.node.id);
            setContextMenu(null);
          }}
          onPaste={() => {
            onPasteNode(isRootNode(contextItem.node.id) ? rootActionTargetId() : contextItem.node.id);
            setContextMenu(null);
          }}
          canPaste={canPaste}
          onDuplicate={() => {
            if (!isRootNode(contextItem.node.id)) {
              onDuplicateNode(contextItem.node.id);
            }
            setContextMenu(null);
          }}
          onDelete={() => {
            if (!isRootNode(contextItem.node.id)) onRemove(contextItem.node.id);
            setContextMenu(null);
          }}
          onToggleCollapse={() => {
            if (!isRootNode(contextItem.node.id)) {
              onPatch(contextItem.node.id, { collapsed: !contextItem.node.collapsed });
            }
            setContextMenu(null);
          }}
          onToggleSiblingCollapse={() => {
            if (!isRootNode(contextItem.node.id)) {
              onToggleSiblingCollapse(contextItem.node.id);
            }
            setContextMenu(null);
          }}
          onEnterTopic={() => {
            if (!isRootNode(contextItem.node.id)) onFocusNode(contextItem.node.id);
            setContextMenu(null);
          }}
        />
      )}
    </div>
  );
}

interface MindMapContextMenuProps {
  item: MindMapItem;
  x: number;
  y: number;
  isRoot: boolean;
  onClose: () => void;
  onInsertAfter: () => void;
  onInsertChild: () => void;
  onInsertParent: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  canPaste: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
  onToggleCollapse: () => void;
  onToggleSiblingCollapse: () => void;
  onEnterTopic: () => void;
}

function MindMapContextMenu({
  item,
  x,
  y,
  isRoot,
  onInsertAfter,
  onInsertChild,
  onInsertParent,
  onCopy,
  onCut,
  onPaste,
  canPaste,
  onDuplicate,
  onDelete,
  onToggleCollapse,
  onToggleSiblingCollapse,
  onEnterTopic,
}: MindMapContextMenuProps) {
  const menuRef = useViewportMenuPosition(x, y);
  const hasChildren = item.node.children.length > 0;
  return (
    <div
      ref={menuRef}
      className="mindmap-context-menu"
      style={{ left: x, top: y } as React.CSSProperties}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button disabled={isRoot} onClick={onInsertAfter}>
        <span>插入同级主题</span>
        <kbd>Enter</kbd>
      </button>
      <button onClick={onInsertChild}>
        <span>插入下级主题</span>
        <kbd>⌘ + Enter</kbd>
      </button>
      <button disabled={isRoot} onClick={onInsertParent}>
        <span>插入上级主题</span>
        <kbd>⌘ + ⇧ + Enter</kbd>
      </button>

      <hr />

      <button onClick={onCopy}>
        <span>复制</span>
        <kbd>⌘ + C</kbd>
      </button>
      <button disabled={isRoot} onClick={onCut}>
        <span>剪切</span>
        <kbd>⌘ + X</kbd>
      </button>
      <button disabled={!canPaste} onClick={onPaste}>
        <span>粘贴</span>
        <kbd>⌘ + V</kbd>
      </button>
      <button disabled={isRoot} onClick={onDuplicate}>
        <span>创建副本</span>
        <kbd>⌘ + D</kbd>
      </button>
      <button className="danger" disabled={isRoot} onClick={onDelete}>
        <span>删除</span>
        <kbd>Delete</kbd>
      </button>

      <hr />

      <button disabled={isRoot || !hasChildren} onClick={onToggleCollapse}>
        <span>{item.node.collapsed ? "展开下级主题" : "折叠下级主题"}</span>
        <kbd>⌘ + .</kbd>
      </button>
      <button disabled={isRoot} onClick={onToggleSiblingCollapse}>
        <span>展开/折叠同级主题</span>
        <kbd>⌘ + ⇧ + .</kbd>
      </button>
      <button disabled={isRoot} onClick={onEnterTopic}>
        <span>进入此主题</span>
        <kbd>⌘ + ]</kbd>
      </button>
    </div>
  );
}

const splitMindMapLines = (value: string, maxChars = 30) => {
  const text = value.trim() || "输入文字";
  const chars = Array.from(text);
  const lines: string[] = [];
  for (let index = 0; index < chars.length; index += maxChars) {
    lines.push(chars.slice(index, index + maxChars).join(""));
  }
  return lines.length ? lines : ["输入文字"];
};

const mindMapMetrics = (node: OutlineNode, depth: number) => {
  const lines = splitMindMapLines(
    `${node.icon ? `${node.icon} ` : ""}${node.text || "输入文字"}`,
    depth === 0 ? 24 : 30,
  );
  const width = depth === 0 ? 300 : 360;
  const minHeight = depth === 0 ? 58 : 52;
  const height = Math.max(minHeight, lines.length * 19 + 22) + (node.attachmentRefs?.length ? 132 : 0);
  return { lines, width, height };
};

function createMindMapLayout(nodes: OutlineNode[]) {
  const items: MindMapItem[] = [];
  const xGap = 390;
  const yGap = 34;
  const pad = 48;
  let cursor = 0;
  let maxDepth = 0;

  const centers = new Map<string, number>();
  const stack: Array<{ node: OutlineNode; depth: number; parentId: string | null; finish: boolean }> =
    nodes.map((node) => ({ node, depth: 0, parentId: null, finish: false })).reverse();
  while (stack.length) {
    const frame = stack.pop()!;
    const { node, depth, parentId } = frame;
    const children = node.collapsed ? [] : node.children;
    if (!frame.finish && children.length) {
      stack.push({ ...frame, finish: true });
      for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], depth: depth + 1, parentId: node.id, finish: false });
      continue;
    }
    maxDepth = Math.max(maxDepth, depth);
    const metrics = mindMapMetrics(node, depth);
    let y = pad + cursor;
    if (!children.length) cursor += metrics.height + yGap;
    else {
      let minimum = Infinity, maximum = -Infinity;
      for (const child of children) { const center = centers.get(child.id)!; minimum = Math.min(minimum, center); maximum = Math.max(maximum, center); }
      y = (minimum + maximum) / 2 - metrics.height / 2;
    }
    items.push({
      node,
      x: pad + depth * xGap,
      y,
      depth,
      parentId,
      lines: metrics.lines,
      width: metrics.width,
      height: metrics.height,
    });
    centers.set(node.id, y + metrics.height / 2);
  }
  const itemMap = new Map(items.map((item) => [item.node.id, item]));
  const maxRight = items.reduce((right, item) => Math.max(right, item.x + item.width), 0);
  const maxBottom = items.reduce((bottom, item) => Math.max(bottom, item.y + item.height), 0);
  return {
    items,
    edges: items
      .filter((item) => item.parentId)
      .map((item) => ({ from: itemMap.get(item.parentId!)!, to: item })),
    width: Math.max(760, maxRight + pad + maxDepth * 12),
    height: Math.max(420, maxBottom + pad),
  };
}

interface PresentationViewProps {
  title: string;
  nodes: OutlineNode[];
  onSelect: (id: string) => void;
}

function PresentationView({ title, nodes, onSelect }: PresentationViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const playTimerRef = useRef<number | null>(null);

  const slides = useMemo(() => {
    const list: Array<{ title: string; subtitle?: string; note?: string; points: OutlineNode[]; node?: OutlineNode }> = [];
    
    // Slide 0: Cover
    list.push({
      title,
      subtitle: "演示文稿",
      points: [],
    });

    // Top level nodes are slides
    nodes.forEach((node) => {
      list.push({
        title: node.text || "未命名主题",
        node,
        note: node.note,
        points: node.children,
      });
    });

    return list;
  }, [nodes, title]);

  useEffect(() => {
    if (currentSlide >= slides.length) {
      setCurrentSlide(0);
    }
  }, [slides.length, currentSlide]);

  const nextSlide = () => {
    setCurrentSlide((prev) => (prev < slides.length - 1 ? prev + 1 : 0));
  };

  const prevSlide = () => {
    setCurrentSlide((prev) => (prev > 0 ? prev - 1 : slides.length - 1));
  };

  // Keyboard navigation
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (isEditableEventTarget(e.target) || (e.target instanceof HTMLElement && e.target.closest("[role=dialog], button, a, select"))) return;
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        setCurrentSlide((prev) => (prev < slides.length - 1 ? prev + 1 : 0));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setCurrentSlide((prev) => (prev > 0 ? prev - 1 : slides.length - 1));
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [slides.length]);

  // Autoplay
  useEffect(() => {
    if (isPlaying) {
      playTimerRef.current = window.setInterval(() => {
        setCurrentSlide((prev) => (prev < slides.length - 1 ? prev + 1 : 0));
      }, 4000);
    } else {
      if (playTimerRef.current) {
        window.clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
    }
    return () => {
      if (playTimerRef.current) window.clearInterval(playTimerRef.current);
    };
  }, [isPlaying, slides.length]);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      void containerRef.current.requestFullscreen().catch((err) => {
        console.error("Error attempting to enable fullscreen:", err);
      });
    } else {
      void document.exitFullscreen();
    }
  };

  const activeSlide = slides[currentSlide] || slides[0];

  return (
    <div ref={containerRef} className="presentation-view">
      <div className="slide-deck">
        <div key={currentSlide} className="slide-card">
          {currentSlide === 0 ? (
            <div className="slide-cover">
              <div className="slide-subtitle">{activeSlide.subtitle}</div>
              <h1>{activeSlide.title}</h1>
              <div className="slide-stats">{nodes.length} 个主要章节</div>
            </div>
          ) : (
            <div className="slide-content">
              <h2 className="slide-title">{activeSlide.title}</h2>
              {activeSlide.node && <AttachmentItems node={activeSlide.node} />}
              {activeSlide.note && (
                <blockquote className="slide-note">
                  {activeSlide.note}
                </blockquote>
              )}
              <div className="slide-body">
                {activeSlide.points.map((point) => (
                  <div key={point.id} className="slide-point-container">
                    <div className="slide-point">
                      <span className="slide-point-bullet">•</span>
                      <span>{point.text || "未命名子项"}</span>
                    </div>
                    <AttachmentItems node={point} />
                    {point.children && point.children.length > 0 && (
                      <div className="slide-point-nested">
                        {point.children.map((subpoint) => (
                          <div key={subpoint.id} className="slide-point-nested-item">
                            <span className="slide-point-nested-bullet">-</span>
                            <span>{subpoint.text || "未命名孙项"}</span>
                            <AttachmentItems node={subpoint} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {activeSlide.points.length === 0 && (
                  <p className="empty-text">无详细内容</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="slide-controls">
        <button className="slide-btn" onClick={prevSlide} title="上一页">
          <ChevronLeft size={20} />
        </button>
        <div className="slide-indicator">
          {currentSlide + 1} / {slides.length}
        </div>
        <button className="slide-btn" onClick={nextSlide} title="下一页">
          <ChevronRight size={20} />
        </button>
        <button
          className="slide-btn"
          onClick={() => setIsPlaying(!isPlaying)}
          title={isPlaying ? "暂停自动播放" : "开启自动播放"}
        >
          {isPlaying ? <Pause size={20} /> : <Play size={20} />}
        </button>
        <button className="slide-btn" onClick={toggleFullscreen} title="全屏演示">
          <Maximize2 size={20} />
        </button>
      </div>
    </div>
  );
}

export default App;
