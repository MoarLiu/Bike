# Bike 1.6.1 发布验证

发布日期：2026-11-09。GitHub 发布时刻 2026-11-09 03:52:14 UTC，即北京时间 11:52:14。

- Release：[Bike 1.6.1](https://github.com/MoarLiu/Bike/releases/tag/v1.6.1)，标签 `v1.6.1`。
- 发布提交：`08c3bdec9a61810c0784ef2d666a9ed34499129c`。`main` 和标签在发布时均指向此提交；后续发布记录文档不改变该标签或制品。
- 候选 CI：[42558135046](https://github.com/MoarLiu/Bike/actions/runs/42558135046)，Linux/macOS 与 Node 兼容性作业全部通过。
- 同提交 `main` CI：[42558321666](https://github.com/MoarLiu/Bike/actions/runs/42558321666)，三个作业全部通过。
- 同提交标签 CI：[42558324242](https://github.com/MoarLiu/Bike/actions/runs/42558324242)，三个作业全部通过。
- Release 已公开，非草稿、非预发布，并已设为最新版本。未登录访问发布页返回 HTTP 200。
- 六项资产均上传完成，GitHub 服务端 SHA-256 与本地逐项一致。
- 发布后重新下载全部六项资产，与本地逐字节一致；下载目录中的 SHA256SUMS-1.6.1.txt 全部核验通过。

## 资产

| 文件 | 字节数 |
| --- | ---: |
| `Bike-1.6.1-arm64.dmg` | 136184535 |
| `Bike-1.6.1-arm64.dmg.sha256` | 87 |
| `Bike-1.6.1-arm64.dmg.blockmap` | 141654 |
| `Bike-Web-1.6.1-sync-server.tar.gz` | 3777242 |
| `latest-mac.yml` | 337 |
| `SHA256SUMS-1.6.1.txt` | 458 |

DMG SHA-256：

```text
ee3cb105f282bd77eb8de699cbe3b8b9465567ea06c1f25738f13c86ddc4b99a
```

Web/Sync/MCP 部署包 SHA-256：

```text
4d3e2a912fb688854402269abe3b9a2d01028a60bb4c6c031e820a996bf617e0
```

部署包发布前补齐了 MCP core/server 与其依赖的 `electron/workspace-lock.cjs`，重新执行干净生产依赖安装、MCP stdio smoke、Web 登录、同步上传和覆盖升级后的数据保留验证，均通过。原本地候选 DMG 保持逐字节不变。

## 验证范围

- Node 22.13.0、22.22.2 本地各 326/326 通过；TypeScript、19 个公开 API 返回字段契约、共享模块导出契约、生产构建与 MCP smoke 通过。
- 正式 DMG 挂载后验证启动、CSP、单实例、主进程 AI 代理/取消、原生撤销重做、保存关窗与重开；包内 24 个运行时文件匹配源码/dist，不含测试文件；包内 MCP 模块真实导入和代码签名验证通过。
- 打包 Electron 固定样本的搜索和大文档内存结果，详见 [候选记录](candidate-1.6.1.md)及原始证据；修复索引缓存随撤销历史保留旧版本导致的内存增长。
- 沿用 arm64、ad-hoc 签名，未进行 Developer ID 签名或 Apple 公证。
- 原生中文输入法组合输入、完整布局矩阵、第二台设备 iCloud、Linux systemd/代理实机部署及未稳定复现的候选选择观察，继续保留 [更新说明](release-1.6.1.md) 中的边界。
- 用户原有 `docs/roadmap.md` 改动、`.workbuddy/`、`review/`、`docs/review-2026-11-08.md` 未纳入本次提交或发布。
