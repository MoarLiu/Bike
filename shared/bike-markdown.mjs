// Canonical Markdown parser/exporter shared by the renderer and MCP.
const uid = () => createId("node");
const createNode = (text = "") => ({ id: uid(), text, note: "", checked: false, collapsed: false, color: "plain", children: [] });
import { codeMask, createId, scanLinks } from "./bike-knowledge.mjs";
import { assertTextBudget, assertTreeBudget, MAX_DOCUMENT_NODES } from "./bike-limits.mjs";
export const DEFAULT_DOCUMENT_TITLE = "未命名文档";
export const DEFAULT_NODE_TEXT = "未命名主题";
const nodeChildren = (node) => Array.isArray(node.children) ? node.children : [];
const normalizeSource = (content) => content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
export const markdownSourceMap = (content) => {
    let text = "";
    const offsets = [];
    for (let i = content.charCodeAt(0) === 0xfeff ? 1 : 0; i < content.length; i++) {
        offsets.push(i);
        if (content[i] === "\r") { text += "\n"; if (content[i + 1] === "\n") i++; }
        else text += content[i];
    }
    offsets.push(content.length);
    return { text, offsets };
};
export const markdownPlainText = (value) => value.replace(/\\([\\`*_[\]{}()#+\-.!>|])/gu, "$1");
export const markdownTableCells = (row) => {
    const cells = [];
    let start = 0, end = row.length;
    while (start < end && /\s/u.test(row[start])) start++;
    while (end > start && /\s/u.test(row[end - 1])) end--;
    if (row[start] === "|") start++;
    if (row[end - 1] === "|") end--;
    let text = "", offsets = [];
    const finish = (at) => {
        let left = 0, right = text.length;
        while (left < right && /\s/u.test(text[left])) left++;
        while (right > left && /\s/u.test(text[right - 1])) right--;
        const positions = offsets.slice(left, right);
        positions.push(right < offsets.length ? offsets[right] : at);
        cells.push({ text: text.slice(left, right), offsets: positions });
        text = ""; offsets = [];
    };
    for (let i = start; i < end; i++) {
        if (row[i] === "\\" && (row[i + 1] === "|" || row[i + 1] === "\\")) {
            offsets.push(i); text += row[++i]; continue;
        }
        if (row[i] === "|") { finish(i); continue; }
        offsets.push(i); text += row[i];
    }
    finish(end);
    return cells;
};
const normalizeMatchText = (value) => unescapeMarkdownInline(value).replace(/\s+/g, " ").trim().toLowerCase();
const pathKey = (path) => path.join(".");
const appendNote = (node, value, separator = "\n") => {
    const note = value.trim();
    if (!note)
        return;
    node.note = node.note ? `${node.note}${separator}${note}` : note;
};
const cloneTable = (table) => table ? table.map((row) => [...row]) : undefined;
const markdownHeadingText = (value) => value.replace(/\s+#+\s*$/, "").trim();
const headingMatch = (line) => {
    const match = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*$/);
    if (!match)
        return null;
    return {
        level: match[1].length,
        rawText: markdownHeadingText(match[2]),
        text: unescapeMarkdownInline(markdownHeadingText(match[2])),
    };
};
const indentationWidth = (indent) => Array.from(indent).reduce((width, char) => width + (char === "\t" ? 4 : 1), 0);
const extensionlessFilename = (filename = "") => filename.replace(/\.(md|markdown)$/i, "").trim();
const resolveNow = (value) => typeof value === "function" ? value() : value ?? new Date().toISOString();
const makeNodeFactory = () => {
    return (text, _path, overrides = {}) => {
        const normalizedText = text.trim() || DEFAULT_NODE_TEXT;
        const base = createNode(normalizedText);
        const node = {
            ...base,
            id: base.id,
            text: normalizedText,
            note: overrides.note ?? "",
            checked: overrides.checked ?? false,
            collapsed: base.collapsed,
            color: base.color,
            headingLevel: overrides.headingLevel ?? 0,
            imageName: overrides.imageName,
            imageAlt: overrides.imageAlt,
            table: overrides.table ? cloneTable(overrides.table) : undefined,
            codeBlock: typeof overrides.codeBlock === "string"
                ? overrides.codeBlock.replace(/\r\n?/g, "\n")
                : undefined,
            codeLanguage: typeof overrides.codeLanguage === "string" && overrides.codeLanguage.trim()
                ? overrides.codeLanguage.trim()
                : undefined,
            isTodo: overrides.isTodo ?? false,
            children: [],
        };
        return node;
    };
};
export const markdownInlineForExport = (value) => {
    const text = value.replace(/\r?\n/g, " ").trim() || DEFAULT_NODE_TEXT;
    const escape = (part) => {
        const compact = part.replace(/\s+/g, " ");
        return compact.replace(/([\\`*_[\]{}()#+\-.!>])/g, (character, _capture, at) =>
            character === "#" && /[\p{L}\p{N}_-]/u.test(compact[at + 1] ?? "") ? character : `\\${character}`);
    };
    let cursor = 0;
    let result = "";
    for (const link of scanLinks(text)) {
        result += escape(text.slice(cursor, link.start)) + link.raw;
        cursor = link.end;
    }
    return result + escape(text.slice(cursor));
};
const markdownNoteForExport = (value, indent = "") => value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `${indent}> ${line}`)
    .join("\n");
const markdownCodeFenceForExport = (code) => {
    let longestRun = 0;
    let currentRun = 0;
    Array.from(code).forEach((character) => {
        if (character === "`") {
            currentRun += 1;
            longestRun = Math.max(longestRun, currentRun);
        }
        else {
            currentRun = 0;
        }
    });
    return "`".repeat(Math.max(3, longestRun + 1));
};
const markdownCodeForExport = (value, language = "", indent = "") => {
    const code = value.replace(/\r\n?/g, "\n");
    const fence = markdownCodeFenceForExport(code);
    const info = language.trim().replace(/[`~\s].*$/, "");
    return [
        `${indent}${fence}${info}`,
        ...code.split("\n").map((line) => `${indent}${line}`),
        `${indent}${fence}`,
    ].join("\n");
};
const markdownTableCellForExport = (value) => {
    if (value === "") return "";
    let rendered = markdownInlineForExport(value);
    const links = scanLinks(rendered);
    for (let i = links.length - 1; i >= 0; i--) rendered = rendered.slice(0, links[i].start) + links[i].raw.replace(/\\/gu, "\\\\") + rendered.slice(links[i].end);
    return rendered.replace(/\|/g, "\\|");
};
const tableToMarkdown = (table, indent = "") => {
    const rows = table.filter((row) => row.length);
    if (!rows.length)
        return [];
    const columnCount = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
    const paddedRows = rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? ""));
    const cells = paddedRows.map((row) => `${indent}| ${row.map(markdownTableCellForExport).join(" | ")} |`);
    const separator = `${indent}| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`;
    return [cells[0], separator, ...cells.slice(1)];
};
const nodeToMarkdown = (node, listDepth, insideList) => {
    const lines = [];
    const text = markdownInlineForExport(node.text);
    const headingLevel = node.headingLevel ?? 0;
    const shouldWriteHeading = headingLevel > 0 && !insideList;
    if (shouldWriteHeading) {
        lines.push(`${"#".repeat(Math.min(headingLevel + 1, 6))} ${text}`);
        if (node.note)
            lines.push(markdownNoteForExport(node.note));
        if (node.imageName) {
            lines.push(`![${markdownInlineForExport(node.imageAlt || node.imageName)}](${node.imageName})`);
        }
        if (node.table)
            lines.push(...tableToMarkdown(node.table));
        if (typeof node.codeBlock === "string") {
            lines.push(markdownCodeForExport(node.codeBlock, node.codeLanguage));
        }
        return { lines, childDepth: 0, childInside: false };
    }
    const indent = "  ".repeat(listDepth);
    const marker = node.isTodo || node.checked ? `- [${node.checked ? "x" : " "}]` : "-";
    lines.push(`${indent}${marker} ${text}`);
    const childIndent = `${indent}  `;
    if (node.note)
        lines.push(markdownNoteForExport(node.note, childIndent));
    if (node.imageName) {
        lines.push(`${childIndent}![${markdownInlineForExport(node.imageAlt || node.imageName)}](${node.imageName})`);
    }
    if (node.table)
        lines.push(...tableToMarkdown(node.table, childIndent));
    if (typeof node.codeBlock === "string") {
        lines.push(markdownCodeForExport(node.codeBlock, node.codeLanguage, childIndent));
    }
    return { lines, childDepth: listDepth + 1, childInside: true };
};
export const documentToMarkdown = (document) => {
    if (typeof document.markdownSource === "string") {
        return normalizeSource(document.markdownSource);
    }
    const title = markdownInlineForExport(document.title || DEFAULT_DOCUMENT_TITLE);
    const body = [];
    const stack = document.nodes.map((node) => ({ node, depth: 0, inside: false })).reverse();
    while (stack.length) {
        const { node, depth, inside } = stack.pop();
        const rendered = nodeToMarkdown(node, depth, inside);
        body.push(...rendered.lines);
        const children = nodeChildren(node);
        for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], depth: rendered.childDepth, inside: rendered.childInside });
    }
    return [`# ${title}`, "", ...body].join("\n").trimEnd();
};
const unescapeMarkdownInline = (value, { preserveWiki = true, preserveTags = true } = {}) => {
    const links = preserveWiki ? scanLinks(value) : [];
    const mask = codeMask(value);
    return value.replace(/\\([\\`*_[\]{}()#+\-.!>])/g, (raw, character, at) => {
        if (mask[at] || links.some((link) => at >= link.start && at < link.end)) return raw;
        if (preserveTags && character === "#" && (at === 0 || /\s/u.test(value[at - 1])) && /[\p{L}\p{N}_-]/u.test(value[at + 2] ?? "")) return raw;
        // Preserve the slash parity at a wiki opener, including escaped literals.
        let next = at;
        while (value[next] === "\\") next++;
        if (preserveWiki && value.startsWith("[[", next)) return raw;
        return character;
    });
};
export const markdownTextForExport = (value) => unescapeMarkdownInline(markdownInlineForExport(value));
const listItemMatch = (line) => {
    const bullet = line.match(/^([ \t]*)([-*+])\s+(?:\[( |x|X)\]\s*)?(.*)$/);
    if (bullet) {
        return {
            indent: indentationWidth(bullet[1]),
            checked: bullet[3]?.toLowerCase() === "x",
            isTodo: bullet[3] !== undefined,
            text: unescapeMarkdownInline(bullet[4].trim()),
            rawText: bullet[4].trim(),
        };
    }
    const ordered = line.match(/^([ \t]*)(\d+[.)])\s+(?:\[( |x|X)\]\s*)?(.*)$/);
    if (!ordered)
        return null;
    return {
        indent: indentationWidth(ordered[1]),
        checked: ordered[3]?.toLowerCase() === "x",
        isTodo: ordered[3] !== undefined,
        text: unescapeMarkdownInline(ordered[4].trim()),
        rawText: ordered[4].trim(),
    };
};
const quoteLineMatch = (line) => line.match(/^([ \t]*)>\s?(.*)$/);
const imageBlockMatch = (line) => line.match(/^([ \t]*)!\[([^\]]*)\]\(([^)]+)\)\s*$/);
const tableDelimiterLine = (line) => {
    const cells = splitTableRow(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
};
const isTableStart = (lines, index) => lines[index]?.includes("|") && tableDelimiterLine(lines[index + 1] ?? "");
const splitEscapedPipe = (value) => {
    const cells = [];
    let cell = "";
    for (const char of value) {
        if (char === "|") {
            let slashes = 0;
            for (let i = cell.length - 1; i >= 0 && cell[i] === "\\"; i--) slashes++;
            if (slashes % 2) { cell = cell.slice(0, -1) + "|"; continue; }
            cells.push(cell);
            cell = "";
            continue;
        }
        cell += char;
    }
    cells.push(cell);
    return cells;
};
const splitTableRow = (line) => {
    return markdownTableCells(line).map((cell) => unescapeMarkdownInline(cell.text));
};
const parseTable = (lines, startIndex) => {
    const tableLines = [lines[startIndex], lines[startIndex + 1]];
    let index = startIndex + 2;
    const framed = lines[startIndex].trimStart().startsWith("|");
    while (index < lines.length && lines[index].includes("|") && lines[index].trim() &&
        (!framed || lines[index].trimStart().startsWith("|")) &&
        !headingMatch(lines[index]) && !listItemMatch(lines[index]) && !quoteLineMatch(lines[index])) {
        tableLines.push(lines[index]);
        index += 1;
    }
    const rows = [
        splitTableRow(tableLines[0]),
        ...tableLines.slice(2).map(splitTableRow),
    ];
    return { lines: tableLines, rows, nextIndex: index };
};
const nextSpecialBlock = (lines, index) => {
    const line = lines[index] ?? "";
    return (!line.trim() ||
        headingMatch(line) ||
        listItemMatch(line) ||
        quoteLineMatch(line) ||
        imageBlockMatch(line) ||
        isTableStart(lines, index) ||
        /^\s{0,3}(```|~~~)/.test(line));
};
const parseMarkdown = (content, previousDocument) => {
    assertTextBudget(content);
    const lines = normalizeSource(content).split("\n");
    const syntaxMask = codeMask(normalizeSource(content));
    const lineOffsets = [];
    let offset = 0;
    for (const line of lines) {
        lineOffsets.push(offset);
        offset += line.length + 1;
    }
    const fields = [];
    const captureField = (node, field, startLine, endLine, fieldStart = 0) => {
        fields.push({ node, field, start: lineOffsets[startLine], end: lineOffsets[endLine] + lines[endLine].length, fieldStart });
    };
    const roots = [];
    const headingStack = [];
    const listStack = [];
    const createParsedNode = makeNodeFactory();
    let createdNodes = 0;
    let title = DEFAULT_DOCUMENT_TITLE;
    let hasTitle = false;
    let titleRange = null;
    let lastNode = null;
    const currentParent = () => listStack[listStack.length - 1] ?? headingStack[headingStack.length - 1];
    const addNode = (text, overrides = {}) => {
        if (++createdNodes > MAX_DOCUMENT_NODES) throw new Error("Markdown 主题数量超过处理预算，原数据已保留");
        const parent = currentParent();
        const siblings = parent ? parent.node.children : roots;
        const path = parent ? [...parent.path, siblings.length] : [siblings.length];
        const node = createParsedNode(text, path, overrides);
        siblings.push(node);
        lastNode = node;
        return { node, path };
    };
    const attachOrCreateBlock = (text, note, overrides = {}, preferNote = false) => {
        if (preferNote && lastNode) {
            appendNote(lastNode, note || text);
            return lastNode;
        }
        listStack.length = 0;
        const block = addNode(text, { ...overrides, note });
        lastNode = block.node;
        return block.node;
    };
    const attachTable = (table) => {
        if (lastNode) {
            lastNode.table = cloneTable(table.rows);
            return;
        }
        const tableTitle = table.rows[0]?.filter(Boolean).join(" / ") || "表格";
        attachOrCreateBlock(`表格：${tableTitle}`, table.lines.join("\n"), { table: table.rows });
    };
    const attachImage = (alt, source) => {
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
                    title = unescapeMarkdownInline(heading.rawText, { preserveWiki: false, preserveTags: false });
                    hasTitle = true;
                    const at = line.indexOf(heading.rawText);
                    titleRange = { start: lineOffsets[index] + at, end: lineOffsets[index] + at + heading.rawText.length };
                    index += 1;
                    continue;
                }
            }
            const markdownLevel = heading.level;
            while (headingStack.length &&
                headingStack[headingStack.length - 1].markdownLevel >= markdownLevel) {
                headingStack.pop();
            }
            listStack.length = 0;
            const parent = headingStack[headingStack.length - 1];
            const siblings = parent ? parent.node.children : roots;
            const path = parent ? [...parent.path, siblings.length] : [siblings.length];
            const node = createParsedNode(heading.text, path, {
                headingLevel: Math.min(Math.max(markdownLevel - 1, 1), 3),
            });
            if (++createdNodes > MAX_DOCUMENT_NODES) throw new Error("Markdown 主题数量超过处理预算，原数据已保留");
            siblings.push(node);
            captureField(node, "text", index, index);
            headingStack.push({ node, path, markdownLevel });
            lastNode = node;
            index += 1;
            continue;
        }
        const listItem = listItemMatch(line);
        if (listItem) {
            const startLine = index;
            const continuation = [listItem.rawText];
            // A lazy continuation inside one inline code span belongs to the
            // same list paragraph, not to a fresh node with a live wiki link.
            while (index + 1 < lines.length && syntaxMask[lineOffsets[index] + lines[index].length]) {
                continuation.push(lines[++index].trim());
            }
            while (listStack.length &&
                listStack[listStack.length - 1].indent >= listItem.indent) {
                listStack.pop();
            }
            const parent = currentParent();
            const siblings = parent ? parent.node.children : roots;
            const path = parent ? [...parent.path, siblings.length] : [siblings.length];
            const text = continuation.length > 1 ? unescapeMarkdownInline(continuation.join("\n")) : listItem.text;
            const node = createParsedNode(text, path, {
                checked: listItem.isTodo ? listItem.checked : false,
                isTodo: listItem.isTodo,
            });
            if (++createdNodes > MAX_DOCUMENT_NODES) throw new Error("Markdown 主题数量超过处理预算，原数据已保留");
            siblings.push(node);
            captureField(node, "text", startLine, index);
            listStack.push({ node, path, indent: listItem.indent });
            lastNode = node;
            index += 1;
            continue;
        }
        const quote = quoteLineMatch(line);
        if (quote) {
            const quoteLines = [];
            let quoteIndex = index;
            while (quoteIndex < lines.length) {
                const currentQuote = quoteLineMatch(lines[quoteIndex]);
                if (!currentQuote)
                    break;
                quoteLines.push(currentQuote[2]);
                quoteIndex += 1;
            }
            const note = quoteLines.join("\n").trim();
            if (lastNode) {
                appendNote(lastNode, note, "\n\n");
            }
            else {
                attachOrCreateBlock(`引用：${note.split("\n")[0] || DEFAULT_NODE_TEXT}`, note);
            }
            if (lastNode)
                captureField(lastNode, "note", index, quoteIndex - 1, lastNode.note.length - note.length);
            index = quoteIndex;
            continue;
        }
        const fence = line.match(/^([ \t]*)(```+|~~~+)\s*(.*)$/);
        if (fence) {
            const fenceIndent = fence[1];
            const marker = fence[2];
            const language = fence[3].trim();
            const codeLines = [];
            index += 1;
            while (index < lines.length && !lines[index].trimStart().startsWith(marker)) {
                const codeLine = lines[index];
                codeLines.push(codeLine.startsWith(fenceIndent) ? codeLine.slice(fenceIndent.length) : codeLine);
                index += 1;
            }
            if (index < lines.length)
                index += 1;
            const label = language ? `代码块：${language}` : "代码块";
            const codeBlock = codeLines.join("\n");
            if (listStack.length && lastNode) {
                lastNode.codeBlock = codeBlock;
                lastNode.codeLanguage = language || undefined;
            }
            else {
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
        const paragraphLines = [];
        while (index < lines.length && !nextSpecialBlock(lines, index)) {
            paragraphLines.push(lines[index].trim());
            index += 1;
        }
        const paragraph = unescapeMarkdownInline(paragraphLines.join(" ").trim());
        if (paragraph) {
            const indentedUnderList = listStack.length > 0 &&
                indentationWidth(lines[index - paragraphLines.length]?.match(/^([ \t]*)/)?.[1] ?? "") >
                    listStack[listStack.length - 1].indent;
            const node = attachOrCreateBlock(paragraph, "", {}, indentedUnderList);
            captureField(node, indentedUnderList ? "note" : "text", index - paragraphLines.length, index - 1, indentedUnderList ? node.note.length - paragraph.length : 0);
        }
    }
    const nodes = roots.length ? roots : [createParsedNode(DEFAULT_NODE_TEXT, [0])];
    assertTreeBudget(nodes);
    reuseMarkdownNodeIds(previousDocument, nodes, content);
    const source = normalizeSource(content);
    const originalOffsets = markdownSourceMap(content).offsets;
    const links = scanLinks(source);
    const linkOrigins = new Map();
    let linkCursor = 0;
    for (const field of fields) {
        while (linkCursor < links.length && links[linkCursor].start < field.start)
            linkCursor++;
        const sourceLinks = [];
        while (linkCursor < links.length && links[linkCursor].end <= field.end)
            sourceLinks.push(links[linkCursor++]);
        const fieldLinks = scanLinks(field.node[field.field]).filter((link) => link.start >= field.fieldStart);
        const used = new Set();
        for (const link of sourceLinks) {
            const match = fieldLinks.findIndex((candidate, index) => !used.has(index) && candidate.raw === link.raw);
            if (match < 0)
                continue;
            used.add(match);
            linkOrigins.set(originalOffsets[link.start], { nodeId: field.node.id, field: field.field, start: fieldLinks[match].start, end: fieldLinks[match].end });
        }
    }
    return {
        title,
        hasTitle,
        nodes,
        linkOrigins,
        fields,
        titleRange,
    };
};

// Preserve list markers, heading levels, notes, fences and unrelated whitespace
// while updating the source range that owns a renamed structured topic.
export const rewriteMarkdownLabel = (document, { nodeId = null, nextLabel }) => {
    if (typeof document.markdownSource !== "string") return document.markdownSource;
    const source = normalizeSource(document.markdownSource);
    const parsed = parseMarkdown(source, document);
    let range = parsed.titleRange;
    let prefix = "", suffix = "";
    if (nodeId) {
        const field = parsed.fields.find((item) => item.field === "text" && item.node.id === nodeId);
        if (!field) return undefined;
        if (field.node.text === nextLabel) return source;
        range = field;
        const raw = source.slice(range.start, range.end);
        prefix = raw.match(/^[ \t]*(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+(?:\[(?: |x|X)\]\s*)?)/)?.[0] ?? raw.match(/^[ \t]*/)[0];
        if (headingMatch(raw)) suffix = raw.match(/\s+#+\s*$/)?.[0] ?? "";
    } else if (parsed.title === nextLabel) return source;
    if (!range) return undefined;
    return source.slice(0, range.start) + prefix + markdownInlineForExport(nextLabel) + suffix + source.slice(range.end);
};
// Equal counts or paths cannot distinguish edits from deleted/replaced nodes.
// Preserve unique anchors, then match only unambiguous, related one-to-one gaps.
const reuseMarkdownNodeIds = (previous, parsed, content) => {
    if (!previous)
        return;
    const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
    const oldNodes = flatten(previous.nodes);
    const newNodes = flatten(parsed);
    const matches = new Map();
    const used = new Set();
    const group = (nodes) => {
        const result = new Map();
        for (const node of nodes) {
            const key = normalizeMatchText(node.text);
            const candidates = result.get(key) ?? [];
            candidates.push(node);
            result.set(key, candidates);
        }
        return result;
    };
    const oldGroups = group(oldNodes), newGroups = group(newNodes);
    for (const [key, candidates] of newGroups) {
        const old = oldGroups.get(key);
        if (key && candidates.length === 1 && old?.length === 1) {
            matches.set(candidates[0], old[0]);
            used.add(old[0]);
        }
    }
    const unchanged = normalizeSource(documentToMarkdown(previous)) === normalizeSource(content);
    const oldSource = previous.markdownSource === undefined ? null : normalizeSource(previous.markdownSource);
    const newSource = normalizeSource(content);
    let prefix = 0, suffix = 0;
    if (oldSource !== null) {
        while (prefix < Math.min(oldSource.length, newSource.length) && oldSource[prefix] === newSource[prefix])
            prefix++;
        while (suffix < Math.min(oldSource.length, newSource.length) - prefix && oldSource[oldSource.length - suffix - 1] === newSource[newSource.length - suffix - 1])
            suffix++;
    }
    const singleLineEdit = oldSource !== null && !oldSource.slice(prefix, oldSource.length - suffix).includes("\n") && !newSource.slice(prefix, newSource.length - suffix).includes("\n");
    const sameShape = (before, after) => before.length === after.length && before.every((node, index) => node.headingLevel === after[index].headingLevel && sameShape(node.children ?? [], after[index].children ?? []));
    const localEdit = singleLineEdit && sameShape(previous.nodes, parsed);
    if (localEdit) {
        // The edit stayed within one source line and preserved the entire
        // hierarchy: positional provenance is stronger than duplicate labels.
        matches.clear();
        used.clear();
        oldNodes.forEach((old, index) => { matches.set(newNodes[index], old); used.add(old); });
    }
    const relatedText = (left, right) => {
        const a = normalizeMatchText(left), b = normalizeMatchText(right);
        let prefix = 0, suffix = 0;
        while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix])
            prefix++;
        while (suffix < Math.min(a.length, b.length) - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1])
            suffix++;
        return prefix + suffix >= Math.max(1, Math.ceil(Math.min(a.length, b.length) / 2));
    };
    const visit = (before, after) => {
        const oldIndices = new Map(before.map((node, index) => [node, index]));
        const anchors = after.map((node, index) => ({ index, oldIndex: oldIndices.get(matches.get(node)) ?? -1 })).filter((item) => item.oldIndex >= 0);
        const ordered = anchors.every((anchor, index) => !index || anchor.oldIndex > anchors[index - 1].oldIndex);
        const boundaries = [{ index: -1, oldIndex: -1 }, ...anchors, { index: after.length, oldIndex: before.length }];
        if (ordered)
            for (let i = 1; i < boundaries.length; i++) {
                const left = boundaries[i - 1], right = boundaries[i];
                const oldGap = before.slice(left.oldIndex + 1, right.oldIndex).filter((node) => !used.has(node));
                const newGap = after.slice(left.index + 1, right.index).filter((node) => !matches.has(node));
                if (oldGap.length !== 1 || newGap.length !== 1)
                    continue;
                const old = oldGap[0], node = newGap[0];
                const childAnchor = flatten(node.children ?? []).some((child) => (old.children ?? []).includes(matches.get(child)));
                if ((unchanged || localEdit || anchors.length || childAnchor) && (unchanged || localEdit || relatedText(old.text, node.text)) && old.headingLevel === node.headingLevel) {
                    matches.set(node, old);
                    used.add(old);
                }
            }
        if (unchanged || localEdit)
            after.forEach((node, index) => {
                const old = before[index];
                if (old && !matches.has(node) && !used.has(old) && old.text === node.text) {
                    matches.set(node, old);
                    used.add(old);
                }
            });
        for (const node of after) {
            const old = matches.get(node);
            if (old)
                visit(old.children ?? [], node.children ?? []);
        }
    };
    visit(previous.nodes, parsed);
    for (const [node, old] of matches) {
        Object.assign(node, { ...old, ...node, id: old.id, collapsed: old.collapsed, color: old.color,
            bold: old.bold, italic: old.italic, underline: old.underline, strike: old.strike, highlight: old.highlight, icon: old.icon });
    }
};
export const parseMarkdownToNodes = (content, previousDocument) => {
    const parsed = parseMarkdown(content, previousDocument);
    return {
        title: parsed.title,
        nodes: parsed.nodes,
    };
};
export const markdownLinkOrigins = (document, content) => {
    const origins = parseMarkdown(content, document).linkOrigins;
    const nodes = new Map();
    const walk = (list) => list.forEach((node) => { nodes.set(node.id, node); walk(node.children ?? []); });
    walk(document.nodes ?? []);
    const sourceLinks = new Map(scanLinks(content).map((link) => [link.start, link]));
    const used = new Map();
    for (const [at, origin] of origins) {
        const node = nodes.get(origin.nodeId);
        if (!node) { origins.delete(at); continue; }
        const key = `${origin.nodeId}:${origin.field}`;
        const occupied = used.get(key) ?? new Set();
        const candidates = scanLinks(String(node[origin.field] ?? ""));
        const link = candidates.find((candidate) => !occupied.has(candidate.start) && candidate.raw === sourceLinks.get(at)?.raw);
        if (!link) { origins.delete(at); continue; }
        occupied.add(link.start);
        used.set(key, occupied);
        origins.set(at, { ...origin, start: link.start, end: link.end });
    }
    return origins;
};
export const parseMarkdownDocument = (content, options = {}) => {
    const now = resolveNow(options.now);
    const previousDocument = options.previousDocument;
    const parsed = parseMarkdown(content, previousDocument);
    const filenameTitle = extensionlessFilename(options.filename) || previousDocument?.title || DEFAULT_DOCUMENT_TITLE;
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
