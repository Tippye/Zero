import SwiftUI

@main
struct ZeroMailApp: App {
    var body: some Scene {
        WindowGroup { SessionView() }
        #if os(macOS)
            .commands { MailCommands() }
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
            Button("设置与设备") { store?.showSettings = true }.keyboardShortcut(",").disabled(store?.phase != .ready)
        }
    }
}
#endif
