import XCTest
@testable import ZeroMail

final class AppGroupBridgeTests: XCTestCase {
    private var directory: URL!
    private var bridge: AppGroupBridge!
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("zero-appgroup-tests-" + UUID().uuidString, isDirectory: true)
        bridge = AppGroupBridge(directory: directory)
    }
    override func tearDownWithError() throws {
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }
    func testShareRemainsDurableUntilExplicitAcknowledgement() throws {
        let file = try OutgoingAttachment(name: "example.txt", type: "text/plain", data: Data("hello".utf8))
        let share = try SharedMailDraft(subject: "Review", text: "https://example.test", attachments: [file])
        try bridge.queue(share)
        XCTAssertEqual(try bridge.pending().map(\.id), [share.id])
        let recovered = try AppGroupBridge(directory: directory).pending()
        XCTAssertEqual(recovered.map(\.id), [share.id])
        let composer = try recovered[0].composer(accountID: "review-account")
        XCTAssertEqual(composer.accountId, "review-account")
        XCTAssertTrue(composer.to.isEmpty && composer.cc.isEmpty && composer.bcc.isEmpty)
        XCTAssertEqual(composer.attachments[0].size, 5)
        XCTAssertEqual(try bridge.pending().count, 1)
        try bridge.acknowledge(share.id)
        XCTAssertTrue(try bridge.pending().isEmpty)
    }
    func testQueueLimitsAndExpiry() throws {
        let now = Date()
        for index in 0..<3 { try bridge.queue(SharedMailDraft(text: "Share \(index)", now: now), now: now) }
        XCTAssertThrowsError(try bridge.queue(SharedMailDraft(text: "Fourth", now: now), now: now))
        XCTAssertTrue(try bridge.pending(now: now.addingTimeInterval(24 * 60 * 60 + 1)).isEmpty)
        try bridge.queue(SharedMailDraft(text: "Fresh"))
        XCTAssertEqual(try bridge.pending().count, 1)
    }
    func testWidgetSnapshotNeverContainsMailOrCredentialFields() throws {
        let snapshot = MailWidgetSnapshot(paired: true, connectedAccounts: 2, recentUnread: 4, partial: true, checkedAt: Date())
        try bridge.saveSnapshot(snapshot)
        XCTAssertEqual(bridge.snapshot(), snapshot)
        let data = try Data(contentsOf: directory.appendingPathComponent("widget.json"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["paired", "connectedAccounts", "recentUnread", "partial", "checkedAt"])
    }
    func testLogoutClearsQueuedContentAndWidgetState() throws {
        try bridge.queue(SharedMailDraft(text: "private shared content"))
        try bridge.saveSnapshot(.init(paired: true, connectedAccounts: 1, recentUnread: 3))
        try bridge.clear()
        XCTAssertTrue(try bridge.pending().isEmpty)
        XCTAssertEqual(bridge.snapshot(), .signedOut)
    }
    func testMalformedAndOversizedAttachmentsCannotBeImported() throws {
        let file = try OutgoingAttachment(name: "safe.txt", type: "text/plain", data: Data([1, 2, 3]))
        let shared = try SharedMailDraft(text: "Test", attachments: [file])
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(shared)) as? [String: Any])
        var attachments = try XCTUnwrap(json["attachments"] as? [[String: Any]])
        attachments[0]["size"] = 0
        json["attachments"] = attachments
        let changed = try JSONDecoder().decode(SharedMailDraft.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertThrowsError(try changed.validate())
        XCTAssertThrowsError(try bridge.queue(changed))
        XCTAssertThrowsError(try SharedMailDraft(text: "Test", attachments: Array(repeating: file, count: 21)))
        XCTAssertThrowsError(try SharedMailDraft(text: String(repeating: "x", count: 200 * 1024 + 1)))
    }
    func testPathTraversalAndSymlinkEnvelopeAreRejected() throws {
        let file = try OutgoingAttachment(name: "../../secrets.txt", type: "text/plain", data: Data())
        XCTAssertThrowsError(try SharedMailDraft(text: "Test", attachments: [file]))
        let share = try SharedMailDraft(text: "Test")
        try bridge.queue(share)
        let path = directory.appendingPathComponent("shares/" + share.id.uuidString + ".json")
        try FileManager.default.removeItem(at: path)
        try FileManager.default.createSymbolicLink(at: path, withDestinationURL: directory.appendingPathComponent("widget.json"))
        XCTAssertThrowsError(try bridge.pending())
    }
    func testMissingOrInvalidWidgetDataFailsClosed() throws {
        XCTAssertEqual(bridge.snapshot(), .signedOut)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("invalid".utf8).write(to: directory.appendingPathComponent("widget.json"))
        XCTAssertEqual(bridge.snapshot(), .signedOut)
    }
    func testSharedImportOriginBindingSurvivesRelaunchAndCannotMoveServers() throws {
        let bindings = SharedDraftOriginBindings(directory: directory.appendingPathComponent("private"))
        let id = UUID(), a = URL(string: "https://mail-a.example")!, b = URL(string: "https://mail-b.example")!
        XCTAssertTrue(try bindings.permits(id, server: b))
        XCTAssertTrue(try bindings.bind(id, server: a))
        let relaunched = SharedDraftOriginBindings(directory: bindings.directory)
        XCTAssertTrue(try relaunched.permits(id, server: a))
        XCTAssertFalse(try relaunched.permits(id, server: b))
        XCTAssertFalse(try relaunched.bind(id, server: b))
        XCTAssertEqual(try relaunched.bound(to: a), [id])
        XCTAssertTrue(try relaunched.bound(to: b).isEmpty)
    }
    func testScopedShareAcknowledgementKeepsOtherOriginsAndUnboundShares() throws {
        let bindings = SharedDraftOriginBindings(directory: directory.appendingPathComponent("private"))
        let a = URL(string: "https://a.example")!, b = URL(string: "https://b.example")!
        let first = try SharedMailDraft(text: "A"), second = try SharedMailDraft(text: "B"), unbound = try SharedMailDraft(text: "Choose a server")
        for share in [first, second, unbound] { try bridge.queue(share) }
        XCTAssertTrue(try bindings.bind(first.id, server: a))
        XCTAssertTrue(try bindings.bind(second.id, server: b))
        for id in try bindings.bound(to: a) { try bridge.acknowledge(id); try bindings.remove(id) }
        XCTAssertEqual(Set(try bridge.pending().map(\.id)), [second.id, unbound.id])
        XCTAssertEqual(try bindings.bound(to: b), [second.id])
        XCTAssertTrue(try bindings.bound(to: a).isEmpty)
    }
    func testCorruptShareBindingFailsClosed() throws {
        let bindings = SharedDraftOriginBindings(directory: directory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("invalid".utf8).write(to: directory.appendingPathComponent("bindings.json"))
        XCTAssertThrowsError(try bindings.permits(UUID(), server: URL(string: "https://mail.example")!))
        XCTAssertThrowsError(try bindings.bind(UUID(), server: URL(string: "https://mail.example")!))
    }
}
