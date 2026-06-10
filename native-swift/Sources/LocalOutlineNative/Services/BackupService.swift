import AppKit
import Foundation

struct BackupResult {
    var ok: Bool
    var path: String?
    var error: String?
}

struct BackupFile: Identifiable, Equatable {
    var id: String { url.path }
    var url: URL
    var modifiedAt: Date?
    var size: Int?
}

enum ICloudBackupService {
    static let latestBackupFilename = "localoutline-workspace.json"
    static let stampedBackupPrefix = "localoutline-workspace-"

    static func directoryURL() -> URL {
        LocalOutlineStorage.backupDirectoryURL()
    }

    static func save(workspace: WorkspaceV1DTO, directory: URL = directoryURL()) -> BackupResult {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = try ImportExportCodec.exportWorkspace(workspace)
            let latest = directory.appendingPathComponent(latestBackupFilename)
            let stamp = Date.isoNow.replacingOccurrences(of: "[:.]", with: "-", options: .regularExpression)
            let stamped = directory.appendingPathComponent("\(stampedBackupPrefix)\(stamp).json")
            try coordinatedWrite(data, to: latest)
            try coordinatedWrite(data, to: stamped)
            return BackupResult(ok: true, path: latest.path)
        } catch {
            return BackupResult(ok: false, error: error.localizedDescription)
        }
    }

    static func load(directory: URL = directoryURL()) -> Result<(WorkspaceV1DTO, String), Error> {
        Result {
            let latest = directory.appendingPathComponent(latestBackupFilename)
            let data = try coordinatedReadData(from: latest)
            let workspace = try ImportExportCodec.jsonDecoder.decode(WorkspaceV1DTO.self, from: data)
            return (TreeOperations.normalizeWorkspace(workspace), latest.path)
        }
    }

    static func listBackups(directory: URL = directoryURL()) throws -> [BackupFile] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        let urls = try coordinatedDirectoryContents(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey]
        )
        return try urls
            .filter { url in
                let name = url.lastPathComponent
                return name == latestBackupFilename
                    || (name.hasPrefix(stampedBackupPrefix) && name.hasSuffix(".json"))
            }
            .map { url in
                let values = try url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
                return BackupFile(url: url, modifiedAt: values.contentModificationDate, size: values.fileSize)
            }
            .sorted { ($0.modifiedAt ?? .distantPast) > ($1.modifiedAt ?? .distantPast) }
    }

    static func openDirectoryInFinder() {
        LocalOutlineStorage.openDocumentsDirectoryInFinder()
    }

    private static func coordinatedWrite(_ data: Data, to url: URL) throws {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var writeError: Error?
        coordinator.coordinate(writingItemAt: url, options: .forReplacing, error: &coordinationError) { targetURL in
            do {
                try data.write(to: targetURL, options: .atomic)
            } catch {
                writeError = error
            }
        }
        if let writeError { throw writeError }
        if let coordinationError { throw coordinationError }
    }

    private static func coordinatedReadData(from url: URL) throws -> Data {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var readResult: Result<Data, Error>?
        coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { targetURL in
            readResult = Result { try Data(contentsOf: targetURL) }
        }
        if let readResult { return try readResult.get() }
        if let coordinationError { throw coordinationError }
        return Data()
    }

    private static func coordinatedDirectoryContents(
        at url: URL,
        includingPropertiesForKeys keys: [URLResourceKey]
    ) throws -> [URL] {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var listResult: Result<[URL], Error>?
        coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { targetURL in
            listResult = Result {
                try FileManager.default.contentsOfDirectory(
                    at: targetURL,
                    includingPropertiesForKeys: keys,
                    options: [.skipsHiddenFiles]
                )
            }
        }
        if let listResult { return try listResult.get() }
        if let coordinationError { throw coordinationError }
        return []
    }
}

enum LocalOutlineStorage {
    static let folderName = "LocalOutline"

    static func documentsDirectoryURL() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Mobile Documents/com~apple~CloudDocs/\(folderName)", isDirectory: true)
    }

    static func backupDirectoryURL() -> URL {
        documentsDirectoryURL().appendingPathComponent(".backups", isDirectory: true)
    }

    static func openDocumentsDirectoryInFinder() {
        let url = documentsDirectoryURL()
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
}

enum FilePanelService {
    @MainActor
    static func openImportPanel() -> URL? {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json, .plainText, .xml, .html]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        return panel.runModal() == .OK ? panel.url : nil
    }

    @MainActor
    static func savePanel(filename: String) -> URL? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = filename
        return panel.runModal() == .OK ? panel.url : nil
    }

    @MainActor
    static func openWorkspaceJSON() throws -> WorkspaceV1DTO? {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        let data = try Data(contentsOf: url)
        let workspace = try ImportExportCodec.jsonDecoder.decode(WorkspaceV1DTO.self, from: data)
        return TreeOperations.normalizeWorkspace(workspace)
    }

    @MainActor
    static func saveWorkspaceJSON(_ workspace: WorkspaceV1DTO) throws -> URL? {
        guard let url = savePanel(filename: ICloudBackupService.latestBackupFilename) else { return nil }
        try ImportExportCodec.exportWorkspace(workspace).write(to: url, options: .atomic)
        return url
    }

    @MainActor
    static func pickBackupDirectory() -> URL? {
        let panel = NSOpenPanel()
        panel.title = "选择备份文件夹"
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        return panel.runModal() == .OK ? panel.url : nil
    }
}
