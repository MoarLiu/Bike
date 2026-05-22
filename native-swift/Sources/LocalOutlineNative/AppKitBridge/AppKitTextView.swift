import AppKit
import SwiftUI

struct AppKitTextView: NSViewRepresentable {
    @Binding var text: String

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.borderType = .noBorder
        scroll.drawsBackground = true
        scroll.backgroundColor = .textBackgroundColor
        scroll.autohidesScrollers = true

        let textView = NSTextView()
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
        guard
            let textView = nsView.documentView as? NSTextView,
            textView.string != text,
            !context.coordinator.isEditing
        else { return }

        textView.string = text
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding var text: String
        var isEditing = false

        init(text: Binding<String>) {
            _text = text
        }

        func textDidBeginEditing(_ notification: Notification) {
            isEditing = true
        }

        func textDidEndEditing(_ notification: Notification) {
            isEditing = false
        }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            text = view.string
        }
    }
}
