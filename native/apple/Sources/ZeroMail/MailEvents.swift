import Foundation
import ZeroPairing

public struct MailEvent: Codable, Sendable, Equatable {
    public let id: String
    public let threadId: String
    public let accountId: String
    public let sender: String
    public let subject: String
}
public struct MailEventPage: Codable, Sendable {
    public let owner: String
    public let cursor: String
    public let events: [MailEvent]
}

/// The native and Windows clients use the same server event cursor. Only routing state is persisted.
public struct MailEventTracker: Codable, Sendable {
    private struct State: Codable, Sendable { let owner: String; var cursor: String }
    private var states: [String: State] = [:]
    public init() {}

    /// A new server/owner or reset database establishes a quiet baseline at the current head.
    public mutating func after(head: MailEventPage, server: URL) throws -> String? {
        try validate(head)
        guard head.events.isEmpty else { throw PairingFailure.invalidResponse }
        let key = server.absoluteString
        guard let state = states[key], state.owner == head.owner,
              Self.validCursor(state.cursor), !Self.less(head.cursor, than: state.cursor) else {
            states[key] = State(owner: head.owner, cursor: head.cursor)
            return nil
        }
        return Self.less(state.cursor, than: head.cursor) ? state.cursor : nil
    }

    /// Commits only the page requested from the current cursor; stale or foreign-owner pages are discarded.
    public mutating func accept(_ page: MailEventPage, server: URL, after: String) throws -> [MailEvent] {
        try validate(page)
        let key = server.absoluteString
        guard let state = states[key], state.owner == page.owner, state.cursor == after else { return [] }
        guard !Self.less(page.cursor, than: after) else { throw PairingFailure.invalidResponse }
        var seen: Set<String> = []
        var events: [MailEvent] = []
        for event in page.events {
            guard Self.less(after, than: event.id), !Self.less(page.cursor, than: event.id),
                  !event.threadId.isEmpty, event.threadId.utf8.count <= 8000,
                  !event.accountId.isEmpty, event.accountId.utf8.count <= 1000 else { throw PairingFailure.invalidResponse }
            if seen.insert(event.id).inserted { events.append(event) }
        }
        states[key] = State(owner: page.owner, cursor: page.cursor)
        return events
    }
    public mutating func reset(server: URL? = nil) {
        if let server { states.removeValue(forKey: server.absoluteString) }
        else { states.removeAll() }
    }
    private func validate(_ page: MailEventPage) throws {
        guard !page.owner.isEmpty, page.owner.utf8.count <= 1000, Self.validCursor(page.cursor),
              page.events.count <= 25, page.events.allSatisfy({ Self.validCursor($0.id) }) else { throw PairingFailure.invalidResponse }
    }
    private static func validCursor(_ value: String) -> Bool {
        (1...18).contains(value.utf8.count) && value.utf8.allSatisfy { (48...57).contains($0) }
    }
    private static func less(_ lhs: String, than rhs: String) -> Bool {
        let left = lhs.drop(while: { $0 == "0" }), right = rhs.drop(while: { $0 == "0" })
        return left.count == right.count ? left.lexicographicallyPrecedes(right) : left.count < right.count
    }
}
