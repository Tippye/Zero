#if os(macOS)
import AppKit
import Combine
import SwiftUI
import ZeroMail

/// Keep the last explicitly selected mail window when the Settings window takes focus.
/// A focused-value lookup would become nil as soon as Settings becomes the key window.
@MainActor
final class SettingsSession: ObservableObject {
    static let shared = SettingsSession()
    let objectWillChange = ObservableObjectPublisher()
    private weak var activeStore: MailStore?
    var store: MailStore? { activeStore }
    func select(_ store: MailStore) {
        guard activeStore !== store else { return }
        objectWillChange.send(); activeStore = store
    }
    /// macOS 13 has no public SwiftUI openSettings action. Invoke the Settings
    /// item installed by the Settings scene through the public NSMenu API.
    @discardableResult
    func open() -> Bool {
        guard let appMenu = NSApp.mainMenu?.items.first?.submenu else { return false }
        appMenu.update()
        guard let index = appMenu.items.firstIndex(where: {
            $0.keyEquivalent == "," && $0.keyEquivalentModifierMask.contains(.command)
        }) else { return false }
        appMenu.performActionForItem(at: index)
        return true
    }
}

/// Attach as the mail window's background. It has no visible or interactive content.
struct MailSettingsWindowContext: NSViewRepresentable {
    let store: MailStore
    func makeNSView(context: Context) -> NSView {
        let view = SettingsWindowContextView(frame: .zero)
        view.setAccessibilityElement(false)
        view.bind(store)
        return view
    }
    func updateNSView(_ nsView: NSView, context: Context) {
        (nsView as? SettingsWindowContextView)?.bind(store)
    }
    static func dismantleNSView(_ nsView: NSView, coordinator: ()) {
        (nsView as? SettingsWindowContextView)?.disconnect()
    }
}

private final class SettingsWindowContextView: NSView {
    private weak var store: MailStore?
    private weak var observedWindow: NSWindow?

    func bind(_ store: MailStore) {
        self.store = store
        trackCurrentWindow()
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        trackCurrentWindow()
    }
    private func trackCurrentWindow() {
        if observedWindow !== window {
            NotificationCenter.default.removeObserver(self, name: NSWindow.didBecomeKeyNotification, object: nil)
            observedWindow = window
            if let window {
                NotificationCenter.default.addObserver(self, selector: #selector(windowBecameKey(_:)), name: NSWindow.didBecomeKeyNotification, object: window)
            }
        }
        selectIfKey()
    }
    @objc private func windowBecameKey(_ notification: Notification) {
        guard let source = notification.object as? NSWindow, source === window else { return }
        selectIfKey()
    }
    private func selectIfKey() {
        guard window?.isKeyWindow == true, let store else { return }
        SettingsSession.shared.select(store)
    }
    func disconnect() {
        NotificationCenter.default.removeObserver(self, name: NSWindow.didBecomeKeyNotification, object: nil)
        observedWindow = nil; store = nil
    }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    deinit { NotificationCenter.default.removeObserver(self) }
}

struct MacSettingsOpenButton: View {
    let store: MailStore
    var body: some View {
        if #available(macOS 14, *) {
            ModernSettingsOpenButton(store: store)
        } else {
            Button {
                SettingsSession.shared.select(store)
                _ = SettingsSession.shared.open()
            } label: { Label("设置…", systemImage: "gearshape") }
            .accessibilityIdentifier("mailSettings")
        }
    }
}

@available(macOS 14, *)
private struct ModernSettingsOpenButton: View {
    let store: MailStore
    @Environment(\.openSettings) private var openSettings
    var body: some View {
        Button {
            SettingsSession.shared.select(store); openSettings()
        } label: { Label("设置…", systemImage: "gearshape") }
        .accessibilityIdentifier("mailSettings")
    }
}

struct MacSettingsView: View {
    @ObservedObject private var session = SettingsSession.shared
    @State private var selection = SettingsTab.general
    private enum SettingsTab: Hashable {
        case general, accounts, classification, viewing, notifications, devices
        var height: CGFloat {
            switch self {
            case .general: return 225
            case .accounts: return 420
            case .classification: return 650
            case .viewing: return 225
            case .notifications: return 430
            case .devices: return 480
            }
        }
    }
    var body: some View {
        TabView(selection: $selection) {
            GeneralMailSettings()
                .tabItem { Label("通用", systemImage: "gearshape") }.tag(SettingsTab.general)
            settingsForm {
                if let store = session.store {
                    AccountSettingsSections(store: store).id(ObjectIdentifier(store))
                } else { unpaired("在邮件主窗口连接服务器，即可管理邮箱账户。") }
            }
            .tabItem { Label("账户", systemImage: "person.crop.circle") }.tag(SettingsTab.accounts)
            settingsForm {
                if let store = session.store {
                    ClassificationSettingsSections(store: store).id(ObjectIdentifier(store))
                } else { unpaired("在邮件主窗口完成配对后可管理 AI 分类与资源限制。") }
            }
            .tabItem { Label("分类", systemImage: "tag") }.tag(SettingsTab.classification)
            ViewingMailSettings()
                .tabItem { Label("查看", systemImage: "text.alignleft") }.tag(SettingsTab.viewing)
            settingsForm { NotificationSettingsSection() }
                .tabItem { Label("通知", systemImage: "bell") }.tag(SettingsTab.notifications)
            settingsForm {
                if let store = session.store {
                    DeviceManagementSections(store: store).id(ObjectIdentifier(store))
                } else { unpaired("在邮件主窗口完成配对，即可批准新设备或撤销已有设备。") }
            }
            .tabItem { Label("设备", systemImage: "laptopcomputer.and.iphone") }.tag(SettingsTab.devices)
        }
        .frame(width: 620, height: selection.height)
    }
    private func settingsForm<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        Form { content() }.formStyle(.grouped)
    }
    private func unpaired(_ message: String) -> some View {
        Section {
            Label("尚未配对", systemImage: "person.crop.circle.badge.questionmark")
            Text(message).foregroundStyle(.secondary)
        }
    }
}

private struct GeneralMailSettings: View {
    @AppStorage(MailPreferenceKey.markReadOnOpen) private var markReadOnOpen = true
    @AppStorage(MailPreferenceKey.confirmBeforeTrash) private var confirmBeforeTrash = false
    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 18) {
            GridRow {
                Text("阅读：").gridColumnAlignment(.trailing)
                Toggle("打开邮件时标记为已读", isOn: $markReadOnOpen)
                    .accessibilityIdentifier("markReadOnOpen")
            }
            GridRow {
                Text("删除：")
                Toggle("移到废纸篓前询问", isOn: $confirmBeforeTrash)
                    .accessibilityIdentifier("confirmBeforeTrash")
            }
        }
        .toggleStyle(.checkbox)
        .padding(30)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

private struct ViewingMailSettings: View {
    @AppStorage(MailPreferenceKey.previewLines) private var previewLines = 2
    @AppStorage(MailPreferenceKey.showAccountAddress) private var showAccountAddress = true
    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 18) {
            GridRow {
                Text("列表预览：").gridColumnAlignment(.trailing)
                Picker("列表预览", selection: $previewLines) {
                    Text("无").tag(0)
                    ForEach(1...5, id: \.self) { Text("\($0) 行").tag($0) }
                }.labelsHidden().frame(width: 140).accessibilityIdentifier("previewLines")
            }
            GridRow {
                Text("邮箱：")
                Toggle("在邮件列表中显示所属邮箱", isOn: $showAccountAddress)
                    .accessibilityIdentifier("showAccountAddress")
            }
        }
        .toggleStyle(.checkbox)
        .padding(30)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
#endif
