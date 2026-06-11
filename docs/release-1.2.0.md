# Bike 1.2.0 更新说明

发布日期：2026-06-04

## 新增

- 增加只读 MCP 服务，方便 Codex、Claude 等 agent 读取 Bike 本地工作区。
- MCP 服务支持 `get_workspace_summary`、`list_documents`、`search_outline`、`get_document`、`get_node`、`export_document` 六个工具。
- MCP 服务支持工作区、文档、Markdown 文档和节点上下文资源。
- 增加 `summarize_outline`、`outline_to_prd`、`outline_to_tasks`、`review_outline_structure` 四个 prompt 模板。
- 支持通过 `BIKE_WORKSPACE_PATH` 指定工作区 JSON 文件；未指定时 macOS 默认优先读取 Electron 备份路径，并在文件不存在时回退到 Swift 原生版 `.backups` 备份路径。
- 增加 MCP unit test 和 stdio smoke test。

## 变更

- 项目版本号更新为 `1.2.0`。
- README 增加 MCP 启动方式和 Codex/Claude stdio 配置示例。
- Electron 打包配置纳入 MCP 服务入口文件，便于后续桌面版集成。

## 验证

- `npm run mcp:test`
- `npm run mcp:smoke`
- `node --check server/auth-server.mjs`
- `node --check electron/main.cjs`
- `npm run build`
- `cd native-swift && ./scripts/test_all.sh`
- `git diff --check`

## 打包说明

- Electron macOS Apple Silicon: `Bike-1.2.0-arm64.dmg`
- Electron Windows x64: `Bike-1.2.0-x64.zip`
- Swift 原生版: `Bike-Native-1.2.0.dmg`

本次产物仍使用 ad-hoc/未正式签名构建，尚未 notarize；适合个人安装测试。公开分发前仍建议接入 Apple Developer ID 签名、notarization 和 Windows 代码签名。

## SHA-256

```text
be224a1b2c4d7b5548ca89cdb30d6ee5c7418182185d4d16358ee2321b2e7c0b  release/Bike-1.2.0-arm64.dmg
97bb699d07c48789ba906c1532c162d500e211cb9e8b62dd9c56db9c479eacd1  release/Bike-1.2.0-arm64.dmg.blockmap
6eb7168ae97d41452a54121904ddb6d98fca7e7396414223e778084ec6232531  release/Bike-1.2.0-x64.zip
eba9dbb10d04fdd573b7b62620453c414a4b835d0640758aeae11becefc44495  native-swift/release/Bike-Native-1.2.0.dmg
```
