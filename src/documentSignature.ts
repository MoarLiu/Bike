import type { OutlineDocument } from "./types";
import { sha256Hex } from "./knowledge";

// Documents are immutable after ingestion. Comparisons must not migrate data,
// allocate identities or fill timestamps. Cache only immutable owning objects.
const signatures = new WeakMap<OutlineDocument, string>();
const nodeSignatures = new WeakMap<object, string>();
const treeSignatures = new WeakMap<OutlineDocument["nodes"], string>();
const nodeContent = (node: OutlineDocument["nodes"][number]) => ({
  ...node,
  note: typeof node.note === "string" ? node.note : "",
  checked: node.checked === true,
  collapsed: node.collapsed === true,
  color: ["plain", "blue", "green", "amber", "rose"].includes(node.color) ? node.color : "plain",
  headingLevel: [1, 2, 3].includes(node.headingLevel ?? 0) ? node.headingLevel : 0,
  bold: node.bold === true, italic: node.italic === true, underline: node.underline === true,
  strike: node.strike === true, highlight: node.highlight === true, isTodo: node.isTodo === true,
  children: treeSignature(node.children ?? []),
});

const treeSignature = (nodes: OutlineDocument["nodes"]): string => {
  const cached = treeSignatures.get(nodes);
  if (cached) return cached;
  const content = nodes.map((node) => {
    const cached = nodeSignatures.get(node);
    if (cached) return cached;
    const signature = sha256Hex(JSON.stringify(stableValue(nodeContent(node))));
    nodeSignatures.set(node, signature);
    return signature;
  });
  const signature = sha256Hex(JSON.stringify(content));
  treeSignatures.set(nodes, signature);
  return signature;
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]): [string, unknown] => [key, stableValue(item)])
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    );
  }
  return value;
};

// v2 was used by development candidates. Reconcile it without interpreting a
// hash from a different algorithm as an edit or a remote tombstone conflict.
export const legacyDocumentSignature = (document: OutlineDocument): string => {
  const copy = (nodes: OutlineDocument["nodes"]): unknown[] => nodes.map((node) => ({
    ...nodeContent(node), children: copy(node.children ?? []),
  }));
  const { updatedAt, markdownUpdatedAt, ...content } = document;
  return sha256Hex(JSON.stringify(stableValue({ ...content, nodes: copy(document.nodes ?? []) })));
};

export const documentSignature = (document: OutlineDocument): string => {
  const cached = signatures.get(document);
  if (cached !== undefined) return cached;
  const { updatedAt, markdownUpdatedAt, ...content } = document;
  const signature = sha256Hex(JSON.stringify(stableValue({ ...content, nodes: treeSignature(document.nodes ?? []) })));
  signatures.set(document, signature);
  return signature;
};

export const sameDocumentContent = (
  left: OutlineDocument,
  right: OutlineDocument,
) => left === right || documentSignature(left) === documentSignature(right);

// Selection is local navigation state, not synchronized content.
export const sameWorkspaceContent = (
  left: import("./types").Workspace,
  right: import("./types").Workspace,
) => left === right || (
  left.documents.length === right.documents.length &&
  left.documents.every((document, index) => (
    document.id === right.documents[index].id &&
    sameDocumentContent(document, right.documents[index])
  ))
);
