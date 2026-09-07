import SwiftUI
import ZeroMail
import ZeroPairing
#if os(iOS)
import UIKit
#endif

@MainActor
final class MailStore: ObservableObject {
    enum Phase: Equatable { case server, connecting, pairing, ready }
    @Published var phase: Phase = .server
    @Published var serverText = UserDefaults.standard.string(forKey: "zero.server") ?? ""
    @Published var deviceName: String = {
        #if os(macOS)
        return "Mac"
        #elseif os(watchOS)
        return "Apple Watch"
        #else
        return UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        #endif
    }()
    @Published var accounts: [MailAccount] = []
    @Published var accountID = ""
    @Published var folder: MailFolder = .inbox
    @Published var query = ""
    @Published var threads: [MailSummary] = []
    @Published var warnings: [MailWarning] = []
    @Published var selectedID: String?
    @Published var detail: MailThread?
    @Published var loading = false
    @Published var reading = false
    @Published var error: String?
    @Published var composer: MailComposer?
    @Published var showSettings = false
    @Published var cursor: String?
    private(set) var client: MailClient?
    var pairing: PairingClient? { client?.pairing }
    private var listRevision = 0
    private var sessionRevision = 0
    private var readRevision = 0
    private var started = false
    private var mailboxVisible = false
    private var pendingLink: MailLink?
    var filterKey: String { accountID + "|" + folder.rawValue + "|" + query }

    func start() async {
        guard !started else { return }; started = true
        if !serverText.isEmpty { await connect() }
    }
    func connect() async {
        clearSession(); phase = .connecting
        do {
            guard let url = URL(string: serverText.trimmingCharacters(in: .whitespacesAndNewlines)) else { throw PairingFailure.invalidServer }
            let pairing = try PairingClient(server: url)
            client = MailClient(pairing: pairing)
            serverText = pairing.server.absoluteString
            UserDefaults.standard.set(serverText, forKey: "zero.server")
            if try await pairing.hasCredential() { await authorized() }
            else { phase = .pairing }
        } catch { phase = .server; report(error) }
    }
    func authorized() async {
        guard let client else { return }
        let revision = sessionRevision
        do {
            let loaded = try await client.accounts()
            guard revision == sessionRevision else { return }
            accounts = loaded; phase = .ready
        } catch {
            guard revision == sessionRevision else { return }
            // A temporary mailbox outage does not discard a valid pairing.
            phase = .ready; report(error)
        }
    }
    func reload(more: Bool = false) async {
        guard let client, phase == .ready, !more || (!loading && cursor != nil) else { return }
        listRevision += 1
        let revision = listRevision, session = sessionRevision
        let account = accountID.isEmpty ? nil : accountID, folder = folder, query = query
        let next = more ? cursor : nil
        loading = true
        defer { if revision == listRevision { loading = false } }
        do {
            let page = try await client.threads(accountID: account, folder: folder, query: query, cursor: next)
            guard revision == listRevision, session == sessionRevision, !Task.isCancelled else { return }
            if more {
                var seen = Set(threads.map(\.id)); threads += page.threads.filter { seen.insert($0.id).inserted }
            } else { threads = page.threads }
            cursor = page.cursor; warnings = page.warnings
        } catch { if revision == listRevision, session == sessionRevision { report(error) } }
    }
    func changeFilter() {
        listRevision += 1; readRevision += 1
        threads = []; detail = nil; selectedID = nil; cursor = nil; warnings = []; loading = false; reading = false
    }
    func open(id: String) async {
        guard let client else { return }
        if let summary = threads.first(where: { $0.id == id }), summary.isDraft { await editDraft(summary); return }
        selectedID = id; detail = nil; reading = true; readRevision += 1
        let revision = readRevision, session = sessionRevision
        defer { if revision == readRevision { reading = false } }
        do {
            let thread = try await client.thread(id: id)
            guard revision == readRevision, session == sessionRevision, !Task.isCancelled else { return }
            detail = thread
            if thread.unread {
                try await client.action(.read, ids: [id])
                guard session == sessionRevision else { return }
                await reload()
            }
        } catch { if revision == readRevision, session == sessionRevision { report(error) } }
    }
    func act(_ action: MailClient.Action, id: String) async {
        guard let client else { return }; let session = sessionRevision
        do {
            try await client.action(action, ids: [id])
            guard session == sessionRevision else { return }
            if action == .trash || action == .archive { detail = nil; selectedID = nil; readRevision += 1 }
            else if selectedID == id {
                let updated = try await client.thread(id: id)
                guard session == sessionRevision, selectedID == id else { return }
                detail = updated
            }
            await reload()
        } catch { if session == sessionRevision { report(error) } }
    }
    func refresh() async {
        guard let client else { return }; let session = sessionRevision
        do {
            let loaded = try await client.accounts()
            guard session == sessionRevision else { return }; accounts = loaded
            try await client.sync(accountID: accountID.isEmpty ? nil : accountID)
        } catch { if session == sessionRevision { report(error) } }
        await reload()
    }
    func compose() {
        guard composer == nil else { return }
        guard let account = accounts.first(where: { $0.connected && $0.id == accountID }) ?? accounts.first(where: \.connected) else { error = "请先在网页设置中连接邮箱，再刷新。"; return }
        composer = MailComposer(accountId: account.id)
    }
    func reply(_ message: MailMessage, all: Bool = false, forward: Bool = false) {
        guard let detail, composer == nil,
              let account = accounts.first(where: { $0.id == threads.first(where: { $0.id == detail.id })?.accountId }) ?? accounts.first(where: { message.to.map(\.email).contains($0.email) }) else { error = "请先在对应邮箱中打开这封邮件。"; return }
        if forward {
            var draft = MailComposer(accountId: account.id); draft.subject = "Fwd: " + message.subject
            draft.text = "\n\n---------- 转发邮件 ----------\n" + message.sender.display + "\n" + message.text
            // Attachments are explicitly selected by the user, never silently forwarded.
            composer = draft
        } else { composer = MailComposer.reply(to: message, threadID: detail.id, account: account, all: all) }
    }
    func editDraft(_ summary: MailSummary) async {
        guard let client, composer == nil else { return }; let session = sessionRevision
        do {
            let saved = try await client.draft(id: summary.id)
            var draft = MailComposer(accountId: summary.accountId)
            draft.draftId = saved.id; draft.to = (saved.to ?? []).joined(separator: ", ")
            draft.cc = (saved.cc ?? []).joined(separator: ", "); draft.bcc = (saved.bcc ?? []).joined(separator: ", ")
            draft.subject = saved.subject ?? ""; draft.text = saved.text
            draft.originalText = saved.text; draft.originalHTML = saved.content
            draft.attachments = try (saved.attachments ?? []).map { try OutgoingAttachment(name: $0.safeFilename, type: $0.mimeType, data: $0.decodedData()) }
            guard session == sessionRevision else { return }; composer = draft
        } catch { if session == sessionRevision { report(error) } }
    }
    func handle(_ link: MailLink) {
        guard phase == .ready, mailboxVisible else { pendingLink = link; return }
        switch link {
        case let .thread(server, id):
            guard server == pairing?.server else { error = "这封邮件属于其他服务器。请先在设置中切换并配对。"; return }
            Task { await open(id: id) }
        case let .compose(to, subject, text):
            guard composer == nil else { error = "请先保存或关闭当前草稿。"; return }
            compose(); composer?.to = to; composer?.subject = subject; composer?.text = text
        }
    }
    func mailboxDidLoad() {
        guard phase == .ready, !Task.isCancelled else { return }
        mailboxVisible = true
        if let link = pendingLink { pendingLink = nil; handle(link) }
    }
    func signOut() async {
        let old = pairing; clearSession(); phase = .server
        do { try await old?.signOut() } catch { self.error = "本机凭据已清除。服务器暂时无法连接，可在其他设备撤销此会话。" }
    }
    func report(_ failure: Error) {
        if failure is CancellationError { return }
        if let pairing = failure as? PairingFailure {
            switch pairing {
            case .signedOut: clearSession(); phase = client == nil ? .server : .pairing; error = "登录已过期或设备已被撤销，请重新配对。"
            case .invalidServer: error = "请输入服务器的 HTTPS 地址，不包含路径、用户名或密码。"
            case .credentialStorage: error = "无法访问设备钥匙串，请解锁设备后重试。"
            case .server(let code): error = "请求未完成（\(code)），请重试或检查邮箱连接。"
            default: error = "服务器返回了无法识别的数据。"
            }
        } else { error = (failure as? LocalizedError)?.errorDescription ?? "无法连接服务器，请检查网络后重试。" }
    }
    private func clearSession() {
        sessionRevision += 1; listRevision += 1; readRevision += 1
        mailboxVisible = false
        accounts = []; threads = []; warnings = []; selectedID = nil; detail = nil; composer = nil
        accountID = ""; query = ""; folder = .inbox; cursor = nil; loading = false; reading = false; showSettings = false
    }
}
