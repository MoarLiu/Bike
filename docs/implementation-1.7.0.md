# Bike 1.7.0 实施记录

更新日期 2026-11-09（Asia/Shanghai）

发布版本为 `1.7.0`，分支为 `codex/development-1.7.0`，起点为包含 1.6.1 发布的 `34ae115`。用户于 2026-11-09 确认沿用 ad-hoc 签名发布，正式签名公证和原生自动更新的签名验收后续完成。最终提交、远端 CI 与下载校验见 [发布验证](publish-verification-1.7.0.md)。

## 当前实现

| 工作包 | 实现与当前验证 |
| --- | --- |
| A01 数据契约 | `shared/bike-attachments.mjs` 及类型声明统一校验 SHA-256、文件大小、图片尺寸、引用与清单。纯文本保留工作区 v1，首次引入附件升级 v2，IndexedDB 同一事务保留升级前副本。附件 Markdown 元数据使用 v2，纯文本沿用 v1 |
| A02 附件库 | `<userData>/attachments/<摘要前两位>/<摘要>` 保存原始字节，文件选择走流式临时文件、哈希、fsync 与原子安装。并发相同内容去重，读取校验原始字节，拒绝符号链接和越界 id。启动清理超过一天的遗留导入临时文件 |
| A03 编辑入口 | 文件选择、粘贴与拖入统一提交，批次可取消，成功项形成一次文档操作。大纲、脑图、Markdown 预览及演示显示图片，详情支持显示名、替代文字、移除、另存和显式系统打开 |
| A04 生命周期 | 扫描当前文档、回收站、持久历史、撤销/重做、剪贴板与备用副本。读取不完整即停止清理。用户确认后隔离，保留 30 天，重新读取时自动恢复，后续清理复核后清除过期对象。当前进程导入或读取过的对象保守保留至下次启动 |
| A05 ZIP | 清单、工作区与引用附件组成完整归档。检查版本、重复条目、特殊文件、字节和条目预算、哈希与引用闭合，校验完成后安装。支持替换及仅补齐附件，可在保留损坏对象副本后修复摘要不符的文件。含附件工作区的破坏性替换先完成完整 ZIP 副本 |
| A06 备份兼容 | iCloud 队列先写齐附件与版本清单，再提交 JSON，附件失败保留上一份完整 JSON。Sync 传输元数据并在事务内拒绝旧客户端覆盖。MCP 精简读取返回附件身份，文本改写保留附件 |
| A07 携图导出 | Markdown/HTML ZIP 使用相对附件路径，同时保留可恢复的 `workspace.json`。PDF 内嵌 PNG/JPEG，WebP 经有界转换嵌入，普通文件列出名称。修复当前 Noto 字体子集化的中文缺字 |
| A08 脑图与演示 | SVG 输出独立矢量形状、文字、关系与内嵌图片，PNG 支持主题背景或透明背景并限制像素预算。演示包含顶层主题及子主题图片 |
| A09 格式评估 | 加入手工编写的 OPML/Markdown 交换样本，浏览器验证层级、备注、任务、URL 与 Unicode。XMind 完成下文评估，真实幕布导出样本仍待取得 |
| A10 分发准备 | 正式签名脚本、JIT entitlement 与受保护 CI 工作流已准备。检查更新接入应用内下载、进度和保存后重启安装，构建增加 ZIP 与更新清单。arm64 和 x64 目录制品可构建，x64 运行环境为 Apple Silicon 上的 Rosetta |
| A11 验收 | 362 项模块测试、共享契约、构建、MCP smoke、浏览器回归与打包 Electron 附件/更新流程已有本机结果，具体环境和边界见下文 |

## 已采用的格式与存储规则

- 附件 schema 为 version 1，引用的显示名和替代文字属于使用位置，原始文件按摘要共享。节点复制、跨文档粘贴和合并保留对应元数据。
- UI 与 MCP 可读取工作区 v1/v2。标记为 v1 却携带新附件字段的文件进入受保护路径，避免旧客户端继续写入。第一次正常附件编辑、单文档导入或 Sync 下载会把本机工作区提升到 v2。
- 含附件的带元数据 Markdown 使用 `bike:document:v2`，旧客户端会报告未知格式。工作区 v1 兼容副本可通过升级前备份取得，后续附件通过完整 ZIP 保留。
- 归档包括正常文档、回收站及其引用附件。本机历史、撤销栈、导航偏好和服务凭据属于本机状态。导出在固定文档快照上进行，缺少原始文件时停止完整导出。
- 附件二进制自动同步继续按路线图安排在 2.0.0。第二设备只取得引用时显示缺失状态，通过“补齐附件”载入 ZIP。Sync Server 先升级再同步附件文档。
- 单文件上限 128 MiB，内联图片上限 32 MiB / 4,000 万像素，批次上限 100 文件 / 512 MiB。ZIP 压缩包上限 512 MiB、展开上限 1 GiB / 10,000 条目。PNG 最多 3,200 万像素，单边最多 16,384 像素。
- 图片解码在主进程排队执行，缩略图最长边 512 px。PDF 每次导出的图片累计解码预算为 1.6 亿像素，SVG 嵌入图片原始大小累计上限为 128 MiB。
- 隔离恢复和清理使用同一附件库边界。云端备份附件采取保守保留，云端对象清理需要独立验证保留版本和外部写入范围。

## 本机验收

| 项目 | 结果与证据范围 |
| --- | --- |
| 模块测试 | Node 26.13.0、22.13.0、22.22.2 均为 362/362，覆盖数据迁移、附件生命周期、ZIP 安全、Sync/MCP 保真、Markdown 身份，以及更新状态机、对话框、可信回执和保存保护 |
| 工程检查 | `npm run check` 通过，包括 23 项共享 API 返回字段契约、TypeScript、生产构建、MCP smoke 和差异空白检查 |
| 浏览器 | 原有聚焦拖拽、搜索定位后撤销、格式往返、同步调度与焦点保持通过。手工交换样本通过，浏览器无 pageerror |
| arm64 打包应用 | Electron 42.11.18 / 内置 Node 24.19.0，最终 DMG 的 13 项附件流程与 7 项基础流程通过，包含转义文件名、首次 Markdown 编辑、损坏对象修复、四视图、ZIP、重启和空白数据目录恢复。架构为 arm64，Rosetta 状态为 false |
| 导出实物 | 检查 SVG 内嵌图片且 XML 有效，PNG 可解码，PDF 包含图片 XObject，携图 Markdown/HTML 的相对路径和原始附件字节一致。PDF 和脑图输出已渲染查看 |
| 文件入口取证 | 文件选择器使用可控的原生 dialog 返回值。粘贴和拖入使用真实 DataTransfer/File 经合成 DOM 事件进入正常编辑处理器，尚需系统剪贴板与 Finder 手动拖入验收 |
| 清理入口 | 打包应用启动后扫描完整本机历史与恢复根，将上一会话孤立文件隔离，活跃图片继续可读。模块验证新增引用复核、恢复隔离对象及 30 天到期复核 |
| x64 评估 | x86_64 可执行文件和 x64 Electron 构建成功，Rosetta 上通过附件与恢复流程。原生 Intel 机器与 Universal 组合制品尚待验证 |
| 签名检查 | 当前本地应用为 ad-hoc。开发机可用 Developer ID Application 身份数量为 0，正式签名、公证和带隔离属性的首次安装尚未验证 |

原始附件证据和截图由 `npm run test:attachments-runtime` 写入 `output/playwright/attachments-1.7.0/`，按 `results-packaged-arm64.json` 与 `results-packaged-x64.json` 区分制品。该目录被 Git 忽略。性能结果为同目录的 `performance.json`。

本次发布制品为 `release/Bike-1.7.0-arm64.dmg` 和同版本 `.zip`，配套 `.sha256` 保存最终摘要。只读挂载 DMG 后执行附件、基础与更新流程检查，核对包内 Electron、共享模块、MCP 与前端构建文件和当前源文件一致。`candidate-manifest.json` 记录制品摘要与对应开发分支，制品使用 ad-hoc 签名。

alpha.2 的完整审查、四项问题修复和发布门禁见 [审查记录](review-1.7.0.md)。损坏对象修复会在附件库根目录保留 `.corrupt-<摘要>-<随机标识>.bak`，常规附件清理保守保留这些副本。

alpha.3 新增应用内更新。真实 `electron-updater` 实例配合受控检查、下载和退出方法，通过 7 项打包流程验证，覆盖正常入口、进度、草稿保存、编辑暂停、签名失败解锁和重试。更新制品、正式签名与跨版本验收条件见 [应用内更新](updates.md)。

性能复用 1.6.1 固定样本。Apple M4 的 arm64 打包应用中，100 文档 / 20,000 主题搜索的 p95 为浅色约 327 ms、暗色约 251 ms，包含 180 ms 防抖和首批绘制。对应 1.6.1 结果约 278 ms / 244 ms。本次浅色测量约增加 17%，仍在本计划 20% 复核阈值内，结果仅适用于记录中的机器与样本。

单篇 20,000 主题、子主题折叠时，200 次独立编辑后的 GC heap 约 47.3 MiB，编辑 p95 约 206 ms。未将这些数字外推到大量图片同时展开、所有主题展开或其他机器。

## 外部格式与架构评估

手工 OPML/Markdown 样本保存在 `tests/fixtures/outline-interop.*`，用于覆盖格式交换的基本语义。这些样本由本项目编写，真实幕布导出兼容性仍需按具体软件版本建立来源、原文件、期望结构和损失记录。

XMind 官方旧 SDK 的 loader 从归档提取 `content.xml`，加载失败还可能回退为空工作簿。因此接入时需要先辨识文件族，严格校验清单并报告损失，避免把解析失败当成空文件导入。官方 generator 是另一个可评估入口。当前阶段保留独立设计决策，实际 XMind 导入后续另开工作包，至少覆盖多 sheet、关系、富文本备注、附件、结构标记和不支持字段的提示。来源为 [官方 SDK loader](https://github.com/xmindltd/xmind-sdk-python/blob/master/xmind/core/loader.py) 和 [官方 generator](https://github.com/xmindltd/xmind-generator)。

arm64 与 x64 目录包约为 544 MiB 与 569 MiB。当前默认分发保留 arm64，x64 已具备候选构建路径。建议取得 Intel 机器实测后再增加独立 x64 制品，Universal 还需要验证双架构合并、依赖与制品体积。

### macOS 28 兼容性提醒核查

2026-11-09 在 macOS 27.0.1 / Apple Silicon 上收到“需要更新 App，包含的一个组件无法在下个主要版本 macOS 28 中打开”的系统通知。Apple Support 于 2026-09-21 更新的[说明](https://support.apple.com/en-us/102527)将此提醒关联到 Intel 应用或组件，以及 macOS 28 的 Rosetta 支持范围变化。

- 已安装的 1.6.1 与最终 1.7.0-alpha.1 ARM DMG 中，各自 15 个 Mach-O 可执行文件和动态库均包含 arm64，覆盖主程序、Electron、Helper、Crashpad、Squirrel 与其依赖。两者的 `app.asar` 均未发现 `.node`、`.dylib` 等原生模块。
- 此前 21:37 至 21:38 的 x64 候选验收实际通过 Rosetta 运行，是本次通知最可能的触发源。现有系统日志无法将该通知直接关联到具体进程，保留此取证限制。
- 最终 ARM DMG 摘要与原候选一致。只读挂载后重新执行附件运行时验收，11 项检查通过，错误列表为空，实际架构为 `arm64`，`app.runningUnderARM64Translation` 为 `false`。
- `verify-attachments.mjs` 与 `verify-runtime.mjs` 的运行时记录增加实际架构和 Rosetta 状态。完整架构清单与本轮结果保存在被 Git 忽略的 `output/playwright/attachments-1.7.0/macos-compatibility.json`。

本机后续回归使用 ARM 候选，Intel 兼容性继续等待 Intel 实机验收。本轮结果覆盖当前 macOS 27.0.1，macOS 28 的实际运行和该通知是否再次出现仍需对应环境验证。

## 正式签名路径

`npm run electron:dist:signed` 先执行工程检查，随后要求 `CSC_NAME` 指向完整的 Developer ID Application 身份，并要求 `APPLE_KEYCHAIN_PROFILE` 对应已保存的 notarytool 凭据。可选 `CSC_LINK` / `CSC_KEY_PASSWORD` 供临时证书导入使用。证书名称在传给锁定的 electron-builder 26.18.0 前去除它要求省略的类型前缀。

正式路径启用 Hardened Runtime、JIT entitlement 和强制签名，跳过开发包的 ad-hoc 钩子，执行应用公证、stapling 与 Gatekeeper 检查，再公证和 staple DMG。最后按最终 DMG 重建 blockmap、`latest-mac.yml` 与 SHA-256，防止公证后摘要过期。

`.github/workflows/macos-signed.yml` 通过手动触发和 `macos-release` 环境运行，需要配置证书、公证 API key 等仓库 secret。普通 PR 的 CI 执行无需这些凭据的检查。此工作流尚未远端执行，签名脚本已完成本地语法与锁定版本 API 核对。当前在线文档已包含 v27 配置变化，实现按仓库锁定版本的类型和代码确认参数。参考 [electron-builder macOS 文档](https://www.electron.build/docs/mac)。

## 后续验收

- 有效 Developer ID 证书与公证凭据到位后，跑通正式链路，并从实际下载位置取得带隔离属性的制品，在干净用户环境验收首次安装和升级。
- 本次发布完成同一候选提交的 Linux/macOS 远端 CI、独立部署包干净安装和升级，以及 DMG 下载校验，结果见发布验证。
- 真实系统剪贴板、Finder 文件拖入、中文输入法、多图/大图压力、完整浅暗/窗口/缩放矩阵。
- 两台真实设备的 iCloud 附件传输与外部 MCP 文件写回组合。当前完整性检查和备份失败保护已有本机代码与回归结果。
- 真实幕布导出样本、Intel 实机和 Universal 评估的环境证据。

用户确认的本次分发范围为 arm64 ad-hoc 制品。其余实机、签名公证和自动替换验证保留为后续工作，实际发布状态与远端结果以发布验证为准。
