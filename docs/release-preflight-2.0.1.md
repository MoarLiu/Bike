# Bike 2.0.1 发布前检查

检查日期为 2026-11-13。源码分支为 `codex/fix-2.0.1`，基线为 `575331fedbb2df743c25520283ba3037cc956952`。目标为 Electron / Web / Sync 的 `v2.0.1` 和独立 MyGO 的 `mygo-v2.0.1`，标题分别为 Bike 2.0.1 与 Bike MyGO 2.0.1。

## 本地检查

- 完整共享检查通过 560 项模块测试、30 项返回契约、TypeScript/Vite 构建、MCP smoke 与差异检查。Go 1.26.10 internal 测试、race、命令编译和桥接差分通过。
- 实际 Electron 包通过双进程同步、附件、冲突、AI 提案、Live MCP 与受控更新回归。5,932 个有效旧排序状态的新旧操作交错通过。
- WKWebView preview 通过四视图、持久化、UTF-16 备份、原生网络/Live、取消关闭及原生导出。20,000 主题布局的 4 次编辑重启后回读成功。
- Electron 最终 DMG 与 ZIP 通过严格 ad-hoc 验签、只读挂载/解压、51 份包内运行时文件比对、4 份字体与许可、更新清单及重新计算的 blockmap 核对。
- Web/Sync/MCP 归档包含 73 份允许文件，Node 22.13.0 的 12 项干净安装与覆盖升级检查通过。包含正文与附件保留、能力协商、旧端 HTTP 426、原附件传输及配置/数据库 0600 权限。
- 另用 2.0.0 实际部署归档创建并启用旧节点同步空间，再覆盖安装 2.0.1。旧空间身份、正文与附件保持，重新安装生产依赖后的 MCP smoke 与全部 12 项检查通过。
- `npm audit --omit=dev` 返回 0 个漏洞。
- 提交清单的凭据模式匹配均为测试夹具、变量读取或禁止路径的通配符。包内 1,742 份文本文件检查未发现个人路径、账户或应用状态。JOSE 的私钥头部匹配是 PKCS#8 格式检查，不含密钥正文。

## 提交范围与本地保留

提交范围包括本轮操作/同步、前端状态、Electron、MyGO、MCP、安装器与服务端修复，相关测试、字体许可、签名/CI 配套和发布说明。按明确文件清单提交。

原有 `docs/review-2026-11-08.md` 与 `docs/review-mygo-2.0.0.md` 保留为本地评审笔记。工作目录、原始审查报告、运行日志和制品输出不纳入源码提交。具体允许文件及内容摘要保存在忽略目录 `release/2.0.1/verification/commit-allowlist.json`。

## 制品与渠道

Electron / Web 发布目录为 `release/2.0.1/`，计划上传 9 个附件。DMG 和 ZIP 各带 `.sha256` 与 `.blockmap`，另含 Web/Sync 部署包、`latest-mac.yml` 与总摘要清单。

| 已验证制品 | SHA-256 |
| --- | --- |
| `Bike-2.0.1-arm64.dmg` | `2bab216f981bdd26daee9fbcca524c60700ee511b040fb578d962dc2f7bda198` |
| `Bike-2.0.1-arm64.zip` | `c67b209d8988f01e11915254d72cbf739c8c099beef68250dc00c4d0cdc6fb6d` |

Web 归档与更新元数据以 `SHA256SUMS-2.0.1.txt` 为准。两份发布说明分别见 [Bike](release-2.0.1.md) 和 [MyGO](release-mygo-2.0.1.md)。

MyGO 正式制品计划为 stable build 16。稳定构建要求干净且已提交的源码，因此在确认提交后从干净发布工作区构建，随后检查签名、源码指纹、版本、只读 DMG、复制安装、tar 解压及实际 MCP。此前通过验收的 preview 包继续保留在本地。

MyGO 计划上传正式 DMG、DMG `.sha256`、tar.gz、`update-darwin-arm64.json` 和 `SHA256SUMS`。两个标签指向相同修复提交。Electron 发布设为仓库 Latest，MyGO 保持独立正式渠道且不接管 Latest。

## 待确认操作

当前未执行源码 commit、tag、push 或 GitHub Release 创建/上传。

确认后按以下顺序执行。任一门禁失败均先修复并复验，再推进公开发布。

1. 按允许清单提交本轮修复与发布文档，推送候选分支并等待 Node / macOS / Linux 和 MyGO 远端 CI。
2. 从该提交建立干净发布工作区，生成并验证 MyGO 2.0.1 stable build 16，生成正式附件摘要与完整性清单。
3. 复核远端 main 没有新增分叉后快进，创建并推送 `v2.0.1` 和 `mygo-v2.0.1`。
4. 创建两个 Release 草稿，按各自清单上传附件、下载核对，再公开发布并检查 Latest 归属。
5. 重新下载公开附件，核对长度与 SHA-256，检查源码、标签、发布说明、CI 和公开可见性，并追加发布验证记录。

## 保留边界

本次沿用 arm64、ad-hoc 签名与手动 DMG。未宣称 Developer ID、公证或签名自动替换通过。真实输入法、其他 macOS、第二台物理设备、iCloud 与真实 provider 的人工验收范围见修复记录。

未连接或修改用户的生产 Sync Server。服务端升级须先备份并关闭旧客户端，再按发布说明统一更新。
