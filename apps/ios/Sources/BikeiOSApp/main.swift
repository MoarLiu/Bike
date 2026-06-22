import SwiftUI

struct BikeiOSApp: App {
    @StateObject private var store = BikeAppStore()

    var body: some Scene {
        WindowGroup {
            AppRootView(store: store)
        }
    }
}

BikeiOSApp.main()

struct AppRootView: View {
    @ObservedObject var store: BikeAppStore
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            LibraryView(store: store, path: $path)
                .navigationDestination(for: String.self) { documentId in
                    EditorView(store: store, documentId: documentId)
                }
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $store.showAISettings) {
            AISettingsView(store: store)
        }
        .sheet(isPresented: $store.showSyncSettings) {
            SyncSettingsView(store: store)
        }
        .task {
            if store.payload == nil {
                store.load()
            }
        }
    }
}
