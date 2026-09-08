import SwiftUI
import ZeroMail

struct DraftRecoveryView: View {
    @ObservedObject var store: MailStore
    @Environment(\.dismiss) private var dismiss
    @State private var discard: RecoveredDraft?
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("这些草稿已加密保存在这台设备上。选择恢复后可继续编辑；不会自动发送。").font(.footnote)
                }
                if let failure = store.recoveryFailure { Text(failure).foregroundStyle(.red) }
                ForEach(store.recoverableDrafts) { recovered in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(recovered.draft.subject.isEmpty ? "无主题草稿" : recovered.draft.subject).font(.headline)
                        Text(store.accounts.first(where: { $0.id == recovered.draft.accountId })?.email ?? "").font(.caption)
                        Text(recovered.updatedAt, style: .date).font(.caption)
                        if recovered.draft.deliveryUncertain == true {
                            Text("曾尝试发送，请先检查已发送邮件。恢复后发送保持禁用，可保存草稿。").font(.caption).foregroundStyle(.orange)
                        }
                        Button("恢复草稿") { store.restoreDraft(recovered) }.accessibilityIdentifier("restoreDraft")
                        Button("删除本机副本", role: .destructive) { discard = recovered }
                    }
                }
                if store.recoverableDrafts.isEmpty { Text("没有待恢复的草稿。") }
            }
            .navigationTitle("恢复草稿")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("稍后") { dismiss() } } }
            .confirmationDialog("删除这份本机恢复草稿？", isPresented: Binding(get: { discard != nil }, set: { if !$0 { discard = nil } }), titleVisibility: .visible) {
                if let discard { Button("删除本机副本", role: .destructive) { store.discardRecoveredDraft(discard); self.discard = nil } }
            }
        }
        .onAppear { store.refreshDraftRecovery() }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 440)
        #endif
    }
}
