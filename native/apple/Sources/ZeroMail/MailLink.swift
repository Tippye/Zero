import Foundation
import ZeroPairing

/// Handoff thread links contain routing data only. Compose links prefill a draft and never send it.
public enum MailLink: Equatable, Sendable {
    public static let activityType = "org.zero.mail.read"
    case inbox
    case thread(server: URL, id: String)
    case compose(to: String, cc: String = "", bcc: String = "", subject: String, text: String)
    public init?(url: URL) {
        guard url.absoluteString.utf8.count <= 32000,
              let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              c.user == nil, c.password == nil, c.fragment == nil else { return nil }
        let scheme = c.scheme?.lowercased(), host = c.host?.lowercased()
        let items = c.queryItems ?? []
        func value(_ name: String) -> String { items.first(where: { $0.name == name })?.value ?? "" }
        if scheme == "mailto" || (scheme == "zeromail" && host == "compose" && ["", "/"].contains(c.path)) {
            guard let recipient = c.percentEncodedPath.removingPercentEncoding else { return nil }
            var fields: [String: String] = ["to": scheme == "mailto" ? recipient : ""]
            let allowed = Set(["to", "cc", "bcc", "subject", "body"])
            // Match desktop links: decode once, preserve literal +, and combine path/query recipients.
            for part in (c.percentEncodedQuery ?? "").split(separator: "&") {
                let pair = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                guard let name = String(pair[0]).removingPercentEncoding?.lowercased() else { return nil }
                guard allowed.contains(name) else { continue }
                guard let value = (pair.count == 2 ? String(pair[1]) : "").removingPercentEncoding else { return nil }
                if name == "to", let current = fields[name], !current.isEmpty { fields[name] = current + "," + value }
                else { fields[name] = value }
            }
            guard fields.allSatisfy({ name, value in
                !value.contains("\0") && (name == "body" || value.rangeOfCharacter(from: CharacterSet(charactersIn: "\r\n")) == nil)
            }) else { return nil }
            self = .compose(to: fields["to"] ?? "", cc: fields["cc"] ?? "", bcc: fields["bcc"] ?? "", subject: fields["subject"] ?? "", text: fields["body"] ?? "")
        } else if scheme == "zeromail", host == "inbox", ["", "/"].contains(c.path), c.port == nil, c.query == nil {
            self = .inbox
        } else if scheme == "zeromail", host == "thread", ["", "/"].contains(c.path), c.port == nil,
                  let url = URL(string: value("server")),
                  let server = try? PairingClient.serverOrigin(url, allowHTTP: PairingClient.allowsDevelopmentHTTP(url)), !value("id").isEmpty {
            self = .thread(server: server, id: value("id"))
        } else { return nil }
    }
    public var url: URL {
        var c = URLComponents(); c.scheme = "zeromail"
        switch self {
        case .inbox: c.host = "inbox"
        case let .thread(server, id): c.host = "thread"; c.queryItems = [.init(name: "server", value: server.absoluteString), .init(name: "id", value: id)]
        case let .compose(to, cc, bcc, subject, text): c.host = "compose"; c.queryItems = [.init(name: "to", value: to), .init(name: "cc", value: cc), .init(name: "bcc", value: bcc), .init(name: "subject", value: subject), .init(name: "body", value: text)]
        }
        return c.url!
    }
}
