import Foundation
import SwiftUI

struct OutlineNode: Codable, Identifiable, Equatable {
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
    var table: [[String]]?
    var children: [OutlineNode]
}

struct OutlineDocument: Codable, Identifiable, Equatable {
    var id: String
    var title: String
    var createdAt: String
    var updatedAt: String
    var nodes: [OutlineNode]
}

struct Workspace: Codable, Equatable {
    var version: Int
    var activeDocumentId: String
    var documents: [OutlineDocument]
}

struct FlatNode: Identifiable, Equatable {
    var id: String { node.id }
    var node: OutlineNode
    var depth: Int
    var parentId: String?
    var path: [Int]
}

enum NodePalette: String, CaseIterable, Identifiable {
    case plain
    case blue
    case green
    case amber
    case rose

    var id: String { rawValue }

    var label: String {
        switch self {
        case .plain: "默认"
        case .blue: "蓝"
        case .green: "绿"
        case .amber: "黄"
        case .rose: "红"
        }
    }

    var textColor: Color {
        switch self {
        case .plain: Color.primary
        case .blue: Color(red: 0.18, green: 0.39, blue: 0.56)
        case .green: Color(red: 0.18, green: 0.44, blue: 0.25)
        case .amber: Color(red: 0.58, green: 0.38, blue: 0.08)
        case .rose: Color(red: 0.64, green: 0.24, blue: 0.31)
        }
    }

    var softBackground: Color {
        switch self {
        case .plain: Color(nsColor: .textBackgroundColor)
        case .blue: Color(red: 0.93, green: 0.97, blue: 1.0)
        case .green: Color(red: 0.93, green: 0.98, blue: 0.94)
        case .amber: Color(red: 1.0, green: 0.96, blue: 0.84)
        case .rose: Color(red: 1.0, green: 0.94, blue: 0.95)
        }
    }
}

func nodePalette(_ value: String) -> NodePalette {
    NodePalette(rawValue: value) ?? .plain
}

func nowISO() -> String {
    ISO8601DateFormatter().string(from: Date())
}

func makeNode(_ text: String = "", children: [OutlineNode] = []) -> OutlineNode {
    OutlineNode(
        id: "node_\(UUID().uuidString.lowercased())",
        text: text,
        note: "",
        checked: false,
        collapsed: false,
        color: "plain",
        headingLevel: nil,
        bold: nil,
        italic: nil,
        underline: nil,
        strike: nil,
        highlight: nil,
        icon: nil,
        imageName: nil,
        table: nil,
        children: children
    )
}

func starterWorkspace() -> Workspace {
    let documentId = "doc_\(UUID().uuidString.lowercased())"
    return Workspace(
        version: 1,
        activeDocumentId: documentId,
        documents: [
            OutlineDocument(
                id: documentId,
                title: "本地化大纲产品蓝图",
                createdAt: nowISO(),
                updatedAt: nowISO(),
                nodes: [
                    makeNode("核心原则 #localfirst", children: [
                        makeNode("所有文档先保存在本机 Application Support"),
                        makeNode("iCloud Drive 作为备份和跨设备同步文件夹"),
                        makeNode("导出格式保持开放：JSON、Markdown")
                    ]),
                    makeNode("编辑逻辑", children: [
                        makeNode("Enter 新建同级主题"),
                        makeNode("Tab / Shift+Tab 调整层级"),
                        makeNode("上下方向键切换主题")
                    ]),
                    makeNode("视图", children: [
                        makeNode("第一阶段先做原生大纲视图"),
                        makeNode("后续补脑图和演示视图")
                    ]),
                    makeNode("知识连接", children: [
                        makeNode("用 #标签 聚合主题"),
                        makeNode("用 [[文档名]] 建立文档链接")
                    ])
                ]
            )
        ]
    )
}
