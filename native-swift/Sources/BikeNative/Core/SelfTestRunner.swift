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
        try treeOperationsRemoveDoesNotTreatDefaultTextAsGlobalPlaceholder()
        try markdownRoundTripPreservesTitleAndTasks()
        try codeBlockRoundTripsAcrossCodecs()
        try jsonWorkspaceCompatibility()
        try tagAndLinkExtraction()
        try updateCheckerComparesSemanticVersions()
        try aiParserAcceptsFlexibleGeneratedNodes()
        try aiParserExtractsResponsesEventStream()
        try mindMapLayoutExposesCollapsedChildrenState()
        try documentUndoWorksAcrossOutlineMindMapAndMarkdown()
        try appStoreDoesNotSaveStarterWorkspaceAfterLoadFailure()
        try appStoreDeleteConfirmationTargetsRequestedDocument()
        try repositoryPersistsDocumentsAsMarkdownFiles()
        try repositoryRenamesWithoutOverwritingOccupiedMarkdownFilename()
        try repositoryPreservesNodeMetadataAcrossMarkdownReload()
        try markdownPreviousMatcherPreservesMetadataAfterExternalReorder()
        try repositoryAdoptsExternalMarkdownFilename()
        try repositoryUsesExternalMarkdownModificationDate()
        try repositorySkipsUnchangedMarkdownWrites()
        try repositoryMigratesLegacyICloudBackupToMarkdownFiles()
        try repositorySavesSnapshotsAndRestores()
        try iCloudBackupWritesLatestAndStampedFiles()
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw SelfTestError.failed(message) }
    }

    private static func expectDate(_ iso: String, _ message: String) throws -> Date {
        guard let date = ISO8601DateFormatter.bike.date(from: iso) else {
            throw SelfTestError.failed(message)
        }
        return date
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

    private static func treeOperationsRemoveDoesNotTreatDefaultTextAsGlobalPlaceholder() throws {
        let retainedChild = OutlineNodeDTO(id: "child", text: Defaults.nodeText)
        let retainedParent = OutlineNodeDTO(id: "parent", text: "Parent", children: [retainedChild])
        let removed = OutlineNodeDTO(id: "removed", text: "Remove")
        let next = TreeOperations.removeNode([retainedParent, removed], targetId: "removed")
        try expect(next.first?.children.first?.id == "child", "remove should preserve unrelated single child with default text")

        let emptiedParent = TreeOperations.removeNode([retainedParent], targetId: "child")
        try expect(emptiedParent.first?.children.isEmpty == true, "removing an only child should leave parent children empty, not insert a placeholder child")
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

    private static func codeBlockRoundTripsAcrossCodecs() throws {
        let child = OutlineNodeDTO(
            id: "nested-code-node",
            text: "Nested",
            codeBlock: "console.log('nested')",
            codeLanguage: "js"
        )
        let node = OutlineNodeDTO(
            id: "code-node",
            text: "Example",
            codeBlock: "let value = 1\nprint(value)",
            codeLanguage: "swift",
            children: [child]
        )
        let document = OutlineDocumentDTO(id: "code-doc", title: "Code", nodes: [node])
        let workspace = WorkspaceV1DTO(activeDocumentId: document.id, documents: [document])

        let jsonData = try ImportExportCodec.exportWorkspace(workspace)
        let jsonDecoded = try ImportExportCodec.jsonDecoder.decode(WorkspaceV1DTO.self, from: jsonData)
        try expect(jsonDecoded.documents[0].nodes[0].codeBlock == node.codeBlock, "code block should survive JSON workspace round trip")
        try expect(jsonDecoded.documents[0].nodes[0].codeLanguage == "swift", "code language should survive JSON workspace round trip")

        let markdown = MarkdownCodec.documentMarkdown(document)
        try expect(markdown.contains("```swift"), "markdown export should include code fence language")
        let parsedMarkdown = MarkdownCodec.parseDocument(
            markdown,
            previousDocument: document,
            documentId: document.id,
            now: document.updatedAt
        )
        try expect(parsedMarkdown.nodes[0].codeBlock == node.codeBlock, "code block should survive markdown parse")
        try expect(parsedMarkdown.nodes[0].codeLanguage == "swift", "code language should survive markdown parse")
        try expect(parsedMarkdown.nodes[0].children[0].codeBlock == child.codeBlock, "nested code block should survive markdown parse")
        try expect(parsedMarkdown.nodes[0].children[0].codeLanguage == "js", "nested code language should survive markdown parse")

        let opml = try ImportExportCodec.exportDocument(document, format: .opml)
        guard case .document(let importedOPML) = try ImportExportCodec.importFile(data: opml.data, filename: opml.filename) else {
            throw SelfTestError.failed("OPML import should return a document")
        }
        try expect(importedOPML.nodes[0].codeBlock == node.codeBlock, "code block should survive OPML round trip")
        try expect(importedOPML.nodes[0].codeLanguage == "swift", "code language should survive OPML round trip")
        try expect(importedOPML.nodes[0].children[0].codeBlock == child.codeBlock, "nested code block should survive OPML round trip")
        try expect(importedOPML.nodes[0].children[0].codeLanguage == "js", "nested code language should survive OPML round trip")
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

    private static func updateCheckerComparesSemanticVersions() throws {
        try expect(UpdateChecker.compareVersions("1.4.0", "1.3.2") == 1, "1.4.0 should be newer than 1.3.2")
        try expect(UpdateChecker.compareVersions("v1.4.0", "1.4.0") == 0, "v-prefix should be ignored")
        let result = UpdateChecker.resultFromRelease(currentVersion: "1.3.2", release: [
            "tag_name": "v1.4.0",
            "html_url": "https://example.com/releases",
            "name": "Bike 1.4.0"
        ])
        try expect(result.updateAvailable, "release result should detect update")
        try expect(result.latestVersion == "1.4.0", "release tag should normalize")
    }

    private static func aiParserAcceptsFlexibleGeneratedNodes() throws {
        let parsed = try AiService.parseJSONText("""
        前置说明
        {"topics":[{"title":"一级","items":["二级",{"topic":"二级 B","subtopics":[{"label":"三级"}]}]}]}
        后置说明
        """)
        let result = try AiService.normalizeActionResult(action: .generate, parsed: parsed)
        let nodes = result.children ?? []
        try expect(nodes.count == 1, "AI parser should find topics container")
        try expect(nodes[0].text == "一级", "AI parser should accept title field")
        try expect(nodes[0].children.count == 2, "AI parser should accept string and object children")
        try expect(nodes[0].children[1].children.first?.text == "三级", "AI parser should accept nested label field")
    }

    private static func aiParserExtractsResponsesEventStream() throws {
        let stream = """
        event: response.output_text.delta
        data: {"type":"response.output_text.delta","delta":"{\\"children\\":[{\\"text\\":\\"A\\"}]}"}

        data: [DONE]
        """
        let text = AiService.extractTextFromEventStream(stream)
        let parsed = try AiService.parseJSONText(text)
        let result = try AiService.normalizeActionResult(action: .generate, parsed: parsed)
        try expect(result.children?.first?.text == "A", "AI parser should read response event stream")
    }

    private static func mindMapLayoutExposesCollapsedChildrenState() throws {
        let parent = OutlineNodeDTO(
            id: "collapsed-parent",
            text: "Parent",
            collapsed: true,
            children: [
                OutlineNodeDTO(id: "hidden-child", text: "Child")
            ]
        )
        let layout = MindMapLayout.layout(title: "Doc", nodes: [parent])
        guard let item = layout.items.first(where: { $0.id == "collapsed-parent" }) else {
            throw SelfTestError.failed("collapsed parent should be visible in mind map layout")
        }
        try expect(item.hasChildren, "collapsed parent should expose children state for expand control")
        try expect(item.childCount == 1, "collapsed parent should expose direct child count for expand control")
        try expect(item.isCollapsed, "collapsed parent should expose collapsed state for expand control")
        try expect(layout.items.contains { $0.id == "hidden-child" } == false, "collapsed child should stay hidden until expanded")
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

        store.updateNode(node.id, coalescingKey: "nodeNote:\(node.id)") { $0.note = "a" }
        store.updateNode(node.id, coalescingKey: "nodeNote:\(node.id)") { $0.note = "ab" }
        try expect(store.activeNode?.note == "ab", "note edits should apply")
        store.undoLastDocumentChange()
        try expect(store.activeNode?.note.isEmpty == true, "one undo should restore coalesced note edits")

        let collapseStore = AppStore(repository: repository)
        var markdownDocument = document
        markdownDocument.markdownSource = "# Undo\n\n- Undo me"
        markdownDocument.markdownUpdatedAt = markdownDocument.updatedAt
        collapseStore.workspace = WorkspaceV1DTO(activeDocumentId: markdownDocument.id, documents: [markdownDocument])
        collapseStore.loadState = .loaded
        collapseStore.activeNodeId = node.id
        let markdownUpdatedAt = markdownDocument.updatedAt
        collapseStore.updateNode(node.id, preservesMarkdown: true) { $0.collapsed = true }
        try expect(collapseStore.activeDocument?.markdownSource != nil, "collapse should preserve markdown source")
        try expect(collapseStore.activeDocument?.updatedAt == markdownUpdatedAt, "collapse should not bump document updatedAt")

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
            .appendingPathComponent("BikeLoadFailureSelfTest-\(UUID().uuidString)", isDirectory: true)
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
    private static func appStoreDeleteConfirmationTargetsRequestedDocument() throws {
        let repository = try WorkspaceRepository(inMemory: true)
        let first = OutlineDocumentDTO(id: "doc-a", title: "A", nodes: [OutlineNodeDTO(text: "A")])
        let second = OutlineDocumentDTO(id: "doc-b", title: "B", nodes: [OutlineNodeDTO(text: "B")])
        let store = AppStore(repository: repository)
        store.workspace = WorkspaceV1DTO(activeDocumentId: first.id, documents: [first, second])
        store.loadState = .loaded
        store.activeNodeId = first.nodes[0].id

        store.requestDeleteDocument(second.id)
        try expect(store.workspace.activeDocumentId == first.id, "requesting context-menu delete should not switch active document")
        try expect(store.pendingDeleteDocumentId == second.id, "delete confirmation should target requested document")
        store.confirmDeletePendingDocument()
        try expect(store.workspace.documents.map(\.id) == [first.id], "confirming delete should remove requested document")
        try expect(store.workspace.activeDocumentId == first.id, "deleting inactive document should keep active document")
    }

    @MainActor
    private static func repositoryPersistsDocumentsAsMarkdownFiles() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("BikeMarkdownSelfTest-\(UUID().uuidString)", isDirectory: true)
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
    private static func repositoryRenamesWithoutOverwritingOccupiedMarkdownFilename() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("BikeRenameCollisionSelfTest-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: base) }

        let repository = try WorkspaceRepository(inMemory: true, baseURL: base)
        let first = OutlineDocumentDTO(id: "doc-alpha", title: "Alpha", nodes: [OutlineNodeDTO(text: "First body")])
        let second = OutlineDocumentDTO(id: "doc-x", title: "x", nodes: [OutlineNodeDTO(text: "Second body")])
        var workspace = WorkspaceV1DTO(activeDocumentId: first.id, documents: [first, second])
        try repository.saveWorkspace(workspace)

        workspace.documents[0].title = "x"
        try repository.saveWorkspace(workspace)

        let occupiedContent = try String(contentsOf: base.appendingPathComponent("x.md"), encoding: .utf8)
        let renamedContent = try String(contentsOf: base.appendingPathComponent("x 2.md"), encoding: .utf8)
        try expect(occupiedContent.contains("Second body"), "existing markdown owner should keep its content")
        try expect(renamedContent.contains("First body"), "renamed document should be written to a unique markdown filename")
        try expect(!FileManager.default.fileExists(atPath: base.appendingPathComponent("Alpha.md").path), "old markdown filename should be removed after collision-safe rename")
    }

    @MainActor
    private static func repositoryPreservesNodeMetadataAcrossMarkdownReload() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("BikeNodeMetadataSelfTest-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: base) }

        let repository = try WorkspaceRepository(inMemory: true, baseURL: base)
        let child = OutlineNodeDTO(id: "child", text: "Child", color: "rose", bold: true, strike: true, highlight: true, icon: "★")
        let root = OutlineNodeDTO(id: "root", text: "Root", collapsed: true, color: "blue", italic: true, underline: true, children: [child])
        let document = OutlineDocumentDTO(id: "doc", title: "Metadata", nodes: [root])
        try repository.saveWorkspace(WorkspaceV1DTO(activeDocumentId: document.id, documents: [document]))

        let reloaded = try WorkspaceRepository(inMemory: true, baseURL: base).loadWorkspace()
        let reloadedRoot = reloaded.documents.first?.nodes.first
        let reloadedChild = reloadedRoot?.children.first
        try expect(reloadedRoot?.id == "root", "root id should survive markdown reload")
        try expect(reloadedRoot?.collapsed == true, "collapsed state should survive markdown reload")
        try expect(reloadedRoot?.color == "blue", "node color should survive markdown reload")
        try expect(reloadedRoot?.italic == true && reloadedRoot?.underline == true, "inline style flags should survive markdown reload")
        try expect(reloadedChild?.id == "child", "child id should survive markdown reload")
        try expect(reloadedChild?.color == "rose" && reloadedChild?.bold == true && reloadedChild?.strike == true && reloadedChild?.highlight == true, "child style metadata should survive markdown reload")
        try expect(reloadedChild?.icon == "★", "node icon should survive markdown reload")
    }

    private static func markdownPreviousMatcherPreservesMetadataAfterExternalReorder() throws {
        let first = OutlineNodeDTO(id: "first", text: "Alpha", color: "blue", bold: true)
        let second = OutlineNodeDTO(id: "second", text: "Beta", color: "rose", italic: true)
        let previous = OutlineDocumentDTO(id: "doc", title: "Metadata", nodes: [first, second])

        let parsed = MarkdownCodec.parseDocument(
            """
            # Metadata

            - Beta
            - Alpha
            """,
            previousDocument: previous,
            documentId: previous.id,
            now: previous.updatedAt
        )

        try expect(parsed.nodes.map(\.id) == ["second", "first"], "reordered markdown should preserve ids by text, not stale path")
        try expect(parsed.nodes.map(\.color) == ["rose", "blue"], "reordered markdown should keep colors with matching text")
        try expect(parsed.nodes[0].italic == true && parsed.nodes[1].bold == true, "reordered markdown should keep style metadata with matching text")
    }

    @MainActor
    private static func repositoryAdoptsExternalMarkdownFilename() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("BikeExternalMarkdownSelfTest-\(UUID().uuidString)", isDirectory: true)
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
    private static func repositoryUsesExternalMarkdownModificationDate() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("BikeExternalModificationSelfTest-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: base) }

        let repository = try WorkspaceRepository(inMemory: true, baseURL: base)
        let document = OutlineDocumentDTO(
            id: "doc",
            title: "External",
            updatedAt: "2024-01-01T00:00:00.000Z",
            nodes: [OutlineNodeDTO(text: "Before")]
        )
        try repository.saveWorkspace(WorkspaceV1DTO(activeDocumentId: document.id, documents: [document]))

        let markdownURL = base.appendingPathComponent("External.md")
        try "# External\n\n- After external edit\n".write(to: markdownURL, atomically: true, encoding: .utf8)
        let externalDate = Date(timeIntervalSince1970: 2_000_000_000)
        try FileManager.default.setAttributes([.modificationDate: externalDate], ofItemAtPath: markdownURL.path)

        let loaded = try WorkspaceRepository(inMemory: true, baseURL: base).loadWorkspace()
        let loadedDate = try expectDate(loaded.documents[0].updatedAt, "external markdown updatedAt should parse")
        try expect(abs(loadedDate.timeIntervalSince(externalDate)) < 1, "external markdown mtime should update document updatedAt")
        try expect(loaded.documents[0].nodes[0].text == "After external edit", "external markdown content should load")
    }

    @MainActor
    private static func repositorySkipsUnchangedMarkdownWrites() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("BikeUnchangedWriteSelfTest-\(UUID().uuidString)", isDirectory: true)
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
            .appendingPathComponent("BikeLegacyICloudSelfTest-\(UUID().uuidString)", isDirectory: true)
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
            .appendingPathComponent("BikeSelfTest-\(UUID().uuidString)", isDirectory: true)
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
        try expect(snapshots.contains { $0.reason == "manual" }, "snapshot reason should exclude timestamp suffix")
        let restored = try repository.restoreSnapshot(snapshots[0], currentWorkspace: workspace)
        try expect(restored.documents[0].title == "Snapshot source", "snapshot restore should recover saved title")
        let restoredSnapshots = try repository.listSnapshots()
        try expect(restoredSnapshots.contains { $0.reason == "before-restore" }, "restore should create before-restore snapshot")
    }

    private static func iCloudBackupWritesLatestAndStampedFiles() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("BikeBackupSelfTest-\(UUID().uuidString)", isDirectory: true)
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
