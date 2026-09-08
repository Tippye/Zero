#if !os(watchOS)
import SwiftUI
import UniformTypeIdentifiers
import ZeroMail

struct ComposerView: View {
    @ObservedObject var store: MailStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    private let recoveryClient: MailClient?
    @State private var draft: MailComposer
    @State private var busy = false
    @State private var importing = false
    @State private var confirmClose = false
    @State private var confirmSend = false
    @State private var uncertain = false
    @State private var failure: String?
    @State private var pending: OutgoingMail?
    @State private var showAI = false
    @State private var recoveryFailure: String?
    @State private var finished = false
    init(store: MailStore, initial: MailComposer) {
        self.store = store; recoveryClient = store.client
        _draft = State(initialValue: initial); _uncertain = State(initialValue: initial.deliveryUncertain == true)
    }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Form {
                    Picker("发件邮箱", selection: $draft.accountId) {
                        ForEach(store.accounts.filter(\.connected)) { Text($0.email).tag($0.id) }
                    }.disabled(draft.draftId != nil || draft.threadId != nil)
                    TextField("收件人", text: $draft.to).accessibilityIdentifier("recipient")
                    TextField("抄送", text: $draft.cc).accessibilityIdentifier("cc")
                    TextField("密送", text: $draft.bcc).accessibilityIdentifier("bcc")
                    TextField("主题", text: $draft.subject).accessibilityIdentifier("subject")
                }.frame(maxHeight: 250)
                Divider()
                TextEditor(text: $draft.text).padding(8).accessibilityLabel("邮件正文").accessibilityIdentifier("messageBody")
                if !draft.attachments.isEmpty {
                    ScrollView(.horizontal) {
                        HStack {
                            ForEach(draft.attachments.indices, id: \.self) { i in
                                Button { draft.attachments.remove(at: i) } label: { Label(draft.attachments[i].name, systemImage: "xmark.circle") }
                            }
                        }.padding()
                    }
                }
                if let failure { Text(failure).font(.callout).foregroundStyle(.red).padding() }
                if let recoveryFailure { Text(recoveryFailure).font(.caption).foregroundStyle(.red).padding(.horizontal) }
                if uncertain {
                    Text("发送结果尚未确认。请先检查已发送文件夹；此窗口不会自动重发。可保存草稿后关闭。").font(.callout).padding()
                }
                if busy { ProgressView("处理中…").padding() }
            }
            .disabled(busy || uncertain)
            .navigationTitle(draft.draftId == nil ? "写邮件" : "编辑草稿")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { confirmClose = true }.disabled(busy) }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button { showAI = true } label: { Label("AI 写作", systemImage: "sparkles") }.disabled(busy || uncertain).accessibilityIdentifier("aiCompose")
                    Button { importing = true } label: { Label("添加附件", systemImage: "paperclip") }.disabled(busy || uncertain)
                    Button("保存草稿") { Task { await save() } }.disabled(busy).accessibilityIdentifier("saveDraft")
                    Button("发送") { prepareSend() }.disabled(busy || uncertain || draft.accountId.isEmpty).accessibilityIdentifier("send")
                }
            }
            .confirmationDialog("发送这封邮件？", isPresented: $confirmSend, titleVisibility: .visible) {
                Button("确认发送") { Task { await send() } }
            } message: { Text("从 \(store.accounts.first(where: { $0.id == draft.accountId })?.email ?? "") 发送给 \(draft.to)" + (draft.cc.isEmpty ? "" : "；抄送 " + draft.cc) + (draft.bcc.isEmpty ? "" : "；密送 " + draft.bcc)) }
            .sheet(isPresented: $showAI) { MailAIComposerView(store: store, initialText: draft.text) { draft.text = $0 } }
            .confirmationDialog("保留当前草稿？", isPresented: $confirmClose, titleVisibility: .visible) {
                Button("保存到邮箱并关闭") { Task { await save() } }
                Button("放弃本次编辑", role: .destructive) { discard() }
                Button("继续编辑", role: .cancel) { }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.data], allowsMultipleSelection: true) { result in
                do {
                    let urls = try result.get()
                    let files = try urls.map { url -> OutgoingAttachment in
                        let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                        let resource = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .contentTypeKey])
                        guard resource.isRegularFile == true, (resource.fileSize ?? Int.max) <= 15 * 1024 * 1024 else { throw MailFailure.oversizedAttachments }
                        return try OutgoingAttachment(name: url.lastPathComponent, type: resource.contentType?.preferredMIMEType ?? "application/octet-stream", data: Data(contentsOf: url))
                    }
                    var checked = draft; checked.attachments += files
                    guard checked.attachments.count <= 20, checked.attachments.reduce(0, { $0 + $1.size }) <= 15 * 1024 * 1024 else { throw MailFailure.oversizedAttachments }
                    draft = checked
                } catch { failure = error.localizedDescription }
            }
        }
        .onAppear { _ = persistRecovery() }
        .onChange(of: draft) { _ in _ = persistRecovery() }
        .onChange(of: scenePhase) { phase in if phase != .active { _ = persistRecovery() } }
        .onDisappear { if !finished { _ = persistRecovery() } }
        .interactiveDismissDisabled()
        #if os(macOS)
        .frame(minWidth: 640, minHeight: 560)
        #endif
    }
    private func prepareSend() {
        guard !uncertain, draft.deliveryUncertain != true else { return }
        do {
            let mail = try draft.outgoing()
            guard !(mail.to + mail.cc + mail.bcc).isEmpty else { throw MailFailure.invalidRecipients }
            pending = mail; failure = nil; confirmSend = true
        } catch { failure = error.localizedDescription }
    }
    private func send() async {
        guard !uncertain, let pending, let client = store.client, client === recoveryClient else { return }
        draft.deliveryUncertain = true
        guard persistRecovery() else { draft.deliveryUncertain = nil; return }
        busy = true; defer { busy = false }
        do {
            try await client.send(pending)
            finished = true
            do { try store.completeComposer(draft, client: recoveryClient) }
            catch { store.error = "邮件已发送，但本机恢复副本未能清除。请检查已发送邮件后删除本机副本。" }
            dismiss(); await store.reload()
        } catch { uncertain = true; _ = persistRecovery(); failure = error.localizedDescription; store.report(error) }
    }
    private func save() async {
        guard let client = store.client, client === recoveryClient, persistRecovery() else { return }
        busy = true; defer { busy = false }
        do {
            draft.draftId = try await client.saveDraft(draft.outgoing()); finished = true
            do { try store.completeComposer(draft, client: recoveryClient) }
            catch { store.error = "草稿已保存到邮箱，但本机恢复副本未能清除。" }
            dismiss(); await store.reload()
        }
        catch { failure = error.localizedDescription; store.report(error) }
    }
    private func persistRecovery() -> Bool {
        guard !finished else { return true }
        guard !draft.to.isEmpty || !draft.cc.isEmpty || !draft.bcc.isEmpty || !draft.subject.isEmpty || !draft.text.isEmpty || !draft.attachments.isEmpty || draft.deliveryUncertain == true else { return true }
        do {
            guard try store.saveRecovery(draft, client: recoveryClient) else { return false }
            recoveryFailure = nil; return true
        } catch { recoveryFailure = error.localizedDescription; return false }
    }
    private func discard() {
        do { try store.completeComposer(draft, client: recoveryClient); finished = true; dismiss() }
        catch { recoveryFailure = error.localizedDescription }
    }
}
#endif
