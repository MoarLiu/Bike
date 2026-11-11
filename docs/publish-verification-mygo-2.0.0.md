# Bike MyGO 2.0.0 发布验证

发布于 2026-11-11 17:50，时区为 Asia/Shanghai，`published=true`。用户授权的源码提交、推送、标签、公开 Release 与资产上传均已执行。

## 正式身份与制品

| 核对项 | 结果 |
| --- | --- |
| Release | [Bike MyGO 2.0.0](https://github.com/MoarLiu/Bike/releases/tag/mygo-v2.0.0) |
| 版本与标签 | 2.0.0 / mygo-v2.0.0 |
| build / 通道 / 架构 | 15 / stable / darwin arm64 |
| Bundle / profile | com.bike.mygo / Bike-MyGO |
| 标签与包内源码提交 | `8d7cc9b69d425a454b8a8c18f2aeb013a3b4961b` |
| 源码指纹 | `6796e5c22a6672b34bc0166af4cffd8453ef90ee158bfafc399d6153a0b9145c` |
| 前端 SHA-256 | `6090fc39aa57e8b27d897831488980ebeaaec99b1f2ed4f33070088bd3bb5af7` |
| 包内二进制 SHA-256 | `95569bc401c1c2744948e208b5bf133e5e813975e301e2be24a4a7c3ed52d7f6` |
| 签名与安装 | ad-hoc，未公证，手动 DMG |
| 系统声明 | Mach-O minos 与 Info.plist 均为 12.0 |

本地原始构建清单保留 local-candidate 状态。发布暂存目录将独立完整性清单提升为 `purpose=release-integrity-inventory`、`published=true`，重新生成其 SHA256SUMS。app、DMG 与 tar 的字节保持已验证摘要。发布清单为手动安装资产的完整性记录，`updaterConsumed=false`。

## 公开资产与重新下载

| 文件 | 字节 | SHA-256 |
| --- | --- | --- |
| bike-mygo-2.0.0-arm64.dmg | 10277308 | `97c581a173beb96760a83905577ccbdf7dfc787f5766a035b84e640e4ee99ebe` |
| bike-mygo-2.0.0-arm64.dmg.sha256 | 92 | `ba22c975b99b7a677fd630d551c9fc347ddd113bedc2f8c9d55476964e8a8235` |
| bike-mygo-2.0.0-darwin-arm64.tar.gz | 9211178 | `01d4d7ff31ac73f98c624c7eaa6caad54892b434b2a7f6072484cd4c95a66341` |
| SHA256SUMS | 285 | `79a72fbeb36b1d6d559c7a1e45594a6ad985fd06189a898dd624042498bdd647` |
| update-darwin-arm64.json | 1459 | `701fc2e6fde6b37a29eda7a3a934aa4419f1d5983a89e68d8d5aeea7dca033ea` |

五项资产均已通过匿名公开地址重新下载，与本地发布暂存文件逐字节摘要一致。DMG 独立 .sha256 与 SHA256SUMS 一致，DMG/tar 与清单中的长度及摘要一致。

## 已完成的发布门禁

- [x] 最终源码与隔离构建工作区 clean，正式 app/probe 源码及前端一致。
- [x] 最终 50 次展开大纲测量的前端摘要与正式包一致，双宿主均逐次完成持久化回读，p95 门槛通过。
- [x] 原生运行、Node-free PATH、桥接、持久化与 Live MCP 检查通过。
- [x] DMG 只读挂载、复制安装、tar 解压、包内容指纹、arm64/minos、ad-hoc 完整性和许可检查通过。
- [x] 复制安装后的启动早退与常规退出自然结束，状态为 0，约 171 ms / 173 ms。
- [x] [MyGO CI](https://github.com/MoarLiu/Bike/actions/runs/42997776945) 与 [既有 CI](https://github.com/MoarLiu/Bike/actions/runs/42997777069) 在最终源码提交上通过。
- [x] 独立标签指向包内源码提交，Release 为公开、非草稿、非预发布。
- [x] 显式 `Latest=false`，仓库 Latest 解析为 `v2.0.0`。
- [x] 上传五项明确允许的资产，并完成公开重新下载及摘要检查。

展开大纲极限样本仍有两次约 6–7 秒的极值。当前与历史性能口径、RSS 和物理占用差异见 [验证摘要](validation-mygo-2.0.0.md)。

## 发布后渠道检查

- 原 Electron 生产更新检查函数实际查询公开接口，得到 `v2.0.0`，当前 2.0.0 返回无新版本。该函数与原 v2.0.0 源码相同。
- Go 生产 `CheckMyGoUpdate` 实际查询公开发布历史，得到独立 `mygo-v2.0.0` 发布页，当前 2.0.0 返回无新版本并标记 manual。
- Web/Sync 安装器原始解析、下载和 SHA-256 校验函数实际选择 `v2.0.0`，部署归档下载与摘要核验通过。该检查覆盖安装器的发布选择和下载阶段。

## 用户人工验收的非阻断待办

- [ ] macOS 12/13 与第二台物理 Mac。
- [ ] 真实中文 IME、Finder、系统剪贴板、物理拖放、iCloud、真实 AI provider 和外部 MCP 客户端。
- [ ] Gatekeeper 提示、手动安装、窗口移动/缩放与 Dock 重开。
- [ ] 当前构建携图 ZIP 的原生保存面板。build 11 成功证据与 build 13 焦点竞争超时分别保留。

持续 ad-hoc 签名与上述用户人工验收按 2026-11-11 指令列为非阻断条件，状态继续按实际证据记录。
