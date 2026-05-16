import AppKit
import SwiftUI

struct KeyAwareTextField: NSViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var fontSize: CGFloat = 15
    var fontWeight: NSFont.Weight = .regular
    var color: NSColor = .labelColor
    var onFocus: () -> Void = {}
    var onSubmit: () -> Void = {}
    var onTab: () -> Void = {}
    var onShiftTab: () -> Void = {}
    var onMoveUp: () -> Void = {}
    var onMoveDown: () -> Void = {}
    var onBackspaceEmpty: () -> Void = {}

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> OutlineNSTextField {
        let textField = OutlineNSTextField()
        textField.delegate = context.coordinator
        textField.isBordered = false
        textField.isBezeled = false
        textField.drawsBackground = false
        textField.focusRingType = .none
        textField.lineBreakMode = .byTruncatingTail
        textField.usesSingleLineMode = true
        textField.placeholderString = placeholder
        textField.handlers = context.coordinator
        applyStyle(to: textField)
        return textField
    }

    func updateNSView(_ textField: OutlineNSTextField, context: Context) {
        context.coordinator.parent = self
        textField.handlers = context.coordinator
        if textField.stringValue != text {
            textField.stringValue = text
        }
        textField.placeholderString = placeholder
        applyStyle(to: textField)
    }

    private func applyStyle(to textField: NSTextField) {
        textField.textColor = color
        textField.font = NSFont.systemFont(ofSize: fontSize, weight: fontWeight)
    }

    final class Coordinator: NSObject, NSTextFieldDelegate, OutlineTextFieldHandlers {
        var parent: KeyAwareTextField

        init(_ parent: KeyAwareTextField) {
            self.parent = parent
        }

        func controlTextDidBeginEditing(_ notification: Notification) {
            parent.onFocus()
        }

        func controlTextDidChange(_ notification: Notification) {
            guard let textField = notification.object as? NSTextField else { return }
            parent.text = textField.stringValue
        }

        func submit() {
            parent.onSubmit()
        }

        func tab(shift: Bool) {
            shift ? parent.onShiftTab() : parent.onTab()
        }

        func move(up: Bool) {
            up ? parent.onMoveUp() : parent.onMoveDown()
        }

        func backspaceEmpty() {
            parent.onBackspaceEmpty()
        }
    }
}

@MainActor
protocol OutlineTextFieldHandlers: AnyObject {
    func submit()
    func tab(shift: Bool)
    func move(up: Bool)
    func backspaceEmpty()
}

@MainActor
final class OutlineNSTextField: NSTextField {
    weak var handlers: OutlineTextFieldHandlers?

    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 36, 76:
            handlers?.submit()
        case 48:
            handlers?.tab(shift: event.modifierFlags.contains(.shift))
        case 126:
            handlers?.move(up: true)
        case 125:
            handlers?.move(up: false)
        case 51 where stringValue.isEmpty:
            handlers?.backspaceEmpty()
        default:
            super.keyDown(with: event)
        }
    }
}
