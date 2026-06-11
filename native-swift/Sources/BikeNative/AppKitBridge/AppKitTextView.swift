import AppKit
import SwiftUI

struct AppKitTextView: NSViewRepresentable {
    @Binding var text: String
    var forceRefreshToken: Int = 0
    var onUndoShortcut: (() -> Void)?
    var onEditingEnded: (() -> Void)?

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.borderType = .noBorder
        scroll.drawsBackground = true
        scroll.backgroundColor = .textBackgroundColor
        scroll.autohidesScrollers = true

        let textView = PlainTextView()
        textView.onUndoShortcut = onUndoShortcut
        textView.isRichText = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.drawsBackground = true
        textView.backgroundColor = .textBackgroundColor
        textView.font = NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)
        textView.string = text
        textView.delegate = context.coordinator
        textView.textContainerInset = NSSize(width: 16, height: 16)
        textView.minSize = NSSize(width: 0, height: scroll.contentSize.height)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.containerSize = NSSize(width: scroll.contentSize.width, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true

        scroll.documentView = textView
        return scroll
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        context.coordinator.forceRefreshToken = forceRefreshToken
        context.coordinator.onEditingEnded = onEditingEnded
        if let plainTextView = nsView.documentView as? PlainTextView {
            plainTextView.onUndoShortcut = onUndoShortcut
        }
        guard
            let textView = nsView.documentView as? NSTextView,
            textView.string != text
        else { return }

        if context.coordinator.isEditing, !context.coordinator.shouldForceRefresh(for: forceRefreshToken) {
            return
        }
        context.coordinator.isApplyingExternalText = true
        textView.string = text
        context.coordinator.isApplyingExternalText = false
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text, forceRefreshToken: forceRefreshToken, onEditingEnded: onEditingEnded)
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding var text: String
        var isEditing = false
        var isApplyingExternalText = false
        var forceRefreshToken: Int
        var onEditingEnded: (() -> Void)?
        private var lastAppliedRefreshToken: Int

        init(text: Binding<String>, forceRefreshToken: Int, onEditingEnded: (() -> Void)?) {
            _text = text
            self.forceRefreshToken = forceRefreshToken
            self.onEditingEnded = onEditingEnded
            lastAppliedRefreshToken = forceRefreshToken
        }

        func shouldForceRefresh(for token: Int) -> Bool {
            guard token != lastAppliedRefreshToken else { return false }
            lastAppliedRefreshToken = token
            return true
        }

        func textDidBeginEditing(_ notification: Notification) {
            isEditing = true
        }

        func textDidEndEditing(_ notification: Notification) {
            isEditing = false
            onEditingEnded?()
        }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            guard !isApplyingExternalText else { return }
            text = view.string
        }
    }
}

final class PlainTextView: NSTextView {
    var onUndoShortcut: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        let modifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
        if event.charactersIgnoringModifiers?.lowercased() == "z", modifiers == .command {
            onUndoShortcut?()
            return
        }
        super.keyDown(with: event)
    }
}
