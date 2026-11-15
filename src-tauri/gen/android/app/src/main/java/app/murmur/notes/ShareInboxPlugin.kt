package app.murmur.notes

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

@InvokeArg
class ClipboardImageArgs {
  var dataBase64: String = ""
}

@TauriPlugin
class ShareInboxPlugin(private val activity: Activity) : Plugin(activity) {
  private val clipboardWorker = ThreadPoolExecutor(
    1, 1, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(4)
  )
  @Volatile private var currentClipboardFile: File? = null

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

  /** Clipboard access happens only after the user chooses Paste image. */
  @Command
  fun readClipboardImage(invoke: Invoke) {
    activity.runOnUiThread {
      try {
        val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = clipboard.primaryClip ?: throw ClipboardFailure("Copy an image first, then try Paste image.")
        val candidates = (0 until minOf(clip.itemCount, 32)).mapNotNull { clip.getItemAt(it).uri }
          .filter { it.scheme == "content" && it.toString().length <= 8192 }
        val describedAsImage = clip.description.hasMimeType("image/*")
        submitClipboard(invoke) {
          val resolver = activity.contentResolver
          val uri = candidates.firstOrNull { candidate ->
            val type = resolver.getType(candidate)
            type?.startsWith("image/") == true || (type == null && describedAsImage)
          } ?: throw ClipboardFailure("The clipboard does not contain an image. Copy an image and try again.")
          val bytes = readClipboardBytes(uri)
          val mime = validateImage(bytes, requirePng = false)
          val extension = when (mime) {
            "image/jpeg" -> "jpg"
            "image/webp" -> "webp"
            "image/gif" -> "gif"
            "image/heic", "image/heif" -> "heic"
            "image/bmp" -> "bmp"
            "image/avif" -> "avif"
            else -> "png"
          }
          invoke.resolve(JSObject()
            .put("name", "Clipboard image.$extension")
            .put("mimeType", mime)
            .put("dataBase64", Base64.encodeToString(bytes, Base64.NO_WRAP)))
        }
      } catch (error: Exception) {
        rejectClipboard(invoke, error)
      }
    }
  }

  @Command
  fun writeClipboardImage(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ClipboardImageArgs::class.java)
      if (args.dataBase64.length > MAX_BASE64_CHARS) throw ClipboardFailure("Clipboard images must be no larger than 25 MiB.")
      submitClipboard(invoke) {
        val bytes = try { Base64.decode(args.dataBase64, Base64.DEFAULT) }
          catch (_: IllegalArgumentException) { throw ClipboardFailure("The clipboard image is invalid.") }
        validateImage(bytes, requirePng = true)
        val directory = File(activity.cacheDir, "clipboard-images")
        if (!directory.isDirectory && !directory.mkdirs()) throw ClipboardFailure("The clipboard image could not be prepared.")
        refreshCurrentClipboardFile(directory)
        trimClipboardCache(directory)
        val file = File(directory, "${UUID.randomUUID()}.png")
        try {
          file.outputStream().use { it.write(bytes) }
          val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
          val published = CountDownLatch(1)
          activity.runOnUiThread {
            try {
              val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
              clipboard.setPrimaryClip(ClipData.newUri(activity.contentResolver, "Murmur image", uri))
              currentClipboardFile = file
              invoke.resolve()
            } catch (error: Exception) {
              file.delete()
              rejectClipboard(invoke, error)
            } finally { published.countDown() }
          }
          // Serialize publication as well as file creation: the next operation
          // must know which file the clipboard currently owns before pruning.
          published.await()
        } catch (error: Exception) {
          file.delete()
          throw error
        }
      }
    } catch (error: Exception) {
      rejectClipboard(invoke, error)
    }
  }

  private fun readClipboardBytes(uri: Uri): ByteArray =
    activity.contentResolver.openInputStream(uri)?.use { input ->
      val output = ByteArrayOutputStream()
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val count = input.read(buffer, 0, minOf(buffer.size, MAX_IMAGE_BYTES - output.size() + 1))
        if (count < 0) break
        if (count == 0) throw ClipboardFailure("The clipboard image could not be read. Copy it again and retry.")
        if (count > MAX_IMAGE_BYTES - output.size()) throw ClipboardFailure("Clipboard images must be no larger than 25 MiB.")
        output.write(buffer, 0, count)
      }
      output.toByteArray()
    } ?: throw ClipboardFailure("The clipboard image could not be opened. Copy it again and retry.")

  private fun validateImage(bytes: ByteArray, requirePng: Boolean): String {
    if (bytes.isEmpty() || bytes.size > MAX_IMAGE_BYTES) throw ClipboardFailure("Clipboard images must be no larger than 25 MiB.")
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val mime = bounds.outMimeType
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || mime == null || !mime.startsWith("image/") || (requirePng && mime != "image/png")) {
      throw ClipboardFailure("The clipboard image is invalid or uses an unsupported format.")
    }
    if (bounds.outWidth.toLong() * bounds.outHeight.toLong() > MAX_IMAGE_PIXELS) {
      throw ClipboardFailure("Clipboard images must contain no more than 40 million pixels.")
    }
    return mime
  }

  private fun trimClipboardCache(directory: File) {
    val active = currentClipboardFile
    var retained = 0
    for (file in directory.listFiles().orEmpty().filter { it.isFile && it.extension == "png" }.sortedByDescending { it.lastModified() }) {
      if (file == active) continue
      // The active file, two recent copies, and the new file total at most
      // four 25-MiB files. Never revoke the URI currently on the clipboard.
      if (retained < 2) retained++ else if (!file.delete()) {
        throw ClipboardFailure("The clipboard cache could not be cleared. Try again shortly.")
      }
    }
  }

  private fun refreshCurrentClipboardFile(directory: File) {
    val inspected = CountDownLatch(1)
    var failure: Exception? = null
    activity.runOnUiThread {
      try {
        val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = clipboard.primaryClip
        val uri = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).uri else null
        val name = uri?.lastPathSegment
        currentClipboardFile = if (uri?.scheme == "content" && uri.authority == "${activity.packageName}.fileprovider" &&
          uri.pathSegments.dropLast(1).lastOrNull() == "clipboard-images" && name != null &&
          Regex("[0-9a-f-]{36}\\.png").matches(name)) File(directory, name) else null
      } catch (error: Exception) { failure = error }
      finally { inspected.countDown() }
    }
    inspected.await()
    failure?.let { throw it }
  }

  private fun submitClipboard(invoke: Invoke, work: () -> Unit) {
    try {
      clipboardWorker.execute {
        try { work() } catch (error: Exception) { rejectClipboard(invoke, error) }
      }
    } catch (_: RejectedExecutionException) {
      invoke.reject("The clipboard is busy. Try again shortly.")
    }
  }

  private fun rejectClipboard(invoke: Invoke, error: Exception) {
    invoke.reject(if (error is ClipboardFailure) error.message ?: "The clipboard image is unavailable."
      else "The clipboard image could not be accessed. Copy it again and retry.")
  }

  private class ClipboardFailure(message: String) : Exception(message)

  companion object {
    private const val MAX_IMAGE_BYTES = 25 * 1024 * 1024
    private const val MAX_BASE64_CHARS = ((MAX_IMAGE_BYTES + 2) / 3) * 4
    private const val MAX_IMAGE_PIXELS = 40_000_000L
  }
}
