import BikeCore
import SwiftUI

struct AISettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: BikeAppStore

    @State private var endpoint: AiEndpoint
    @State private var baseUrl: String
    @State private var apiKey: String
    @State private var model: String

    init(store: BikeAppStore) {
        self.store = store
        let settings = store.aiSettings
        _endpoint = State(initialValue: settings.endpoint)
        _baseUrl = State(initialValue: settings.baseUrl)
        _apiKey = State(initialValue: settings.apiKey)
        _model = State(initialValue: settings.model)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("服务") {
                    Picker("协议", selection: $endpoint) {
                        ForEach(AiEndpoint.allCases) { endpoint in
                            Text(endpoint.title).tag(endpoint)
                        }
                    }
                    TextField("Base URL", text: $baseUrl)
                        .autocorrectionDisabled()
                    TextField("模型", text: $model)
                        .autocorrectionDisabled()
                }

                Section("密钥") {
                    SecureField("API Key", text: $apiKey)
                        .autocorrectionDisabled()
                }
            }
            .navigationTitle("AI 设置")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        let didSave = store.saveAISettings(AiSettings(
                            endpoint: endpoint,
                            baseUrl: baseUrl,
                            apiKey: apiKey,
                            model: model
                        ))
                        if didSave {
                            dismiss()
                        }
                    }
                    .disabled(!canSave)
                }
            }
        }
    }

    private var canSave: Bool {
        !baseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
