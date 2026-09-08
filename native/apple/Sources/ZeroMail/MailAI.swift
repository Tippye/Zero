import Foundation
import ZeroPairing

public struct MailAIStatus: Decodable, Sendable {
    public let ready: Bool
    public let name: String
    public let model: String
}

public enum MailAIAction: String, Codable, Sendable {
    case summary, translate, ask
}

public struct MailAITurn: Codable, Sendable {
    public let question: String
    public let answer: String
    public init(question: String, answer: String) { self.question = question; self.answer = answer }
}

public struct MailTranslation: Decodable, Sendable {
    public let subject: String
    public let html: String
    public let text: String
    public let language: String
    /// Server cache expiration, in milliseconds since the Unix epoch.
    public let expiresAt: Double
    private enum CodingKeys: String, CodingKey { case subject, html, text, language, expiresAt }
    public init(from decoder: Decoder) throws {
        let value = try decoder.container(keyedBy: CodingKeys.self)
        subject = try value.decode(String.self, forKey: .subject)
        html = try value.decode(String.self, forKey: .html)
        language = try value.decode(String.self, forKey: .language)
        expiresAt = try value.decode(Double.self, forKey: .expiresAt)
        guard html.utf8.count <= 4 * 1024 * 1024 else { throw PairingFailure.invalidResponse }
        text = try value.decodeIfPresent(String.self, forKey: .text) ?? Self.plainText(html)
    }
    /// Passive text conversion for older servers. Never instantiates WebKit or an HTML document
    /// renderer, so remote images, CSS and scripts cannot initiate requests during decoding.
    private static func plainText(_ html: String) -> String {
        var value = html.replacingOccurrences(of: #"(?is)<!--.*?(?:-->|$)|<(script|style|head|iframe|object)\b[^>]*>.*?(?:</\1\s*>|$)"#, with: "", options: .regularExpression)
        value = value.replacingOccurrences(of: #"(?i)<(?:br\b[^>]*|/(?:p|div|li|tr|h[1-6]|blockquote|pre)\s*)>"#, with: "\n", options: .regularExpression)
        value = value.replacingOccurrences(of: #"<[^>]*>"#, with: "", options: .regularExpression)
        let entities = ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " ", "ensp": " ", "emsp": " ", "thinsp": " ", "ndash": "–", "mdash": "—", "lsquo": "‘", "rsquo": "’", "ldquo": "“", "rdquo": "”", "hellip": "…", "copy": "©", "reg": "®", "trade": "™", "bull": "•", "euro": "€", "pound": "£", "yen": "¥", "cent": "¢"]
        if let expression = try? NSRegularExpression(pattern: #"&(#(?:[xX][0-9a-fA-F]+|[0-9]+)|[A-Za-z]+);"#) {
            let result = NSMutableString(string: value)
            for match in expression.matches(in: value, range: NSRange(value.startIndex..., in: value)).reversed() {
                guard let range = Range(match.range(at: 1), in: value) else { continue }
                let entity = String(value[range])
                var replacement = entities[entity]
                if entity.hasPrefix("#") {
                    let hexadecimal = entity.dropFirst().lowercased().hasPrefix("x")
                    let digits = entity.dropFirst(hexadecimal ? 2 : 1)
                    if let number = UInt32(digits, radix: hexadecimal ? 16 : 10), let scalar = UnicodeScalar(number), number != 0 { replacement = String(scalar) }
                }
                if let replacement { result.replaceCharacters(in: match.range, with: replacement) }
            }
            value = result as String
        }
        return value.replacingOccurrences(of: #"[ \t]+\n"#, with: "\n", options: .regularExpression)
            .replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

public struct MailAIResult: Decodable, Sendable {
    public let text: String
    public let translation: MailTranslation?
}

public struct MailAIComposition: Decodable, Sendable {
    public let text: String
    public let model: String
}

extension MailClient {
    private func aiCall<Input: Encodable, Output: Decodable>(_ operation: String, input: Input) async throws -> Output {
        let data = try await pairing.mailRequest(operation: operation, body: JSONEncoder().encode(input))
        return try JSONDecoder().decode(Output.self, from: data)
    }

    public func aiStatus() async throws -> MailAIStatus {
        struct Input: Encodable {}
        if usesLegacyAI { return try await legacyAIStatus() }
        do { return try await aiCall("ai-status", input: Input()) }
        catch let PairingFailure.server(code) where code == "NOT_FOUND" {
            let status = try await legacyAIStatus()
            usesLegacyAI = true
            return status
        }
    }

    private func legacyAIStatus() async throws -> MailAIStatus {
        struct Overview: Decodable {
            struct Profile: Decodable { let id: String; let name: String; let model: String }
            let ready: Bool
            let activeId: String?
            let profiles: [Profile]
        }
        let overview = try JSONDecoder().decode(Overview.self, from: await pairing.webAIRequest(operation: .status))
        let active = overview.profiles.first { $0.id == overview.activeId }
        return MailAIStatus(ready: overview.ready, name: active?.name ?? "", model: active?.model ?? "")
    }
    private func legacyAI<Input: Encodable, Output: Decodable>(_ operation: PairingClient.WebAIOperation, input: Input) async throws -> Output {
        let data = try await pairing.webAIRequest(operation: operation, input: JSONEncoder().encode(input))
        return try JSONDecoder().decode(Output.self, from: data)
    }

    public func readWithAI(threadID: String, messageID: String, action: MailAIAction, language: String, question: String = "", history: [MailAITurn] = []) async throws -> MailAIResult {
        struct Input: Encodable {
            let threadId: String
            let messageId: String
            let action: MailAIAction
            let language: String
            let question: String
            let history: [MailAITurn]
        }
        let input = Input(threadId: threadID, messageId: messageID, action: action, language: language, question: question, history: history)
        if usesLegacyAI { return try await legacyAI(.read, input: input) }
        return try await aiCall("ai-read", input: input)
    }

    public func cachedTranslation(threadID: String, messageID: String) async throws -> MailTranslation? {
        struct Input: Encodable { let threadId: String; let messageId: String }
        struct Output: Decodable { let translation: MailTranslation? }
        if usesLegacyAI { return try await legacyAI(.translation, input: Input(threadId: threadID, messageId: messageID)) }
        let output: Output = try await aiCall("ai-translation", input: Input(threadId: threadID, messageId: messageID))
        return output.translation
    }

    /// Call only after the user requests generation. The result must be reviewed before applying.
    public func composeWithAI(instructions: String) async throws -> MailAIComposition {
        struct Input: Encodable { let instructions: String; let consent = true }
        if usesLegacyAI {
            struct LegacyInput: Encodable { let task = "compose"; let instructions: String; let consent = true }
            return try await legacyAI(.compose, input: LegacyInput(instructions: instructions))
        }
        return try await aiCall("ai-compose", input: Input(instructions: instructions))
    }
}
