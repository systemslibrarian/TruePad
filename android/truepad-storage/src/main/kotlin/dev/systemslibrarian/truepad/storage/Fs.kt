package dev.systemslibrarian.truepad.storage

import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.channels.FileChannel
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.PosixFilePermissions
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
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

    /**
     * Is this path NOT KNOWN TO BE ABSENT?
     *
     * This is deliberately not "is there a readable regular file here". It gates
     * the §17 tombstone, and a terminal marker must fail CLOSED: anything present
     * at the path — a regular file, a directory, a symlink whose target is gone —
     * and any inability to decide must all read as present. Only a definitive
     * "nothing is here" may return false.
     */
    fun exists(path: String): Boolean

    /** Remove a file or directory tree. Idempotent. */
    fun remove(path: String)

    /** Overwrite `length` bytes at `offset` and fsync — the destruction zero-overwrite. */
    fun writeRange(path: String, offset: Long, data: ByteArray)

    /** Size in bytes, or null if absent. */
    fun size(path: String): Long?

    /** Direct children (one level) under a prefix directory, names only. */
    fun list(prefix: String): List<String>

    /**
     * Run `fn` holding an exclusive lock named `scope` — real mutual exclusion,
     * never a UI flag. BOUNDED: if the lock cannot be taken within
     * [LOCK_TIMEOUT_MS] the call refuses `locked` rather than blocking forever.
     *
     * Unbounded blocking is wrong specifically on Android. A verb runs behind a
     * UI action, and a wait longer than a few seconds is an ANR — the system
     * kills the process, which is a crash at an arbitrary point in the state
     * machine. A refusal is free and consumes nothing; a kill is not. Contention
     * on one pair's lock is also never legitimately long here: every verb is
     * bounded work on one small store, so a wait this long means a stuck or dead
     * holder, not a queue.
     */
    fun <T> withLock(scope: String, fn: () -> T): T
}

/**
 * How long a verb waits for a pair's lock before refusing `locked`. Ten seconds
 * is far beyond any legitimate contention (every verb is bounded work on one
 * small store) and comfortably inside the window in which a background thread
 * can still report a refusal to the UI.
 */
const val LOCK_TIMEOUT_MS: Long = 10_000

/* ---- in-process lock table shared by both backings -------------------------- */

private object LockTable {
    private val locks = ConcurrentHashMap<String, ReentrantLock>()
    fun lockFor(scope: String): ReentrantLock = locks.computeIfAbsent(scope) { ReentrantLock() }
}

private fun refuseLocked(scope: String, what: String): Nothing = throw EngineRefused(
    "locked",
    "another operation on $scope still holds its $what after ${LOCK_TIMEOUT_MS / 1000} seconds. TruePad runs one " +
        "writer per pair so two operations can never consume the same material, and it refuses rather than wait " +
        "indefinitely. Nothing was burned.",
)

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
        if (!lock.tryLock(LOCK_TIMEOUT_MS, TimeUnit.MILLISECONDS)) refuseLocked(scope, "in-process lock")
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
        restrictDir(root)
    }

    private fun full(path: String): File {
        var f = root
        for (part in path.split('/')) if (part.isNotEmpty()) f = File(f, part)
        return f
    }

    override fun readFile(path: String): ByteArray? {
        val f = full(path)
        if (f.isFile) return f.readBytes()
        /*
         * PRESENT-BUT-NOT-A-REGULAR-FILE IS NOT ABSENCE.
         *
         * This returned null for a directory, a FIFO, a device node or a dangling
         * symlink, which is indistinguishable from "no such path" to every caller.
         * That is a fail-OPEN on the one distinction several state readers exist to
         * make: `absent` is the value that PERMITS an action. A directory at
         * <pairId>/handoff.json read as Absent, and Absent is what lets a pad that
         * has already left be handed off a SECOND time.
         *
         * The SPT readers were already written for this: readRequestClaim says "a
         * read that throws becomes `unreadable`, never `absent`", and
         * Handoff.readHandoffState wraps this call for exactly that reason. They
         * simply never got an exception to catch, because the adapter swallowed the
         * condition. Throwing here is what makes those readers work as designed.
         *
         * NOFOLLOW_LINKS is deliberate: a DANGLING symlink reports false from both
         * isFile() and exists(), so without it the most obviously planted path of
         * all would still read as absence.
         *
         * Every other caller that does not catch propagates the exception instead,
         * which aborts the operation having consumed nothing — the fail-CLOSED
         * direction. LOSS IS ACCEPTABLE; REUSE IS NOT.
         */
        if (Files.exists(f.toPath(), LinkOption.NOFOLLOW_LINKS)) {
            throw IllegalStateException(
                "$path exists but is not a regular file, so it cannot be read as state. " +
                    "This is NOT the same as absence and must never be treated as absence: " +
                    "absence is what permits an action. Nothing was touched.",
            )
        }
        return null
    }

    override fun writeFileAtomic(path: String, data: ByteArray) {
        val target = full(path)
        val dir = target.parentFile ?: throw IllegalStateException("no parent for $path")
        if (!dir.isDirectory) { dir.mkdirs(); restrictDir(dir) }
        val tmp = File(dir, "${target.name}.writing")
        RandomAccessFile(tmp, "rw").use { raf ->
            // Restricted BEFORE any bytes are written, so the secret body never
            // exists on disk under wider permissions, not even briefly.
            restrictFile(tmp)
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
        val dir = target.parentFile
        if (dir != null && !dir.isDirectory) { dir.mkdirs(); restrictDir(dir) }
        // Whether this append CREATES the file decides what has to be made
        // durable. fsync on a file descriptor persists the file's CONTENTS, not
        // its directory entry, so a crash after a creating append can lose the
        // whole file even though its bytes were flushed. The journal and the
        // witness journal are both created by their first append, and losing one
        // of those wholesale is exactly the state the reconciliation is meant to
        // survive — so the parent directory is fsynced too, but only on the
        // append that creates the entry.
        val created = !target.exists()
        RandomAccessFile(target, "rw").use { raf ->
            if (created) restrictFile(target)
            raf.seek(raf.length())
            raf.write(data)
            raf.fd.sync()
        }
        if (created && dir != null) fsyncDir(dir)
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

    /**
     * NOT KNOWN TO BE ABSENT — see the [Fs.exists] contract.
     *
     * `File.exists()` is WRONG here and this is a measured fact, not a guess: it
     * follows symlinks, so a `destroyed.json` that is a symlink to a deleted
     * target reads as FALSE and a destroyed pair becomes usable again. That is a
     * terminal-state fail-open, and reuse is the one outcome TruePad may never
     * allow. `Files.notExists(NOFOLLOW_LINKS)` is true only when the path is
     * definitively absent: it is false for a regular file, a directory, a
     * dangling symlink, AND for any path whose status cannot be determined.
     */
    override fun exists(path: String): Boolean {
        val p = full(path).toPath()
        return try {
            Files.readAttributes(p, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
            true
        } catch (_: NoSuchFileException) {
            false // the ONE definitive negative: there is no such path
        } catch (_: IOException) {
            // Anything else -- a permission failure, an I/O error, a path whose
            // parent is not a directory -- is NOT a definitive "nothing is here",
            // so it reads as present. Deliberately conservative, and deliberately
            // not dependent on how a JDK happens to map a given errno: the
            // editions must agree, and only ENOENT is portable enough to trust.
            true
        }
    }

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
        // Both layers are BOUNDED: see Fs.withLock on why an Android verb must
        // refuse rather than block.
        val inProc = LockTable.lockFor("nio:${root.absolutePath}:$scope")
        if (!inProc.tryLock(LOCK_TIMEOUT_MS, TimeUnit.MILLISECONDS)) refuseLocked(scope, "in-process lock")
        try {
            val lockDir = File(root, ".locks").apply { mkdirs(); restrictDir(this) }
            val lockFile = File(lockDir, "$scope.lock")
            FileChannel.open(
                lockFile.toPath(),
                StandardOpenOption.CREATE, StandardOpenOption.WRITE,
            ).use { ch ->
                // tryLock() polls instead of blocking: FileLock has no timed
                // acquire, and lock() would reintroduce the unbounded wait.
                val deadline = System.nanoTime() + LOCK_TIMEOUT_MS * 1_000_000
                var fileLock = ch.tryLock()
                while (fileLock == null) {
                    if (System.nanoTime() >= deadline) refuseLocked(scope, "file lock")
                    Thread.sleep(25)
                    fileLock = ch.tryLock()
                }
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

    /*
     * 0600 files and 0700 directories, matching the released CLI's FILE_MODE and
     * DIR_MODE. On Android this is BELT AND BRACES, not the protection itself:
     * an app's private data directory is already isolated per-UID, and that
     * isolation — not the mode bits — is what keeps other apps out. Setting the
     * modes anyway means the same store copied to shared storage, an SD card, or
     * a developer's desktop does not silently widen. Best-effort: a backing that
     * does not implement POSIX permissions (some FAT/exFAT volumes) throws, and
     * the operation continues rather than failing a burn over a mode bit.
     * docs/ANDROID-SECURITY.md states this limitation instead of hiding it.
     */
    private fun restrictFile(f: File) {
        try {
            Files.setPosixFilePermissions(f.toPath(), PosixFilePermissions.fromString("rw-------"))
        } catch (_: Exception) {
            /* best-effort */
        }
    }

    private fun restrictDir(d: File) {
        try {
            Files.setPosixFilePermissions(d.toPath(), PosixFilePermissions.fromString("rwx------"))
        } catch (_: Exception) {
            /* best-effort */
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
