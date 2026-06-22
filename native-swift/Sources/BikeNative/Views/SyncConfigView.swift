import SwiftUI

struct SyncConfigDialog: View {
    @EnvironmentObject private var store: AppStore
    @State private var draft: SyncConfig
    @State private var intervalText: String

    init(config: SyncConfig) {
        _draft = State(initialValue: config)
        _intervalText = State(initialValue: "\(config.autoSyncIntervalSeconds)")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Web Sync")
                        .font(.title3.weight(.semibold))
                    Text(statusText)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    store.showSyncConfigDialog = false
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
            }

            VStack(spacing: 0) {
                SyncConfigTextFieldRow(
                    title: "Web 地址",
                    prompt: "https://bike.example.com",
                    text: $draft.serverUrl
                )

                Divider()

                SyncConfigSecureFieldRow(
                    title: "设备密钥",
                    prompt: "同步密钥",
                    text: $draft.token
                )

                Divider()

                Toggle("后台自动同步", isOn: Binding(
                    get: { draft.autoSync },
                    set: { draft.autoSync = $0 }
                ))
                .padding(.horizontal, 14)
                .padding(.vertical, 11)

                Divider()

                HStack(spacing: 16) {
                    Text("同步间隔")
                        .frame(width: 92, alignment: .leading)
                    TextField("60", text: $intervalText)
                        .textFieldStyle(.roundedBorder)
                        .disabled(!draft.autoSync)
                    Text("秒")
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
            }
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))

            HStack(spacing: 8) {
                Button("拉取") {
                    draft.autoSyncIntervalSeconds = normalizedInterval
                    store.saveSyncConfigAndPull(draft)
                }
                .disabled(store.isSyncing)
                Button("上传") {
                    draft.autoSyncIntervalSeconds = normalizedInterval
                    store.saveSyncConfigAndPush(draft)
                }
                .disabled(store.isSyncing)
                Spacer()
                Button("取消") {
                    store.showSyncConfigDialog = false
                }
                Button("保存") {
                    draft.autoSyncIntervalSeconds = normalizedInterval
                    store.saveSyncConfig(draft)
                }
                .disabled(store.isSyncing)
                Button(store.isSyncing ? "同步中..." : "保存并同步") {
                    draft.autoSyncIntervalSeconds = normalizedInterval
                    store.saveSyncConfigAndSync(draft)
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.isSyncing)
            }
        }
        .padding(22)
        .frame(width: 540)
    }

    private var statusText: String {
        if store.isSyncing { return "正在同步..." }
        if let lastSyncedAt = store.syncState.lastSyncedAt {
            return "上次同步：\(format(lastSyncedAt))"
        }
        return draft.serverUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "尚未配置" : "尚未同步"
    }

    private var normalizedInterval: Int {
        SyncConfig.normalizeAutoSyncInterval(Int(intervalText) ?? SyncConfig.defaultAutoSyncIntervalSeconds)
    }

    private func format(_ iso: String) -> String {
        guard let date = ISO8601DateFormatter.bike.date(from: iso) else { return "时间未知" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

private struct SyncConfigTextFieldRow: View {
    var title: String
    var prompt: String
    @Binding var text: String

    var body: some View {
        HStack(spacing: 16) {
            Text(title)
                .frame(width: 92, alignment: .leading)
            TextField("", text: $text, prompt: Text(prompt).foregroundStyle(.secondary))
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }
}

private struct SyncConfigSecureFieldRow: View {
    var title: String
    var prompt: String
    @Binding var text: String

    var body: some View {
        HStack(spacing: 16) {
            Text(title)
                .frame(width: 92, alignment: .leading)
            SecureField("", text: $text, prompt: Text(prompt).foregroundStyle(.secondary))
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }
}
