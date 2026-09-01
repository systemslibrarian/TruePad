package dev.systemslibrarian.truepad.app

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import dev.systemslibrarian.truepad.storage.Engine
import dev.systemslibrarian.truepad.storage.NioFs
import java.io.File
import java.io.IOException
import java.io.InputStream

/*
 * THE PLATFORM BINDING. Two directories, chosen deliberately, and a bounded
 * reader for files the operator picks.
 *
 * Everything else about storage — durability, ordering, reconciliation, what may
 * be consumed — is the engine's, and this file does not get a vote.
 */
object AndroidStorage {

    /** Pad stores: <filesDir>/truepad/<pairId>/{a-to-b,b-to-a}/… */
    const val STORE_DIR_NAME = "truepad"

    /** Rollback witness: <noBackupFilesDir>/truepad/witness/<pairId>.log */
    const val WITNESS_DIR_NAME = "truepad"

    /** Scratch for a file being handed out, never the live store. */
    const val EXPORT_CACHE_DIR_NAME = "export"

    fun storeRoot(context: Context): File = File(context.filesDir, STORE_DIR_NAME)

    /**
     * THE ROLLBACK-WITNESS DIRECTORY, and the reason it is a different one.
     *
     * A witness only detects a rollback if it lives in a different failure
     * domain from the thing being rolled back. `getNoBackupFilesDir()` is that
     * domain on Android: Auto Backup and device-to-device transfer carry
     * `getFilesDir()` and, by the platform's own contract, never this. So a pair
     * store that was restored from anywhere meets a witness that still remembers
     * the true high-water and the true attempt budget, and the engine refuses
     * `witness-regressed` before a single byte is consumed.
     *
     * TruePad additionally sets allowBackup="false" and excludes everything in
     * data_extraction_rules.xml, so in the shipping configuration nothing should
     * be restorable at all. This directory is the layer that still holds if that
     * one is ever wrong — a vendor backup path, a future platform change, a
     * developer restoring files by hand. Belt and braces, and the braces are the
     * ones with a test.
     *
     * Returning filesDir here would silently destroy rollback detection while
     * every other test still passed. See docs/ANDROID-SECURITY.md §4.
     */
    fun witnessRoot(context: Context): File = File(context.noBackupFilesDir, WITNESS_DIR_NAME)

    /** Build the engine over the two Android directories. One per process. */
    fun engineFor(context: Context): Engine =
        Engine(fs = NioFs(storeRoot(context)), witnessFs = NioFs(witnessRoot(context)))

    /* ---- incoming files: hostile until proven otherwise -------------------- */

    /**
     * The largest thing TruePad will read from a picked file.
     *
     * A picker URI is chosen by the operator but SERVED by whoever owns it,
     * which may be another application. It can lie about its size, stream
     * forever, or grow while being read, so the read is bounded by what is
     * actually consumed rather than by any length the provider reports. 64 MiB
     * is far beyond any legitimate pad bundle or source file and far below what
     * would trouble the heap.
     */
    const val MAX_PICKED_BYTES: Int = 64 * 1024 * 1024

    class PickedFileTooLarge(val limit: Int) :
        IOException("this file is larger than the ${limit / (1024 * 1024)} MB TruePad will read")

    /**
     * Read a picked document with a HARD ceiling.
     *
     * Nothing here trusts the provider: not the reported size, not the display
     * name, not the MIME type. The only thing that decides how much is read is
     * how much arrives, and one byte past the ceiling aborts.
     */
    @Throws(IOException::class)
    fun readPicked(resolver: ContentResolver, uri: Uri, limit: Int = MAX_PICKED_BYTES): ByteArray {
        // NOTE what is NOT here: no query() for OpenableColumns.SIZE, and no
        // use of any length the provider reports. The only thing that decides
        // how much is read is how much arrives.
        val stream: InputStream = resolver.openInputStream(uri)
            ?: throw IOException("this file could not be opened")
        return readBounded(stream, limit)
    }

    /**
     * The ceiling itself, over any stream.
     *
     * Separated from [readPicked] so it can be tested against a stream that
     * genuinely never ends — which is the case that matters and which a fixed
     * test file cannot produce. One byte past the ceiling aborts; a stream of
     * exactly the ceiling is accepted.
     */
    @Throws(IOException::class)
    fun readBounded(stream: InputStream, limit: Int = MAX_PICKED_BYTES): ByteArray {
        stream.use { input ->
            val out = java.io.ByteArrayOutputStream(minOf(limit, 1 shl 16))
            val buf = ByteArray(1 shl 16)
            var total = 0L
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                total += n
                // Strictly greater: a file of exactly `limit` bytes is allowed.
                if (total > limit) throw PickedFileTooLarge(limit)
                out.write(buf, 0, n)
            }
            return out.toByteArray()
        }
    }

    /**
     * A display name for a picked file, for the operator's own reference.
     *
     * ATTACKER-CONTROLLED. A provider can return any string: path separators,
     * traversal sequences, control characters, thousands of characters, or
     * nothing. It is never used to build a path, never used to decide anything,
     * and is sanitised before it is shown or recorded — it exists so the
     * operator can tell two sources apart in a list, and for no other purpose.
     */
    fun sanitiseDisplayName(raw: String?, fallback: String): String {
        if (raw.isNullOrBlank()) return fallback
        val cleaned = buildString {
            for (c in raw) {
                when {
                    // Path separators would let a name read as a location.
                    c == '/' || c == '\\' -> append('_')
                    // Control characters, including the NUL and the bidi
                    // overrides that can make a name render as something else.
                    c.isISOControl() -> append('_')
                    c == '\u202E' || c == '\u202D' || c == '\u200F' || c == '\u200E' -> append('_')
                    else -> append(c)
                }
            }
        }.trim().trim('.')
        if (cleaned.isEmpty()) return fallback
        return if (cleaned.length > 64) cleaned.take(64) + "…" else cleaned
    }

    /* ---- outgoing files ----------------------------------------------------- */

    /**
     * Write bytes to a document the operator created through the system picker.
     *
     * The operator chose the destination; TruePad never picks one, never writes
     * to shared storage on its own, and never hands another application a URI
     * that points into the live pad store. The bytes written here are a COPY
     * produced by the engine, not the store files themselves.
     */
    @Throws(IOException::class)
    fun writePicked(resolver: ContentResolver, uri: Uri, bytes: ByteArray) {
        // "wt" truncates: without it, writing a shorter document over a longer
        // one leaves the tail of the previous contents in place.
        resolver.openOutputStream(uri, "wt")?.use { out ->
            out.write(bytes)
            out.flush()
        } ?: throw IOException("this location could not be written")
    }

    /**
     * Best-effort removal of anything left in the export scratch directory.
     *
     * HYGIENE, NOT ERASURE. This unlinks files; it proves nothing about what the
     * flash translation layer kept, exactly as §17 says of destruction itself.
     */
    fun clearExportCache(context: Context) {
        val dir = File(context.cacheDir, EXPORT_CACHE_DIR_NAME)
        if (!dir.isDirectory) return
        dir.listFiles()?.forEach { runCatching { it.delete() } }
    }
}
