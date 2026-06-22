import CryptoKit
import Foundation

public struct SyncConfig: Codable, Equatable, Sendable {
    public var serverUrl: String
    public var token: String
    public var autoSync: Bool
    public var autoSyncIntervalSeconds: Int

    public static let defaultAutoSyncIntervalSeconds = 60
    public static let minimumAutoSyncIntervalSeconds = 15

    public init(
        serverUrl: String = "",
        token: String = "",
        autoSync: Bool = false,
        autoSyncIntervalSeconds: Int = defaultAutoSyncIntervalSeconds
    ) {
        self.serverUrl = serverUrl
        self.token = token
        self.autoSync = autoSync
        self.autoSyncIntervalSeconds = autoSyncIntervalSeconds
    }

    public var normalized: SyncConfig {
        SyncConfig(
            serverUrl: Self.normalizeServerUrl(serverUrl),
            token: token.trimmingCharacters(in: .whitespacesAndNewlines),
            autoSync: autoSync,
            autoSyncIntervalSeconds: Self.normalizeAutoSyncInterval(autoSyncIntervalSeconds)
        )
    }

    public var isConfigured: Bool {
        Self.validationMessage(for: self) == nil
    }

    public static func normalizeServerUrl(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        return trimmed.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
    }

    public static func normalizeAutoSyncInterval(_ value: Int) -> Int {
        max(minimumAutoSyncIntervalSeconds, value)
    }

    public static func validationMessage(for config: SyncConfig) -> String? {
        let normalized = config.normalized
        guard !normalized.serverUrl.isEmpty else { return "请输入 Web 版地址" }
        guard let url = URL(string: normalized.serverUrl),
              url.scheme == "http" || url.scheme == "https",
              url.host?.isEmpty == false else {
            return "Web 版地址需要以 http:// 或 https:// 开头"
        }
        guard !normalized.token.isEmpty else { return "请输入设备同步密钥" }
        return nil
    }
}

public struct SyncState: Codable, Equatable, Sendable {
    public var serverUrl: String
    public var workspaceRevision: Int?
    public var documentRevisions: [String: Int]
    public var documentFingerprints: [String: String]
    public var deletedDocumentRevisions: [String: Int]
    public var lastSyncedAt: String?

    public static func empty(serverUrl: String) -> SyncState {
        SyncState(
            serverUrl: SyncConfig.normalizeServerUrl(serverUrl),
            workspaceRevision: nil,
            documentRevisions: [:],
            documentFingerprints: [:],
            deletedDocumentRevisions: [:],
            lastSyncedAt: nil
        )
    }
}

public struct SyncSummary: Equatable, Sendable {
    public var uploaded = 0
    public var downloaded = 0
    public var deleted = 0
    public var conflicts: [String] = []

    public var hasVisibleChange: Bool {
        uploaded > 0 || downloaded > 0 || deleted > 0 || !conflicts.isEmpty
    }

    public var message: String {
        if !conflicts.isEmpty { return "同步完成，但有 \(conflicts.count) 个冲突" }
        let parts = [
            uploaded > 0 ? "上传 \(uploaded)" : nil,
            downloaded > 0 ? "下载 \(downloaded)" : nil,
            deleted > 0 ? "删除 \(deleted)" : nil
        ].compactMap { $0 }
        return parts.isEmpty ? "已同步，无变化" : "已同步：" + parts.joined(separator: "，")
    }
}

public struct SyncDocumentSummary: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var revision: Int
    public var updatedAt: String
    public var deletedAt: String?
}

public struct SyncManifest: Codable, Equatable, Sendable {
    public var workspaceRevision: Int
    public var activeDocumentId: String?
    public var documentOrder: [String]
    public var documents: [SyncDocumentSummary]
}

public enum SyncServiceError: LocalizedError {
    case invalidServerURL
    case invalidResponse
    case invalidJSON
    case requestFailed(status: Int, message: String, currentRevision: Int?)

    public var errorDescription: String? {
        switch self {
        case .invalidServerURL: "同步服务地址无效"
        case .invalidResponse: "同步服务返回了无效响应"
        case .invalidJSON: "同步服务返回了无效 JSON"
        case .requestFailed(let status, let message, let currentRevision):
            currentRevision.map { "\(message)（HTTP \(status)，当前 revision \($0)）" } ?? "\(message)（HTTP \(status)）"
        }
    }
}

public enum SyncPreferences {
    private static let configKey = "bike.ios.sync.config"
    private static let stateKey = "bike.ios.sync.state"

    public static func loadConfig() -> SyncConfig {
        guard let data = UserDefaults.standard.data(forKey: configKey),
              let persisted = try? WorkspaceJSON.decoder.decode(PersistedSyncConfig.self, from: data) else {
            return SyncConfig()
        }
        return SyncConfig(
            serverUrl: persisted.serverUrl,
            token: persisted.token ?? "",
            autoSync: persisted.autoSync ?? false,
            autoSyncIntervalSeconds: persisted.autoSyncIntervalSeconds ?? SyncConfig.defaultAutoSyncIntervalSeconds
        ).normalized
    }

    public static func saveConfig(_ config: SyncConfig) {
        let normalized = config.normalized
        let persisted = PersistedSyncConfig(
            serverUrl: normalized.serverUrl,
            token: normalized.token,
            autoSync: normalized.autoSync,
            autoSyncIntervalSeconds: normalized.autoSyncIntervalSeconds
        )
        if let data = try? WorkspaceJSON.encoder.encode(persisted) {
            UserDefaults.standard.set(data, forKey: configKey)
        }
    }

    public static func loadState(serverUrl: String) -> SyncState {
        let normalizedServerUrl = SyncConfig.normalizeServerUrl(serverUrl)
        guard let data = UserDefaults.standard.data(forKey: stateKey),
              let state = try? WorkspaceJSON.decoder.decode(SyncState.self, from: data),
              state.serverUrl == normalizedServerUrl else {
            return .empty(serverUrl: normalizedServerUrl)
        }
        return state
    }

    public static func saveState(_ state: SyncState) {
        if let data = try? WorkspaceJSON.encoder.encode(state) {
            UserDefaults.standard.set(data, forKey: stateKey)
        }
    }
}

public struct SyncService {
    private let config: SyncConfig
    private let session: URLSession

    public init(config: SyncConfig, session: URLSession = .shared) {
        self.config = config.normalized
        self.session = session
    }

    public func syncWorkspace(
        _ workspace: Workspace,
        previousState: SyncState
    ) async throws -> (workspace: Workspace, state: SyncState, summary: SyncSummary) {
        var state = previousState
        state.serverUrl = config.serverUrl
        var summary = SyncSummary()
        let manifest = try await fetchManifest()
        let remoteById = Dictionary(uniqueKeysWithValues: manifest.documents.map { ($0.id, $0) })
        let remoteLiveIds = Set(manifest.documents.filter { $0.deletedAt == nil }.map(\.id))
        var documents = workspace.documents

        func localById() -> [String: OutlineDocument] {
            Dictionary(uniqueKeysWithValues: documents.map { ($0.id, $0) })
        }

        for remote in manifest.documents {
            let local = localById()[remote.id]
            let knownRevision = state.documentRevisions[remote.id]
            let knownFingerprint = state.documentFingerprints[remote.id]
            let localChanged = try local.map { try documentFingerprint($0) != knownFingerprint } ?? false

            if remote.deletedAt != nil {
                recordDeletedState(&state, id: remote.id, revision: remote.revision)
                guard let local else { continue }
                if documents.count == 1 {
                    summary.conflicts.append("\(local.title)：远端已删除，但本机至少需要保留一个文档")
                    continue
                }
                if knownRevision != nil, !localChanged {
                    documents.removeAll { $0.id == remote.id }
                    summary.deleted += 1
                } else {
                    summary.conflicts.append("\(local.title)：远端已删除，本机也有改动")
                }
                continue
            }

            guard let local else {
                if let knownRevision {
                    if knownRevision == remote.revision {
                        let deleted = try await deleteDocument(id: remote.id, expectedRevision: remote.revision)
                        recordDeletedState(&state, id: remote.id, revision: deleted.revision)
                        summary.deleted += 1
                    } else {
                        summary.conflicts.append("\(remote.title)：本机已删除，但远端有更新")
                    }
                } else {
                    let downloaded = try await fetchDocument(id: remote.id)
                    documents.append(downloaded.document)
                    try recordDocumentState(&state, document: downloaded.document, revision: downloaded.revision)
                    summary.downloaded += 1
                }
                continue
            }

            guard let knownRevision else {
                let downloaded = try await fetchDocument(id: remote.id)
                if try documentFingerprint(downloaded.document) == documentFingerprint(local) {
                    try recordDocumentState(&state, document: local, revision: downloaded.revision)
                } else {
                    summary.conflicts.append("\(local.title)：本机和远端都存在，尚未建立共同 revision")
                }
                continue
            }

            if knownRevision == remote.revision {
                if localChanged {
                    let uploaded = try await putDocument(local, expectedRevision: knownRevision)
                    documents = documents.map { $0.id == uploaded.document.id ? uploaded.document : $0 }
                    try recordDocumentState(&state, document: uploaded.document, revision: uploaded.revision)
                    summary.uploaded += 1
                } else {
                    try recordDocumentState(&state, document: local, revision: remote.revision)
                }
                continue
            }

            if !localChanged {
                let downloaded = try await fetchDocument(id: remote.id)
                documents = documents.map { $0.id == downloaded.document.id ? downloaded.document : $0 }
                try recordDocumentState(&state, document: downloaded.document, revision: downloaded.revision)
                summary.downloaded += 1
            } else {
                summary.conflicts.append("\(local.title)：本机和远端都有新改动")
            }
        }

        for local in documents where remoteById[local.id] == nil && !remoteLiveIds.contains(local.id) {
            let uploaded = try await putDocument(local, expectedRevision: nil)
            documents = documents.map { $0.id == uploaded.document.id ? uploaded.document : $0 }
            try recordDocumentState(&state, document: uploaded.document, revision: uploaded.revision)
            summary.uploaded += 1
        }

        let localOrder = workspace.documents.map(\.id)
        let preferredOrder = localOrder + manifest.documentOrder.filter { !localOrder.contains($0) }
        let ordered = orderedDocuments(documents, documentOrder: preferredOrder)
        let activeDocumentId = ordered.contains { $0.id == workspace.activeDocumentId }
            ? workspace.activeDocumentId
            : ordered.first?.id ?? workspace.activeDocumentId
        let nextWorkspace = Workspace(activeDocumentId: activeDocumentId, documents: ordered)

        if summary.conflicts.isEmpty, !nextWorkspace.documents.isEmpty {
            let latestManifest = try await fetchManifest()
            let patchedManifest = try await patchManifest(
                expectedRevision: latestManifest.workspaceRevision,
                activeDocumentId: nextWorkspace.activeDocumentId,
                documentOrder: nextWorkspace.documents.map(\.id)
            )
            state.workspaceRevision = patchedManifest.workspaceRevision
        } else {
            state.workspaceRevision = manifest.workspaceRevision
        }
        state.lastSyncedAt = Date.bikeISO8601
        return (nextWorkspace, state, summary)
    }

    public func pullWorkspace() async throws -> (workspace: Workspace?, state: SyncState, manifest: SyncManifest) {
        var state = SyncState.empty(serverUrl: config.serverUrl)
        let manifest = try await fetchManifest()
        var documents: [OutlineDocument] = []
        for summary in manifest.documents {
            if summary.deletedAt != nil {
                recordDeletedState(&state, id: summary.id, revision: summary.revision)
                continue
            }
            let remote = try await fetchDocument(id: summary.id)
            documents.append(remote.document)
            try recordDocumentState(&state, document: remote.document, revision: remote.revision)
        }
        state.workspaceRevision = manifest.workspaceRevision
        state.lastSyncedAt = Date.bikeISO8601
        guard !documents.isEmpty else { return (nil, state, manifest) }
        let ordered = orderedDocuments(documents, documentOrder: manifest.documentOrder)
        let activeDocumentId = manifest.activeDocumentId.flatMap { id in
            ordered.contains { $0.id == id } ? id : nil
        } ?? ordered[0].id
        return (Workspace(activeDocumentId: activeDocumentId, documents: ordered), state, manifest)
    }

    public func pushWorkspace(_ workspace: Workspace) async throws -> (state: SyncState, summary: SyncSummary) {
        var state = SyncState.empty(serverUrl: config.serverUrl)
        var summary = SyncSummary()
        var manifest = try await fetchManifest()
        let remoteById = Dictionary(uniqueKeysWithValues: manifest.documents.map { ($0.id, $0) })
        for document in workspace.documents {
            let uploaded = try await putDocument(document, expectedRevision: remoteById[document.id]?.revision)
            try recordDocumentState(&state, document: uploaded.document, revision: uploaded.revision)
            summary.uploaded += 1
        }
        manifest = try await fetchManifest()
        let patchedManifest = try await patchManifest(
            expectedRevision: manifest.workspaceRevision,
            activeDocumentId: workspace.activeDocumentId,
            documentOrder: workspace.documents.map(\.id)
        )
        state.workspaceRevision = patchedManifest.workspaceRevision
        state.lastSyncedAt = Date.bikeISO8601
        return (state, summary)
    }

    private func fetchManifest() async throws -> SyncManifest {
        try await apiRequest("/api/sync/manifest")
    }

    private func fetchDocument(id: String) async throws -> (revision: Int, document: OutlineDocument) {
        let response: RemoteDocumentResponse = try await apiRequest("/api/documents/\(Self.pathComponent(id))")
        return (response.revision, response.document)
    }

    private func putDocument(_ document: OutlineDocument, expectedRevision: Int?) async throws -> (revision: Int, document: OutlineDocument) {
        let body = PutDocumentBody(expectedRevision: expectedRevision, document: document)
        let response: RemoteDocumentResponse = try await apiRequest(
            "/api/documents/\(Self.pathComponent(document.id))",
            method: "PUT",
            body: try WorkspaceJSON.encoder.encode(body)
        )
        return (response.revision, response.document)
    }

    private func deleteDocument(id: String, expectedRevision: Int) async throws -> DeletedDocumentResponse {
        let body = DeleteDocumentBody(expectedRevision: expectedRevision)
        return try await apiRequest(
            "/api/documents/\(Self.pathComponent(id))",
            method: "DELETE",
            body: try WorkspaceJSON.encoder.encode(body)
        )
    }

    private func patchManifest(expectedRevision: Int, activeDocumentId: String?, documentOrder: [String]) async throws -> SyncManifest {
        let body = PatchManifestBody(expectedRevision: expectedRevision, activeDocumentId: activeDocumentId, documentOrder: documentOrder)
        return try await apiRequest("/api/sync/manifest", method: "PATCH", body: try WorkspaceJSON.encoder.encode(body))
    }

    private func apiRequest<Response: Decodable>(_ pathname: String, method: String = "GET", body: Data? = nil) async throws -> Response {
        guard let url = URL(string: "\(config.serverUrl)\(pathname)") else { throw SyncServiceError.invalidServerURL }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else { throw SyncServiceError.invalidResponse }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let body = try? WorkspaceJSON.decoder.decode(SyncErrorBody.self, from: data)
            let fallback = String(data: data.prefix(500), encoding: .utf8)
            throw SyncServiceError.requestFailed(
                status: httpResponse.statusCode,
                message: body?.message ?? fallback ?? "同步请求失败",
                currentRevision: body?.currentRevision
            )
        }
        do {
            return try WorkspaceJSON.decoder.decode(Response.self, from: data)
        } catch {
            throw SyncServiceError.invalidJSON
        }
    }

    private func orderedDocuments(_ documents: [OutlineDocument], documentOrder: [String]) -> [OutlineDocument] {
        var byId = Dictionary(uniqueKeysWithValues: documents.map { ($0.id, $0) })
        var ordered: [OutlineDocument] = []
        for id in documentOrder {
            if let document = byId.removeValue(forKey: id) {
                ordered.append(document)
            }
        }
        ordered.append(contentsOf: byId.values)
        return ordered
    }

    private func recordDocumentState(_ state: inout SyncState, document: OutlineDocument, revision: Int) throws {
        state.documentRevisions[document.id] = revision
        state.documentFingerprints[document.id] = try documentFingerprint(document)
        state.deletedDocumentRevisions.removeValue(forKey: document.id)
    }

    private func recordDeletedState(_ state: inout SyncState, id: String, revision: Int) {
        state.deletedDocumentRevisions[id] = revision
        state.documentRevisions[id] = revision
        state.documentFingerprints.removeValue(forKey: id)
    }

    private func documentFingerprint(_ document: OutlineDocument) throws -> String {
        let data = try WorkspaceJSON.encoder.encode(document)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func pathComponent(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}

private struct PersistedSyncConfig: Codable {
    var serverUrl: String
    var token: String?
    var autoSync: Bool?
    var autoSyncIntervalSeconds: Int?
}

private struct RemoteDocumentResponse: Codable {
    var revision: Int
    var document: OutlineDocument
}

private struct DeletedDocumentResponse: Codable {
    var id: String
    var revision: Int
    var deletedAt: String
}

private struct PutDocumentBody: Codable {
    var expectedRevision: Int?
    var document: OutlineDocument
}

private struct DeleteDocumentBody: Codable {
    var expectedRevision: Int
}

private struct PatchManifestBody: Codable {
    var expectedRevision: Int
    var activeDocumentId: String?
    var documentOrder: [String]
}

private struct SyncErrorBody: Codable {
    var message: String?
    var currentRevision: Int?
}
