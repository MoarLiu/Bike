import AppKit
import Combine
import Foundation

private struct WorkspaceUndoSnapshot {
    var workspace: WorkspaceV1DTO
    var activeNodeId: String?
    var focusNodeId: String?
}

enum WorkspaceLoadState: Equatable {
    case loading
    case loaded
    case failed(String)
}

@MainActor
final class AppStore: ObservableObject {
    @Published var workspace: WorkspaceV1DTO = SampleData.starterWorkspace()
    @Published var loadState: WorkspaceLoadState = .loading
    @Published var mode: ViewMode = .outline
    @Published var markdownPaneMode: MarkdownPaneMode = .split
    @Published var activeNodeId: String?
    @Published var focusNodeId: String?
    @Published var search = ""
    @Published var selectedTag: String?
    @Published var notice: String?
    @Published var showDeleteConfirmation = false
    @Published var pendingDeleteDocumentId: String?
    @Published var useDarkMode = false {
        didSet { applyAppearance() }
    }
    @Published var undoApplyRevision = 0
    @Published var focusRequestToken = 0
    @Published var focusRequestNodeId: String?
    @Published var aiConfig: AiApiConfig = AiConfigStore.load()
    @Published var showAiConfigDialog = false
    @Published var aiBusyTargetIds: Set<String> = []
    @Published var isCheckingUpdates = false

    let repository: WorkspaceRepository
    private var saveTask: Task<Void, Never>?
    private var noticeTask: Task<Void, Never>?
    private var undoStack: [WorkspaceUndoSnapshot] = []
    private var lastUndoCoalescingKey: String?

    init(repository: WorkspaceRepository) {
        self.repository = repository
    }

    convenience init() {
        do {
            try self.init(repository: WorkspaceRepository())
        } catch {
            do {
                try self.init(repository: WorkspaceRepository(inMemory: true))
                loadState = .failed("初始化本地存储失败：\(error.localizedDescription)")
            } catch {
                preconditionFailure("Failed to initialize fallback workspace repository: \(error)")
            }
        }
    }

    var activeDocument: OutlineDocumentDTO? {
        workspace.documents.first { $0.id == workspace.activeDocumentId } ?? workspace.documents.first
    }

    var isWorkspaceReady: Bool {
        loadState == .loaded
    }

    var loadErrorMessage: String? {
        if case .failed(let message) = loadState {
            return message
        }
        return nil
    }

    var activeNode: OutlineNodeDTO? {
        guard let activeDocument, let activeNodeId else { return nil }
        return TreeOperations.findNode(in: activeDocument.nodes, id: activeNodeId)
    }

    var focusNode: OutlineNodeDTO? {
        guard let activeDocument, let focusNodeId else { return nil }
        return TreeOperations.findNode(in: activeDocument.nodes, id: focusNodeId)
    }

    var focusTitle: String? {
        focusNode.map { TreeOperations.nodeText($0) }
    }

    var visibleNodes: [OutlineNodeDTO] {
        focusNode.map { [$0] } ?? activeDocument?.nodes ?? []
    }

    var matchingDocuments: [OutlineDocumentDTO] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return workspace.documents
            .filter { document in
                let allText = ([document.title] + TreeOperations.flatten(document.nodes).map { TreeOperations.nodeText($0.node) }).joined(separator: " ").lowercased()
                let matchesQuery = query.isEmpty || allText.contains(query)
                let matchesTag = selectedTag == nil || TreeOperations.flatten(document.nodes).contains { row in
                    TreeOperations.extractTags(row.node.text).contains(selectedTag!) || TreeOperations.extractTags(row.node.note).contains(selectedTag!)
                }
                return matchesQuery && matchesTag
            }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    var tags: [String] {
        guard let activeDocument else { return [] }
        let set = TreeOperations.flatten(activeDocument.nodes).reduce(into: Set<String>()) { result, row in
            TreeOperations.extractTags(row.node.text).forEach { result.insert($0) }
            TreeOperations.extractTags(row.node.note).forEach { result.insert($0) }
        }
        return set.sorted { $0.localizedCompare($1) == .orderedAscending }
    }

    var linkRows: [(source: String, link: String)] {
        guard let activeDocument else { return [] }
        return TreeOperations.flatten(activeDocument.nodes).flatMap { row in
            TreeOperations.extractLinks(row.node.text).map { (source: row.node.text.isEmpty ? Defaults.nodeText : row.node.text, link: $0) }
        }
    }

    func load() {
        saveTask?.cancel()
        loadState = .loading
        do {
            workspace = try repository.loadWorkspace()
            activeNodeId = TreeOperations.firstNodeId(activeDocument?.nodes ?? [])
            focusNodeId = nil
            clearUndoHistory()
            applyAppearance()
            loadState = .loaded
        } catch {
            loadState = .failed(error.localizedDescription)
            show("载入失败：\(error.localizedDescription)")
        }
    }

    func flushSaveNow() {
        guard isWorkspaceReady else {
            show("工作区尚未载入，无法保存")
            return
        }
        saveTask?.cancel()
        do {
            try repository.saveWorkspace(workspace)
            show("已保存到 iCloud Drive/Bike")
        } catch {
            show("保存失败：\(error.localizedDescription)")
        }
    }

    func createManualSnapshot() {
        guard canEditWorkspace() else { return }
        do {
            try repository.createSnapshot(reason: "manual", workspace: workspace)
            show("已创建本地快照")
        } catch {
            show("快照失败：\(error.localizedDescription)")
        }
    }

    func scheduleSave() {
        guard isWorkspaceReady else { return }
        saveTask?.cancel()
        let current = workspace
        saveTask = Task { [repository] in
            try? await Task.sleep(for: .milliseconds(350))
            if Task.isCancelled { return }
            do {
                try await MainActor.run { try repository.saveWorkspace(current) }
            } catch {
                await MainActor.run { self.show("保存失败：\(error.localizedDescription)") }
            }
        }
    }

    func selectDocument(_ id: String) {
        guard canEditWorkspace() else { return }
        workspace.activeDocumentId = id
        focusNodeId = nil
        activeNodeId = TreeOperations.firstNodeId(activeDocument?.nodes ?? [])
        finishCoalescedUndo()
        scheduleSave()
    }

    func createDocument() {
        guard canEditWorkspace() else { return }
        recordUndoSnapshot()
        let id = UUID().uuidString
        let document = OutlineDocumentDTO(id: id, title: Defaults.documentTitle, nodes: [OutlineNodeDTO(text: "新主题")])
        workspace.documents.insert(document, at: 0)
        workspace.activeDocumentId = id
        activeNodeId = document.nodes.first?.id
        focusNodeId = nil
        show("已创建新文档")
        scheduleSave()
    }

    func duplicateDocument() {
        guard canEditWorkspace() else { return }
        guard var source = activeDocument else { return }
        recordUndoSnapshot()
        source.id = UUID().uuidString
        source.title += " 副本"
        source.createdAt = Date.isoNow
        source.updatedAt = Date.isoNow
        source.nodes = rekey(source.nodes)
        workspace.documents.insert(source, at: 0)
        workspace.activeDocumentId = source.id
        activeNodeId = TreeOperations.firstNodeId(source.nodes)
        show("已创建副本：\(source.title)")
        scheduleSave()
    }

    func deleteActiveDocument() {
        deleteDocument(workspace.activeDocumentId)
    }

    func requestDeleteDocument(_ id: String? = nil) {
        guard canEditWorkspace() else { return }
        guard workspace.documents.count > 1 else {
            show("至少保留一个文档")
            return
        }
        pendingDeleteDocumentId = id ?? workspace.activeDocumentId
        showDeleteConfirmation = true
    }

    func confirmDeletePendingDocument() {
        let targetId = pendingDeleteDocumentId ?? workspace.activeDocumentId
        pendingDeleteDocumentId = nil
        deleteDocument(targetId)
    }

    func cancelDeleteDocument() {
        pendingDeleteDocumentId = nil
    }

    private func deleteDocument(_ id: String) {
        guard canEditWorkspace() else { return }
        guard workspace.documents.count > 1 else {
            show("至少保留一个文档")
            return
        }
        guard let removedIndex = workspace.documents.firstIndex(where: { $0.id == id }) else {
            show("文档不存在")
            return
        }
        let document = workspace.documents[removedIndex]
        recordUndoSnapshot()
        workspace.documents.remove(at: removedIndex)
        if workspace.activeDocumentId == id {
            let nextIndex = min(removedIndex, workspace.documents.count - 1)
            workspace.activeDocumentId = workspace.documents[nextIndex].id
            activeNodeId = TreeOperations.firstNodeId(workspace.documents[nextIndex].nodes)
            focusNodeId = nil
        }
        show("已删除文档：\(document.title)")
        scheduleSave()
    }

    func updateTitle(_ title: String) {
        guard canEditWorkspace() else { return }
        guard let documentId = activeDocument?.id else { return }
        patchActiveDocument(coalescingKey: "title:\(documentId)") { document in
            document.title = title.isEmpty ? Defaults.documentTitle : title
            document.updatedAt = Date.isoNow
            document.markdownSource = nil
            document.markdownUpdatedAt = nil
        }
    }

    func setMarkdownSource(_ value: String, coalescingKey: String? = nil) {
        guard canEditWorkspace() else { return }
        guard var document = activeDocument else { return }
        let normalized = MarkdownCodec.normalizeSource(value)
        guard MarkdownCodec.documentMarkdown(document) != normalized else { return }
        recordUndoSnapshot(coalescingKey: coalescingKey)
        document = MarkdownCodec.parseDocument(normalized, previousDocument: document, documentId: document.id)
        replaceActiveDocument(document)
        activeNodeId = activeNodeId.flatMap { TreeOperations.findNode(in: document.nodes, id: $0)?.id } ?? TreeOperations.firstNodeId(document.nodes)
    }

    func setActiveNodes(
        _ nodes: [OutlineNodeDTO],
        coalescingKey: String? = nil,
        preservesMarkdown: Bool = false
    ) {
        guard canEditWorkspace() else { return }
        guard var document = activeDocument, document.nodes != nodes else { return }
        recordUndoSnapshot(coalescingKey: coalescingKey)
        document.nodes = nodes
        if !preservesMarkdown {
            document.updatedAt = Date.isoNow
            document.markdownSource = nil
            document.markdownUpdatedAt = nil
        }
        replaceActiveDocument(document)
    }

    func updateNode(
        _ id: String,
        coalescingKey: String? = nil,
        preservesMarkdown: Bool = false,
        _ transform: (inout OutlineNodeDTO) -> Void
    ) {
        guard canEditWorkspace() else { return }
        guard let document = activeDocument else { return }
        setActiveNodes(
            TreeOperations.updateNode(document.nodes, id: id, transform: transform),
            coalescingKey: coalescingKey,
            preservesMarkdown: preservesMarkdown
        )
    }

    func updateNodeText(_ id: String, text: String) {
        guard canEditWorkspace() else { return }
        guard let document = activeDocument,
              TreeOperations.findNode(in: document.nodes, id: id)?.text != text else { return }
        recordUndoSnapshot(coalescingKey: "nodeText:\(id)")
        applyActiveNodes(TreeOperations.updateNode(document.nodes, id: id) { node in
            node.text = text
        })
    }

    func toggleStrike(_ id: String) {
        updateNode(id) { node in
            node.strike = !(node.strike ?? false)
        }
    }

    func insertAfter(_ id: String) {
        guard canEditWorkspace() else { return }
        guard let document = activeDocument else { return }
        let node = OutlineNodeDTO(text: "")
        setActiveNodes(TreeOperations.insertSiblingAfter(document.nodes, targetId: id, newNode: node))
        selectNode(node.id, focusEditor: true)
    }

    func insertChild(_ id: String) {
        guard canEditWorkspace() else { return }
        guard let document = activeDocument else { return }
        let node = OutlineNodeDTO(text: "")
        setActiveNodes(TreeOperations.addChild(document.nodes, targetId: id, child: node))
        selectNode(node.id, focusEditor: true)
    }

    func insertMindMapRootChild() {
        guard canEditWorkspace() else { return }
        if let focusNodeId {
            insertChild(focusNodeId)
            show("已新增子节点")
            return
        }
        guard let document = activeDocument else { return }
        let node = OutlineNodeDTO(text: "")
        setActiveNodes(document.nodes + [node])
        selectNode(node.id, focusEditor: true)
        show("已新增子节点")
    }

    func removeNode(_ id: String) {
        guard canEditWorkspace() else { return }
        guard let document = activeDocument else { return }
        let next = TreeOperations.removeNode(document.nodes, targetId: id)
        setActiveNodes(next)
        activeNodeId = TreeOperations.firstNodeId(next)
        if focusNodeId == id { focusNodeId = nil }
        show("已删除主题")
    }

    func indentActive() {
        guard canEditWorkspace() else { return }
        guard let document = activeDocument, let activeNodeId else { return }
        setActiveNodes(TreeOperations.indentNode(document.nodes, targetId: activeNodeId))
    }

    func outdentActive() {
        guard canEditWorkspace() else { return }
        guard let document = activeDocument, let activeNodeId else { return }
        setActiveNodes(TreeOperations.outdentNode(document.nodes, targetId: activeNodeId))
    }

    func moveActive(_ direction: Int) {
        guard canEditWorkspace() else { return }
        guard let document = activeDocument, let activeNodeId else { return }
        setActiveNodes(TreeOperations.moveNode(document.nodes, targetId: activeNodeId, direction: direction))
    }

    func navigateActiveUp() {
        guard let activeNodeId else { return }
        let nodes = visibleNodes
        let flatRows = TreeOperations.flatten(nodes, respectCollapsed: true)
        if let index = flatRows.firstIndex(where: { $0.node.id == activeNodeId }), index > 0 {
            selectNode(flatRows[index - 1].node.id, focusEditor: true)
        }
    }

    func navigateActiveDown() {
        guard let activeNodeId else { return }
        let nodes = visibleNodes
        let flatRows = TreeOperations.flatten(nodes, respectCollapsed: true)
        if let index = flatRows.firstIndex(where: { $0.node.id == activeNodeId }), index < flatRows.count - 1 {
            selectNode(flatRows[index + 1].node.id, focusEditor: true)
        }
    }

    func focusActiveNode() {
        guard canEditWorkspace() else { return }
        guard let activeNodeId else {
            show("请选择一个主题")
            return
        }
        focusOnNode(activeNodeId)
    }

    func focusOnNode(_ id: String) {
        guard canEditWorkspace() else { return }
        guard let document = activeDocument, let node = TreeOperations.findNode(in: document.nodes, id: id) else {
            show("主题不存在")
            return
        }
        selectNode(id, focusEditor: true)
        focusNodeId = id
        show("正在聚焦：\(TreeOperations.nodeText(node))")
    }

    func selectNode(_ id: String, focusEditor: Bool = false) {
        activeNodeId = id
        if focusEditor {
            requestEditorFocus(for: id)
        }
    }

    func requestEditorFocus(for id: String) {
        focusRequestNodeId = id
        focusRequestToken += 1
    }

    func clearEditorFocusRequest() {
        focusRequestNodeId = nil
    }

    func clearFocus() {
        guard canEditWorkspace() else { return }
        guard focusNodeId != nil else { return }
        focusNodeId = nil
        show("已退出聚焦")
    }

    func undoDocumentCommand() {
        undoLastDocumentChange()
    }

    func undoLastDocumentChange() {
        guard canEditWorkspace() else { return }
        guard let snapshot = undoStack.popLast() else { return }
        restoreUndoSnapshot(snapshot)
        show("已撤销")
    }

    func finishCoalescedUndo() {
        lastUndoCoalescingKey = nil
    }

    func setDarkMode(_ enabled: Bool) {
        useDarkMode = enabled
    }

    func toggleDarkMode() {
        setDarkMode(!useDarkMode)
    }

    func openAiConfig() {
        aiConfig = AiConfigStore.load()
        showAiConfigDialog = true
    }

    func saveAiConfig(_ config: AiApiConfig) {
        if let message = AiConfigStore.validationMessage(for: config) {
            show(message)
            return
        }
        aiConfig = AiConfigStore.save(config)
        showAiConfigDialog = false
        show("API 密钥配置已保存")
    }

    func isAiBusy(_ targetId: String) -> Bool {
        aiBusyTargetIds.contains(targetId)
    }

    func performAiNodeAction(_ action: AiNodeAction, targetId: String) {
        Task { await runAiNodeAction(action, targetId: targetId) }
    }

    func performMarkdownAiAction(_ action: AiNodeAction, source: String, selectedRange: NSRange) {
        Task { await runMarkdownAiAction(action, source: source, selectedRange: selectedRange) }
    }

    func checkForUpdates() {
        guard !isCheckingUpdates else { return }
        isCheckingUpdates = true
        show("正在检查更新...")
        Task {
            let result = await UpdateChecker.fetchLatestRelease()
            await MainActor.run {
                self.isCheckingUpdates = false
                self.presentUpdateResult(result)
            }
        }
    }

    func exportActive(format: ExportFormat) {
        guard isWorkspaceReady else {
            show("工作区尚未载入，无法导出")
            return
        }
        guard let document = activeDocument else { return }
        do {
            let result = try ImportExportCodec.exportDocument(document, format: format)
            guard let url = FilePanelService.savePanel(filename: result.filename) else { return }
            try result.data.write(to: url, options: .atomic)
            show("已导出 \(url.lastPathComponent)")
        } catch {
            show("导出失败：\(error.localizedDescription)")
        }
    }

    func exportActivePDF() {
        guard isWorkspaceReady else {
            show("工作区尚未载入，无法导出")
            return
        }
        guard let document = activeDocument else { return }
        let filename = "\(TreeOperations.sanitizeFilenameBase(document.title)).pdf"
        guard let url = FilePanelService.savePanel(filename: filename) else { return }
        do {
            try ImportExportCodec.exportPDF(document).write(to: url, options: .atomic)
            show("已导出 PDF：\(url.lastPathComponent)")
        } catch {
            show("PDF 导出失败：\(error.localizedDescription)")
        }
    }

    func exportWorkspace() {
        guard isWorkspaceReady else {
            show("工作区尚未载入，无法导出")
            return
        }
        guard let url = FilePanelService.savePanel(filename: "bike-workspace.json") else { return }
        do {
            try ImportExportCodec.exportWorkspace(workspace).write(to: url, options: .atomic)
            show("已导出工作区")
        } catch {
            show("工作区导出失败：\(error.localizedDescription)")
        }
    }

    func importFile() {
        guard canEditWorkspace() else { return }
        guard let url = FilePanelService.openImportPanel() else { return }
        do {
            let imported = try ImportExportCodec.importFile(data: Data(contentsOf: url), filename: url.lastPathComponent)
            switch imported {
            case .workspace(let next):
                try repository.createSnapshot(reason: "before-import-workspace", workspace: workspace)
                recordUndoSnapshot()
                workspace = next
                activeNodeId = TreeOperations.firstNodeId(activeDocument?.nodes ?? [])
                focusNodeId = nil
                show("已导入工作区：\(url.lastPathComponent)")
            case .document(let document):
                recordUndoSnapshot()
                workspace.documents.insert(document, at: 0)
                workspace.activeDocumentId = document.id
                activeNodeId = TreeOperations.firstNodeId(document.nodes)
                focusNodeId = nil
                show("已导入文档：\(url.lastPathComponent)")
            }
            finishCoalescedUndo()
            scheduleSave()
        } catch {
            show("导入失败：\(error.localizedDescription)")
        }
    }

    func backupToICloud() {
        guard isWorkspaceReady else {
            show("工作区尚未载入，无法备份")
            return
        }
        let result = ICloudBackupService.save(workspace: workspace)
        show(result.ok ? "JSON 备份已保存：\(result.path ?? "")" : result.error ?? "备份失败")
    }

    func loadICloudBackup() {
        guard canEditWorkspace() else { return }
        switch ICloudBackupService.load() {
        case .success(let (next, path)):
            do {
                try repository.createSnapshot(reason: "before-icloud-restore", workspace: workspace)
            } catch {}
            recordUndoSnapshot()
            workspace = next
            activeNodeId = TreeOperations.firstNodeId(activeDocument?.nodes ?? [])
            focusNodeId = nil
            finishCoalescedUndo()
            scheduleSave()
            show("已载入 iCloud 备份：\(path)")
        case .failure(let error):
            show("载入备份失败：\(error.localizedDescription)")
        }
    }

    func copyNodeLink(_ node: OutlineNodeDTO) {
        guard isWorkspaceReady else {
            show("工作区尚未载入，无法复制链接")
            return
        }
        guard let activeDocument else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("[[\(activeDocument.title)#\(node.text.isEmpty ? Defaults.nodeText : node.text)]]", forType: .string)
        show("已复制主题链接")
    }

    func show(_ message: String) {
        notice = message
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(1500))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self?.notice = nil
            }
        }
    }

    private func patchActiveDocument(coalescingKey: String? = nil, _ mutate: (inout OutlineDocumentDTO) -> Void) {
        guard canEditWorkspace() else { return }
        guard var document = activeDocument else { return }
        let previous = document
        mutate(&document)
        guard document != previous else { return }
        recordUndoSnapshot(coalescingKey: coalescingKey)
        replaceActiveDocument(document)
    }

    private func replaceActiveDocument(_ document: OutlineDocumentDTO) {
        guard isWorkspaceReady else { return }
        guard let index = workspace.documents.firstIndex(where: { $0.id == document.id }) else { return }
        workspace.documents[index] = document
        scheduleSave()
    }

    private func applyActiveNodes(_ nodes: [OutlineNodeDTO]) {
        guard isWorkspaceReady else { return }
        guard var document = activeDocument else { return }
        document.nodes = nodes
        document.updatedAt = Date.isoNow
        document.markdownSource = nil
        document.markdownUpdatedAt = nil
        replaceActiveDocument(document)
    }

    private func recordUndoSnapshot(coalescingKey: String? = nil) {
        if let coalescingKey, lastUndoCoalescingKey == coalescingKey {
            return
        }
        let snapshot = WorkspaceUndoSnapshot(
            workspace: workspace,
            activeNodeId: activeNodeId,
            focusNodeId: focusNodeId
        )
        if let last = undoStack.last,
           last.workspace == snapshot.workspace,
           last.activeNodeId == snapshot.activeNodeId,
           last.focusNodeId == snapshot.focusNodeId {
            return
        }
        undoStack.append(snapshot)
        lastUndoCoalescingKey = coalescingKey
    }

    private func restoreUndoSnapshot(_ snapshot: WorkspaceUndoSnapshot) {
        guard isWorkspaceReady else { return }
        workspace = TreeOperations.normalizeWorkspace(snapshot.workspace)
        activeNodeId = validNodeId(snapshot.activeNodeId) ?? TreeOperations.firstNodeId(activeDocument?.nodes ?? [])
        focusNodeId = validNodeId(snapshot.focusNodeId)
        undoApplyRevision += 1
        finishCoalescedUndo()
        scheduleSave()
    }

    private func validNodeId(_ id: String?) -> String? {
        guard let activeDocument, let id else { return nil }
        return TreeOperations.findNode(in: activeDocument.nodes, id: id)?.id
    }

    private func clearUndoHistory() {
        undoStack.removeAll(keepingCapacity: true)
        finishCoalescedUndo()
    }

    private func applyAppearance() {
        NSApp.appearance = NSAppearance(named: useDarkMode ? .darkAqua : .aqua)
    }

    private func canEditWorkspace() -> Bool {
        guard isWorkspaceReady else {
            show("工作区尚未载入，无法编辑")
            return false
        }
        return true
    }

    private func rekey(_ nodes: [OutlineNodeDTO]) -> [OutlineNodeDTO] {
        nodes.map { node in
            var copy = node
            copy.id = "node_\(UUID().uuidString)"
            copy.children = rekey(copy.children)
            return copy
        }
    }

    private func runAiNodeAction(_ action: AiNodeAction, targetId: String) async {
        guard canEditWorkspace() else { return }
        guard let document = activeDocument,
              let target = TreeOperations.findNode(in: document.nodes, id: targetId) else {
            show("请选择一个主题")
            return
        }
        guard AiConfigStore.validationMessage(for: aiConfig) == nil else {
            show("请先配置 API 密钥")
            openAiConfig()
            return
        }
        guard !aiBusyTargetIds.contains(targetId) else { return }

        aiBusyTargetIds.insert(targetId)
        show(action == .generate ? "AI 正在生成子主题..." : "AI 正在润色主题...")
        defer { aiBusyTargetIds.remove(targetId) }

        do {
            let result = try await AiService.run(
                config: aiConfig,
                action: action,
                context: AiActionContext(
                    documentTitle: document.title,
                    topicText: target.text,
                    note: target.note,
                    existingChildren: target.children.map(\.text)
                )
            )

            switch action {
            case .polish:
                guard let text = result.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
                    throw AiServiceError.missingPolishText
                }
                updateNodeText(targetId, text: text)
                show("已润色当前主题")
            case .generate:
                let generated = AiService.generatedNodesToOutlineNodes(result.children)
                guard !generated.isEmpty else {
                    throw AiServiceError.requestFailed("AI 没有生成可用子主题")
                }
                guard let latestDocument = activeDocument else { return }
                setActiveNodes(TreeOperations.updateNode(latestDocument.nodes, id: targetId) { node in
                    node.collapsed = false
                    node.children.append(contentsOf: generated)
                })
                show("已生成 \(generated.count) 个子主题")
            }
        } catch {
            show(error.localizedDescription)
        }
    }

    private func runMarkdownAiAction(_ action: AiNodeAction, source: String, selectedRange: NSRange) async {
        guard canEditWorkspace() else { return }
        guard let document = activeDocument else { return }
        guard let target = markdownLineTarget(source: source, selectedRange: selectedRange) else {
            show("请先把光标放在一个 Markdown 主题行")
            return
        }
        guard AiConfigStore.validationMessage(for: aiConfig) == nil else {
            show("请先配置 API 密钥")
            openAiConfig()
            return
        }

        let busyKey = "markdown"
        guard !aiBusyTargetIds.contains(busyKey) else { return }
        aiBusyTargetIds.insert(busyKey)
        show(action == .generate ? "AI 正在生成 Markdown 子主题..." : "AI 正在润色 Markdown 主题...")
        defer { aiBusyTargetIds.remove(busyKey) }

        do {
            let result = try await AiService.run(
                config: aiConfig,
                action: action,
                context: AiActionContext(
                    documentTitle: document.title,
                    topicText: target.text,
                    note: "",
                    existingChildren: []
                )
            )
            switch action {
            case .polish:
                guard let text = result.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
                    throw AiServiceError.missingPolishText
                }
                let next = replaceMarkdownLineBody(source: source, target: target, replacement: text)
                setMarkdownSource(next, coalescingKey: "markdown-ai:\(document.id)")
                show("已润色当前 Markdown 主题")
            case .generate:
                let generated = result.children ?? []
                guard !generated.isEmpty else {
                    throw AiServiceError.requestFailed("AI 没有生成可用子主题")
                }
                let insertion = markdownChildLines(for: generated, parentPrefix: target.prefix)
                let next = insertMarkdownLines(source: source, target: target, insertion: insertion)
                setMarkdownSource(next, coalescingKey: "markdown-ai:\(document.id)")
                show("已生成 Markdown 子主题")
            }
        } catch {
            show(error.localizedDescription)
        }
    }

    private func presentUpdateResult(_ result: UpdateCheckResult) {
        if !result.ok {
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = "检查更新失败"
            alert.informativeText = "\(result.error ?? "请稍后重试")\n\n当前版本：\(result.currentVersion)"
            alert.addButton(withTitle: "好")
            alert.addButton(withTitle: "打开发布页")
            if alert.runModal() == .alertSecondButtonReturn {
                NSWorkspace.shared.open(result.releaseUrl)
            }
            return
        }

        let alert = NSAlert()
        alert.alertStyle = result.updateAvailable ? .informational : .informational
        alert.messageText = result.updateAvailable ? "发现新版本 \(result.latestVersion)" : "当前已是最新版本"
        alert.informativeText = result.updateAvailable
            ? "当前版本：\(result.currentVersion)\n最新版本：\(result.latestVersion)\n\(result.releaseName)"
            : "当前版本：\(result.currentVersion)"
        alert.addButton(withTitle: result.updateAvailable ? "打开发布页" : "好")
        alert.addButton(withTitle: result.updateAvailable ? "稍后" : "打开发布页")
        let response = alert.runModal()
        if (result.updateAvailable && response == .alertFirstButtonReturn) ||
            (!result.updateAvailable && response == .alertSecondButtonReturn) {
            NSWorkspace.shared.open(result.releaseUrl)
        }
    }

    private struct MarkdownLineTarget {
        var lineRange: NSRange
        var bodyRange: NSRange
        var prefix: String
        var text: String
        var line: String
    }

    private func markdownLineTarget(source: String, selectedRange: NSRange) -> MarkdownLineTarget? {
        let nsSource = source as NSString
        let length = nsSource.length
        guard length > 0 else { return nil }
        let location = min(max(0, selectedRange.location), max(0, length - 1))
        let lineRange = nsSource.lineRange(for: NSRange(location: location, length: 0))
        let rawLine = nsSource.substring(with: lineRange)
        let line = rawLine.trimmingCharacters(in: .newlines)
        guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }

        let pattern = #"^([ \t]*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+|>\s*)?)(.*)$"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
              match.numberOfRanges >= 3,
              let prefixRange = Range(match.range(at: 1), in: line),
              let bodyRangeInLine = Range(match.range(at: 2), in: line) else {
            return nil
        }

        let prefix = String(line[prefixRange])
        let text = String(line[bodyRangeInLine]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let prefixLength = (prefix as NSString).length
        let bodyLength = (line as NSString).length - prefixLength
        return MarkdownLineTarget(
            lineRange: lineRange,
            bodyRange: NSRange(location: lineRange.location + prefixLength, length: bodyLength),
            prefix: prefix,
            text: text,
            line: line
        )
    }

    private func replaceMarkdownLineBody(source: String, target: MarkdownLineTarget, replacement: String) -> String {
        let mutable = NSMutableString(string: source)
        mutable.replaceCharacters(in: target.bodyRange, with: replacement)
        return mutable as String
    }

    private func insertMarkdownLines(source: String, target: MarkdownLineTarget, insertion: String) -> String {
        let mutable = NSMutableString(string: source)
        let insertAt = target.lineRange.location + target.lineRange.length
        let needsLeadingNewline = !target.line.hasSuffix("\n") && insertAt >= (source as NSString).length
        mutable.insert((needsLeadingNewline ? "\n" : "") + insertion, at: insertAt)
        return mutable as String
    }

    private func markdownChildLines(for nodes: [AiGeneratedNode], parentPrefix: String) -> String {
        let parentIndent = parentPrefix.prefix { $0 == " " || $0 == "\t" }
        let childIndent = String(parentIndent) + "  "

        func lines(_ nodes: [AiGeneratedNode], indent: String, depth: Int) -> [String] {
            guard depth <= 3 else { return [] }
            return nodes.flatMap { node -> [String] in
                let text = node.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { return [] }
                return ["\(indent)- \(text)"] + lines(node.children, indent: indent + "  ", depth: depth + 1)
            }
        }

        return lines(nodes, indent: childIndent, depth: 1).joined(separator: "\n") + "\n"
    }
}
