import SwiftUI

struct MindMapView: View {
    @EnvironmentObject private var store: AppStore
    var title: String
    var nodes: [OutlineNodeDTO]
    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .topLeading) {
                Canvas { context, _ in
                    let layout = MindMapLayout.layout(title: title, nodes: nodes)
                    context.translateBy(x: offset.width + 40, y: offset.height + proxy.size.height / 2 - layout.height / 2)
                    context.scaleBy(x: scale, y: scale)
                    for edge in layout.edges {
                        var path = Path()
                        path.move(to: CGPoint(x: edge.from.maxX, y: edge.from.midY))
                        path.addCurve(
                            to: CGPoint(x: edge.to.minX, y: edge.to.midY),
                            control1: CGPoint(x: edge.from.maxX + 54, y: edge.from.midY),
                            control2: CGPoint(x: edge.to.minX - 54, y: edge.to.midY)
                        )
                        context.stroke(path, with: .color(.secondary.opacity(0.45)), lineWidth: 1.5)
                    }
                }
                .gesture(DragGesture().onChanged { offset = $0.translation })
                .onScrollPhaseChange { _, _ in }

                let layout = MindMapLayout.layout(title: title, nodes: nodes)
                ForEach(layout.items) { item in
                    MindMapNode(item: item)
                        .position(
                            x: 40 + offset.width + (item.rect.midX * scale),
                            y: proxy.size.height / 2 - layout.height / 2 + offset.height + (item.rect.midY * scale)
                        )
                        .scaleEffect(scale)
                }

                HStack {
                    Button { scale = min(scale * 1.18, 2.5) } label: { Image(systemName: "plus.magnifyingglass") }
                    Text("\(Int(scale * 100))%").font(.caption.monospacedDigit())
                    Button { scale = max(scale * 0.85, 0.35) } label: { Image(systemName: "minus.magnifyingglass") }
                    Button { scale = 1; offset = .zero } label: { Image(systemName: "arrow.counterclockwise") }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .padding(12)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                .padding(14)
            }
        }
        .background(.quaternary.opacity(0.45))
    }
}

private struct MindMapNode: View {
    @EnvironmentObject private var store: AppStore
    var item: MindMapLayout.Item

    var body: some View {
        Text(item.title)
            .font(item.depth == 0 ? .headline : .body)
            .lineLimit(3)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(width: item.rect.width, height: item.rect.height)
            .background(background, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(store.activeNodeId == item.id ? Color.accentColor : Color.secondary.opacity(0.24), lineWidth: store.activeNodeId == item.id ? 2 : 1))
            .contentShape(Rectangle())
            .onTapGesture {
                if item.id != MindMapLayout.rootId {
                    store.activeNodeId = item.id
                }
            }
            .contextMenu {
                if item.id == MindMapLayout.rootId {
                    Button("新增子节点") { store.insertMindMapRootChild() }
                } else {
                    Button("新增同级") { store.insertAfter(item.id) }
                    Button("新增子级") { store.insertChild(item.id) }
                    if store.focusNodeId == item.id {
                        Button("退出聚焦") { store.clearFocus() }
                    } else {
                        Button("进入此主题") { store.focusOnNode(item.id) }
                    }
                    Divider()
                    Button("删除", role: .destructive) { store.removeNode(item.id) }
                }
            }
    }

    private var background: Color {
        item.depth == 0 ? Color.accentColor.opacity(0.16) : Color(nsColor: .controlBackgroundColor)
    }
}

enum MindMapLayout {
    static let rootId = "__local_outline_mindmap_root__"

    struct Item: Identifiable {
        var id: String
        var title: String
        var rect: CGRect
        var depth: Int
        var parentId: String?
    }

    struct Edge {
        var from: CGRect
        var to: CGRect
    }

    struct Result {
        var items: [Item]
        var edges: [Edge]
        var width: CGFloat
        var height: CGFloat
    }

    static func layout(title: String, nodes: [OutlineNodeDTO]) -> Result {
        let root = OutlineNodeDTO(id: rootId, text: title, children: nodes)
        var items: [Item] = []
        let xGap: CGFloat = 330
        let yGap: CGFloat = 30
        var cursor: CGFloat = 0

        @discardableResult
        func visit(_ node: OutlineNodeDTO, depth: Int, parent: String?) -> CGFloat {
            let size = CGSize(width: depth == 0 ? 260 : 280, height: max(52, CGFloat(node.text.count / 22 + 1) * 22 + 20))
            let children = node.collapsed ? [] : node.children
            let y: CGFloat
            if children.isEmpty {
                y = cursor
                cursor += size.height + yGap
            } else {
                let childCenters = children.map { visit($0, depth: depth + 1, parent: node.id) }
                y = ((childCenters.min() ?? 0) + (childCenters.max() ?? 0)) / 2 - size.height / 2
            }
            items.append(Item(id: node.id, title: node.text.isEmpty ? Defaults.nodeText : node.text, rect: CGRect(origin: CGPoint(x: CGFloat(depth) * xGap, y: y), size: size), depth: depth, parentId: parent))
            return y + size.height / 2
        }

        _ = visit(root, depth: 0, parent: nil)
        let map = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0.rect) })
        let edges = items.compactMap { item -> Edge? in
            guard let parentId = item.parentId, let parent = map[parentId] else { return nil }
            return Edge(from: parent, to: item.rect)
        }
        let width = (items.map(\.rect.maxX).max() ?? 760) + 80
        let height = max((items.map(\.rect.maxY).max() ?? 420) + 80, 420)
        return Result(items: items, edges: edges, width: width, height: height)
    }
}
