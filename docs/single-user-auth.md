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

开启后，服务端取 `X-Forwarded-For` 中由可信代理追加的条目作为客户端 IP，也就是从右往左数第 `trustedProxyCount` 个条目（默认 `1`，即最右侧一项）。左侧条目由客户端自己填写，可以随意伪造，因此不会被用来识别客户端。只有一层反向代理（Nginx、Caddy 等）时保持默认的 `1`；有多层可信代理（例如 CDN 后面再接 Nginx）时，把 `trustedProxyCount` 设为可信代理的层数。`trustedProxyCount` 必须是大于等于 1 的整数；该请求头缺失或为空时回退到 TCP 连接地址。

### 登录限流与受信设备

登录失败会按以下方式限流，阈值和退避时间不变（同一窗口 15 分钟、最多 8 次失败、单次最长等待 30 秒）：

- 每次成功登录后，除了会话 Cookie `bike_session`，还会下发一个用 `sessionSecret` 签名的设备 Cookie `bike_device`（`HttpOnly`、`SameSite=Strict`、开启 `secureCookies` 时带 `Secure`，有效期约 180 天）。它只用来标记“这台设备以前登录成功过”，本身不能用来访问应用。
- 带有效设备 Cookie 的登录只按这台设备单独计数，不受账号和 IP 维度的限流影响。这样即使有人持续猜密码，你已经用过的设备仍然能正常登录。
- 没有设备 Cookie（或 Cookie 无效、属于其他用户名）的登录同时按“IP”和“用户名”两个维度计数。同一 IP 更换用户名仍会累计失败次数。任一维度处于限流状态时，服务端会在校验密码之前直接返回 `429`，即使密码正确也一样，避免把 `429` 和登录成功当作判断密码对错的依据。
- 失败会累加本次尝试使用的计数；成功会清除它们。
- 限流表只清理已过期的记录。表满时，新身份的请求返回 `429`，不能挤掉已有账号的失败记录。受信设备使用独立的限流表，不受陌生客户端填满记录的影响。

退出登录不会清除设备 Cookie。更换 `sessionSecret` 会让所有设备 Cookie 一起失效；之后第一次登录需要在没有被限流时完成。

### 退出登录与会话状态文件

退出登录会让此前签发的所有会话失效，这个吊销时间点会写入会话状态文件，服务重启后依然有效。文件位置按以下顺序确定：

1. `auth.sessionStatePath`：相对项目根目录的路径，也可以写绝对路径。留空表示不设置。
2. systemd 的 `StateDirectory=` 提供的 `$STATE_DIRECTORY` 下的 `auth-session.json`（有多个目录时取第一个）。
3. 项目根目录下的 `data/auth-session.json`。

文件以临时文件 + 重命名的方式原子写入，权限为 `0600`，父目录不存在时会自动创建。运行服务的用户需要对该目录有写权限。

`update-web` 会给尚未配置 `StateDirectory` 的旧 systemd 服务添加一个独立配置文件，再重新加载并重启服务；原 unit、运行用户、启动命令和管理员配置保持原样。已有自定义 `StateDirectory` 时直接沿用。默认状态位置从 `data/` 移到 systemd 目录后，启动时也会读取旧文件并取较新的吊销时间，避免先前退出的会话恢复有效；新的退出记录写入 systemd 目录。显式设置了 `auth.sessionStatePath` 时仍使用该路径，需要自行保证写权限。

- 文件不存在：视为从未退出登录。
- 文件无法读取或内容损坏：服务会在日志中报错，并让启动前签发的所有会话失效（需要重新登录），下次退出登录时会重写该文件。
- 写入失败：日志中会报错，本次退出登录仍然生效并清除 Cookie，但只在服务重启前有效。

## 启动

```bash
npm run start:web
```

如果你用反向代理，把公网域名代理到配置里的 `host:port`。建议让服务监听 `127.0.0.1`，只让反向代理暴露到公网。

## 同步服务

同步服务已经拆成独立入口。Web-only 部署不会启动同步 API；Web 前端仍然保留同步设置，可以填写任意兼容的同步服务地址。使用部署菜单时运行：

```bash
curl -fsSL https://raw.githubusercontent.com/MoarLiu/Bike/main/scripts/install.sh | bash
```

直接安装 Bike Web 版：

```bash
curl -fsSL https://raw.githubusercontent.com/MoarLiu/Bike/main/scripts/install.sh | bash -s -- install-web
```

直接安装同步服务：

```bash
curl -fsSL https://raw.githubusercontent.com/MoarLiu/Bike/main/scripts/install.sh | bash -s -- install-sync
```

已经 clone 仓库时，也可以在项目目录里运行：

```bash
./scripts/setup-sync-server.sh install
```

curl 管理脚本会下载 GitHub Release 里的 Web/Sync Server 部署包，校验 SHA-256，解压到 `/opt/bike`，然后进入引导安装。如果系统 Node.js 缺失或低于 `22.13.0`，安装器会自动下载官方 Node.js 22 到 `/opt/bike/.node/` 并让服务使用它，不覆盖系统自带 Node。Web 引导脚本会配置登录用户名、登录密码、端口和默认同步服务地址；同步服务引导脚本会配置端口、用户名、SQLite 路径、CORS 来源、同步密钥。后续用同一个脚本管理：

```bash
cd /opt/bike
./bike.sh
./bike.sh status
./bike.sh logs
./bike.sh restart
./bike.sh stop
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
