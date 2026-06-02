import Foundation

enum SelfTestError: Error, CustomStringConvertible {
    case failed(String)

    var description: String {
        switch self {
        case .failed(let message): message
        }
    }
}

enum SelfTestRunner {
    @MainActor
    static func run() throws {
        try workspaceNormalizationRepairsEmptyWorkspace()
        try treeOperationsInsertIndentOutdent()
        try markdownRoundTripPreservesTitleAndTasks()
        try jsonWorkspaceCompatibility()
        try tagAndLinkExtraction()
        try documentUndoWorksAcrossOutlineMindMapAndMarkdown()
        try appStoreDoesNotSaveStarterWorkspaceAfterLoadFailure()
        try repositoryPersistsDocumentsAsMarkdownFiles()
        try repositoryAdoptsExternalMarkdownFilename()
        try repositorySkipsUnchangedMarkdownWrites()
        try repositoryMigratesLegacyICloudBackupToMarkdownFiles()
        try repositorySavesSnapshotsAndRestores()
        try iCloudBackupWritesLatestAndStampedFiles()
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw SelfTestError.failed(message) }
    }

    private static func workspaceNormalizationRepairsEmptyWorkspace() throws {
        let workspace = TreeOperations.normalizeWorkspace(WorkspaceV1DTO(activeDocumentId: "missing", documents: []))
        try expect(workspace.version == 1, "workspace version should be 1")
        try expect(workspace.documents.count == 1, "empty workspace should get starter document")
        try expect(workspace.activeDocumentId == workspace.documents[0].id, "active document should be repaired")
        try expect(!workspace.documents[0].nodes.isEmpty, "document should contain at least one node")
    }

    private static func treeOperationsInsertIndentOutdent() throws {
        let a = OutlineNodeDTO(id: "a", text: "A")
        let b = OutlineNodeDTO(id: "b", text: "B")
        var nodes = [a, b]
        nodes = TreeOperations.indentNode(nodes, targetId: "b")
        try expect(nodes.count == 1, "indent should move node into previous sibling")
        try expect(nodes[0].children.first?.id == "b", "indented child should be b")
        nodes = TreeOperations.outdentNode(nodes, targetId: "b")
        try expect(nodes.map(\.id) == ["a", "b"], "outdent should restore sibling order")
    }

    private static func markdownRoundTripPreservesTitleAndTasks() throws {
        let markdown = """
        # Plan

        - [x] Done
          > Note
        - Next
        """
        let document = MarkdownCodec.parseDocument(markdown)
        try expect(document.title == "Plan", "markdown title should parse")
        try expect(document.nodes.first?.checked == true, "task checked state should parse")
        try expect(document.nodes.first?.note == "Note", "quote should attach as note")
        try expect(MarkdownCodec.documentMarkdown(document).contains("# Plan"), "markdown export should keep title")
    }

    private static func jsonWorkspaceCompatibility() throws {
        let workspace = SampleData.starterWorkspace()
        let data = try ImportExportCodec.exportWorkspace(workspace)
        let decoded = try ImportExportCodec.jsonDecoder.decode(WorkspaceV1DTO.self, from: data)
        try expect(decoded.version == 1, "workspace json version should be 1")
        try expect(decoded.documents.first?.title == "本地化大纲产品蓝图", "starter title should round trip")
    }

    private static func tagAndLinkExtraction() throws {
        try expect(TreeOperations.extractTags("hello #项目 #local-first") == ["项目", "local-first"], "tag extraction failed")
        try expect(TreeOperations.extractLinks("见 [[文档名]] 和 [[A#B]]") == ["文档名", "A#B"], "link extraction failed")
    }

    @MainActor
    private static func documentUndoWorksAcrossOutlineMindMapAndMarkdown() throws {
        let repository = try WorkspaceRepository(inMemory: true)
        let store = AppStore(repository: repository)
        let node = OutlineNodeDTO(id: "undo-node", text: "Undo me")
        let document = OutlineDocumentDTO(id: "undo-doc", title: "Undo", nodes: [node])
        store.workspace = WorkspaceV1DTO(activeDocumentId: document.id, documents: [document])
        store.loadState = .loaded
        store.mode = .outline
        store.activeNodeId = node.id
        let initialWorkspace = store.workspace

        store.toggleStrike(node.id)
        try expect(store.activeNode?.strike == true, "strike toggle should mark node")
        store.insertChild(node.id)
        try expect(store.activeNode?.id != node.id, "insert child should select new node")
        store.undoLastDocumentChange()
        try expect(store.activeDocument?.nodes.first?.strike == true, "first undo should restore previous outline operation")
        store.undoLastDocumentChange()
        try expect(store.workspace == initialWorkspace, "second undo should return to startup workspace")

        store.removeNode(node.id)
        try expect(TreeOperations.findNode(in: store.activeDocument?.nodes ?? [], id: node.id) == nil, "remove should delete target node")
        store.undoLastDocumentChange()
        try expect(store.activeDocument?.nodes.first?.id == node.id, "undo should restore deleted node")

        store.mode = .mindmap
        store.insertMindMapRootChild()
        try expect((store.activeDocument?.nodes.count ?? 0) == 2, "mind map root insert should add node")
        store.undoLastDocumentChange()
        try expect((store.activeDocument?.nodes.count ?? 0) == 1, "undo should restore mind map change")

        let beforeMarkdown = store.workspace
        store.mode = .markdown
        store.setMarkdownSource("# Changed\n\n- Markdown node", coalescingKey: "markdown:undo-doc")
        try expect(store.activeDocument?.title == "Changed", "markdown edit should change title")
        store.undoLastDocumentChange()
        try expect(store.workspace == beforeMarkdown, "undo should restore markdown change")

        store.toggleStrike(node.id)
        try expect(store.activeNode?.strike == true, "strike toggle should mark node after cross-mode undos")
        store.undoLastDocumentChange()
        try expect(store.activeNode?.strike != true, "undo should restore strike state")
    }

    @MainActor
    private static func appStoreDoesNotSaveStarterWorkspaceAfterLoadFailure() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("LocalOutlineLoadFailureSelfTest-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: base) }

        let seedRepository = try WorkspaceRepository(inMemory: true, baseURL: base)
        let document = OutlineDocumentDTO(id: "real-doc", title: "Real Note", nodes: [OutlineNodeDTO(text: "Keep me")])
        try seedRepository.saveWorkspace(WorkspaceV1DTO(activeDocumentId: document.id, documents: [document]))

        let realURL = base.appendingPathComponent("Real Note.md")
        try Data([0xff, 0xfe, 0xfd]).write(to: realURL, options: .atomic)

        let failingRepository = try WorkspaceRepository(inMemory: true, baseURL: base)
        let store = AppStore(repository: failingRepository)
        store.load()
        guard case .failed = store.loadState else {
            throw SelfTestError.failed("load failure should put store in failed state")
        }

        store.flushSaveNow()

        let markdownFiles = try FileManager.default.contentsOfDirectory(
            at: base,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )
            .filter { ["md", "markdown"].contains($0.pathExtension.lowercased()) }
            .map(\.lastPathComponent)
            .sorted()

        try expect(markdownFiles == ["Real Note.md"], "failed load should not save starter workspace over real markdown files")
        let unreadableData = try Data(contentsOf: realURL)
        try expect(unreadableData == Data([0xff, 0xfe, 0xfd]), "failed load should not rewrite unreadable markdown file")
    }

    @MainActor
    private static func repositoryPersistsDocumentsAsMarkdownFiles() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("LocalOutlineMarkdownSelfTest-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: base) }

        let repository = try WorkspaceRepository(inMemory: true, baseURL: base)
        let first = OutlineDocumentDTO(id: "doc-1", title: "Alpha Note", nodes: [OutlineNodeDTO(text: "First")])
        let second = OutlineDocumentDTO(id: "doc-2", title: "Alpha Note", nodes: [OutlineNodeDTO(text: "Second")])
        var workspace = WorkspaceV1DTO(activeDocumentId: second.id, documents: [first, second])
        try repository.saveWorkspace(workspace)

        try expect(FileManager.default.fileExists(atPath: base.appendingPathComponent("Alpha Note.md").path), "first markdown file should be saved")
        try expect(FileManager.default.fileExists(atPath: base.appendingPathComponent("Alpha Note 2.md").path), "duplicate titles should get unique markdown filenames")

        let reloaded = try repository.loadWorkspace()
        try expect(reloaded.documents.count == 2, "markdown files should load as documents")
        try expect(reloaded.activeDocumentId == second.id, "active document should be restored from metadata")

        workspace.documents[0].title = "Renamed"
        workspace.documents.removeLast()
        workspace.activeDocumentId = workspace.documents[0].id
        try repository.saveWorkspace(workspace)

        try expect(FileManager.default.fileExists(atPath: base.appendingPathComponent("Renamed.md").path), "renamed title should rename markdown file")
        try expect(!FileManager.default.fileExists(atPath: base.appendingPathComponent("Alpha Note.md").path), "old markdown filename should be removed after rename")
        try expect(!FileManager.default.fileExists(atPath: base.appendingPathComponent("Alpha Note 2.md").path), "deleted document markdown file should be removed")
    }

    @MainActor
    private static func repositoryAdoptsExternalMarkdownFilename() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("LocalOutlineExternalMarkdownSelfTest-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: base) }

        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        let externalURL = base.appendingPathComponent("meeting.md")
        try "# Q1 Plan\n\n- Keep original filename\n".write(to: externalURL, atomically: true, encoding: .utf8)

        let repository = try WorkspaceRepository(inMemory: true, baseURL: base)
        var loaded = try repository.loadWorkspace()
        try expect(loaded.documents.first?.title == "Q1 Plan", "external markdown title should parse")
        loaded.documents[0].nodes[0].text = "Updated"
        try repository.saveWorkspace(loaded)

        try expect(FileManager.default.fileExists(atPath: externalURL.path), "external markdown filename should be adopted")
        try expect(!FileManager.default.fileExists(atPath: base.appendingPathComponent("Q1 Plan.md").path), "save should not duplicate external markdown under title filename")
        let reloaded = try repository.loadWorkspace()
        try expect(reloaded.documents.count == 1, "adopted external markdown should not duplicate on reload")
    }

    @MainActor
    private static func repositorySkipsUnchangedMarkdownWrites() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("LocalOutlineUnchangedWriteSelfTest-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: base) }

        let repository = try WorkspaceRepository(inMemory: true, baseURL: base)
        let first = OutlineDocumentDTO(id: "doc-1", title: "Stable", nodes: [OutlineNodeDTO(text: "Unchanged")])
        var second = OutlineDocumentDTO(id: "doc-2", title: "Changed", nodes: [OutlineNodeDTO(text: "Before")])
        var workspace = WorkspaceV1DTO(activeDocumentId: first.id, documents: [first, second])
        try repository.saveWorkspace(workspace)

        let stableURL = base.appendingPathComponent("Stable.md")
        let originalDate = Date(timeIntervalSince1970: 1_700_000_000)
        try FileManager.default.setAttributes([.modificationDate: originalDate], ofItemAtPath: stableURL.path)

        second.nodes[0].text = "After"
        workspace.documents = [first, second]
        try repository.saveWorkspace(workspace)

        let attributes = try FileManager.default.attributesOfItem(atPath: stableURL.path)
        let actualDate = (attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? -1
        try expect(actualDate == originalDate.timeIntervalSince1970, "unchanged markdown file should not be rewritten, expected \(originalDate.timeIntervalSince1970), got \(actualDate)")
    }

    @MainActor
    private static func repositoryMigratesLegacyICloudBackupToMarkdownFiles() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("LocalOutlineLegacyICloudSelfTest-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: base) }

        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        let document = OutlineDocumentDTO(id: "legacy-doc", title: "Legacy Backup", nodes: [OutlineNodeDTO(text: "Migrated")])
        let workspace = WorkspaceV1DTO(activeDocumentId: document.id, documents: [document])
        try ImportExportCodec.exportWorkspace(workspace).write(
            to: base.appendingPathComponent(ICloudBackupService.latestBackupFilename),
            options: .atomic
        )

        let repository = try WorkspaceRepository(inMemory: true, baseURL: base)
        let loaded = try repository.loadWorkspace()
        try expect(loaded.documents.first?.title == "Legacy Backup", "legacy iCloud backup should load")
        try expect(FileManager.default.fileExists(atPath: base.appendingPathComponent("Legacy Backup.md").path), "legacy iCloud backup should migrate to markdown")
        try expect(!FileManager.default.fileExists(atPath: base.appendingPathComponent(ICloudBackupService.latestBackupFilename).path), "legacy root backup should be moved out of markdown directory")
        try expect(FileManager.default.fileExists(atPath: base.appendingPathComponent(".backups/\(ICloudBackupService.latestBackupFilename)").path), "legacy root backup should be archived")
    }

    @MainActor
    private static func repositorySavesSnapshotsAndRestores() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("LocalOutlineSelfTest-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: base) }

        let repository = try WorkspaceRepository(inMemory: true, baseURL: base)
        var workspace = SampleData.starterWorkspace()
        workspace.documents[0].title = "Snapshot source"
        try repository.saveWorkspace(workspace)
        try repository.createSnapshot(reason: "manual", workspace: workspace)

        workspace.documents[0].title = "Changed"
        try repository.saveWorkspace(workspace)

        let snapshots = try repository.listSnapshots()
        try expect(!snapshots.isEmpty, "snapshot list should not be empty")
        let restored = try repository.restoreSnapshot(snapshots[0], currentWorkspace: workspace)
        try expect(restored.documents[0].title == "Snapshot source", "snapshot restore should recover saved title")
        let restoredSnapshots = try repository.listSnapshots()
        try expect(restoredSnapshots.contains { $0.reason.hasPrefix("before-restore") }, "restore should create before-restore snapshot")
    }

    private static func iCloudBackupWritesLatestAndStampedFiles() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("LocalOutlineBackupSelfTest-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let workspace = SampleData.starterWorkspace()
        let result = ICloudBackupService.save(workspace: workspace, directory: directory)
        try expect(result.ok, "backup save should succeed")
        try expect(FileManager.default.fileExists(atPath: directory.appendingPathComponent(ICloudBackupService.latestBackupFilename).path), "latest backup should exist")
        let backups = try ICloudBackupService.listBackups(directory: directory)
        try expect(backups.count == 2, "latest and stamped backup should be listed")
        let loaded = try ICloudBackupService.load(directory: directory).get().0
        try expect(loaded == workspace, "loaded backup should match saved workspace")
    }
}
