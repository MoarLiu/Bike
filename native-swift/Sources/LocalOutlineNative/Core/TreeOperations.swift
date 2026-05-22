import Foundation

enum TreeOperations {
    static func createNode(_ text: String = "") -> OutlineNodeDTO {
        OutlineNodeDTO(text: text)
    }

    static func normalizeWorkspace(_ workspace: WorkspaceV1DTO) -> WorkspaceV1DTO {
        var used = Set<String>()
        var documents = workspace.documents.map { normalizeDocument($0, usedIds: &used) }
        if documents.isEmpty {
            let document = OutlineDocumentDTO()
            documents = [document]
        }
        let active = documents.contains { $0.id == workspace.activeDocumentId } ? workspace.activeDocumentId : documents[0].id
        return WorkspaceV1DTO(version: 1, activeDocumentId: active, documents: documents)
    }

    static func normalizeDocument(_ document: OutlineDocumentDTO, usedIds: inout Set<String>) -> OutlineDocumentDTO {
        var doc = document
        doc.id = uniqueId(doc.id, usedIds: &usedIds)
        doc.title = doc.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? Defaults.documentTitle : doc.title
        doc.nodes = doc.nodes.map { normalizeNode($0, usedIds: &usedIds) }
        if doc.nodes.isEmpty {
            doc.nodes = [normalizeNode(OutlineNodeDTO(text: Defaults.nodeText), usedIds: &usedIds)]
        }
        return doc
    }

    static func normalizeNode(_ node: OutlineNodeDTO, usedIds: inout Set<String>) -> OutlineNodeDTO {
        var next = node
        next.id = uniqueId(next.id, usedIds: &usedIds)
        next.text = next.text.isEmpty ? Defaults.nodeText : next.text
        next.color = OutlineColor.normalize(next.color)
        if let heading = next.headingLevel, ![0, 1, 2, 3].contains(heading) {
            next.headingLevel = 0
        }
        next.children = next.children.map { normalizeNode($0, usedIds: &usedIds) }
        return next
    }

    private static func uniqueId(_ value: String, usedIds: inout Set<String>) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = trimmed.isEmpty ? "node_\(UUID().uuidString)" : trimmed
        if !usedIds.contains(candidate) {
            usedIds.insert(candidate)
            return candidate
        }
        let id = "node_\(UUID().uuidString)"
        usedIds.insert(id)
        return id
    }

    static func count(_ nodes: [OutlineNodeDTO]) -> Int {
        nodes.reduce(0) { $0 + 1 + count($1.children) }
    }

    static func flatten(
        _ nodes: [OutlineNodeDTO],
        respectCollapsed: Bool = false,
        parentId: String? = nil,
        depth: Int = 0,
        path: [Int] = []
    ) -> [FlatNode] {
        var rows: [FlatNode] = []
        for (index, node) in nodes.enumerated() {
            let currentPath = path + [index]
            rows.append(FlatNode(node: node, depth: depth, parentId: parentId, path: currentPath))
            if !respectCollapsed || !node.collapsed {
                rows.append(contentsOf: flatten(
                    node.children,
                    respectCollapsed: respectCollapsed,
                    parentId: node.id,
                    depth: depth + 1,
                    path: currentPath
                ))
            }
        }
        return rows
    }

    static func firstNodeId(_ nodes: [OutlineNodeDTO]) -> String? {
        flatten(nodes).first?.node.id
    }

    static func findNode(in nodes: [OutlineNodeDTO], id: String) -> OutlineNodeDTO? {
        for node in nodes {
            if node.id == id { return node }
            if let child = findNode(in: node.children, id: id) { return child }
        }
        return nil
    }

    static func updateNode(_ nodes: [OutlineNodeDTO], id: String, transform: (inout OutlineNodeDTO) -> Void) -> [OutlineNodeDTO] {
        nodes.map { node in
            var copy = node
            if copy.id == id {
                transform(&copy)
            } else {
                copy.children = updateNode(copy.children, id: id, transform: transform)
            }
            copy.color = OutlineColor.normalize(copy.color)
            return copy
        }
    }

    static func insertSiblingAfter(_ nodes: [OutlineNodeDTO], targetId: String, newNode: OutlineNodeDTO) -> [OutlineNodeDTO] {
        if let index = nodes.firstIndex(where: { $0.id == targetId }) {
            var next = nodes
            next.insert(newNode, at: index + 1)
            return next
        }
        return nodes.map { node in
            var copy = node
            copy.children = insertSiblingAfter(copy.children, targetId: targetId, newNode: newNode)
            return copy
        }
    }

    static func addChild(_ nodes: [OutlineNodeDTO], targetId: String, child: OutlineNodeDTO) -> [OutlineNodeDTO] {
        nodes.map { node in
            var copy = node
            if copy.id == targetId {
                copy.collapsed = false
                copy.children.append(child)
            } else {
                copy.children = addChild(copy.children, targetId: targetId, child: child)
            }
            return copy
        }
    }

    static func removeNode(_ nodes: [OutlineNodeDTO], targetId: String) -> [OutlineNodeDTO] {
        var removedHere = nodes.filter { $0.id != targetId }
        if removedHere.count != nodes.count {
            return removedHere.isEmpty ? [createNode(Defaults.nodeText)] : removedHere
        }
        removedHere = nodes.map { node in
            var copy = node
            copy.children = removeNode(copy.children, targetId: targetId)
            if copy.children.count == 1, copy.children[0].text == Defaults.nodeText, !node.children.isEmpty {
                copy.children = []
            }
            return copy
        }
        return removedHere
    }

    static func indentNode(_ nodes: [OutlineNodeDTO], targetId: String) -> [OutlineNodeDTO] {
        if let index = nodes.firstIndex(where: { $0.id == targetId }) {
            guard index > 0 else { return nodes }
            var next = nodes
            let target = next.remove(at: index)
            next[index - 1].collapsed = false
            next[index - 1].children.append(target)
            return next
        }
        return nodes.map { node in
            var copy = node
            copy.children = indentNode(copy.children, targetId: targetId)
            return copy
        }
    }

    static func outdentNode(_ nodes: [OutlineNodeDTO], targetId: String) -> [OutlineNodeDTO] {
        for index in nodes.indices {
            if let childIndex = nodes[index].children.firstIndex(where: { $0.id == targetId }) {
                var next = nodes
                let target = next[index].children.remove(at: childIndex)
                next.insert(target, at: index + 1)
                return next
            }
        }
        return nodes.map { node in
            var copy = node
            copy.children = outdentNode(copy.children, targetId: targetId)
            return copy
        }
    }

    static func moveNode(_ nodes: [OutlineNodeDTO], targetId: String, direction: Int) -> [OutlineNodeDTO] {
        if let index = nodes.firstIndex(where: { $0.id == targetId }) {
            let target = index + direction
            guard nodes.indices.contains(target) else { return nodes }
            var next = nodes
            let node = next.remove(at: index)
            next.insert(node, at: target)
            return next
        }
        return nodes.map { node in
            var copy = node
            copy.children = moveNode(copy.children, targetId: targetId, direction: direction)
            return copy
        }
    }

    static func mergeNode(_ nodes: [OutlineNodeDTO], sourceId: String, targetId: String) -> [OutlineNodeDTO] {
        guard let source = findNode(in: nodes, id: sourceId) else { return nodes }
        let withoutSource = removeNode(nodes, targetId: sourceId)
        return updateNode(withoutSource, id: targetId) { node in
            node.text += source.text
            node.children.append(contentsOf: source.children)
        }
    }

    static func contains(node: OutlineNodeDTO, id: String) -> Bool {
        node.id == id || node.children.contains { contains(node: $0, id: id) }
    }

    static func extractTags(_ text: String) -> [String] {
        let pattern = #"(^|\s)#([\p{L}\p{N}_-]+)"#
        return matches(pattern: pattern, in: text).compactMap { match in
            guard match.numberOfRanges > 2 else { return nil }
            return substring(text, match.range(at: 2))
        }
    }

    static func extractLinks(_ text: String) -> [String] {
        let pattern = #"\[\[([^\]]+)\]\]"#
        return matches(pattern: pattern, in: text).compactMap { match in
            guard match.numberOfRanges > 1 else { return nil }
            return substring(text, match.range(at: 1))?.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    static func nodeText(_ node: OutlineNodeDTO) -> String {
        "\(node.text) \(node.note)".trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func sanitizeFilenameBase(_ value: String) -> String {
        let invalid = CharacterSet(charactersIn: #"<>:"/\|?*"#).union(.controlCharacters)
        let cleaned = value
            .components(separatedBy: invalid).joined(separator: "_")
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: ". ").union(.whitespacesAndNewlines))
        let base = String(cleaned.prefix(120))
        if base.isEmpty { return Defaults.documentTitle }
        if ["con", "prn", "aux", "nul"].contains(base.lowercased()) { return "_\(base)" }
        if base.lowercased().range(of: #"^(com[1-9]|lpt[1-9])$"#, options: .regularExpression) != nil { return "_\(base)" }
        return base
    }

    private static func matches(pattern: String, in text: String) -> [NSTextCheckingResult] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
    }

    private static func substring(_ text: String, _ range: NSRange) -> String? {
        guard let swiftRange = Range(range, in: text) else { return nil }
        return String(text[swiftRange])
    }
}
