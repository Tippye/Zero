import SwiftUI
import ZeroMail
import ZeroPairing

struct SessionView: View {
    @StateObject private var store = MailStore()
    @Environment(\.scenePhase) private var scenePhase
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
            await store.start()
            #if !os(watchOS)
            receiveIntent()
            #endif
        }
        .onChange(of: scenePhase) { phase in
            if phase == .active, store.phase == .ready { Task { await store.reload() } }
            #if !os(watchOS)
            if phase == .active { receiveIntent() }
            #endif
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
        .onReceive(intentInbox.$pending) { link in if link != nil, scenePhase == .active { receiveIntent() } }
        #endif
        #if os(macOS)
        .frame(minWidth: 760, minHeight: 520)
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
                Text("认证凭据只保存在这台设备的钥匙串中。").font(.footnote).foregroundStyle(.secondary)
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
