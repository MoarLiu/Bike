# Local Outline

一个参考幕布产品逻辑的本地优先大纲工具：以树状大纲为核心数据模型，同一份数据可切换为大纲、思维导图和演示视图。数据默认存储在浏览器本地 IndexedDB，桌面版可自动备份到 iCloud Drive。

当前版本：1.3.2。

## 运行

```bash
npm install
npm run dev
```

打开 Vite 输出的本地地址即可使用。桌面壳运行：

```bash
npm run electron:dev
```

打包 macOS Apple Silicon 桌面版：

```bash
npm run electron:dist:mac
```

打包 Windows x64 桌面版：

```bash
npm run electron:dist:win
```

产物会输出到 `release/`，包括 macOS 的 `Local Outline-版本号-arm64.dmg` 和 Windows 的 `Local Outline-版本号-x64.zip`。当前使用本机 ad-hoc/未签名打包，适合个人安装测试；正式分发给其他用户时需要接入 Apple Developer ID 签名、notarization 或 Windows 代码签名。

## MCP 服务

1.2.0 增加了只读 MCP 服务，1.3.0 增加受控写入能力，方便 Codex、Claude 等 agent 读取和整理本地大纲。MCP 默认读取工作区 JSON 文件，macOS 上会优先使用 Electron 备份路径：

```text
~/Library/Mobile Documents/com~apple~CloudDocs/LocalOutline/localoutline-workspace.json
```

如果该文件不存在，会自动尝试 Swift 原生版备份路径：

```text
~/Library/Mobile Documents/com~apple~CloudDocs/LocalOutline/.backups/localoutline-workspace.json
```

启动 MCP 服务：

```bash
npm run mcp:localoutline
```

如果要指定工作区文件：

```bash
LOCAL_OUTLINE_WORKSPACE_PATH=/absolute/path/to/localoutline-workspace.json npm run mcp:localoutline
```

如果要允许真实写入，需要显式启用写入模式；默认仍为只读：

```bash
LOCAL_OUTLINE_MCP_MODE=write LOCAL_OUTLINE_WORKSPACE_PATH=/absolute/path/to/localoutline-workspace.json npm run mcp:localoutline
```

可用能力：

- Read Tools：`get_workspace_summary`、`list_documents`、`search_outline`、`get_document`、`get_node`、`export_document`。
- Write Tools：`create_document`、`update_document_title`、`create_node`、`update_node`、`set_node_checked`、`append_children`、`move_node`、`delete_node`。写入工具默认 `dryRun=true`，真实落盘需要 `LOCAL_OUTLINE_MCP_MODE=write`、`dryRun=false` 和匹配的 `expectedRevision`。dry-run 会返回可复用的 `confirmationArgs`，用于确认同一批生成 ID 和 UTC ISO 写入时间；真实写入期间会创建同目录 lockfile 并在替换前复核 revision。
- Resources：`localoutline://workspace/summary`、`localoutline://documents`、`localoutline://document/{documentId}`、`localoutline://document-markdown/{documentId}`、`localoutline://node/{documentId}/{nodeId}`。
- Prompts：`summarize_outline`、`outline_to_prd`、`outline_to_tasks`、`review_outline_structure`。

Codex/Claude Desktop 可按 stdio MCP server 配置本地命令，例如：

```json
{
  "mcpServers": {
    "localoutline": {
      "command": "npm",
      "args": ["--prefix", "/absolute/path/to/local-outline", "run", "mcp:localoutline"],
      "env": {
        "LOCAL_OUTLINE_WORKSPACE_PATH": "/absolute/path/to/localoutline-workspace.json",
        "LOCAL_OUTLINE_MCP_MODE": "readonly"
      }
    }
  }
}
```

## 公网单用户部署

这个项目不要把账号密码写进前端源码或环境变量注入到 Vite 里。公网部署推荐使用内置的单用户认证服务：配置文件只保存在服务器本机，登录通过后才会返回应用静态文件。

```bash
cp config/local-outline.config.example.json config/local-outline.config.json
npm run auth:hash -- "你的登录密码"
```

把命令输出的 `passwordHash` 和 `sessionSecret` 填进 `config/local-outline.config.json`，再设置：

```json
{
  "host": "127.0.0.1",
  "port": 4173,
  "auth": {
    "username": "me",
    "passwordHash": "填入生成结果",
    "sessionSecret": "填入生成结果",
    "sessionMaxAgeHours": 168,
    "secureCookies": false
  }
}
```

启动生产服务：

```bash
npm run start:web
```

如果放在 Nginx/Caddy/Cloudflare Tunnel 后面并启用 HTTPS，把 `secureCookies` 改为 `true`。真实配置文件 `config/local-outline.config.json` 已加入 `.gitignore`，不要提交到仓库。

## 当前能力

- 大纲编辑：新增同级、子级、缩进、反缩进、折叠、聚焦、任务勾选、备注、颜色。
- 多视图：大纲编辑、Markdown 编辑/预览、思维导图、演示视图。
- Markdown 模式：支持源码编辑、分栏编辑预览、纯编辑和纯预览切换。
- 知识组织：全文搜索、标签 `#tag`、文档链接 `[[文档名]]`。
- 导入导出：JSON 工作区、Markdown、OPML、FreeMind、HTML。
- 文件导出：PDF 直接下载。
- 本地优先：浏览器 IndexedDB 自动保存，Ctrl/Cmd+S 可触发本地保存。
- 输入空间：大纲编辑宽度提升到约 1040px，脑图节点支持更长单行文本。
- iCloud 备份：浏览器版可选择 iCloud Drive 文件夹写入；Electron 版写入 `~/Library/Mobile Documents/com~apple~CloudDocs/LocalOutline/`。
- MCP 服务：暴露本地工作区摘要、文档列表、全文搜索、文档读取、节点上下文、导出和受控写入能力。

## 后续方向

- 用 File System Access API 绑定固定工作区文件夹，实现更接近原生的打开/保存体验。
- 用 Electron Builder 或 Tauri 打包 macOS 应用。
- 增加版本历史、节点级反向链接、附件本地库、PDF/图片导出。
- MCP 后续增加应用内控制面板、写入审计日志和快照恢复 UI。
- AI 生成功能放到 1.3.0 之后评估，优先基于 MCP 写入底座做可预览、可确认的生成建议。
