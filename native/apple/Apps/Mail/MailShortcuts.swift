import AppIntents
import SwiftUI
import ZeroMail

@MainActor
final class ComposeIntentInbox: ObservableObject {
    static let shared = ComposeIntentInbox()
    @Published private(set) var pending: MailLink?
    func submit(_ link: MailLink) { pending = link }
    func take() -> MailLink? { let link = pending; pending = nil; return link }
}

struct ComposeMailIntent: AppIntent {
    static var title: LocalizedStringResource = "在 Zero Mail 中写邮件"
    static var description = IntentDescription("打开邮件编辑器，检查内容后手动发送。")
    static var openAppWhenRun = true
    @Parameter(title: "收件人") var recipient: String?
    @Parameter(title: "主题") var subject: String?
    @Parameter(title: "正文") var text: String?
    @MainActor
    func perform() async throws -> some IntentResult {
        // Runs in the foreground app. Self-hosted domains do not have fixed universal links.
        ComposeIntentInbox.shared.submit(.compose(to: recipient ?? "", subject: subject ?? "", text: text ?? ""))
        return .result()
    }
}
struct ZeroMailShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ComposeMailIntent(), phrases: ["用 \(.applicationName) 写邮件", "Compose mail in \(.applicationName)"], shortTitle: "写邮件", systemImageName: "square.and.pencil")
    }
}
