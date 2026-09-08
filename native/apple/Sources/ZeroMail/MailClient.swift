import Foundation
import ZeroPairing

public actor MailClient {
    public nonisolated let pairing: PairingClient
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    // Chosen only by a successful capability check; never by retrying a submitted AI mutation.
    var usesLegacyAI = false
    public init(pairing: PairingClient) { self.pairing = pairing }
    private struct Empty: Codable {}
    private struct ID: Encodable { let id: String }
    private func call<Input: Encodable, Output: Decodable>(_ operation: String, _ input: Input, as: Output.Type = Output.self) async throws -> Output {
        try decoder.decode(Output.self, from: await pairing.mailRequest(operation: operation, body: encoder.encode(input)))
    }
    public func accounts() async throws -> [MailAccount] {
        struct Result: Decodable { let accounts: [MailAccount] }
        return try await call("accounts", Empty(), as: Result.self).accounts
    }
    public func threads(accountID: String? = nil, folder: MailFolder = .inbox, category: MailCategory? = nil, query: String = "", cursor: String? = nil) async throws -> MailPage {
        struct Input: Encodable { let accountId: String?; let folder: String; let category: String?; let q: String; let cursor: String; let maxResults = 20 }
        let selected = category == .all ? nil : category?.rawValue
        return try await call("threads", Input(accountId: accountID, folder: folder.rawValue, category: selected, q: query, cursor: cursor ?? ""))
    }
    public func thread(id: String) async throws -> MailThread { try await call("thread", ID(id: id)) }
    public func attachments(messageID: String) async throws -> [MailAttachment] {
        struct Result: Decodable { let attachments: [MailAttachment] }
        return try await call("attachments", ID(id: messageID), as: Result.self).attachments
    }
    public enum Action: String, Sendable { case read, unread, star, unstar, archive, trash }
    public func action(_ action: Action, ids: [String]) async throws {
        struct Input: Encodable { let action: String; let ids: [String] }
        let _: Empty = try await call("action", Input(action: action.rawValue, ids: ids))
    }
    public func send(_ mail: OutgoingMail) async throws {
        struct Result: Decodable { let success: Bool }
        guard try await call("send", mail, as: Result.self).success else { throw MailFailure.sendRejected }
    }
    public func saveDraft(_ mail: OutgoingMail) async throws -> String {
        struct Result: Decodable { let id: String }
        return try await call("save-draft", mail, as: Result.self).id
    }
    public func draft(id: String) async throws -> SavedDraft { try await call("draft", ID(id: id)) }
    public func deleteDraft(id: String) async throws { let _: Empty = try await call("delete-draft", ID(id: id)) }
    public func sync(accountID: String? = nil) async throws {
        struct Input: Encodable { let accountId: String? }
        let _: Empty = try await call("sync", Input(accountId: accountID))
    }
    public func category(id: String) async throws -> MailCategoryState {
        try await call("mail-category", ID(id: id))
    }
    public func moveCategory(id: String, to category: MailCategory) async throws {
        guard category != .all else { throw MailFailure.invalidCategory }
        struct Input: Encodable { let id: String; let category: String }
        let _: Empty = try await call("move-category", Input(id: id, category: category.rawValue))
    }
    public func classificationStatus() async throws -> MailClassificationStatus {
        try await call("classification-status", Empty())
    }
    public func classificationSettings() async throws -> MailClassificationSettingsOverview {
        try await call("classification-settings", Empty())
    }
    public func saveClassificationSettings(_ settings: MailClassificationSettings) async throws -> MailClassificationSettings {
        struct Result: Decodable { let settings: MailClassificationSettings }
        return try await call("classification-save", settings, as: Result.self).settings
    }
    public func controlClassification(_ action: MailClassificationAction) async throws {
        struct Input: Encodable { let action: MailClassificationAction }
        let _: Empty = try await call("classification-control", Input(action: action))
    }
    public func events(after: String? = nil) async throws -> MailEventPage {
        struct Input: Encodable { let after: String? }
        return try await call("events", Input(after: after))
    }
}
