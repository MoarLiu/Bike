import SwiftUI

@main
struct LocalOutlineNativeApp: App {
    @StateObject private var store = WorkspaceStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .frame(minWidth: 1040, minHeight: 680)
        }
        .commands {
            CommandMenu("大纲") {
                Button("新增同级") {
                    if let id = store.activeNodeId { store.insertAfter(id) }
                }
                .keyboardShortcut(.return, modifiers: [])

                Button("新增子级") {
                    if let id = store.activeNodeId { store.insertChild(id) }
                }
                .keyboardShortcut(.tab, modifiers: [])

                Button("上移") {
                    if let id = store.activeNodeId { store.moveNode(id, direction: -1) }
                }
                .keyboardShortcut(.upArrow, modifiers: [.command])

                Button("下移") {
                    if let id = store.activeNodeId { store.moveNode(id, direction: 1) }
                }
                .keyboardShortcut(.downArrow, modifiers: [.command])
            }

            CommandMenu("数据") {
                Button("导入工作区 JSON...") {
                    store.importWorkspaceJSON()
                }
                Button("导出工作区 JSON...") {
                    store.exportWorkspaceJSON()
                }
                Divider()
                Button("备份到 iCloud Drive") {
                    store.backupToICloudDrive()
                }
                Button("载入 iCloud Drive 备份") {
                    store.loadICloudBackup()
                }
            }
        }
    }
}
