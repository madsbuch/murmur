package app.murmur.notes

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin
class ShareInboxPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun getInboxPath(invoke: Invoke) {
    IncomingShares.inboxPath(activity) { path, error ->
      if (path == null) {
        invoke.reject(error ?: "The incoming-file inbox is unavailable.")
      } else {
        invoke.resolve(JSObject().put("path", path))
      }
    }
  }
}
