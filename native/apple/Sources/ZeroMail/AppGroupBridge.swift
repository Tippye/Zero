import Foundation
import ZeroPairing

public enum AppGroupFailure: Error, LocalizedError {
    case unavailable, invalidShare, queueFull
    public var errorDescription: String? {
        switch self {
        case .unavailable: return "共享容器不可用，请确认应用与扩展使用相同的 App Group 签名配置。"
        case .invalidShare: return "分享内容无效或过大。最多 20 个附件、合计 15 MB，正文最多 200 KB。"
        case .queueFull: return "已有 3 份待导入的分享内容，请先在 Zero Mail 中处理。"
        }
    }
}

/// Intentionally excludes server names, account identifiers, message metadata and credentials.
public struct MailWidgetSnapshot: Codable, Sendable, Equatable {
    public let paired: Bool
    public let connectedAccounts: Int
    public let recentUnread: Int
    public let partial: Bool
    public let checkedAt: Date?
    public init(paired: Bool, connectedAccounts: Int = 0, recentUnread: Int = 0, partial: Bool = false, checkedAt: Date? = nil) {
        self.paired = paired; self.connectedAccounts = max(0, connectedAccounts)
        self.recentUnread = max(0, recentUnread); self.partial = partial; self.checkedAt = checkedAt
    }
    public static let signedOut = MailWidgetSnapshot(paired: false)
}

/// Shared content is a proposed draft, never an outgoing message. Recipient fields cannot be encoded.
public struct SharedMailDraft: Codable, Sendable, Identifiable {
    public let id: UUID
    public let createdAt: Date
    public var subject: String
    public var text: String
    public var attachments: [OutgoingAttachment]
    public init(subject: String = "", text: String, attachments: [OutgoingAttachment] = [], now: Date = Date()) throws {
        id = UUID(); createdAt = now; self.subject = subject; self.text = text; self.attachments = attachments
        try validate()
    }
    public func validate() throws {
        guard subject.utf8.count <= 1000, text.utf8.count <= 200 * 1024,
              !subject.contains("\0"), !text.contains("\0"), attachments.count <= 20 else { throw AppGroupFailure.invalidShare }
        var bytes = 0
        for attachment in attachments {
            guard attachment.size >= 0, attachment.size <= 15 * 1024 * 1024,
                  attachment.base64.utf8.count <= 20 * 1024 * 1024,
                  let data = Data(base64Encoded: attachment.base64), data.count == attachment.size,
                  !attachment.name.isEmpty, attachment.name.utf8.count <= 1024,
                  attachment.name.rangeOfCharacter(from: .controlCharacters) == nil,
                  !attachment.name.contains("/"), !attachment.name.contains("\\"),
                  attachment.type.utf8.count <= 256 else { throw AppGroupFailure.invalidShare }
            bytes += data.count
            guard bytes <= 15 * 1024 * 1024 else { throw AppGroupFailure.invalidShare }
        }
    }
    public func composer(accountID: String) throws -> MailComposer {
        try validate()
        var result = MailComposer(accountId: accountID)
        result.subject = subject; result.text = text; result.attachments = attachments
        return result
    }
}

/// All production callers use the entitled App Group; the directory initializer supports isolated tests.
public struct AppGroupBridge: Sendable {
    public static let identifier = "group.org.zero.mail"
    public let directory: URL
    public init(directory: URL) { self.directory = directory }
    public static func shared() throws -> AppGroupBridge {
        #if canImport(Darwin)
        guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier) else { throw AppGroupFailure.unavailable }
        return AppGroupBridge(directory: root.appendingPathComponent("ZeroMail", isDirectory: true))
        #else
        throw AppGroupFailure.unavailable
        #endif
    }
    private var shares: URL { directory.appendingPathComponent("shares", isDirectory: true) }
    private func prepare(_ directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var directory = directory
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try? directory.setResourceValues(values)
    }
    private func write<T: Encodable>(_ value: T, to url: URL, privateContent: Bool) throws {
        try prepare(url.deletingLastPathComponent())
        let data = try JSONEncoder().encode(value)
        #if os(iOS) || os(watchOS)
        try data.write(to: url, options: privateContent ? [.atomic, .completeFileProtection] : [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    public func saveSnapshot(_ snapshot: MailWidgetSnapshot) throws {
        try write(snapshot, to: directory.appendingPathComponent("widget.json"), privateContent: false)
    }
    public func snapshot() -> MailWidgetSnapshot {
        let url = directory.appendingPathComponent("widget.json")
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 4096,
              let data = try? Data(contentsOf: url), let result = try? JSONDecoder().decode(MailWidgetSnapshot.self, from: data),
              result.connectedAccounts >= 0, result.recentUnread >= 0 else { return .signedOut }
        return result
    }
    public func queue(_ draft: SharedMailDraft, now: Date = Date()) throws {
        try draft.validate()
        try prepare(shares)
        guard try pending(now: now).count < 3 else { throw AppGroupFailure.queueFull }
        try write(draft, to: shares.appendingPathComponent(draft.id.uuidString + ".json"), privateContent: true)
    }
    /// Reading does not acknowledge: a crash or cancelled import retains the share for the next launch.
    public func pending(now: Date = Date()) throws -> [SharedMailDraft] {
        guard FileManager.default.fileExists(atPath: shares.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: shares, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
            .filter { $0.pathExtension == "json" && UUID(uuidString: $0.deletingPathExtension().lastPathComponent) != nil }
            .compactMap { url -> SharedMailDraft? in
                let attributes = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
                guard attributes.isRegularFile == true, attributes.isSymbolicLink != true,
                      (attributes.fileSize ?? Int.max) <= 22 * 1024 * 1024 else { throw AppGroupFailure.invalidShare }
                let data = try Data(contentsOf: url)
                let draft = try JSONDecoder().decode(SharedMailDraft.self, from: data)
                guard draft.id.uuidString == url.deletingPathExtension().lastPathComponent else { throw AppGroupFailure.invalidShare }
                try draft.validate()
                if now.timeIntervalSince(draft.createdAt) > 24 * 60 * 60 {
                    try FileManager.default.removeItem(at: url); return nil
                }
                guard draft.createdAt.timeIntervalSince(now) < 5 * 60 else { throw AppGroupFailure.invalidShare }
                return draft
            }.sorted { $0.createdAt < $1.createdAt }
    }
    public func acknowledge(_ id: UUID) throws {
        let url = shares.appendingPathComponent(id.uuidString + ".json")
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
    public func clear() throws {
        if FileManager.default.fileExists(atPath: shares.path) { try FileManager.default.removeItem(at: shares) }
        try saveSnapshot(.signedOut)
    }
}

/// Private to the main app: server ownership never enters the shared widget container.
/// The first accepted import binds its original to one origin until it is acknowledged.
public struct SharedDraftOriginBindings: Sendable {
    public let directory: URL
    public init(directory: URL) { self.directory = directory }
    private var file: URL { directory.appendingPathComponent("bindings.json") }
    private func origin(_ server: URL) throws -> String {
        try PairingClient.serverOrigin(server, allowHTTP: PairingClient.allowsDevelopmentHTTP(server)).absoluteString
    }
    private func read() throws -> [String: String] {
        guard FileManager.default.fileExists(atPath: file.path) else { return [:] }
        let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              (values.fileSize ?? Int.max) <= 1024 * 1024 else { throw AppGroupFailure.invalidShare }
        let bindings = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: file))
        guard bindings.allSatisfy({ UUID(uuidString: $0.key) != nil && URL(string: $0.value) != nil }) else { throw AppGroupFailure.invalidShare }
        return bindings
    }
    private func write(_ bindings: [String: String]) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard try directory.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true else { throw AppGroupFailure.invalidShare }
        var directory = directory, values = URLResourceValues(); values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        let data = try JSONEncoder().encode(bindings)
        #if os(iOS) || os(watchOS)
        try data.write(to: file, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: file, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
    public func permits(_ id: UUID, server: URL) throws -> Bool {
        let bound = try read()[id.uuidString]
        return try bound == nil || bound == origin(server)
    }
    public func bind(_ id: UUID, server: URL) throws -> Bool {
        var bindings = try read(); let origin = try origin(server)
        if let bound = bindings[id.uuidString] { return bound == origin }
        bindings[id.uuidString] = origin; try write(bindings); return true
    }
    public func bound(to server: URL) throws -> [UUID] {
        let origin = try origin(server)
        return try read().compactMap { $0.value == origin ? UUID(uuidString: $0.key) : nil }
    }
    public func remove(_ id: UUID) throws {
        var bindings = try read(); bindings.removeValue(forKey: id.uuidString); try write(bindings)
    }
    public func retain(_ ids: Set<UUID>) throws {
        let bindings = try read(), retained = Set(ids.map(\.uuidString))
        let filtered = bindings.filter { retained.contains($0.key) }
        if filtered.count != bindings.count { try write(filtered) }
    }
}
