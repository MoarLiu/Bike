# 使用 MyGO 重写 Bike macOS 客户端：可行性研究

研究日期：2026-11-10，Asia/Shanghai。结论针对 Bike 当前 2.0.0 的 macOS 客户端；Web 和 Sync Server 继续沿用现有实现。

**后续决策（2026-11-10）：用户确认新增与 Electron/Web 并存的 MyGO 2.0.0，并要求最终安装包移除 Node。实施以 [MyGO 2.0.0 开发计划](development-mygo-2.0.0.md) 为准。本文保留研究过程；其中临时 Node helper、替换原客户端及沿用原身份的建议，不作为当前交付方案。**

## 结论

**有条件可行，推荐优先采用 MyGO + WKWebView + 现有 React 前端，以 Go 替换 Electron 桌面层。暂不推荐直接把整个产品重写为 MyGO 的 Go 原生 UI。**

这条路线能够保留现有界面、四种视图及大部分业务逻辑，同时去掉随应用分发的 Chromium。主要工作量在数据迁移、36 个桌面桥接成员、附件与备份服务、Live MCP，以及发行和回归测试。它并非只改启动入口。

本次已经在临时目录编译并运行 MyGO v0.8.3，加载 Bike 现有生产前端，完成四种视图的基础渲染、一次 React 编辑提交、IndexedDB 保存及进程重启后读取、Go/JavaScript 调用和 Markdown 文件下载。该结果支持技术路线，但不构成完整桌面客户端验收。探针还捕获到一条通用启动脚本错误，在无 Bike/React 的极简页面也能复现，原因尚未定位。

## 研究基线

| 项目 | 实际检查的版本或范围 |
| --- | --- |
| Bike | package.json 为 2.0.0；本地 HEAD 为 fd3f57ec6551e234d3aecbb1c9145c34684f9d2e |
| Bike 工作区 | 存在本次研究前已有的修改；分析以当前文件为准，不将其误当成干净的发布提交 |
| MyGO 稳定版本 | v0.8.3，发布于 2026-11-07；提交 5add3817c74bb7505d0b473bc5fb28abe2201b99 |
| MyGO 主分支 | 查询时为 d4a6da45c41d8cf0b31848ae2901ad47dd48c7eb；运行探针固定使用 v0.8.3 |
| 最新 Release 的区别 | GitHub 另有 native-sqlitecore 资源发布；不能把它当成框架版本。此次查到的最新框架语义版本为 v0.8.3 |
| 框架年龄 | GitHub 仓库创建于 2026-09-26，距研究日约 45 天；已有较广 API 面，但长期维护稳定性尚缺观察周期 |
| 本机探针 | macOS 27.0.1、arm64、Go 1.27.3、CGO_ENABLED=0 |

本机原先没有 Go；此次将官方 Go 工具链下载到临时目录，按官方公布的 SHA-256 校验后使用，没有修改系统工具链。Go 模块下载曾遇默认代理 TLS 超时，改用模块镜像完成；未关闭模块校验。

## MyGO 提供什么

MyGO 的两种 UI 路线必须分开评估：

- **Web 前端模式**：macOS 使用 WKWebView，React/Vite 构建结果可嵌入 Go 可执行文件，通过生成的 TypeScript 客户端调用 Go 服务。生产页面使用 mygo://localhost。
- **Go 原生 UI 模式**：MyGO 自己用 GPU 绘制界面，不依赖 HTML/JavaScript/WebView；这里的原生 UI 不等于把控件逐一映射成 SwiftUI 或 AppKit 控件。它有列表、大纲、文本输入、Markdown、代码编辑器、绘图及混合 WebView 等基础能力。

两种模式均有窗口、菜单、对话框、剪贴板、文件拖放、文件关联、生命周期及更新等桌面 API。框架本身不要求 cgo，v0.8.3 要求 Go 1.27.3。Web 构建工具只在开发和打包时使用，不必随应用分发 Bun；若保留 Bike 的 Node MCP 实现，则 Node 属于 Bike 自己额外引入的运行时。

发行工具支持 macOS app、DMG、签名、公证和 darwin/universal。更新采用框架自己的签名归档和 manifest。框架具备这些 API，不代表 Bike 现有业务语义已被实现。

## 与当前 Electron 路线对比

| 维度 | 继续使用 Electron | MyGO + React/WKWebView | MyGO Go 原生 UI |
| --- | --- | --- | --- |
| 现有界面还原 | 已有基线 | 高：保留 JSX/CSS，但需处理 WebKit 差异 | 工作量大：布局、控件与交互重写 |
| 业务逻辑复用 | 全部保留 | 大部分前端和 shared JS 可保留 | 模型算法需移植或另设 JS 运行层 |
| 引擎分发 | 随包分发 Chromium/Node | 使用系统 WebKit，不分发 Chromium | 不需要 WebView；若嵌入 Web 页面则另计 |
| 浏览器行为 | 当前打包版本统一 | 受用户 macOS/WebKit 版本影响 | 受框架文本、输入与绘制实现影响 |
| 安装体积 | 当前正式包基线较大 | 预计明显下降，须测最终完整包 | 潜在更小，不能用空白示例估算完整 Bike |
| 内存/启动 | 有现有实现和测试基线 | 有降低开销的机会；WebKit 仍有子进程 | 有更大优化空间，也有大量重写风险 |
| 大纲/脑图算法 | 可以直接优化现有代码 | 换壳不会自动改善 React 和树算法 | 可重新设计虚拟化/绘制，但不是现成收益 |
| Live MCP | 可直接使用随 Electron 带来的 Node | 需内置 Node helper 或重写 MCP 服务 | 同样需要解决，不能直接执行现有 JS |
| 测试体系 | 现有 Electron/Playwright 可用 | 模块测试可复用，真实宿主测试需适配 | 很多 UI 测试及交互基线重建 |
| 维护成本 | 一套共享前端，桌面层稳定 | React/Go 两种语言，仍可与 Web 共用前端 | Mac 与 Web 两套 UI 的持续维护成本最高 |
| 本次建议 | 保留为比较和回退基线 | **推荐进入有验收门槛的迁移阶段** | 待明确需要纯 Go 或全原生体验后再评估 |

体积实测：当前 release/2.0.0 的 Electron DMG 为 136,754,898 字节，约 130.4 MiB；app 目录磁盘占用约 365 MiB。此次嵌入现有 dist 的 MyGO 探针可执行文件为 16,006,018 字节，约 15.3 MiB。**后者没有实现 Bike 桌面服务、MCP 和完整发行包，与正式 app/DMG 不是同口径，不能据此宣布最终缩小比例，也不能推导内存节省比例。**

## Bike 的实际迁移边界

按本地当前文本行数粗计，排除模块测试和 smoke 文件：

| 范围 | 文件数 | 文本行数 | 迁移意义 |
| --- | ---: | ---: | --- |
| src 的 TS/TSX/CSS | 39 | 17,473 | UI、状态、IndexedDB、导出、同步等；WebView 路线主要复用对象 |
| shared 的 MJS | 10 | 3,693 | 树/链接/Markdown/操作/副本等共同语义；优先保留同一份实现 |
| electron 的 CJS | 18 | 2,809 | 桌面服务和平台集成，需移植或适配 |
| mcp 的非测试 MJS | 3 | 2,984 | MCP 服务、文件/Live store；依赖 Node 和 JS 业务语义 |

行数不是开发工时。src/App.tsx 单文件 7,641 行，src/styles.css 4,111 行；全原生重写会把大量既有交互状态重新实现。

现有 electron/preload.cjs 暴露 **36 个桥接成员，包含请求方法、事件订阅和回执**。src/vite-env.d.ts 已有 BikeDesktopBridge 类型，且 Electron renderer 已禁用 Node integration、启用隔离和 sandbox，平台边界比前端到处调用 Node 的项目清晰。

| 能力 | 可复用部分 | 必须重做或验证的部分 | 风险 |
| --- | --- | --- | --- |
| 大纲、脑图、演示、Markdown | React、CSS、SVG、文本模型 | 四视图布局、焦点、快捷键、IME、拖拽、foreignObject | 中 |
| 搜索、标签、双链、关系、模板、提案 | src/shared 的算法和界面 | 边界契约和大数据性能回归 | 低至中 |
| 撤销/重做、历史、回收站 | 现有业务实现 | 系统 Edit 菜单与应用撤销的分工、关闭刷新 | 中 |
| JSON/MD/OPML/FreeMind/HTML/PDF、脑图图片 | 现有导出器、pdf-lib 和字体 | Blob 下载完成、另存、中文 PDF、SVG/PNG 边界 | 中 |
| 本地持久与旧数据迁移 | 第一阶段可保留 storage.ts | Chromium 数据导出、WebKit 导入、私有副本状态与恢复 | 高 |
| 附件和工作区 ZIP | 前端入口、格式、SHA-256 标识与协议 | Go 文件库、流式传输、图片缩略图、ZIP 校验、清理隔离 | 高 |
| iCloud Drive 备份 | 已有规则和测试用例 | 原子写、锁、基线哈希、外部更改暂停、退出回执 | 高 |
| AI 与正文同步 | 前端协议、提案与合并逻辑 | Go HTTP 代理、配置校验、取消、超时、预算 | 中至高 |
| 附件原件同步 | 协议、哈希、服务端 | 分块、断点续传、取消、ENOSPC 和安装校验 | 高 |
| Live/File MCP | 工具 schema 和业务语义可作为基线 | 运行时、stdio/socket、授权范围、草稿、批准、幂等 | 高 |
| 检查更新、下载、重启安装 | 当前产品交互 | 更新 manifest、签名、公证、保存后安装、旧端过渡 | 高 |

## 最需要提前解决的问题

### 1. 无损迁移不能只导入普通 ZIP

现有桌面版主体数据在 Chromium IndexedDB，MyGO 的 WKWebView 使用另一套存储，生产 origin 也由 file 页面变成 mygo://localhost。不能通过改应用名或复制 Chromium 数据目录直接复用。

Bike 2.0 不只保存文档：src/storage.ts 将正文、元信息和 replica 一起提交；shared/bike-replica.mjs 还保存 actorId、clock、generation、outbox、receipts、audit、cursor、remote 和 conflicts。普通工作区 ZIP 主要装 workspace.json、manifest 和附件，**不等于整个本机数据库迁移包**。

需要明确两种不同交付目标：

- 作为新设备导入：导入文档和附件，重新生成本机身份并接入同步。较简单，但不能声称完整保留本机审计、回执和未同步操作历史。
- 替换原客户端并完整延续：增加专门的本机迁移流程，导出数据库记录、必要的 localStorage 配置/导航/备用副本及附件；在关闭旧端写入后，校验、导入、再切换。保留旧数据用于回退。

第二种流程不能让两个仍在使用的客户端共用相同 actorId；切换中失败、两端同时启动、旧端回退、已有未确认 outbox 和未提交草稿均需有明确行为。迁移包中的本机配置不能当作普通分享文件处理。

第一阶段建议继续使用现有 IndexedDB 事务及 JS 副本逻辑，控制变更范围。把数据权威层迁到 Go/SQLite 有长期价值，但它是另一项需要单独测试事务、回执、CAS 和恢复语义的工程，不宜与首次换壳绑定。

### 2. 附件不能照搬大块二进制 IPC

当前 attachment-import 接受 ArrayBuffer/Uint8Array；单文件上限 128 MiB、单批 512 MiB。MyGO 的服务绑定用 JSON，Go 的 []byte 对应 base64 字符串。直接适配会引入约 4/3 的编码体积，以及 JS 字符串、JSON 和 Go 解码的额外副本。

建议：文件选择和 Finder 拖入尽量由 Go 从用户选择/授权的路径读取；剪贴板或浏览器 File 使用有限大小分块或受控流接口。对话框取消、传输取消、哈希校验、空间不足、ZIP 路径校验、附件隔离清理都必须保留。缩略图需要替换当前 Electron nativeImage。

### 3. Live MCP 的 Node 运行时不会随换壳自动保留

当前 electron/entry.cjs 通过 --mcp-live 切换入口，electron/mcp-entry.cjs 启动 Node MCP SDK；本机私有 socket 再把 snapshot/proposal/status 请求交给运行中的 renderer。

可选方案：

- **迁移初期内置受管理的 Node helper**：复用现有 mcp/shared，最有利于保持工具行为一致；按需启动，避免要求最终用户安装 Node。应用仍可去掉 Chromium，但不能宣传无 Node 或纯单文件。helper 的打包、签名、退出和版本也要管理。
- **Go 实现 MCP 服务**：可以进一步降低运行时依赖，但必须重建工具、资源、提示词、JSON-RPC、授权及业务验证，并用相同样本核对输出。尤其不能把 Live 改成读取滞后的备份 JSON 来冒充完整还原。

全 Go 还涉及 JS/Go 间的 canonical JSON、字段缺省、Unicode、数字和扩展字段语义；关系改绑、提案及冲突合并应使用共享测试语料做差分验证。

### 4. WebKit 和系统版本成为新的兼容矩阵

本次通过的是 macOS 27.0.1 上的小样本，不覆盖老系统。当前正式包的 Info.plist 声明最低 macOS 12.0；声明不等于已在该系统实测。MyGO v0.8.3 默认也声明 12.0，但有能力自己的版本门槛。

一个具体陷阱：MyGO 的命名 NewSession 在 macOS 14 之前退回内存存储，退出后不持久；默认 session 走 defaultDataStore，不能把这个限制错误地套到所有会话。此次隔离探针在 macOS 27 使用命名 session。若正式产品继续覆盖 12/13，必须选择正确的持久会话策略，并以退出重启验证；不能直接照搬探针会话方案。

另需验证真实中文输入法组合输入、系统剪贴板图片、Finder 文件拖放、SVG foreignObject 的布局和命中、中文字体及 PDF、Blob 生命周期、窗口关闭、系统 Edit 菜单和应用历史。MyGO 的 ui.Outline 提供虚拟化基础，不会自动复现 Bike 的编辑、批量操作、提案和关系行为。

### 5. 更新渠道和签名需要过渡

Bike 当前使用 electron-updater；MyGO 使用自己的签名 tar.gz、update-darwin-*.json 等产物，两者不能直接互换。

建议首次迁移使用明确的数据迁移流程和手动 DMG 安装，MyGO 客户端之后再进入自己的更新通道。Beta 使用独立 bundle/profile、MCP discovery 和备份写入配置，避免双端争写；正式切换时再确定原 com.bike.app 身份和数据目录的延续方式。

MyGO 更新包签名与 Apple Developer ID 签名/公证是不同层。框架提供签名工具不代表已获得 Apple 凭据，也不会自动解除当前 ad-hoc 发布的限制。更新安装前必须继续等待保存和备份回执。

## 推荐的实现结构

```text
src/ + shared/                       保留 React UI 和共同业务语义
src/platform/desktopBridge           明确 Electron / MyGO / Web 适配
                                    第一阶段保持 BikeDesktopBridge 产品契约
desktop-mygo/                        Go 应用入口、窗口、菜单、生命周期
  services/                         文件、附件、备份、网络、更新、MCP socket
  bindings/                         生成的 TS 类型和适配器
mcp/                                初期可由内置 Node helper 继续执行
server/                             继续使用现有 Web / Sync Server
```

桌面适配器可沿用现有返回结构、事件退订和取消语义，减少 App.tsx 的迁移改动。不能把 36 个接口做成空实现或静默降级后宣称完成。原生调用仍需保持可信页面、参数约束、链接导航和请求配置校验，不能因为桥接换成 Go 就放宽权限。

### 适合同时做的优化

1. 去掉 Chromium 分发，测量最终 app/DMG、冷暖启动和包含 WebKit 子进程/helper 的总内存。
2. 将附件读取、哈希、归档和网络传输放在 Go 层，避免大对象反复穿过 JSON 桥。
3. 检查大纲/搜索的重复遍历、可见区域渲染、脑图节点测量和历史保留；这些优化大多也能惠及现有 Web/Electron。
4. 在数据安全和功能对等后，再改善菜单、窗口恢复、对话框和 Mac 快捷键体验。

不应承诺仅换壳即可让 20,000 节点编辑、中文输入或脑图布局成倍加速。主瓶颈若在 React 重渲染、全树遍历或同步序列化，仍需对应修改算法。

## 本次实际运行证据

证据保存在 [evidence-mygo-2026-11-10](validation-mygo-2.0.0.md)。所有测试使用虚构三节点文档及隔离命名 session，没有读取真实用户工作区；最终重启验证后已清除此 session 的网站数据。

| 检查 | 本次结果 | 覆盖边界 |
| --- | --- | --- |
| MyGO v0.8.3、CGO_ENABLED=0 编译 | 通过 | 临时 Go 工具链，本机 arm64 可执行文件 |
| 现有 dist 加载 | 通过 | 生产 mygo://localhost，secure context |
| Go ↔ JS 调用 | 通过 | 中文、emoji 和数字的 JSON 往返 |
| IndexedDB/localStorage 重启持久化 | 通过 | 退出第一个进程后由第二个进程读回 |
| 大纲/脑图/演示/Markdown 基础渲染 | 通过 | 三节点 fixture、程序触发切换、DOM 检查及截图；不等于像素级或完整交互验收 |
| React 编辑 → IndexedDB → 再次进程重启 | 通过 | DOM input 事件触发真实前端提交；不是物理键盘/IME 测试 |
| Markdown 下载 | 通过 | 实际生成 .md 文件，由 MyGO 下载回调写入隔离目录 |
| 启动脚本错误 | 未解决 | 捕获 Script error.，无来源行号；无 React 的极简页面同样复现，尚不能确定属于框架、宿主环境还是探针注入 |
| 附件、ZIP、PDF、PNG、iCloud、AI、同步、Live MCP | 未验证 | 探针没有实现 BikeDesktopBridge，不应据 UI 可见推断能力可用 |
| 最低系统、Intel、签名更新、性能 | 未验证 | 未做这些平台/发行/性能实验 |

本次没有宣称全部工程测试或 Bike 2.0 的真实服务接入通过。原 Bike 验收中仍有真实 AI/MCP、物理双设备、输入法和 iCloud 等后续补测项；迁移版不能自动继承其通过状态。

## 工作量与执行顺序

以下是基于当前范围的一名熟悉 Go、React 和 macOS 的工程师的粗估，不是承诺日期。真实输入法、旧系统、迁移和框架问题可能扩大范围。

| 阶段 | 交付和退出条件 | 估计人日 |
| --- | --- | ---: |
| P0 补完可行性 PoC | 定位启动错误；实机 IME/剪贴板/拖放/导出/退出；确定最低系统；建立同数据性能基线 | 3–5 |
| P1 桌面桥和壳 | 36 个成员对应实现；菜单、网络、事件、取消、关闭和更新准备契约 | 8–12 |
| P2 数据与文件迁移 | 私有迁移流程、附件/ZIP、备份、断点同步及故障注入 | 8–12 |
| P3 MCP 与跨端语义 | 受管理 helper 路线、真实客户端连接、草稿/批准/撤权/幂等、兼容性对照 | 5–8 |
| P4 发布验证 | 完整应用、旧端过渡、签名/公证及更新、最低系统与设备回归、回退演练 | 5–8 |
| 合计 | 推荐 WebView 路线达到可交付对等版 | **29–45 人日，约 6–9 个工作周** |

首阶段已有的探针可以复用，但不能替代 P0 尚缺的验收。若第一版就要求完全移除 Node、重写全部 MCP 并把权威数据迁到 Go/SQLite，需重新估算，通常另增加数周。证书申请、实机资源或外部服务等待不包含在上述人日中。

全 Go 原生 UI 路线粗估 **60–100+ 人日，约 3–5 个月或更长**。主要原因是大纲编辑器、脑图交互、Markdown 往返、中文输入、撤销/提案、导出与跨端数据语义都需重建或重新集成，而且 Web 与 Mac 会产生长期双 UI 维护成本。

## 完成迁移的验收定义

- 功能：以当前四视图及 Bike 2.0 R01–R14 为清单，覆盖 36 个桥接成员；禁用按钮和只呈现界面不算完成。
- 数据：v1/v2/v3、文档/主题身份、扩展字段、关系、附件、回收站、历史和本机副本状态按约定保留；失败时旧端仍可恢复。
- 同步/MCP：真实服务和客户端；离线并发、回执重试、批准/拒绝/撤权、未失焦草稿和双端冲突处理。
- 系统：真实输入法、Finder/系统剪贴板、键盘菜单、关闭重开、最低支持系统，以及若要提供 Intel 则须有 Intel 实机验收。
- 性能：同机、同数据、同功能、同口径比较总进程内存、冷暖启动、空闲 CPU/唤醒、搜索/编辑 p95、展开大文档和附件峰值；当前旧样本的折叠节点结果不能代替全部展开测试。
- 发布：打包后的 app、签名/公证范围、实际下载、安装、更新保存屏障和回退均有证据。

**建议决策：批准 MyGO WebView 路线的 P0/P1 技术迁移，保留 Electron 为对照和回退；以阶段验收决定是否继续切换正式 Mac 客户端。现在没有充分证据支持直接开始全 Go 原生 UI 的整套重写。**

## 主要来源

MyGO 的能力判断主要来自 v0.8.3 的源码和官方文档，主分支新能力没有算入稳定版已验证范围：

- [MyGO v0.8.3 README](https://github.com/egoist/mygo/blob/v0.8.3/README.md)：双 UI 路线、构建模型。
- [前端与 origin](https://github.com/egoist/mygo/blob/v0.8.3/docs/frontend.md)：资源、存储、文件拖放和 preload。
- [绑定与 JSON](https://github.com/egoist/mygo/blob/v0.8.3/docs/bindings.md)：生成客户端、二进制编码、事件、Channel 和信任边界。
- [Session 源码](https://github.com/egoist/mygo/blob/v0.8.3/session.go) / [macOS 实现](https://github.com/egoist/mygo/blob/v0.8.3/internal/darwin/session.go)：命名会话的 macOS 14 门槛与默认 data store 的区别。
- [发行](https://github.com/egoist/mygo/blob/v0.8.3/docs/distribution.md) / [更新](https://github.com/egoist/mygo/blob/v0.8.3/docs/updates.md)：打包、架构、签名、公证及更新产物。
- [原生 Outline](https://github.com/egoist/mygo/blob/v0.8.3/docs/ui/outline.md) / [原生性能口径](https://github.com/egoist/mygo/blob/v0.8.3/docs/ui/performance.md)：现有基础控件与基准范围。
- Bike：[桌面接口](../src/vite-env.d.ts)、[preload](../electron/preload.cjs)、[持久化](../src/storage.ts)、[副本状态](../shared/bike-replica.mjs)、[归档](../electron/workspace-archive.cjs)、[附件 IPC](../electron/attachment-ipc.cjs)、[Live MCP](../electron/live-mcp-service.cjs)、[MCP 入口](../electron/mcp-entry.cjs)、[2.0 验收范围](acceptance-2.0.0.md)。
