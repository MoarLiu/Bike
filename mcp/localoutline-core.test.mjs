import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WorkspaceStore,
  buildWorkspaceIndex,
  documentToMarkdown,
  exportDocumentForMcp,
  getDocument,
  getNode,
  getWorkspaceSummary,
  listDocuments,
  loadMcpConfig,
  migrateWorkspace,
  searchOutline,
} from "./localoutline-core.mjs";

const sampleWorkspace = () => ({
  version: 1,
  activeDocumentId: "doc_mcp",
  documents: [
    {
      id: "doc_mcp",
      title: "MCP 服务需求",
      createdAt: "2026-06-04T08:00:00.000Z",
      updatedAt: "2026-06-04T09:00:00.000Z",
      nodes: [
        {
          id: "node_background",
          text: "背景",
          note: "让 Codex 和 Claude 读取本地大纲。",
          checked: false,
          collapsed: false,
          color: "blue",
          children: [
            {
              id: "node_value",
              text: "需求价值",
              note: "减少复制粘贴，保留结构语义。",
              checked: false,
              collapsed: false,
              color: "plain",
              isTodo: false,
              children: [],
            },
          ],
        },
        {
          id: "node_tools",
          text: "Tool 需求",
          note: "",
          checked: true,
          collapsed: false,
          color: "green",
          isTodo: true,
          children: [],
        },
      ],
    },
    {
      id: "doc_other",
      title: "普通笔记",
      createdAt: "2026-06-03T08:00:00.000Z",
      updatedAt: "2026-06-03T09:00:00.000Z",
      nodes: [
        {
          id: "node_other",
          text: "无关内容",
          note: "",
          checked: false,
          collapsed: false,
          color: "plain",
          children: [],
        },
      ],
    },
  ],
});

const makeStore = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "localoutline-mcp-"));
  const workspacePath = path.join(directory, "localoutline-workspace.json");
  await fs.writeFile(workspacePath, JSON.stringify(sampleWorkspace(), null, 2), "utf8");
  return new WorkspaceStore({
    workspacePath,
    mode: "readonly",
    debug: true,
    maxSearchResults: 50,
    maxDocumentNodes: 2000,
  });
};

test("summarizes and lists workspace documents", async () => {
  const store = await makeStore();
  const snapshot = await store.load();

  const summary = getWorkspaceSummary(snapshot);
  assert.equal(summary.documentCount, 2);
  assert.equal(summary.nodeCount, 4);
  assert.equal(summary.workspacePathIsRedacted, false);

  const documents = listDocuments(snapshot, { query: "MCP" }).documents;
  assert.equal(documents.length, 1);
  assert.equal(documents[0].id, "doc_mcp");
  assert.equal(documents[0].nodeCount, 3);
});

test("uses Swift native backup path when Electron backup is absent on macOS", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "localoutline-home-"));
  const swiftBackupPath = path.join(
    homeDir,
    "Library",
    "Mobile Documents",
    "com~apple~CloudDocs",
    "LocalOutline",
    ".backups",
    "localoutline-workspace.json",
  );
  await fs.mkdir(path.dirname(swiftBackupPath), { recursive: true });
  await fs.writeFile(swiftBackupPath, "{}", "utf8");

  const config = await loadMcpConfig({
    env: {},
    homeDir,
    platform: "darwin",
  });

  assert.equal(config.workspacePath, swiftBackupPath);
});

test("searches title, node text, and notes with breadcrumbs", async () => {
  const store = await makeStore();
  const snapshot = await store.load();

  const titleMatches = searchOutline(snapshot, { query: "MCP", fields: ["title"] });
  assert.equal(titleMatches.matches[0].field, "title");

  const noteMatches = searchOutline(snapshot, { query: "Claude", fields: ["note"] });
  assert.equal(noteMatches.matches[0].nodeId, "node_background");
  assert.deepEqual(noteMatches.matches[0].breadcrumb, ["MCP 服务需求", "背景"]);

  const textMatches = searchOutline(snapshot, { query: "Tool", fields: ["text"] });
  assert.equal(textMatches.matches[0].nodeId, "node_tools");
});

test("returns compact documents, markdown, nodes, and exports", async () => {
  const store = await makeStore();
  const snapshot = await store.load();

  const compact = getDocument(snapshot, {
    documentId: "doc_mcp",
    format: "compact",
  });
  assert.equal(compact.content.nodes[0].children[0].text, "需求价值");

  const markdown = getDocument(snapshot, {
    documentId: "doc_mcp",
    format: "markdown",
  });
  assert.match(markdown.content, /# MCP 服务需求/);
  assert.match(markdown.content, /- \[x\] Tool 需求/);

  const node = getNode(snapshot, {
    documentId: "doc_mcp",
    nodeId: "node_value",
    includeAncestors: true,
    includeSiblings: true,
  });
  assert.deepEqual(node.ancestors.map((ancestor) => ancestor.id), ["node_background"]);
  assert.equal(node.node.depth, 1);

  const exported = exportDocumentForMcp(snapshot, {
    documentId: "doc_mcp",
    format: "markdown",
  });
  assert.equal(exported.mime, "text/markdown");
  assert.equal(exported.filename, "MCP 服务需求.md");
});

test("indexes deeply nested outlines without recursive stack overflow", () => {
  let root = {
    id: "deep_0",
    text: "deep 0",
    note: "",
    checked: false,
    collapsed: false,
    color: "plain",
    children: [],
  };
  let current = root;
  for (let index = 1; index < 5000; index += 1) {
    const child = {
      id: `deep_${index}`,
      text: `deep ${index}`,
      note: "",
      checked: false,
      collapsed: false,
      color: "plain",
      children: [],
    };
    current.children = [child];
    current = child;
  }

  const workspace = migrateWorkspace({
    version: 1,
    activeDocumentId: "doc_deep",
    documents: [
      {
        id: "doc_deep",
        title: "Deep",
        createdAt: "2026-06-04T08:00:00.000Z",
        updatedAt: "2026-06-04T09:00:00.000Z",
        nodes: [root],
      },
    ],
  });
  const index = buildWorkspaceIndex(workspace);

  assert.equal(index.nodeCount, 5000);
  assert.equal(
    index.nodesByDocumentId.get("doc_deep").byNodeId.get("deep_0").descendantCount,
    4999,
  );
  assert.match(documentToMarkdown(workspace.documents[0]), /deep 4999/);

  const snapshot = {
    workspace,
    index,
    config: {
      maxDocumentNodes: 10,
    },
  };
  const deepNode = getNode(snapshot, {
    documentId: "doc_deep",
    nodeId: "deep_4999",
    includeAncestors: true,
    childrenDepth: 0,
    format: "json",
  });
  assert.equal(deepNode.format, "compact");
  assert.equal(deepNode.truncated, true);
  assert.equal(deepNode.ancestors.length, 9);
  assert.equal(deepNode.ancestors[0].id, "deep_4990");
  assert.equal(deepNode.ancestors[8].id, "deep_4998");
});

test("limits get_node compact output by maxDocumentNodes", async () => {
  const store = await makeStore();
  store.config.maxDocumentNodes = 2;
  const snapshot = await store.load();

  const node = getNode(snapshot, {
    documentId: "doc_mcp",
    nodeId: "node_background",
    childrenDepth: 3,
  });

  assert.equal(node.truncated, false);
  assert.equal(node.node.children.length, 1);

  store.config.maxDocumentNodes = 1;
  const limited = getNode(snapshot, {
    documentId: "doc_mcp",
    nodeId: "node_background",
    childrenDepth: 3,
  });

  assert.equal(limited.truncated, true);
  assert.equal(limited.node.children.length, 0);
});

test("prioritizes get_node ancestors before large child subtrees", () => {
  const workspace = migrateWorkspace({
    version: 1,
    activeDocumentId: "doc_budget",
    documents: [
      {
        id: "doc_budget",
        title: "Budget",
        createdAt: "2026-06-04T08:00:00.000Z",
        updatedAt: "2026-06-04T09:00:00.000Z",
        nodes: [
          {
            id: "root",
            text: "Root",
            note: "",
            checked: false,
            collapsed: false,
            color: "plain",
            children: [
              {
                id: "target",
                text: "Target",
                note: "",
                checked: false,
                collapsed: false,
                color: "plain",
                children: Array.from({ length: 5 }, (_, index) => ({
                  id: `child_${index}`,
                  text: `Child ${index}`,
                  note: "",
                  checked: false,
                  collapsed: false,
                  color: "plain",
                  children: [],
                })),
              },
            ],
          },
        ],
      },
    ],
  });
  const snapshot = {
    workspace,
    index: buildWorkspaceIndex(workspace),
    config: {
      maxDocumentNodes: 3,
    },
  };

  const node = getNode(snapshot, {
    documentId: "doc_budget",
    nodeId: "target",
    includeAncestors: true,
    childrenDepth: 1,
  });

  assert.equal(node.truncated, true);
  assert.deepEqual(node.ancestors.map((ancestor) => ancestor.id), ["root"]);
  assert.deepEqual(node.node.children.map((child) => child.id), ["child_0"]);
});
