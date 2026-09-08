import SwiftUI
import ZeroMail
import ZeroPairing
#if os(iOS)
import UIKit
#endif

@MainActor
final class MailStore: ObservableObject {
    private final class Window { weak var store: MailStore?; init(_ store: MailStore) { self.store = store } }
    private static var windows: [Window] = []
    private let recoveryOwner = DraftRecoveryLeaseOwner()
    init() {
        MailPreferences.registerDefaults()
        preferences = MailPreferences()
        Self.windows.removeAll { $0.store == nil }
        Self.windows.append(Window(self))
    }
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
    @Published private(set) var preferences = MailPreferences()
    @Published var pendingTrashID: String?
    private var pendingTrashRevision: Int?
    @Published var composer: MailComposer? {
        didSet {
            guard oldValue?.id != composer?.id, let server = pairing?.server else { return }
            if let oldValue {
                DraftRecoveryLeases.shared.release(oldValue.id, server: server, owner: recoveryOwner)
                if let sharedID = oldValue.sharedImportID { EcosystemBridge.shared.release(sharedID, owner: recoveryOwner) }
            }
            if let composer { _ = DraftRecoveryLeases.shared.claim(composer.id, server: server, owner: recoveryOwner) }
            Self.hideClaimedDrafts()
        }
    }
    @Published var sharedDraftOffer: SharedMailDraft?
    @Published var showSettings = false
    @Published var recoverableDrafts: [RecoveredDraft] = []
    @Published var showDraftRecovery = false
    @Published var recoveryFailure: String?
    private var validatedRecoveryOrigin: URL?
    private var offeredDraftRecovery = false
    private var pendingRecoveredDraft: RecoveredDraft?
    @Published var cursor: String?
    private(set) var client: MailClient?
    var pairing: PairingClient? { client?.pairing }
    private var listRevision = 0
    private var sessionRevision = 0
    private var readRevision = 0
    private var started = false
    private var mailboxVisible = false
    private var sceneActive = false
    private var polling: Task<Void, Never>?
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
            let pairing = try PairingClient(server: url, allowHTTP: PairingClient.allowsDevelopmentHTTP(url))
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
            accounts = loaded; validatedRecoveryOrigin = client.pairing.server
            phase = .ready; refreshDraftRecovery(); updatePolling()
        } catch {
            guard revision == sessionRevision else { return }
            // A temporary mailbox outage does not discard a valid pairing.
            phase = .ready; report(error); updatePolling()
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
            if thread.unread, preferences.markReadOnOpen {
                try await client.action(.read, ids: [id])
                guard session == sessionRevision else { return }
                await reload()
            }
        } catch { if revision == readRevision, session == sessionRevision { report(error) } }
    }
    func act(_ action: MailClient.Action, id: String) async {
        if action == .trash, preferences.confirmBeforeTrash {
            pendingTrashRevision = sessionRevision
            pendingTrashID = id
            return
        }
        await performAction(action, id: id)
    }
    func confirmTrash(id: String) async {
        guard pendingTrashRevision == sessionRevision, phase == .ready else { return }
        pendingTrashRevision = nil
        pendingTrashID = nil
        await performAction(.trash, id: id)
    }
    private func performAction(_ action: MailClient.Action, id: String) async {
        guard let client else { return }; let session = sessionRevision
        do {
            try await client.action(action, ids: [id])
            guard session == sessionRevision else { return }
            if action == .trash || action == .archive {
                if selectedID == id { detail = nil; selectedID = nil; readRevision += 1 }
            }
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
            validatedRecoveryOrigin = client.pairing.server; refreshDraftRecovery()
            try await client.sync(accountID: accountID.isEmpty ? nil : accountID)
        } catch { if session == sessionRevision { report(error) } }
        await reload()
    }
    func sceneChanged(active: Bool) {
        sceneActive = active
        updatePolling()
        if active {
            refreshPreferences()
            Task { await MailNotifications.shared.refreshPermission() }
            offerSharedDraft()
        }
    }
    func refreshPreferences() {
        let updated = MailPreferences()
        if preferences != updated { preferences = updated }
        MailNotifications.shared.refreshPreferences()
    }
    func stopPolling() { polling?.cancel(); polling = nil }
    private func updatePolling() {
        #if os(macOS)
        let shouldPoll = phase == .ready
        #else
        let shouldPoll = phase == .ready && sceneActive
        #endif
        guard shouldPoll else { stopPolling(); return }
        guard polling == nil else { return }
        polling = Task { [weak self] in
            while !Task.isCancelled {
                await self?.pollInbox()
                do {
                    #if os(watchOS)
                    try await Task.sleep(nanoseconds: 60_000_000_000)
                    #else
                    try await Task.sleep(nanoseconds: 30_000_000_000)
                    #endif
                } catch { return }
            }
        }
    }
    private func pollInbox() async {
        guard let client, phase == .ready, !Task.isCancelled else { return }
        let session = sessionRevision, server = client.pairing.server
        do {
            let loaded = try await client.accounts()
            guard session == sessionRevision, !Task.isCancelled else { return }
            accounts = loaded
            if validatedRecoveryOrigin == nil {
                validatedRecoveryOrigin = client.pairing.server
                refreshDraftRecovery()
            }
            let connected = loaded.filter(\.connected)
            var recentUnread = 0
            var partialSnapshot = false
            do { try await MailNotifications.shared.poll(client: client, accountIDs: Set(connected.map(\.id))) }
            catch {
                guard session == sessionRevision, !Task.isCancelled else { return }
                if let failure = error as? PairingFailure, failure == .signedOut { throw failure }
            }
            for account in connected {
                do {
                    let page = try await client.threads(accountID: account.id, folder: .inbox)
                    guard session == sessionRevision, !Task.isCancelled else { return }
                    recentUnread += page.threads.filter { $0.accountId == account.id && $0.unread && !$0.isDraft }.count
                    partialSnapshot = partialSnapshot || page.cursor != nil || !page.warnings.isEmpty
                } catch {
                    guard session == sessionRevision, !Task.isCancelled else { return }
                    if let failure = error as? PairingFailure, failure == .signedOut { throw failure }
                    partialSnapshot = true
                    // A failed provider must not stop checks for the other connected accounts.
                }
            }
            guard session == sessionRevision, !Task.isCancelled else { return }
            EcosystemBridge.shared.publish(MailWidgetSnapshot(paired: true, connectedAccounts: connected.count, recentUnread: recentUnread, partial: partialSnapshot, checkedAt: Date()))
            if sceneActive, !loading { await reload() }
        } catch {
            guard session == sessionRevision, !Task.isCancelled else { return }
            // Transient polling failures are quiet. A revoked credential must immediately stop the session.
            if let failure = error as? PairingFailure, failure == .signedOut { report(failure) }
        }
    }
    func receiveNotification() {
        guard phase == .ready, let server = pairing?.server,
              let destination = MailNotifications.shared.take(for: server) else { return }
        guard accounts.contains(where: { $0.id == destination.accountID && $0.connected }) else {
            error = "此通知所属的邮箱已断开连接，请检查网页中的邮箱设置。"; return
        }
        handle(destination.link)
    }
    func offerSharedDraft() {
        #if !os(watchOS)
        guard phase == .ready, mailboxVisible, composer == nil, sharedDraftOffer == nil,
              recoverableDrafts.isEmpty, !showDraftRecovery, accounts.contains(where: \.connected) else { return }
        if let server = pairing?.server { sharedDraftOffer = try? EcosystemBridge.shared.nextShare(server: server) }
        #endif
    }
    func importSharedDraft(_ shared: SharedMailDraft) {
        guard phase == .ready, composer == nil, let server = pairing?.server,
              let account = accounts.first(where: { $0.connected && $0.id == accountID }) ?? accounts.first(where: \.connected) else { return }
        do {
            var draft = try shared.composer(accountID: account.id)
            guard EcosystemBridge.shared.claim(shared.id, server: server, owner: recoveryOwner) else { sharedDraftOffer = nil; return }
            draft.sharedImportID = shared.id
            composer = draft; sharedDraftOffer = nil
        } catch { report(error) }
    }
    func deferSharedDraft() {
        if let sharedDraftOffer { EcosystemBridge.shared.deferShare(sharedDraftOffer.id) }
        sharedDraftOffer = nil
    }
    func acknowledgeSharedComposer(_ draft: MailComposer) {
        if let id = draft.sharedImportID { EcosystemBridge.shared.acknowledge(id) }
    }
    func compose() {
        guard composer == nil else { return }
        guard let account = accounts.first(where: { $0.connected && $0.id == accountID }) ?? accounts.first(where: \.connected) else { error = "请先在网页设置中连接邮箱，再刷新。"; return }
        composer = MailComposer(accountId: account.id)
    }
    func reply(_ message: MailMessage, all: Bool = false, forward: Bool = false) {
        guard let detail, composer == nil,
              let account = detail.replyAccount(for: message, accounts: accounts, listedAccountID: threads.first(where: { $0.id == detail.id })?.accountId) else { error = "请先在对应邮箱中打开这封邮件。"; return }
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
        case .inbox:
            guard composer == nil else { error = "请先保存或关闭当前草稿。"; return }
            folder = .inbox; query = ""; selectedID = nil; detail = nil
            readRevision += 1; reading = false; showSettings = false
        case let .thread(server, id):
            guard server == pairing?.server else { error = "这封邮件属于其他服务器。请先在设置中切换并配对。"; return }
            Task { await open(id: id) }
        case let .compose(to, cc, bcc, subject, text):
            guard composer == nil else { error = "请先保存或关闭当前草稿。"; return }
            compose(); composer?.to = to; composer?.cc = cc; composer?.bcc = bcc
            composer?.subject = subject; composer?.text = text
        }
    }
    func mailboxDidLoad() {
        guard phase == .ready, !Task.isCancelled else { return }
        mailboxVisible = true
        if let link = pendingLink { pendingLink = nil; handle(link) }
        if !offeredDraftRecovery, composer == nil, !recoverableDrafts.isEmpty {
            offeredDraftRecovery = true; showDraftRecovery = true
        }
        offerSharedDraft()
    }
    func refreshDraftRecovery() {
        guard phase == .ready, let server = pairing?.server, validatedRecoveryOrigin == server else { return }
        do {
            recoverableDrafts = try DraftRecoveryStore.device.recover(server: server, accountIDs: Set(accounts.filter(\.connected).map(\.id)))
                .filter { !DraftRecoveryLeases.shared.isClaimed($0.id, server: server) }
            recoveryFailure = nil
        } catch { recoveryFailure = error.localizedDescription }
    }
    func restoreDraft(_ recovered: RecoveredDraft) {
        guard phase == .ready, composer == nil, let server = pairing?.server, validatedRecoveryOrigin == server,
              accounts.contains(where: { $0.id == recovered.draft.accountId && $0.connected }) else { return }
        guard DraftRecoveryLeases.shared.claim(recovered.id, server: server, owner: recoveryOwner) else {
            recoveryFailure = "这份草稿已在另一个窗口打开。"; refreshDraftRecovery(); return
        }
        Self.hideClaimedDrafts()
        pendingRecoveredDraft = recovered; showDraftRecovery = false
    }
    func finishRestoringDraft() {
        guard let recovered = pendingRecoveredDraft else { return }
        pendingRecoveredDraft = nil
        let pendingServer = pairing?.server
        guard phase == .ready, composer == nil, let server = pairing?.server, validatedRecoveryOrigin == server,
              accounts.contains(where: { $0.id == recovered.draft.accountId && $0.connected }) else {
            if let pendingServer { DraftRecoveryLeases.shared.release(recovered.id, server: pendingServer, owner: recoveryOwner) }
            return
        }
        guard DraftRecoveryLeases.shared.claim(recovered.id, server: server, owner: recoveryOwner) else { return }
        if let id = recovered.draft.sharedImportID {
            guard EcosystemBridge.shared.claim(id, server: server, owner: recoveryOwner) else {
                DraftRecoveryLeases.shared.release(recovered.id, server: server, owner: recoveryOwner)
                recoveryFailure = "这份分享草稿已在另一个窗口打开。"; return
            }
            sharedDraftOffer = nil
        }
        composer = recovered.draft
    }
    func discardRecoveredDraft(_ recovered: RecoveredDraft) {
        guard phase == .ready, let server = pairing?.server, validatedRecoveryOrigin == server else { return }
        guard DraftRecoveryLeases.shared.claim(recovered.id, server: server, owner: recoveryOwner) else { recoveryFailure = "这份草稿已在另一个窗口打开。"; return }
        defer { DraftRecoveryLeases.shared.release(recovered.id, server: server, owner: recoveryOwner); refreshDraftRecovery() }
        do {
            try DraftRecoveryStore.device.remove(recovered.id, server: server)
            acknowledgeSharedComposer(recovered.draft); refreshDraftRecovery()
        } catch { recoveryFailure = error.localizedDescription }
    }
    @discardableResult func saveRecovery(_ draft: MailComposer, client expected: MailClient?) throws -> Bool {
        guard let expected, client === expected, phase == .ready, validatedRecoveryOrigin == expected.pairing.server,
              accounts.contains(where: { $0.id == draft.accountId && $0.connected }) else { return false }
        guard DraftRecoveryLeases.shared.claim(draft.id, server: expected.pairing.server, owner: recoveryOwner) else { throw DraftRecoveryFailure.unavailable }
        try DraftRecoveryStore.device.save(draft, server: expected.pairing.server)
        if composer?.id == draft.id { composer = draft }
        return true
    }
    func completeComposer(_ draft: MailComposer, client expected: MailClient?) throws {
        guard let expected, client === expected, phase == .ready else { return }
        try DraftRecoveryStore.device.remove(draft.id, server: expected.pairing.server)
        DraftRecoveryLeases.shared.release(draft.id, server: expected.pairing.server, owner: recoveryOwner)
        acknowledgeSharedComposer(draft); refreshDraftRecovery()
    }
    private func eraseDraftRecovery() {
        guard let server = pairing?.server else { return }
        do { try DraftRecoveryStore.device.clear(server: server) }
        catch { recoveryFailure = error.localizedDescription }
    }
    func signOut() async {
        let old = pairing; eraseDraftRecovery(); invalidateOriginWindows(); phase = .server
        do { try await old?.signOut() }
        catch let failure as PairingFailure where failure == .credentialStorage {
            self.error = "无法清除本机钥匙串凭据，请解锁设备后重试退出。"
        } catch { self.error = "本机凭据已清除。服务器暂时无法连接，可在其他设备撤销此会话。" }
    }
    func report(_ failure: Error) {
        if failure is CancellationError { return }
        if let pairing = failure as? PairingFailure {
            switch pairing {
            case .signedOut: eraseDraftRecovery(); invalidateOriginWindows(); error = "登录已过期或设备已被撤销，请重新配对。"
            case .invalidServer: error = "请输入服务器的 HTTPS 地址，不包含路径、用户名或密码。"
            case .credentialStorage: error = "无法访问设备钥匙串，请解锁设备后重试。"
            case .server(let code): error = "请求未完成（\(code)），请重试或检查邮箱连接。"
            default: error = "服务器返回了无法识别的数据。"
            }
        } else { error = (failure as? LocalizedError)?.errorDescription ?? "无法连接服务器，请检查网络后重试。" }
    }
    private func clearSession() {
        DraftRecoveryLeases.shared.releaseAll(owner: recoveryOwner)
        validatedRecoveryOrigin = nil; recoverableDrafts = []; showDraftRecovery = false; offeredDraftRecovery = false; pendingRecoveredDraft = nil
        stopPolling()
        if let server = pairing?.server {
            MailNotifications.shared.reset(server: server)
            EcosystemBridge.shared.clear(server: server)
        }
        sharedDraftOffer = nil; pendingTrashID = nil; pendingTrashRevision = nil
        sessionRevision += 1; listRevision += 1; readRevision += 1
        mailboxVisible = false
        accounts = []; threads = []; warnings = []; selectedID = nil; detail = nil; composer = nil
        accountID = ""; query = ""; folder = .inbox; cursor = nil; loading = false; reading = false; showSettings = false
    }
    private static func hideClaimedDrafts() {
        windows.removeAll { $0.store == nil }
        for window in windows {
            guard let store = window.store, let server = store.pairing?.server else { continue }
            store.recoverableDrafts.removeAll { DraftRecoveryLeases.shared.isClaimed($0.id, server: server) }
        }
    }
    private func invalidateOriginWindows() {
        guard let server = pairing?.server else { clearSession(); phase = .server; return }
        Self.windows.removeAll { $0.store == nil }
        for window in Self.windows {
            guard let store = window.store, store.pairing?.server == server else { continue }
            store.clearSession(); store.phase = .server
        }
    }
}
