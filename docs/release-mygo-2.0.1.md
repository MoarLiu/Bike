# Bike MyGO 2.0.1 更新说明

2026-11-13 发布候选，计划采用 macOS arm64 stable build 16，标签为 `mygo-v2.0.1`。正式包须在确认提交后，从干净源码工作区构建并完成安装包检查，当前尚未公开发布。

## 本次修复

- 沿用共享前端的保存、同步、草稿屏障、历史恢复、大纲虚拟化、弹窗焦点、Markdown 和导出修复。
- MyGO 附件传输自动分批并限制累计预算，原始网络 JSON 与 UTF-16 文本在桥接前后保持保真。
- Go MCP 的 Markdown 来源锚点依据实际语法位置确定，修复重复链接、CRLF、代码块和托管附件的来源匹配。补齐旧日期格式、File 读取边界和 Live 连接处理。
- 修复关闭前保存屏障、原生确认取消、窗口可见范围与过期 Live discovery。正式界面移除开发调试入口。
- ZIP 导入先检查中央目录边界，临时对象和备份附件按保留根清理。配置只有成功读取后才标记为已加载。

## 安装、数据与更新

正式安装包计划为 `bike-mygo-2.0.1-arm64.dmg`，应用身份为 `com.bike.mygo`，继续使用 `Bike-MyGO` 数据与备份目录。现有 `Bike MyGO Preview` 候选使用独立身份，不能作为正式更新包上传。

包内运行无需 Node，工具链固定为 Go 1.26.10、`GOEXPERIMENT=jsonv2` 与 MyGO v0.8.3。最低系统声明继续为 macOS 12.0。

升级同步前先保存并导出完整 ZIP、关闭旧客户端、备份并升级服务端，再统一更新所有客户端至 2.0.1。新旧操作分别使用对应版本的排序算法，旧客户端的节点同步请求会收到 HTTP 426。完整顺序见 [Bike 升级说明](release-2.0.1.md#部署与升级顺序)。

继续采用 ad-hoc 签名与手动 DMG 安装，未经过 Developer ID 签名和 Apple 公证。首次打开可能需要系统安全确认。`update-darwin-arm64.json` 用于发布完整性核验，`updaterConsumed=false`、`automaticReplacement=false`。

## 验证与边界

Go internal 测试、race、全部命令编译、36 项桌面桥契约及跨实现协议检查通过。当前主机的 WKWebView 四视图、持久化、UTF-16 备份、网络代理、原生 Live 审批与取消关闭验证通过。

20,000 主题的原生布局样本首屏挂载 31 行、末端 35 行，4 次独立编辑全部在重启后回读。真实导出检查覆盖 14 份文件和 16 份视图截屏，包括 PDF、SVG 和 PNG。样本仅代表本机受控场景。

正式 stable 制品仍须在提交后验证源码指纹、构建号、ad-hoc 签名、只读 DMG 挂载、复制安装、tar 解压与 Node-free CLI。最终摘要和公开下载核验将在发布记录补齐。

真实输入法、macOS 12/13、其他物理设备、Finder/剪贴板/拖放、iCloud、真实 AI provider、外部 MCP 和 Gatekeeper 的人工体验继续列为验收边界。
