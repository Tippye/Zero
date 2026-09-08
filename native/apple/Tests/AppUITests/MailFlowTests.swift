import XCTest

/// Runs only against scripts/ui-fixture.mjs. No production recipient or token.
@available(macOS 13.3, iOS 16.4, *)
final class MailFlowTests: XCTestCase {
    private let origin = "http://localhost:19280"
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard ProcessInfo.processInfo.environment["ZERO_UI_FIXTURE"] == "1" else {
            throw XCTSkip("Start scripts/ui-fixture.mjs and use scripts/test-ui.sh for synthetic mail UI coverage")
        }
        try request("/__test/reset")
        app = XCUIApplication()
        app.launchArguments = ["-zero.server", origin]
        app.launch()
        let pair = app.buttons["pairDevice"]
        if pair.waitForExistence(timeout: 3) { pair.tap() }
        XCTAssertTrue(app.buttons["compose"].waitForExistence(timeout: 15), app.debugDescription)
    }

    override func tearDownWithError() throws { app?.terminate() }

    @discardableResult private func request(_ path: String, body: [String: Any]? = nil) throws -> [String: Any] {
        let done = expectation(description: path)
        var output: Result<[String: Any], Error>!
        var request = URLRequest(url: URL(string: origin + path)!)
        request.httpMethod = "POST"
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        URLSession.shared.dataTask(with: request) { data, _, error in
            if let error { output = .failure(error) }
            else { output = Result { try JSONSerialization.jsonObject(with: data!) as! [String: Any] } }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return try output.get()
    }

    private func openComposer(_ query: String) {
        app.open(URL(string: "zeromail://compose?" + query)!)
        XCTAssertTrue(app.textFields["recipient"].waitForExistence(timeout: 10))
    }

    func testPairingKeychainRecoveryAndReadAttachment() throws {
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["compose"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["pairDevice"].exists)
        app.open(URL(string: "zeromail://inbox")!)
        let inbox = app.descendants(matching: .any)["folder-inbox"].firstMatch
        if inbox.exists && inbox.isHittable { inbox.tap() }
        let row = app.descendants(matching: .any)["thread-mbx.ui-test.message-1"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), app.debugDescription)
        row.tap()
        let attachment = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "sample.txt")).firstMatch
        XCTAssertTrue(attachment.waitForExistence(timeout: 10), app.debugDescription)
        attachment.tap()
        XCTAssertTrue(app.buttons["shareAttachment"].waitForExistence(timeout: 10))
        let state = try request("/__test/state")
        XCTAssertEqual((state["flags"] as? [String: Any])?["unread"] as? Bool, false)
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Apple mail and attachment"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.buttons["查看邮件排版"].tap()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 10))
        XCTAssertTrue(web.staticTexts["Synthetic mail for Apple validation"].waitForExistence(timeout: 10))
        XCTAssertFalse(web.staticTexts["UNSAFE SCRIPT"].exists)
        XCTAssertFalse((try request("/__test/state")["requests"] as? [String] ?? []).contains("remote-content-loaded"))
    }

    func testComposeLinksPreserveRecipientsAndDraft() throws {
        openComposer("to=to%2Btag%40example.test&cc=cc%40example.test&bcc=bcc%40example.test&subject=Apple%20draft&body=Hello%20Apple")
        XCTAssertEqual(app.textFields["recipient"].value as? String, "to+tag@example.test")
        XCTAssertEqual(app.textFields["cc"].value as? String, "cc@example.test")
        XCTAssertEqual(app.textFields["bcc"].value as? String, "bcc@example.test")
        XCTAssertEqual(app.textFields["subject"].value as? String, "Apple draft")
        app.buttons["saveDraft"].tap()
        XCTAssertTrue(app.buttons["compose"].waitForExistence(timeout: 10))
        let state = try request("/__test/state")
        let drafts = try XCTUnwrap(state["drafts"] as? [[String: Any]])
        XCTAssertEqual(drafts.count, 1)
        XCTAssertEqual(drafts.first?["bcc"] as? [String], ["bcc@example.test"])
        XCTAssertEqual((state["sent"] as? [Any])?.count, 0)
    }

    #if os(iOS)
    func testLandscapeReadingKeepsReplyReachable() throws {
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        app.open(URL(string: "zeromail://inbox")!)
        let inbox = app.descendants(matching: .any)["folder-inbox"].firstMatch
        if inbox.exists && inbox.isHittable { inbox.tap() }
        let row = app.descendants(matching: .any)["thread-mbx.ui-test.message-1"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        let detail = app.scrollViews["mailDetail"]
        XCTAssertTrue(detail.waitForExistence(timeout: 10))
        let reply = app.buttons["回复全部"]
        for _ in 0..<8 {
            if reply.exists && reply.isHittable { break }
            detail.swipeUp()
        }
        XCTAssertTrue(reply.isHittable, app.debugDescription)
        XCTAssertGreaterThanOrEqual(reply.frame.minX, detail.frame.minX - 1)
        XCTAssertLessThanOrEqual(reply.frame.maxX, detail.frame.maxX + 1)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Landscape reading and accessible reply"; screenshot.lifetime = .keepAlways; add(screenshot)
        reply.tap()
        XCTAssertTrue(app.textFields["recipient"].waitForExistence(timeout: 10))
        app.buttons["saveDraft"].tap()
        XCTAssertTrue(app.buttons["compose"].waitForExistence(timeout: 10))
        XCTAssertEqual((try request("/__test/state")["sent"] as? [Any])?.count, 0)
    }
    #endif

    func testAIWritingRequiresGenerateAndApplyWithoutSending() throws {
        try verifyAIWriting()
    }

    func testLegacyWebAIWritingWithoutNativeAIEndpoints() throws {
        try request("/__test/configure", body: ["legacy": true])
        try verifyAIWriting()
        let calls = try request("/__test/state")["requests"] as? [String] ?? []
        XCTAssertEqual(calls.filter { $0 == "web:imap.generate" }.count, 1)
        XCTAssertFalse(calls.contains("ai-compose"))
    }

    func testAIReaderStillWorksWhenTranslationCacheFails() throws {
        try verifyReaderWithoutCache(legacy: false)
    }

    func testLegacyWebAIReaderWithoutNativeAIEndpoints() throws {
        try verifyReaderWithoutCache(legacy: true)
    }

    private func verifyReaderWithoutCache(legacy: Bool) throws {
        try request("/__test/configure", body: ["legacy": legacy, "cacheUnavailable": true])
        app.open(URL(string: "zeromail://inbox")!)
        let inbox = app.descendants(matching: .any)["folder-inbox"].firstMatch
        if inbox.exists && inbox.isHittable { inbox.tap() }
        let row = app.descendants(matching: .any)["thread-mbx.ui-test.message-1"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
        let reader = app.descendants(matching: .any)["aiReader"].firstMatch
        XCTAssertTrue(reader.waitForExistence(timeout: 10)); reader.tap()
        XCTAssertTrue(app.staticTexts["aiCacheUnavailable"].waitForExistence(timeout: 10))
        let summary = app.buttons["aiSummary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 10)); XCTAssertTrue(summary.isEnabled); summary.tap()
        XCTAssertTrue(app.staticTexts["Synthetic mail summary"].waitForExistence(timeout: 10))
        let translate = app.buttons["aiTranslate"]
        translate.tap()
        XCTAssertTrue(app.staticTexts["合成翻译正文"].waitForExistence(timeout: 10))
        let state = try request("/__test/state")
        let calls = state["requests"] as? [String] ?? []
        XCTAssertEqual(calls.filter { $0 == (legacy ? "web:ai.read" : "ai-read") }.count, 2)
        XCTAssertEqual((state["sent"] as? [Any])?.count, 0)
    }

    private func verifyAIWriting() throws {
        openComposer("to=recipient%40example.test&subject=AI%20review&body=Original%20draft")
        app.buttons["aiCompose"].tap()
        let instructions = app.descendants(matching: .any)["aiComposeInstructions"].firstMatch
        XCTAssertTrue(instructions.waitForExistence(timeout: 10))
        XCTAssertFalse((try request("/__test/state")["requests"] as? [String] ?? []).contains("ai-compose"))
        XCTAssertFalse((try request("/__test/state")["requests"] as? [String] ?? []).contains("web:imap.generate"))
        instructions.tap(); instructions.typeText("Write a short test reply")
        let generate = app.buttons["aiComposeGenerate"]
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: generate)
        waitForExpectations(timeout: 10)
        generate.tap()
        let apply = app.buttons["aiComposeApply"]
        XCTAssertTrue(apply.waitForExistence(timeout: 10))
        XCTAssertEqual((try request("/__test/state")["sent"] as? [Any])?.count, 0)
        apply.tap()
        XCTAssertEqual(app.textViews["messageBody"].value as? String, "Synthetic AI draft for review")
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "AI draft reviewed before send"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.buttons["saveDraft"].tap()
        XCTAssertTrue(app.buttons["compose"].waitForExistence(timeout: 10))
        let state = try request("/__test/state")
        XCTAssertEqual((state["sent"] as? [Any])?.count, 0)
        XCTAssertEqual((state["drafts"] as? [[String: Any]])?.first?["text"] as? String, "Synthetic AI draft for review")
    }

    func testSendingRequiresExplicitConfirmation() throws {
        openComposer("to=recipient%40example.test&subject=Confirm%20send&body=Synthetic%20only")
        app.buttons["send"].tap()
        XCTAssertTrue(app.buttons["确认发送"].waitForExistence(timeout: 5))
        XCTAssertEqual((try request("/__test/state")["sent"] as? [Any])?.count, 0)
        app.buttons["确认发送"].tap()
        XCTAssertTrue(app.buttons["compose"].waitForExistence(timeout: 10))
        let sent = try XCTUnwrap(try request("/__test/state")["sent"] as? [[String: Any]])
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?["subject"] as? String, "Confirm send")
    }

    func testUnsavedDraftSurvivesProcessRelaunchWithoutAutomaticSend() throws {
        openComposer("to=recovery%40example.test&cc=copy%40example.test&bcc=private%40example.test&subject=Recovery%20check&body=Saved%20only%20on%20device")
        let body = app.textViews["messageBody"]
        XCTAssertTrue(body.waitForExistence(timeout: 5))
        body.tap(); body.typeText(" unsaved edit")
        let expectedBody = try XCTUnwrap(body.value as? String)
        XCTAssertTrue(expectedBody.contains("unsaved edit"))
        XCTAssertEqual((try request("/__test/state")["drafts"] as? [Any])?.count, 0)
        app.terminate(); app.launch()
        let restore = app.buttons["restoreDraft"].firstMatch
        XCTAssertTrue(restore.waitForExistence(timeout: 15), app.debugDescription)
        restore.tap()
        XCTAssertTrue(app.textFields["recipient"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(app.textFields["recipient"].value as? String, "recovery@example.test")
        XCTAssertEqual(app.textFields["cc"].value as? String, "copy@example.test")
        XCTAssertEqual(app.textFields["bcc"].value as? String, "private@example.test")
        XCTAssertEqual(app.textFields["subject"].value as? String, "Recovery check")
        XCTAssertEqual(app.textViews["messageBody"].value as? String, expectedBody)
        let recoveredState = try request("/__test/state")
        XCTAssertEqual((recoveredState["sent"] as? [Any])?.count, 0)
        XCTAssertEqual((recoveredState["drafts"] as? [Any])?.count, 0)
        app.buttons["saveDraft"].tap()
        XCTAssertTrue(app.buttons["compose"].waitForExistence(timeout: 10))
        let savedState = try request("/__test/state")
        XCTAssertEqual((savedState["drafts"] as? [Any])?.count, 1)
        XCTAssertEqual((savedState["sent"] as? [Any])?.count, 0)
    }
}
