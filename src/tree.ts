import type { FlatNode, OutlineNode } from "./types";

export const uid = () =>
  `node_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

export const createNode = (text = ""): OutlineNode => ({
  id: uid(),
  text,
  note: "",
  checked: false,
  collapsed: false,
  color: "plain",
  children: [],
});

export const cloneNodes = (nodes: OutlineNode[]): OutlineNode[] =>
  nodes.map((node) => ({
    ...node,
    children: cloneNodes(node.children ?? []),
  }));

export const countNodes = (nodes: OutlineNode[]): number =>
  nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);

export const findNode = (
  nodes: OutlineNode[],
  id: string,
): OutlineNode | null => {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(node.children, id);
    if (child) return child;
  }
  return null;
};

export const locateNode = (
  nodes: OutlineNode[],
  id: string,
  path: number[] = [],
): { node: OutlineNode; path: number[] } | null => {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const nextPath = [...path, index];
    if (node.id === id) return { node, path: nextPath };
    const child = locateNode(node.children, id, nextPath);
    if (child) return child;
  }
  return null;
};

export const getNodeAtPath = (
  nodes: OutlineNode[],
  path: number[],
): OutlineNode => {
  let current = nodes[path[0]];
  for (let index = 1; index < path.length; index += 1) {
    current = current.children[path[index]];
  }
  return current;
};

const siblingsAtPath = (
  nodes: OutlineNode[],
  path: number[],
): OutlineNode[] => {
  if (path.length === 1) return nodes;
  const parent = getNodeAtPath(nodes, path.slice(0, -1));
  return parent.children;
};

export const updateNode = (
  nodes: OutlineNode[],
  id: string,
  updater: (node: OutlineNode) => void,
): OutlineNode[] => {
  const next = cloneNodes(nodes);
  const located = locateNode(next, id);
  if (!located) return nodes;
  updater(located.node);
  return next;
};

export const insertSiblingAfter = (
  nodes: OutlineNode[],
  targetId: string,
  node: OutlineNode,
): OutlineNode[] => {
  const next = cloneNodes(nodes);
  const located = locateNode(next, targetId);
  if (!located) return [...next, node];
  const siblings = siblingsAtPath(next, located.path);
  siblings.splice(located.path[located.path.length - 1] + 1, 0, node);
  return next;
};

export const addChild = (
  nodes: OutlineNode[],
  targetId: string,
  child: OutlineNode,
): OutlineNode[] => {
  const next = cloneNodes(nodes);
  const located = locateNode(next, targetId);
  if (!located) return next;
  located.node.children.push(child);
  located.node.collapsed = false;
  return next;
};

export const insertParent = (
  nodes: OutlineNode[],
  targetId: string,
  parent: OutlineNode,
): OutlineNode[] => {
  const next = cloneNodes(nodes);
  const located = locateNode(next, targetId);
  if (!located) return next;
  const siblings = siblingsAtPath(next, located.path);
  const index = located.path[located.path.length - 1];
  const [node] = siblings.splice(index, 1);
  parent.children = [node];
  parent.collapsed = false;
  siblings.splice(index, 0, parent);
  return next;
};

export const removeNode = (
  nodes: OutlineNode[],
  targetId: string,
): OutlineNode[] => {
  const next = cloneNodes(nodes);
  const located = locateNode(next, targetId);
  if (!located) return nodes;
  const siblings = siblingsAtPath(next, located.path);
  siblings.splice(located.path[located.path.length - 1], 1);
  return next.length ? next : [createNode("新主题")];
};

export const indentNode = (
  nodes: OutlineNode[],
  targetId: string,
): OutlineNode[] => {
  const next = cloneNodes(nodes);
  const located = locateNode(next, targetId);
  if (!located) return nodes;
  const index = located.path[located.path.length - 1];
  if (index === 0) return nodes;
  const siblings = siblingsAtPath(next, located.path);
  const [node] = siblings.splice(index, 1);
  const previous = siblings[index - 1];
  previous.children.push(node);
  previous.collapsed = false;
  return next;
};

export const outdentNode = (
  nodes: OutlineNode[],
  targetId: string,
): OutlineNode[] => {
  const next = cloneNodes(nodes);
  const located = locateNode(next, targetId);
  if (!located || located.path.length < 2) return nodes;
  const childSiblings = siblingsAtPath(next, located.path);
  const childIndex = located.path[located.path.length - 1];
  const [node] = childSiblings.splice(childIndex, 1);
  const parentPath = located.path.slice(0, -1);
  const parentIndex = parentPath[parentPath.length - 1];
  const parentSiblings = siblingsAtPath(next, parentPath);
  parentSiblings.splice(parentIndex + 1, 0, node);
  return next;
};

export const moveNode = (
  nodes: OutlineNode[],
  targetId: string,
  direction: -1 | 1,
): OutlineNode[] => {
  const next = cloneNodes(nodes);
  const located = locateNode(next, targetId);
  if (!located) return nodes;
  const siblings = siblingsAtPath(next, located.path);
  const index = located.path[located.path.length - 1];
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= siblings.length) return nodes;
  const [node] = siblings.splice(index, 1);
  siblings.splice(targetIndex, 0, node);
  return next;
};

export const flattenNodes = (
  nodes: OutlineNode[],
  options: { respectCollapsed?: boolean; parentId?: string | null } = {},
  depth = 0,
  path: number[] = [],
): FlatNode[] => {
  const rows: FlatNode[] = [];
  nodes.forEach((node, index) => {
    const nextPath = [...path, index];
    rows.push({
      node,
      depth,
      parentId: options.parentId ?? null,
      path: nextPath,
    });
    if (!options.respectCollapsed || !node.collapsed) {
      rows.push(
        ...flattenNodes(
          node.children,
          { ...options, parentId: node.id },
          depth + 1,
          nextPath,
        ),
      );
    }
  });
  return rows;
};

export const firstNodeId = (nodes: OutlineNode[]) =>
  flattenNodes(nodes)[0]?.node.id ?? null;

export const extractTags = (text: string) =>
  Array.from(text.matchAll(/(^|\s)#([\p{L}\p{N}_-]+)/gu)).map(
    (match) => match[2],
  );

export const extractLinks = (text: string) =>
  Array.from(text.matchAll(/\[\[([^\]]+)\]\]/g)).map((match) =>
    match[1].trim(),
  );

export const nodeText = (node: OutlineNode) =>
  `${node.text} ${node.note}`.trim();

export const normalizeColor = (color: string) =>
  ["plain", "blue", "green", "amber", "rose"].includes(color)
    ? color
    : "plain";
