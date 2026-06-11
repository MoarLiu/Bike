# Bike 1.4.0 更新说明

发布日期：2026-06-11

## 重点更新

- 产品正式更名为 Bike，Web、Electron、MCP、Swift Native、README 和发布文档已统一使用新名称。
- 新增 AI 辅助能力：可配置 API base URL、API key、模型和协议端点，在大纲、思维导图、Markdown 模式中生成子主题或润色当前主题。
- AI 生成支持基于当前节点继续展开子节点，最多生成 3 级结构，适合快速拆需求、整理文章提纲和扩展脑图。
- 新增检查更新入口：Electron 菜单和应用内按钮可检查 GitHub Release，并打开发布页获取新版本。
- Swift Native 同步 1.4.0 功能，包括 AI 配置、AI 生成/润色、检查更新、默认窗口尺寸和脑图折叠/展开控制。

## 体验优化

- 重新设计节点旁的 AI 入口按钮，改为更轻量的圆形 Sparkles 图标。
- 默认启动窗口调整为 `1366 x 960`。
- 大纲输入区域更稳定，修复部分节点圆点、文字和输入框错位的问题。
- 思维导图模式下，AI 菜单层级提升，避免弹出菜单被画布遮挡。
- Swift Native 的 API 配置弹窗改为输入框内部灰色占位提示，减少表单拥挤感。
- Swift Native 思维导图折叠按钮改为更小的圆形控件：折叠状态显示被收起的直接子节点数量，展开状态显示 `-`。

## 兼容性修复

- 兼容严格要求 Responses `input` 为列表的 API 服务。
- 移除部分模型或兼容服务不支持的 `temperature` 参数。
- 兼容 `chat/completions` 与 `responses` 返回结构，包括 JSON 字符串、字符串数组、`nodes/items/topics` 容器，以及 `title/name/label/topic` 等字段。
- 兼容 `text/event-stream` SSE 返回，避免把流式事件当普通 JSON 文本解析后出现“AI没有生成子节点”。
- 继续读取旧版 IndexedDB、localStorage、iCloud 备份路径、AI 配置和 MCP 环境变量，降低从 LocalOutline 升级到 Bike 的迁移风险。

## 隐私说明

- API key 只保存在用户本机应用配置中，不写入源码、README、发布说明或打包产物。
- 本次预发布流程会扫描 `sk-`、API base URL、token、secret、password、私钥、本机绝对路径和常见个人信息模式。
- `config/bike.config.json`、`release/`、`dist/`、Swift 构建目录和常见临时文件保持在 `.gitignore` 保护范围内。

## 打包产物

- Windows Electron x64: `release/Bike-1.4.0-x64.zip`
- macOS Electron Apple Silicon: `release/Bike-1.4.0-arm64.dmg`
- macOS Swift Native: `native-swift/release/Bike-Native-1.4.0.dmg`

Bundle 信息：

- Electron Bundle ID: `com.bike.app`
- Electron App version/build: `1.4.0`
- Swift Native Bundle ID: `com.bike.native`
- Swift Native App version/build: `1.4.0`

## 验证清单

- `npm run build`
- `npm run electron:test`
- `npm run mcp:test`
- `node --test server/auth-server.test.mjs`
- `npm run electron:dist:mac`
- `hdiutil verify release/Bike-1.4.0-arm64.dmg`
- `npm run electron:dist:win`
- `unzip -t release/Bike-1.4.0-x64.zip`
- `cd native-swift && ./scripts/test_all.sh`
- `cd native-swift && ./scripts/package_dmg.sh`
- `hdiutil verify native-swift/release/Bike-Native-1.4.0.dmg`

## SHA-256

```text
6bd1e0973b8ae3c70b118f71dd622167aede133cd2e1f6c5cfe1aadc10f0d3cd  release/Bike-1.4.0-arm64.dmg
02e86d0f8016cbbe9f03af1afd14e8a19b8f7e49eb65b460d99fa47fe6672a75  release/Bike-1.4.0-arm64.dmg.blockmap
c9faddb7cac5716a3065d2dffe5fd38da86e865e0c252963a1d90e00b80a4c51  release/Bike-1.4.0-x64.zip
2341cca30355e48731cd17bff6d1e7246c545a6309e2c599dd8aa9434593a75b  native-swift/release/Bike-Native-1.4.0.dmg
```

## 关联文档

- [Bike 1.3.2 更新说明](./release-1.3.2.md)
