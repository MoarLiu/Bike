export const MAX_DOCUMENT_NODES = 100_000;
export const MAX_DESKTOP_DEPTH = 256;
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
export const MAX_JSON_DEPTH = 600;
export const utf8ByteLength = (value) => new TextEncoder().encode(value).byteLength;

export class BikeResourceError extends Error {
  constructor(message, code = "resource-limit") { super(message); this.name = "BikeResourceError"; this.code = code; }
}

export const assertTextBudget = (text, maximum = MAX_DOCUMENT_BYTES) => {
  if (text.length > maximum || utf8ByteLength(text) > maximum) throw new BikeResourceError(`文件超过 ${Math.floor(maximum / 1024 / 1024)} MiB，已停止处理并保留原数据`);
};

export const assertTreeBudget = (nodes, { maxNodes = MAX_DOCUMENT_NODES, maxDepth = MAX_DESKTOP_DEPTH } = {}) => {
  if (!Array.isArray(nodes)) return { nodes: 0, depth: 0 };
  let count = 0, depth = 0;
  const seen = new WeakSet();
  const stack = [{ list: nodes, at: 0, depth: 1 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.at >= frame.list.length) { stack.pop(); continue; }
    const node = frame.list[frame.at++];
    if (++count > maxNodes || frame.list.length > maxNodes) throw new BikeResourceError(`主题数超过 ${maxNodes.toLocaleString("en-US")}，已停止处理并保留原数据`);
    if (frame.depth > maxDepth) throw new BikeResourceError(`主题深度超过 ${maxDepth} 层，已停止处理并保留原数据`);
    depth = Math.max(depth, frame.depth);
    if (node && typeof node === "object") {
      if (seen.has(node)) throw new BikeResourceError("主题包含循环或重复对象，已保留原数据");
      seen.add(node);
      if (Array.isArray(node.children) && node.children.length) stack.push({ list: node.children, at: 0, depth: frame.depth + 1 });
    }
  }
  return { nodes: count, depth };
};

export const assertValueBudget = (value, { maxDepth = MAX_JSON_DEPTH, maxBytes = MAX_DOCUMENT_BYTES, maxValues = 2_000_000 } = {}) => {
  let bytes = 0, values = 0;
  const ancestors = new WeakSet();
  const stack = [{ value, depth: 0, exit: false }];
  while (stack.length) {
    const frame = stack.pop();
    const item = frame.value;
    if (frame.exit) { ancestors.delete(item); continue; }
    if (++values > maxValues || frame.depth > maxDepth) throw new BikeResourceError("数据嵌套或字段数量超过处理预算，已保留原数据");
    if (typeof item === "string") bytes += utf8ByteLength(JSON.stringify(item));
    else if (item && typeof item === "object") {
      if (ancestors.has(item)) throw new BikeResourceError("数据包含循环引用，已保留原数据");
      ancestors.add(item);
      stack.push({ value: item, depth: frame.depth, exit: true });
      const entries = Array.isArray(item) ? item.map((child) => ["", child]) : Object.entries(item);
      bytes += entries.length * 2 + 2;
      for (let i = entries.length - 1; i >= 0; i--) {
        bytes += utf8ByteLength(JSON.stringify(entries[i][0]));
        stack.push({ value: entries[i][1], depth: frame.depth + 1, exit: false });
      }
    } else bytes += 8;
    if (bytes > maxBytes) throw new BikeResourceError(`数据超过 ${Math.floor(maxBytes / 1024 / 1024)} MiB 处理预算，已保留原数据`);
  }
  return { bytes, values };
};

export const assertDocumentBudget = (document, options) => {
  assertTreeBudget(document?.nodes, options);
  assertValueBudget(document, options);
};

export const assertWorkspaceBudget = (workspace) => {
  for (const document of workspace?.documents ?? []) assertTreeBudget(document?.nodes);
  for (const entry of workspace?.trash ?? []) assertTreeBudget(entry?.document?.nodes);
  assertValueBudget(workspace);
};
