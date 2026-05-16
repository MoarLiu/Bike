import AppKit
import Foundation
import SwiftUI

@MainActor
final class WorkspaceStore: ObservableObject {
    @Published private(set) var workspace: Workspace
    @Published var activeNodeId: String?
    @Published var notice: String = "本地自动保存已开启"

    private var saveTask: Task<Void, Never>?
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init() {
        encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        decoder = JSONDecoder()

        if let loaded = Self.loadFromDisk(decoder: decoder) {
            workspace = loaded
        } else {
            workspace = starterWorkspace()
        }

        activeNodeId = TreeOperations.firstNodeId(activeDocument?.nodes ?? [])
    }

    var activeDocument: OutlineDocument? {
        workspace.documents.first { $0.id == workspace.activeDocumentId } ?? workspace.documents.first
    }

    var activeNode: OutlineNode? {
        guard let activeNodeId, let document = activeDocument else { return nil }
        return TreeOperations.findNode(in: document.nodes, id: activeNodeId)
    }

    var visibleRows: [FlatNode] {
        TreeOperations.flatten(activeDocument?.nodes ?? [], respectCollapsed: true)
    }

    func selectDocument(_ id: String) {
        mutateWorkspace(schedule: false) { workspace in
            workspace.activeDocumentId = id
        }
        activeNodeId = TreeOperations.firstNodeId(activeDocument?.nodes ?? [])
    }

    func createDocument() {
        let document = OutlineDocument(
            id: "doc_\(UUID().uuidString.lowercased())",
            title: "未命名文档",
            createdAt: nowISO(),
            updatedAt: nowISO(),
            nodes: [makeNode("新主题")]
        )
        mutateWorkspace { workspace in
            workspace.activeDocumentId = document.id
            workspace.documents.insert(document, at: 0)
        }
        activeNodeId = document.nodes.first?.id
    }

    func deleteActiveDocument() {
        guard workspace.documents.count > 1 else {
            notice = "至少保留一个文档"
            return
        }
        let deletingId = workspace.activeDocumentId
        mutateWorkspace { workspace in
            workspace.documents.removeAll { $0.id == deletingId }
            workspace.activeDocumentId = workspace.documents.first?.id ?? ""
        }
        activeNodeId = TreeOperations.firstNodeId(activeDocument?.nodes ?? [])
    }

    func updateActiveDocumentTitle(_ title: String) {
        withActiveDocument { document in
            document.title = title.isEmpty ? "未命名文档" : title
        }
    }

    func selectNode(_ id: String) {
        activeNodeId = id
    }

    func updateNodeText(_ id: String, text: String) {
        updateNode(id) { node in
            node.text = text
        }
    }

    func updateNodeNote(_ id: String, note: String) {
        updateNode(id) { node in
            node.note = note
        }
    }

    func updateNodeColor(_ id: String, color: String) {
        updateNode(id) { node in
            node.color = nodePalette(color).rawValue
        }
    }

    func toggleChecked(_ id: String) {
        updateNode(id) { node in
            node.checked.toggle()
        }
    }

    func toggleCollapsed(_ id: String) {
        updateNode(id) { node in
            node.collapsed.toggle()
        }
    }

    func insertAfter(_ id: String) {
        let node = makeNode("")
        withActiveDocument { document in
            TreeOperations.insertSiblingAfter(in: &document.nodes, targetId: id, node: node)
        }
        activeNodeId = node.id
    }

    func insertChild(_ id: String) {
        let child = makeNode("")
        withActiveDocument { document in
            TreeOperations.addChild(in: &document.nodes, targetId: id, child: child)
        }
        activeNodeId = child.id
    }

    func removeNode(_ id: String) {
        withActiveDocument { document in
            TreeOperations.removeNode(in: &document.nodes, targetId: id)
        }
        activeNodeId = TreeOperations.firstNodeId(activeDocument?.nodes ?? [])
    }

    func indentNode(_ id: String) {
        withActiveDocument { document in
            TreeOperations.indentNode(in: &document.nodes, targetId: id)
        }
        activeNodeId = id
    }

    func outdentNode(_ id: String) {
        withActiveDocument { document in
            TreeOperations.outdentNode(in: &document.nodes, targetId: id)
        }
        activeNodeId = id
    }

    func moveNode(_ id: String, direction: Int) {
        withActiveDocument { document in
            TreeOperations.moveNode(in: &document.nodes, targetId: id, direction: direction)
        }
        activeNodeId = id
    }

    func selectAdjacentNode(from id: String, direction: Int) {
        let rows = visibleRows
        guard let index = rows.firstIndex(where: { $0.node.id == id }) else { return }
        let nextIndex = index + direction
        guard rows.indices.contains(nextIndex) else { return }
        activeNodeId = rows[nextIndex].node.id
    }

    func exportWorkspaceJSON() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "localoutline-workspace.json"
        panel.allowedContentTypes = [.json]
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }

        do {
            let data = try encoder.encode(workspace)
            try data.write(to: url, options: .atomic)
            notice = "已导出工作区：\(url.lastPathComponent)"
        } catch {
            notice = "导出失败：\(error.localizedDescription)"
        }
    }

    func importWorkspaceJSON() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }

        do {
            let data = try Data(contentsOf: url)
            let imported = try decoder.decode(Workspace.self, from: data)
            workspace = imported
            activeNodeId = TreeOperations.firstNodeId(activeDocument?.nodes ?? [])
            scheduleSave()
            notice = "已导入工作区：\(url.lastPathComponent)"
        } catch {
            notice = "导入失败：\(error.localizedDescription)"
        }
    }

    func backupToICloudDrive() {
        do {
            let directory = Self.iCloudBackupDirectory()
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = try encoder.encode(workspace)
            let latest = directory.appendingPathComponent("localoutline-workspace.json")
            let stamped = directory.appendingPathComponent("localoutline-workspace-\(safeTimestamp()).json")
            try data.write(to: latest, options: .atomic)
            try data.write(to: stamped, options: .atomic)
            notice = "iCloud 备份已保存：\(latest.path)"
        } catch {
            notice = "iCloud 备份失败：\(error.localizedDescription)"
        }
    }

    func loadICloudBackup() {
        do {
            let url = Self.iCloudBackupDirectory().appendingPathComponent("localoutline-workspace.json")
            let data = try Data(contentsOf: url)
            workspace = try decoder.decode(Workspace.self, from: data)
            activeNodeId = TreeOperations.firstNodeId(activeDocument?.nodes ?? [])
            scheduleSave()
            notice = "已载入 iCloud 备份"
        } catch {
            notice = "载入 iCloud 备份失败：\(error.localizedDescription)"
        }
    }

    private func updateNode(_ id: String, update: (inout OutlineNode) -> Void) {
        withActiveDocument { document in
            _ = TreeOperations.updateNode(in: &document.nodes, id: id, update: update)
        }
    }

    private func withActiveDocument(_ update: (inout OutlineDocument) -> Void) {
        mutateWorkspace { workspace in
            guard let index = workspace.documents.firstIndex(where: { $0.id == workspace.activeDocumentId }) else {
                return
            }
            update(&workspace.documents[index])
            workspace.documents[index].updatedAt = nowISO()
        }
    }

    private func mutateWorkspace(schedule: Bool = true, _ update: (inout Workspace) -> Void) {
        objectWillChange.send()
        update(&workspace)
        if schedule {
            scheduleSave()
        }
    }

    private func scheduleSave() {
        saveTask?.cancel()
        let snapshot = workspace
        saveTask = Task { [encoder] in
            try? await Task.sleep(for: .milliseconds(250))
            do {
                try Self.write(snapshot, encoder: encoder)
                await MainActor.run {
                    self.notice = "本地自动保存于 \(Date().formatted(date: .omitted, time: .shortened))"
                }
            } catch {
                await MainActor.run {
                    self.notice = "自动保存失败：\(error.localizedDescription)"
                }
            }
        }
    }

    private static func loadFromDisk(decoder: JSONDecoder) -> Workspace? {
        let url = workspaceURL()
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(Workspace.self, from: data)
    }

    private static func write(_ workspace: Workspace, encoder: JSONEncoder) throws {
        let url = workspaceURL()
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let data = try encoder.encode(workspace)
        try data.write(to: url, options: .atomic)
    }

    private static func workspaceURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base
            .appendingPathComponent("LocalOutlineNative", isDirectory: true)
            .appendingPathComponent("workspace.json")
    }

    private static func iCloudBackupDirectory() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Mobile Documents", isDirectory: true)
            .appendingPathComponent("com~apple~CloudDocs", isDirectory: true)
            .appendingPathComponent("LocalOutlineNative", isDirectory: true)
    }

    private func safeTimestamp() -> String {
        nowISO()
            .replacingOccurrences(of: ":", with: "-")
            .replacingOccurrences(of: ".", with: "-")
    }
}
