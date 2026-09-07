import Foundation
import ZeroPairing

/// Handoff and deep links contain routing data only, never credentials or message bodies.
public enum MailLink: Equatable, Sendable {
    public static let activityType = "org.zero.mail.read"
    case thread(server: URL, id: String)
    case compose(to: String, subject: String, text: String)
    public init?(url: URL) {
        guard url.absoluteString.utf8.count < 32000, let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let items = c.queryItems ?? []
        func value(_ name: String) -> String { items.first(where: { $0.name == name })?.value ?? "" }
        if c.scheme == "mailto" {
            self = .compose(to: c.path, subject: value("subject"), text: value("body"))
        } else if c.scheme == "zeromail", c.host == "compose" {
            self = .compose(to: value("to"), subject: value("subject"), text: value("body"))
        } else if c.scheme == "zeromail", c.host == "thread", let url = URL(string: value("server")), let server = try? PairingClient.serverOrigin(url), !value("id").isEmpty {
            self = .thread(server: server, id: value("id"))
        } else { return nil }
    }
    public var url: URL {
        var c = URLComponents(); c.scheme = "zeromail"
        switch self {
        case let .thread(server, id): c.host = "thread"; c.queryItems = [.init(name: "server", value: server.absoluteString), .init(name: "id", value: id)]
        case let .compose(to, subject, text): c.host = "compose"; c.queryItems = [.init(name: "to", value: to), .init(name: "subject", value: subject), .init(name: "body", value: text)]
        }
        return c.url!
    }
}
