import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 360)
        } detail: {
            VStack(spacing: 0) {
                TopBarView()
                ToolStripView()
                Divider()
                HSplitView {
                    DetailModeView()
                        .frame(minWidth: 520)
                    if store.mode != .markdown {
                        InspectorView()
                            .frame(minWidth: 260, idealWidth: 300, maxWidth: 360, maxHeight: .infinity)
                            .overlay(alignment: .leading) {
                                Divider()
                            }
                    }
                }
            }
        }
        .overlay(alignment: .bottom) {
            if let notice = store.notice {
                Text(notice)
                    .font(.caption)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                    .padding(.bottom, 14)
                    .transition(.opacity.combined(with: .scale(scale: 0.98)))
            }
        }
        .animation(.easeOut(duration: 0.18), value: store.notice)
        .alert("确认删除", isPresented: $store.showDeleteConfirmation) {
            Button("取消", role: .cancel) {}
            Button("删除", role: .destructive) { store.deleteActiveDocument() }
        } message: {
            Text("此操作会删除当前文档。")
        }
    }
}

private struct DetailModeView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        switch store.mode {
        case .outline:
            OutlineEditorView(nodes: store.visibleNodes)
        case .mindmap:
            MindMapView(title: store.focusNode?.text ?? store.activeDocument?.title ?? Defaults.documentTitle, nodes: store.visibleNodes)
        case .presentation:
            PresentationView(title: store.focusNode?.text ?? store.activeDocument?.title ?? Defaults.documentTitle, nodes: store.visibleNodes)
        case .markdown:
            MarkdownEditorView()
        }
    }
}

struct TopBarView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                TextField("文档标题", text: Binding(
                    get: { store.activeDocument?.title ?? "" },
                    set: { store.updateTitle($0) }
                ))
                .textFieldStyle(.plain)
                .font(.headline)

                HStack(spacing: 6) {
                    Image(systemName: store.focusNode == nil ? "folder" : "scope")
                    if let focusTitle = store.focusTitle {
                        Text("正在聚焦：\(focusTitle)")
                            .lineLimit(1)
                        Button {
                            store.clearFocus()
                        } label: {
                            Label("退出聚焦", systemImage: "xmark.circle")
                                .labelStyle(.titleAndIcon)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.mini)
                        .help("退出聚焦，回到完整大纲")
                    } else {
                        Text("\(TreeOperations.count(store.activeDocument?.nodes ?? [])) 个主题")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Spacer(minLength: 12)

            Picker("", selection: $store.mode) {
                ForEach(ViewMode.allCases) { mode in
                    Label(mode.title, systemImage: mode.systemImage).tag(mode)
                }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .frame(width: 460)

            Button {
                store.duplicateDocument()
            } label: {
                Image(systemName: "doc.on.doc")
            }
            .help("复制文档")

            Button(role: .destructive) {
                store.showDeleteConfirmation = true
            } label: {
                Image(systemName: "trash")
            }
            .help("删除文档")
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }
}

struct ToolStripView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if store.mode != .markdown {
                    Button {
                        if let id = store.activeNodeId { store.insertAfter(id) }
                    } label: { Label("同级", systemImage: "plus") }
                    Button {
                        if let id = store.activeNodeId { store.insertChild(id) }
                    } label: { Label("子级", systemImage: "increase.indent") }
                    if store.focusNode == nil {
                        Button { store.focusActiveNode() } label: { Label("聚焦", systemImage: "scope") }
                            .help("只显示当前主题及其子主题")
                    } else {
                        Button { store.clearFocus() } label: { Label("退出聚焦", systemImage: "xmark.circle") }
                            .help("回到完整大纲")
                    }
                    Button { store.moveActive(-1) } label: { Label("上移", systemImage: "arrow.up") }
                    Button { store.moveActive(1) } label: { Label("下移", systemImage: "arrow.down") }
                    Divider().frame(height: 22)
                }
                Button { store.exportActive(format: .markdown) } label: { Label("导出 MD", systemImage: "square.and.arrow.down") }
                Button { store.exportActive(format: .opml) } label: { Label("OPML", systemImage: "doc.text") }
                Button { store.exportActive(format: .freemind) } label: { Label("FreeMind", systemImage: "brain.head.profile") }
                Button { store.exportActive(format: .html) } label: { Label("HTML", systemImage: "globe") }
                Button { store.exportActivePDF() } label: { Label("PDF", systemImage: "doc.richtext") }
                Button { store.exportWorkspace() } label: { Label("工作区", systemImage: "doc.badge.gearshape") }
                Divider().frame(height: 22)
                Button { store.backupToICloud() } label: { Label("iCloud 备份", systemImage: "icloud.and.arrow.up") }
                Button { store.loadICloudBackup() } label: { Label("载入备份", systemImage: "icloud.and.arrow.down") }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .padding(.horizontal, 20)
            .padding(.bottom, 10)
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        Form {
            Toggle("使用暗黑模式", isOn: $store.useDarkMode)
            HStack {
                Text("iCloud 备份目录")
                Spacer()
                Text(ICloudBackupService.directoryURL().path)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Button("在 Finder 中打开") { ICloudBackupService.openDirectoryInFinder() }
            }
        }
        .padding()
        .frame(width: 620)
    }
}
