import XCTest
@testable import ZeroMail
import ZeroPairing
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private final class TestCredentials: PairingCredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var token: String? = "signed%2Btoken%3D"
    func read(server: String) throws -> String? { lock.lock(); defer { lock.unlock() }; return token }
    func save(token: String, server: String) throws { lock.lock(); defer { lock.unlock() }; self.token = token }
    func remove(server: String) throws { lock.lock(); defer { lock.unlock() }; token = nil }
}
private func result(_ request: URLRequest, _ json: String, status: Int = 200) -> (Data, HTTPURLResponse) {
    (Data(json.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
}
final class MailClientTests: XCTestCase {
    func testQueryAndCursorStayInPOSTBodyAndOpaqueBearerIsPreserved() async throws {
        let pairing = try PairingClient(server: URL(string: "https://mail.example")!, store: TestCredentials(), transport: { request in
            XCTAssertEqual(request.url?.absoluteString, "https://mail.example/api/native/v1/threads")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer signed%2Btoken%3D")
            let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            XCTAssertEqual(body["q"] as? String, "from:someone@example.test #private")
            XCTAssertEqual(body["cursor"] as? String, "a/b?+&=中文")
            XCTAssertEqual(body["accountId"] as? String, "owned-account")
            return result(request, #"{"threads":[],"cursor":null,"warnings":[]}"#)
        })
        let page = try await MailClient(pairing: pairing).threads(accountID: "owned-account", query: "from:someone@example.test #private", cursor: "a/b?+&=中文")
        XCTAssertTrue(page.threads.isEmpty)
    }
    func testRevokedMailSessionClearsKeychain() async throws {
        let store = TestCredentials()
        let pairing = try PairingClient(server: URL(string: "https://mail.example")!, store: store, transport: { result($0, #"{"error":"unauthorized"}"#, status: 401) })
        do { _ = try await MailClient(pairing: pairing).accounts(); XCTFail("Expected revocation") }
        catch { XCTAssertEqual(error as? PairingFailure, .signedOut) }
        XCTAssertNil(try store.read(server: "https://mail.example"))
    }
    func testSendIsNotRetriedAfterAmbiguousNetworkFailure() async throws {
        let pairing = try PairingClient(server: URL(string: "https://mail.example")!, store: TestCredentials(), transport: { request in
            XCTAssertEqual(request.timeoutInterval, 120)
            throw URLError(.timedOut)
        })
        var draft = MailComposer(accountId: "account"); draft.to = "a@example.test"
        let original = draft.id.uuidString
        let payload = try draft.outgoing()
        XCTAssertEqual(payload.operationId, original)
        do { try await MailClient(pairing: pairing).send(payload); XCTFail("Expected timeout") } catch { XCTAssertTrue(error is URLError) }
        XCTAssertEqual(try draft.outgoing().operationId, original)
    }
    func testAddressValidationAndEscapedText() throws {
        var draft = MailComposer(accountId: "account")
        draft.to = "a@example.test, b@example.test"; draft.text = "<script>&\n你好"
        XCTAssertEqual(try draft.outgoing().to.count, 2)
        XCTAssertEqual(try draft.outgoing().message, "<div>&lt;script&gt;&amp;<br>你好</div>")
        for invalid in ["a@example.test\r\nBcc:x@example.test", "a@example.test,", "a@example.test;b@example.test", "not-email"] {
            XCTAssertThrowsError(try MailComposer.recipients(invalid))
        }
    }
    func testReplyAllNeverCopiesBccAndExcludesSenderAccount() throws {
        let message = try JSONDecoder().decode(MailMessage.self, from: Data(#"{"id":"one","sender":{"email":"sender@example.test"},"to":[{"email":"me@example.test"},{"email":"friend@example.test"}],"cc":[{"email":"FRIEND@example.test"}],"bcc":[{"email":"private@example.test"}],"subject":"Hello","receivedOn":"","text":"Body","html":"Body","messageId":"<id@example.test>","replyTo":"Sender <reply@example.test>","isDraft":false,"attachments":[]}"#.utf8))
        let account = try JSONDecoder().decode(MailAccount.self, from: Data(#"{"id":"account","email":"me@example.test","name":"Me","providerId":"imap","connected":true}"#.utf8))
        let reply = MailComposer.reply(to: message, threadID: "thread", account: account, all: true)
        XCTAssertEqual(reply.to, "reply@example.test"); XCTAssertEqual(reply.cc, "friend@example.test"); XCTAssertTrue(reply.bcc.isEmpty)
        XCTAssertEqual(reply.headers["In-Reply-To"], "<id@example.test>")
    }
    func testAttachmentNamesCannotEscapeTemporaryDirectoryAndBase64URLWorks() throws {
        let attachment = try JSONDecoder().decode(MailAttachment.self, from: Data(#"{"attachmentId":"one","filename":"../../secret.txt","mimeType":"text/plain","size":2,"body":"-_8"}"#.utf8))
        XCTAssertFalse(attachment.safeFilename.contains("/"))
        XCTAssertEqual(try attachment.decodedData(), Data([251, 255]))
    }
    func testDeepLinksRoundTripWithoutCredentialsAndRejectForeignSchemes() throws {
        let link = MailLink.thread(server: URL(string: "https://mail.example")!, id: "a/b?+&=中文")
        XCTAssertEqual(MailLink(url: link.url), link)
        XCTAssertNil(MailLink(url: URL(string: "zeromail://thread?server=https://user:password@mail.example&id=1")!))
        XCTAssertNil(MailLink(url: URL(string: "javascript:alert(1)")!))
        XCTAssertEqual(MailLink(url: URL(string: "mailto:a@example.test?subject=Hello%20there&body=%E4%BD%A0%E5%A5%BD")!), .compose(to: "a@example.test", subject: "Hello there", text: "你好"))
    }
    func testNativeOperationCannotEscapeAPIBoundary() async throws {
        let client = try PairingClient(server: URL(string: "https://mail.example")!, store: TestCredentials(), transport: { request in
            XCTFail("Invalid path reached transport"); return result(request, "{}")
        })
        for value in ["../auth/sign-out", "https://attacker.example", "accounts?token=x", ""] {
            do { _ = try await client.mailRequest(operation: value, body: Data("{}".utf8)); XCTFail("Path accepted") }
            catch { XCTAssertEqual(error as? PairingFailure, .invalidServer) }
        }
    }
    func testUneditedHTMLDraftKeepsFormatting() throws {
        var draft = MailComposer(accountId: "account")
        draft.text = "A table"; draft.originalText = "A table"; draft.originalHTML = "<table><tr><td>A table</td></tr></table>"
        XCTAssertEqual(try draft.outgoing().message, draft.originalHTML)
        draft.text = "Changed <text>"
        XCTAssertEqual(try draft.outgoing().message, "<div>Changed &lt;text&gt;</div>")
    }
    func testRealServerResponseFixtures() throws {
        guard let directory = ProcessInfo.processInfo.environment["ZERO_APPLE_FIXTURES"] else { throw XCTSkip("Run deploy/tests/apple-native.mjs first and set ZERO_APPLE_FIXTURES") }
        let decoder = JSONDecoder()
        func data(_ name: String) throws -> Data { try Data(contentsOf: URL(fileURLWithPath: directory).appendingPathComponent(name + ".json")) }
        struct Accounts: Decodable { let accounts: [MailAccount] }
        struct Attachments: Decodable { let attachments: [MailAttachment] }
        XCTAssertFalse(try decoder.decode(Accounts.self, from: data("accounts")).accounts.isEmpty)
        XCTAssertNotNil(try decoder.decode(MailPage.self, from: data("page")).cursor)
        XCTAssertEqual(try decoder.decode(MailThread.self, from: data("thread")).messages[0].text, "Hello & welcome")
        XCTAssertEqual(try decoder.decode(Attachments.self, from: data("attachments")).attachments[0].decodedData(), Data("hello".utf8))
        XCTAssertEqual(try decoder.decode(SavedDraft.self, from: data("draft")).text, "Draft body")
    }
}
