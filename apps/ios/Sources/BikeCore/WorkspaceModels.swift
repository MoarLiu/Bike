import Foundation

public let currentWorkspaceVersion = 1
public let inboxDocumentTitle = "Bike iOS 收件箱"

public struct Workspace: Codable, Equatable, Sendable {
    public var version: Int
    public var activeDocumentId: String
    public var documents: [OutlineDocument]

    public init(
        version: Int = currentWorkspaceVersion,
        activeDocumentId: String,
        documents: [OutlineDocument]
    ) {
        self.version = version
        self.activeDocumentId = activeDocumentId
        self.documents = documents
    }
}

public struct OutlineDocument: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var createdAt: String
    public var updatedAt: String
    public var markdownSource: String?
    public var markdownUpdatedAt: String?
    public var isShortcut: Bool
    public var nodes: [OutlineNode]

    public init(
        id: String = newBikeId("doc"),
        title: String,
        createdAt: String = Date.bikeISO8601,
        updatedAt: String = Date.bikeISO8601,
        markdownSource: String? = nil,
        markdownUpdatedAt: String? = nil,
        isShortcut: Bool = false,
        nodes: [OutlineNode] = []
    ) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.markdownSource = markdownSource
        self.markdownUpdatedAt = markdownUpdatedAt
        self.isShortcut = isShortcut
        self.nodes = nodes
    }

    enum CodingKeys: String, CodingKey {
        case id, title, createdAt, updatedAt, markdownSource, markdownUpdatedAt, isShortcut, nodes
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
        markdownSource = try container.decodeIfPresent(String.self, forKey: .markdownSource)
        markdownUpdatedAt = try container.decodeIfPresent(String.self, forKey: .markdownUpdatedAt)
        isShortcut = try container.decodeIfPresent(Bool.self, forKey: .isShortcut) ?? false
        nodes = try container.decodeIfPresent([OutlineNode].self, forKey: .nodes) ?? []
    }
}

public struct OutlineNode: Codable, Equatable, Identifiable, Hashable, Sendable {
    public var id: String
    public var text: String
    public var note: String
    public var checked: Bool
    public var collapsed: Bool
    public var color: String
    public var headingLevel: Int?
    public var bold: Bool?
    public var italic: Bool?
    public var underline: Bool?
    public var strike: Bool?
    public var highlight: Bool?
    public var icon: String?
    public var imageName: String?
    public var imageAlt: String?
    public var table: [[String]]?
    public var codeBlock: String?
    public var codeLanguage: String?
    public var isTodo: Bool?
    public var children: [OutlineNode]

    public init(
        id: String = newBikeId("node"),
        text: String,
        note: String = "",
        checked: Bool = false,
        collapsed: Bool = false,
        color: String = "plain",
        headingLevel: Int? = nil,
        bold: Bool? = nil,
        italic: Bool? = nil,
        underline: Bool? = nil,
        strike: Bool? = nil,
        highlight: Bool? = nil,
        icon: String? = nil,
        imageName: String? = nil,
        imageAlt: String? = nil,
        table: [[String]]? = nil,
        codeBlock: String? = nil,
        codeLanguage: String? = nil,
        isTodo: Bool? = nil,
        children: [OutlineNode] = []
    ) {
        self.id = id
        self.text = text
        self.note = note
        self.checked = checked
        self.collapsed = collapsed
        self.color = color
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
        self.codeBlock = codeBlock
        self.codeLanguage = codeLanguage
        self.isTodo = isTodo
        self.children = children
    }
}

public struct FlatNodeRow: Identifiable, Equatable, Sendable {
    public var id: String { node.id }
    public var node: OutlineNode
    public var depth: Int

    public init(node: OutlineNode, depth: Int) {
        self.node = node
        self.depth = depth
    }
}

public func newBikeId(_ prefix: String) -> String {
    "\(prefix)_\(UUID().uuidString)"
}

extension Date {
    public static var bikeISO8601: String {
        ISO8601DateFormatter.bike.string(from: Date())
    }
}

extension ISO8601DateFormatter {
    static var bike: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }
}
