import XCTest
@testable import ZeroMail

final class MailEventTrackerTests: XCTestCase {
    private let server = URL(string: "https://mail.example")!
    private func page(_ cursor: String, owner: String = "owner", events: [MailEvent] = []) -> MailEventPage { .init(owner: owner, cursor: cursor, events: events) }
    private func event(_ id: String, account: String = "a") -> MailEvent { .init(id: id, threadId: "mbx.\(account).message", accountId: account, sender: "Sender", subject: "Mail") }
    func testFirstBaselineIsQuietAndSubsequentEventsAreConsumedOnce() throws {
        var tracker = MailEventTracker()
        XCTAssertNil(try tracker.after(head: page("10"), server: server))
        XCTAssertEqual(try tracker.after(head: page("12"), server: server), "10")
        let events = try tracker.accept(page("12", events: [event("11"), event("12")]), server: server, after: "10")
        XCTAssertEqual(events.map(\.id), ["11", "12"])
        XCTAssertNil(try tracker.after(head: page("12"), server: server))
        XCTAssertTrue(try tracker.accept(page("12", events: [event("11")]), server: server, after: "10").isEmpty)
    }
    func testCursorComparisonPreservesPrecisionAboveJavaScriptSafeInteger() throws {
        var tracker = MailEventTracker()
        let previous = "9007199254740993", next = "9007199254740994"
        _ = try tracker.after(head: page(previous), server: server)
        XCTAssertEqual(try tracker.after(head: page(next), server: server), previous)
        XCTAssertEqual(try tracker.accept(page(next, events: [event(next)]), server: server, after: previous).map(\.id), [next])
    }
    func testServerAndOwnerIsolationAndLogoutReset() throws {
        var tracker = MailEventTracker()
        _ = try tracker.after(head: page("10"), server: server)
        let second = URL(string: "https://other.example")!
        XCTAssertNil(try tracker.after(head: page("50"), server: second))
        XCTAssertNil(try tracker.after(head: page("20", owner: "other-user"), server: server))
        XCTAssertTrue(try tracker.accept(page("21", events: [event("21")]), server: server, after: "20").isEmpty)
        tracker.reset(server: server)
        XCTAssertNil(try tracker.after(head: page("22", owner: "other-user"), server: server))
        XCTAssertEqual(try tracker.after(head: page("51"), server: second), "50")
    }
    func testPersistedStateResumesAfterAppRestartWithoutSharingMailMetadata() throws {
        var tracker = MailEventTracker()
        _ = try tracker.after(head: page("10"), server: server)
        let data = try JSONEncoder().encode(tracker)
        var restored = try JSONDecoder().decode(MailEventTracker.self, from: data)
        XCTAssertEqual(try restored.after(head: page("12"), server: server), "10")
        let saved = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(saved.contains("subject") || saved.contains("sender") || saved.contains("token") || saved.contains("threadId"))
    }
    func testPaginatedBurstDoesNotSkipBeyondFirstPage() throws {
        var tracker = MailEventTracker()
        _ = try tracker.after(head: page("0"), server: server)
        XCTAssertEqual(try tracker.after(head: page("30"), server: server), "0")
        XCTAssertEqual(try tracker.accept(page("25", events: (1...25).map { event(String($0)) }), server: server, after: "0").count, 25)
        XCTAssertEqual(try tracker.after(head: page("30"), server: server), "25")
        XCTAssertEqual(try tracker.accept(page("30", events: (26...30).map { event(String($0)) }), server: server, after: "25").count, 5)
    }
    func testFilteredReadOrArchivedEventsStillAdvanceCursorAndDuplicateRowsAreDeduplicated() throws {
        var tracker = MailEventTracker()
        _ = try tracker.after(head: page("10"), server: server)
        XCTAssertEqual(try tracker.accept(page("15", events: [event("12"), event("12")]), server: server, after: "10").count, 1)
        XCTAssertTrue(try tracker.accept(page("20"), server: server, after: "15").isEmpty)
        XCTAssertNil(try tracker.after(head: page("20"), server: server))
    }
    func testMalformedOrRewindingPagesCannotAdvanceState() throws {
        var tracker = MailEventTracker()
        _ = try tracker.after(head: page("10"), server: server)
        for invalid in ["", "-1", "1.5", "1e2", "9999999999999999999", "１２"] {
            XCTAssertThrowsError(try tracker.after(head: page(invalid), server: server))
        }
        XCTAssertThrowsError(try tracker.accept(page("9"), server: server, after: "10"))
        XCTAssertThrowsError(try tracker.accept(page("11", events: [event("12")]), server: server, after: "10"))
        XCTAssertThrowsError(try tracker.accept(page("11", events: [event("10")]), server: server, after: "10"))
        XCTAssertEqual(try tracker.after(head: page("12"), server: server), "10")
    }
    func testServerDatabaseResetEstablishesNewQuietBaseline() throws {
        var tracker = MailEventTracker()
        _ = try tracker.after(head: page("100"), server: server)
        XCTAssertNil(try tracker.after(head: page("2"), server: server))
        XCTAssertEqual(try tracker.after(head: page("3"), server: server), "2")
    }
}
