import SwiftUI
import ZeroMail
import ZeroPairing

struct SessionView: View {
    @StateObject private var store = MailStore()
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject private var notifications = MailNotifications.shared
    #if !os(watchOS)
    @ObservedObject private var intentInbox = ComposeIntentInbox.shared
    #endif
    var body: some View {
        Group {
            switch store.phase {
            case .server: serverForm
            case .connecting: ProgressView("正在连接…")
            case .pairing:
                if let client = store.pairing {
                    VStack {
                        PairingLoginView(client: client, deviceName: store.deviceName) { Task { await store.authorized() } }
                        Button("更换服务器") { store.phase = .server }.padding()
                    }
                }
            case .ready:
                #if os(watchOS)
                WatchMailboxView(store: store)
                #else
                MailboxView(store: store)
                #endif
            }
        }
        .task {
            store.sceneChanged(active: scenePhase == .active)
            await store.start()
            store.receiveNotification()
            #if !os(watchOS)
            receiveIntent()
            #endif
        }
        .onChange(of: scenePhase) { phase in
            store.sceneChanged(active: phase == .active)
            if phase == .active, store.phase == .ready { Task { await store.reload() } }
            if phase == .active { store.receiveNotification() }
            #if !os(watchOS)
            if phase == .active { receiveIntent() }
            #endif
        }
        .onChange(of: store.phase) { phase in if phase == .ready { store.receiveNotification() } }
        .onReceive(notifications.$pending) { destination in if destination != nil { Task { store.receiveNotification() } } }
        .onReceive(NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification).receive(on: RunLoop.main)) { _ in
            store.refreshPreferences()
        }
        .onDisappear { store.stopPolling() }
        .confirmationDialog("将邮件移到废纸篓？", isPresented: Binding(get: { store.pendingTrashID != nil }, set: { if !$0 { store.pendingTrashID = nil } }), titleVisibility: .visible, presenting: store.pendingTrashID) { id in
            Button("移到废纸篓", role: .destructive) { Task { await store.confirmTrash(id: id) } }
            Button("取消", role: .cancel) { store.pendingTrashID = nil }
        }
        .confirmationDialog("导入系统分享内容？", isPresented: Binding(get: { store.sharedDraftOffer != nil }, set: { if !$0 { store.deferSharedDraft() } }), titleVisibility: .visible) {
            if let draft = store.sharedDraftOffer {
                Button("导入草稿") { store.importSharedDraft(draft) }
                Button("稍后", role: .cancel) { store.deferSharedDraft() }
            }
        } message: {
            Text("将创建一份收件人为空的新草稿。请检查发件邮箱、正文和附件，再手动发送。")
        }
        .onOpenURL { if let link = MailLink(url: $0) { store.handle(link) } }
        .onContinueUserActivity(MailLink.activityType) { activity in
            guard let raw = activity.userInfo?["route"] as? String, let url = URL(string: raw), let link = MailLink(url: url) else { return }
            store.handle(link)
        }
        .alert("Zero Mail", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) {
            Button("好", role: .cancel) { store.error = nil }
        } message: { Text(store.error ?? "") }
        #if !os(watchOS)
        .onReceive(intentInbox.$pending) { link in
            // @Published emits before storing the new value. Consume after the
            // current actor turn so a Shortcut arriving in an active app opens.
            if link != nil, scenePhase == .active { Task { @MainActor in receiveIntent() } }
        }
        #endif
        #if os(iOS)
        .sheet(isPresented: $store.showSettings) { DeviceSettingsView(store: store) }
        #endif
        #if os(macOS)
        .frame(minWidth: 760, minHeight: 520)
        .background(MailSettingsWindowContext(store: store))
        .focusedSceneValue(\.mailStore, store)
        #endif
    }
    #if !os(watchOS)
    private func receiveIntent() {
        if let link = intentInbox.take() { store.handle(link) }
    }
    #endif
    private var serverForm: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Image(systemName: "envelope").font(.largeTitle).foregroundStyle(.tint).accessibilityHidden(true)
                Text("连接 Zero Mail").font(.title2.bold())
                Text("输入你部署的服务器地址，然后用已登录设备批准配对。首次登录可在服务器上授权。").foregroundStyle(.secondary)
                TextField("https://mail.example.com", text: $store.serverText)
                    #if os(iOS)
                    .textContentType(.URL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    #endif
                    .accessibilityIdentifier("serverURL")
                TextField("设备名称", text: $store.deviceName).accessibilityIdentifier("deviceName")
                Button("继续") { Task { await store.connect() } }.buttonStyle(.borderedProminent).disabled(store.serverText.isEmpty || store.deviceName.isEmpty).accessibilityIdentifier("connect")
                #if os(macOS)
                MacSettingsOpenButton(store: store)
                #elseif os(iOS)
                Button("设置") { store.showSettings = true }.accessibilityIdentifier("mailSettings")
                #endif
                Text("认证凭据只保存在这台设备的钥匙串中。").font(.footnote).foregroundStyle(.secondary)
                #if DEBUG
                Text("开发版本支持本机 HTTP 测试服务，例如 http://localhost:18080。正式版本仅连接 HTTPS。").font(.footnote).foregroundStyle(.secondary)
                #endif
            }.padding().frame(maxWidth: 460)
        }
    }
}

#if os(macOS)
struct MailStoreKey: FocusedValueKey { typealias Value = MailStore }
extension FocusedValues {
    var mailStore: MailStore? { get { self[MailStoreKey.self] } set { self[MailStoreKey.self] = newValue } }
}
#endif
