# Bike

Bike 是一个本地优先的大纲、思维导图和 Markdown 写作工具。它用同一份树形数据承载想法：你可以在大纲里快速拆解结构，在脑图里观察关系，在 Markdown 里整理成文档，也可以通过 MCP 把本地大纲交给 Codex、Claude 等 agent 读取和整理。

当前版本：1.4.0。

## 1.4.0 重点

Bike 1.4.0 把 AI 辅助放进了核心编辑流程。你可以在桌面菜单中配置自己的 API base URL、API key、模型和协议端点，然后在大纲、思维导图、Markdown 模式里对当前主题执行：

- 生成：基于当前主题内容生成子主题，最多继续展开 3 级子节点。
- 润色：重写当前主题，让表达更清晰、更适合继续组织。

AI 能力使用用户自己的接口配置，支持 `chat/completions` 与 `responses` 两类兼容端点。API key 只保存在本机应用配置中，不会写入仓库、README、发布说明或打包产物。

这一版还完成了产品更名为 Bike、检查更新、默认窗口尺寸调整、节点 AI 入口重新设计、API 兼容解析修复，以及 Swift Native 版本的 1.4.0 功能同步。

## 核心能力

- 大纲编辑：新增同级、子级、缩进、反缩进、折叠、聚焦、任务勾选、备注、颜色。
- 思维导图：同一份大纲数据可切换为脑图视图，支持节点编辑、折叠和展开。
- Markdown 文档：支持源码编辑、分栏编辑预览、纯编辑和纯预览切换。
- AI 辅助：在大纲、思维导图、Markdown 模式中生成子主题或润色当前主题。
- 知识组织：全文搜索、标签 `#tag`、文档链接 `[[文档名]]`。
- 导入导出：JSON 工作区、Markdown、OPML、FreeMind、HTML、PDF。
- 本地优先：浏览器 IndexedDB 自动保存，桌面版可备份到 iCloud Drive。
- 检查更新：桌面菜单和应用内入口可检查 GitHub Release，并跳转发布页获取新版本。
- MCP 服务：把本地工作区暴露为可读取、可搜索、可定位、可导出的结构化上下文，并支持受控写入。

## 发布产物

1.4.0 预发布包含三份桌面产物：

- Windows Electron x64：`Bike-1.4.0-x64.zip`
- macOS Electron Apple Silicon：`Bike-1.4.0-arm64.dmg`
- macOS Swift Native：`Bike-Native-1.4.0.dmg`

当前打包使用本机 ad-hoc/未签名流程，适合个人安装测试。正式面向更多用户分发时，应接入 Apple Developer ID 签名、notarization、stapling，以及 Windows 代码签名。

## 运行开发版

```bash
npm install
npm run dev
```

打开 Vite 输出的本地地址即可使用。桌面壳运行：

```bash
npm run electron:dev
```

## 打包 Electron 版

macOS Apple Silicon：

```bash
npm run electron:dist:mac
```

Windows x64：

```bash
npm run electron:dist:win
```

产物会输出到 `release/`。

## Swift Native 版

Swift Native 版本位于 `native-swift/`，目标是提供更贴近 macOS 原生体验的 Bike 客户端，并与 Electron 版共享 1.4.0 的核心功能。

```bash
cd native-swift
./scripts/test_all.sh
./scripts/package_dmg.sh
```

产物会输出到 `native-swift/release/`。

## 数据与隐私

Bike 默认把数据保存在本机。Web/Electron 版使用 IndexedDB，macOS 桌面版可写入 iCloud Drive 备份路径：

```text
~/Library/Mobile Documents/com~apple~CloudDocs/Bike/bike-workspace.json
```

Swift Native 版的 JSON 备份路径：

```text
~/Library/Mobile Documents/com~apple~CloudDocs/Bike/.backups/bike-workspace.json
```

API key、单用户部署配置和本机工作区文件都不应该提交到仓库。项目已经忽略 `config/bike.config.json`、`release/`、`dist/`、Swift 构建目录和常见临时文件。

## MCP 服务

1.2.0 增加了只读 MCP 服务，1.3.0 增加受控写入能力，方便 Codex、Claude 等 agent 读取和整理本地大纲。MCP 默认读取工作区 JSON 文件，macOS 上会优先使用 Electron 备份路径；如果该文件不存在，会自动尝试 Swift Native 备份路径。

启动 MCP 服务：

```bash
npm run mcp:bike
```

如果要指定工作区文件：

```bash
BIKE_WORKSPACE_PATH=/absolute/path/to/bike-workspace.json npm run mcp:bike
```

如果要允许真实写入，需要显式启用写入模式；默认仍为只读：

```bash
BIKE_MCP_MODE=write BIKE_WORKSPACE_PATH=/absolute/path/to/bike-workspace.json npm run mcp:bike
```

可用能力：

- Read Tools：`get_workspace_summary`、`list_documents`、`search_outline`、`get_document`、`get_node`、`export_document`。
- Write Tools：`create_document`、`update_document_title`、`create_node`、`update_node`、`set_node_checked`、`append_children`、`move_node`、`delete_node`。写入工具默认 `dryRun=true`，真实落盘需要 `BIKE_MCP_MODE=write`、`dryRun=false` 和匹配的 `expectedRevision`。
- Resources：`bike://workspace/summary`、`bike://documents`、`bike://document/{documentId}`、`bike://document-markdown/{documentId}`、`bike://node/{documentId}/{nodeId}`。
- Prompts：`summarize_outline`、`outline_to_prd`、`outline_to_tasks`、`review_outline_structure`。

Codex/Claude Desktop 可按 stdio MCP server 配置本地命令，例如：

```json
{
  "mcpServers": {
    "bike": {
      "command": "npm",
      "args": ["--prefix", "/absolute/path/to/bike", "run", "mcp:bike"],
      "env": {
        "BIKE_WORKSPACE_PATH": "/absolute/path/to/bike-workspace.json",
        "BIKE_MCP_MODE": "readonly"
      }
    }
  }
}
```

## 公网单用户部署

这个项目不要把账号密码写进前端源码或环境变量注入到 Vite 里。公网部署推荐使用内置的单用户认证服务：配置文件只保存在服务器本机，登录通过后才会返回应用静态文件。

```bash
cp config/bike.config.example.json config/bike.config.json
npm run auth:hash -- "你的登录密码"
```

把命令输出的 `passwordHash` 和 `sessionSecret` 填进 `config/bike.config.json`，再设置：

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

如果放在 Nginx/Caddy/Cloudflare Tunnel 后面并启用 HTTPS，把 `secureCookies` 改为 `true`。真实配置文件 `config/bike.config.json` 已加入 `.gitignore`，不要提交到仓库。

## 后续方向

- 增加版本历史、节点级反向链接、附件本地库和更完整的 PDF/图片导出。
- 为 MCP 写入增加应用内控制面板、写入审计日志和快照恢复 UI。
- 完成正式代码签名、notarization、stapling 和 Windows 签名流程。
