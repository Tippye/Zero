import XCTest

@available(macOS 13.3, iOS 16.4, *)
final class HTMLMailTests: XCTestCase {
    private var app: XCUIApplication!
    override func setUpWithError() throws {
        continueAfterFailure = false
        guard ProcessInfo.processInfo.environment["ZERO_UI_FIXTURE"] == "1" else { throw XCTSkip("Use scripts/test-ui.sh with synthetic mail") }
        try request("/__test/reset")
        app = XCUIApplication()
    }
    override func tearDownWithError() throws { app?.terminate() }
    @discardableResult private func request(_ path: String, body: [String: String]? = nil) throws -> [String: Any] {
        let done = expectation(description: path)
        var result: Result<[String: Any], Error>!
        var request = URLRequest(url: URL(string: "http://localhost:19280" + path)!)
        request.httpMethod = "POST"
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        URLSession.shared.dataTask(with: request) { data, _, error in
            if let error { result = .failure(error) }
            else { result = Result { try JSONSerialization.jsonObject(with: XCTUnwrap(data)) as! [String: Any] } }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return try result.get()
    }
    private func openMail(_ variant: String) throws {
        try request("/__test/configure", body: ["htmlCase": variant])
        app.launchArguments = ["-zero.server", "http://localhost:19280"]
        app.launch()
        let pair = app.buttons["pairDevice"]
        if pair.waitForExistence(timeout: 3) { pair.tap() }
        XCTAssertTrue(app.buttons["compose"].waitForExistence(timeout: 15))
        // A fresh launch already opens the inbox; deep-link routing is tested
        // separately. Wait for recovery dismissal before interacting with rows.
        let later = app.buttons["稍后"]
        if later.waitForExistence(timeout: 2) {
            later.tap()
            expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: later)
            waitForExpectations(timeout: 5)
        }
        let inbox = app.descendants(matching: .any)["folder-inbox"].firstMatch
        if inbox.exists && inbox.isHittable { inbox.tap() }
        let row = app.descendants(matching: .any)["thread-mbx.ui-test.message-1"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
    }
    private func checkRenderedBody() throws -> XCUIElement {
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(web.staticTexts["HTML receipt"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(web.staticTexts["$42.00"].exists)
        XCTAssertFalse(web.staticTexts["UNSAFE SCRIPT"].exists)
        XCTAssertFalse(app.staticTexts["Plain fallback only"].exists)
        XCTAssertFalse((try request("/__test/state")["requests"] as? [String] ?? []).contains("remote-content-loaded"))
        return web
    }
    func testHTMLRendersInlineAndCanSwitchToPlainText() throws {
        try openMail("styled")
        let web = try checkRenderedBody()
        XCTAssertGreaterThan(web.frame.height, 130, "WebKit must report its intrinsic email height instead of using the initial placeholder")
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "Inline styled HTML email"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.buttons["toggleMailBodyFormat"].tap()
        XCTAssertTrue(app.staticTexts["Plain fallback only"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.webViews.firstMatch.exists)
        app.buttons["toggleMailBodyFormat"].tap()
        _ = try checkRenderedBody()
    }
    func testHTMLOnlyEmailDoesNotShowEmptyBody() throws {
        try openMail("html-only")
        _ = try checkRenderedBody()
        XCTAssertFalse(app.staticTexts["此邮件没有纯文本正文。"].exists)
    }
    func testPlainTextOnlyEmailUsesNativeText() throws {
        try openMail("text-only")
        XCTAssertTrue(app.staticTexts["Plain fallback only"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.webViews.firstMatch.exists)
        XCTAssertFalse(app.buttons["toggleMailBodyFormat"].exists)
    }
    func testExpandedHTMLAndAttachmentRemainAvailable() throws {
        try openMail("styled")
        _ = try checkRenderedBody()
        app.buttons["查看邮件排版"].tap()
        let done = app.buttons["完成"]
        XCTAssertTrue(done.waitForExistence(timeout: 10))
        XCTAssertTrue(app.webViews.staticTexts["HTML receipt"].firstMatch.waitForExistence(timeout: 10))
        done.tap()
        let attachment = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "sample.txt")).firstMatch
        XCTAssertTrue(attachment.waitForExistence(timeout: 10)); attachment.tap()
        XCTAssertTrue(app.buttons["shareAttachment"].waitForExistence(timeout: 10))
        XCTAssertFalse((try request("/__test/state")["requests"] as? [String] ?? []).contains("remote-content-loaded"))
    }
    func testLongHTMLResizesAndReplyRemainsReachable() throws {
        try openMail("long")
        let web = try checkRenderedBody()
        XCTAssertGreaterThan(web.frame.height, 500)
        #if os(iOS)
        let originalWidth = web.frame.width
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        expectation(for: NSPredicate { _, _ in abs(web.frame.width - originalWidth) > 10 }, evaluatedWith: web)
        waitForExpectations(timeout: 10)
        XCTAssertGreaterThan(web.frame.height, 500)
        #endif
        let detail = app.scrollViews["mailDetail"]
        let reply = app.buttons["回复全部"]
        for _ in 0..<16 {
            if reply.exists && reply.isHittable { break }
            detail.swipeUp()
        }
        XCTAssertTrue(reply.isHittable, app.debugDescription)
        reply.tap()
        XCTAssertTrue(app.textFields["recipient"].waitForExistence(timeout: 10))
        XCTAssertEqual((try request("/__test/state")["sent"] as? [Any])?.count, 0)
        app.buttons["关闭"].tap()
        let discard = app.buttons["放弃本次编辑"]
        XCTAssertTrue(discard.waitForExistence(timeout: 5)); discard.tap()
        XCTAssertTrue(app.buttons["compose"].waitForExistence(timeout: 5))
    }
}
