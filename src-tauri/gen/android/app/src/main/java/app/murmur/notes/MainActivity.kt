package app.murmur.notes

import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var appearanceMode = "system"
  private var appearanceSelected = false
  private var incomingBatchId: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    incomingBatchId = IncomingShares.receive(this, intent, savedInstanceState?.getString(IncomingShares.BATCH_STATE))
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val systemTypes = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      val types = systemTypes or WindowInsetsCompat.Type.ime()
      val safe = insets.getInsets(types)
      view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
      // Edge-to-edge WebViews do not reliably resize for adjustResize alone.
      // Reserve the largest overlapping inset (keyboard or system bar), then
      // consume it so the WebView cannot apply the same space a second time.
      WindowInsetsCompat.Builder(insets)
        .setInsets(types, Insets.NONE)
        .setInsetsIgnoringVisibility(systemTypes, Insets.NONE)
        .setDisplayCutout(null)
        .build()
    }
    ViewCompat.requestApplyInsets(content)
    updateSystemAppearance()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    incomingBatchId = IncomingShares.receive(this, intent)
  }

  override fun onSaveInstanceState(outState: Bundle) {
    incomingBatchId?.let { outState.putString(IncomingShares.BATCH_STATE, it) }
    super.onSaveInstanceState(outState)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    updateSystemAppearance()
  }

  fun applyAppearance(mode: String, initial: Boolean) {
    // SQLite loads asynchronously during startup. A late initial value must
    // never overwrite a theme the user has already selected in this process.
    if (initial && appearanceSelected) return
    if (!initial) appearanceSelected = true
    appearanceMode = mode
    updateSystemAppearance()
  }

  private fun updateSystemAppearance() {
    val dark = when (appearanceMode) {
      "dark" -> true
      "light" -> false
      else -> resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
    }
    val background = if (dark) Color.rgb(11, 16, 23) else Color.rgb(238, 243, 246)
    window.decorView.setBackgroundColor(background)
    findViewById<View>(android.R.id.content)?.setBackgroundColor(background)
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.isAppearanceLightStatusBars = !dark
    controller.isAppearanceLightNavigationBars = !dark
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      window.isNavigationBarContrastEnforced = false
    }
  }
}
