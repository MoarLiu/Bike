# Bike 1.1.2 更新说明

发布日期：2026-06-02

## 新增

- Swift 原生版默认使用 iCloud Drive/Bike 作为 Markdown 保存目录。
- Swift 原生版会把每个文档保存为独立 `.md` 文件，并维护隐藏 metadata 用于文档顺序、活动文档和文件名映射。
- Swift 原生版新增加载失败错误页，支持重试和打开 Markdown 目录。

## 修复

- 修复 Web/Electron 在工作区加载失败时可能用空白数据覆盖原数据的问题。
- 修复 Web/Electron localStorage 降级数据与 IndexedDB 数据新旧判断不一致的问题。
- 修复服务端登录限流的内存增长、X-Forwarded-For 信任和用户名维度硬锁可用性问题。
- 修复 Electron CSP、外链拦截、备份清理误报和备份保留边界问题。
- 修复 Swift 原生版加载失败后 starter workspace 可能被保存到真实目录的问题。
- 修复 Swift 原生版外部 Markdown 文件因缺少 metadata 而被重复保存的问题。
- 修复 Swift 原生版保存时重写未变化 Markdown 文件的问题。
- 修复 Swift 原生版思维导图空白点击导致编辑文本丢失的问题。

## 验证

- `npm run build`
- `node --check server/auth-server.mjs`
- `node --check electron/main.cjs`
- `cd native-swift && ./scripts/test_all.sh`
- `git diff --check`

## 打包说明

- Electron macOS Apple Silicon: `Bike-1.1.2-arm64.dmg`
- Swift 原生版: `Bike-Native-1.1.2.dmg`

## SHA-256

```text
ec1d3beabc4921e85cb5dafd6ce2f774c2fb6e6b98296b99402ea0bbda9ca4a4  release/Bike-1.1.2-arm64.dmg
3f3a377d1a90138a3ea8037249d634664eb2f9fdbc04de52ba0cb71fa23a1a8d  release/Bike-1.1.2-arm64.dmg.blockmap
ae97e423fba81d05eaf0c0d372a7e0aecd416d875d19cd55a4f911e5783cd718  release/Bike-1.1.2-x64.zip
9be156865a5e74cf736026950faf1dc9730f5a599e76443c799ea525391e27d9  native-swift/release/Bike-Native-1.1.2.dmg
```
