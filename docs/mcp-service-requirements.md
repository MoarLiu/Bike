# LocalOutline MCP 服务需求说明

状态：1.2.0 已实现只读 MVP；1.3.0 已实现 MCP 受控写入基础能力
日期：2026-06-04
适用产品：Local Outline 1.2.0 起；写入能力目标版本为 1.3.0

## 1. 背景

LocalOutline 是一个本地优先的大纲、脑图和演示工具，核心数据是一份 `Workspace`，其中包含多篇 `OutlineDocument`，每篇文档由树形 `OutlineNode` 组成。当前数据主要保存在浏览器 IndexedDB，桌面版可备份到 iCloud Drive 的 `localoutline-workspace.json`。

随着 Codex、Claude 等 AI agent 逐渐成为日常写作、编码和知识整理入口，LocalOutline 可以通过 MCP 服务把本地大纲暴露为可读取、可搜索、可定位、可导出的结构化上下文。这样 agent 不需要用户手动复制整篇大纲，也不需要把无关内容塞进上下文，而是可以按需读取文档、节点和子树。

## 2. 需求价值

### 2.1 用户价值

- 减少复制粘贴：用户可以让 AI 直接读取指定大纲、节点或搜索结果。
- 保留结构语义：AI 获取的是文档树、节点路径、父子层级、备注和任务状态，而不是一段扁平文本。
- 提升上下文质量：AI 可以只取相关子树，避免整篇文档过长导致上下文污染。
- 扩展工作流：用户可以从大纲生成 PRD、任务计划、代码实现步骤、会议纪要、复盘总结。
- 坚持本地优先：MCP 服务默认在本机运行，通过 stdio 被 Codex/Claude 调用，不要求把全部知识库上传到云端。

### 2.2 产品价值

- LocalOutline 从“大纲编辑器”升级为“AI agent 可调用的结构化知识库”。
- MCP 能力可以成为后续插件生态、自动化工作流和个人知识管理的重要入口。
- 只读 MVP 的实现成本和风险都较低，适合先验证真实使用价值；1.3.0 再把低风险结构化写入纳入 MCP 工作流。

## 3. 目标和非目标

### 3.1 1.2.0 第一阶段目标

第一阶段实现只读 MCP 服务，支持：

- 读取工作区摘要。
- 列出文档。
- 按标题、节点正文、备注搜索。
- 获取完整文档或文档的 Markdown 表示。
- 获取指定节点及其上下文。
- 导出文档为 JSON 或 Markdown 文本。
- 提供少量 prompt 模板，帮助 agent 更稳定地使用 LocalOutline 内容。

### 3.2 1.3.0 第二阶段目标

1.3.0 在只读能力稳定后，把受控写入作为核心需求：

- 创建文档或节点。
- 更新节点正文、备注、任务状态、颜色等字段。
- 移动节点。
- 删除节点。
- 批量追加子节点。
- 支持写入工具的 dry-run 预览，调用方可以先获取变更摘要。
- 写入前生成快照，并要求调用方传入预期版本或内容哈希，降低覆盖风险。
- 默认仍保持只读，只有显式启用写入模式后才允许写入工具落盘。

### 3.3 非目标

1.2.0 和 1.3.0 都不做：

- 实时多人协作。
- 云端同步服务。
- 直接暴露 IndexedDB 给外部进程。
- 自动双向同步 iCloud 文件。
- 无提示的大范围写入。
- 任意文件系统访问能力。
- 完整替代 LocalOutline 的图形界面编辑体验。
- 1.3.0 不内置 AI 生成、通用聊天面板、模型选择或 API key 管理。

## 4. 用户场景

### 场景 1：让 Codex 理解项目大纲

用户在 LocalOutline 里维护一个产品需求或技术方案大纲。使用 Codex 时，用户说：“读取 LocalOutline 里的 MCP 服务需求，帮我拆实现任务。”Codex 通过 MCP 搜索相关文档，读取文档树，然后生成实现步骤。

成功标准：

- 用户不需要复制整篇大纲。
- Codex 能拿到标题、层级、备注、任务状态。
- Codex 可以引用节点路径说明依据。

### 场景 2：让 Claude 总结某个子树

用户在 Claude 里要求：“总结 LocalOutline 里某个节点下面的所有内容。”Claude 通过 `get_node` 获取该节点、父级路径和指定深度的子节点，输出摘要。

成功标准：

- 输出只围绕目标子树。
- 长文档不会被全量塞入上下文。

### 场景 3：从大纲生成 PRD 或任务列表

用户让 AI 根据一篇 LocalOutline 文档生成 PRD、开发任务、测试清单或发布说明。AI 使用 `get_document` 或 `export_document` 获取 Markdown，再按照 prompt 模板输出。

成功标准：

- 大纲层级能映射为章节和条目。
- 任务节点、备注、标签不会丢失。

### 场景 4：后续受控写回

用户让 AI “把刚才生成的任务追加到某个节点下”。AI 先调用只读工具定位节点，再调用写入工具提交 dry-run 预览。用户确认后，工具写入新节点并创建快照。

成功标准：

- 写入前可预览。
- 写入失败可回滚。
- 并发编辑时不会静默覆盖用户本地数据。

## 5. MCP 能力设计

MCP 服务建议同时暴露 Tools、Resources 和 Prompts。

- Tools：供模型主动调用，用于搜索、读取、导出和后续写入。
- Resources：供客户端把文档或节点作为上下文资源加载。
- Prompts：提供面向大纲的常用工作流模板，例如总结、生成 PRD、拆任务。

### 5.1 服务名称

建议名称：

```text
localoutline
```

服务显示名：

```text
LocalOutline MCP
```

### 5.2 传输方式

MVP 使用 stdio transport，便于 Codex、Claude Desktop 等客户端直接启动本地 Node.js 进程。

后续可选：

- Streamable HTTP：适合 LocalOutline 应用运行时暴露本地端口。
- Electron 内置 MCP server：适合桌面版统一管理权限、数据源和写入。

## 6. 数据源设计

### 6.1 当前约束

LocalOutline 当前权威数据在浏览器 IndexedDB 中，外部 Node.js MCP 进程无法直接稳定读取浏览器 IndexedDB。桌面版已有 iCloud Drive 备份文件；Electron 版默认位置是：

```text
~/Library/Mobile Documents/com~apple~CloudDocs/LocalOutline/localoutline-workspace.json
```

Swift 原生版的 JSON 备份默认位置是：

```text
~/Library/Mobile Documents/com~apple~CloudDocs/LocalOutline/.backups/localoutline-workspace.json
```

因此，MVP 不应假设可以直接访问运行中应用的内存状态或 IndexedDB。

### 6.2 MVP 推荐数据源

MVP 使用配置文件或环境变量指定工作区 JSON 文件路径：

```text
LOCAL_OUTLINE_WORKSPACE_PATH=/absolute/path/to/localoutline-workspace.json
```

读取流程：

1. MCP server 启动时读取配置路径。
2. 每次工具调用前检查文件修改时间。
3. 文件变更后重新加载并通过 `migrateWorkspace` 归一化。
4. 若文件不存在或格式无效，返回明确错误。

优点：

- 实现简单。
- 与现有 iCloud 备份兼容。
- 不破坏当前 IndexedDB 存储模型。
- 适合只读验证。

限制：

- 读取的是最近备份，不一定是应用内最新未备份状态。
- 写入 JSON 文件不会自动更新正在运行的 LocalOutline UI。
- 后续需要专门设计 app 与 MCP 的同步桥。

### 6.3 后续数据源演进

长期建议把“可被 MCP 读取的工作区文件”变成产品一等能力：

- 桌面版支持绑定一个工作区 JSON 文件，并把它作为可见备份/交换文件。
- Electron 主进程提供本地数据桥，MCP server 通过 IPC 或本地 HTTP 读取当前工作区。
- 写入操作进入应用内事务，由 LocalOutline UI 负责合并、保存和提示冲突。

## 7. 数据模型范围

MCP 输出应基于当前 TypeScript 模型：

```ts
interface Workspace {
  version: 1;
  activeDocumentId: string;
  documents: OutlineDocument[];
}

interface OutlineDocument {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  markdownSource?: string;
  markdownUpdatedAt?: string;
  nodes: OutlineNode[];
}

interface OutlineNode {
  id: string;
  text: string;
  note: string;
  checked: boolean;
  collapsed: boolean;
  color: string;
  headingLevel?: 0 | 1 | 2 | 3;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  highlight?: boolean;
  icon?: string;
  imageName?: string;
  imageAlt?: string;
  table?: string[][];
  isTodo?: boolean;
  children: OutlineNode[];
}
```

为方便 AI 使用，工具结果应额外提供派生字段：

- `path`：节点在文档树中的数组路径，例如 `[0, 2, 1]`。
- `breadcrumb`：从文档标题到节点的文本路径。
- `parentId`：父节点 ID，顶层节点为 `null`。
- `depth`：节点深度，顶层为 `0`。
- `childCount`：直接子节点数量。
- `descendantCount`：后代节点数量。
- `documentTitle`：所属文档标题。

## 8. Tool 需求

### 8.1 `get_workspace_summary`

用途：获取工作区概览，帮助 AI 判断有哪些文档和最近更新时间。

输入：

```json
{}
```

输出：

```json
{
  "version": 1,
  "activeDocumentId": "doc-id",
  "documentCount": 3,
  "nodeCount": 128,
  "updatedAt": "2026-06-04T10:00:00.000Z",
  "workspacePath": "/absolute/path/to/localoutline-workspace.json"
}
```

要求：

- 不返回完整文档内容。
- 文件路径可根据配置隐藏，默认只返回 basename；调试模式才返回绝对路径。

### 8.2 `list_documents`

用途：列出文档，支持简单过滤。

输入：

```json
{
  "query": "MCP",
  "limit": 20,
  "includeStats": true
}
```

输出：

```json
{
  "documents": [
    {
      "id": "doc-id",
      "title": "MCP 服务需求",
      "createdAt": "2026-06-04T09:00:00.000Z",
      "updatedAt": "2026-06-04T10:00:00.000Z",
      "nodeCount": 42,
      "topLevelNodeCount": 5
    }
  ]
}
```

要求：

- `query` 匹配文档标题。
- 默认按 `updatedAt` 倒序。
- `limit` 默认 20，最大 100。

### 8.3 `search_outline`

用途：跨文档搜索标题、节点正文、备注。

输入：

```json
{
  "query": "MCP",
  "documentId": "optional-doc-id",
  "fields": ["title", "text", "note"],
  "limit": 20
}
```

输出：

```json
{
  "query": "MCP",
  "matches": [
    {
      "documentId": "doc-id",
      "documentTitle": "MCP 服务需求",
      "nodeId": "node-id",
      "field": "text",
      "snippet": "增加一个 MCP 服务，让 Codex 和 Claude 调用",
      "breadcrumb": ["MCP 服务需求", "背景", "AI 调用"],
      "path": [0, 1]
    }
  ]
}
```

要求：

- 默认大小写不敏感。
- 匹配备注时返回 `field: "note"`。
- 命中文档标题时 `nodeId` 可为 `null`。
- 返回结果应包含足够路径信息，方便后续调用 `get_node`。

### 8.4 `get_document`

用途：读取完整文档，支持 JSON、Markdown 和 compact 三种格式。

输入：

```json
{
  "documentId": "doc-id",
  "format": "markdown",
  "maxDepth": 6
}
```

输出：

```json
{
  "documentId": "doc-id",
  "title": "MCP 服务需求",
  "format": "markdown",
  "content": "# MCP 服务需求\n\n- 背景\n  - ..."
}
```

格式说明：

- `json`：返回完整 `OutlineDocument`，保留所有字段。
- `markdown`：返回可读 Markdown，适合总结和生成文档。
- `compact`：返回裁剪后的树，只保留 `id`、`text`、`note`、`checked`、`children` 和派生路径。

要求：

- 默认 `format` 为 `compact`。
- 大文档需要支持 `maxDepth` 和后续分页策略。
- 超过最大输出限制时返回裁剪提示和可继续读取的节点信息。

### 8.5 `get_node`

用途：读取指定节点及上下文。

输入：

```json
{
  "documentId": "doc-id",
  "nodeId": "node-id",
  "includeAncestors": true,
  "includeSiblings": true,
  "childrenDepth": 3
}
```

输出：

```json
{
  "documentId": "doc-id",
  "documentTitle": "MCP 服务需求",
  "node": {
    "id": "node-id",
    "text": "Tool 需求",
    "note": "",
    "path": [7],
    "breadcrumb": ["MCP 服务需求", "Tool 需求"],
    "children": []
  },
  "ancestors": [],
  "siblings": []
}
```

要求：

- `childrenDepth` 默认 2，最大 8。
- `includeSiblings` 默认 false。
- 输出固定为 compact 节点结构，不提供 raw JSON 子树。
- 目标节点、子节点、祖先和兄弟节点共享 `maxDocumentNodes` 输出预算。
- 找不到节点时返回明确错误，不返回空内容冒充成功。

### 8.6 `export_document`

用途：按现有导出能力返回指定格式文本。

输入：

```json
{
  "documentId": "doc-id",
  "format": "json"
}
```

输出：

```json
{
  "filename": "MCP 服务需求.json",
  "mime": "application/json",
  "content": "{...}"
}
```

MVP 支持格式：

- `json`
- `markdown`

后续支持：

- `opml`
- `freemind`
- `html`

要求：

- 复用现有导出逻辑，避免 MCP 与 UI 导出结果分叉。
- 若当前导出函数依赖浏览器 API，应抽出纯函数部分供 MCP 复用。

## 9. Resource 需求

建议资源 URI：

```text
localoutline://workspace/summary
localoutline://documents
localoutline://document/{documentId}
localoutline://document-markdown/{documentId}
localoutline://node/{documentId}/{nodeId}
```

资源要求：

- `localoutline://workspace/summary` 返回工作区摘要。
- `localoutline://documents` 返回文档列表。
- `localoutline://document/{documentId}` 返回 compact JSON。
- `localoutline://document-markdown/{documentId}` 返回 Markdown。
- `localoutline://node/{documentId}/{nodeId}` 返回节点上下文。

资源元数据应包含：

- `name`
- `title`
- `description`
- `mimeType`
- `annotations.lastModified`

## 10. Prompt 需求

### 10.1 `summarize_outline`

用途：总结指定文档或节点。

参数：

- `documentId`
- `nodeId` 可选
- `style`：`brief`、`detailed`、`executive`

### 10.2 `outline_to_prd`

用途：把大纲转换成 PRD。

参数：

- `documentId`
- `nodeId` 可选
- `audience`：`engineering`、`product`、`mixed`

### 10.3 `outline_to_tasks`

用途：把大纲拆成实施任务。

参数：

- `documentId`
- `nodeId` 可选
- `includeAcceptanceCriteria`：布尔值

### 10.4 `review_outline_structure`

用途：审查大纲结构，指出层级混乱、重复、缺少结论或任务不可执行的问题。

参数：

- `documentId`
- `nodeId` 可选

## 11. 1.3.0 写入能力需求

写入能力作为 1.3.0 主需求进入实施范围。目标是在不破坏本地优先和数据安全边界的前提下，让 Codex、Claude 等 agent 可以对 LocalOutline 工作区执行小范围、可预览、可回滚的结构化变更。

### 11.1 写入原则

- 默认关闭，需要在配置里显式启用写入模式。
- 写入工具只允许修改配置的 `workspacePath`，不得接受任意文件路径参数。
- 每次真实写入前创建快照。
- 每次真实写入要求传入 `expectedRevision`。
- 支持 `dryRun`，dry-run 返回变更预览，不落盘。
- dry-run 返回的 `writeTimestamp` 必须是 UTC ISO 时间，真实确认时应原样复用。
- 删除操作必须在快照可恢复的前提下执行；若后续数据模型有回收站，应优先使用软删除。
- 写入失败必须返回原因，不允许部分成功后静默退出。
- 写入后返回新的 `workspaceRevision`、受影响文档和节点 ID、快照路径显示名。

### 11.2 1.3.0 写入工具

1.3.0 先实现以下低风险工具：

- `create_document`：创建新文档，可设置标题和初始节点。
- `update_document_title`：修改文档标题。
- `create_node`：在指定父节点或文档根部创建节点。
- `update_node`：更新节点正文、备注、颜色、折叠状态和待办字段。
- `set_node_checked`：切换或设置待办完成状态。
- `append_children`：批量追加子节点。
- `move_node`：移动节点到同文档内的新父节点或根部。
- `delete_node`：删除节点，真实写入前必须生成快照。

每个写入工具的公共入参至少包含：

- `expectedRevision`：调用方读取到的工作区 revision。
- `dryRun`：默认为 `true`，只有显式传入 `false` 才落盘。
- `reason`：可选，写入原因，用于快照和日志。

### 11.3 版本和冲突

MCP server 应维护 `workspaceRevision`，可由以下信息生成：

- 工作区 JSON 内容哈希。
- 文件修改时间。
- 文档最大 `updatedAt`。

写入工具必须校验调用方传入的 `expectedRevision`。若当前 revision 不一致，返回冲突错误，并要求调用方重新读取。

### 11.4 写入预览

dry-run 返回内容应包括：

- 操作类型。
- 目标文档和节点路径。
- 将新增、更新、移动或删除的节点数量。
- 关键字段的 before/after 摘要。
- 当前 `workspaceRevision`。
- 调用方需要再次确认时使用的参数提示。
- 可直接复用的 `confirmationArgs`，包含生成好的文档/节点 ID、固定 `writeTimestamp`、`expectedRevision` 和 `dryRun=false`。

dry-run 不创建快照、不写文件、不更新内存缓存。

### 11.5 快照和原子写入

真实写入流程：

1. 获取工作区同目录 lockfile，避免多个 MCP 写入进程同时替换同一文件。
2. 重新读取当前工作区文件并计算 revision。
3. 校验 `expectedRevision`。
4. 生成变更后的工作区对象并运行迁移/归一化。
5. 在工作区同目录的 `.backups/` 下写入 MCP 快照。
6. 将新工作区写入临时文件。
7. 原子 rename 前再次校验当前 revision，若外部写入插队则冲突退出并清理临时文件。
8. 使用原子 rename 替换目标工作区文件。
9. 清空或更新内存缓存，并返回新的 revision。

快照文件名建议包含时间戳和操作名，例如 `localoutline-mcp-20260604-153000-update-node.json`。

## 12. 配置需求

### 12.1 环境变量

```text
LOCAL_OUTLINE_WORKSPACE_PATH=/absolute/path/to/localoutline-workspace.json
LOCAL_OUTLINE_MCP_MODE=readonly
LOCAL_OUTLINE_MCP_DEBUG=false
```

1.3.0 支持：

```text
LOCAL_OUTLINE_MCP_MODE=write
```

默认值仍为 `readonly`。只有 `write` 模式可以执行真实写入；`readonly` 模式下写入工具即使存在，也必须拒绝落盘。

### 12.2 配置文件

可选支持：

```json
{
  "workspacePath": "/absolute/path/to/localoutline-workspace.json",
  "mode": "readonly",
  "maxSearchResults": 50,
  "maxDocumentNodes": 2000,
  "debug": false
}
```

1.3.0 可把 `mode` 设置为 `"write"` 来启用受控写入。

建议默认路径：

- macOS Electron 备份路径：`~/Library/Mobile Documents/com~apple~CloudDocs/LocalOutline/localoutline-workspace.json`
- macOS Swift 原生版备份路径：`~/Library/Mobile Documents/com~apple~CloudDocs/LocalOutline/.backups/localoutline-workspace.json`
- 项目开发路径：通过环境变量显式指定。

## 13. 安全和隐私

### 13.1 默认安全边界

- MCP server 默认只读。
- 默认不监听公网端口。
- 默认不访问配置路径以外的文件。
- 默认不把文档内容写入日志。
- 默认不上传任何内容。
- 1.3.0 启用写入模式后，也只能修改配置的工作区文件和同目录快照文件。

### 13.2 路径限制

服务只能读取：

- 显式配置的工作区 JSON 文件。
- 后续写入时创建的同目录快照文件。

禁止能力：

- 读取任意绝对路径。
- 遍历用户 Home 目录。
- 接受来自工具参数的任意文件路径。

### 13.3 日志

日志只记录：

- 工具名称。
- 调用时间。
- 文档 ID。
- 返回条数。
- 错误类型。

日志不记录：

- 节点正文全文。
- 备注全文。
- 完整工作区 JSON。

## 14. 非功能需求

### 14.1 性能

- 100 篇文档、5 万节点以内，搜索应在 1 秒内返回。
- 工作区加载后应建立内存索引，避免每次搜索都递归全量树。
- 文件修改后再重建索引。

### 14.2 稳定性

- 工作区 JSON 格式错误时，服务不崩溃。
- 单个文档异常时，应尽量返回可诊断错误。
- 工具参数必须做 schema 校验。

### 14.3 兼容性

- 支持 Node.js LTS。
- 支持 macOS 优先，后续兼容 Windows。
- MCP server 与前端共用类型和迁移逻辑，避免数据模型漂移。

### 14.4 可测试性

需要准备 fixtures：

- 空工作区。
- 单文档多层级工作区。
- 含备注、任务、颜色、Markdown 字段的工作区。
- 非法 JSON。
- 重复 ID 或缺字段的旧数据。

测试覆盖：

- 迁移。
- 文档列表。
- 搜索。
- 节点路径生成。
- Markdown 导出。
- 错误处理。

## 15. 实施计划

### Phase 0：设计和拆分

- 确认只读 MVP 范围。
- 确认 MCP server 放置目录，例如 `mcp/` 或 `server/mcp/`。
- 抽出可被 Node 复用的纯函数：迁移、遍历、Markdown 导出。

### Phase 1：只读 MCP MVP

- 增加 MCP server 入口。
- 增加工作区文件加载器。
- 增加树索引和搜索。
- 实现 `get_workspace_summary`、`list_documents`、`search_outline`、`get_document`、`get_node`、`export_document`。
- 增加 npm script，例如 `npm run mcp:localoutline`。

### Phase 2：Resources 和 Prompts

- 增加 resource URI。
- 增加 prompt 模板。
- 用 MCP Inspector 验证工具、资源和 prompts。
- 编写 Codex/Claude 配置说明。

### Phase 3：1.3.0 受控写入

- 增加 revision/hash。
- 增加 dry-run。
- 增加快照。
- 实现 `create_document`、`update_document_title`、`create_node`、`update_node`、`set_node_checked`、`append_children`、`move_node`、`delete_node`。
- 增加冲突测试。
- 增加 readonly/write 模式测试。

### Phase 4：应用内集成

- 桌面版提供“启用 MCP”设置项。
- UI 显示当前 MCP 数据源状态。
- 支持从当前 IndexedDB 工作区主动刷新 MCP 可读文件。
- 探索 Electron 主进程内置 MCP 服务或本地数据桥。

## 16. MVP 验收标准

MVP 完成时应满足：

- 可以通过 stdio 启动 LocalOutline MCP server。
- 可以从配置路径读取 `localoutline-workspace.json`。
- `list_documents` 能返回文档列表。
- `search_outline` 能命中文档标题、节点正文和备注。
- `get_document` 能返回 compact JSON 和 Markdown。
- `get_node` 能返回节点、父级路径和指定深度子树。
- `export_document` 能返回 JSON 和 Markdown。
- 工作区文件不存在、JSON 非法、文档 ID 不存在、节点 ID 不存在时都有明确错误。
- 不开启写入能力时，服务不会修改任何文件。
- 有基础自动化测试覆盖核心工具。

## 17. 1.3.0 写入验收标准

1.3.0 完成时应满足：

- 默认配置启动时仍然只读，不会修改任何文件。
- `LOCAL_OUTLINE_MCP_MODE=write` 或配置文件 `mode: "write"` 可启用受控写入。
- 所有写入工具都支持 `dryRun`，且 dry-run 不落盘、不创建快照。
- 真实写入必须校验 `expectedRevision`，revision 不一致时返回冲突错误。
- 真实写入前必须创建快照，快照内容可用于恢复写入前工作区。
- 快照文件名必须唯一，不能在同一秒内的同类写入中互相覆盖。
- 写入目标只能是配置的工作区 JSON 文件。
- 真实写入需要用工作区同目录 lockfile 协调多个 MCP 进程。
- 写入使用临时文件和原子替换，避免半写入破坏工作区。
- 原子替换前如果当前工作区 revision 已变化，必须冲突退出并保留外部写入。
- 写入成功后返回新的 `workspaceRevision` 和受影响对象摘要。
- readonly 模式下调用写入工具会返回明确拒绝原因。
- 单元测试覆盖成功写入、dry-run、confirmationArgs、并发 revision 冲突、跨实例写入锁、readonly 拒绝、快照创建、非法参数和原子替换冲突。
- 产品范围仍聚焦 MCP 受控写入，不包含内置 AI 生成功能。

## 18. 风险和待确认问题

### 18.1 风险

- 备份文件不是最新数据，用户可能误以为 AI 读取的是当前 UI 状态。
- 工作区很大时，完整文档返回可能超过客户端上下文限制。
- 1.3.0 写入如果不经过应用内事务，容易和 IndexedDB 状态冲突。
- 不同 MCP 客户端对 resources/prompts 的展示和调用体验可能不同。

### 18.2 待确认问题

- 第一版是否只读取 iCloud 备份文件，还是增加“手动导出 MCP 工作区文件”按钮？
- 是否需要在 UI 里显示“上次 MCP 可读数据更新时间”？
- Codex 和 Claude 的配置说明是否要放进 README，还是单独放进 docs？
- 1.3.0 写入是否先以“快照可恢复”为安全边界，还是必须先实现应用内回收站？
- 是否需要为节点增加 `updatedAt`，方便 AI 判断局部内容新旧？
- 1.3.0 之后是否基于 MCP 写入底座增加内置 AI 生成，并采用用户自带 API key 还是本地模型？

## 19. 参考资料

- [MCP Server Concepts](https://modelcontextprotocol.io/docs/learn/server-concepts)
- [MCP Resources](https://modelcontextprotocol.io/docs/concepts/resources)
- [MCP Prompts](https://modelcontextprotocol.io/docs/concepts/prompts)
- [MCP SDKs](https://modelcontextprotocol.io/docs/sdk)
- [LocalOutline 本地优先架构设计](./local-first-architecture.md)
- [LocalOutline 产品分析](./product-analysis.md)
