# Bike 1.6.0 发布验证

发布日期：2026-11-08。GitHub 发布时刻为 2026-11-08 14:04:20 UTC，即北京时间 22:04:20。

- Release：`Bike 1.6.0`，标签 `v1.6.0`。
- 发布提交：`c97f4437a52695832aadb97c194ee658761f2db5`。
- 发布提交的 Linux/macOS CI 均通过，运行编号 `42487612340`。
- Release 为公开可访问、非草稿、非预发布，并已设为最新版本；未登录访问发布页返回 HTTP 200。
- 六项资产均上传完成。发布后重新下载全部六项，与本地逐字节一致；下载目录中的总校验清单核验通过。
- `main` 上后续发布状态文档同步不改变该标签、发布提交或资产。

## 资产

| 文件 | 字节数 |
| --- | ---: |
| `Bike-1.6.0-arm64.dmg` | 136176116 |
| `Bike-1.6.0-arm64.dmg.sha256` | 87 |
| `Bike-1.6.0-arm64.dmg.blockmap` | 141837 |
| `Bike-Web-1.6.0-sync-server.tar.gz` | 3774408 |
| `latest-mac.yml` | 337 |
| `SHA256SUMS-1.6.0.txt` | 458 |

DMG SHA-256：

```text
3b0ae4416c15cacedfd5b1f919f2a939368fead2ec9ed98872fdd7a715fdea4a
```

Web/Sync 包 SHA-256：

```text
a4f15782ddce19add03f6a9ab1c1fffc72e45394dff1e47ba995f468ad5dc8dc
```

## 已验证范围与限制

- 本机 Node.js 22.13.0 下 288/288 测试、类型检查、生产构建与 MCP smoke 通过；远端两个平台 CI 通过。
- 正式 DMG 的版本、架构、签名、原生启动/退出及包内模块已核验；部署包完成干净安装和 Web/Sync/MCP 检查。
- 签名为 ad-hoc，未经过 Developer ID 签名与 Apple 公证。
- 生产依赖审计告警为 0；构建链保留已披露的 minimatch 中危告警。
- 跨设备 iCloud、其他系统/输入法及一次未稳定复现的候选选择观察，继续按 [更新说明](release-1.6.0.md) 和 [验收记录](acceptance-1.6.0.md) 保留边界。
