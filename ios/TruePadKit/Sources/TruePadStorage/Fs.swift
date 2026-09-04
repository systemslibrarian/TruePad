/* ============================================================================
 * The durable-file operations the frozen v2 store state machine is defined over
 * (§1, §12) — the Swift twin of android/truepad-storage Fs.kt and the browser's
 * vfs.ts. Paths are relative POSIX strings ("<pairId>/a-to-b/head.json"); the
 * store never escapes its pair directory. Synchronous, like the Kotlin one.
 *
 * WHAT "DURABLE" MEANS HERE, HONESTLY
 * -----------------------------------
 * It means: the bytes reached the app-private container and were flushed with
 * F_FULLFSYNC, and a process death after that point is survived.
 *
 * It does NOT mean the CLI's Linux-ext4 power-loss claim, and it does not mean
 * anything about physical erasure. See DarwinFs below for the specific Apple
 * guarantees relied on, and docs/IOS-SECURITY.md for what is claimed and what is
 * not.
 *
 *   LOSS IS ACCEPTABLE; REUSE IS NOT.
 *
 * Every operation here is shaped by that. A torn write leaves a partial file
 * that every reader in this engine refuses CLOSED — corrupt-head,
 * corrupt-secret-body, corrupt-journal — never a silently accepted mix. Losing a
 * record is a supported outcome; accepting a half-written one that lets an
 * offset be consumed twice is not.
 * ========================================================================= */

import Foundation

/// A typed engine refusal, carrying the same reason strings the CLI, Browser and
/// Android editions use, so the cross-edition corpora agree on vocabulary.
public struct EngineRefused: Error, Equatable {
    public let reason: String
    public let message: String

    public init(reason: String, message: String) {
        self.reason = reason
        self.message = message
    }
}

/// How long a verb waits for a pair's lock before refusing `locked`.
///
/// Ten seconds is far beyond any legitimate contention — every verb is bounded
/// work on one small store — and comfortably inside the window in which a
/// background task can still report a refusal to the UI.
public let lockTimeoutSeconds: TimeInterval = 10

public protocol Fs: AnyObject {
    /// Whole file, or nil if absent.
    func readFile(_ path: String) throws -> [UInt8]?

    /// Replace a file's whole contents durably. Atomic where the backing offers
    /// it (temp file + full sync + rename + parent-directory sync); a torn write
    /// of the target leaves a partial file every reader refuses CLOSED, never a
    /// silently accepted mix. The rollback witness does NOT depend on this — it
    /// is an append-only journal.
    func writeFileAtomic(_ path: String, _ data: [UInt8]) throws

    /// Append to a file (creating it if absent) and sync. The journal's shape.
    func appendFile(_ path: String, _ data: [UInt8]) throws

    /// Positioned read of `length` bytes from `offset` (secret.bin reads, §1.2).
    func readRange(_ path: String, offset: Int, length: Int) throws -> [UInt8]

    /// Overwrite `length` bytes at `offset` and sync — the destruction
    /// zero-overwrite. See DarwinFs for what this does and does not prove.
    func writeRange(_ path: String, offset: Int, data: [UInt8]) throws

    /// Is this path NOT KNOWN TO BE ABSENT?
    ///
    /// Deliberately not "is there a readable regular file here". It gates the §17
    /// tombstone, and a terminal marker must fail CLOSED: anything present at the
    /// path — a regular file, a directory, a symlink whose target is gone — and
    /// any inability to decide must all read as present. Only a definitive
    /// "nothing is here" may return false.
    func exists(_ path: String) -> Bool

    /// Remove a file or directory tree. Idempotent.
    func remove(_ path: String) throws

    /// Size in bytes, or nil if absent.
    func size(_ path: String) throws -> Int?

    /// Direct children (one level) under a prefix directory, names only.
    func list(_ prefix: String) throws -> [String]

    /// Run `fn` holding an exclusive lock named `scope` — real mutual exclusion,
    /// never a UI flag.
    ///
    /// BOUNDED: if the lock cannot be taken within `lockTimeoutSeconds` the call
    /// refuses `locked` rather than blocking forever. Unbounded blocking is wrong
    /// specifically on a phone: a verb runs behind a UI action, and a long wait
    /// gets the app killed by the watchdog — which is a crash at an arbitrary
    /// point in the state machine. A refusal is free and consumes nothing; a kill
    /// is not. Contention on one pair's lock is never legitimately long here, so
    /// a wait this long means a stuck or dead holder, not a queue.
    func withLock<T>(_ scope: String, _ fn: () throws -> T) throws -> T
}

func refuseLocked(_ scope: String, _ what: String) -> EngineRefused {
    EngineRefused(
        reason: "locked",
        message: "another operation on \(scope) still holds its \(what) after "
            + "\(Int(lockTimeoutSeconds)) seconds. TruePad runs one writer per pair so two operations "
            + "can never consume the same material, and it refuses rather than wait indefinitely. "
            + "Nothing was burned."
    )
}

public enum FsFailure: Error, Equatable {
    case noSuchFile(String)
    case rangeOutOfBounds(path: String, offset: Int, length: Int, size: Int)
    case noParentDirectory(String)
    case io(String)
}

/// Process-wide lock table shared by both backings.
final class LockTable: @unchecked Sendable {
    static let shared = LockTable()
    private var locks: [String: NSRecursiveLock] = [:]
    private let guard_ = NSLock()

    func lock(for scope: String) -> NSRecursiveLock {
        guard_.lock()
        defer { guard_.unlock() }
        if let existing = locks[scope] { return existing }
        let created = NSRecursiveLock()
        locks[scope] = created
        return created
    }
}
