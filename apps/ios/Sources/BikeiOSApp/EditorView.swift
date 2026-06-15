import BikeCore
import SwiftUI

struct EditorView: View {
    @ObservedObject var store: BikeAppStore
    let documentId: String

    @State private var draftTitle = ""
    @FocusState private var titleFocused: Bool
    @FocusState private var focusedNodeId: String?

    private var document: OutlineDocument? {
        store.payload?.workspace.documents.first { $0.id == documentId }
    }

    private var rows: [FlatNodeRow] {
        document?.nodes.flattenVisible() ?? []
    }

    private var aiBusy: Bool {
        store.aiBusyNodeId != nil
    }

    private var documentTitle: String {
        document?.title ?? ""
    }

    private var displayTitle: String {
        let trimmed = documentTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "未命名文档" : trimmed
    }

    var body: some View {
        editorContent
            .navigationTitle(displayTitle)
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    keyboardToolbar
                }
            }
#endif
            .onAppear {
                syncDraftTitle(force: true)
            }
            .onChange(of: documentId) { _, _ in
                syncDraftTitle(force: true)
            }
            .onChange(of: documentTitle) { _, _ in
                syncDraftTitle(force: false)
            }
    }

    private var editorContent: some View {
        ZStack(alignment: .bottom) {
            BikeTheme.background.ignoresSafeArea()
            if let document {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        DocumentTitleEditor(title: $draftTitle, isFocused: $titleFocused)
                            .padding(.horizontal, 14)
                            .padding(.top, 10)
                            .onChange(of: draftTitle) { _, value in
                                saveDocumentTitle(value)
                            }

                        LazyVStack(alignment: .leading, spacing: 4) {
                            ForEach(rows) { row in
                                OutlineRowView(
                                    store: store,
                                    documentId: document.id,
                                    row: row,
                                    aiBusy: aiBusy,
                                    focusedNodeId: $focusedNodeId
                                )
                            }
                        }
                        .padding(.horizontal, 12)
                    }
                    .padding(.bottom, 76)
                }
                VStack(spacing: 0) {
                    Divider().overlay(BikeTheme.hairline)
                    HStack {
                        StatusBadge(text: store.status)
                        Spacer()
                        if let busyNodeId = store.aiBusyNodeId,
                           document.nodes.findNode(busyNodeId) != nil {
                            ProgressView()
                                .controlSize(.small)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.ultraThinMaterial)
                }
            } else {
                MissingDocumentView()
            }
        }
    }

    @ViewBuilder
    private var keyboardToolbar: some View {
        if let node = focusedNode {
            Button {
                moveFocusedNodeToParentLevel(node)
            } label: {
                Image(systemName: "arrow.up.left")
            }
            .accessibilityLabel("移动到上级")
            .disabled(aiBusy)

            Button {
                addSibling(after: node)
            } label: {
                Image(systemName: "plus.rectangle.on.rectangle")
            }
            .accessibilityLabel("新增同级")
            .disabled(aiBusy)

            Button {
                addChild(to: node)
            } label: {
                Image(systemName: "arrow.turn.down.right")
            }
            .accessibilityLabel("新增子级")
            .disabled(aiBusy)

            Divider()

            Button {
                store.runAIGenerate(documentId: documentId, node: node)
            } label: {
                Image(systemName: "sparkles")
            }
            .accessibilityLabel("AI 生成")
            .disabled(aiBusy)

            Button {
                store.runAIPolish(documentId: documentId, node: node)
            } label: {
                Image(systemName: "wand.and.stars")
            }
            .accessibilityLabel("AI 润色")
            .disabled(aiBusy)

            Button(role: .destructive) {
                deleteNode(node)
            } label: {
                Image(systemName: "trash")
            }
            .accessibilityLabel("删除")
            .disabled(aiBusy)
        }
    }

    private var focusedNode: OutlineNode? {
        guard let focusedNodeId else { return nil }
        return document?.nodes.findNode(focusedNodeId)
    }

    private func syncDraftTitle(force: Bool) {
        guard force || !titleFocused else { return }
        draftTitle = documentTitle
    }

    private func saveDocumentTitle(_ title: String) {
        guard documentTitle != title else { return }
        store.mutateWorkspace {
            $0.withDocumentTitle(documentId: documentId, title: title)
        }
    }

    private func moveFocusedNodeToParentLevel(_ node: OutlineNode) {
        store.mutateWorkspace {
            $0.withNodeMovedToParentLevel(documentId: documentId, nodeId: node.id)
        }
    }

    private func addSibling(after node: OutlineNode) {
        let newNode = outlineNode("")
        store.mutateWorkspace {
            $0.withSiblingAfter(documentId: documentId, nodeId: node.id, newNode: newNode)
        }
        focusedNodeId = newNode.id
    }

    private func addChild(to node: OutlineNode) {
        let child = outlineNode("")
        store.mutateWorkspace {
            $0.withChildNode(documentId: documentId, nodeId: node.id, childNode: child)
        }
        focusedNodeId = child.id
    }

    private func deleteNode(_ node: OutlineNode) {
        store.mutateWorkspace {
            $0.withNodeDeleted(documentId: documentId, nodeId: node.id)
        }
        focusedNodeId = nil
    }
}

private struct DocumentTitleEditor: View {
    @Binding var title: String
    @FocusState.Binding var isFocused: Bool

    var body: some View {
        TextField("文档名称", text: $title, axis: .vertical)
            .textFieldStyle(.plain)
            .font(.system(size: 28, weight: .bold, design: .rounded))
            .foregroundStyle(.primary)
            .lineLimit(1...2)
            .submitLabel(.done)
            .focused($isFocused)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
            .onSubmit {
                isFocused = false
            }
            .accessibilityLabel("文档名称")
    }
}

private struct OutlineRowView: View {
    @ObservedObject var store: BikeAppStore
    let documentId: String
    let row: FlatNodeRow
    let aiBusy: Bool
    @FocusState.Binding var focusedNodeId: String?

    @State private var draftText: String
    @State private var draftNote: String

    init(
        store: BikeAppStore,
        documentId: String,
        row: FlatNodeRow,
        aiBusy: Bool,
        focusedNodeId: FocusState<String?>.Binding
    ) {
        self.store = store
        self.documentId = documentId
        self.row = row
        self.aiBusy = aiBusy
        _focusedNodeId = focusedNodeId
        _draftText = State(initialValue: row.node.text)
        _draftNote = State(initialValue: row.node.note)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            indentation

            Button {
                store.mutateWorkspace {
                    $0.withNodeChecked(documentId: documentId, nodeId: row.node.id, checked: !row.node.checked)
                }
            } label: {
                Image(systemName: row.node.checked ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(row.node.checked ? BikeTheme.green : .secondary)
                    .frame(width: 24, height: 28)
            }
            .buttonStyle(.plain)
            .disabled(aiBusy)

            if row.node.children.isEmpty {
                Color.clear.frame(width: 22, height: 28)
            } else {
                Button {
                    store.mutateWorkspace {
                        $0.withNodeCollapsed(
                            documentId: documentId,
                            nodeId: row.node.id,
                            collapsed: !row.node.collapsed
                        )
                    }
                } label: {
                    Image(systemName: row.node.collapsed ? "chevron.right" : "chevron.down")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 22, height: 28)
                }
                .buttonStyle(.plain)
                .disabled(aiBusy)
            }

            VStack(alignment: .leading, spacing: 4) {
                TextField("主题", text: $draftText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 17, weight: row.depth == 0 ? .semibold : .regular))
                    .foregroundStyle(row.node.checked ? .secondary : .primary)
                    .strikethrough(row.node.checked)
                    .submitLabel(.return)
                    .focused($focusedNodeId, equals: row.node.id)
                    .disabled(aiBusy)
                    .onSubmit {
                        addChild()
                    }

                if focusedNodeId == row.node.id || !draftNote.isEmpty {
                    TextField("备注", text: $draftNote, axis: .vertical)
                        .textFieldStyle(.plain)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1...4)
                        .focused($focusedNodeId, equals: row.node.id)
                        .disabled(aiBusy)
                }
            }
            .padding(.vertical, 5)
            .padding(.horizontal, 8)
            .background(rowBackground)
            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        }
        .padding(.vertical, 1)
        .contentShape(Rectangle())
        .onTapGesture {
            focusedNodeId = row.node.id
        }
        .onChange(of: draftText) { _, _ in
            saveDraft()
        }
        .onChange(of: draftNote) { _, _ in
            saveDraft()
        }
        .onChange(of: row.node.id) { _, _ in
            draftText = row.node.text
            draftNote = row.node.note
        }
        .onChange(of: row.node.text) { _, value in
            if focusedNodeId != row.node.id {
                draftText = value
            }
        }
        .onChange(of: row.node.note) { _, value in
            if focusedNodeId != row.node.id {
                draftNote = value
            }
        }
    }

    private var indentation: some View {
        HStack(spacing: 0) {
            ForEach(0..<row.depth, id: \.self) { _ in
                Rectangle()
                    .fill(BikeTheme.guide)
                    .frame(width: 1)
                    .frame(width: 14, height: 34)
            }
        }
    }

    private var rowBackground: Color {
        focusedNodeId == row.node.id ? BikeTheme.panel : .clear
    }

    private func saveDraft() {
        store.mutateWorkspace {
            $0.withNodeTextAndNote(
                documentId: documentId,
                nodeId: row.node.id,
                text: draftText,
                note: draftNote
            )
        }
    }

    private func addChild() {
        let child = outlineNode("")
        store.mutateWorkspace {
            $0.withChildNode(documentId: documentId, nodeId: row.node.id, childNode: child)
        }
        focusedNodeId = child.id
    }
}

private struct MissingDocumentView: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "doc.badge.questionmark")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(.secondary)
            Text("文档不存在")
                .font(.headline)
            Text("它可能已经被删除或导入的工作区不再包含该文档。")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(28)
    }
}
