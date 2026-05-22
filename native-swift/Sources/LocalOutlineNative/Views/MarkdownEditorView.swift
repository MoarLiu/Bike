import SwiftUI

struct MarkdownEditorView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                markdownToolbar
                Spacer()
                Picker("", selection: $store.markdownPaneMode) {
                    ForEach(MarkdownPaneMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 220)
            }

            Group {
                switch store.markdownPaneMode {
                case .edit:
                    editorPane
                case .preview:
                    previewPane
                case .split:
                    HStack(spacing: 0) {
                        editorPane
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                        DashedDivider()
                        previewPane
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
            }
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var editorPane: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Markdown 编辑器")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
            AppKitTextView(text: Binding(
                get: { MarkdownCodec.documentMarkdown(store.activeDocument ?? OutlineDocumentDTO()) },
                set: { store.setMarkdownSource($0) }
            ))
        }
        .padding(16)
        .frame(minWidth: 360, maxWidth: .infinity, minHeight: 520, maxHeight: .infinity)
    }

    private var previewPane: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("预览")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
            ScrollView {
                Text(MarkdownCodec.previewAttributedString(MarkdownCodec.documentMarkdown(store.activeDocument ?? OutlineDocumentDTO())))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 12)
            }
        }
        .padding(16)
        .frame(minWidth: 360, maxWidth: .infinity, minHeight: 520, maxHeight: .infinity)
    }

    private var markdownToolbar: some View {
        HStack(spacing: 6) {
            Button("H1") { prefix("# ") }
            Button("H2") { prefix("## ") }
            Button { wrap("**") } label: { Image(systemName: "bold") }
            Button { wrap("*") } label: { Image(systemName: "italic") }
            Button { prefix("> ") } label: { Image(systemName: "quote.opening") }
            Button { prefix("- ") } label: { Image(systemName: "list.bullet") }
            Button { prefix("- [ ] ") } label: { Image(systemName: "checklist") }
            Button { insert("\n| 列 A | 列 B |\n| --- | --- |\n| 内容 | 内容 |\n") } label: { Image(systemName: "tablecells") }
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    private func source() -> String {
        MarkdownCodec.documentMarkdown(store.activeDocument ?? OutlineDocumentDTO())
    }

    private func insert(_ value: String) {
        store.setMarkdownSource(source() + value)
    }

    private func prefix(_ value: String) {
        store.setMarkdownSource(source() + "\n\(value)")
    }

    private func wrap(_ marker: String) {
        store.setMarkdownSource(source() + "\(marker)文本\(marker)")
    }
}

private struct DashedDivider: View {
    var body: some View {
        GeometryReader { proxy in
            Path { path in
                path.move(to: CGPoint(x: 0.5, y: 0))
                path.addLine(to: CGPoint(x: 0.5, y: proxy.size.height))
            }
            .stroke(Color.secondary.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [5, 5]))
        }
        .frame(width: 1)
        .padding(.vertical, 12)
    }
}
