# Bike

Bike 是一个本地优先的大纲、思维导图和 Markdown 写作工具。它用同一份树形数据承载想法：你可以在大纲里快速拆解结构，在脑图里观察关系，在 Markdown 里整理成文档，也可以通过 MCP 把本地大纲交给 Codex、Claude 等 agent 读取和整理。

## 当前版本

| 平台 | 版本 | 状态 | 位置 |
| --- | --- | --- | --- |
| Web / Electron Desktop | `1.4.1` | 当前桌面主线 | 根目录 |
| macOS Swift Native | `1.4.1` | 原生 macOS 客户端 | `native-swift/` |
| Android Companion | `0.1.14-web-sync` | Mobile beta | `apps/android/` |
| iOS Companion | `0.1.14` | Mobile beta | `apps/ios/` |

桌面端是完整 Bike 体验；移动端是 companion client，优先服务手机上的快速捕捉、阅读、轻量编辑、AI 生成/润色和 Web Sync，不追求与桌面端完全功能一致。

## 1.4.1 重点

Bike 1.4.1 增加了文档级 Web Sync。公网部署的 Web 版可以作为个人同步中间服务，Electron、Swift Native、Android 和 iOS 填写 Web 地址与设备同步密钥后，可按文档 revision 双向同步，并支持后台自动同步。

同步服务使用 SQLite 保存文档快照、工作区清单和 tombstone 删除记录。客户端写入会携带 `expectedRevision`，revision 不匹配时返回 `409 Conflict`，避免静默覆盖远端更新。服务端也提供文档 operation log API，作为后续多人同文档协作或 CRDT/OT 的底座。

Bike 1.4.x 继续保留 AI 辅助核心编辑流程。你可以在桌面菜单中配置自己的 API base URL、API key、模型和协议端点，然后在大纲、思维导图、Markdown 模式里对当前主题执行：

- 生成：基于当前主题内容生成子主题，最多继续展开 3 级子节点。
- 润色：重写当前主题，让表达更清晰、更适合继续组织。

AI 能力使用用户自己的接口配置，支持 `chat/completions` 与 `responses` 两类兼容端点。API key 只保存在本机应用配置中，不会写入仓库、README、发布说明或打包产物。

这一版还把 Web Sync 接入 Electron、Swift Native、Android 和 iOS。同步设备密钥按用户要求明文保存在本机应用配置中，不读取系统密钥串，便于理解、迁移和删除。

## 核心能力

- 大纲编辑：新增同级、子级、缩进、反缩进、折叠、聚焦、任务勾选、备注、颜色。
- 思维导图：同一份大纲数据可切换为脑图视图，支持节点编辑、折叠和展开。
- Markdown 文档：支持源码编辑、分栏编辑预览、纯编辑和纯预览切换。
- AI 辅助：在大纲、思维导图、Markdown 模式中生成子主题或润色当前主题。
- 知识组织：全文搜索、标签 `#tag`、文档链接 `[[文档名]]`。
- 导入导出：JSON 工作区、Markdown、OPML、FreeMind、HTML、PDF。
- 本地优先：浏览器 IndexedDB 自动保存，桌面版可备份到 iCloud Drive。
- 文档级同步：公网 Web 部署可使用 SQLite 作为个人同步服务，其他设备可按文档 revision 双向同步。
- 检查更新：桌面菜单和应用内入口可检查 GitHub Release，并跳转发布页获取新版本。
- MCP 服务：把本地工作区暴露为可读取、可搜索、可定位、可导出的结构化上下文，并支持受控写入。

## 平台与范围

| 能力 | Web / Electron | macOS Swift Native | Android Companion | iOS Companion |
| --- | --- | --- | --- | --- |
| Workspace v1 JSON | Yes | Yes | Yes | Yes |
| 未知 JSON 字段保留 | Yes | Yes | Yes | Yes |
| 文档库 | Yes | Yes | Yes | Yes |
| 文档重命名 / 删除 / 复制 | Yes | Yes | Yes | Yes |
| 大纲阅读 | Yes | Yes | Yes | Yes |
| 轻量大纲编辑 | Yes | Yes | Yes | Yes |
| AI 生成 / 润色 | Yes | Yes | Yes | Yes |
| Responses / Chat Completions | Yes | Yes | Yes | Yes |
| 思维导图 | Yes | Yes | Deferred | Deferred |
| MCP | Yes | Planned / partial | Deferred | Deferred |
| 文档级同步 | Manual / Auto Web Sync | Manual / Auto Web Sync | Manual / Auto Web Sync | Manual / Auto Web Sync |
| 自动同步 | Configurable | Configurable | Configurable | Configurable |
| 拖拽排序 | Yes | Yes | Deferred | Deferred |
| 多节点批量操作 | Yes | Yes | Deferred | Deferred |
| 完整富文本字段编辑 | Yes | Yes | Deferred | Deferred |

更完整的平台能力矩阵见 `docs/mobile/platform-matrix.md`。

## 项目结构

```text
.
├── src/                    # Web / Electron 共享前端
├── electron/               # Electron 壳
├── native-swift/           # macOS Swift Native 客户端
├── apps/
│   ├── android/            # Android Companion，Kotlin + Jetpack Compose
│   └── ios/                # iOS Companion，SwiftUI + SwiftPM/Xcode
├── server/                 # 单用户公网部署服务
├── mcp/                    # Bike MCP server
├── config/                 # 单用户部署配置模板
└── docs/                   # 项目文档
```

## 快速开始

安装依赖并运行 Web 开发版：

```bash
npm install
npm run dev
```

打开 Vite 输出的本地地址即可使用。桌面壳运行：

```bash
npm run electron:dev
```

## 桌面端构建

macOS Apple Silicon Electron：

```bash
npm run electron:dist:mac
```

Windows x64 Electron：

```bash
npm run electron:dist:win
```

产物会输出到 `release/`。

Swift Native macOS：

```bash
cd native-swift
./scripts/test_all.sh
./scripts/package_dmg.sh
```

产物会输出到 `native-swift/release/`。

## 移动端开发

移动端不是桌面端完整替代品，而是用于手机上的快速捕捉、阅读、轻量编辑和 AI 生成/润色。Android 与 iOS 共享 Bike Workspace v1 JSON 语义，并尽量保留桌面端未知字段，避免移动端轻编辑破坏桌面端数据。

移动端当前不包含脑图视图、MCP、拖拽排序、多选批量大纲操作和完整富文本字段编辑。

Android 本地验证：

```bash
cd apps/android
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
PATH=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home/bin:$PATH \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
./gradlew testDebugUnitTest assembleDebug
```

iOS 本地验证：

```bash
cd apps/ios
swift build
swift run BikeCoreChecks
xcodebuild -project BikeiOS.xcodeproj \
  -scheme BikeiOS \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/BikeIOSXcodeDerived \
  build CODE_SIGNING_ALLOWED=NO
```

移动端封版资产通过 GitHub Releases 分发。当前 beta 使用 `mobile-v0.1.14` 标签：

- Android：debug keystore 签名的 APK，可用于侧载 beta 测试。
- iOS：Simulator `.app` 可用于模拟器测试；`iphoneos` IPA 目前未签名，真机安装需要 Apple Developer 证书和 provisioning profile。

APK、IPA、dSYM、zip 等发布产物不要提交到 git；发布时附上 release notes 与 SHA-256 校验值。

## 数据与隐私

Bike 默认把数据保存在本机。Web/Electron 版使用 IndexedDB，macOS 桌面版可写入 iCloud Drive 备份路径：

```text
~/Library/Mobile Documents/com~apple~CloudDocs/Bike/bike-workspace.json
```

Swift Native 版的 JSON 备份路径：

```text
~/Library/Mobile Documents/com~apple~CloudDocs/Bike/.backups/bike-workspace.json
```

移动端使用各自平台的本地存储保存工作区、同步配置与 AI 配置。Web Sync 设备密钥明文保存在本机应用配置中，不读取系统密钥串。API key、单用户部署配置、本机工作区文件、移动端签名文件、keystore、provisioning profile 都不应该提交到仓库。项目已经忽略 `config/bike.config.json`、`release/`、`dist/`、Swift/Android 构建目录和常见临时文件。

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
  },
  "sync": {
    "enabled": true,
    "databasePath": "data/bike-sync.sqlite",
    "deviceTokenHashes": []
  }
}
```

启动生产服务：

```bash
npm run start:web
```

如果放在 Nginx/Caddy/Cloudflare Tunnel 后面并启用 HTTPS，把 `secureCookies` 改为 `true`。真实配置文件 `config/bike.config.json` 已加入 `.gitignore`，不要提交到仓库。

同步服务需要在配置中显式设置 `"sync": { "enabled": true }` 才会启动，SQLite 数据库保存在 `data/bike-sync.sqlite`。Web 同源登录后可直接在侧栏底部同步；Electron、Swift Native、Android 和 iOS 可填写 Web 地址 + 设备同步密钥连接同一服务，并可开启可配置后台自动同步。服务端也提供文档 operation log API 作为多人同文档协作底座。详细协议见 [Bike 文档级同步服务](./docs/sync-service.md)。

## 发布规则

- 桌面端 release 使用 `v1.x.x` 标签。
- 移动端 beta release 使用 `mobile-v0.x.x` 标签。
- 不提交构建产物、签名文件、证书、密钥、工作区 JSON 或本机路径。
- GitHub Release 必须包含 release notes 和 SHA-256 校验文件。

## 后续方向

- 增加版本历史、节点级反向链接、附件本地库和更完整的 PDF/图片导出。
- 为 MCP 写入增加应用内控制面板、写入审计日志和快照恢复 UI。
- 完成正式代码签名、notarization、stapling、Windows 签名、Android release keystore 和 iOS Developer signing 流程。
