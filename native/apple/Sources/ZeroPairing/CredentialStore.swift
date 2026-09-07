import Foundation
#if canImport(Security)
import Security
#endif

public protocol PairingCredentialStore: Sendable {
    func read(server: String) throws -> String?
    func save(token: String, server: String) throws
    func remove(server: String) throws
}

/// Credentials stay on this device, separated by the exact server origin.
public struct KeychainCredentialStore: PairingCredentialStore {
    public init() {}
    #if canImport(Security)
    private func query(_ server: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "org.zero.mail.pairing",
         kSecAttrAccount as String: server,
         kSecAttrSynchronizable as String: false]
    }
    public func read(server: String) throws -> String? {
        var q = query(server)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data, let token = String(data: data, encoding: .utf8) else { throw PairingFailure.credentialStorage }
        return token
    }
    public func save(token: String, server: String) throws {
        let attributes: [String: Any] = [kSecValueData as String: Data(token.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query(server) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let item = query(server).merging(attributes) { _, new in new }
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw PairingFailure.credentialStorage }
        } else if status != errSecSuccess { throw PairingFailure.credentialStorage }
    }
    public func remove(server: String) throws {
        let status = SecItemDelete(query(server) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw PairingFailure.credentialStorage }
    }
    #else
    // Linux builds exercise the protocol with an injected test store, never a
    // plaintext fallback pretending to be Keychain.
    public func read(server: String) throws -> String? { throw PairingFailure.credentialStorage }
    public func save(token: String, server: String) throws { throw PairingFailure.credentialStorage }
    public func remove(server: String) throws { throw PairingFailure.credentialStorage }
    #endif
}
