import AppKit
import SwiftUI

@MainActor
final class LocalOutlineAppDelegate: NSObject, NSApplicationDelegate {
    weak var store: AppStore?

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        store?.flushSaveNow()
        return .terminateNow
    }
}

@main
struct LocalOutlineNativeApp: App {
    @NSApplicationDelegateAdaptor(LocalOutlineAppDelegate.self) private var appDelegate
    @StateObject private var store = AppStore()

    init() {
        if CommandLine.arguments.contains("--self-test") {
            do {
                try SelfTestRunner.run()
                print("LocalOutlineNative self-tests passed")
                Foundation.exit(0)
            } catch {
                fputs("LocalOutlineNative self-tests failed: \(error)\n", stderr)
                Foundation.exit(1)
            }
        }
    }

    var body: some Scene {
        WindowGroup("Local Outline Native") {
            ContentView()
                .environmentObject(store)
                .frame(minWidth: 980, minHeight: 640)
                .preferredColorScheme(store.useDarkMode ? .dark : .light)
                .onAppear {
                    appDelegate.store = store
                    store.load()
                }
        }
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("新建文档") { store.createDocument() }
                    .keyboardShortcut("n", modifiers: [.command])
            }
            CommandGroup(replacing: .undoRedo) {
                Button("撤销") { store.undoDocumentCommand() }
                    .keyboardShortcut("z", modifiers: [.command])
            }
            CommandMenu("Local Outline") {
                Button("保存") { store.flushSaveNow() }
                    .keyboardShortcut("s", modifiers: [.command])
                Button("创建快照") { store.createManualSnapshot() }
                    .keyboardShortcut("s", modifiers: [.command, .shift])
                Divider()
                Button("导入...") { store.importFile() }
                    .keyboardShortcut("o", modifiers: [.command])
                Button("导出工作区...") { store.exportWorkspace() }
                Divider()
                Button("创建 JSON 备份") { store.backupToICloud() }
                Button("载入 iCloud 备份") { store.loadICloudBackup() }
                Button("打开 Markdown 目录") { LocalOutlineStorage.openDocumentsDirectoryInFinder() }
            }
            CommandMenu("大纲") {
                Button("新增同级") {
                    if let id = store.activeNodeId { store.insertAfter(id) }
                }
                .keyboardShortcut(.return, modifiers: [])
                Button("新增子级") {
                    if let id = store.activeNodeId { store.insertChild(id) }
                }
                .keyboardShortcut(.tab, modifiers: [])
                Button("提升层级") { store.outdentActive() }
                    .keyboardShortcut(.tab, modifiers: [.shift])
                Button("上移") { store.moveActive(-1) }
                    .keyboardShortcut(.upArrow, modifiers: [.command])
                Button("下移") { store.moveActive(1) }
                    .keyboardShortcut(.downArrow, modifiers: [.command])
            }
        }

        Settings {
            SettingsView()
                .environmentObject(store)
                .preferredColorScheme(store.useDarkMode ? .dark : .light)
        }
    }
}
