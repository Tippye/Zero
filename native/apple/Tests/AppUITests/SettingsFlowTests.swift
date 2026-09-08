import XCTest

/// Uses only the loopback UI fixture and this app's Settings.bundle preferences.
@available(macOS 13.3, iOS 16.4, *)
final class SettingsFlowTests: XCTestCase {
    private let origin = "http://localhost:19280"
    private let threadID = "mbx.ui-test.message-1"
    private var app: XCUIApplication!
    private var capturedSystemSettings = false

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard ProcessInfo.processInfo.environment["ZERO_UI_FIXTURE"] == "1" else {
            throw XCTSkip("Start scripts/ui-fixture.mjs and use scripts/test-ui.sh for synthetic settings coverage")
        }
        try request("/__test/reset")
        app = XCUIApplication()
    }

    override func tearDownWithError() throws { app?.terminate() }

    private func launch(overrides: [String: String] = [:], systemPreview: Bool = false) {
        // Argument-domain values isolate fast behavior tests from preferences left by manual QA.
        // The Settings round trip omits previewLines so the system's persistent value can change.
        var preferences = [
            "zero.mail.previewLines": "2", "zero.mail.markReadOnOpen": "YES",
            "zero.mail.confirmBeforeTrash": "NO", "zero.mail.showAccountAddress": "YES",
            "zero.notifications.preview": "NO", "zero.notifications.sound": "YES"
        ]
        preferences.merge(overrides) { _, value in value }
        if systemPreview { preferences.removeValue(forKey: "zero.mail.previewLines") }
        app.launchArguments = ["-zero.server", origin] + preferences.keys.sorted().flatMap { ["-" + $0, preferences[$0]!] }
        app.launch()
        let pair = app.buttons["pairDevice"]
        if pair.waitForExistence(timeout: 3) { pair.tap() }
        XCTAssertTrue(app.buttons["compose"].waitForExistence(timeout: 15), app.debugDescription)
    }

    @discardableResult private func request(_ path: String) throws -> [String: Any] {
        let done = expectation(description: path)
        var output: Result<[String: Any], Error>!
        var request = URLRequest(url: URL(string: origin + path)!)
        request.httpMethod = "POST"
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error { output = .failure(error) }
            else {
                output = Result {
                    let response = try XCTUnwrap(response as? HTTPURLResponse)
                    XCTAssertEqual(response.statusCode, 200)
                    return try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(data)) as? [String: Any])
                }
            }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return try output.get()
    }

    private func actions() throws -> [[String: Any]] {
        try XCTUnwrap(try request("/__test/state")["actions"] as? [[String: Any]], "UI fixture must record action payloads")
    }

    private func waitForAction(_ name: String) throws -> [[String: Any]] {
        let deadline = Date().addingTimeInterval(5)
        repeat {
            let values = try actions()
            if values.contains(where: { $0["action"] as? String == name }) { return values }
            Thread.sleep(forTimeInterval: 0.1)
        } while Date() < deadline
        XCTFail("Expected fixture action: " + name)
        return try actions()
    }

    private func assertNoAction(_ name: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let deadline = Date().addingTimeInterval(0.5)
        repeat {
            XCTAssertFalse(try actions().contains { $0["action"] as? String == name }, file: file, line: line)
            Thread.sleep(forTimeInterval: 0.1)
        } while Date() < deadline
    }

    @discardableResult private func openInbox() -> XCUIElement {
        app.open(URL(string: "zeromail://inbox")!)
        let inbox = app.descendants(matching: .any)["folder-inbox"].firstMatch
        if inbox.exists && inbox.isHittable { inbox.tap() }
        let row = app.descendants(matching: .any)["thread-" + threadID].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), app.debugDescription)
        return row
    }

    private func readFixture() {
        openInbox().tap()
        XCTAssertTrue(app.scrollViews["mailDetail"].waitForExistence(timeout: 10), app.debugDescription)
    }

    private func openMailSettings() {
        let settings = app.buttons["mailSettings"].firstMatch
        if !(settings.exists && settings.isHittable) {
            // In a compact split view, navigate from the inbox back to the app sidebar.
            let back = app.navigationBars.buttons["Zero Mail"].firstMatch
            if back.exists && back.isHittable { back.tap() }
        }
        XCTAssertTrue(settings.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(settings.isHittable, app.debugDescription)
        settings.tap()
        XCTAssertTrue(app.buttons["完成"].waitForExistence(timeout: 5))
    }

    func testPreviewAccountAddressAndAutomaticReadWhenEnabled() throws {
        launch()
        openInbox()
        XCTAssertTrue(app.staticTexts["mailPreview-" + threadID].exists)
        XCTAssertTrue(app.staticTexts["mailAccount-" + threadID].exists)
        readFixture()
        let values = try waitForAction("read")
        XCTAssertEqual(values.filter { $0["action"] as? String == "read" }.count, 1)
        XCTAssertEqual((try request("/__test/state")["flags"] as? [String: Any])?["unread"] as? Bool, false)
    }

    func testOpeningMailDoesNotMarkReadWhenDisabled() throws {
        launch(overrides: ["zero.mail.markReadOnOpen": "NO"])
        readFixture()
        try assertNoAction("read")
        XCTAssertEqual((try request("/__test/state")["flags"] as? [String: Any])?["unread"] as? Bool, true)
    }

    func testZeroPreviewLinesAndHiddenAccountRemoveListDetails() {
        launch(overrides: ["zero.mail.previewLines": "0", "zero.mail.showAccountAddress": "NO"])
        let row = openInbox()
        XCTAssertFalse(app.staticTexts["mailPreview-" + threadID].exists)
        XCTAssertFalse(app.staticTexts["mailAccount-" + threadID].exists)
        XCTAssertFalse(row.label.contains("Synthetic mail for Apple validation"))
        XCTAssertFalse(row.label.contains("me@example.test"))
        XCTAssertFalse(row.staticTexts["Synthetic mail for Apple validation"].exists)
        XCTAssertFalse(row.staticTexts["me@example.test"].exists)
        // The parent row still exists, so absence cannot be explained by a missing mailbox.
        XCTAssertTrue(app.descendants(matching: .any)["thread-" + threadID].firstMatch.exists)
    }

    func testTrashConfirmationCancellationDoesNothingAndConfirmationActsOnce() throws {
        launch(overrides: ["zero.mail.markReadOnOpen": "NO", "zero.mail.confirmBeforeTrash": "YES"])
        readFixture()
        let trash = app.buttons["trashThread"].firstMatch
        XCTAssertTrue(trash.waitForExistence(timeout: 5)); trash.tap()
        let title = app.staticTexts["将邮件移到废纸篓？"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 5), app.debugDescription)
        let cancel = app.buttons["取消"].firstMatch
        if cancel.exists { cancel.tap() }
        else {
            // iPad's native confirmation popover omits a Cancel button. A tap outside
            // dismisses it; choose a point outside its actual visible geometry.
            let popover = app.popovers.firstMatch
            let excluded = popover.exists ? popover.frame : title.frame.insetBy(dx: -60, dy: -120)
            let candidates = [CGVector(dx: 0.05, dy: 0.9), CGVector(dx: 0.95, dy: 0.9), CGVector(dx: 0.05, dy: 0.5)]
            let offset = try XCTUnwrap(candidates.first { offset in
                !excluded.contains(CGPoint(x: app.frame.minX + app.frame.width * offset.dx,
                                           y: app.frame.minY + app.frame.height * offset.dy))
            })
            app.coordinate(withNormalizedOffset: offset).tap()
        }
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: title)
        waitForExpectations(timeout: 5)
        try assertNoAction("trash")
        XCTAssertEqual((try request("/__test/state")["flags"] as? [String: Any])?["folder"] as? String, "inbox")
        trash.tap()
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        let confirm = app.buttons.matching(NSPredicate(format: "label == %@ AND identifier != %@", "移到废纸篓", "trashThread")).firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5)); confirm.tap()
        _ = try waitForAction("trash")
        let values = try actions()
        XCTAssertEqual(values.count, 1)
        XCTAssertEqual(values.first?["action"] as? String, "trash")
        XCTAssertEqual(values.first?["ids"] as? [String], [threadID])
        XCTAssertEqual((try request("/__test/state")["flags"] as? [String: Any])?["folder"] as? String, "trash")
    }

    func testTrashWithoutConfirmationMovesMailImmediately() throws {
        launch(overrides: ["zero.mail.markReadOnOpen": "NO", "zero.mail.confirmBeforeTrash": "NO"])
        readFixture()
        let trash = app.buttons["trashThread"].firstMatch
        XCTAssertTrue(trash.waitForExistence(timeout: 5)); trash.tap()
        _ = try waitForAction("trash")
        XCTAssertFalse(app.staticTexts["将邮件移到废纸篓？"].exists)
        XCTAssertEqual(try actions().count, 1)
    }

    #if os(iOS)
    func testAppSettingsExposesSystemSettingsEntry() {
        launch()
        openMailSettings()
        XCTAssertTrue(app.buttons["openSystemSettings"].exists)
    }

    func testSystemSettingsPreviewChangeRefreshesRunningApp() throws {
        launch(systemPreview: true)
        let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        defer { settings.terminate(); app.activate() }

        openSystemSettings(settings)
        chooseSystemPreview(2, in: settings)
        returnToInbox()
        XCTAssertTrue(app.staticTexts["mailPreview-" + threadID].exists)

        openSystemSettings(settings)
        chooseSystemPreview(0, in: settings)
        returnToInbox()
        let preview = app.staticTexts["mailPreview-" + threadID]
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: preview)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(app.staticTexts["mailAccount-" + threadID].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "System Settings preview preference applied without relaunch"
        screenshot.lifetime = .keepAlways; add(screenshot)

        // Restore the documented default through the same public Settings UI.
        openSystemSettings(settings)
        chooseSystemPreview(2, in: settings)
        returnToInbox()
        XCTAssertTrue(app.staticTexts["mailPreview-" + threadID].waitForExistence(timeout: 5))
        XCTAssertEqual((try request("/__test/state")["sent"] as? [Any])?.count, 0)
    }

    private func openSystemSettings(_ settings: XCUIApplication) {
        openMailSettings()
        let open = app.buttons["openSystemSettings"]
        XCTAssertTrue(open.waitForExistence(timeout: 5)); open.tap()
        XCTAssertTrue(settings.wait(for: .runningForeground, timeout: 15), "System Settings did not enter the foreground")
        settings.activate()
    }

    private func chooseSystemPreview(_ lines: Int, in settings: XCUIApplication) {
        // A subsequent public Settings launch may preserve the previously open Preview page.
        // Return to the app root so its navigation title is never mistaken for the preference row.
        let back = settings.navigationBars.buttons["Zero Mail"].firstMatch
        if back.exists && back.isHittable { back.tap() }
        let root = settings.navigationBars["Zero Mail"].firstMatch
        if !root.exists {
            let appsBack = settings.navigationBars.buttons.matching(NSPredicate(format: "label IN %@", ["App", "Apps"])).firstMatch
            if appsBack.exists && appsBack.isHittable { appsBack.tap() }
        }
        for _ in 0..<12 {
            if root.exists { break }
            let zero = settings.buttons["org.zero.mail.ios"].firstMatch
            if zero.exists && zero.isHittable { zero.tap(); continue }
            settings.swipeUp()
        }
        // iPadOS also has an Apple app named Preview. Never select a preference until
        // the exact Zero Mail settings page is open; an Apps-list label is insufficient.
        XCTAssertTrue(root.waitForExistence(timeout: 5), settings.debugDescription)
        var row = settings.cells.containing(.staticText, identifier: "预览").firstMatch
        for _ in 0..<12 {
            if row.exists { break }
            let english = settings.cells.containing(.staticText, identifier: "Preview").firstMatch
            if english.exists { row = english; break }
            settings.swipeUp()
        }
        XCTAssertTrue(row.exists, settings.debugDescription)
        if !capturedSystemSettings {
            Thread.sleep(forTimeInterval: 0.5) // Let the system navigation animation settle for the attachment.
            let screenshot = XCTAttachment(screenshot: settings.screenshot())
            screenshot.name = "Zero Mail preference page in system Settings"
            screenshot.lifetime = .keepAlways; add(screenshot)
            capturedSystemSettings = true
        }
        row.tap()
        let labels = lines == 0 ? ["无", "None"] : ["\(lines) 行", "\(lines)行", "\(lines) Lines", "\(lines) lines"]
        let option = settings.buttons.matching(NSPredicate(format: "label IN %@", labels)).firstMatch
        XCTAssertTrue(option.waitForExistence(timeout: 5), settings.debugDescription)
        option.tap()
    }

    private func returnToInbox() {
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        let done = app.buttons["完成"].firstMatch
        if done.exists && done.isHittable { done.tap() }
        openInbox()
    }
    #endif
}
