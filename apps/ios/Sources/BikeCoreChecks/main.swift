import BikeCore
import Darwin
import Foundation

@main
struct BikeCoreChecks {
    static func main() async {
        var checks = CheckSuite()

        checks.run("starter workspace uses Bike IDs and inbox document", checkStarterWorkspace)
        checks.run("document actions keep active document valid", checkDocumentActions)
        checks.run("node text, note, and structure mutations", checkNodeMutations)
        checks.run("outdent and delete nested node", checkOutdentAndDelete)
        checks.run("deleting all documents creates replacement", checkDeletingAllDocuments)
        checks.run("decode desktop workspace with rich node fields", checkDecodeRichWorkspace)
        checks.run("preserve unknown desktop fields during round trip", checkUnknownFieldRoundTrip)
        checks.run("preserve unknown fields when editing known fields", checkUnknownFieldsAfterEdit)
        checks.run("remove known nullable fields when cleared", checkClearedNullableFields)
        checks.run("fresh encode omits null optional fields", checkFreshEncodeDefaults)
        checks.run("reject workspace without documents", checkRejectEmptyWorkspace)
        checks.run("normalize missing active document", checkNormalizeActiveDocument)
        await checks.run("repository loadOrCreate creates starter file", checkRepositoryLoadOrCreate)
        await checks.run("repository backs up corrupted workspace", checkCorruptedWorkspaceBackup)
        await checks.run("repository replace and export JSON", checkRepositoryReplaceAndExport)
        checks.run("AI parses fenced and balanced JSON", checkAIJSONParsing)
        checks.run("AI extracts Responses and Chat Completions text", checkAITextExtraction)
        checks.run("AI extracts event stream deltas", checkAIEventStreamExtraction)
        checks.run("AI sanitizes generated nodes from flexible keys", checkAIFlexibleKeys)
        checks.run("AI polish requires text", checkPolishRequiresText)
        checks.run("AI endpoint URL normalization", checkEndpointURLNormalization)

        if checks.failures == 0 {
            print("BikeCoreChecks passed: \(checks.passed) checks")
        } else {
            print("BikeCoreChecks failed: \(checks.failures) of \(checks.total) checks")
            exit(1)
        }
    }
}

private struct CheckSuite {
    private(set) var total = 0
    private(set) var passed = 0
    private(set) var failures = 0

    mutating func run(_ name: String, _ check: () throws -> Void) {
        total += 1
        do {
            try check()
            passed += 1
            print("✓ \(name)")
        } catch {
            failures += 1
            print("✗ \(name): \(error)")
        }
    }

    mutating func run(_ name: String, _ check: () async throws -> Void) async {
        total += 1
        do {
            try await check()
            passed += 1
            print("✓ \(name)")
        } catch {
            failures += 1
            print("✗ \(name): \(error)")
        }
    }
}

private struct CheckFailure: Error, CustomStringConvertible {
    var description: String
}

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() {
        throw CheckFailure(description: message)
    }
}

private func require<T>(_ value: T?, _ message: String) throws -> T {
    guard let value else {
        throw CheckFailure(description: message)
    }
    return value
}

private func checkStarterWorkspace() throws {
    let workspace = createStarterWorkspace(now: fixedDate)
    let document = try workspace.activeDocument()

    try expect(document.id.hasPrefix("doc_"), "document id should use doc_ prefix")
    try expect(workspace.activeDocumentId == document.id, "active document id should match document")
    try expect(document.title == inboxDocumentTitle, "starter document should be inbox")
    try expect(document.createdAt == fixedTimestamp, "createdAt should use supplied date")
    try expect(document.updatedAt == fixedTimestamp, "updatedAt should use supplied date")
    try expect(document.nodeCount() > 1, "starter document should contain sample outline")
}

private func checkDocumentActions() throws {
    let workspace = createStarterWorkspace(now: fixedDate)
    let source = try workspace.activeDocument()
    let renamed = workspace.withDocumentTitle(documentId: source.id, title: "移动端草稿", now: laterDate)
    let renamedDocument = try renamed.activeDocument()
    try expect(renamedDocument.title == "移动端草稿", "document title should update")
    try expect(renamedDocument.updatedAt == laterTimestamp, "renaming should update updatedAt")

    let duplicated = workspace.withDocumentDuplicated(documentId: source.id, now: laterDate)
    let copied = try duplicated.activeDocument()

    try expect(duplicated.documents.count == 2, "duplicating should add document")
    try expect(copied.id.hasPrefix("doc_"), "duplicated id should use doc_ prefix")
    try expect(source.id != copied.id, "duplicated document id should be fresh")
    try expect(source.nodes[0].id != copied.nodes[0].id, "duplicated node id should be fresh")
    try expect(copied.title == "\(source.title) 副本", "duplicated title should include suffix")
    try expect(copied.createdAt == laterTimestamp, "duplicated createdAt should update")

    let deleted = duplicated.withDocumentDeleted(documentId: copied.id, now: laterDate)
    try expect(deleted.documents.count == 1, "deleting active duplicate should leave source")
    try expect(deleted.documents.contains { $0.id == deleted.activeDocumentId }, "active id should remain valid")
}

private func checkNodeMutations() throws {
    let workspace = createStarterWorkspace(now: fixedDate)
    let document = try workspace.activeDocument()
    let root = try require(document.nodes.first, "starter root missing")
    let firstChild = try require(root.children.first, "starter child missing")

    let updated = workspace
        .withNodeTextAndNote(
            documentId: document.id,
            nodeId: root.id,
            text: "移动收件箱",
            note: "一次保存两个字段",
            now: laterDate
        )
        .withSiblingAfter(
            documentId: document.id,
            nodeId: firstChild.id,
            newNode: outlineNode("新同级"),
            now: laterDate
        )
        .withChildNode(
            documentId: document.id,
            nodeId: root.id,
            childNode: outlineNode("新子级"),
            now: laterDate
        )

    let nextRoot = try require(try updated.activeDocument().nodes.first, "updated root missing")
    try expect(nextRoot.text == "移动收件箱", "text should update")
    try expect(nextRoot.note == "一次保存两个字段", "note should update")
    try expect(nextRoot.children[1].text == "新同级", "sibling should insert after target")
    try expect(nextRoot.children.last?.text == "新子级", "child should append")
    let updatedDocument = try updated.activeDocument()
    try expect(updatedDocument.updatedAt == laterTimestamp, "updatedAt should update")
}

private func checkOutdentAndDelete() throws {
    let workspace = createStarterWorkspace(now: fixedDate)
    let document = try workspace.activeDocument()
    let root = try require(document.nodes.first, "starter root missing")
    let child = try require(root.children.first, "starter child missing")

    let outdented = workspace.withNodeMovedToParentLevel(
        documentId: document.id,
        nodeId: child.id,
        now: laterDate
    )
    let outdentedDocument = try outdented.activeDocument()
    try expect(outdentedDocument.nodes[1].id == child.id, "child should become root sibling")

    let deleted = outdented.withNodeDeleted(
        documentId: document.id,
        nodeId: child.id,
        now: laterDate
    )
    let deletedDocument = try deleted.activeDocument()
    try expect(!deletedDocument.nodes.contains { $0.id == child.id }, "outdented node should delete")
}

private func checkDeletingAllDocuments() throws {
    let workspace = createStarterWorkspace(now: fixedDate)
    let updated = workspace.withDocumentsDeleted(
        documentIds: Set(workspace.documents.map(\.id)),
        now: laterDate
    )

    try expect(updated.documents.count == 1, "replacement document should exist")
    try expect(updated.activeDocumentId == updated.documents[0].id, "replacement should be active")
    try expect(updated.documents[0].title == "未命名文档", "replacement title should be default")
    try expect(updated.documents[0].id.hasPrefix("doc_"), "replacement id should use doc_ prefix")
}

private func checkDecodeRichWorkspace() throws {
    let payload = try WorkspaceJSON.decode(sampleWorkspaceJSON)
    let document = try require(payload.workspace.documents.first, "document missing")
    let node = try require(document.nodes.first, "node missing")

    try expect(payload.workspace.version == 1, "workspace version should decode")
    try expect(payload.workspace.activeDocumentId == "doc_product", "active document should decode")
    try expect(document.title == "Bike iOS MVP", "document title should decode")
    try expect(document.markdownSource?.contains("# Bike iOS") == true, "markdown source should decode")
    try expect(node.text == "移动端定位", "node text should decode")
    try expect(node.headingLevel == 2, "heading level should decode")
    try expect(node.bold == true, "bold should decode")
    try expect(node.codeLanguage == "swift", "code language should decode")
    try expect(node.table?.first == ["场景", "价值"], "table should decode")
    try expect(node.children.first?.text == "快速捕捉", "child should decode")
}

private func checkUnknownFieldRoundTrip() throws {
    let payload = try WorkspaceJSON.decode(sampleWorkspaceJSON)
    let encoded = try WorkspaceJSON.encode(payload)
    let reparsed = try parseObject(encoded)

    try expect(reparsed.object("iosUnknown").string("scope") == "top-level", "top-level unknown field should survive")
    let document = try require(reparsed.array("documents").first?.objectValue, "document JSON missing")
    try expect(document.string("futureDocumentField") == "desktop-only", "document unknown field should survive")
    let node = try require(document.array("nodes").first?.objectValue, "node JSON missing")
    try expect(node.string("futureNodeField") == "keep-me", "node unknown field should survive")
    try expect(node.bool("bold") == true, "known field should survive")
    let child = try require(node.array("children").first?.objectValue, "child JSON missing")
    try expect(child.number("futureChildField") == 7, "child unknown field should survive")
}

private func checkUnknownFieldsAfterEdit() throws {
    var payload = try WorkspaceJSON.decode(sampleWorkspaceJSON)
    var document = try require(payload.workspace.documents.first, "document missing")
    var root = try require(document.nodes.first, "root missing")
    root.text = "移动端定位调整"
    root.checked = true
    document.title = "Bike iOS Companion"
    document.nodes = [root]
    payload.workspace.documents = [document]

    let encoded = try WorkspaceJSON.encode(payload)
    let documentJSON = try require(try parseObject(encoded).array("documents").first?.objectValue, "document JSON missing")
    let nodeJSON = try require(documentJSON.array("nodes").first?.objectValue, "node JSON missing")

    try expect(documentJSON.string("title") == "Bike iOS Companion", "known document title should update")
    try expect(documentJSON.string("futureDocumentField") == "desktop-only", "unknown document field should survive")
    try expect(nodeJSON.string("text") == "移动端定位调整", "known node text should update")
    try expect(nodeJSON.bool("checked") == true, "known checked should update")
    try expect(nodeJSON.string("futureNodeField") == "keep-me", "unknown node field should survive")
    let child = try require(nodeJSON.array("children").first?.objectValue, "child JSON missing")
    try expect(child.string("text") == "快速捕捉", "child text should survive")
    try expect(child.number("futureChildField") == 7, "child unknown field should survive")
}

private func checkClearedNullableFields() throws {
    var payload = try WorkspaceJSON.decode(sampleWorkspaceJSON)
    var document = try require(payload.workspace.documents.first, "document missing")
    var root = try require(document.nodes.first, "root missing")
    document.markdownSource = nil
    document.markdownUpdatedAt = nil
    root.bold = nil
    root.icon = nil
    root.imageName = nil
    root.imageAlt = nil
    root.table = nil
    root.codeBlock = nil
    root.codeLanguage = nil
    document.nodes = [root]
    payload.workspace.documents = [document]

    let encoded = try WorkspaceJSON.encode(payload)
    let documentJSON = try require(try parseObject(encoded).array("documents").first?.objectValue, "document JSON missing")
    let nodeJSON = try require(documentJSON.array("nodes").first?.objectValue, "node JSON missing")

    try expect(documentJSON["markdownSource"] == nil, "cleared markdownSource should be removed")
    try expect(documentJSON["markdownUpdatedAt"] == nil, "cleared markdownUpdatedAt should be removed")
    try expect(nodeJSON["bold"] == nil, "cleared bold should be removed")
    try expect(nodeJSON["icon"] == nil, "cleared icon should be removed")
    try expect(nodeJSON["imageName"] == nil, "cleared imageName should be removed")
    try expect(nodeJSON["imageAlt"] == nil, "cleared imageAlt should be removed")
    try expect(nodeJSON["table"] == nil, "cleared table should be removed")
    try expect(nodeJSON["codeBlock"] == nil, "cleared codeBlock should be removed")
    try expect(nodeJSON["codeLanguage"] == nil, "cleared codeLanguage should be removed")
    try expect(nodeJSON.string("futureNodeField") == "keep-me", "unknown node field should survive")
}

private func checkFreshEncodeDefaults() throws {
    let workspace = Workspace(
        activeDocumentId: "doc_1",
        documents: [
            OutlineDocument(
                id: "doc_1",
                title: "Inbox",
                createdAt: "2026-06-13T00:00:00.000Z",
                updatedAt: "2026-06-13T00:00:00.000Z",
                nodes: [
                    OutlineNode(id: "node_1", text: "Captured thought")
                ]
            )
        ]
    )

    let encoded = try WorkspaceJSON.encode(workspace)
    let document = try require(try parseObject(encoded).array("documents").first?.objectValue, "document JSON missing")
    let node = try require(document.array("nodes").first?.objectValue, "node JSON missing")

    try expect(node.string("color") == "plain", "color default should encode")
    try expect(node["headingLevel"] == nil, "nil headingLevel should omit")
    try expect(document["markdownSource"] == nil, "nil markdownSource should omit")
}

private func checkRejectEmptyWorkspace() throws {
    do {
        _ = try WorkspaceJSON.decode("""
        {
          "version": 1,
          "activeDocumentId": "missing",
          "documents": []
        }
        """)
        throw CheckFailure(description: "empty workspace should fail")
    } catch {
        try expect(error.localizedDescription == "工作区至少需要一篇文档", "error message should explain invalid workspace")
    }
}

private func checkNormalizeActiveDocument() throws {
    let payload = try WorkspaceJSON.decode("""
    {
      "version": 1,
      "activeDocumentId": "missing",
      "documents": [
        {
          "id": "doc_first",
          "title": "First",
          "createdAt": "2026-06-13T00:00:00.000Z",
          "updatedAt": "2026-06-13T00:00:00.000Z",
          "nodes": []
        }
      ]
    }
    """)

    try expect(payload.workspace.activeDocumentId == "doc_first", "missing active id should normalize to first document")
}

private func checkRepositoryLoadOrCreate() async throws {
    let directory = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let workspaceURL = directory.appendingPathComponent("bike-workspace.json")
    let repository = WorkspaceRepository(workspaceURL: workspaceURL)

    let payload = try await repository.loadOrCreate()

    try expect(FileManager.default.fileExists(atPath: workspaceURL.path), "workspace file should be created")
    try expect(payload.workspace.documents.count == 1, "starter payload should have one document")
    try expect(payload.workspace.documents.first?.title == inboxDocumentTitle, "starter document should be inbox")
    try expect(payload.recovery == nil, "fresh load should not include recovery")
}

private func checkCorruptedWorkspaceBackup() async throws {
    let directory = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let workspaceURL = directory.appendingPathComponent("bike-workspace.json")
    try "{ broken json".write(to: workspaceURL, atomically: true, encoding: .utf8)
    let repository = WorkspaceRepository(workspaceURL: workspaceURL)

    let payload = try await repository.loadOrCreate()

    try expect(payload.recovery != nil, "corrupted load should include recovery")
    try expect(payload.recovery?.backupFileName.hasPrefix("bike-workspace.json.corrupted-") == true, "backup name should be timestamped")
    try expect(payload.workspace.documents.first?.title == inboxDocumentTitle, "starter workspace should be created after corruption")
    let backups = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        .filter { $0.hasPrefix("bike-workspace.json.corrupted-") }
    try expect(backups.count == 1, "one corrupted backup should be present")
}

private func checkRepositoryReplaceAndExport() async throws {
    let directory = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let workspaceURL = directory.appendingPathComponent("bike-workspace.json")
    let repository = WorkspaceRepository(workspaceURL: workspaceURL)

    let payload = try await repository.replace(fromJSON: """
    {
      "version": 1,
      "activeDocumentId": "doc_imported",
      "documents": [
        {
          "id": "doc_imported",
          "title": "Imported",
          "createdAt": "2026-06-13T00:00:00.000Z",
          "updatedAt": "2026-06-13T00:00:00.000Z",
          "nodes": [
            {"id": "node_imported", "text": "Hello", "note": "", "checked": false, "collapsed": false, "color": "plain", "children": []}
          ]
        }
      ]
    }
    """)
    let exported = try await repository.exportText(payload)

    try expect(exported.contains("\"title\" : \"Imported\""), "exported JSON should include imported title")
    try expect(payload.workspace.activeDocumentId == "doc_imported", "active id should decode")
}

private func checkAIJSONParsing() throws {
    let fenced = try AiService.parseJSONText("""
    ```json
    {"children":[{"text":"子主题"}]}
    ```
    """)
    let fencedResult = try AiService.normalizeActionResult(action: .generate, parsed: fenced)
    try expect(fencedResult.children?.first?.text == "子主题", "fenced JSON should parse")

    let prose = try AiService.parseJSONText("""
    当然可以，结果如下：
    {"children":[{"title":"调研","subTopics":[{"name":"用户场景"}]}]}
    希望有帮助。
    """)
    let proseResult = try AiService.normalizeActionResult(action: .generate, parsed: prose)
    try expect(proseResult.children?.first?.text == "调研", "balanced JSON slice should parse")
    try expect(proseResult.children?.first?.children.first?.text == "用户场景", "flexible child keys should parse")
}

private func checkAITextExtraction() throws {
    let responsesText = AiService.extractText(from: [
        "output": [
            [
                "content": [
                    ["type": "output_text", "text": "{\"text\":\"润色后\"}"]
                ]
            ]
        ]
    ])
    try expect(responsesText == "{\"text\":\"润色后\"}", "Responses output text should extract")

    let chatText = AiService.extractText(from: [
        "choices": [
            [
                "message": [
                    "content": [
                        ["text": "{\"children\":[{\"text\":\"节点\"}]}"]
                    ]
                ]
            ]
        ]
    ])
    try expect(chatText == "{\"children\":[{\"text\":\"节点\"}]}", "chat completion content should extract")
}

private func checkAIEventStreamExtraction() throws {
    let stream = """
    event: response.output_text.delta
    data: {"type":"response.output_text.delta","delta":"{\\"children\\":["}

    event: response.output_text.delta
    data: {"type":"response.output_text.delta","delta":"{\\"text\\":\\"节点\\"}]}"}

    data: [DONE]
    """

    try expect(
        AiService.extractTextFromEventStream(stream) == "{\"children\":[{\"text\":\"节点\"}]}",
        "SSE deltas should concatenate"
    )
}

private func checkAIFlexibleKeys() throws {
    let parsed = try AiService.parseJSONText("""
    {
      "outline": [
        {
          "topic": "第一层",
          "nodes": [
            {
              "heading": "第二层",
              "children": [
                {"label": "第三层"},
                {"text": "第四层应被截断", "children": [{"text":"过深"}]}
              ]
            }
          ]
        }
      ]
    }
    """)

    let result = try AiService.normalizeActionResult(action: .generate, parsed: parsed)
    let outlineNodes = AiService.generatedNodesToOutlineNodes(result.children ?? [])

    try expect(outlineNodes.first?.text == "第一层", "topic key should map to text")
    try expect(outlineNodes.first?.children.first?.text == "第二层", "heading key should map to text")
    try expect(outlineNodes.first?.children.first?.children.first?.text == "第三层", "label key should map to text")
    try expect(outlineNodes.first?.children.first?.children.count == 2, "third level siblings should survive")
    try expect(outlineNodes.first?.children.first?.children[1].children.isEmpty == true, "fourth level children should truncate")
}

private func checkPolishRequiresText() throws {
    let parsed = try AiService.parseJSONText("{\"children\":[{\"text\":\"不是润色文本\"}]}")
    do {
        _ = try AiService.normalizeActionResult(action: .polish, parsed: parsed)
        throw CheckFailure(description: "polish result without text should fail")
    } catch {
        try expect(error as? AiServiceError == .missingPolishText, "polish error should be missingPolishText")
    }
}

private func checkEndpointURLNormalization() throws {
    try expect(
        AiService.endpointURL(
            settings: AiSettings(endpoint: .responses, baseUrl: "https://api.openai.com", apiKey: "k", model: "m")
        )?.absoluteString == "https://api.openai.com/v1/responses",
        "OpenAI host without path should append /v1/responses"
    )
    try expect(
        AiService.endpointURL(
            settings: AiSettings(endpoint: .chatCompletions, baseUrl: "https://example.com/v1/", apiKey: "k", model: "m")
        )?.absoluteString == "https://example.com/v1/chat/completions",
        "base URL should append chat/completions"
    )
    try expect(
        AiService.endpointURL(
            settings: AiSettings(endpoint: .responses, baseUrl: "example.com", apiKey: "k", model: "m")
        ) == nil,
        "base URL without scheme should reject"
    )
}

private func parseObject(_ source: String) throws -> [String: JSONValue] {
    let value = try WorkspaceJSON.decoder.decode(JSONValue.self, from: Data(source.utf8))
    return value.objectValue ?? [:]
}

private func temporaryDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("BikeCoreChecks-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

private func bikeFormatter() -> ISO8601DateFormatter {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}

private extension Dictionary where Key == String, Value == JSONValue {
    func array(_ key: String) -> [JSONValue] {
        self[key]?.arrayValue ?? []
    }

    func string(_ key: String) -> String? {
        self[key]?.stringValue
    }

    func bool(_ key: String) -> Bool? {
        if case .bool(let value) = self[key] { return value }
        return nil
    }

    func number(_ key: String) -> Double? {
        if case .number(let value) = self[key] { return value }
        return nil
    }

    func object(_ key: String) -> [String: JSONValue] {
        self[key]?.objectValue ?? [:]
    }
}

private let fixedDate = bikeFormatter().date(from: "2026-06-13T00:00:00.000Z")!
private let laterDate = bikeFormatter().date(from: "2026-06-13T00:05:00.000Z")!
private let fixedTimestamp = bikeFormatter().string(from: fixedDate)
private let laterTimestamp = bikeFormatter().string(from: laterDate)

private let sampleWorkspaceJSON = """
{
  "version": 1,
  "activeDocumentId": "doc_product",
  "iosUnknown": { "scope": "top-level" },
  "documents": [
    {
      "id": "doc_product",
      "title": "Bike iOS MVP",
      "createdAt": "2026-06-13T00:00:00.000Z",
      "updatedAt": "2026-06-13T01:00:00.000Z",
      "markdownSource": "# Bike iOS\\n\\n- 移动端定位",
      "markdownUpdatedAt": "2026-06-13T01:00:00.000Z",
      "futureDocumentField": "desktop-only",
      "nodes": [
        {
          "id": "node_positioning",
          "text": "移动端定位",
          "note": "Mobile companion, not desktop parity.",
          "checked": false,
          "collapsed": false,
          "color": "blue",
          "headingLevel": 2,
          "bold": true,
          "italic": false,
          "underline": false,
          "strike": false,
          "highlight": true,
          "icon": "spark",
          "imageName": "capture.png",
          "imageAlt": "Capture flow",
          "table": [["场景", "价值"], ["分享入口", "快速收集"]],
          "codeBlock": "let scope = \\"MVP\\"",
          "codeLanguage": "swift",
          "isTodo": true,
          "futureNodeField": "keep-me",
          "children": [
            {
              "id": "node_capture",
              "text": "快速捕捉",
              "note": "",
              "checked": true,
              "collapsed": false,
              "color": "plain",
              "futureChildField": 7,
              "children": []
            }
          ]
        }
      ]
    }
  ]
}
"""
