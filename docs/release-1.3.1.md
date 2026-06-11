# Bike 1.3.1 更新说明

发布日期：2026-06-07

## 修复

- 为 MCP 写入工具增加节点深度和单次写入节点数量上限，降低异常或恶意工具输入导致 MCP 进程崩溃、资源膨胀的风险。
- `create_document`、`create_node`、`append_children` 和 `move_node` 均会校验写入后的节点深度，上限为 64 层。
- 单次新增节点数量会复用 `BIKE_MCP_MAX_DOCUMENT_NODES` / `maxDocumentNodes` 上限。
- 将 MCP 写入路径中的节点构造、确认参数生成和节点定位改为迭代实现，避免超深输入触发递归栈溢出。
- MCP 写入工具的 `children` schema 不再递归校验，深度和数量防护统一下沉到 core 层。
- 修复 `search_outline` 在节点正文和备注同时命中时，结果数量可能超过 `limit` 的问题。
- Web 认证部署模式补充 CSP、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY` 和 `Referrer-Policy` 响应头。
- 修复认证后静态资源服务的路径前缀边界校验，避免读取 `dist` 同前缀兄弟目录。
- 登录页错误文案增加 HTML 转义，作为防御性加固。
- 补充 `trustProxyHeaders` 的部署说明：仅在可信反向代理覆盖客户端 `X-Forwarded-For` 时开启。

## 验证

- `npm run mcp:test`
- `npm run mcp:smoke`
- `node --check server/auth-server.mjs`
- `node --check mcp/bike-core.mjs`
- `node --check mcp/bike-server.mjs`
- `node --check mcp/bike-core.test.mjs`
- `git diff --check`
- `npm run build`

## 打包说明

- Electron macOS Apple Silicon: `Bike-1.3.1-arm64.dmg`
- 本次产物仍使用 ad-hoc/未正式签名构建，尚未 notarize；适合个人安装测试。公开分发前建议接入 Apple Developer ID 签名和 notarization。

## SHA-256

- `Bike-1.3.1-arm64.dmg`: `667f0c77ddb6ec75f8c4f67ff56e11a98289e73a2cfeb84aeafe1d9c827edc5b`
- `Bike-1.3.1-arm64.dmg.blockmap`: `7e4fc023df5fbca70d50e10e96f956d1dfd325737bb3bc360656ed9c28b4cb8b`

## 关联文档

- [Bike 1.3.0 更新说明](./release-1.3.0.md)
- [单用户认证部署](./single-user-auth.md)
