# Bike MyGO 2.0.0 候选说明

更新于 2026-11-11，时区为 Asia/Shanghai。已归档制品为 macOS arm64 本地 preview build 13，制品与摘要见 [候选证据](validation-mygo-2.0.0.md)，验证范围见 [验收记录](acceptance-mygo-2.0.0.md)。当前源码修复尚需同源构建和验证，展开大纲性能、自动化回归、远端 CI 与严格包校验继续保持发布阻断。

用户已在 2026-11-11 授权处理其余缺陷后执行发布流程，后续沿用该授权。持续发布路线为 ad-hoc 签名与手动 DMG 安装。人工真机测试由用户亲自完成，并作为非阻断待办保留实际状态。

## 产品与安装

Bike MyGO 使用 Go 桌面服务、WKWebView 和共享 React 前端。产品版本为 2.0.0，preview 名称为 Bike MyGO Preview，bundle 为 `com.bike.mygo.preview`，正式身份为 `com.bike.mygo`。应用数据、备份、Live MCP discovery 和更新渠道按产品及通道隔离。

后续持续采用 arm64、ad-hoc 签名和手动 DMG 安装。包内含前端、中文字体、Go 服务和许可，实际运行使用系统 WebKit。严格安装包检查覆盖 DMG 挂载、复制 app、tar 解压、完整包指纹、Mach-O、实际 ad-hoc 签名、依赖及系统 PATH 下的 CLI，并继续作为发布门禁。

编译器固定为 Go 1.26.10，并启用 `GOEXPERIMENT=jsonv2`。MyGO v0.8.3 使用已校验源码，维护补丁只调整 go.mod 工具链声明。当前 Mach-O 和 plist 均声明 macOS 12.0，物理 macOS 12/13 的运行验收交由用户，继续记录为非阻断待办。

## 功能与迁移

四视图、主题、知识操作、差异提案、版本历史、附件和原有数据协议沿用共享实现。Go 接通 36 项桌面桥、原件库、分块附件、ZIP、独立备份、网络代理、同步及手动更新查询。

PDF 包含代码语言、多行代码和完成状态 `[x]`。字体缺少字形的字符显示为可读 Unicode 标记，例如 `[U+1F642]`。原生任务按钮保持 22×28 并与主题文字同排。

普通 JSON/ZIP 导入按原有格式交换正文与附件。完整本机副本另保留回收站、版本历史、恢复副本和来源审计，并创建新 actor、空活动 outbox，初始关闭同步与自动备份。偏好和 AI 密钥分别选择。

源导出入口使用已经安装的 Electron Bike 2.0.0 读取关闭 profile 的隔离副本。用户先保存并退出原 app，然后明确指定真实 app/profile 路径。操作和范围见 [实施记录](implementation-mygo-2.0.0.md#完整本机副本与源导出)。源目录锁、打开句柄、并发启动、前后指纹、原件摘要和原子 ZIP 安装有独立检查。

Go MCP 由包内同一可执行文件提供。File 默认为只读，v1/v2 真实写入需显式授权和 revision，v3 的真实写入使用 Live 批准。File 提供 14 个工具，Live 提供 15 个工具，另有资源、模板、5 个 prompt 和补全。

## 更新方式

MyGO 仅选择 `mygo-v` 发布链，候选清单记录 `installation=manual`、`automaticReplacement=false`。应用检查新版本后打开受信发布页，用户取得新 DMG 并手动安装。候选中的 `update-darwin-arm64.json` 用于本地完整性核对，`updaterConsumed=false`。

按用户确认，本次交付使用独立渠道查询、受信发布页与手动 DMG 安装。自动下载、进度、稍后自动安装、保存后自动替换、更新包签名链、断点下载及安装故障状态机不纳入本次交付。持续采用 ad-hoc 签名，Apple Developer ID 签名与公证不作为该路线的前置条件。Gatekeeper 和手动安装的人工体验由用户验收并保留非阻断待办。

## 性能与验证边界

独立主题编辑按用户要求固定为 50 次。样本包括 100 文档/20,000 主题、单文档 20,000 主题、折叠/展开大纲与脑图，以及单独的大提案和 128 MiB 附件峰值。旧失败、诊断与修复后复测分别保留，入口见 [性能证据](validation-mygo-2.0.0.md)。

build 13 的展开大纲局部诊断完成 3 次保存与同事务回读，耗时为 10.80 / 10.26 / 3.70 秒，长尾仍在。该补丁尚未证明性能改善，MG11 保留阻断，正式 50 次对照尚未完成。携图 ZIP 的真实面板成功证据来自 build 11，build 13 的面板交互超时单独保留并交由用户非阻断复验，本地归档代码与文件检查继续执行。

macOS 12/13、第二台物理 Mac、真实中文输入法、Finder/系统剪贴板/物理拖放、iCloud、真实 AI provider、Gatekeeper 及其他人工交互由用户负责，按 [验收记录](acceptance-mygo-2.0.0.md) 保留非阻断待办。当前源码重新打包、自动化回归、远端 CI、包校验与其余缺陷处置继续按发布门禁完成。缺陷与处理见 [缺陷记录](defects-mygo-2.0.0.md)，已授权的发布流程和发布后检查见 [发布验证](publish-verification-mygo-2.0.0.md)。
