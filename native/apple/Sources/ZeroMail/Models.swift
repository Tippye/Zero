import Foundation

public struct MailAccount: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let email: String
    public let name: String
    public let providerId: String
    public let connected: Bool
    public let warning: String?
}
public struct MailAddress: Codable, Sendable, Hashable {
    public var email: String
    public var name: String?
    public var display: String { name.flatMap { $0.isEmpty ? nil : $0 } ?? email }
    public init(email: String, name: String? = nil) { self.email = email; self.name = name }
}
public enum MailFolder: String, CaseIterable, Identifiable, Codable, Sendable {
    case inbox, starred, sent, draft, archive, spam, trash
    public var id: String { rawValue }
    public var title: String {
        switch self { case .inbox: return "收件箱"; case .starred: return "星标"; case .sent: return "已发送"; case .draft: return "草稿"; case .archive: return "归档"; case .spam: return "垃圾邮件"; case .trash: return "废纸篓" }
    }
    public var symbol: String {
        switch self { case .inbox: return "tray"; case .starred: return "star"; case .sent: return "paperplane"; case .draft: return "doc"; case .archive: return "archivebox"; case .spam: return "exclamationmark.shield"; case .trash: return "trash" }
    }
}
public enum MailCategory: String, CaseIterable, Identifiable, Codable, Sendable {
    case all, primary, transactions, updates, promotions
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .all: return "所有"
        case .primary: return "主要"
        case .transactions: return "交易"
        case .updates: return "更新"
        case .promotions: return "推广"
        }
    }
    public var symbol: String {
        switch self {
        case .all: return "tray.full"
        case .primary: return "tray"
        case .transactions: return "creditcard"
        case .updates: return "bell"
        case .promotions: return "tag"
        }
    }
}
public struct MailCategoryState: Decodable, Sendable {
    public let enabled: Bool
    public let category: MailCategory?
    public init(enabled: Bool, category: MailCategory?) {
        self.enabled = enabled; self.category = category
    }
}
public enum MailClassificationAction: String, Codable, Sendable { case start, pause, restart }
public struct MailClassificationSettings: Codable, Sendable, Equatable {
    public var concurrency: Int
    public var batchSize: Int
    public var intervalSeconds: Int
    public var timeoutSeconds: Int
    public var recentDays: Int
    public var historyEveryBatches: Int
    enum CodingKeys: String, CodingKey {
        case concurrency
        case batchSize = "batch_size"
        case intervalSeconds = "interval_seconds"
        case timeoutSeconds = "timeout_seconds"
        case recentDays = "recent_days"
        case historyEveryBatches = "history_every_batches"
    }
    public init(concurrency: Int, batchSize: Int, intervalSeconds: Int, timeoutSeconds: Int, recentDays: Int, historyEveryBatches: Int) {
        self.concurrency = concurrency; self.batchSize = batchSize
        self.intervalSeconds = intervalSeconds; self.timeoutSeconds = timeoutSeconds
        self.recentDays = recentDays; self.historyEveryBatches = historyEveryBatches
    }
}
public struct MailClassificationSettingsOverview: Decodable, Sendable {
    public let enabled: Bool
    public let defaults: MailClassificationSettings
    public let settings: MailClassificationSettings
    public init(enabled: Bool, defaults: MailClassificationSettings, settings: MailClassificationSettings) {
        self.enabled = enabled; self.defaults = defaults; self.settings = settings
    }
}
public struct MailClassificationAccountStatus: Decodable, Sendable, Identifiable {
    public var id: String { accountId }
    public let accountId: String
    public let email: String
    public let classificationTotal: Int
    public let classifiedCount: Int
    public let classificationError: String?
    public let classificationPaused: Bool
    public let classificationRunning: Bool
    public let classificationRetryAt: String?
}
public struct MailClassificationStatus: Decodable, Sendable {
    public let enabled: Bool
    public let classifierOnline: Bool
    public let accounts: [MailClassificationAccountStatus]
}
public struct MailSummary: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let accountId: String
    public let accountEmail: String
    public let subject: String
    public let sender: MailAddress
    public let receivedOn: String
    public let snippet: String
    public let unread: Bool
    public let starred: Bool
    public let isDraft: Bool
}
public struct MailWarning: Codable, Sendable {
    public let accountId: String
    public let email: String
    public let message: String
}
public struct MailPage: Codable, Sendable {
    public let threads: [MailSummary]
    public let cursor: String?
    public let warnings: [MailWarning]
}
public struct MailAttachment: Codable, Identifiable, Sendable {
    public var id: String { attachmentId }
    public let attachmentId: String
    public let filename: String
    public let mimeType: String
    public let size: Int
    public let body: String?
    public func decodedData() throws -> Data {
        guard let body, body.count <= 28 * 1024 * 1024 else { throw MailFailure.invalidAttachment }
        var base64 = body.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64), data.count == size else { throw MailFailure.invalidAttachment }
        return data
    }
    public var safeFilename: String {
        let name = filename.components(separatedBy: CharacterSet(charactersIn: "/\\:").union(.controlCharacters)).joined(separator: "_")
        return name.isEmpty || name == "." || name == ".." ? "attachment" : String(name.prefix(180))
    }
}
public struct MailMessage: Codable, Identifiable, Sendable {
    public let id: String
    public let sender: MailAddress
    public let to: [MailAddress]
    public let cc: [MailAddress]
    public let bcc: [MailAddress]
    public let subject: String
    public let receivedOn: String
    public let text: String
    public let html: String
    public let messageId: String?
    public let replyTo: String?
    public let references: String?
    public let isDraft: Bool
    public let attachments: [MailAttachment]
}
public struct MailThread: Codable, Identifiable, Sendable {
    public let id: String
    public let accountId: String?
    public let unread: Bool
    public let starred: Bool
    public let messages: [MailMessage]
}
public struct SavedDraft: Decodable, Sendable {
    public let id: String
    public let to: [String]?
    public let cc: [String]?
    public let bcc: [String]?
    public let subject: String?
    public let text: String
    public let attachments: [MailAttachment]?
    public let content: String?
}
public enum MailFailure: Error, LocalizedError, Equatable {
    case invalidRecipients, invalidAttachment, oversizedAttachments, sendRejected, invalidCategory
    public var errorDescription: String? {
        switch self {
        case .invalidRecipients: return "请输入有效的邮箱地址，多个地址用逗号分隔。"
        case .invalidAttachment: return "无法读取附件。"
        case .oversizedAttachments: return "附件总大小不能超过 15 MB，最多 20 个。"
        case .sendRejected: return "服务器未确认发送成功，请检查已发送文件夹。"
        case .invalidCategory: return "请选择具体的邮件分类。"
        }
    }
}
public struct OutgoingAttachment: Codable, Sendable, Identifiable, Equatable {
    public var id: String { name + ":" + String(size) + ":" + String(lastModified) }
    public let name: String
    public let type: String
    public let size: Int
    public let lastModified: Double
    public let base64: String
    public init(name: String, type: String, data: Data) throws {
        guard data.count <= 15 * 1024 * 1024 else { throw MailFailure.oversizedAttachments }
        self.name = name; self.type = type; self.size = data.count
        self.lastModified = Date().timeIntervalSince1970 * 1000; self.base64 = data.base64EncodedString()
    }
}
public struct OutgoingMail: Codable, Sendable {
    public var accountId: String
    public var to: [MailAddress]
    public var cc: [MailAddress]
    public var bcc: [MailAddress]
    public var subject: String
    public var message: String
    public var attachments: [OutgoingAttachment]
    public var threadId: String?
    public var draftId: String?
    public var headers: [String: String]
    public var operationId: String
}

public struct MailComposer: Codable, Identifiable, Sendable, Equatable {
    public var id = UUID()
    public var accountId = ""
    public var to = ""
    public var cc = ""
    public var bcc = ""
    public var subject = ""
    public var text = ""
    public var originalHTML: String?
    public var originalText: String?
    public var attachments: [OutgoingAttachment] = []
    public var threadId: String?
    public var draftId: String?
    public var sharedImportID: UUID?
    public var deliveryUncertain: Bool?
    public var headers: [String: String] = [:]
    public init(accountId: String = "") { self.accountId = accountId }
    public static func recipients(_ value: String) throws -> [MailAddress] {
        if value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return [] }
        return try value.split(separator: ",", omittingEmptySubsequences: false).map {
            let email = $0.trimmingCharacters(in: .whitespacesAndNewlines)
            guard email.range(of: #"^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$"#, options: .regularExpression) != nil else { throw MailFailure.invalidRecipients }
            return MailAddress(email: email)
        }
    }
    public func outgoing() throws -> OutgoingMail {
        guard attachments.count <= 20, attachments.reduce(0, { $0 + $1.size }) <= 15 * 1024 * 1024 else { throw MailFailure.oversizedAttachments }
        let escaped = text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\n", with: "<br>")
        let html = text == originalText ? (originalHTML ?? "<div>" + escaped + "</div>") : "<div>" + escaped + "</div>"
        return try OutgoingMail(accountId: accountId, to: Self.recipients(to), cc: Self.recipients(cc), bcc: Self.recipients(bcc), subject: subject, message: html, attachments: attachments, threadId: threadId, draftId: draftId, headers: headers, operationId: id.uuidString)
    }
    public static func reply(to message: MailMessage, threadID: String, account: MailAccount, all: Bool = false) -> MailComposer {
        var result = MailComposer(accountId: account.id)
        // Reply-To may contain a display name. Only accept a single mailbox here.
        let reply = message.replyTo ?? message.sender.email
        let extracted = reply.range(of: #"<([^<>]+)>"#, options: .regularExpression).map { String(reply[$0].dropFirst().dropLast()) } ?? reply
        let ownEmail = account.email.lowercased()
        if message.sender.email.lowercased() == ownEmail {
            // Replying to a sent message continues with its original recipients, never ourselves.
            var seen = Set([ownEmail])
            let originalTo = message.to.filter { seen.insert($0.email.lowercased()).inserted }
            result.to = (all ? originalTo : Array(originalTo.prefix(1))).map(\.email).joined(separator: ", ")
            if all { result.cc = message.cc.filter { seen.insert($0.email.lowercased()).inserted }.map(\.email).joined(separator: ", ") }
        } else {
            let parsed = try? recipients(extracted)
            let target = parsed?.count == 1 ? (parsed?.first?.email ?? message.sender.email) : message.sender.email
            result.to = target.lowercased() == ownEmail ? message.sender.email : target
            if all {
                var seen = Set([ownEmail, result.to.lowercased()])
                result.cc = (message.to + message.cc).filter { seen.insert($0.email.lowercased()).inserted }.map(\.email).joined(separator: ", ")
            }
        }
        result.subject = message.subject.lowercased().hasPrefix("re:") ? message.subject : "Re: " + message.subject
        result.threadId = threadID
        if let messageID = message.messageId {
            result.headers["In-Reply-To"] = messageID
            result.headers["References"] = [message.references, messageID].compactMap { $0 }.joined(separator: " ")
        }
        result.text = "\n\n" + message.sender.display + "：\n" + message.text.split(separator: "\n", omittingEmptySubsequences: false).map { "> " + $0 }.joined(separator: "\n")
        return result
    }
}
