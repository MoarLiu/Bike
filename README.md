# Bike

Bike 是一个本地优先的大纲、思维导图和 Markdown 写作工具。它用同一份树形数据承载想法：你可以在大纲里快速拆解结构，在脑图里观察关系，在 Markdown 里整理成文档，也可以通过 MCP 把本地大纲交给 Codex、Claude 等 agent 读取和整理。

## 当前版本

| 平台 | 版本 | 状态 | 位置 |
| --- | --- | --- | --- |
| Web / Electron macOS Apple Silicon | `1.7.0` | 稳定版，macOS 使用 ad-hoc 签名 | 根目录 |

## 1.7.0

- 桌面版支持选择、粘贴及拖入图片或文件，按 SHA-256 去重保存，四视图共享附件引用。
- 首次引入附件时升级到工作区 version 2，并保留可下载的升级前副本。完整迁移和备份使用“工作区 ZIP”，单独 JSON 保存结构及引用。
- Markdown/HTML 携图 ZIP、PDF 内嵌图片、脑图 SVG/PNG，以及 30 天附件隔离清理已接入。清理扫描包含回收站、版本历史、撤销和备用副本。
- 同步交换附件元数据，另一设备通过 ZIP 补齐原文件。先升级 Sync Server，含附件文档会拒绝旧客户端覆盖写入。
- 本版按确认的发布范围继续采用 ad-hoc 签名，首次安装可能触发 macOS 安全提示。Developer ID 签名公证流程已准备，凭据与真实验收后续完成。
- 检查更新已接入应用内下载、进度和保存后重启安装流程。原生自动替换需要兼容签名，本版 ad-hoc 制品通过 DMG 手动升级。配置与验证边界见 [应用内更新](docs/updates.md)。

功能、升级规则和验证范围见 [1.7.0 更新说明](docs/release-1.7.0.md)，实现与环境记录见 [实施记录](docs/implementation-1.7.0.md)。

## 1.6.0 重点

- 文档/主题链接补全、反向链接、改名跟随；重名目标需明确选择。
- 主题级搜索、多标签与任务筛选，以及本机收藏、最近打开和保存筛选管理。
- 同文档主题关系的编辑和脑图虚线显示，关系修改支持撤销。
- Electron 自动 iCloud 备份默认关闭；启用后写入已保存版本，遇外部变化暂停。
- 保留撤销、回收站和本地版本历史；节点详情默认收起，Electron 最小窗口为 1366×960。

完整更新说明见 [Bike 1.6.0](docs/release-1.6.0.md)。Bike 面向个人知识整理，以 Electron macOS 桌面版为主，继续提供 Web/Sync Server 部署包。

## 同步服务与 AI

Bike 1.4.2 把 Web Sync 从 Web 认证服务中拆成可单独部署的 Sync Server。Web 版默认只托管应用入口和静态资源，数据仍保存在浏览器 IndexedDB；需要多端同步时，可以额外部署同步服务，Web 与 Electron 填写同步服务地址与设备同步密钥后，可按文档 revision 双向同步，并支持后台自动同步。

这一版新增独立同步服务入口、专用配置模板和 `.sh` 引导脚本。用户可以只部署 Web、部署 Web + Sync Server，或只安装 Sync Server；脚本会引导设置同步端口、用户名、SQLite 路径、CORS 来源和同步密钥，并提供启动、停止、重启、日志、状态和健康检查。

同步服务继续使用 SQLite 保存文档快照、工作区清单和 tombstone 删除记录。客户端写入会携带 `expectedRevision`，revision 不匹配时返回 `409 Conflict`，避免静默覆盖远端更新。服务端也提供文档 operation log API，作为后续多人同文档协作或 CRDT/OT 的底座。

Bike 1.4.x 继续保留 AI 辅助核心编辑流程。你可以在桌面菜单中配置自己的 API base URL、API key、模型和协议端点，然后在大纲、思维导图、Markdown 模式里对当前主题执行：

- 生成：基于当前主题内容生成子主题，最多继续展开 3 级子节点。
- 润色：重写当前主题，让表达更清晰、更适合继续组织。

AI 能力使用用户自己的接口配置，支持 `chat/completions` 与 `responses` 两类兼容端点。API key 只保存在本机应用配置中，不会写入仓库、README、发布说明或打包产物。

Electron 同样接入 Web Sync。同步设备密钥按用户要求明文保存在本机应用配置中，不读取系统密钥串，便于理解、迁移和删除。

## 核心能力

- 大纲编辑：新增同级、子级、缩进、反缩进、折叠、聚焦、任务勾选、备注、颜色。
- 思维导图：同一份大纲数据可切换为脑图视图，支持节点编辑、折叠和展开。
- Markdown 文档：支持源码编辑、分栏编辑预览、纯编辑和纯预览切换。
- AI 辅助：在大纲、思维导图、Markdown 模式中生成子主题或润色当前主题。
- 知识组织：主题级搜索、多标签 `#tag`、文档/主题链接 `[[文档名#主题名|别名]]`、反向链接和同文档主题关系。
- 导入导出：JSON 工作区、Markdown、OPML、FreeMind、HTML、PDF。
- 编辑安全：撤销/重做、文档回收站和本地版本历史快照。
- 本地优先：浏览器 IndexedDB 保存，桌面版支持手动备份和可选的自动 iCloud Drive 备份。
- 节点详情栏默认收起，可通过右上角的“显示节点详情”按钮展开，再次点击收起。
- 文档级同步：可单独部署 SQLite Sync Server，其他设备可按文档 revision 双向同步。
- 检查更新由桌面菜单和应用内入口共用，支持确认下载、显示进度、稍后安装及保存工作区后重启安装。macOS 自动安装需要正式签名应用及匹配的 ZIP 更新包。
- MCP 服务：把本地工作区暴露为可读取、可搜索、可定位、可导出的结构化上下文，并支持受控写入。

## 项目结构

```text
.
├── src/                    # Web / Electron 共享前端
├── electron/               # Electron 壳
├── server/                 # Web 认证服务、独立同步服务
├── mcp/                    # Bike MCP server
├── shared/                 # 前端与 MCP 共用的 Markdown / 知识连接运行时
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

产物会输出到 `release/`。

## 数据与隐私

Bike 默认把数据保存在本机。Web/Electron 版使用 IndexedDB，macOS 桌面版可写入 iCloud Drive 备份路径：

```text
~/Library/Mobile Documents/com~apple~CloudDocs/Bike/bike-workspace.json
```

Web Sync 设备密钥明文保存在本机应用配置中，不读取系统密钥串。API key、单用户部署配置、本机工作区文件和签名文件都不应该提交到仓库。项目已经忽略 `config/bike.config.json`、`release/`、`dist/` 和常见临时文件。

IndexedDB 保存失败或页面关闭前仍有未保存编辑时，应用会按标签页独立保留备用副本。另一页保存后，如果本页仍有未保存修改，会暂停保存并提示冲突；关页重开后，可通过侧栏的“备用副本 · 查看与恢复”下载或恢复留下的修改。恢复和删除前均会先下载备份，内容不同的备用副本会保留供恢复。旧版本的 localStorage 备用数据也能读取。

## MCP 服务

1.2.0 增加了只读 MCP 服务，1.3.0 增加受控写入能力，方便 Codex、Claude 等 agent 读取和整理本地大纲。MCP 默认读取工作区 JSON 文件，macOS 上会优先使用 Electron 备份路径；如果该文件不存在，会兼容尝试改名前的旧版 `LocalOutline/localoutline-workspace.json` 路径。其他平台默认读取 `~/.bike/bike-workspace.json`。

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

这个项目不要把账号密码写进前端源码或环境变量注入到 Vite 里。公网部署推荐使用内置的单用户认证 Web 服务：配置文件只保存在服务器本机，登录通过后才会返回应用静态文件。同步服务已经拆成独立入口，可以按需要单独部署。

### 只部署 Web 版

推荐使用 curl 打开部署菜单：

```bash
curl -fsSL https://raw.githubusercontent.com/MoarLiu/Bike/main/scripts/install.sh | bash
```

直接安装 Bike Web 版：

```bash
curl -fsSL https://raw.githubusercontent.com/MoarLiu/Bike/main/scripts/install.sh | bash -s -- install-web
```

脚本会下载 GitHub Release 里的 Web/Sync Server 部署包，校验 SHA-256，解压到 `/opt/bike`，引导配置 Web 监听地址、端口、登录用户名和登录密码，并在 systemd 环境下安装和启动 `bike-web.service`。后续管理可以执行：

```bash
cd /opt/bike
./bike.sh
./bike.sh update-web
```

也可以手动配置：

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
  "web": {
    "defaultSyncServerUrl": ""
  },
  "sync": {
    "enabled": false,
    "databasePath": "data/bike-sync.sqlite",
    "deviceTokenHashes": []
  }
}
```

启动生产服务：

```bash
npm run start:web
```

如果放在 Nginx/Caddy/Cloudflare Tunnel 后面并启用 HTTPS，把 `secureCookies` 改为 `true`。真实配置文件 `config/bike.config.json` 已加入 `.gitignore`，不要提交到仓库。Web-only 模式不会启动同步 API；前端同步设置仍可填写其他兼容的同步服务地址。

### 只部署同步服务

在服务器上可以直接用 curl 打开管理菜单：

```bash
curl -fsSL https://raw.githubusercontent.com/MoarLiu/Bike/main/scripts/install.sh | bash
```

直接安装同步服务：

```bash
curl -fsSL https://raw.githubusercontent.com/MoarLiu/Bike/main/scripts/install.sh | bash -s -- install-sync
```

安装指定版本或目录：

```bash
curl -fsSL https://raw.githubusercontent.com/MoarLiu/Bike/main/scripts/install.sh \
  | BIKE_VERSION=v1.6.0 BIKE_INSTALL_DIR=/opt/bike-sync-server bash -s -- install-sync
```

已经 clone 仓库时，也可以在项目目录里运行：

```bash
./scripts/setup-sync-server.sh install
```

curl 管理脚本会下载 GitHub Release 里的 Web/Sync Server 部署包，校验 SHA-256，解压到 `/opt/bike`，然后进入引导安装。如果系统 Node.js 缺失或低于 `22.13.0`，安装器会自动下载官方 Node.js 22 到 `/opt/bike/.node/` 并让服务使用它，不覆盖系统自带 Node。引导脚本会逐步配置监听地址、端口、用户名、SQLite 路径、CORS 来源，并可选择系统生成或自定义同步密钥；在 systemd 环境下会安装并启动 `bike-sync-server.service`。后续管理命令：

```bash
cd /opt/bike
./bike.sh
./bike.sh status
./bike.sh logs
./bike.sh restart
./bike.sh stop
```

也可以打开交互菜单：

```bash
./scripts/setup-sync-server.sh
```

如果不安装系统服务，也可以直接复制 `config/bike-sync.config.example.json` 为 `config/bike-sync.config.json` 后启动：

```bash
npm run start:sync
```

同步服务默认监听 `127.0.0.1:4174`，API 使用 `Authorization: Bearer 你的同步密钥` 鉴权。服务端也提供文档 operation log API 作为多人同文档协作底座。详细协议见 [Bike 文档级同步服务](./docs/sync-service.md)。

### 部署 Web + 同步服务

先分别准备 `config/bike.config.json` 和 `config/bike-sync.config.json`。如果希望 Web 版打开后默认指向本机同步服务，在 Web 配置里设置：

```json
{
  "web": {
    "defaultSyncServerUrl": "http://127.0.0.1:4174"
  }
}
```

然后组合启动：

```bash
npm run start:full
```

生产环境更推荐用 systemd、pm2、Docker 或反向代理分别管理 Web 和 Sync 两个进程；同步服务可以用 `./scripts/setup-sync-server.sh install` 安装成 systemd 服务，`start:full` 主要用于本机或轻量部署。

## 发布规则

- 桌面端 release 使用 `v1.x.x` 标签。
- 不提交构建产物、签名文件、证书、密钥、工作区 JSON 或本机路径。
- GitHub Release 必须包含 release notes 和 SHA-256 校验文件。

## 后续方向

- 增加节点级反向链接、附件本地库和更完整的 PDF/图片导出。
- 为 MCP 写入增加应用内控制面板、写入审计日志和快照恢复 UI。
- 完成 macOS 正式代码签名、notarization 和 stapling 流程。
