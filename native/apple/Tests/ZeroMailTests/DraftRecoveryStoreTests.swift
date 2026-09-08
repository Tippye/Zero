#if canImport(CryptoKit)
import Foundation
import XCTest
import Darwin
@testable import ZeroMail

private final class TestDraftKeys: DraftRecoveryKeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var keys: [String: Data] = [:]
    func read(origin: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return keys[origin] }
    func save(_ key: Data, origin: String) throws { lock.lock(); defer { lock.unlock() }; keys[origin] = key }
    func remove(origin: String) throws { lock.lock(); defer { lock.unlock() }; keys.removeValue(forKey: origin) }
}

final class DraftRecoveryStoreTests: XCTestCase {
    private let server = URL(string: "https://mail.example")!
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("zero-recovery-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    private func files(_ directory: URL) -> [URL] {
        (FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.isRegularFileKey])?.allObjects as? [URL] ?? [])
            .filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }
    }
    func testNoDuplicateRestoreAcrossLiveWindowsAndOriginScopedRelease() throws {
        let leases = DraftRecoveryLeases(), first = DraftRecoveryLeaseOwner(), second = DraftRecoveryLeaseOwner()
        let id = UUID(), other = URL(string: "https://other.example")!
        XCTAssertTrue(leases.claim(id, server: server, owner: first))
        XCTAssertTrue(leases.claim(id, server: server, owner: first), "Typing in the owning window retains the lease")
        XCTAssertFalse(leases.claim(id, server: URL(string: "https://MAIL.example:443/")!, owner: second))
        XCTAssertTrue(leases.isClaimed(id, server: server), "Other recovery lists hide the open draft")
        leases.release(id, server: server, owner: second)
        XCTAssertFalse(leases.claim(id, server: server, owner: second), "An unrelated window cannot release the owner")
        XCTAssertTrue(leases.claim(id, server: other, owner: second), "Equal UUIDs on different origins are independent")
        leases.release(id, server: server, owner: first)
        XCTAssertTrue(leases.claim(id, server: server, owner: second), "Explicit completion releases the snapshot")
        leases.releaseAll(owner: first)
        XCTAssertTrue(leases.isClaimed(id, server: other))
    }
    func testClosingWindowReleasesWeakLeaseWithoutErasingRecovery() throws {
        let leases = DraftRecoveryLeases(), root = try directory(), keys = TestDraftKeys()
        let store = DraftRecoveryStore(directory: root, keys: keys)
        var draft = MailComposer(accountId: "account"); draft.text = "Still recoverable"
        try store.save(draft, server: server)
        var window: DraftRecoveryLeaseOwner? = DraftRecoveryLeaseOwner()
        XCTAssertTrue(leases.claim(draft.id, server: server, owner: try XCTUnwrap(window)))
        XCTAssertTrue(leases.isClaimed(draft.id, server: server))
        window = nil
        XCTAssertFalse(leases.isClaimed(draft.id, server: server))
        XCTAssertTrue(leases.claim(draft.id, server: server, owner: DraftRecoveryLeaseOwner()))
        XCTAssertEqual(try store.recover(server: server, accountIDs: ["account"]).first?.draft, draft)
    }
    func testEncryptedRecoveryPreservesDraftIdentityAttachmentsAndUncertainSend() throws {
        let root = try directory(), keys = TestDraftKeys()
        let store = DraftRecoveryStore(directory: root, keys: keys)
        var draft = MailComposer(accountId: "owned-account")
        draft.to = "unfinished-address,"; draft.cc = "cc@example.test"; draft.bcc = "private@example.test"
        draft.subject = "Secret subject 42"; draft.text = "Confidential draft marker 123"
        draft.deliveryUncertain = true; draft.sharedImportID = UUID()
        draft.attachments = [try OutgoingAttachment(name: "note.txt", type: "text/plain", data: Data("Private attachment marker".utf8))]
        try store.save(draft, server: server)
        let restored = try DraftRecoveryStore(directory: root, keys: keys).recover(server: server, accountIDs: ["owned-account"])
        XCTAssertEqual(restored.first?.draft, draft)
        XCTAssertEqual(restored.first?.draft.id.uuidString, draft.id.uuidString)
        XCTAssertEqual(restored.first?.draft.deliveryUncertain, true)
        for file in files(root) {
            let bytes = try Data(contentsOf: file)
            XCTAssertNil(bytes.range(of: Data(draft.text.utf8)))
            XCTAssertNil(bytes.range(of: Data(draft.subject.utf8)))
            XCTAssertNil(bytes.range(of: Data("Private attachment marker".utf8)))
            XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
            // NSURL reports false for temporary directories even after setting the exclusion.
            // Verify the persisted Apple backup-exclusion attribute itself on this test volume.
            let excluded = getxattr(file.deletingLastPathComponent().path, "com.apple.metadata:com_apple_backup_excludeItem", nil, 0, 0, 0)
            XCTAssertGreaterThan(excluded, 0)
        }
    }
    func testTypingReusesAttachmentCiphertextAndReplacingAttachmentsIsAtomic() throws {
        let root = try directory(), keys = TestDraftKeys(), store: DraftRecoveryStore
        store = DraftRecoveryStore(directory: root, keys: keys)
        var draft = MailComposer(accountId: "account")
        draft.attachments = [try OutgoingAttachment(name: "a.txt", type: "text/plain", data: Data("one".utf8))]
        try store.save(draft, server: server)
        let original = try XCTUnwrap(files(root).first { $0.pathExtension == "blob" })
        let ciphertext = try Data(contentsOf: original)
        draft.text = "new text"
        try store.save(draft, server: server)
        XCTAssertEqual(try Data(contentsOf: original), ciphertext)
        XCTAssertEqual(files(root).filter { $0.pathExtension == "blob" }.count, 1)
        draft.attachments = [try OutgoingAttachment(name: "b.txt", type: "text/plain", data: Data("two".utf8))]
        try store.save(draft, server: server)
        XCTAssertFalse(FileManager.default.fileExists(atPath: original.path))
        XCTAssertEqual(files(root).filter { $0.pathExtension == "blob" }.count, 1)
        XCTAssertEqual(try store.recover(server: server, accountIDs: ["account"]).first?.draft, draft)
    }
    func testRecoveryRequiresMatchingOriginAndOwnedAccount() throws {
        let root = try directory(), keys = TestDraftKeys(), store: DraftRecoveryStore
        store = DraftRecoveryStore(directory: root, keys: keys)
        var draft = MailComposer(accountId: "alice-account"); draft.text = "Alice"
        try store.save(draft, server: server)
        XCTAssertTrue(try store.recover(server: server, accountIDs: ["bob-account"]).isEmpty)
        XCTAssertTrue(try store.recover(server: URL(string: "https://other.example")!, accountIDs: ["alice-account"]).isEmpty)
        XCTAssertEqual(try store.recover(server: server, accountIDs: ["alice-account"]).count, 1)
    }
    func testCiphertextTamperingAndMissingKeyNeverProducePlaintextFallback() throws {
        let root = try directory(), keys = TestDraftKeys()
        let store = DraftRecoveryStore(directory: root, keys: keys)
        var draft = MailComposer(accountId: "account"); draft.text = "Keep this draft"
        try store.save(draft, server: server)
        let file = try XCTUnwrap(files(root).first { $0.pathExtension == "draft" })
        var bytes = try Data(contentsOf: file); bytes[bytes.count - 1] ^= 1
        try bytes.write(to: file)
        XCTAssertThrowsError(try store.recover(server: server, accountIDs: ["account"]))
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        try keys.remove(origin: server.absoluteString)
        XCTAssertThrowsError(try store.save(draft, server: server))
        XCTAssertEqual(try Data(contentsOf: file), bytes)
    }
    func testCapacityAndInvalidAttachmentsPreserveExistingSnapshots() throws {
        let root = try directory(), keys = TestDraftKeys()
        let store = DraftRecoveryStore(directory: root, keys: keys, maximumDrafts: 1)
        var first = MailComposer(accountId: "account"); first.text = "First"
        try store.save(first, server: server)
        var second = MailComposer(accountId: "account"); second.text = "Second"
        XCTAssertThrowsError(try store.save(second, server: server))
        first.text = "Updated"
        try store.save(first, server: server)
        var broken = first
        broken.attachments = [try JSONDecoder().decode(OutgoingAttachment.self, from: Data(#"{"name":"x","type":"text/plain","size":100,"lastModified":0,"base64":"aGk="}"#.utf8))]
        XCTAssertThrowsError(try store.save(broken, server: server))
        broken = first; broken.text = String(repeating: "x", count: 4 * 1024 * 1024)
        XCTAssertThrowsError(try store.save(broken, server: server))
        XCTAssertEqual(try store.recover(server: server, accountIDs: ["account"]).first?.draft, first)
    }
    func testExplicitClearRemovesOnlyThatOriginsDraftsAndKey() throws {
        let root = try directory(), keys = TestDraftKeys()
        let store = DraftRecoveryStore(directory: root, keys: keys)
        var draft = MailComposer(accountId: "account"); draft.text = "Draft"
        let other = URL(string: "https://other.example")!
        try store.save(draft, server: server); try store.save(draft, server: other)
        try store.clear(server: server)
        XCTAssertNil(try keys.read(origin: server.absoluteString))
        XCTAssertNotNil(try keys.read(origin: other.absoluteString))
        XCTAssertTrue(try store.recover(server: server, accountIDs: ["account"]).isEmpty)
        XCTAssertEqual(try store.recover(server: other, accountIDs: ["account"]).first?.draft, draft)
        try store.remove(draft.id, server: other)
        XCTAssertTrue(try store.recover(server: other, accountIDs: ["account"]).isEmpty)
    }
}
#endif
