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
    public typealias Transport = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
    public nonisolated let server: URL
    private let store: any PairingCredentialStore
    private let transport: Transport
    private let decoder: JSONDecoder

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
    public func hasCredential() throws -> Bool { try store.read(server: server.absoluteString) != nil }
    private func request(_ path: String, body: Data?, authorized: Bool) async throws -> Data {
        guard path.hasPrefix("/api/"), let url = URL(string: path, relativeTo: server)?.absoluteURL,
              url.scheme == server.scheme, url.host == server.host, url.port == server.port else { throw PairingFailure.invalidServer }
        var request = URLRequest(url: url)
        if path == "/api/native/v1/send" { request.timeoutInterval = 120 }
        request.httpMethod = body == nil ? "GET" : "POST"
        request.setValue(server.absoluteString, forHTTPHeaderField: "Origin")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        if authorized {
            guard let token = try store.read(server: server.absoluteString) else { throw PairingFailure.signedOut }
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await transport(request)
        if response.statusCode == 401 {
            try store.remove(server: server.absoluteString)
            throw PairingFailure.signedOut
        }
        guard (200..<300).contains(response.statusCode) else {
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
                try store.save(token: token, server: server.absoluteString)
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
        _ = try await call("/api/pairing/revoke", body: ["sessionId": device.id], authorized: true)
        if device.current { try store.remove(server: server.absoluteString) }
    }
    public func signOut() async throws {
        defer { try? store.remove(server: server.absoluteString) }
        _ = try await call("/api/auth/sign-out", body: [:], authorized: true)
    }
}
