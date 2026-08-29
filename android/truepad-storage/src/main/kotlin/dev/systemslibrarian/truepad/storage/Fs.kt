package dev.systemslibrarian.truepad.storage

import java.io.File
import java.io.RandomAccessFile
import java.nio.channels.FileChannel
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock

/*
 * The durable-file operations the frozen v2 store state machine is defined over
 * (§1, §12) — the Kotlin twin of src/browser/engine/vfs.ts's Vfs. Paths are
 * relative POSIX strings ("<pairId>/a-to-b/head.json"); the store never escapes
 * its pair directory. Synchronous (Kotlin/JVM), unlike the async browser Vfs.
 *
 * "durable" here is the Android sense of docs/ANDROID-SECURITY.md §storage: the
 * bytes reached the app-private filesystem and were fsync'd; a process death
 * after fsync is survived. It is NOT the CLI's Linux-ext4 power-loss claim.
 */
interface Fs {
    /** Whole file, or null if absent. */
    fun readFile(path: String): ByteArray?

    /**
     * Replace a file's whole contents durably. Atomic where the backing offers
     * it (temp file + fsync + ATOMIC_MOVE + parent-dir fsync); a torn write of
     * the target leaves a partial file every reader in this engine refuses
     * CLOSED (corrupt-head / corrupt-secret-body / corrupt-journal), never a
     * silently-accepted mix. The rollback witness does NOT depend on this — it
     * is an append-only journal (Witness.kt).
     */
    fun writeFileAtomic(path: String, data: ByteArray)

    /** Append to a file (creating it if absent) and fsync. The journal's write shape. */
    fun appendFile(path: String, data: ByteArray)

    /** Positioned read of `length` bytes from `offset` (secret.bin reads, §1.2). */
    fun readRange(path: String, offset: Long, length: Int): ByteArray

    fun exists(path: String): Boolean

    /** Remove a file or directory tree. Idempotent. */
    fun remove(path: String)

    /** Overwrite `length` bytes at `offset` and fsync — the destruction zero-overwrite. */
    fun writeRange(path: String, offset: Long, data: ByteArray)

    /** Size in bytes, or null if absent. */
    fun size(path: String): Long?

    /** Direct children (one level) under a prefix directory, names only. */
    fun list(prefix: String): List<String>

    /** Run `fn` holding an exclusive lock named `scope` — real mutual exclusion. */
    fun <T> withLock(scope: String, fn: () -> T): T
}

/* ---- in-process lock table shared by both backings -------------------------- */

private object LockTable {
    private val locks = ConcurrentHashMap<String, ReentrantLock>()
    fun lockFor(scope: String): ReentrantLock = locks.computeIfAbsent(scope) { ReentrantLock() }
}

/* ---- MemoryFs: fast in-memory backing for fault-injection tests ------------- */

class MemoryFs : Fs {
    private val files = ConcurrentHashMap<String, ByteArray>()

    override fun readFile(path: String): ByteArray? = files[path]?.copyOf()

    override fun writeFileAtomic(path: String, data: ByteArray) {
        files[path] = data.copyOf()
    }

    override fun appendFile(path: String, data: ByteArray) {
        val prev = files[path] ?: ByteArray(0)
        val next = ByteArray(prev.size + data.size)
        System.arraycopy(prev, 0, next, 0, prev.size)
        System.arraycopy(data, 0, next, prev.size, data.size)
        files[path] = next
    }

    override fun readRange(path: String, offset: Long, length: Int): ByteArray {
        val f = files[path] ?: throw IllegalStateException("readRange: no such file $path")
        val off = offset.toInt()
        if (offset < 0 || off + length > f.size) {
            throw IllegalStateException("readRange: [$offset, ${offset + length}) out of range for $path (${f.size} bytes)")
        }
        return f.copyOfRange(off, off + length)
    }

    override fun writeRange(path: String, offset: Long, data: ByteArray) {
        val f = files[path] ?: throw IllegalStateException("writeRange: no such file $path")
        val off = offset.toInt()
        if (offset < 0 || off + data.size > f.size) {
            throw IllegalStateException("writeRange: [$offset, ${offset + data.size}) out of range for $path")
        }
        System.arraycopy(data, 0, f, off, data.size)
    }

    override fun exists(path: String): Boolean = files.containsKey(path)

    override fun remove(path: String) {
        // Remove the exact key AND any children under "path/".
        files.remove(path)
        val prefix = "$path/"
        files.keys.filter { it.startsWith(prefix) }.forEach { files.remove(it) }
    }

    override fun size(path: String): Long? = files[path]?.size?.toLong()

    override fun list(prefix: String): List<String> {
        val norm = if (prefix.isEmpty()) "" else prefix.trimEnd('/') + "/"
        val names = LinkedHashSet<String>()
        for (key in files.keys) {
            if (norm.isEmpty() || key.startsWith(norm)) {
                val rest = key.substring(norm.length)
                val first = rest.substringBefore('/')
                if (first.isNotEmpty()) names.add(first)
            }
        }
        return names.toList()
    }

    override fun <T> withLock(scope: String, fn: () -> T): T {
        val lock = LockTable.lockFor("mem:$scope")
        lock.lock()
        try {
            return fn()
        } finally {
            lock.unlock()
        }
    }
}

/* ---- NioFs: the durable product backing (java.nio; runs on Android/ART) ------ */

class NioFs(private val root: File) : Fs {
    init {
        root.mkdirs()
    }

    private fun full(path: String): File {
        var f = root
        for (part in path.split('/')) if (part.isNotEmpty()) f = File(f, part)
        return f
    }

    override fun readFile(path: String): ByteArray? {
        val f = full(path)
        return if (f.isFile) f.readBytes() else null
    }

    override fun writeFileAtomic(path: String, data: ByteArray) {
        val target = full(path)
        val dir = target.parentFile ?: throw IllegalStateException("no parent for $path")
        dir.mkdirs()
        val tmp = File(dir, "${target.name}.writing")
        RandomAccessFile(tmp, "rw").use { raf ->
            raf.setLength(0)
            raf.write(data)
            raf.fd.sync() // fsync the temp's contents before publishing
        }
        try {
            Files.move(
                tmp.toPath(), target.toPath(),
                StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (_: AtomicMoveNotSupportedException) {
            // Backing cannot rename atomically: a durable replace that still
            // fails closed on a torn write (documented in ANDROID-SECURITY.md).
            Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
        fsyncDir(dir)
    }

    override fun appendFile(path: String, data: ByteArray) {
        val target = full(path)
        target.parentFile?.mkdirs()
        RandomAccessFile(target, "rw").use { raf ->
            raf.seek(raf.length())
            raf.write(data)
            raf.fd.sync()
        }
    }

    override fun readRange(path: String, offset: Long, length: Int): ByteArray {
        val target = full(path)
        RandomAccessFile(target, "r").use { raf ->
            if (offset < 0 || offset + length > raf.length()) {
                throw IllegalStateException("readRange: [$offset, ${offset + length}) out of range for $path (${raf.length()} bytes)")
            }
            val buf = ByteArray(length)
            raf.seek(offset)
            raf.readFully(buf)
            return buf
        }
    }

    override fun writeRange(path: String, offset: Long, data: ByteArray) {
        val target = full(path)
        RandomAccessFile(target, "rw").use { raf ->
            if (offset < 0 || offset + data.size > raf.length()) {
                throw IllegalStateException("writeRange: [$offset, ${offset + data.size}) out of range for $path")
            }
            raf.seek(offset)
            raf.write(data)
            raf.fd.sync()
        }
    }

    override fun exists(path: String): Boolean = full(path).exists()

    override fun remove(path: String) {
        full(path).deleteRecursively()
    }

    override fun size(path: String): Long? {
        val f = full(path)
        return if (f.exists()) f.length() else null
    }

    override fun list(prefix: String): List<String> {
        val dir = if (prefix.isEmpty()) root else full(prefix)
        return dir.listFiles()?.map { it.name } ?: emptyList()
    }

    override fun <T> withLock(scope: String, fn: () -> T): T {
        // In-process mutual exclusion for app threads, PLUS a real OS file lock
        // for the process/filesystem boundary (§single-writer). Never a UI flag.
        val inProc = LockTable.lockFor("nio:${root.absolutePath}:$scope")
        inProc.lock()
        try {
            val lockDir = File(root, ".locks").apply { mkdirs() }
            val lockFile = File(lockDir, "$scope.lock")
            FileChannel.open(
                lockFile.toPath(),
                StandardOpenOption.CREATE, StandardOpenOption.WRITE,
            ).use { ch ->
                val fileLock = ch.lock() // blocks until the exclusive OS lock is held
                try {
                    return fn()
                } finally {
                    fileLock.release()
                }
            }
        } finally {
            inProc.unlock()
        }
    }

    private fun fsyncDir(dir: File) {
        // Best-effort directory-metadata fsync so a rename is durable. Supported
        // on Android/Linux; on some backings (e.g. macOS dev host) opening a
        // directory channel for force() may be unsupported — swallowed, and
        // ANDROID-SECURITY.md states the limitation rather than faking it.
        try {
            FileChannel.open(dir.toPath(), StandardOpenOption.READ).use { it.force(true) }
        } catch (_: Exception) {
            /* best-effort */
        }
    }
}
