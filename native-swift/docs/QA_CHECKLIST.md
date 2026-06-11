# Native Swift QA Checklist

## Persistence

- 启动 App 后会创建默认 workspace。
- 修改标题后等待 debounce，退出重开仍保留标题。
- `Cmd+S` 可立即保存。
- `Shift+Cmd+S` 可创建快照。
- 仓库恢复快照前会自动创建 `before-restore` 快照；当前通过 `./scripts/test_all.sh` 覆盖。

## Backup

- 点击 `iCloud Backup` 后生成：
  - `~/Library/Mobile Documents/com~apple~CloudDocs/Bike/.backups/bike-workspace.json`
  - `~/Library/Mobile Documents/com~apple~CloudDocs/Bike/.backups/bike-workspace-{timestamp}.json`
- 备份 JSON 可被 Web 端工作区导入逻辑识别。
- iCloud Drive 不可用时，界面显示错误而不是崩溃。

## File Panels

- `openWorkspaceJSON` 只允许选择 `.json` 文件。
- 工作区 JSON 保存默认文件名为 `bike-workspace.json`。
- 通用导入面板仍允许 JSON、Markdown/plain text、OPML/XML、HTML 等导入格式。
- 选择备份目录时允许创建文件夹。

## AI / Updates

- 菜单 `Bike > 配置API密钥` 可打开配置弹窗，保存协议端点、API baseurl、API key 和模型。
- 大纲模式：选中或悬停主题时出现 AI 按钮，可生成子主题或润色当前主题。
- 脑图模式：编辑主题时节点右侧出现 AI 按钮，菜单不应被兄弟节点遮挡。
- Markdown 模式：将光标放在主题行后，工具栏 AI 按钮可生成下级条目或润色当前行。
- 菜单和工具栏的 `检查更新` 可请求 GitHub Release，并能打开发布页。

## Release Scripts

- `./scripts/test_all.sh` 通过。
- `./scripts/build_and_run.sh --verify` 能构建并启动 `Bike Native.app`。
- `./scripts/package_dmg.sh` 输出 `release/Bike-Native-1.4.0.dmg`。
- 挂载 DMG 后可看到 `.app`，复制到 `/Applications` 后可启动。

## Regression Boundaries

- 本子项目不得修改根目录 Electron/Web 文件。
- 根目录 `scripts/`、`src/`、`electron/`、`server/`、`package.json` 不应因本任务产生 diff。
