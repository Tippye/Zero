import SwiftUI
import ZeroPairing

struct DeviceSettingsView: View {
    @ObservedObject var store: MailStore
    @Environment(\.dismiss) private var dismiss
    @State private var devices: [PairedDevice] = []
    @State private var code = ""
    @State private var preview: PairingPreview?
    @State private var previewCode = ""
    @State private var revoke: PairedDevice?
    @State private var busy = false
    @State private var confirmSignOut = false
    var body: some View {
        NavigationStack {
            Form {
                Section("服务器") {
                    Text(store.serverText).font(.footnote)
                    Text("新增邮箱与服务设置请在已登录的网页中管理。").font(.footnote)
                    #if !os(watchOS)
                    if let server = store.pairing?.server { Link("打开网页设置", destination: server.appendingPathComponent("settings/connections")) }
                    #endif
                }
                Section("授权新设备") {
                    TextField("配对码 ABCD-EFGH", text: $code).autocorrectionDisabled()
                    Button("查看请求") { Task { await inspect() } }.disabled(code.isEmpty || busy)
                    if let preview {
                        Text(preview.deviceName).font(.headline)
                        Text(preview.origin).font(.footnote)
                        Text("过期时间：") + Text(preview.expiresAt, style: .time)
                        Text("仅批准你正在登录的设备。")
                        Button("批准此设备") { Task { await decide(true) } }.disabled(busy)
                        Button("拒绝", role: .destructive) { Task { await decide(false) } }.disabled(busy)
                    }
                }
                Section("已配对设备") {
                    ForEach(devices) { device in
                        VStack(alignment: .leading) {
                            Text(device.name + (device.current ? "（本机）" : ""))
                            Text(device.expiresAt, style: .date).font(.caption).foregroundStyle(.secondary)
                            Button("撤销", role: .destructive) { revoke = device }.disabled(busy)
                        }
                    }
                    Button("刷新设备") { Task { await load() } }.disabled(busy)
                }
                Section { Button("退出并更换服务器", role: .destructive) { confirmSignOut = true }.disabled(busy) }
            }
            .navigationTitle("设置与设备")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .task { await load() }
            .confirmationDialog("撤销这台设备？", isPresented: Binding(get: { revoke != nil }, set: { if !$0 { revoke = nil } }), titleVisibility: .visible) {
                if let device = revoke { Button("撤销 \(device.name)", role: .destructive) { Task { await remove(device) } } }
            }
            .confirmationDialog("退出后需要重新配对。", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("退出", role: .destructive) { Task { await store.signOut() } }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 560)
        #endif
    }
    private func load() async {
        busy = true; defer { busy = false }
        do { devices = try await store.pairing?.devices() ?? [] } catch { store.report(error) }
    }
    private func inspect() async {
        busy = true; preview = nil; defer { busy = false }
        do { previewCode = code; preview = try await store.pairing?.preview(code: previewCode) } catch { store.report(error) }
    }
    private func decide(_ approve: Bool) async {
        guard let preview else { return }; busy = true; defer { busy = false }
        do { try await store.pairing?.decide(code: previewCode, requestID: preview.requestId, approve: approve); self.preview = nil; code = ""; await load() }
        catch { store.report(error) }
    }
    private func remove(_ device: PairedDevice) async {
        busy = true; defer { busy = false }
        do { try await store.pairing?.revoke(device); if device.current { store.report(PairingFailure.signedOut) } else { await load() } }
        catch { store.report(error) }
    }
}
