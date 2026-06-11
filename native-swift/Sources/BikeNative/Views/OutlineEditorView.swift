import AppKit
import SwiftUI

struct OutlineEditorView: View {
    @EnvironmentObject private var store: AppStore
    var nodes: [OutlineNodeDTO]

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if store.focusNode == nil {
                    TextField("文档标题", text: Binding(
                        get: { store.activeDocument?.title ?? "" },
                        set: { store.updateTitle($0) }
                    ))
                    .textFieldStyle(.plain)
                    .font(.system(size: 32, weight: .bold))
                    .padding(.bottom, 18)
                } else if let focusTitle = store.focusTitle {
                    FocusBannerView(title: focusTitle)
                        .padding(.bottom, 18)
                }

                ForEach(TreeOperations.flatten(nodes, respectCollapsed: true)) { row in
                    OutlineRowView(row: row)
                }
            }
            .frame(maxWidth: 1040, alignment: .leading)
            .padding(.horizontal, 36)
            .padding(.vertical, 42)
        }
    }
}

private struct FocusBannerView: View {
    @EnvironmentObject private var store: AppStore
    var title: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "scope")
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text("正在聚焦")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(title)
                    .font(.headline)
                    .lineLimit(1)
            }
            Spacer(minLength: 12)
            Button {
                store.clearFocus()
            } label: {
                Label("退出聚焦", systemImage: "xmark.circle")
            }
            .controlSize(.small)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.accentColor.opacity(0.18)))
    }
}

private struct OutlineRowView: View {
    @EnvironmentObject private var store: AppStore
    var row: FlatNode
    @State private var isHovering = false

    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            Group {
                if row.node.children.isEmpty {
                    Color.clear
                        .frame(width: 18, height: 18)
                } else {
                    Button {
                        store.updateNode(row.node.id, preservesMarkdown: true) { $0.collapsed.toggle() }
                    } label: {
                        Image(systemName: row.node.collapsed ? "chevron.right" : "chevron.down")
                            .font(.system(size: 11, weight: .medium))
                            .frame(width: 18, height: 18)
                    }
                    .buttonStyle(.borderless)
                }
            }
            .padding(.leading, CGFloat(row.depth) * 24)

            if row.node.isTodo == true {
                Button {
                    store.updateNode(row.node.id) { $0.checked.toggle() }
                } label: {
                    Image(systemName: row.node.checked ? "checkmark.circle.fill" : "circle")
                }
                .buttonStyle(.borderless)
            } else {
                Circle()
                    .fill(color(row.node.color))
                    .frame(width: 7, height: 7)
            }

            if let icon = row.node.icon {
                Text(icon)
            }

            OutlineNodeTextEditor(text: Binding(
                get: { row.node.text },
                set: { text in store.updateNodeText(row.node.id, text: text) }
            ), placeholder: "输入主题", fontSize: fontSize(row.node), fontWeight: fontWeight(row.node), italic: row.node.italic == true, textColor: nsTextColor(row.node), strikethrough: row.node.strike == true || (row.node.checked && row.node.isTodo == true), isActive: store.activeNodeId == row.node.id, forceRefreshToken: store.undoApplyRevision, focusRequestToken: store.focusRequestToken, shouldHandleFocusRequest: store.focusRequestNodeId == row.node.id, onFocusHandled: {
                store.clearEditorFocusRequest()
            }, onSubmit: {
                store.finishCoalescedUndo()
                store.insertAfter(row.node.id)
            }, onIndent: {
                store.finishCoalescedUndo()
                store.selectNode(row.node.id)
                store.indentActive()
            }, onOutdent: {
                store.finishCoalescedUndo()
                store.selectNode(row.node.id)
                store.outdentActive()
            }, onMoveUp: {
                store.selectNode(row.node.id)
                store.navigateActiveUp()
            }, onMoveDown: {
                store.selectNode(row.node.id)
                store.navigateActiveDown()
            }, onSelect: {
                store.finishCoalescedUndo()
                store.selectNode(row.node.id, focusEditor: true)
            }, onUndo: {
                store.undoDocumentCommand()
            }, onEditingEnded: {
                store.finishCoalescedUndo()
            }, menuActions: OutlineNodeTextMenuActions(
                isFocused: store.focusNodeId == row.node.id,
                insertSibling: { store.insertAfter(row.node.id) },
                insertChild: { store.insertChild(row.node.id) },
                focus: { store.focusOnNode(row.node.id) },
                clearFocus: { store.clearFocus() },
                copyLink: { store.copyNodeLink(row.node) },
                toggleTodo: { store.updateNode(row.node.id) { $0.isTodo = !($0.isTodo ?? false) } },
                toggleStrike: { store.toggleStrike(row.node.id) },
                setColor: { item in store.updateNode(row.node.id) { $0.color = item.rawValue } },
                delete: { store.removeNode(row.node.id) }
            ))
            .frame(minHeight: rowHeight(row.node))
            .background(row.node.highlight == true ? Color.yellow.opacity(0.25) : Color.clear)

            if isHovering || store.activeNodeId == row.node.id || store.isAiBusy(row.node.id) {
                AiActionMenu(isBusy: store.isAiBusy(row.node.id)) { action in
                    store.performAiNodeAction(action, targetId: row.node.id)
                }
            }

            Spacer(minLength: 8)

            ForEach(TreeOperations.extractTags(row.node.text), id: \.self) { tag in
                Text("#\(tag)").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .padding(.trailing, 8)
        .background(store.activeNodeId == row.node.id ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onTapGesture { store.selectNode(row.node.id, focusEditor: true) }
        .onHover { isHovering = $0 }
        .contextMenu {
            Button("新增同级") { store.insertAfter(row.node.id) }
            Button("新增子级") { store.insertChild(row.node.id) }
            Divider()
            Button("AI 生成") { store.performAiNodeAction(.generate, targetId: row.node.id) }
            Button("AI 润色") { store.performAiNodeAction(.polish, targetId: row.node.id) }
            if store.focusNodeId == row.node.id {
                Button("退出聚焦") { store.clearFocus() }
            } else {
                Button("聚焦") { store.focusOnNode(row.node.id) }
            }
            Divider()
            Button("复制主题链接") { store.copyNodeLink(row.node) }
            Button("转化为待办任务") { store.updateNode(row.node.id) { $0.isTodo = !($0.isTodo ?? false) } }
            Button("删除线") { store.toggleStrike(row.node.id) }
            Menu("颜色") {
                ForEach(OutlineColor.allCases) { item in
                    Button(item.title) { store.updateNode(row.node.id) { $0.color = item.rawValue } }
                }
            }
            Divider()
            Button("删除", role: .destructive) { store.removeNode(row.node.id) }
        }
    }

    private func rowHeight(_ node: OutlineNodeDTO) -> CGFloat {
        fontSize(node) + 10
    }

    private func fontSize(_ node: OutlineNodeDTO) -> CGFloat {
        switch node.headingLevel ?? 0 {
        case 1: return 24
        case 2: return 20
        case 3: return 18
        default: return 16
        }
    }

    private func fontWeight(_ node: OutlineNodeDTO) -> NSFont.Weight {
        node.bold == true || (node.headingLevel ?? 0) > 0 ? .bold : .regular
    }

    private func nsTextColor(_ node: OutlineNodeDTO) -> NSColor {
        if node.checked && node.isTodo == true {
            return .secondaryLabelColor
        }
        switch OutlineColor.normalize(node.color) {
        case "blue": return .systemBlue
        case "green": return .systemGreen
        case "amber": return .systemOrange
        case "rose": return .systemPink
        default: return .labelColor
        }
    }

    private func color(_ value: String) -> Color {
        switch OutlineColor.normalize(value) {
        case "blue": .blue
        case "green": .green
        case "amber": .orange
        case "rose": .pink
        default: .primary
        }
    }
}

struct InspectorView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let node = store.activeNode {
                InspectorSection(title: "节点详情", systemImage: "info.circle") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("备注")
                            .font(.caption.bold())
                            .foregroundStyle(.secondary)
                        TextEditor(text: Binding(
                            get: { node.note },
                            set: { value in
                                store.updateNode(node.id, coalescingKey: "nodeNote:\(node.id)") { $0.note = value }
                            }
                        ))
                        .font(.body)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 112, maxHeight: 150)
                        .padding(6)
                        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
                    }

                    LabeledContent("颜色") {
                        Picker("", selection: Binding(
                            get: { OutlineColor(rawValue: node.color) ?? .plain },
                            set: { value in store.updateNode(node.id) { $0.color = value.rawValue } }
                        )) {
                            ForEach(OutlineColor.allCases) { color in
                                Label {
                                    Text(color.title)
                                } icon: {
                                    Circle()
                                        .fill(inspectorColor(color.rawValue))
                                        .frame(width: 8, height: 8)
                                }
                                .tag(color)
                            }
                        }
                        .labelsHidden()
                        .frame(width: 108)
                    }

                    LabeledContent("子主题") {
                        Text("\(node.children.count)")
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                }
            } else {
                ContentUnavailableView("选择一个主题", systemImage: "cursorarrow.click")
            }

            InspectorSection(title: "文档链接", systemImage: "link") {
                if store.linkRows.isEmpty {
                    Text("暂无链接")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(Array(store.linkRows.prefix(8).enumerated()), id: \.offset) { _, row in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(row.source)
                                .lineLimit(1)
                            Text("[[\(row.link)]]")
                                .foregroundStyle(.tint)
                                .lineLimit(1)
                        }
                        .font(.caption)
                        .padding(.vertical, 3)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func inspectorColor(_ value: String) -> Color {
        switch OutlineColor.normalize(value) {
        case "blue": .blue
        case "green": .green
        case "amber": .orange
        case "rose": .pink
        default: .secondary.opacity(0.35)
        }
    }
}

private struct InspectorSection<Content: View>: View {
    var title: String
    var systemImage: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: systemImage)
                .font(.headline)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
