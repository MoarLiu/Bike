# Local Outline 1.3.0 更新说明

发布日期：2026-06-06

## 新增

- MCP 服务从只读扩展为受控写入，方便 Codex、Claude 等 agent 在用户确认后整理本地大纲。
- 新增 8 个 MCP 写入工具：
  - `create_document`
  - `update_document_title`
  - `create_node`
  - `update_node`
  - `set_node_checked`
  - `append_children`
  - `move_node`
  - `delete_node`
- 写入工具默认 `dryRun=true`，dry-run 会返回变更预览和可复用的 `confirmationArgs`。
- 支持 `LOCAL_OUTLINE_MCP_MODE=write` 或配置文件 `mode: "write"` 显式启用真实写入。
- 新增 Electron workspace lock/atomic 写入 helper，并补充单元测试。

## 安全和可靠性

- 默认仍为只读模式，写入工具即使存在也不会在 readonly 模式下落盘。
- 真实写入必须提供匹配的 `expectedRevision`，revision 不一致会冲突退出。
- 真实写入前会在工作区同目录 `.backups/` 下创建快照。
- 工作区写入使用临时文件和原子替换，避免半写入破坏 JSON。
- MCP 写入和 Electron iCloud latest 备份共享带 owner token 的 lockfile，降低并发覆盖风险。
- `writeTimestamp` 必须是 UTC ISO 时间，格式类似 `2026-06-05T08:00:00.000Z`。

## 非目标

- 不内置 AI 生成功能、通用聊天面板、模型选择、API key 管理或生成计费能力。
- 不做实时多人协作或云端同步服务。
- 不接受工具参数里的任意文件路径。
- 不要求写入后立即刷新正在运行的浏览器 IndexedDB 状态。

## 后续 AI 方向

AI 生成功能放到 1.3.0 之后评估。后续更适合基于 1.3.0 的 MCP 写入底座实现：

- 从节点扩展子任务或提纲。
- 把粘贴文本整理成结构化大纲。
- 从大纲生成 PRD、任务列表、会议纪要或发布说明。
- 审查大纲结构并生成修改建议。
- 生成内容先进入待确认区或 AI 建议文档，再由用户确认合并。

后续内置 AI 必须默认关闭，并明确提示会发送哪些本地内容给模型服务。

## 已知限制

- 如果图形界面已经打开并持有旧的 IndexedDB 工作区，MCP 写入后的文件状态不会自动同步回正在运行的 UI。
- 本版本仍聚焦 MCP 写入底座，AI 生成建议放到后续版本评估。

## 验证

- `npm run mcp:test`
- `npm run mcp:smoke`
- `node --check electron/workspace-lock.cjs`
- `node --check electron/main.cjs`
- `node --check mcp/localoutline-core.mjs`
- `node --check mcp/localoutline-server.mjs`
- `git diff --check`
- `npm run build`

## 打包说明

- Electron macOS Apple Silicon: `Local Outline-1.3.0-arm64.dmg`
- 本次产物仍使用 ad-hoc/未正式签名构建，尚未 notarize；适合个人安装测试。公开分发前建议接入 Apple Developer ID 签名和 notarization。

## SHA-256

- `Local Outline-1.3.0-arm64.dmg`: `5dbe0df77bbe2a221214bc99be24c7ee1c1a5be52bab030d143f7943ce1e5663`
- `Local Outline-1.3.0-arm64.dmg.blockmap`: `4cb5f56b1fb42ea18f44f20287450ecbb8a9604abe85a71a5d489b7c3a80f774`

## 关联文档

- [LocalOutline MCP 服务需求说明](./mcp-service-requirements.md)
- [Local Outline 1.2.0 更新说明](./release-1.2.0.md)
