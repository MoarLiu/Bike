# Bike 应用内更新

1.7.0 将桌面菜单和应用内的“检查更新”接入同一更新流程。

## 用户流程

检查稳定发布 → 确认下载 → 显示下载进度 → 稍后安装或重启安装。

选择重启安装后，应用先刷新草稿并保存到 IndexedDB 主存储，暂停编辑，再向主进程返回本次安装的保存回执。保存冲突、在途导入/同步/恢复、备用存储回退或 30 秒超时都会阻止安装。失败后可继续编辑并重试。

下载完成后选择“稍后”，可再次通过检查更新入口选择安装。下载和安装分别确认，普通退出保持用户选择。

## 实现与分发

- 使用固定版本 `electron-updater` 6.8.11，更新源为 `MoarLiu/Bike` 的 GitHub 稳定发布。
- `autoDownload`、`autoInstallOnAppQuit`、`allowPrerelease` 和 `allowDowngrade` 均关闭。
- 主进程控制检查、下载和安装，渲染进程仅接收状态和可信的保存请求。保存回执绑定当前窗口、主 frame 与一次性请求编号。
- macOS 使用完整应用 ZIP 和原生更新安装器。下载文件的 SHA-512 由更新器按发布清单验证，原生安装器执行签名校验。缓存和 blockmap 可用于更新器支持的差分下载。
- 本地构建显式设置 `--publish never`。正式签名流程生成 DMG、ZIP、两者的 blockmap，以及 `latest-mac.yml`。
- DMG 公证和 stapling 后重新生成 DMG blockmap 并刷新对应摘要，保留清单中的 ZIP 信息。ZIP 在应用公证后生成。

正式发布时应同时上传匹配版本的 `.dmg`、`.zip`、两者的 `.blockmap`、更新清单和校验文件。更新源及这些文件必须来自同一次候选构建。

## 兼容与验收

1.7.0 按确认范围使用 ad-hoc 签名。应用内检查、下载、进度和安装前保存流程已验证，macOS 原生自动替换要求签名兼容的应用。本版通过 DMG 手动升级，真实跨版本自动替换需要有效签名和对应版本验收。

旧版本的检查更新逻辑需要先通过安装新版本取得。Web 的更新入口继续用于查看部署发布信息。

本轮新增 14 项模块回归，覆盖重复请求合并、网络/下载失败、签名失败、保存失败、可信回执、超时及稍后安装。受控打包流程使用真实 `electron-updater` 实例，并替换检查、下载和退出方法，验证 UI、IPC、进度、草稿保存、编辑锁、安装失败解锁和再次尝试。

```sh
BIKE_ELECTRON_EXECUTABLE="/path/to/Bike.app/Contents/MacOS/Bike" npm run test:updates-runtime
```

受控流程结果位于被 Git 忽略的 `output/playwright/updates-1.7.0/results.json`。真实远端下载、签名替换、权限、重启和跨版本附件保留仍需在正式签名制品上验收。

实现依据为 [electron-builder 自动更新文档](https://www.electron.build/auto-update.html) 和 [Electron autoUpdater 文档](https://www.electronjs.org/docs/latest/api/auto-updater)。具体 API 和打包参数按仓库锁定版本的代码核对。
