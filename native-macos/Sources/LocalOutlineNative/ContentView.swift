import AppKit
import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: WorkspaceStore

    var body: some View {
        HStack(spacing: 0) {
            SidebarView()
                .frame(width: 250)

            Divider()

            VStack(spacing: 0) {
                TopToolbar()
                Divider()
                OutlineEditorView()
            }

            Divider()

            InspectorView()
                .frame(width: 300)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

struct SidebarView: View {
    @EnvironmentObject private var store: WorkspaceStore

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "list.bullet.indent")
                    .font(.title3)
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(Color.accentColor)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Local Outline")
                        .font(.headline)
                    Text("SwiftUI 原生版")
                        .foregroundStyle(.secondary)
                        .font(.caption)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)

            HStack {
                Button {
                    store.createDocument()
                } label: {
                    Label("新文档", systemImage: "plus")
                }
                Button {
                    store.deleteActiveDocument()
                } label: {
                    Image(systemName: "trash")
                }
                .help("删除当前文档")
            }
            .buttonStyle(.bordered)
            .padding(.horizontal, 16)

            List(selection: Binding(
                get: { store.workspace.activeDocumentId },
                set: { store.selectDocument($0) }
            )) {
                ForEach(store.workspace.documents) { document in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(document.title)
                            .font(.system(size: 14, weight: .semibold))
                            .lineLimit(1)
                        Text("\(TreeOperations.count(document.nodes)) 个主题")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .tag(document.id)
                    .padding(.vertical, 4)
                }
            }
            .listStyle(.sidebar)

            VStack(alignment: .leading, spacing: 8) {
                Label("本地保存", systemImage: "checkmark.icloud")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(store.notice)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .padding([.horizontal, .bottom], 16)
        }
        .background(Color(nsColor: .underPageBackgroundColor))
    }
}

struct TopToolbar: View {
    @EnvironmentObject private var store: WorkspaceStore

    var body: some View {
        HStack(spacing: 8) {
            Button {
                if let id = store.activeNodeId { store.insertAfter(id) }
            } label: {
                Label("同级", systemImage: "plus")
            }

            Button {
                if let id = store.activeNodeId { store.insertChild(id) }
            } label: {
                Label("子级", systemImage: "arrow.turn.down.right")
            }

            Button {
                if let id = store.activeNodeId { store.outdentNode(id) }
            } label: {
                Image(systemName: "decrease.indent")
            }
            .help("提升层级")

            Button {
                if let id = store.activeNodeId { store.indentNode(id) }
            } label: {
                Image(systemName: "increase.indent")
            }
            .help("降低层级")

            Divider()
                .frame(height: 22)

            Button {
                if let id = store.activeNodeId { store.moveNode(id, direction: -1) }
            } label: {
                Image(systemName: "arrow.up")
            }
            .help("上移")

            Button {
                if let id = store.activeNodeId { store.moveNode(id, direction: 1) }
            } label: {
                Image(systemName: "arrow.down")
            }
            .help("下移")

            Spacer()

            Button {
                store.importWorkspaceJSON()
            } label: {
                Label("导入", systemImage: "square.and.arrow.down")
            }

            Button {
                store.exportWorkspaceJSON()
            } label: {
                Label("导出", systemImage: "square.and.arrow.up")
            }

            Button {
                store.backupToICloudDrive()
            } label: {
                Label("iCloud 备份", systemImage: "icloud")
            }
        }
        .buttonStyle(.bordered)
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .background(.regularMaterial)
    }
}

struct OutlineEditorView: View {
    @EnvironmentObject private var store: WorkspaceStore

    var body: some View {
        VStack(spacing: 0) {
            if store.activeDocument != nil {
                TextField(
                    "文档标题",
                    text: Binding(
                        get: { store.activeDocument?.title ?? "" },
                        set: { store.updateActiveDocumentTitle($0) }
                    )
                )
                .textFieldStyle(.plain)
                .font(.system(size: 30, weight: .bold))
                .padding(.horizontal, 34)
                .padding(.top, 30)
                .padding(.bottom, 18)

                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(store.visibleRows) { row in
                            OutlineRowView(row: row)
                                .id(row.id)
                        }
                    }
                    .padding(.horizontal, 34)
                    .padding(.bottom, 80)
                }
            } else {
                ContentUnavailableView(
                    "暂无文档",
                    systemImage: "doc",
                    description: Text("点击左侧“新文档”开始")
                )
            }
        }
    }
}

struct OutlineRowView: View {
    @EnvironmentObject private var store: WorkspaceStore
    let row: FlatNode

    private var node: OutlineNode { row.node }
    private var palette: NodePalette { nodePalette(node.color) }
    private var isActive: Bool { store.activeNodeId == node.id }

    var body: some View {
        HStack(spacing: 6) {
            Button {
                store.toggleCollapsed(node.id)
            } label: {
                Image(systemName: node.collapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 11, weight: .bold))
                    .opacity(node.children.isEmpty ? 0 : 1)
            }
            .buttonStyle(.plain)
            .disabled(node.children.isEmpty)
            .frame(width: 18)

            Button {
                store.toggleChecked(node.id)
            } label: {
                Image(systemName: node.checked ? "checkmark.circle.fill" : "circle.fill")
                    .font(.system(size: node.checked ? 13 : 7))
                    .foregroundStyle(node.checked ? Color.accentColor : Color.secondary)
                    .frame(width: 18, height: 24)
            }
            .buttonStyle(.plain)

            if let icon = node.icon, !icon.isEmpty {
                Text(icon)
            }

            KeyAwareTextField(
                text: Binding(
                    get: { store.activeDocument.flatMap { _ in TreeOperations.findNode(in: store.activeDocument?.nodes ?? [], id: node.id)?.text } ?? node.text },
                    set: { store.updateNodeText(node.id, text: $0) }
                ),
                placeholder: "输入主题",
                fontSize: fontSize,
                fontWeight: fontWeight,
                color: NSColor(palette.textColor),
                onFocus: { store.selectNode(node.id) },
                onSubmit: { store.insertAfter(node.id) },
                onTab: { store.indentNode(node.id) },
                onShiftTab: { store.outdentNode(node.id) },
                onMoveUp: { store.selectAdjacentNode(from: node.id, direction: -1) },
                onMoveDown: { store.selectAdjacentNode(from: node.id, direction: 1) },
                onBackspaceEmpty: { store.removeNode(node.id) }
            )
            .frame(height: rowHeight)
            .opacity(node.checked ? 0.55 : 1)

            Spacer(minLength: 8)

            if !node.note.isEmpty {
                Image(systemName: "text.bubble")
                    .foregroundStyle(.secondary)
                    .font(.caption)
            }
        }
        .padding(.leading, CGFloat(row.depth) * 24)
        .padding(.trailing, 8)
        .frame(minHeight: rowHeight)
        .background(rowBackground)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onTapGesture {
            store.selectNode(node.id)
        }
    }

    private var rowBackground: Color {
        if node.highlight == true { return Color.yellow.opacity(0.28) }
        if isActive { return Color.accentColor.opacity(0.12) }
        return Color.clear
    }

    private var rowHeight: CGFloat {
        switch node.headingLevel {
        case 1: 40
        case 2: 36
        case 3: 32
        default: 30
        }
    }

    private var fontSize: CGFloat {
        switch node.headingLevel {
        case 1: 22
        case 2: 18
        case 3: 16
        default: 15
        }
    }

    private var fontWeight: NSFont.Weight {
        if node.bold == true { return .bold }
        switch node.headingLevel {
        case 1: return .bold
        case 2: return .semibold
        case 3: return .medium
        default: return .regular
        }
    }
}

struct InspectorView: View {
    @EnvironmentObject private var store: WorkspaceStore

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("节点详情")
                .font(.headline)

            if let node = store.activeNode {
                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("备注")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        TextEditor(
                            text: Binding(
                                get: { store.activeNode?.note ?? "" },
                                set: { store.updateNodeNote(node.id, note: $0) }
                            )
                        )
                        .frame(minHeight: 120)
                        .scrollContentBackground(.hidden)
                    }
                    .padding(4)
                }

                Picker(
                    "颜色",
                    selection: Binding(
                        get: { store.activeNode?.color ?? "plain" },
                        set: { store.updateNodeColor(node.id, color: $0) }
                    )
                ) {
                    ForEach(NodePalette.allCases) { item in
                        Text(item.label).tag(item.rawValue)
                    }
                }
                .pickerStyle(.segmented)

                Toggle(
                    "待办完成",
                    isOn: Binding(
                        get: { store.activeNode?.checked ?? false },
                        set: { _ in store.toggleChecked(node.id) }
                    )
                )

                Divider()

                LabeledContent("子主题") {
                    Text("\(node.children.count)")
                }
                LabeledContent("节点 ID") {
                    Text(node.id)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }

                Spacer()
            } else {
                ContentUnavailableView(
                    "选择一个主题",
                    systemImage: "cursorarrow.click"
                )
                Spacer()
            }
        }
        .padding(18)
        .background(Color(nsColor: .textBackgroundColor))
    }
}
