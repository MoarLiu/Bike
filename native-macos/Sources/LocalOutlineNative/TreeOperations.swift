import Foundation

enum TreeOperations {
    static func clone(_ nodes: [OutlineNode]) -> [OutlineNode] {
        nodes
    }

    static func count(_ nodes: [OutlineNode]) -> Int {
        nodes.reduce(0) { total, node in
            total + 1 + count(node.children)
        }
    }

    static func firstNodeId(_ nodes: [OutlineNode]) -> String? {
        flatten(nodes).first?.node.id
    }

    static func findNode(in nodes: [OutlineNode], id: String) -> OutlineNode? {
        for node in nodes {
            if node.id == id { return node }
            if let child = findNode(in: node.children, id: id) {
                return child
            }
        }
        return nil
    }

    static func locate(
        in nodes: [OutlineNode],
        id: String,
        path: [Int] = []
    ) -> [Int]? {
        for index in nodes.indices {
            let nextPath = path + [index]
            if nodes[index].id == id { return nextPath }
            if let childPath = locate(in: nodes[index].children, id: id, path: nextPath) {
                return childPath
            }
        }
        return nil
    }

    static func flatten(
        _ nodes: [OutlineNode],
        respectCollapsed: Bool = false,
        parentId: String? = nil,
        depth: Int = 0,
        path: [Int] = []
    ) -> [FlatNode] {
        var rows: [FlatNode] = []
        for index in nodes.indices {
            let node = nodes[index]
            let nextPath = path + [index]
            rows.append(
                FlatNode(
                    node: node,
                    depth: depth,
                    parentId: parentId,
                    path: nextPath
                )
            )
            if !respectCollapsed || !node.collapsed {
                rows.append(
                    contentsOf: flatten(
                        node.children,
                        respectCollapsed: respectCollapsed,
                        parentId: node.id,
                        depth: depth + 1,
                        path: nextPath
                    )
                )
            }
        }
        return rows
    }

    static func updateNode(
        in nodes: inout [OutlineNode],
        id: String,
        update: (inout OutlineNode) -> Void
    ) -> Bool {
        for index in nodes.indices {
            if nodes[index].id == id {
                update(&nodes[index])
                return true
            }
            if updateNode(in: &nodes[index].children, id: id, update: update) {
                return true
            }
        }
        return false
    }

    static func insertSiblingAfter(
        in nodes: inout [OutlineNode],
        targetId: String,
        node: OutlineNode
    ) {
        guard let path = locate(in: nodes, id: targetId), let index = path.last else {
            nodes.append(node)
            return
        }
        mutateSiblings(in: &nodes, parentPath: Array(path.dropLast())) { siblings in
            siblings.insert(node, at: min(index + 1, siblings.count))
        }
    }

    static func addChild(
        in nodes: inout [OutlineNode],
        targetId: String,
        child: OutlineNode
    ) {
        _ = updateNode(in: &nodes, id: targetId) { node in
            node.children.append(child)
            node.collapsed = false
        }
    }

    static func removeNode(in nodes: inout [OutlineNode], targetId: String) {
        guard let path = locate(in: nodes, id: targetId), let index = path.last else {
            return
        }
        mutateSiblings(in: &nodes, parentPath: Array(path.dropLast())) { siblings in
            if siblings.indices.contains(index) {
                siblings.remove(at: index)
            }
        }
        if nodes.isEmpty {
            nodes = [makeNode("新主题")]
        }
    }

    static func indentNode(in nodes: inout [OutlineNode], targetId: String) {
        guard let path = locate(in: nodes, id: targetId), let index = path.last, index > 0 else {
            return
        }
        mutateSiblings(in: &nodes, parentPath: Array(path.dropLast())) { siblings in
            let node = siblings.remove(at: index)
            siblings[index - 1].children.append(node)
            siblings[index - 1].collapsed = false
        }
    }

    static func outdentNode(in nodes: inout [OutlineNode], targetId: String) {
        guard
            let path = locate(in: nodes, id: targetId),
            path.count >= 2,
            let childIndex = path.last
        else {
            return
        }

        let parentPath = Array(path.dropLast())
        let grandParentPath = Array(parentPath.dropLast())
        guard let parentIndex = parentPath.last else { return }

        var liftedNode: OutlineNode?
        mutateSiblings(in: &nodes, parentPath: parentPath) { siblings in
            if siblings.indices.contains(childIndex) {
                liftedNode = siblings.remove(at: childIndex)
            }
        }

        guard let liftedNode else { return }
        mutateSiblings(in: &nodes, parentPath: grandParentPath) { siblings in
            siblings.insert(liftedNode, at: min(parentIndex + 1, siblings.count))
        }
    }

    static func moveNode(in nodes: inout [OutlineNode], targetId: String, direction: Int) {
        guard
            let path = locate(in: nodes, id: targetId),
            let index = path.last
        else {
            return
        }
        mutateSiblings(in: &nodes, parentPath: Array(path.dropLast())) { siblings in
            let targetIndex = index + direction
            guard siblings.indices.contains(index), siblings.indices.contains(targetIndex) else {
                return
            }
            let node = siblings.remove(at: index)
            siblings.insert(node, at: targetIndex)
        }
    }

    private static func mutateSiblings(
        in nodes: inout [OutlineNode],
        parentPath: [Int],
        body: (inout [OutlineNode]) -> Void
    ) {
        guard let first = parentPath.first else {
            body(&nodes)
            return
        }
        let rest = Array(parentPath.dropFirst())
        guard nodes.indices.contains(first) else { return }
        mutateSiblings(in: &nodes[first].children, parentPath: rest, body: body)
    }
}
