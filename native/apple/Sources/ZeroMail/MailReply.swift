import Foundation

extension MailThread {
    /// Prefer the mailbox that owns the thread, including when Handoff opens it outside the list.
    public func replyAccount(for message: MailMessage, accounts: [MailAccount], listedAccountID: String? = nil) -> MailAccount? {
        func account(_ id: String) -> MailAccount? { accounts.first { $0.id == id && $0.connected } }
        if let accountId { return account(accountId) }
        // Older servers omit accountId. Match the server's mbx.<encoded account>.<encoded id> format.
        if id.hasPrefix("mbx.") {
            let parts = id.dropFirst(4).split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2,
                  let owner = String(parts[0]).removingPercentEncoding, !owner.isEmpty,
                  let nativeID = String(parts[1]).removingPercentEncoding, !nativeID.isEmpty else { return nil }
            return account(owner)
        }
        if let listedAccountID { return account(listedAccountID) }
        // Legacy unscoped IDs may be matched only when exactly one connected account fits.
        let addresses = Set(([message.sender] + message.to + message.cc).map { $0.email.lowercased() })
        let candidates = accounts.filter { $0.connected && addresses.contains($0.email.lowercased()) }
        return candidates.count == 1 ? candidates[0] : nil
    }
}
