# Bike 1.7.0 发布验证

发布范围于 2026-11-09 确认，macOS arm64 继续使用 ad-hoc 签名。版本为 `1.7.0`，目标标签为 `v1.7.0`，Release 标题为 Bike 1.7.0。

## 本地制品与验收

- Node 26.13.0、22.13.0、22.22.2 各通过 362 项模块测试。
- `npm run check` 通过，包含共享契约、TypeScript、生产构建、MCP smoke 与差异检查。浏览器回归的 5 项流程通过。
- 最终 DMG 只读挂载后，13 项附件流程、7 项基础流程与 7 项受控更新流程通过，错误列表均为空。
- 包内 29 个运行时文件与当前源码及前端构建逐项一致。ZIP 中的应用与 DMG 应用一致，15 个原生组件均为 arm64，实际运行未经过 Rosetta。
- ad-hoc 应用通过 `codesign --verify --deep --strict`，DMG 通过完整性校验。更新清单的版本、字节数与 SHA-512 匹配最终 ZIP 和 DMG。
- Web/Sync/MCP 归档的 41 个文件与当前源文件一致。Node 22.13.0 上的 9 项部署检查通过，覆盖干净依赖安装、登录、MCP、旧客户端 HTTP 426 保护、覆盖升级与私有文件权限。
- 生产依赖审计为 0 项漏洞。完整依赖树仍有 6 项 moderate 开发工具链告警。
- 发布提交范围为 72 个文件，源码隐私扫描通过。

| 最终制品 | SHA-256 |
| --- | --- |
| `Bike-1.7.0-arm64.dmg` | `7d0b669f7743a0df16ab95b8daeaefdfdcc5649bedf797d2abd0242a36559cda` |
| `Bike-1.7.0-arm64.zip` | `6a5ea4136d08a5eb0eaa4b64859827302398ab429d47ac553c97d4075ae6ca75` |
| `Bike-Web-1.7.0-sync-server.tar.gz` | `f67ebfa1d5a6e49198025816a97e9064a3e41ed12e425cdcbefa9be1b8fcf6ca` |

`SHA256SUMS-1.7.0.txt` 同时覆盖 DMG、ZIP、两个 blockmap、更新清单与 Web/Sync/MCP 归档。原始验收日志保存在本地 `release/1.7.0/verification/`。

## 远端验证

[Bike 1.7.0](https://github.com/MoarLiu/Bike/releases/tag/v1.7.0) 于 2026-11-09 23:26:40（Asia/Shanghai）公开发布，并设为当前稳定 Release。

发布源码提交为 `3c90ba6dae23a1688859cada674fff3b29c5efa0`，标签 `v1.7.0` 指向该提交。候选分支、main 和标签均执行同一源码提交的 CI。

| 检查入口 | 证据 | 结果 |
| --- | --- | --- |
| 候选分支 | [CI 运行](https://github.com/MoarLiu/Bike/actions/runs/42643596185) | Linux、macOS、Node 22.22.2 三项任务全部通过 |
| main | [CI 运行](https://github.com/MoarLiu/Bike/actions/runs/42644214142) | Linux、macOS、Node 22.22.2 三项任务全部通过 |
| v1.7.0 标签 | [CI 运行](https://github.com/MoarLiu/Bike/actions/runs/42644213778) | Linux、macOS、Node 22.22.2 三项任务全部通过 |

- 九个 Release 资产均可通过无需登录的公开地址下载。全部文件的字节数和 SHA-256 与本地最终制品一致，配套独立摘要及汇总校验文件匹配。
- 重新下载的 DMG 通过完整性与应用严格签名校验。只读挂载后再次通过 13 项附件、7 项基础及 7 项受控更新流程，错误列表为空。实际版本为 1.7.0，运行架构为 arm64，Rosetta 状态为 false。
- 重新下载的 Web/Sync/MCP 归档在 Node 22.13.0 上再次通过 9 项干净安装与覆盖升级检查。
- 资产包含 DMG、ZIP、对应的两个 blockmap 和两个独立 SHA-256 文件、`latest-mac.yml`、Web/Sync/MCP 归档及 `SHA256SUMS-1.7.0.txt`。

本记录在发布后单独提交。发布源码与安装包对应上述标签提交，原始远端 CI、公开下载和运行验证记录保存在本地 `release/1.7.0/verification/`。

## 签名与更新边界

本版采用 ad-hoc 签名，首次安装可能触发 Gatekeeper 提示。应用内检查、下载、进度和安装前保存已接入，macOS 原生自动替换需要兼容签名，本版通过 DMG 手动升级。

真实 Finder 拖入、系统剪贴板、中文输入法、完整窗口/多图矩阵、两设备 iCloud、Intel 实机与原生自动升级保留实机验收边界。
