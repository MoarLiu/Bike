# Bike 2.0.1 发布验证

2026-11-13 已按用户“确认发布”授权完成两个独立正式渠道的发布。两个标签均指向源码 `7bf6985ae5dd82ae0f0c7b57b81681a1e58b8fd0`。主要修复提交为 `1a9f5f7515a345c2fd6af77997e4f96a91eca0fd`，随后追加 CI 浅克隆修复。

## 公开发布

| 渠道 | 标签 | 制品 | 公开时间（Asia/Shanghai） |
| --- | --- | --- | --- |
| [Bike 2.0.1](https://github.com/MoarLiu/Bike/releases/tag/v2.0.1) | `v2.0.1` | Electron arm64、Web / Sync / Node MCP | 2026-11-13 14:19:20 |
| [Bike MyGO 2.0.1](https://github.com/MoarLiu/Bike/releases/tag/mygo-v2.0.1) | `mygo-v2.0.1` | arm64 stable build 16 | 2026-11-13 14:19:28 |

两个 Release 均为公开、非草稿、非预发布。仓库 Latest 为 Electron `v2.0.1`，MyGO 保持独立 `mygo-v` 渠道。main 已快进到发布源码，随后仅追加本文及发布状态文档。

## 验证

- 完整共享检查通过 560 项模块测试、30 项返回契约、TypeScript/Vite 构建与 MCP smoke。Go internal、race、命令编译、桥接和跨实现检查通过。
- 候选分支、main 与两个标签的六组 CI 共 14 项作业全部通过。两个发布事件的渠道隔离检查也通过。
- MyGO stable 从干净发布工作区构建，manifest 的 dirty=false，内嵌提交、版本与 build 16 一致。构建输入指纹与已验收 preview 相同，均为 `e1a902f2b7e61949adc3e692c6a142d51ef4afd2c892cfdbb0f9e9678360d946`。
- MyGO 正式包通过严格 ad-hoc 签名、源码/二进制与包内容指纹、最低系统声明、第三方许可、只读 DMG、复制安装、tar 解压与 Node-free CLI。最终源码另通过 WKWebView 原生运行和 File / Live MCP 回归。
- Electron 包通过 51 份运行时源码/构建文件、4 份字体及许可、严格签名、只读 DMG/ZIP 内容、更新清单长度/SHA-512 和重算 blockmap 核对。
- 两个草稿共 14 个附件先核对 GitHub 服务端摘要，再逐一下载核对长度及 SHA-256 后公开。公开后再次以不带认证信息的请求下载全部 14 个附件，长度与 SHA-256 均与最终本地制品一致。
- 从公开下载的两个 DMG 只读挂载并严格验签。公开 Electron App 的双进程同步、附件、冲突、AI 提案、Live MCP 及草稿回归通过；公开 MyGO App 的真实 Go MCP 回归及版本/提交/二进制摘要核对通过。
- 公开 Web/Sync 归档在 Node 22.13.0 下，从实际 2.0.0 部署归档创建的旧节点同步空间覆盖升级，12 项检查通过，保留旧空间身份、正文及附件，并验证新能力、旧端 HTTP 426 和私有文件权限。
- 生产依赖审计为 0 个漏洞。源码与包内隐私检查没有未解决项，原有本地评审笔记和生成证据未进入源码提交或发布附件。

首次 CI 因 checkout 默认深度为 1，把提交当成根提交检查了历史空白。未修改原有应用代码或上游许可来规避检查，将 checkout 深度调整为 2，经隔离克隆复现验证，并在最终源码上重跑全部检查。

## 远端 CI

| 位置 | 工作流 | 作业数 | 结果 |
| --- | --- | --- | --- |
| `codex/fix-2.0.1` | [CI](https://github.com/MoarLiu/Bike/actions/runs/43376326383) | 3 | success |
| `codex/fix-2.0.1` | [MyGO](https://github.com/MoarLiu/Bike/actions/runs/43376326302) | 1 | success |
| `main` | [CI](https://github.com/MoarLiu/Bike/actions/runs/43377171918) | 3 | success |
| `main` | [MyGO](https://github.com/MoarLiu/Bike/actions/runs/43377171939) | 1 | success |
| `v2.0.1` | [CI](https://github.com/MoarLiu/Bike/actions/runs/43377172018) | 3 | success |
| `mygo-v2.0.1` | [CI](https://github.com/MoarLiu/Bike/actions/runs/43377171844) | 3 | success |

渠道隔离通过 [Electron 发布事件](https://github.com/MoarLiu/Bike/actions/runs/43377883334) 和 [MyGO 发布事件](https://github.com/MoarLiu/Bike/actions/runs/43377899411)。

## 最终制品 SHA-256

| 制品 | SHA-256 |
| --- | --- |
| `Bike-2.0.1-arm64.dmg` | `2bab216f981bdd26daee9fbcca524c60700ee511b040fb578d962dc2f7bda198` |
| `Bike-2.0.1-arm64.zip` | `c67b209d8988f01e11915254d72cbf739c8c099beef68250dc00c4d0cdc6fb6d` |
| `Bike-Web-2.0.1-sync-server.tar.gz` | `be7385c73e8a06fd83f942eb216aec0daf1bd8f824b6153b1c83ccd6865e541f` |
| `bike-mygo-2.0.1-arm64.dmg` | `4d143b7eff53eafee23413641ccac8e06571666bb6b6305aed0ee915112c492a` |
| `bike-mygo-2.0.1-darwin-arm64.tar.gz` | `a5e277d4077489c6b8261844f80608ea9fad508232ff8624735b86fb87811d3d` |

Electron / Web 共有 9 个附件，完整摘要见 Release 中的 `SHA256SUMS-2.0.1.txt`。MyGO 共有 5 个附件，完整摘要见其 `SHA256SUMS`。两个 DMG 各带独立 `.sha256` 文件。MyGO 公开完整性清单为 published=true、updaterConsumed=false、automaticReplacement=false，保留原始本地清单作为构建记录。

## 升级与保留边界

先保存并导出完整工作区 ZIP，关闭旧客户端，停止并备份服务端配置、SQLite 及附件，再升级服务端并统一更新客户端至 2.0.1。旧节点客户端会收到 HTTP 426。不要让旧算法解释新操作，回退应在独立环境使用升级前备份。

本次沿用 arm64、ad-hoc 签名和手动 DMG，未经过 Developer ID 签名或公证。真实输入法、其他 macOS、第二台物理设备、iCloud、真实 provider 和外部 MCP 的人工验收边界继续保留。受控测试不替代这些人工检查。未连接或修改用户生产 Sync Server。

原始源码允许清单、构建/运行报告、CI JSON、草稿及公开下载摘要保留在被 Git 忽略的发布证据目录中。该目录与本地评审笔记未上传为 Release 附件。
