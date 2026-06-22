# Bike 1.4.1 更新说明

发布日期：2026-06-22

## 重点更新

- 增加文档级 Web Sync：公网 Web 部署可作为个人同步中间服务，Electron、Swift Native、Android 和 iOS 可填写 Web 地址与设备同步密钥连接。
- 同步服务使用 SQLite 保存文档快照、workspace manifest、revision 和 tombstone 删除记录。
- 同步写入携带 `expectedRevision`，revision 不匹配时返回 `409 Conflict`，避免静默覆盖远端更新。
- 增加文档 operation log API，作为后续多人同文档协作、OT 或 CRDT 的底座。
- Electron、Swift Native、Android 和 iOS 均接入手动同步、上传、拉取和可配置后台自动同步。
- 设备同步密钥按产品要求明文保存在 Bike 自身本机配置中，不读取 Keychain、Keystore 或 Electron safeStorage。

## 服务端 API

- `GET /api/sync/manifest`
- `PATCH /api/sync/manifest`
- `GET /api/documents`
- `GET /api/documents/:id`
- `PUT /api/documents/:id`
- `DELETE /api/documents/:id`
- `GET /api/documents/:id/operations`
- `POST /api/documents/:id/operations`

详细协议见 `docs/sync-service.md`。

## 发布产物

- Web / Electron Desktop: `release/Bike-1.4.1-arm64.dmg`
- Electron update metadata: `release/Bike-1.4.1-arm64.dmg.blockmap`, `release/latest-mac.yml`
- macOS Swift Native: `release/native-swift/Bike-Native-1.4.1.dmg`
- Android Companion debug APK: `release/android/Bike-Android-0.1.14-debug.apk`
- Android Companion unsigned release APK: `release/android/Bike-Android-0.1.14-release-unsigned.apk`
- Web deploy source bundle: `release/web/Bike-Web-1.4.1-sync.tar.gz`

## 兼容性和限制

- Web Sync 是单用户个人同步服务，不是多用户账号体系。
- 文档级同步可以检测冲突，但不会自动合并同一篇文档的并发修改。
- Operation log 已持久化和分发，但当前不会在服务端自动应用任意节点操作。
- Electron 和 Swift Native macOS 包为本地 ad-hoc 签名，未 notarize。
- Android debug APK 可侧载测试；release APK 当前为 unsigned，需要正式发布前使用 Android 签名证书签名。
- 本机缺少完整 Xcode 时无法产出 iOS `.app` 或 `.ipa` 发布包；本轮只验证 SwiftPM 构建和 `BikeCoreChecks`。

## 验证

- `npm run build`
- `npm run electron:test`
- `npm run mcp:test`
- `node --test server/auth-server.test.mjs`
- `node --check electron/main.cjs electron/preload.cjs server/auth-server.mjs server/sync-store.mjs`
- `cd native-swift && ./scripts/test_all.sh`
- `cd apps/ios && swift build`
- `cd apps/ios && swift run BikeCoreChecks`
- `cd apps/android && ./gradlew testDebugUnitTest assembleDebug assembleRelease`
- `hdiutil verify release/Bike-1.4.1-arm64.dmg`
- `hdiutil verify release/native-swift/Bike-Native-1.4.1.dmg`
- `codesign --verify --deep --strict` for both macOS `.app` bundles
- `apksigner verify` for Android debug APK

## SHA-256

```text
f99725419762094e43d2cdfe2c9b331c8d2ea7cbcfb153f753c6d9509dc19895  release/Bike-1.4.1-arm64.dmg
509f2b43983fc2974e3904210fefccf2ec11c4c444f709cfed77ea55c8298fbc  release/Bike-1.4.1-arm64.dmg.blockmap
b6257390c95b9fe016ab358db6046bf1c460f4685a8d14da13c3d158da146434  release/latest-mac.yml
149f28e1902386deefa488aa4e14fffacbef864aaa7e8a05151f6155cc0c4584  release/native-swift/Bike-Native-1.4.1.dmg
cd36182ab2d1442ec736a75f91bd7acbfd167959d652771eff01cf349c993da6  release/android/Bike-Android-0.1.14-debug.apk
c51c898ef51b15f8501a8356c80979f5583d11a3c1aca221853fec6a9514c125  release/android/Bike-Android-0.1.14-release-unsigned.apk
49e9f210f337884fa6ec0bffa8ec1a23dca6a141ce689ce67d31e94146c284ba  release/web/Bike-Web-1.4.1-sync.tar.gz
```

同一份校验值也写入 `release/SHA256SUMS-1.4.1.txt`。
