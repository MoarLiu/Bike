import type { FlatNode, OutlineNode } from "./types";
import { uuid } from "./id";
import { extractKnowledgeTags, scanLinks } from "./knowledge";

export const uid = () => `node_${uuid()}`;
export const createNode = (text = ""): OutlineNode => ({
  id: uid(), text, note: "", checked: false, collapsed: false, color: "plain", children: [],
});

export const cloneNodes = (nodes: OutlineNode[]): OutlineNode[] => {
  const result: OutlineNode[] = [];
  const stack = [{ source: nodes, target: result }];
  while (stack.length) {
    const { source, target } = stack.pop()!;
    for (const node of source) {
      const copy = { ...node, children: [] as OutlineNode[] };
      target.push(copy);
      stack.push({ source: node.children ?? [], target: copy.children });
    }
  }
  return result;
};

export const countNodes = (nodes: OutlineNode[]): number => {
  let count = 0;
  const stack = [nodes];
  while (stack.length) {
    for (const node of stack.pop()!) {
      count += 1;
      if (node.children?.length) stack.push(node.children);
    }
  }
  return count;
};

export const findNode = (nodes: OutlineNode[], id: string): OutlineNode | null => {
  const stack = [...nodes].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (node.id === id) return node;
    for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]);
  }
  return null;
};

export const locateNode = (
  nodes: OutlineNode[], id: string, path: number[] = [],
): { node: OutlineNode; path: number[] } | null => {
  const stack: Array<{ list: OutlineNode[]; index: number; path: number[] }> = [{ list: nodes, index: 0, path }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.list.length) { stack.pop(); continue; }
    const index = frame.index++;
    const node = frame.list[index];
    const nextPath = [...frame.path, index];
    if (node.id === id) return { node, path: nextPath };
    if (node.children.length) stack.push({ list: node.children, index: 0, path: nextPath });
  }
  return null;
};

export const getNodeAtPath = (nodes: OutlineNode[], path: number[]): OutlineNode => {
  let current = nodes[path[0]];
  for (let index = 1; index < path.length; index += 1) current = current.children[path[index]];
  return current;
};

const siblingsAtPath = (nodes: OutlineNode[], path: number[]) =>
  path.length === 1 ? nodes : getNodeAtPath(nodes, path.slice(0, -1)).children;

// Replace a sibling list, then copy only the nodes on its ancestor path.
const replaceSiblings = (nodes: OutlineNode[], path: number[], siblings: OutlineNode[]): OutlineNode[] => {
  let result = siblings;
  for (let depth = path.length - 2; depth >= 0; depth -= 1) {
    const ancestorPath = path.slice(0, depth + 1);
    const ancestor = getNodeAtPath(nodes, ancestorPath);
    const list = [...siblingsAtPath(nodes, ancestorPath)];
    list[path[depth]] = { ...ancestor, children: result };
    result = list;
  }
  return result;
};

const shallowEqualNode = (before: OutlineNode, after: OutlineNode) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .every((key) => Object.is(before[key as keyof OutlineNode], after[key as keyof OutlineNode]));

export const updateNode = (nodes: OutlineNode[], id: string, updater: (node: OutlineNode) => void): OutlineNode[] => {
  const located = locateNode(nodes, id);
  if (!located) return nodes;
  const updated = { ...located.node };
  updater(updated);
  if (shallowEqualNode(located.node, updated)) return nodes;
  const siblings = [...siblingsAtPath(nodes, located.path)];
  siblings[located.path[located.path.length - 1]] = updated;
  return replaceSiblings(nodes, located.path, siblings);
};

const insertSibling = (nodes: OutlineNode[], targetId: string, newNode: OutlineNode, after: boolean) => {
  const located = locateNode(nodes, targetId);
  if (!located) return nodes;
  const siblings = [...siblingsAtPath(nodes, located.path)];
  siblings.splice(located.path[located.path.length - 1] + Number(after), 0, newNode);
  return replaceSiblings(nodes, located.path, siblings);
};
export const insertSiblingAfter = (nodes: OutlineNode[], targetId: string, newNode: OutlineNode) =>
  insertSibling(nodes, targetId, newNode, true);
export const insertSiblingBefore = (nodes: OutlineNode[], targetId: string, newNode: OutlineNode) =>
  insertSibling(nodes, targetId, newNode, false);
export const addChild = (nodes: OutlineNode[], targetId: string, childNode: OutlineNode) =>
  updateNode(nodes, targetId, (node) => { node.collapsed = false; node.children = [...node.children, childNode]; });

export const findParentNodeId = (nodes: OutlineNode[], targetId: string, currentParentId: string | null = null): string | null => {
  const located = locateNode(nodes, targetId);
  return !located ? null : located.path.length === 1
    ? currentParentId : getNodeAtPath(nodes, located.path.slice(0, -1)).id;
};

export const insertParent = (nodes: OutlineNode[], targetId: string, parent: OutlineNode) => {
  const located = locateNode(nodes, targetId);
  if (!located) return nodes;
  const siblings = [...siblingsAtPath(nodes, located.path)];
  siblings[located.path[located.path.length - 1]] = { ...parent, children: [located.node], collapsed: false };
  return replaceSiblings(nodes, located.path, siblings);
};

const removeLocated = (nodes: OutlineNode[], path: number[]) => {
  const siblings = [...siblingsAtPath(nodes, path)];
  siblings.splice(path[path.length - 1], 1);
  return replaceSiblings(nodes, path, siblings);
};
export const removeNode = (nodes: OutlineNode[], targetId: string): OutlineNode[] => {
  const located = locateNode(nodes, targetId);
  if (!located) return nodes;
  const next = removeLocated(nodes, located.path);
  return next.length ? next : [createNode("新主题")];
};

export const indentNode = (nodes: OutlineNode[], targetId: string) => {
  const located = locateNode(nodes, targetId);
  if (!located) return nodes;
  const index = located.path[located.path.length - 1];
  if (!index) return nodes;
  const siblings = [...siblingsAtPath(nodes, located.path)];
  const previous = siblings[index - 1];
  siblings.splice(index - 1, 2, { ...previous, collapsed: false, children: [...previous.children, located.node] });
  return replaceSiblings(nodes, located.path, siblings);
};

export const outdentNode = (nodes: OutlineNode[], targetId: string) => {
  const located = locateNode(nodes, targetId);
  if (!located || located.path.length < 2) return nodes;
  const parentPath = located.path.slice(0, -1);
  const parent = getNodeAtPath(nodes, parentPath);
  const children = [...parent.children];
  children.splice(located.path[located.path.length - 1], 1);
  const siblings = [...siblingsAtPath(nodes, parentPath)];
  siblings.splice(parentPath[parentPath.length - 1], 1, { ...parent, children }, located.node);
  return replaceSiblings(nodes, parentPath, siblings);
};

export const moveNode = (nodes: OutlineNode[], targetId: string, direction: -1 | 1) => {
  const located = locateNode(nodes, targetId);
  if (!located) return nodes;
  const index = located.path[located.path.length - 1];
  const list = siblingsAtPath(nodes, located.path);
  if (index + direction < 0 || index + direction >= list.length) return nodes;
  const siblings = [...list];
  siblings.splice(index, 1);
  siblings.splice(index + direction, 0, located.node);
  return replaceSiblings(nodes, located.path, siblings);
};

export const relocateNode = (
  nodes: OutlineNode[], sourceId: string, targetId: string,
  zone: "before" | "after" | "child", focusId: string | null = null,
): OutlineNode[] => {
  if (sourceId === targetId || !["before", "after", "child"].includes(zone)) return nodes;
  const source = locateNode(nodes, sourceId);
  const target = locateNode(nodes, targetId);
  if (!source || !target || findNode(source.node.children, targetId)) return nodes;
  if (focusId) {
    const focus = findNode(nodes, focusId);
    if (!focus || sourceId === focusId || !findNode(focus.children, sourceId) ||
      (targetId !== focusId && !findNode(focus.children, targetId)) ||
      (targetId === focusId && zone !== "child")) return nodes;
  }
  const sourceIndex = source.path[source.path.length - 1];
  const targetIndex = target.path[target.path.length - 1];
  if (siblingsAtPath(nodes, source.path) === siblingsAtPath(nodes, target.path) &&
    ((zone === "before" && sourceIndex === targetIndex - 1) ||
     (zone === "after" && sourceIndex === targetIndex + 1))) return nodes;
  if (zone === "child" && target.node.children[target.node.children.length - 1] === source.node && !target.node.collapsed) return nodes;
  const remaining = removeLocated(nodes, source.path);
  return zone === "child" ? addChild(remaining, targetId, source.node)
    : insertSibling(remaining, targetId, source.node, zone === "after");
};

export const mergeNodes = (nodes: OutlineNode[], sourceId: string, targetId: string) => {
  const source = findNode(nodes, sourceId);
  if (!source || sourceId === targetId || !findNode(nodes, targetId) || findNode(source.children, targetId)) return nodes;
  return updateNode(removeNode(nodes, sourceId), targetId, (node) => {
    node.text = (node.text || "") + (source.text || "");
    node.note = [node.note, source.note].filter(Boolean).join("\n");
    node.checked = node.checked || source.checked;
    node.isTodo = node.isTodo || source.isTodo;
    if (node.color === "plain" && source.color !== "plain") node.color = source.color;
    for (const key of ["bold", "italic", "underline", "strike", "highlight"] as const) node[key] = node[key] || source[key];
    for (const key of ["icon", "imageName", "imageAlt", "codeBlock", "codeLanguage"] as const) node[key] = node[key] ?? source[key];
    node.table = node.table ?? source.table?.map((row) => [...row]);
    if (source.attachmentRefs?.length) node.attachmentRefs = [...(node.attachmentRefs ?? []), ...source.attachmentRefs];
    node.children = [...node.children, ...source.children];
  });
};

export const flattenNodes = (
  nodes: OutlineNode[], options: { respectCollapsed?: boolean; parentId?: string | null } = {},
  depth = 0, path: number[] = [],
): FlatNode[] => {
  const rows: FlatNode[] = [];
  const stack = [{ list: nodes, index: 0, depth, path, parentId: options.parentId ?? null }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.list.length) { stack.pop(); continue; }
    const index = frame.index++;
    const node = frame.list[index];
    const nextPath = [...frame.path, index];
    rows.push({ node, depth: frame.depth, parentId: frame.parentId, path: nextPath });
    if (node.children.length && (!options.respectCollapsed || !node.collapsed)) {
      stack.push({ list: node.children, index: 0, depth: frame.depth + 1, path: nextPath, parentId: node.id });
    }
  }
  return rows;
};

export const firstNodeId = (nodes: OutlineNode[]) => nodes[0]?.id ?? null;
export const extractTags = (text: string) => extractKnowledgeTags(text);
export const extractLinks = (text: string) => scanLinks(text).map((link) => link.label);
export const nodeText = (node: OutlineNode) => `${node.text} ${node.note}`.trim();
export const normalizeColor = (color: string) => ["plain", "blue", "green", "amber", "rose"].includes(color) ? color : "plain";
