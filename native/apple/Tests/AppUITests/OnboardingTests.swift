import XCTest

final class OnboardingTests: XCTestCase {
    func testServerSetupAndHTTPSValidation() {
        let app = XCUIApplication()
        app.launchArguments = ["-zero.server", ""]
        app.launch()
        let server = app.textFields["serverURL"]
        XCTAssertTrue(server.waitForExistence(timeout: 10))
        XCTAssertTrue(app.textFields["deviceName"].exists)
        server.tap(); server.typeText("http://insecure.example")
        app.buttons["connect"].tap()
        XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(server.exists)
    }
}
