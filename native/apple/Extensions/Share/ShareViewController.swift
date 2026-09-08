import UIKit
import SwiftUI
import UniformTypeIdentifiers
import ZeroMail

@MainActor
private final class ShareState: ObservableObject {
    @Published var loading = true
    @Published var queued = false
    @Published var subject = ""
    @Published var text = ""
    @Published var attachments: [OutgoingAttachment] = []
    @Published var error: String?
}

final class ShareViewController: UIViewController {
    private let state = ShareState()
    private var loadingTask: Task<Void, Never>?
    override func viewDidLoad() {
        super.viewDidLoad()
        let view = ShareReviewView(state: state, save: { [weak self] in self?.save() }, close: { [weak self] in self?.finish() })
        let host = UIHostingController(rootView: view)
        addChild(host); self.view.addSubview(host.view)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([host.view.leadingAnchor.constraint(equalTo: self.view.leadingAnchor), host.view.trailingAnchor.constraint(equalTo: self.view.trailingAnchor), host.view.topAnchor.constraint(equalTo: self.view.topAnchor), host.view.bottomAnchor.constraint(equalTo: self.view.bottomAnchor)])
        host.didMove(toParent: self)
        loadingTask = Task { [weak self] in await self?.load() }
    }
    deinit { loadingTask?.cancel() }
    private func load() async {
        defer { state.loading = false }
        do {
            let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
            let providers = items.flatMap { $0.attachments ?? [] }
            guard !providers.isEmpty, providers.count <= 20 else { throw AppGroupFailure.invalidShare }
            var text: [String] = []
            var attachments: [OutgoingAttachment] = []
            var totalBytes = 0
            for provider in providers {
                try Task.checkCancellation()
                if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    let item = try await loadItem(provider, type: UTType.fileURL.identifier)
                    guard let url = item as? URL, url.isFileURL else { throw AppGroupFailure.invalidShare }
                    let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                    let attachment = try Self.attachment(url: url, name: url.lastPathComponent, type: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream", remaining: 15 * 1024 * 1024 - totalBytes)
                    totalBytes += attachment.size; attachments.append(attachment)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    let item = try await loadItem(provider, type: UTType.url.identifier)
                    guard let url = item as? URL, ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.user == nil, url.password == nil else { throw AppGroupFailure.invalidShare }
                    text.append(url.absoluteString)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    let item = try await loadItem(provider, type: UTType.plainText.identifier)
                    if let string = item as? String { text.append(string) }
                    else if let data = item as? Data, data.count <= 200 * 1024, let string = String(data: data, encoding: .utf8) { text.append(string) }
                    else { throw AppGroupFailure.invalidShare }
                } else if let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .data) == true }) {
                    let attachment = try await loadAttachment(provider, type: type, remaining: 15 * 1024 * 1024 - totalBytes)
                    totalBytes += attachment.size; attachments.append(attachment)
                } else { throw AppGroupFailure.invalidShare }
                guard text.reduce(0, { $0 + $1.utf8.count + 2 }) <= 200 * 1024 else { throw AppGroupFailure.invalidShare }
            }
            try Task.checkCancellation()
            state.subject = String((items.first?.attributedTitle?.string ?? "").prefix(200))
            state.text = text.joined(separator: "\n\n")
            state.attachments = attachments
            _ = try SharedMailDraft(subject: state.subject, text: state.text, attachments: attachments)
        } catch is CancellationError { }
        catch { state.error = error.localizedDescription }
    }
    private func loadItem(_ provider: NSItemProvider, type: String) async throws -> NSSecureCoding {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type, options: nil) { item, error in
                if let error { continuation.resume(throwing: error) }
                else if let item { continuation.resume(returning: item) }
                else { continuation.resume(throwing: AppGroupFailure.invalidShare) }
            }
        }
    }
    private func loadAttachment(_ provider: NSItemProvider, type: String, remaining: Int) async throws -> OutgoingAttachment {
        let suggested = provider.suggestedName
        return try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                if let error { continuation.resume(throwing: error); return }
                guard let url else { continuation.resume(throwing: AppGroupFailure.invalidShare); return }
                // The temporary file is valid only during this callback; read the bounded copy here.
                do {
                    let contentType = UTType(type)
                    var name = suggested ?? url.lastPathComponent
                    if (name as NSString).pathExtension.isEmpty, let suffix = contentType?.preferredFilenameExtension { name += "." + suffix }
                    continuation.resume(returning: try Self.attachment(url: url, name: name, type: contentType?.preferredMIMEType ?? "application/octet-stream", remaining: remaining))
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
    nonisolated private static func attachment(url: URL, name: String, type: String, remaining: Int) throws -> OutgoingAttachment {
        let attributes = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard attributes.isRegularFile == true, remaining >= 0, (attributes.fileSize ?? Int.max) <= remaining else { throw AppGroupFailure.invalidShare }
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        let data = try handle.read(upToCount: remaining + 1) ?? Data()
        guard data.count <= remaining else { throw AppGroupFailure.invalidShare }
        let safeName = String(name.components(separatedBy: CharacterSet(charactersIn: "/\\:").union(.controlCharacters)).joined(separator: "_").prefix(180))
        return try OutgoingAttachment(name: safeName.isEmpty ? "attachment" : safeName, type: type, data: data)
    }
    private func save() {
        guard !state.loading, !state.queued else { return }
        do {
            let draft = try SharedMailDraft(subject: state.subject, text: state.text, attachments: state.attachments)
            try AppGroupBridge.shared().queue(draft)
            state.queued = true; state.error = nil
        } catch { state.error = error.localizedDescription }
    }
    private func finish() {
        loadingTask?.cancel()
        extensionContext?.completeRequest(returningItems: nil)
    }
}

private struct ShareReviewView: View {
    @ObservedObject var state: ShareState
    let save: () -> Void
    let close: () -> Void
    var body: some View {
        NavigationStack {
            Form {
                if state.loading { ProgressView("正在读取分享内容…") }
                else if state.queued {
                    Label("已保存待导入内容", systemImage: "checkmark.circle")
                    Text("请打开 Zero Mail，配对后确认导入。收件人保持为空，需要你检查并手动发送。待导入内容保留 24 小时。")
                } else {
                    Section("创建待检查草稿") {
                        TextField("主题（可选）", text: $state.subject)
                        TextEditor(text: $state.text).frame(minHeight: 140).accessibilityLabel("分享正文")
                        ForEach(state.attachments) { attachment in
                            Label(attachment.name, systemImage: "paperclip").font(.caption)
                        }
                        Text("\(state.attachments.count) 个附件 · 收件人为空，不会自动发送。").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if let error = state.error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("分享至 Zero Mail")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(state.queued ? "完成" : "取消", action: close) }
                if !state.queued {
                    ToolbarItem(placement: .confirmationAction) { Button("保存", action: save).disabled(state.loading || (state.text.isEmpty && state.attachments.isEmpty)).accessibilityIdentifier("saveSharedDraft") }
                }
            }
        }
    }
}
