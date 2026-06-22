import CryptoKit
import Foundation

struct SyncConfig: Codable, Equatable, Sendable {
    var serverUrl: String
    var token: String
    var autoSync: Bool
    var autoSyncIntervalSeconds: Int

    static let empty = SyncConfig(
        serverUrl: "",
        token: "",
        autoSync: false,
        autoSyncIntervalSeconds: defaultAutoSyncIntervalSeconds
    )
    static let defaultAutoSyncIntervalSeconds = 60
    static let minimumAutoSyncIntervalSeconds = 15

    var normalized: SyncConfig {
        SyncConfig(
            serverUrl: Self.normalizeServerUrl(serverUrl),
            token: token.trimmingCharacters(in: .whitespacesAndNewlines),
            autoSync: autoSync,
            autoSyncIntervalSeconds: Self.normalizeAutoSyncInterval(autoSyncIntervalSeconds)
        )
    }

    var isConfigured: Bool {
        Self.validationMessage(for: self) == nil
    }

    static func normalizeServerUrl(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        return trimmed.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
    }

    static func normalizeAutoSyncInterval(_ value: Int) -> Int {
        max(minimumAutoSyncIntervalSeconds, value)
    }

    static func validationMessage(for config: SyncConfig) -> String? {
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

struct SyncState: Codable, Equatable, Sendable {
    var serverUrl: String
    var workspaceRevision: Int?
    var documentRevisions: [String: Int]
    var documentFingerprints: [String: String]
    var deletedDocumentRevisions: [String: Int]
    var lastSyncedAt: String?

    static func empty(serverUrl: String) -> SyncState {
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

struct SyncDocumentSummary: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var title: String
    var revision: Int
    var updatedAt: String
    var deletedAt: String?
}

struct SyncManifest: Codable, Equatable, Sendable {
    var workspaceRevision: Int
    var activeDocumentId: String?
    var documentOrder: [String]
    var documents: [SyncDocumentSummary]
}

struct SyncSummary: Equatable, Sendable {
    var uploaded = 0
    var downloaded = 0
    var deleted = 0
    var conflicts: [String] = []

    var hasVisibleChange: Bool {
        uploaded > 0 || downloaded > 0 || deleted > 0 || !conflicts.isEmpty
    }

    var message: String {
        if !conflicts.isEmpty {
            return "同步完成，但有 \(conflicts.count) 个冲突"
        }
        let parts = [
            uploaded > 0 ? "上传 \(uploaded)" : nil,
            downloaded > 0 ? "下载 \(downloaded)" : nil,
            deleted > 0 ? "删除 \(deleted)" : nil
        ].compactMap { $0 }
        return parts.isEmpty ? "已同步，无变化" : "已同步：" + parts.joined(separator: "，")
    }
}

enum SyncServiceError: LocalizedError {
    case invalidServerURL
    case invalidResponse
    case invalidJSON(String)
    case requestFailed(status: Int, message: String, currentRevision: Int?)

    var errorDescription: String? {
        switch self {
        case .invalidServerURL:
            return "同步服务地址无效"
        case .invalidResponse:
            return "同步服务返回了无效响应"
        case .invalidJSON(let message):
            return message
        case .requestFailed(let status, let message, let currentRevision):
            if let currentRevision {
                return "\(message)（HTTP \(status)，当前 revision \(currentRevision)）"
            }
            return "\(message)（HTTP \(status)）"
        }
    }
}

private struct PersistedSyncConfig: Codable {
    var serverUrl: String
    var token: String?
    var autoSync: Bool?
    var autoSyncIntervalSeconds: Int?
}

enum SyncPreferences {
    private static let configKey = "bike.native.sync.config"
    private static let stateKey = "bike.native.sync.state"

    static func loadConfig() -> SyncConfig {
        guard let data = UserDefaults.standard.data(forKey: configKey),
              let persisted = try? ImportExportCodec.jsonDecoder.decode(PersistedSyncConfig.self, from: data) else {
            return SyncConfig(
                serverUrl: "",
                token: "",
                autoSync: false,
                autoSyncIntervalSeconds: SyncConfig.defaultAutoSyncIntervalSeconds
            )
        }
        return SyncConfig(
            serverUrl: persisted.serverUrl,
            token: persisted.token ?? "",
            autoSync: persisted.autoSync ?? false,
            autoSyncIntervalSeconds: persisted.autoSyncIntervalSeconds ?? SyncConfig.defaultAutoSyncIntervalSeconds
        ).normalized
    }

    static func saveConfig(_ config: SyncConfig) {
        let normalized = config.normalized
        let persisted = PersistedSyncConfig(
            serverUrl: normalized.serverUrl,
            token: normalized.token,
            autoSync: normalized.autoSync,
            autoSyncIntervalSeconds: normalized.autoSyncIntervalSeconds
        )
        if let data = try? ImportExportCodec.jsonEncoder.encode(persisted) {
            UserDefaults.standard.set(data, forKey: configKey)
        }
    }

    static func loadState(serverUrl: String) -> SyncState {
        let normalizedServerUrl = SyncConfig.normalizeServerUrl(serverUrl)
        guard let data = UserDefaults.standard.data(forKey: stateKey),
              let state = try? ImportExportCodec.jsonDecoder.decode(SyncState.self, from: data),
              state.serverUrl == normalizedServerUrl else {
            return .empty(serverUrl: normalizedServerUrl)
        }
        return state
    }

    static func saveState(_ state: SyncState) {
        if let data = try? ImportExportCodec.jsonEncoder.encode(state) {
            UserDefaults.standard.set(data, forKey: stateKey)
        }
    }
}

struct SyncService {
    private let config: SyncConfig
    private let session: URLSession

    init(config: SyncConfig, session: URLSession = .shared) {
        self.config = config.normalized
        self.session = session
    }

    func fetchManifest() async throws -> SyncManifest {
        try await apiRequest("/api/sync/manifest")
    }

    func fetchDocument(id: String) async throws -> (revision: Int, document: OutlineDocumentDTO) {
        let response: RemoteDocumentResponse = try await apiRequest("/api/documents/\(Self.pathComponent(id))")
        return (response.revision, TreeOperations.normalizeStandaloneDocument(response.document))
    }

    func putDocument(_ document: OutlineDocumentDTO, expectedRevision: Int?) async throws -> (revision: Int, document: OutlineDocumentDTO) {
        let body = PutDocumentBody(expectedRevision: expectedRevision, document: document)
        let response: RemoteDocumentResponse = try await apiRequest(
            "/api/documents/\(Self.pathComponent(document.id))",
            method: "PUT",
            body: try ImportExportCodec.jsonEncoder.encode(body)
        )
        return (response.revision, TreeOperations.normalizeStandaloneDocument(response.document))
    }

    private func deleteDocument(id: String, expectedRevision: Int) async throws -> DeletedDocumentResponse {
        let body = DeleteDocumentBody(expectedRevision: expectedRevision)
        return try await apiRequest(
            "/api/documents/\(Self.pathComponent(id))",
            method: "DELETE",
            body: try ImportExportCodec.jsonEncoder.encode(body)
        )
    }

    func patchManifest(expectedRevision: Int, activeDocumentId: String?, documentOrder: [String]) async throws -> SyncManifest {
        let body = PatchManifestBody(
            expectedRevision: expectedRevision,
            activeDocumentId: activeDocumentId,
            documentOrder: documentOrder
        )
        return try await apiRequest(
            "/api/sync/manifest",
            method: "PATCH",
            body: try ImportExportCodec.jsonEncoder.encode(body)
        )
    }

    func pullWorkspace() async throws -> (workspace: WorkspaceV1DTO?, state: SyncState, manifest: SyncManifest) {
        var state = SyncState.empty(serverUrl: config.serverUrl)
        let manifest = try await fetchManifest()
        let workspace = try await workspaceFromRemote(manifest: manifest, state: &state)
        state.workspaceRevision = manifest.workspaceRevision
        state.lastSyncedAt = Date.isoNow
        return (workspace, state, manifest)
    }

    func pushWorkspace(_ workspace: WorkspaceV1DTO) async throws -> (state: SyncState, summary: SyncSummary) {
        var state = SyncState.empty(serverUrl: config.serverUrl)
        var summary = SyncSummary()
        var manifest = try await fetchManifest()
        let remoteById = Dictionary(uniqueKeysWithValues: manifest.documents.map { ($0.id, $0) })

        for document in workspace.documents {
            let remote = remoteById[document.id]
            let expectedRevision = remote?.revision
            let result = try await putDocument(document, expectedRevision: expectedRevision)
            try recordDocumentState(&state, document: result.document, revision: result.revision)
            summary.uploaded += 1
        }

        manifest = try await fetchManifest()
        let patchedManifest = try await patchManifest(
            expectedRevision: manifest.workspaceRevision,
            activeDocumentId: workspace.activeDocumentId,
            documentOrder: workspace.documents.map(\.id)
        )
        state.workspaceRevision = patchedManifest.workspaceRevision
        state.lastSyncedAt = Date.isoNow
        return (state, summary)
    }

    func syncWorkspace(
        _ workspace: WorkspaceV1DTO,
        previousState: SyncState
    ) async throws -> (workspace: WorkspaceV1DTO, state: SyncState, summary: SyncSummary) {
        var state = previousState
        state.serverUrl = config.serverUrl
        var summary = SyncSummary()
        let manifest = try await fetchManifest()
        let remoteById = Dictionary(uniqueKeysWithValues: manifest.documents.map { ($0.id, $0) })
        let remoteLiveIds = Set(manifest.documents.filter { $0.deletedAt == nil }.map(\.id))
        var documents = workspace.documents

        func localById() -> [String: OutlineDocumentDTO] {
            Dictionary(uniqueKeysWithValues: documents.map { ($0.id, $0) })
        }

        for remote in manifest.documents {
            let local = localById()[remote.id]
            let knownRevision = state.documentRevisions[remote.id]
            let knownFingerprint = state.documentFingerprints[remote.id]
            let localChanged: Bool
            if let local {
                let localFingerprint = try documentFingerprint(local)
                localChanged = knownFingerprint != localFingerprint
            } else {
                localChanged = false
            }

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
                let remoteFingerprint = try documentFingerprint(downloaded.document)
                let localFingerprint = try documentFingerprint(local)
                if remoteFingerprint == localFingerprint {
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
        let nextWorkspace = WorkspaceV1DTO(activeDocumentId: activeDocumentId, documents: ordered)

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
        state.lastSyncedAt = Date.isoNow
        return (TreeOperations.normalizeWorkspace(nextWorkspace), state, summary)
    }

    private func workspaceFromRemote(
        manifest: SyncManifest,
        state: inout SyncState
    ) async throws -> WorkspaceV1DTO? {
        var documents: [OutlineDocumentDTO] = []
        for summary in manifest.documents {
            if summary.deletedAt != nil {
                recordDeletedState(&state, id: summary.id, revision: summary.revision)
                continue
            }
            let remote = try await fetchDocument(id: summary.id)
            documents.append(remote.document)
            try recordDocumentState(&state, document: remote.document, revision: remote.revision)
        }
        guard !documents.isEmpty else { return nil }
        let ordered = orderedDocuments(documents, documentOrder: manifest.documentOrder)
        let activeDocumentId = manifest.activeDocumentId.flatMap { id in
            ordered.contains { $0.id == id } ? id : nil
        } ?? ordered[0].id
        return TreeOperations.normalizeWorkspace(WorkspaceV1DTO(activeDocumentId: activeDocumentId, documents: ordered))
    }

    private func apiRequest<Response: Decodable>(
        _ pathname: String,
        method: String = "GET",
        body: Data? = nil
    ) async throws -> Response {
        guard let url = URL(string: "\(config.serverUrl)\(pathname)") else {
            throw SyncServiceError.invalidServerURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw SyncServiceError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let errorBody = try? ImportExportCodec.jsonDecoder.decode(SyncErrorBody.self, from: data)
            let fallback = String(data: data.prefix(500), encoding: .utf8)
            throw SyncServiceError.requestFailed(
                status: httpResponse.statusCode,
                message: errorBody?.message ?? fallback ?? "同步请求失败",
                currentRevision: errorBody?.currentRevision
            )
        }
        do {
            return try ImportExportCodec.jsonDecoder.decode(Response.self, from: data)
        } catch {
            throw SyncServiceError.invalidJSON("同步服务返回了无效 JSON")
        }
    }

    private func orderedDocuments(
        _ documents: [OutlineDocumentDTO],
        documentOrder: [String]
    ) -> [OutlineDocumentDTO] {
        var byId = Dictionary(uniqueKeysWithValues: documents.map { ($0.id, $0) })
        var ordered: [OutlineDocumentDTO] = []
        for id in documentOrder {
            if let document = byId.removeValue(forKey: id) {
                ordered.append(document)
            }
        }
        ordered.append(contentsOf: byId.values)
        return ordered
    }

    private func recordDocumentState(
        _ state: inout SyncState,
        document: OutlineDocumentDTO,
        revision: Int
    ) throws {
        state.documentRevisions[document.id] = revision
        state.documentFingerprints[document.id] = try documentFingerprint(document)
        state.deletedDocumentRevisions.removeValue(forKey: document.id)
    }

    private func recordDeletedState(_ state: inout SyncState, id: String, revision: Int) {
        state.deletedDocumentRevisions[id] = revision
        state.documentRevisions[id] = revision
        state.documentFingerprints.removeValue(forKey: id)
    }

    private func documentFingerprint(_ document: OutlineDocumentDTO) throws -> String {
        let data = try ImportExportCodec.jsonEncoder.encode(document)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func pathComponent(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}

private struct RemoteDocumentResponse: Codable {
    var revision: Int
    var document: OutlineDocumentDTO
}

private struct DeletedDocumentResponse: Codable {
    var id: String
    var revision: Int
    var deletedAt: String
}

private struct PutDocumentBody: Codable {
    var expectedRevision: Int?
    var document: OutlineDocumentDTO
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
    var error: String?
    var message: String?
    var currentRevision: Int?
}

private extension TreeOperations {
    static func normalizeStandaloneDocument(_ document: OutlineDocumentDTO) -> OutlineDocumentDTO {
        var usedIds = Set<String>()
        return normalizeDocument(document, usedIds: &usedIds)
    }
}
