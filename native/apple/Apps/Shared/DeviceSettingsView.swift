import SwiftUI
import ZeroMail
import ZeroPairing
#if os(iOS)
import UIKit
#endif

struct DeviceSettingsView: View {
    @ObservedObject var store: MailStore
    @Environment(\.dismiss) private var dismiss
    #if os(iOS)
    @Environment(\.openURL) private var openURL
    #endif
    var body: some View {
        NavigationStack {
            Form {
                #if os(iOS)
                Section {
                    Button {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    } label: { Label("打开系统设置", systemImage: "gearshape") }
                    .accessibilityIdentifier("openSystemSettings")
                } footer: { Text("阅读、列表显示和提醒声音可在系统设置中调整。") }
                #endif
                AccountSettingsSections(store: store)
                NotificationSettingsSection()
                DeviceManagementSections(store: store)
            }
            .navigationTitle("设置")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() }.accessibilityIdentifier("closeSettings") } }
        }
    }
}

/// Shared by the iOS settings panel and the Mac Accounts tab.
struct AccountSettingsSections: View {
    @ObservedObject var store: MailStore
    @State private var confirmSignOut = false
    @State private var signOutClient: PairingClient?
    @State private var signingOut = false
    var body: some View {
        Section("账户") {
            if store.phase == .ready {
                if let server = store.pairing?.server {
                    LabeledContent("服务器", value: server.absoluteString).font(.callout)
                }
                if store.accounts.isEmpty { Text("尚未连接邮箱").foregroundStyle(.secondary) }
                ForEach(store.accounts) { account in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "envelope").foregroundStyle(.secondary).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(account.email)
                            if !account.name.isEmpty, account.name != account.email {
                                Text(account.name).font(.caption).foregroundStyle(.secondary)
                            }
                            Text(account.connected ? "已连接" : "需要重新连接")
                                .font(.caption).foregroundStyle(account.connected ? Color.secondary : Color.orange)
                            if let warning = account.warning { Text(warning).font(.caption).foregroundStyle(.orange) }
                        }
                        Spacer(minLength: 0)
                    }
                }
                #if !os(watchOS)
                if let server = store.pairing?.server {
                    Link("管理邮箱账户…", destination: server.appendingPathComponent("settings/connections"))
                        .accessibilityIdentifier("manageMailAccounts")
                }
                #endif
                Button("刷新账户") { Task { await store.refresh() } }
                    .disabled(store.loading || signingOut).accessibilityIdentifier("refreshSettingsAccounts")
                Button("退出并更换服务器…", role: .destructive) {
                    signOutClient = store.pairing; confirmSignOut = true
                }
                    .disabled(signingOut).accessibilityIdentifier("signOutSettings")
                if signingOut { ProgressView() }
            } else {
                Label("尚未配对", systemImage: "person.crop.circle.badge.questionmark")
                Text("在主窗口连接服务器并完成配对，即可管理邮箱账户和设备。")
                    .font(.callout).foregroundStyle(.secondary)
            }
            if let error = store.error { SettingsErrorText(message: error) }
        }
        .onChange(of: store.pairing.map(ObjectIdentifier.init)) { _ in
            confirmSignOut = false; signOutClient = nil
        }
        .confirmationDialog("退出 Zero Mail？", isPresented: $confirmSignOut, titleVisibility: .visible, presenting: signOutClient) { client in
            Button("退出并更换服务器", role: .destructive) {
                guard store.pairing === client else { return }
                signingOut = true
                Task {
                    if store.pairing === client { await store.signOut() }
                    signingOut = false
                }
            }
            Button("取消", role: .cancel) { }
        } message: { _ in Text("本机配对凭据和此服务器的本机恢复草稿将被清除，再次使用时需要重新配对。") }
    }
}

struct DeviceManagementSections: View {
    @ObservedObject var store: MailStore
    @State private var devices: [PairedDevice] = []
    @State private var code = ""
    @State private var preview: PairingPreview?
    @State private var previewCode = ""
    @State private var revoke: PairedDevice?
    @State private var revokeClient: PairingClient?
    @State private var busy = false
    @State private var loaded = false
    @State private var failure: String?
    var body: some View {
        Group {
            if store.phase == .ready {
                Section("授权新设备") {
                    HStack {
                        TextField("配对码 ABCD-EFGH", text: $code).autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.characters)
                            #endif
                            .accessibilityIdentifier("settingsPairingCode")
                        Button("查看请求") { Task { await inspect() } }
                            .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                            .accessibilityIdentifier("inspectPairingRequest")
                    }
                    if let preview {
                        LabeledContent("设备", value: preview.deviceName)
                        LabeledContent("服务器", value: preview.origin).font(.callout)
                        LabeledContent("有效期至") { Text(preview.expiresAt, style: .time) }
                        Text("仅批准你正在登录的设备。")
                            .font(.caption).foregroundStyle(.secondary)
                        HStack {
                            Button("批准此设备") { Task { await decide(true) } }.accessibilityIdentifier("approvePairingRequest")
                            Button("拒绝", role: .destructive) { Task { await decide(false) } }
                        }.disabled(busy)
                    }
                }
                Section("已配对设备") {
                    ForEach(devices) { device in
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(device.name + (device.current ? "（本机）" : ""))
                                (Text("有效期至 ") + Text(device.expiresAt, style: .date))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 12)
                            Button("撤销…", role: .destructive) {
                                revokeClient = store.pairing; revoke = device
                            }.disabled(busy)
                                .accessibilityIdentifier("revokeDevice-" + device.id)
                        }
                    }
                    if loaded, devices.isEmpty { Text("没有已配对设备").foregroundStyle(.secondary) }
                    Button("刷新设备") { Task { await load() } }.disabled(busy).accessibilityIdentifier("refreshSettingsDevices")
                    if busy { ProgressView() }
                    if let failure { SettingsErrorText(message: failure) }
                }
            } else {
                #if os(macOS)
                Section("设备") {
                    Label("配对后可管理设备", systemImage: "laptopcomputer.and.iphone")
                    Text("在主窗口完成配对后，可批准新设备或撤销已有访问权限。")
                        .font(.callout).foregroundStyle(.secondary)
                }
                #endif
            }
        }
        .task(id: store.phase) {
            if store.phase == .ready { await load() }
            else { devices = []; preview = nil; code = ""; loaded = false; failure = nil }
        }
        .onChange(of: store.pairing.map(ObjectIdentifier.init)) { _ in
            revoke = nil; revokeClient = nil; preview = nil; previewCode = ""; code = ""; devices = []; loaded = false
        }
        .confirmationDialog("撤销这台设备？", isPresented: Binding(get: { revoke != nil }, set: { if !$0 { revoke = nil } }), titleVisibility: .visible, presenting: revoke) { device in
            if let client = revokeClient {
                Button("撤销 \(device.name)", role: .destructive) { Task { await remove(device, client: client) } }
            }
            Button("取消", role: .cancel) { }
        } message: { device in
            Text(device.current ? "这会退出本机账户，并清除本机配对凭据和此服务器的恢复草稿。" : "这台设备将无法继续访问你的邮箱，需要重新配对才能恢复。")
        }
    }
    private func load() async {
        guard !busy, store.phase == .ready, let client = store.pairing else { return }
        busy = true; failure = nil; defer { busy = false }
        do {
            let result = try await client.devices()
            guard store.pairing === client, store.phase == .ready, !Task.isCancelled else { return }
            devices = result; loaded = true
        } catch { report(error, client: client) }
    }
    private func inspect() async {
        guard !busy, store.phase == .ready, let client = store.pairing else { return }
        busy = true; preview = nil; failure = nil; defer { busy = false }
        let submitted = code.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let result = try await client.preview(code: submitted)
            guard store.pairing === client, store.phase == .ready, !Task.isCancelled else { return }
            previewCode = submitted; preview = result
        } catch { report(error, client: client) }
    }
    private func decide(_ approve: Bool) async {
        guard !busy, let preview, store.phase == .ready, let client = store.pairing else { return }
        busy = true; failure = nil
        do {
            try await client.decide(code: previewCode, requestID: preview.requestId, approve: approve)
            guard store.pairing === client, store.phase == .ready else { busy = false; return }
            self.preview = nil; code = ""; busy = false; await load()
        } catch { busy = false; report(error, client: client) }
    }
    private func remove(_ device: PairedDevice, client: PairingClient) async {
        guard !busy, store.phase == .ready, store.pairing === client else { return }
        busy = true; failure = nil
        do {
            try await client.revoke(device)
            guard store.pairing === client, store.phase == .ready else { busy = false; return }
            revoke = nil; busy = false
            if device.current { store.report(PairingFailure.signedOut) } else { await load() }
        } catch { busy = false; report(error, client: client) }
    }
    private func report(_ error: Error, client: PairingClient) {
        guard store.pairing === client, !Task.isCancelled, !(error is CancellationError) else { return }
        if error as? PairingFailure == .signedOut { store.report(error); return }
        if error as? PairingFailure == .expired { failure = "配对请求已过期，请在新设备上生成新的配对码。" }
        else { failure = "操作未完成，请检查网络连接和配对码后重试。" }
    }
}

struct SettingsErrorText: View {
    let message: String
    var body: some View {
        Label(message, systemImage: "exclamationmark.circle")
            .font(.callout).foregroundStyle(.red).accessibilityIdentifier("settingsError")
    }
}
