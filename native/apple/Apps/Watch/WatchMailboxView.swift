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
                if store.folder == .inbox {
                    Picker("分类", selection: $store.category) {
                        ForEach(MailCategory.allCases) { Text($0.title).tag($0) }
                    }.accessibilityIdentifier("mailCategoryFilter")
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
                if !store.recoverableDrafts.isEmpty { Button("恢复本机草稿") { store.showDraftRecovery = true } }
                Button("设置与设备") { store.showSettings = true }
            }
            .navigationTitle("Zero Mail")
            .navigationDestination(for: String.self) { id in
                WatchThreadView(store: store).task(id: id) { await store.open(id: id) }
            }
            .sheet(isPresented: $store.showSettings) { DeviceSettingsView(store: store) }
            .sheet(isPresented: $store.showDraftRecovery, onDismiss: { store.finishRestoringDraft() }) { DraftRecoveryView(store: store) }
            .sheet(item: $store.composer) { draft in WatchReplyView(store: store, draft: draft) }
            .task(id: store.filterKey) { store.changeFilter(); await store.reload(); store.mailboxDidLoad() }
            .onChange(of: store.selectedID) { id in
                if let id { if path.last != id { path = [id] } }
                else { path = [] }
            }
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
                    MailAIView(store: store, threadID: thread.id, messageID: message.id).id(message.id)
                    if !message.attachments.isEmpty { Text("\(message.attachments.count) 个附件，请在其他设备查看。").font(.caption) }
                    Button("回复") { store.reply(message) }
                    Button(thread.starred ? "取消星标" : "星标") { Task { await store.act(thread.starred ? .unstar : .star, id: thread.id) } }
                    Button("标为未读") { Task { await store.act(.unread, id: thread.id) } }
                    Menu("移动至分类") {
                        ForEach(MailCategory.allCases.filter { $0 != .all }) { category in
                            Button(category.title) { Task { await store.moveCategory(category, id: thread.id) } }
                        }
                    }
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
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    private let recoveryClient: MailClient?
    @State private var draft: MailComposer
    @State private var busy = false
    @State private var confirm = false
    @State private var failed = false
    @State private var confirmClose = false
    @State private var finished = false
    @State private var failure: String?
    init(store: MailStore, draft: MailComposer) {
        self.store = store; recoveryClient = store.client
        _draft = State(initialValue: draft); _failed = State(initialValue: draft.deliveryUncertain == true)
    }
    var body: some View {
        NavigationStack {
            Form {
                if draft.threadId == nil {
                    Picker("发件邮箱", selection: $draft.accountId) {
                        ForEach(store.accounts.filter(\.connected)) { Text($0.email).tag($0.id) }
                    }.disabled(busy || failed || draft.draftId != nil)
                    TextField("收件人", text: $draft.to).disabled(busy || failed)
                    TextField("主题", text: $draft.subject).disabled(busy || failed)
                } else { Text("回复给 " + draft.to).font(.caption) }
                TextField("输入或听写正文", text: $draft.text).disabled(busy || failed)
                Button("发送") { confirm = true }.disabled(busy || draft.to.isEmpty || draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || failed)
                Button("保存草稿") { Task { await save() } }.disabled(busy)
                if busy { ProgressView() }
                if failed { Text("发送未确认，请先检查已发送邮件。此草稿不能再次发送，可保存到邮箱。").font(.caption) }
                if let failure { Text(failure).font(.caption).foregroundStyle(.red) }
                Button("关闭") { confirmClose = true }.disabled(busy)
            }
            .navigationTitle(draft.threadId == nil ? "写邮件" : "回复")
            .confirmationDialog("发送给 \(draft.to)？", isPresented: $confirm, titleVisibility: .visible) {
                Button("确认发送") { Task { await send() } }
            }
            .confirmationDialog("保留当前草稿？", isPresented: $confirmClose, titleVisibility: .visible) {
                Button("保存到邮箱并关闭") { Task { await save() } }
                Button("保留在本机并关闭") { if persistRecovery() { finished = true; dismiss() } }
                Button("放弃本次编辑", role: .destructive) { discard() }
            }
        }
        .interactiveDismissDisabled()
        .onAppear { _ = persistRecovery() }
        .onChange(of: draft) { _ in _ = persistRecovery() }
        .onChange(of: scenePhase) { phase in if phase != .active { _ = persistRecovery() } }
        .onDisappear { if !finished { _ = persistRecovery() } }
    }
    private func send() async {
        guard !failed, draft.deliveryUncertain != true, let client = store.client, client === recoveryClient else { return }
        do {
            let outgoing = try draft.outgoing()
            guard !(outgoing.to + outgoing.cc + outgoing.bcc).isEmpty else { throw MailFailure.invalidRecipients }
            draft.deliveryUncertain = true
            guard persistRecovery() else { draft.deliveryUncertain = nil; return }
            busy = true; defer { busy = false }
            do {
                try await client.send(outgoing); finished = true
                do { try store.completeComposer(draft, client: recoveryClient) }
                catch { store.error = "邮件已发送，但本机恢复副本未能清除，请检查后删除。" }
                dismiss(); await store.reload()
            } catch { failed = true; _ = persistRecovery(); failure = error.localizedDescription; store.report(error) }
        } catch { failure = error.localizedDescription }
    }
    private func save() async {
        guard let client = store.client, client === recoveryClient, persistRecovery() else { return }
        busy = true; defer { busy = false }
        do {
            draft.draftId = try await client.saveDraft(draft.outgoing()); finished = true
            do { try store.completeComposer(draft, client: recoveryClient) }
            catch { store.error = "草稿已保存到邮箱，但本机恢复副本未能清除。" }
            dismiss(); await store.reload()
        } catch { failure = error.localizedDescription; store.report(error) }
    }
    private func persistRecovery() -> Bool {
        guard !finished else { return true }
        do {
            guard try store.saveRecovery(draft, client: recoveryClient) else { return false }
            failure = nil; return true
        } catch { failure = error.localizedDescription; return false }
    }
    private func discard() {
        do { try store.completeComposer(draft, client: recoveryClient); finished = true; dismiss() }
        catch { failure = error.localizedDescription }
    }
}
