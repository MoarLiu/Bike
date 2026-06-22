import BikeCore
import SwiftUI

struct SyncSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: BikeAppStore

    @State private var serverUrl: String
    @State private var token: String
    @State private var autoSync: Bool
    @State private var intervalText: String

    init(store: BikeAppStore) {
        self.store = store
        let config = store.syncConfig
        _serverUrl = State(initialValue: config.serverUrl)
        _token = State(initialValue: config.token)
        _autoSync = State(initialValue: config.autoSync)
        _intervalText = State(initialValue: "\(config.autoSyncIntervalSeconds)")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("服务") {
                    TextField("https://bike.example.com", text: $serverUrl)
                        .autocorrectionDisabled()
                    SecureField("设备同步密钥", text: $token)
                        .autocorrectionDisabled()
                }

                Section("自动同步") {
                    Toggle("后台自动同步", isOn: $autoSync)
                    HStack {
                        TextField("60", text: $intervalText)
                            .disabled(!autoSync)
                        Text("秒")
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    Button(store.isSyncing ? "同步中..." : "立即同步") {
                        save()
                        store.syncNow()
                    }
                    .disabled(store.isSyncing || !canSave)
                    Button("上传本机到 Web") {
                        save()
                        store.pushLocalWorkspace()
                    }
                    .disabled(store.isSyncing || !canSave)
                    Button("从 Web 拉取") {
                        save()
                        store.pullRemoteWorkspace()
                    }
                    .disabled(store.isSyncing || !canSave)
                }

                if let lastSyncedAt = store.syncState.lastSyncedAt {
                    Section("状态") {
                        Text("上次同步：\(format(lastSyncedAt))\(store.syncConfig.autoSync ? " · 自动" : "")")
                    }
                }
            }
            .navigationTitle("Web Sync")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        if save() { dismiss() }
                    }
                    .disabled(!canSave)
                }
            }
        }
    }

    private var canSave: Bool {
        SyncConfig.validationMessage(for: draft) == nil
    }

    private var draft: SyncConfig {
        SyncConfig(
            serverUrl: serverUrl,
            token: token,
            autoSync: autoSync,
            autoSyncIntervalSeconds: SyncConfig.normalizeAutoSyncInterval(
                Int(intervalText) ?? SyncConfig.defaultAutoSyncIntervalSeconds
            )
        )
    }

    @discardableResult
    private func save() -> Bool {
        store.saveSyncConfig(draft)
    }

    private func format(_ iso: String) -> String {
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = isoFormatter.date(from: iso) else { return "时间未知" }
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}
