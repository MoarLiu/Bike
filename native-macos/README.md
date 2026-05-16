# Local Outline Native

这是 Local Outline 的 macOS SwiftUI 原生重写版本，当前处于第一阶段 MVP。

## 运行

```bash
cd native-macos
swift run
```

也可以在 Xcode 中打开 `Package.swift` 后运行 `LocalOutlineNative`。

## 打包 Outline.app

```bash
cd ..
native-macos/scripts/package-outline-app.sh
```

默认会使用当前项目里的 CleanShot 图标素材生成 `OutlineIcon.icns`，并输出：

- `native-macos/release/Outline.app`
- `native-macos/release/Outline-arm64.zip`

当前包是 Apple Silicon / arm64，并使用本机 ad-hoc 签名，适合个人试用。

## 当前能力

- SwiftUI 原生窗口。
- 文档列表。
- 大纲编辑。
- 节点新增同级、子级、缩进、反缩进、上移、下移、折叠、勾选。
- 输入框快捷键：
  - `Enter` 新建同级主题。
  - `Tab` 降低层级。
  - `Shift+Tab` 提升层级。
  - `↑ / ↓` 切换主题。
  - 空主题 `Backspace` 删除。
- 右侧节点备注、颜色、待办状态。
- 本地自动保存到 `~/Library/Application Support/LocalOutlineNative/workspace.json`。
- JSON 工作区导入/导出。
- iCloud Drive 备份到 `~/Library/Mobile Documents/com~apple~CloudDocs/LocalOutlineNative/`。

## 数据兼容

原生版沿用 Web/Electron 版的 `Workspace` / `OutlineDocument` / `OutlineNode` JSON 结构，便于后续互相导入导出。

## 下一阶段

- 做成标准 `.app` bundle 并加入图标。
- 补撤销/重做。
- 补右键菜单。
- 补脑图视图。
- 补 Markdown / OPML / PDF 导出。
