import Foundation

#if !LOCAL_OUTLINE_CLI_BUILD
import SwiftData

@Model
final class DocumentRecord {
    @Attribute(.unique) var id: String
    var title: String
    var createdAt: String
    var updatedAt: String
    var markdownSource: String?
    var markdownUpdatedAt: String?
    var deletedAt: String?
    var sortKey: Double

    init(document: OutlineDocumentDTO, sortKey: Double) {
        self.id = document.id
        self.title = document.title
        self.createdAt = document.createdAt
        self.updatedAt = document.updatedAt
        self.markdownSource = document.markdownSource
        self.markdownUpdatedAt = document.markdownUpdatedAt
        self.deletedAt = nil
        self.sortKey = sortKey
    }
}

@Model
final class NodeRecord {
    @Attribute(.unique) var id: String
    var documentId: String
    var parentId: String?
    var sortKey: Double
    var text: String
    var note: String
    var checked: Bool
    var collapsed: Bool
    var color: String
    var headingLevel: Int
    var bold: Bool
    var italic: Bool
    var underline: Bool
    var strike: Bool
    var highlight: Bool
    var icon: String?
    var imageName: String?
    var imageAlt: String?
    var tableJSON: String?
    var isTodo: Bool
    var createdAt: String
    var updatedAt: String

    init(node: OutlineNodeDTO, documentId: String, parentId: String?, sortKey: Double, now: String) {
        self.id = node.id
        self.documentId = documentId
        self.parentId = parentId
        self.sortKey = sortKey
        self.text = node.text
        self.note = node.note
        self.checked = node.checked
        self.collapsed = node.collapsed
        self.color = OutlineColor.normalize(node.color)
        self.headingLevel = node.headingLevel ?? 0
        self.bold = node.bold ?? false
        self.italic = node.italic ?? false
        self.underline = node.underline ?? false
        self.strike = node.strike ?? false
        self.highlight = node.highlight ?? false
        self.icon = node.icon
        self.imageName = node.imageName
        self.imageAlt = node.imageAlt
        if let table = node.table, let data = try? ImportExportCodec.jsonEncoder.encode(table) {
            self.tableJSON = String(data: data, encoding: .utf8)
        } else {
            self.tableJSON = nil
        }
        self.isTodo = node.isTodo ?? false
        self.createdAt = now
        self.updatedAt = now
    }

    func dto(children: [OutlineNodeDTO]) -> OutlineNodeDTO {
        let table: [[String]]?
        if let tableJSON, let data = tableJSON.data(using: .utf8), let parsed = try? ImportExportCodec.jsonDecoder.decode([[String]].self, from: data) {
            table = parsed
        } else {
            table = nil
        }
        return OutlineNodeDTO(
            id: id,
            text: text,
            note: note,
            checked: checked,
            collapsed: collapsed,
            color: color,
            headingLevel: headingLevel,
            bold: bold,
            italic: italic,
            underline: underline,
            strike: strike,
            highlight: highlight,
            icon: icon,
            imageName: imageName,
            imageAlt: imageAlt,
            table: table,
            isTodo: isTodo,
            children: children
        )
    }
}

@Model
final class AppSettingRecord {
    @Attribute(.unique) var key: String
    var value: String

    init(key: String, value: String) {
        self.key = key
        self.value = value
    }
}

@Model
final class SnapshotRecord {
    @Attribute(.unique) var id: String
    var createdAt: String
    var reason: String
    var workspaceJSON: String

    init(id: String = UUID().uuidString, createdAt: String = Date.isoNow, reason: String, workspaceJSON: String) {
        self.id = id
        self.createdAt = createdAt
        self.reason = reason
        self.workspaceJSON = workspaceJSON
    }
}
#else
struct DocumentRecord {}
struct NodeRecord {}
struct AppSettingRecord {}
struct SnapshotRecord {}
#endif
