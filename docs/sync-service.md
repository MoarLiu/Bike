# Bike 文档级同步服务

Bike Sync Server 是可单独部署的个人同步服务。同步仍保持本地优先：Web 前端继续保存 IndexedDB，本地数据可离线使用；同步服务端 SQLite 只作为多设备交换文档的中间层。

## MVP 范围

- 同步粒度：单篇 `OutlineDocument`。
- 工作区清单：保存 `activeDocumentId`、文档顺序和每篇文档的 revision。
- 冲突策略：所有写入都携带 `expectedRevision`，revision 不匹配返回 `409 Conflict`。
- 删除策略：服务端使用 `deletedAt` tombstone，避免旧设备把已删除文档重新上传。
- 数据库：默认 `data/bike-sync.sqlite`，可在配置中修改。
- 鉴权：独立同步服务使用 Bearer 设备密钥。旧的 Web 内置同步兼容模式仍可使用登录 Cookie。

不在 MVP 范围内：

- 多用户账号体系。
- 实时协同编辑。
- 服务端自动应用节点级操作。
- CRDT 自动合并。
- 附件同步。

## 部署模式

同步服务使用 Node 内置 `node:sqlite`，部署环境需要 Node.js 22.5.0 或更新版本。

### 只部署 Sync Server

推荐使用引导脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/MoarLiu/Bike/main/scripts/install-sync-server.sh | bash
```

安装指定版本或目录：

```bash
curl -fsSL https://raw.githubusercontent.com/MoarLiu/Bike/main/scripts/install-sync-server.sh \
  | BIKE_VERSION=v1.4.2 BIKE_INSTALL_DIR=/opt/bike-sync-server bash
```

已经 clone 仓库时，也可以在项目目录里运行：

```bash
./scripts/setup-sync-server.sh install
```

curl 安装器会下载 GitHub Release 里的 Web/Sync Server 部署包，校验 SHA-256，解压到 `/opt/bike-sync-server`，然后进入引导安装。脚本会逐步配置同步端口、用户名、SQLite 路径、CORS 来源和同步密钥；在 systemd 环境下会安装并启动 `bike-sync-server.service`。后续管理命令：

```bash
cd /opt/bike-sync-server
./scripts/setup-sync-server.sh status
./scripts/setup-sync-server.sh logs
./scripts/setup-sync-server.sh restart
./scripts/setup-sync-server.sh stop
```

也可以打开交互菜单：

```bash
./scripts/setup-sync-server.sh
```

不安装系统服务时，可以手动复制配置模板：

```bash
cp config/bike-sync.config.example.json config/bike-sync.config.json
npm run start:sync
```

独立同步服务读取 `config/bike-sync.config.json`：

```json
{
  "host": "127.0.0.1",
  "port": 4174,
  "owner": {
    "username": "me"
  },
  "databasePath": "data/bike-sync.sqlite",
  "deviceTokenHashes": [],
  "maxBodyBytes": 10485760,
  "cors": {
    "enabled": true,
    "allowedOrigins": [
      "http://127.0.0.1:4173",
      "http://localhost:4173"
    ]
  }
}
```

`databasePath` 是相对项目根目录的 SQLite 文件路径，也可以写绝对路径。浏览器 Web 版跨端口访问独立同步服务时，需要把 Web 来源加入 `cors.allowedOrigins`；Electron、Swift Native、Android 和 iOS 原生客户端不依赖浏览器 CORS。

如需给移动端使用设备密钥：

```bash
./scripts/setup-sync-server.sh add-key
```

脚本可以系统生成密钥，也可以录入自定义密钥。手动维护配置时，把生成的 `passwordHash` 放入：

```json
{
  "deviceTokenHashes": [
    {
      "name": "my-phone",
      "hash": "pbkdf2$..."
    }
  ]
}
```

客户端请求时使用：

```http
Authorization: Bearer 你的设备同步密钥
```

### 只部署 Web 版

Web-only 部署使用 `config/bike.config.json`，默认 `"sync.enabled": false`。这种模式不启动同步 API，浏览器数据只保存在本机 IndexedDB。用户仍可在同步设置中填写其他兼容的同步服务地址。

### 部署 Web + Sync Server

准备 Web 配置和同步服务配置后，可以组合启动：

```bash
npm run start:full
```

如果希望 Web 版默认连接本机同步服务，在 `config/bike.config.json` 中设置：

```json
{
  "web": {
    "defaultSyncServerUrl": "http://127.0.0.1:4174"
  }
}
```

生产环境建议用 systemd、pm2、Docker 或反向代理分别管理 Web 和 Sync 两个进程。旧配置仍支持在 `config/bike.config.json` 中显式设置 `"sync": { "enabled": true }`，让 `server/auth-server.mjs` 同时暴露同步 API；这是兼容模式，不再是推荐部署形态。

`npm run setup:sync` 仍然可用，它只是 `bash scripts/setup-sync-server.sh` 的 npm 别名。

## API

### `GET /healthz`

独立同步服务健康检查，无需鉴权：

```json
{
  "ok": true,
  "service": "bike-sync-server",
  "owner": "me"
}
```

### `GET /api/sync/manifest`

返回工作区清单：

```json
{
  "workspaceRevision": 2,
  "activeDocumentId": "doc-a",
  "documentOrder": ["doc-a"],
  "documents": [
    {
      "id": "doc-a",
      "title": "项目计划",
      "revision": 7,
      "updatedAt": "2026-06-21T10:00:00.000Z",
      "deletedAt": null
    }
  ]
}
```

### `PATCH /api/sync/manifest`

更新当前文档和文档顺序：

```json
{
  "expectedRevision": 2,
  "activeDocumentId": "doc-a",
  "documentOrder": ["doc-a", "doc-b"]
}
```

### `GET /api/documents`

返回文档摘要列表。内容与 manifest 的 `documents` 字段一致。

### `GET /api/documents/:id`

返回单篇文档：

```json
{
  "revision": 7,
  "document": {
    "id": "doc-a",
    "title": "项目计划",
    "createdAt": "...",
    "updatedAt": "...",
    "nodes": []
  }
}
```

已删除文档返回 `410 Gone`，包含 tombstone revision。

### `PUT /api/documents/:id`

创建或更新单篇文档：

```json
{
  "expectedRevision": 7,
  "document": {
    "id": "doc-a",
    "title": "项目计划",
    "createdAt": "...",
    "updatedAt": "...",
    "nodes": []
  }
}
```

新建文档使用 `"expectedRevision": null`。更新已有文档必须传当前 revision。

### `DELETE /api/documents/:id`

删除单篇文档：

```json
{
  "expectedRevision": 7
}
```

服务端会写入 tombstone，并递增文档 revision。

### `GET /api/documents/:id/operations?after=0`

返回指定文档的协作操作日志。`after` 是客户端已经处理过的最后一个 operation sequence：

```json
{
  "documentId": "doc-a",
  "currentRevision": 7,
  "operations": [
    {
      "sequence": 1,
      "baseRevision": 7,
      "actorId": "macbook",
      "operation": {
        "type": "node.update_text",
        "nodeId": "node-a",
        "text": "新的主题"
      },
      "createdAt": "2026-06-22T10:00:00.000Z"
    }
  ]
}
```

### `POST /api/documents/:id/operations`

追加协作操作日志：

```json
{
  "baseRevision": 7,
  "actorId": "macbook",
  "operations": [
    {
      "type": "node.update_text",
      "nodeId": "node-a",
      "text": "新的主题"
    }
  ]
}
```

`baseRevision` 必须匹配当前文档 revision，否则返回 `409 Conflict`。当前版本只持久化并分发操作日志，不在服务端自动应用任意操作；客户端要把它作为节点级/CRDT 协同编辑的底座，而不是绕过现有 `PUT /api/documents/:id` 的文档快照同步。

## Web 前端行为

侧栏底部的同步状态块可直接执行双向同步，旁边的设置按钮可配置服务地址和设备密钥。
Web-only 部署默认不提供同步 API。部署 Web + Sync Server 时，Web 服务可以通过 `web.defaultSyncServerUrl` 预填默认同步地址；用户也可以手动填写其他兼容的同步服务地址。同步设置里的设备密钥会明文保存在本机应用配置中，便于用户理解、迁移和删除；不会读取系统密钥串。

当前提供三种手动动作：

- 同步：根据本地保存的文档 revision 和 fingerprint 做双向交换。
- 拉取：从服务端替换本机工作区，执行前下载本机 JSON 备份。
- 上传：把本机文档上传到服务端，适合第一次初始化服务器。

可在同步设置中开启后台自动同步。自动同步会在本机保存后延迟触发一次，并按配置的间隔轮询远端更新；无变化时不提示，有上传、下载、删除、冲突或错误时提示。

双向同步规则：

- 本机新文档：上传。
- 远端新文档：下载。
- 本机删除且远端未变：删除远端。
- 远端删除且本机未变：删除本机。
- 两边都改：报告冲突，不覆盖任一边。

## Electron、Swift Native、Android 和 iOS

Electron 本地版复用 Web 前端的同步界面。打包后的 Electron 渲染进程不会直接跨域请求 Web 服务，而是通过 preload 暴露的主进程代理访问同步 API。代理只允许 `/api/sync/manifest`、`/api/documents`、`/api/documents/:id` 和文档 operation log 路径，并把设备密钥作为 Bearer token 发送。Electron 不读取系统密钥串，设备密钥会明文保存在本机应用配置中。

Swift Native 版在设置或侧栏齿轮中配置 Web 地址和设备密钥。Web 地址、设备密钥和同步 revision 状态保存在 UserDefaults。本地仍以 iCloud Drive/Bike 下的 Markdown 文件和 sidecar metadata 作为主存储；同步拉取或双向同步下载远端更新后，会先创建本地快照再写回 Markdown 存储。

Android 和 iOS Companion 也复用同一套文档级 API。Android 使用 SharedPreferences 明文保存设备密钥；iOS 使用 UserDefaults 明文保存设备密钥。两端都支持手动同步、上传、拉取和可配置后台自动同步。

部署好同步服务后，本地客户端连接流程：

1. 运行 `./scripts/setup-sync-server.sh install` 或手动配置 `config/bike-sync.config.json`，生成设备同步密钥。
2. 启动同步服务，确认 `http://你的同步服务地址/healthz` 可访问。
3. 在 Web、Electron、Swift Native、Android 或 iOS 中打开 Web Sync 配置，填写同步服务地址和设备同步密钥。
4. 第一次初始化可选择“上传”把本机文档推到同步服务，或选择“拉取”把同步服务文档替换到本机。
5. 后续使用“同步”进行文档级双向交换；发生 revision 冲突时会提示，不会静默覆盖。

## 后续演进

服务端已经提供文档 operation log 底座。要达到真正多人同文档实时编辑，还需要把各端编辑器里的标题、节点文本、插入、删除、移动等 UI 事件映射为稳定操作，并实现客户端操作应用/回放、冲突变换或 CRDT 合并策略。
