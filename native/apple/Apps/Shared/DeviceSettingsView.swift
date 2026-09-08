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
                ClassificationSettingsSections(store: store)
                NotificationSettingsSection()
                DeviceManagementSections(store: store)
            }
            .navigationTitle("设置")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() }.accessibilityIdentifier("closeSettings") } }
        }
    }
}

/// Server-backed classification and resource limits shared by Mac, iPhone, iPad and Watch.
struct ClassificationSettingsSections: View {
    @ObservedObject var store: MailStore
    @State private var status: MailClassificationStatus?
    @State private var overview: MailClassificationSettingsOverview?
    @State private var draft: MailClassificationSettings?
    @State private var aiReady = false
    @State private var busy = false
    @State private var loaded = false
    @State private var failure: String?
    private var total: Int { status?.accounts.reduce(0) { $0 + $1.classificationTotal } ?? 0 }
    private var completed: Int { status?.accounts.reduce(0) { $0 + $1.classifiedCount } ?? 0 }
    private var paused: Bool { status?.accounts.isEmpty == false && status?.accounts.allSatisfy(\.classificationPaused) == true }
    private var running: Bool { status?.accounts.contains(where: \.classificationRunning) == true }
    private var enabled: Bool { status?.enabled == true && overview?.enabled == true }
    private var primaryAction: MailClassificationAction {
        paused ? .start : completed == total && total > 0 ? .restart : .start
    }
    private var primaryActionTitle: String {
        paused ? "继续分类" : completed == total && total > 0 ? "重新分类" : "立即分类"
    }

    var body: some View {
        Group {
            if store.phase == .ready {
                Section("AI 邮件分类") {
                    if loaded, !enabled {
                        Text("服务器尚未启用后台邮件同步，无法使用本地分类。").foregroundStyle(.secondary)
                    } else if let status {
                        Text(statusText(status)).font(.callout)
                        ProgressView(value: Double(completed), total: Double(max(total, 1)))
                        Text("已分类 \(completed) / \(total)").font(.caption).foregroundStyle(.secondary)
                        ForEach(status.accounts.filter { $0.classificationError != nil && !$0.classificationPaused }) { account in
                            Text(account.email + "：" + classificationError(account.classificationError!))
                                .font(.caption).foregroundStyle(.orange)
                        }
                        if !aiReady { Text("请先在网页设置中配置并启用 LLM 服务商。").font(.caption).foregroundStyle(.secondary) }
                        HStack {
                            Button(primaryActionTitle) {
                                Task { await control(primaryAction) }
                            }
                            .disabled(busy || total == 0 || !aiReady || !status.classifierOnline || running)
                            Button("暂停", role: .destructive) { Task { await control(.pause) } }
                                .disabled(busy || paused || total == 0)
                        }
                    } else { ProgressView("载入分类状态…") }
                    if let failure { Text(failure).font(.caption).foregroundStyle(.red) }
                    Button("刷新分类状态") { Task { await load() } }.disabled(busy)
                }
                if enabled, let limits = draft {
                    Section("分类资源限制") {
                        Stepper("并行请求：\(limits.concurrency)", value: intBinding(\.concurrency), in: 1...4)
                        Stepper("每批邮件：\(limits.batchSize)", value: intBinding(\.batchSize), in: 1...50)
                        Stepper("批次间隔：\(limits.intervalSeconds) 秒", value: intBinding(\.intervalSeconds), in: 2...3600)
                        Stepper("请求超时：\(limits.timeoutSeconds) 秒", value: intBinding(\.timeoutSeconds), in: 5...120)
                        Stepper("优先最近：\(limits.recentDays) 天", value: intBinding(\.recentDays), in: 1...365)
                        Stepper("历史批次频率：每 \(limits.historyEveryBatches) 批", value: intBinding(\.historyEveryBatches), in: 1...100)
                        Text("单轮最多处理 \(limits.concurrency * limits.batchSize) 封邮件。限制保存在服务器并应用于所有 Apple 设备及网页端；读取与 AI 请求继续由服务器隔离并限制资源。")
                            .font(.caption).foregroundStyle(.secondary)
                        HStack {
                            Button("保存限制") { Task { await save() } }
                                .disabled(busy || draft == overview?.settings)
                            Button("恢复服务器默认值") { draft = overview?.defaults }.disabled(busy)
                        }
                    }
                }
            }
        }
        .task(id: store.phase) {
            guard store.phase == .ready else { reset(); return }
            await load()
            while !Task.isCancelled, store.phase == .ready {
                do { try await Task.sleep(nanoseconds: running ? 5_000_000_000 : 30_000_000_000) }
                catch { return }
                await load(refreshLimits: false)
            }
        }
        .onChange(of: store.pairing.map(ObjectIdentifier.init)) { _ in reset() }
    }

    private func intBinding(_ keyPath: WritableKeyPath<MailClassificationSettings, Int>) -> Binding<Int> {
        Binding(get: { draft?[keyPath: keyPath] ?? 1 }, set: {
            guard var value = draft else { return }
            value[keyPath: keyPath] = $0
            draft = value
        })
    }
    private func statusText(_ value: MailClassificationStatus) -> String {
        if !value.classifierOnline { return "分类服务离线，已缓存邮件仍可查看。" }
        if paused { return "分类已暂停，继续后将从当前进度开始。" }
        if total == 0 { return "暂时没有可分类的收件箱邮件。" }
        if completed == total { return "分类已完成。" }
        return running ? "正在分类…" : "等待分类服务处理。"
    }
    private func classificationError(_ code: String) -> String {
        switch code {
        case "INVALID_RESPONSE": return "模型返回的分类格式不正确。"
        case "OUTPUT_LIMIT": return "模型输出被截断，服务器将缩小批次后重试。"
        case "AUTH_FAILED", "CONFIGURATION": return "模型配置或凭据无效。"
        case "RATE_LIMIT": return "服务商限制了请求频率。"
        case "TIMEOUT": return "分类请求超时。"
        default: return "分类请求失败，请检查当前模型及服务。"
        }
    }
    private func load(refreshLimits: Bool = true) async {
        guard let client = store.client else { return }
        do {
            async let nextStatus = client.classificationStatus()
            async let provider = client.aiStatus()
            if refreshLimits || overview == nil {
                async let nextOverview = client.classificationSettings()
                let values = try await (nextStatus, nextOverview, provider)
                guard store.client === client, store.phase == .ready, !Task.isCancelled else { return }
                status = values.0; overview = values.1; draft = values.1.settings; aiReady = values.2.ready
            } else {
                let values = try await (nextStatus, provider)
                guard store.client === client, store.phase == .ready, !Task.isCancelled else { return }
                status = values.0; aiReady = values.1.ready
            }
            loaded = true; failure = nil
        } catch {
            guard !Task.isCancelled, store.client === client else { return }
            loaded = true; failure = settingsFailure(error)
            if error as? PairingFailure == .signedOut { store.report(error) }
        }
    }
    private func control(_ action: MailClassificationAction) async {
        guard let client = store.client, !busy else { return }
        busy = true; defer { busy = false }
        do { try await client.controlClassification(action); await load(refreshLimits: false) }
        catch { failure = settingsFailure(error); if error as? PairingFailure == .signedOut { store.report(error) } }
    }
    private func save() async {
        guard let client = store.client, let draft, !busy else { return }
        busy = true; defer { busy = false }
        do {
            let saved = try await client.saveClassificationSettings(draft)
            guard store.client === client else { return }
            self.draft = saved
            if let overview { self.overview = MailClassificationSettingsOverview(enabled: overview.enabled, defaults: overview.defaults, settings: saved) }
            failure = nil
        } catch { failure = settingsFailure(error); if error as? PairingFailure == .signedOut { store.report(error) } }
    }
    private func settingsFailure(_ error: Error) -> String {
        if let failure = error as? PairingFailure {
            if failure == .signedOut { return "登录已过期，请重新配对。" }
            if case .server("NOT_FOUND") = failure { return "服务器版本尚未提供 Apple 分类管理接口。" }
            if case .server("PRECONDITION_FAILED") = failure { return "服务器尚未启用后台邮件同步。" }
            if case .server("BAD_REQUEST") = failure { return "资源限制超出服务器允许范围。" }
        }
        return "无法载入或保存分类设置，请稍后重试。"
    }
    private func reset() {
        status = nil; overview = nil; draft = nil; aiReady = false; busy = false; loaded = false; failure = nil
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
