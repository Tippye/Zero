import SwiftUI
import ZeroMail

struct WatchMailboxView: View {
    @ObservedObject var store: MailStore
    @State private var path: [String] = []
    var body: some View {
        NavigationStack(path: $path) {
            List {
                Picker("邮箱", selection: $store.accountID) {
                    Text("所有邮箱").tag("")
                    ForEach(store.accounts) { Text($0.email).tag($0.id) }
                }
                Picker("文件夹", selection: $store.folder) {
                    ForEach([MailFolder.inbox, .starred, .sent, .archive]) { Text($0.title).tag($0) }
                }
                Button("刷新") { Task { await store.refresh() } }.disabled(store.loading)
                ForEach(store.warnings.indices, id: \.self) { index in Text(store.warnings[index].message).font(.caption).foregroundStyle(.orange) }
                ForEach(store.threads) { thread in
                    NavigationLink(value: thread.id) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(thread.sender.display).font(.headline).lineLimit(1)
                            Text(thread.subject.isEmpty ? "无主题" : thread.subject).lineLimit(2)
                            if thread.unread { Text("未读").font(.caption).foregroundStyle(.tint) }
                        }
                    }
                }
                if store.loading { ProgressView() }
                else if store.threads.isEmpty { Text(store.accounts.isEmpty ? "请在网页连接邮箱后刷新。" : "没有邮件") }
                if store.cursor != nil { Button("更多邮件") { Task { await store.reload(more: true) } }.disabled(store.loading) }
                Button("设置与设备") { store.showSettings = true }
            }
            .navigationTitle("Zero Mail")
            .navigationDestination(for: String.self) { id in
                WatchThreadView(store: store).task(id: id) { await store.open(id: id) }
            }
            .sheet(isPresented: $store.showSettings) { DeviceSettingsView(store: store) }
            .sheet(item: $store.composer) { draft in WatchReplyView(store: store, draft: draft) }
            .task(id: store.filterKey) { store.changeFilter(); await store.reload(); store.mailboxDidLoad() }
            .onChange(of: store.selectedID) { id in if let id, path.last != id { path = [id] } }
        }
    }
}

struct WatchThreadView: View {
    @ObservedObject var store: MailStore
    @State private var confirmTrash = false
    var body: some View {
        ScrollView {
            if let thread = store.detail, let message = thread.messages.last {
                VStack(alignment: .leading, spacing: 14) {
                    Text(message.subject.isEmpty ? "无主题" : message.subject).font(.headline)
                    Text(message.sender.display).font(.caption)
                    Text(message.text.isEmpty ? "请在 iPhone、iPad 或 Mac 上查看这封邮件的排版与附件。" : message.text)
                    if !message.attachments.isEmpty { Text("\(message.attachments.count) 个附件，请在其他设备查看。").font(.caption) }
                    Button("回复") { store.reply(message) }
                    Button(thread.starred ? "取消星标" : "星标") { Task { await store.act(thread.starred ? .unstar : .star, id: thread.id) } }
                    Button("标为未读") { Task { await store.act(.unread, id: thread.id) } }
                    Button("归档") { Task { await store.act(.archive, id: thread.id) } }
                    Button("移到废纸篓", role: .destructive) { confirmTrash = true }
                }.padding(.horizontal)
                .userActivity(MailLink.activityType) { activity in
                    guard let server = store.pairing?.server else { return }
                    activity.title = "在 Zero Mail 中继续阅读"
                    activity.userInfo = ["route": MailLink.thread(server: server, id: thread.id).url.absoluteString]
                    activity.isEligibleForHandoff = true
                    activity.isEligibleForSearch = false; activity.isEligibleForPublicIndexing = false
                }
                .confirmationDialog("移到废纸篓？", isPresented: $confirmTrash, titleVisibility: .visible) {
                    Button("移到废纸篓", role: .destructive) { Task { await store.act(.trash, id: thread.id) } }
                }
            } else if store.reading { ProgressView() }
            else { Text("请选择邮件或返回后重试。") }
        }
    }
}

struct WatchReplyView: View {
    @ObservedObject var store: MailStore
    let draft: MailComposer
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var busy = false
    @State private var confirm = false
    @State private var failed = false
    var body: some View {
        NavigationStack {
            Form {
                Text("回复给 " + draft.to).font(.caption)
                TextField("输入或听写回复", text: $text)
                Button("发送回复") { confirm = true }.disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || failed)
                if busy { ProgressView() }
                if failed { Text("发送未确认，请在其他设备检查已发送邮件。不会自动重发。").font(.caption) }
                Button("关闭") { dismiss() }.disabled(busy)
            }
            .navigationTitle("回复")
            .confirmationDialog("发送回复给 \(draft.to)？", isPresented: $confirm, titleVisibility: .visible) {
                Button("确认发送") {
                    Task {
                        busy = true; defer { busy = false }
                        do {
                            guard let client = store.client else { return }
                            var outgoing = draft; outgoing.text = text + draft.text
                            try await client.send(outgoing.outgoing()); dismiss(); await store.reload()
                        } catch { failed = true; store.report(error) }
                    }
                }
            }
        }
    }
}
