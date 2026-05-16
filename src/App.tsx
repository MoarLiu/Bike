import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bold,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Cloud,
  Copy,
  Download,
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
  Link2,
  ListTree,
  Palette,
  Plus,
  Presentation,
  RotateCcw,
  Search,
  Smile,
  Star,
  Strikethrough,
  Table,
  Tag,
  Trash2,
  Type,
  Underline,
  Upload,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { saveICloudBackup } from "./backup";
import {
  downloadText,
  exportDocument,
  exportDocumentAsPdf,
  exportWorkspace,
  importDocument,
} from "./exporters";
import { createStarterWorkspace } from "./sample";
import { loadWorkspace, saveWorkspace } from "./storage";
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
  moveNode,
  nodeText,
  normalizeColor,
  outdentNode,
  removeNode,
  uid,
  updateNode,
} from "./tree";

type ExportFormat = "json" | "markdown" | "opml" | "freemind" | "html";
type NodeClipboard = {
  mode: "copy" | "cut";
  sourceId: string;
  node: OutlineNode;
};

const now = () => new Date().toISOString();

const classNames = (...names: Array<string | false | undefined>) =>
  names.filter(Boolean).join(" ");

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

const formatTime = (iso: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

const colorOptions = [
  { value: "plain", label: "默认" },
  { value: "blue", label: "蓝" },
  { value: "green", label: "绿" },
  { value: "amber", label: "黄" },
  { value: "rose", label: "红" },
];

const nodeMenuColors = [
  { value: "plain", label: "默认", swatch: "#5f6065" },
  { value: "blue", label: "蓝", swatch: "#3b73ad" },
  { value: "green", label: "绿", swatch: "#3f7f4f" },
  { value: "amber", label: "黄", swatch: "#a96f21" },
  { value: "rose", label: "红", swatch: "#b55562" },
];

function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<ViewMode>("outline");
  const [search, setSearch] = useState("");
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [nodeClipboard, setNodeClipboard] = useState<NodeClipboard | null>(null);
  const [notice, setNotice] = useState("本地自动保存已开启");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputRefs = useRef(new Map<string, HTMLInputElement>());

  useEffect(() => {
    let mounted = true;
    loadWorkspace().then((stored) => {
      if (!mounted) return;
      const next = stored ?? createStarterWorkspace();
      setWorkspace(next);
      setActiveNodeId(firstNodeId(next.documents[0]?.nodes ?? []));
      setReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!workspace || !ready) return;
    const handle = window.setTimeout(() => {
      saveWorkspace(workspace);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [workspace, ready]);

  useEffect(() => {
    if (!activeNodeId) return;
    const handle = window.setTimeout(() => {
      inputRefs.current.get(activeNodeId)?.focus();
    }, 20);
    return () => window.clearTimeout(handle);
  }, [activeNodeId, mode]);

  const activeDocument = useMemo(() => {
    if (!workspace) return null;
    return (
      workspace.documents.find((document) => document.id === workspace.activeDocumentId) ??
      workspace.documents[0] ??
      null
    );
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
    return workspace.documents.filter((document) => {
      const matchesQuery = !query || collectDocumentText(document).includes(query);
      const matchesTag =
        !selectedTag ||
        flattenNodes(document.nodes).some((row) =>
          [...extractTags(row.node.text), ...extractTags(row.node.note)].includes(selectedTag),
        );
      return matchesQuery && matchesTag;
    });
  }, [search, selectedTag, workspace]);

  const commitWorkspace = (updater: (workspace: Workspace) => Workspace) => {
    setWorkspace((current) => (current ? updater(current) : current));
  };

  const patchActiveDocument = (
    updater: (document: OutlineDocument) => OutlineDocument,
  ) => {
    commitWorkspace((current) => ({
      ...current,
      documents: current.documents.map((document) =>
        document.id === current.activeDocumentId
          ? updater({ ...document, updatedAt: now() })
          : document,
      ),
    }));
  };

  const setActiveNodes = (nodes: OutlineNode[]) => {
    patchActiveDocument((document) => ({ ...document, nodes }));
  };

  const selectDocument = (id: string) => {
    const document = workspace?.documents.find((item) => item.id === id);
    setFocusNodeId(null);
    setActiveNodeId(firstNodeId(document?.nodes ?? []));
    commitWorkspace((current) => ({ ...current, activeDocumentId: id }));
  };

  const createDocument = () => {
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
  };

  const duplicateDocument = () => {
    if (!activeDocument) return;
    const id = crypto.randomUUID();
    const document = {
      ...activeDocument,
      id,
      title: `${activeDocument.title} 副本`,
      createdAt: now(),
      updatedAt: now(),
      nodes: rekeyNodes(activeDocument.nodes),
    };
    setActiveNodeId(firstNodeId(document.nodes));
    setFocusNodeId(null);
    commitWorkspace((current) => ({
      ...current,
      activeDocumentId: id,
      documents: [document, ...current.documents],
    }));
  };

  const deleteDocument = () => {
    if (!activeDocument || !workspace || workspace.documents.length === 1) {
      setNotice("至少保留一个文档");
      return;
    }
    const nextDocuments = workspace.documents.filter(
      (document) => document.id !== activeDocument.id,
    );
    const nextActive = nextDocuments[0];
    setActiveNodeId(firstNodeId(nextActive.nodes));
    setFocusNodeId(null);
    setWorkspace({
      ...workspace,
      activeDocumentId: nextActive.id,
      documents: nextDocuments,
    });
  };

  const handleNodeText = (id: string, text: string) => {
    if (!activeDocument) return;
    setActiveNodes(updateNode(activeDocument.nodes, id, (node) => {
      node.text = text;
    }));
  };

  const handleNodePatch = (id: string, patch: Partial<OutlineNode>) => {
    if (!activeDocument) return;
    setActiveNodes(updateNode(activeDocument.nodes, id, (node) => {
      Object.assign(node, patch);
      node.color = normalizeColor(node.color);
    }));
  };

  const copyNodeLink = async (nodeId: string) => {
    const node = activeDocument ? findNode(activeDocument.nodes, nodeId) : null;
    if (!activeDocument || !node) return;
    const link = `[[${activeDocument.title}#${node.text || "未命名主题"}]]`;
    try {
      await navigator.clipboard.writeText(link);
      setNotice("已复制主题链接");
    } catch {
      setNotice(link);
    }
  };

  const exportNodeMarkdown = (nodeId: string) => {
    const node = activeDocument ? findNode(activeDocument.nodes, nodeId) : null;
    if (!node) return;
    const title = node.text || "未命名主题";
    const content = [`# ${title}`, "", renderNodeMarkdown(node)].join("\n");
    downloadText(`${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")}.md`, content, "text/markdown");
    setNotice(`已导出主题：${title}`);
  };

  const insertAfter = (id: string) => {
    if (!activeDocument) return;
    const node = createNode("");
    setActiveNodes(insertSiblingAfter(activeDocument.nodes, id, node));
    setActiveNodeId(node.id);
  };

  const insertChild = (id: string) => {
    if (!activeDocument) return;
    const node = createNode("");
    setActiveNodes(addChild(activeDocument.nodes, id, node));
    setActiveNodeId(node.id);
  };

  const removeActiveNode = (id: string) => {
    if (!activeDocument) return;
    const next = removeNode(activeDocument.nodes, id);
    setActiveNodes(next);
    setActiveNodeId(firstNodeId(next));
    if (focusNodeId === id) setFocusNodeId(null);
  };

  const duplicateNode = (id: string) => {
    if (!activeDocument) return;
    const node = findNode(activeDocument.nodes, id);
    if (!node) return;
    const [copy] = rekeyNodes([node]);
    setActiveNodes(insertSiblingAfter(activeDocument.nodes, id, copy));
    setActiveNodeId(copy.id);
    setNotice("已创建主题副本");
  };

  const insertParentNode = (id: string) => {
    if (!activeDocument) return;
    const parent = createNode("上级主题");
    setActiveNodes(insertParent(activeDocument.nodes, id, parent));
    setActiveNodeId(parent.id);
    setNotice("已插入上级主题");
  };

  const copyNodeToClipboard = async (id: string) => {
    const node = activeDocument ? findNode(activeDocument.nodes, id) : null;
    if (!node) return;
    setNodeClipboard({
      mode: "copy",
      sourceId: id,
      node: cloneNodes([node])[0],
    });
    try {
      await navigator.clipboard.writeText(renderNodeMarkdown(node));
    } catch {
      // Browser clipboard permission is best-effort; the in-app clipboard still works.
    }
    setNotice("已复制主题，可在脑图中粘贴");
  };

  const cutNodeToClipboard = (id: string) => {
    const node = activeDocument ? findNode(activeDocument.nodes, id) : null;
    if (!node) return;
    setNodeClipboard({
      mode: "cut",
      sourceId: id,
      node: cloneNodes([node])[0],
    });
    setNotice("已剪切主题，选择目标后粘贴");
  };

  const pasteNodeAsChild = (targetId: string) => {
    if (!activeDocument || !nodeClipboard) return;
    const sourceNode = findNode(activeDocument.nodes, nodeClipboard.sourceId);
    if (
      nodeClipboard.mode === "cut" &&
      sourceNode &&
      nodeContainsId(sourceNode, targetId)
    ) {
      setNotice("不能把主题粘贴到自己或自己的子主题里");
      return;
    }

    const [pasted] = rekeyNodes([nodeClipboard.node]);
    const baseNodes =
      nodeClipboard.mode === "cut" && sourceNode
        ? removeNode(activeDocument.nodes, nodeClipboard.sourceId)
        : activeDocument.nodes;
    const next = addChild(baseNodes, targetId, pasted);
    setActiveNodes(next);
    setActiveNodeId(pasted.id);
    if (nodeClipboard.mode === "cut") {
      setNodeClipboard(null);
    }
    setNotice("已粘贴为下级主题");
  };

  const toggleSiblingCollapse = (id: string) => {
    if (!activeDocument) return;
    const rows = flattenNodes(activeDocument.nodes);
    const target = rows.find((row) => row.node.id === id);
    if (!target) return;
    const siblings = rows.filter(
      (row) => row.parentId === target.parentId && row.node.children.length,
    );
    if (!siblings.length) return;
    const shouldCollapse = siblings.some((row) => !row.node.collapsed);
    const siblingIds = new Set(siblings.map((row) => row.node.id));
    const next = cloneNodes(activeDocument.nodes);
    const apply = (nodes: OutlineNode[]) => {
      nodes.forEach((node) => {
        if (siblingIds.has(node.id)) node.collapsed = shouldCollapse;
        apply(node.children);
      });
    };
    apply(next);
    setActiveNodes(next);
    setNotice(shouldCollapse ? "已折叠同级主题" : "已展开同级主题");
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
    node: OutlineNode,
  ) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const rows = flattenNodes(visibleNodes, { respectCollapsed: true });
      const index = rows.findIndex((row) => row.node.id === node.id);
      const nextIndex = event.key === "ArrowUp" ? index - 1 : index + 1;
      const nextNode = rows[nextIndex]?.node;
      if (nextNode) {
        event.preventDefault();
        setActiveNodeId(nextNode.id);
      }
    }
    if (event.key === "Enter") {
      event.preventDefault();
      insertAfter(node.id);
    }
    if (event.key === "Tab") {
      event.preventDefault();
      if (!activeDocument) return;
      const next = event.shiftKey
        ? outdentNode(activeDocument.nodes, node.id)
        : indentNode(activeDocument.nodes, node.id);
      setActiveNodes(next);
      setActiveNodeId(node.id);
    }
    if (event.key === "Backspace" && !node.text && countNodes(activeDocument?.nodes ?? []) > 1) {
      event.preventDefault();
      removeActiveNode(node.id);
    }
  };

  const updateTitle = (title: string) => {
    patchActiveDocument((document) => ({
      ...document,
      title: title || "未命名文档",
    }));
  };

  const moveSelected = (direction: -1 | 1) => {
    if (!activeDocument || !activeNodeId) return;
    setActiveNodes(moveNode(activeDocument.nodes, activeNodeId, direction));
  };

  const exportActive = (format: ExportFormat) => {
    if (!activeDocument) return;
    const result = exportDocument(activeDocument, format);
    downloadText(result.filename, result.content, result.mime);
    setNotice(`已导出 ${result.filename}`);
  };

  const exportActivePdf = async () => {
    if (!activeDocument) return;
    try {
      setNotice("正在生成 PDF...");
      const filename = await exportDocumentAsPdf(activeDocument);
      setNotice(`已下载 PDF：${filename}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "PDF 导出失败");
    }
  };

  const exportAll = () => {
    if (!workspace) return;
    const result = exportWorkspace(workspace);
    downloadText(result.filename, result.content, result.mime);
    setNotice(`已导出 ${result.filename}`);
  };

  const backupToCloud = async () => {
    if (!workspace) return;
    try {
      const result = await saveICloudBackup(workspace);
      setNotice(result.ok ? `iCloud 备份已保存：${result.path}` : result.error ?? "备份失败");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const loadCloudBackup = async () => {
    if (!window.localOutline) {
      setNotice("浏览器版请用“导入”选择 iCloud Drive 里的 localoutline-workspace.json");
      return;
    }
    const result = await window.localOutline.loadICloudBackup();
    if (!result.ok || !result.payload || !("documents" in (result.payload as Workspace))) {
      setNotice(result.error ?? "没有找到可用的 iCloud 备份");
      return;
    }
    const next = result.payload as Workspace;
    setWorkspace(next);
    setActiveNodeId(firstNodeId(next.documents[0]?.nodes ?? []));
    setFocusNodeId(null);
    setNotice(`已载入 iCloud 备份：${result.path}`);
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const imported = importDocument(await file.text(), file.name);
      if ("documents" in imported) {
        setWorkspace(imported);
        setActiveNodeId(firstNodeId(imported.documents[0]?.nodes ?? []));
        setNotice(`已导入工作区：${file.name}`);
        return;
      }
      setFocusNodeId(null);
      setActiveNodeId(firstNodeId(imported.nodes));
      commitWorkspace((current) => ({
        ...current,
        activeDocumentId: imported.id,
        documents: [imported, ...current.documents],
      }));
      setNotice(`已导入文档：${file.name}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导入失败");
    }
  };

  const setNodeRef = (id: string, element: HTMLInputElement | null) => {
    if (element) {
      inputRefs.current.set(id, element);
    } else {
      inputRefs.current.delete(id);
    }
  };

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
            <strong>Local Outline</strong>
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
          <button onClick={() => fileInputRef.current?.click()}>
            <Upload size={16} />
            导入
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="工作区导航">
          <button>
            <Clock size={16} />
            最近编辑
          </button>
          <button>
            <Zap size={16} />
            快速访问
          </button>
          <button className="selected">
            <FolderOpen size={16} />
            我的文档
          </button>
        </nav>

        <div className="document-list">
          {matchingDocuments.map((document) => (
            <button
              key={document.id}
              className={classNames(
                "document-item",
                document.id === activeDocument.id && "active",
              )}
              onClick={() => selectDocument(document.id)}
            >
              <FileText size={16} />
              <span>{document.title}</span>
              <small>{formatTime(document.updatedAt)}</small>
            </button>
          ))}
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
          <button title="本地会员功能">
            <Star size={16} />
          </button>
          <button title="标签">
            <Tag size={16} />
          </button>
          <button title="iCloud 备份" onClick={backupToCloud}>
            <Cloud size={16} />
          </button>
          <button title="回收站">
            <Trash2 size={16} />
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
                onClick={() => setMode("outline")}
              >
                <LayoutList size={16} />
                大纲
              </button>
              <button
                className={mode === "mindmap" ? "selected" : ""}
                onClick={() => setMode("mindmap")}
              >
                <Brain size={16} />
                脑图
              </button>
              <button
                className={mode === "presentation" ? "selected" : ""}
                onClick={() => setMode("presentation")}
              >
                <Presentation size={16} />
                演示
              </button>
            </div>

            <button className="icon-button" onClick={duplicateDocument} title="复制文档">
              <Copy size={17} />
            </button>
            <button className="icon-button danger" onClick={deleteDocument} title="删除文档">
              <Trash2 size={17} />
            </button>
          </div>
        </header>

        <div className="toolstrip">
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
          <button onClick={() => exportActive("markdown")}>
            <Download size={16} />
            Markdown
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

        <div className="content">
          <section className="editor-pane">
            {selectedTag && (
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
              />
            )}

            {mode === "mindmap" && (
              <MindMap
                title={focusNode?.text || activeDocument.title}
                nodes={visibleNodes}
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
              />
            )}

            {mode === "presentation" && (
              <PresentationView
                title={focusNode?.text || activeDocument.title}
                nodes={visibleNodes}
                onSelect={setActiveNodeId}
              />
            )}
          </section>

          <aside className="inspector">
            <section>
              <div className="section-title">节点详情</div>
              {activeNode ? (
                <>
                  <label className="field">
                    <span>备注</span>
                    <textarea
                      value={activeNode.note}
                      onChange={(event) =>
                        handleNodePatch(activeNode.id, { note: event.target.value })
                      }
                      placeholder="补充说明、行动项或引用..."
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
        </div>
      </section>

      <input
        ref={fileInputRef}
        className="hidden-input"
        type="file"
        accept=".json,.md,.markdown,.opml,.xml,.mm"
        onChange={handleImport}
      />
    </main>
  );
}

interface OutlineViewProps {
  nodes: OutlineNode[];
  activeNodeId: string | null;
  setNodeRef: (id: string, element: HTMLInputElement | null) => void;
  onSelect: (id: string) => void;
  onText: (id: string, text: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>, node: OutlineNode) => void;
  onPatch: (id: string, patch: Partial<OutlineNode>) => void;
  onInsertAfter: (id: string) => void;
  onInsertChild: (id: string) => void;
  onRemove: (id: string) => void;
  onCopyLink: (id: string) => void;
  onExportNode: (id: string) => void;
}

function OutlineView(props: OutlineViewProps) {
  const rows = flattenNodes(props.nodes, { respectCollapsed: true });
  const [menuState, setMenuState] = useState<{
    nodeId: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (!menuState) return;
    const close = () => setMenuState(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("resize", close);
    };
  }, [menuState]);

  const menuNode = menuState
    ? rows.find((row) => row.node.id === menuState.nodeId)?.node ?? null
    : null;

  const closeMenu = () => setMenuState(null);
  const patchFromMenu = (patch: Partial<OutlineNode>) => {
    if (!menuState) return;
    props.onPatch(menuState.nodeId, patch);
    closeMenu();
  };

  return (
    <div className="outline-list">
      {rows.map(({ node, depth }) => (
        <div
          key={node.id}
          className={classNames(
            "outline-row",
            props.activeNodeId === node.id && "active",
            `node-${normalizeColor(node.color)}`,
            `heading-${node.headingLevel ?? 0}`,
            node.highlight && "is-highlighted",
          )}
          style={{ "--depth": depth } as React.CSSProperties}
          onClick={() => props.onSelect(node.id)}
        >
          <button
            className="disclosure"
            onClick={(event) => {
              event.stopPropagation();
              props.onPatch(node.id, { collapsed: !node.collapsed });
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
            className="check-button"
            onClick={(event) => {
              event.stopPropagation();
              props.onSelect(node.id);
              const rect = event.currentTarget.getBoundingClientRect();
              setMenuState({
                nodeId: node.id,
                x: rect.left + rect.width / 2,
                y: rect.bottom + 8,
              });
            }}
            title="主题操作"
          >
            {node.checked ? <CheckCircle2 size={17} /> : <Circle size={17} />}
          </button>

          <div className="outline-text-cell">
            {node.icon && <span className="node-icon">{node.icon}</span>}
            <input
              ref={(element) => props.setNodeRef(node.id, element)}
              value={node.text}
              className={classNames(
                node.checked && "checked",
                node.bold && "is-bold",
                node.italic && "is-italic",
                node.underline && "is-underline",
                node.strike && "is-strike",
              )}
              onChange={(event) => props.onText(node.id, event.target.value)}
              onKeyDown={(event) => props.onKeyDown(event, node)}
              onFocus={() => props.onSelect(node.id)}
              placeholder="输入主题"
            />
            {node.imageName && (
              <span className="node-attachment">
                <Image size={13} />
                {node.imageName}
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
            {extractTags(node.text).map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
            {extractLinks(node.text).map((link) => (
              <span key={link}>[[{link}]]</span>
            ))}
          </div>

          <div className="row-actions">
            <button onClick={() => props.onInsertAfter(node.id)} title="新增同级">
              <Plus size={15} />
            </button>
            <button onClick={() => props.onInsertChild(node.id)} title="新增子级">
              <Indent size={15} />
            </button>
            <button onClick={() => props.onRemove(node.id)} title="删除">
              <Trash2 size={15} />
            </button>
          </div>
        </div>
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
            })
          }
        >
          <Image size={19} />
          <span>{node.imageName ? "移除图片" : "添加图片"}</span>
        </button>
        <button className="node-menu-row" onClick={() => onPatch({ checked: !node.checked })}>
          <CheckCircle2 size={19} />
          <span>{node.checked ? "取消待办" : "添加待办"}</span>
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
}: MindMapProps) {
  const mapRootId = "__local_outline_mindmap_root__";
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
  }, [layout.width, layout.height]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("resize", close);
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

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
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

  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
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
  const setMapNodeText = (id: string, text: string) => {
    const cleanText = text.replace(/\r?\n/g, " ");
    if (isRootNode(id)) {
      onTitle(cleanText || "未命名文档");
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
      className={classNames("mindmap-scroll", dragging && "dragging")}
      onWheel={handleWheel}
      onPointerDown={startPan}
      onPointerMove={pan}
      onPointerUp={endPan}
      onPointerCancel={endPan}
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
              d={`M ${edge.from.x + edge.from.width} ${edge.from.y + edge.from.height / 2} C ${
                edge.from.x + edge.from.width + 52
              } ${edge.from.y + edge.from.height / 2}, ${edge.to.x - 52} ${
                edge.to.y + edge.to.height / 2
              }, ${edge.to.x} ${edge.to.y + edge.to.height / 2}`}
            />
          ))}
          {layout.items.map((item) => (
            <foreignObject
              key={item.node.id}
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
                  activeNodeId === item.node.id && "active",
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
                    {!isRootNode(item.node.id) && (
                      <button
                        className="map-node-add"
                        title="新增下级主题"
                        onClick={(event) => {
                          event.stopPropagation();
                          onInsertChild(item.node.id);
                        }}
                        onPointerDown={(event) => event.stopPropagation()}
                      >
                        <Plus size={18} />
                      </button>
                    )}
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
            if (!isRootNode(contextItem.node.id)) onInsertChild(contextItem.node.id);
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
            if (!isRootNode(contextItem.node.id)) onPasteNode(contextItem.node.id);
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
      onContextMenu={(event) => event.preventDefault()}
    >
      <button disabled={isRoot} onClick={onInsertAfter}>
        <span>插入同级主题</span>
        <kbd>Enter</kbd>
      </button>
      <button disabled={isRoot} onClick={onInsertChild}>
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
      <button disabled={isRoot || !canPaste} onClick={onPaste}>
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

const splitMindMapLines = (value: string, maxChars = 15) => {
  const text = value.trim() || "输入文字";
  const chars = Array.from(text);
  const lines: string[] = [];
  for (let index = 0; index < chars.length; index += maxChars) {
    lines.push(chars.slice(index, index + maxChars).join(""));
  }
  return lines.length ? lines : ["输入文字"];
};

const mindMapMetrics = (node: OutlineNode, depth: number) => {
  const lines = splitMindMapLines(`${node.icon ? `${node.icon} ` : ""}${node.text || "输入文字"}`);
  const width = depth === 0 ? 220 : 236;
  const minHeight = depth === 0 ? 58 : 52;
  const height = Math.max(minHeight, lines.length * 19 + 22);
  return { lines, width, height };
};

function createMindMapLayout(nodes: OutlineNode[]) {
  const items: MindMapItem[] = [];
  const xGap = 260;
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
  const rows = flattenNodes(nodes, { respectCollapsed: true });
  return (
    <div className="presentation-view">
      <h1>{title}</h1>
      <div className="slide-outline">
        {rows.map((row) => (
          <button
            key={row.node.id}
            style={{ "--depth": row.depth } as React.CSSProperties}
            onClick={() => onSelect(row.node.id)}
            className={row.node.checked ? "checked" : ""}
          >
            <span>{row.node.text || "未命名主题"}</span>
            {row.node.note && <small>{row.node.note}</small>}
          </button>
        ))}
      </div>
    </div>
  );
}

export default App;
