# 本地优先架构设计

## 目标

本项目采用本地优先架构：用户的主要数据先保存在本机，应用不依赖登录、服务器或在线同步即可使用。iCloud Drive 用作用户可见、可备份、可迁移的文件通道，而不是服务端数据库的替代品。

当前代码基线：

- 前端：React + TypeScript + Vite。
- 桌面壳：Electron。
- 本地存储：IndexedDB，失败时退回 localStorage。
- 备份：Electron 写入 iCloud Drive 固定目录；浏览器版本优先使用 File System Access API，失败时引导用户导出工作区。
- 导入导出：JSON、Markdown、OPML、FreeMind、HTML。

## 架构原则

1. 本机是权威数据源
   - 编辑时只依赖内存状态和本地存储。
   - 自动保存写入 IndexedDB。
   - iCloud 文件是备份/迁移副本，不作为实时同步锁源。

2. 一份树形数据，多种视图
   - 大纲、脑图、演示都从同一个文档树渲染。
   - 不为脑图或演示维护第二份结构数据。
   - 样式和布局属于视图状态，不应破坏文档内容模型。

3. 开放格式可迁移
   - JSON 保存完整工作区。
   - Markdown、OPML、FreeMind、HTML 面向互通和分享。
   - 导入时做格式归一化，落到统一的 `OutlineDocument` / `OutlineNode` 模型。

4. 云能力可替换
   - iCloud Drive 只是一种本地文件夹同步方案。
   - 后续可以增加 WebDAV、Syncthing 文件夹、Dropbox 文件夹等备份目标。
   - 核心编辑器不应依赖具体云厂商 API。

## 数据模型

当前 TypeScript 模型如下：

```ts
export type ViewMode = "outline" | "mindmap" | "presentation";

export interface OutlineNode {
  id: string;
  text: string;
  note: string;
  checked: boolean;
  collapsed: boolean;
  color: string;
  children: OutlineNode[];
}

export interface OutlineDocument {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  nodes: OutlineNode[];
}

export interface Workspace {
  version: 1;
  activeDocumentId: string;
  documents: OutlineDocument[];
}
```

### Workspace

`Workspace` 是本地保存和工作区导出的顶层对象。

字段说明：

- `version`：数据结构版本，用于后续迁移。
- `activeDocumentId`：上次打开的文档。
- `documents`：用户全部本地文档。

建议后续扩展：

- `settings`：主题、默认视图、快捷键偏好。
- `folders`：文档分组。
- `trash`：软删除文档。
- `snapshots`：历史快照索引。
- `schemaVersion` 替代或补充 `version`，便于更细粒度迁移。

### OutlineDocument

`OutlineDocument` 是单篇文档。

字段说明：

- `id`：文档唯一标识。
- `title`：文档标题。
- `createdAt` / `updatedAt`：ISO 时间字符串。
- `nodes`：顶层节点数组，支持多个根主题。

建议后续扩展：

- `folderId`：所属文件夹。
- `tags`：文档级标签缓存。
- `favorite`：收藏。
- `deletedAt`：回收站。
- `viewState`：最近视图、滚动位置、选中节点。

### OutlineNode

`OutlineNode` 是编辑器最小内容单位。

字段说明：

- `id`：节点唯一标识。
- `text`：节点正文。
- `note`：节点备注。
- `checked`：任务完成状态。
- `collapsed`：是否折叠子节点。
- `color`：节点颜色标记，目前支持 `plain`、`blue`、`green`、`amber`、`rose`。
- `children`：子节点数组。

建议后续扩展：

- `createdAt` / `updatedAt`：节点级时间。
- `completedAt`：任务完成时间。
- `links`：解析后的文档链接缓存。
- `tags`：解析后的标签缓存。
- `attachments`：图片或文件引用。
- `order`：支持 CRDT 或跨设备合并时的稳定排序键。

## 本地存储

当前实现位于 `src/storage.ts`：

- IndexedDB 数据库名：`bike-db`。
- object store：`workspace-store`。
- key：`workspace`。
- 回退 localStorage key：`bike-workspace`。
- 自动保存节流：应用状态变化后约 250ms 写入一次。

### 保存流程

1. React 状态中的 `workspace` 发生变化。
2. `useEffect` 触发延迟保存。
3. 优先打开 IndexedDB。
4. 将完整 `Workspace` 写入固定 key。
5. 如果 IndexedDB 不可用，则序列化到 localStorage。

优点：

- 实现简单。
- 离线可用。
- 不需要文件权限。
- 工作区整体导出容易。

风险：

- 当前是整工作区覆盖写入，文档很多时写放大会变明显。
- localStorage 容量小，只能作为兜底。
- 没有事务级历史，误删后难恢复。
- 没有跨标签页并发协调。

### 建议演进

短期：

- 增加保存状态：保存中、已保存、保存失败。
- 保存前校验 `Workspace.version` 和必要字段。
- 加入基础迁移函数：`migrateWorkspace(raw): Workspace`。
- 对导入数据做 id 修复、颜色归一化、空节点兜底。

中期：

- IndexedDB 拆分 object store：`documents`、`settings`、`snapshots`。
- 文档级保存，避免每次写入全量工作区。
- 增加软删除和最近快照。
- 使用 BroadcastChannel 同步多窗口状态。

长期：

- 若需要跨设备自动合并，可引入变更日志或 CRDT。
- 节点顺序需要稳定排序键，不能只依赖数组下标。
- 附件应进入独立存储区，文档模型只保存引用。

## iCloud Drive 备份

当前实现分为 Electron 和浏览器两条路径。

### Electron 路径

`electron/main.cjs` 通过 IPC 暴露：

- `save-icloud-backup`
- `load-icloud-backup`

备份目录：

```text
~/Library/Mobile Documents/com~apple~CloudDocs/Bike
```

保存时写入两个文件：

- `bike-workspace.json`：最新备份。
- `bike-workspace-{timestamp}.json`：带时间戳的历史备份。

优点：

- 用户能在 Finder 和 iCloud Drive 中看到文件。
- 不需要接入 CloudKit。
- 适合个人备份和设备迁移。

风险：

- iCloud Drive 同步完成时间不可控。
- 多设备同时编辑同一个 JSON 会出现最后写入覆盖。
- 当前没有检测远端备份是否比本地新。
- Windows 和 Linux 不适用该路径。

### 浏览器路径

`src/backup.ts` 中优先调用 `window.bike`，旧版 `window.localOutline` 仅作为兼容别名保留。如果不在 Electron 中，则尝试使用 `showDirectoryPicker` 让用户选择可写目录。

限制：

- File System Access API 不是所有浏览器都支持。
- 浏览器不能稳定定位用户的 iCloud Drive 固定目录。
- 不支持时只能引导用户导出工作区 JSON。

### 备份策略建议

首版：

- 保留“手动 iCloud 备份”和“载入备份”。
- 展示备份文件路径。
- 备份前确保保存当前 IndexedDB 状态。
- 载入备份前提示会覆盖当前工作区。

下一步：

- 启动时检测 iCloud 最新备份时间。
- 如果备份比本地新，提示用户选择本地版本或备份版本。
- 保留最近 N 个时间戳备份，避免目录无限增长。
- 对备份 JSON 增加 `backupCreatedAt` 和应用版本。

谨慎项：

- 不建议首版做“自动双向同步”。
- 不建议直接监听 iCloud 文件并自动覆盖当前编辑状态。
- 不建议把 iCloud 文件当数据库频繁写入。

## 导入导出

当前实现位于 `src/exporters.ts`。

### 导出

文档级导出：

- `json`：保存 `OutlineDocument`，信息最完整。
- `markdown`：按层级输出 Markdown 列表，备注输出为引用块。
- `opml`：输出 OPML 2.0 大纲。
- `freemind`：输出 `.mm` 脑图格式。
- `html`：输出简单只读 HTML。

工作区导出：

- `bike-workspace.json`：保存完整 `Workspace`。

### 导入

当前支持：

- `.json`：识别 `Workspace` 或 `OutlineDocument`。
- `.md` / `.markdown`：解析一级标题、缩进列表和任务勾选状态。
- `.opml` / `.xml`：解析 `<outline>`。
- `.mm`：解析 FreeMind `<node>`。

导入后统一转换为 `OutlineDocument` 或 `Workspace`。

### 兼容性建议

短期必须补齐：

- 导入时运行 schema 校验和迁移。
- 导入文档时重建缺失 id，避免不同文件 id 冲突。
- 导入工作区时检查 `activeDocumentId` 是否存在。
- 文件名和标题去除非法字符，避免导出失败。

建议增加：

- OPML 导入兼容 `text`、`title`、`_note`、`_checked` 等字段。
- 导入报告：成功节点数、跳过节点数、错误原因。
- 测试用例覆盖幕布、FreeMind、常见 OPML 工具导出的样例。

## 视图层设计

### 大纲视图

大纲视图是唯一主编辑器，应优先保证：

- 输入焦点稳定。
- Enter / Tab / Shift+Tab / Backspace 行为可预测。
- 折叠后节点仍保留完整子树。
- 聚焦模式不改变树结构，只改变可见根节点。

### 脑图视图

脑图视图从 `OutlineNode[]` 派生：

- 输入：当前文档根节点，或聚焦节点。
- 输出：布局后的节点和连线。
- 交互：选中节点、展开/收起、居中。

后续如果支持脑图中拖拽换父级，必须调用同一套树操作函数，不能在脑图中直接维护独立结构。

### 演示视图

演示视图从文档树派生：

- 文档标题或聚焦节点作为标题。
- 一级节点作为章节。
- 子级节点作为要点。

首版可保持轻量。后续若加入演讲模式，应将页码、当前章节、全屏状态作为视图状态，不写入内容模型。

## 数据一致性和迁移

### 当前一致性规则

- 每个节点必须有 `id`。
- 每个文档必须有 `id`、`title`、`createdAt`、`updatedAt`、`nodes`。
- 工作区必须有至少一个文档。
- 文档必须尽量保留至少一个节点。
- `color` 只能使用白名单值，不合法时归一为 `plain`。

### 建议增加迁移层

新增 `src/migrations.ts`：

```ts
export const CURRENT_WORKSPACE_VERSION = 1;

export function migrateWorkspace(raw: unknown): Workspace {
  // 1. 校验对象形状
  // 2. 补齐缺失字段
  // 3. 修复 activeDocumentId
  // 4. 归一化节点
  // 5. 返回当前版本 Workspace
}
```

迁移入口：

- `loadWorkspace`
- `importDocument`
- `loadICloudBackup`

不要让 UI 组件直接信任外部 JSON。

## 冲突处理

首版定位是“手动备份”，冲突处理可以简单明确。

场景：

- 本地 IndexedDB 有较新编辑。
- iCloud `bike-workspace.json` 也有不同内容。
- 用户点击载入备份。

建议处理：

1. 读取备份的 `updatedAt` 最大值。
2. 读取本地的 `updatedAt` 最大值。
3. 如果备份覆盖本地，先自动导出一个本地恢复点。
4. 提示用户确认“载入备份会替换当前工作区”。

后续如果要自动同步，需要引入：

- 设备 id。
- 变更日志。
- 节点级更新时间。
- 冲突保留副本。
- 合并策略或 CRDT。

## 后续原生化路线

### 阶段 1：稳定桌面壳

- 完善 Electron 菜单：新建、打开、导入、导出、备份、撤销、重做。
- 注册系统快捷键。
- 使用原生文件保存/打开对话框。
- 在退出前确保保存完成。
- 打包 macOS 应用并处理权限说明。

### 阶段 2：文件夹级备份体验

- 在设置中显示 iCloud 备份目录。
- 支持更改备份目录。
- 支持打开备份目录。
- 支持自动清理旧备份。
- 支持从任意工作区 JSON 恢复。

### 阶段 3：原生文件模型

可评估从“一个工作区 JSON”演进到“一个文档一个文件”：

```text
Bike/
  workspace.json
  documents/
    doc_a.json
    doc_b.json
  attachments/
    image_001.png
```

优点：

- 单文档冲突更少。
- 大工作区写入更快。
- 更适合 iCloud Drive 同步。
- 附件管理更清晰。

代价：

- 需要文件索引和恢复逻辑。
- 删除、重命名、移动都要处理文件一致性。
- 浏览器版本无法无感操作整个目录。

### 阶段 4：移动端或 Apple 生态深化

如果继续走本地 Apple 生态：

- macOS/iOS 原生可考虑 SwiftData 或 SQLite。
- iCloud 可考虑 Document-based App 或 CloudKit。
- Web/Electron 版本仍保留 JSON 导入导出作为互通层。

不建议过早迁移。当前 React/Electron 版本更适合快速验证编辑器和信息架构。

## 开发清单

近期优先：

- 增加 `migrateWorkspace` 和导入校验。
- 载入 iCloud 备份前增加覆盖确认。
- 保存 iCloud 备份前生成本地恢复点。
- 文档搜索结果定位到节点。
- 增加撤销/重做。

中期优先：

- 文档级 IndexedDB 存储。
- 快照和回收站。
- 脑图缩放和图片导出。
- 反向链接和标签全局页。

长期观察：

- 多设备自动合并是否真的必要。
- 附件是否进入核心场景。
- 是否需要账号和云端协作。
- 是否迁移到原生 macOS/iOS 数据栈。
