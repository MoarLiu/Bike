import AppKit
import SwiftUI

struct MindMapView: View {
    @EnvironmentObject private var store: AppStore
    var title: String
    var nodes: [OutlineNodeDTO]
    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var accumulatedOffset: CGSize = .zero
    @State private var editingNodeId: String? = nil
    @State private var editingDraftText: String = ""
    @State private var shouldIgnoreFocusLoss = false

    var body: some View {
        GeometryReader { proxy in
            let layout = MindMapLayout.layout(title: title, nodes: nodes)
            let renderedItems = renderItems(layout.items)
            ZStack(alignment: .topLeading) {
                ZStack(alignment: .topLeading) {
                    Color.clear
                        .contentShape(Rectangle())

                    ZStack(alignment: .topLeading) {
                        Canvas { context, _ in
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
                        .frame(width: layout.width, height: layout.height)

                        ForEach(renderedItems) { item in
                            MindMapNode(
                                item: item,
                                editingNodeId: $editingNodeId,
                                editingDraftText: $editingDraftText,
                                shouldIgnoreFocusLoss: $shouldIgnoreFocusLoss,
                                cancelEditing: { _ = cancelEditingAndClearSelection() }
                            )
                                .position(x: item.rect.midX, y: item.rect.midY)
                        }

                        ForEach(renderedItems.filter { $0.id != MindMapLayout.rootId && $0.hasChildren }) { item in
                            MindMapCollapseControl(item: item) {
                                toggleCollapse(item)
                            }
                            .position(x: item.rect.maxX + 14, y: item.rect.midY)
                        }
                    }
                    .frame(width: layout.width, height: layout.height)
                    .scaleEffect(scale)
                    .offset(x: offset.width + 40, y: offset.height + proxy.size.height / 2 - layout.height / 2)
                    .animation(.spring(response: 0.3, dampingFraction: 0.85), value: scale)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .contentShape(Rectangle())
                .simultaneousGesture(
                    SpatialTapGesture()
                        .onEnded { tap in
                            clearSelectionIfNeeded(at: tap.location, layout: layout, viewportHeight: proxy.size.height)
                        }
                )
                .simultaneousGesture(
                    DragGesture(minimumDistance: 3)
                        .onChanged { gesture in
                            guard editingNodeId == nil else { return }
                            offset = CGSize(
                                width: accumulatedOffset.width + gesture.translation.width,
                                height: accumulatedOffset.height + gesture.translation.height
                            )
                        }
                        .onEnded { gesture in
                            guard editingNodeId == nil else { return }
                            accumulatedOffset = CGSize(
                                width: accumulatedOffset.width + gesture.translation.width,
                                height: accumulatedOffset.height + gesture.translation.height
                            )
                            offset = accumulatedOffset
                        }
                )

                // Static zoom overlay (independent of zoom and drag)
                HStack {
                    Button { scale = min(scale * 1.18, 2.5) } label: { Image(systemName: "plus.magnifyingglass") }
                    Text("\(Int(scale * 100))%").font(.caption.monospacedDigit())
                    Button { scale = max(scale * 0.85, 0.35) } label: { Image(systemName: "minus.magnifyingglass") }
                    Button {
                        scale = 1
                        offset = .zero
                        accumulatedOffset = .zero
                    } label: { Image(systemName: "arrow.counterclockwise") }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .padding(12)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                .padding(14)
            }
        }
        .overlay {
            MindMapInputMonitor(
                onScroll: { deltaY in
                    zoomByScroll(deltaY)
                },
                onEscape: {
                    cancelEditingAndClearSelection()
                }
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .allowsHitTesting(false)
        }
        .background(.quaternary.opacity(0.45))
    }

    private func clearSelectionIfNeeded(at location: CGPoint, layout: MindMapLayout.Result, viewportHeight: CGFloat) {
        guard !locationHitsNode(location, layout: layout, viewportHeight: viewportHeight) else { return }
        commitEditingAndClearSelection()
    }

    private func commitEditingAndClearSelection() {
        if let editingNodeId {
            store.updateNodeText(editingNodeId, text: editingDraftText)
        }
        _ = cancelEditingAndClearSelection()
    }

    @discardableResult
    private func cancelEditingAndClearSelection() -> Bool {
        guard editingNodeId != nil || store.activeNodeId != nil else { return false }
        shouldIgnoreFocusLoss = true
        store.finishCoalescedUndo()
        editingNodeId = nil
        store.activeNodeId = nil
        return true
    }

    private func zoomByScroll(_ deltaY: CGFloat) -> Bool {
        guard editingNodeId == nil, abs(deltaY) > 0.1 else { return false }
        let factor = exp(deltaY * 0.002)
        scale = min(max(scale * factor, 0.35), 2.5)
        return true
    }

    private func locationHitsNode(_ location: CGPoint, layout: MindMapLayout.Result, viewportHeight: CGFloat) -> Bool {
        let mapOffset = CGPoint(x: offset.width + 40, y: offset.height + viewportHeight / 2 - layout.height / 2)
        let mapCenter = CGPoint(x: layout.width / 2, y: layout.height / 2)
        let localPoint = CGPoint(
            x: mapCenter.x + (location.x - mapOffset.x - mapCenter.x) / scale,
            y: mapCenter.y + (location.y - mapOffset.y - mapCenter.y) / scale
        )
        return layout.items.contains { $0.rect.insetBy(dx: -8, dy: -8).contains(localPoint) }
    }

    private func renderItems(_ items: [MindMapLayout.Item]) -> [MindMapLayout.Item] {
        guard let editingNodeId else { return items }
        let editingItems = items.filter { $0.id == editingNodeId }
        guard !editingItems.isEmpty else { return items }
        return items.filter { $0.id != editingNodeId } + editingItems
    }

    private func toggleCollapse(_ item: MindMapLayout.Item) {
        guard item.id != MindMapLayout.rootId else { return }
        store.updateNode(item.id, preservesMarkdown: true) { node in
            node.collapsed.toggle()
        }
        store.selectNode(item.id)
    }
}

private struct MindMapNode: View {
    @EnvironmentObject private var store: AppStore
    var item: MindMapLayout.Item
    @Binding var editingNodeId: String?
    @Binding var editingDraftText: String
    @Binding var shouldIgnoreFocusLoss: Bool
    var cancelEditing: () -> Void

    @FocusState private var isTextFieldFocused: Bool

    var body: some View {
        if editingNodeId == item.id {
            TextField("", text: $editingDraftText, axis: .vertical)
                .textFieldStyle(.plain)
                .font(item.depth == 0 ? .headline : .body)
                .multilineTextAlignment(.center)
                .padding(.leading, 14)
                .padding(.trailing, item.id == MindMapLayout.rootId ? 14 : 44)
                .padding(.vertical, 10)
                .frame(width: item.rect.width, height: item.rect.height)
                .background(background, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.accentColor, lineWidth: 2))
                .overlay(alignment: .trailing) {
                    if item.id != MindMapLayout.rootId {
                        AiActionMenu(isBusy: store.isAiBusy(item.id)) { action in
                            saveEdit()
                            store.performAiNodeAction(action, targetId: item.id)
                        }
                        .padding(.trailing, 9)
                    }
                }
                .focused($isTextFieldFocused)
                .onSubmit {
                    commitEdit()
                }
                .onExitCommand {
                    cancelEditing()
                }
                .onChange(of: isTextFieldFocused) { _, isFocused in
                    if !isFocused {
                        handleFocusLoss()
                    }
                }
                .onAppear {
                    if editingNodeId == item.id {
                        beginEditing()
                    }
                }
        } else {
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
                .simultaneousGesture(
                    TapGesture(count: 2)
                        .onEnded {
                            startEditing()
                        }
                )
                .contextMenu {
                    if item.id == MindMapLayout.rootId {
                        Button("新增子节点") { store.insertMindMapRootChild() }
                    } else {
                        Button("新增同级") { store.insertAfter(item.id) }
                        Button("新增子级") { store.insertChild(item.id) }
                        if item.hasChildren {
                            Button(item.isCollapsed ? "展开下级主题" : "折叠下级主题") {
                                toggleCollapse()
                            }
                        }
                        Divider()
                        Button("AI 生成") { store.performAiNodeAction(.generate, targetId: item.id) }
                        Button("AI 润色") { store.performAiNodeAction(.polish, targetId: item.id) }
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
    }

    private var background: Color {
        item.depth == 0 ? Color.accentColor.opacity(0.16) : Color(nsColor: .controlBackgroundColor)
    }

    private func toggleCollapse() {
        guard item.id != MindMapLayout.rootId else { return }
        store.updateNode(item.id, preservesMarkdown: true) { node in
            node.collapsed.toggle()
        }
        store.selectNode(item.id)
    }

    private func startEditing() {
        guard item.id != MindMapLayout.rootId else { return }
        if let currentEditingId = editingNodeId, currentEditingId != item.id {
            store.updateNodeText(currentEditingId, text: editingDraftText)
            store.finishCoalescedUndo()
        }
        store.activeNodeId = item.id
        editingNodeId = item.id
    }

    private func beginEditing() {
        shouldIgnoreFocusLoss = false
        editingDraftText = TreeOperations.findNode(in: store.activeDocument?.nodes ?? [], id: item.id)?.text ?? ""
        DispatchQueue.main.async {
            isTextFieldFocused = true
        }
    }

    private func handleFocusLoss() {
        if shouldIgnoreFocusLoss {
            shouldIgnoreFocusLoss = false
            return
        }
        let shouldCloseEditor = editingNodeId == item.id
        let draft = editingDraftText
        DispatchQueue.main.async {
            if shouldIgnoreFocusLoss {
                shouldIgnoreFocusLoss = false
                return
            }
            saveEdit(draft)
            if shouldCloseEditor, editingNodeId == item.id {
                shouldIgnoreFocusLoss = true
                editingNodeId = nil
            }
        }
    }

    private func saveEdit(_ draft: String? = nil) {
        store.updateNodeText(item.id, text: draft ?? editingDraftText)
        store.finishCoalescedUndo()
    }

    private func commitEdit() {
        saveEdit()
        shouldIgnoreFocusLoss = true
        editingNodeId = nil
    }
}

private struct MindMapCollapseControl: View {
    var item: MindMapLayout.Item
    var onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            ZStack {
                Circle()
                    .fill(Color(nsColor: .textBackgroundColor))
                    .overlay(
                        Circle()
                            .stroke(Color.accentColor.opacity(0.82), lineWidth: 1.35)
                    )
                    .shadow(color: .black.opacity(0.07), radius: 3, x: 0, y: 1)

                Text(item.isCollapsed ? childCountText : "-")
                    .font(.system(size: item.isCollapsed ? 10 : 14, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(Color.accentColor)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
            }
            .frame(width: 21, height: 21)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help(item.isCollapsed ? "展开 \(item.childCount) 个子主题" : "折叠下级主题")
        .accessibilityLabel(item.isCollapsed ? "展开 \(item.childCount) 个子主题" : "折叠下级主题")
    }

    private var childCountText: String {
        item.childCount > 99 ? "99+" : "\(item.childCount)"
    }
}

private struct MindMapInputMonitor: NSViewRepresentable {
    var onScroll: (CGFloat) -> Bool
    var onEscape: () -> Bool

    func makeNSView(context: Context) -> MindMapInputMonitorView {
        MindMapInputMonitorView()
    }

    func updateNSView(_ nsView: MindMapInputMonitorView, context: Context) {
        nsView.onScroll = onScroll
        nsView.onEscape = onEscape
        nsView.installMonitorsIfNeeded()
    }
}

private final class MindMapInputMonitorView: NSView {
    var onScroll: ((CGFloat) -> Bool)?
    var onEscape: (() -> Bool)?

    private let monitors = MindMapEventMonitorBag()

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            removeMonitors()
        } else {
            installMonitorsIfNeeded()
        }
    }

    func installMonitorsIfNeeded() {
        guard window != nil else { return }
        if monitors.scrollMonitor == nil {
            monitors.scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                guard let self,
                      self.contains(event),
                      abs(event.scrollingDeltaY) >= abs(event.scrollingDeltaX) else {
                    return event
                }
                return self.onScroll?(event.scrollingDeltaY) == true ? nil : event
            }
        }
        if monitors.keyMonitor == nil {
            monitors.keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, self.window === event.window, event.keyCode == 53 else {
                    return event
                }
                return self.onEscape?() == true ? nil : event
            }
        }
    }

    private func contains(_ event: NSEvent) -> Bool {
        guard window === event.window else { return false }
        let point = convert(event.locationInWindow, from: nil)
        return bounds.contains(point)
    }

    private func removeMonitors() {
        monitors.removeAll()
    }
}

private final class MindMapEventMonitorBag {
    var scrollMonitor: Any?
    var keyMonitor: Any?

    deinit {
        removeAll()
    }

    func removeAll() {
        if let scrollMonitor {
            NSEvent.removeMonitor(scrollMonitor)
            self.scrollMonitor = nil
        }
        if let keyMonitor {
            NSEvent.removeMonitor(keyMonitor)
            self.keyMonitor = nil
        }
    }
}

enum MindMapLayout {
    static let rootId = "__bike_mindmap_root__"

    struct Item: Identifiable {
        var id: String
        var title: String
        var rect: CGRect
        var depth: Int
        var parentId: String?
        var hasChildren: Bool
        var childCount: Int
        var isCollapsed: Bool
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
            items.append(Item(
                id: node.id,
                title: node.text.isEmpty ? Defaults.nodeText : node.text,
                rect: CGRect(origin: CGPoint(x: CGFloat(depth) * xGap, y: y), size: size),
                depth: depth,
                parentId: parent,
                hasChildren: !node.children.isEmpty,
                childCount: node.children.count,
                isCollapsed: node.collapsed
            ))
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
