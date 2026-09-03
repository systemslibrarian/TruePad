package dev.systemslibrarian.truepad.spt

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock

/* ============================================================================
 * The filesystem abstraction the SPT durable protocol runs over — the Kotlin
 * mirror of the browser engine's Vfs. Kept HERE (not a dependency on the OTP
 * storage module) so truepad-spt stays self-contained and the frozen OTP engine
 * is untouched (Decision 19). The app adapts its real filesystem to this.
 *
 * The protocol's whole safety rests on: writeFileAtomic being the only writer,
 * `exists` being reliable, and NOTHING ever rewriting a committed marker.
 * ========================================================================= */
interface SptVfs {
    /** The file's bytes, or null if it does not exist. */
    fun readFile(path: String): ByteArray?

    /** Create/replace a file with its complete contents. The one writer. */
    fun writeFileAtomic(path: String, data: ByteArray)

    fun exists(path: String): Boolean

    fun remove(path: String)

    /** Overwrite `data.size` bytes at `offset` in an existing file (best-effort
     *  key hygiene only; the terminal marker is the authority). */
    fun writeRange(path: String, offset: Long, data: ByteArray)

    fun size(path: String): Long?

    /** Direct children (one level) under a prefix directory, names only. */
    fun list(prefix: String): List<String>

    /** Run `fn` holding an exclusive lock named `scope`. */
    fun <T> withLock(scope: String, fn: () -> T): T
}

/** An in-memory SptVfs for tests — a byte-exact stand-in for the durable one.
 *  Paths are opaque keys; `list` returns the one-level child names under a prefix. */
class MemorySptVfs : SptVfs {
    private val files = ConcurrentHashMap<String, ByteArray>()
    private val locks = ConcurrentHashMap<String, ReentrantLock>()

    override fun readFile(path: String): ByteArray? = files[path]?.copyOf()

    override fun writeFileAtomic(path: String, data: ByteArray) {
        files[path] = data.copyOf()
    }

    override fun exists(path: String): Boolean = files.containsKey(path)

    override fun remove(path: String) {
        files.remove(path)
    }

    override fun writeRange(path: String, offset: Long, data: ByteArray) {
        val cur = files[path] ?: throw IllegalStateException("writeRange on missing file $path")
        val off = offset.toInt()
        require(off + data.size <= cur.size) { "writeRange out of bounds" }
        val next = cur.copyOf()
        System.arraycopy(data, 0, next, off, data.size)
        files[path] = next
    }

    override fun size(path: String): Long? = files[path]?.size?.toLong()

    override fun list(prefix: String): List<String> {
        val norm = if (prefix.endsWith("/")) prefix else "$prefix/"
        val names = LinkedHashSet<String>()
        for (key in files.keys) {
            if (!key.startsWith(norm)) continue
            val rest = key.substring(norm.length)
            val slash = rest.indexOf('/')
            names.add(if (slash < 0) rest else rest.substring(0, slash))
        }
        return names.toList()
    }

    override fun <T> withLock(scope: String, fn: () -> T): T {
        val lock = locks.computeIfAbsent(scope) { ReentrantLock() }
        lock.lock()
        try {
            return fn()
        } finally {
            lock.unlock()
        }
    }
}

/** The SPT layer's typed refusal — a reason code plus a human message, mirroring
 *  the storage engine's EngineRefused without depending on it. */
class SptRefused(val reason: String, message: String) : Exception(message)
