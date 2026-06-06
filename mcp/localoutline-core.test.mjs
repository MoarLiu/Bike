import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WorkspaceStore,
  appendChildrenForMcp,
  buildWorkspaceIndex,
  createDocumentForMcp,
  createNodeForMcp,
  deleteNodeForMcp,
  documentToMarkdown,
  exportDocumentForMcp,
  getDocument,
  getNode,
  getWorkspaceSummary,
  listDocuments,
  loadMcpConfig,
  migrateWorkspace,
  moveNodeForMcp,
  searchOutline,
  setNodeCheckedForMcp,
  updateDocumentTitleForMcp,
  updateNodeForMcp,
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

const makeStore = async ({ mode = "readonly" } = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "localoutline-mcp-"));
  const workspacePath = path.join(directory, "localoutline-workspace.json");
  await fs.writeFile(workspacePath, JSON.stringify(sampleWorkspace(), null, 2), "utf8");
  return new WorkspaceStore({
    workspacePath,
    mode,
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

test("previews document creation without writing files", async () => {
  const store = await makeStore();
  const snapshot = await store.load();
  const beforeRaw = await fs.readFile(store.config.workspacePath, "utf8");

  const result = await createDocumentForMcp(store, {
    expectedRevision: snapshot.revision,
    dryRun: true,
    title: "AI 建议",
    initialNodes: [
      {
        text: "待确认任务",
        children: [{ text: "子任务" }],
      },
    ],
  });

  assert.equal(result.applied, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.affected.documentIds.length, 1);
  assert.notEqual(result.nextWorkspaceRevision, snapshot.revision);
  assert.equal(await fs.readFile(store.config.workspacePath, "utf8"), beforeRaw);
  await assert.rejects(
    fs.stat(path.join(path.dirname(store.config.workspacePath), ".backups")),
    /ENOENT/,
  );
});

test("dry-run create_node returns confirmation args with stable ids and revision", async () => {
  const store = await makeStore({ mode: "write" });
  const snapshot = await store.load();

  const preview = await createNodeForMcp(store, {
    expectedRevision: snapshot.revision,
    dryRun: true,
    documentId: "doc_mcp",
    parentNodeId: "node_background",
    text: "预览后确认",
    children: [{ text: "确认子任务" }],
  });

  assert.equal(preview.applied, false);
  assert.equal(preview.confirmationArgs.dryRun, false);
  assert.equal(preview.confirmationArgs.expectedRevision, snapshot.revision);
  assert.ok(preview.confirmationArgs.id);
  assert.ok(preview.confirmationArgs.writeTimestamp);

  const applied = await createNodeForMcp(store, preview.confirmationArgs);
  assert.equal(applied.applied, true);
  assert.equal(applied.nextWorkspaceRevision, preview.nextWorkspaceRevision);

  const next = await store.load();
  const node = getNode(next, {
    documentId: "doc_mcp",
    nodeId: preview.confirmationArgs.id,
    childrenDepth: 1,
  }).node;
  assert.equal(node.text, "预览后确认");
  assert.equal(node.children[0].id, preview.confirmationArgs.children[0].id);
});

test("rejects real writes in readonly mode and stale revisions", async () => {
  const store = await makeStore();
  const snapshot = await store.load();

  await assert.rejects(
    updateNodeForMcp(store, {
      expectedRevision: snapshot.revision,
      dryRun: false,
      documentId: "doc_mcp",
      nodeId: "node_tools",
      text: "真实写入",
    }),
    /readonly 模式/,
  );

  await assert.rejects(
    updateNodeForMcp(store, {
      expectedRevision: "stale",
      dryRun: true,
      documentId: "doc_mcp",
      nodeId: "node_tools",
      text: "不会预览",
    }),
    /revision 冲突/,
  );
});

test("serializes concurrent real writes so stale revisions cannot overwrite", async () => {
  const store = await makeStore({ mode: "write" });
  const snapshot = await store.load();

  const results = await Promise.allSettled([
    updateNodeForMcp(store, {
      expectedRevision: snapshot.revision,
      dryRun: false,
      documentId: "doc_mcp",
      nodeId: "node_tools",
      text: "并发写入 A",
    }),
    updateNodeForMcp(store, {
      expectedRevision: snapshot.revision,
      dryRun: false,
      documentId: "doc_mcp",
      nodeId: "node_tools",
      text: "并发写入 B",
    }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.match(String(rejected.reason?.message ?? rejected.reason), /revision 冲突/);
});

test("serializes real writes from separate store instances with a workspace lock", async () => {
  const firstStore = await makeStore({ mode: "write" });
  const secondStore = new WorkspaceStore({ ...firstStore.config });
  const snapshot = await firstStore.load();

  const results = await Promise.allSettled([
    updateNodeForMcp(firstStore, {
      expectedRevision: snapshot.revision,
      dryRun: false,
      documentId: "doc_mcp",
      nodeId: "node_tools",
      text: "跨实例写入 A",
    }),
    updateNodeForMcp(secondStore, {
      expectedRevision: snapshot.revision,
      dryRun: false,
      documentId: "doc_mcp",
      nodeId: "node_tools",
      text: "跨实例写入 B",
    }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.match(String(rejected.reason?.message ?? rejected.reason), /revision 冲突/);

  const lockPath = path.join(
    path.dirname(firstStore.config.workspacePath),
    `.${path.basename(firstStore.config.workspacePath)}.lock`,
  );
  await assert.rejects(fs.stat(lockPath), /ENOENT/);
});

test("does not release a workspace lock owned by another writer", async () => {
  const store = await makeStore({ mode: "write" });
  const lockPath = path.join(
    path.dirname(store.config.workspacePath),
    `.${path.basename(store.config.workspacePath)}.lock`,
  );
  const release = await store.acquireWorkspaceWriteLock();
  const replacementLock = `${JSON.stringify(
    {
      pid: process.pid,
      ownerToken: "replacement-owner",
      createdAt: "2026-06-05T08:00:00.000Z",
      workspacePath: path.basename(store.config.workspacePath),
    },
    null,
    2,
  )}\n`;

  await fs.writeFile(lockPath, replacementLock, "utf8");
  await release();
  assert.equal(await fs.readFile(lockPath, "utf8"), replacementLock);
  await fs.unlink(lockPath);
});

test("rejects non-UTC ISO write timestamps", async () => {
  const store = await makeStore({ mode: "write" });
  const snapshot = await store.load();

  await assert.rejects(
    updateNodeForMcp(store, {
      expectedRevision: snapshot.revision,
      dryRun: true,
      writeTimestamp: "2026/06/05",
      documentId: "doc_mcp",
      nodeId: "node_tools",
      text: "非法时间",
    }),
    /ISO 8601 UTC/,
  );
  await assert.rejects(
    updateNodeForMcp(store, {
      expectedRevision: snapshot.revision,
      dryRun: true,
      writeTimestamp: "2026-02-30T08:00:00Z",
      documentId: "doc_mcp",
      nodeId: "node_tools",
      text: "不存在日期",
    }),
    /ISO 8601 UTC/,
  );

  const preview = await updateNodeForMcp(store, {
    expectedRevision: snapshot.revision,
    dryRun: true,
    writeTimestamp: "2026-06-05T08:00:00Z",
    documentId: "doc_mcp",
    nodeId: "node_tools",
    text: "合法时间",
  });
  assert.equal(preview.confirmationArgs.writeTimestamp, "2026-06-05T08:00:00.000Z");
});

test("aborts atomic replacement when workspace changes before rename", async () => {
  const store = await makeStore({ mode: "write" });
  const snapshot = await store.load();
  const originalBackup = store.writeBackupSnapshot.bind(store);

  store.writeBackupSnapshot = async (options) => {
    const backup = await originalBackup(options);
    const externalWorkspace = sampleWorkspace();
    externalWorkspace.documents[0].nodes[1].text = "外部写入";
    await fs.writeFile(
      store.config.workspacePath,
      `${JSON.stringify(externalWorkspace, null, 2)}\n`,
      "utf8",
    );
    return backup;
  };

  await assert.rejects(
    updateNodeForMcp(store, {
      expectedRevision: snapshot.revision,
      dryRun: false,
      documentId: "doc_mcp",
      nodeId: "node_tools",
      text: "MCP 写入",
    }),
    /revision 冲突/,
  );

  const raw = await fs.readFile(store.config.workspacePath, "utf8");
  assert.match(raw, /外部写入/);
  assert.doesNotMatch(raw, /MCP 写入/);

  const entries = await fs.readdir(path.dirname(store.config.workspacePath));
  assert.deepEqual(
    entries.filter((entry) => entry.endsWith(".tmp")),
    [],
  );
});

test("writes node changes with revision checks, snapshots, and atomic replacement", async () => {
  const store = await makeStore({ mode: "write" });
  let snapshot = await store.load();

  const created = await createNodeForMcp(store, {
    expectedRevision: snapshot.revision,
    dryRun: false,
    reason: "unit-test-create-node",
    documentId: "doc_mcp",
    parentNodeId: "node_background",
    text: "写入任务",
    color: "amber",
  });

  assert.equal(created.applied, true);
  assert.equal(created.snapshot.pathIsRedacted, false);
  await fs.stat(created.snapshot.path);

  snapshot = await store.load();
  assert.equal(snapshot.revision, created.nextWorkspaceRevision);
  let node = getNode(snapshot, {
    documentId: "doc_mcp",
    nodeId: created.affected.nodeIds[0],
  }).node;
  assert.equal(node.text, "写入任务");
  assert.equal(node.color, "amber");

  const updated = await updateNodeForMcp(store, {
    expectedRevision: snapshot.revision,
    dryRun: false,
    documentId: "doc_mcp",
    nodeId: created.affected.nodeIds[0],
    text: "已更新任务",
    note: "来自 MCP 写入测试",
    checked: true,
  });
  assert.equal(updated.applied, true);

  snapshot = await store.load();
  node = getNode(snapshot, {
    documentId: "doc_mcp",
    nodeId: created.affected.nodeIds[0],
  }).node;
  assert.equal(node.text, "已更新任务");
  assert.equal(node.note, "来自 MCP 写入测试");
  assert.equal(node.checked, true);
  assert.equal(node.isTodo, true);
});

test("uses unique backup filenames for repeated writes in the same millisecond", async () => {
  const store = await makeStore({ mode: "write" });
  const fixedTimestamp = "2026-06-05T08:00:00.123Z";
  let snapshot = await store.load();

  const first = await updateNodeForMcp(store, {
    expectedRevision: snapshot.revision,
    dryRun: false,
    writeTimestamp: fixedTimestamp,
    documentId: "doc_mcp",
    nodeId: "node_tools",
    text: "同秒写入 A",
  });

  snapshot = await store.load();
  const second = await updateNodeForMcp(store, {
    expectedRevision: snapshot.revision,
    dryRun: false,
    writeTimestamp: fixedTimestamp,
    documentId: "doc_mcp",
    nodeId: "node_tools",
    text: "同秒写入 B",
  });

  assert.notEqual(first.snapshot.filename, second.snapshot.filename);
  assert.match(first.snapshot.filename, /20260605T080000-123Z/);
  await fs.stat(first.snapshot.path);
  await fs.stat(second.snapshot.path);
});

test("writes document title, checked state, appended children, moves, and deletes", async () => {
  const store = await makeStore({ mode: "write" });
  let snapshot = await store.load();

  const title = await updateDocumentTitleForMcp(store, {
    expectedRevision: snapshot.revision,
    dryRun: false,
    documentId: "doc_mcp",
    title: "MCP 写入需求",
  });
  assert.equal(title.applied, true);

  snapshot = await store.load();
  const checked = await setNodeCheckedForMcp(store, {
    expectedRevision: snapshot.revision,
    dryRun: false,
    documentId: "doc_mcp",
    nodeId: "node_background",
    checked: true,
  });
  assert.equal(checked.applied, true);

  snapshot = await store.load();
  const appended = await appendChildrenForMcp(store, {
    expectedRevision: snapshot.revision,
    dryRun: false,
    documentId: "doc_mcp",
    parentNodeId: "node_background",
    children: [{ text: "追加子节点 A" }, { text: "追加子节点 B" }],
  });
  assert.equal(appended.affected.nodeIds.length, 2);

  snapshot = await store.load();
  const moved = await moveNodeForMcp(store, {
    expectedRevision: snapshot.revision,
    dryRun: false,
    documentId: "doc_mcp",
    nodeId: "node_tools",
    targetParentNodeId: "node_background",
    position: "first",
  });
  assert.equal(moved.applied, true);

  snapshot = await store.load();
  const movedNode = getNode(snapshot, {
    documentId: "doc_mcp",
    nodeId: "node_tools",
    includeAncestors: true,
  });
  assert.deepEqual(movedNode.ancestors.map((ancestor) => ancestor.id), [
    "node_background",
  ]);

  const deletedId = appended.affected.nodeIds[0];
  const deleted = await deleteNodeForMcp(store, {
    expectedRevision: snapshot.revision,
    dryRun: false,
    documentId: "doc_mcp",
    nodeId: deletedId,
  });
  assert.equal(deleted.applied, true);

  snapshot = await store.load();
  assert.throws(
    () =>
      getNode(snapshot, {
        documentId: "doc_mcp",
        nodeId: deletedId,
      }),
    /找不到节点/,
  );
});
