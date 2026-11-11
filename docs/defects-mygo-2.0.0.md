# Bike MyGO 2.0.0 缺陷与复核

更新于 2026-11-11，时区为 Asia/Shanghai。状态以实际复测为准，发布门禁见 [验收记录](acceptance-mygo-2.0.0.md)。

MYGO-12 至 MYGO-16 的 review 修复已包含在正式 stable build 15，源码提交为 `8d7cc9b69d425a454b8a8c18f2aeb013a3b4961b`。当前交付范围的发布门禁已完成，用户人工验收按非阻断待办继续记录。

| 编号 | 问题与证据 | 处理与状态 |
| --- | --- | --- |
| MYGO-01 | 原探针 Page.Eval 语句块触发表达式编译失败及重试，出现通用 Script error | 诊断宿主改用显式异步表达式。正常路径无错误，旧方式对照保留一次预期错误，已闭环 |
| MYGO-02 | Go 1.27.3 产物 minos 为 13.0，与 12.0 目标冲突 | 固定 Go 1.26.10/jsonv2 和已校验维护补丁。Mach-O/plist 实测均为 12.0，物理 12/13 待验 |
| MYGO-03 | MCP 清空 codeLanguage 后，序列化确认参数丢失空字符串意图 | JS/Go 同时保留空值确认参数，实际预览→序列化→确认及固定差分通过，已闭环 |
| MYGO-04 | 严格 JSON-v2 对象边界可能改变工作区、备份、Live 中孤立 UTF-16 | 内部边界使用原 JSON 文本，前端窄适配解析。实际原生备份/保存/Live Unicode 往返通过，已闭环 |
| MYGO-05 | 完整副本历史/恢复/审计附件闭合集合与普通文本 SHA-256 混淆 | 使用结构化 assetId 和元数据清单识别引用。11 原件、14 类坏副本与跨语言扫描通过，已闭环 |
| MYGO-06 | 正式 Electron 对照与早期 MyGO 展开大纲超时，修复挂载后仍有编辑长尾 | 继续修复高度重复测量、附件 Context 与隐藏工具子树绘制。最终同源各 50 次回读成功，MyGO p95 1,701 ms、Electron 3,576 ms，退化门槛通过。MyGO 最大 7,049 ms，保留两次极值与历史失败，见[性能记录](validation-mygo-2.0.0.md) |
| MYGO-07 | 旧原生展开脑图编辑 p95 2,006 ms，对正式 Electron 1,648 ms 高 21.7% | 共享节点 memo/连接线缓存进入 build 12。该版原生 50 次编辑 p95 1,429 ms，同源重建 Electron 为 1,703.8 ms，低约 16.1%，此项复核收敛。正式发行旧基线与同源重建对照分别保留 |
| MYGO-08 | build 11 首轮附件峰值观测器无法替换冻结的 MyGO runtime，记录到零块并误报 | 改为 Go 侧透明转发观测，build 11/12 重测均通过 128×1 MiB、全原件/重启/隔离及进程清理，已闭环 |
| MYGO-09 | PDF 遗漏代码正文，缺字字符映射为方框或其他字符 | 添加语言与多行代码，完成状态使用 [x]，缺字显示 Unicode 标记，build 12/13 实际 PDF 提取/渲染通过，已闭环 |
| MYGO-10 | 原任务按钮占满大纲一列，主题文字换行 | 既有按钮移入文字 flex 容器并复用尺寸。build 12/13 浅暗主题/双尺寸均为 22×28 同排，真实 UI 切换持久通过，已闭环 |
| MYGO-11 | build 13 在重启后立即请求退出，20 秒等待超时 | 增加关闭订阅就绪握手，仅对明确 loading 回执在原 15 秒预算内重试。定向边界回归通过，build 15 复制安装的早退与普通退出自然结束，约 171 ms / 173 ms。已闭环，旧失败保留 |
| MYGO-12 | P1，附件备份准备期间到达的外部云端正文可能被覆盖 | 提交阶段继续核对初始 hash 与存在性，最终目标变化统一暂停并保留 pending，成功修订与 ticket 保持原值。修改/创建/删除、显式替换、正文无变化及最终 flush 期间变化的定向回归通过 |
| MYGO-13 | P2，关闭准备的 busy 状态阻止最新自动备份入队 | 仅允许关闭锁下的权威保存入队并排空备份，核对最终语义哈希的成功回执。失败释放编辑锁，暂停/禁用/冲突边界仍生效。双 bridge、旧任务在途、失败重试与最终 revision 的回调回归通过 |
| MYGO-14 | P2，Go TrimSpace 与 JS trim 差异改写节点 ID，造成知识链接悬空 | 六处摄入归一化复用 TrimJS。U+0085、U+FEFF、JS 空白及 v1/v2 真实写入回归通过，修复后独立 Go CLI 的原始复现探针确认 ID 与引用保持闭合 |
| MYGO-15 | P2，完整副本中断回滚后 React 偏好仍保留导入值 | 成功导入与中断恢复共用偏好重载，按恢复正文裁剪导航。正文加载临时失败时保留待刷新标记，重试成功后完成同步。回滚、完成及加载重试用例通过 |
| MYGO-16 | P2，页面失效或进程中断遗留分块上传，阻塞附件清理 | 上传绑定页面 context 与超时 timer，页面取消、崩溃、分离及退出均回收，旧回调核对上传实例。启动在取得单实例锁后仅回收上传临时普通文件。过期、重用 ID、遗留文件及页面准入的定向 race 回归通过 |

MYGO-06 已通过最终 50 次同源对照门槛，MYGO-07 沿用已完成的同源脑图对照，MYGO-11 已由最终安装包验证早退。极限大纲的偶发极值与人工 IME、旧系统、Finder、双物理设备和真实服务待办继续如实记录。

## Review 修复验证

本轮使用受影响的既有测试入口与实际回调，执行备份/AtomicFile、MCP 归一化及写入、附件/桌面清理 race、关闭和迁移恢复回归，以及 TypeScript 与差异空白检查。MCP 另使用修复后的独立 CLI 重放原始失败。

相关回归位于 [services_test.go](../desktop-mygo/internal/services/services_test.go)、[attachment_safety_test.go](../desktop-mygo/internal/services/attachment_safety_test.go)、[desktop_darwin_test.go](../desktop-mygo/internal/platform/desktop_darwin_test.go)、[model_test.go](../desktop-mygo/internal/mcp/model_test.go)、[write_vectors_test.go](../desktop-mygo/internal/mcp/write_vectors_test.go)、[app-update.test.mjs](../tests/app-update.test.mjs) 和 [local-migration.test.mjs](../tests/local-migration.test.mjs)。

云端并发验证使用隔离文件与确定性注入。AtomicFile 采用最终 stat 检查后 rename 的提交机制，真实 iCloud 多设备并发由用户人工验收。review 修复已包含在最终源码和安装包，定向回归、原生运行与严格包检查通过。
