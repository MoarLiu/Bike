# Bike MyGO 2.0.0 实施记录

进度更新于 2026-11-11。stable build 15 已公开发布，标签为 mygo-v2.0.0，源码为 `8d7cc9b69d425a454b8a8c18f2aeb013a3b4961b`。范围依据[开发计划](development-mygo-2.0.0.md)，实际发布与验证见[发布验证](publish-verification-mygo-2.0.0.md)。

## 开工基线与产品身份

- 分支为 `codex/mygo-2.0.0`，开工基线为 `fd3f57ec6551e234d3aecbb1c9145c34684f9d2e`。正式产品源码已提交并由 `mygo-v2.0.0` 标签固定。
- 开工时已有 `.github/workflows/macos-signed.yml`、`README.md`、`package.json` 修改，以及 `.workbuddy/`、探针、审查和签名资料。保留既有内容，新增独立 MyGO 入口。
- 产品版本保持 2.0.0，独立 build 编号。stable 身份为 `com.bike.mygo`，preview 为 `com.bike.mygo.preview`。profile、备份目录、Live discovery、socket 和输出目录按通道隔离。
- 包内入口为 `Contents/MacOS/bike-mygo`。同一 Go 可执行文件支持 GUI、File MCP、Live MCP 和构建身份查询。更新只选择 `mygo-v` 版本链，当前采用 ad-hoc 签名和手动安装流程。

## 工具链与可复现源码

| 项目 | 当前约定 |
| --- | --- |
| Go | 固定 1.26.10，构建时 `CGO_ENABLED=0` |
| Go 官方归档摘要 | darwin-arm64 SHA-256 `0b5183492292ada170f9b561a834863808dd02edba599e4ad0e89899330020b3` |
| MyGO | v0.8.3，提交 `5add3817c74bb7505d0b473bc5fb28abe2201b99` |
| 源码锁 | `desktop-mygo/mygo-source.json`，同时冻结模块 h1 与 zip SHA-256 |
| 维护补丁 | 仅将上游 `go.mod` 的 Go 声明从 1.27.3 调整为 1.26.10 |
| JSON 模式 | `GOEXPERIMENT=jsonv2`，显式记录于产品配置和构建 manifest |
| Go MCP SDK | `github.com/modelcontextprotocol/go-sdk v1.8.0` |
| 前端运行桥 | `mygo-runtime 0.8.3`，根 lockfile 锁定 |
| CI | 独立 MyGO workflow，Go 1.26.10、Node 22.13.0、macOS 15 arm64 |

`scripts/prepare-mygo-source.mjs` 从已校验模块缓存或固定代理取得源码，验证两个摘要，应用单一声明补丁并复核缓存内容。依赖准备仅发生在开发/构建阶段。实际 app 包含编译后的 Go 程序与前端资源。

11 月 10 日首批 Go 1.27.3 产物的 Mach-O `minos` 为 13.0，曾阻断 macOS 12 目标。11 月 11 日采用上述兼容组合后，实际 Mach-O 和 plist 均为 12.0，本机严格包检查通过。旧结果保存在 [M0 历史证据](validation-mygo-2.0.0.md)。macOS 12/13 实机启动、存储与生命周期继续待测。实验性 JSON 模式和维护补丁是当前候选的明确约束。

## 已接通的生产路径

| 范围 | 实现与边界 |
| --- | --- |
| 前端适配 | `src/platform/mygo.ts` 对齐 Electron preload 和 TypeScript 的 36 个成员，复用原 React/共享业务代码 |
| 可信调用 | 仅绑定窄范围 `Invoke`/`Reply`，校验调用窗口、页面和 `mygo://localhost` 来源。生产 MyGO CSP 的网络连接限制为本源，外部 HTTP 由 Go 代理处理 |
| 窗口与生命周期 | 独立单实例、Dock 激活、窗口边界、外链、菜单、业务撤销、API 设置事件，关闭/更新等待草稿与备份回执，失败保留窗口和恢复线索 |
| 附件 | SHA-256 原件库、分块导入、原生文件选择、读取/另存/打开、缩略图、修复、保护清单、扫描票据、隔离和保留策略 |
| 归档 | 原工作区 ZIP 格式，有界解压、原件摘要/元数据验证、路径和特殊文件约束、原子导出，安装前完成归档校验 |
| 备份 | 默认关闭，独立 MyGO 目录、锁、基线哈希、外部变化暂停、重试/保留、保存来源验证和退出回执 |
| 网络 | 保存配置匹配、AI 两类端点、Sync 路径与查询白名单、拒绝重定向、超时、取消和响应预算 |
| 附件同步 | 原服务端协议、并发 2、1 MiB 分块、租约、持久续传、取消、完成回执和原件安装校验 |
| 更新 | 独立 tag 前缀、受信发布页和版本比较，显式手动安装路径 |
| 本地存储 | 继续使用原 IndexedDB/CAS/操作回执实现。完整副本使用跨库 journal、租约续期和崩溃收尾，历史/恢复/来源审计纳入原件保护 |

Go 文件服务的 JS↔Go ZIP 与实际 Node Sync Server 验证，包含 v1/v2/v3、回收站、原件、跨语言续传、坏摘要、取消、离线收敛、冲突及重启丢确认后的去重。完整本机副本额外的历史/审计附件单独做闭合清单和校验验证。

## 完整本机副本与源导出

完整副本带有单独的版本化 manifest 和内部摘要，保留正文、回收站、当前及孤立版本历史、恢复副本和来源审计。新客户端创建独立 actor，活动 outbox 为空，同步和自动备份初始关闭。偏好与 AI 密钥分别由用户选择。源审计、旧 outbox、冲突和回执作为只读归档保存，历史恢复通过正常的新操作提交。

当前产品可执行文件提供一次性源导出入口，实际产品路径验收复用 build 12 记录。用户先保存草稿并退出原 Electron Bike 2.0.0，然后明确选择已安装 app 和其真实 profile 路径。

```sh
"/Applications/Bike MyGO.app/Contents/MacOS/bike-mygo" \
  --export-electron-profile \
  --electron-app "/Applications/Bike.app" \
  --source-profile "/absolute/path/to/closed-electron-profile" \
  --output "$HOME/Desktop/Bike-local-copy.zip"
```

`--include-preferences` 与 `--include-credentials` 各自默认关闭。导出器取得关闭 profile 的新 inode 字节副本，校验源目录前后指纹，拒绝活动锁、打开句柄、特殊文件和并发启动。临时 app 复用用户已安装的 Electron runtime，加载独立离线读取器，Go 完成原件校验和 ZIP 原子安装。用户端 CLI 的 PATH 可以只含系统工具。构建时生成并嵌入读取器代码，产品源码指纹使用 `build-input-files-v2`。

严格 JSON-v2 桥对普通 JSON 对象保持原契约。可能携带孤立 UTF-16 的工作区、备份和 Live 载荷在内部边界改为 JSON 文本传输，前端再解析。相关字段由窄适配器处理，36 项公开桥成员一致。实际原生备份、归档和 Live Unicode 往返已取得证据。

## 共享布局修复

大纲 textarea 的初次布局、宽度和字体变化统一批处理高度重置、读取与写入。输入时同步调整高度，以维持链接弹层定位。20,000 行的浏览器验证已完成 50 次持久化编辑，原先双方展开大纲的 150 秒失败保留为基线。

脑图节点使用 React.memo 边界，连接线 JSX 随实际布局变化更新。浏览器诊断中一次草稿编辑从重绘全部 20,001 个节点降为一个节点，几何与连接线保持一致。build 12 原生 50 次展开编辑 p95 为 1,429 ms，同源重建 Electron 为 1,703.8 ms。

原生采样进一步定位到大纲父 Grid 的隐式轨道计算，父列表改为等价块流，每行原有内部 Grid 继续使用。build 11 冻结前端上的单属性 override 验证了 100 行完整矩形一致、20,000 行两次保存与重启读回。修复随后进入 build 12。任务勾选按钮移入既有文字 flex 容器，build 12 原生浅暗主题/双尺寸验证其为 22×28、与文字同排并可持久切换。

build 13 引入默认 React.memo 边界与按行状态复用的 WeakMap JSX 缓存。后续进一步稳定附件 Context、复用输入事件的同步高度测量，并让隐藏工具区保留占位且跳过子树绘制。悬浮、活动行、键盘焦点和已打开的 AI 菜单恢复正常显示。最终同源双宿主各 50 次编辑与回读通过，MyGO p95 1,701 ms，Electron 3,576 ms。MyGO 最大 7,049 ms，历史失败与极值保留。

共享 PDF 导出补上代码语言和多行正文，保留缩进与空行。完成任务使用 `[x]`。当前字体无法表示的字符使用可读 Unicode 标记，例如 `🙂` 输出为 `[U+1F642]`。build 12 的实际 PDF 已经过文本提取、字体/图像对象检查及白底 2× 渲染验证。

## Go MCP

File 提供 6 个读工具和 8 个写工具。Live 另提供 `get_proposal_status`。资源、动态文档资源、3 个资源模板、5 个 prompt 和文档 ID 补全使用冻结的原实现契约。

- File 默认 readonly。真实 v1/v2 写入需要显式 `--mode write`、`dryRun=false` 和匹配 revision，写前创建可恢复快照，原子替换并维护保留预算。v3 File 真实写入继续拒绝。
- Live 通过应用授权的私有 protocol-2 socket 获取读取屏障、提交提案和查询回执。真实写入需要 dry-run 身份，经 renderer 批准后使用原事务入口。状态查询、重复请求、摘要不一致、撤权和断开均有独立处理。
- Go 实现有序 JSON、UTF-16、canonical/digest、工作区迁移、树操作、Markdown、wiki/知识引用和返回预算。95 组固定 JS 写入差分语料覆盖 77 个成功预览与 18 个预期错误，另有读取、Markdown 和规范化语料。
- 用真实 stdio 客户端对照原 Node 服务，验证 schema、资源、prompt、补全、受控 File 写入、Live 候选摘要和幂等回执。测试子进程 PATH 不含 Node，检查未加载 WebKit/Electron。
- 对 SDK 自动添加的元数据与省略规则做窄范围 wire 适配，保持原公开契约。旧格式缺省 ID 在同一 File 服务会话内稳定。
- 修复共享 MCP 清空代码语言后，JSON 序列化确认参数丢失清空意图的问题。JS 和 Go 同时保留空字符串确认值，并以实际预览→序列化→确认回归验证。

删除最后一个根节点时产生的新占位节点 ID 仍采用原实现的随机规则。固定 ID 的差分用例与这类自动生成身份分别验证。复杂原始 Markdown 的来源定位继续采取保守策略，具体覆盖以语料和验收证据为准。

## 构建与本地验收入口

```sh
export BIKE_MYGO_GO="$(command -v go)"
export BIKE_MYGO_BUILD=15
export BIKE_MYGO_CHANNEL=stable
npm run mygo:test:contracts
npm run mygo:test
npm run mygo:test:race
npm run mygo:build
npm run mygo:test:mcp
npm run mygo:test:runtime
node scripts/verify-mygo-interop.mjs
node scripts/mygo.mjs package
npm run mygo:verify:package
```

以上为各类检查入口，按开发计划第 10.3 节选择受影响步骤。构建会核对产品版本、编译器、源码锁、Mach-O 最低版本、生产标志与构建输入指纹。Go、前端及字体许可放入签名包内。候选打包生成 DMG、tar、独立更新清单与 SHA-256 文件，严格验证会挂载 DMG、复制 app、解压 tar 并比对完整包内容。实际最终 build 和测试结果见 [验收记录](acceptance-mygo-2.0.0.md)。

```sh
"Bike MyGO.app/Contents/MacOS/bike-mygo" --version
"Bike MyGO.app/Contents/MacOS/bike-mygo" --mcp-file --workspace /absolute/path/to/workspace.json
"Bike MyGO.app/Contents/MacOS/bike-mygo" --mcp-file --workspace /absolute/path/to/workspace-v2.json --mode write
"Bike MyGO.app/Contents/MacOS/bike-mygo" --mcp-live
```

## 最终验收与用户待办

最终 build 15 完成同源构建、生产原生运行、严格包校验、复制安装后的启动早退/普通退出和两组远端 CI。原生完整副本 UI、多格式导出、跨宿主、源导出和峰值结果按 build 11/12/13 的实际归属复用。携图 ZIP 保存面板保留 build 11 成功与 build 13 焦点竞争超时的历史记录，当前人工复验由用户负责。

正式发布后的 Go 更新查询选中 mygo-v2.0.0，原 Electron 与 Web/Sync 安装下载路径选中 v2.0.0，公开下载和摘要检查通过。当前交付采用 ad-hoc 与手动 DMG。macOS 12/13、两台物理 Mac、真实中文 IME、Finder/系统剪贴板/物理拖放、iCloud、真实 AI provider、外部 MCP 客户端和 Gatekeeper 由用户亲自验收，按约定列为非阻断待办。
