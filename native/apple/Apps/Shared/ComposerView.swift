#if !os(watchOS)
import SwiftUI
import UniformTypeIdentifiers
import ZeroMail

struct ComposerView: View {
    @ObservedObject var store: MailStore
    @Environment(\.dismiss) private var dismiss
    @State private var draft: MailComposer
    @State private var busy = false
    @State private var importing = false
    @State private var confirmClose = false
    @State private var confirmSend = false
    @State private var uncertain = false
    @State private var failure: String?
    @State private var pending: OutgoingMail?
    init(store: MailStore, initial: MailComposer) { self.store = store; _draft = State(initialValue: initial) }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Form {
                    Picker("发件邮箱", selection: $draft.accountId) {
                        ForEach(store.accounts.filter(\.connected)) { Text($0.email).tag($0.id) }
                    }.disabled(draft.draftId != nil || draft.threadId != nil)
                    TextField("收件人", text: $draft.to).accessibilityIdentifier("recipient")
                    TextField("抄送", text: $draft.cc)
                    TextField("密送", text: $draft.bcc)
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
                    Button { importing = true } label: { Label("添加附件", systemImage: "paperclip") }.disabled(busy || uncertain)
                    Button("保存草稿") { Task { await save() } }.disabled(busy)
                    Button("发送") { prepareSend() }.disabled(busy || uncertain || draft.accountId.isEmpty).accessibilityIdentifier("send")
                }
            }
            .confirmationDialog("发送这封邮件？", isPresented: $confirmSend, titleVisibility: .visible) {
                Button("确认发送") { Task { await send() } }
            } message: { Text("从 \(store.accounts.first(where: { $0.id == draft.accountId })?.email ?? "") 发送给 \(draft.to)" + (draft.cc.isEmpty ? "" : "；抄送 " + draft.cc) + (draft.bcc.isEmpty ? "" : "；密送 " + draft.bcc)) }
            .confirmationDialog("保留当前草稿？", isPresented: $confirmClose, titleVisibility: .visible) {
                Button("保存到邮箱并关闭") { Task { await save() } }
                Button("放弃本次编辑", role: .destructive) { dismiss() }
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
        .interactiveDismissDisabled()
        #if os(macOS)
        .frame(minWidth: 640, minHeight: 560)
        #endif
    }
    private func prepareSend() {
        do {
            let mail = try draft.outgoing()
            guard !(mail.to + mail.cc + mail.bcc).isEmpty else { throw MailFailure.invalidRecipients }
            pending = mail; failure = nil; confirmSend = true
        } catch { failure = error.localizedDescription }
    }
    private func send() async {
        guard let pending, let client = store.client else { return }
        busy = true; defer { busy = false }
        do { try await client.send(pending); dismiss(); await store.reload() }
        catch { uncertain = true; failure = error.localizedDescription; store.report(error) }
    }
    private func save() async {
        guard let client = store.client else { return }
        busy = true; defer { busy = false }
        do { draft.draftId = try await client.saveDraft(draft.outgoing()); dismiss(); await store.reload() }
        catch { failure = error.localizedDescription; store.report(error) }
    }
}
#endif
