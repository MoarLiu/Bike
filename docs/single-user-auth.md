# 单用户认证部署

Bike 的主数据仍然保存在使用者浏览器的 IndexedDB 中。公网部署时，认证层的目标是阻止陌生人访问你的应用入口和静态资源，避免他们打开同一个站点、导入/覆盖自己的数据或误以为这是公开服务。

## 为什么不用前端配置

Vite 前端配置会被打包进浏览器可下载的 JS 文件。账号、密码、哈希或密钥只要进入前端包，就不能视为秘密。因此公网部署使用 `server/auth-server.mjs`：

- 服务器读取 `config/bike.config.json`。
- 未登录请求会跳转到 `/login`。
- 登录成功后设置 `HttpOnly`、`SameSite=Strict` 的会话 Cookie。
- 登录后才会返回 `dist` 中的应用文件和资源。
- Web 服务默认不启动同步 API。需要多端同步时，推荐单独部署 Sync Server。

## 创建配置

```bash
cp config/bike.config.example.json config/bike.config.json
npm run auth:hash -- "你的登录密码"
```

把输出填入配置：

```json
{
  "host": "127.0.0.1",
  "port": 4173,
  "auth": {
    "username": "me",
    "passwordHash": "pbkdf2$310000$...",
    "sessionSecret": "...",
    "sessionMaxAgeHours": 168,
    "secureCookies": true
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

`secureCookies` 在 HTTPS 后面应设置为 `true`；本机 HTTP 调试时用 `false`。

`trustProxyHeaders` 默认保持 `false`。只有当服务部署在可信反向代理后面，且代理会覆盖客户端传入的 `X-Forwarded-For` 头时，才应开启它。

## 启动

```bash
npm run start:web
```

如果你用反向代理，把公网域名代理到配置里的 `host:port`。建议让服务监听 `127.0.0.1`，只让反向代理暴露到公网。

## 同步服务

同步服务已经拆成独立入口。Web-only 部署不会启动同步 API；Web 前端仍然保留同步设置，可以填写任意兼容的同步服务地址。只部署同步服务时运行：

```bash
curl -fsSL https://raw.githubusercontent.com/MoarLiu/Bike/main/scripts/install-sync-server.sh | bash
```

已经 clone 仓库时，也可以在项目目录里运行：

```bash
./scripts/setup-sync-server.sh install
```

curl 安装器会下载 GitHub Release 里的 Web/Sync Server 部署包，校验 SHA-256，解压到 `/opt/bike-sync-server`，然后进入引导安装。如果系统 Node.js 缺失或低于 `22.5.0`，安装器会自动下载官方 Node.js 22 到 `/opt/bike-sync-server/.node/` 并让同步服务使用它，不覆盖系统自带 Node。引导脚本会配置端口、用户名、SQLite 路径、CORS 来源、同步密钥；在 systemd 环境下会安装并启动 `bike-sync-server.service`。后续用同一个脚本管理：

```bash
cd /opt/bike-sync-server
./scripts/setup-sync-server.sh status
./scripts/setup-sync-server.sh logs
./scripts/setup-sync-server.sh restart
./scripts/setup-sync-server.sh stop
```

也可以手动复制 `config/bike-sync.config.example.json` 为 `config/bike-sync.config.json` 后运行：

```bash
npm run start:sync
```

如果要让 Web 版默认连接本机同步服务，在 `config/bike.config.json` 中设置：

```json
{
  "web": {
    "defaultSyncServerUrl": "http://127.0.0.1:4174"
  }
}
```

同步设置中输入的设备密钥会明文保存在本机应用配置中，不读取系统密钥串。

生成设备密钥 hash：

```bash
npm run auth:hash -- "你的设备同步密钥"
```

手动配置同步服务密钥时，把输出的 `passwordHash` 放入 `config/bike-sync.config.json`：

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

同步 API 和冲突规则见 [Bike 文档级同步服务](./sync-service.md)。

## 更换密码

重新执行：

```bash
npm run auth:hash -- "新的登录密码"
```

替换 `passwordHash`。如果也替换 `sessionSecret`，已有登录会全部失效。
