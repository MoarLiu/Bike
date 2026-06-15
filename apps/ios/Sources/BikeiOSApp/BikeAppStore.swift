import BikeCore
import Foundation

@MainActor
final class BikeAppStore: ObservableObject {
    @Published var payload: WorkspacePayload?
    @Published var status = "正在载入工作区..."
    @Published var aiSettings: AiSettings
    @Published var showAISettings = false
    @Published var aiBusyNodeId: String?

    private let repository: WorkspaceRepository
    private let aiSettingsStore: AiSettingsStore
    private var saveTask: Task<Void, Never>?
    private var saveRequestId = 0
    private var aiTask: Task<Void, Never>?
    private var aiRequestId = 0

    init(
        repository: WorkspaceRepository = WorkspaceRepository(),
        aiSettingsStore: AiSettingsStore = AiSettingsStore()
    ) {
        self.repository = repository
        self.aiSettingsStore = aiSettingsStore
        self.aiSettings = aiSettingsStore.load()
    }

    func load() {
        Task {
            do {
                payload = try await repository.loadOrCreate()
                status = payload?.recovery.map {
                    "工作区文件损坏，已备份为 \($0.backupFileName)，并创建新工作区"
                } ?? "已载入本地工作区"
            } catch {
                status = error.localizedDescription
            }
        }
    }

    @discardableResult
    func saveAISettings(_ settings: AiSettings) -> Bool {
        do {
            let normalized = settings.normalized()
            let storageMode = try aiSettingsStore.save(normalized)
            aiSettings = normalized
            showAISettings = false
            status = storageMode == .debugFallback
                ? "AI 配置已保存到本机调试存储"
                : "AI 配置已保存"
            return true
        } catch {
            status = "AI 配置保存失败：\(error.localizedDescription)"
            return false
        }
    }

    func mutateWorkspace(_ transform: (Workspace) -> Workspace) {
        guard var current = payload else { return }
        current.workspace = transform(current.workspace)
        replacePayload(current)
    }

    func replacePayload(_ next: WorkspacePayload, persist: Bool = true) {
        payload = next
        guard persist else { return }
        saveRequestId += 1
        let requestId = saveRequestId
        saveTask?.cancel()
        status = "正在保存..."
        saveTask = Task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, requestId == saveRequestId else { return }
            do {
                _ = try await repository.save(next)
                guard requestId == saveRequestId else { return }
                status = "已保存到本机"
            } catch {
                guard requestId == saveRequestId else { return }
                status = error.localizedDescription
            }
        }
    }

    func importWorkspace(json: String) {
        cancelAI(message: "已取消未完成的 AI 请求")
        saveRequestId += 1
        saveTask?.cancel()
        Task {
            do {
                payload = try await repository.replace(fromJSON: json)
                status = "已导入工作区"
            } catch {
                status = error.localizedDescription
            }
        }
    }

    func exportText() async -> String? {
        guard let payload else { return nil }
        do {
            return try await repository.exportText(payload)
        } catch {
            status = error.localizedDescription
            return nil
        }
    }

    func cancelAI(message: String? = nil) {
        if aiTask != nil || aiBusyNodeId != nil {
            aiRequestId += 1
            aiTask?.cancel()
            aiTask = nil
            aiBusyNodeId = nil
            if let message { status = message }
        }
    }

    func runAIGenerate(documentId: String, node: OutlineNode) {
        guard aiTask == nil, aiBusyNodeId == nil else {
            status = "AI 正在处理，请稍后"
            return
        }
        guard aiSettings.isConfigured else {
            showAISettings = true
            status = "请先配置 AI Base URL、API key 和模型"
            return
        }

        aiRequestId += 1
        let requestId = aiRequestId
        aiBusyNodeId = node.id
        status = "AI 正在生成子主题..."
        aiTask = Task {
            do {
                let title = payload?.workspace.documents.first(where: { $0.id == documentId })?.title ?? ""
                let result = try await AiService.run(
                    settings: aiSettings,
                    action: .generate,
                    context: AiActionContext(
                        documentTitle: title,
                        topicText: node.text,
                        note: node.note,
                        existingChildren: node.children.map(\.text)
                    )
                )
                guard requestId == aiRequestId, !Task.isCancelled else { return }
                let outlineChildren = AiService.generatedNodesToOutlineNodes(result.children ?? [])
                guard !outlineChildren.isEmpty else {
                    status = "AI 没有生成可用子主题"
                    finishAI(requestId)
                    return
                }
                mutateWorkspace {
                    $0.withGeneratedOutlineChildren(
                        documentId: documentId,
                        nodeId: node.id,
                        children: outlineChildren
                    )
                }
                status = "AI 已生成子主题"
                finishAI(requestId)
            } catch is CancellationError {
                finishAI(requestId)
            } catch {
                guard requestId == aiRequestId else { return }
                status = "AI 生成失败：\(error.localizedDescription)"
                finishAI(requestId)
            }
        }
    }

    func runAIPolish(documentId: String, node: OutlineNode) {
        guard aiTask == nil, aiBusyNodeId == nil else {
            status = "AI 正在处理，请稍后"
            return
        }
        guard aiSettings.isConfigured else {
            showAISettings = true
            status = "请先配置 AI Base URL、API key 和模型"
            return
        }

        aiRequestId += 1
        let requestId = aiRequestId
        aiBusyNodeId = node.id
        status = "AI 正在润色主题..."
        aiTask = Task {
            do {
                let title = payload?.workspace.documents.first(where: { $0.id == documentId })?.title ?? ""
                let result = try await AiService.run(
                    settings: aiSettings,
                    action: .polish,
                    context: AiActionContext(
                        documentTitle: title,
                        topicText: node.text,
                        note: node.note,
                        existingChildren: node.children.map(\.text)
                    )
                )
                guard requestId == aiRequestId, !Task.isCancelled else { return }
                let text = result.text ?? ""
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    status = "AI 没有返回润色文本"
                    finishAI(requestId)
                    return
                }
                mutateWorkspace {
                    $0.withNodeText(documentId: documentId, nodeId: node.id, text: text)
                }
                status = "AI 已润色主题"
                finishAI(requestId)
            } catch is CancellationError {
                finishAI(requestId)
            } catch {
                guard requestId == aiRequestId else { return }
                status = "AI 润色失败：\(error.localizedDescription)"
                finishAI(requestId)
            }
        }
    }

    private func finishAI(_ requestId: Int) {
        guard requestId == aiRequestId else { return }
        aiBusyNodeId = nil
        aiTask = nil
    }
}
