import Foundation
import XCTest
@testable import ZeroMail

final class MailPreferencesTests: XCTestCase {
    private func defaults() throws -> (UserDefaults, String) {
        let name = "zero.preferences.test." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defaults.removePersistentDomain(forName: name)
        addTeardownBlock { defaults.removePersistentDomain(forName: name) }
        return (defaults, name)
    }
    private var bundle: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Configuration/Settings.bundle", isDirectory: true)
    }
    private func dictionary(at url: URL) throws -> [String: Any] {
        try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: url), options: [], format: nil) as? [String: Any])
    }
    private func expectedValues(_ preferences: MailPreferences) -> [String: Any] {
        [MailPreferenceKey.previewLines: preferences.previewLines,
         MailPreferenceKey.markReadOnOpen: preferences.markReadOnOpen,
         MailPreferenceKey.confirmBeforeTrash: preferences.confirmBeforeTrash,
         MailPreferenceKey.showAccountAddress: preferences.showAccountAddress,
         MailPreferenceKey.notificationPreview: preferences.notificationPreview,
         MailPreferenceKey.notificationSound: preferences.notificationSound]
    }
    func testDefaultsWorkBeforeRegistrationAndDoNotPersistPreferences() throws {
        let (defaults, name) = try defaults(), preferences = MailPreferences(defaults: defaults)
        XCTAssertEqual(preferences.previewLines, 2)
        XCTAssertTrue(preferences.markReadOnOpen)
        XCTAssertFalse(preferences.confirmBeforeTrash)
        XCTAssertTrue(preferences.showAccountAddress)
        XCTAssertFalse(preferences.notificationPreview)
        XCTAssertTrue(preferences.notificationSound)
        XCTAssertTrue(defaults.persistentDomain(forName: name)?.isEmpty ?? true)
        MailPreferences.registerDefaults(in: defaults)
        XCTAssertEqual(MailPreferences(defaults: defaults), preferences)
        XCTAssertTrue(defaults.persistentDomain(forName: name)?.isEmpty ?? true, "Registration must not save defaults as user choices")
        for (key, value) in expectedValues(preferences) {
            XCTAssertEqual(defaults.object(forKey: key) as? NSObject, value as? NSObject, key)
        }
    }
    func testRegistrationPreservesExplicitFalseAndZeroPreview() throws {
        let (defaults, _) = try defaults()
        defaults.set(0, forKey: MailPreferenceKey.previewLines)
        for key in [MailPreferenceKey.markReadOnOpen, MailPreferenceKey.confirmBeforeTrash, MailPreferenceKey.showAccountAddress, MailPreferenceKey.notificationPreview, MailPreferenceKey.notificationSound] {
            defaults.set(false, forKey: key)
        }
        MailPreferences.registerDefaults(in: defaults)
        MailPreferences.registerDefaults(in: defaults)
        let preferences = MailPreferences(defaults: defaults)
        XCTAssertEqual(preferences.previewLines, 0)
        XCTAssertFalse(preferences.markReadOnOpen)
        XCTAssertFalse(preferences.confirmBeforeTrash)
        XCTAssertFalse(preferences.showAccountAddress)
        XCTAssertFalse(preferences.notificationPreview)
        XCTAssertFalse(preferences.notificationSound)
    }
    func testPersistedChoicesAndExistingNotificationKeyAreReadByAnotherInstance() throws {
        let (defaults, name) = try defaults()
        XCTAssertEqual(MailPreferenceKey.notificationPreview, "zero.notifications.preview")
        defaults.set(5, forKey: MailPreferenceKey.previewLines)
        defaults.set(false, forKey: MailPreferenceKey.markReadOnOpen)
        defaults.set(true, forKey: MailPreferenceKey.confirmBeforeTrash)
        defaults.set(false, forKey: MailPreferenceKey.showAccountAddress)
        defaults.set(true, forKey: "zero.notifications.preview")
        defaults.set(false, forKey: MailPreferenceKey.notificationSound)
        let reloaded = MailPreferences(defaults: try XCTUnwrap(UserDefaults(suiteName: name)))
        XCTAssertEqual(reloaded, MailPreferences(defaults: defaults))
        XCTAssertEqual(reloaded.previewLines, 5)
        XCTAssertFalse(reloaded.markReadOnOpen)
        XCTAssertTrue(reloaded.confirmBeforeTrash)
        XCTAssertFalse(reloaded.showAccountAddress)
        XCTAssertTrue(reloaded.notificationPreview)
        XCTAssertFalse(reloaded.notificationSound)
    }
    func testPreviewLinesClampIntegersAndRejectInvalidTypes() throws {
        let (defaults, _) = try defaults()
        for (value, expected) in [(Int.min, 0), (-1, 0), (0, 0), (3, 3), (5, 5), (6, 5), (Int.max, 5)] {
            defaults.set(value, forKey: MailPreferenceKey.previewLines)
            XCTAssertEqual(MailPreferences(defaults: defaults).previewLines, expected)
            XCTAssertEqual(defaults.object(forKey: MailPreferenceKey.previewLines) as? Int, value, "Reading must not replace stored choices")
        }
        for invalid: Any in ["three", "3.5", "1e2", 3.5, [3], ["value": 3], Data([3])] {
            defaults.set(invalid, forKey: MailPreferenceKey.previewLines)
            XCTAssertEqual(MailPreferences(defaults: defaults).previewLines, 2)
        }
    }
    func testSystemSettingsBooleanRepresentationPreservesZeroAndOnePreviewChoices() throws {
        let (defaults, name) = try defaults()
        MailPreferences.registerDefaults(in: defaults)
        for (stored, expected) in [(false, 0), (true, 1)] {
            // Observed after choosing “None” in the actual iOS Settings.bundle UI: the
            // app's persistent plist contains <false/>, although Values declares integer 0.
            let plist = try PropertyListSerialization.data(fromPropertyList: [MailPreferenceKey.previewLines: stored], format: .binary, options: 0)
            let domain = try XCTUnwrap(PropertyListSerialization.propertyList(from: plist, options: [], format: nil) as? [String: Any])
            defaults.setPersistentDomain(domain, forName: name)
            let another = try XCTUnwrap(UserDefaults(suiteName: name))
            MailPreferences.registerDefaults(in: another)
            XCTAssertEqual(MailPreferences(defaults: another).previewLines, expected)
            let unchanged = try XCTUnwrap(another.persistentDomain(forName: name)?[MailPreferenceKey.previewLines] as? NSNumber)
            XCTAssertEqual(CFGetTypeID(unchanged), CFBooleanGetTypeID(), "Reading must not rewrite the stored representation")
            XCTAssertEqual(unchanged.boolValue, stored)
        }
    }
    func testBooleanPreferencesRejectUnknownStringsAndNonBooleanNumbers() throws {
        let (defaults, _) = try defaults()
        for invalid: Any in ["not-a-bool", "2", "1.5", "enabled", 0, 1, 2, 0.5, [], ["value": true], Data([1])] {
            for key in [MailPreferenceKey.markReadOnOpen, MailPreferenceKey.confirmBeforeTrash, MailPreferenceKey.showAccountAddress, MailPreferenceKey.notificationPreview, MailPreferenceKey.notificationSound] {
                defaults.set(invalid, forKey: key)
            }
            let preferences = MailPreferences(defaults: defaults)
            XCTAssertTrue(preferences.markReadOnOpen)
            XCTAssertFalse(preferences.confirmBeforeTrash)
            XCTAssertTrue(preferences.showAccountAddress)
            XCTAssertFalse(preferences.notificationPreview)
            XCTAssertTrue(preferences.notificationSound)
        }
    }
    func testStandardArgumentDomainStringsOverrideRegisteredAndPersistentDefaults() throws {
        let (defaults, _) = try defaults()
        defaults.set(true, forKey: MailPreferenceKey.markReadOnOpen)
        MailPreferences.registerDefaults(in: defaults)
        let originalArguments = defaults.volatileDomain(forName: UserDefaults.argumentDomain)
        defaults.setVolatileDomain([
            MailPreferenceKey.previewLines: "4", MailPreferenceKey.markReadOnOpen: "NO",
            MailPreferenceKey.confirmBeforeTrash: "1", MailPreferenceKey.showAccountAddress: "false",
            MailPreferenceKey.notificationPreview: "YES", MailPreferenceKey.notificationSound: "0"
        ], forName: UserDefaults.argumentDomain)
        defer { defaults.setVolatileDomain(originalArguments, forName: UserDefaults.argumentDomain) }
        let preferences = MailPreferences(defaults: defaults)
        XCTAssertEqual(preferences.previewLines, 4)
        XCTAssertFalse(preferences.markReadOnOpen)
        XCTAssertTrue(preferences.confirmBeforeTrash)
        XCTAssertFalse(preferences.showAccountAddress)
        XCTAssertTrue(preferences.notificationPreview)
        XCTAssertFalse(preferences.notificationSound)
    }
    func testSettingsSchemaMatchesTheCoreContractAndUsesOnlyAppPreferences() throws {
        let root = try dictionary(at: bundle.appendingPathComponent("Root.plist"))
        XCTAssertEqual(Set(root.keys), ["PreferenceSpecifiers", "StringsTable"])
        XCTAssertEqual(root["StringsTable"] as? String, "Root")
        XCTAssertNil(root["ApplicationGroupContainerIdentifier"])
        let rows = try XCTUnwrap(root["PreferenceSpecifiers"] as? [[String: Any]])
        let controls = rows.filter { $0["Key"] != nil }
        let (defaults, _) = try defaults(), expected = expectedValues(MailPreferences(defaults: defaults))
        XCTAssertEqual(controls.count, expected.count)
        XCTAssertEqual(Set(controls.compactMap { $0["Key"] as? String }), Set(expected.keys))
        for row in rows {
            let type = try XCTUnwrap(row["Type"] as? String)
            XCTAssertTrue(["PSGroupSpecifier", "PSMultiValueSpecifier", "PSToggleSwitchSpecifier"].contains(type))
            guard let key = row["Key"] as? String else { XCTAssertEqual(type, "PSGroupSpecifier"); continue }
            XCTAssertEqual(row["DefaultValue"] as? NSObject, expected[key] as? NSObject, key)
            if key == MailPreferenceKey.previewLines {
                XCTAssertEqual(type, "PSMultiValueSpecifier")
                XCTAssertEqual(row["Values"] as? [Int], Array(0...5))
                XCTAssertEqual((row["Titles"] as? [String])?.count, 6)
            } else {
                XCTAssertEqual(type, "PSToggleSwitchSpecifier")
                let number = try XCTUnwrap(row["DefaultValue"] as? NSNumber)
                XCTAssertEqual(CFGetTypeID(number), CFBooleanGetTypeID())
                XCTAssertNil(row["TrueValue"]); XCTAssertNil(row["FalseValue"])
            }
        }
    }
    func testSettingsLocalizationsCoverEveryLabelAndFooter() throws {
        let root = try dictionary(at: bundle.appendingPathComponent("Root.plist"))
        let rows = try XCTUnwrap(root["PreferenceSpecifiers"] as? [[String: Any]])
        let labels = Set(rows.flatMap { row in
            ([row["Title"] as? String, row["FooterText"] as? String].compactMap { $0 }) + (row["Titles"] as? [String] ?? [])
        })
        for language in ["en", "zh-Hans"] {
            let strings = try dictionary(at: bundle.appendingPathComponent(language + ".lproj/Root.strings"))
            XCTAssertEqual(Set(strings.keys), labels)
            for label in labels { XCTAssertFalse((strings[label] as? String)?.isEmpty ?? true, label) }
            XCTAssertEqual(strings["PREVIEW_LINES"] as? String, language == "en" ? "Preview" : "预览")
            XCTAssertEqual(strings["PREVIEW_NONE"] as? String, language == "en" ? "None" : "无")
        }
    }
}
