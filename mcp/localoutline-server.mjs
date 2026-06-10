#!/usr/bin/env node
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import {
  SERVER_DISPLAY_NAME,
  SERVER_NAME,
  appendChildrenForMcp,
  createWorkspaceStore,
  createDocumentForMcp,
  createNodeForMcp,
  deleteNodeForMcp,
  exportDocumentForMcp,
  getDocument,
  getNode,
  getWorkspaceSummary,
  listDocuments,
  moveNodeForMcp,
  searchOutline,
  setNodeCheckedForMcp,
  textToolResult,
  updateDocumentTitleForMcp,
  updateNodeForMcp,
} from "./localoutline-core.mjs";

const jsonContent = (uri, data) => ({
  contents: [
    {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(data, null, 2),
    },
  ],
});

const textContent = (uri, text, mimeType = "text/plain") => ({
  contents: [
    {
      uri,
      mimeType,
      text,
    },
  ],
});

const variableString = (value) =>
  Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");

const documentResourceMetadata = (document, format = "compact") => {
  const isMarkdown = format === "markdown";
  return {
    uri: isMarkdown
      ? `localoutline://document-markdown/${encodeURIComponent(document.id)}`
      : `localoutline://document/${encodeURIComponent(document.id)}`,
    name: isMarkdown ? `${document.title}.md` : document.title,
    title: isMarkdown ? `${document.title} Markdown` : document.title,
    description: isMarkdown
      ? "LocalOutline 文档的 Markdown 视图"
      : "LocalOutline 文档的 compact JSON 视图",
    mimeType: isMarkdown ? "text/markdown" : "application/json",
    annotations: {
      audience: ["assistant"],
      priority: 0.8,
      lastModified: document.updatedAt,
    },
  };
};

const readPackageVersion = async () => {
  const raw = await fs.readFile(new URL("../package.json", import.meta.url), "utf8");
  return JSON.parse(raw).version;
};

const writeCommonInputSchema = {
  expectedRevision: z.string().min(1).describe("调用方读取到的 workspace revision"),
  dryRun: z.boolean().optional().default(true).describe("默认 true；false 时才真实落盘"),
  reason: z.string().max(300).optional().default("").describe("写入原因，用于快照和审计摘要"),
  writeTimestamp: z
    .string()
    .optional()
    .describe("UTC ISO 写入时间；dry-run confirmationArgs 会自动生成，普通调用无需手写"),
};

const positionSchema = z.enum(["first", "last"]).optional().default("last");
const titleSchema = z.string().max(300);
const nodeTextSchema = z.string().max(10_000);
const nodeNoteSchema = z.string().max(50_000);
const nodeCodeSchema = z.string().max(50_000);
const nodeCodeLanguageSchema = z.string().max(80);

const writableNodeSchema = z.object({
  id: z.string().min(1).optional(),
  text: nodeTextSchema.optional(),
  note: nodeNoteSchema.optional(),
  checked: z.boolean().optional(),
  collapsed: z.boolean().optional(),
  color: z.enum(["plain", "blue", "green", "amber", "rose"]).optional(),
  codeBlock: nodeCodeSchema.optional(),
  codeLanguage: nodeCodeLanguageSchema.optional(),
  isTodo: z.boolean().optional(),
  children: z.array(z.any()).optional().default([]),
});

export const createLocalOutlineMcpServer = async ({
  store,
  version,
} = {}) => {
  const workspaceStore = store ?? (await createWorkspaceStore());
  const resolvedVersion = version ?? (await readPackageVersion());
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: SERVER_DISPLAY_NAME,
      version: resolvedVersion,
      websiteUrl: "https://github.com/MoarLiu/LocalOutline",
    },
    {
      capabilities: {
        resources: { listChanged: false },
        prompts: { listChanged: false },
        tools: { listChanged: false },
      },
    },
  );

  const snapshot = () => workspaceStore.load();

  server.registerTool(
    "get_workspace_summary",
    {
      title: "Get Workspace Summary",
      description: "读取 LocalOutline 工作区概览，不返回完整文档内容。",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => textToolResult(getWorkspaceSummary(await snapshot())),
  );

  server.registerTool(
    "list_documents",
    {
      title: "List Documents",
      description: "列出 LocalOutline 文档，可按标题过滤。",
      inputSchema: {
        query: z.string().optional().default("").describe("按文档标题过滤"),
        limit: z.number().int().min(1).max(100).optional().default(20),
        includeStats: z.boolean().optional().default(true),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) => textToolResult(listDocuments(await snapshot(), args)),
  );

  server.registerTool(
    "search_outline",
    {
      title: "Search Outline",
      description: "跨文档搜索标题、节点正文和备注。",
      inputSchema: {
        query: z.string().min(1).describe("搜索关键词"),
        documentId: z.string().optional().describe("可选，限制在单篇文档内搜索"),
        fields: z
          .array(z.enum(["title", "text", "note"]))
          .optional()
          .default(["title", "text", "note"]),
        limit: z.number().int().min(1).max(100).optional().default(20),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) => textToolResult(searchOutline(await snapshot(), args)),
  );

  server.registerTool(
    "get_document",
    {
      title: "Get Document",
      description: "读取指定 LocalOutline 文档，支持 compact、json、markdown。",
      inputSchema: {
        documentId: z.string().min(1),
        format: z.enum(["compact", "json", "markdown"]).optional().default("compact"),
        maxDepth: z.number().int().min(0).max(20).optional().default(6),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) => textToolResult(getDocument(await snapshot(), args)),
  );

  server.registerTool(
    "get_node",
    {
      title: "Get Node",
      description: "读取指定节点、父级路径、可选兄弟节点和指定深度子树。",
      inputSchema: {
        documentId: z.string().min(1),
        nodeId: z.string().min(1),
        includeAncestors: z.boolean().optional().default(true),
        includeSiblings: z.boolean().optional().default(false),
        childrenDepth: z.number().int().min(0).max(8).optional().default(2),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) => textToolResult(getNode(await snapshot(), args)),
  );

  server.registerTool(
    "export_document",
    {
      title: "Export Document",
      description: "把指定文档导出为 JSON 或 Markdown 文本。",
      inputSchema: {
        documentId: z.string().min(1),
        format: z.enum(["json", "markdown"]).optional().default("json"),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) => textToolResult(exportDocumentForMcp(await snapshot(), args)),
  );

  server.registerTool(
    "create_document",
    {
      title: "Create Document",
      description: "创建 LocalOutline 文档。默认 dry-run 只返回预览；真实写入需要 write 模式和 dryRun=false。",
      inputSchema: {
        ...writeCommonInputSchema,
        documentId: z.string().min(1).optional(),
        title: titleSchema.optional(),
        initialNodes: z.array(writableNodeSchema).optional().default([]),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async (args) => textToolResult(await createDocumentForMcp(workspaceStore, args)),
  );

  server.registerTool(
    "update_document_title",
    {
      title: "Update Document Title",
      description: "更新 LocalOutline 文档标题，结构化写入前会校验 revision。",
      inputSchema: {
        ...writeCommonInputSchema,
        documentId: z.string().min(1),
        title: titleSchema.min(1),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async (args) => textToolResult(await updateDocumentTitleForMcp(workspaceStore, args)),
  );

  server.registerTool(
    "create_node",
    {
      title: "Create Node",
      description: "在文档根部或指定父节点下创建节点。",
      inputSchema: {
        ...writeCommonInputSchema,
        documentId: z.string().min(1),
        parentNodeId: z.string().min(1).optional(),
        position: positionSchema,
        id: z.string().min(1).optional(),
        text: nodeTextSchema.optional(),
        note: nodeNoteSchema.optional(),
        checked: z.boolean().optional(),
        collapsed: z.boolean().optional(),
        color: z.enum(["plain", "blue", "green", "amber", "rose"]).optional(),
        codeBlock: nodeCodeSchema.optional(),
        codeLanguage: nodeCodeLanguageSchema.optional(),
        isTodo: z.boolean().optional(),
        children: z.array(writableNodeSchema).optional().default([]),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async (args) => textToolResult(await createNodeForMcp(workspaceStore, args)),
  );

  server.registerTool(
    "update_node",
    {
      title: "Update Node",
      description: "更新节点正文、备注、颜色、折叠状态和待办字段。",
      inputSchema: {
        ...writeCommonInputSchema,
        documentId: z.string().min(1),
        nodeId: z.string().min(1),
        text: nodeTextSchema.optional(),
        note: nodeNoteSchema.optional(),
        color: z.enum(["plain", "blue", "green", "amber", "rose"]).optional(),
        collapsed: z.boolean().optional(),
        checked: z.boolean().optional(),
        codeBlock: nodeCodeSchema.optional(),
        codeLanguage: nodeCodeLanguageSchema.optional(),
        isTodo: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async (args) => textToolResult(await updateNodeForMcp(workspaceStore, args)),
  );

  server.registerTool(
    "set_node_checked",
    {
      title: "Set Node Checked",
      description: "设置节点待办完成状态，并将节点标记为待办。",
      inputSchema: {
        ...writeCommonInputSchema,
        documentId: z.string().min(1),
        nodeId: z.string().min(1),
        checked: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async (args) => textToolResult(await setNodeCheckedForMcp(workspaceStore, args)),
  );

  server.registerTool(
    "append_children",
    {
      title: "Append Children",
      description: "向文档根部或指定父节点批量追加子节点。",
      inputSchema: {
        ...writeCommonInputSchema,
        documentId: z.string().min(1),
        parentNodeId: z.string().min(1).optional(),
        children: z.array(writableNodeSchema).min(1),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async (args) => textToolResult(await appendChildrenForMcp(workspaceStore, args)),
  );

  server.registerTool(
    "move_node",
    {
      title: "Move Node",
      description: "在同一文档内移动节点到根部或新的父节点下。",
      inputSchema: {
        ...writeCommonInputSchema,
        documentId: z.string().min(1),
        nodeId: z.string().min(1),
        targetParentNodeId: z.string().min(1).optional(),
        position: positionSchema,
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async (args) => textToolResult(await moveNodeForMcp(workspaceStore, args)),
  );

  server.registerTool(
    "delete_node",
    {
      title: "Delete Node",
      description: "删除节点；真实写入前会创建快照。",
      inputSchema: {
        ...writeCommonInputSchema,
        documentId: z.string().min(1),
        nodeId: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args) => textToolResult(await deleteNodeForMcp(workspaceStore, args)),
  );

  server.registerResource(
    "workspace-summary",
    "localoutline://workspace/summary",
    {
      title: "Workspace Summary",
      description: "LocalOutline 工作区概览",
      mimeType: "application/json",
      annotations: { audience: ["assistant"], priority: 0.6 },
    },
    async (uri) => jsonContent(uri.href, getWorkspaceSummary(await snapshot())),
  );

  server.registerResource(
    "documents",
    "localoutline://documents",
    {
      title: "Document List",
      description: "LocalOutline 文档列表",
      mimeType: "application/json",
      annotations: { audience: ["assistant"], priority: 0.7 },
    },
    async (uri) => jsonContent(uri.href, listDocuments(await snapshot(), { limit: 100 })),
  );

  server.registerResource(
    "document",
    new ResourceTemplate("localoutline://document/{documentId}", {
      list: async () => {
        const current = await snapshot();
        return {
          resources: current.workspace.documents.map((document) =>
            documentResourceMetadata(document, "compact"),
          ),
        };
      },
      complete: {
        documentId: async (value) => {
          const current = await snapshot();
          return current.workspace.documents
            .filter((document) => document.title.includes(value) || document.id.includes(value))
            .slice(0, 20)
            .map((document) => document.id);
        },
      },
    }),
    {
      title: "Document",
      description: "LocalOutline 文档 compact JSON",
      mimeType: "application/json",
      annotations: { audience: ["assistant"], priority: 0.8 },
    },
    async (uri, variables) => {
      const documentId = decodeURIComponent(variableString(variables.documentId));
      return jsonContent(
        uri.href,
        getDocument(await snapshot(), { documentId, format: "compact" }).content,
      );
    },
  );

  server.registerResource(
    "document-markdown",
    new ResourceTemplate("localoutline://document-markdown/{documentId}", {
      list: async () => {
        const current = await snapshot();
        return {
          resources: current.workspace.documents.map((document) =>
            documentResourceMetadata(document, "markdown"),
          ),
        };
      },
      complete: {
        documentId: async (value) => {
          const current = await snapshot();
          return current.workspace.documents
            .filter((document) => document.title.includes(value) || document.id.includes(value))
            .slice(0, 20)
            .map((document) => document.id);
        },
      },
    }),
    {
      title: "Document Markdown",
      description: "LocalOutline 文档 Markdown",
      mimeType: "text/markdown",
      annotations: { audience: ["assistant"], priority: 0.8 },
    },
    async (uri, variables) => {
      const documentId = decodeURIComponent(variableString(variables.documentId));
      return textContent(
        uri.href,
        getDocument(await snapshot(), { documentId, format: "markdown" }).content,
        "text/markdown",
      );
    },
  );

  server.registerResource(
    "node",
    new ResourceTemplate("localoutline://node/{documentId}/{nodeId}", {
      list: undefined,
      complete: {
        documentId: async (value) => {
          const current = await snapshot();
          return current.workspace.documents
            .filter((document) => document.title.includes(value) || document.id.includes(value))
            .slice(0, 20)
            .map((document) => document.id);
        },
      },
    }),
    {
      title: "Node",
      description: "LocalOutline 节点上下文",
      mimeType: "application/json",
      annotations: { audience: ["assistant"], priority: 0.9 },
    },
    async (uri, variables) => {
      const documentId = decodeURIComponent(variableString(variables.documentId));
      const nodeId = decodeURIComponent(variableString(variables.nodeId));
      return jsonContent(
        uri.href,
        getNode(await snapshot(), {
          documentId,
          nodeId,
          includeAncestors: true,
          includeSiblings: false,
          childrenDepth: 3,
        }),
      );
    },
  );

  const targetText = ({ documentId, nodeId }) =>
    nodeId
      ? `LocalOutline 文档 ${documentId} 中的节点 ${nodeId}`
      : `LocalOutline 文档 ${documentId}`;

  server.registerPrompt(
    "summarize_outline",
    {
      title: "Summarize Outline",
      description: "总结指定 LocalOutline 文档或节点。",
      argsSchema: {
        documentId: z.string().min(1),
        nodeId: z.string().optional(),
        style: z.enum(["brief", "detailed", "executive"]).optional().default("brief"),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `请先通过 LocalOutline MCP 读取 ${targetText(args)}，再用 ${args.style} 风格总结。保留大纲层级中的关键判断、待办和备注，不要引入大纲外的信息。`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "outline_to_prd",
    {
      title: "Outline To PRD",
      description: "把指定大纲转换成 PRD。",
      argsSchema: {
        documentId: z.string().min(1),
        nodeId: z.string().optional(),
        audience: z.enum(["engineering", "product", "mixed"]).optional().default("mixed"),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `请先读取 ${targetText(args)}，面向 ${args.audience} 读者整理成 PRD。请保留需求背景、目标、范围、用户场景、功能点、非目标、风险和验收标准。`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "outline_to_tasks",
    {
      title: "Outline To Tasks",
      description: "把指定大纲拆成实施任务。",
      argsSchema: {
        documentId: z.string().min(1),
        nodeId: z.string().optional(),
        includeAcceptanceCriteria: z.boolean().optional().default(true),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `请先读取 ${targetText(args)}，拆成可执行任务。${args.includeAcceptanceCriteria ? "每个任务都给出验收标准。" : "任务保持简洁，不需要逐条验收标准。"} 请按依赖顺序排列。`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "review_outline_structure",
    {
      title: "Review Outline Structure",
      description: "审查大纲结构和可执行性。",
      argsSchema: {
        documentId: z.string().min(1),
        nodeId: z.string().optional(),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `请先读取 ${targetText(args)}，审查大纲结构。重点指出层级混乱、重复项、缺失前提、不可执行任务、风险遗漏和可以合并的节点，并给出修改建议。`,
          },
        },
      ],
    }),
  );

  return server;
};

const isMainModule = () =>
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const printHelp = () => {
  process.stdout.write(`LocalOutline MCP

Usage:
  npm run mcp:localoutline
  LOCAL_OUTLINE_WORKSPACE_PATH=/path/to/localoutline-workspace.json npm run mcp:localoutline

Environment:
  LOCAL_OUTLINE_WORKSPACE_PATH   Workspace JSON path. On macOS, defaults to the Electron iCloud backup path,
                                 then falls back to the Swift native .backups path when absent.
  LOCAL_OUTLINE_MCP_CONFIG       Optional JSON config path.
  LOCAL_OUTLINE_MCP_DEBUG        Set true to show absolute workspace paths in tool results.
  LOCAL_OUTLINE_MCP_MODE         readonly (default) or write. Real writes require write mode.

Options:
  --help                         Show this help.
  --show-config                  Print resolved config and exit.
`);
};

const main = async () => {
  if (process.argv.includes("--help")) {
    printHelp();
    return;
  }

  const store = await createWorkspaceStore();

  if (process.argv.includes("--show-config")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...store.config,
          workspacePath: store.config.debug
            ? store.config.workspacePath
            : "redacted; set LOCAL_OUTLINE_MCP_DEBUG=true to show",
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const server = await createLocalOutlineMcpServer({
    store,
    version: await readPackageVersion(),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_DISPLAY_NAME} running on stdio\n`);
};

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(
      `LocalOutline MCP failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
