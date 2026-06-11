# Bike 1.3.2 更新说明

发布日期：2026-06-11

## 修复

- 修复认证服务登出接口的会话吊销校验，未登录请求不会再吊销当前有效会话，避免被强制登出。
- 增强认证服务的密码哈希、会话吊销和限流测试覆盖。
- 修复节点重排后 Markdown 属性恢复可能串位的问题，Web、MCP 和 Swift 版本都会用节点文本校验属性归属。
- 修复输入正文后缩进防抖回写导致内容或层级回滚的问题。
- 修复大纲聚焦模式和脑图中心编辑场景下误改文档标题的问题。
- 修复备注编辑、拖拽悬停和导入导出中的若干性能与一致性问题。
- 补齐代码块字段的类型、迁移、MCP、OPML、Markdown 和 Swift 往返支持。
- 修复 Electron 工作区锁校验与 MCP core 校验不一致的问题。
- 移除 SwiftData 旧记录模型，Swift 版本改为 sidecar 元数据保存节点属性。
- 将 PDF 中文字体切换为可子集化的 TrueType 字体，降低中文导出 PDF 体积。

## 变更

- 当前版本号更新为 `1.3.2`。
- Electron macOS 构建继续面向 Apple Silicon。
- 本次仍为 ad-hoc/未正式签名构建，尚未 notarize；首次打开可能需要在 macOS 安全设置中手动允许。

## 验证

- `npm run build`
- `npm run mcp:test`
- `node --test server/auth-server.test.mjs`
- `cd native-swift && ./scripts/test_all.sh`
- `npm run mcp:smoke`
- `npm audit --audit-level=moderate`
- `git diff --check`
- `npm run electron:dist:mac`
- DMG 挂载检查、Info.plist 版本检查、代码签名状态检查和 CRC 校验
- 应用包与源码隐私扫描，未发现待发布的本地报告、绝对路径或凭据

## 打包说明

- Electron macOS Apple Silicon: `Local.Outline-1.3.2-arm64.dmg`
- Bundle ID: `com.bike.app`
- App version/build: `1.3.2`

## SHA-256

- `Local.Outline-1.3.2-arm64.dmg`: `deedce844a8d945613283c05cb8518a9b8cd3704d80cfac4be94a5dad605b1ad`
- `Local.Outline-1.3.2-arm64.dmg.blockmap`: `09e155bafce41a1ef1662696726df10b59bbcf4710dbce97ce0ae74d2e9216b4`

## 关联文档

- [Bike 1.3.1 更新说明](./release-1.3.1.md)
- [单用户认证部署](./single-user-auth.md)
