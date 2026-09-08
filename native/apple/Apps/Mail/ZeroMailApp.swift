import SwiftUI
import ZeroMail

@main
struct ZeroMailApp: App {
    init() { MailPreferences.registerDefaults(); _ = MailNotifications.shared }
    var body: some Scene {
        WindowGroup { SessionView() }
        #if os(macOS)
            .commands { MailCommands() }
        #endif
        #if os(macOS)
        Settings { MacSettingsView() }
            .windowResizability(.contentSize)
        #endif
    }
}

#if os(macOS)
struct MailCommands: Commands {
    @FocusedValue(\.mailStore) private var store
    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("写邮件") { store?.compose() }.keyboardShortcut("n").disabled(store?.phase != .ready)
        }
        CommandMenu("邮件") {
            Button("刷新") { Task { await store?.refresh() } }.keyboardShortcut("r").disabled(store?.phase != .ready)
            Button("归档") { if let id = store?.selectedID { Task { await store?.act(.archive, id: id) } } }.keyboardShortcut("e").disabled(store?.detail == nil)
        }
    }
}
#endif
