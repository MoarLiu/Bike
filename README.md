# Local Outline

一个参考幕布产品逻辑的本地优先大纲工具：以树状大纲为核心数据模型，同一份数据可切换为大纲、思维导图和演示视图。数据默认存储在浏览器本地 IndexedDB，桌面版可自动备份到 iCloud Drive。

## 运行

```bash
npm install
npm run dev
```

打开 Vite 输出的本地地址即可使用。桌面壳运行：

```bash
npm run electron:dev
```

打包 macOS Apple Silicon 桌面版：

```bash
npm run electron:dist:mac
```

打包 Windows x64 桌面版：

```bash
npm run electron:dist:win
```

产物会输出到 `release/`，包括 macOS 的 `Local Outline-版本号-arm64.zip` 和 Windows 的 `Local Outline-版本号-x64.zip`。当前使用本机 ad-hoc/未签名打包，适合个人安装测试；正式分发给其他用户时需要接入 Apple Developer ID 签名、notarization 或 Windows 代码签名。

## 公网单用户部署

这个项目不要把账号密码写进前端源码或环境变量注入到 Vite 里。公网部署推荐使用内置的单用户认证服务：配置文件只保存在服务器本机，登录通过后才会返回应用静态文件。

```bash
cp config/local-outline.config.example.json config/local-outline.config.json
npm run auth:hash -- "你的登录密码"
```

把命令输出的 `passwordHash` 和 `sessionSecret` 填进 `config/local-outline.config.json`，再设置：

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
  }
}
```

启动生产服务：

```bash
npm run start:web
```

如果放在 Nginx/Caddy/Cloudflare Tunnel 后面并启用 HTTPS，把 `secureCookies` 改为 `true`。真实配置文件 `config/local-outline.config.json` 已加入 `.gitignore`，不要提交到仓库。

## 当前能力

- 大纲编辑：新增同级、子级、缩进、反缩进、折叠、聚焦、任务勾选、备注、颜色。
- 多视图：大纲编辑、思维导图、演示视图。
- 知识组织：全文搜索、标签 `#tag`、文档链接 `[[文档名]]`。
- 导入导出：JSON 工作区、Markdown、OPML、FreeMind、HTML。
- 文件导出：PDF 直接下载。
- 本地优先：浏览器 IndexedDB 自动保存。
- iCloud 备份：浏览器版可选择 iCloud Drive 文件夹写入；Electron 版写入 `~/Library/Mobile Documents/com~apple~CloudDocs/LocalOutline/`。

## 后续方向

- 用 File System Access API 绑定固定工作区文件夹，实现更接近原生的打开/保存体验。
- 用 Electron Builder 或 Tauri 打包 macOS 应用。
- 增加版本历史、节点级反向链接、附件本地库、PDF/图片导出。
