# Bike MyGO 2.0.0 开发计划

整理日期为 2026-11-10，进度更新于 2026-11-11（Asia/Shanghai）。**stable build 15 已发布为 mygo-v2.0.0**。36 项桥接、Go 服务、File/Live MCP、review 修复、同源制品、远端 CI、严格包校验与公开下载核验均已完成。展开大纲的最终同源 50 次 p95 门槛通过，极限样本的偶发极值与用户人工待办见[验收记录](acceptance-mygo-2.0.0.md)及[发布验证](publish-verification-mygo-2.0.0.md)。

**2026-11-11 用户发布政策调整**。后续持续采用 arm64、ad-hoc 签名和手动 DMG 安装路线。用户亲自负责 macOS 12/13、双物理 Mac、真实中文 IME、Finder/系统剪贴板/物理拖放、iCloud、真实 AI provider、Gatekeeper 及其他人工真机交互，相关条目保留为非阻断待办。携图 ZIP 原生保存面板的交互超时也由用户复验，本地归档代码与文件校验继续按影响范围检查。尚未取得的证据仍标为待验。

用户在 2026-11-11 授权的发布流程已执行。当前更新方式为独立渠道查询、受信发布页和手动安装，自动下载及替换范围已按本次交付决策处置。用户人工验收继续按非阻断待办记录。

本计划依据用户确认：**保留当前 Electron 版和 Web 版，新增 MyGO macOS 版；三个产品形态的正式版本继续使用 2.0.0。MyGO 版采用 Go 桌面层 + WKWebView + 现有 React 前端，正式安装包不携带 Node，也不要求用户安装 Node。**

这是新增并行客户端，不是替换 Electron、移动原 v2.0.0 标签或重新发布原有资产。[原 2.0.0 开发计划](development-2.0.0.md)继续记录 Electron/Web 已交付功能；本计划是 MyGO 版的实施依据。此前[可行性研究](mygo-feasibility-2026-11-10.md)中的临时 Node helper 和替换原应用路线不再作为本版交付方案。

## 1. 版本目标与范围

### 1.1 交付目标

1. 新增可与 Electron 同时安装、独立启动的 Bike MyGO 2.0.0，首先交付 macOS arm64。
2. 复用四种视图、React/CSS 和可在浏览器运行的共享逻辑，完整承接现有 2.0.0 功能与 R01–R14 行为。
3. Go 实现桌面服务和 MCP，移除 Mac 安装包中的 Electron、Chromium、Node 及对用户机器 Node/npm 的依赖。
4. 保持工作区 v1/v2/v3 导入、现有 JSON/ZIP、节点操作协议 2 和 Sync Server 兼容，不因框架变化另起数据协议。
5. Electron、Web 和 MyGO 可通过现有同步服务交换数据；同机两种桌面客户端具有不同副本身份，不共享活跃数据库和备份写入目标。
6. 保留 Electron/Web 的构建、测试、MCP 和部署能力；共享前端改动须同时回归三种宿主。

首版兼容目标为 arm64、macOS 12+，与现有 app 的最低版本声明对齐。实际 Mach-O 和 plist 的最低版本继续通过自动化包检查，12/13 的真实运行由用户作为非阻断待办验收。系统声明与实测结果分别记录。Intel/Universal 不纳入首版承诺。

**工具链进展（2026-11-11）**。11 月 10 日发现 Go 1.27.3 产物的 `minos` 为 13.0。现固定 Go 1.26.10、`CGO_ENABLED=0`、`GOEXPERIMENT=jsonv2`，对校验后的 MyGO v0.8.3 仅应用 `go.mod` 工具链声明补丁，实际产物的 `minos` 和 plist 均为 12.0，严格包校验通过。源码补丁与上游摘要已冻结。macOS 12/13 实机验收继续保持待测，实验性 JSON 模式与维护补丁列入候选说明。

### 1.2 本版不做

- 不把全部 UI 改写成 Go GPU 原生控件，不重设计现有界面。
- 不把 Web/Sync Server 改为 Go，不要求整个仓库停止使用 Node。Node/Bun 仍可作为构建、测试和旧产品的运行工具。
- 不同时把主数据从 IndexedDB 改为 Go/SQLite；复用已存在的事务、CAS、操作回执与恢复语义。
- 不增加多人协作、账号系统、云端托管、移动端或新的产品功能。
- 不复用 Electron 的 bundle id、安装位置、活跃 profile、actorId、MCP discovery 或默认 iCloud 备份目录。

### 1.3 基线与已知验证边界

| 项目 | 基线 |
| --- | --- |
| 业务基线 | 当前 Bike 2.0.0；本地 HEAD fd3f57ec6551e234d3aecbb1c9145c34684f9d2e；发布来源和资产见[正式发布验证](publish-verification-2.0.0.md) |
| 工作区 | 存在既有未提交修改；开工时逐项确认并记录，不自动纳入或覆盖 |
| MyGO 起点 | 已做探针的 v0.8.3，提交 5add3817c74bb7505d0b473bc5fb28abe2201b99；M0 固定实际依赖，不直接跟踪 main |
| Go 起点与当前工具链 | 历史探针使用 1.27.3；当前开发与 CI 固定 1.26.10、CGO_ENABLED=0、GOEXPERIMENT=jsonv2 |
| 已有证据 | 四视图基础渲染、Go/JS 往返、编辑持久化和重启读回、MD 下载，见[探针证据](validation-mygo-2.0.0.md) |
| 启动错误结论 | M0 已定位为原探针向 Page.Eval 传入语句块时触发的表达式编译失败及重试；改成显式异步表达式后正常用例无错误，旧方式对照仍复现，见[M0 证据](validation-mygo-2.0.0.md) |
| 当前边界 | 正式 build 15 的发布门禁已完成。极限大纲仍有两次约 6–7 秒的极值，携图 ZIP 面板与真实系统/设备/服务交互由用户非阻断验收，更新采用手动 DMG |

原 Electron 验收中的用户后续补测仅适用于原交付，不能继承为 MyGO 的通过结果或默认豁免。

## 2. 同版本并存与发行身份

### 2.1 产品、目录和标签

以下是本版的实施约定，实际构建须自动检查：

| 项目 | Electron/Web 现状 | MyGO 2.0.0 约定 |
| --- | --- | --- |
| 正式产品版本 | 2.0.0 | 2.0.0 |
| 产品形态标识 | electron / web | mygo；关于页、日志、诊断和制品 manifest 明确标识 |
| Mac 应用名 | Bike.app | Bike MyGO.app |
| Bundle ID | com.bike.app | com.bike.mygo |
| 应用程序文件 | 原有 Bike 入口 | 独立 bike-mygo 入口，实际包内路径在 M0 冻结并写入 MCP 配置 |
| 本机应用数据 | ~/Library/Application Support/bike | ~/Library/Application Support/Bike-MyGO |
| 预发布数据 | 原 Electron preview 目录 | Bike-MyGO-preview；预发布 bundle 使用 com.bike.mygo.preview |
| 默认 iCloud 备份 | iCloud Drive/Bike | iCloud Drive/Bike-MyGO；preview 再单独隔离 |
| Live MCP discovery | 原 profile/live-mcp.json | MyGO profile/live-mcp.json，独立授权、令牌和 socket |
| Git 正式标签 | v2.0.0 保持原指向 | 新增 mygo-v2.0.0，指向 MyGO 交付源码 |
| Release 标题 | 已有 Bike 2.0.0 | Bike MyGO 2.0.0 |
| 构建输出 | 现有 release 路径 | release/mygo/2.0.0/，不覆盖已有产物 |

根 package.json 继续为 2.0.0；新增 MyGO 配置须与业务版本一致。alpha.1、alpha.2、alpha.3、beta、RC 是本计划的阶段和候选批次，先作为 CI 制品分发，并附独立递增 build 编号、commit 和构建清单，不改写已有 Electron 预发布或正式标签。版本、形态、build 三者分别记录。

MyGO 本版正式 app 的 CFBundleShortVersionString 为 2.0.0，CFBundleVersion 使用独立构建编号。不能假设提高 build 编号就会触发同语义版本的自动更新。正式资产发布后不可静默覆盖；后续修订的版本和发布动作另行安排。

### 2.2 更新和下载路由

当前 Electron 检查更新和 Web/Sync 安装脚本均依赖 GitHub 的 releases/latest。MyGO 必须使用独立选择机制：

- 同仓库使用 mygo-v 前缀，MyGO 更新查询的 tagPrefix 固定为 mygo-v，用户从受信发布页取得对应平台的手动安装包。候选完整性清单单独记录平台与形态，当前标记 updaterConsumed=false。
- MyGO Release 发布时显式不设置为仓库默认 Latest；原 Electron/Web 继续解析原有版本链。此行为加入发布后检查。
- MyGO 发布流程与既有发布流程分开；原 v2.0.0 标签、Release 和资产保持不变。不能仅添加 MyGO 文件到旧正式资产后就称为有独立更新渠道。
- 建议独立资产名：bike-mygo-2.0.0-arm64.dmg、bike-mygo-2.0.0-darwin-arm64.tar.gz、update-darwin-arm64.json、MyGO 专属 SHA-256 清单。精确名称以冻结的配置及真实输出检查为准。
- Electron 的 latest-mac.yml、blockmap 和 Web 部署归档不由 MyGO 流程生成或覆盖。
- 验证旧 Electron 更新检查、Web/Sync latest 安装以及 MyGO 更新检查各自命中正确渠道。

## 3. 架构与复用策略

```text
src/ + shared/                  三种宿主共用 UI、树、知识操作、同步和格式逻辑
src/platform/                  Electron / MyGO / Web 的明确适配边界
desktop-mygo/
  cmd/bike-mygo/               GUI、--mcp-live、--mcp-file 等入口
  internal/platform/          窗口、菜单、生命周期和可信调用
  internal/services/          附件、归档、备份、网络、更新
  internal/mcp/               Go MCP 协议、工具、资源、prompt、Live/File store
  internal/contracts/         版本化数据、JSON/哈希规则与校验
  bindings/                   生成的 TypeScript 绑定
  tests/fixtures/             与现有 JS 实现对照的固定语料
electron/                     继续维护原桌面版
mcp/                          继续维护原 Node MCP，作为行为对照
server/                       保留原 Web/Sync Server
```

目录是建议分层，不要求为每个概念预先创建空模块。优先通过现有 BikeDesktopBridge 维持返回结构、取消、事件订阅和回执；生成的 MyGO 服务绑定由适配器转换，不将平台分支散落到各视图。Web 不具备的桌面能力继续按原规则提示。

Go MCP 可复用协议库，但 SDK、依赖版本和分发许可在 M0 固定。既有浏览器共享逻辑继续由前端执行；需要脱离 UI 运行的 File MCP 逻辑移植到 Go，并以旧 JS 实现为对照。不得要求 File MCP 打开隐藏 WebView 才能工作，也不以其他打包 JS 运行时替代 Node 来绕过本版 Go 服务目标。

本机与远端状态仍经现有提交入口协调。Go 层不另建一条绕过 renderer 事务、批准、版本检查和 outbox 的写入通道。

## 4. 数据导入、并存与回退

### 4.1 独立副本是默认行为

两个客户端可以同时运行：窗口锁、profile、WebKit 存储、附件库、设置、socket 和更新锁分别隔离。同名 IndexedDB 数据库不表示两个不同宿主可以共享底层目录。

**文档和主题身份按格式保留，每个客户端生成自己的 actorId；不得把原 Electron 的活动 replica 整包复制到 MyGO 后让两端继续运行。** 原 actorId、outbox、cursor、remote 基线、活动回执与连接令牌不作为新客户端活动状态导入。原端待同步内容不能因导入而被清空或标记已确认。

### 4.2 两种导入入口

| 入口 | 行为 | 验收要求 |
| --- | --- | --- |
| 普通 JSON/工作区 ZIP | 按现有规则导入正文、引用，ZIP 另含原附件；作为独立副本 | 不宣传保留全部本机状态；保持 v1/v2/v3 和旧端格式保护 |
| Electron 本机完整导入 | 一次性导出正文、附件、回收站、可迁移版本历史、备用副本和所选偏好；源审计按来源归档 | 导入前展示范围和不迁移项；原端不被修改；完成后可比对内容与附件哈希 |

完整导入工具可复用已有 Electron 运行时读取隔离 profile 副本，不将 Node/Electron 打入 MyGO app。原端先刷新可提交草稿并停止写入，取得一致快照；源数据目录不能在读写中直接复制后宣称一致。M0 冻结导出工具、文件格式、校验和用户操作步骤。

正文库与版本历史库是两个 IndexedDB 数据库，不能假设跨库原子事务。导入先校验和暂存，在隔离 profile 或有完成标记的导入会话内安装；在所有必需部分完成前不对用户宣告成功或开始同步。崩溃、磁盘满、坏附件和再次导入须可重试或回到导入前状态。

源设备审计保留为带来源的只读历史，不变成新设备活动 outbox/回执；待确认提案和内存撤销栈不转成新端可执行操作。版本历史恢复在新端产生正常的新操作。涉及源审计、历史、备用副本的附件仍纳入清理保护。凭据和私有配置单独选择，不自动混入普通分享副本。

### 4.3 连接同一 Sync 空间

- 推荐以独立身份从既有服务端 checkpoint 初始化，再通过原端正常同步取得修改。
- 源端存在待传操作、未解决冲突或不确定共同基线时，不自动把本机导入副本接入同一远端；先完成源端同步/冲突处理，或明确导入为保持同步关闭的离线副本。
- 已有两份同 ID 文档、旧副本再次导入、服务端落后和断线重连均使用现有冲突与身份规则，不能静默覆盖或重复创建。
- 分别测试 MyGO ↔ Electron、MyGO ↔ Web 的协议交互；测试范围以各宿主当前已有能力为准，不给 Web 虚构桌面附件能力。

### 4.4 回退含义

卸载 MyGO 不影响原 Electron 的数据和应用。MyGO 中新增的内容可通过既有同步或兼容 ZIP 带回 Electron。回退是退出并行客户端或交换数据，不是把 MyGO 数据目录交给 Electron 打开。iCloud 文件仅作备份/显式导入，不作为两端共用的实时数据库。

## 5. 工作包和逐项验收

MG01 和 MG09 垂直样例已经开工，当前状态逐项记录在验收文档。M0 中复用探针和首批基础实现按各自覆盖边界验收。

### MG01 基线、工具链与并存身份

- 建立 codex/mygo-2.0.0 开发分支或隔离 worktree，记录实际开工 commit 和既有修改处置。
- 固定 Go/MyGO、构建工具和 Go MCP 依赖；CI 记录编译器、SDK、架构、CGO 和构建参数。
- 实现第 2 节的独立身份和目录，明确 beta/正式隔离。定位探针启动错误，最低系统的人工持久化验收交由用户非阻断跟踪。
- 冻结前端构建、MCP 入口、导出协议、更新选择及性能基线。

验收覆盖同机并存、无 Node 的启动和生产 custom scheme 重启持久化。MyGO v0.8.3 的命名 session 在 macOS 14 之前不持久，生产采用默认 session。旧系统实际持久化证据由用户补充，按 2026-11-11 政策作为非阻断待办记录。

### MG02 桌面桥、窗口、菜单与生命周期

- 接通第 6 节全部 36 个桥接成员；建立生成绑定与现有 TypeScript 契约检查。
- 复现窗口大小、关闭重开、Dock 激活、单实例、菜单、外链、设置入口与应用事件。
- 原生编辑菜单与业务撤销分别处理，避免一次 Cmd+Z 同时触发浏览器及应用两条历史。
- 关闭和更新前刷新草稿并等待保存/备份回执；超时保留恢复线索，不直接退出丢数据。
- 保留可信来源、导航约束、参数/预算校验；阻止不受信任页面调用 Go 能力。

验收：正常、繁忙、取消、窗口关闭和异常断开都有明确结果，事件退订后不重复回调；不能以空实现或永久禁用按钮计为完成。

### MG03 四视图、输入与导出体验

- 保持大纲、脑图、演示、Markdown，以及搜索、标签、双链、关系、任务、提案、历史界面和主题样式。
- 自动化继续覆盖输入、焦点、快捷键与保存边界。真实中文 IME 的组合/提交/取消、系统选区/复制粘贴和物理拖拽由用户人工验收，记录为非阻断待办。
- 检查 SVG foreignObject、缩放、节点命中、滚动、字体与高 DPI；仅针对差异修复，不顺带重设计。
- 复用现有导出算法，验证 JSON、MD、OPML、FreeMind、HTML、PDF、SVG、PNG 和携图导出的真实文件。

验收：浅/暗主题、1366×960 和较大窗口的核心流程有截图及交互证据；中文 PDF、图片、表格、代码、关系和链接往返不丢失。

### MG04 本地持久、恢复与完整导入

- 复用 storage.ts 的原子提交、版本保护、CAS、备用副本、回执和现有历史入口。
- 实现第 4 节普通导入与完整本机导入；处理历史库、私有只读归档、重复导入及身份初始化。
- 验证 renderer 重载、主进程异常退出、提交中断、存储满与两个窗口的竞争。
- 明确 WebKit 存储的 app/session/origin 稳定性，开发地址与生产地址不混作用户数据源。

验收：已返回成功的提交重启后存在；未完成提交不会伪装成功；旧 Electron 源数据可完整恢复且活动身份不被复制。

### MG05 附件、归档及文件服务

- Go 实现 SHA-256 附件库、读取/另存/打开、缩略图、补齐、扫描和隔离清理。
- 选择文件和授权拖入路径由 Go 读取；File/剪贴板数据采用有界分块，避免 128 MiB 内容整块 base64 过桥。
- 保持工作区 ZIP 格式、内容校验、路径/符号链接约束、覆盖保护及原子安装。
- 清理保护包含回收站、版本历史、撤销、备用副本、活动 outbox/冲突与导入的只读历史。

验收：原件字节一致；大批次、取消、ENOSPC、损坏 ZIP、缺失/坏哈希及恶意路径不破坏已有数据；导出失败不留下冒充成功的文件。

### MG06 iCloud 备份与退出刷新

- 移植现有队列、文件锁、基线哈希、原子写、外部变化暂停、保留策略和退出回执。
- 默认关闭自动备份；启用后只写 MyGO 专属目录，preview 再隔离。
- 读取原 Electron 备份属于显式导入，不自动把其目录改成 MyGO 写入目标。

验收：两个 app 同时启用备份时分别写各自位置；外部修改、备份中关闭、磁盘错误和重启恢复保持原语义。

### MG07 Go 网络代理与 AI 完整闭环

- Go HTTP 实现现有 provider 和 Sync 请求代理，保持已保存配置匹配、路径白名单、超时、取消、响应预算和错误结构。
- 生成、润色、五类知识操作、PRD/任务/会议模板继续走既有预览、依赖组接受/拒绝及持久提交。
- API 配置、个人密钥的本机策略保持既有产品规则，不额外引入账号体系。

确定性 provider 的取消、超时、无效输出、目标变化、部分接受和过期候选继续按自动化门禁验证。真实 provider 结果由用户人工补充，保留非阻断待验状态。

### MG08 正文及附件同步互操作

- 前端继续使用现有操作协议和合并实现，Go 层接管网络/附件 I/O，不重写服务端。
- 保持正文操作、outbox、checkpoint、回执去重、游标、冲突和补偿撤销的事务边界。
- Go 附件传输保持分块、租约、续传、取消、配额和安装校验，正文与附件进度分别显示。
- 联调 MyGO/Electron 两独立副本，以及 Web 的现有同步路径。

验收：不同字段收敛、同字段/结构冲突可比较，重复/乱序/丢确认/长时间离线后不重复应用；两端互不盗用 actorId，坏附件不被安装。

### MG09 无 Node 的 Go MCP

- 实现 Go stdio MCP、工具/资源/prompt schema、返回结构和错误行为；保留 6 个读工具、8 个写工具、5 个 prompt、既有资源及 Live 的提案状态查询。具体 manifest 从当前实现提取并冻结。
- 同一 Go 可执行文件或打包的 Go helper 提供 Live/File 入口。File 模式在 GUI 未启动时可独立运行；Live 断开明确报错，不自动降级到文件写入。
- Live 保持默认关闭/只读、文档范围、可提交草稿读取屏障、组合输入保护、批准/拒绝/撤权、状态查询与幂等回执。
- File 沿用现有格式边界：v1/v2 的受控写入按现有授权和锁规则执行；**v3 禁止 File 真实写入，要求 Live 确认写入**，不得因换语言放开限制。
- 移植独立执行所需的树操作、Markdown、索引、校验、revision 和 digest，保留扩展字段；前端已共享的语义不要在无必要时另造一份。
- 差分测试固定时间/id，比较 JS 与 Go 的成功结果、错误、JSON/Unicode/数字/字段缺省、关系改绑和边界预算；只归一化声明的非确定字段。
- 配置为独立的 Bike MyGO MCP 服务；不替换用户原 Electron MCP 配置，不在 stdout 混入日志。

验收：实际 MCP 客户端完成读、搜索、资源/prompt、预览、批准、回执、重连和双客户端竞争；无 Node PATH 环境下 Live/File 均工作，File 不启动 GUI/WebView。

### MG10 打包、更新和渠道隔离

- 固定 bundle、slug、版本、build、架构、输出及更新 tagPrefix；构建后从包内读取并核对。
- 独立检查 `mygo-v` 渠道、比较版本并打开受信发布页，用户保存工作后手动下载和安装 DMG。
- 后续持续采用 arm64、ad-hoc、手动 DMG 路线。实际 codesign 完整性、架构、摘要和包内容校验继续作为发布门禁。
- 自动下载、进度、稍后自动安装、保存后自动替换、更新包签名链和失败恢复状态机不纳入本次交付。Apple Developer ID 签名及公证不作为当前路线的前置条件。
- 自动化验证版本和渠道选择、受信来源以及实际发布制品的架构、签名类型和摘要。Gatekeeper 与人工手动安装提示由用户验收并作为非阻断待办记录。

验收：DMG/app/更新归档同源、签名范围真实、没有 Node/Chromium；原 Electron/Web 的资产、Latest 路由和安装脚本保持正确。

2026-11-11 用户确认当前手动安装最低交付方式，并将 ad-hoc 作为持续发布路线。build 13 的已归档实现具有 `mygo-v` 查询、版本比较、受信发布页与手动 DMG 安装。更新清单标记 `updaterConsumed=false`、`automaticReplacement=false`。原计划中的自动下载与替换范围按本次指令移出本次交付，实际实现边界在发布说明中保留。

### MG11 体积与性能优化

- 完整 arm64 app 以 25–40 MiB、DMG 以 12–25 MiB 为工程目标，约 30 MiB app 为努力方向，不把 15.3 MiB 探针当完整包承诺。
- 超出 40 MiB app 或 25 MiB DMG 时先给出模块/资源构成、依赖和优化结论，不通过删功能或运行时下载依赖达标。
- 检查重复依赖、字体/资源、无用构建数据、大对象过桥、列表/脑图重复计算；共享优化须回归 Electron/Web。
- 与正式 Electron 2.0.0 在同机同数据上比较冷暖启动、总进程内存、空闲 CPU/唤醒、编辑/搜索 p95、附件峰值和退出时间。统计 MyGO 主进程、WebContent、GPU、Network 和 Go helper，不能只报 Go heap。

验收：性能原始数据可复现；编辑/搜索或稳定内存退化超过 20% 进入阻断复核，原因和处理在 RC 前闭环。冷启动与其他指标在 M0 取得基线后冻结目标，不预先宣称倍数提升。

### MG12 三端回归、实机与交付证据

- 保留当前 npm check、共享契约、Electron 和 Web 回归；增加 Go 测试、跨语言语料、MyGO 真正 WKWebView 运行时和包内验收。
- JS 纯函数测试可复用，依赖 Electron/CDP 的运行时脚本须适配，不能改名字后视为已覆盖 MyGO。
- 记录自动化 MCP 与跨宿主交互。真实输入法、Finder/系统剪贴板/拖放、iCloud、AI provider、Gatekeeper 和两台物理 Mac 的人工交互由用户验收，保留非阻断待办。
- 建立实施、验收、缺陷、性能、发布说明及制品验证记录；均对应 commit、build、环境和 SHA-256。

验收：本计划矩阵逐项有通过/失败/待测及证据；未测不计为通过；历史 Electron 豁免不自动适用于新增客户端。

## 6. 桌面桥覆盖清单

基线为现有 preload 的 36 个成员；新增接口另行记录，保留返回值、事件退订、取消和错误语义。

| 分类 | 数量 | 成员 |
| --- | ---: | --- |
| 本地附件 | 7 | scanAttachments、cleanAttachments、importAttachments、cancelAttachmentImport、readAttachment、saveAttachment、openAttachment |
| 附件同步 | 3 | syncAttachments、cancelAttachmentSync、onAttachmentSyncProgress |
| 工作区归档 | 2 | exportWorkspaceArchive、importWorkspaceArchive |
| iCloud/自动备份 | 11 | saveICloudBackup、loadICloudBackup、getBackupStatus、setBackupAuto、pauseBackup、enqueueBackup、inspectBackup、replaceBackupWithLocal、acceptBackupBaseline、onBackupFlush、finishBackupFlush |
| Live MCP | 5 | getLiveMcpState、startLiveMcp、stopLiveMcp、onLiveMcpRequest、onLiveMcpRevoke |
| 更新 | 3 | checkForUpdates、onUpdateState、onPrepareUpdate |
| AI 代理 | 2 | invokeAiProvider、cancelAiRequest |
| 正文同步代理 | 1 | invokeSyncRequest |
| 编辑/配置事件 | 2 | onEditCommand、onOpenApiConfig |
| 合计 | 36 | 所有成员均需正常、失败及适用的取消/关闭路径证据 |

## 7. 原 2.0.0 功能追溯

本版迁移既有能力，不重新定义原 R01–R14 产品语义。

| 原需求 | MyGO 工作包与验收重点 |
| --- | --- |
| R01 实时 MCP | MG02/MG04/MG09：草稿屏障、批准、回执、UI 刷新 |
| R02 差异依赖组、R03 操作追溯 | MG03/MG04/MG09：预览、部分接受、来源、恢复和持久结果一致 |
| R04 总结、R05 重排、R06 去重、R07 任务、R08 关系、R09 模板 | MG03/MG07/MG09：原有界面及算法、真实 provider、Go MCP 对等 |
| R10 并发合并、R11 节点冲突 | MG04/MG08：跨客户端收敛、结构竞争及冲突比较 |
| R12 附件原件 | MG05/MG08：跨实现分块、断点、校验和配额 |
| R13 增量追赶 | MG04/MG08：outbox、回执、checkpoint 和连续游标 |
| R14 同步历史与恢复 | MG04/MG08：补偿撤销、远端后续修改保留、历史恢复传播 |

## 8. 里程碑、依赖与工时

按一名熟悉 Go/React/macOS 的工程师粗估，外部账号、凭据及测试设备等待时间另计。不承诺具体日期；M0 结束后按实际风险更新估算。

| 阶段 | 主要交付 | 退出条件 | 估计人日 |
| --- | --- | --- | ---: |
| M0 架构与风险验证 | MG01；MG09 Go MCP 垂直样例；MG04 导入模型；MG10 渠道策略；MG11 基线 | 启动错误有结论、系统目标声明核对、并存隔离、无 Node 的 MCP 样例、测试语料和版本规则冻结，旧系统人工持久化由用户非阻断验收 | 4–6 |
| M1 / alpha.1 | MG02/MG03/MG04 主路径 | 四视图、编辑、保存、恢复、退出与普通导入可用；原 Electron/Web 回归通过 | 7–10 |
| M2 / alpha.2 | MG05/MG06/MG07/MG08；完整本机导入 | 文件/备份/AI/正文及附件同步形成闭环；并存和导入故障保护通过 | 9–14 |
| M3 / alpha.3 | MG09 全部 Go MCP，MG10/MG11 初版 | Live/File、所有工具资源 prompt、批准/幂等、无 Node 分发通过；全部承诺功能接通 | 12–20 |
| M4 / beta | MG12；MG10/MG11 完整包验证 | 三端、旧格式、自动化回归、性能及完整包检查收齐，真实服务/两设备/最低系统人工验收由用户非阻断跟踪 | 6–9 |
| M5 / RC 与正式候选 | 缺陷收口、文档、同源制品、发行验证 | 发布门禁全部满足，形成 Bike MyGO 2.0.0 可发布候选 | 3–6 |
| 合计 | 新增无 Node 的 MyGO 对等客户端 | 包含移植和回归，不重复叠加旧 Electron 开发量 | **41–65 人日，约 8–13 个工作周** |

关键顺序为身份/存储/协议冻结 → 桌面适配和本机安全提交 → 文件与同步 → 完整 Go MCP → 自动化验收、同源制品与发行。用户人工真机验收作为非阻断待办独立跟踪。Go MCP 的高风险垂直样例在 M0 执行，开发可交错进行，表中工作量已含联调和回归。

阶段名不是新的正式产品版本。候选可多轮迭代，但未完成的功能必须在候选说明中列出，不能用阶段发布替代最终对等交付。

## 9. 验收矩阵与资源预算

| 维度 | 必须覆盖 |
| --- | --- |
| 并存 | 两 app 同开、各自单实例、重开/更新/卸载、独立身份与锁；一端崩溃不伤另一端 |
| 本地数据 | v1/v2/v3；正常/备用/历史库；存储满、事务中断、回执丢失、重复导入和源端未同步 |
| 四视图 | 自动化主题、缩放、关系与导出检查。真实中文输入、系统剪贴板和物理拖放由用户非阻断验收 |
| AI | 两类现有端点与确定性 fixture 的取消/拒绝/部分接受/过期/无效输出，真实 provider 由用户非阻断验收 |
| MCP | 无 Node PATH；GUI 开/关；Live/File；只读/授权；多客户端、撤权、超时、重试和包内 CLI |
| 正文同步 | MyGO↔Electron、MyGO↔Web 的既有能力；同字段/移动/删除竞争、checkpoint、重复消息和远端后续编辑 |
| 附件 | 双端原件、续传、错误哈希、取消、配额、ENOSPC、隔离清理和历史保护 |
| 系统 | 系统目标与包内声明自动化核对，macOS 12/13、双物理 Mac、真实 Finder/剪贴板/iCloud/Gatekeeper 由用户非阻断验收 |
| 更新 | 原 Electron/Web latest 不变，MyGO tagPrefix 只读本渠道，受信发布页和手动 DMG 安装，实际包的架构/签名类型/摘要自动化核对 |
| 包体 | 生产 app 无 Electron/Chromium/Node/Bun 等随包运行时，无运行时下载安装依赖；MCP 完整可用 |
| 性能 | 同机同数据、总进程口径；冷暖启动、空闲、搜索/编辑、全部展开大纲/脑图和附件峰值 |

沿用既有共享限制：工作区 JSON 64 MiB；附件单件 128 MiB、单批 100 件/512 MiB；可预览图片 32 MiB/40,000,000 像素；操作包 4 MiB、outbox 32 MiB、checkpoint 累计响应 160 MiB、附件块 1 MiB；其余限制以 shared 中的当前定义为准。Go 与 JS 共用可对照的版本化限制，不各自复制常量后漂移。

固定性能样本至少包括 100 文档/20,000 主题、单文档 20,000 主题/50 次独立编辑、折叠及展开两种情形、大批提案和附件。编辑轮次按用户在 2026-11-11 的要求调整为 50。历史样本的折叠根节点结果不代表全部展开性能。

最低系统设备和真实服务等人工条件按用户 2026-11-11 指令保留待验，并移出发布阻断。自动化与用户人工验收分别记录证据，待验项继续保持实际状态。

## 10. 构建、CI 与发布门禁

### 10.1 当前检查入口

现有脚本及 MyGO 独立检查入口均已接入 package.json，职责如下。

- mygo:dev / mygo:build：开发与生产构建，版本/形态检查。
- mygo:test：Go 单元与集成测试，适用的包增加 race 检查。
- mygo:test:contracts：Go/JS 固定语料、schema、哈希、revision、限制和桥接返回值差分。
- mygo:test:runtime：真实 WKWebView、保存、关闭、输入和导出。
- mygo:test:mcp：无 Node PATH 的包内 stdio、Live/File 及真实客户端回归。
- mygo:test:interop：与原 Electron/Web/Sync Server 的数据、附件和冲突场景。
- mygo:dist:mac / mygo:verify:package：DMG/app、身份、架构、签名、依赖、摘要及版本渠道。
- mygo:measure：100 文档/20,000 主题和单文档 20,000 主题的六场景、每状态 50 次编辑，以及单独的大提案/128 MiB 附件峰值。

现有 npm run check 和 Electron/Web 运行时作为共享代码的持续回归。Go 测试能编译不代表真实 WKWebView 已测试；MyGO 启动通过也不代表旧产品没有回归。

### 10.2 正式候选门禁

1. 按本次交付范围完成 MG01–MG12、36 个桥接成员及 R01–R14 自动化检查，处理阻断性数据丢失、越权和更新串流缺陷。用户人工真机条目单独保留非阻断待办。
2. 当前修复源码重新形成同源 app、probe、DMG、tar 和清单。候选的源码、工具链、前端指纹及 build 一致，受影响的 MyGO/Electron/Web 自动化回归和独立远端 CI 通过。
3. 在没有用户 Node/npm 的运行环境中验证 GUI、文件、AI、同步、Live/File MCP；检查依赖、Mach-O/dylib 和子进程，不把网页 DOM Node 文字误判为 Node 运行时。
4. 原 Electron 的安装、profile、v2.0.0 标签和已发布资产不被覆盖；并存身份、备份和更新渠道经过实际检查。
5. 完整 app/DMG 的体积、性能和 ad-hoc 签名范围有实际记录，展开大纲长尾及其他性能阻断完成复核处置。持续采用手动 DMG 安装，自动下载与替换不纳入本次交付。
6. 包内 CLI、DMG 中 app、更新归档和发布清单核对一致；记录 SHA-256、版本、形态、build、架构和依赖。
7. 发布说明明确新增 MyGO 版、2.0.0 同版本并存、导入范围、旧端不受影响及安装/更新方式。
8. 用户已在 2026-11-11 授权其余缺陷处理后执行实际推送、独立标签、公开 Release 和资产上传，后续沿用该授权。完成其余阻断后推进发布，并验证公开下载和三条更新/安装路径。ad-hoc 路线及用户人工真机待办在发布说明中如实披露。

### 10.3 验证节奏

2026-11-11 按用户反馈调整执行策略。验证范围由改动影响和实际失败决定，复用未变模块的已有结果，并保留对应构建与证据来源。

- 局部修改执行类型检查和受影响的既有用例。相关修改成批收口后，再做一次对应模块集成验证。
- 性能定位先做 1–3 次编辑。方向确认后，仅对受影响场景执行 50 次正式测量。
- 共享完整回归、打包、原生全矩阵和跨宿主验收集中在阶段冻结或最终候选时执行。新的局部修改先更新影响范围。
- 测量工具失败先修复工具并重跑失败步骤，保留诊断记录。工具自身的问题单独归属。
- 新增测试限于既有覆盖遗漏的真实回归风险，优先扩展现有用例。临时性能和交互诊断保留在诊断工具中。

最终 stable build 15 已发布，源码为 `8d7cc9b69d425a454b8a8c18f2aeb013a3b4961b`。展开大纲同源各 50 次编辑均持久化成功，MyGO p95 1,701 ms、Electron 3,576 ms，通过退化门槛。MyGO 最大 7,049 ms，原始失败与极值继续保留。其余模块按实际构建复用证据，见[验证摘要](validation-mygo-2.0.0.md)。

## 11. 交付文档与开工清单

交付记录包括 implementation-mygo-2.0.0.md、acceptance-mygo-2.0.0.md、release-mygo-2.0.0.md、publish-verification-mygo-2.0.0.md、defects-mygo-2.0.0.md 以及对应证据目录。每项结果以实际构建和执行记录为依据。

- [x] 明确产品决策：新增 MyGO 2.0.0，保留 Electron/Web，最终 Mac 包无 Node。
- [x] 形成并存身份、数据、MCP、版本和更新渠道规划。
- [x] 保存既有最小探针的证据与限制。
- [x] 冻结实际开工基线并建立独立开发分支/worktree。分支为 codex/mygo-2.0.0，基线为 fd3f57ec6551e234d3aecbb1c9145c34684f9d2e，既有修改处置见实施记录。
- [x] 定位原探针启动错误，冻结默认持久 session、工具链和独立身份。
- [x] 建立 36 项桥接契约、Go MCP 全工具与 95 组固定写入差分。
- [x] 完成本机完整副本模型、闭合历史附件、一次性 Electron 源导出和跨库故障测试。
- [x] 记录正式 Electron 2.0.0 对照的 50 次性能基线及原始失败，实施共享布局修复并启动同源双宿主复测。
- [x] 生成同源 build 13 app/probe/DMG/tar，验证原生运行、包内 MCP、许可、签名和摘要。
- [x] 归档 build 13 的多格式导出、完整副本七阶段、跨宿主与 Live 双客户端结果，并注明 build 11/12 复用证据。
- [x] 完成 build 13 展开大纲 3 次局部诊断，保留长尾阻断及原始失败。
- [x] 完成展开大纲性能修复及受影响场景的 50 次同源对照，保留极限样本极值。
- [x] 用户确认持续 ad-hoc/手动 DMG 路线，自动下载与替换不纳入本次交付。
- [x] 用户已在 2026-11-11 授权处理其余缺陷后执行发布流程。
- [ ] 用户完成人工 macOS 12/13、真实输入法/文件交互/服务及第二台物理 Mac 验收，作为非阻断待办。
- [x] 将最终源码构建为同源制品，通过受影响回归、两组远端 CI 和严格包校验，并完成公开下载核验。
- [x] 按本次交付范围完成 M1–M5 开发、自动化验收与正式发布，用户人工验收另列非阻断待办。

最终 build 15 已完成源码、制品、远端 CI、包校验、安装启动关闭和本轮性能门禁，公开 Release 及三条渠道检查见[发布验证](publish-verification-mygo-2.0.0.md)。build 11/12/13 的未受影响模块按原归属复用，用户人工真机验收继续作为非阻断待办。

## 12. 当前依据

- [MyGO 可行性研究](mygo-feasibility-2026-11-10.md)与[真实探针证据](validation-mygo-2.0.0.md)。
- [已有 2.0.0 开发计划](development-2.0.0.md)、[验收](acceptance-2.0.0.md)、[更新说明](release-2.0.0.md)、[发布验证](publish-verification-2.0.0.md)。
- [桌面桥类型](../src/vite-env.d.ts)、[preload](../electron/preload.cjs)、[持久化](../src/storage.ts)、[版本历史](../src/versionHistory.ts)、[副本状态](../shared/bike-replica.mjs)。
- [MCP 服务](../mcp/bike-server.mjs)、[MCP 核心](../mcp/bike-core.mjs)、[Live store](../mcp/bike-live.mjs)、[原 Electron 更新检查](../electron/update-checker.cjs)、[Web 安装入口](../scripts/install.sh)。
