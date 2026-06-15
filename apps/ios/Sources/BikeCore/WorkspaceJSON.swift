import Foundation

public struct WorkspacePayload: Equatable, Sendable {
    public var workspace: Workspace
    public var raw: [String: JSONValue]
    public var recovery: WorkspaceRecovery?

    public init(workspace: Workspace, raw: [String: JSONValue], recovery: WorkspaceRecovery? = nil) {
        self.workspace = workspace
        self.raw = raw
        self.recovery = recovery
    }
}

public struct WorkspaceRecovery: Equatable, Sendable {
    public var backupFileName: String

    public init(backupFileName: String) {
        self.backupFileName = backupFileName
    }
}

public enum WorkspaceJSON {
    public static let decoder: JSONDecoder = JSONDecoder()

    public static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }()

    public static func decode(_ source: String) throws -> WorkspacePayload {
        guard let data = source.data(using: .utf8) else {
            throw WorkspaceError.invalidWorkspace
        }
        let rawValue = try decoder.decode(JSONValue.self, from: data)
        guard let raw = rawValue.objectValue else {
            throw WorkspaceError.invalidWorkspace
        }
        let workspace = try normalize(decoder.decode(Workspace.self, from: data))
        return WorkspacePayload(workspace: workspace, raw: raw)
    }

    public static func encode(_ workspace: Workspace) throws -> String {
        let data = try encoder.encode(workspace)
        return String(decoding: data, as: UTF8.self)
    }

    public static func encode(_ payload: WorkspacePayload) throws -> String {
        let encodedData = try encoder.encode(payload.workspace)
        let encodedValue = try decoder.decode(JSONValue.self, from: encodedData)
        guard let encoded = encodedValue.objectValue else {
            throw WorkspaceError.invalidWorkspace
        }
        let merged = mergeWorkspace(raw: payload.raw, encoded: encoded)
        let data = try encoder.encode(JSONValue.object(merged))
        return String(decoding: data, as: UTF8.self)
    }

    public static func payload(for workspace: Workspace) throws -> WorkspacePayload {
        let data = try encoder.encode(workspace)
        let raw = try decoder.decode(JSONValue.self, from: data).objectValue ?? [:]
        return WorkspacePayload(workspace: workspace, raw: raw)
    }

    private static func normalize(_ workspace: Workspace) throws -> Workspace {
        guard !workspace.documents.isEmpty else {
            throw WorkspaceError.invalidWorkspace
        }
        if workspace.documents.contains(where: { $0.id == workspace.activeDocumentId }) {
            return workspace
        }
        var next = workspace
        next.activeDocumentId = workspace.documents[0].id
        return next
    }

    private static func mergeWorkspace(
        raw: [String: JSONValue],
        encoded: [String: JSONValue]
    ) -> [String: JSONValue] {
        var result = raw
        result["version"] = encoded["version"]
        result["activeDocumentId"] = encoded["activeDocumentId"]
        result["documents"] = mergeDocuments(
            raw: raw["documents"]?.arrayValue,
            encoded: encoded["documents"]?.arrayValue ?? []
        )
        return result
    }

    private static func mergeDocuments(raw: [JSONValue]?, encoded: [JSONValue]) -> JSONValue {
        let rawById = Dictionary(
            uniqueKeysWithValues: raw?
                .compactMap { value -> (String, [String: JSONValue])? in
                    guard let object = value.objectValue, let id = object["id"]?.stringValue else { return nil }
                    return (id, object)
                } ?? []
        )
        return .array(encoded.map { value in
            guard let encodedDocument = value.objectValue else { return value }
            let id = encodedDocument["id"]?.stringValue
            return .object(mergeDocument(raw: id.flatMap { rawById[$0] }, encoded: encodedDocument))
        })
    }

    private static func mergeDocument(
        raw: [String: JSONValue]?,
        encoded: [String: JSONValue]
    ) -> [String: JSONValue] {
        var result = raw ?? [:]
        putKnown(encoded: encoded, into: &result, keys: documentKeys)
        result["nodes"] = mergeNodes(
            raw: raw?["nodes"]?.arrayValue,
            encoded: encoded["nodes"]?.arrayValue ?? []
        )
        return result
    }

    private static func mergeNodes(raw: [JSONValue]?, encoded: [JSONValue]) -> JSONValue {
        let rawById = Dictionary(
            uniqueKeysWithValues: raw?
                .compactMap { value -> (String, [String: JSONValue])? in
                    guard let object = value.objectValue, let id = object["id"]?.stringValue else { return nil }
                    return (id, object)
                } ?? []
        )
        return .array(encoded.map { value in
            guard let encodedNode = value.objectValue else { return value }
            let id = encodedNode["id"]?.stringValue
            return .object(mergeNode(raw: id.flatMap { rawById[$0] }, encoded: encodedNode))
        })
    }

    private static func mergeNode(
        raw: [String: JSONValue]?,
        encoded: [String: JSONValue]
    ) -> [String: JSONValue] {
        var result = raw ?? [:]
        putKnown(encoded: encoded, into: &result, keys: nodeKeys)
        result["children"] = mergeNodes(
            raw: raw?["children"]?.arrayValue,
            encoded: encoded["children"]?.arrayValue ?? []
        )
        return result
    }

    private static func putKnown(
        encoded: [String: JSONValue],
        into result: inout [String: JSONValue],
        keys: Set<String>
    ) {
        for key in keys {
            if let value = encoded[key] {
                result[key] = value
            } else {
                result.removeValue(forKey: key)
            }
        }
    }

    private static let documentKeys: Set<String> = [
        "id",
        "title",
        "createdAt",
        "updatedAt",
        "markdownSource",
        "markdownUpdatedAt",
        "isShortcut"
    ]

    private static let nodeKeys: Set<String> = [
        "id",
        "text",
        "note",
        "checked",
        "collapsed",
        "color",
        "headingLevel",
        "bold",
        "italic",
        "underline",
        "strike",
        "highlight",
        "icon",
        "imageName",
        "imageAlt",
        "table",
        "codeBlock",
        "codeLanguage",
        "isTodo"
    ]
}
