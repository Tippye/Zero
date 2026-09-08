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
private func replyThread(id: String, owner: String? = nil, sender: String = "sender@example.test", to: [String] = [], cc: [String] = [], bcc: [String] = [], replyTo: String? = nil) throws -> MailThread {
    var message: [String: Any] = [
        "id": "message", "sender": ["email": sender], "to": to.map { ["email": $0] }, "cc": cc.map { ["email": $0] }, "bcc": bcc.map { ["email": $0] },
        "subject": "Hello", "receivedOn": "", "text": "Body", "html": "Body", "isDraft": false, "attachments": [],
    ]
    if let replyTo { message["replyTo"] = replyTo }
    var value: [String: Any] = ["id": id, "unread": false, "starred": false, "messages": [message]]
    if let owner { value["accountId"] = owner }
    return try JSONDecoder().decode(MailThread.self, from: JSONSerialization.data(withJSONObject: value))
}
final class MailClientTests: XCTestCase {
    func testNativeEventFeedUsesAuthenticatedPOSTAndPreservesStringCursor() async throws {
        let cursor = "9007199254740993"
        let pairing = try PairingClient(server: URL(string: "https://mail.example")!, store: TestCredentials(), transport: { request in
            XCTAssertEqual(request.url?.path, "/api/native/v1/events")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer signed%2Btoken%3D")
            let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            XCTAssertEqual(body["after"] as? String, cursor)
            return result(request, #"{"owner":"owner","cursor":"9007199254740994","events":[{"id":"9007199254740994","threadId":"mbx.a.message","accountId":"a","sender":"Sender","subject":"Mail"}]}"#)
        })
        let events = try await MailClient(pairing: pairing).events(after: cursor)
        XCTAssertEqual(events.events.first?.accountId, "a")
        XCTAssertEqual(events.cursor, "9007199254740994")
    }
    func testReplyToSentMailTargetsOriginalRecipientsWithoutSelfOrBcc() throws {
        let account = try JSONDecoder().decode(MailAccount.self, from: Data(#"{"id":"me","email":"me@example.test","name":"Me","providerId":"imap","connected":true}"#.utf8))
        let thread = try replyThread(id: "mbx.me.thread", sender: "ME@example.test", to: ["me@example.test", "first@example.test", "FIRST@example.test", "second@example.test"], cc: ["SECOND@example.test", "copied@example.test", "ME@example.test"], bcc: ["private@example.test"], replyTo: "me@example.test")
        let reply = MailComposer.reply(to: thread.messages[0], threadID: thread.id, account: account)
        XCTAssertEqual(reply.to, "first@example.test")
        XCTAssertTrue(reply.cc.isEmpty); XCTAssertTrue(reply.bcc.isEmpty)
        let all = MailComposer.reply(to: thread.messages[0], threadID: thread.id, account: account, all: true)
        XCTAssertEqual(all.to, "first@example.test, second@example.test")
        XCTAssertEqual(all.cc, "copied@example.test")
        XCTAssertTrue(all.bcc.isEmpty)
        XCTAssertEqual(all.threadId, thread.id)
        let selfOnly = try replyThread(id: "mbx.me.thread", sender: "me@example.test", to: ["ME@example.test"], bcc: ["private@example.test"])
        let noPublicRecipient = MailComposer.reply(to: selfOnly.messages[0], threadID: selfOnly.id, account: account, all: true)
        XCTAssertTrue(noPublicRecipient.to.isEmpty); XCTAssertTrue(noPublicRecipient.cc.isEmpty); XCTAssertTrue(noPublicRecipient.bcc.isEmpty)
    }
    func testReplyToReceivedMailAvoidsSelfAddressInReplyTo() throws {
        let account = try JSONDecoder().decode(MailAccount.self, from: Data(#"{"id":"me","email":"me@example.test","name":"Me","providerId":"imap","connected":true}"#.utf8))
        let thread = try replyThread(id: "mbx.me.thread", to: ["me@example.test"], replyTo: "Me <ME@example.test>")
        let reply = MailComposer.reply(to: thread.messages[0], threadID: thread.id, account: account)
        XCTAssertEqual(reply.to, "sender@example.test")
    }
    func testThreadDeepLinksRespectDevelopmentTransportPolicy() throws {
        let loopback = URL(string: "zeromail://thread?server=http%3A%2F%2Flocalhost%3A18080&id=mbx.account.message")!
        #if DEBUG
        XCTAssertEqual(MailLink(url: loopback), .thread(server: URL(string: "http://localhost:18080")!, id: "mbx.account.message"))
        #else
        XCTAssertNil(MailLink(url: loopback))
        #endif
        for server in ["http://192.168.1.2", "http://localhost.example", "http://user:pass@localhost", "http://localhost/api"] {
            var url = URLComponents(); url.scheme = "zeromail"; url.host = "thread"
            url.queryItems = [.init(name: "server", value: server), .init(name: "id", value: "message")]
            XCTAssertNil(MailLink(url: url.url!), server)
        }
    }
    func testReplyUsesOwnedMailboxWhenThreadIsOutsideCurrentList() throws {
        let accounts = try JSONDecoder().decode([MailAccount].self, from: Data(#"[{"id":"other","email":"other@example.test","name":"Other","providerId":"imap","connected":true},{"id":"account%2Ename","email":"me@example.test","name":"Me","providerId":"imap","connected":true}]"#.utf8))
        let thread = try replyThread(id: "mbx.account%252Ename.thread%2Eid", owner: "account%2Ename", to: ["other@example.test"])
        XCTAssertEqual(thread.replyAccount(for: thread.messages[0], accounts: accounts)?.id, "account%2Ename")
        let oldServer = try replyThread(id: "mbx.account%252Ename.thread%2Eid", to: ["other@example.test"])
        XCTAssertNil(oldServer.accountId)
        XCTAssertEqual(oldServer.replyAccount(for: oldServer.messages[0], accounts: accounts, listedAccountID: "other")?.id, "account%2Ename")
        for id in ["mbx.unknown.thread", "mbx..thread", "mbx.account%FF.thread"] {
            let unknown = try replyThread(id: id, to: ["me@example.test"])
            XCTAssertNil(unknown.replyAccount(for: unknown.messages[0], accounts: accounts), id)
        }
    }
    func testLegacyReplyResolvesCCAndSentMailButRejectsAmbiguousAccounts() throws {
        let accounts = try JSONDecoder().decode([MailAccount].self, from: Data(#"[{"id":"me","email":"me@example.test","name":"Me","providerId":"imap","connected":true},{"id":"other","email":"other@example.test","name":"Other","providerId":"imap","connected":true}]"#.utf8))
        let copied = try replyThread(id: "legacy", cc: ["ME@example.test"])
        XCTAssertEqual(copied.replyAccount(for: copied.messages[0], accounts: accounts)?.id, "me")
        let sent = try replyThread(id: "legacy", sender: "ME@example.test", to: ["friend@example.test"])
        XCTAssertEqual(sent.replyAccount(for: sent.messages[0], accounts: accounts)?.id, "me")
        let ambiguous = try replyThread(id: "legacy", to: ["me@example.test", "other@example.test"])
        XCTAssertNil(ambiguous.replyAccount(for: ambiguous.messages[0], accounts: accounts))
        XCTAssertEqual(ambiguous.replyAccount(for: ambiguous.messages[0], accounts: accounts, listedAccountID: "other")?.id, "other")
        let missing = try replyThread(id: "legacy", owner: "deleted", to: ["me@example.test"])
        XCTAssertNil(missing.replyAccount(for: missing.messages[0], accounts: accounts))
    }
    func testAIReaderUsesOwnedIDsAndKeepsContentInPOSTBody() async throws {
        let pairing = try PairingClient(server: URL(string: "https://mail.example")!, store: TestCredentials(), transport: { request in
            XCTAssertEqual(request.url?.absoluteString, "https://mail.example/api/native/v1/ai-read")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.timeoutInterval, 150)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer signed%2Btoken%3D")
            let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            XCTAssertEqual(body["threadId"] as? String, "mbx.account.thread%2F中文")
            XCTAssertEqual(body["messageId"] as? String, "mbx.account.message+&=1")
            XCTAssertEqual(body["action"] as? String, "ask")
            XCTAssertEqual(body["language"] as? String, "zh-CN")
            XCTAssertEqual(body["question"] as? String, "截止时间？")
            XCTAssertEqual((body["history"] as? [[String: String]])?.first, ["question": "发生了什么？", "answer": "新项目。"])
            XCTAssertEqual(Set(body.keys), Set(["threadId", "messageId", "action", "language", "question", "history"]))
            return result(request, #"{"text":"下周五。","translation":null}"#)
        })
        let answer = try await MailClient(pairing: pairing).readWithAI(threadID: "mbx.account.thread%2F中文", messageID: "mbx.account.message+&=1", action: .ask, language: "zh-CN", question: "截止时间？", history: [MailAITurn(question: "发生了什么？", answer: "新项目。")])
        XCTAssertEqual(answer.text, "下周五。")
        XCTAssertNil(answer.translation)
    }
    func testAIAvailabilityAndCachedTranslationDoNotGenerate() async throws {
        let pairing = try PairingClient(server: URL(string: "https://mail.example")!, store: TestCredentials(), transport: { request in
            switch request.url!.lastPathComponent {
            case "ai-status":
                return result(request, #"{"ready":true,"name":"My provider","model":"my-model"}"#)
            case "ai-translation":
                let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
                XCTAssertEqual(body, ["threadId": "mbx.account.thread", "messageId": "mbx.account.message"])
                return result(request, #"{"translation":{"subject":"你好","text":"正文","html":"<p>正文</p>","language":"zh-CN","expiresAt":1234567890000}}"#)
            default:
                XCTFail("Viewing AI availability must not trigger generation")
                return result(request, "{}")
            }
        })
        let client = MailClient(pairing: pairing)
        let status = try await client.aiStatus()
        XCTAssertTrue(status.ready); XCTAssertEqual(status.model, "my-model")
        let translation = try await client.cachedTranslation(threadID: "mbx.account.thread", messageID: "mbx.account.message")
        XCTAssertEqual(translation?.html, "<p>正文</p>")
        XCTAssertEqual(translation?.text, "正文")
        XCTAssertEqual(translation?.expiresAt, 1234567890000)
    }
    func testAIComposeRequestsOnlyDraftTextAndExplicitConsent() async throws {
        let pairing = try PairingClient(server: URL(string: "https://mail.example")!, store: TestCredentials(), transport: { request in
            XCTAssertEqual(request.url?.absoluteString, "https://mail.example/api/native/v1/ai-compose")
            XCTAssertEqual(request.timeoutInterval, 150)
            let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            XCTAssertEqual(body["instructions"] as? String, "请起草问候邮件。")
            XCTAssertEqual(body["consent"] as? Bool, true)
            XCTAssertEqual(Set(body.keys), Set(["instructions", "consent"]))
            return result(request, #"{"text":"你好，最近好吗？","model":"my-model"}"#)
        })
        let draft = try await MailClient(pairing: pairing).composeWithAI(instructions: "请起草问候邮件。")
        XCTAssertEqual(draft.text, "你好，最近好吗？")
    }
    func testCancellingAIRequestStopsTransportWithoutRetry() async throws {
        actor Calls {
            var count = 0
            func record() { count += 1 }
        }
        let calls = Calls()
        let started = expectation(description: "AI request started")
        let pairing = try PairingClient(server: URL(string: "https://mail.example")!, store: TestCredentials(), transport: { request in
            await calls.record(); started.fulfill()
            try await Task.sleep(nanoseconds: 30_000_000_000)
            XCTFail("Cancelled transport continued")
            return result(request, #"{"text":"unexpected","translation":null}"#)
        })
        let task = Task { try await MailClient(pairing: pairing).readWithAI(threadID: "thread", messageID: "message", action: .summary, language: "en") }
        await fulfillment(of: [started], timeout: 2)
        task.cancel()
        do { _ = try await task.value; XCTFail("Expected cancellation") }
        catch { XCTAssertTrue(error is CancellationError) }
        let count = await calls.count
        XCTAssertEqual(count, 1)
    }
    func testMissingAIConfigurationPreservesPairing() async throws {
        let store = TestCredentials()
        let pairing = try PairingClient(server: URL(string: "https://mail.example")!, store: store, transport: { request in
            result(request, #"{"error":"PRECONDITION_FAILED"}"#, status: 409)
        })
        do { _ = try await MailClient(pairing: pairing).composeWithAI(instructions: "Draft a greeting"); XCTFail("Expected missing configuration") }
        catch { XCTAssertEqual(error as? PairingFailure, .server("PRECONDITION_FAILED")) }
        XCTAssertNotNil(try store.read(server: "https://mail.example"))
    }
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
    func testComposeLinksPreserveAllDesktopFieldsAndDecodeOnce() throws {
        let expected = MailLink.compose(to: "a+b@example.test", cc: "c@example.test", bcc: "d@example.test", subject: "你好 & 50% a+b", text: "first\r\nsecond?yes%20")
        let query = "cc=c@example.test&bcc=d@example.test&subject=%E4%BD%A0%E5%A5%BD%20%26%2050%25%20a+b&body=first%0D%0Asecond%3Fyes%2520"
        XCTAssertEqual(MailLink(url: URL(string: "mailto:a%2Bb@example.test?" + query)!), expected)
        XCTAssertEqual(MailLink(url: URL(string: "zeromail://compose?to=a%2Bb@example.test&" + query)!), expected)
        XCTAssertEqual(MailLink(url: expected.url), expected)
    }
    func testComposeLinksCombineQueryRecipientsAndAcceptCaseInsensitiveHeaders() throws {
        let url = URL(string: "MAILTO:first@example.test?TO=second@example.test&to=third@example.test&CC=c@example.test&Bcc=d@example.test&SUBJECT=old&subject=new&attachment=file:///tmp/private")!
        XCTAssertEqual(MailLink(url: url), .compose(to: "first@example.test,second@example.test,third@example.test", cc: "c@example.test", bcc: "d@example.test", subject: "new", text: ""))
        XCTAssertEqual(MailLink(url: URL(string: "mailto:?subject=Hello")!), .compose(to: "", subject: "Hello", text: ""))
    }
    func testInboxLinksMatchDesktopRoutes() throws {
        for raw in ["zeromail://inbox", "zeromail://inbox/", "ZEROMAIL://INBOX"] {
            XCTAssertEqual(MailLink(url: URL(string: raw)!), .inbox, raw)
        }
        XCTAssertEqual(MailLink.inbox.url.absoluteString, "zeromail://inbox")
        XCTAssertEqual(MailLink(url: MailLink.inbox.url), .inbox)
        for raw in ["zeromail://inbox?server=https://other.example", "zeromail://inbox/other", "zeromail://inbox:123"] {
            XCTAssertNil(MailLink(url: URL(string: raw)!), raw)
        }
    }
    func testComposeLinksRejectHeaderInjectionAndUnsupportedRoutes() throws {
        for raw in [
            "mailto:a@example.test%0D%0ABcc:private@example.test",
            "mailto:a@example.test?to=b@example.test%0A",
            "mailto:a@example.test?cc=c@example.test%0D",
            "mailto:a@example.test?bcc=d@example.test%0D%0A",
            "mailto:a@example.test?subject=hello%0Aworld",
            "mailto:a@example.test?subject=%00",
            "mailto:a@example.test?body=hello%00world",
            "mailto:a@example.test?subject=%FF",
            "mailto:a@example.test#fragment",
            "zeromail://user:pass@compose?to=a@example.test",
            "zeromail://compose/extra?to=a@example.test",
            "zeromail://server?url=https://other.example",
            "zeromail://thread/extra?server=https://mail.example&id=1",
            "zeromail://compose?body=" + String(repeating: "x", count: 32000)
        ] {
            XCTAssertNil(MailLink(url: URL(string: raw)!), raw.prefix(120).description)
        }
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
