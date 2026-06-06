import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const workspace = {
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
          id: "node_tools",
          text: "Tool 需求",
          note: "实现 get_workspace_summary 和 search_outline。",
          checked: false,
          collapsed: false,
          color: "plain",
          children: [],
        },
      ],
    },
  ],
};

const workspacePath = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "localoutline-mcp-smoke-"));
  const filePath = path.join(directory, "localoutline-workspace.json");
  await fs.writeFile(filePath, JSON.stringify(workspace, null, 2), "utf8");
  return filePath;
};

const parseToolJson = (result) => JSON.parse(result.content[0].text);

const main = async () => {
  const filePath = await workspacePath();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["mcp/localoutline-server.mjs"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOCAL_OUTLINE_WORKSPACE_PATH: filePath,
      LOCAL_OUTLINE_MCP_DEBUG: "true",
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "localoutline-mcp-smoke",
    version: "1.0.0",
  });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "append_children",
        "create_document",
        "create_node",
        "delete_node",
        "export_document",
        "get_document",
        "get_node",
        "get_workspace_summary",
        "list_documents",
        "move_node",
        "search_outline",
        "set_node_checked",
        "update_document_title",
        "update_node",
      ],
    );
    const getNodeTool = tools.tools.find((tool) => tool.name === "get_node");
    assert.equal(getNodeTool.inputSchema.properties.format, undefined);

    const summary = parseToolJson(
      await client.callTool({ name: "get_workspace_summary", arguments: {} }),
    );
    assert.equal(summary.documentCount, 1);
    assert.equal(summary.workspacePath, filePath);

    const preview = parseToolJson(
      await client.callTool({
        name: "create_node",
        arguments: {
          expectedRevision: summary.revision,
          dryRun: true,
          documentId: "doc_mcp",
          parentNodeId: "node_tools",
          text: "dry-run 子节点",
        },
      }),
    );
    assert.equal(preview.applied, false);
    assert.equal(preview.dryRun, true);

    const search = parseToolJson(
      await client.callTool({
        name: "search_outline",
        arguments: { query: "search_outline" },
      }),
    );
    assert.equal(search.matches[0].nodeId, "node_tools");

    const resources = await client.listResources();
    assert.ok(
      resources.resources.some(
        (resource) => resource.uri === "localoutline://workspace/summary",
      ),
    );

    const markdownResource = await client.readResource({
      uri: "localoutline://document-markdown/doc_mcp",
    });
    assert.match(markdownResource.contents[0].text, /# MCP 服务需求/);

    const prompts = await client.listPrompts();
    assert.ok(
      prompts.prompts.some((prompt) => prompt.name === "outline_to_tasks"),
    );
  } finally {
    await client.close();
  }
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
