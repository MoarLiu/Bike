import Foundation

@MainActor
final class WorkspaceRepository {
    private let snapshotsURL: URL
    private let backupsURL: URL
    private let markdownDirectoryURL: URL
    private let metadataURL: URL
    private let legacyStoreURL: URL
    private let legacyICloudBackupURL: URL

    init(inMemory: Bool = false, baseURL: URL? = nil) throws {
        let legacyBase = (
            inMemory
                ? URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("LocalOutlineNative-\(UUID().uuidString)", isDirectory: true)
                : FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Local Outline Native", isDirectory: true)
        )
        let base = baseURL ?? LocalOutlineStorage.documentsDirectoryURL()
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        markdownDirectoryURL = base
        metadataURL = base.appendingPathComponent(".localoutline-workspace.json")
        legacyICloudBackupURL = base.appendingPathComponent(ICloudBackupService.latestBackupFilename)
        legacyStoreURL = legacyBase.appendingPathComponent("workspace.json")
        snapshotsURL = base.appendingPathComponent(".snapshots", isDirectory: true)
        backupsURL = base.appendingPathComponent(".backups", isDirectory: true)
        try FileManager.default.createDirectory(at: snapshotsURL, withIntermediateDirectories: true)
    }

    func loadWorkspace() throws -> WorkspaceV1DTO {
        let markdownWorkspace = try loadMarkdownWorkspaceIfAvailable()
        if let markdownWorkspace {
            return markdownWorkspace
        }

        if FileManager.default.fileExists(atPath: legacyStoreURL.path) {
            let data = try Data(contentsOf: legacyStoreURL)
            let workspace = try ImportExportCodec.jsonDecoder.decode(WorkspaceV1DTO.self, from: data)
            let normalized = TreeOperations.normalizeWorkspace(workspace)
            try saveWorkspace(normalized)
            try archiveLegacyRootBackups()
            return normalized
        }

        if FileManager.default.fileExists(atPath: legacyICloudBackupURL.path) {
            let data = try Data(contentsOf: legacyICloudBackupURL)
            let workspace = try ImportExportCodec.jsonDecoder.decode(WorkspaceV1DTO.self, from: data)
            let normalized = TreeOperations.normalizeWorkspace(workspace)
            try saveWorkspace(normalized)
            try archiveLegacyRootBackups()
            return normalized
        }

        let starter = SampleData.starterWorkspace()
        try saveWorkspace(starter)
        return starter
    }

    func replaceWorkspace(_ workspace: WorkspaceV1DTO, snapshotReason: String? = "replace") throws {
        let normalized = TreeOperations.normalizeWorkspace(workspace)
        if let snapshotReason {
            try createSnapshot(reason: snapshotReason, workspace: normalized)
        }

        try saveMarkdownWorkspace(normalized)
    }

    func saveWorkspace(_ workspace: WorkspaceV1DTO) throws {
        try replaceWorkspace(workspace, snapshotReason: nil)
    }

    func createSnapshot(reason: String, workspace: WorkspaceV1DTO) throws {
        let data = try ImportExportCodec.exportWorkspace(workspace)
        let stamp = Date.isoNow.replacingOccurrences(of: "[:.]", with: "-", options: .regularExpression)
        let url = snapshotsURL.appendingPathComponent("\(reason)-\(stamp).json")
        try data.write(to: url, options: .atomic)
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

    private func loadMarkdownWorkspaceIfAvailable() throws -> WorkspaceV1DTO? {
        guard FileManager.default.fileExists(atPath: markdownDirectoryURL.path) else { return nil }
        let metadata = try loadMetadata()
        let urls = try FileManager.default.contentsOfDirectory(
            at: markdownDirectoryURL,
            includingPropertiesForKeys: [.contentModificationDateKey, .creationDateKey],
            options: [.skipsHiddenFiles]
        )
        let markdownURLs = urls
            .filter { ["md", "markdown"].contains($0.pathExtension.lowercased()) }
            .sorted { left, right in
                let leftSort = metadata.documents.first { $0.filename == left.lastPathComponent }?.sortKey ?? Int.max
                let rightSort = metadata.documents.first { $0.filename == right.lastPathComponent }?.sortKey ?? Int.max
                if leftSort != rightSort { return leftSort < rightSort }
                return left.lastPathComponent.localizedStandardCompare(right.lastPathComponent) == .orderedAscending
            }
        guard !markdownURLs.isEmpty else { return nil }

        var documents: [OutlineDocumentDTO] = []
        var loadedMetadataDocuments: [PersistedDocumentMetadata] = []
        for (index, url) in markdownURLs.enumerated() {
            let content = try String(contentsOf: url, encoding: .utf8)
            let fileId = url.lastPathComponent
            let item = metadata.documents.first { $0.filename == fileId }
            let values = try url.resourceValues(forKeys: [.contentModificationDateKey, .creationDateKey])
            let fileModifiedAt = values.contentModificationDate.map { ISO8601DateFormatter.localOutline.string(from: $0) }
            let modifiedAt = [item?.updatedAt, fileModifiedAt].compactMap { $0 }.max() ?? Date.isoNow
            let createdAt = item?.createdAt ?? values.creationDate.map { ISO8601DateFormatter.localOutline.string(from: $0) } ?? modifiedAt
            let document = MarkdownCodec.parseDocument(
                content,
                filename: url.lastPathComponent,
                previousDocument: item.map {
                    OutlineDocumentDTO(
                        id: $0.id,
                        title: $0.title,
                        createdAt: createdAt,
                        updatedAt: $0.updatedAt,
                        nodes: ($0.nodes?.isEmpty == false ? $0.nodes : nil) ?? [OutlineNodeDTO(text: Defaults.nodeText)]
                    )
                },
                documentId: item?.id,
                now: modifiedAt
            )
            var normalizedDocument = document
            normalizedDocument.createdAt = createdAt
            normalizedDocument.updatedAt = modifiedAt
            documents.append(normalizedDocument)
            loadedMetadataDocuments.append(PersistedDocumentMetadata(
                id: normalizedDocument.id,
                filename: fileId,
                title: normalizedDocument.title,
                createdAt: normalizedDocument.createdAt,
                updatedAt: normalizedDocument.updatedAt,
                sortKey: index,
                nodes: normalizedDocument.nodes
            ))
        }

        let active = documents.contains { $0.id == metadata.activeDocumentId } ? metadata.activeDocumentId : documents[0].id
        let loadedMetadata = PersistedWorkspaceMetadata(activeDocumentId: active, documents: loadedMetadataDocuments)
        if loadedMetadata != metadata {
            try writeMetadata(loadedMetadata)
        }
        return TreeOperations.normalizeWorkspace(WorkspaceV1DTO(activeDocumentId: active, documents: documents))
    }

    private func saveMarkdownWorkspace(_ workspace: WorkspaceV1DTO) throws {
        try FileManager.default.createDirectory(at: markdownDirectoryURL, withIntermediateDirectories: true)
        let previous = try loadMetadata()
        var usedFilenames = Set<String>()
        var reservedFilenames = Set(
            previous.documents
                .filter { prior in workspace.documents.contains { $0.id == prior.id } }
                .map { $0.filename.lowercased() }
        )
        var metadataDocuments: [PersistedDocumentMetadata] = []
        var supersededURLs: [URL] = []

        for (index, document) in workspace.documents.enumerated() {
            let prior = previous.documents.first { $0.id == document.id }
            if let prior {
                reservedFilenames.remove(prior.filename.lowercased())
            }
            let filename = markdownFilename(
                for: document,
                prior: prior,
                usedFilenames: &usedFilenames,
                reservedFilenames: reservedFilenames
            )
            let targetURL = markdownDirectoryURL.appendingPathComponent(filename)
            if let prior, prior.filename != filename {
                let oldURL = markdownDirectoryURL.appendingPathComponent(prior.filename)
                if FileManager.default.fileExists(atPath: oldURL.path), !FileManager.default.fileExists(atPath: targetURL.path) {
                    try FileManager.default.moveItem(at: oldURL, to: targetURL)
                } else if FileManager.default.fileExists(atPath: oldURL.path) {
                    supersededURLs.append(oldURL)
                }
            }
            let data = Data((MarkdownCodec.documentMarkdown(document) + "\n").utf8)
            if FileManager.default.fileExists(atPath: targetURL.path) {
                let existingData = try Data(contentsOf: targetURL)
                if existingData != data {
                    try data.write(to: targetURL, options: .atomic)
                }
            } else {
                try data.write(to: targetURL, options: .atomic)
            }
            metadataDocuments.append(PersistedDocumentMetadata(
                id: document.id,
                filename: filename,
                title: document.title,
                createdAt: document.createdAt,
                updatedAt: document.updatedAt,
                sortKey: index,
                nodes: document.nodes
            ))
        }

        let currentFilenames = Set(metadataDocuments.map { $0.filename.lowercased() })
        for url in supersededURLs where !currentFilenames.contains(url.lastPathComponent.lowercased()) {
            if FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
        }

        let activeIds = Set(workspace.documents.map(\.id))
        for stale in previous.documents where !activeIds.contains(stale.id) {
            guard !currentFilenames.contains(stale.filename.lowercased()) else { continue }
            let staleURL = markdownDirectoryURL.appendingPathComponent(stale.filename)
            if FileManager.default.fileExists(atPath: staleURL.path) {
                try FileManager.default.removeItem(at: staleURL)
            }
        }

        let metadata = PersistedWorkspaceMetadata(activeDocumentId: workspace.activeDocumentId, documents: metadataDocuments)
        try writeMetadata(metadata)
    }

    private func markdownFilename(
        for document: OutlineDocumentDTO,
        prior: PersistedDocumentMetadata?,
        usedFilenames: inout Set<String>,
        reservedFilenames: Set<String>
    ) -> String {
        let base = TreeOperations.sanitizeFilenameBase(document.title)
        let currentBase = prior?.filename.replacingOccurrences(of: #"\.(md|markdown)$"#, with: "", options: [.regularExpression, .caseInsensitive])
        let titleChanged = prior.map { $0.title != document.title } ?? true
        let preferredBase = titleChanged ? base : currentBase ?? base
        var candidate = "\(preferredBase).md"
        var suffix = 2
        while usedFilenames.contains(candidate.lowercased()) || reservedFilenames.contains(candidate.lowercased()) {
            candidate = "\(preferredBase) \(suffix).md"
            suffix += 1
        }
        usedFilenames.insert(candidate.lowercased())
        return candidate
    }

    private func loadMetadata() throws -> PersistedWorkspaceMetadata {
        guard FileManager.default.fileExists(atPath: metadataURL.path) else {
            return PersistedWorkspaceMetadata(activeDocumentId: "", documents: [])
        }
        let data = try Data(contentsOf: metadataURL)
        return (try? ImportExportCodec.jsonDecoder.decode(PersistedWorkspaceMetadata.self, from: data))
            ?? PersistedWorkspaceMetadata(activeDocumentId: "", documents: [])
    }

    private func writeMetadata(_ metadata: PersistedWorkspaceMetadata) throws {
        let metadataData = try ImportExportCodec.jsonEncoder.encode(metadata)
        try metadataData.write(to: metadataURL, options: .atomic)
    }

    private func archiveLegacyRootBackups() throws {
        guard FileManager.default.fileExists(atPath: markdownDirectoryURL.path) else { return }
        let urls = try FileManager.default.contentsOfDirectory(
            at: markdownDirectoryURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )
        let backupURLs = urls.filter { url in
            let name = url.lastPathComponent
            return name == ICloudBackupService.latestBackupFilename
                || (name.hasPrefix(ICloudBackupService.stampedBackupPrefix) && name.hasSuffix(".json"))
        }
        guard !backupURLs.isEmpty else { return }

        try FileManager.default.createDirectory(at: backupsURL, withIntermediateDirectories: true)
        for url in backupURLs {
            let destination = uniqueArchivedBackupURL(for: url.lastPathComponent)
            try FileManager.default.moveItem(at: url, to: destination)
        }
    }

    private func uniqueArchivedBackupURL(for filename: String) -> URL {
        let base = (filename as NSString).deletingPathExtension
        let ext = (filename as NSString).pathExtension
        var candidate = backupsURL.appendingPathComponent(filename)
        var suffix = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = backupsURL.appendingPathComponent("\(base)-migrated-\(suffix).\(ext)")
            suffix += 1
        }
        return candidate
    }

    private func snapshotReason(from url: URL) -> String {
        let name = url.deletingPathExtension().lastPathComponent
        let timestampSuffix = #"-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z$"#
        if let range = name.range(of: timestampSuffix, options: .regularExpression) {
            return String(name[..<range.lowerBound])
        }
        return name
    }

}

struct SnapshotInfo: Identifiable, Equatable {
    var id: String
    var reason: String
    var createdAt: Date
    var url: URL
}

private struct PersistedWorkspaceMetadata: Codable, Equatable {
    var activeDocumentId: String
    var documents: [PersistedDocumentMetadata]
}

private struct PersistedDocumentMetadata: Codable, Equatable {
    var id: String
    var filename: String
    var title: String
    var createdAt: String
    var updatedAt: String
    var sortKey: Int
    var nodes: [OutlineNodeDTO]? = nil
}
