import type { OutlineDocument, OutlineNode } from "./types";
import { createNode, uid } from "./tree";

export const DEFAULT_DOCUMENT_TITLE = "未命名文档";
export const DEFAULT_NODE_TEXT = "未命名主题";

type MarkdownParseOptions = {
  filename?: string;
  previousDocument?: OutlineDocument;
  documentId?: string;
  now?: string | (() => string);
};

type PreviousNodeEntry = {
  node: OutlineNode;
  used: boolean;
};

type NodeOverrides = Partial<
  Pick<
    OutlineNode,
    | "note"
    | "checked"
    | "headingLevel"
    | "imageName"
    | "imageAlt"
    | "table"
    | "codeBlock"
    | "codeLanguage"
    | "isTodo"
  >
>;

type StackItem = {
  node: OutlineNode;
  path: number[];
};

type HeadingStackItem = StackItem & {
  markdownLevel: number;
};

type ListStackItem = StackItem & {
  indent: number;
};

type ParsedMarkdown = {
  title: string;
  hasTitle: boolean;
  nodes: OutlineNode[];
};

const nodeChildren = (node: OutlineNode) =>
  Array.isArray(node.children) ? node.children : [];

const normalizeSource = (content: string) =>
  content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

const normalizeMatchText = (value: string) =>
  unescapeMarkdownInline(value).replace(/\s+/g, " ").trim().toLowerCase();

const pathKey = (path: number[]) => path.join(".");

const appendNote = (node: OutlineNode, value: string, separator = "\n") => {
  const note = value.trim();
  if (!note) return;
  node.note = node.note ? `${node.note}${separator}${note}` : note;
};

const cloneTable = (table: string[][] | undefined) =>
  table ? table.map((row) => [...row]) : undefined;

const markdownHeadingText = (value: string) =>
  value.replace(/\s+#+\s*$/, "").trim();

const headingMatch = (line: string) => {
  const match = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*$/);
  if (!match) return null;
  return {
    level: match[1].length,
    text: unescapeMarkdownInline(markdownHeadingText(match[2])),
  };
};

const indentationWidth = (indent: string) =>
  Array.from(indent).reduce((width, char) => width + (char === "\t" ? 4 : 1), 0);

const extensionlessFilename = (filename = "") =>
  filename.replace(/\.(md|markdown)$/i, "").trim();

const resolveNow = (value: MarkdownParseOptions["now"]) =>
  typeof value === "function" ? value() : value ?? new Date().toISOString();

const createPreviousMatcher = (previousDocument?: OutlineDocument) => {
  const byPath = new Map<string, PreviousNodeEntry>();
  const byText = new Map<string, PreviousNodeEntry[]>();

  const visit = (nodes: OutlineNode[], parentPath: number[] = []) => {
    nodes.forEach((node, index) => {
      const currentPath = [...parentPath, index];
      const entry = { node, used: false };
      byPath.set(pathKey(currentPath), entry);

      const key = normalizeMatchText(node.text);
      if (key) {
        const entries = byText.get(key) ?? [];
        entries.push(entry);
        byText.set(key, entries);
      }

      visit(nodeChildren(node), currentPath);
    });
  };

  visit(previousDocument?.nodes ?? []);

  return (path: number[], text: string) => {
    const key = normalizeMatchText(text);
    const pathEntry = byPath.get(pathKey(path));
    if (
      pathEntry &&
      !pathEntry.used &&
      normalizeMatchText(pathEntry.node.text) === key
    ) {
      pathEntry.used = true;
      return pathEntry.node;
    }

    const textEntry = byText.get(key)?.find((entry) => !entry.used);
    if (textEntry) {
      textEntry.used = true;
      return textEntry.node;
    }

    return undefined;
  };
};

const makeNodeFactory = (previousDocument?: OutlineDocument) => {
  const matchPrevious = createPreviousMatcher(previousDocument);

  return (text: string, path: number[], overrides: NodeOverrides = {}) => {
    const normalizedText = text.trim() || DEFAULT_NODE_TEXT;
    const previousNode = matchPrevious(path, normalizedText);
    const base = previousNode ?? createNode(normalizedText);

    const node: OutlineNode = {
      ...base,
      id: base.id,
      text: normalizedText,
      note: overrides.note ?? "",
      checked: overrides.checked ?? false,
      collapsed: previousNode?.collapsed ?? base.collapsed,
      color: previousNode?.color ?? base.color,
      headingLevel: overrides.headingLevel ?? 0,
      bold: previousNode?.bold,
      italic: previousNode?.italic,
      underline: previousNode?.underline,
      strike: previousNode?.strike,
      highlight: previousNode?.highlight,
      icon: previousNode?.icon,
      imageName: overrides.imageName,
      imageAlt: overrides.imageAlt,
      table: overrides.table ? cloneTable(overrides.table) : undefined,
      codeBlock:
        typeof overrides.codeBlock === "string"
          ? overrides.codeBlock.replace(/\r\n?/g, "\n")
          : undefined,
      codeLanguage:
        typeof overrides.codeLanguage === "string" && overrides.codeLanguage.trim()
          ? overrides.codeLanguage.trim()
          : undefined,
      isTodo: overrides.isTodo ?? false,
      children: [],
    };

    return node;
  };
};

export const markdownInlineForExport = (value: string) => {
  const inline = value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  const text = inline || DEFAULT_NODE_TEXT;
  return text.replace(/([\\`*_[\]{}()#+\-.!>])/g, "\\$1");
};

const markdownNoteForExport = (value: string, indent = "") =>
  value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `${indent}> ${line}`)
    .join("\n");

const markdownCodeFenceForExport = (code: string) => {
  let longestRun = 0;
  let currentRun = 0;
  Array.from(code).forEach((character) => {
    if (character === "`") {
      currentRun += 1;
      longestRun = Math.max(longestRun, currentRun);
    } else {
      currentRun = 0;
    }
  });
  return "`".repeat(Math.max(3, longestRun + 1));
};

const markdownCodeForExport = (value: string, language = "", indent = "") => {
  const code = value.replace(/\r\n?/g, "\n");
  const fence = markdownCodeFenceForExport(code);
  const info = language.trim().replace(/[`~\s].*$/, "");
  return [
    `${indent}${fence}${info}`,
    ...code.split("\n").map((line) => `${indent}${line}`),
    `${indent}${fence}`,
  ].join("\n");
};

const markdownTableCellForExport = (value: string) =>
  markdownInlineForExport(value).replace(/\|/g, "\\|");

const tableToMarkdown = (table: string[][], indent = "") => {
  const rows = table.filter((row) => row.length);
  if (!rows.length) return [];

  const columnCount = Math.max(...rows.map((row) => row.length));
  const paddedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => row[index] ?? ""),
  );
  const cells = paddedRows.map((row) =>
    `${indent}| ${row.map(markdownTableCellForExport).join(" | ")} |`,
  );
  const separator = `${indent}| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`;
  return [cells[0], separator, ...cells.slice(1)];
};

const nodeToMarkdown = (
  node: OutlineNode,
  listDepth: number,
  insideList: boolean,
): string[] => {
  const lines: string[] = [];
  const text = markdownInlineForExport(node.text);
  const headingLevel = node.headingLevel ?? 0;
  const shouldWriteHeading = headingLevel > 0 && !insideList;

  if (shouldWriteHeading) {
    lines.push(`${"#".repeat(Math.min(headingLevel + 1, 6))} ${text}`);
    if (node.note) lines.push(markdownNoteForExport(node.note));
    if (node.imageName) {
      lines.push(`![${markdownInlineForExport(node.imageAlt || node.imageName)}](${node.imageName})`);
    }
    if (node.table) lines.push(...tableToMarkdown(node.table));
    if (typeof node.codeBlock === "string") {
      lines.push(markdownCodeForExport(node.codeBlock, node.codeLanguage));
    }
    nodeChildren(node).forEach((child) => {
      lines.push(...nodeToMarkdown(child, 0, false));
    });
    return lines;
  }

  const indent = "  ".repeat(listDepth);
  const marker = node.isTodo || node.checked ? `- [${node.checked ? "x" : " "}]` : "-";
  lines.push(`${indent}${marker} ${text}`);

  const childIndent = `${indent}  `;
  if (node.note) lines.push(markdownNoteForExport(node.note, childIndent));
  if (node.imageName) {
    lines.push(`${childIndent}![${markdownInlineForExport(node.imageAlt || node.imageName)}](${node.imageName})`);
  }
  if (node.table) lines.push(...tableToMarkdown(node.table, childIndent));
  if (typeof node.codeBlock === "string") {
    lines.push(markdownCodeForExport(node.codeBlock, node.codeLanguage, childIndent));
  }

  nodeChildren(node).forEach((child) => {
    lines.push(...nodeToMarkdown(child, listDepth + 1, true));
  });

  return lines;
};

export const documentToMarkdown = (document: OutlineDocument) => {
  if (typeof document.markdownSource === "string") {
    return normalizeSource(document.markdownSource);
  }
  const title = markdownInlineForExport(document.title || DEFAULT_DOCUMENT_TITLE);
  const body = document.nodes.flatMap((node) => nodeToMarkdown(node, 0, false));
  return [`# ${title}`, "", ...body].join("\n").trimEnd();
};

const unescapeMarkdownInline = (value: string) =>
  value.replace(/\\([\\`*_[\]{}()#+\-.!>])/g, "$1");

const listItemMatch = (line: string) => {
  const bullet = line.match(/^([ \t]*)([-*+])\s+(?:\[( |x|X)\]\s*)?(.*)$/);
  if (bullet) {
    return {
      indent: indentationWidth(bullet[1]),
      checked: bullet[3]?.toLowerCase() === "x",
      isTodo: bullet[3] !== undefined,
      text: unescapeMarkdownInline(bullet[4].trim()),
    };
  }

  const ordered = line.match(/^([ \t]*)(\d+[.)])\s+(?:\[( |x|X)\]\s*)?(.*)$/);
  if (!ordered) return null;

  return {
    indent: indentationWidth(ordered[1]),
    checked: ordered[3]?.toLowerCase() === "x",
    isTodo: ordered[3] !== undefined,
    text: unescapeMarkdownInline(ordered[4].trim()),
  };
};

const quoteLineMatch = (line: string) => line.match(/^([ \t]*)>\s?(.*)$/);

const imageBlockMatch = (line: string) =>
  line.match(/^([ \t]*)!\[([^\]]*)\]\(([^)]+)\)\s*$/);

const tableDelimiterLine = (line: string) =>
  /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

const isTableStart = (lines: string[], index: number) =>
  lines[index]?.includes("|") && tableDelimiterLine(lines[index + 1] ?? "");

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

const splitTableRow = (line: string) => {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return splitEscapedPipe(trimmed).map((cell) => unescapeMarkdownInline(cell.trim()));
};

const parseTable = (lines: string[], startIndex: number) => {
  const tableLines: string[] = [lines[startIndex], lines[startIndex + 1]];
  let index = startIndex + 2;

  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
    tableLines.push(lines[index]);
    index += 1;
  }

  const rows = [
    splitTableRow(tableLines[0]),
    ...tableLines.slice(2).map(splitTableRow),
  ];

  return { lines: tableLines, rows, nextIndex: index };
};

const nextSpecialBlock = (lines: string[], index: number) => {
  const line = lines[index] ?? "";
  return (
    !line.trim() ||
    headingMatch(line) ||
    listItemMatch(line) ||
    quoteLineMatch(line) ||
    imageBlockMatch(line) ||
    isTableStart(lines, index) ||
    /^\s{0,3}(```|~~~)/.test(line)
  );
};

const parseMarkdown = (
  content: string,
  previousDocument?: OutlineDocument,
): ParsedMarkdown => {
  const lines = normalizeSource(content).split("\n");
  const roots: OutlineNode[] = [];
  const headingStack: HeadingStackItem[] = [];
  const listStack: ListStackItem[] = [];
  const createParsedNode = makeNodeFactory(previousDocument);
  let title = DEFAULT_DOCUMENT_TITLE;
  let hasTitle = false;
  let lastNode: OutlineNode | null = null;

  const currentParent = (): StackItem | undefined =>
    listStack[listStack.length - 1] ?? headingStack[headingStack.length - 1];

  const addNode = (text: string, overrides: NodeOverrides = {}) => {
    const parent = currentParent();
    const siblings = parent ? parent.node.children : roots;
    const path = parent ? [...parent.path, siblings.length] : [siblings.length];
    const node = createParsedNode(text, path, overrides);
    siblings.push(node);
    lastNode = node;
    return { node, path };
  };

  const attachOrCreateBlock = (
    text: string,
    note: string,
    overrides: NodeOverrides = {},
    preferNote = false,
  ) => {
    if (preferNote && lastNode) {
      appendNote(lastNode, note || text);
      return;
    }
    listStack.length = 0;
    const block = addNode(text, { ...overrides, note });
    lastNode = block.node;
  };

  const attachTable = (table: ReturnType<typeof parseTable>) => {
    if (lastNode) {
      lastNode.table = cloneTable(table.rows);
      return;
    }
    const tableTitle = table.rows[0]?.filter(Boolean).join(" / ") || "表格";
    attachOrCreateBlock(`表格：${tableTitle}`, table.lines.join("\n"), { table: table.rows });
  };

  const attachImage = (alt: string, source: string) => {
    if (lastNode) {
      lastNode.imageName = source;
      lastNode.imageAlt = alt || undefined;
      return;
    }
    attachOrCreateBlock(`图片：${alt || source || DEFAULT_NODE_TEXT}`, source, {
      imageName: source,
      imageAlt: alt || undefined,
    });
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = headingMatch(line);
    if (heading) {
      if (heading.level === 1) {
        if (!hasTitle && heading.text) {
          title = heading.text;
          hasTitle = true;
          index += 1;
          continue;
        }
      }

      const markdownLevel = heading.level;
      while (
        headingStack.length &&
        headingStack[headingStack.length - 1].markdownLevel >= markdownLevel
      ) {
        headingStack.pop();
      }
      listStack.length = 0;

      const parent = headingStack[headingStack.length - 1];
      const siblings = parent ? parent.node.children : roots;
      const path = parent ? [...parent.path, siblings.length] : [siblings.length];
      const node = createParsedNode(heading.text, path, {
        headingLevel: Math.min(Math.max(markdownLevel - 1, 1), 3) as 1 | 2 | 3,
      });
      siblings.push(node);
      headingStack.push({ node, path, markdownLevel });
      lastNode = node;
      index += 1;
      continue;
    }

    const listItem = listItemMatch(line);
    if (listItem) {
      while (
        listStack.length &&
        listStack[listStack.length - 1].indent >= listItem.indent
      ) {
        listStack.pop();
      }

      const parent = currentParent();
      const siblings = parent ? parent.node.children : roots;
      const path = parent ? [...parent.path, siblings.length] : [siblings.length];
      const node = createParsedNode(listItem.text, path, {
        checked: listItem.isTodo ? listItem.checked : false,
        isTodo: listItem.isTodo,
      });
      siblings.push(node);
      listStack.push({ node, path, indent: listItem.indent });
      lastNode = node;
      index += 1;
      continue;
    }

    const quote = quoteLineMatch(line);
    if (quote) {
      const quoteLines: string[] = [];
      let quoteIndex = index;
      while (quoteIndex < lines.length) {
        const currentQuote = quoteLineMatch(lines[quoteIndex]);
        if (!currentQuote) break;
        quoteLines.push(currentQuote[2]);
        quoteIndex += 1;
      }
      const note = quoteLines.join("\n").trim();
      if (lastNode) {
        appendNote(lastNode, note, "\n\n");
      } else {
        attachOrCreateBlock(`引用：${note.split("\n")[0] || DEFAULT_NODE_TEXT}`, note);
      }
      index = quoteIndex;
      continue;
    }

    const fence = line.match(/^([ \t]*)(```+|~~~+)\s*(.*)$/);
    if (fence) {
      const fenceIndent = fence[1];
      const marker = fence[2];
      const language = fence[3].trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith(marker)) {
        const codeLine = lines[index];
        codeLines.push(codeLine.startsWith(fenceIndent) ? codeLine.slice(fenceIndent.length) : codeLine);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const label = language ? `代码块：${language}` : "代码块";
      const codeBlock = codeLines.join("\n");
      if (listStack.length && lastNode) {
        lastNode.codeBlock = codeBlock;
        lastNode.codeLanguage = language || undefined;
      } else {
        attachOrCreateBlock(label, "", { codeBlock, codeLanguage: language || undefined });
      }
      continue;
    }

    if (isTableStart(lines, index)) {
      const table = parseTable(lines, index);
      attachTable(table);
      index = table.nextIndex;
      continue;
    }

    const image = imageBlockMatch(line);
    if (image) {
      const alt = unescapeMarkdownInline(image[2].trim());
      const source = image[3].trim();
      attachImage(alt, source);
      index += 1;
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && !nextSpecialBlock(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }

    const paragraph = unescapeMarkdownInline(paragraphLines.join(" ").trim());
    if (paragraph) {
      const indentedUnderList =
        listStack.length > 0 &&
        indentationWidth(lines[index - paragraphLines.length]?.match(/^([ \t]*)/)?.[1] ?? "") >
          listStack[listStack.length - 1].indent;
      attachOrCreateBlock(paragraph, "", {}, indentedUnderList);
    }
  }

  return {
    title,
    hasTitle,
    nodes: roots.length ? roots : [createParsedNode(DEFAULT_NODE_TEXT, [0])],
  };
};

export const parseMarkdownToNodes = (
  content: string,
  previousDocument?: OutlineDocument,
) => {
  const parsed = parseMarkdown(content, previousDocument);
  return {
    title: parsed.title,
    nodes: parsed.nodes,
  };
};

export const parseMarkdownDocument = (
  content: string,
  options: MarkdownParseOptions = {},
): OutlineDocument => {
  const now = resolveNow(options.now);
  const previousDocument = options.previousDocument;
  const parsed = parseMarkdown(content, previousDocument);
  const filenameTitle =
    extensionlessFilename(options.filename) || previousDocument?.title || DEFAULT_DOCUMENT_TITLE;
  const title = parsed.hasTitle ? parsed.title : filenameTitle;

  return {
    id: options.documentId ?? previousDocument?.id ?? uid(),
    title,
    createdAt: previousDocument?.createdAt ?? now,
    updatedAt: now,
    markdownSource: normalizeSource(content),
    markdownUpdatedAt: now,
    nodes: parsed.nodes,
  };
};
