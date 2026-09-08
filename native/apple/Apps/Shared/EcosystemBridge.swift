import Foundation
import WidgetKit
import ZeroMail

@MainActor
final class EcosystemBridge {
    static let shared = EcosystemBridge()
    private struct Claim { weak var owner: DraftRecoveryLeaseOwner? }
    private var claimed: [UUID: Claim] = [:]
    private let bindings = SharedDraftOriginBindings(directory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("ZeroMail/SharedDraftBindings", isDirectory: true))
    private var deferred: Set<UUID> = []
    private var lastSnapshot: MailWidgetSnapshot?
    private var lastReload = Date.distantPast
    func nextShare(server: URL) throws -> SharedMailDraft? {
        let pending = try AppGroupBridge.shared().pending()
        try bindings.retain(Set(pending.map(\.id)))
        claimed = claimed.filter { $0.value.owner != nil }
        return try pending.first {
            guard claimed[$0.id]?.owner == nil, !deferred.contains($0.id) else { return false }
            return try bindings.permits($0.id, server: server)
        }
    }
    func claim(_ id: UUID, server: URL, owner: DraftRecoveryLeaseOwner) -> Bool {
        if let current = claimed[id]?.owner {
            return current === owner && (try? bindings.permits(id, server: server)) == true
        }
        guard (try? bindings.bind(id, server: server)) == true else { return false }
        claimed[id] = Claim(owner: owner); return true
    }
    func release(_ id: UUID, owner: DraftRecoveryLeaseOwner) {
        if claimed[id]?.owner === owner { claimed.removeValue(forKey: id) }
    }
    func deferShare(_ id: UUID) { deferred.insert(id) }
    func acknowledge(_ id: UUID) {
        do { try AppGroupBridge.shared().acknowledge(id); try bindings.remove(id); claimed.removeValue(forKey: id) }
        catch { claimed.removeValue(forKey: id); deferred.insert(id) }
    }
    func publish(_ snapshot: MailWidgetSnapshot) {
        guard let bridge = try? AppGroupBridge.shared() else { return }
        do {
            try bridge.saveSnapshot(snapshot)
            let changed = lastSnapshot?.paired != snapshot.paired || lastSnapshot?.recentUnread != snapshot.recentUnread || lastSnapshot?.connectedAccounts != snapshot.connectedAccounts || lastSnapshot?.partial != snapshot.partial
            if changed || Date().timeIntervalSince(lastReload) >= 15 * 60 {
                WidgetCenter.shared.reloadAllTimelines(); lastReload = Date()
            }
            lastSnapshot = snapshot
        } catch { }
    }
    func clear(server: URL) {
        if let bridge = try? AppGroupBridge.shared() {
            if let ids = try? bindings.bound(to: server) {
                for id in ids {
                    do {
                        try bridge.acknowledge(id); try bindings.remove(id)
                        claimed.removeValue(forKey: id); deferred.remove(id)
                    } catch { deferred.insert(id) }
                }
            }
            try? bridge.saveSnapshot(.signedOut)
        }
        lastSnapshot = nil
        WidgetCenter.shared.reloadAllTimelines()
    }
}
