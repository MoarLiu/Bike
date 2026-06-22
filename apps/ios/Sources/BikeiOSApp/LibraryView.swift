import BikeCore
import SwiftUI

struct LibraryView: View {
    @ObservedObject var store: BikeAppStore
    @Binding var path: [String]

    @State private var query = ""
    @State private var selectedFilter: DocumentFilter = .all
    @State private var renamingDocument: OutlineDocument?
    @State private var deletingDocument: OutlineDocument?

    private var documents: [OutlineDocument] {
        guard let workspace = store.payload?.workspace else { return [] }
        let filtered = workspace.documents.filter { document in
            switch selectedFilter {
            case .all: true
            case .shortcuts: document.isShortcut
            }
        }
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return filtered }
        return filtered.filter { document in
            document.title.localizedCaseInsensitiveContains(trimmed) ||
                document.nodes.flattenSearch(trimmed).isEmpty == false
        }
    }

    var body: some View {
        ZStack {
            BikeTheme.background.ignoresSafeArea()
            content
        }
        .navigationTitle("Bike")
        .toolbar {
            ToolbarItem(placement: leadingToolbarPlacement) {
                HStack(spacing: 14) {
                    Button {
                        store.showAISettings = true
                    } label: {
                        Image(systemName: "sparkles")
                    }
                    .accessibilityLabel("AI 设置")

                    Button {
                        store.showSyncSettings = true
                    } label: {
                        Image(systemName: store.isSyncing ? "arrow.triangle.2.circlepath" : "arrow.clockwise.icloud")
                    }
                    .accessibilityLabel("Web Sync")
                    .disabled(store.isSyncing)
                }
            }
            ToolbarItem(placement: trailingToolbarPlacement) {
                Button(action: createDocument) {
                    Image(systemName: "square.and.pencil")
                }
                .accessibilityLabel("新建文档")
            }
        }
        .sheet(item: $renamingDocument) { document in
            RenameDocumentSheet(store: store, document: document)
        }
        .confirmationDialog(
            "删除文档",
            isPresented: Binding(
                get: { deletingDocument != nil },
                set: { if !$0 { deletingDocument = nil } }
            ),
            presenting: deletingDocument
        ) { document in
            Button("删除", role: .destructive) {
                deleteDocument(document)
            }
        } message: { document in
            Text("删除“\(document.title)”后无法从本机工作区恢复。")
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.payload == nil {
            VStack(spacing: 14) {
                ProgressView()
                Text(store.status)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            let scrollView = ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    filterBar
                    documentGrid
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 28)
            }
#if os(iOS)
            scrollView
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜索文档和主题")
#else
            scrollView
                .searchable(text: $query, prompt: "搜索文档和主题")
#endif
        }
    }

    private var leadingToolbarPlacement: ToolbarItemPlacement {
#if os(iOS)
        .topBarLeading
#else
        .automatic
#endif
    }

    private var trailingToolbarPlacement: ToolbarItemPlacement {
#if os(iOS)
        .topBarTrailing
#else
        .automatic
#endif
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("本机工作区")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline) {
                Text("\(store.payload?.workspace.documents.count ?? 0)")
                    .font(.system(size: 42, weight: .bold, design: .rounded))
                Text("篇文档")
                    .font(.headline)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 12)
                StatusBadge(text: store.status)
            }
        }
        .padding(.top, 10)
    }

    private var filterBar: some View {
        Picker("文档筛选", selection: $selectedFilter) {
            ForEach(DocumentFilter.allCases) { filter in
                Text(filter.title).tag(filter)
            }
        }
        .pickerStyle(.segmented)
    }

    private var documentGrid: some View {
        LazyVGrid(
            columns: [
                GridItem(.flexible(), spacing: 12),
                GridItem(.flexible(), spacing: 12)
            ],
            spacing: 12
        ) {
            ForEach(documents) { document in
                Button {
                    store.mutateWorkspace { $0.withActiveDocument(document.id) }
                    path = [document.id]
                } label: {
                    DocumentCard(document: document)
                }
                .buttonStyle(.plain)
                .contextMenu {
                    Button {
                        renamingDocument = document
                    } label: {
                        Label("重命名", systemImage: "pencil")
                    }
                    Button {
                        duplicateDocument(document)
                    } label: {
                        Label("复制", systemImage: "doc.on.doc")
                    }
                    Button {
                        toggleShortcut(document)
                    } label: {
                        Label(document.isShortcut ? "取消快捷" : "设为快捷", systemImage: document.isShortcut ? "star.slash" : "star")
                    }
                    Button(role: .destructive) {
                        deletingDocument = document
                    } label: {
                        Label("删除", systemImage: "trash")
                    }
                }
            }
        }
    }

    private func createDocument() {
        let document = OutlineDocument(
            title: "未命名文档",
            nodes: [outlineNode("新主题")]
        )
        store.mutateWorkspace { workspace in
            var next = workspace
            next.documents.insert(document, at: 0)
            next.activeDocumentId = document.id
            return next
        }
        path = [document.id]
    }

    private func duplicateDocument(_ document: OutlineDocument) {
        store.mutateWorkspace { $0.withDocumentDuplicated(documentId: document.id) }
    }

    private func toggleShortcut(_ document: OutlineDocument) {
        store.mutateWorkspace {
            $0.withDocumentShortcut(documentId: document.id, isShortcut: !document.isShortcut)
        }
    }

    private func deleteDocument(_ document: OutlineDocument) {
        store.mutateWorkspace { $0.withDocumentDeleted(documentId: document.id) }
        deletingDocument = nil
    }
}

private struct DocumentCard: View {
    let document: OutlineDocument

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: document.isShortcut ? "star.fill" : "doc.text")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(document.isShortcut ? BikeTheme.gold : BikeTheme.accent)
                Spacer()
                Text("\(document.nodeCount())")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            Text(document.title.isEmpty ? "未命名文档" : document.title)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)

            Spacer(minLength: 4)

            Text(document.updatedAt)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
        .padding(14)
        .frame(minHeight: 142, alignment: .top)
        .background(BikeTheme.card)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(BikeTheme.hairline, lineWidth: 1)
        )
    }
}

private struct RenameDocumentSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: BikeAppStore
    let document: OutlineDocument
    @State private var title: String

    init(store: BikeAppStore, document: OutlineDocument) {
        self.store = store
        self.document = document
        _title = State(initialValue: document.title)
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("文档名称", text: $title)
            }
            .navigationTitle("重命名")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        store.mutateWorkspace {
                            $0.withDocumentTitle(documentId: document.id, title: title)
                        }
                        dismiss()
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDetents([.height(180), .medium])
    }
}

private enum DocumentFilter: String, CaseIterable, Identifiable {
    case all
    case shortcuts

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: "全部"
        case .shortcuts: "快捷"
        }
    }
}

struct StatusBadge: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .background(BikeTheme.panel)
            .clipShape(Capsule())
    }
}

enum BikeTheme {
    static let background = Color(red: 0.055, green: 0.058, blue: 0.066)
    static let panel = Color(red: 0.10, green: 0.105, blue: 0.118)
    static let card = Color(red: 0.125, green: 0.13, blue: 0.145)
    static let hairline = Color.white.opacity(0.08)
    static let guide = Color.white.opacity(0.16)
    static let accent = Color(red: 0.46, green: 0.72, blue: 0.93)
    static let green = Color(red: 0.32, green: 0.78, blue: 0.55)
    static let gold = Color(red: 0.96, green: 0.76, blue: 0.32)
}
