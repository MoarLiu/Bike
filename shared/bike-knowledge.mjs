// Shared by the Electron renderer, tests, and MCP. No DOM and no app imports.
import { markdownLinkOrigins, markdownTextForExport, rewriteMarkdownLabel } from "./bike-markdown.mjs";
import { validateDocumentAttachments } from "./bike-attachments.mjs";

export const KNOWLEDGE_VERSION = 1;
export const MAX_METADATA_BYTES = 2 * 1024 * 1024;
export const MAX_RELATION_LABEL = 40;
export const MAX_RELATIONS = 1000;
export const MAX_DRAWN_RELATIONS = 200;
export const MAX_SEARCH_PAGE = 100;

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

export const canonicalText = (value) => {
  const text = String(value ?? "");
  let end = text.length;
  while (end > 0 && /\s/u.test(text[end - 1])) end -= 1;
  return end === text.length ? text : text.slice(0, end);
};

export const identityKey = (value) => String(value ?? "").normalize("NFC");

export const foldKey = (value) => identityKey(value).toLocaleLowerCase("en-US");

const unicodeLength = (value) => Array.from(String(value ?? "")).length;

export const createId = (prefix) => {
  const cryptoApi = globalThis.crypto;
  const random = typeof cryptoApi?.randomUUID === "function"
    ? cryptoApi.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}_${random}`;
};

const rightRotate = (value, shift) => (value >>> shift) | (value << (32 - shift));

export const sha256Hex = (message) => {
  const bytes = textEncoder.encode(String(message ?? ""));
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const high = Math.floor(bitLength / 0x100000000);
  view.setUint32(paddedLength - 8, high);
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rightRotate(words[index - 15], 7) ^ rightRotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rightRotate(words[index - 2], 17) ^ rightRotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return Array.from(state, (value) => value.toString(16).padStart(8, "0")).join("");
};

const bytesToBase64Url = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const base64UrlToBytes = (value) => {
  const normalized = String(value).replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

export const codeMask = (text) => {
  const mask = new Uint8Array(text.length);
  let offset = 0;
  let fence = null;
  const lines = text.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const newline = lineIndex < lines.length - 1;
    const fenceMatch = /^[ \t]*(`{3,}|~{3,})/u.exec(line);
    if (fence) {
      mask.fill(1, offset, offset + line.length + (newline ? 1 : 0));
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/u.exec(line);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) fence = null;
    } else if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      mask.fill(1, offset, offset + line.length + (newline ? 1 : 0));
    }
    offset += line.length + (newline ? 1 : 0);
  }
  // A code span closes only at a delimiter run of the same length, and may
  // cross line boundaries. Backslashes inside a code span are literal.
  for (let cursor = 0; cursor < text.length;) {
    if (mask[cursor] || text[cursor] !== "`" || escaped(text, cursor)) { cursor++; continue; }
    let end = cursor + 1;
    while (text[end] === "`") end++;
    const width = end - cursor;
    let close = end;
    let matched = false;
    while (close < text.length && !mask[close]) {
      if (text[close] !== "`") { close++; continue; }
      let runEnd = close + 1;
      while (text[runEnd] === "`") runEnd++;
      if (runEnd - close === width) {
        mask.fill(1, cursor, runEnd);
        cursor = runEnd;
        matched = true;
        break;
      }
      close = runEnd;
    }
    if (!matched) cursor = end;
  }
  return mask;
};

const escaped = (text, index) => {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
};

const readEscaped = (text, start, end, mask) => {
  let documentName = "";
  let nodeName = null;
  let alias = null;
  let mode = "document";
  for (let index = start; index < end; index += 1) {
    if (mask[index]) return null;
    if (text[index] === "\\" && index + 1 < end && "\\#|][`".includes(text[index + 1])) {
      const value = text[index + 1];
      if (mode === "document") documentName += value;
      else if (mode === "node") nodeName += value;
      else alias += value;
      index += 1;
      continue;
    }
    if (text[index] === "#" && mode === "document") {
      mode = "node";
      nodeName = "";
      continue;
    }
    if (text[index] === "|" && mode !== "alias") {
      mode = "alias";
      alias = "";
      continue;
    }
    if (mode === "document") documentName += text[index];
    else if (mode === "node") nodeName += text[index];
    else alias += text[index];
  }
  if (!identityKey(documentName) || (nodeName !== null && !identityKey(nodeName))) return null;
  return {
    documentName: identityKey(documentName),
    nodeName: nodeName === null ? null : identityKey(nodeName),
    alias: alias === null ? null : identityKey(alias),
  };
};

export const formatWikiLink = ({ documentName, nodeName = null, alias = null }) => {
  const escape = (value) => String(value).replace(/[\\#|\]`]/gu, (character) => `\\${character}`);
  let body = escape(identityKey(documentName));
  if (nodeName) body += `#${escape(identityKey(nodeName))}`;
  if (alias) body += `|${escape(identityKey(alias))}`;
  return `[[${body}]]`;
};

export const scanLinks = (text) => {
  const source = String(text ?? "");
  const mask = codeMask(source);
  const links = [];
  for (let index = 0; index < source.length - 1; index += 1) {
    if (mask[index] || source[index] !== "[" || source[index + 1] !== "[") continue;
    if (escaped(source, index)) continue;
    let close = -1;
    let boundary = source.length - 1;
    for (let cursor = index + 2; cursor < source.length - 1; cursor += 1) {
      if (mask[cursor]) { boundary = cursor; break; }
      if (source[cursor] === "\\" && "\\#|][`".includes(source[cursor + 1] ?? "")) {
        cursor += 1;
        continue;
      }
      if (source[cursor] === "]" && source[cursor + 1] === "]" && !escaped(source, cursor)) {
        close = cursor;
        break;
      }
    }
    if (close === -1) { index = Math.max(index, boundary - 1); continue; }
    const parsed = readEscaped(source, index + 2, close, mask);
    if (!parsed) {
      index = close + 1;
      continue;
    }
    const raw = source.slice(index, close + 2);
    links.push({
      start: index,
      end: close + 2,
      raw,
      ...parsed,
      labelMode: parsed.alias ? "custom" : "auto",
      label: parsed.alias || parsed.nodeName || parsed.documentName,
    });
    index = close + 1;
  }
  return links;
};

export const activeLinkQuery = (text, caret) => {
  const source = String(text ?? "");
  const end = Math.max(0, Math.min(source.length, caret ?? source.length));
  const mask = codeMask(source);
  let start = -1;
  for (let index = end - 1; index >= Math.max(0, end - 500); index -= 1) {
    if (source[index] === "\n") return null;
    if (source[index] === "]" && source[index - 1] === "]") return null;
    if (source[index] === "[" && source[index - 1] === "[" && !mask[index] && !escaped(source, index - 1)) {
      start = index - 1;
      break;
    }
  }
  if (start < 0 || mask[start]) return null;
  return { start, end, query: source.slice(start + 2, end) };
};

export const insertLinkAtQuery = (text, query, target) => {
  const raw = formatWikiLink(target);
  const end = query.end ?? text.length;
  return {
    text: `${text.slice(0, query.start)}${raw}${text.slice(end)}`,
    start: query.start,
    end: query.start + raw.length,
    raw,
    labelMode: target.alias ? "custom" : "auto",
  };
};

export const extractKnowledgeTags = (text) => {
  const source = String(text ?? "");
  const mask = codeMask(source);
  const tags = [];
  const links = scanLinks(source);
  const pattern = /(^|[\s])#([\p{L}\p{N}_-]+)/gu;
  for (const match of source.matchAll(pattern)) {
    const hashIndex = match.index + match[1].length;
    if (mask[hashIndex] || links.some((link) => hashIndex >= link.start && hashIndex < link.end)) continue;
    const lineStart = source.lastIndexOf("\n", hashIndex - 1) + 1;
    const prefix = source.slice(lineStart, hashIndex);
    if (/^#{1,6}$/u.test(prefix) && /\s/u.test(source[hashIndex + 1] ?? "")) continue;
    if (/^#{0,5}$/u.test(prefix) && source.slice(lineStart, hashIndex + 1).startsWith("#") && /\s/u.test(source[hashIndex + match[2].length + 1] ?? " ")) {
      // A markdown heading with a required space is not a tag.
    }
    const line = source.slice(lineStart, source.indexOf("\n", hashIndex) === -1 ? source.length : source.indexOf("\n", hashIndex));
    if (/^ {0,3}#{1,6}\s/u.test(line) && hashIndex - lineStart < 6) continue;
    const tokenStart = source.lastIndexOf(" ", hashIndex);
    const token = source.slice(tokenStart + 1, hashIndex);
    if (/^[a-z][a-z0-9+.-]*:/iu.test(token) || /[/?&=]$/u.test(token)) continue;
    tags.push(identityKey(match[2]));
  }
  return tags;
};

const clone = (value) => structuredClone(value);

const mapKnowledgeNodes = (nodes = [], mapper) => {
  const result = [];
  const stack = [{ source: nodes, target: result, parent: null }];
  const pending = [];
  while (stack.length) {
    const frame = stack.pop();
    for (let i = 0; i < frame.source.length; i++) {
      const node = frame.source[i];
      const children = [];
      pending.push({ node, children, target: frame.target, index: i });
      stack.push({ source: childNodes(node), target: children });
    }
  }
  for (let i = pending.length - 1; i >= 0; i--) {
    const { node, children, target, index } = pending[i];
    const sameChildren = children.length === childNodes(node).length && children.every((child, at) => child === node.children[at]);
    target[index] = mapper(sameChildren ? node : { ...node, children });
  }
  return result.length === nodes.length && result.every((node, i) => node === nodes[i]) ? nodes : result;
};

export const emptyKnowledge = () => ({ version: KNOWLEDGE_VERSION, references: [], relations: [] });

const validReference = (reference) => isRecord(reference)
  && typeof reference.id === "string"
  && isRecord(reference.source)
  && (reference.source.kind === "node-field" || reference.source.kind === "markdown")
  && (reference.source.kind !== "node-field" || (typeof reference.source.nodeId === "string" && ["text", "note"].includes(reference.source.field)))
  && typeof reference.source.raw === "string"
  && Number.isInteger(reference.source.start)
  && Number.isInteger(reference.source.end)
  && isRecord(reference.target)
  && typeof reference.target.documentId === "string"
  && (reference.target.nodeId === undefined || typeof reference.target.nodeId === "string")
  && (reference.labelMode === "auto" || reference.labelMode === "custom");

const validRelation = (relation) => isRecord(relation)
  && typeof relation.id === "string"
  && typeof relation.fromNodeId === "string"
  && typeof relation.toNodeId === "string"
  && typeof relation.label === "string";

const validSourceGroups = (knowledge) => {
  if (knowledge.sourceGroups !== undefined && (!isRecord(knowledge.sourceGroups) || !Object.values(knowledge.sourceGroups).every((group) => (
    isRecord(group) && typeof group.raw === "string" && Array.isArray(group.candidates) && group.candidates.every((item) => (
      isRecord(item) && typeof item.nodeId === "string" && ["text", "note"].includes(item.field)
    ))
  )))) return false;
  return knowledge.references.every((reference) => reference.source.groupId === undefined || (
    typeof reference.source.groupId === "string" && knowledge.sourceGroups && Object.hasOwn(knowledge.sourceGroups, reference.source.groupId)
  ));
};

export const knowledgeEditable = (knowledge) => Boolean(
  isRecord(knowledge) &&
  knowledge.version === KNOWLEDGE_VERSION &&
  Array.isArray(knowledge.references) &&
  knowledge.references.every(validReference) &&
  Array.isArray(knowledge.relations) &&
  knowledge.relations.every(validRelation) && validSourceGroups(knowledge),
);

// Ambiguous Markdown source provenance is shared per group; targets are never
// inferred from a candidate. This avoids both global raw-text bans and O(n^2)
// copies of the same candidate list on every lost reference.
const candidateFields = new WeakMap();
const fieldKey = (origin) => origin.kind === "markdown" ? "markdown" : `${origin.kind}:${origin.nodeId ?? ""}:${origin.field ?? ""}`;
const sourceMatches = (knowledge, reference, origin) => {
  const source = reference.source;
  if (source.kind === origin.kind && source.nodeId === origin.nodeId && source.field === origin.field) return true;
  const group = knowledge?.sourceGroups?.[source.groupId];
  if (origin.kind !== "node-field" || !Array.isArray(group?.candidates)) return false;
  let fields = candidateFields.get(group.candidates);
  if (!fields) { fields = new Set(group.candidates.map((item) => fieldKey({ kind: "node-field", ...item }))); candidateFields.set(group.candidates, fields); }
  return fields.has(fieldKey(origin));
};

const ensureKnowledge = (document) => {
  if (!document.knowledge) document.knowledge = emptyKnowledge();
  return knowledgeEditable(document.knowledge) ? document.knowledge : null;
};

const childNodes = (node) => Array.isArray(node?.children) ? node.children : [];

export const walkNodes = (nodes, visit, ancestors = []) => {
  const stack = [{ nodes: nodes ?? [], index: 0 }];
  const path = [...ancestors];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.nodes.length) {
      stack.pop();
      if (stack.length) path.pop();
      continue;
    }
    const node = frame.nodes[frame.index++];
    visit(node, [...path]);
    if (childNodes(node).length) {
      path.push(node);
      stack.push({ nodes: childNodes(node), index: 0 });
    }
  }
};

export const findKnowledgeNode = (nodes, id) => {
  let found = null;
  walkNodes(nodes, (node, ancestors) => {
    if (!found && node.id === id) found = { node, ancestors };
  });
  return found;
};

const collectIds = (nodes, ids = []) => {
  walkNodes(nodes, (node) => ids.push(node.id));
  return ids;
};

const fieldText = (node, field) => String(node?.[field] ?? "");

const referencesForField = (knowledge, nodeId, field) => knowledge.references.filter((reference) => (
  sourceMatches(knowledge, reference, { kind: "node-field", nodeId, field })
));

const applyFieldEdits = (text, edits, fieldReferences) => {
  const sorted = [...edits].sort((left, right) => left.start - right.start);
  let cursor = 0;
  let output = "";
  for (const edit of sorted) {
    if (edit.start < cursor || edit.end > text.length || text.slice(edit.start, edit.end) !== edit.previousRaw) return null;
    output += text.slice(cursor, edit.start) + edit.nextRaw;
    edit.resultStart = output.length - edit.nextRaw.length;
    edit.resultEnd = output.length;
    cursor = edit.end;
  }
  output += text.slice(cursor);
  for (const reference of fieldReferences) {
    const covering = sorted.find((edit) => edit.reference === reference);
    if (covering) {
      reference.source = {
        ...reference.source,
        start: covering.resultStart,
        end: covering.resultEnd,
        raw: covering.nextRaw,
      };
      continue;
    }
    let delta = 0;
    let overlaps = false;
    for (const edit of sorted) {
      if (edit.end <= reference.source.start) delta += edit.nextRaw.length - (edit.end - edit.start);
      else if (edit.start < reference.source.end) overlaps = true;
    }
    if (overlaps || reference.source.start < 0) {
      reference.source = { ...reference.source, start: -1, end: -1 };
    } else {
      reference.source = {
        ...reference.source,
        start: reference.source.start + delta,
        end: reference.source.end + delta,
      };
    }
  }
  return output;
};

export const relocateFieldReferences = (knowledge, { nodeId, field, text, previousText }) => {
  if (!knowledgeEditable(knowledge)) return knowledge;
  const next = clone(knowledge);
  const links = scanLinks(text);
  const used = new Set();
  const oldLinks = previousText === undefined ? null : scanLinks(previousText);
  let prefix = 0, suffix = 0;
  if (previousText !== undefined) {
    while (prefix < Math.min(previousText.length, text.length) && previousText[prefix] === text[prefix]) prefix++;
    while (suffix < Math.min(previousText.length, text.length) - prefix && previousText[previousText.length - suffix - 1] === text[text.length - suffix - 1]) suffix++;
  }
  next.references = next.references.flatMap((reference) => {
    if (reference?.source?.kind !== "node-field" || reference.source.nodeId !== nodeId || reference.source.field !== field) {
      return [reference];
    }
    const oldCount = oldLinks?.filter((link) => link.raw === reference.source.raw).length
      ?? knowledge.references.filter((item) => item.source?.kind === "node-field" && item.source.nodeId === nodeId && item.source.field === field && item.source.raw === reference.source.raw).length;
    const newCount = links.filter((link) => link.raw === reference.source.raw).length;
    if (oldCount > 1 && newCount > 0 && oldCount !== newCount) return [{ ...reference, source: { ...reference.source, start: -1, end: -1 } }];
    if (reference.source.start < 0 && newCount) return [reference];
    let projected = reference.source.start;
    if (previousText !== undefined && previousText.slice(reference.source.start, reference.source.end) === reference.source.raw) {
      if (reference.source.start >= previousText.length - suffix) projected += text.length - previousText.length;
      else if (reference.source.end > prefix) projected = -1;
    }
    const exactIndex = links.findIndex((link, index) => !used.has(index) && link.start === projected && link.raw === reference.source.raw);
    const matches = links
      .map((link, index) => ({ link, index }))
      .filter((item) => !used.has(item.index) && item.link.raw === reference.source.raw);
    const chosen = exactIndex >= 0 ? { link: links[exactIndex], index: exactIndex } : matches.length === 1 ? matches[0] : null;
    if (!chosen) {
      if (matches.length > 1) {
        return [{ ...reference, source: { ...reference.source, start: -1, end: -1 } }];
      }
      return [];
    }
    used.add(chosen.index);
    return [{
      ...reference,
      source: { ...reference.source, start: chosen.link.start, end: chosen.link.end, raw: chosen.link.raw },
    }];
  });
  return next;
};

const setNodeField = (document, nodeId, field, text) => {
  const located = findKnowledgeNode(document.nodes, nodeId);
  if (!located) return false;
  located.node[field] = text;
  return true;
};

export const withFieldText = (document, { nodeId, field, text }) => {
  const located = findKnowledgeNode(document.nodes, nodeId);
  const previousText = fieldText(located?.node, field);
  if (!located || previousText === text) return document;
  const next = { ...document, nodes: mapKnowledgeNodes(document.nodes, (node) => node.id === nodeId ? { ...node, [field]: text } : node) };
  if (field === "text" && typeof document.markdownSource === "string") {
    next.markdownSource = rewriteMarkdownLabel(document, { nodeId, nextLabel: text });
    if (next.markdownSource === undefined) delete next.markdownUpdatedAt;
  }
  if (knowledgeEditable(next.knowledge)) {
    next.knowledge = relocateFieldReferences(next.knowledge, { nodeId, field, text, previousText });
    const raws = new Set(scanLinks(text).map((link) => link.raw));
    for (const [id, group] of Object.entries(next.knowledge.sourceGroups ?? {})) {
      if (!raws.has(group.raw)) group.candidates = group.candidates.filter((item) => item.nodeId !== nodeId || item.field !== field);
      if (!group.candidates.length && !next.knowledge.references.some((reference) => reference.source.groupId === id && reference.source.kind === "markdown")) {
        next.knowledge.references = next.knowledge.references.filter((reference) => reference.source.groupId !== id);
        delete next.knowledge.sourceGroups[id];
      }
    }
  }
  return next;
};

const liveDocuments = (workspace) => Array.isArray(workspace?.documents) ? workspace.documents : [];

const trashedDocuments = (workspace) => (Array.isArray(workspace?.trash) ? workspace.trash : [])
  .map((entry) => entry?.document)
  .filter(Boolean);

const documentTitleForMatch = (document, rename) => (
  rename && rename.documentId === document.id && !rename.nodeId ? rename.previous : document.title
);

const nodeLabelForMatch = (node, rename) => (
  rename && rename.nodeId === node.id ? rename.previous : node.text
);

const documentsNamed = (documents, name, rename) => {
  const exact = documents.filter((document) => identityKey(documentTitleForMatch(document, rename)) === identityKey(name));
  if (exact.length) return exact;
  const folded = documents.filter((document) => foldKey(documentTitleForMatch(document, rename)) === foldKey(name));
  return folded;
};

const nodesNamed = (document, name, rename) => {
  const matches = [];
  walkNodes(document.nodes, (node, ancestors) => {
    if (identityKey(nodeLabelForMatch(node, rename)) === identityKey(name)) matches.push({ node, ancestors });
  });
  if (matches.length) return matches;
  const folded = [];
  walkNodes(document.nodes, (node, ancestors) => {
    if (foldKey(nodeLabelForMatch(node, rename)) === foldKey(name)) folded.push({ node, ancestors });
  });
  return folded;
};

const resolveParsedLink = (workspace, link, rename = null) => {
  const documents = documentsNamed(liveDocuments(workspace), link.documentName, rename);
  if (documents.length !== 1) {
    const trashed = documentsNamed(trashedDocuments(workspace), link.documentName, rename);
    if (!documents.length && trashed.length === 1 && !link.nodeName) {
      return { status: "deleted", documentId: trashed[0].id, nodeId: null };
    }
    return { status: documents.length ? "ambiguous" : trashed.length ? "deleted" : "missing" };
  }
  const document = documents[0];
  if (!link.nodeName) return { status: "resolved", documentId: document.id, nodeId: null };
  const nodes = nodesNamed(document, link.nodeName, rename);
  if (nodes.length === 1) return { status: "resolved", documentId: document.id, nodeId: nodes[0].node.id, ancestors: nodes[0].ancestors };
  const trashedNodes = nodesNamed({ nodes: trashedDocuments(workspace).find((item) => item.id === document.id)?.nodes ?? [] }, link.nodeName, rename);
  return { status: nodes.length ? "ambiguous" : trashedNodes.length ? "deleted" : "missing", documentId: document.id };
};

const pathLabel = (ancestors, node) => [...ancestors, node].map((item) => item.text || "未命名主题").join(" / ");

const referenceStatus = (workspace, document, reference, context) => {
  const locate = (document, id) => context ? context.node(document, id) : findKnowledgeNode(document.nodes, id)?.node;
  const sourceText = reference.source?.kind === "markdown"
    ? String(document.markdownSource ?? "")
    : fieldText(locate(document, reference.source?.nodeId), reference.source?.field);
  if (!reference.source || reference.source.start < 0 || sourceText.slice(reference.source.start, reference.source.end) !== reference.source.raw) {
    return "sourceMismatch";
  }
  const target = liveDocuments(workspace).find((item) => item.id === reference.target?.documentId);
  const trashed = trashedDocuments(workspace).find((item) => item.id === reference.target?.documentId);
  if (!target) return trashed ? "deleted" : "missing";
  if (reference.target.nodeId) {
    const node = locate(target, reference.target.nodeId);
    if (!node) {
      const trashedNode = trashed ? findKnowledgeNode(trashed.nodes, reference.target.nodeId) : null;
      return trashedNode ? "deleted" : "missing";
    }
  }
  return "resolved";
};

const linkCovered = (reference, link) => (
  reference.source?.start === link.start &&
  reference.source?.end === link.end &&
  reference.source?.raw === link.raw
);

export const resolveDocumentConnections = (workspace, document) => {
  const results = [];
  const normalized = anchorMarkdownReferences(document);
  if (normalized && !knowledgeEditable(normalized)) return [];
  const knowledge = knowledgeEditable(normalized) ? normalized : null;
  const visited = new Set();
  const nodeMaps = new Map(), statuses = new Map(), fields = new Map(), guarded = new Map();
  const context = { node: (document, id) => {
    if (!nodeMaps.has(document)) { const nodes = new Map(); walkNodes(document.nodes, (node) => nodes.set(node.id, node)); nodeMaps.set(document, nodes); }
    return nodeMaps.get(document).get(id);
  } };
  const statusFor = (reference) => {
    if (!statuses.has(reference)) statuses.set(reference, referenceStatus(workspace, document, reference, context));
    return statuses.get(reference);
  };
  const guard = (origin, raw) => { const key = fieldKey(origin), raws = guarded.get(key) ?? new Set(); raws.add(raw); guarded.set(key, raws); };
  const guardedGroups = new Set();
  for (const reference of knowledge?.references ?? []) {
    const key = fieldKey(reference.source), list = fields.get(key) ?? []; list.push(reference); fields.set(key, list);
    if (statusFor(reference) === "sourceMismatch") { guard(reference.source, reference.source.raw); if (reference.source.groupId) guardedGroups.add(reference.source.groupId); }
  }
  for (const id of guardedGroups) {
    const group = knowledge.sourceGroups[id];
    for (const candidate of group.candidates) guard({ kind: "node-field", ...candidate }, group.raw);
  }
  const origins = typeof document.markdownSource === "string" ? markdownLinkOrigins(document, document.markdownSource) : new Map();
  const consume = (text, describe, links = scanLinks(text)) => {
    const used = new Set();
    for (const reference of fields.get(fieldKey(describe.origin)) ?? []) {
      visited.add(reference);
      const status = statusFor(reference);
      const covered = links.findIndex((link, index) => !used.has(index) && linkCovered(reference, link));
      if (covered >= 0) used.add(covered);
      results.push({ reference, status, link: covered >= 0 ? links[covered] : null, origin: describe.origin });
    }
    for (const [index, link] of links.entries()) {
      if (used.has(index)) continue;
      if (guarded.get(fieldKey(describe.origin))?.has(link.raw)) continue;
      const resolved = resolveParsedLink(workspace, link);
      results.push({ reference: null, link, status: resolved.status, resolved, origin: describe.origin });
    }
  };
  walkNodes(document.nodes, (node) => {
    for (const field of ["text", "note"]) consume(fieldText(node, field), {
      matches: (reference) => reference.source?.kind === "node-field" && reference.source.nodeId === node.id && reference.source.field === field,
      origin: { documentId: document.id, nodeId: node.id, field, kind: "node-field" },
    });
  });
  if (typeof document.markdownSource === "string") consume(document.markdownSource, {
    matches: (reference) => reference.source?.kind === "markdown",
    origin: { documentId: document.id, nodeId: null, field: "markdown", kind: "markdown" },
  }, scanLinks(document.markdownSource).filter((link) => !origins.has(link.start)));
  for (const reference of knowledge?.references ?? []) {
    if (!visited.has(reference)) results.push({ reference, status: statusFor(reference), link: null,
      origin: { documentId: document.id, nodeId: reference.source.nodeId ?? null, field: reference.source.field ?? "markdown", kind: reference.source.kind } });
  }
  return results;
};

const targetKey = (documentId, nodeId = null) => `${documentId}\u0000${nodeId ?? ""}`;
// Undo retains earlier document objects. A WeakMap keyed by those objects would
// retain a full search index for every edit as long as history remains alive.
// Cache only the latest live version of each document instead.
const documentIndexCache = new Map();

export const buildKnowledgeIndex = (workspace) => {
  const liveIds = new Set(liveDocuments(workspace).map((document) => document.id));
  for (const id of documentIndexCache.keys()) if (!liveIds.has(id)) documentIndexCache.delete(id);
  const documents = [];
  const nodes = [];
  const tagMap = new Map();
  const backlinks = new Map();
  const nodesByDocument = new Map();
  for (const document of liveDocuments(workspace)) {
    const nodeRecords = new Map();
    documents.push({
      id: document.id,
      title: document.title || "未命名文档",
      updatedAt: document.updatedAt || "",
    });
    let cached = documentIndexCache.get(document.id);
    if (cached?.document !== document) {
      const records = [];
      walkNodes(document.nodes, (node, ancestors) => {
      const parentIds = ancestors.map((item) => item.id);
      const record = {
        documentId: document.id,
        nodeId: node.id,
        text: node.text || "",
        note: node.note || "",
        pathLabel: pathLabel(ancestors, node),
        parentIds,
        isTodo: node.isTodo === true,
        checked: node.checked === true,
        updatedAt: document.updatedAt || "",
        codeBlock: node.codeBlock || "",
        tableText: Array.isArray(node.table) ? node.table.flat().join(" ") : "",
      };
      record.tagKeys = new Set([...extractKnowledgeTags(record.text), ...extractKnowledgeTags(record.note)].map(foldKey));
      record.tags = [...new Set([...extractKnowledgeTags(record.text), ...extractKnowledgeTags(record.note)])];
      record.foldedText = foldKey(record.text); record.foldedNote = foldKey(record.note);
      record.foldedCode = foldKey(`${record.codeBlock} ${record.tableText}`);
      records.push(record);
      });
      cached = { document, records, hasLinks: records.some((record) => record.text.includes("[[") || record.note.includes("[[")) || document.markdownSource?.includes("[[") };
      documentIndexCache.set(document.id, cached);
    }
    nodesByDocument.set(document.id, cached.records);
    for (const record of cached.records) {
      nodes.push(record);
      nodeRecords.set(record.nodeId, record);
      const seen = new Set();
      for (const tag of record.tags) {
        const key = foldKey(tag);
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = tagMap.get(key) ?? { key, label: tag, nodes: [], documentIds: new Set() };
        entry.nodes.push({ documentId: document.id, nodeId: record.nodeId });
        entry.documentIds.add(document.id);
        tagMap.set(key, entry);
      }
    }
    const connections = cached.hasLinks || document.knowledge?.references?.length ? resolveDocumentConnections(workspace, document) : [];
    for (const item of connections) {
      if (item.status !== "resolved") continue;
      const target = item.reference?.target ?? (item.resolved?.documentId ? { documentId: item.resolved.documentId, nodeId: item.resolved.nodeId } : null);
      if (!target?.documentId) continue;
      const keys = [targetKey(target.documentId, null)];
      if (target.nodeId) keys.push(targetKey(target.documentId, target.nodeId));
      const source = {
        documentId: document.id,
        documentTitle: document.title || "未命名文档",
        nodeId: item.origin?.nodeId ?? null,
        field: item.origin?.field ?? "text",
        raw: item.link?.raw ?? item.reference?.source?.raw ?? "",
        label: item.link?.label ?? "",
        status: item.status,
        pathLabel: nodeRecords.get(item.origin?.nodeId)?.pathLabel ?? document.title,
        snippet: String(nodeRecords.get(item.origin?.nodeId)?.[item.origin?.field === "note" ? "note" : "text"] ?? item.link?.raw ?? "").slice(0, 120),
      };
      for (const key of keys) {
        const list = backlinks.get(key) ?? [];
        list.push(source);
        backlinks.set(key, list);
      }
    }
  }
  return {
    documents,
    nodes,
    nodesByDocument,
    tags: [...tagMap.values()].map((tag) => ({
      key: tag.key,
      label: tag.label,
      count: tag.nodes.length,
      documentCount: tag.documentIds.size,
      nodes: tag.nodes,
    })).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh-CN")),
    backlinks,
  };
};

const groupedBacklinks = (sources) => {
  const groups = new Map();
  for (const source of sources) {
    const key = `${source.documentId}\u0000${source.nodeId ?? ""}\u0000${source.field}`;
    const group = groups.get(key) ?? { ...source, count: 0 };
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()];
};

export const backlinksFor = (index, documentId, nodeId = null) => groupedBacklinks(
  index.backlinks.get(targetKey(documentId, nodeId)) ?? [],
);

const snippetAround = (text, query) => {
  const source = String(text ?? "");
  const needle = foldKey(query);
  const folded = foldKey(source);
  const at = needle ? folded.indexOf(needle) : -1;
  if (at < 0) return { text: source.slice(0, 120), ranges: [] };
  const start = Math.max(0, at - 36);
  const end = Math.min(source.length, at + Math.max(needle.length, 1) + 36);
  return {
    text: `${start ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`,
    ranges: [{
      start: (start ? 1 : 0) + (at - start),
      end: (start ? 1 : 0) + (at - start) + needle.length,
    }],
  };
};

const taskMatches = (node, task) => {
  if (!task || task === "all") return true;
  if (task === "open") return node.isTodo && !node.checked;
  if (task === "done") return node.isTodo && node.checked;
  return false;
};
const searchQueryCaches = new WeakMap();
const searchStats = new WeakMap();
export const knowledgeSearchStats = (index) => ({ ...(searchStats.get(index) ?? { scannedNodes: 0, cacheHits: 0 }) });
export const knowledgeIndexCacheStats = () => ({ documents: documentIndexCache.size,
  nodes: [...documentIndexCache.values()].reduce((total, entry) => total + entry.records.length, 0) });

export const searchKnowledge = (index, filters = {}) => {
  const query = identityKey(filters.query ?? "").trim();
  const foldedQuery = foldKey(query);
  const tags = (filters.tags ?? []).map(foldKey).filter(Boolean);
  const documentIds = Array.isArray(filters.documentIds) && filters.documentIds.length ? new Set(filters.documentIds) : null;
  const favorites = filters.favoriteOnly ? new Set(filters.favoriteIds ?? []) : null;
  const limit = Math.max(1, Math.min(MAX_SEARCH_PAGE, filters.limit ?? MAX_SEARCH_PAGE));
  const offset = Math.max(0, filters.offset ?? 0);
  let cache = searchQueryCaches.get(index);
  if (!cache) { cache = new Map(); searchQueryCaches.set(index, cache); }
  const key = JSON.stringify([foldedQuery, [...tags].sort(), documentIds ? [...documentIds].sort() : null, filters.task ?? "all", favorites ? [...favorites].sort() : null, filters.includeCode === true]);
  const stats = searchStats.get(index) ?? { scannedNodes: 0, cacheHits: 0 };
  searchStats.set(index, stats);
  const cached = cache.get(key);
  const hits = cached ?? [];
  const matchesNodeFilters = (node) => taskMatches(node, filters.task)
    && (!tags.length || tags.every((tag) => (node.tagKeys ?? new Set([...extractKnowledgeTags(node.text), ...extractKnowledgeTags(node.note)].map(foldKey))).has(tag)));
  if (cached) stats.cacheHits += 1;
  else {
  if (query) {
    for (const document of index.documents) {
      if (documentIds && !documentIds.has(document.id)) continue;
      if (favorites && !favorites.has(document.id)) continue;
      if ((tags.length || (filters.task && filters.task !== "all")) && !(index.nodesByDocument?.get(document.id) ?? index.nodes.filter((node) => node.documentId === document.id)).some(matchesNodeFilters)) continue;
      const title = document.title || "";
      const foldedTitle = foldKey(title);
      if (foldedTitle !== foldedQuery && !foldedTitle.includes(foldedQuery)) continue;
      hits.push({
        documentId: document.id,
        nodeId: null,
        field: "title",
        pathLabel: title,
        updatedAt: document.updatedAt,
        rank: foldedTitle === foldedQuery ? 400 : 300,
        ...snippetAround(title, query),
      });
    }
  }
  for (const node of index.nodes) {
    stats.scannedNodes += 1;
    if (documentIds && !documentIds.has(node.documentId)) continue;
    if (favorites && !favorites.has(node.documentId)) continue;
    if (!taskMatches(node, filters.task)) continue;
    if (tags.length) {
      const present = node.tagKeys ?? new Set([
        ...extractKnowledgeTags(node.text),
        ...extractKnowledgeTags(node.note),
      ].map(foldKey));
      if (tags.some((tag) => !present.has(tag))) continue;
    }
    if (!query && !tags.length && filters.task !== "open" && filters.task !== "done" && !filters.favoriteOnly && !documentIds) continue;
    if (query) {
      const fields = [
        ["text", node.text, 200],
        ["note", node.note, 100],
      ];
      if (filters.includeCode) fields.push(["code", `${node.codeBlock} ${node.tableText}`, 50]);
      for (const [field, value, rank] of fields) {
        const folded = field === "text" ? node.foldedText : field === "note" ? node.foldedNote : node.foldedCode;
        if (!(folded ?? foldKey(value)).includes(foldedQuery)) continue;
        hits.push({
          documentId: node.documentId,
          nodeId: node.nodeId,
          field,
          pathLabel: node.pathLabel,
          parentIds: node.parentIds,
          updatedAt: node.updatedAt,
          rank,
          ...snippetAround(value, query),
        });
        break;
      }
    } else {
      hits.push({
        documentId: node.documentId,
        nodeId: node.nodeId,
        field: "text",
        pathLabel: node.pathLabel,
        parentIds: node.parentIds,
        updatedAt: node.updatedAt,
        rank: 10,
        text: node.text.slice(0, 120),
        ranges: [],
      });
    }
  }
  hits.sort((left, right) => (
    right.rank - left.rank ||
    String(right.updatedAt).localeCompare(String(left.updatedAt)) ||
    `${left.documentId}:${left.nodeId ?? ""}`.localeCompare(`${right.documentId}:${right.nodeId ?? ""}`)
  ));
    cache.set(key, hits);
    while (cache.size > 4 || (cache.size > 1 && [...cache.values()].reduce((total, items) => total + items.length, 0) > 50_000)) cache.delete(cache.keys().next().value);
  }
  const page = hits.slice(offset, offset + limit);
  const groups = [];
  for (const hit of page) {
    let group = groups.find((item) => item.documentId === hit.documentId);
    if (!group) {
      group = {
        documentId: hit.documentId,
        title: index.documents.find((document) => document.id === hit.documentId)?.title ?? "未命名文档",
        hits: [],
      };
      groups.push(group);
    }
    group.hits.push(hit);
  }
  return { groups, total: hits.length, truncated: offset + page.length < hits.length, offset, limit };
};

export const suggestLinkTargets = (workspace, rawQuery, { limit = 8 } = {}) => {
  const query = String(rawQuery ?? "");
  const trailingTopic = query.endsWith("#") && !escaped(query, query.length - 1);
  const parseQuery = trailingTopic ? `${query}主题` : query;
  const parsed = readEscaped(parseQuery, 0, parseQuery.length, new Uint8Array(parseQuery.length));
  const documentQuery = parsed?.documentName ?? identityKey(query);
  const nodeQuery = trailingTopic ? "" : parsed?.nodeName ?? null;
  const items = [];
  const documents = liveDocuments(workspace);
  if (nodeQuery === null) {
    const matches = documents.filter((document) => !documentQuery || foldKey(document.title).includes(foldKey(documentQuery)));
    const titles = new Map();
    for (const document of matches) {
      const key = foldKey(document.title);
      titles.set(key, (titles.get(key) ?? 0) + 1);
    }
    for (const document of matches) {
      items.push({
        kind: "document",
        documentId: document.id,
        title: document.title || "未命名文档",
        detail: String(document.nodes?.[0]?.text ?? "空文档").slice(0, 64),
        ambiguous: titles.get(foldKey(document.title)) > 1,
      });
    }
    if (documentQuery && !documents.some((document) => identityKey(document.title) === documentQuery)) {
      items.push({ kind: "create", title: documentQuery });
    }
  } else {
    const docMatches = documents.filter((document) => !documentQuery || foldKey(document.title).includes(foldKey(documentQuery)));
    for (const document of docMatches) {
      const labels = new Map();
      walkNodes(document.nodes, (node) => { const key = identityKey(node.text); labels.set(key, (labels.get(key) ?? 0) + 1); });
      walkNodes(document.nodes, (node, ancestors) => {
        if (nodeQuery && !foldKey(node.text).includes(foldKey(nodeQuery))) return;
        items.push({
          kind: "node",
          documentId: document.id,
          nodeId: node.id,
          documentTitle: document.title || "未命名文档",
          title: node.text || "未命名主题",
          pathLabel: pathLabel(ancestors, node),
          detail: String(node.note ?? "").slice(0, 64),
          ambiguous: labels.get(identityKey(node.text)) > 1,
        });
      });
    }
  }
  const limited = items.slice(0, limit);
  const requiresExplicit = limited.some((item) => item.ambiguous) || new Set(limited.map((item) => foldKey(item.title ?? ""))).size !== limited.length;
  return { items: limited, requiresExplicit, highlight: requiresExplicit ? -1 : limited.length ? 0 : -1 };
};

const rewriteField = (document, node, field, workspace, rename, ambiguous) => {
  const text = fieldText(node, field);
  if (!text.includes("[[")) return false;
  const links = scanLinks(text);
  const fieldReferences = knowledgeEditable(document.knowledge) ? referencesForField(document.knowledge, node.id, field) : [];
  const covered = new Set();
  const edits = [];
  for (const reference of fieldReferences) {
    const linkIndex = links.findIndex((link) => linkCovered(reference, link));
    if (linkIndex >= 0) covered.add(linkIndex);
    if (reference.labelMode !== "auto" || reference.target?.documentId !== rename.documentId) continue;
    if (rename.nodeId && reference.target.nodeId !== rename.nodeId) continue;
    if (linkIndex < 0) continue;
    const link = links[linkIndex];
    const nextRaw = formatWikiLink({
      documentName: rename.nodeId ? link.documentName : rename.nextLabel,
      nodeName: rename.nodeId && reference.target.nodeId === rename.nodeId ? rename.nextLabel : link.nodeName,
      alias: link.alias,
    });
    if (nextRaw !== link.raw) {
      edits.push({ start: link.start, end: link.end, previousRaw: link.raw, nextRaw, reference });
    }
  }
  links.forEach((link, index) => {
    if (covered.has(index) || link.labelMode === "custom") return;
    if (fieldReferences.some((reference) => reference.source.raw === link.raw && !links.some((candidate) => linkCovered(reference, candidate)))) return;
    const resolved = resolveParsedLink(workspace, link, rename);
    const matchesDocument = resolved.documentId === rename.documentId || resolved.status === "resolved" && resolved.documentId === rename.documentId;
    if (resolved.status === "ambiguous") {
      const nameMatches = rename.nodeId
        ? identityKey(link.nodeName ?? "") === identityKey(rename.previous)
        : identityKey(link.documentName) === identityKey(rename.previous);
      if (nameMatches) ambiguous.push({ documentId: document.id, nodeId: node.id, field, raw: link.raw });
      return;
    }
    if (resolved.status !== "resolved" || resolved.documentId !== rename.documentId) return;
    if (rename.nodeId && resolved.nodeId !== rename.nodeId) return;
    if (!rename.nodeId && link.nodeName) {
      const nextRaw = formatWikiLink({ documentName: rename.nextLabel, nodeName: link.nodeName, alias: link.alias });
      if (nextRaw !== link.raw) edits.push({ start: link.start, end: link.end, previousRaw: link.raw, nextRaw, reference: null });
      return;
    }
    if (rename.nodeId && !link.nodeName) return;
    const nextRaw = formatWikiLink({
      documentName: rename.nodeId ? link.documentName : rename.nextLabel,
      nodeName: rename.nodeId ? rename.nextLabel : null,
      alias: link.alias,
    });
    if (nextRaw !== link.raw) edits.push({ start: link.start, end: link.end, previousRaw: link.raw, nextRaw, reference: null });
    void matchesDocument;
  });
  if (!edits.length) return false;
  const nextText = applyFieldEdits(text, edits, fieldReferences);
  if (nextText == null) return false;
  node[field] = nextText;
  return true;
};

export const renameTarget = (workspace, options) => {
  const documentId = options.documentId;
  const nodeId = options.nodeId ?? null;
  const nextLabel = String(options.nextLabel ?? "");
  const original = liveDocuments(workspace).find((document) => document.id === documentId);
  if (!original) return { workspace, updatedDocumentIds: [], ambiguous: [] };
  const previous = options.previousLabel ?? (nodeId ? findKnowledgeNode(original.nodes, nodeId)?.node.text ?? "" : original.title);
  if (previous === nextLabel) return { workspace, updatedDocumentIds: [], ambiguous: [] };
  const source = options.mutate ? workspace : { ...workspace, documents: liveDocuments(workspace).map((document) => ({
    ...document, ...(document.knowledge ? { knowledge: clone(document.knowledge) } : {}),
  })) };
  const originalKnowledge = new Map();
  const sourceBindings = new Map();
  const sourceOrigins = new Map();
  for (const candidate of liveDocuments(source)) {
    originalKnowledge.set(candidate.id, candidate.knowledge);
    const anchored = anchorMarkdownReferences(candidate);
    if (candidate.knowledge) candidate.knowledge = anchored;
    const bindings = new Map();
    const origins = typeof candidate.markdownSource === "string" ? markdownLinkOrigins(candidate, candidate.markdownSource) : new Map();
    sourceOrigins.set(candidate.id, origins);
    if (typeof candidate.markdownSource === "string" && knowledgeEditable(anchored)) {
      for (const [at, origin] of origins) {
        const reference = anchored.references.find((item) => item.source.kind === "node-field" && item.source.nodeId === origin.nodeId && item.source.field === origin.field && item.source.start === origin.start && item.source.end === origin.end);
        if (reference) bindings.set(at, reference.id);
      }
    }
    sourceBindings.set(candidate.id, bindings);
  }
  const document = liveDocuments(source).find((item) => item.id === documentId);
  const rename = { documentId, nodeId, previous, nextLabel };
  const ambiguous = [];
  const updated = new Set([documentId]);
  if (nodeId) {
    const located = findKnowledgeNode(document.nodes, nodeId);
    if (!located) return { workspace, updatedDocumentIds: [], ambiguous: [] };
    document.nodes = mapKnowledgeNodes(document.nodes, (node) => node.id === nodeId ? { ...node, text: nextLabel } : node);
    if (knowledgeEditable(document.knowledge)) {
      document.knowledge = relocateFieldReferences(document.knowledge, { nodeId, field: "text", text: nextLabel, previousText: previous });
    }
  } else {
    document.title = nextLabel;
  }
  for (const candidate of liveDocuments(source)) {
    if (candidate.knowledge && !knowledgeEditable(candidate.knowledge)) continue;
    let changed = false;
    candidate.nodes = mapKnowledgeNodes(candidate.nodes, (originalNode) => {
      const node = { ...originalNode };
      const renamedNode = candidate.id === documentId && node.id === nodeId;
      const textChanged = !renamedNode && rewriteField(candidate, node, "text", source, rename, ambiguous);
      const noteChanged = rewriteField(candidate, node, "note", source, rename, ambiguous);
      if (textChanged || noteChanged) { changed = true; return node; }
      return originalNode;
    });
    if (changed) updated.add(candidate.id);
  }
  for (const candidate of liveDocuments(source)) {
    if (typeof candidate.markdownSource !== "string") continue;
    if (candidate.knowledge && !knowledgeEditable(candidate.knowledge)) continue;
    const editable = knowledgeEditable(candidate.knowledge) ? candidate.knowledge : emptyKnowledge();
    const text = candidate.markdownSource;
    const links = scanLinks(text);
    const markdownRefs = editable.references.filter((reference) => reference.source?.kind === "markdown");
    const edits = [];
    const covered = new Set();
    for (const reference of markdownRefs) {
      const linkIndex = links.findIndex((link) => linkCovered(reference, link));
      if (linkIndex >= 0) covered.add(linkIndex);
      if (reference.labelMode !== "auto" || reference.target?.documentId !== documentId) continue;
      if (nodeId && reference.target.nodeId !== nodeId) continue;
      if (linkIndex < 0) continue;
      const link = links[linkIndex];
      const nextRaw = formatWikiLink({
        documentName: nodeId ? link.documentName : nextLabel,
        nodeName: nodeId && reference.target.nodeId === nodeId ? nextLabel : link.nodeName,
        alias: link.alias,
      });
      if (nextRaw !== link.raw) edits.push({ start: link.start, end: link.end, previousRaw: link.raw, nextRaw, reference });
    }
    links.forEach((link, index) => {
      if (covered.has(index) || link.alias) return;
      const fieldBinding = sourceBindings.get(candidate.id)?.get(link.start);
      if (fieldBinding) {
        const reference = editable.references.find((item) => item.id === fieldBinding);
        if (reference?.labelMode === "auto" && reference.target.documentId === documentId && (!nodeId || reference.target.nodeId === nodeId)) {
          const nextRaw = formatWikiLink({ documentName: nodeId ? link.documentName : nextLabel, nodeName: nodeId ? nextLabel : link.nodeName, alias: link.alias });
          if (nextRaw !== link.raw) edits.push({ start: link.start, end: link.end, previousRaw: link.raw, nextRaw, reference: null });
        }
        return;
      }
      const fieldOrigin = sourceOrigins.get(candidate.id)?.get(link.start);
      const origin = fieldOrigin ? { kind: "node-field", ...fieldOrigin } : { kind: "markdown" };
      if (editable.references.some((reference) => reference.source.raw === link.raw && reference.source.start < 0 && sourceMatches(editable, reference, origin))) return;
      const resolved = resolveParsedLink(source, link, rename);
      if (resolved.status === "ambiguous") {
        ambiguous.push({ documentId: candidate.id, nodeId: null, field: "markdown", raw: link.raw });
        return;
      }
      if (resolved.status !== "resolved" || resolved.documentId !== documentId) return;
      if (nodeId ? resolved.nodeId !== nodeId : link.nodeName) {
        if (!nodeId && link.nodeName && resolved.documentId === documentId) {
          const nextRaw = formatWikiLink({ documentName: nextLabel, nodeName: link.nodeName, alias: null });
          if (nextRaw !== link.raw) edits.push({ start: link.start, end: link.end, previousRaw: link.raw, nextRaw, reference: null });
        }
        return;
      }
      const nextRaw = formatWikiLink({
        documentName: nodeId ? link.documentName : nextLabel,
        nodeName: nodeId ? nextLabel : null,
      });
      if (nextRaw !== link.raw) edits.push({ start: link.start, end: link.end, previousRaw: link.raw, nextRaw, reference: null });
    });
    if (!edits.length) continue;
    const nextText = applyFieldEdits(text, edits, markdownRefs);
    if (nextText == null) continue;
    candidate.markdownSource = nextText;
    if (knowledgeEditable(candidate.knowledge)) candidate.knowledge.references = editable.references;
    updated.add(candidate.id);
  }
  for (const candidate of liveDocuments(source)) {
    if (candidate.id === documentId && typeof candidate.markdownSource === "string") {
      const before = candidate.markdownSource;
      const next = rewriteMarkdownLabel(candidate, { nodeId, nextLabel });
      if (next !== before) {
        candidate.markdownSource = next;
        candidate.knowledge = relocateMarkdownReferences(candidate.knowledge, next, before);
      }
    }
    if (!updated.has(candidate.id) && originalKnowledge.has(candidate.id)) {
      const original = originalKnowledge.get(candidate.id);
      if (original === undefined) delete candidate.knowledge;
      else candidate.knowledge = original;
    }
  }
  if (!options.mutate) {
    const originals = new Map(liveDocuments(workspace).map((document) => [document.id, document]));
    source.documents = source.documents.map((document) => updated.has(document.id) ? document : originals.get(document.id));
  }
  return { workspace: source, updatedDocumentIds: [...updated], ambiguous };
};

const relationError = (document, relation, { ignoreId = null } = {}) => {
  if (!relation.fromNodeId || !relation.toNodeId) return "需要选择两个主题";
  if (relation.fromNodeId === relation.toNodeId) return "不能把主题关联到自己";
  if (!findKnowledgeNode(document.nodes, relation.fromNodeId) || !findKnowledgeNode(document.nodes, relation.toNodeId)) {
    return "关系的两端必须是当前文档中的主题";
  }
  if (unicodeLength(relation.label ?? "") > MAX_RELATION_LABEL) return `关系标签最多 ${MAX_RELATION_LABEL} 个字符`;
  const knowledge = knowledgeEditable(document.knowledge) ? document.knowledge : emptyKnowledge();
  if (knowledge.relations.length >= MAX_RELATIONS && !ignoreId) return `单个文档最多 ${MAX_RELATIONS} 条关系`;
  const duplicate = knowledge.relations.some((item) => (
    item.id !== ignoreId && item.fromNodeId === relation.fromNodeId && item.toNodeId === relation.toNodeId
  ));
  return duplicate ? "这对主题已经有一条同方向关系" : null;
};

const withRelations = (document, relations) => ({ ...document, knowledge: { ...(knowledgeEditable(document.knowledge) ? document.knowledge : emptyKnowledge()), relations } });

export const addRelation = (document, input) => {
  const relation = {
    id: input.id || createId("rel"),
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    label: identityKey(input.label ?? ""),
  };
  const error = relationError(document, relation);
  if (error) return { document, error };
  const knowledge = knowledgeEditable(document.knowledge) ? document.knowledge : emptyKnowledge();
  return { document: withRelations(document, [...knowledge.relations, relation]), relation, error: null };
};

export const updateRelation = (document, id, patch) => {
  const knowledge = knowledgeEditable(document.knowledge) ? document.knowledge : emptyKnowledge();
  const current = knowledge.relations.find((item) => item.id === id);
  if (!current) return { document, error: "找不到关系" };
  const relation = {
    ...current,
    ...patch,
    id,
    label: patch.label === undefined ? current.label : identityKey(patch.label),
  };
  const error = relationError(document, relation, { ignoreId: id });
  if (error) return { document, error };
  return {
    document: withRelations(document, knowledge.relations.map((item) => item.id === id ? relation : item)),
    relation,
    error: null,
  };
};

export const deleteRelation = (document, id) => withRelations(
  document,
  (knowledgeEditable(document.knowledge) ? document.knowledge.relations : []).filter((item) => item.id !== id),
);

export const reverseRelation = (document, id) => {
  const current = (knowledgeEditable(document.knowledge) ? document.knowledge.relations : []).find((item) => item.id === id);
  if (!current) return { document, error: "找不到关系" };
  return updateRelation(document, id, { fromNodeId: current.toNodeId, toNodeId: current.fromNodeId });
};

export const relationView = (document) => (
  (knowledgeEditable(document.knowledge) ? document.knowledge.relations : []).map((relation) => ({
    ...relation,
    fromMissing: !findKnowledgeNode(document.nodes, relation.fromNodeId),
    toMissing: !findKnowledgeNode(document.nodes, relation.toNodeId),
  }))
);

export const rekeyNodes = (nodes, idFactory = () => createId("node")) => {
  const idMap = new Map();
  const walk = (list) => list.map((node) => {
    const id = idFactory();
    idMap.set(node.id, id);
    return { ...node, id, children: walk(childNodes(node)) };
  });
  return { nodes: walk(nodes ?? []), idMap };
};

export const copiedKnowledgeFragment = (knowledge, { sourceDocumentId, nextDocumentId, idMap, wholeDocument = false }) => {
  if (!knowledgeEditable(knowledge)) return { references: [], relations: [], locked: Boolean(knowledge) };
  const references = [];
  const sourceGroups = {}, groupIds = new Map();
  for (const [id, group] of Object.entries(knowledge.sourceGroups ?? {})) {
    const candidates = group.candidates.filter((item) => idMap.has(item.nodeId)).map((item) => ({ ...item, nodeId: idMap.get(item.nodeId) }));
    if (!candidates.length) continue;
    const nextId = createId("source"); groupIds.set(id, nextId);
    sourceGroups[nextId] = { ...group, candidates };
  }
  for (const reference of knowledge.references) {
    if (reference.source?.kind === "markdown" ? !wholeDocument : !idMap.has(reference.source.nodeId) && !groupIds.has(reference.source.groupId)) continue;
    const sameDocument = reference.target?.documentId === sourceDocumentId;
    const targetCopied = sameDocument && reference.target?.nodeId ? idMap.has(reference.target.nodeId) : false;
    references.push({
      ...clone(reference),
      id: createId("ref"),
      source: reference.source.kind === "markdown" ? { ...reference.source, start: -1, end: -1 } : { ...reference.source, nodeId: idMap.get(reference.source.nodeId) ?? reference.source.nodeId,
        ...(groupIds.has(reference.source.groupId) ? { groupId: groupIds.get(reference.source.groupId) } : {}) },
      target: {
        documentId: sameDocument && (!reference.target.nodeId || targetCopied) ? nextDocumentId : reference.target.documentId,
        ...(reference.target.nodeId ? { nodeId: targetCopied ? idMap.get(reference.target.nodeId) : reference.target.nodeId } : {}),
      },
    });
  }
  const relations = knowledge.relations.filter((relation) => idMap.has(relation.fromNodeId) && idMap.has(relation.toNodeId)).map((relation) => ({
    ...relation,
    id: createId("rel"),
    fromNodeId: idMap.get(relation.fromNodeId),
    toNodeId: idMap.get(relation.toNodeId),
  }));
  return { references, relations, sourceGroups, locked: false };
};

export const moveSubtreeConnections = (sourceDocument, targetDocument, movedIds) => {
  if ([sourceDocument, targetDocument].some((document) => document.knowledge && !knowledgeEditable(document.knowledge))) {
    return { source: sourceDocument, target: targetDocument, error: "这份文档的知识数据需要更新版本后才能移动主题" };
  }
  const ids = new Set(movedIds);
  const source = clone(sourceDocument);
  const target = clone(targetDocument);
  if (source.knowledge) source.knowledge = anchorMarkdownReferences(source);
  if (target.knowledge) target.knowledge = anchorMarkdownReferences(target);
  const sourceKnowledge = knowledgeEditable(source.knowledge) ? source.knowledge : emptyKnowledge();
  const targetKnowledge = knowledgeEditable(target.knowledge) ? target.knowledge : emptyKnowledge();
  const movedRelations = [];
  sourceKnowledge.relations = sourceKnowledge.relations.filter((relation) => {
    const from = ids.has(relation.fromNodeId);
    const to = ids.has(relation.toNodeId);
    if (from && to) {
      movedRelations.push(relation);
      return false;
    }
    return true;
  });
  const movedReferences = [];
  const movedGroups = new Map();
  sourceKnowledge.references = sourceKnowledge.references.filter((reference) => {
    const group = sourceKnowledge.sourceGroups?.[reference.source.groupId];
    if (group) {
      const moved = group.candidates.filter((item) => ids.has(item.nodeId));
      if (moved.length) {
        targetKnowledge.sourceGroups ??= {};
        let targetGroupId = movedGroups.get(reference.source.groupId);
        if (!targetGroupId) {
          targetGroupId = createId("source");
          movedGroups.set(reference.source.groupId, targetGroupId);
          targetKnowledge.sourceGroups[targetGroupId] = { ...group, candidates: moved };
        }
        const remaining = group.candidates.filter((item) => !ids.has(item.nodeId));
        movedReferences.push({ ...reference, id: remaining.length ? createId("ref") : reference.id,
          source: { ...reference.source, ...moved[0], groupId: targetGroupId, start: -1, end: -1 } });
        if (!remaining.length) return false;
        reference.source = { ...reference.source, ...remaining[0], start: -1, end: -1 };
      }
      if (reference.target?.documentId === source.id && reference.target.nodeId && ids.has(reference.target.nodeId)) reference.target = { ...reference.target, documentId: target.id };
      return true;
    }
    if (reference.source?.kind === "node-field" && ids.has(reference.source.nodeId)) {
      movedReferences.push(reference);
      return false;
    }
    if (reference.target?.documentId === source.id && reference.target.nodeId && ids.has(reference.target.nodeId)) {
      reference.target = { ...reference.target, documentId: target.id };
    }
    return true;
  });
  for (const [id, group] of Object.entries(sourceKnowledge.sourceGroups ?? {})) {
    group.candidates = group.candidates.filter((item) => !ids.has(item.nodeId));
    if (!group.candidates.length) delete sourceKnowledge.sourceGroups[id];
  }
  targetKnowledge.relations = [...targetKnowledge.relations, ...movedRelations];
  targetKnowledge.references = [...targetKnowledge.references, ...movedReferences.map((reference) => (
    reference.target?.documentId === source.id && reference.target.nodeId && ids.has(reference.target.nodeId)
      ? { ...reference, target: { ...reference.target, documentId: target.id } }
      : reference
  ))];
  source.knowledge = sourceKnowledge.references.length || sourceKnowledge.relations.length ? sourceKnowledge : source.knowledge ? sourceKnowledge : undefined;
  target.knowledge = targetKnowledge;
  return { source, target };
};

export const retargetIncomingNodes = (documents, { sourceDocumentId, targetDocumentId, movedIds }) => {
  const ids = new Set(movedIds);
  return documents.map((document) => {
    if (!knowledgeEditable(document.knowledge)) return document;
    let changed = false;
    const references = document.knowledge.references.map((reference) => {
      if (reference.target?.documentId === sourceDocumentId && reference.target.nodeId && ids.has(reference.target.nodeId)) {
        changed = true;
        return { ...reference, target: { ...reference.target, documentId: targetDocumentId } };
      }
      return reference;
    });
    return changed ? { ...document, knowledge: { ...document.knowledge, references } } : document;
  });
};

export const remapCollidingIds = (document, usedIds, idFactory = (prefix) => createId(prefix)) => {
  const next = clone(document);
  const idMap = new Map();
  if (usedIds.has(next.id)) {
    const id = idFactory("doc");
    idMap.set(next.id, id);
    next.id = id;
  }
  usedIds.add(next.id);
  const walk = (nodes) => nodes.map((node) => {
    let id = node.id;
    if (!id || usedIds.has(id) || idMap.has(id)) {
      const previous = id;
      id = idFactory("node");
      if (previous) idMap.set(previous, id);
    }
    usedIds.add(id);
    return { ...node, id, children: walk(childNodes(node)) };
  });
  next.nodes = walk(next.nodes ?? []);
  if (knowledgeEditable(next.knowledge) && idMap.size) {
    for (const group of Object.values(next.knowledge.sourceGroups ?? {})) {
      group.candidates = group.candidates.map((item) => ({ ...item, nodeId: idMap.get(item.nodeId) ?? item.nodeId }));
    }
    const sourceId = [...idMap.entries()].find(([, value]) => value === next.id)?.[0] ?? document.id;
    next.knowledge = {
      ...next.knowledge,
      references: next.knowledge.references.map((reference) => ({
        ...reference,
        source: reference.source?.kind === "node-field"
          ? { ...reference.source, nodeId: idMap.get(reference.source.nodeId) ?? reference.source.nodeId,
            ...(reference.source.sourceNodeId ? { sourceNodeId: idMap.get(reference.source.sourceNodeId) ?? reference.source.sourceNodeId } : {}) }
          : reference.source,
        target: {
          documentId: reference.target?.documentId === sourceId || reference.target?.documentId === document.id && idMap.has(document.id)
            ? next.id
            : reference.target?.documentId,
          ...(reference.target?.nodeId ? { nodeId: reference.target.documentId === document.id ? idMap.get(reference.target.nodeId) ?? reference.target.nodeId : reference.target.nodeId } : {}),
        },
      })),
      relations: next.knowledge.relations.map((relation) => ({
        ...relation,
        fromNodeId: idMap.get(relation.fromNodeId) ?? relation.fromNodeId,
        toNodeId: idMap.get(relation.toNodeId) ?? relation.toNodeId,
      })),
    };
  }
  return { document: next, idMap };
};

export const relocateMarkdownReferences = (knowledge, text, previousText) => {
  if (!knowledgeEditable(knowledge)) return knowledge;
  const next = clone(knowledge);
  const links = scanLinks(text);
  const used = new Set();
  const oldLinks = previousText === undefined ? null : scanLinks(previousText);
  let prefix = 0, suffix = 0;
  if (previousText !== undefined) {
    while (prefix < Math.min(previousText.length, text.length) && previousText[prefix] === text[prefix]) prefix++;
    while (suffix < Math.min(previousText.length, text.length) - prefix && previousText[previousText.length - suffix - 1] === text[text.length - suffix - 1]) suffix++;
  }
  next.references = next.references.flatMap((reference) => {
    if (reference?.source?.kind !== "markdown") return [reference];
    const oldCount = (oldLinks ?? knowledge.references.filter((item) => item.source?.kind === "markdown")).filter((item) => (item.source?.raw ?? item.raw) === reference.source.raw).length;
    const newCount = links.filter((item) => item.raw === reference.source.raw).length;
    if (oldCount > 1 && newCount > 0 && oldCount !== newCount) return [{ ...reference, source: { ...reference.source, start: -1, end: -1 } }];
    if (reference.source.start < 0 && newCount) return [reference];
    let projected = reference.source.start;
    if (previousText !== undefined && previousText.slice(reference.source.start, reference.source.end) === reference.source.raw) {
      if (reference.source.start >= previousText.length - suffix) projected += text.length - previousText.length;
      else if (reference.source.end > prefix) projected = -1;
    }
    const exactIndex = links.findIndex((link, index) => !used.has(index) && link.start === projected && link.raw === reference.source.raw);
    const matches = links.map((link, index) => ({ link, index })).filter((item) => !used.has(item.index) && item.link.raw === reference.source.raw);
    const chosen = exactIndex >= 0 ? { link: links[exactIndex], index: exactIndex } : matches.length === 1 ? matches[0] : null;
    if (!chosen) {
      return matches.length > 1 ? [{ ...reference, source: { ...reference.source, start: -1, end: -1 } }] : [];
    }
    used.add(chosen.index);
    return [{ ...reference, source: { ...reference.source, start: chosen.link.start, end: chosen.link.end, raw: chosen.link.raw } }];
  });
  return next;
};

export const anchorMarkdownReferences = (document) => {
  if (!knowledgeEditable(document.knowledge) || typeof document.markdownSource !== "string") return document.knowledge;
  const origins = markdownLinkOrigins(document, document.markdownSource);
  const references = document.knowledge.references.map((reference) => {
    if (reference.source?.kind !== "markdown") return reference;
    const { start, end, raw } = reference.source;
    if (start < 0 || document.markdownSource.slice(start, end) !== raw) return { ...reference, source: { ...reference.source, start: -1, end: -1 } };
    const origin = origins.get(start);
    if (!origin) return reference;
    const node = findKnowledgeNode(document.nodes, origin.nodeId)?.node;
    if (!node) return reference;
    const value = fieldText(node, origin.field);
    if (value.slice(origin.start, origin.end) !== raw) return { ...reference, source: { ...reference.source, start: -1, end: -1 } };
    return { ...reference, source: { kind: "node-field", ...origin, raw } };
  });
  return { ...document.knowledge, references };
};

export const reconcileMarkdownReferences = (before, after) => {
  let knowledge = anchorMarkdownReferences(before);
  if (!knowledgeEditable(knowledge)) return knowledge;
  const previousNodes = new Map();
  walkNodes(before.nodes, (node) => previousNodes.set(node.id, node));
  walkNodes(after.nodes, (node) => {
    const previous = previousNodes.get(node.id);
    if (!previous) return;
    for (const field of ["text", "note"]) {
      if (fieldText(previous, field) !== fieldText(node, field)) knowledge = relocateFieldReferences(knowledge, { nodeId: node.id, field, previousText: fieldText(previous, field), text: fieldText(node, field) });
    }
  });
  knowledge = relocateMarkdownReferences(knowledge, after.markdownSource ?? "", before.markdownSource);
  return guardLostSources(knowledge, new Set(collectIds(before.nodes)), after.nodes);
};

const guardLostSources = (knowledge, beforeIds, nodes, includeMarkdown = false) => {
  const afterIds = new Set(collectIds(nodes));
  const candidatesByRaw = new Map(), allByRaw = new Map();
  walkNodes(nodes, (node) => {
    for (const field of ["text", "note"]) {
      for (const raw of new Set(scanLinks(fieldText(node, field)).map((link) => link.raw))) {
        const all = allByRaw.get(raw) ?? [];
        all.push({ nodeId: node.id, field }); allByRaw.set(raw, all);
        if (beforeIds.has(node.id)) continue;
        const candidates = candidatesByRaw.get(raw) ?? [];
        candidates.push({ nodeId: node.id, field }); candidatesByRaw.set(raw, candidates);
      }
    }
  });
  const groups = { ...(knowledge.sourceGroups ?? {}) };
  const byRaw = new Map();
  for (const [id, group] of Object.entries(groups)) {
    const candidates = Array.isArray(group.candidates) ? group.candidates.filter((item) => afterIds.has(item.nodeId)) : [];
    groups[id] = { ...group, candidates };
    byRaw.set(group.raw, id);
  }
  const lostByRaw = new Map();
  for (const reference of knowledge.references) {
    if ((reference.source.kind === "node-field" && !afterIds.has(reference.source.nodeId)) || (includeMarkdown && reference.source.kind === "markdown")) {
      const lost = lostByRaw.get(reference.source.raw) ?? [];
      lost.push(reference); lostByRaw.set(reference.source.raw, lost);
    }
  }
  for (const [raw, references] of lostByRaw) {
    const candidates = (references.some((reference) => reference.source.kind === "markdown") ? allByRaw : candidatesByRaw).get(raw) ?? [];
    if (!candidates.length) continue;
    let id = byRaw.get(raw);
    if (!id) { id = createId("source"); byRaw.set(raw, id); groups[id] = { raw, candidates: [] }; }
    const merged = new Map([...groups[id].candidates, ...candidates].map((item) => [`${item.nodeId}:${item.field}`, item]));
    groups[id].candidates = [...merged.values()];
    for (const reference of references) reference.source = { ...reference.source, start: -1, end: -1, groupId: id };
  }
  if (Object.keys(groups).length) knowledge.sourceGroups = groups;
  return knowledge;
};

export const resolveWikiLink = (workspace, raw, origin = null) => {
  const link = scanLinks(String(raw ?? ""))[0];
  if (!link) return { status: "missing" };
  if (origin) {
    const document = liveDocuments(workspace).find((item) => item.id === origin.documentId);
    if (!document) return { status: "sourceMismatch", link };
    if (document.knowledge && !knowledgeEditable(document.knowledge)) return { status: "sourceMismatch", link };
    if (origin.kind === "markdown") {
      const mapped = markdownLinkOrigins(document, document.markdownSource ?? "").get(origin.start);
      if (mapped && findKnowledgeNode(document.nodes, mapped.nodeId)) origin = { documentId: document.id, kind: "node-field", ...mapped };
    }
    const sourceText = origin.kind === "markdown"
      ? String(document.markdownSource ?? "")
      : fieldText(findKnowledgeNode(document.nodes, origin.nodeId)?.node, origin.field);
    const sourceRaw = origin.sourceRaw ?? raw;
    if (origin.start < 0 || sourceText.slice(origin.start, origin.end) !== sourceRaw) {
      return { status: "sourceMismatch", link };
    }
    const normalized = anchorMarkdownReferences(document);
    const references = knowledgeEditable(normalized) ? normalized.references : [];
    const bound = references.filter((reference) => (
      reference.source?.kind === origin.kind &&
      reference.source.nodeId === origin.nodeId &&
      reference.source.field === origin.field &&
      reference.source.start === origin.start &&
      reference.source.end === origin.end
    ));
    if (bound.length > 1) return { status: "sourceMismatch", link };
    if (bound.length) {
      const reference = bound[0];
      return { status: referenceStatus(workspace, document, reference), ...reference.target, link };
    }
    // Do not reinterpret a displaced binding as a link to a recycled name.
    if (references.some((reference) => sourceMatches(normalized, reference, origin) && reference.source.raw === sourceRaw && referenceStatus(workspace, document, reference) === "sourceMismatch")) {
      return { status: "sourceMismatch", link };
    }
  }
  return { ...resolveParsedLink(workspace, link), link };
};

export const attachReference = (document, input) => {
  const next = clone(document);
  const knowledge = ensureKnowledge(next);
  if (!knowledge) return { document, error: "这份文档的知识数据需要更新版本后才能修改" };
  const sourceText = input.source.kind === "markdown"
    ? String(next.markdownSource ?? "")
    : fieldText(findKnowledgeNode(next.nodes, input.source.nodeId)?.node, input.source.field);
  if (sourceText.slice(input.source.start, input.source.end) !== input.source.raw) {
    return { document, error: "链接位置和当前文本不一致" };
  }
  knowledge.references = knowledge.references.filter((reference) => !(
    reference.source?.kind === input.source.kind &&
    reference.source.nodeId === input.source.nodeId &&
    reference.source.field === input.source.field &&
    reference.source.start === input.source.start
  ));
  const displaced = knowledge.references.findIndex((reference) => reference.source.kind === input.source.kind && reference.source.nodeId === input.source.nodeId && reference.source.field === input.source.field && reference.source.start < 0 && reference.source.raw === input.source.raw);
  if (displaced >= 0) knowledge.references.splice(displaced, 1);
  const reference = {
    id: input.id || createId("ref"),
    source: {
      kind: input.source.kind, start: input.source.start, end: input.source.end, raw: input.source.raw,
      ...(input.source.kind === "node-field" ? { nodeId: input.source.nodeId, field: input.source.field }
        : input.source.sourceNodeId ? { sourceNodeId: input.source.sourceNodeId } : {}),
    },
    target: input.target,
    labelMode: input.labelMode === "custom" ? "custom" : "auto",
  };
  knowledge.references.push(reference);
  const sameSource = (item) => item.source.kind === input.source.kind && item.source.nodeId === input.source.nodeId && item.source.field === input.source.field && item.source.raw === input.source.raw;
  const occurrences = scanLinks(sourceText).filter((link) => link.raw === input.source.raw);
  if (occurrences.every((link) => knowledge.references.some((item) => sameSource(item) && linkCovered(item, link)))) {
    knowledge.references = knowledge.references.filter((item) => !sameSource(item) || item.source.start >= 0);
    for (const [id, group] of Object.entries(knowledge.sourceGroups ?? {})) {
      if (group.raw !== input.source.raw || !Array.isArray(group.candidates)) continue;
      group.candidates = group.candidates.filter((item) => input.source.kind !== "node-field" || item.nodeId !== input.source.nodeId || item.field !== input.source.field);
      if (!group.candidates.length) {
        knowledge.references = knowledge.references.filter((item) => item.source.groupId !== id);
        delete knowledge.sourceGroups[id];
      }
    }
  }
  return { document: next, reference, error: null };
};

const LOSSY_MARKER = "<!-- bike-export:lossy -->";
const METADATA_PATTERN = /<!--\s*bike:document:v(\d+)\s+([A-Za-z0-9_-]+)\s*-->/gu;
const METADATA_START = "<!-- bike:metadata -->";
const METADATA_END = "<!-- /bike:metadata -->";

const jsonDepth = (value, depth = 1) => {
  let maximum = depth;
  const pending = [{ value, depth }];
  while (pending.length) {
    const item = pending.pop();
    maximum = Math.max(maximum, item.depth);
    if (maximum > 8) return maximum;
    if (item.value && typeof item.value === "object") {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  return maximum;
};

const validMetadataTree = (records) => {
  const ids = new Set(), paths = new Set(), siblings = new Map();
  for (const record of records) {
    if (!record.id || !record.path.length || ids.has(record.id)) return false;
    const key = record.path.join(".");
    if (paths.has(key) || (record.attributes !== undefined && !isRecord(record.attributes))) return false;
    ids.add(record.id); paths.add(key);
    const parent = record.path.slice(0, -1).join(".");
    const indices = siblings.get(parent) ?? [];
    indices.push(record.path.at(-1)); siblings.set(parent, indices);
  }
  for (const [parent, indices] of siblings) {
    if (parent && !paths.has(parent)) return false;
    indices.sort((a, b) => a - b);
    if (indices.some((index, at) => index !== at)) return false;
  }
  return true;
};

export const readBikeMetadata = (markdown) => {
  const source = String(markdown ?? "").replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const mask = codeMask(source);
  const standalone = (match) => !mask[match.index] && /^ {0,3}$/u.test(source.slice(source.lastIndexOf("\n", match.index - 1) + 1, match.index));
  const starts = [...source.matchAll(/^<!-- bike:metadata -->$/gmu)].filter(standalone);
  const ends = [...source.matchAll(/^<!-- \/bike:metadata -->$/gmu)].filter(standalone);
  let envelope = null;
  if (starts.length || ends.length) {
    if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) return { status: "invalid", error: "Bike 元数据封装无效或重复" };
    envelope = { start: starts[0].index, end: ends[0].index + METADATA_END.length };
  }
  const loose = [...source.matchAll(/<!--\s*bike:document:v\d+[^>]*-->/gu)].filter(standalone);
  const matches = [...source.matchAll(METADATA_PATTERN)].filter(standalone);
  if (envelope && (!matches.length || matches[0].index < envelope.start || matches[0].index >= envelope.end)) return { status: "invalid", error: "Bike 元数据字段无效" };
  if (!loose.length && !matches.length) return { status: "absent", body: source };
  if (matches.length === 1 && !["1", "2"].includes(matches[0][1])) {
    return { status: "unknown-version", version: Number(matches[0][1]) };
  }
  if (loose.length !== 1 || matches.length !== 1) {
    return { status: "invalid", error: "Bike 元数据格式无效" };
  }
  const match = matches[0];
  let decoded = "";
  try {
    const bytes = base64UrlToBytes(match[2]);
    if (bytes.length > MAX_METADATA_BYTES) return { status: "too-large" };
    decoded = textDecoder.decode(bytes);
  } catch {
    return { status: "invalid", error: "Bike 元数据无法解码" };
  }
  if (textEncoder.encode(decoded).length > MAX_METADATA_BYTES) return { status: "too-large" };
  let payload;
  try {
    payload = JSON.parse(decoded);
  } catch {
    return { status: "invalid", error: "Bike 元数据不是有效 JSON" };
  }
  if (!isRecord(payload) || payload.v !== Number(match[1]) || typeof payload.documentId !== "string" || !Array.isArray(payload.nodes) || typeof payload.digest !== "string") {
    return { status: "invalid", error: "Bike 元数据字段不完整" };
  }
  if (jsonDepth(payload) > 8) return { status: "invalid", error: "Bike 元数据嵌套过深" };
  const validNodes = payload.nodes.every((node) => isRecord(node) && typeof node.id === "string" && Array.isArray(node.path) && node.path.every((part) => Number.isInteger(part) && part >= 0) && typeof node.text === "string" && (node.exportText === undefined || typeof node.exportText === "string") && (node.note === undefined || typeof node.note === "string"));
  if (!validNodes) return { status: "invalid", error: "Bike 节点映射无效" };
  if (payload.title !== undefined && typeof payload.title !== "string") return { status: "invalid", error: "Bike 标题无效" };
  if (payload.documentAttributes !== undefined && !isRecord(payload.documentAttributes)) return { status: "invalid", error: "Bike 文档扩展无效" };
  if (payload.structure !== undefined && (payload.structure !== "tree-v1" || !validMetadataTree(payload.nodes))) {
    return { status: "invalid", error: "Bike 原始层级映射无效" };
  }
  if (payload.knowledge !== undefined && !knowledgeEditable(payload.knowledge)) {
    return { status: "invalid", error: "Bike 知识字段无效" };
  }
  const body = canonicalText(envelope ? source.slice(0, envelope.start) + source.slice(envelope.end) : source.replace(match[0], ""));
  return {
    status: payload.digest === sha256Hex(body) ? "matched" : "digest-mismatch",
    body,
    metadata: payload,
  };
};

const flattenIdentity = (nodes) => {
  const output = [];
  const stack = nodes.map((node, index) => ({ node, path: [index] })).reverse();
  while (stack.length) {
    const { node, path } = stack.pop();
    output.push({ id: node.id, path, text: node.text || "", node });
    const children = childNodes(node);
    for (let index = children.length - 1; index >= 0; index--) stack.push({ node: children[index], path: [...path, index] });
  }
  return output;
};

export const encodeBikeMetadata = (document, body) => {
  validateDocumentAttachments(document);
  const metadataVersion = document.attachments ? 2 : 1;
  if (document.knowledge && !knowledgeEditable(document.knowledge)) throw new Error("当前版本无法无损导出这份知识数据，请使用 JSON 导出保留原数据");
  const { id, title, nodes, knowledge, markdownSource, markdownUpdatedAt, updatedAt, ...documentAttributes } = document;
  const payload = {
    v: metadataVersion,
    documentId: document.id,
    title: document.title,
    documentAttributes,
    structure: "tree-v1",
    nodes: flattenIdentity(document.nodes ?? []).map(({ node, ...record }) => {
      const { id, text, note, children, ...attributes } = node;
      return { ...record, exportText: markdownTextForExport(record.text), note: note ?? "", attributes };
    }),
    ...(knowledgeEditable(document.knowledge)
      ? { knowledge: clone(anchorMarkdownReferences(document)) }
      : {}),
    digest: sha256Hex(canonicalText(body)),
  };
  if (!validMetadataTree(payload.nodes) || jsonDepth(payload) > 8) {
    throw new Error("当前数据无法安全编码为 Bike 元数据，请使用 JSON 导出保留原数据");
  }
  const encoded = textEncoder.encode(JSON.stringify(payload));
  if (encoded.length > MAX_METADATA_BYTES) {
    const error = new Error("Bike 元数据超过 2 MiB，已取消无损导出");
    error.code = "too-large";
    throw error;
  }
  return `<!-- bike:document:v${metadataVersion} ${bytesToBase64Url(encoded)} -->`;
};

const stripLossyTrailer = (body) => {
  const mask = codeMask(body);
  const index = [...body.matchAll(/<!-- bike-export:lossy -->/gu)].filter((match) => !mask[match.index]).at(-1)?.index ?? -1;
  if (index < 0) return body;
  return canonicalText(body.slice(0, index));
};

const nodeLabelMap = (document) => {
  const labels = new Map();
  walkNodes(document.nodes, (node) => labels.set(node.id, node.text || "未命名主题"));
  return labels;
};
export const readableRelations = (document, { separator = " → " } = {}) => {
  const labels = nodeLabelMap(document);
  return relationView(document).map((relation) => `${labels.get(relation.fromNodeId) ?? "缺失主题"}${separator}${labels.get(relation.toNodeId) ?? "缺失主题"}${relation.label ? `：${relation.label}` : ""}${relation.fromMissing || relation.toMissing ? "（端点缺失）" : ""}`);
};

export const finalizeMarkdownExport = (body, document, { metadata = false } = {}) => {
  const read = readBikeMetadata(body);
  if (["invalid", "unknown-version", "too-large"].includes(read.status)) return { content: String(body ?? ""), lossy: true, error: read.error ?? "原 Markdown 中的 Bike 元数据无法安全更新，请使用 JSON 保留原数据" };
  const plain = stripLossyTrailer(read.status === "unknown-version" ? String(body ?? "") : read.body ?? String(body ?? ""));
  const canonical = canonicalText(plain);
  if (!metadata) {
    const knowledge = knowledgeEditable(document.knowledge) ? document.knowledge : null;
    const lossReasons = ["稳定 id 与引用身份不包含在普通 Markdown 中"];
    if (String(body ?? "") !== canonical) lossReasons.push("文件末尾空白已规范化");
    let textNormalized = markdownTextForExport(String(document.title ?? "")) !== String(document.title ?? "");
    walkNodes(document.nodes, (node) => { if (markdownTextForExport(String(node.text ?? "")) !== String(node.text ?? "")) textNormalized = true; });
    if (textNormalized) lossReasons.push("主题文本中的换行或连续空白已规范化");
    if (!knowledge || (!knowledge.references.length && !knowledge.relations.length)) return { content: canonical, lossy: true, lossReasons };
    const labels = nodeLabelMap(document);
    const lines = ["", LOSSY_MARKER, "## 关系", ""];
    if (knowledge.relations.length) {
      for (const relation of knowledge.relations) {
        const from = labels.get(relation.fromNodeId) ?? "缺失主题";
        const to = labels.get(relation.toNodeId) ?? "缺失主题";
        lines.push(`- ${from} → ${to}${relation.label ? `：${relation.label}` : ""}`);
      }
    } else {
      lines.push("- （没有跨主题关系）");
    }
    lines.push("", "> 此 Markdown 不包含稳定 id。链接文字仍可读，但重名和身份信息可能丢失。如需在 Bike 间无损往返，请导出带元数据的 Markdown。", "");
    return { content: `${canonical}\n${lines.join("\n")}`, lossy: true, lossReasons };
  }
  try {
    return { content: `${canonical}\n\n${METADATA_START}\n${encodeBikeMetadata(document, canonical)}\n${METADATA_END}\n`, lossy: false };
  } catch (error) {
    return { content: canonical, lossy: true, error: error instanceof Error ? error.message : String(error) };
  }
};

const assignPaths = (nodes, records) => {
  const byPath = new Map(records.map((record) => [record.path.join("."), record]));
  walkNodes(nodes, (node, ancestors) => {
    const path = [];
    let siblings = nodes;
    for (const ancestor of ancestors) {
      path.push(siblings.findIndex((item) => item === ancestor));
      siblings = childNodes(ancestor);
    }
    // path of current node is computed by the caller below.
    void byPath;
    void node;
  });
  const visit = (list, parentPath) => {
    list.forEach((node, index) => {
      const path = [...parentPath, index];
      const record = byPath.get(path.join("."));
      if (record && identityKey(record.exportText ?? record.text) === identityKey(node.text)) {
        node.id = record.id;
        node.text = record.text;
        if (typeof record.note === "string") node.note = record.note;
      }
      visit(childNodes(node), path);
    });
  };
  visit(nodes, []);
};

const assignUniqueText = (nodes, records) => {
  const metadataGroups = new Map();
  for (const record of records) {
    const key = identityKey(record.exportText ?? record.text);
    metadataGroups.set(key, [...(metadataGroups.get(key) ?? []), record]);
  }
  const parsed = [];
  walkNodes(nodes, (node) => parsed.push(node));
  const parsedGroups = new Map();
  for (const node of parsed) {
    const key = identityKey(node.text);
    parsedGroups.set(key, [...(parsedGroups.get(key) ?? []), node]);
  }
  for (const [key, group] of metadataGroups) {
    const candidates = parsedGroups.get(key) ?? [];
    if (group.length === 1 && candidates.length === 1) candidates[0].id = group[0].id;
  }
};

export const restoreMarkdownIdentity = (document, metadata, { matched }) => {
  const next = { ...clone(document), ...(matched ? clone(metadata.documentAttributes ?? {}) : {}) };
  if (matched && metadata.structure === "tree-v1") {
    // Markdown cannot express every mix of heading/list hierarchy. The digest
    // authenticates the exported body; rebuild the original flat tree mapping.
    const byPath = new Map(metadata.nodes.map((record) => [record.path.join("."), {
      note: "", checked: false, collapsed: false, color: "plain",
      ...clone(record.attributes ?? {}), id: record.id, text: record.text, note: record.note ?? "", children: [],
    }]));
    next.nodes = [];
    for (const record of metadata.nodes) {
      const parent = record.path.slice(0, -1).join(".");
      const list = parent ? byPath.get(parent).children : next.nodes;
      list[record.path.at(-1)] = byPath.get(record.path.join("."));
    }
    if (typeof metadata.title === "string") next.title = metadata.title;
  } else if (matched) assignPaths(next.nodes, metadata.nodes);
  else assignUniqueText(next.nodes, metadata.nodes);
  if (metadata.documentId && matched) next.id = metadata.documentId;
  const live = new Set(collectIds(next.nodes));
  if (metadata.knowledge) {
    let knowledge = clone(metadata.knowledge);
    knowledge.references = knowledge.references.map((reference) => {
      if (reference.target?.documentId === metadata.documentId) {
        reference = { ...reference, target: { ...reference.target, documentId: next.id } };
      }
      if ((!matched && reference.source?.kind === "markdown") || (reference.source?.kind === "node-field" && !live.has(reference.source.nodeId))) {
        return { ...reference, source: { ...reference.source, start: -1, end: -1 } };
      }
      return reference;
    });
    if (!matched) knowledge = guardLostSources(knowledge, new Set(metadata.nodes.map((record) => record.id)), next.nodes, true);
    next.knowledge = knowledge;
  }
  return next;
};

export const summarizeKnowledge = (workspace, document, { limit = 40 } = {}) => {
  const bounded = (items) => ({ items: items.slice(0, limit), total: items.length, truncated: items.length > limit });
  const connections = knowledgeEditable(document.knowledge) || document.knowledge == null || document.knowledge?.version === KNOWLEDGE_VERSION
    ? resolveDocumentConnections(workspace, document)
    : [];
  // Compact readers need connections, not a second full text/tag/path index.
  // In particular, storing every ancestor path is quadratic on a deep outline.
  const incomingSources = [];
  for (const source of liveDocuments(workspace)) {
    for (const item of source === document ? connections : resolveDocumentConnections(workspace, source)) {
      const target = item.reference?.target ?? item.resolved;
      if (item.status !== "resolved" || target?.documentId !== document.id) continue;
      incomingSources.push({ documentId: source.id, documentTitle: source.title || "未命名文档", nodeId: item.origin?.nodeId ?? null,
        field: item.origin?.field ?? "text", raw: item.link?.raw ?? item.reference?.source?.raw ?? "",
        label: item.link?.label ?? "", status: item.status });
    }
  }
  const incoming = groupedBacklinks(incomingSources);
  const relations = relationView(document);
  return {
    references: bounded(connections.map((item) => ({
      status: item.status,
      raw: item.link?.raw ?? item.reference?.source?.raw ?? "",
      target: item.reference?.target ?? null,
      field: item.origin?.field ?? null,
    }))),
    incoming: bounded(incoming),
    relations: bounded(relations.map((relation) => ({
      id: relation.id,
      fromNodeId: relation.fromNodeId,
      toNodeId: relation.toNodeId,
      label: relation.label,
      broken: relation.fromMissing || relation.toMissing,
    }))),
    truncated: connections.length > limit || incoming.length > limit || relations.length > limit,
  };
};

export const expandAncestors = (nodes, nodeId) => {
  const located = findKnowledgeNode(nodes, nodeId);
  if (!located) return { nodes, found: false };
  const ancestors = new Set(located.ancestors.map((node) => node.id));
  let changed = false;
  const visit = (list) => {
    let listChanged = false;
    const result = list.map((node) => {
      const children = visit(childNodes(node));
      const collapsed = ancestors.has(node.id) ? false : node.collapsed;
      if (collapsed === node.collapsed && children === node.children) return node;
      changed = true;
      listChanged = true;
      return { ...node, collapsed, children };
    });
    return listChanged ? result : list;
  };
  const next = visit(nodes);
  return { nodes: changed ? next : nodes, found: true };
};

const NAVIGATION_LIMITS = { favorites: 500, recent: 50, filters: 30 };

export const createNavigationState = () => ({ version: 1, favorites: [], recent: [], filters: [] });

export const normalizeNavigation = (raw) => {
  const state = createNavigationState();
  if (!isRecord(raw)) return state;
  state.favorites = Array.isArray(raw.favorites) ? raw.favorites.filter((id) => typeof id === "string").slice(0, NAVIGATION_LIMITS.favorites) : [];
  state.recent = Array.isArray(raw.recent) ? raw.recent.filter((item) => isRecord(item) && typeof item.documentId === "string").slice(0, NAVIGATION_LIMITS.recent).map((item) => ({
    documentId: item.documentId,
    nodeId: typeof item.nodeId === "string" ? item.nodeId : null,
    view: typeof item.view === "string" ? item.view : "outline",
    openedAt: typeof item.openedAt === "string" ? item.openedAt : "",
  })) : [];
  state.filters = Array.isArray(raw.filters) ? raw.filters.filter((item) => isRecord(item) && typeof item.name === "string").slice(0, NAVIGATION_LIMITS.filters).map((item) => ({
    id: typeof item.id === "string" ? item.id : createId("filter"),
    name: item.name.slice(0, 40),
    query: typeof item.query === "string" ? item.query : "",
    tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string") : [],
    documentIds: Array.isArray(item.documentIds) ? item.documentIds.filter((id) => typeof id === "string") : [],
    task: item.task === "open" || item.task === "done" ? item.task : "all",
    favoriteOnly: item.favoriteOnly === true,
    includeCode: item.includeCode === true,
  })) : [];
  return state;
};

export const toggleFavorite = (state, documentId) => {
  const favorites = state.favorites.includes(documentId)
    ? state.favorites.filter((id) => id !== documentId)
    : [documentId, ...state.favorites].slice(0, NAVIGATION_LIMITS.favorites);
  return { ...state, favorites };
};

export const rememberOpen = (state, entry) => ({
  ...state,
  recent: [
    {
      documentId: entry.documentId,
      nodeId: entry.nodeId ?? null,
      view: entry.view ?? "outline",
      openedAt: entry.openedAt ?? new Date().toISOString(),
    },
    ...state.recent.filter((item) => item.documentId !== entry.documentId),
  ].slice(0, NAVIGATION_LIMITS.recent),
});

export const saveNavigationFilter = (state, filter) => {
  const next = {
    id: filter.id || createId("filter"),
    name: identityKey(filter.name || "未命名筛选").slice(0, 40),
    query: filter.query ?? "",
    tags: filter.tags ?? [],
    documentIds: filter.documentIds ?? [],
    task: filter.task === "open" || filter.task === "done" ? filter.task : "all",
    favoriteOnly: filter.favoriteOnly === true,
    includeCode: filter.includeCode === true,
  };
  const without = state.filters.filter((item) => item.id !== next.id && item.name !== next.name);
  return { ...state, filters: [next, ...without].slice(0, NAVIGATION_LIMITS.filters) };
};

export const deleteNavigationFilter = (state, id) => ({ ...state, filters: state.filters.filter((item) => item.id !== id) });

export const renameNavigationFilter = (state, id, name) => ({
  ...state,
  filters: state.filters.map((item) => item.id === id ? { ...item, name: identityKey(name).slice(0, 40) } : item),
});

export const pruneNavigation = (state, { liveIds, trashIds }) => {
  const live = new Set(liveIds);
  const known = new Set([...liveIds, ...trashIds]);
  const result = {
    ...state,
    favorites: state.favorites.filter((id) => known.has(id)),
    recent: state.recent.filter((item) => live.has(item.documentId)),
    filters: state.filters.map((filter) => ({
      ...filter,
      broken: filter.documentIds.some((id) => !live.has(id)),
    })),
  };
  return JSON.stringify(result) === JSON.stringify(state) ? state : result;
};

export const resetRecentOpens = (state) => ({ ...state, recent: [] });

export const pruneBackupPayloads = (payloads, state) => {
  const retained = new Set([state.writing?.ticket, state.pending?.ticket]);
  for (const ticket of payloads.keys()) if (!retained.has(ticket)) payloads.delete(ticket);
};
export const backupContentHash = (workspace) => {
  const copyNodes = (nodes = []) => nodes.map(({ collapsed, children, ...node }) => ({ ...node, children: copyNodes(children) }));
  const copyDocument = ({ updatedAt, markdownUpdatedAt, nodes, ...document }) => ({ ...document, nodes: copyNodes(nodes) });
  const { activeDocumentId, documents = [], trash, ...rest } = workspace;
  return sha256Hex(JSON.stringify({ ...rest, documents: documents.map(copyDocument),
    ...(trash ? { trash: trash.map((entry) => ({ ...entry, document: copyDocument(entry.document) })) } : {}) }));
};

export const createBackupSchedule = () => ({
  enabled: false,
  paused: null,
  dirtySince: null,
  pending: null,
  dueAt: null,
  writing: null,
  lastHash: null,
});

export const reduceBackupSchedule = (state, event, now) => {
  const next = { ...state };
  let enqueue = null;
  const startWrite = (job) => {
    enqueue = job;
    next.writing = job;
    next.pending = null;
    next.dueAt = null;
    next.dirtySince = null;
  };
  if (event.type === "set-enabled") {
    next.enabled = event.enabled === true;
    if (!next.enabled) {
      next.pending = null;
      next.dueAt = null;
      next.dirtySince = null;
    }
  } else if (event.type === "pause") {
    next.paused = event.reason || "paused";
    next.pending = null;
    next.dueAt = null;
  } else if (event.type === "resume") {
    next.paused = null;
  } else if (event.type === "saved") {
    if (!event.authoritative || !next.enabled || next.paused) return { state: next, enqueue };
    if (event.hash === next.lastHash && !next.pending && !next.writing) return { state: next, enqueue };
    if (next.pending?.hash === event.hash) {
      next.pending = { ticket: event.ticket, hash: event.hash };
      return { state: next, enqueue };
    }
    // A revert to the in-flight content must replace an intermediate pending
    // save, retaining the newest receipt so older windows cannot win later.
    if (next.writing?.hash === event.hash && !next.pending) return { state: next, enqueue };
    next.pending = { ticket: event.ticket, hash: event.hash };
    next.dirtySince ??= now;
    next.dueAt = now + 5000;
    if (!next.writing && now - next.dirtySince >= 60000) startWrite(next.pending);
  } else if ((event.type === "tick" || event.type === "flush") && next.enabled && !next.paused && next.pending && !next.writing) {
    if (event.type === "flush" || (next.dueAt != null && now >= next.dueAt)) startWrite(next.pending);
  } else if (event.type === "write-finished") {
    if (next.writing?.ticket === event.ticket) {
      if (event.ok) next.lastHash = event.hash ?? next.writing.hash;
      next.writing = null;
    }
    if (!next.writing && next.pending && next.enabled && !next.paused && next.pending.ticket !== event.ticket) {
      startWrite(next.pending);
    }
  }
  return { state: next, enqueue };
};
