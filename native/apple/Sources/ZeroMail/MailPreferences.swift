import Foundation

/// Shared by app settings and iOS Settings.bundle. Values stay in the app's standard defaults domain.
public enum MailPreferenceKey {
    public static let previewLines = "zero.mail.previewLines"
    public static let markReadOnOpen = "zero.mail.markReadOnOpen"
    public static let confirmBeforeTrash = "zero.mail.confirmBeforeTrash"
    public static let showAccountAddress = "zero.mail.showAccountAddress"
    public static let notificationPreview = "zero.notifications.preview"
    public static let notificationSound = "zero.notifications.sound"
}

public struct MailPreferences: Equatable, Sendable {
    public let previewLines: Int
    public let markReadOnOpen: Bool
    public let confirmBeforeTrash: Bool
    public let showAccountAddress: Bool
    public let notificationPreview: Bool
    public let notificationSound: Bool

    private static var registration: [String: Any] {
        [MailPreferenceKey.previewLines: 2,
         MailPreferenceKey.markReadOnOpen: true,
         MailPreferenceKey.confirmBeforeTrash: false,
         MailPreferenceKey.showAccountAddress: true,
         MailPreferenceKey.notificationPreview: false,
         MailPreferenceKey.notificationSound: true]
    }

    /// Registration supplies missing values without writing or replacing the user's saved choices.
    public static func registerDefaults(in defaults: UserDefaults = .standard) {
        defaults.register(defaults: registration)
    }

    /// A snapshot also works before registration, including when opening the app for the first time.
    public init(defaults: UserDefaults = .standard) {
        previewLines = Self.lines(defaults.object(forKey: MailPreferenceKey.previewLines))
        markReadOnOpen = Self.boolean(defaults.object(forKey: MailPreferenceKey.markReadOnOpen), fallback: true)
        confirmBeforeTrash = Self.boolean(defaults.object(forKey: MailPreferenceKey.confirmBeforeTrash), fallback: false)
        showAccountAddress = Self.boolean(defaults.object(forKey: MailPreferenceKey.showAccountAddress), fallback: true)
        notificationPreview = Self.boolean(defaults.object(forKey: MailPreferenceKey.notificationPreview), fallback: false)
        notificationSound = Self.boolean(defaults.object(forKey: MailPreferenceKey.notificationSound), fallback: true)
    }

    private static func boolean(_ value: Any?, fallback: Bool) -> Bool {
        // NSArgumentDomain exposes standard launch overrides as strings on Apple platforms.
        if let string = value as? String {
            switch string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "yes", "true", "1": return true
            case "no", "false", "0": return false
            default: return fallback
            }
        }
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return fallback }
        return number.boolValue
    }

    private static func lines(_ value: Any?) -> Int {
        if let string = value as? String, let number = Int(string.trimmingCharacters(in: .whitespacesAndNewlines)) {
            return min(5, max(0, number))
        }
        guard let number = value as? NSNumber else { return 2 }
        // iOS Settings can persist the integer choices 0/1 as CFBoolean. Accept that
        // representation without rewriting the user's value or changing the integer schema.
        if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? 1 : 0 }
        guard ["c", "s", "i", "l", "q", "C", "S", "I", "L", "Q"].contains(String(cString: number.objCType)) else { return 2 }
        if number.compare(NSNumber(value: 0)) == .orderedAscending { return 0 }
        if number.compare(NSNumber(value: 5)) == .orderedDescending { return 5 }
        return number.intValue
    }
}
