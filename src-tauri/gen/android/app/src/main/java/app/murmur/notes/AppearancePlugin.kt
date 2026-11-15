package app.murmur.notes

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class AppearanceArgs {
  var theme: String = ""
  var initial: Boolean = false
}

/** Receives the theme already persisted by Rust; stores no second preference. */
@TauriPlugin
class AppearancePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun apply(invoke: Invoke) {
    val args = invoke.parseArgs(AppearanceArgs::class.java)
    if (args.theme != "system" && args.theme != "light" && args.theme != "dark") {
      invoke.reject("Invalid appearance mode")
      return
    }
    activity.runOnUiThread {
      if (activity is MainActivity) {
        activity.applyAppearance(args.theme, args.initial)
        invoke.resolve()
      } else {
        invoke.reject("Murmur appearance is unavailable in this activity")
      }
    }
  }
}
