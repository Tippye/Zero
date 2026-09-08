import XCTest
@testable import ZeroPairing
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private final class MemoryStore: PairingCredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    func read(server: String) throws -> String? { lock.lock(); defer { lock.unlock() }; return values[server] }
    func save(token: String, server: String) throws { lock.lock(); defer { lock.unlock() }; values[server] = token }
    func remove(server: String) throws { lock.lock(); defer { lock.unlock() }; values.removeValue(forKey: server) }
}
private func response(_ request: URLRequest, _ json: String, status: Int = 200) -> (Data, HTTPURLResponse) {
    (Data(json.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!)
}
final class PairingClientTests: XCTestCase {
    func testDevelopmentHTTPIsLimitedToExactLoopbackOrigins() throws {
        for value in ["http://localhost:18080", "http://127.0.0.1:18080", "http://[::1]:18080"] {
            #if DEBUG
            XCTAssertTrue(PairingClient.allowsDevelopmentHTTP(URL(string: value)!), value)
            #else
            XCTAssertFalse(PairingClient.allowsDevelopmentHTTP(URL(string: value)!), value)
            #endif
        }
        for value in ["http://localhost.example:18080", "http://192.168.1.2", "http://127.0.0.2", "http://localhost@external.example", "http://user:pass@localhost", "http://localhost/api", "http://localhost?redirect=example", "https://localhost"] {
            XCTAssertFalse(PairingClient.allowsDevelopmentHTTP(URL(string: value)!), value)
        }
    }
    func testOriginValidationAndExplicitHTTP() throws {
        for value in ["http://mail.example", "https://user:secret@mail.example", "https://mail.example/path", "https://mail.example?key=value", "https://mail.example/#code"] {
            XCTAssertThrowsError(try PairingClient.serverOrigin(URL(string: value)!))
        }
        XCTAssertEqual(try PairingClient.serverOrigin(URL(string: "https://mail.example/")!).absoluteString, "https://mail.example")
        XCTAssertEqual(try PairingClient.serverOrigin(URL(string: "http://localhost:19180")!, allowHTTP: true).scheme, "http")
    }
    func testNativePairingPreservesOpaqueTokenAndServerIsolation() async throws {
        let store = MemoryStore()
        try store.save(token: "other-server-token", server: "https://other.example")
        let client = try PairingClient(server: URL(string: "https://mail.example")!, store: store, transport: { request in
            switch request.url!.path {
            case "/api/pairing/start":
                XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
                let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
                XCTAssertEqual(body["mode"], "native")
                return response(request, """
                {"requestId":"test-request","deviceSecret":"private-secret","userCode":"ABCD-EFGH","expiresAt":"2099-01-01T00:00:00.000Z","interval":5,"verificationUri":"https://mail.example/pair","verificationUriComplete":"https://mail.example/pair#code=ABCD-EFGH"}
                """)
            case "/api/pairing/exchange":
                let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
                XCTAssertEqual(body["deviceSecret"], "private-secret")
                XCTAssertNil(body["userCode"])
                return response(request, "{\"status\":\"authorized\",\"token\":\"opaque.signature%2B%2F%3D\"}")
            case "/api/pairing/devices":
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer opaque.signature%2B%2F%3D")
                return response(request, """
                {"devices":[{"id":"device-id","name":"iPhone","createdAt":"2026-09-07T00:00:00.000Z","expiresAt":"2099-01-01T00:00:00.000Z","current":true}]}
                """)
            default: throw PairingFailure.invalidResponse
            }
        })
        let request = try await client.start(deviceName: "iPhone")
        XCTAssertFalse(request.verificationUriComplete.absoluteString.contains(request.deviceSecret))
        try await client.waitForAuthorization(request)
        let devices = try await client.devices()
        XCTAssertEqual(devices.first?.name, "iPhone")
        XCTAssertEqual(try store.read(server: "https://other.example"), "other-server-token")
    }
    func testRevokedSessionClearsOnlyItsServerCredential() async throws {
        let store = MemoryStore()
        try store.save(token: "old-token", server: "https://mail.example")
        try store.save(token: "keep-token", server: "https://other.example")
        let client = try PairingClient(server: URL(string: "https://mail.example")!, store: store, transport: { request in response(request, "{\"error\":\"unauthorized\"}", status: 401) })
        do { _ = try await client.devices(); XCTFail("Revoked session must fail") } catch { XCTAssertEqual(error as? PairingFailure, .signedOut) }
        XCTAssertNil(try store.read(server: "https://mail.example"))
        XCTAssertEqual(try store.read(server: "https://other.example"), "keep-token")
    }
    func testUntrustedVerificationOriginIsRejected() async throws {
        let client = try PairingClient(server: URL(string: "https://mail.example")!, store: MemoryStore(), transport: { request in
            response(request, """
            {"requestId":"test","deviceSecret":"private","userCode":"ABCD-EFGH","expiresAt":"2099-01-01T00:00:00Z","interval":5,"verificationUri":"https://attacker.example/pair","verificationUriComplete":"https://attacker.example/pair#code=ABCD-EFGH"}
            """)
        })
        do { _ = try await client.start(deviceName: "Watch"); XCTFail("Unexpected verification origin") } catch { XCTAssertEqual(error as? PairingFailure, .invalidResponse) }
    }
    func testSignOutFailureStillClearsLocalCredential() async throws {
        let store = MemoryStore(); try store.save(token: "test", server: "https://mail.example")
        let client = try PairingClient(server: URL(string: "https://mail.example")!, store: store, transport: { _ in throw URLError(.notConnectedToInternet) })
        do { try await client.signOut(); XCTFail("Network failure should be reported") } catch { }
        XCTAssertNil(try store.read(server: "https://mail.example"))
    }
    func testSignOutClearsBeforeNetworkAndDoesNotDeleteReplacementOnCompletion() async throws {
        let store = MemoryStore(), origin = "https://mail.example"
        try store.save(token: "old-token", server: origin)
        let client = try PairingClient(server: URL(string: origin)!, store: store, transport: { request in
            XCTAssertNil(try store.read(server: origin), "Local logout completes before waiting for the server")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer old-token")
            try store.save(token: "replacement-token", server: origin)
            return response(request, "{}")
        })
        try await client.signOut()
        XCTAssertEqual(try store.read(server: origin), "replacement-token")
    }
    func testLateUnauthorizedResponseCannotRevokeReplacementCredential() async throws {
        let store = MemoryStore(), origin = "https://mail.example"
        try store.save(token: "old-token", server: origin)
        let client = try PairingClient(server: URL(string: origin)!, store: store, transport: { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer old-token")
            try store.save(token: "replacement-token", server: origin)
            return response(request, "{\"error\":\"unauthorized\"}", status: 401)
        })
        do { _ = try await client.devices(); XCTFail("The old request must fail") }
        catch { XCTAssertTrue(error is CancellationError, "A stale request must not tell the app to erase the new session") }
        XCTAssertEqual(try store.read(server: origin), "replacement-token")
    }
    func testWebAIUnauthorizedResponsePreservesReplacementCredential() async throws {
        let store = MemoryStore(), origin = "https://mail.example"
        try store.save(token: "old-token", server: origin)
        let client = try PairingClient(server: URL(string: origin)!, store: store, transport: { request in
            XCTAssertEqual(request.url?.path, "/api/trpc/ai.read")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer old-token")
            try store.save(token: "replacement-token", server: origin)
            return response(request, #"{"error":{"json":{"message":"unauthorized","data":{"code":"UNAUTHORIZED"}}}}"#, status: 401)
        })
        do { _ = try await client.webAIRequest(operation: .read, input: Data("{}".utf8)); XCTFail("The old request must fail") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(try store.read(server: origin), "replacement-token")
    }
    func testLateCurrentDeviceRevocationDoesNotSignOutReplacement() async throws {
        let store = MemoryStore(), origin = "https://mail.example"
        try store.save(token: "old-token", server: origin)
        let client = try PairingClient(server: URL(string: origin)!, store: store, transport: { request in
            try store.save(token: "replacement-token", server: origin)
            return response(request, "{}")
        })
        let device = PairedDevice(id: "old-session", name: "Mac", createdAt: Date(), expiresAt: Date.distantFuture, current: true)
        do { try await client.revoke(device); XCTFail("An obsolete session must not invalidate the current UI") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(try store.read(server: origin), "replacement-token")
    }
    #if canImport(Security)
    func testKeychainRoundTrip() throws {
        let store = KeychainCredentialStore(), server = "https://" + UUID().uuidString + ".example.invalid"
        defer { try? store.remove(server: server) }
        try store.save(token: "synthetic-keychain-test", server: server)
        XCTAssertEqual(try store.read(server: server), "synthetic-keychain-test")
        try store.save(token: "updated-test", server: server)
        XCTAssertEqual(try store.read(server: server), "updated-test")
        try store.remove(server: server)
        XCTAssertNil(try store.read(server: server))
    }
    #endif
}
