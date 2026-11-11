# Bike MyGO 2.0.0 发布验证

更新于 2026-11-11，时区为 Asia/Shanghai。当前状态为本地候选，`published=false`。用户已在 2026-11-11 授权其余缺陷处理后执行发布流程，包含提交、推送、独立标签、公开 Release 与资产上传，后续沿用该授权。

持续发布路线为 ad-hoc 签名和手动 DMG 安装。用户亲自负责人工真机验收，相关证据保留待验并移出发布阻断。性能长尾、当前修复源码的同源制品、自动化回归、远端 CI 与严格包校验仍为阻断项。

## 本地制品

构建与验证记录位于 [验收记录](acceptance-mygo-2.0.0.md) 和 [build 13 证据](validation-mygo-2.0.0.md)。本地 preview 已归档，展开大纲性能阻断继续保留。最终正式候选须核对以下字段。

| 核对项 | 依据 |
| --- | --- |
| 版本、形态、build、bundle、平台、架构 | 包内 `--version`、Info.plist、build-manifest.json |
| 源码与前端 | sourceFingerprint、sourceFingerprintScope、frontendSHA256 |
| Mach-O 与签名 | arm64、minos、codesign 严格校验、真实签名类型 |
| 包内容 | app、挂载 DMG、复制 app、解压 tar 的完整内容指纹 |
| 摘要与清单 | SHA256SUMS、DMG/tar SHA-256、update-darwin-arm64.json |
| Node-free 运行 | 系统 PATH 下 GUI/服务/MCP，包内运行时扫描与 dylib |
| 开源许可 | Go、实际链接模块、前端依赖及字体的通知 |

当前候选的更新清单为本地完整性记录，安装方式为手动，更新包签名为 none。实际 ad-hoc codesign、架构、摘要和包内容检查继续执行。公开安装说明披露持续采用的 ad-hoc、未公证及手动 DMG 路线，Gatekeeper 人工体验由用户非阻断验收。自动下载与替换不纳入本次交付。

## 发布前阻断项

- [ ] 处理其余缺陷，将当前修复源码重新构建为同源 app、probe、DMG、tar 和清单，并完成 MG01–MG12 本次交付范围内的受影响自动化检查。
- [ ] 独立 MyGO workflow 在远端运行通过。
- [ ] 严格包校验、实际 ad-hoc 签名完整性、许可、架构、摘要与 Node-free 运行检查通过。
- [ ] 性能超过 20% 的退化完成原因复核与处置。
- [ ] 解决展开大纲长尾并完成受影响场景的 50 次对照。
- [x] 用户在 2026-11-11 给出处理其余缺陷后执行发布的指令，后续沿用该授权。
- [x] 用户确认持续 ad-hoc/手动 DMG 路线，自动下载及替换状态机移出本次交付。

## 用户人工验收的非阻断待办

- [ ] 用户验收 macOS 12/13 与第二台物理 Mac。
- [ ] 用户验收真实中文 IME、Finder、系统剪贴板、物理拖放、iCloud、真实 AI provider 及其他人工系统交互。
- [ ] 用户记录 Gatekeeper 提示、手动安装与实际启动体验。
- [ ] 用户复验当前构建携图 ZIP 的原生保存面板。build 13 交互超时保留，build 11 成功证据保留原归属，本地归档代码检查继续按影响范围执行。

## 已授权的发布执行检查

- [ ] 对明确允许的文件进行最终 diff 和状态核对，记录实际 commit。
- [ ] 建立独立 `mygo-v2.0.0` 标签和 Bike MyGO 2.0.0 Release。
- [ ] 明确设置该 Release 的 Latest 行为，核对原 Electron/Web 的选择结果。
- [ ] 上传匹配的 DMG、tar、清单与摘要。
- [ ] 从公开地址重新下载资产，校验字节和 SHA-256。
- [ ] 验证 Release 的非草稿可见性、版本、平台、形态和资产名。
- [ ] 真实运行原 Electron 更新检查、Web/Sync latest 安装和 MyGO `mygo-v` 查询三条路径。
- [ ] 在发布说明中列出用户负责的 Gatekeeper、手动安装和其他人工真机待办及当前证据状态。

公开下载、远端可见性和三条正式更新路径在当前记录中保持待执行。
