import Foundation

public actor WorkspaceRepository {
    public let workspaceURL: URL

    public init(workspaceURL: URL? = nil) {
        if let workspaceURL {
            self.workspaceURL = workspaceURL
        } else {
            let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSTemporaryDirectory())
            self.workspaceURL = directory.appendingPathComponent("bike-workspace.json")
        }
    }

    public func loadOrCreate() throws -> WorkspacePayload {
        if !FileManager.default.fileExists(atPath: workspaceURL.path) {
            return try createAndPersistStarterWorkspace()
        }

        do {
            let source = try String(contentsOf: workspaceURL, encoding: .utf8)
            return try WorkspaceJSON.decode(source)
        } catch {
            let recovery = try? backupCorruptedWorkspaceFile()
            return try createAndPersistStarterWorkspace(
                recovery: recovery.map { WorkspaceRecovery(backupFileName: $0.lastPathComponent) }
            )
        }
    }

    @discardableResult
    public func save(_ payload: WorkspacePayload) throws -> WorkspacePayload {
        try writeTextAtomically(WorkspaceJSON.encode(payload))
        return payload
    }

    public func replace(fromJSON source: String) throws -> WorkspacePayload {
        let payload = try WorkspaceJSON.decode(source)
        try writeTextAtomically(WorkspaceJSON.encode(payload))
        return payload
    }

    public func exportText(_ payload: WorkspacePayload) throws -> String {
        try WorkspaceJSON.encode(payload)
    }

    private func createAndPersistStarterWorkspace(recovery: WorkspaceRecovery? = nil) throws -> WorkspacePayload {
        let workspace = createStarterWorkspace()
        var payload = try WorkspaceJSON.payload(for: workspace)
        payload.recovery = recovery
        try writeTextAtomically(WorkspaceJSON.encode(payload))
        return payload
    }

    private func backupCorruptedWorkspaceFile() throws -> URL {
        guard FileManager.default.fileExists(atPath: workspaceURL.path) else {
            throw CocoaError(.fileNoSuchFile)
        }
        let parent = workspaceURL.deletingLastPathComponent()
        let timestamp = ISO8601DateFormatter.bike.string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        var candidate = parent.appendingPathComponent("\(workspaceURL.lastPathComponent).corrupted-\(timestamp)")
        var index = 1
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = parent.appendingPathComponent("\(workspaceURL.lastPathComponent).corrupted-\(timestamp)-\(index)")
            index += 1
        }
        try FileManager.default.moveItem(at: workspaceURL, to: candidate)
        return candidate
    }

    private func writeTextAtomically(_ text: String) throws {
        let parent = workspaceURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        try text.write(to: workspaceURL, atomically: true, encoding: .utf8)
    }
}
