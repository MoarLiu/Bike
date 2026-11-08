# Bike 1.5.0 开发文档：可靠编辑基础

状态：本机与制品验收完成，待发布门禁
基线：`v1.4.4`（`d9a79f5`）
更新日期：2026-11-08

产品定位：个人知识工具，以 Electron macOS 桌面版为主；本版本优先覆盖实际桌面菜单、快捷键、数据重启保留和最小窗口。

## 1. 目标

1.5.0 解决“改错之后回不去”的问题：误删、拖错、AI 改写、Markdown 重新解析、同步下载都要有明确的回退路径。这个版本不扩展新的内容类型，也不改变同步协议。

成功标准：

- 大纲、脑图、Markdown 中的结构化修改都能撤销和重做。
- 删除文档进入回收站，可以恢复或彻底删除。
- 每篇文档有本地版本历史，可以预览、比较并恢复；恢复操作本身也能撤销。
- 新数据字段与 Web、Electron、iCloud 备份、MCP 和 Sync Server 兼容，不丢失现有数据。
- 仓库具备自动 CI，每次推送和 PR 都运行类型检查、测试和构建。

## 2. 范围

### 包含

| 编号 | 功能 | 优先级 |
| --- | --- | --- |
| F1 | 撤销/重做：快捷键、工具栏、Electron 编辑菜单 | P0 |
| F2 | 文档回收站：移入、恢复、彻底删除、清空、自动过期 | P0 |
| F3 | 本地版本历史：自动/手动快照、预览、差异摘要、恢复 | P0 |
| F4 | 数据兼容：`workspace.trash` 在 Web、Electron 备份、MCP 写入中保留 | P0 |
| F5 | 工程基线：GitHub Actions、新增模块单元测试、新 UI 放入独立组件 | P0 |

### 不包含

- 撤销记录持久化：刷新或重启后撤销栈清空，长期回退依赖版本历史。
- 版本历史跨设备同步：快照只保存在本机 IndexedDB。
- 节点级回收站：删除节点通过撤销和版本历史恢复。
- 同步协议、Workspace `version`、MCP 工具接口的破坏性变更。
- 签名公证、附件、反向链接等 1.6.0 及以后内容。

## 3. 现状约束

- 用户编辑大多经过 `commitWorkspace(updater)`；同步结果、其他标签页刷新、导入和恢复备用副本直接调用 `replaceWorkspace`。这条边界正好区分“本机编辑”和“外部替换”。
- 工作区数据结构不可变，修改时生成新的文档对象，因此保存前后文档引用的成本很低。
- 大纲行与备注栏都有本地草稿，失焦时提交；撤销前必须先提交草稿，否则失焦会把旧文本重新写回。
- 同步通过 `documentFingerprint` 判断本机改动；被同步删除后本机重新出现的文档会作为本机修改恢复到服务端。
- `src/migrations.ts` 保留未知工作区字段，但 `mcp/bike-core.mjs` 只输出 `version`、`activeDocumentId`、`documents`。Electron iCloud 备份和 MCP 写入都使用后者，必须补齐 `trash`。
- PDF 相关依赖已经通过动态 `import()` 按需加载，构建中的大 chunk 警告来自懒加载包，不影响首屏，本版本不处理。

## 4. F1 撤销/重做

### 4.1 交互

- `Cmd/Ctrl+Z` 撤销，`Shift+Cmd/Ctrl+Z` 或 `Ctrl+Y` 重做。
- 顶栏增加“撤销”“重做”按钮，无记录时禁用；提示文字显示操作名称。
- 焦点在大纲节点输入框或非输入区域时，由 Bike 处理；焦点在标题、搜索框、备注、Markdown 源码和弹窗输入框中时，保留浏览器原生文本撤销。
- Electron 的编辑菜单和 `before-input-event` 统一发送命令到页面；键盘处理阻止默认事件及菜单快捷键再次执行，由页面判断执行 Bike 撤销还是原生文本撤销。
- 撤销后选中修改前所在的节点；如果节点不存在，则选中文档第一个节点。修改涉及非当前文档时切换到该文档。

### 4.2 数据结构

新增 `src/editHistory.ts`，不依赖 React：

```ts
type HistoryDocumentChange = { id: string; before: OutlineDocument; after: OutlineDocument };
type HistoryEntry = {
  group: string | null;
  label: string;
  at: number;
  changes: HistoryDocumentChange[];
  beforeSelection: { documentId: string; nodeId: string | null };
  afterSelection: { documentId: string; nodeId: string | null };
};
type EditHistory = { past: HistoryEntry[]; future: HistoryEntry[] };
```

- 采用全局操作栈。一次提交修改多个文档（例如跨文档剪切粘贴）时作为一个条目整体撤销。
- 只记录已有文档的内容变化；新建、删除文档和切换当前文档不进入撤销栈，删除由回收站处理。
- 最多保留 200 条；新的编辑会清空重做栈。
- 文字输入按 `text:<nodeId>`、`note:<nodeId>`、`title:<documentId>`、`markdown:<documentId>` 分组；同组、同文档且间隔不超过 1.5 秒的提交合并为一条。
- `commitWorkspace(updater, options)` 默认记录已有文档的内容变化；文字、AI 和历史恢复通过 `EditOptions` 显式传入名称与分组，避免无效操作或延迟草稿把分组遗留给下一次修改。

### 4.3 外部修改保护

撤销或重做前，逐个检查当前文档是否仍等于条目记录的结果：

- 引用相同直接通过。
- 引用不同则比较规范化后的内容签名（忽略 `updatedAt`、`markdownUpdatedAt`），兼容同步上传后服务端返回的等价文档。
- 文档缺失或内容不同，说明同步下载、其他标签页、导入或删除已经改变内容。此时拒绝撤销、清空撤销栈并提示用户，避免覆盖较新的内容。
- 导入工作区、载入 iCloud 备份、从服务端拉取、恢复备用副本和重新载入工作区时主动清空撤销栈。

撤销和重做写入的文档使用新的 `updatedAt`，让保存、同步和“最近编辑”都把它视为一次新的本机修改。

## 5. F2 文档回收站

### 5.1 数据结构

```ts
interface TrashEntry {
  id: string;
  document: OutlineDocument;
  deletedAt: string;
  originalIndex: number;
}

interface Workspace {
  version: 1;
  activeDocumentId: string;
  documents: OutlineDocument[];
  trash?: TrashEntry[];
}
```

- `trash` 是可选字段，不提升 Workspace `version`。1.4.4 Web 会原样保留未知字段；1.4.4 的 Electron 备份和 MCP 写入会丢弃回收站，但不会影响正常文档。
- 回收站只属于本机，不通过 Sync Server 同步。文档移入回收站后，同步仍按现有规则删除远端文档；恢复后按现有“修改优先于删除”规则重新上传。
- 回收站最多保留 100 条，超过 30 天的条目在删除新文档或打开回收站时清理。

### 5.2 规则

- 删除文档：从 `documents` 移到 `trash` 开头，记录删除时间和原位置；至少保留一个正常文档。
- 恢复：插回原位置（超出范围则放到末尾）并打开它。如果同 id 的文档已经因同步重新出现，恢复为新 id 的副本，标题加“（恢复）”，节点 id 同时重建。
- 彻底删除单条需要确认；清空回收站需要确认，并先下载回收站 JSON 备份。
- 回收站文档不参与搜索、标签、MCP 文档列表和导出单文档；导出工作区 JSON 和 iCloud 备份会包含回收站。

## 6. F3 本地版本历史

### 6.1 存储

新增独立 IndexedDB 数据库 `bike-history-db`，对象存储 `snapshots`，键为 `document:<documentId>`，值为该文档的快照列表。使用独立数据库，避免升级正在保护工作区 revision 的 `bike-db`。读改写在同一个 `readwrite` 事务中完成，多个标签页同时写入同一文档不会互相覆盖。

```ts
interface DocumentSnapshot {
  id: string;
  documentId: string;
  title: string;
  createdAt: string;
  reason: "auto" | "manual" | "before-restore" | "sync";
  nodeCount: number;
  signature: string;
  size: number;
  document: OutlineDocument;
}
```

### 6.2 生成时机

| 原因 | 时机 | 保存内容 |
| --- | --- | --- |
| `auto` | 本次打开后第一次修改该文档，以及之后每 10 分钟内的第一次修改 | 修改前的版本 |
| `manual` | 用户点击“保存当前版本” | 当前版本 |
| `before-restore` | 恢复历史版本之前 | 当前版本 |
| `sync` | 同步或拉取会改变本机文档内容之前 | 被替换的本机版本 |

与最新快照内容相同的版本不重复保存；回到较早内容时保留中间的历史记录。快照写入失败不阻塞编辑，只提示一次；手动操作显示错误，恢复前快照失败则取消恢复。

### 6.3 保留策略

- 每篇文档最多 50 个快照。
- 超过 60 天的快照会被清理，但始终保留最新 3 个。
- 每篇文档快照总大小不超过 20 MB，超出时从最旧的开始清理，至少保留最新 1 个。
- 文档彻底删除后快照暂不清理，仍受以上规则约束。

### 6.4 交互

- 顶栏“版本历史”打开当前文档的快照列表：时间、原因、标题、主题数量。
- 选中快照后显示前 120 个主题的层级预览，以及相对当前版本的新增、删除、修改主题数量。
- “恢复此版本”需要确认：先保存 `before-restore` 快照，再通过普通提交替换当前文档内容，因此可以立即撤销。
- 文档 id 和创建时间保持不变，恢复后的 `updatedAt` 为当前时间。

## 7. F4 兼容性

- `src/migrations.ts` 规范化 `trash`：丢弃无效条目，迁移条目中的文档，过滤非法时间和位置。
- `mcp/bike-core.mjs` 的 `migrateWorkspace` 同样输出 `trash`，保证 Electron iCloud 备份和 MCP 写入保留回收站；MCP 读工具只读取 `documents`。
- 从服务端拉取会替换本机文档，但保留本机回收站。
- 同步下载覆盖本机文档前写入 `sync` 快照，可以从版本历史找回同步前的本机内容。

## 8. F5 工程要求

- 新增 `.github/workflows/ci.yml`：Node.js 22.13.0、`npm ci`、`npm test`、`npm run build`。
- 新逻辑放在 `src/editHistory.ts`、`src/trash.ts`、`src/versionHistory.ts`、`src/documentSignature.ts`；新 UI 放在 `src/components/`，不继续扩大 `App.tsx` 中的组件定义。
- 新增单元测试：撤销合并、跨文档撤销、外部修改拒绝、回收站恢复冲突与过期、迁移、快照去重与保留、IndexedDB 读改写、MCP 保留回收站。

## 9. 验收清单

- [x] 大纲文字、结构、缩进、拖拽、删除、格式及跨文档粘贴可撤销/重做。
- [x] 连续输入按文档、节点和时间间隔合并，撤销后新编辑不合并到旧条目。
- [x] 标题、搜索框、备注和 Markdown 源码保留原生文本撤销。
- [x] AI 生成和润色可以撤销；受控响应验证，未调用用户真实接口。
- [x] 其他标签页更新后拒绝旧撤销；同步前快照期间有新编辑时保留本机内容。
- [x] 删除文档可恢复；同 id 已存在时恢复为副本，迁移后原始 id 保留。
- [x] 清空前下载备份；30 天过期与数量上限由核心模块处理。
- [x] 自动、手动快照可预览与恢复，恢复后可撤销。
- [x] 浏览器刷新、实际打包应用重启保留历史；两标签页并发保存快照不丢失。
- [x] 隔离 home 下的实际 Electron iCloud 备份和 MCP 写入保留回收站。
- [x] Node.js 22.13.0 本机测试、构建和 MCP smoke 通过；远端 CI 作为发布前门禁。

## 10. 任务拆分

| 顺序 | 任务 | 产出 |
| --- | --- | --- |
| 1 | 数据模型与迁移 | `types.ts`、`migrations.ts`、`bike-core.mjs`、迁移测试 |
| 2 | 撤销核心模块 | `editHistory.ts`、`documentSignature.ts`、单元测试 |
| 3 | 回收站核心模块 | `trash.ts`、单元测试 |
| 4 | 版本历史存储 | `versionHistory.ts`、fake IndexedDB 测试 |
| 5 | App 接入 | 提交记录、快捷键、Electron 菜单、同步快照、删除与恢复流程 |
| 6 | UI 组件 | `components/TrashDialog.tsx`、`components/VersionHistoryDialog.tsx`、样式 |
| 7 | CI 与文档 | `ci.yml`、README、CHANGELOG、发布说明 |
| 8 | 真实浏览器和打包应用验证 | 按验收清单逐项记录 |

## 11. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 撤销覆盖同步或其他标签页的新内容 | 撤销前验证当前内容等于记录结果，不一致则拒绝并清空 |
| 行内草稿在撤销后失焦，重新写入旧文字 | 撤销前先让焦点元素失焦并提交所有草稿 |
| 快照占用过多空间 | 数量、时间和容量三重限制；写入失败不影响编辑 |
| 旧客户端丢弃回收站 | 字段可选，不影响正常文档；发布说明提示升级所有设备 |
| 菜单快捷键重复执行 | Electron 中页面不直接处理快捷键，统一由菜单命令分发 |

## 12. 实施进度

| 任务 | 状态 |
| --- | --- |
| 开发文档 | 完成 |
| 1-7 | 完成 |
| 8 | 浏览器、DMG 实际应用与部署包验收完成；远端 CI 为发布前门禁 |
