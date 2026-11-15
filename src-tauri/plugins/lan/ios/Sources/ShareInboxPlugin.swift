import Foundation
import Tauri

/// Separate native plugin sharing the existing iOS package only for linking.
final class ShareInboxPlugin: Plugin {
    @objc public func sourceDatabase(_ invoke: Invoke) {
        let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.app.murmur.notes")
        if let container {
            invoke.resolve(["path": container.appendingPathComponent("incoming-shares.sqlite3").path])
        } else {
            invoke.resolve(["path": NSNull()])
        }
    }
}

@_cdecl("init_plugin_share_inbox")
func initShareInboxPlugin() -> Plugin { ShareInboxPlugin() }
