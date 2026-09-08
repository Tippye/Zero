import XCTest
@testable import ZeroMail
import ZeroPairing
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private final class LegacyCredentials: PairingCredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var token: String? = "opaque%2Bbearer%3D"
    func read(server: String) throws -> String? { lock.lock(); defer { lock.unlock() }; return token }
    func save(token: String, server: String) throws { lock.lock(); defer { lock.unlock() }; self.token = token }
    func remove(server: String) throws { lock.lock(); defer { lock.unlock() }; token = nil }
}
private actor LegacyCalls {
    private(set) var paths: [String] = []
    func record(_ request: URLRequest) { paths.append(request.url!.path) }
}
private func legacyResponse(_ request: URLRequest, _ json: String, status: Int = 200) -> (Data, HTTPURLResponse) {
    (Data(json.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
}
private let readyOverview = #"{"result":{"data":{"json":{"ready":true,"activeId":"active","profiles":[{"id":"inactive","name":"Other","model":"other"},{"id":"active","name":"Private Docker","model":"remote-model","baseUrl":"http://provider.internal:11434/v1","apiKey":"must-not-be-used"}]}}}}"#
private func nativeMissing(_ request: URLRequest) -> (Data, HTTPURLResponse) { legacyResponse(request, #"{"error":"NOT_FOUND"}"#, status: 404) }

final class LegacyAICompatibilityTests: XCTestCase {
    func testCapabilitySelectsLegacyOnceAndUsesOnlySameOriginTypedProcedures() async throws {
        let calls = LegacyCalls()
        let pairing = try PairingClient(server: URL(string: "https://mail.example")!, store: LegacyCredentials(), transport: { request in
            await calls.record(request)
            XCTAssertEqual(request.url?.host, "mail.example")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer opaque%2Bbearer%3D")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://mail.example")
            switch request.url!.path {
            case "/api/native/v1/ai-status": return nativeMissing(request)
            case "/api/trpc/llm.list":
                XCTAssertEqual(request.httpMethod, "GET"); XCTAssertNil(request.httpBody); XCTAssertNil(request.url?.query)
                return legacyResponse(request, readyOverview)
            case "/api/trpc/ai.read":
                XCTAssertEqual(request.httpMethod, "POST"); XCTAssertEqual(request.timeoutInterval, 150)
                let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody!) as? [String: Any])
                XCTAssertEqual(Set(envelope.keys), ["json"])
                let input = try XCTUnwrap(envelope["json"] as? [String: Any])
                XCTAssertEqual(input["threadId"] as? String, "mbx.a.thread%2F中文")
                XCTAssertEqual(input["messageId"] as? String, "mbx.a.message+&=1")
                XCTAssertEqual(input["question"] as? String, "何时完成？")
                XCTAssertEqual((input["history"] as? [[String: String]])?.first?["answer"], "明天。")
                return legacyResponse(request, #"{"result":{"data":{"json":{"text":"明天下午。","translation":null}}}}"#)
            case "/api/trpc/imap.generate":
                XCTAssertEqual(request.httpMethod, "POST"); XCTAssertEqual(request.timeoutInterval, 150)
                let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody!) as? [String: Any])
                let input = try XCTUnwrap(envelope["json"] as? [String: Any])
                XCTAssertEqual(Set(input.keys), ["task", "instructions", "consent"])
                XCTAssertEqual(input["task"] as? String, "compose"); XCTAssertEqual(input["consent"] as? Bool, true)
                XCTAssertEqual(input["instructions"] as? String, "起草问候")
                return legacyResponse(request, #"{"result":{"data":{"json":{"text":"你好。","model":"remote-model"}}}}"#)
            default: XCTFail("Unexpected route: \(request.url!.path)"); throw PairingFailure.invalidResponse
            }
        })
        let client = MailClient(pairing: pairing)
        let status = try await client.aiStatus()
        XCTAssertTrue(status.ready); XCTAssertEqual(status.name, "Private Docker"); XCTAssertEqual(status.model, "remote-model")
        _ = try await client.aiStatus()
        let answer = try await client.readWithAI(threadID: "mbx.a.thread%2F中文", messageID: "mbx.a.message+&=1", action: .ask, language: "zh-CN", question: "何时完成？", history: [.init(question: "截止？", answer: "明天。")])
        XCTAssertEqual(answer.text, "明天下午。")
        let composition = try await client.composeWithAI(instructions: "起草问候")
        XCTAssertEqual(composition.text, "你好。")
        let paths = await calls.paths
        XCTAssertEqual(paths, ["/api/native/v1/ai-status", "/api/trpc/llm.list", "/api/trpc/llm.list", "/api/trpc/ai.read", "/api/trpc/imap.generate"])
    }

    func testLegacyCachedTranslationPreservesOpaqueIDsAndPassivelyConvertsHTML() async throws {
        let pairing = try PairingClient(server: URL(string: "https://mail.example")!, store: LegacyCredentials(), transport: { request in
            switch request.url!.path {
            case "/api/native/v1/ai-status": return nativeMissing(request)
            case "/api/trpc/llm.list": return legacyResponse(request, readyOverview)
            case "/api/trpc/ai.translation":
                XCTAssertEqual(request.httpMethod, "GET"); XCTAssertNil(request.httpBody)
                let query = try XCTUnwrap(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "input" }?.value)
                let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(query.utf8)) as? [String: Any])
                let input = try XCTUnwrap(envelope["json"] as? [String: String])
                XCTAssertEqual(input, ["threadId": "mbx.a.t%2F?+&=中文", "messageId": "mbx.a.m+%25#"])
                let translation: [String: Any] = ["subject": "译文", "html": "<head><style>secret style</style></head><p>Hello &amp; &#x4E2D;&#25991;</p><script src='https://evil.invalid/a'>secret script</script><img src='https://evil.invalid/pixel'><p>&lt;safe&gt; &copy;</p>", "language": "zh-CN", "expiresAt": 1234567890000.0]
                let data = try JSONSerialization.data(withJSONObject: ["result": ["data": ["json": translation]]])
                return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            default: XCTFail("Text conversion must not fetch resources"); throw PairingFailure.invalidResponse
            }
        })
        let client = MailClient(pairing: pairing); _ = try await client.aiStatus()
        let translation = try await client.cachedTranslation(threadID: "mbx.a.t%2F?+&=中文", messageID: "mbx.a.m+%25#")
        XCTAssertEqual(translation?.text, "Hello & 中文\n<safe> ©")
        XCTAssertEqual(translation?.expiresAt, 1234567890000)
        XCTAssertTrue(translation?.html.contains("https://evil.invalid/pixel") == true, "Original HTML remains available to the existing safe renderer")
    }

    func testLegacyNullTranslationAndUnavailableConfigurationAreReadOnly() async throws {
        let calls = LegacyCalls()
        let pairing = try PairingClient(server: URL(string: "https://mail.example")!, store: LegacyCredentials(), transport: { request in
            await calls.record(request)
            switch request.url!.path {
            case "/api/native/v1/ai-status": return nativeMissing(request)
            case "/api/trpc/llm.list": return legacyResponse(request, #"{"result":{"data":{"json":{"ready":false,"activeId":null,"profiles":[]}}}}"#)
            case "/api/trpc/ai.translation": return legacyResponse(request, #"{"result":{"data":{"json":null}}}"#)
            default: XCTFail("Opening status/cache must never generate"); throw PairingFailure.invalidResponse
            }
        })
        let client = MailClient(pairing: pairing), status = try await client.aiStatus()
        XCTAssertFalse(status.ready); XCTAssertEqual(status.name, ""); XCTAssertEqual(status.model, "")
        let cached = try await client.cachedTranslation(threadID: "thread", messageID: "message")
        XCTAssertNil(cached)
        let count = await calls.paths.count; XCTAssertEqual(count, 3)
    }

    func testNativeCapabilityErrorsNeverTriggerLegacyFallback() async throws {
        for code in ["PRECONDITION_FAILED", "INTERNAL_SERVER_ERROR", "FORBIDDEN"] {
            let calls = LegacyCalls(), store = LegacyCredentials()
            let pairing = try PairingClient(server: URL(string: "https://mail.example")!, store: store, transport: { request in
                await calls.record(request)
                XCTAssertEqual(request.url?.path, "/api/native/v1/ai-status")
                return legacyResponse(request, "{\"error\":\"\(code)\"}", status: 500)
            })
            do { _ = try await MailClient(pairing: pairing).aiStatus(); XCTFail("Expected capability error") }
            catch { XCTAssertEqual(error as? PairingFailure, .server(code)) }
            let count = await calls.paths.count; XCTAssertEqual(count, 1)
            XCTAssertNotNil(try store.read(server: "https://mail.example"))
        }
    }

    func testLegacyAuthenticationFailureClearsCredentialAndDoesNotGenerate() async throws {
        let calls = LegacyCalls(), store = LegacyCredentials()
        let pairing = try PairingClient(server: URL(string: "https://mail.example")!, store: store, transport: { request in
            await calls.record(request)
            if request.url?.path == "/api/native/v1/ai-status" { return nativeMissing(request) }
            XCTAssertEqual(request.url?.path, "/api/trpc/llm.list")
            return legacyResponse(request, #"{"error":{"json":{"message":"private detail","data":{"code":"UNAUTHORIZED","httpStatus":401}}}}"#, status: 401)
        })
        do { _ = try await MailClient(pairing: pairing).aiStatus(); XCTFail("Expected authentication failure") }
        catch { XCTAssertEqual(error as? PairingFailure, .signedOut) }
        XCTAssertNil(try store.read(server: "https://mail.example"))
        let count = await calls.paths.count; XCTAssertEqual(count, 2)
    }

    func testSubmittedLegacyGenerationErrorIsNotRetriedOrSentToNative() async throws {
        for code in ["NOT_FOUND", "PRECONDITION_FAILED", "BAD_GATEWAY"] {
            let calls = LegacyCalls(), store = LegacyCredentials()
            let pairing = try PairingClient(server: URL(string: "https://mail.example")!, store: store, transport: { request in
                await calls.record(request)
                switch request.url!.path {
                case "/api/native/v1/ai-status": return nativeMissing(request)
                case "/api/trpc/llm.list": return legacyResponse(request, readyOverview)
                case "/api/trpc/imap.generate":
                    return legacyResponse(request, "{\"error\":{\"json\":{\"message\":\"LLM_NOT_CONFIGURED: /settings/llm private diagnostic\",\"data\":{\"code\":\"\(code)\"}}}}", status: 412)
                default: XCTFail("Generation must not switch transport or retry"); throw PairingFailure.invalidResponse
                }
            })
            let client = MailClient(pairing: pairing); _ = try await client.aiStatus()
            do { _ = try await client.composeWithAI(instructions: "Draft"); XCTFail("Expected generation failure") }
            catch { XCTAssertEqual(error as? PairingFailure, .server(code), "Expose symbolic code only, never raw provider details") }
            let paths = await calls.paths
            XCTAssertEqual(paths.filter { $0.contains("generate") }.count, 1); XCTAssertEqual(paths.count, 3)
            XCTAssertNotNil(try store.read(server: "https://mail.example"))
        }
    }

    func testNativeGenerationNotFoundWithoutCapabilityCheckDoesNotFallback() async throws {
        let calls = LegacyCalls()
        let pairing = try PairingClient(server: URL(string: "https://mail.example")!, store: LegacyCredentials(), transport: { request in
            await calls.record(request); XCTAssertEqual(request.url?.path, "/api/native/v1/ai-read")
            return nativeMissing(request)
        })
        do { _ = try await MailClient(pairing: pairing).readWithAI(threadID: "thread", messageID: "message", action: .summary, language: "en"); XCTFail("Expected missing endpoint") }
        catch { XCTAssertEqual(error as? PairingFailure, .server("NOT_FOUND")) }
        let count = await calls.paths.count; XCTAssertEqual(count, 1)
    }

    func testLegacyCancellationStopsGenerationWithoutRetry() async throws {
        let calls = LegacyCalls(), started = expectation(description: "Generation started")
        let pairing = try PairingClient(server: URL(string: "https://mail.example")!, store: LegacyCredentials(), transport: { request in
            await calls.record(request)
            switch request.url!.path {
            case "/api/native/v1/ai-status": return nativeMissing(request)
            case "/api/trpc/llm.list": return legacyResponse(request, readyOverview)
            case "/api/trpc/imap.generate":
                started.fulfill(); try await Task.sleep(nanoseconds: 30_000_000_000)
                XCTFail("Cancelled generation resumed"); throw PairingFailure.invalidResponse
            default: XCTFail("Unexpected retry"); throw PairingFailure.invalidResponse
            }
        })
        let client = MailClient(pairing: pairing); _ = try await client.aiStatus()
        let task = Task { try await client.composeWithAI(instructions: "Draft") }
        await fulfillment(of: [started], timeout: 2); task.cancel()
        do { _ = try await task.value; XCTFail("Expected cancellation") } catch { XCTAssertTrue(error is CancellationError) }
        let count = await calls.paths.count; XCTAssertEqual(count, 3)
    }
}
