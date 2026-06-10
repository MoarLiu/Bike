import type { FlatNode, OutlineNode } from "./types";

export const uid = () =>
  `node_${crypto.randomUUID()}`;

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

const shallowEqualNode = (before: OutlineNode, after: OutlineNode) => {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const field = key as keyof OutlineNode;
    if (!Object.is(before[field], after[field])) return false;
  }
  return true;
};

export const updateNode = (
  nodes: OutlineNode[],
  id: string,
  updater: (node: OutlineNode) => void,
): OutlineNode[] => {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.id === id) {
      const updated = { ...node };
      updater(updated);
      if (shallowEqualNode(node, updated)) return node;
      changed = true;
      return updated;
    }
    if (node.children && node.children.length > 0) {
      const nextChildren = updateNode(node.children, id, updater);
      if (nextChildren !== node.children) {
        changed = true;
        return { ...node, children: nextChildren };
      }
    }
    return node;
  });
  return changed ? next : nodes;
};

export const insertSiblingAfter = (
  nodes: OutlineNode[],
  targetId: string,
  newNode: OutlineNode,
): OutlineNode[] => {
  const index = nodes.findIndex((n) => n.id === targetId);
  if (index !== -1) {
    const next = [...nodes];
    next.splice(index + 1, 0, newNode);
    return next;
  }
  return nodes.map((node) => {
    if (node.children && node.children.length > 0) {
      const nextChildren = insertSiblingAfter(node.children, targetId, newNode);
      if (nextChildren !== node.children) {
        return { ...node, children: nextChildren };
      }
    }
    return node;
  });
};

export const insertSiblingBefore = (
  nodes: OutlineNode[],
  targetId: string,
  newNode: OutlineNode,
): OutlineNode[] => {
  const index = nodes.findIndex((n) => n.id === targetId);
  if (index !== -1) {
    const next = [...nodes];
    next.splice(index, 0, newNode);
    return next;
  }
  return nodes.map((node) => {
    if (node.children && node.children.length > 0) {
      const nextChildren = insertSiblingBefore(node.children, targetId, newNode);
      if (nextChildren !== node.children) {
        return { ...node, children: nextChildren };
      }
    }
    return node;
  });
};

export const addChild = (
  nodes: OutlineNode[],
  targetId: string,
  childNode: OutlineNode,
): OutlineNode[] => {
  return nodes.map((node) => {
    if (node.id === targetId) {
      return {
        ...node,
        collapsed: false,
        children: [...node.children, childNode],
      };
    }
    if (node.children && node.children.length > 0) {
      const nextChildren = addChild(node.children, targetId, childNode);
      if (nextChildren !== node.children) {
        return { ...node, children: nextChildren };
      }
    }
    return node;
  });
};

export const findParentNodeId = (
  nodes: OutlineNode[],
  targetId: string,
  currentParentId: string | null = null,
): string | null => {
  for (const node of nodes) {
    if (node.id === targetId) {
      return currentParentId;
    }
    if (node.children && node.children.length > 0) {
      const found = findParentNodeId(node.children, targetId, node.id);
      if (found !== null) return found;
    }
  }
  return null;
};

export const insertParent = (
  nodes: OutlineNode[],
  targetId: string,
  parent: OutlineNode,
): OutlineNode[] => {
  const next = cloneNodes(nodes);
  const located = locateNode(next, targetId);
  if (!located) return nodes;
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
  const index = nodes.findIndex((n) => n.id === targetId);
  if (index !== -1) {
    if (index === 0) return nodes;
    const previous = nodes[index - 1];
    const target = nodes[index];
    const nextPrevious = {
      ...previous,
      collapsed: false,
      children: [...previous.children, target],
    };
    const next = [...nodes];
    next.splice(index - 1, 2, nextPrevious);
    return next;
  }
  return nodes.map((node) => {
    if (node.children && node.children.length > 0) {
      const nextChildren = indentNode(node.children, targetId);
      if (nextChildren !== node.children) {
        return { ...node, children: nextChildren };
      }
    }
    return node;
  });
};

export const outdentNode = (
  nodes: OutlineNode[],
  targetId: string,
): OutlineNode[] => {
  const recurse = (
    list: OutlineNode[],
  ): { newNodes: OutlineNode[]; outdentedNode: OutlineNode | null } => {
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      const childIndex = node.children.findIndex((c) => c.id === targetId);
      if (childIndex !== -1) {
        const targetNode = node.children[childIndex];
        const nextChildren = [...node.children];
        nextChildren.splice(childIndex, 1);
        const nextNode = { ...node, children: nextChildren };
        
        const nextList = [...list];
        nextList.splice(i, 1, nextNode);
        nextList.splice(i + 1, 0, targetNode);
        return { newNodes: nextList, outdentedNode: targetNode };
      }
    }
    
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      if (node.children && node.children.length > 0) {
        const { newNodes: nextChildren, outdentedNode } = recurse(node.children);
        if (nextChildren !== node.children) {
          const nextNode = { ...node, children: nextChildren };
          const nextList = [...list];
          nextList.splice(i, 1, nextNode);
          return { newNodes: nextList, outdentedNode };
        }
      }
    }
    
    return { newNodes: list, outdentedNode: null };
  };

  const { newNodes } = recurse(nodes);
  return newNodes;
};

export const moveNode = (
  nodes: OutlineNode[],
  targetId: string,
  direction: -1 | 1,
): OutlineNode[] => {
  const index = nodes.findIndex((n) => n.id === targetId);
  if (index !== -1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= nodes.length) return nodes;
    const next = [...nodes];
    const [node] = next.splice(index, 1);
    next.splice(targetIndex, 0, node);
    return next;
  }
  return nodes.map((node) => {
    if (node.children && node.children.length > 0) {
      const nextChildren = moveNode(node.children, targetId, direction);
      if (nextChildren !== node.children) {
        return { ...node, children: nextChildren };
      }
    }
    return node;
  });
};

export const mergeNodes = (
  nodes: OutlineNode[],
  sourceId: string,
  targetId: string,
): OutlineNode[] => {
  const sourceNode = findNode(nodes, sourceId);
  if (!sourceNode) return nodes;
  const nextWithoutSource = removeNode(nodes, sourceId);
  return updateNode(nextWithoutSource, targetId, (node) => {
    node.text = (node.text || "") + (sourceNode.text || "");
    node.note = [node.note, sourceNode.note].filter(Boolean).join("\n");
    node.checked = node.checked || sourceNode.checked;
    node.isTodo = node.isTodo || sourceNode.isTodo;
    if (node.color === "plain" && sourceNode.color !== "plain") {
      node.color = sourceNode.color;
    }
    node.bold = node.bold || sourceNode.bold;
    node.italic = node.italic || sourceNode.italic;
    node.underline = node.underline || sourceNode.underline;
    node.strike = node.strike || sourceNode.strike;
    node.highlight = node.highlight || sourceNode.highlight;
    node.icon = node.icon ?? sourceNode.icon;
    node.imageName = node.imageName ?? sourceNode.imageName;
    node.imageAlt = node.imageAlt ?? sourceNode.imageAlt;
    node.table = node.table ?? sourceNode.table?.map((row) => [...row]);
    node.codeBlock = node.codeBlock ?? sourceNode.codeBlock;
    node.codeLanguage = node.codeLanguage ?? sourceNode.codeLanguage;
    node.children = [...(node.children || []), ...(sourceNode.children || [])];
  });
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
