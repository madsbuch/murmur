package app.murmur.notes

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.widget.Toast
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** OS-granted files are staged durably before Rust selects a destination network. */
object IncomingShares {
  const val BATCH_STATE = "app.murmur.notes.incomingBatch"
  private const val MAX_ITEM_BYTES = 25 * 1024 * 1024
  private const val MAX_QUEUE_BYTES = 100L * 1024 * 1024
  private const val MAX_ITEMS = 32
  private const val DATABASE_NAME = "incoming-native.sqlite3"
  private val executor = ThreadPoolExecutor(
    1, 1, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(32)
  )
  private val main = Handler(Looper.getMainLooper())
  private val mimePattern = Regex("[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+")

  /** Recreated activities reuse this identity, including after process death. */
  fun receive(context: Context, intent: Intent?, restoredBatch: String? = null): String? {
    if (intent == null || (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE)) {
      return null
    }
    val app = context.applicationContext
    try {
      val batch = validUuid(restoredBatch) ?: validUuid(intent.getStringExtra(BATCH_STATE))
        ?: UUID.randomUUID().toString()
      intent.putExtra(BATCH_STATE, batch)
      val uris = streamUris(intent)
      if (uris.isEmpty()) return batch // Text-only shares are not files.
      if (intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION == 0) {
        show(app, "The sending app did not grant access to these files. Please share them again.")
        return batch
      }
      if (uris.size > MAX_ITEMS) {
        show(app, "Share at most 32 files at a time.")
        return batch
      }
      val mime = intent.type
      submit(app) {
        var received = 0
        var failure: String? = null
        for ((index, uri) in uris.withIndex()) {
          try {
            val id = UUID.nameUUIDFromBytes("$batch:$index".toByteArray(Charsets.UTF_8)).toString()
            if (store(app, id, uri, mime)) received += 1
          } catch (error: ShareFailure) {
            failure = error.message
          } catch (_: Exception) {
            failure = "A shared file could not be received. Please share it again from its source app."
          }
        }
        when {
          failure != null -> show(app, failure)
          received > 0 -> show(app, if (received == 1) "Received a shared file." else "Received $received shared files.")
        }
      }
      return batch
    } catch (_: Exception) {
      show(app, "These shared files could not be received. Please try again.")
      return null
    }
  }

  /** Uses the ingestion executor so cold-launch files are ready before this resolves. */
  fun inboxPath(context: Context, result: (String?, String?) -> Unit) {
    val app = context.applicationContext
    try {
      executor.execute {
        try {
          openDatabase(app).use { }
          result(File(app.filesDir, DATABASE_NAME).absolutePath, null)
        } catch (_: Exception) {
          result(null, "The incoming-file inbox could not be opened.")
        }
      }
    } catch (_: RejectedExecutionException) {
      result(null, "The incoming-file inbox is busy. Try again shortly.")
    }
  }

  private fun submit(context: Context, work: () -> Unit) {
    try {
      executor.execute(work)
    } catch (_: RejectedExecutionException) {
      show(context, "Too many files are arriving. Please try sharing again shortly.")
    }
  }

  private fun validUuid(value: String?): String? = try {
    value?.takeIf { it.length == 36 && UUID.fromString(it).toString() == it }
  } catch (_: IllegalArgumentException) {
    null
  }

  @Suppress("DEPRECATION")
  private fun streamUris(intent: Intent): List<Uri> {
    val streams: List<Uri> = if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      if (Build.VERSION.SDK_INT >= 33) {
        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
      } else {
        intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
      }
    } else {
      val stream = if (Build.VERSION.SDK_INT >= 33) {
        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
      }
      listOfNotNull(stream)
    }
    if (streams.isNotEmpty()) return streams.take(MAX_ITEMS + 1)
    val clip = intent.clipData ?: return emptyList()
    return (0 until minOf(clip.itemCount, MAX_ITEMS + 1)).mapNotNull { clip.getItemAt(it).uri }
  }

  private fun openDatabase(context: Context): SQLiteDatabase {
    val file = File(context.filesDir, DATABASE_NAME)
    val database = SQLiteDatabase.openDatabase(
      file.absolutePath, null,
      SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY or SQLiteDatabase.NO_LOCALIZED_COLLATORS
    )
    try {
      database.rawQuery("PRAGMA busy_timeout = 5000", null).use { it.moveToFirst() }
      database.rawQuery("PRAGMA journal_mode = DELETE", null).use { it.moveToFirst() }
      // This is set before the first table is created. Freed BLOB pages are
      // reclaimed at each commit instead of growing an empty inbox indefinitely.
      database.execSQL("PRAGMA auto_vacuum = FULL")
      database.setMaximumSize(110L * 1024 * 1024)
      database.execSQL("""
        CREATE TABLE IF NOT EXISTS incoming_shares (
          id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 36),
          name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 255),
          mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 3 AND 127),
          content BLOB NOT NULL CHECK(typeof(content) = 'blob' AND length(content) <= $MAX_ITEM_BYTES),
          created_at INTEGER NOT NULL CHECK(created_at >= 0)
        )
      """.trimIndent())
      return database
    } catch (error: Exception) {
      database.close()
      throw error
    }
  }

  private fun store(context: Context, id: String, uri: Uri, fallbackMime: String?): Boolean {
    if (uri.scheme != "content" || uri.toString().length > 8192 || uri.authority == "${context.packageName}.fileprovider") {
      throw ShareFailure("Only files shared with permission by another app can be received.")
    }
    openDatabase(context).use { database ->
      if (contains(database, id)) return false
      val info = metadata(context, uri, fallbackMime)
      if (info.size != null && info.size > MAX_ITEM_BYTES) {
        throw ShareFailure("Shared files must be no larger than 25 MiB.")
      }
      // Read only while the OS-granted URI is available. Never retain the URI as
      // a substitute for the file or request broad storage permissions.
      val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val count = input.read(buffer, 0, minOf(buffer.size, MAX_ITEM_BYTES - output.size() + 1))
          if (count < 0) break
          if (count == 0) throw ShareFailure("The shared file stopped responding. Please share it again.")
          if (count > MAX_ITEM_BYTES - output.size()) {
            throw ShareFailure("Shared files must be no larger than 25 MiB.")
          }
          output.write(buffer, 0, count)
        }
        output.toByteArray()
      } ?: throw ShareFailure("The shared file could not be opened. Please share it again.")
      database.beginTransaction()
      try {
        if (contains(database, id)) return false
        database.rawQuery("SELECT count(*), coalesce(sum(length(content)), 0) FROM incoming_shares", null).use { cursor ->
          if (!cursor.moveToFirst() || cursor.getLong(0) >= MAX_ITEMS || cursor.getLong(1) + bytes.size > MAX_QUEUE_BYTES) {
            throw ShareFailure("The incoming inbox is full. Add or discard waiting files, then share again.")
          }
        }
        val values = ContentValues().apply {
          put("id", id)
          put("name", info.name)
          put("mime_type", info.mime)
          put("content", bytes)
          put("created_at", System.currentTimeMillis().coerceAtLeast(0L))
        }
        database.insertOrThrow("incoming_shares", null, values)
        database.setTransactionSuccessful()
      } finally {
        database.endTransaction()
      }
    }
    return true
  }

  private fun contains(database: SQLiteDatabase, id: String): Boolean =
    database.rawQuery("SELECT 1 FROM incoming_shares WHERE id = ?", arrayOf(id)).use { it.moveToFirst() }

  private data class FileInfo(val name: String, val mime: String, val size: Long?)

  private fun metadata(context: Context, uri: Uri, fallbackMime: String?): FileInfo {
    var displayName: String? = null
    var size: Long? = null
    try {
      context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
          val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
          if (nameColumn >= 0 && !cursor.isNull(nameColumn)) displayName = cursor.getString(nameColumn)
          if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) size = cursor.getLong(sizeColumn).takeIf { it >= 0 }
        }
      }
    } catch (_: Exception) {
      // Some providers expose streams without OpenableColumns metadata. The
      // bounded stream read remains authoritative for access and size.
    }
    val basename = displayName.orEmpty().replace('\\', '/').substringAfterLast('/')
      .filterNot { it.isISOControl() }.trim().take(255).trimEnd { it.isHighSurrogate() }
    val name = basename.takeUnless { it.isBlank() || it == "." || it == ".." } ?: "Shared file"
    val providerMime = try { context.contentResolver.getType(uri) } catch (_: Exception) { null }
    val reportedMime = (providerMime ?: fallbackMime).orEmpty().lowercase(Locale.ROOT)
    val mime = reportedMime.takeIf { it.length <= 127 && mimePattern.matches(it) } ?: "application/octet-stream"
    return FileInfo(name, mime, size)
  }

  private class ShareFailure(message: String) : Exception(message)

  private fun show(context: Context, message: String) {
    main.post { Toast.makeText(context, message, Toast.LENGTH_LONG).show() }
  }
}
