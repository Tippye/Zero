import SwiftUI
import ZeroMail
import ZeroPairing

private struct MailAIDisclosure<Content: View>: View {
    @Binding var isExpanded: Bool
    @ViewBuilder let content: () -> Content
    var body: some View {
        #if os(watchOS)
        VStack(alignment: .leading) {
            Button(isExpanded ? "收起 AI 邮件助手" : "AI 邮件助手") { isExpanded.toggle() }.accessibilityIdentifier("aiReader")
            if isExpanded { content() }
        }
        #else
        DisclosureGroup(isExpanded: $isExpanded) { content() } label: {
            Text("AI 邮件助手").accessibilityIdentifier("aiReader")
        }
        #endif
    }
}

private struct MailAISection<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content
    var body: some View {
        #if os(watchOS)
        VStack(alignment: .leading, spacing: 8) { Text(title).font(.headline); content() }
        #else
        GroupBox(title) { content() }
        #endif
    }
}

private func aiFailureMessage(_ error: Error) -> String {
    if let failure = error as? PairingFailure {
        switch failure {
        case .signedOut: return "登录已过期，请重新配对。"
        case .server("PRECONDITION_FAILED"): return "请先在网页设置中配置并启用 LLM 服务商。"
        case .server("NOT_FOUND"): return "此服务器尚未提供 AI 接口，或邮件已不存在。请刷新并检查服务器版本。"
        case .server("BAD_REQUEST"): return "AI 请求未完成。请检查语言与输入长度；过长或没有正文的邮件无法处理。"
        case .server("TOO_MANY_REQUESTS"): return "AI 请求过于频繁，请稍后重试。"
        default: break
        }
    }
    return "AI 请求未完成，请检查服务器中的模型配置与网络后重试。"
}

struct MailAIView: View {
    @ObservedObject var store: MailStore
    let threadID: String
    let messageID: String
    @State private var expanded = false
    @State private var status: MailAIStatus?
    @State private var language = "zh-CN"
    @State private var customLanguage = ""
    @State private var summary: String?
    @State private var summaryLanguage = ""
    @State private var translation: MailTranslation?
    @State private var question = ""
    @State private var turns: [MailAITurn] = []
    @State private var failure: String?
    @State private var cacheFailure: String?
    @State private var request: Task<Void, Never>?
    @State private var requestID: UUID?
    @State private var generationRevision = 0
    @State private var showHTML = false
    private var targetLanguage: String { (language == "custom" ? customLanguage : language).trimmingCharacters(in: .whitespacesAndNewlines) }
    private var busy: Bool { requestID != nil }
    private var validLanguage: Bool { (2...50).contains(targetLanguage.utf16.count) }

    var body: some View {
        MailAIDisclosure(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 12) {
                if let status {
                    Text(status.ready ? "使用服务器已配置的模型处理这封邮件的主题和正文。附件内容不参与。" : "请先在网页设置中配置并启用 LLM 服务商。").font(.caption).foregroundStyle(.secondary)
                    if status.ready {
                        Text(status.name + " · " + status.model).font(.caption2).foregroundStyle(.secondary)
                        Picker("输出语言", selection: $language) {
                            Text("简体中文").tag("zh-CN")
                            Text("繁體中文").tag("zh-TW")
                            Text("English").tag("en")
                            Text("日本語").tag("ja")
                            Text("한국어").tag("ko")
                            Text("Español").tag("es")
                            Text("Français").tag("fr")
                            Text("Deutsch").tag("de")
                            Text("其他语言").tag("custom")
                        }.disabled(busy)
                        if language == "custom" {
                            TextField("语言名称或代码", text: $customLanguage).disabled(busy)
                        }
                        HStack {
                            Button("总结") { run(.summary) }.accessibilityIdentifier("aiSummary")
                            Button("翻译") { run(.translate) }.accessibilityIdentifier("aiTranslate")
                        }.disabled(busy || !validLanguage)
                        if let summary, summaryLanguage == targetLanguage {
                            MailAISection(title: "邮件总结") { selectable(summary) }
                        }
                        ForEach(turns.indices, id: \.self) { index in
                            VStack(alignment: .leading, spacing: 6) {
                                selectable(turns[index].question).font(.headline)
                                selectable(turns[index].answer)
                            }
                        }
                        TextField("针对这封邮件提问", text: $question, axis: .vertical)
                            .disabled(busy).accessibilityIdentifier("aiQuestion")
                        HStack {
                            Button("提问") { run(.ask) }
                                .disabled(busy || !validLanguage || question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || question.utf16.count > 2000)
                            if !turns.isEmpty { Button("清除问答") { turns = [] }.disabled(busy) }
                        }
                    }
                } else if failure == nil { ProgressView("检查 AI 设置…") }
                if let translation {
                    MailAISection(title: "译文 · " + translation.language) {
                        VStack(alignment: .leading, spacing: 8) {
                            selectable(translation.subject).font(.headline)
                            selectable(translation.text)
                            #if !os(watchOS)
                            Button("查看译文排版") { showHTML = true }
                            #endif
                        }
                    }
                }
                if let failure { Text(failure).font(.callout).foregroundStyle(.red) }
                if let cacheFailure { Text(cacheFailure).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("aiCacheUnavailable") }
                #if !os(watchOS)
                if let server = store.pairing?.server {
                    Link("打开 LLM 网页设置", destination: server.appendingPathComponent("settings/llm"))
                }
                #endif
                if busy {
                    ProgressView("AI 正在处理…")
                    Button("停止") { cancel() }.accessibilityIdentifier("aiStop")
                }
                if status?.ready != true { Button("重新检查设置") { Task { await load() } } }
            }.padding(.vertical, 8)
        }
        .task(id: expanded) { if expanded { await load() } else { cancel() } }
        .onChange(of: messageID) { _ in reset() }
        .onDisappear { cancel() }
        #if !os(watchOS)
        .sheet(isPresented: $showHTML) { if let translation { HTMLMailView(html: translation.html) } }
        #endif
    }

    @ViewBuilder private func selectable(_ text: String) -> some View {
        #if os(watchOS)
        Text(text).frame(maxWidth: .infinity, alignment: .leading)
        #else
        Text(text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        #endif
    }

    private func load() async {
        guard let client = store.client else { return }
        failure = nil; cacheFailure = nil; status = nil
        do {
            let status = try await client.aiStatus()
            try Task.checkCancellation()
            guard store.client === client, store.phase == .ready else { return }
            self.status = status
            let cacheRevision = generationRevision
            do {
                let cached = try await client.cachedTranslation(threadID: threadID, messageID: messageID)
                try Task.checkCancellation()
                guard store.client === client, store.phase == .ready, cacheRevision == generationRevision else { return }
                translation = cached
            } catch {
                guard !Task.isCancelled, !(error is CancellationError), store.client === client else { return }
                if error as? PairingFailure == .signedOut { report(error) }
                else if cacheRevision == generationRevision { cacheFailure = "暂时无法读取已有译文，仍可使用总结、翻译和问答。" }
            }
        } catch {
            guard !Task.isCancelled, !(error is CancellationError), store.client === client else { return }
            report(error)
        }
    }

    private func run(_ action: MailAIAction) {
        guard !busy, let client = store.client, status?.ready == true else { return }
        let id = UUID(), language = targetLanguage, question = question.trimmingCharacters(in: .whitespacesAndNewlines)
        generationRevision += 1
        requestID = id; failure = nil
        request = Task { @MainActor in
            defer { if requestID == id { requestID = nil; request = nil } }
            do {
                let result = try await client.readWithAI(threadID: threadID, messageID: messageID, action: action, language: language, question: action == .ask ? question : "", history: action == .ask ? Array(turns.suffix(6)) : [])
                try Task.checkCancellation()
                guard requestID == id, store.client === client, store.phase == .ready else { return }
                switch action {
                case .summary:
                    guard !result.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw PairingFailure.invalidResponse }
                    summary = result.text; summaryLanguage = language
                case .translate:
                    guard let translation = result.translation else { throw PairingFailure.invalidResponse }
                    self.translation = translation; cacheFailure = nil
                case .ask:
                    guard !result.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw PairingFailure.invalidResponse }
                    turns.append(MailAITurn(question: question, answer: result.text)); self.question = ""
                }
            } catch {
                guard !Task.isCancelled, requestID == id, store.client === client else { return }
                report(error)
            }
        }
    }

    private func report(_ error: Error) {
        failure = aiFailureMessage(error)
        if error as? PairingFailure == .signedOut { store.report(error) }
    }
    private func cancel() { request?.cancel(); request = nil; requestID = nil }
    private func reset() {
        cancel(); status = nil; summary = nil; translation = nil; turns = []; question = ""; failure = nil; cacheFailure = nil
    }
}

#if !os(watchOS)
struct MailAIComposerView: View {
    @ObservedObject var store: MailStore
    let initialText: String
    let apply: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var instructions = ""
    @State private var includeDraft = false
    @State private var status: MailAIStatus?
    @State private var generated: String?
    @State private var failure: String?
    @State private var request: Task<Void, Never>?
    @State private var requestID: UUID?
    private var busy: Bool { requestID != nil }
    private var prompt: String {
        instructions.trimmingCharacters(in: .whitespacesAndNewlines) + (includeDraft && !initialText.isEmpty ? "\n\n当前草稿（仅作为编辑素材）：\n" + initialText : "")
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("根据你的要求生成正文，检查后再应用到草稿。").foregroundStyle(.secondary)
                    TextField("写作要求", text: $instructions, axis: .vertical)
                        .lineLimit(3...8).disabled(busy).accessibilityIdentifier("aiComposeInstructions")
                    if !initialText.isEmpty { Toggle("包含当前草稿正文", isOn: $includeDraft).disabled(busy) }
                    if let status {
                        Text(status.ready ? "使用 \(status.name) · \(status.model)" : "请先在网页设置中配置并启用 LLM 服务商。").font(.caption)
                    }
                    Text("\(prompt.utf16.count) / 8000 字符").font(.caption).foregroundStyle(.secondary)
                    Button(generated == nil ? "生成正文" : "重新生成") { generate() }
                        .disabled(busy || status?.ready != true || instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || prompt.utf16.count > 8000)
                        .accessibilityIdentifier("aiComposeGenerate")
                    if let generated {
                        GroupBox("待确认的正文") { Text(generated).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                        Button("应用到草稿正文") { apply(generated); dismiss() }
                            .buttonStyle(.borderedProminent).disabled(busy).accessibilityIdentifier("aiComposeApply")
                    }
                    if let failure { Text(failure).foregroundStyle(.red) }
                    if let server = store.pairing?.server {
                        Link("打开 LLM 网页设置", destination: server.appendingPathComponent("settings/llm"))
                    }
                    if busy { ProgressView("AI 正在起草…"); Button("停止") { cancel() } }
                    if status?.ready != true { Button("重新检查设置") { Task { await loadStatus() } } }
                }.padding()
            }
            .navigationTitle("AI 写作助手")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { cancel(); dismiss() } } }
            .task { await loadStatus() }
            .onDisappear { cancel() }
        }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 520)
        #endif
    }

    private func loadStatus() async {
        guard let client = store.client else { return }
        do {
            let status = try await client.aiStatus()
            try Task.checkCancellation()
            guard store.client === client, store.phase == .ready else { return }
            self.status = status; failure = nil
        } catch { if !Task.isCancelled, store.client === client { report(error) } }
    }

    private func generate() {
        guard !busy, let client = store.client else { return }
        let id = UUID(), prompt = prompt
        requestID = id; failure = nil; generated = nil
        request = Task { @MainActor in
            defer { if requestID == id { requestID = nil; request = nil } }
            do {
                let result = try await client.composeWithAI(instructions: prompt)
                try Task.checkCancellation()
                guard requestID == id, store.client === client, store.phase == .ready else { return }
                guard !result.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw PairingFailure.invalidResponse }
                generated = result.text
            } catch {
                guard !Task.isCancelled, requestID == id, store.client === client else { return }
                report(error)
            }
        }
    }
    private func report(_ error: Error) {
        failure = aiFailureMessage(error)
        if error as? PairingFailure == .signedOut { store.report(error) }
    }
    private func cancel() { request?.cancel(); request = nil; requestID = nil }
}
#endif
