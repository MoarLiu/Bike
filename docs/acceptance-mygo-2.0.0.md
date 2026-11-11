# Bike MyGO 2.0.0 验收记录

更新于 2026-11-11。stable build 15 已发布为 [mygo-v2.0.0](https://github.com/MoarLiu/Bike/releases/tag/mygo-v2.0.0)，当前交付范围的发布门禁已完成。开发范围见 [开发计划](development-mygo-2.0.0.md)，结构与使用方式见 [实施记录](implementation-mygo-2.0.0.md)。

用户在 2026-11-11 确认后续持续采用 ad-hoc 签名和手动 DMG 安装，并亲自完成人工真机验收。macOS 12/13、第二台物理 Mac、真实 IME、Finder/系统剪贴板/物理拖放、iCloud、真实 AI provider、Gatekeeper 和原生保存面板交互均列为用户负责的非阻断待办。缺失证据继续标为待验，已有失败保留原始记录。

用户已在同日授权其余缺陷处理后执行发布流程，后续沿用该授权。自动下载与替换不纳入本次交付，更新按独立渠道查询、受信发布页和手动安装的最低交付方式验收。

正式 build 15 包含 review 修复、启动关闭握手和大纲性能处理。执行策略按改动影响复用历史结果，并保留实际构建归属。展开大纲同源双宿主各 50 次保存与回读完成，MyGO p95 为 1,701 ms，对照为 3,576 ms。旧 build 12/13/14 的失败与诊断结果保留。

2026-11-11 review 的五项问题已包含在正式源码，定向回归、最终远端 CI、同源制品及原生运行检查通过。未受影响的完整副本七阶段、多格式与跨宿主 UI 结果继续注明 build 11/12/13 的复用来源，见 [缺陷记录](defects-mygo-2.0.0.md#review-修复验证)。

## 环境与候选

| 项目 | 当前证据 |
| --- | --- |
| 本机 | macOS 27.0.1 / 26A434，arm64 |
| 工具链 | Go 1.26.10，GOEXPERIMENT=jsonv2，CGO_ENABLED=0 构建，race 使用 CGO_ENABLED=1 |
| MyGO | v0.8.3，校验源码后的单一 go.mod 声明补丁 |
| 版本与身份 | 2.0.0，stable build 15，com.bike.mygo |
| 系统声明 | 当前 Mach-O minos 与 plist 均为 12.0 |
| 签名与安装 | 持续采用 ad-hoc、手动 DMG 安装，实际 codesign 与包完整性校验保持门禁 |
| 源码 | codex/mygo-2.0.0，`8d7cc9b69d425a454b8a8c18f2aeb013a3b4961b`，最终构建工作区 clean |
| 当前制品 | stable build 15，同源 app、probe、DMG、tar，源码指纹 `6796e5c22a6672b34bc0166af4cffd8453ef90ee158bfafc399d6153a0b9145c` |
| 前端指纹 | `6090fc39aa57e8b27d897831488980ebeaaec99b1f2ed4f33070088bd3bb5af7`，与最终 50 次测量一致 |

11 月 10 日 Go 1.27.3 / minos 13.0 的阻断发现保留在 [历史 M0 证据](validation-mygo-2.0.0.md)。当前工具链组合已解决声明与产物目标冲突，macOS 12/13 的实机能力继续单独验收。

## 已取得的结果

| 检查 | 结果 | 覆盖范围 |
| --- | --- | --- |
| 共享 npm check | 最终源码远端通过 | 共享测试、返回契约、TypeScript/Vite、Node MCP smoke、Electron/Web 运行时及 Node 兼容检查 |
| 桌面桥契约 | 通过 | Electron preload、TypeScript 与 MyGO 适配器的 36 成员一致，保留订阅/退订、取消与回执 |
| Go 基础/race/vet | 通过 | 全 internal 单测与 vet，MCP/contracts/product/services/sourceexport 的 race，含 CAS/锁、回收隔离、并发传输及故障保护 |
| 固定写入差分 | 通过 | 95 组 JS/Go 用例，77 成功与 18 预期错误，全部八种写操作、原字节 revision、next JSON/hash、Unicode、可选字段和引用改绑 |
| 实际 File MCP | 通过 | 14 工具、v1/v2 受控真实写入、readonly、v3 写入拒绝、备份字节和旧 revision 拒绝 |
| 实际 Live MCP | 通过协议互通 | 15 工具、原 protocol-2 socket、候选/client 摘要、待批状态、回执查询、重复请求、改载荷拒绝与撤权 |
| MCP 资源与 prompt | 通过 | 静态/动态资源、3 个模板、5 个 prompt、文档 ID 补全，schema 与返回内容对照 Node |
| 无 Node MCP | 通过 | 包内/Go CLI 使用 PATH=/usr/bin:/bin，确认该 PATH 无 Node，未启动 WebKit/Electron |
| 生产 WKWebView | 通过 | 生产 mygo://localhost、安全上下文、显式生产标志、仅本源连接 CSP，MYGO_ENV=development 也保持生产模式 |
| 四视图与持久化 | 通过固定语料 | 大纲/脑图/演示/Markdown 截图，React DOM 编辑、IndexedDB、进程重启读回和真实 Markdown 下载 |
| 原生格式与主题矩阵 | build 13 通过 | 16 张视图截图、4 张菜单截图、14 个真实下载，浅暗主题×双尺寸×四视图，八类格式、中文 PDF/代码/表格/关系/图像及内联任务状态 |
| 原生携图 ZIP 保存 | build 11 历史证据通过，build 13 由用户非阻断复验 | HTML/元数据 MD 的 ZIP 经真实保存面板确认原件字节、摘要与相对路径。build 13 携图 HTML 面板在焦点竞争期间超时，未生成 ZIP，原始日志保留。本地归档代码与文件检查继续按影响范围执行 |
| 原生桥运行 | 通过 11 项固定检查 | 附件保护、退订、备份往返与 Unicode、保存 Unicode、AI 代理/取消、Sync 代理、Live snapshot/Unicode、组合输入关闭屏障 |
| Go/JS 普通 ZIP | 通过 | v1/v2/v3 双向、回收站、可读正文、空/PDF/PNG 原件、坏对象修复、恶意条目和原目标保护 |
| 完整副本附件 ZIP | 通过 | 11 件原件，含历史/恢复/审计/嵌套归档专用附件，内部 checksum、闭合清单及 14 类坏副本，共享扫描规则对照通过 |
| Electron 源导出 CLI | build 12 实际包内二进制通过 | 正式 2.0.0 profile，正文/历史/恢复/回收站/来源审计和 8 原件，源 app/profile 前后指纹相同，活动写入/竞态/取消/坏原件/目标保护通过 |
| 原生完整副本 UI | build 13 的 7 阶段通过 | 预览/取消/确认、导入前 ZIP 重开、新 actor/空活动 outbox/离线默认、只读来源、8 原件、journal 收尾、历史/恢复 UI 操作及重启 |
| 附件同步互通 | 通过 | 实际 Node Sync Server，跨语言租约、1 MiB 续传、并发 2、取消、坏远端原件拒绝与修复 |
| 正文同步互通 | build 13 实际跨宿主通过 | Go↔Web transport 的离线/冲突/丢确认/重启去重，另有 build 13 WKWebView↔Electron GUI 的不同字段、同字段、结构冲突、补偿撤销、原件与去重 |
| 原生 Live 双客户端 | build 13 实际通过 | 两个包内 Go stdio 客户端竞争同 revision，恰好一个 committed/一个 stale，回执重放、撤权、只读重连及重启持久化 |
| 正式制品打包 | build 15 通过 | DMG 挂载、复制 app、tar 解压、包指纹、Node-free CLI、许可及清单，app 约 20.04 MiB，DMG 10,277,308 字节 |
| 安装后 GUI smoke | build 15 通过 | 隔离 HOME 的 DMG app 实际窗口，首次窗口出现后立即退出与普通退出均自然结束，约 171 ms / 173 ms |
| 正式 app 并存与实例 | build 12 的 9 项通过，build 13 原诊断部分完成 | build 13 已确认并存、第二实例、独立 profile、异常退出隔离及窗口恢复共 7 项，重启后立即退出的等待超时。build 12 的完整结果保留原归属 |
| 启动关闭专项 | build 15 通过 | 关闭订阅就绪与 loading 重试受原超时预算限制。最终包早退和普通退出均自然结束，旧 build 13 超时保留原归属 |
| 大提案与附件峰值 | build 12 完整重测通过 | 1,525,850 字节/33 changes 提案、128×1 MiB 附件调用、原件/回执/重启/保护与隔离，全部进程采样与清理验证。旧测量器误报单独保留 |
| 展开脑图 50 次编辑 | build 12 复核收敛 | MyGO p95 1,429 ms，同源重建 Electron 为 1,703.8 ms，低约 16.1%。正式 Electron 旧基线单独保留 |
| 展开大纲编辑 | 最终源码 50 次同源对照通过 | MyGO p95 1,701 ms，Electron 3,576 ms，50/50 保存回读。MyGO 最大 7,049 ms，保留极限样本的偶发长尾 |

原探针的通用 Script error 已定位为 Page.Eval 先按表达式编译语句块造成的失败及重试。测试宿主改用显式异步表达式后正常用例无错误，旧方式对照仍复现一次。

共享 MCP 代码语言清空确认已同步修复 JS 与 Go，增加预览→JSON 序列化→真实确认测试。自动生成的新节点身份保持原随机规则，固定 ID 的哈希对照另行验证。

## 工作包状态

| 工作包 | 当前状态 | 剩余验收重点 |
| --- | --- | --- |
| MG01 | 身份、兼容工具链与本机并存/实例检查通过 | macOS 12/13 实机持久化由用户非阻断验收 |
| MG02 | 36 桥、关闭屏障、并存实例与 build 15 安装早退检查通过 | 实际移动/缩放、Dock 重开和真实 IME 由用户非阻断验收 |
| MG03 | build 13 原生格式/主题/尺寸矩阵与 PDF/任务修复复验通过 | 携图 ZIP 人工面板、系统剪贴板/物理拖放/中文输入法由用户非阻断复验 |
| MG04 | build 13 完整副本 7 阶段及重启通过，偏好恢复修复通过最终回归 | 物理旧系统、Finder 和真实断电/磁盘环境由用户非阻断验收 |
| MG05 | Go 原件库、普通/完整 ZIP 和大文件峰值通过 | 本地归档/原件检查继续按改动执行，真实 Finder/设备磁盘由用户非阻断验收 |
| MG06 | 备份固定路径及外部基线/关闭最终备份修复通过 | 真实 iCloud、双客户端目录和人工文件变化由用户非阻断验收 |
| MG07 | Go 网络与确定性 provider 通过 | 真实 provider 的生成/知识操作/模板、部分接受与过期候选由用户非阻断验收 |
| MG08 | build 13 Electron/MyGO GUI 与本地服务跨实现互通通过 | 两台物理 Mac 的断线/冲突矩阵由用户非阻断验收 |
| MG09 | 全工具、资源、prompt、stdio、Unicode 与原生双客户端批准竞争通过 | 人工客户端和真实 OS 输入组合由用户非阻断验收 |
| MG10 | stable build 15 已公开发布，ad-hoc、手动更新、同源制品及下载核验通过 | 用户负责实际 Gatekeeper 与手动安装体验 |
| MG11 | 展开大纲最终同源 50 次对照及 p95 门槛通过，脑图和峰值沿用已有证据 | 极限大纲最大 7,049 ms，真实设备人工条件由用户非阻断验收 |
| MG12 | 最终源码两组远端 CI、同源包及本轮受影响验证通过 | 真实服务、旧系统与双设备由用户非阻断验收 |

## 发布门禁与执行结果

- 展开大纲同源 50 次回读与 p95 门槛通过，极值和内存口径见验证摘要。
- 最终源码已形成同源 app、probe、DMG、tar 与清单，并完成定向回归和严格包校验。
- 最终源码的 MyGO workflow 与既有 CI 均通过，实际源码和构建归属已记录。
- 发布说明继续披露维护补丁、实验性 JSON 模式和持续 ad-hoc/手动 DMG 路线。
- 用户授权的提交、推送、独立标签、公开 Release 与五项资产上传已完成，匿名下载核验通过。

## 用户人工验收的非阻断待办

- macOS 12/13、第二台物理 Mac 与真实断电/设备磁盘条件。
- 真实中文 IME、Finder、系统剪贴板、物理拖放、iCloud 和真实 AI provider。
- Gatekeeper 提示、手动安装体验、实际窗口移动/缩放及 Dock 重开。
- 当前构建的携图 ZIP 原生保存面板由用户复验。成功证据继续归属 build 11，build 13 面板超时保留原记录，本地归档代码检查继续执行。

自动下载、进度与自动替换状态机按用户确认移出本次交付。上述人工待办的状态继续按真实证据记录。

build 13 的构建、运行、MCP、签名与安装记录见 [同源制品证据](validation-mygo-2.0.0.md)。完整副本见 [七阶段原生验收](validation-mygo-2.0.0.md)，跨宿主与 Live 见 [双客户端验收](validation-mygo-2.0.0.md)，性能见 [当前结果与历史边界](validation-mygo-2.0.0.md)。未测项目继续保留在矩阵中。

最终 build 15 在实际复制安装的 app 上验证窗口出现后的立即退出和普通退出。前端订阅就绪及加载中握手已修复，两个过程均自然退出且状态为 0。历史 build 13 失败继续保留。
