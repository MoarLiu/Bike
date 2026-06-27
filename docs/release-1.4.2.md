# Bike 1.4.2 更新说明

发布日期：2026-06-27

## 重点更新

- 将 Web Sync 从 Web 认证服务中拆成可单独部署的 Bike Sync Server。
- Web-only 部署默认不启动同步 API，浏览器数据继续保存在 IndexedDB；用户仍可手动接入其他兼容同步服务。
- 新增独立同步服务入口 `server/sync-server.mjs`、共享同步 API `server/sync-api.mjs` 和专用配置模板 `config/bike-sync.config.example.json`。
- 新增同步服务安装脚本 `./scripts/setup-sync-server.sh`，支持引导配置、添加密钥、安装 systemd 服务、启动、停止、重启、日志、状态和健康检查。
- Web + Sync Server 部署可通过 `web.defaultSyncServerUrl` 预填默认同步服务地址。
- 修复公网 HTTP/IP 部署下的 Web 空白页和 `crypto.randomUUID()` 不可用问题。
- 修复跨端口 Sync Server 的 CORS 凭据处理，减少浏览器侧 `Failed to fetch`。

## 发布产物

- Web / Electron Desktop: `release/Bike-1.4.2-arm64.dmg`
- Electron update metadata: `release/Bike-1.4.2-arm64.dmg.blockmap`, `release/latest-mac.yml`
- Web + Sync Server deploy bundle: `release/web/Bike-Web-1.4.2-sync-server.tar.gz`
- Checksums: `release/SHA256SUMS-1.4.2.txt`

## 兼容性和限制

- Sync Server 需要 Node.js 22.5.0 或更新版本，因为服务端存储使用 Node 内置 `node:sqlite`。
- Web Sync 仍是单用户个人同步服务，不是多用户账号体系。
- 文档级同步可以检测冲突，但不会自动合并同一篇文档的并发修改。
- Electron macOS 包为本地 ad-hoc 签名，未 notarize。
- 本轮只重新发布 Web / Electron / Sync Server 资产；Swift Native 当前发布资产仍为 1.4.1，Android 和 iOS Companion beta 仍为 0.1.14。
- 本机当前只有 CommandLineTools，没有完整 Xcode，因此 SwiftUI Native/iOS app 完整编译和 Native DMG 打包未纳入本轮发布资产。

## 验证

- `npm run build`
- `npm run electron:test`
- `npm run mcp:test`
- `node --test server/auth-server.test.mjs server/sync-server.test.mjs`
- `node --check electron/main.cjs electron/preload.cjs server/auth-server.mjs server/sync-server.mjs server/sync-store.mjs server/sync-api.mjs scripts/setup-sync-server.mjs scripts/hash-password.mjs`
- `bash -n scripts/setup-sync-server.sh`
- `./scripts/setup-sync-server.sh help`
- `cd apps/ios && swift run BikeCoreChecks`
- `hdiutil verify release/Bike-1.4.2-arm64.dmg`
- Mounted DMG check: `Bike.app` version `1.4.2`, bundle id `com.bike.app`
- `codesign --verify --deep --strict` for mounted `Bike.app`
- Mounted DMG launch smoke test
- Web deploy tarball whitelist and privacy scan
- `cd release && shasum -a 256 -c SHA256SUMS-1.4.2.txt`

## SHA-256

```text
7bbdacde28e54e27c66bea4e5c3792f9aeface235f588901ede6090b4048da07  Bike-1.4.2-arm64.dmg
2839e631252b47227ce1995152c6c7aea22820a0b16b3fd37fac996fce3fab1d  Bike-1.4.2-arm64.dmg.blockmap
730ed48cc81f9432213890e5ceb32e1abc82d9247f3df9fb142db5e439a63a2e  latest-mac.yml
7112449593aa483208a53fe78e0086097553059445616cf49f32bf79de26565b  web/Bike-Web-1.4.2-sync-server.tar.gz
```

同一份校验值也写入 `release/SHA256SUMS-1.4.2.txt`，路径相对 `release/` 目录。
