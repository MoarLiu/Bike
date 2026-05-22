import AppKit
import SwiftUI

struct OutlineNodeTextMenuActions {
    var isFocused: Bool
    var insertSibling: () -> Void
    var insertChild: () -> Void
    var focus: () -> Void
    var clearFocus: () -> Void
    var copyLink: () -> Void
    var toggleTodo: () -> Void
    var setColor: (OutlineColor) -> Void
    var delete: () -> Void
}

struct OutlineNodeTextEditor: NSViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var fontSize: CGFloat
    var fontWeight: NSFont.Weight
    var italic: Bool
    var textColor: NSColor
    var strikethrough: Bool
    var onSubmit: () -> Void
    var onIndent: () -> Void
    var onOutdent: () -> Void
    var onSelect: () -> Void
    var menuActions: OutlineNodeTextMenuActions

    func makeNSView(context: Context) -> ContextMenuTextView {
        let view = ContextMenuTextView()
        view.coordinator = context.coordinator
        view.delegate = context.coordinator
        view.isRichText = false
        view.importsGraphics = false
        view.allowsUndo = true
        view.isEditable = true
        view.isSelectable = true
        view.drawsBackground = false
        view.usesFindBar = false
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.isHorizontallyResizable = false
        view.isVerticallyResizable = false
        view.textContainerInset = NSSize(width: 0, height: 2)
        view.textContainer?.lineBreakMode = .byTruncatingTail
        view.textContainer?.maximumNumberOfLines = 1
        view.textContainer?.widthTracksTextView = true
        view.textContainer?.heightTracksTextView = true
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        applyStyle(to: view, context: context)
        view.string = text
        return view
    }

    func updateNSView(_ nsView: ContextMenuTextView, context: Context) {
        context.coordinator.update(self)
        nsView.coordinator = context.coordinator
        if nsView.string != text, !context.coordinator.isEditing {
            nsView.string = text
        }
        applyStyle(to: nsView, context: context)
        nsView.placeholderString = placeholder
        nsView.needsDisplay = true
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self, text: $text)
    }

    private func applyStyle(to view: NSTextView, context: Context) {
        let resolvedFont = makeFont()
        let attributes = textAttributes(font: resolvedFont)
        let selectedRanges = view.selectedRanges
        view.font = resolvedFont
        view.textColor = textColor
        view.typingAttributes = attributes
        if view.string.isEmpty {
            view.textStorage?.setAttributedString(NSAttributedString(string: "", attributes: attributes))
        } else if let storage = view.textStorage {
            storage.setAttributes(attributes, range: NSRange(location: 0, length: storage.length))
        }
        view.selectedRanges = selectedRanges
        view.invalidateIntrinsicContentSize()
    }

    private func makeFont() -> NSFont {
        let base = NSFont.systemFont(ofSize: fontSize, weight: fontWeight)
        guard italic else { return base }
        return NSFontManager.shared.convert(base, toHaveTrait: .italicFontMask)
    }

    private func textAttributes(font: NSFont) -> [NSAttributedString.Key: Any] {
        var attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: textColor
        ]
        if strikethrough {
            attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
        }
        return attributes
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding var text: String
        var parent: OutlineNodeTextEditor
        var isEditing = false

        init(parent: OutlineNodeTextEditor, text: Binding<String>) {
            self.parent = parent
            _text = text
        }

        func update(_ parent: OutlineNodeTextEditor) {
            self.parent = parent
        }

        func selectRow() {
            parent.onSelect()
        }

        func submit() {
            parent.onSubmit()
        }

        func makeMenu() -> NSMenu {
            let menu = NSMenu()
            menu.addItem(item("新增同级", #selector(insertSibling)))
            menu.addItem(item("新增子级", #selector(insertChild)))
            menu.addItem(item(parent.menuActions.isFocused ? "退出聚焦" : "聚焦", #selector(toggleFocus)))
            menu.addItem(.separator())
            menu.addItem(item("复制主题链接", #selector(copyLink)))
            menu.addItem(item("转化为待办任务", #selector(toggleTodo)))

            let colorMenu = NSMenu()
            for color in OutlineColor.allCases {
                let colorItem = NSMenuItem(title: color.title, action: #selector(setColor(_:)), keyEquivalent: "")
                colorItem.target = self
                colorItem.representedObject = color.rawValue
                colorMenu.addItem(colorItem)
            }
            let colorRoot = NSMenuItem(title: "颜色", action: nil, keyEquivalent: "")
            colorRoot.submenu = colorMenu
            menu.addItem(colorRoot)

            menu.addItem(.separator())
            menu.addItem(item("删除", #selector(deleteNode)))
            return menu
        }

        private func item(_ title: String, _ action: Selector) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            return item
        }

        @objc private func insertSibling() {
            parent.menuActions.insertSibling()
        }

        @objc private func insertChild() {
            parent.menuActions.insertChild()
        }

        @objc private func toggleFocus() {
            parent.menuActions.isFocused ? parent.menuActions.clearFocus() : parent.menuActions.focus()
        }

        @objc private func copyLink() {
            parent.menuActions.copyLink()
        }

        @objc private func toggleTodo() {
            parent.menuActions.toggleTodo()
        }

        @objc private func setColor(_ sender: NSMenuItem) {
            guard
                let rawValue = sender.representedObject as? String,
                let color = OutlineColor(rawValue: rawValue)
            else { return }
            parent.menuActions.setColor(color)
        }

        @objc private func deleteNode() {
            parent.menuActions.delete()
        }

        func textDidBeginEditing(_ notification: Notification) {
            isEditing = true
            (notification.object as? NSTextView)?.needsDisplay = true
        }

        func textDidEndEditing(_ notification: Notification) {
            isEditing = false
            (notification.object as? NSTextView)?.needsDisplay = true
        }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            text = view.string.replacingOccurrences(of: "\n", with: " ")
            view.needsDisplay = true
        }

        func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            if commandSelector == #selector(NSResponder.insertNewline(_:)) {
                submit()
                return true
            }
            if commandSelector == #selector(NSResponder.insertTab(_:)) {
                parent.onIndent()
                return true
            }
            if commandSelector == #selector(NSResponder.insertBacktab(_:)) {
                parent.onOutdent()
                return true
            }
            return false
        }
    }
}

final class ContextMenuTextView: NSTextView {
    weak var coordinator: OutlineNodeTextEditor.Coordinator?
    var placeholderString = ""

    override var intrinsicContentSize: NSSize {
        let currentFont = font ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)
        let height = ceil(currentFont.ascender - currentFont.descender + currentFont.leading) + 6
        return NSSize(width: NSView.noIntrinsicMetric, height: height)
    }

    override func mouseDown(with event: NSEvent) {
        coordinator?.selectRow()
        super.mouseDown(with: event)
    }

    override func rightMouseDown(with event: NSEvent) {
        coordinator?.selectRow()
        guard let menu = coordinator?.makeMenu() else { return }
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        coordinator?.selectRow()
        return coordinator?.makeMenu()
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, window?.firstResponder !== self, !placeholderString.isEmpty else { return }
        let currentFont = font ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: currentFont,
            .foregroundColor: NSColor.placeholderTextColor
        ]
        placeholderString.draw(
            at: NSPoint(x: textContainerInset.width, y: textContainerInset.height),
            withAttributes: attributes
        )
    }
}
