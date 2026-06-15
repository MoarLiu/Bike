import Foundation

public extension Workspace {
    func withActiveDocument(_ documentId: String) -> Workspace {
        guard documents.contains(where: { $0.id == documentId }) else { return self }
        var next = self
        next.activeDocumentId = documentId
        return next
    }

    func withDocumentTitle(documentId: String, title: String, now: Date = Date()) -> Workspace {
        updateDocument(documentId, now: now) { document in
            document.title = String(title.prefix(120))
        }
    }

    func withDocumentShortcut(documentId: String, isShortcut: Bool, now: Date = Date()) -> Workspace {
        updateDocument(documentId, now: now) { document in
            document.isShortcut = isShortcut
        }
    }

    func withDocumentMovedToFront(_ documentId: String) -> Workspace {
        guard let index = documents.firstIndex(where: { $0.id == documentId }), index > 0 else {
            return self
        }
        var nextDocuments = documents
        let document = nextDocuments.remove(at: index)
        nextDocuments.insert(document, at: 0)
        var next = self
        next.documents = nextDocuments
        return next
    }

    func withDocumentDuplicated(documentId: String, now: Date = Date()) -> Workspace {
        guard let index = documents.firstIndex(where: { $0.id == documentId }) else { return self }
        let duplicated = documents[index].duplicated(now: now)
        var next = self
        next.documents.insert(duplicated, at: index + 1)
        next.activeDocumentId = duplicated.id
        return next
    }

    func withDocumentsDuplicated(documentIds: Set<String>, now: Date = Date()) -> Workspace {
        guard !documentIds.isEmpty else { return self }
        var lastCopiedId: String?
        var nextDocuments: [OutlineDocument] = []
        for document in documents {
            nextDocuments.append(document)
            if documentIds.contains(document.id) {
                let copy = document.duplicated(now: now)
                nextDocuments.append(copy)
                lastCopiedId = copy.id
            }
        }
        var next = self
        next.documents = nextDocuments
        next.activeDocumentId = lastCopiedId ?? activeDocumentId
        return next
    }

    func withDocumentDeleted(documentId: String, now: Date = Date()) -> Workspace {
        withDocumentsDeleted(documentIds: [documentId], now: now)
    }

    func withDocumentsDeleted(documentIds: Set<String>, now: Date = Date()) -> Workspace {
        guard !documentIds.isEmpty else { return self }
        let remaining = documents.filter { !documentIds.contains($0.id) }
        if !remaining.isEmpty {
            var next = self
            next.documents = remaining
            if documentIds.contains(activeDocumentId) {
                next.activeDocumentId = remaining[0].id
            }
            return next
        }

        let timestamp = ISO8601DateFormatter.bike.string(from: now)
        let document = OutlineDocument(
            id: newBikeId("doc"),
            title: "未命名文档",
            createdAt: timestamp,
            updatedAt: timestamp,
            nodes: [outlineNode("新主题")]
        )
        return Workspace(activeDocumentId: document.id, documents: [document])
    }

    func withInboxEntry(_ content: String, now: Date = Date()) -> Workspace {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return self }

        let timestamp = ISO8601DateFormatter.bike.string(from: now)
        let lines = trimmed
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let title = String((lines.first ?? "分享内容").prefix(120))
        let note = lines.dropFirst().joined(separator: "\n")
        let node = outlineNode(title, note: note)

        if let inboxIndex = documents.firstIndex(where: { $0.title == inboxDocumentTitle }) {
            var next = self
            next.activeDocumentId = next.documents[inboxIndex].id
            next.documents[inboxIndex].updatedAt = timestamp
            next.documents[inboxIndex].nodes.insert(node, at: 0)
            return next
        }

        let document = OutlineDocument(
            id: newBikeId("doc"),
            title: inboxDocumentTitle,
            createdAt: timestamp,
            updatedAt: timestamp,
            nodes: [node]
        )
        var next = self
        next.activeDocumentId = document.id
        next.documents.insert(document, at: 0)
        return next
    }

    func withNodeText(documentId: String, nodeId: String, text: String, now: Date = Date()) -> Workspace {
        updateDocument(documentId, now: now) { document in
            document.nodes = document.nodes.updateNode(nodeId) { node in
                node.text = text
            }
        }
    }

    func withNodeTextAndNote(documentId: String, nodeId: String, text: String, note: String, now: Date = Date()) -> Workspace {
        updateDocument(documentId, now: now) { document in
            document.nodes = document.nodes.updateNode(nodeId) { node in
                node.text = text
                node.note = note
            }
        }
    }

    func withNodeChecked(documentId: String, nodeId: String, checked: Bool, now: Date = Date()) -> Workspace {
        updateDocument(documentId, now: now) { document in
            document.nodes = document.nodes.updateNode(nodeId) { node in
                node.checked = checked
            }
        }
    }

    func withNodeCollapsed(documentId: String, nodeId: String, collapsed: Bool, now: Date = Date()) -> Workspace {
        updateDocument(documentId, now: now) { document in
            document.nodes = document.nodes.updateNode(nodeId) { node in
                node.collapsed = collapsed
            }
        }
    }

    func withSiblingAfter(documentId: String, nodeId: String, newNode: OutlineNode, now: Date = Date()) -> Workspace {
        updateDocument(documentId, now: now) { document in
            document.nodes = document.nodes.insertSiblingAfter(nodeId, newNode: newNode)
        }
    }

    func withChildNode(documentId: String, nodeId: String, childNode: OutlineNode, now: Date = Date()) -> Workspace {
        updateDocument(documentId, now: now) { document in
            document.nodes = document.nodes.addChild(nodeId, childNode: childNode)
        }
    }

    func withGeneratedOutlineChildren(documentId: String, nodeId: String, children: [OutlineNode], now: Date = Date()) -> Workspace {
        let validChildren = children.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        guard !validChildren.isEmpty else { return self }
        return updateDocument(documentId, now: now) { document in
            document.nodes = document.nodes.updateNode(nodeId) { node in
                node.collapsed = false
                node.children.append(contentsOf: validChildren)
            }
        }
    }

    func withNodeMovedToParentLevel(documentId: String, nodeId: String, now: Date = Date()) -> Workspace {
        updateDocument(documentId, now: now) { document in
            document.nodes = document.nodes.outdentNode(nodeId)
        }
    }

    func withRootNode(documentId: String, newNode: OutlineNode, now: Date = Date()) -> Workspace {
        updateDocument(documentId, now: now) { document in
            document.nodes.append(newNode)
        }
    }

    func withNodeDeleted(documentId: String, nodeId: String, now: Date = Date()) -> Workspace {
        updateDocument(documentId, now: now) { document in
            let nextNodes = document.nodes.deleteNode(nodeId)
            document.nodes = nextNodes.isEmpty ? [outlineNode("新主题")] : nextNodes
        }
    }

    func withNewDocument(title: String = "未命名文档", now: Date = Date()) -> Workspace {
        let timestamp = ISO8601DateFormatter.bike.string(from: now)
        let document = OutlineDocument(
            id: newBikeId("doc"),
            title: title,
            createdAt: timestamp,
            updatedAt: timestamp,
            nodes: [outlineNode("新主题")]
        )
        var next = self
        next.activeDocumentId = document.id
        next.documents.insert(document, at: 0)
        return next
    }

    private func updateDocument(_ documentId: String, now: Date, update: (inout OutlineDocument) -> Void) -> Workspace {
        var next = self
        guard let index = next.documents.firstIndex(where: { $0.id == documentId }) else {
            return self
        }
        update(&next.documents[index])
        next.documents[index].updatedAt = ISO8601DateFormatter.bike.string(from: now)
        return next
    }
}

public extension OutlineDocument {
    func duplicated(now: Date = Date()) -> OutlineDocument {
        let timestamp = ISO8601DateFormatter.bike.string(from: now)
        return OutlineDocument(
            id: newBikeId("doc"),
            title: title.isEmpty ? "副本" : String("\(title) 副本".prefix(120)),
            createdAt: timestamp,
            updatedAt: timestamp,
            markdownSource: markdownSource,
            markdownUpdatedAt: markdownUpdatedAt,
            isShortcut: isShortcut,
            nodes: nodes.map { $0.duplicated() }
        )
    }
}

public extension OutlineNode {
    func duplicated() -> OutlineNode {
        var next = self
        next.id = newBikeId("node")
        next.children = children.map { $0.duplicated() }
        return next
    }
}

public extension Array where Element == OutlineNode {
    func findNode(_ nodeId: String) -> OutlineNode? {
        for node in self {
            if node.id == nodeId {
                return node
            }
            if let child = node.children.findNode(nodeId) {
                return child
            }
        }
        return nil
    }

    func updateNode(_ nodeId: String, update: (inout OutlineNode) -> Void) -> [OutlineNode] {
        map { node in
            var next = node
            if next.id == nodeId {
                update(&next)
            } else {
                next.children = next.children.updateNode(nodeId, update: update)
            }
            return next
        }
    }

    func insertSiblingAfter(_ nodeId: String, newNode: OutlineNode) -> [OutlineNode] {
        if let index = firstIndex(where: { $0.id == nodeId }) {
            var next = self
            next.insert(newNode, at: index + 1)
            return next
        }
        return map { node in
            var next = node
            next.children = next.children.insertSiblingAfter(nodeId, newNode: newNode)
            return next
        }
    }

    func addChild(_ nodeId: String, childNode: OutlineNode) -> [OutlineNode] {
        updateNode(nodeId) { node in
            node.collapsed = false
            node.children.append(childNode)
        }
    }

    func deleteNode(_ nodeId: String) -> [OutlineNode] {
        compactMap { node in
            if node.id == nodeId { return nil }
            var next = node
            next.children = next.children.deleteNode(nodeId)
            return next
        }
    }

    func outdentNode(_ nodeId: String) -> [OutlineNode] {
        for index in indices {
            if let childIndex = self[index].children.firstIndex(where: { $0.id == nodeId }) {
                var next = self
                let target = next[index].children.remove(at: childIndex)
                next.insert(target, at: index + 1)
                return next
            }
        }
        return map { node in
            var next = node
            next.children = next.children.outdentNode(nodeId)
            return next
        }
    }

    func flattenVisible(depth: Int = 0) -> [FlatNodeRow] {
        flatMap { node -> [FlatNodeRow] in
            let current = [FlatNodeRow(node: node, depth: depth)]
            return node.collapsed ? current : current + node.children.flattenVisible(depth: depth + 1)
        }
    }

    func flattenSearch(_ query: String, depth: Int = 0) -> [FlatNodeRow] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return flattenVisible(depth: depth) }
        return flatMap { node -> [FlatNodeRow] in
            let current = node.matches(trimmed) ? [FlatNodeRow(node: node, depth: depth)] : []
            return current + node.children.flattenSearch(trimmed, depth: depth + 1)
        }
    }
}

public extension OutlineNode {
    func matches(_ query: String) -> Bool {
        text.localizedCaseInsensitiveContains(query) || note.localizedCaseInsensitiveContains(query)
    }
}
