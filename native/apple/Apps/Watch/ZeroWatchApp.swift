import SwiftUI
import ZeroMail

@main
struct ZeroWatchApp: App {
    init() { MailPreferences.registerDefaults(); _ = MailNotifications.shared }
    var body: some Scene { WindowGroup { SessionView() } }
}
