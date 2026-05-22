import Foundation

#if !LOCAL_OUTLINE_CLI_BUILD
import SwiftData
#endif

@MainActor
final class WorkspaceRepository {
    #if !LOCAL_OUTLINE_CLI_BUILD
    let container: ModelContainer
    private let context: ModelContext
    #endif

    private let storeURL: URL
    private let snapshotsURL: URL

    init(inMemory: Bool = false, baseURL: URL? = nil) throws {
        #if !LOCAL_OUTLINE_CLI_BUILD
        let schema = Schema([
            DocumentRecord.self,
            NodeRecord.self,
            AppSettingRecord.self,
            SnapshotRecord.self
        ])
        let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: inMemory)
        container = try ModelContainer(for: schema, configurations: [configuration])
        context = ModelContext(container)
        #endif

        let base = baseURL ?? (
            inMemory
                ? URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("LocalOutlineNative-\(UUID().uuidString)", isDirectory: true)
                : FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Local Outline Native", isDirectory: true)
        )
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        storeURL = base.appendingPathComponent("workspace.json")
        snapshotsURL = base.appendingPathComponent("snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: snapshotsURL, withIntermediateDirectories: true)
    }

    func loadWorkspace() throws -> WorkspaceV1DTO {
        #if !LOCAL_OUTLINE_CLI_BUILD
        let documents = try context.fetch(FetchDescriptor<DocumentRecord>(sortBy: [SortDescriptor(\DocumentRecord.sortKey)]))
            .filter { $0.deletedAt == nil }
        if !documents.isEmpty {
            let nodes = try context.fetch(FetchDescriptor<NodeRecord>(sortBy: [SortDescriptor(\NodeRecord.sortKey)]))
            let docs = documents.map { record -> OutlineDocumentDTO in
                let rootNodes = buildNodes(records: nodes.filter { $0.documentId == record.id }, parentId: nil)
                return OutlineDocumentDTO(
                    id: record.id,
                    title: record.title,
                    createdAt: record.createdAt,
                    updatedAt: record.updatedAt,
                    markdownSource: record.markdownSource,
                    markdownUpdatedAt: record.markdownUpdatedAt,
                    nodes: rootNodes.isEmpty ? [OutlineNodeDTO(text: Defaults.nodeText)] : rootNodes
                )
            }
            let active = try setting("activeDocumentId") ?? docs.first?.id ?? ""
            return TreeOperations.normalizeWorkspace(WorkspaceV1DTO(activeDocumentId: active, documents: docs))
        }
        #endif

        guard FileManager.default.fileExists(atPath: storeURL.path) else {
            let starter = SampleData.starterWorkspace()
            try saveWorkspace(starter)
            return starter
        }
        let data = try Data(contentsOf: storeURL)
        let workspace = try ImportExportCodec.jsonDecoder.decode(WorkspaceV1DTO.self, from: data)
        return TreeOperations.normalizeWorkspace(workspace)
    }

    func replaceWorkspace(_ workspace: WorkspaceV1DTO, snapshotReason: String? = "replace") throws {
        let normalized = TreeOperations.normalizeWorkspace(workspace)
        if let snapshotReason {
            try createSnapshot(reason: snapshotReason, workspace: normalized)
        }

        #if !LOCAL_OUTLINE_CLI_BUILD
        try deleteAll(DocumentRecord.self)
        try deleteAll(NodeRecord.self)
        for (docIndex, document) in normalized.documents.enumerated() {
            context.insert(DocumentRecord(document: document, sortKey: Double(docIndex)))
            insertNodes(document.nodes, documentId: document.id, parentId: nil)
        }
        try setSetting("activeDocumentId", value: normalized.activeDocumentId)
        try context.save()
        #endif

        try saveJSON(normalized)
    }

    func saveWorkspace(_ workspace: WorkspaceV1DTO) throws {
        try replaceWorkspace(workspace, snapshotReason: nil)
    }

    func createSnapshot(reason: String, workspace: WorkspaceV1DTO) throws {
        let data = try ImportExportCodec.exportWorkspace(workspace)
        let stamp = Date.isoNow.replacingOccurrences(of: "[:.]", with: "-", options: .regularExpression)
        let url = snapshotsURL.appendingPathComponent("\(reason)-\(stamp).json")
        try data.write(to: url, options: .atomic)

        #if !LOCAL_OUTLINE_CLI_BUILD
        if let json = String(data: data, encoding: .utf8) {
            context.insert(SnapshotRecord(reason: reason, workspaceJSON: json))
            try context.save()
        }
        #endif
    }

    func listSnapshots() throws -> [SnapshotInfo] {
        var snapshots: [SnapshotInfo] = []

        if FileManager.default.fileExists(atPath: snapshotsURL.path) {
            let urls = try FileManager.default.contentsOfDirectory(
                at: snapshotsURL,
                includingPropertiesForKeys: [.contentModificationDateKey],
                options: [.skipsHiddenFiles]
            )
            snapshots = try urls
                .filter { $0.pathExtension.lowercased() == "json" }
                .map { url in
                    let values = try url.resourceValues(forKeys: [.contentModificationDateKey])
                    return SnapshotInfo(
                        id: url.deletingPathExtension().lastPathComponent,
                        reason: snapshotReason(from: url),
                        createdAt: values.contentModificationDate ?? .distantPast,
                        url: url
                    )
                }
        }

        return snapshots.sorted { $0.createdAt > $1.createdAt }
    }

    func restoreSnapshot(_ snapshot: SnapshotInfo, currentWorkspace: WorkspaceV1DTO) throws -> WorkspaceV1DTO {
        try createSnapshot(reason: "before-restore", workspace: currentWorkspace)
        let data = try Data(contentsOf: snapshot.url)
        let workspace = try ImportExportCodec.jsonDecoder.decode(WorkspaceV1DTO.self, from: data)
        let normalized = TreeOperations.normalizeWorkspace(workspace)
        try saveWorkspace(normalized)
        return normalized
    }

    private func saveJSON(_ workspace: WorkspaceV1DTO) throws {
        let data = try ImportExportCodec.exportWorkspace(workspace)
        try data.write(to: storeURL, options: .atomic)
    }

    private func snapshotReason(from url: URL) -> String {
        let name = url.deletingPathExtension().lastPathComponent
        guard let lastDash = name.lastIndex(of: "-") else { return name }
        return String(name[..<lastDash])
    }

    #if !LOCAL_OUTLINE_CLI_BUILD
    private func insertNodes(_ nodes: [OutlineNodeDTO], documentId: String, parentId: String?) {
        let now = Date.isoNow
        for (index, node) in nodes.enumerated() {
            context.insert(NodeRecord(node: node, documentId: documentId, parentId: parentId, sortKey: Double(index), now: now))
            insertNodes(node.children, documentId: documentId, parentId: node.id)
        }
    }

    private func buildNodes(records: [NodeRecord], parentId: String?) -> [OutlineNodeDTO] {
        records
            .filter { $0.parentId == parentId }
            .sorted { $0.sortKey < $1.sortKey }
            .map { record in
                let children = buildNodes(records: records, parentId: record.id)
                return record.dto(children: children)
            }
    }

    private func deleteAll<T: PersistentModel>(_ type: T.Type) throws {
        let descriptor = FetchDescriptor<T>()
        for record in try context.fetch(descriptor) {
            context.delete(record)
        }
    }

    private func setting(_ key: String) throws -> String? {
        try context.fetch(FetchDescriptor<AppSettingRecord>()).first { $0.key == key }?.value
    }

    private func setSetting(_ key: String, value: String) throws {
        if let record = try context.fetch(FetchDescriptor<AppSettingRecord>()).first(where: { $0.key == key }) {
            record.value = value
        } else {
            context.insert(AppSettingRecord(key: key, value: value))
        }
    }
    #endif
}

struct SnapshotInfo: Identifiable, Equatable {
    var id: String
    var reason: String
    var createdAt: Date
    var url: URL
}
