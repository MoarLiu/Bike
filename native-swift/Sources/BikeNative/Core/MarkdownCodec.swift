import Foundation
import SwiftUI

enum MarkdownCodec {
    static func documentMarkdown(_ document: OutlineDocumentDTO) -> String {
        if let source = document.markdownSource {
            return normalizeSource(source)
        }
        let title = escapeInline(document.title.isEmpty ? Defaults.documentTitle : document.title)
        let body = document.nodes.flatMap { nodeToMarkdown($0, depth: 0, insideList: false) }
        return (["# \(title)", ""] + body).joined(separator: "\n").trimmingCharacters(in: .newlines)
    }

    static func parseDocument(
        _ source: String,
        filename: String? = nil,
        previousDocument: OutlineDocumentDTO? = nil,
        documentId: String? = nil,
        now: String = Date.isoNow
    ) -> OutlineDocumentDTO {
        let parsed = parse(source, previousDocument: previousDocument)
        let filenameTitle = filename?.replacingOccurrences(of: #"\.(md|markdown)$"#, with: "", options: [.regularExpression, .caseInsensitive])
        let title = parsed.hasTitle ? parsed.title : (filenameTitle?.isEmpty == false ? filenameTitle! : previousDocument?.title ?? Defaults.documentTitle)
        return OutlineDocumentDTO(
            id: documentId ?? previousDocument?.id ?? UUID().uuidString,
            title: title,
            createdAt: previousDocument?.createdAt ?? now,
            updatedAt: now,
            markdownSource: normalizeSource(source),
            markdownUpdatedAt: now,
            nodes: parsed.nodes.isEmpty ? [OutlineNodeDTO(text: Defaults.nodeText)] : parsed.nodes
        )
    }

    static func previewAttributedString(_ source: String) -> AttributedString {
        var output = AttributedString()
        for line in normalizeSource(source).split(separator: "\n", omittingEmptySubsequences: false) {
            var text = String(line)
            if text.hasPrefix("# ") {
                text = text.replacingOccurrences(of: #"^#\s+"#, with: "", options: .regularExpression)
                var part = AttributedString(text + "\n")
                part.font = .largeTitle.bold()
                output.append(part)
            } else if text.hasPrefix("## ") {
                text = text.replacingOccurrences(of: #"^##\s+"#, with: "", options: .regularExpression)
                var part = AttributedString(text + "\n")
                part.font = .title.bold()
                output.append(part)
            } else if text.hasPrefix(">") {
                var part = AttributedString(text.replacingOccurrences(of: #"^>\s?"#, with: "", options: .regularExpression) + "\n")
                part.foregroundColor = .secondary
                output.append(part)
            } else {
                output.append(AttributedString(text + "\n"))
            }
        }
        return output
    }

    private struct ParsedMarkdown {
        var title: String
        var hasTitle: Bool
        var nodes: [OutlineNodeDTO]
    }

    private static func parse(_ source: String, previousDocument: OutlineDocumentDTO?) -> ParsedMarkdown {
        let lines = normalizeSource(source).components(separatedBy: "\n")
        var roots: [OutlineNodeDTO] = []
        var title = Defaults.documentTitle
        var hasTitle = false
        var headingStack: [(level: Int, path: [Int])] = []
        var listStack: [(indent: Int, path: [Int])] = []
        var lastPath: [Int]?
        let matcher = PreviousMatcher(previousDocument: previousDocument)

        func nodeAt(_ path: [Int]) -> OutlineNodeDTO? {
            guard !path.isEmpty else { return nil }
            var list = roots
            var node: OutlineNodeDTO?
            for index in path {
                guard list.indices.contains(index) else { return nil }
                node = list[index]
                list = node?.children ?? []
            }
            return node
        }

        func mutateNode(at path: [Int], _ transform: (inout OutlineNodeDTO) -> Void) {
            guard !path.isEmpty else { return }
            func mutate(_ list: inout [OutlineNodeDTO], depth: Int) {
                let index = path[depth]
                guard list.indices.contains(index) else { return }
                if depth == path.count - 1 {
                    transform(&list[index])
                } else {
                    mutate(&list[index].children, depth: depth + 1)
                }
            }
            mutate(&roots, depth: 0)
        }

        func siblings(for parentPath: [Int]?) -> [OutlineNodeDTO] {
            guard let parentPath else { return roots }
            return nodeAt(parentPath)?.children ?? []
        }

        func appendNode(_ text: String, parentPath: [Int]?, overrides: (inout OutlineNodeDTO) -> Void = { _ in }) -> [Int] {
            let index = siblings(for: parentPath).count
            let path = (parentPath ?? []) + [index]
            var node = matcher.makeNode(text: text, path: path)
            overrides(&node)
            if let parentPath {
                mutateNode(at: parentPath) { parent in
                    parent.children.append(node)
                }
            } else {
                roots.append(node)
            }
            lastPath = path
            return path
        }

        var index = 0
        while index < lines.count {
            let line = lines[index]
            if line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                index += 1
                continue
            }

            if let heading = headingMatch(line) {
                if heading.level == 1, !hasTitle {
                    title = heading.text
                    hasTitle = true
                    index += 1
                    continue
                }
                while let last = headingStack.last, last.level >= heading.level {
                    headingStack.removeLast()
                }
                listStack.removeAll()
                let parent = headingStack.last?.path
                let path = appendNode(heading.text, parentPath: parent) { node in
                    node.headingLevel = min(max(heading.level - 1, 1), 3)
                }
                headingStack.append((heading.level, path))
                index += 1
                continue
            }

            if let item = listItemMatch(line) {
                while let last = listStack.last, last.indent >= item.indent {
                    listStack.removeLast()
                }
                let parent = listStack.last?.path ?? headingStack.last?.path
                let path = appendNode(item.text, parentPath: parent) { node in
                    node.checked = item.checked
                    node.isTodo = item.isTodo
                }
                listStack.append((item.indent, path))
                index += 1
                continue
            }

            if let quote = quoteMatch(line) {
                var quotes = [quote]
                index += 1
                while index < lines.count, let next = quoteMatch(lines[index]) {
                    quotes.append(next)
                    index += 1
                }
                if let lastPath {
                    let note = quotes.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                    mutateNode(at: lastPath) { node in
                        node.note = node.note.isEmpty ? note : "\(node.note)\n\(note)"
                    }
                } else {
                    _ = appendNode("引用：\(quotes.first ?? Defaults.nodeText)", parentPath: nil) { node in
                        node.note = quotes.joined(separator: "\n")
                    }
                }
                continue
            }

            if let image = imageMatch(line) {
                if let lastPath {
                    mutateNode(at: lastPath) { node in
                        node.imageAlt = image.alt.isEmpty ? nil : image.alt
                        node.imageName = image.source
                    }
                } else {
                    _ = appendNode("图片：\(image.alt.isEmpty ? image.source : image.alt)", parentPath: nil) { node in
                        node.imageAlt = image.alt.isEmpty ? nil : image.alt
                        node.imageName = image.source
                    }
                }
                index += 1
                continue
            }

            if isTableStart(lines, index) {
                let table = parseTable(lines, start: index)
                if let lastPath {
                    mutateNode(at: lastPath) { node in
                        node.table = table.rows
                    }
                } else {
                    let title = table.rows.first?.joined(separator: " / ") ?? "表格"
                    _ = appendNode("表格：\(title)", parentPath: nil) { node in
                        node.table = table.rows
                        node.note = table.lines.joined(separator: "\n")
                    }
                }
                index = table.nextIndex
                continue
            }

            if let fence = line.firstMatch(#"^([ \t]*)(```+|~~~+)\s*(.*?)\s*$"#) {
                let fenceIndent = fence[1]
                let marker = fence[2]
                let language = fence[3].trimmingCharacters(in: .whitespacesAndNewlines)
                var code: [String] = []
                index += 1
                while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(marker) {
                    let codeLine = lines[index]
                    code.append(codeLine.hasPrefix(fenceIndent) ? String(codeLine.dropFirst(fenceIndent.count)) : codeLine)
                    index += 1
                }
                if index < lines.count { index += 1 }
                let codeBlock = code.joined(separator: "\n")
                if let lastPath {
                    mutateNode(at: lastPath) { node in
                        node.codeBlock = codeBlock
                        node.codeLanguage = language.isEmpty ? nil : language
                    }
                } else {
                    _ = appendNode(language.isEmpty ? "代码块" : "代码块：\(language)", parentPath: listStack.last?.path ?? headingStack.last?.path) { node in
                        node.codeBlock = codeBlock
                        node.codeLanguage = language.isEmpty ? nil : language
                    }
                }
                continue
            }

            var paragraph = [line.trimmingCharacters(in: .whitespaces)]
            index += 1
            while index < lines.count, !lines[index].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, headingMatch(lines[index]) == nil, listItemMatch(lines[index]) == nil, quoteMatch(lines[index]) == nil, imageMatch(lines[index]) == nil, !isTableStart(lines, index) {
                paragraph.append(lines[index].trimmingCharacters(in: .whitespaces))
                index += 1
            }
            _ = appendNode(unescapeInline(paragraph.joined(separator: " ")), parentPath: listStack.last?.path ?? headingStack.last?.path)
        }

        return ParsedMarkdown(title: title, hasTitle: hasTitle, nodes: roots)
    }

    private static func nodeToMarkdown(_ node: OutlineNodeDTO, depth: Int, insideList: Bool) -> [String] {
        var lines: [String] = []
        let text = escapeInline(node.text.isEmpty ? Defaults.nodeText : node.text)
        let heading = node.headingLevel ?? 0
        if heading > 0, !insideList {
            lines.append("\(String(repeating: "#", count: min(heading + 1, 6))) \(text)")
            appendBlocks(node, indent: "", lines: &lines)
            node.children.forEach { lines.append(contentsOf: nodeToMarkdown($0, depth: 0, insideList: false)) }
            return lines
        }

        let indent = String(repeating: "  ", count: depth)
        let marker = (node.isTodo == true || node.checked) ? "- [\(node.checked ? "x" : " ")]" : "-"
        lines.append("\(indent)\(marker) \(text)")
        appendBlocks(node, indent: indent + "  ", lines: &lines)
        node.children.forEach { lines.append(contentsOf: nodeToMarkdown($0, depth: depth + 1, insideList: true)) }
        return lines
    }

    private static func appendBlocks(_ node: OutlineNodeDTO, indent: String, lines: inout [String]) {
        if !node.note.isEmpty {
            node.note.components(separatedBy: "\n").forEach { lines.append("\(indent)> \($0)") }
        }
        if let codeBlock = node.codeBlock {
            lines.append(contentsOf: codeToMarkdown(codeBlock, language: node.codeLanguage, indent: indent))
        }
        if let imageName = node.imageName {
            lines.append("\(indent)![\(escapeInline(node.imageAlt ?? imageName))](\(imageName))")
        }
        if let table = node.table, !table.isEmpty {
            lines.append(contentsOf: tableToMarkdown(table, indent: indent))
        }
    }

    private static func codeToMarkdown(_ code: String, language: String?, indent: String) -> [String] {
        let fence = codeFence(for: code)
        let normalizedLanguage = language?
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let opening = normalizedLanguage.isEmpty ? "\(indent)\(fence)" : "\(indent)\(fence)\(normalizedLanguage)"
        return [opening] + normalizeSource(code).components(separatedBy: "\n").map { "\(indent)\($0)" } + ["\(indent)\(fence)"]
    }

    private static func codeFence(for code: String) -> String {
        var longestRun = 0
        var currentRun = 0
        for character in code {
            if character == "`" {
                currentRun += 1
                longestRun = max(longestRun, currentRun)
            } else {
                currentRun = 0
            }
        }
        return String(repeating: "`", count: max(3, longestRun + 1))
    }

    private static func tableToMarkdown(_ table: [[String]], indent: String) -> [String] {
        let columnCount = table.map(\.count).max() ?? 0
        guard columnCount > 0 else { return [] }
        let rows = table.map { row in
            (0..<columnCount).map { index in index < row.count ? row[index] : "" }
        }
        let header = "\(indent)| \(rows[0].map(escapeTableCell).joined(separator: " | ")) |"
        let separator = "\(indent)| \(Array(repeating: "---", count: columnCount).joined(separator: " | ")) |"
        return [header, separator] + rows.dropFirst().map { "\(indent)| \($0.map(escapeTableCell).joined(separator: " | ")) |" }
    }

    static func normalizeSource(_ content: String) -> String {
        content.replacingOccurrences(of: "\u{FEFF}", with: "").replacingOccurrences(of: "\r\n?", with: "\n", options: .regularExpression)
    }

    private static func escapeInline(_ value: String) -> String {
        let normalized = value
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "\n", with: " ")
        let trimmed = normalized.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = trimmed.isEmpty ? Defaults.nodeText : trimmed
        return text.replacingOccurrences(of: #"([\\`*_\[\]{}()#+\-.!>])"#, with: #"\\$1"#, options: .regularExpression)
    }

    private static func unescapeInline(_ value: String) -> String {
        value.replacingOccurrences(of: #"\\([\\`*_\[\]{}()#+\-.!>])"#, with: "$1", options: .regularExpression)
    }

    private static func escapeTableCell(_ value: String) -> String {
        escapeInline(value).replacingOccurrences(of: "|", with: "\\|")
    }

    private static func headingMatch(_ line: String) -> (level: Int, text: String)? {
        guard let match = line.firstMatch(#"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$"#) else { return nil }
        return (match[1].count, unescapeInline(match[2].trimmingCharacters(in: .whitespaces)))
    }

    private static func listItemMatch(_ line: String) -> (indent: Int, checked: Bool, isTodo: Bool, text: String)? {
        guard let match = line.firstMatch(#"^([ \t]*)(?:[-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s*)?(.*)$"#) else { return nil }
        let indent = match[1].reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
        let isTodo = !match[2].isEmpty
        return (indent, match[2].lowercased() == "x", isTodo, unescapeInline(match[3].trimmingCharacters(in: .whitespaces)))
    }

    private static func quoteMatch(_ line: String) -> String? {
        line.firstMatch(#"^[ \t]*>\s?(.*)$"#)?[1]
    }

    private static func imageMatch(_ line: String) -> (alt: String, source: String)? {
        guard let match = line.firstMatch(#"^[ \t]*!\[([^\]]*)\]\(([^)]+)\)\s*$"#) else { return nil }
        return (unescapeInline(match[1]), match[2])
    }

    private static func isTableStart(_ lines: [String], _ index: Int) -> Bool {
        guard lines.indices.contains(index + 1), lines[index].contains("|") else { return false }
        return splitTableRow(lines[index + 1]).allSatisfy { $0.range(of: #"^:?-{3,}:?$"#, options: .regularExpression) != nil }
    }

    private static func parseTable(_ lines: [String], start: Int) -> (rows: [[String]], lines: [String], nextIndex: Int) {
        var tableLines = [lines[start], lines[start + 1]]
        var index = start + 2
        while lines.indices.contains(index), lines[index].contains("|"), !lines[index].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            tableLines.append(lines[index])
            index += 1
        }
        return ([splitTableRow(tableLines[0])] + tableLines.dropFirst(2).map(splitTableRow), tableLines, index)
    }

    private static func splitTableRow(_ line: String) -> [String] {
        let trimmed = line.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "|"))
        var cells: [String] = []
        var current = ""
        var escaping = false
        for char in trimmed {
            if escaping {
                current.append(char)
                escaping = false
            } else if char == "\\" {
                escaping = true
            } else if char == "|" {
                cells.append(unescapeInline(current.trimmingCharacters(in: .whitespaces)))
                current = ""
            } else {
                current.append(char)
            }
        }
        cells.append(unescapeInline(current.trimmingCharacters(in: .whitespaces)))
        return cells
    }
}

private final class PreviousMatcher {
    private var byPath: [String: OutlineNodeDTO] = [:]
    private var byText: [String: [OutlineNodeDTO]] = [:]
    private var used = Set<String>()

    init(previousDocument: OutlineDocumentDTO?) {
        func visit(_ nodes: [OutlineNodeDTO], path: [Int] = []) {
            for (index, node) in nodes.enumerated() {
                byPath[Self.pathKey(path + [index])] = node
                let textKey = Self.normalizeMatchText(node.text)
                if !textKey.isEmpty {
                    byText[textKey, default: []].append(node)
                }
                visit(node.children, path: path + [index])
            }
        }
        visit(previousDocument?.nodes ?? [])
    }

    func makeNode(text: String, path: [Int]) -> OutlineNodeDTO {
        let normalizedText = text.isEmpty ? Defaults.nodeText : text
        var base = previousNode(text: normalizedText, path: path) ?? OutlineNodeDTO(text: normalizedText)
        if used.contains(base.id) {
            base.id = "node_\(UUID().uuidString)"
        }
        used.insert(base.id)
        base.text = normalizedText
        base.note = ""
        base.checked = false
        base.headingLevel = 0
        base.imageName = nil
        base.imageAlt = nil
        base.table = nil
        base.codeBlock = nil
        base.codeLanguage = nil
        base.isTodo = false
        base.children = []
        return base
    }

    private func previousNode(text: String, path: [Int]) -> OutlineNodeDTO? {
        let textKey = Self.normalizeMatchText(text)
        if let pathNode = byPath[Self.pathKey(path)],
           !used.contains(pathNode.id),
           Self.normalizeMatchText(pathNode.text) == textKey {
            return pathNode
        }

        if let textNode = byText[textKey]?.first(where: { !used.contains($0.id) }) {
            return textNode
        }

        return nil
    }

    private static func pathKey(_ path: [Int]) -> String {
        path.map(String.init).joined(separator: ".")
    }

    private static func normalizeMatchText(_ value: String) -> String {
        value
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }
}

private extension String {
    func firstMatch(_ pattern: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let nsRange = NSRange(startIndex..., in: self)
        guard let result = regex.firstMatch(in: self, range: nsRange) else { return nil }
        return (0..<result.numberOfRanges).map { index in
            guard let range = Range(result.range(at: index), in: self) else { return "" }
            return String(self[range])
        }
    }
}
