import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum PairingFailure: Error, Equatable {
    case invalidServer, invalidResponse, expired, signedOut, credentialStorage
    case server(String)
}
public struct PairingRequest: Decodable, Sendable {
    public let requestId: String
    // Deliberately internal: display only userCode or verificationUriComplete.
    let deviceSecret: String
    public let userCode: String
    public let expiresAt: Date
    public let interval: Int
    public let verificationUri: URL
    public let verificationUriComplete: URL
}
public struct PairingPreview: Decodable, Sendable {
    public let requestId: String
    public let origin: String
    public let deviceName: String
    public let createdAt: Date
    public let expiresAt: Date
}
public struct PairedDevice: Decodable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let createdAt: Date
    public let expiresAt: Date
    public let current: Bool
}
private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

public actor PairingClient {
    private static let credentialLock = NSLock()
    private func credential<T>(_ operation: () throws -> T) rethrows -> T {
        Self.credentialLock.lock(); defer { Self.credentialLock.unlock() }
        return try operation()
    }
    public typealias Transport = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
    public nonisolated let server: URL
    private let store: any PairingCredentialStore
    private let transport: Transport
    private let decoder: JSONDecoder

    /// Debug builds may reach a developer's loopback tunnel. Release builds
    /// never opt into HTTP, including when opening a saved development origin.
    public static func allowsDevelopmentHTTP(_ value: URL) -> Bool {
        #if DEBUG
        guard let components = URLComponents(url: value, resolvingAgainstBaseURL: false),
              components.scheme == "http", let host = components.host?.lowercased(),
              ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host) else { return false }
        return (try? serverOrigin(value, allowHTTP: true)) != nil
        #else
        return false
        #endif
    }

    public static func serverOrigin(_ value: URL, allowHTTP: Bool = false) throws -> URL {
        guard let c = URLComponents(url: value, resolvingAgainstBaseURL: false),
              c.scheme == "https" || (allowHTTP && c.scheme == "http"),
              let host = c.host, !host.isEmpty, c.user == nil, c.password == nil,
              c.path.isEmpty || c.path == "/", c.query == nil, c.fragment == nil else { throw PairingFailure.invalidServer }
        var normalized = c; normalized.path = ""; normalized.host = host.lowercased()
        if (c.scheme == "https" && c.port == 443) || (c.scheme == "http" && c.port == 80) { normalized.port = nil }
        guard let origin = normalized.url else { throw PairingFailure.invalidServer }
        return origin
    }
    public init(server: URL, allowHTTP: Bool = false, store: any PairingCredentialStore = KeychainCredentialStore(), transport: Transport? = nil) throws {
        self.server = try Self.serverOrigin(server, allowHTTP: allowHTTP)
        self.store = store
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            let parser = ISO8601DateFormatter()
            parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = parser.date(from: text) { return date }
            parser.formatOptions = [.withInternetDateTime]
            guard let date = parser.date(from: text) else { throw PairingFailure.invalidResponse }
            return date
        }
        self.decoder = decoder
        if let transport { self.transport = transport }
        else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpCookieStorage = nil
            configuration.httpShouldSetCookies = false
            configuration.urlCache = nil
            configuration.timeoutIntervalForRequest = 20
            let session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
            self.transport = { request in
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else { throw PairingFailure.invalidResponse }
                return (data, http)
            }
        }
    }
    private func call(_ path: String, body: [String: String]? = nil, authorized: Bool = false) async throws -> Data {
        try await request(path, body: body.map { try JSONSerialization.data(withJSONObject: $0) }, authorized: authorized)
    }
    /// Only the versioned mail API is exposed to clients; credentials remain in this actor.
    public func mailRequest(operation: String, body: Data) async throws -> Data {
        guard !operation.isEmpty, operation.allSatisfy({ $0.isASCII && ($0.isLetter || $0 == "-") }) else { throw PairingFailure.invalidServer }
        return try await request("/api/native/v1/" + operation, body: body, authorized: true)
    }
    /// Compatibility with the existing authenticated web AI API only. No provider URLs or
    /// arbitrary tRPC procedures can be supplied, and submitted mutations are never retried.
    public enum WebAIOperation: String, Sendable {
        case status = "llm.list", read = "ai.read", translation = "ai.translation", compose = "imap.generate"
    }
    public func webAIRequest(operation: WebAIOperation, input: Data? = nil) async throws -> Data {
        var path = "/api/trpc/" + operation.rawValue
        var body: Data?
        if operation == .status {
            guard input == nil else { throw PairingFailure.invalidResponse }
        } else {
            guard let input, input.count <= 1024 * 1024,
                  let json = try JSONSerialization.jsonObject(with: input) as? [String: Any] else { throw PairingFailure.invalidResponse }
            let envelope = try JSONSerialization.data(withJSONObject: ["json": json])
            if operation == .translation {
                let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
                guard let encoded = String(data: envelope, encoding: .utf8)?.addingPercentEncoding(withAllowedCharacters: allowed) else { throw PairingFailure.invalidResponse }
                path += "?input=" + encoded
            } else { body = envelope }
        }
        let response = try await request(path, body: body, authorized: true)
        guard response.count <= 4 * 1024 * 1024,
              let root = try JSONSerialization.jsonObject(with: response) as? [String: Any] else { throw PairingFailure.invalidResponse }
        if let code = Self.webErrorCode(root) { throw PairingFailure.server(code) }
        guard let result = root["result"] as? [String: Any], let data = result["data"] as? [String: Any],
              let json = data["json"] else { throw PairingFailure.invalidResponse }
        return try JSONSerialization.data(withJSONObject: json, options: [.fragmentsAllowed])
    }
    private static func webErrorCode(_ root: [String: Any]) -> String? {
        guard let error = root["error"] as? [String: Any], let json = error["json"] as? [String: Any],
              let data = json["data"] as? [String: Any], let code = data["code"] as? String,
              !code.isEmpty, code.utf8.count <= 64,
              code.utf8.allSatisfy({ (65...90).contains($0) || $0 == 95 }) else { return nil }
        return code
    }
    public func hasCredential() throws -> Bool { try credential { try store.read(server: server.absoluteString) != nil } }
    private func request(_ path: String, body: Data?, authorized: Bool, tokenOverride: String? = nil) async throws -> Data {
        guard path.hasPrefix("/api/"), let url = URL(string: path, relativeTo: server)?.absoluteURL,
              url.scheme == server.scheme, url.host == server.host, url.port == server.port else { throw PairingFailure.invalidServer }
        var request = URLRequest(url: url)
        if path == "/api/native/v1/send" { request.timeoutInterval = 120 }
        if path == "/api/native/v1/ai-read" || path == "/api/native/v1/ai-compose" { request.timeoutInterval = 150 }
        if path == "/api/trpc/ai.read" || path == "/api/trpc/imap.generate" { request.timeoutInterval = 150 }
        request.httpMethod = body == nil ? "GET" : "POST"
        request.setValue(server.absoluteString, forHTTPHeaderField: "Origin")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        var requestToken: String?
        if authorized {
            guard let token = try tokenOverride ?? credential({ try store.read(server: server.absoluteString) }) else { throw PairingFailure.signedOut }
            requestToken = token
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await transport(request)
        let webFailure: String? = path.hasPrefix("/api/trpc/")
            ? (try? JSONSerialization.jsonObject(with: data) as? [String: Any]).flatMap(Self.webErrorCode) : nil
        if response.statusCode == 401 || webFailure == "UNAUTHORIZED" {
            let replaced = try credential {
                let current = try store.read(server: server.absoluteString)
                if let requestToken, current == requestToken { try store.remove(server: server.absoluteString) }
                return current != nil && current != requestToken
            }
            // A late response from a replaced session must not sign the new session out.
            if replaced { throw CancellationError() }
            throw PairingFailure.signedOut
        }
        guard (200..<300).contains(response.statusCode) else {
            if let webFailure { throw PairingFailure.server(webFailure) }
            let failure = try? JSONSerialization.jsonObject(with: data) as? [String: String]
            throw PairingFailure.server(failure?["error"] ?? "request_failed")
        }
        return data
    }
    public func start(deviceName: String) async throws -> PairingRequest {
        let data = try await call("/api/pairing/start", body: ["deviceName": deviceName, "mode": "native"])
        let request = try decoder.decode(PairingRequest.self, from: data)
        guard request.verificationUri.scheme == server.scheme, request.verificationUri.host == server.host,
              request.verificationUri.port == server.port,
              request.verificationUriComplete.scheme == server.scheme, request.verificationUriComplete.host == server.host,
              request.verificationUriComplete.port == server.port else { throw PairingFailure.invalidResponse }
        return request
    }
    /// Polls at the server's interval. Cancelling the task stops polling.
    public func waitForAuthorization(_ request: PairingRequest) async throws {
        guard request.verificationUri.scheme == server.scheme, request.verificationUri.host == server.host, request.verificationUri.port == server.port else { throw PairingFailure.invalidServer }
        struct Poll: Decodable { let status: String; let token: String?; let interval: Int? }
        var interval = max(5, request.interval)
        while Date() < request.expiresAt {
            try Task.checkCancellation()
            try await Task.sleep(nanoseconds: UInt64(min(interval, 60)) * 1_000_000_000)
            let data = try await call("/api/pairing/exchange", body: ["requestId": request.requestId, "deviceSecret": request.deviceSecret])
            let result = try decoder.decode(Poll.self, from: data)
            if result.status == "authorized", let token = result.token {
                // Keep the response opaque: decoding its percent escapes breaks
                // the server's signed bearer transport.
                try credential { try store.save(token: token, server: server.absoluteString) }
                return
            }
            guard result.status == "authorization_pending" || result.status == "slow_down" else { throw PairingFailure.invalidResponse }
            interval = max(5, result.interval ?? interval)
        }
        throw PairingFailure.expired
    }
    public func preview(code: String) async throws -> PairingPreview {
        try decoder.decode(PairingPreview.self, from: await call("/api/pairing/preview", body: ["code": code], authorized: true))
    }
    /// Call only after the UI displays the preview and the user confirms.
    public func decide(code: String, requestID: String, approve: Bool) async throws {
        _ = try await call("/api/pairing/" + (approve ? "approve" : "deny"), body: ["code": code, "requestId": requestID], authorized: true)
    }
    public func devices() async throws -> [PairedDevice] {
        struct Result: Decodable { let devices: [PairedDevice] }
        return try decoder.decode(Result.self, from: await call("/api/pairing/devices", authorized: true)).devices
    }
    public func revoke(_ device: PairedDevice) async throws {
        guard let token = try credential({ try store.read(server: server.absoluteString) }) else { throw PairingFailure.signedOut }
        _ = try await request("/api/pairing/revoke", body: JSONSerialization.data(withJSONObject: ["sessionId": device.id]), authorized: true, tokenOverride: token)
        if device.current {
            let removed = try credential {
                guard try store.read(server: server.absoluteString) == token else { return false }
                try store.remove(server: server.absoluteString); return true
            }
            if !removed { throw CancellationError() }
        }
    }
    public func signOut() async throws {
        let token = try credential {
            let token = try store.read(server: server.absoluteString)
            try store.remove(server: server.absoluteString)
            return token
        }
        guard let token else { return }
        _ = try await request("/api/auth/sign-out", body: Data("{}".utf8), authorized: true, tokenOverride: token)
    }
}
