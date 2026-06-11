import SwiftUI

struct AiActionMenu: View {
    var isBusy: Bool
    var onAction: (AiNodeAction) -> Void

    var body: some View {
        Menu {
            ForEach(AiNodeAction.allCases) { action in
                Button {
                    onAction(action)
                } label: {
                    Label(action.title, systemImage: action.systemImage)
                }
            }
        } label: {
            ZStack {
                Circle()
                    .fill(isBusy ? Color.secondary.opacity(0.16) : Color.accentColor)
                Image(systemName: isBusy ? "hourglass" : "sparkles")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(isBusy ? Color.secondary : Color.white)
            }
            .frame(width: 26, height: 26)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .disabled(isBusy)
        .help(isBusy ? "AI 正在处理" : "AI 助手")
    }
}

struct AiConfigDialog: View {
    @EnvironmentObject private var store: AppStore
    @State private var draft: AiApiConfig

    init(config: AiApiConfig) {
        _draft = State(initialValue: config)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("配置API密钥")
                        .font(.title3.weight(.semibold))
                    Text("用于大纲、思维导图和 Markdown 模式的 AI 生成与润色。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    store.showAiConfigDialog = false
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
            }

            VStack(spacing: 0) {
                HStack(spacing: 16) {
                    Text("协议端点")
                        .font(.headline)
                        .frame(width: 112, alignment: .leading)
                    Picker("", selection: $draft.endpoint) {
                        ForEach(AiEndpoint.allCases) { endpoint in
                            Text(endpoint.title).tag(endpoint)
                        }
                    }
                    .labelsHidden()
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)

                Divider()

                AiConfigTextFieldRow(
                    title: "API baseurl",
                    prompt: "https://api.openai.com/v1",
                    text: $draft.baseUrl
                )

                Divider()

                AiConfigSecureFieldRow(
                    title: "API key",
                    prompt: "sk-...",
                    text: $draft.apiKey
                )

                Divider()

                AiConfigTextFieldRow(
                    title: "大模型",
                    prompt: "gpt-5.5",
                    text: $draft.model
                )
            }
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))

            HStack {
                Spacer()
                Button("取消") {
                    store.showAiConfigDialog = false
                }
                Button("保存") {
                    store.saveAiConfig(draft)
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(22)
        .frame(width: 520)
    }
}

private struct AiConfigTextFieldRow: View {
    var title: String
    var prompt: String
    @Binding var text: String

    var body: some View {
        HStack(spacing: 16) {
            Text(title)
                .frame(width: 112, alignment: .leading)
            TextField("", text: $text, prompt: Text(prompt).foregroundStyle(.secondary))
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }
}

private struct AiConfigSecureFieldRow: View {
    var title: String
    var prompt: String
    @Binding var text: String

    var body: some View {
        HStack(spacing: 16) {
            Text(title)
                .frame(width: 112, alignment: .leading)
            SecureField("", text: $text, prompt: Text(prompt).foregroundStyle(.secondary))
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }
}
