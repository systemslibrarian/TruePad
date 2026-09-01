package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.core.JsonArray
import dev.systemslibrarian.truepad.core.JsonBool
import dev.systemslibrarian.truepad.core.JsonNumber
import dev.systemslibrarian.truepad.core.JsonObject
import dev.systemslibrarian.truepad.core.JsonString
import dev.systemslibrarian.truepad.core.JsonValue
import dev.systemslibrarian.truepad.core.hexToBytes
import dev.systemslibrarian.truepad.core.parseJson
import dev.systemslibrarian.truepad.core.requiredSourceLength
import java.io.File
import java.time.Instant

/* Shared fixtures for the storage suite. */

object V {
    private val dir = File("../vectors")
    fun obj(name: String): JsonObject {
        val f = File(dir, name)
        check(f.isFile) { "missing vector file ${f.absolutePath}; regenerate with _gen/android-vectors.mjs" }
        return parseJson(f.readText()) as JsonObject
    }
}

fun JsonObject.arr(key: String): List<JsonValue> = (members.getValue(key) as JsonArray).items
fun JsonObject.obj(key: String): JsonObject = members.getValue(key) as JsonObject
fun JsonObject.str(key: String): String = (members.getValue(key) as JsonString).value
fun JsonObject.strOrNull(key: String): String? = (members[key] as? JsonString)?.value
fun JsonObject.long(key: String): Long = (members.getValue(key) as JsonNumber).raw.toLong()
fun JsonObject.int(key: String): Int = long(key).toInt()
fun JsonObject.bool(key: String): Boolean = (members.getValue(key) as JsonBool).value
fun JsonValue.asObj(): JsonObject = this as JsonObject
fun thex(s: String): ByteArray = hexToBytes(s) ?: error("bad hex: $s")

/** The generator's frozen instant, so Kotlin reproduces the released bytes. */
const val FIXED_NOW = "2026-09-01T00:00:00.000Z"
val FIXED_INSTANT: Instant = Instant.parse(FIXED_NOW)
const val FIXED_PAIR_ID = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"

/** The generator's source-material shape, reproduced exactly. */
fun genBytes(n: Int, seed: Int): ByteArray =
    ByteArray(n) { i -> ((seed + i * 31 + ((i.toLong() * i) % 251).toInt()) and 0xff).toByte() }

fun fixedEngine(fs: Fs, pairIdHex: String = FIXED_PAIR_ID, witnessFs: Fs = fs): Engine =
    Engine(fs, witnessFs, clock = { FIXED_INSTANT }, pairIdSource = { thex(pairIdHex) })

/** The two declared sources the released trace used, at the required length. */
fun traceSources(capacity: Long, capacityRecords: Long): List<SourceInput> {
    val need = requiredSourceLength(capacity, capacityRecords).toInt()
    return listOf(
        SourceInput("die-rolls.bin", "physical dice, declared by operator", genBytes(need, 11)),
        SourceInput("coin-flips.bin", "coin flips, declared by operator", genBytes(need, 137)),
    )
}

fun textAt(fs: Fs, path: String): String =
    String(fs.readFile(path) ?: error("missing $path"), Charsets.UTF_8)

fun headPath(pairId: String, d: Direction) = "${storeDir(pairId, d)}/$HEAD_FILE"
fun journalPath(pairId: String, d: Direction) = "${storeDir(pairId, d)}/$JOURNAL_FILE"
fun secretPath(pairId: String, d: Direction) = "${storeDir(pairId, d)}/$SECRET_FILE"

fun refusalOf(body: () -> Unit): EngineRefused = try {
    body()
    error("expected an EngineRefused, but the operation succeeded")
} catch (e: EngineRefused) {
    e
}

/* ---- fault injection --------------------------------------------------------
 * A crash is modelled as an exception thrown from the durable write ITSELF,
 * after or before it takes effect. Two modes matter:
 *
 *   BEFORE — the write never lands (a crash between deciding and writing)
 *   AFTER  — the write lands, then the process dies before the next step
 *
 * Both leave the store in a state the next load must reconcile safely. The rule
 * under test is always the same: whatever is lost, nothing may be REUSED.
 * ------------------------------------------------------------------------- */

class InjectedCrash(message: String) : RuntimeException(message)

enum class When { BEFORE, AFTER }

/**
 * Wraps an [Fs] and throws on the [ordinal]-th matching write, either before or
 * after letting it through. Matching is by (operation, path predicate).
 */
class FaultFs(
    private val inner: Fs,
    private val op: String, // "writeFileAtomic" | "appendFile" | "writeRange" | "remove"
    private val pathMatches: (String) -> Boolean,
    private val ordinal: Int = 1,
    private val timing: When = When.BEFORE,
) : Fs {
    var matched = 0
        private set
    var fired = false
        private set

    private fun <T> guard(kind: String, path: String, run: () -> T): T {
        if (kind != op || !pathMatches(path)) return run()
        matched += 1
        if (matched != ordinal) return run()
        fired = true
        if (timing == When.BEFORE) throw InjectedCrash("crash BEFORE $kind $path (#$ordinal)")
        val r = run()
        throw InjectedCrash("crash AFTER $kind $path (#$ordinal)")
    }

    override fun readFile(path: String) = inner.readFile(path)
    override fun writeFileAtomic(path: String, data: ByteArray) =
        guard("writeFileAtomic", path) { inner.writeFileAtomic(path, data) }
    override fun appendFile(path: String, data: ByteArray) =
        guard("appendFile", path) { inner.appendFile(path, data) }
    override fun readRange(path: String, offset: Long, length: Int) = inner.readRange(path, offset, length)
    override fun exists(path: String) = inner.exists(path)
    override fun remove(path: String) = guard("remove", path) { inner.remove(path) }
    override fun writeRange(path: String, offset: Long, data: ByteArray) =
        guard("writeRange", path) { inner.writeRange(path, offset, data) }
    override fun size(path: String) = inner.size(path)
    override fun list(prefix: String) = inner.list(prefix)
    override fun <T> withLock(scope: String, fn: () -> T): T = inner.withLock(scope, fn)
}

/** Records every path written, in order — for asserting the §12.4 write ORDER. */
class RecordingFs(private val inner: Fs) : Fs {
    val writes = ArrayList<String>()
    override fun readFile(path: String) = inner.readFile(path)
    override fun writeFileAtomic(path: String, data: ByteArray) {
        writes.add("write:$path"); inner.writeFileAtomic(path, data)
    }
    override fun appendFile(path: String, data: ByteArray) {
        writes.add("append:$path"); inner.appendFile(path, data)
    }
    override fun readRange(path: String, offset: Long, length: Int) = inner.readRange(path, offset, length)
    override fun exists(path: String) = inner.exists(path)
    override fun remove(path: String) { writes.add("remove:$path"); inner.remove(path) }
    override fun writeRange(path: String, offset: Long, data: ByteArray) {
        writes.add("range:$path"); inner.writeRange(path, offset, data)
    }
    override fun size(path: String) = inner.size(path)
    override fun list(prefix: String) = inner.list(prefix)
    override fun <T> withLock(scope: String, fn: () -> T): T = inner.withLock(scope, fn)
}

/** A snapshot of every file, for modelling a backup/restore rollback. */
fun snapshot(fs: MemoryFs, paths: List<String>): Map<String, ByteArray?> =
    paths.associateWith { fs.readFile(it) }

fun restore(fs: MemoryFs, snap: Map<String, ByteArray?>) {
    for ((path, bytes) in snap) {
        if (bytes == null) fs.remove(path) else fs.writeFileAtomic(path, bytes)
    }
}

fun allPaths(fs: MemoryFs, pairId: String): List<String> = buildList {
    for (d in Direction.entries) {
        add(headPath(pairId, d)); add(journalPath(pairId, d)); add(secretPath(pairId, d))
    }
    add(pairMetaPath(pairId))
    add(witnessLogPath(pairId))
}

/**
 * Flip one bit of an envelope's Wegman-Carter tag, leaving every other field —
 * and therefore the canonical authenticated bytes — untouched. This is the
 * minimal forgery: the record is well-formed and in-window, and only the tag is
 * wrong, so it exercises O4 rather than any earlier gate.
 */
fun tamperTag(envelope: String): String {
    val m = Regex("\"tag\":\"([0-9a-f]{32})\"").find(envelope) ?: error("no tag in $envelope")
    val tag = m.groupValues[1]
    val flipped = (if (tag[0] == '0') "1" else "0") + tag.substring(1)
    return envelope.replaceRange(m.range, "\"tag\":\"$flipped\"")
}

/** `Throwable.message` is nullable for Java's sake; an EngineRefused always has one. */
val EngineRefused.text: String get() = message ?: error("an EngineRefused with no message")
