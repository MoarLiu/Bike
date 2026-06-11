import type { PDFFont, PDFPage, RGB } from "pdf-lib";
import type { OutlineDocument, OutlineNode, Workspace } from "./types";
import { migrateDocument, migrateWorkspace } from "./migrations";
import { createNode, normalizeColor } from "./tree";
import {
  DEFAULT_DOCUMENT_TITLE,
  DEFAULT_NODE_TEXT,
  documentToMarkdown,
  parseMarkdownDocument,
} from "./markdown";
import pdfFontUrl from "./assets/NotoSansSC-ChineseSimplified.ttf?url";

const escapeXml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const documentTitle = (document: OutlineDocument) =>
  document.title || DEFAULT_DOCUMENT_TITLE;

const nodeText = (node: OutlineNode) => node.text || DEFAULT_NODE_TEXT;

const nodeNote = (node: OutlineNode) => node.note || "";

const nodeChildren = (node: OutlineNode) =>
  Array.isArray(node.children) ? node.children : [];

const normalizeHeadingLevel = (value: string | null): OutlineNode["headingLevel"] => {
  if (value === "1" || value === "2" || value === "3") return Number(value) as 1 | 2 | 3;
  return 0;
};

const parseOpmlTable = (value: string | null) => {
  if (!value) return undefined;
  try {
    const table = JSON.parse(value);
    if (!Array.isArray(table)) return undefined;
    return table
      .filter(Array.isArray)
      .map((row) => row.map((cell) => (typeof cell === "string" ? cell : "")));
  } catch {
    return undefined;
  }
};

type RgbFactory = (red: number, green: number, blue: number) => RGB;

const colorToRgb = (color: string, rgb: RgbFactory) => {
  if (color === "blue") return rgb(0.23, 0.45, 0.68);
  if (color === "green") return rgb(0.25, 0.5, 0.31);
  if (color === "amber") return rgb(0.66, 0.44, 0.13);
  if (color === "rose") return rgb(0.71, 0.33, 0.38);
  return rgb(0.12, 0.12, 0.13);
};

const sanitizeFilenameBase = (value: string) => {
  const sanitized = value
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

const exportFilename = (title: string, extension: string) =>
  `${sanitizeFilenameBase(title || DEFAULT_DOCUMENT_TITLE)}.${extension}`;

const opmlOptionalAttrs = (attrs: Record<string, string | number | boolean | undefined>) =>
  Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== "" && value !== false)
    .map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`)
    .join("");

const opmlNode = (node: OutlineNode, depth = 2): string => {
  const pad = "  ".repeat(depth);
  const attrs = `text="${escapeXml(nodeText(node))}" _note="${escapeXml(
    nodeNote(node),
  )}" _checked="${node.checked ? "true" : "false"}"${opmlOptionalAttrs({
    _isTodo: node.isTodo,
    _collapsed: node.collapsed,
    _color: node.color && node.color !== "plain" ? node.color : undefined,
    _headingLevel: node.headingLevel,
    _bold: node.bold,
    _italic: node.italic,
    _underline: node.underline,
    _strike: node.strike,
    _highlight: node.highlight,
    _icon: node.icon,
    _imageName: node.imageName,
    _imageAlt: node.imageAlt,
    _table: node.table ? JSON.stringify(node.table) : undefined,
    _codeLanguage: node.codeLanguage,
    _codeBlock: node.codeBlock,
  })}`;
  const children = nodeChildren(node);
  if (!children.length) return `${pad}<outline ${attrs}/>`;
  return [
    `${pad}<outline ${attrs}>`,
    ...children.map((child) => opmlNode(child, depth + 1)),
    `${pad}</outline>`,
  ].join("\n");
};

const freemindNode = (node: OutlineNode, depth = 1): string => {
  const pad = "  ".repeat(depth);
  const children = nodeChildren(node);
  if (!children.length) return `${pad}<node TEXT="${escapeXml(nodeText(node))}"/>`;
  return [
    `${pad}<node TEXT="${escapeXml(nodeText(node))}">`,
    ...children.map((child) => freemindNode(child, depth + 1)),
    `${pad}</node>`,
  ].join("\n");
};

const htmlNode = (node: OutlineNode): string => {
  const children = nodeChildren(node);
  const childHtml = children.length
    ? `<ul>${children.map(htmlNode).join("")}</ul>`
    : "";
  const checked = node.checked ? " data-checked=\"true\"" : "";
  const note = nodeNote(node) ? `<p>${escapeXml(nodeNote(node))}</p>` : "";
  return `<li${checked}><span>${escapeXml(nodeText(node))}</span>${note}${childHtml}</li>`;
};

const printableNode = (node: OutlineNode): string => {
  const children = nodeChildren(node);
  const checked = node.checked ? `<span class="check">✓</span>` : "";
  const note = nodeNote(node)
    ? `<p class="note">${escapeXml(nodeNote(node)).replace(/\n/g, "<br>")}</p>`
    : "";
  const childHtml = children.length
    ? `<ul>${children.map(printableNode).join("")}</ul>`
    : "";
  return `<li><div class="topic">${checked}<span>${escapeXml(nodeText(node))}</span></div>${note}${childHtml}</li>`;
};

const printableDocument = (outlineDocument: OutlineDocument) => {
  const title = documentTitle(outlineDocument);
  return [
    `<!doctype html>`,
    `<html lang="zh-CN">`,
    `<head>`,
    `<meta charset="UTF-8">`,
    `<title>${escapeXml(title)}.pdf</title>`,
    `<style>`,
    `@page { margin: 18mm 16mm; }`,
    `* { box-sizing: border-box; }`,
    `body { margin: 0; color: #1d1d1f; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; font-size: 13px; line-height: 1.55; }`,
    `main { max-width: 760px; margin: 0 auto; }`,
    `h1 { margin: 0 0 22px; font-size: 28px; line-height: 1.2; }`,
    `ul { margin: 0; padding-left: 22px; list-style: disc; }`,
    `li { margin: 8px 0; break-inside: avoid; }`,
    `.topic { display: inline-flex; gap: 6px; align-items: baseline; }`,
    `.check { color: #6b4fd7; font-weight: 700; }`,
    `.note { margin: 5px 0 0; padding-left: 10px; color: #6f6f74; border-left: 2px solid #ecebea; }`,
    `</style>`,
    `</head>`,
    `<body><main><h1>${escapeXml(title)}</h1><ul>${outlineDocument.nodes
      .map(printableNode)
      .join("")}</ul></main></body>`,
    `</html>`,
  ].join("");
};

export const exportDocument = (
  document: OutlineDocument,
  format: "json" | "markdown" | "opml" | "freemind" | "html",
) => {
  const title = documentTitle(document);

  if (format === "json") {
    return {
      filename: exportFilename(title, "json"),
      mime: "application/json",
      content: JSON.stringify(document, null, 2),
    };
  }

  if (format === "markdown") {
    return {
      filename: exportFilename(title, "md"),
      mime: "text/markdown",
      content: documentToMarkdown(document),
    };
  }

  if (format === "opml") {
    return {
      filename: exportFilename(title, "opml"),
      mime: "text/x-opml",
      content: [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<opml version="2.0">`,
        `  <head><title>${escapeXml(title)}</title></head>`,
        `  <body>`,
        ...document.nodes.map((node) => opmlNode(node, 2)),
        `  </body>`,
        `</opml>`,
      ].join("\n"),
    };
  }

  if (format === "freemind") {
    return {
      filename: exportFilename(title, "mm"),
      mime: "application/xml",
      content: [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<map version="1.0.1">`,
        `  <node TEXT="${escapeXml(title)}">`,
        ...document.nodes.map((node) => freemindNode(node, 2)),
        `  </node>`,
        `</map>`,
      ].join("\n"),
    };
  }

  return {
    filename: exportFilename(title, "html"),
    mime: "text/html",
    content: [
      `<!doctype html>`,
      `<html lang="zh-CN">`,
      `<head><meta charset="UTF-8"><title>${escapeXml(title)}</title></head>`,
      `<body><h1>${escapeXml(title)}</h1><ul>${document.nodes.map(htmlNode).join("")}</ul></body>`,
      `</html>`,
    ].join(""),
  };
};

export const exportWorkspace = (workspace: Workspace) => ({
  filename: "bike-workspace.json",
  mime: "application/json",
  content: JSON.stringify(workspace, null, 2),
});

export const downloadText = (filename: string, content: string, mime: string) => {
  const blob = new Blob([content], { type: mime });
  downloadBlob(filename, blob);
};

export const downloadBlob = (filename: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

const pdfText = (value: string) =>
  value.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").trim();

const wrapPdfText = (
  value: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number,
) => {
  const paragraphs = pdfText(value).split("\n");
  const lines: string[] = [];

  paragraphs.forEach((paragraph) => {
    if (!paragraph) {
      lines.push("");
      return;
    }

    let line = "";
    Array.from(paragraph).forEach((char) => {
      const next = `${line}${char}`;
      if (line && font.widthOfTextAtSize(next, fontSize) > maxWidth) {
        lines.push(line);
        line = char;
        return;
      }
      line = next;
    });
    lines.push(line);
  });

  return lines.length ? lines : [DEFAULT_NODE_TEXT];
};

const nodePdfFontSize = (node: OutlineNode, depth: number) => {
  if (node.headingLevel === 1) return 17;
  if (node.headingLevel === 2) return 15;
  if (node.headingLevel === 3) return 13;
  if (depth === 0) return 13;
  if (depth === 1) return 12;
  return 11;
};

export const exportDocumentAsPdf = async (outlineDocument: OutlineDocument) => {
  const [{ PDFDocument, rgb }, fontkitModule] = await Promise.all([
    import("pdf-lib"),
    import("@pdf-lib/fontkit"),
  ]);
  const fontkit = fontkitModule.default;
  const filename = exportFilename(documentTitle(outlineDocument), "pdf");
  const pdfDocument = await PDFDocument.create();
  pdfDocument.registerFontkit(fontkit);
  const fontBytes = await fetch(pdfFontUrl).then((response) => {
    if (!response.ok) throw new Error("无法加载 PDF 中文字体");
    return response.arrayBuffer();
  });
  const font = await pdfDocument.embedFont(fontBytes, { subset: true });

  const pageSize = { width: 595.28, height: 841.89 };
  const margin = { top: 56, right: 52, bottom: 54, left: 52 };
  let page = pdfDocument.addPage([pageSize.width, pageSize.height]);
  let y = pageSize.height - margin.top;

  const addPage = () => {
    page = pdfDocument.addPage([pageSize.width, pageSize.height]);
    y = pageSize.height - margin.top;
  };

  const ensureSpace = (height: number) => {
    if (y - height < margin.bottom) addPage();
  };

  const drawLines = (
    lines: string[],
    options: {
      x: number;
      fontSize: number;
      lineHeight: number;
      color: ReturnType<typeof rgb>;
      pageRef?: PDFPage;
    },
  ) => {
    lines.forEach((line) => {
      ensureSpace(options.lineHeight);
      const targetPage = options.pageRef ?? page;
      targetPage.drawText(line, {
        x: options.x,
        y: y - options.fontSize,
        size: options.fontSize,
        font,
        color: options.color,
      });
      y -= options.lineHeight;
    });
  };

  const titleFontSize = 24;
  const titleLines = wrapPdfText(
    documentTitle(outlineDocument),
    font,
    titleFontSize,
    pageSize.width - margin.left - margin.right,
  );
  drawLines(titleLines, {
    x: margin.left,
    fontSize: titleFontSize,
    lineHeight: 32,
    color: rgb(0.08, 0.08, 0.09),
  });
  y -= 14;

  const drawNode = (node: OutlineNode, depth: number) => {
    const indent = depth * 18;
    const x = margin.left + indent;
    const bullet = node.checked ? "☑" : "•";
    const icon = node.icon ? `${node.icon} ` : "";
    const text = `${bullet} ${icon}${nodeText(node)}`;
    const fontSize = nodePdfFontSize(node, depth);
    const lineHeight = fontSize + 6;
    const maxWidth = pageSize.width - margin.right - x;
    const lines = wrapPdfText(text, font, fontSize, maxWidth);
    ensureSpace(lines.length * lineHeight + 6);
    drawLines(lines, {
      x,
      fontSize,
      lineHeight,
      color: colorToRgb(node.color, rgb),
    });

    if (nodeNote(node)) {
      const noteLines = wrapPdfText(
        `备注：${nodeNote(node)}`,
        font,
        9.5,
        pageSize.width - margin.right - x - 16,
      );
      drawLines(noteLines, {
        x: x + 16,
        fontSize: 9.5,
        lineHeight: 14,
        color: rgb(0.42, 0.42, 0.46),
      });
    }

    if (node.imageName || node.table) {
      const attachments = [
        node.imageName ? `图片：${node.imageName}` : "",
        node.table ? `表格：${node.table.map((row) => row.join(" | ")).join(" / ")}` : "",
      ]
        .filter(Boolean)
        .join("  ");
      drawLines(wrapPdfText(attachments, font, 9.5, maxWidth - 16), {
        x: x + 16,
        fontSize: 9.5,
        lineHeight: 14,
        color: rgb(0.38, 0.38, 0.42),
      });
    }

    y -= depth === 0 ? 5 : 2;
    nodeChildren(node).forEach((child) => drawNode(child, depth + 1));
  };

  outlineDocument.nodes.forEach((node) => drawNode(node, 0));

  const pageCount = pdfDocument.getPageCount();
  pdfDocument.getPages().forEach((pdfPage, index) => {
    const footer = `${index + 1} / ${pageCount}`;
    pdfPage.drawText(footer, {
      x:
        pageSize.width -
        margin.right -
        font.widthOfTextAtSize(footer, 9),
      y: 24,
      size: 9,
      font,
      color: rgb(0.55, 0.55, 0.58),
    });
  });

  const pdfBytes = await pdfDocument.save();
  const pdfBuffer = new ArrayBuffer(pdfBytes.byteLength);
  new Uint8Array(pdfBuffer).set(pdfBytes);
  downloadBlob(filename, new Blob([pdfBuffer], { type: "application/pdf" }));
  return filename;
};

const parseOutlineElement = (element: Element): OutlineNode => ({
  ...createNode(element.getAttribute("text") || element.getAttribute("title") || "未命名主题"),
  note: element.getAttribute("_note") || "",
  checked: element.getAttribute("_checked") === "true",
  collapsed: element.getAttribute("_collapsed") === "true",
  color: normalizeColor(element.getAttribute("_color") || "plain"),
  headingLevel: normalizeHeadingLevel(element.getAttribute("_headingLevel")),
  bold: element.getAttribute("_bold") === "true",
  italic: element.getAttribute("_italic") === "true",
  underline: element.getAttribute("_underline") === "true",
  strike: element.getAttribute("_strike") === "true",
  highlight: element.getAttribute("_highlight") === "true",
  isTodo: element.getAttribute("_isTodo") === "true",
  icon: element.getAttribute("_icon") || undefined,
  imageName: element.getAttribute("_imageName") || undefined,
  imageAlt: element.getAttribute("_imageAlt") || undefined,
  table: parseOpmlTable(element.getAttribute("_table")),
  codeLanguage: element.getAttribute("_codeLanguage") || undefined,
  codeBlock: element.getAttribute("_codeBlock") || undefined,
  children: Array.from(element.children)
    .filter((child) => child.tagName.toLowerCase() === "outline")
    .map(parseOutlineElement),
});

const parseFreeMindElement = (element: Element): OutlineNode => ({
  ...createNode(element.getAttribute("TEXT") || element.getAttribute("text") || "未命名主题"),
  children: Array.from(element.children)
    .filter((child) => child.tagName.toLowerCase() === "node")
    .map(parseFreeMindElement),
});

export const importDocument = (content: string, filename: string): OutlineDocument | Workspace => {
  const now = new Date().toISOString();
  const lowerFilename = filename.toLowerCase();

  if (lowerFilename.endsWith(".json")) {
    const parsed = JSON.parse(content) as Workspace | OutlineDocument;
    if ("documents" in parsed) return migrateWorkspace(parsed);
    return migrateDocument({
      ...parsed,
      id: crypto.randomUUID(),
      updatedAt: now,
    });
  }

  if (/\.(md|markdown)$/i.test(filename)) {
    return parseMarkdownDocument(content, { filename });
  }

  const parser = new DOMParser();
  const xml = parser.parseFromString(content, "application/xml");
  const error = xml.querySelector("parsererror");
  if (error) throw new Error("无法解析导入文件");

  if (lowerFilename.endsWith(".mm")) {
    const root = xml.getElementsByTagName("node")[0];
    const title = root?.getAttribute("TEXT") || root?.getAttribute("text") || filename.replace(/\.mm$/, "");
    const nodes = root
      ? Array.from(root.children)
          .filter((child) => child.tagName.toLowerCase() === "node")
          .map(parseFreeMindElement)
      : [createNode("未命名主题")];
    return {
      id: crypto.randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      nodes,
    };
  }

  const title =
    xml.querySelector("head > title")?.textContent?.trim() ||
    filename.replace(/\.(opml|xml)$/i, "");
  const body = xml.getElementsByTagName("body")[0];
  const nodes = body
    ? Array.from(body.children)
        .filter((child) => child.tagName.toLowerCase() === "outline")
        .map(parseOutlineElement)
    : [createNode("未命名主题")];

  return {
    id: crypto.randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    nodes,
  };
};
