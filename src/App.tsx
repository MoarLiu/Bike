import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  Pause,
  Pencil,
  Play,
  Plus,
  Presentation,
  Quote,
  RefreshCw,
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
  saveAiConfig,
  validateAiConfig,
  type AiApiConfig,
  type AiGeneratedNode,
  type AiNodeAction,
} from "./ai";
import { saveICloudBackup } from "./backup";
import {
  downloadText,
  exportDocument,
  exportDocumentAsPdf,
  exportWorkspace,
  importDocument,
} from "./exporters";
import { documentToMarkdown, parseMarkdownDocument } from "./markdown";
import { firstDocument, migrateWorkspace } from "./migrations";
import { createStarterWorkspace } from "./sample";
import { loadWorkspace, saveWorkspace, saveWorkspaceFallback, type WorkspaceSaveResult } from "./storage";
import type { OutlineDocument, OutlineNode, ViewMode, Workspace } from "./types";
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
  uid,
  updateNode,
} from "./tree";

type ExportFormat = "json" | "markdown" | "opml" | "freemind" | "html";
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

const classNames = (...names: Array<string | false | undefined>) =>
  names.filter(Boolean).join(" ");

const isEditableEventTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  Boolean(target.closest("input, textarea, [contenteditable]"));

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

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

const getDocumentMarkdown = (document: MarkdownDocument) =>
  document.markdownSource ?? documentToMarkdown(document);

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

const markdownLineInfos = (source: string) => {
  const lines = source.split("\n");
  let offset = 0;
  return lines.map((line) => {
    const info = {
      line,
      start: offset,
      end: offset + line.length,
    };
    offset += line.length + 1;
    return info;
  });
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
  delete next.markdownSource;
  delete next.markdownUpdatedAt;
  return next;
};

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

const firstNodeIdInWorkspace = (workspace: Workspace) =>
  firstNodeId(firstDocument(workspace).nodes);

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
}: {
  nodeId: string;
  note: string;
  onPatch: (id: string, patch: Partial<OutlineNode>) => void;
  onDraftChange: (id: string, value: string, baseNote: string) => void;
  onCommit: (id: string, value: string) => void;
}) {
  const [draft, setDraft] = useState(note);
  const latestRef = useRef({ nodeId, note, draft, onPatch, onCommit });
  const focusedRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);

  useEffect(() => {
    latestRef.current = { nodeId, note, draft, onPatch, onCommit };
  }, [draft, nodeId, note, onPatch, onCommit]);

  useEffect(() => {
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
      latest.onCommit(latest.nodeId, latest.draft);
      latestRef.current = { ...latest, note: latest.draft };
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
    <textarea
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<AppViewMode>("outline");
  const [markdownPaneMode, setMarkdownPaneMode] = useState<MarkdownPaneMode>("split");
  const [markdownDraft, setMarkdownDraft] = useState("");
  const [search, setSearch] = useState("");
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [nodeClipboard, setNodeClipboard] = useState<NodeClipboard | null>(null);
  const [notice, setNotice] = useState("本地自动保存已开启");
  const [noticeKey, setNoticeKey] = useState(0);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [sidebarView, setSidebarView] = useState<"all" | "recent">("all");
  const [recentTicker, setRecentTicker] = useState(0);
  const [aiConfig, setAiConfig] = useState<AiApiConfig>(() => loadAiConfig());
  const [showAiConfig, setShowAiConfig] = useState(false);
  const [aiBusyKey, setAiBusyKey] = useState<string | null>(null);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const workspaceRef = useRef<Workspace | null>(null);
  const modeRef = useRef<AppViewMode>("outline");
  const activeNodeIdRef = useRef<string | null>(null);
  const markdownDraftRef = useRef<MarkdownDraft>({ documentId: null, value: "", dirty: false });
  const inspectorNoteDraftRef = useRef<InspectorNoteDraft | null>(null);
  const markdownParseTimerRef = useRef<number | null>(null);
  const flushPendingEditsRef = useRef<() => Workspace | null>(() => null);

  const [theme, setTheme] = useState<"light" | "dark">(
    () => (localStorage.getItem("theme") as "light" | "dark") || "light"
  );
  const [pendingCaretFocus, setPendingCaretFocus] = useState<{ id: string; position: number } | null>(null);

  const showNotice = useEventCallback((message: string) => {
    setNotice(message);
    setNoticeKey((k) => k + 1);
  });

  const showSaveResult = useEventCallback((result: WorkspaceSaveResult) => {
    if (!result.ok) {
      showNotice(`保存失败：${result.error.message}`);
      return;
    }
    if (result.target === "localstorage") {
      showNotice("IndexedDB 不可用，已临时保存到浏览器备用存储");
    }
  });

  const replaceWorkspace = useEventCallback((next: Workspace) => {
    workspaceRef.current = next;
    setWorkspace(next);
    return next;
  });

  const initializeWorkspace = useEventCallback((isMounted: () => boolean = () => true) => {
    setLoadError(null);
    setReady(false);
    return loadWorkspace().then((result) => {
      if (!isMounted()) return;
      if (result.status === "error") {
        const message = `数据加载失败，已暂停自动保存：${result.error.message}`;
        setLoadError(message);
        showNotice(message);
        return;
      }
      const next = result.status === "loaded" ? result.workspace : createStarterWorkspace();
      replaceWorkspace(next);
      setActiveNodeId(firstNodeIdInWorkspace(next));
      setReady(true);
    }).catch((error) => {
      if (!isMounted()) return;
      const message = `数据加载失败，已暂停自动保存：${error instanceof Error ? error.message : String(error)}`;
      setLoadError(message);
      showNotice(message);
    });
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    workspaceRef.current = workspace;
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
    if (!workspace || !ready) return;
    const handle = window.setTimeout(() => {
      saveWorkspace(workspace).then(showSaveResult);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [workspace, ready]);

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

  const focusNode = useMemo(() => {
    if (!activeDocument || !focusNodeId) return null;
    return findNode(activeDocument.nodes, focusNodeId);
  }, [activeDocument, focusNodeId]);

  const visibleNodes = focusNode ? [focusNode] : activeDocument?.nodes ?? [];

  const tags = useMemo(() => {
    if (!activeDocument) return [];
    const tagSet = new Set<string>();
    flattenNodes(activeDocument.nodes).forEach((row) => {
      extractTags(row.node.text).forEach((tag) => tagSet.add(tag));
      extractTags(row.node.note).forEach((tag) => tagSet.add(tag));
    });
    return Array.from(tagSet).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [activeDocument]);

  const linkRows = useMemo(() => {
    if (!activeDocument) return [];
    return flattenNodes(activeDocument.nodes)
      .flatMap((row) =>
        extractLinks(row.node.text).map((link) => ({
          source: row.node.text || "未命名主题",
          link,
        })),
      )
      .slice(0, 12);
  }, [activeDocument]);

  const matchingDocuments = useMemo(() => {
    if (!workspace) return [];
    const query = search.trim().toLowerCase();
    const filtered = workspace.documents.filter((document) => {
      const matchesQuery = !query || collectDocumentText(document).includes(query);
      const matchesTag =
        !selectedTag ||
        flattenNodes(document.nodes).some((row) =>
          [...extractTags(row.node.text), ...extractTags(row.node.note)].includes(selectedTag),
        );
      return matchesQuery && matchesTag;
    });
    if (sidebarView === "recent") {
      return [...filtered]
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
        .slice(0, 12);
    }
    return filtered;
  }, [search, selectedTag, workspace, sidebarView, recentTicker]);

  const commitWorkspace = useEventCallback((updater: (workspace: Workspace) => Workspace) => {
    const current = workspaceRef.current;
    if (!current) return null;
    const next = updater(current);
    return next === current ? current : replaceWorkspace(next);
  });

  const patchActiveDocument = (
    updater: (document: MarkdownDocument) => MarkdownDocument,
    options: { preserveMarkdown?: boolean } = {},
  ) => {
    return commitWorkspace((current) => {
      let changed = false;
      const documents = current.documents.map((document) => {
        if (document.id !== current.activeDocumentId) return document;
        const before = document as MarkdownDocument;
        const updated = updater(before);
        if (updated === before) return document;
        changed = true;
        if (!options.preserveMarkdown && typeof before.markdownSource === "string") {
          showNotice("已切换为结构化编辑，原始 Markdown 将由当前大纲重新生成");
        }
        const stamped = { ...updated, updatedAt: now() };
        return options.preserveMarkdown ? stamped : clearDocumentMarkdown(stamped);
      });
      return changed ? { ...current, documents } : current;
    });
  };
  const patchActiveDocumentStable = useEventCallback(patchActiveDocument);

  const updateActiveNodes = (
    updater: (nodes: OutlineNode[], document: MarkdownDocument) => OutlineNode[],
  ) => {
    let nextNodes: OutlineNode[] | null = null;
    patchActiveDocumentStable((document) => {
      const nodes = updater(document.nodes, document);
      nextNodes = nodes;
      return nodes === document.nodes ? document : { ...document, nodes };
    });
    return nextNodes;
  };
  const updateActiveNodesStable = useEventCallback(updateActiveNodes);

  const setActiveNodes = useEventCallback((nodes: OutlineNode[]) =>
    patchActiveDocumentStable((document) =>
      nodes === document.nodes ? document : { ...document, nodes },
    ),
  );

  const parseMarkdownIntoDocument = (
    document: MarkdownDocument,
    content: string,
  ): MarkdownDocument => {
    const timestamp = now();
    const parsed = parseMarkdownDocument(content, {
      previousDocument: document,
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
      const nextWorkspace = commitWorkspace((current) => ({
        ...current,
        documents: current.documents.map((document) => {
          if (document.id !== draft.documentId) return document;
          nextDocument = parseMarkdownIntoDocument(document as MarkdownDocument, draft.value);
          return nextDocument;
        }),
      }));

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

  const flushFocusedStructuredInput = useEventCallback(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLTextAreaElement)) return workspaceRef.current;

    const entry = Array.from(inputRefs.current.entries()).find(([, input]) => input === element);
    if (!entry) return workspaceRef.current;

    const [nodeId] = entry;
    const current = workspaceRef.current;
    const active = current?.documents.find((item) => item.id === current.activeDocumentId);
    const node = active ? findNode(active.nodes, nodeId) : null;
    if (!current || !active || !node || node.text === element.value) return current;

    return commitWorkspace((workspace) => ({
      ...workspace,
      documents: workspace.documents.map((document) =>
        document.id === workspace.activeDocumentId
          ? clearDocumentMarkdown({
              ...(document as MarkdownDocument),
              updatedAt: now(),
              nodes: updateNode(document.nodes, nodeId, (target) => {
                target.text = element.value;
              }),
            })
          : document,
      ),
    }));
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
    if (!draft || draft.nodeId !== nodeId) return;
    inspectorNoteDraftRef.current = {
      nodeId,
      value,
      baseNote: value,
      dirty: false,
    };
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
              ...(document as MarkdownDocument),
              updatedAt: now(),
              nodes: updateNode(document.nodes, draft.nodeId, (target) => {
                target.note = draft.value;
              }),
            })
          : document,
      ),
    }));
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

  useEffect(() => {
    const handleSaveShortcut = async (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      event.stopPropagation();
      const nextWorkspace = flushPendingEditsRef.current() ?? workspaceRef.current;
      if (!nextWorkspace) return;
      const result = await saveWorkspace(nextWorkspace);
      if (result.ok) {
        showNotice(result.target === "indexeddb" ? "已保存到本地" : "IndexedDB 不可用，已临时保存到浏览器备用存储");
      } else {
        showNotice(`保存失败：${result.error.message}`);
      }
    };

    window.addEventListener("keydown", handleSaveShortcut, { capture: true });
    return () => window.removeEventListener("keydown", handleSaveShortcut, { capture: true });
  }, []);

  useEffect(() => {
    const flushAndPersistFallback = () => {
      const nextWorkspace = flushPendingEditsRef.current() ?? workspaceRef.current;
      if (nextWorkspace) saveWorkspaceFallback(nextWorkspace);
    };

    const preventFileDropNavigation = (event: DragEvent) => {
      event.preventDefault();
    };

    window.addEventListener("beforeunload", flushAndPersistFallback, { capture: true });
    window.addEventListener("pagehide", flushAndPersistFallback, { capture: true });
    window.addEventListener("dragover", preventFileDropNavigation);
    window.addEventListener("drop", preventFileDropNavigation);
    return () => {
      flushAndPersistFallback();
      window.removeEventListener("beforeunload", flushAndPersistFallback, { capture: true });
      window.removeEventListener("pagehide", flushAndPersistFallback, { capture: true });
      window.removeEventListener("dragover", preventFileDropNavigation);
      window.removeEventListener("drop", preventFileDropNavigation);
    };
  }, []);

  const selectDocument = useEventCallback((id: string) => {
    const currentWorkspace = flushPendingEdits() ?? workspaceRef.current;
    const document = currentWorkspace?.documents.find((item) => item.id === id);
    setFocusNodeId(null);
    setActiveNodeId(firstNodeId(document?.nodes ?? []));
    commitWorkspace((current) => ({ ...current, activeDocumentId: id }));
  });

  const createDocument = useEventCallback(() => {
    flushPendingEdits();
    const id = crypto.randomUUID();
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
    const id = crypto.randomUUID();
    const document = clearDocumentMarkdown({
      ...sourceDocument,
      id,
      title: `${sourceDocument.title} 副本`,
      createdAt: now(),
      updatedAt: now(),
      nodes: rekeyNodes(sourceDocument.nodes),
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
    const currentWorkspace = flushPendingEdits() ?? workspaceRef.current;
    const currentDocument = currentWorkspace?.documents.find(
      (document) => document.id === currentWorkspace.activeDocumentId,
    );
    if (!currentDocument || !currentWorkspace || currentWorkspace.documents.length === 1) {
      showNotice("至少保留一个文档");
      return;
    }
    const nextDocuments = currentWorkspace.documents.filter(
      (document) => document.id !== currentDocument.id,
    );
    const nextActive = nextDocuments[0];
    const deletedTitle = currentDocument.title;
    setActiveNodeId(firstNodeId(nextActive.nodes));
    setFocusNodeId(null);
    replaceWorkspace({
      ...currentWorkspace,
      activeDocumentId: nextActive.id,
      documents: nextDocuments,
    });
    showNotice(`已删除文档：${deletedTitle}`);
  });

  const handleNodeText = useEventCallback((id: string, text: string) => {
    updateActiveNodesStable((nodes) => updateNode(nodes, id, (node) => {
      node.text = text;
    }));
  });

  const handleNodePatch = useEventCallback((id: string, patch: Partial<OutlineNode>) => {
    updateActiveNodesStable((nodes) => updateNode(nodes, id, (node) => {
      Object.assign(node, patch);
      node.color = normalizeColor(node.color);
    }));
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
  ) => {
    const config = ensureAiConfig();
    if (!config) return null;
    return runAiNodeAction(config, action, context);
  });

  const handleStructuredAiAction = useEventCallback(async (
    action: AiNodeAction,
    targetId: StructuredAiTargetId,
  ) => {
    const currentWorkspace = flushPendingEdits() ?? workspaceRef.current;
    const document = currentWorkspace?.documents.find(
      (item) => item.id === currentWorkspace.activeDocumentId,
    ) as MarkdownDocument | undefined;
    if (!document) return;

    const isDocumentRoot = targetId === MINDMAP_ROOT_ID;
    const node = isDocumentRoot ? null : findNode(document.nodes, targetId);
    if (!isDocumentRoot && !node) return;

    const busyKey = `structured:${targetId}:${action}`;
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
      });
      if (!result) return;

      if (action === "polish") {
        const text = result.text?.trim();
        if (!text) throw new Error("AI 没有返回润色文本");
        if (isDocumentRoot) {
          updateTitle(text);
        } else {
          handleNodeText(targetId, text);
        }
        showNotice("已润色当前主题");
        return;
      }

      const generated = generatedNodesToOutlineNodes(result.children);
      if (!generated.length) throw new Error("AI 没有生成可用子主题");
      if (isDocumentRoot) {
        patchActiveDocumentStable((active) => ({
          ...active,
          nodes: [...active.nodes, ...generated],
        }));
      } else {
        updateActiveNodesStable((nodes) => updateNode(nodes, targetId, (target) => {
          target.collapsed = false;
          target.children = [...target.children, ...generated];
        }));
      }
      setActiveNodeId(generated[0].id);
      showNotice(`已生成 ${generated.length} 个子主题`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "AI 操作失败");
    } finally {
      setAiBusyKey((current) => (current === busyKey ? null : current));
    }
  });

  const handleMarkdownAiAction = useEventCallback(async (
    action: AiNodeAction,
    target: MarkdownAiTarget,
    source: string,
  ) => {
    if (!activeDocument) return null;
    const busyKey = `markdown:${action}`;
    setAiBusyKey(busyKey);
    showNotice(action === "generate" ? "AI 正在生成 Markdown 子主题..." : "AI 正在润色 Markdown 主题...");
    try {
      const result = await requestAiForTopic(action, {
        documentTitle: activeDocument.title,
        topicText: target.text,
        existingChildren: [],
      });
      if (!result) return null;

      if (action === "polish") {
        const text = result.text?.trim();
        if (!text) throw new Error("AI 没有返回润色文本");
        const next = replaceMarkdownTargetLine(source, target, text);
        const cursor =
          target.kind === "heading"
            ? target.lineStart + target.prefix.length + text.length
            : target.kind === "list"
              ? target.lineStart + target.indent.length + target.marker.length + text.length
              : target.lineStart + text.length;
        handleMarkdownDraftChange(next);
        showNotice("已润色当前 Markdown 主题");
        return { value: next, cursor };
      }

      if (!result.children?.length) throw new Error("AI 没有生成可用子主题");
      const next = insertMarkdownChildren(source, target, result.children);
      handleMarkdownDraftChange(next);
      showNotice("已生成 Markdown 子主题");
      return { value: next, cursor: target.subtreeEnd + Math.max(0, next.length - source.length) };
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "AI 操作失败");
      return null;
    } finally {
      setAiBusyKey((current) => (current === busyKey ? null : current));
    }
  });

  const handleSaveAiConfig = useEventCallback((config: AiApiConfig) => {
    const error = validateAiConfig(config);
    if (error) {
      showNotice(error);
      return false;
    }
    const saved = saveAiConfig(config);
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
    if (!node) return;
    const [copy] = rekeyNodes([node]);
    updateActiveNodesStable((nodes) => (findNode(nodes, id) ? insertSiblingAfter(nodes, id, copy) : nodes));
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

      [pasted] =
        clipboard.mode === "copy"
          ? rekeyNodes([clipboard.node])
          : cloneNodes([sourceNode ?? clipboard.node]);
      pastedId = pasted.id;
      const activeBaseNodes =
        clipboard.mode === "cut" && sourceNode && activeDocumentId === clipboard.sourceDocumentId
          ? removeNode(active.nodes, clipboard.sourceId)
          : active.nodes;
      const activeNodes = targetId === MINDMAP_ROOT_ID
        ? [...activeBaseNodes, pasted]
        : addChild(activeBaseNodes, targetId, pasted);
      didPaste = true;

      return {
        ...current,
        documents: current.documents.map((document) => {
          if (document.id === activeDocumentId) {
            return clearDocumentMarkdown({
              ...(document as MarkdownDocument),
              updatedAt: now(),
              nodes: activeNodes,
            });
          }
          if (clipboard.mode === "cut" && sourceNode && document.id === clipboard.sourceDocumentId) {
            return clearDocumentMarkdown({
              ...(document as MarkdownDocument),
              updatedAt: now(),
              nodes: removeNode(document.nodes, clipboard.sourceId),
            });
          }
          return document;
        }),
      };
    });
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
      const next = cloneNodes(nodes);
      const apply = (items: OutlineNode[]) => {
        items.forEach((node) => {
          if (siblingIds.has(node.id)) node.collapsed = shouldCollapse;
          apply(node.children);
        });
      };
      apply(next);
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

  const updateTitle = useEventCallback((title: string) => {
    const nextTitle = title || "未命名文档";
    if (modeRef.current === "markdown" && activeDocument) {
      const currentSource = markdownDraftRef.current.documentId === activeDocument.id
        ? markdownDraftRef.current.value
        : getDocumentMarkdown(activeDocument);
      handleMarkdownDraftChange(replaceMarkdownTitle(currentSource, nextTitle));
      patchActiveDocumentStable(
        (document) => (document.title === nextTitle ? document : { ...document, title: nextTitle }),
        { preserveMarkdown: true },
      );
      return;
    }
    patchActiveDocumentStable((document) =>
      document.title === nextTitle ? document : { ...document, title: nextTitle },
    );
  });

  const moveSelected = useEventCallback((direction: -1 | 1) => {
    if (!activeNodeId) return;
    flushFocusedStructuredInput();
    updateActiveNodesStable((nodes) => moveNode(nodes, activeNodeId, direction));
  });

  const exportActive = useEventCallback((format: ExportFormat) => {
    const currentWorkspace = flushPendingEdits() ?? workspaceRef.current;
    const document = currentWorkspace?.documents.find(
      (item) => item.id === currentWorkspace.activeDocumentId,
    ) as MarkdownDocument | undefined;
    if (!document) return;
    const result = exportDocument(document, format);
    downloadText(
      result.filename,
      format === "markdown" ? getDocumentMarkdown(document) : result.content,
      result.mime,
    );
    showNotice(`已导出 ${result.filename}`);
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
      showNotice(`已下载 PDF：${filename}`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "PDF 导出失败");
    }
  });

  const exportAll = useEventCallback(() => {
    const currentWorkspace = flushPendingEdits() ?? workspaceRef.current;
    if (!currentWorkspace) return;
    const result = exportWorkspace(currentWorkspace);
    downloadText(result.filename, result.content, result.mime);
    showNotice(`已导出 ${result.filename}`);
  });

  const backupToCloud = useEventCallback(async () => {
    const currentWorkspace = flushPendingEdits() ?? workspaceRef.current;
    if (!currentWorkspace) return;
    try {
      const expectedRevision =
        localStorage.getItem(ICLOUD_REVISION_KEY) ??
        localStorage.getItem(LEGACY_ICLOUD_REVISION_KEY) ??
        undefined;
      const result = await saveICloudBackup(currentWorkspace, expectedRevision);
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
    try {
      const next = migrateWorkspace(result.payload);
      replaceWorkspace(next);
      setActiveNodeId(firstNodeIdInWorkspace(next));
      setFocusNodeId(null);
      if (result.revision) {
        localStorage.setItem(ICLOUD_REVISION_KEY, result.revision);
        localStorage.removeItem(LEGACY_ICLOUD_REVISION_KEY);
      }
      showNotice(`已载入 iCloud 备份：${result.path}`);
    } catch (error) {
      showNotice(`载入备份失败：${error instanceof Error ? error.message : String(error)}`);
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
        showNotice(`检查更新失败：${result.error ?? "请稍后重试"}`);
        return;
      }
      if (!result.updateAvailable) {
        showNotice(`已是最新版本：${result.currentVersion}`);
        return;
      }

      const shouldOpen = window.confirm(
        `发现新版本 ${result.latestVersion}\n当前版本：${result.currentVersion}\n\n是否打开发布页？`,
      );
      if (shouldOpen) {
        window.open(result.releaseUrl || __RELEASE_PAGE_URL__, "_blank", "noopener,noreferrer");
      }
      showNotice(`发现新版本：${result.latestVersion}`);
    } catch (error) {
      showNotice(`检查更新失败：${error instanceof Error ? error.message : String(error)}`);
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
      const imported = importDocument(await file.text(), file.name);
      if ("documents" in imported) {
        const currentWorkspace = workspaceRef.current;
        const shouldReplace = window.confirm(
          `导入工作区「${file.name}」会替换当前所有文档。继续前会先下载一份当前工作区备份。`,
        );
        if (!shouldReplace) {
          showNotice("已取消导入工作区");
          return;
        }
        if (currentWorkspace) {
          const backup = exportWorkspace(currentWorkspace);
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          downloadText(
            `bike-workspace-before-import-${stamp}.json`,
            backup.content,
            backup.mime,
          );
        }
        replaceWorkspace(imported);
        setActiveNodeId(firstNodeIdInWorkspace(imported));
        setFocusNodeId(null);
        showNotice(`已导入工作区：${file.name}`);
        return;
      }
      setFocusNodeId(null);
      setActiveNodeId(firstNodeId(imported.nodes));
      commitWorkspace((current) => ({
        ...current,
        activeDocumentId: imported.id,
        documents: [imported, ...current.documents],
      }));
      showNotice(`已导入文档：${file.name}`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "导入失败");
    }
  });

  const setNodeRef = useEventCallback((id: string, element: HTMLTextAreaElement | null) => {
    if (element) {
      inputRefs.current.set(id, element);
    } else {
      inputRefs.current.delete(id);
    }
  });

  if (loadError) {
    return (
      <main className="loading loading-error">
        <section>
          <h1>无法打开本地工作区</h1>
          <p>{loadError}</p>
          <button type="button" onClick={() => initializeWorkspace()}>
            重试
          </button>
        </section>
      </main>
    );
  }

  if (!workspace || !activeDocument) {
    return <div className="loading">正在打开本地工作区...</div>;
  }

  const tagHits = selectedTag
    ? flattenNodes(activeDocument.nodes).filter((row) =>
        [...extractTags(row.node.text), ...extractTags(row.node.note)].includes(selectedTag),
      )
    : [];

  return (
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
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索文档、主题、备注"
          />
        </label>

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
          <button onClick={() => showNotice("快速访问功能开发中，敬请期待")}>
            <Zap size={16} />
            快速访问
          </button>
          <button className={sidebarView === "all" ? "selected" : ""} onClick={() => setSidebarView("all")}>
            <FolderOpen size={16} />
            我的文档
          </button>
        </nav>

        <div className={classNames("document-list", sidebarView === "recent" && "recent-list")}>
          <div className="document-list-title">
            <span>{sidebarView === "recent" ? "最近编辑" : "我的文档"}</span>
            <small>
              {sidebarView === "recent"
                ? `${matchingDocuments.length} 个最近文档`
                : `${matchingDocuments.length} 个文档`}
            </small>
          </div>
          {matchingDocuments.map((document) => (
            <button
              key={document.id}
              className={classNames(
                "document-item",
                document.id === activeDocument.id && "active",
                sidebarView === "recent" && "show-time",
              )}
              onClick={() => selectDocument(document.id)}
            >
              <FileText size={16} />
              <span>{document.title}</span>
              <small>
                {sidebarView === "recent"
                  ? formatRecentTime(document.updatedAt)
                  : formatTime(document.updatedAt)}
              </small>
            </button>
          ))}
          {matchingDocuments.length === 0 && (
            <span className="empty-text">
              {sidebarView === "recent" ? "暂无最近编辑文档" : "没有匹配的文档"}
            </span>
          )}
        </div>

        <div className="sidebar-section">
          <div className="section-title">
            <Tag size={15} />
            标签
          </div>
          <div className="tag-list">
            {tags.map((tag) => (
              <button
                key={tag}
                className={classNames("tag-pill", selectedTag === tag && "selected")}
                onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
              >
                #{tag}
              </button>
            ))}
            {!tags.length && <span className="empty-text">暂无标签</span>}
          </div>
        </div>

        <div className="sidebar-dock">
          <button title="本地会员功能" onClick={() => showNotice("会员功能开发中，敬请期待")}>
            <Star size={16} />
          </button>
          <button title="标签" onClick={() => { const el = document.querySelector(".sidebar-section"); if (el) el.scrollIntoView({ behavior: "smooth" }); }}>
            <Tag size={16} />
          </button>
          <button title="iCloud 备份" onClick={backupToCloud}>
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
          <button title="回收站" onClick={() => showNotice("回收站功能开发中，敬请期待")}>
            <Trash2 size={16} />
          </button>
          <button title={theme === "light" ? "切换到暗黑模式" : "切换到明亮模式"} onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </div>

        <div className="sync-panel">
          <Cloud size={17} />
          <div>
            <strong>本地保存</strong>
            <span>{notice}</span>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="title-block">
            <input
              className="title-input"
              value={activeDocument.title}
              onChange={(event) => updateTitle(event.target.value)}
            />
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

            <button className="icon-button" onClick={duplicateDocument} title="复制文档">
              <Copy size={17} />
            </button>
            <button className="icon-button danger" onClick={() => setShowConfirmDelete(true)} title="删除文档">
              <Trash2 size={17} />
            </button>
          </div>
        </header>

        <div className="toolstrip">
          {mode !== "markdown" && (
            <>
              <button onClick={() => activeNodeId && insertAfter(activeNodeId)}>
                <Plus size={16} />
                同级
              </button>
              <button onClick={() => activeNodeId && insertChild(activeNodeId)}>
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
          <button onClick={() => exportActive("markdown")}>
            <Download size={16} />
            导出 MD
          </button>
          <button onClick={() => exportActive("opml")}>OPML</button>
          <button onClick={() => exportActive("freemind")}>FreeMind</button>
          <button onClick={() => exportActive("html")}>HTML</button>
          <button onClick={exportActivePdf}>PDF</button>
          <button onClick={exportAll}>
            <FileJson size={16} />
            工作区
          </button>
          <span className="separator" />
          <button onClick={backupToCloud}>
            <Cloud size={16} />
            iCloud 备份
          </button>
          <button onClick={loadCloudBackup}>载入备份</button>
        </div>

        <div
          className={classNames(
            "content",
            mode === "markdown" && "markdown-active",
            mode === "markdown" && `markdown-${markdownPaneMode}`,
          )}
        >
          <section className={classNames("editor-pane", mode === "markdown" && "markdown-editor-pane")}>
            {selectedTag && mode !== "markdown" && (
              <div className="filter-banner">
                <Tag size={15} />
                #{selectedTag} 命中 {tagHits.length} 个主题
                <button onClick={() => setSelectedTag(null)}>
                  <X size={14} />
                </button>
              </div>
            )}

            {mode === "outline" && !focusNode && (
              <input
                className="document-heading-input"
                value={activeDocument.title}
                onChange={(event) => updateTitle(event.target.value)}
                aria-label="文档标题"
              />
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
                isAiBusy={(id) => Boolean(aiBusyKey?.startsWith(`structured:${id}:`))}
              />
            )}

            {mode === "mindmap" && (
              <MindMap
                title={focusNode?.text || activeDocument.title}
                nodes={focusNode ? focusNode.children : activeDocument.nodes}
                rootTargetId={focusNode?.id ?? null}
                viewportResetKey={focusNode?.id ?? activeDocument.id}
                activeNodeId={activeNodeId}
                onSelect={setActiveNodeId}
                onTitle={updateTitle}
                onText={handleNodeText}
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
                onAiAction={handleStructuredAiAction}
                isAiBusy={(id) => Boolean(aiBusyKey?.startsWith(`structured:${id}:`))}
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
                value={markdownDraft}
                viewMode={markdownPaneMode}
                onChange={handleMarkdownDraftChange}
                onViewModeChange={setMarkdownPaneMode}
                onAiAction={handleMarkdownAiAction}
                isAiBusy={Boolean(aiBusyKey?.startsWith("markdown:"))}
              />
            )}
          </section>

          {mode !== "markdown" && (
            <aside className="inspector">
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
                  </>
                ) : (
                  <p className="empty-text">选择一个主题查看详情</p>
                )}
              </section>

              <section>
                <div className="section-title">
                  <Link2 size={15} />
                  文档链接
                </div>
                <div className="link-list">
                  {linkRows.map((row, index) => (
                    <div key={`${row.source}-${row.link}-${index}`} className="link-row">
                      <span>{row.source}</span>
                      <strong>[[{row.link}]]</strong>
                    </div>
                  ))}
                  {!linkRows.length && <p className="empty-text">用 [[文档名]] 建立链接</p>}
                </div>
              </section>

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

      {showAiConfig && (
        <AiConfigDialog
          initialConfig={aiConfig || defaultAiConfig}
          onSave={handleSaveAiConfig}
          onClose={() => setShowAiConfig(false)}
        />
      )}

      {showConfirmDelete && (
        <div className="confirm-overlay" onClick={() => setShowConfirmDelete(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>确认删除</h3>
            <p>确定要删除文档「{activeDocument.title}」吗？此操作不可撤销。</p>
            <div className="confirm-actions">
              <button className="confirm-cancel" onClick={() => setShowConfirmDelete(false)}>取消</button>
              <button className="confirm-delete" onClick={() => { setShowConfirmDelete(false); deleteDocument(); }}>删除</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

interface MarkdownViewProps {
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
    <div className="modal-overlay" onClick={onClose}>
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
              autoComplete="current-password"
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
    </div>
  );
}

function MarkdownView({
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
            <textarea
              ref={textareaRef}
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
          <MarkdownPreview content={value} />
        )}
      </div>
    </div>
  );
}

function MarkdownPreview({ content }: { content: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
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

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = Math.min(heading[1].length, 6);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      blocks.push(
        <Tag key={`heading-${index}`}>
          {renderInlineMarkdown(heading[2], `heading-${index}`)}
        </Tag>,
      );
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const tableLines = [lines[index], lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        tableLines.push(lines[index]);
        index += 1;
      }
      const headers = splitMarkdownTableRow(tableLines[0]);
      const rows = tableLines.slice(2).map(splitMarkdownTableRow);
      blocks.push(
        <table key={`table-${index}`} className="markdown-preview-table">
          <thead>
            <tr>
              {headers.map((cell, cellIndex) => (
                <th key={`head-${cellIndex}`}>
                  {renderInlineMarkdown(cell, `table-head-${index}-${cellIndex}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`}>
                {row.map((cell, cellIndex) => (
                  <td key={`cell-${rowIndex}-${cellIndex}`}>
                    {renderInlineMarkdown(cell, `table-cell-${index}-${rowIndex}-${cellIndex}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    const listItem = line.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/);
    if (listItem) {
      const items: Array<{ indent: number; checked?: boolean; text: string }> = [];
      while (index < lines.length) {
        const item = lines[index].match(/^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/);
        if (!item) break;
        items.push({
          indent: item[1].replace(/\t/g, "    ").length,
          checked: item[2] ? item[2].toLowerCase() === "x" : undefined,
          text: item[3],
        });
        index += 1;
      }
      blocks.push(renderMarkdownPreviewList(buildMarkdownPreviewList(items), `list-${index}`));
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${index}`}>
          {quoteLines.map((quoteLine, quoteIndex) => (
            <p key={`quote-line-${quoteIndex}`}>
              {renderInlineMarkdown(quoteLine, `quote-${index}-${quoteIndex}`)}
            </p>
          ))}
        </blockquote>,
      );
      continue;
    }

    const paragraphLines = [line.trim()];
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
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push(
      <p key={`paragraph-${index}`}>
        {renderInlineMarkdown(paragraphLines.join(" "), `paragraph-${index}`)}
      </p>,
    );
  }

  return (
    <div className="markdown-preview" aria-label="Markdown 预览">
      {blocks.length ? blocks : <p className="empty-text">暂无 Markdown 内容</p>}
    </div>
  );
}

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
  text: string;
  checked?: boolean;
  children: MarkdownPreviewListItem[];
}

const buildMarkdownPreviewList = (
  items: Array<{ indent: number; checked?: boolean; text: string }>,
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
      checked: item.checked,
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    stack.push({ indent: item.indent, children: node.children });
  });

  return roots;
};

const renderMarkdownPreviewList = (
  items: MarkdownPreviewListItem[],
  keyPrefix: string,
): React.ReactNode => (
  <ul key={keyPrefix} className="markdown-preview-list">
    {items.map((item, itemIndex) => (
      <li
        key={`${keyPrefix}-${itemIndex}`}
        className={item.checked !== undefined ? "task-item" : undefined}
      >
        <span className="markdown-preview-list-line">
          {item.checked !== undefined && (
            <input type="checkbox" checked={item.checked} readOnly />
          )}
          <span>{renderInlineMarkdown(item.text, `${keyPrefix}-${itemIndex}`)}</span>
        </span>
        {item.children.length > 0 &&
          renderMarkdownPreviewList(item.children, `${keyPrefix}-${itemIndex}-children`)}
      </li>
    ))}
  </ul>
);

const safeMarkdownUrl = (value: string, kind: "link" | "image") => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const protocol = trimmed.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (!protocol) return trimmed;
  if (protocol === "http" || protocol === "https" || protocol === "mailto" || protocol === "tel") {
    return trimmed;
  }
  if (kind === "image" && protocol === "data" && /^data:image\//i.test(trimmed)) {
    return trimmed;
  }
  return "";
};

const renderInlineMarkdown = (text: string, keyPrefix: string): React.ReactNode[] => {
  const nodes: React.ReactNode[] = [];
  const tokenPattern =
    /(!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*]+)\*|_([^_]+)_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const key = `${keyPrefix}-${match.index}`;
    if (match[2] !== undefined) {
      const source = safeMarkdownUrl(match[3], "image");
      nodes.push(
        source ? (
          <img key={key} src={source} alt={match[2]} className="markdown-preview-image" />
        ) : (
          <span key={key}>{match[2]}</span>
        ),
      );
    } else if (match[4] !== undefined) {
      const href = safeMarkdownUrl(match[5], "link");
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

    lastIndex = tokenPattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
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
  onUpdateNodes: (nodes: OutlineNode[]) => void;
  onAiAction: (action: AiNodeAction, targetId: StructuredAiTargetId) => void;
  isAiBusy: (id: StructuredAiTargetId) => boolean;
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
}: OutlineNodeRowProps) {
  const [localText, setLocalText] = useState(node.text);
  const [textCellWidth, setTextCellWidth] = useState(0);
  const isFocusedRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const textCellRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const autoResize = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  const updateTextCellWidth = useCallback(() => {
    const nextWidth = textCellRef.current?.clientWidth ?? 0;
    setTextCellWidth((currentWidth) => (
      Math.abs(currentWidth - nextWidth) < 1 ? currentWidth : nextWidth
    ));
  }, []);

  useEffect(() => {
    if (!isFocusedRef.current) {
      setLocalText(node.text);
    }
  }, [node.text]);

  useLayoutEffect(() => {
    autoResize(textareaRef.current);
    if (resizeFrameRef.current) window.cancelAnimationFrame(resizeFrameRef.current);
    if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      autoResize(textareaRef.current);
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        autoResize(textareaRef.current);
      });
    });
    resizeTimerRef.current = window.setTimeout(() => {
      resizeTimerRef.current = null;
      autoResize(textareaRef.current);
    }, 140);
  }, [autoResize, localText, textCellWidth]);

  useEffect(() => {
    const textCell = textCellRef.current;
    const observer = textCell && "ResizeObserver" in window
      ? new ResizeObserver(updateTextCellWidth)
      : null;
    if (observer && textCell) observer.observe(textCell);
    window.addEventListener("resize", updateTextCellWidth);
    updateTextCellWidth();

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateTextCellWidth);
    };
  }, [updateTextCellWidth]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) window.clearTimeout(debounceTimerRef.current);
      if (resizeFrameRef.current) window.cancelAnimationFrame(resizeFrameRef.current);
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
    };
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setLocalText(val);
    autoResize(e.target);

    if (debounceTimerRef.current) window.clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = window.setTimeout(() => {
      onText(node.id, val);
    }, 400);
  };

  const handleBlur = () => {
    isFocusedRef.current = false;
    if (debounceTimerRef.current) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    onText(node.id, localText);
  };

  const handleFocus = () => {
    isFocusedRef.current = true;
    onSelect(node.id);
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
        `node-${normalizeColor(node.color)}`,
        `heading-${node.headingLevel ?? 0}`,
        node.highlight && "is-highlighted",
        dropZone ? `drop-${dropZone}` : false,
      )}
      style={{ "--depth": depth } as React.CSSProperties}
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

      {node.isTodo && (
        <button
          className="task-checkbox"
          onClick={handleCheckboxToggle}
          title={node.checked ? "设为未完成" : "设为已完成"}
        >
          {node.checked ? <CheckCircle2 size={16} className="checked" /> : <Circle size={16} />}
        </button>
      )}

      <div className="outline-text-cell" ref={textCellRef}>
        {node.icon && <span className="node-icon">{node.icon}</span>}
        <textarea
          ref={(element) => {
            textareaRef.current = element;
            setNodeRef(node.id, element);
          }}
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
          onKeyDown={(event) => onKeyDown(event, node)}
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
        {node.table && (
          <span className="node-attachment">
            <Table size={13} />
            表格 {node.table.length}x{node.table[0]?.length ?? 0}
          </span>
        )}
      </div>

      <div className="row-meta">
        {extractTags(localText).map((tag) => (
          <span key={tag}>#{tag}</span>
        ))}
        {extractLinks(localText).map((link) => (
          <span key={link}>[[{link}]]</span>
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

function OutlineView(props: OutlineViewProps) {
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

    let next = removeNode(props.nodes, sourceId);
    if (dropZone === "before") {
      next = insertSiblingBefore(next, targetId, sourceNode);
    } else if (dropZone === "after") {
      next = insertSiblingAfter(next, targetId, sourceNode);
    } else {
      next = addChild(next, targetId, sourceNode);
    }
    props.onUpdateNodes(next);
    draggedIdRef.current = null;
    draggedNodeRef.current = null;
    setDropState(null);
  });

  return (
    <div className="outline-list">
      {rows.map(({ node, depth }) => (
        <OutlineNodeRow
          key={node.id}
          node={node}
          depth={depth}
          isActive={props.activeNodeId === node.id}
          onSelect={props.onSelect}
          onText={props.onText}
          onKeyDown={props.onKeyDown}
          onPatch={props.onPatch}
          onInsertAfter={props.onInsertAfter}
          onInsertChild={props.onInsertChild}
          onRemove={props.onRemove}
          setNodeRef={props.setNodeRef}
          onOpenMenu={handleOpenMenu}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDragEnd={handleDragEnd}
          onDrop={handleDrop}
          dropZone={dropState?.id === node.id ? dropState.zone : null}
          onAiAction={props.onAiAction}
          isAiBusy={props.isAiBusy(node.id)}
        />
      ))}
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
}

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
  const timestamp = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
  const selectedWords = node.text.trim()
    ? Array.from(node.text.trim().matchAll(/[\p{L}\p{N}_-]+/gu)).length
    : 0;
  const nextIcon = node.icon ? undefined : "★";
  const nextTable = node.table
    ? undefined
    : [
        ["字段", "内容"],
        ["待补充", "待补充"],
      ];

  return (
    <div
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
          onClick={() =>
            onPatch({
              imageName: node.imageName ? undefined : "本地图片占位",
              imageAlt: undefined,
            })
          }
        >
          <Image size={19} />
          <span>{node.imageName ? "移除图片" : "添加图片"}</span>
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
        <span>编辑于：{timestamp}</span>
        <span>选中字数：{selectedWords}</span>
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

function MindMap({
  title,
  nodes,
  rootTargetId,
  viewportResetKey,
  activeNodeId,
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
}: MindMapProps) {
  const mapRootId = MINDMAP_ROOT_ID;
  const viewportRef = useRef<HTMLDivElement | null>(null);
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
      if (!isRootNode(renderedActiveNodeId)) {
        onInsertAfter(renderedActiveNodeId);
      } else {
        onInsertChild(rootTargetId ?? renderedActiveNodeId);
      }
    } else if (event.key === "Tab") {
      event.preventDefault();
      if (event.shiftKey) {
        if (!isRootNode(renderedActiveNodeId)) {
          onInsertParent(renderedActiveNodeId);
        }
      } else {
        onInsertChild(isRootNode(renderedActiveNodeId) ? rootTargetId ?? renderedActiveNodeId : renderedActiveNodeId);
      }
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
  const setMapNodeText = (id: string, text: string) => {
    const cleanText = text.replace(/\r?\n/g, " ");
    if (isRootNode(id)) {
      if (rootTargetId) {
        onText(rootTargetId, cleanText || "未命名主题");
      } else {
        onTitle(cleanText || "未命名文档");
      }
      return;
    }
    onText(id, cleanText);
  };

  const copyMapNode = async (item: MindMapItem) => {
    try {
      await navigator.clipboard.writeText(item.node.text || title);
    } catch {
      // Clipboard may be unavailable in some browser contexts; the menu still closes.
    }
  };

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
      </div>

      <div
        className="mindmap-stage"
        style={{
          width: layout.width,
          height: layout.height,
          transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.scale})`,
        }}
      >
        <svg
          className="mindmap"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label={`${title} 思维导图`}
        >
          {layout.edges.map((edge) => (
            <path
              key={`${edge.from.node.id}-${edge.to.node.id}`}
              className={classNames("mindmap-edge", `edge-${normalizeColor(edge.to.node.color)}`)}
              d={`M ${edge.from.x + edge.from.width} ${edge.from.y + edge.from.height / 2} C ${
                edge.from.x + edge.from.width + 52
              } ${edge.from.y + edge.from.height / 2}, ${edge.to.x - 52} ${
                edge.to.y + edge.to.height / 2
              }, ${edge.to.x} ${edge.to.y + edge.to.height / 2}`}
            />
          ))}
          {renderedItems.map((item) => (
            <foreignObject
              key={item.node.id}
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
                if (!isRootNode(item.node.id)) onSelect(item.node.id);
                setEditingNodeId(item.node.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!isRootNode(item.node.id)) onSelect(item.node.id);
                setContextMenu({
                  nodeId: item.node.id,
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
            >
              <div
                className={classNames(
                  "map-node",
                  renderedActiveNodeId === item.node.id && "active",
                  editingNodeId === item.node.id && "editing",
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
                {editingNodeId === item.node.id ? (
                  <div className="map-node-edit-wrap">
                    <textarea
                      autoFocus
                      value={isRootNode(item.node.id) ? title : item.node.text}
                      placeholder="输入文字"
                      onChange={(event) => setMapNodeText(item.node.id, event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) return;
                        if (event.key === "Enter") {
                          event.preventDefault();
                          setEditingNodeId(null);
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setEditingNodeId(null);
                        }
                      }}
                      onBlur={() => setEditingNodeId(null)}
                    />
                    <AiInlineMenu
                      busy={isAiBusy(isRootNode(item.node.id) ? rootActionTargetId() : item.node.id)}
                      onAction={(action) =>
                        onAiAction(action, isRootNode(item.node.id) ? rootActionTargetId() : item.node.id)
                      }
                    />
                    <button
                      className="map-node-add"
                      title="新增下级主题"
                      onClick={(event) => {
                        event.stopPropagation();
                        onInsertChild(isRootNode(item.node.id) ? rootActionTargetId() : item.node.id);
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
              </div>
            </foreignObject>
          ))}
        </svg>
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
  const hasChildren = item.node.children.length > 0;
  return (
    <div
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
        <kbd>Tab</kbd>
      </button>
      <button disabled={isRoot} onClick={onInsertParent}>
        <span>插入上级主题</span>
        <kbd>⇧ + Tab</kbd>
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
  const height = Math.max(minHeight, lines.length * 19 + 22);
  return { lines, width, height };
};

function createMindMapLayout(nodes: OutlineNode[]) {
  const items: MindMapItem[] = [];
  const xGap = 390;
  const yGap = 34;
  const pad = 48;
  let cursor = 0;
  let maxDepth = 0;

  const visit = (node: OutlineNode, depth: number, parentId: string | null): number => {
    maxDepth = Math.max(maxDepth, depth);
    const metrics = mindMapMetrics(node, depth);
    const children = node.collapsed ? [] : node.children;
    let y: number;
    if (!children.length) {
      y = pad + cursor;
      cursor += metrics.height + yGap;
    } else {
      const childYs = children.map((child) => visit(child, depth + 1, node.id));
      y = (Math.min(...childYs) + Math.max(...childYs)) / 2 - metrics.height / 2;
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
    return y + metrics.height / 2;
  };

  nodes.forEach((node) => visit(node, 0, null));
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
    const list: Array<{ title: string; subtitle?: string; note?: string; points: OutlineNode[] }> = [];
    
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
      if (isEditableEventTarget(e.target)) return;
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
                    {point.children && point.children.length > 0 && (
                      <div className="slide-point-nested">
                        {point.children.map((subpoint) => (
                          <div key={subpoint.id} className="slide-point-nested-item">
                            <span className="slide-point-nested-bullet">-</span>
                            <span>{subpoint.text || "未命名孙项"}</span>
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
