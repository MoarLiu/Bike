import SwiftUI

struct SidebarView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "list.bullet.indent")
                    .frame(width: 28, height: 28)
                    .foregroundStyle(.white)
                    .background(Color.primary, in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text("Bike").font(.headline)
                    Text("原生 Swift").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.top, 8)

            HStack {
                Image(systemName: "magnifyingglass")
                TextField("搜索文档、主题、备注", text: $store.search)
                    .textFieldStyle(.plain)
            }
            .padding(8)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))

            HStack(spacing: 8) {
                Button { store.createDocument() } label: { Label("新文档", systemImage: "plus") }
                Button { store.importFile() } label: { Label("导入", systemImage: "square.and.arrow.down") }
            }
            .buttonStyle(.bordered)

            List(selection: Binding(
                get: { store.workspace.activeDocumentId },
                set: { id in if let id { store.selectDocument(id) } }
            )) {
                Section("最近编辑") {
                    ForEach(store.matchingDocuments) { document in
                        DocumentRow(document: document)
                            .tag(document.id)
                            .contextMenu {
                                Button("打开文档") {
                                    store.selectDocument(document.id)
                                }
                                Button("创建副本") {
                                    store.selectDocument(document.id)
                                    store.duplicateDocument()
                                }
                                Divider()
                                Button("删除文档", role: .destructive) {
                                    store.requestDeleteDocument(document.id)
                                }
                            }
                    }
                }
            }
            .listStyle(.sidebar)

            if !store.tags.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Label("标签", systemImage: "tag")
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack {
                            ForEach(store.tags, id: \.self) { tag in
                                Button("#\(tag)") {
                                    store.selectedTag = store.selectedTag == tag ? nil : tag
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                            }
                        }
                    }
                }
            }

            HStack(spacing: 12) {
                Button { store.backupToICloud() } label: { Image(systemName: "icloud") }
                    .help("创建 JSON 备份")
                Button { store.syncNow() } label: { Image(systemName: store.isSyncing ? "hourglass" : "arrow.triangle.2.circlepath") }
                    .disabled(store.isSyncing)
                    .help("同步 Web 文档")
                Button { store.openSyncConfig() } label: { Image(systemName: "gearshape") }
                    .help("配置 Web Sync")
                Button { store.toggleDarkMode() } label: { Image(systemName: store.useDarkMode ? "sun.max" : "moon") }
                    .help(store.useDarkMode ? "切换到明亮模式" : "切换到暗黑模式")
                Button { BikeStorage.openDocumentsDirectoryInFinder() } label: { Image(systemName: "folder") }
                    .help("在 Finder 中打开 Markdown 保存目录")
                Spacer()
            }
            .buttonStyle(.borderless)

            HStack(alignment: .top, spacing: 8) {
                Image(systemName: store.isSyncing ? "arrow.triangle.2.circlepath" : "checkmark.icloud")
                VStack(alignment: .leading, spacing: 2) {
                    Text("iCloud Markdown / Web Sync").font(.caption.bold())
                    Text(store.notice ?? syncStatusText).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer()
            }
            .padding(.vertical, 8)
        }
        .padding(.horizontal, 12)
    }

    private var syncStatusText: String {
        if store.isSyncing { return "正在同步 Web 文档..." }
        if let lastSyncedAt = store.syncState.lastSyncedAt {
            return "Web 上次同步：\(format(lastSyncedAt))\(store.syncConfig.autoSync ? " · 自动" : "")"
        }
        return store.syncConfig.isConfigured ? "Web Sync 尚未同步" : "自动保存到 iCloud Drive/Bike"
    }

    private func format(_ iso: String) -> String {
        guard let date = ISO8601DateFormatter.bike.date(from: iso) else { return "时间未知" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

private struct DocumentRow: View {
    var document: OutlineDocumentDTO

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "doc.text")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(document.title)
                    .lineLimit(1)
                Text(format(document.updatedAt))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    private func format(_ iso: String) -> String {
        guard let date = ISO8601DateFormatter.bike.date(from: iso) else { return "时间未知" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
