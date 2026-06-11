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
    var toggleStrike: () -> Void
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
    var isActive: Bool
    var forceRefreshToken: Int
    var focusRequestToken: Int
    var shouldHandleFocusRequest: Bool
    var onFocusHandled: () -> Void
    var onSubmit: () -> Void
    var onIndent: () -> Void
    var onOutdent: () -> Void
    var onMoveUp: () -> Void
    var onMoveDown: () -> Void
    var onSelect: () -> Void
    var onUndo: () -> Void
    var onEditingEnded: () -> Void
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
        view.textContainer?.lineBreakMode = .byWordWrapping
        view.textContainer?.maximumNumberOfLines = 0
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
        let shouldForceRefresh = context.coordinator.shouldForceRefresh(for: forceRefreshToken)
        if nsView.string != text, !context.coordinator.isEditing || shouldForceRefresh {
            context.coordinator.isApplyingExternalText = true
            nsView.string = text
            context.coordinator.isApplyingExternalText = false
        }
        applyStyle(to: nsView, context: context)
        nsView.placeholderString = placeholder
        nsView.needsDisplay = true
        
        if isActive && shouldHandleFocusRequest && context.coordinator.shouldFocus(for: focusRequestToken) {
            DispatchQueue.main.async {
                if nsView.window?.firstResponder !== nsView {
                    nsView.window?.makeFirstResponder(nsView)
                }
                nsView.setSelectedRange(NSRange(location: (nsView.string as NSString).length, length: 0))
                context.coordinator.parent.onFocusHandled()
            }
        }
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
        var isApplyingExternalText = false
        private var lastAppliedRefreshToken: Int
        private var lastHandledFocusToken: Int

        init(parent: OutlineNodeTextEditor, text: Binding<String>) {
            self.parent = parent
            _text = text
            lastAppliedRefreshToken = parent.forceRefreshToken
            lastHandledFocusToken = 0
        }

        func update(_ parent: OutlineNodeTextEditor) {
            self.parent = parent
        }

        func shouldForceRefresh(for token: Int) -> Bool {
            guard token != lastAppliedRefreshToken else { return false }
            lastAppliedRefreshToken = token
            return true
        }

        func shouldFocus(for token: Int) -> Bool {
            guard token != lastHandledFocusToken else { return false }
            lastHandledFocusToken = token
            return true
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
            menu.addItem(item("删除线", #selector(toggleStrike)))

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

        @objc private func toggleStrike() {
            parent.menuActions.toggleStrike()
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
            if let view = notification.object as? NSTextView {
                text = view.string
                view.needsDisplay = true
            }
            parent.onEditingEnded()
        }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            guard !isApplyingExternalText else { return }
            guard !view.hasMarkedText() else {
                view.invalidateIntrinsicContentSize()
                view.needsDisplay = true
                return
            }
            text = view.string
            view.invalidateIntrinsicContentSize()
            view.needsDisplay = true
        }

        func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            if textView.hasMarkedText() {
                return false
            }
            if commandSelector == #selector(NSResponder.insertNewline(_:)) {
                if let event = NSApp.currentEvent, event.modifierFlags.contains(.shift) {
                    textView.insertNewlineIgnoringFieldEditor(nil)
                    textView.invalidateIntrinsicContentSize()
                    return true
                } else {
                    text = textView.string
                    submit()
                    return true
                }
            }
            if commandSelector == #selector(NSResponder.insertTab(_:)) {
                text = textView.string
                parent.onIndent()
                return true
            }
            if commandSelector == #selector(NSResponder.insertBacktab(_:)) {
                text = textView.string
                parent.onOutdent()
                return true
            }
            if commandSelector == #selector(NSResponder.moveUp(_:)) {
                guard let layoutManager = textView.layoutManager else { return false }
                let selectedRange = textView.selectedRange()
                let stringLength = (textView.string as NSString).length
                guard layoutManager.numberOfGlyphs > 0, stringLength > 0 else { return false }
                let characterIndex = min(max(0, selectedRange.location), stringLength - 1)
                let glyphIndex = min(layoutManager.glyphIndexForCharacter(at: characterIndex), layoutManager.numberOfGlyphs - 1)
                let lineRect = layoutManager.lineFragmentRect(forGlyphAt: glyphIndex, effectiveRange: nil)
                let firstLineRect = layoutManager.lineFragmentRect(forGlyphAt: 0, effectiveRange: nil)
                if lineRect.origin.y == firstLineRect.origin.y {
                    text = textView.string
                    parent.onMoveUp()
                    return true
                }
            }
            if commandSelector == #selector(NSResponder.moveDown(_:)) {
                guard let layoutManager = textView.layoutManager else { return false }
                let selectedRange = textView.selectedRange()
                let totalGlyphs = layoutManager.numberOfGlyphs
                let stringLength = (textView.string as NSString).length
                guard totalGlyphs > 0, stringLength > 0 else { return false }
                let characterIndex = min(max(0, selectedRange.location), stringLength - 1)
                let glyphIndex = min(layoutManager.glyphIndexForCharacter(at: characterIndex), totalGlyphs - 1)
                let lineRect = layoutManager.lineFragmentRect(forGlyphAt: glyphIndex, effectiveRange: nil)
                let lastGlyphIndex = totalGlyphs > 0 ? totalGlyphs - 1 : 0
                let lastLineRect = layoutManager.lineFragmentRect(forGlyphAt: lastGlyphIndex, effectiveRange: nil)
                if lineRect.origin.y == lastLineRect.origin.y {
                    text = textView.string
                    parent.onMoveDown()
                    return true
                }
            }
            if NSStringFromSelector(commandSelector) == "undo:" {
                text = textView.string
                parent.onUndo()
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
        guard let layoutManager = layoutManager, let textContainer = textContainer else {
            return super.intrinsicContentSize
        }
        layoutManager.ensureLayout(for: textContainer)
        let usedRect = layoutManager.usedRect(for: textContainer)
        let fontHeight = font?.pointSize ?? 14
        let padding: CGFloat = 8
        let height = max(fontHeight + padding, ceil(usedRect.height) + textContainerInset.height * 2)
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

    override func keyDown(with event: NSEvent) {
        let modifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
        if event.charactersIgnoringModifiers?.lowercased() == "z", modifiers == .command {
            coordinator?.parent.onUndo()
            return
        }
        super.keyDown(with: event)
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
