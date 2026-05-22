# Native Swift QA Checklist

## Persistence

- 启动 App 后会创建默认 workspace。
- 修改标题后等待 debounce，退出重开仍保留标题。
- `Cmd+S` 可立即保存。
- `Shift+Cmd+S` 可创建快照。
- 仓库恢复快照前会自动创建 `before-restore` 快照；当前通过 `./scripts/test_all.sh` 覆盖。

## Backup

- 点击 `iCloud Backup` 后生成：
  - `~/Library/Mobile Documents/com~apple~CloudDocs/LocalOutline/localoutline-workspace.json`
  - `~/Library/Mobile Documents/com~apple~CloudDocs/LocalOutline/localoutline-workspace-{timestamp}.json`
- 备份 JSON 可被 Web 端工作区导入逻辑识别。
- iCloud Drive 不可用时，界面显示错误而不是崩溃。

## File Panels

- `openWorkspaceJSON` 只允许选择 `.json` 文件。
- 工作区 JSON 保存默认文件名为 `localoutline-workspace.json`。
- 通用导入面板仍允许 JSON、Markdown/plain text、OPML/XML、HTML 等导入格式。
- 选择备份目录时允许创建文件夹。

## Release Scripts

- `./scripts/test_all.sh` 通过。
- `./scripts/build_and_run.sh --verify` 能构建并启动 `Local Outline Native.app`。
- `./scripts/package_dmg.sh` 输出 `release/Local-Outline-Native-0.1.0.dmg`。
- 挂载 DMG 后可看到 `.app`，复制到 `/Applications` 后可启动。

## Regression Boundaries

- 本子项目不得修改根目录 Electron/Web 文件。
- 根目录 `scripts/`、`src/`、`electron/`、`server/`、`package.json` 不应因本任务产生 diff。
