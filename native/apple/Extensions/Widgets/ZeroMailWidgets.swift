import SwiftUI
import WidgetKit
import ZeroMail

private struct MailEntry: TimelineEntry {
    let date: Date
    let snapshot: MailWidgetSnapshot
}
private struct MailTimeline: TimelineProvider {
    func placeholder(in context: Context) -> MailEntry { MailEntry(date: Date(), snapshot: .signedOut) }
    func getSnapshot(in context: Context, completion: @escaping (MailEntry) -> Void) { completion(entry()) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<MailEntry>) -> Void) {
        completion(Timeline(entries: [entry()], policy: .after(Date().addingTimeInterval(15 * 60))))
    }
    private func entry() -> MailEntry { MailEntry(date: Date(), snapshot: (try? AppGroupBridge.shared().snapshot()) ?? .signedOut) }
}

private struct MailWidgetBackground: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 17.0, macOS 14.0, watchOS 10.0, *) {
            content.containerBackground(for: .widget) { Color.clear }
        } else { content.padding(8) }
    }
}

private struct InboxWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: MailEntry
    private var status: String {
        if !entry.snapshot.paired { return "打开应用完成配对" }
        if entry.snapshot.connectedAccounts == 0 { return "尚未连接邮箱" }
        return "最近未读 \(entry.snapshot.recentUnread)"
    }
    var body: some View {
        Group {
            #if !os(macOS)
            if family == .accessoryCircular {
                VStack(spacing: 1) {
                    Image(systemName: "envelope")
                    if entry.snapshot.paired { Text("\(entry.snapshot.recentUnread)").privacySensitive() }
                }.accessibilityLabel(status)
            } else if family == .accessoryInline {
                Label(status, systemImage: "envelope").privacySensitive()
            } else if family == .accessoryRectangular {
                VStack(alignment: .leading) {
                    Label("Zero Mail", systemImage: "envelope")
                    Text(status).font(.caption).privacySensitive()
                    if let date = entry.snapshot.checkedAt { Text(date, style: .relative).font(.caption2) }
                }
            } else { fullView }
            #else
            fullView
            #endif
        }
        .modifier(MailWidgetBackground())
        .widgetURL(MailLink.inbox.url)
    }
    private var fullView: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Zero Mail", systemImage: "envelope.fill").font(.headline)
            Text(status).font(.title3.bold()).privacySensitive()
            if entry.snapshot.paired {
                Text(entry.snapshot.partial ? "最近检查的部分收件箱" : "最近检查的收件箱").font(.caption2).foregroundStyle(.secondary)
                if let date = entry.snapshot.checkedAt {
                    HStack(spacing: 3) { Text("更新于"); Text(date, style: .relative) }.font(.caption2).foregroundStyle(.secondary)
                }
            }
            #if !os(watchOS)
            if family == .systemMedium {
                HStack {
                    Link(destination: MailLink.inbox.url) { Label("收件箱", systemImage: "tray") }
                    Spacer()
                    Link(destination: MailLink.compose(to: "", subject: "", text: "").url) { Label("写邮件", systemImage: "square.and.pencil") }
                }.font(.caption)
            }
            #endif
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

private var inboxFamilies: [WidgetFamily] {
    #if os(watchOS)
    return [.accessoryCircular, .accessoryRectangular, .accessoryInline]
    #elseif os(iOS)
    return [.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline]
    #else
    return [.systemSmall, .systemMedium]
    #endif
}
private struct InboxWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "org.zero.mail.inbox", provider: MailTimeline()) { InboxWidgetView(entry: $0) }
            .configurationDisplayName("Zero Mail 收件箱")
            .description("查看最近检查的未读数量并打开收件箱。内容由应用更新。")
            .supportedFamilies(inboxFamilies)
    }
}
private struct ComposeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "org.zero.mail.compose", provider: MailTimeline()) { _ in
            VStack(spacing: 5) {
                Image(systemName: "square.and.pencil").font(.title2)
                Text("写邮件").font(.caption)
            }
            .modifier(MailWidgetBackground())
            .widgetURL(MailLink.compose(to: "", subject: "", text: "").url)
        }
        .configurationDisplayName("Zero Mail 写邮件")
        .description("打开空白草稿，检查收件人与内容后手动发送。")
        .supportedFamilies(composeFamilies)
    }
    private var composeFamilies: [WidgetFamily] {
        #if os(watchOS)
        return [.accessoryCircular, .accessoryRectangular]
        #elseif os(iOS)
        return [.systemSmall, .accessoryCircular, .accessoryRectangular]
        #else
        return [.systemSmall]
        #endif
    }
}
@main
struct ZeroMailWidgets: WidgetBundle {
    var body: some Widget { InboxWidget(); ComposeWidget() }
}
