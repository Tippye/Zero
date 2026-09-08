import Foundation
import ZeroPairing
#if canImport(CryptoKit)
import CryptoKit
#endif
#if canImport(Security)
import Security
#endif

public enum DraftRecoveryFailure: Error, LocalizedError {
    case unavailable, invalidDraft, capacity
    public var errorDescription: String? {
        switch self {
        case .unavailable: return "无法保存或读取本机恢复草稿，请确认设备已解锁。"
        case .invalidDraft: return "本机恢复草稿已损坏或超过大小限制。原有文件已保留。"
        case .capacity: return "本机恢复草稿空间已满，请先处理已有草稿。"
        }
    }
}

public protocol DraftRecoveryKeyStore: Sendable {
    func read(origin: String) throws -> Data?
    func save(_ key: Data, origin: String) throws
    func remove(origin: String) throws
}

public struct DeviceDraftKeyStore: DraftRecoveryKeyStore {
    public init() {}
    #if canImport(Security)
    private func query(_ origin: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "org.zero.mail.draft-recovery",
         kSecAttrAccount as String: origin, kSecAttrSynchronizable as String: false]
    }
    public func read(origin: String) throws -> Data? {
        var query = query(origin); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data, data.count == 32 else { throw DraftRecoveryFailure.unavailable }
        return data
    }
    public func save(_ key: Data, origin: String) throws {
        guard key.count == 32 else { throw DraftRecoveryFailure.unavailable }
        let attributes: [String: Any] = [kSecValueData as String: key, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query(origin) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            guard SecItemAdd(query(origin).merging(attributes) { _, new in new } as CFDictionary, nil) == errSecSuccess else { throw DraftRecoveryFailure.unavailable }
        } else if status != errSecSuccess { throw DraftRecoveryFailure.unavailable }
    }
    public func remove(origin: String) throws {
        let status = SecItemDelete(query(origin) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw DraftRecoveryFailure.unavailable }
    }
    #else
    public func read(origin: String) throws -> Data? { throw DraftRecoveryFailure.unavailable }
    public func save(_ key: Data, origin: String) throws { throw DraftRecoveryFailure.unavailable }
    public func remove(origin: String) throws { throw DraftRecoveryFailure.unavailable }
    #endif
}

public struct RecoveredDraft: Identifiable, Sendable {
    public var id: UUID { draft.id }
    public let draft: MailComposer
    public let updatedAt: Date
}

/// One token per live window. Leases hold it weakly, so closing a window releases its drafts
/// without requiring MainActor work from deinit; backgrounding a live window retains ownership.
public final class DraftRecoveryLeaseOwner: Sendable { public init() {} }

public final class DraftRecoveryLeases: @unchecked Sendable {
    public static let shared = DraftRecoveryLeases()
    private struct Claim { weak var owner: DraftRecoveryLeaseOwner? }
    private var claims: [String: Claim] = [:]
    private let lock = NSLock()
    public init() {}
    private func key(_ id: UUID, server: URL) -> String? {
        guard let origin = try? PairingClient.serverOrigin(server, allowHTTP: PairingClient.allowsDevelopmentHTTP(server)) else { return nil }
        return origin.absoluteString + "|" + id.uuidString
    }
    public func claim(_ id: UUID, server: URL, owner: DraftRecoveryLeaseOwner) -> Bool {
        guard let key = key(id, server: server) else { return false }
        lock.lock(); defer { lock.unlock() }
        if let current = claims[key]?.owner { return current === owner }
        claims[key] = Claim(owner: owner); return true
    }
    public func isClaimed(_ id: UUID, server: URL) -> Bool {
        guard let key = key(id, server: server) else { return true }
        lock.lock(); defer { lock.unlock() }
        return claims[key]?.owner != nil
    }
    public func release(_ id: UUID, server: URL, owner: DraftRecoveryLeaseOwner) {
        guard let key = key(id, server: server) else { return }
        lock.lock(); defer { lock.unlock() }
        if claims[key]?.owner === owner { claims.removeValue(forKey: key) }
    }
    public func releaseAll(owner: DraftRecoveryLeaseOwner) {
        lock.lock(); defer { lock.unlock() }
        claims = claims.filter { $0.value.owner != nil && $0.value.owner !== owner }
    }
}

/// Encrypted snapshots only, never an offline send queue. The lock makes each write complete before
/// returning, so a subsequent quit does not abandon a debounce task. Unchanged attachment blobs are reused.
public final class DraftRecoveryStore: @unchecked Sendable {
    public static let device = DraftRecoveryStore(directory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("ZeroMail/DraftRecovery", isDirectory: true))
    private let directory: URL
    private let keys: any DraftRecoveryKeyStore
    private let lock = NSLock()
    private let maximumDrafts: Int
    private let maximumBytes = 128 * 1024 * 1024
    private let manifestLimit = 4 * 1024 * 1024
    private let attachmentLimit = 22 * 1024 * 1024
    private struct Envelope: Codable {
        let version: Int
        let origin: String
        let updatedAt: Date
        var draft: MailComposer
        let attachments: String?
    }
    private struct CachedAttachments { let files: [OutgoingAttachment]; let blob: String? }
    private var attachmentCache: [String: CachedAttachments] = [:]
    public init(directory: URL, keys: any DraftRecoveryKeyStore = DeviceDraftKeyStore(), maximumDrafts: Int = 10) {
        self.directory = directory; self.keys = keys; self.maximumDrafts = max(1, min(10, maximumDrafts))
    }
    private func location(_ server: URL) throws -> (String, URL) {
        let origin = try PairingClient.serverOrigin(server, allowHTTP: PairingClient.allowsDevelopmentHTTP(server)).absoluteString
        #if canImport(CryptoKit)
        let hash = SHA256.hash(data: Data(origin.utf8)).map { String(format: "%02x", $0) }.joined()
        return (origin, directory.appendingPathComponent(hash, isDirectory: true))
        #else
        throw DraftRecoveryFailure.unavailable
        #endif
    }
    private func prepare(_ folder: URL) throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard try folder.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true else { throw DraftRecoveryFailure.invalidDraft }
        var folder = folder, values = URLResourceValues(); values.isExcludedFromBackup = true
        try folder.setResourceValues(values)
    }
    private func files(_ folder: URL) throws -> [URL] {
        guard FileManager.default.fileExists(atPath: folder.path) else { return [] }
        guard try folder.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true else { throw DraftRecoveryFailure.invalidDraft }
        return try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
    }
    private func data(_ url: URL, limit: Int) throws -> Data {
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? Int.max) <= limit else { throw DraftRecoveryFailure.invalidDraft }
        return try Data(contentsOf: url)
    }
    private func key(_ origin: String, create: Bool, folder: URL) throws -> Data {
        if let key = try keys.read(origin: origin) { guard key.count == 32 else { throw DraftRecoveryFailure.unavailable }; return key }
        guard create, try files(folder).isEmpty else { throw DraftRecoveryFailure.unavailable }
        #if canImport(CryptoKit)
        let key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        try keys.save(key, origin: origin); return key
        #else
        throw DraftRecoveryFailure.unavailable
        #endif
    }
    private func crypt(_ data: Data, key: Data, origin: String, filename: String, encrypt: Bool) throws -> Data {
        #if canImport(CryptoKit)
        let context = Data(("zero-draft-v1|" + origin + "|" + filename).utf8)
        if encrypt {
            guard let sealed = try AES.GCM.seal(data, using: SymmetricKey(data: key), authenticating: context).combined else { throw DraftRecoveryFailure.unavailable }
            return sealed
        }
        do { return try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: SymmetricKey(data: key), authenticating: context) }
        catch { throw DraftRecoveryFailure.invalidDraft }
        #else
        throw DraftRecoveryFailure.unavailable
        #endif
    }
    private func write(_ data: Data, to url: URL) throws {
        #if os(iOS) || os(watchOS)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: url, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    private func envelope(_ url: URL, origin: String, key: Data) throws -> Envelope {
        let plain = try crypt(data(url, limit: manifestLimit + 64), key: key, origin: origin, filename: url.lastPathComponent, encrypt: false)
        let envelope = try JSONDecoder().decode(Envelope.self, from: plain)
        guard envelope.version == 1, envelope.origin == origin,
              envelope.draft.id.uuidString + ".draft" == url.lastPathComponent,
              !envelope.draft.accountId.isEmpty else { throw DraftRecoveryFailure.invalidDraft }
        if let blob = envelope.attachments {
            let prefix = envelope.draft.id.uuidString + "-"
            guard blob.hasPrefix(prefix), blob.hasSuffix(".blob"), UUID(uuidString: String(blob.dropFirst(prefix.count).dropLast(5))) != nil else { throw DraftRecoveryFailure.invalidDraft }
        }
        return envelope
    }
    public func save(_ draft: MailComposer, server: URL, now: Date = Date()) throws {
        lock.lock(); defer { lock.unlock() }
        guard !draft.accountId.isEmpty, draft.attachments.count <= 20 else { throw DraftRecoveryFailure.invalidDraft }
        let (origin, folder) = try location(server); try prepare(folder)
        let key = try key(origin, create: true, folder: folder), filename = draft.id.uuidString + ".draft"
        let url = folder.appendingPathComponent(filename), existing = try files(folder)
        guard FileManager.default.fileExists(atPath: url.path) || existing.filter({ $0.pathExtension == "draft" }).count < maximumDrafts else { throw DraftRecoveryFailure.capacity }
        let previous = FileManager.default.fileExists(atPath: url.path) ? try envelope(url, origin: origin, key: key) : nil
        let cacheID = origin + "|" + draft.id.uuidString
        var blob = previous?.attachments, encryptedAttachments: Data?
        if attachmentCache[cacheID]?.files != draft.attachments || (blob == nil && !draft.attachments.isEmpty) {
            if draft.attachments.isEmpty { blob = nil }
            else {
                var bytes = 0
                for file in draft.attachments {
                    guard file.size >= 0, file.base64.utf8.count <= 20 * 1024 * 1024,
                          let data = Data(base64Encoded: file.base64), data.count == file.size else { throw DraftRecoveryFailure.invalidDraft }
                    bytes += data.count
                    guard bytes <= 15 * 1024 * 1024 else { throw DraftRecoveryFailure.invalidDraft }
                }
                blob = draft.id.uuidString + "-" + UUID().uuidString + ".blob"
                let encoded = try JSONEncoder().encode(draft.attachments)
                guard encoded.count <= attachmentLimit else { throw DraftRecoveryFailure.invalidDraft }
                encryptedAttachments = try crypt(encoded, key: key, origin: origin, filename: blob!, encrypt: true)
            }
        }
        var metadata = draft; metadata.attachments = []
        let record = Envelope(version: 1, origin: origin, updatedAt: now, draft: metadata, attachments: blob)
        let encoded = try JSONEncoder().encode(record)
        guard encoded.count <= manifestLimit else { throw DraftRecoveryFailure.invalidDraft }
        let encrypted = try crypt(encoded, key: key, origin: origin, filename: filename, encrypt: true)
        let total = try existing.reduce(0) { total, file in
            let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true, let size = values.fileSize else { throw DraftRecoveryFailure.invalidDraft }
            return total + size
        }
        let oldSize = previous == nil ? 0 : (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
        let replacedBlobSize: Int
        if let old = previous?.attachments, old != blob { replacedBlobSize = try folder.appendingPathComponent(old).resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0 }
        else { replacedBlobSize = 0 }
        guard total - oldSize - replacedBlobSize + encrypted.count + (encryptedAttachments?.count ?? 0) <= maximumBytes else { throw DraftRecoveryFailure.capacity }
        if let encryptedAttachments, let blob { try write(encryptedAttachments, to: folder.appendingPathComponent(blob)) }
        try write(encrypted, to: url)
        attachmentCache[cacheID] = CachedAttachments(files: draft.attachments, blob: blob)
        if let old = previous?.attachments, old != blob { try? FileManager.default.removeItem(at: folder.appendingPathComponent(old)) }
    }
    /// Call only after pairing and fetching this origin's current owned accounts.
    public func recover(server: URL, accountIDs: Set<String>) throws -> [RecoveredDraft] {
        lock.lock(); defer { lock.unlock() }
        let (origin, folder) = try location(server), all = try files(folder)
        guard !all.isEmpty else { return [] }
        let key = try key(origin, create: false, folder: folder)
        var recovered: [RecoveredDraft] = []
        for url in all where url.pathExtension == "draft" {
            let record = try envelope(url, origin: origin, key: key)
            guard accountIDs.contains(record.draft.accountId) else { continue }
            var draft = record.draft
            if let blob = record.attachments {
                let raw = try crypt(data(folder.appendingPathComponent(blob), limit: attachmentLimit + 64), key: key, origin: origin, filename: blob, encrypt: false)
                draft.attachments = try JSONDecoder().decode([OutgoingAttachment].self, from: raw)
            }
            attachmentCache[origin + "|" + draft.id.uuidString] = CachedAttachments(files: draft.attachments, blob: record.attachments)
            recovered.append(RecoveredDraft(draft: draft, updatedAt: record.updatedAt))
        }
        return recovered.sorted { $0.updatedAt > $1.updatedAt }
    }
    public func remove(_ id: UUID, server: URL) throws {
        lock.lock(); defer { lock.unlock() }
        let (origin, folder) = try location(server)
        let matches = try files(folder).filter { $0.lastPathComponent == id.uuidString + ".draft" || $0.lastPathComponent.hasPrefix(id.uuidString + "-") }
            .sorted { $0.pathExtension == "draft" && $1.pathExtension != "draft" }
        for url in matches {
            try FileManager.default.removeItem(at: url)
        }
        attachmentCache.removeValue(forKey: origin + "|" + id.uuidString)
    }
    public func clear(server: URL) throws {
        lock.lock(); defer { lock.unlock() }
        let (origin, folder) = try location(server)
        var failure: Error?
        do { try keys.remove(origin: origin) } catch { failure = error }
        do { if FileManager.default.fileExists(atPath: folder.path) { try FileManager.default.removeItem(at: folder) } }
        catch { if failure == nil { failure = error } }
        attachmentCache = attachmentCache.filter { !$0.key.hasPrefix(origin + "|") }
        if let failure { throw failure }
    }
}
