import AppKit
import CoreGraphics
import Foundation

enum ExportFormat: String, CaseIterable, Identifiable {
    case json
    case markdown
    case opml
    case freemind
    case html

    var id: String { rawValue }
    var title: String {
        switch self {
        case .json: "JSON"
        case .markdown: "Markdown"
        case .opml: "OPML"
        case .freemind: "FreeMind"
        case .html: "HTML"
        }
    }

    var fileExtension: String {
        switch self {
        case .json: "json"
        case .markdown: "md"
        case .opml: "opml"
        case .freemind: "mm"
        case .html: "html"
        }
    }
}

enum ImportExportCodec {
    static let jsonEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    static let jsonDecoder = JSONDecoder()

    static func exportWorkspace(_ workspace: WorkspaceV1DTO) throws -> Data {
        try jsonEncoder.encode(workspace)
    }

    static func exportDocument(_ document: OutlineDocumentDTO, format: ExportFormat) throws -> (filename: String, data: Data) {
        let base = TreeOperations.sanitizeFilenameBase(document.title)
        switch format {
        case .json:
            return ("\(base).json", try jsonEncoder.encode(document))
        case .markdown:
            return ("\(base).md", Data(MarkdownCodec.documentMarkdown(document).utf8))
        case .opml:
            return ("\(base).opml", Data(exportOPML(document).utf8))
        case .freemind:
            return ("\(base).mm", Data(exportFreeMind(document).utf8))
        case .html:
            return ("\(base).html", Data(exportHTML(document).utf8))
        }
    }

    static func exportPDF(_ document: OutlineDocumentDTO) -> Data {
        let pageBounds = CGRect(x: 0, y: 0, width: 595.28, height: 841.89)
        let data = NSMutableData()
        guard let consumer = CGDataConsumer(data: data as CFMutableData) else { return Data() }
        var box = pageBounds
        guard let context = CGContext(consumer: consumer, mediaBox: &box, nil) else { return Data() }
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12),
            .foregroundColor: NSColor.labelColor
        ]
        let left: CGFloat = 52
        let top: CGFloat = pageBounds.height - 58
        let bottom: CGFloat = 54
        let lineHeight: CGFloat = 16
        let maxWidth = pageBounds.width - 104
        var y = top

        func beginPage() {
            context.beginPDFPage(nil)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
            y = top
        }

        func endPage() {
            NSGraphicsContext.restoreGraphicsState()
            context.endPDFPage()
        }

        beginPage()
        for line in wrappedPrintableLines(printableText(document), attributes: attributes, maxWidth: maxWidth) {
            if y < bottom {
                endPage()
                beginPage()
            }
            (line as NSString).draw(at: CGPoint(x: left, y: y), withAttributes: attributes)
            y -= lineHeight
        }
        endPage()
        context.closePDF()
        return data as Data
    }

    static func importFile(data: Data, filename: String) throws -> ImportedContent {
        let lower = filename.lowercased()
        let text = String(data: data, encoding: .utf8) ?? ""
        if lower.hasSuffix(".json") {
            if let workspace = try? jsonDecoder.decode(WorkspaceV1DTO.self, from: data) {
                return .workspace(TreeOperations.normalizeWorkspace(workspace))
            }
            let document = try jsonDecoder.decode(OutlineDocumentDTO.self, from: data)
            var used = Set<String>()
            return .document(TreeOperations.normalizeDocument(document, usedIds: &used))
        }
        if lower.hasSuffix(".md") || lower.hasSuffix(".markdown") {
            return .document(MarkdownCodec.parseDocument(text, filename: filename))
        }
        if lower.hasSuffix(".mm") {
            return .document(try parseFreeMind(text, filename: filename))
        }
        return .document(try parseOPML(text, filename: filename))
    }

    private static func exportOPML(_ document: OutlineDocumentDTO) -> String {
        [
            #"<?xml version="1.0" encoding="UTF-8"?>"#,
            #"<opml version="2.0">"#,
            "  <head><title>\(xml(document.title))</title></head>",
            "  <body>",
            document.nodes.map { opmlNode($0, depth: 2) }.joined(separator: "\n"),
            "  </body>",
            "</opml>"
        ].joined(separator: "\n")
    }

    private static func opmlNode(_ node: OutlineNodeDTO, depth: Int) -> String {
        let pad = String(repeating: "  ", count: depth)
        let attrs = [
            #"text="\#(xml(node.text.isEmpty ? Defaults.nodeText : node.text))""#,
            #"_note="\#(xml(node.note))""#,
            #"_checked="\#(node.checked ? "true" : "false")""#,
            node.isTodo == true ? #"_isTodo="true""# : nil,
            node.collapsed ? #"_collapsed="true""# : nil,
            node.color != OutlineColor.plain.rawValue ? #"_color="\#(node.color)""# : nil,
            (node.headingLevel ?? 0) > 0 ? #"_headingLevel="\#(node.headingLevel ?? 0)""# : nil,
            node.bold == true ? #"_bold="true""# : nil,
            node.italic == true ? #"_italic="true""# : nil,
            node.underline == true ? #"_underline="true""# : nil,
            node.strike == true ? #"_strike="true""# : nil,
            node.highlight == true ? #"_highlight="true""# : nil,
            node.icon.map { #"_icon="\#(xml($0))""# },
            node.imageName.map { #"_imageName="\#(xml($0))""# },
            node.imageAlt.map { #"_imageAlt="\#(xml($0))""# },
            node.table.flatMap { try? String(data: jsonEncoder.encode($0), encoding: .utf8) }.map { #"_table="\#(xml($0))""# },
            node.codeLanguage.map { #"_codeLanguage="\#(xml($0))""# },
            node.codeBlock.map { #"_codeBlock="\#(xml($0))""# }
        ].compactMap { $0 }.joined(separator: " ")
        guard !node.children.isEmpty else { return "\(pad)<outline \(attrs)/>" }
        return ["\(pad)<outline \(attrs)>", node.children.map { opmlNode($0, depth: depth + 1) }.joined(separator: "\n"), "\(pad)</outline>"].joined(separator: "\n")
    }

    private static func exportFreeMind(_ document: OutlineDocumentDTO) -> String {
        [
            #"<?xml version="1.0" encoding="UTF-8"?>"#,
            #"<map version="1.0.1">"#,
            #"  <node TEXT="\#(xml(document.title))">"#,
            document.nodes.map { freeMindNode($0, depth: 2) }.joined(separator: "\n"),
            "  </node>",
            "</map>"
        ].joined(separator: "\n")
    }

    private static func freeMindNode(_ node: OutlineNodeDTO, depth: Int) -> String {
        let pad = String(repeating: "  ", count: depth)
        guard !node.children.isEmpty else { return #"\#(pad)<node TEXT="\#(xml(node.text.isEmpty ? Defaults.nodeText : node.text))"/>"# }
        return [#"\#(pad)<node TEXT="\#(xml(node.text.isEmpty ? Defaults.nodeText : node.text))">"#, node.children.map { freeMindNode($0, depth: depth + 1) }.joined(separator: "\n"), "\(pad)</node>"].joined(separator: "\n")
    }

    private static func exportHTML(_ document: OutlineDocumentDTO) -> String {
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"><title>\(xml(document.title))</title></head><body><h1>\(xml(document.title))</h1><ul>\(document.nodes.map(htmlNode).joined())</ul></body></html>"
    }

    private static func htmlNode(_ node: OutlineNodeDTO) -> String {
        let note = node.note.isEmpty ? "" : "<p>\(xml(node.note))</p>"
        let code = node.codeBlock.map { "<pre><code>\(xml($0))</code></pre>" } ?? ""
        let checked = node.checked ? #" data-checked="true""# : ""
        let children = node.children.isEmpty ? "" : "<ul>\(node.children.map(htmlNode).joined())</ul>"
        return "<li\(checked)><span>\(xml(node.text.isEmpty ? Defaults.nodeText : node.text))</span>\(note)\(code)\(children)</li>"
    }

    private static func printableText(_ document: OutlineDocumentDTO) -> String {
        func lines(_ node: OutlineNodeDTO, depth: Int) -> [String] {
            let indent = String(repeating: "  ", count: depth)
            let mark = node.checked ? "☑" : "•"
            let note = node.note.isEmpty ? [] : ["\(indent)  备注：\(node.note)"]
            let code = node.codeBlock.map { block in
                ["\(indent)  代码："] + block.components(separatedBy: "\n").map { "\(indent)    \($0)" }
            } ?? []
            return ["\(indent)\(mark) \(node.icon.map { "\($0) " } ?? "")\(node.text.isEmpty ? Defaults.nodeText : node.text)"] + note + code + node.children.flatMap { lines($0, depth: depth + 1) }
        }
        return ([document.title, ""] + document.nodes.flatMap { lines($0, depth: 0) }).joined(separator: "\n")
    }

    private static func wrappedPrintableLines(
        _ text: String,
        attributes: [NSAttributedString.Key: Any],
        maxWidth: CGFloat
    ) -> [String] {
        text.components(separatedBy: "\n").flatMap { line -> [String] in
            guard !line.isEmpty else { return [""] }
            var result: [String] = []
            var current = ""
            for character in line {
                let next = current + String(character)
                if !current.isEmpty, (next as NSString).size(withAttributes: attributes).width > maxWidth {
                    result.append(current)
                    current = String(character)
                } else {
                    current = next
                }
            }
            if !current.isEmpty {
                result.append(current)
            }
            return result
        }
    }

    private static func parseOPML(_ text: String, filename: String) throws -> OutlineDocumentDTO {
        let delegate = OutlineXMLDelegate(mode: .opml)
        let parser = XMLParser(data: Data(text.utf8))
        parser.delegate = delegate
        guard parser.parse() else { throw ImportError.invalidXML }
        return OutlineDocumentDTO(title: delegate.title ?? filename.replacingOccurrences(of: #"\.(opml|xml)$"#, with: "", options: [.regularExpression, .caseInsensitive]), nodes: delegate.roots.isEmpty ? [OutlineNodeDTO(text: Defaults.nodeText)] : delegate.roots)
    }

    private static func parseFreeMind(_ text: String, filename: String) throws -> OutlineDocumentDTO {
        let delegate = OutlineXMLDelegate(mode: .freeMind)
        let parser = XMLParser(data: Data(text.utf8))
        parser.delegate = delegate
        guard parser.parse() else { throw ImportError.invalidXML }
        return OutlineDocumentDTO(title: delegate.title ?? filename.replacingOccurrences(of: #"\.mm$"#, with: "", options: [.regularExpression, .caseInsensitive]), nodes: delegate.roots.isEmpty ? [OutlineNodeDTO(text: Defaults.nodeText)] : delegate.roots)
    }

    private static func xml(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\r\n", with: "&#10;")
            .replacingOccurrences(of: "\n", with: "&#10;")
            .replacingOccurrences(of: "\r", with: "&#10;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }
}

enum ImportedContent {
    case workspace(WorkspaceV1DTO)
    case document(OutlineDocumentDTO)
}

enum ImportError: Error, LocalizedError {
    case invalidXML

    var errorDescription: String? {
        switch self {
        case .invalidXML: "无法解析导入文件"
        }
    }
}

private final class OutlineXMLDelegate: NSObject, XMLParserDelegate {
    enum Mode { case opml, freeMind }
    let mode: Mode
    var roots: [OutlineNodeDTO] = []
    var title: String?
    private var stack: [OutlineNodeDTO] = []
    private var readingTitle = false
    private var titleBuffer = ""
    private var seenFreeMindRoot = false

    init(mode: Mode) {
        self.mode = mode
    }

    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes attributeDict: [String : String] = [:]) {
        let name = elementName.lowercased()
        if mode == .opml, name == "title" {
            readingTitle = true
            titleBuffer = ""
            return
        }
        if mode == .opml, name == "outline" {
            push(opmlNode(attributeDict))
        }
        if mode == .freeMind, name == "node" {
            let node = OutlineNodeDTO(text: attributeDict["TEXT"] ?? attributeDict["text"] ?? Defaults.nodeText)
            if !seenFreeMindRoot {
                title = node.text
                seenFreeMindRoot = true
                stack.append(node)
            } else {
                push(node)
            }
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        if readingTitle { titleBuffer += string }
    }

    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
        let name = elementName.lowercased()
        if mode == .opml, name == "title" {
            title = titleBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
            readingTitle = false
            return
        }
        if (mode == .opml && name == "outline") || (mode == .freeMind && name == "node") {
            guard let node = stack.popLast() else { return }
            if let parent = stack.popLast() {
                var updated = parent
                updated.children.append(node)
                stack.append(updated)
            } else if !(mode == .freeMind && title == node.text && roots.isEmpty) {
                roots.append(node)
            }
        }
    }

    private func push(_ node: OutlineNodeDTO) {
        stack.append(node)
    }

    private func opmlNode(_ attrs: [String: String]) -> OutlineNodeDTO {
        let table: [[String]]?
        if let raw = attrs["_table"], let data = raw.data(using: .utf8), let parsed = try? ImportExportCodec.jsonDecoder.decode([[String]].self, from: data) {
            table = parsed
        } else {
            table = nil
        }
        return OutlineNodeDTO(
            text: attrs["text"] ?? attrs["title"] ?? Defaults.nodeText,
            note: attrs["_note"] ?? "",
            checked: attrs["_checked"] == "true",
            collapsed: attrs["_collapsed"] == "true",
            color: OutlineColor.normalize(attrs["_color"]),
            headingLevel: Int(attrs["_headingLevel"] ?? "0") ?? 0,
            bold: attrs["_bold"] == "true",
            italic: attrs["_italic"] == "true",
            underline: attrs["_underline"] == "true",
            strike: attrs["_strike"] == "true",
            highlight: attrs["_highlight"] == "true",
            icon: attrs["_icon"],
            imageName: attrs["_imageName"],
            imageAlt: attrs["_imageAlt"],
            table: table,
            codeBlock: attrs["_codeBlock"],
            codeLanguage: attrs["_codeLanguage"],
            isTodo: attrs["_isTodo"] == "true"
        )
    }
}
