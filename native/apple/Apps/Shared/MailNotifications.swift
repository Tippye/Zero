import SwiftUI
import UserNotifications
import CryptoKit
import ZeroMail
import ZeroPairing

@MainActor
final class MailNotifications: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    struct Destination {
        let server: URL
        let accountID: String
        let link: MailLink
    }
    static let shared = MailNotifications()
    @Published private(set) var enabled = UserDefaults.standard.bool(forKey: "zero.notifications.enabled")
    @Published var preview = MailPreferences().notificationPreview {
        didSet { if oldValue != preview { UserDefaults.standard.set(preview, forKey: MailPreferenceKey.notificationPreview) } }
    }
    @Published var sound = MailPreferences().notificationSound {
        didSet { if oldValue != sound { UserDefaults.standard.set(sound, forKey: MailPreferenceKey.notificationSound) } }
    }
    @Published private(set) var permitted = false
    @Published private(set) var permissionChecked = false
    @Published private(set) var pending: Destination?
    @Published private(set) var failure: String?
    @Published private(set) var eventFeedAvailable: Bool?
    private let center = UNUserNotificationCenter.current()
    private var tracker: MailEventTracker = {
        guard let data = UserDefaults.standard.data(forKey: "zero.notificationFeed"),
              let value = try? JSONDecoder().decode(MailEventTracker.self, from: data) else { return MailEventTracker() }
        return value
    }()
    private var revisions = UserDefaults.standard.dictionary(forKey: "zero.notificationEpochs") as? [String: String] ?? [:]
    private var running: Set<URL> = []
    private var preferenceRevision = 0

    private override init() {
        super.init()
        center.delegate = self
    }

    func refreshPermission() async {
        refreshPreferences()
        let settings = await center.notificationSettings()
        #if os(iOS)
        permitted = [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
        #else
        permitted = [.authorized, .provisional].contains(settings.authorizationStatus)
        #endif
        permissionChecked = true
    }

    func refreshPreferences() {
        let preferences = MailPreferences()
        if preview != preferences.notificationPreview { preview = preferences.notificationPreview }
        if sound != preferences.notificationSound { sound = preferences.notificationSound }
    }

    func setEnabled(_ value: Bool) async {
        preferenceRevision += 1
        let preference = preferenceRevision
        failure = nil
        if value {
            do { _ = try await center.requestAuthorization(options: [.alert, .sound]) }
            catch { failure = "无法请求通知权限，请在系统设置中检查 Zero Mail 的通知权限。" }
            await refreshPermission()
        }
        guard preference == preferenceRevision else { return }
        enabled = value && permitted
        UserDefaults.standard.set(enabled, forKey: "zero.notifications.enabled")
        tracker.reset()
        persistTracker()
        if !enabled {
            center.removeAllPendingNotificationRequests()
            center.removeAllDeliveredNotifications()
            pending = nil
        }
    }

    func poll(client: MailClient, accountIDs: Set<String>) async throws {
        let server = client.pairing.server
        guard running.insert(server).inserted else { return }
        defer { running.remove(server) }
        let generation = generation(for: server)
        let preference = preferenceRevision
        let head: MailEventPage
        do { head = try await client.events() }
        catch let PairingFailure.server(code) where code == "NOT_FOUND" {
            eventFeedAvailable = false; return
        }
        guard !Task.isCancelled, generation == revisions[server.absoluteString], preference == preferenceRevision else { return }
        eventFeedAvailable = true
        let after = try tracker.after(head: head, server: server)
        persistTracker()
        guard let after else { return }
        let page = try await client.events(after: after)
        guard !Task.isCancelled, generation == revisions[server.absoluteString], preference == preferenceRevision else { return }
        var previewTracker = tracker
        let events = try previewTracker.accept(page, server: server, after: after)
        if enabled, permitted {
            await display(events.filter { accountIDs.contains($0.accountId) }, server: server, generation: generation, preference: preference)
        }
        guard !Task.isCancelled, generation == revisions[server.absoluteString], preference == preferenceRevision else { return }
        _ = try tracker.accept(page, server: server, after: after)
        persistTracker()
    }

    private func display(_ events: [MailEvent], server: URL, generation: String, preference: Int) async {
        for event in events {
            guard !Task.isCancelled, enabled, preference == preferenceRevision, generation == revisions[server.absoluteString] else { return }
            let content = UNMutableNotificationContent()
            content.title = preview ? String((event.sender.isEmpty ? "Zero Mail" : event.sender).prefix(160)) : "Zero Mail"
            content.body = preview ? String((event.subject.isEmpty ? "无主题" : event.subject).prefix(240)) : "收到新邮件，点按查看。"
            content.sound = sound ? .default : nil
            let link = MailLink.thread(server: server, id: event.threadId)
            content.userInfo = ["route": link.url.absoluteString, "account": event.accountId, "server": server.absoluteString, "generation": generation]
            let digest = SHA256.hash(data: Data((server.absoluteString + "\u{0}" + event.accountId + "\u{0}" + event.id).utf8))
            let identifier = "zero.mail." + digest.map { String(format: "%02x", $0) }.joined()
            do {
                try await center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
                if Task.isCancelled || !enabled || preference != preferenceRevision || generation != revisions[server.absoluteString] {
                    center.removePendingNotificationRequests(withIdentifiers: [identifier])
                    center.removeDeliveredNotifications(withIdentifiers: [identifier])
                }
            } catch { failure = "新邮件通知未能显示，请检查系统通知设置。" }
        }
    }

    private func persistTracker() {
        if let data = try? JSONEncoder().encode(tracker) { UserDefaults.standard.set(data, forKey: "zero.notificationFeed") }
    }
    private func generation(for server: URL) -> String {
        if let value = revisions[server.absoluteString] { return value }
        let value = UUID().uuidString
        revisions[server.absoluteString] = value
        UserDefaults.standard.set(revisions, forKey: "zero.notificationEpochs")
        return value
    }

    func test() async {
        await refreshPermission()
        guard enabled, permitted else { failure = "请先允许 Zero Mail 显示通知。"; return }
        let content = UNMutableNotificationContent()
        content.title = "Zero Mail"
        content.body = "这是一条系统通知测试，没有发送邮件。"
        content.sound = sound ? .default : nil
        do { try await center.add(UNNotificationRequest(identifier: "zero.notification-test", content: content, trigger: nil)) }
        catch { failure = "测试通知未能显示，请检查系统通知设置。" }
    }

    func reset(server: URL) {
        let generation = UUID().uuidString
        revisions[server.absoluteString] = generation
        UserDefaults.standard.set(revisions, forKey: "zero.notificationEpochs")
        tracker.reset(server: server)
        persistTracker(); eventFeedAvailable = nil
        if pending?.server == server { pending = nil }
        Task {
            let requests = await center.pendingNotificationRequests()
            center.removePendingNotificationRequests(withIdentifiers: requests.filter { $0.content.userInfo["server"] as? String == server.absoluteString && $0.content.userInfo["generation"] as? String != generation }.map(\.identifier))
            let delivered = await center.deliveredNotifications()
            center.removeDeliveredNotifications(withIdentifiers: delivered.filter { $0.request.content.userInfo["server"] as? String == server.absoluteString && $0.request.content.userInfo["generation"] as? String != generation }.map { $0.request.identifier })
        }
    }

    func take(for server: URL) -> Destination? {
        guard pending?.server == server else { return nil }
        defer { pending = nil }
        return pending
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let route = response.notification.request.content.userInfo["route"] as? String,
              let raw = URL(string: route), let link = MailLink(url: raw),
              case let .thread(server, _) = link,
              let accountID = response.notification.request.content.userInfo["account"] as? String,
              let generation = response.notification.request.content.userInfo["generation"] as? String else {
            completionHandler(); return
        }
        Task { @MainActor in
            if generation == self.revisions[server.absoluteString] {
                self.pending = Destination(server: server, accountID: accountID, link: link)
            }
            completionHandler()
        }
    }
}

struct NotificationSettingsSection: View {
    @ObservedObject private var notifications = MailNotifications.shared
    @State private var requesting = false
    var body: some View {
        Section("新邮件通知") {
            Toggle("允许新邮件通知", isOn: Binding(get: { notifications.enabled }, set: { value in
                requesting = true
                Task { await notifications.setEnabled(value); requesting = false }
            })).disabled(requesting).accessibilityIdentifier("notificationsEnabled")
            Toggle("在通知中显示发件人与主题", isOn: $notifications.preview).disabled(!notifications.enabled)
            Toggle("播放新邮件提示音", isOn: $notifications.sound).disabled(!notifications.enabled)
            Button("测试系统通知") { Task { await notifications.test() } }.disabled(!notifications.enabled || requesting).accessibilityIdentifier("testNotification")
            #if os(macOS)
            Text("应用运行时每 30 秒检查收件箱；退出应用后停止。首次检查不通知历史邮件。").font(.footnote).foregroundStyle(.secondary)
            #else
            Text("仅在应用位于前台时检查收件箱。后台或退出后的即时推送尚未启用。首次检查不通知历史邮件。").font(.footnote).foregroundStyle(.secondary)
            #endif
            if notifications.permissionChecked, !notifications.permitted {
                Text("如已拒绝授权，请在系统设置中允许 Zero Mail 通知后重试。").font(.footnote)
            }
            if notifications.eventFeedAvailable == false {
                Text("此服务器未提供新邮件事件。请升级服务器后启用通知；收件箱刷新仍可使用。").font(.footnote).foregroundStyle(.orange)
            }
            if let failure = notifications.failure { Text(failure).font(.footnote).foregroundStyle(.orange) }
        }.task { await notifications.refreshPermission() }
    }
}
