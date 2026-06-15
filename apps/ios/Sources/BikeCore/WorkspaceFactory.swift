import Foundation

public func outlineNode(
    _ text: String,
    note: String = "",
    children: [OutlineNode] = []
) -> OutlineNode {
    OutlineNode(text: text, note: note, children: children)
}

public func createStarterWorkspace(now: Date = Date()) -> Workspace {
    let timestamp = ISO8601DateFormatter.bike.string(from: now)
    let documentId = newBikeId("doc")
    let document = OutlineDocument(
        id: documentId,
        title: inboxDocumentTitle,
        createdAt: timestamp,
        updatedAt: timestamp,
        nodes: [
            outlineNode(
                "快速捕捉",
                children: [
                    outlineNode("从 iOS 分享面板收集文字和链接"),
                    outlineNode("离线保存到本机工作区"),
                    outlineNode("回到桌面端继续深度整理")
                ]
            ),
            outlineNode(
                "轻量整理",
                children: [
                    outlineNode("新增同级和子级主题"),
                    outlineNode("折叠、勾选、备注"),
                    outlineNode("保持 Workspace v1 JSON 兼容")
                ]
            )
        ]
    )
    return Workspace(activeDocumentId: documentId, documents: [document])
}

public extension Workspace {
    func activeDocument() throws -> OutlineDocument {
        if let document = documents.first(where: { $0.id == activeDocumentId }) {
            return document
        }
        if let document = documents.first {
            return document
        }
        throw WorkspaceError.noAvailableDocument
    }
}

public extension OutlineDocument {
    func nodeCount() -> Int {
        nodes.reduce(0) { $0 + $1.nodeCount() }
    }
}

public extension OutlineNode {
    func nodeCount() -> Int {
        1 + children.reduce(0) { $0 + $1.nodeCount() }
    }
}

public enum WorkspaceError: LocalizedError, Equatable {
    case noAvailableDocument
    case invalidWorkspace

    public var errorDescription: String? {
        switch self {
        case .noAvailableDocument:
            "工作区没有可用文档"
        case .invalidWorkspace:
            "工作区至少需要一篇文档"
        }
    }
}
