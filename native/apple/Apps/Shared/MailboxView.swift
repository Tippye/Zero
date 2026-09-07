#if !os(watchOS)
import SwiftUI
import ZeroMail

struct MailboxView: View {
    @ObservedObject var store: MailStore
    var body: some View {
        NavigationSplitView {
            List(selection: Binding<MailFolder?>(get: { store.folder }, set: { if let folder = $0 { store.folder = folder } })) {
                Section("邮箱") {
                    Picker("账户", selection: $store.accountID) {
                        Text("所有邮箱").tag("")
                        ForEach(store.accounts) { Text($0.email).tag($0.id) }
                    }
                }
                Section {
                    ForEach(MailFolder.allCases) { folder in
                        NavigationLink(value: folder) { Label(folder.title, systemImage: folder.symbol) }
                    }
                }
                Section {
                    Button { store.showSettings = true } label: { Label("设置与设备", systemImage: "gear") }
                }
            }
            .navigationTitle("Zero Mail")
        } content: {
            ThreadListView(store: store)
        } detail: {
            ThreadDetailView(store: store)
        }
        .toolbar {
            ToolbarItemGroup {
                Button { Task { await store.refresh() } } label: { Label("刷新", systemImage: "arrow.clockwise") }.disabled(store.loading)
                Button { store.compose() } label: { Label("写邮件", systemImage: "square.and.pencil") }
            }
        }
        .sheet(isPresented: $store.showSettings) { DeviceSettingsView(store: store) }
        .sheet(item: $store.composer) { draft in ComposerView(store: store, initial: draft) }
        .task(id: store.filterKey) {
            store.changeFilter()
            do {
                if !store.query.isEmpty { try await Task.sleep(nanoseconds: 350_000_000) }
                try Task.checkCancellation(); await store.reload()
                store.mailboxDidLoad()
            } catch { }
        }
    }
}

struct ThreadListView: View {
    @ObservedObject var store: MailStore
    var body: some View {
        List(selection: $store.selectedID) {
            ForEach(store.warnings.indices, id: \.self) { index in
                Label(store.warnings[index].email + "：" + store.warnings[index].message, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
            }
            ForEach(store.threads) { thread in
                NavigationLink(value: thread.id) { MailRow(thread: thread) }
                    .contextMenu {
                        Button(thread.unread ? "标为已读" : "标为未读") { Task { await store.act(thread.unread ? .read : .unread, id: thread.id) } }
                        Button(thread.starred ? "取消星标" : "添加星标") { Task { await store.act(thread.starred ? .unstar : .star, id: thread.id) } }
                        Button("归档") { Task { await store.act(.archive, id: thread.id) } }
                        Button("移到废纸篓", role: .destructive) { Task { await store.act(.trash, id: thread.id) } }
                    }
                    .swipeActions {
                        Button { Task { await store.act(.archive, id: thread.id) } } label: { Label("归档", systemImage: "archivebox") }.tint(.blue)
                    }
            }
            if store.cursor != nil { Button("载入更多") { Task { await store.reload(more: true) } }.disabled(store.loading) }
            if store.loading { ProgressView("载入邮件…") }
            if !store.loading, store.threads.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text(store.accounts.isEmpty ? "尚未连接邮箱" : "没有邮件").font(.headline)
                    Text(store.accounts.isEmpty ? "在网页的设置 → 邮箱连接中添加账户，然后刷新。" : "可尝试其他文件夹或搜索条件。").foregroundStyle(.secondary)
                }.padding(.vertical)
            }
        }
        .navigationTitle(store.folder.title)
        .searchable(text: $store.query, prompt: "搜索邮件")
        .refreshable { await store.refresh() }
        .onChange(of: store.selectedID) { id in if let id { Task { await store.open(id: id) } } }
    }
}

struct MailRow: View {
    let thread: MailSummary
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                if thread.unread { Circle().fill(.tint).frame(width: 7, height: 7).accessibilityLabel("未读") }
                Text(thread.sender.display.isEmpty ? thread.accountEmail : thread.sender.display).fontWeight(thread.unread ? .semibold : .regular).lineLimit(1)
                Spacer(minLength: 4)
                if thread.starred { Image(systemName: "star.fill").foregroundStyle(.yellow).accessibilityLabel("星标") }
            }
            Text(thread.subject.isEmpty ? "无主题" : thread.subject).font(.subheadline).lineLimit(2)
            if !thread.snippet.isEmpty { Text(thread.snippet).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
            Text(thread.accountEmail).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }.padding(.vertical, 4)
    }
}

struct ThreadDetailView: View {
    private struct HTMLPresentation: Identifiable { let id = UUID(); let html: String }
    @ObservedObject var store: MailStore
    @State private var exported: URL?
    @State private var exporting = false
    @State private var htmlPresentation: HTMLPresentation?
    var body: some View {
        Group {
            if store.reading { ProgressView("读取邮件…") }
            else if let thread = store.detail {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        ForEach(thread.messages) { message in
                            VStack(alignment: .leading, spacing: 12) {
                                Text(message.subject.isEmpty ? "无主题" : message.subject).font(.title2.bold()).textSelection(.enabled)
                                Text(message.sender.display + " <" + message.sender.email + ">").font(.subheadline).textSelection(.enabled)
                                Text("收件人：" + message.to.map(\.email).joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
                                Text(message.receivedOn).font(.caption).foregroundStyle(.secondary)
                                Divider()
                                Text(message.text.isEmpty ? "此邮件没有可显示的文字正文。" : message.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                                if !message.html.isEmpty {
                                    Button("查看邮件排版") { htmlPresentation = HTMLPresentation(html: message.html) }
                                }
                                ForEach(message.attachments) { attachment in
                                    Button { Task { await export(attachment, messageID: message.id) } } label: {
                                        Label(attachment.filename + " · " + ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file), systemImage: "paperclip")
                                    }.disabled(exporting)
                                }
                                HStack {
                                    Button("回复") { store.reply(message) }
                                    Button("回复全部") { store.reply(message, all: true) }
                                    Button("转发正文") { store.reply(message, forward: true) }
                                }
                                Divider()
                            }
                        }
                        if let exported { ShareLink("保存或分享附件", item: exported) }
                    }.padding(24).frame(maxWidth: 900)
                }
                .userActivity(MailLink.activityType) { activity in
                    guard let server = store.pairing?.server else { return }
                    activity.title = "在 Zero Mail 中继续阅读"
                    activity.userInfo = ["route": MailLink.thread(server: server, id: thread.id).url.absoluteString]
                    activity.isEligibleForHandoff = true
                    activity.isEligibleForSearch = false; activity.isEligibleForPublicIndexing = false
                }
                .toolbar {
                    Button { Task { await store.act(thread.starred ? .unstar : .star, id: thread.id) } } label: { Label("星标", systemImage: thread.starred ? "star.fill" : "star") }
                    Button { Task { await store.act(.unread, id: thread.id) } } label: { Label("标为未读", systemImage: "envelope.badge") }
                    Button { Task { await store.act(.archive, id: thread.id) } } label: { Label("归档", systemImage: "archivebox") }
                    Button { Task { await store.act(.trash, id: thread.id) } } label: { Label("移到废纸篓", systemImage: "trash") }
                }
            } else {
                VStack(spacing: 16) {
                    Image(systemName: "envelope.open").font(.largeTitle)
                    if let id = store.selectedID { Button("重新读取") { Task { await store.open(id: id) } } }
                    else { Text("选择一封邮件").foregroundStyle(.secondary) }
                }
            }
        }
        .onChange(of: store.selectedID) { _ in clearExport() }
        .onDisappear { clearExport() }
        .sheet(item: $htmlPresentation) { HTMLMailView(html: $0.html) }
    }
    private func export(_ attachment: MailAttachment, messageID: String) async {
        exporting = true; defer { exporting = false }
        do {
            guard let client = store.client else { return }
            let selected = store.selectedID
            let all = try await client.attachments(messageID: messageID)
            guard selected == store.selectedID, store.phase == .ready else { return }
            guard let item = all.first(where: { $0.id == attachment.id }) else { throw MailFailure.invalidAttachment }
            let data = try item.decodedData()
            clearExport()
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("zero-attachment-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(item.safeFilename)
            #if os(iOS)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            #else
            try data.write(to: url, options: .atomic)
            #endif
            exported = url
        } catch { store.report(error) }
    }
    private func clearExport() {
        if let exported { try? FileManager.default.removeItem(at: exported.deletingLastPathComponent()) }; exported = nil
    }
}
#endif
