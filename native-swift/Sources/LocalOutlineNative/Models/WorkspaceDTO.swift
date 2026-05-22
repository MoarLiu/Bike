import Foundation

enum ViewMode: String, Codable, CaseIterable, Identifiable {
    case outline
    case mindmap
    case presentation
    case markdown

    var id: String { rawValue }
    var title: String {
        switch self {
        case .outline: "大纲"
        case .mindmap: "脑图"
        case .presentation: "演示"
        case .markdown: "Markdown"
        }
    }

    var systemImage: String {
        switch self {
        case .outline: "list.bullet.indent"
        case .mindmap: "brain.head.profile"
        case .presentation: "rectangle.on.rectangle"
        case .markdown: "doc.plaintext"
        }
    }
}

enum MarkdownPaneMode: String, Codable, CaseIterable, Identifiable {
    case edit
    case preview
    case split

    var id: String { rawValue }
    var title: String {
        switch self {
        case .edit: "编辑"
        case .preview: "预览"
        case .split: "分栏"
        }
    }
}

enum OutlineColor: String, Codable, CaseIterable, Identifiable {
    case plain
    case blue
    case green
    case amber
    case rose

    var id: String { rawValue }
    var title: String {
        switch self {
        case .plain: "默认"
        case .blue: "蓝"
        case .green: "绿"
        case .amber: "黄"
        case .rose: "红"
        }
    }

    static func normalize(_ value: String?) -> String {
        guard let value, Self(rawValue: value) != nil else { return Self.plain.rawValue }
        return value
    }
}

struct WorkspaceV1DTO: Codable, Equatable {
    var version: Int
    var activeDocumentId: String
    var documents: [OutlineDocumentDTO]

    init(version: Int = 1, activeDocumentId: String, documents: [OutlineDocumentDTO]) {
        self.version = version
        self.activeDocumentId = activeDocumentId
        self.documents = documents
    }
}

struct OutlineDocumentDTO: Codable, Equatable, Identifiable {
    var id: String
    var title: String
    var createdAt: String
    var updatedAt: String
    var markdownSource: String?
    var markdownUpdatedAt: String?
    var nodes: [OutlineNodeDTO]

    init(
        id: String = UUID().uuidString,
        title: String = Defaults.documentTitle,
        createdAt: String = Date.isoNow,
        updatedAt: String = Date.isoNow,
        markdownSource: String? = nil,
        markdownUpdatedAt: String? = nil,
        nodes: [OutlineNodeDTO] = [OutlineNodeDTO(text: Defaults.nodeText)]
    ) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.markdownSource = markdownSource
        self.markdownUpdatedAt = markdownUpdatedAt
        self.nodes = nodes
    }
}

struct OutlineNodeDTO: Codable, Equatable, Identifiable, Hashable {
    var id: String
    var text: String
    var note: String
    var checked: Bool
    var collapsed: Bool
    var color: String
    var headingLevel: Int?
    var bold: Bool?
    var italic: Bool?
    var underline: Bool?
    var strike: Bool?
    var highlight: Bool?
    var icon: String?
    var imageName: String?
    var imageAlt: String?
    var table: [[String]]?
    var isTodo: Bool?
    var children: [OutlineNodeDTO]

    init(
        id: String = "node_\(UUID().uuidString)",
        text: String = "",
        note: String = "",
        checked: Bool = false,
        collapsed: Bool = false,
        color: String = OutlineColor.plain.rawValue,
        headingLevel: Int? = 0,
        bold: Bool? = nil,
        italic: Bool? = nil,
        underline: Bool? = nil,
        strike: Bool? = nil,
        highlight: Bool? = nil,
        icon: String? = nil,
        imageName: String? = nil,
        imageAlt: String? = nil,
        table: [[String]]? = nil,
        isTodo: Bool? = nil,
        children: [OutlineNodeDTO] = []
    ) {
        self.id = id
        self.text = text
        self.note = note
        self.checked = checked
        self.collapsed = collapsed
        self.color = OutlineColor.normalize(color)
        self.headingLevel = headingLevel
        self.bold = bold
        self.italic = italic
        self.underline = underline
        self.strike = strike
        self.highlight = highlight
        self.icon = icon
        self.imageName = imageName
        self.imageAlt = imageAlt
        self.table = table
        self.isTodo = isTodo
        self.children = children
    }

    enum CodingKeys: String, CodingKey {
        case id, text, note, checked, collapsed, color, headingLevel
        case bold, italic, underline, strike, highlight, icon, imageName, imageAlt, table, isTodo, children
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? "node_\(UUID().uuidString)"
        text = try container.decodeIfPresent(String.self, forKey: .text) ?? Defaults.nodeText
        note = try container.decodeIfPresent(String.self, forKey: .note) ?? ""
        checked = try container.decodeIfPresent(Bool.self, forKey: .checked) ?? false
        collapsed = try container.decodeIfPresent(Bool.self, forKey: .collapsed) ?? false
        color = OutlineColor.normalize(try container.decodeIfPresent(String.self, forKey: .color))
        let rawHeading = try container.decodeIfPresent(Int.self, forKey: .headingLevel) ?? 0
        headingLevel = [0, 1, 2, 3].contains(rawHeading) ? rawHeading : 0
        bold = try container.decodeIfPresent(Bool.self, forKey: .bold)
        italic = try container.decodeIfPresent(Bool.self, forKey: .italic)
        underline = try container.decodeIfPresent(Bool.self, forKey: .underline)
        strike = try container.decodeIfPresent(Bool.self, forKey: .strike)
        highlight = try container.decodeIfPresent(Bool.self, forKey: .highlight)
        icon = try container.decodeIfPresent(String.self, forKey: .icon)
        imageName = try container.decodeIfPresent(String.self, forKey: .imageName)
        imageAlt = try container.decodeIfPresent(String.self, forKey: .imageAlt)
        table = try container.decodeIfPresent([[String]].self, forKey: .table)
        isTodo = try container.decodeIfPresent(Bool.self, forKey: .isTodo)
        children = try container.decodeIfPresent([OutlineNodeDTO].self, forKey: .children) ?? []
    }
}

struct FlatNode: Identifiable, Equatable {
    var id: String { node.id }
    var node: OutlineNodeDTO
    var depth: Int
    var parentId: String?
    var path: [Int]
}

enum Defaults {
    static let documentTitle = "未命名文档"
    static let nodeText = "未命名主题"
}

extension Date {
    static var isoNow: String {
        ISO8601DateFormatter.localOutline.string(from: Date())
    }
}

extension ISO8601DateFormatter {
    static var localOutline: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }
}
