# Bike 2.0.1 修复与验收

基线：575331f；分支 `codex/fix-2.0.1`；涵盖 2026-11-12 审查的 1 条 P0、12 条 P1、41 条 P2、70 条 P3，共 124 条。原有签名工作区改动保留并在原基础上修复。版本号统一为 2.0.1，尚未发布。

P0 原报告中的“永久”应理解为持续保存失败，并非不可逆的数据损坏；旧版本撤销触发序列后仍可能恢复，JSON 也是恢复出口。修复保持最高优先级。

勾选表示代码修复、事实核正或兼容边界已逐项处理，不表示每一项都做过独立实机验收。含保留边界的条目单列说明；实际运行证据见文末。另已撤回旧 MyGO 报告 F-01：JS 和 Go 的整数型键 canonical 顺序一致，不能按该误报改坏摘要算法。

## 2.0.1 行为与容量

- v3 的本机保存不再受 4 MiB / 4,000 变更的单个 HTTP 请求门槛约束；有效工作区仍受既有 64 MiB、100,000 主题、256 层深度预算保护。完整逻辑提交上限 160 MiB，经校验分片后原子进入操作流。
- 大提交、文档顺序和排序引擎需要 2.0.1 Sync Server 能力。先备份并关闭旧客户端，升级服务器，再更新同空间客户端。新服务器拒绝未协商排序能力的旧节点同步请求（426）；新客户端也在启用空间前检查服务器能力。
- 首次连接遇到同 ID 不同内容，后台同步停止；手动同步需确认并先下载本机备份。原始候选进入冲突记录，丢失回执重试仍识别原 seed 身份。
- 节点同步 HTTP 请求以 `bikeOrdering=2` 协商引擎，Electron/MyGO 的路径白名单只放行这个确切参数，分页参数仍仅允许用于分页端点；附件传输不改变排序协议。
- 新操作带 `orderingVersion: 2`；已发出的 2.0.0 操作保持原内容和身份，按原引擎回放。跨引擎只修整内部锚点，保留可见树、逻辑时钟和 tombstone；必要时保留旧锚点用于恢复旧队列，不重写历史回执。冲突解决摘要按同一语义处理缺省字段。
- 普通 UI 保存不再新增永久幂等回执；显式请求回执保留，避免重复应用。只压缩从未开始网络传输的新副本队列，任何可能已发出的操作身份保持不变。
- Live 请求/响应上限统一为 80 MiB，提案只传变化文档；4 个并发任务之外返回忙碌错误，断开后可在原授权下重连，授权变化必须重新连接。输入标题期间读取返回忙碌，不强制失焦。
- 历史有效快照内容全局保留预算为 128 MiB，单文档仍保留数量/时间限制。单条损坏记录不阻塞健康快照，原始损坏值保留，不自动丢弃恢复材料。
- 关闭时第一次收到正常“忙碌”答复会保留窗口；再次关闭或桥接超时/损坏时出现原生确认，默认返回窗口。已关闭的窗口不再产生误导恢复记录。
- 备份清理以当前正文、保留的时间戳快照和当前附件清单为根。无引用云端附件先隔离 30 天；服务端维护默认预览，至少保留 30 天，并保护保留操作与旧基线引用。
- 浏览器 JSON 备份不包含附件二进制，界面会明确说明；完整附件迁移仍使用桌面 ZIP。浏览器文件夹备份使用唯一文件名。

## 执行顺序

1. 保存、操作投影、容量与同步协议
2. 前端提交、恢复、导航与交互
3. Live MCP、附件、服务端与部署
4. MyGO 契约、平台与性能
5. 导出、渲染、可访问性与性能
6. 签名、CI、2.0.1 版本与文档
7. 全量回归、运行时验证与逐项结案

## 问题清单

- [x] P0: 启用 2.0（v3）工作区后，普通编辑序列会让保存永久失败
- [x] P1-2.1 上一次会话新建的主题在下次重启的首次保存夹带默认字段伪变更；约 572 个未规范化主题即永久保存失败
- [x] P1-2.2 操作预算是本机保存的硬门槛，一次保存的差异超限即永久失败
- [x] P1-2.3 回执与 outbox 无淘汰，v3 工作区在数月使用后全面拒绝保存
- [x] P1-2.4 客户端对 checkpoint 文档做迁移，基线与服务器不一致 → 同步停摆与误冲突
- [x] P1-2.5 v3 同步不携带文档顺序：本机重排被回退，新建文档跳到末尾
- [x] P1-2.6 v3 同步在应用结果前不再刷新草稿，Markdown 草稿随后整篇覆盖刚合并的远端修改
- [x] P1-2.7 Live MCP 会话在空闲或并发上限处被销毁，两端都不重连，之后所有工具调用永久失败
- [x] P1-2.8 MyGO 附件同步缺少分批，附件总量超过 512 MiB 或 1000 个时永远失败
- [x] P1-2.9 主题菜单与脑图右键菜单无视口夹取（旧 P1 仍在）
- [x] P1-2.10 Web 形态在 2.0 失去全部 AI 与知识操作，入口却照常可点；Markdown 路径先发计费请求再必然失败
- [x] P1-2.11 安装器以 root 改写同步配置后服务用户读不到，重启即起不来
- [x] P1-2.12 未提交的验签脚本只读 stdout，而 `codesign -d` 与 `spctl` 的结果在 stderr，正确签名的产物必然判失败
- [x] P2-1: checkpoint 每页重复下发完整 manifest 与已删除文档正文：总量 ≈ 7.0×(N/1000)² MiB，N≈4.4k 触及客户端 160 MiB 预算；`normalizeOrder` 两次 `order.includes` 为 O(N²)；`getManifest` 同步阻塞（3000 文档约 80 ms/次，每页一次）
- [x] P2-2: 服务端附件对象没有任何删除路径，配额 2 GiB 硬编码不可配 → 累计后永久 507
- [x] P2-3: 陈旧写锁回收条件过严（需「满 10 分钟**且** pid 不存活」），pid 被复用或 Docker 中 PID 1 时永不回收；影响备份、MCP File 写入与服务端附件上传（服务端返回 400 且文案误导）
  - 结案说明：已增加进程出生标识（Linux 优先 procfs）及死进程立即回收；外部主机或旧锁无法证明失效时仍拒绝抢占，需管理员核实。
- [x] P2-4: 客户端 4 MiB 是估算值、服务端是真实请求体字节；超限操作会让 outbox 队头永久阻塞
- [x] P2-5: 首次接入时两端同 id 文档内容不同 → 本机版本被远端替换并整篇转冲突
- [x] P2-6: 每次保存的主线程成本随工作区整体大小增长（全工作区摘要、每次应用深拷贝全部文档与位置、同步逐条重放 outbox）
  - 结案说明：取消普通保存的重复全文请求摘要，只复制受影响文档，未发布队列可压缩，空同步短路；完整 IndexedDB 快照原子写入和必要的队列回放仍保留。
- [x] P2-7: v3 零改动同步也整体替换工作区并写 IndexedDB、递增 revision、广播（无旧路径的 `merged === current` 短路）
- [x] P2-8: 恢复历史版本不检查跨文档节点 ID 冲突，静默产生重复 ID，下次启动被重新编号，关系/链接绑定失配
- [x] P2-9: 提交在忙碌窗口被静默丢弃，而草稿仍被标记为已提交（v3 后台同步落盘窗口内 Markdown 输入会静默丢失；回车/缩进/标题同理）
- [x] P2-10: v3 同步期间切换文档：同步失败（副本 generation 不匹配）或成功后活动文档回跳、选中节点悬空
- [x] P2-11: Web + version≥2 工作区：冲突页两个按钮与备用副本页的全部操作、清空回收站、拉取、导入 JSON 全部失效（都要求先保存成功并写完整 ZIP）
- [x] P2-12: 多标签页活动文档互相跟随（纯导航即全量落盘 + 广播 + 对端全量重载），无法并排看两篇文档
- [x] P2-13: Live MCP 读取屏障每次调用都 `blur()` 标题输入并 flush，外部客户端连续读取会让正在编辑标题的用户反复失焦并产生一串中间态重命名
- [x] P2-14: `toggleSiblingCollapse` 整树克隆，20,000 主题下 12 次折叠/展开只保留 **2** 条撤销（58.6 MiB、中位 247 ms），逐出静默
- [x] P2-15: 「创建文档并链接」的提示与撤销行为相反（提示称新文档会保留，撤销实际删除且不进回收站）
- [x] P2-16: `workspaceRef` 镜像 effect 可能把 ref 回退到旧工作区（与 `replaceWorkspace` 的同步赋值重复）
- [x] P2-17: 预览内联正则在未闭合 `[` 上平方回溯，含大量 `[` 的长文本会让 Markdown 分栏每次按键卡死
- [x] P2-18: PDF 导出把应用自己插入的默认图标「★」渲染成 `[U+2605]`（`→`、`✓`、`℃`、日韩文、emoji、零宽空格同样缺失）
- [x] P2-19: 脑图 SVG/PNG 导出不过滤 XML 非法控制符：SVG 报成功但文件损坏，PNG 报英文原始错误
- [x] P2-20: 模态对话框不具备模态行为：焦点不进入、Escape 不关闭、Tab 落到背景；演示模式下空格会翻页而无法激活按钮
- [x] P2-21: 大纲视图无虚拟化：2 万主题时点击一行 1.35 s、失焦提交 2.4 s、打开菜单 1.6 s、导入到渲染 4.2 s（DOM 68 万节点）
- [x] P2-22: 无边框表格仍吞行、`<td>` 不按表头列数截断；`snake_case_name`/`2*3*4` 被渲染成斜体；有序列表渲染成 `<ul>`；URL 含括号时 href 被截断
- [x] P2-23: 同步安装流程默认可以 root 运行 systemd 服务（`BIKE_SYNC_SERVICE_USER` 缺省回退 `id -un`），非 systemd 路径（含 macOS）必然失败
- [x] P2-24: 数据库目录安全校验是过窄黑名单且会对该目录做 root `chown`/`chmod 0700`：`/var/lib`、`/usr/local`、`/srv`、用户家目录、`/etc/cron.d` 全部放行
- [x] P2-25: 附件 API 把内部错误与服务器绝对路径以 400 回传；锁竞争同样是 400（应为 503 可重试）
- [x] P2-26: Cookie 鉴权的内置同步 API 与登出没有 Origin/Content-Type 校验：带 Cookie 的跨站 `text/plain` POST 可把空间不可逆升级到协议 2（此后旧客户端全部 426）、可吊销全部会话
- [x] P2-27: 未鉴权请求可触发 500 与堆栈日志（如 `GET //[ ` 在认证前 `new URL` 抛错），可被用来刷 journald
- [x] P2-28: Live 提案把整个授权范围作为 `candidate` 回传，请求上限 4 MiB（响应侧却是 80 MiB）→ 授权范围 JSON 超过约 4 MiB 时 Live 写入与 `dryRun` 预览 100% 失败并断开连接
- [x] P2-29: 每次备份都在工作区写锁内重读并重哈希全部附件（源库 + 目标库各一次），随附件总量线性变慢并吃满 3 秒关窗预算
- [x] P2-30: `<iCloud>/Bike/attachment-manifests/<revision>.json` 每次内容变化写一份，从不读取也从不清理（MyGO 的 `backup.go:203` 同）；云端已删除附件的副本永不回收
- [x] P2-31: ad-hoc 签名下应用内更新是必然失败的路径：错误文案指向网络，`check-for-updates` 在安装阶段还报 `ok:true`，也没有「打开发布页手动下载」的回退入口
- [x] P2-32: 主进程网络代理跟随重定向（307/308 会转发请求体到白名单外路径），且「已保存配置」锚点读渲染进程 `localStorage`；目标地址无任何限制（可直连 127.0.0.1）
  - 结案说明：代理拒绝重定向；显式配置的 localhost/局域网服务继续支持。本机设置不是抵御已控制渲染进程的独立安全边界。
- [x] P2-33: `attachment-open` 用文档里的 `name` 决定扩展名、落盘不带 quarantine 属性后直接交给系统打开（等于为接收到的文件提供 Gatekeeper 绕过通道）；MyGO 相同
- [x] P2-34: 每次备份都把全部附件完整复制成 `.import-*.tmp` 写进 iCloud 目录（先复制后判断已存在），Electron 是先读目标、缺失才写
- [x] P2-35: `getBackupStatus` 把整个 pending 请求（含完整工作区 `json.RawMessage`）回传，前端每 3 秒轮询一次；Electron 只回 `{sourceRevision, sourceHash, ticket}`
- [x] P2-36: 同步操作体、旧版整文档 PUT、checkpoint 响应与 AI 请求体经 Go map 往返，没有沿用 MYGO-04 的文本保真通道：含孤立代理对的文本经 MyGO 同步后服务端与其他设备收到 U+FFFD，`resolutionBaselines` 摘要可能对不上
- [x] P2-37: 知识锚定用启发式替代 JS 的 Markdown 位置映射（`strings.Count` 唯一性判断、note 用 `Contains`），读输出漂移、写后显式引用永久失联
- [x] P2-38: 签名 workflow 的上传步骤用 `if: always()`，未通过核对的候选照样以 `bike-signed-<run>` 产出，与 `docs/signing-runbook.md:67` 的承诺相反
- [x] P2-39: 签名凭据（`CSC_LINK`、`CSC_KEY_PASSWORD`）是 job 级环境变量，对 `npm ci`、510 项测试、vite 构建与被测应用全部可见；公证三项 secret 是步骤级的（做法正确）
- [x] P2-40: 整条签名链路没有任何地方核对「期望的 Team ID」；CI 下预检对证书不做任何校验（p12 能否解码、密码、CN、有效期都不查）
- [x] P2-41: 同一仓库两条发布链（Electron/Web 的 `v*` 与 MyGO 的 `mygo-v*`）的隔离只靠发布时手工设 `Latest=false`，仓库内无脚本或 CI 断言
- [x] P3-1. 版本快照 20 MB/50 条是「每文档」上限、无全局预算：`src/versionHistory.ts:32-34,44`。
- [x] P3-2. `appendSnapshot` 用 `break` 截断，导致后续更旧快照无法补位：`src/versionHistory.ts:160`。
- [x] P3-3. 版本历史单条损坏会让整篇历史不可读写：`src/versionHistory.ts:46-70,209`。
- [x] P3-4. `pushWorkspaceToRemote` 的 `expectedRevision` 三元两分支等价：`src/sync.ts:579`。
- [x] P3-5. `deletedDocumentRevisions` 只写不读（死状态、无清理）：`src/sync.ts:446-450`。
- [x] P3-6. 浏览器回退的 iCloud 备份非原子、无版本保护：`src/backup.ts:34-39`。
- [x] P3-7. `updatedAt` 非法（如空串）的文档让首次同步永久失败（seed 抛「无效操作时间」）：`src/migrations.ts:94`、`src/operationSync.ts:87`；分片复现。
- [x] P3-8. 忙碌时删除文档、回收站命令静默 no-op（对话框已关闭，无反馈）：`src/App.tsx:2369,2399,2414,2423,5009`。
- [x] P3-9. `pruneNavigation` 恒返回新对象 → 每次提交多一次全 App 渲染 + 一次 localStorage 写：`src/App.tsx:1354-1360`；分片实测。
- [x] P3-10. `tagHits` 每次 render 全树遍历：`src/App.tsx:4290-4294`。
- [x] P3-11. stale 撤销条目只提示、不出栈，永久堵住其下所有历史：`src/App.tsx:2166-2169`。
- [x] P3-12. 每次保存仍全量扫描/解析 localStorage 备用副本并重算整工作区哈希；搜索「加载更多」按页重复全量扫描：`src/App.tsx:1049,1079,1465-1479`。
- [x] P3-13. API key 与同步设备密钥输入框声明 `autocomplete="current-password"`，存在被密码管理器自动填充的风险（浏览器行为待验证）：`src/App.tsx:5215,5331`。
- [x] P3-14. 脑图视口键盘处理形成焦点陷阱（Tab 无法离开、Enter/Backspace 改成改文档、内部按钮无法键盘操作）：`src/App.tsx:7190-7254,7355,7389`；分片复现。
- [x] P3-15. 预览里的远程图片在三种形态下都被 CSP 拦截且无回退说明：`src/App.tsx:6021-6025`、`vite.config.ts:16`、`server/auth-server.mjs:51`、`electron/main.cjs:49`。
- [x] P3-16. 同步间隔输入框无法正常键入（每次 `onChange` 规范化，输入 120 显示 15→152→1520）：`src/App.tsx:5356-5364`；分片复现。
- [x] P3-17. 主题菜单页脚两项信息不实（「编辑于」取渲染时间；「选中字数」数的是连续字母数字段）：`src/App.tsx:6683-6692,6830-6833`。
- [x] P3-18. HTML 携图导出的附件 URL 未转义（当前靠 `migrateDocument` 校验兜底）：`src/exporters.ts:147-151`；分片实测不可达。
- [x] P3-19. 脑图导出的附件类型判断比 PDF 宽（`startsWith("image/")` vs `isPreviewableImage`），HEIC/TIFF 会导致 PNG 导出整体失败：`src/mindMapExport.ts:61`、`src/exporters.ts:375`。
- [x] P3-20. 多处把引擎/服务商原始报错直接显示（`null` JSON 导入的 `'in' operator` 报错、AI 响应里第一段括号解析失败、服务商错误文本原样显示）：`src/exporters.ts:588`、`src/ai.ts:302-303,451,470`；分片复现。
- [x] P3-21. 关系目标下拉为整篇文档每个主题渲染 `<option>` 无上限；`targets` 每次渲染重新过滤映射：`src/components/KnowledgePanel.tsx:86-91,129,133-140`、`src/App.tsx:4870`。
- [x] P3-22. 缺 HSTS 响应头：`server/auth-server.mjs:59-64`、`server/sync-api.mjs:10-14`。
- [x] P3-23. `/healthz` 暴露 owner：`server/sync-server.mjs:136-143`；分片复现。
- [x] P3-24. 会话状态 rename 后未 fsync 目录（对比 `electron/workspace-lock.cjs:138`）：`server/session-state.mjs:56-76`。
- [x] P3-25. systemd 单元与环境变量未加引号：`scripts/install.sh:607-617`、`scripts/setup-sync-server.sh:149-162`。
- [x] P3-26. 部署包只比对同 Release 清单（无签名）；`install-sync-server.sh:36-38` 仍从 main `curl | bash`：`scripts/install.sh:355-377,384-401`。
  - 结案说明：引导固定到版本标签，先完整下载再执行；部署包继续以 GitHub HTTPS 与同 Release 摘要为信任边界，没有伪造独立签名密钥。
- [x] P3-27. JSON `null` 或非对象请求体导致 500（应为 400）：`server/sync-store.mjs:41-43`、`server/sync-api.mjs:183-188,260-266`；分片复现。
- [x] P3-28. 登录 429 的 `Retry-After: 30` 是固定值，与实际退避不符：`server/auth-server.mjs:400-405,387-388`；分片复现。
- [x] P3-29. 启动强制 `chmod(config,0600)` 使「配置只读/非本用户所有」的部署直接启动失败，且错误信息误导：`server/auth-server.mjs:87`、`server/sync-server.mjs:54`；分片用 `uchg` 复现。
- [x] P3-30. `releases/latest` 渠道解析没有 tag 前缀过滤，脚本会把 `mygo-v*` 拼成 `vmygo-v…`（当前 fail-closed）：`scripts/install.sh:293-297,343-351`。
- [x] P3-31. 「重新安装/更新」只 `systemctl start`，运行中的服务不会被重启（用户以为已生效）：`scripts/install.sh:652-658,686-696,709-713`。
- [x] P3-32. 同步配置解析错误被静默吞掉并用默认配置覆盖（丢掉已有 `deviceTokenHashes`/`databasePath`/`port` 等）：`scripts/setup-sync-server.mjs:102-108`。
- [x] P3-33. `configure` 完全不询问 `trustProxyHeaders`，反代部署下所有客户端共用一个失败限流桶：`scripts/setup-sync-server.mjs:189-214`。
- [x] P3-34. 无 systemd 时以 root 后台运行的拒绝只做了一半（`install_all` 仍先写 root 配置再抛错）：`scripts/setup-sync-server.sh:188-197`、`scripts/setup-sync-server.mjs:262`。
- [x] P3-35. 附件同步取消/中断留下的 `<userData>/attachment-transfers/*.part`、`bike-open-*` 目录无清理策略：`electron/attachment-sync.cjs:73,77,99,109`、`electron/attachment-ipc.cjs:20,106-113`。
- [x] P3-36. 错误信息脱敏漏掉 `resources/list` 与补全回调，仍回传本机绝对路径：`mcp/bike-server.mjs:150-162,470-487,506-523,545-553`；分片用 SDK `Client` + `InMemoryTransport` 复现。
- [x] P3-37. 附件库只要出现任何杂散文件（`.DS_Store`、崩溃残留的 `.<digest>.<pid>.*.tmp`），清理功能永久报错且无恢复入口：`electron/attachment-service.cjs:247-257,289-290,78-82`；分片复现。
- [x] P3-38. File 模式对 v3 工作区的 dry-run 仍宣称 `mode: "write"` 并给出 `confirmationArgs`，确认时才被拒：`mcp/bike-core.mjs:681-685`；分片复现。
- [x] P3-39. 未设置 `session.setPermissionRequestHandler`/`setPermissionCheckHandler`，Electron 默认放行权限请求：`electron/main.cjs`（grep 无命中）；静态推断。
- [x] P3-40. 死代码与测试缺口：`fetchLatestRelease`/`resultFromRelease`（`electron/update-checker.cjs:35-91`）、`safeReleaseUrl`（`electron/ipc-guard.cjs:21-27`）、`pruneStampedBackups`（`electron/main.cjs:493-510`）均已无运行时调用方但仍随包发布；`electron/preload.cjs:82` 的 `localOutline` 别名重复暴露；`mcp/bike-core.mjs:2135-2146` 把同一份数据同时放进 `content[0].text` 与 `structuredContent`，响应体积翻倍。
  - 结案说明：删除未使用的备份清理函数，发布查询与 URL 校验重新接入手动更新路径；localOutline 别名和 MCP 双表示保留旧客户端兼容。
- [x] P3-41. File MCP 的 `json`/`export_document` 输出仍绕过 `maxDocumentNodes`（旧发现仍在，新增 8 MiB 字节上限）；嵌套 children 的 1,000,000 字正文 + 2,000,000 字备注可落盘：`mcp/bike-core.mjs:1983-1991,2088-2106,2135-2138`、`mcp/bike-server.mjs:117-121`；分片复现。
- [x] P3-42. 缓存键 `mtimeMs:size` 可被同尺寸改写欺骗；`writeTimestamp` 可写任意历史时间：`mcp/bike-core.mjs:546,910-927,652`；分片复现。
  - 结案说明：缓存加入 inode/dev/ctime；writeTimestamp 继续是显式调用参数，用于确定性 dry-run 与确认重放，不视为服务器审计时间。
- [x] P3-43. 工作区深度上限两端不同：Go 载入即拒（256），JS 读到 10,000（只有 markdown/json 导出才用 256）：`internal/mcp/model.go:59` 对比 `mcp/bike-core.mjs:160`；分片用 JS 实测 257/300 层可读。
- [x] P3-44. 日期解析 `Date.parse` vs `time.Parse(RFC3339Nano)`：一条 trash 记录的非 ISO 时间就让整个工作区读不了：`internal/mcp/model.go:256-263`、`read.go:56-60`、`store.go:148-152`；分片 JS 侧实测差异。
- [x] P3-45. RE2 的 `\s` 只匹配 ASCII，代码围栏语言标签在非 ASCII 空白处与 JS 不同（元数据注释正则同样受影响）：`internal/mcp/markdown.go:116,350-351` 对比 `shared/bike-markdown.mjs:138`。
- [x] P3-46. 孤立代理对在 breadcrumb 与资源元数据里退化为 U+FFFD（MYGO-04 的保真只在 ParseJSON/Stringify 主路径成立）：`internal/contracts/json.go:371-380`、`internal/mcp/read.go:139-151,193-209`、`resources.go:61-67`。
- [x] P3-47. 元数据剥离前的校验比 JS 浅，可能「安全地」改写 JS 拒绝重写的元数据（丢掉来自更新版本 Bike 的元数据块）：`internal/mcp/markdown.go:360-381` 对比 `shared/bike-knowledge.mjs:1716-1729`。
- [x] P3-48. 差分断言与向量存在覆盖盲区：工具结果两侧都做键序无关比较、wiki 向量的 `nodeName`/`alias` 从不断言、所有 read/write 向量都绕过 zod 层、`workspace-normalization.json` 只有 3 例（无重复 ID/无深树/无 trash）、`desktop-mygo/tests/fixtures/mcp-manifest.json` 无消费者：`internal/mcp/read_vectors_test.go:55-56,108-112`、`write_vectors_test.go:60-72`、`scripts/mygo-contracts.mjs:74-94`。**这解释了为什么 3.6 与本节的多条漂移至今全绿。**
  - 结案说明：补充 Markdown 来源/连接、孤立代理字符、重复 ID、trash、深度、真实 RPC 参数和网络 JSON 回归；删除无人消费的旧 manifest 副本。整数键 canonical 向量原本已存在。
- [x] P3-49. 复杂度/内存峰值：`nodeByID` 无早退（每次按 ID 查找 O(N·depth) 分配）、`connections()` 每次为每个活文档跑两遍全文扫描：`internal/mcp/model.go:274-299`、`wiki.go:394-482,483-490`。
- [x] P3-50. 小漂移合集：Live 空标题文案、`updatedAt` 全零返回 epoch 0 而非 `null`、`listDocuments` 对非 ISO 时间的排序、`rename.go:335-345` 的解析基线差异：`markdown.go:171`、`store.go:156-160`、`read.go:46-71`；分片 JS 侧实测。
- [x] P3-51. secrets 存在性守卫 `test -n A && test -n B && test -n C` 在 `bash -e` 下只对最后一项生效（主审实测前项为空时继续执行并退出 0）；`NOTARY_KEY_ID`/`NOTARY_ISSUER`/`CSC_KEY_PASSWORD` 完全没检查：`.github/workflows/macos-signed.yml:33`。
- [x] P3-52. 预检判定偏松：`notarytool history` 失败只要不是「No Keychain password item」就降为警告；`security find-certificate -c` 取同 CN 的第一张（续期后可能读到旧证书）；entitlements 用子串判断：`scripts/preflight-signing.mjs:97-101,69,108,113`。
- [x] P3-53. 修好 P1 2.12 后验签仍有缺口：只要求输出含 `accepted` 而不要求 `source=Notarized Developer ID`；`.blockmap`/`.sha256` 与清单顶层 `path`/`sha512` 未核对；不核对包内 `Info.plist` 版本与 bundle id；`require('js-yaml')` 非声明依赖；runbook 示例把 App 专用密码写在命令行参数里：`scripts/verify-signed-release.mjs:59,104,15`、`docs/signing-runbook.md:34-35,79`。
- [x] P3-54. MyGO stable 构建不拒绝脏工作区，二进制里的 commit 可能与源码不符：`scripts/mygo.mjs:64,82,130-132`（`dirty` 只写进 manifest）。
- [x] P3-55. `git diff --check` 在干净检出上是空操作（查不到提交里的空白错误，也查不到生成物漂移）：`.github/workflows/ci.yml:33`、`mygo.yml:58`。
- [x] P3-56. 6 个仅渲染进程使用的依赖放在 `dependencies`，asar 里约 50 MB 是死重（本地 1.7.0 构建实测 `app.asar` 72.5 MB）：`package.json:54-66`。
- [x] P3-57. `.gitignore` 缺口：`.workbuddy/`（含 agent 记忆文件）、`review/`、`output/` 根目录未被忽略，一次 `git add -A` 就会入库：`.gitignore:1-21`；分片用 `git check-ignore` 实测。
- [x] P3-58. 测试体系：约 75–90 个用例（510 的 15–18%）跑的是手写 bindings 下的 `App.tsx` 片段，没有任何测试整体加载 `App.tsx`；`mcp:smoke` 不在 `npm test` 的 glob 内（由 `check` 与 CI 单独跑）：`tests/helpers/typescript.mjs:51-64`、`package.json:12-13`。
  - 结案说明：原 CI 已有整体加载 App 的真实运行脚本，本项原断言不成立；现补入 20,000 行、菜单、焦点与多标签页回归并接入 CI。片段单测继续作为补充。
- [x] P3-59. `mygo.yml` 的 push 触发仅 `codex/mygo-*`，合入 main 后直推 main 的 Go 改动零门禁：`.github/workflows/mygo.yml:4-5`。
- [x] P3-60. `cmd/` 下 5–8 个验收 harness 从不进 CI 编译，internal API 漂移推迟到手测才暴露：`mygo.yml:48-57`。
- [x] P3-61. race 测试不含 `internal/platform`：`scripts/mygo.mjs:44`。
- [x] P3-62. 4 个验收脚本硬编码 `release/mygo/2.0.0`；bindings 生成物漂移无 `git diff --exit-code` 门禁；路径过滤漏 `index.html`/`tsconfig.json`；包校验脚本无超时：`scripts/verify-mygo-mcp.mjs:19`、`verify-mygo-migration.mjs:171`、`verify-mygo-ui.mjs:22`、`verify-mygo-lifecycle.py:13`、`mygo.yml:7-16,58`。
- [x] P3-63. stable 通道的发布物是本地机构建（manifest `stage: local-candidate`），CI 只产 preview（已在文档披露，属已知接受边界）：`scripts/mygo.mjs:132`。
  - 结案说明：保留已明确接受的本地 stable / CI preview 分工；stable 新增干净源码门禁。本轮仅生成未发布的本地候选。
- [x] P3-64. 生产菜单暴露 View → Reload / Force Reload（框架 `RoleViewMenu`），误按 Cmd+R 会绕过关闭握手、静默撤销 Live 授权，并取消在途上传；DevTools 菜单项在正式构建下是空操作。这同时是「关闭握手无逃生通道」的事实出口：`desktop-mygo/internal/platform/lifecycle_darwin.go:102`（Electron 只在开发态提供，`electron/main.cjs:369`）。
- [x] P3-65. Live socket 目录硬编码 `/tmp`，崩溃后发现文件残留（启动时不清理），客户端只校验发现文件、不校验 socket 属主。多用户 Mac 上强杀后其他本机用户可重建同名 socket 冒充应用（前置条件多）：`internal/services/live.go:76,142-150`、`internal/mcp/live.go:65`；Electron 用每用户私有的 `os.tmpdir()`。
- [x] P3-66. `SyncURL` 对 `%2F` 的处理与 Electron 不一致：正则匹配解码后的路径，ID 含 `/` 的旧版文档接口被拒：`internal/services/network.go:91-104`；分片用 node 实测 Electron 的 `createSyncRequestUrl` 接受 `/api/documents/a%2Fb`。
- [x] P3-67. ZIP 条目数上限在整份中央目录物化之后才检查，构造归档可在导入时瞬时占用 GB 级内存：`internal/services/archive.go:147-153`（依据对 Go 标准库 `zip.NewReader` 的记忆，本机无源码可核）；Electron 用 yauzl 惰性读取并先看 `entryCount`（`electron/workspace-archive.cjs:92-96`）。
- [x] P3-68. `beginAttachmentUpload` 持 `desktop.mu` 等 `library.mu`，备份或缩略图正在哈希大文件时会拖住整个桥（秒级卡顿，未发现锁序反转）：`internal/platform/bridge_darwin.go:352-358`、`internal/services/attachments.go:247-291`。
- [x] P3-69. 临时文件与状态残留：`.import-*.tmp` 与 `.corrupt-*.bak` 崩溃后不回收（`RecoverUploads` 只清 `.upload-*.tmp`）；`loadLocked` 在读取前就置 `loaded = true`，设置文件损坏后任何 `SetAuto`/`Pause` 都会覆盖它；`Network.Cancel` 的 `cancelled` 表不限条数与 id 长度：`internal/services/attachments.go:470-491`、`backup.go:71`、`network.go:212-219`。
- [x] P3-70. 同步非 2xx 文本响应的形态与 Electron 不同：Go 返回 `{"text": 全文}`（最大可到 80 MiB），Electron 返回 `{message: 前 500 字符}`；反代返回 502 HTML 页时整页回灌给渲染进程：`internal/services/network.go:178-186` 对比 `electron/network-proxy.cjs:13`。

## 验证记录

2026-11-13 本地候选验证完成。所有应用验证使用隔离测试数据，不接触用户日常工作区。

- Node 22.13.0：完整 `npm run check` 通过（560 项测试、30 项共享返回契约、TypeScript/Vite 构建、MCP smoke、diff 检查）。
- 升级压力回归：`node scripts/verify-legacy-ordering.mjs` 从 575331f 读取旧排序与副本代码；5,932 个有效旧状态继续编辑及新旧操作交错全部通过，另 68 个被旧引擎拒绝的合法编辑序列在新引擎成功保存。固定旧数据样本已进入单测。
- Go 1.26.10 + jsonv2：internal 测试与 race 通过；全部 cmd harness 编译通过；真实二进制 14 个 File / 15 个 Live MCP 工具、资源与提示词同 Node 参考实现互操作通过。新增日期测试核对 ISO 的 UTC 语义、旧日期的本地时区、Date.toString 和 RFC 时区。
- Chromium：整体加载 App 的基础回归通过；20,000 主题只挂载 32 行、约 1,395 个 DOM 元素，滚动编辑、保存回读、菜单边界、25 次 Tab 焦点约束和双标签页独立导航通过。
- Electron：最终打包 App 的完整双进程 HTTP 同步、附件原件、字段冲突、撤销补偿、AI 部分接受/拒绝、MCP 审批/回执/重试、撤权、标题/备注/Markdown 草稿与组合输入保护的运行矩阵通过。
- WKWebView：无 Node PATH 下四视图、持久化、UTF-16 备份、AI/同步代理、原生 Live 审批/拒绝/重试通过。真实原生关闭确认选择“返回窗口”后数据保持不变，正常关闭屏障随后通过。
- 原生大纲：20,000 主题首屏挂载 31 行、末端 35 行；4 次独立编辑均持久保存并在重启后回读。当前主机展开 485 ms、4 次编辑中 p95（等于样本最大值）629 ms；不是跨设备性能保证。
- 跨宿主 HTTP：Go/JS 附件续传与修复、不同字段合并、可见同字段冲突、丢失回执、服务器重启、回执去重全部通过。
- 包内附件与更新：最终 Electron App 的附件导入、四视图显示、导出、重启回读、损坏修复与隔离清理通过；受控更新流程验证保存屏障、进度、签名错误解锁和重试。真实签名替换仍单独保留边界。
- 原生导出：WKWebView 的 14 份真实导出文件与 16 份视图截屏通过检查，涵盖文本、图片及 PDF/SVG/PNG。
- PDF：已渲染实际导出文件并目视核对，★、→、✓、℃、日文、韩文与单色 emoji 正常；代码、中文与页码无裁切。

## 本地产物

- Electron：`release/Bike-2.0.1-arm64.dmg`、`release/Bike-2.0.1-arm64.zip` 及各自 `.sha256` / `.blockmap`。已核对 51 份包内源码/构建文件、4 份字体及许可、更新清单和重算差分索引，并只读挂载 DMG、解压 ZIP 校验签名完整性及内容一致性。
- MyGO：`release/mygo/2.0.1/build-1-preview/` 下的 DMG、tar.gz、`SHA256SUMS` 和本地完整性清单。已验证 arm64、版本/构建号、ad-hoc 签名、Node-free PATH、只读挂载、安装副本及解压副本一致性。
- 两类产物均为本地候选，未发布。MyGO 使用隔离的 preview 身份；尚未从含未提交改动的源码构建 stable。
- 验收证据在被 Git 忽略的 `output/review-2.0.1/`、`output/playwright/`、`output/mygo/` 中。原生布局/导出为单独的诊断程序，未混入产品 App。

## 保留的验收边界

- 真实 Developer ID、公证与两版正式签名 App 的自动替换需要发布身份与凭据，本轮不将 ad-hoc 候选宣称为已公证产物。
- 原生运行脚本验证当前主机上的 WKWebView 与隔离数据；真实系统输入法、其他 macOS 版本、两台物理设备和真实付费模型账号仍不等同于受控测试。
- Linux systemd 安装按脚本测试与权限/路径分支核对；未对用户生产服务器做部署或清理。
- 工作区原有未提交文件继续保留；没有执行 Git commit、tag、push 或 GitHub Release 发布。
