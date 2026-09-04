/* ============================================================================
 * DarwinFs — the durable product backing on iOS and macOS.
 * ----------------------------------------------------------------------------
 * THE APPLE-SPECIFIC PART, AND WHY IT IS NOT JUST fsync()
 *
 * On Darwin, `fsync()` does NOT guarantee the bytes reached stable storage. It
 * flushes them out of the kernel's buffers and into the DRIVE, where they may sit
 * in the device's own write cache. Apple's documentation is explicit about this
 * and provides `fcntl(fd, F_FULLFSYNC)` for callers that need the stronger
 * barrier. A store that used plain fsync() would be claiming a durability it does
 * not have — and on a format whose entire safety argument is "the consumption
 * record reached disk before the output was released", that is exactly the wrong
 * place to be optimistic. Every sync in this file is F_FULLFSYNC, falling back to
 * fsync() only when the filesystem refuses the stronger call (ENOTSUP), which is
 * recorded rather than hidden.
 *
 * WHAT THIS BACKING ACTUALLY GUARANTEES
 *
 *   * bytes flushed with F_FULLFSYNC survive process death, app termination, and
 *     an ordinary reboot;
 *   * `rename(2)` on APFS is atomic, so a whole-file replace is all-or-nothing
 *     for a reader that opens the target;
 *   * a torn temp file is never published, because the temp is fully synced
 *     before the rename;
 *   * files are created with Data Protection, so at rest they are encrypted with
 *     a key tied to the device and (for the stronger classes) the passcode.
 *
 * WHAT IT DOES NOT GUARANTEE — stated here rather than left to be assumed:
 *
 *   * NOT power-loss atomicity across the whole state machine. F_FULLFSYNC
 *     orders one file's bytes; it does not make a multi-file transition atomic.
 *     The engine's answer to that is ordering and fail-closed readers, not a
 *     claim that torn states cannot happen.
 *   * NOT secure erasure. `writeRange` with zeros overwrites the LOGICAL bytes.
 *     APFS is copy-on-write over flash with wear levelling, so the previous
 *     physical blocks may persist until the controller reuses them. TruePad
 *     cannot prove a byte is gone from an iPhone, and does not claim to. What the
 *     zero-overwrite buys is that the material is no longer reachable through
 *     the file, which is what stops REUSE.
 *   * NOT protection against a restored backup or a copied container. A restore
 *     can reinstate an older consumption cursor. That is the rollback problem,
 *     and it is the witness journal's business, not this file's.
 *   * NOT a hardware monotonic counter. The Secure Enclave is not the desktop
 *     TPM authority and is never described as one.
 * ========================================================================= */

import Foundation

#if canImport(Darwin)
import Darwin
#endif

public final class DarwinFs: Fs, @unchecked Sendable {
    public let root: URL

    /// The Data Protection class new files are created with.
    ///
    /// `.completeUnlessOpen` is the default rather than `.complete`: a store must
    /// remain writable while the device is locked if a verb is already in flight,
    /// and `.complete` would fail those writes outright. A caller that wants the
    /// stronger class can pass it, and the trade is stated rather than silently
    /// chosen.
    public let fileProtection: FileProtectionType

    /// True once a sync has had to fall back from F_FULLFSYNC to fsync(). Read by
    /// the diagnostics surface so a weaker guarantee is REPORTED, not assumed.
    public private(set) var fullFsyncUnsupported = false

    public init(root: URL, fileProtection: FileProtectionType = .completeUnlessOpen) throws {
        self.root = root
        self.fileProtection = fileProtection
        try Self.makeDirectory(root, protection: fileProtection)
    }

    // ---- paths --------------------------------------------------------------

    func url(_ path: String) -> URL {
        var u = root
        for part in path.split(separator: "/") where !part.isEmpty {
            u.appendPathComponent(String(part))
        }
        return u
    }

    static func makeDirectory(_ dir: URL, protection: FileProtectionType) throws {
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue {
            return
        }
        try FileManager.default.createDirectory(
            at: dir, withIntermediateDirectories: true,
            attributes: [
                // 0700, matching the released CLI's DIR_MODE. On iOS this is BELT
                // AND BRACES, not the protection itself: the app container is
                // already isolated per-app, and that isolation is what keeps other
                // apps out. Setting the mode anyway means a store copied to a
                // shared location or a developer's desktop does not silently
                // widen.
                .posixPermissions: 0o700,
                .protectionKey: protection,
            ])
        try excludeFromBackup(dir)
    }

    /// Pad material and consumption state must NOT ride into iCloud or a Finder
    /// backup: a restored backup reinstates an older cursor, which is precisely
    /// the rollback that turns "spent" back into "unspent". Excluding the store
    /// does not make rollback impossible — a full device restore still exists —
    /// but it removes the routine path to it.
    static func excludeFromBackup(_ url: URL) throws {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = url
        try? mutable.setResourceValues(values)
    }

    // ---- syncing ------------------------------------------------------------

    /// The strong barrier. Returns whether F_FULLFSYNC itself succeeded.
    @discardableResult
    func fullSync(_ fd: Int32) -> Bool {
        #if canImport(Darwin)
        if fcntl(fd, F_FULLFSYNC, 0) != -1 { return true }
        // The filesystem refused the stronger call. Fall back, and REMEMBER, so
        // the weaker guarantee can be reported instead of quietly assumed.
        fullFsyncUnsupported = true
        _ = fsync(fd)
        return false
        #else
        _ = fsync(fd)
        return false
        #endif
    }

    /// Sync a directory's metadata so a rename is durable. A file descriptor's
    /// sync persists the file's CONTENTS, not its directory entry.
    func syncDirectory(_ dir: URL) {
        #if canImport(Darwin)
        let fd = open(dir.path, O_RDONLY)
        guard fd >= 0 else { return }
        defer { close(fd) }
        fullSync(fd)
        #endif
    }

    // ---- Fs -----------------------------------------------------------------

    public func readFile(_ path: String) throws -> [UInt8]? {
        let target = url(path)
        guard FileManager.default.fileExists(atPath: target.path) else { return nil }
        var isDir: ObjCBool = false
        _ = FileManager.default.fileExists(atPath: target.path, isDirectory: &isDir)
        if isDir.boolValue { return nil }
        return [UInt8](try Data(contentsOf: target))
    }

    public func writeFileAtomic(_ path: String, _ data: [UInt8]) throws {
        let target = url(path)
        let dir = target.deletingLastPathComponent()
        try Self.makeDirectory(dir, protection: fileProtection)

        let tmp = dir.appendingPathComponent(target.lastPathComponent + ".writing")
        // Create with the protection class and 0600 BEFORE any bytes are written,
        // so the secret body never exists on disk unprotected, not even briefly.
        FileManager.default.createFile(
            atPath: tmp.path, contents: nil,
            attributes: [.posixPermissions: 0o600, .protectionKey: fileProtection])

        let fd = open(tmp.path, O_WRONLY | O_TRUNC)
        guard fd >= 0 else { throw FsFailure.io("open \(tmp.path) failed (errno \(errno))") }
        var wrote = false
        data.withUnsafeBytes { buf in
            var offset = 0
            while offset < buf.count {
                let n = write(fd, buf.baseAddress!.advanced(by: offset), buf.count - offset)
                if n <= 0 { return }
                offset += n
            }
            wrote = true
        }
        guard wrote else {
            close(fd)
            throw FsFailure.io("short write to \(tmp.path)")
        }
        fullSync(fd)          // the temp's CONTENTS are durable before publishing
        close(fd)

        // rename(2) is atomic on APFS: a reader sees the old file or the new one,
        // never a mix.
        guard rename(tmp.path, target.path) == 0 else {
            throw FsFailure.io("rename to \(target.path) failed (errno \(errno))")
        }
        syncDirectory(dir)    // ... and the directory ENTRY is durable too
    }

    public func appendFile(_ path: String, _ data: [UInt8]) throws {
        let target = url(path)
        let dir = target.deletingLastPathComponent()
        try Self.makeDirectory(dir, protection: fileProtection)

        // Whether this append CREATES the file decides what has to be made
        // durable. Syncing a descriptor persists CONTENTS, not the directory
        // entry, so a crash after a creating append can lose the whole file even
        // though its bytes were flushed. The journal and the witness journal are
        // both created by their first append, and losing one of those wholesale is
        // exactly the state reconciliation has to survive — so the parent
        // directory is synced too, but only on the append that creates the entry.
        let created = !FileManager.default.fileExists(atPath: target.path)
        if created {
            FileManager.default.createFile(
                atPath: target.path, contents: nil,
                attributes: [.posixPermissions: 0o600, .protectionKey: fileProtection])
        }
        let fd = open(target.path, O_WRONLY | O_APPEND)
        guard fd >= 0 else { throw FsFailure.io("open \(target.path) failed (errno \(errno))") }
        var wrote = false
        data.withUnsafeBytes { buf in
            var offset = 0
            while offset < buf.count {
                let n = write(fd, buf.baseAddress!.advanced(by: offset), buf.count - offset)
                if n <= 0 { return }
                offset += n
            }
            wrote = true
        }
        guard wrote else { close(fd); throw FsFailure.io("short append to \(target.path)") }
        fullSync(fd)
        close(fd)
        if created { syncDirectory(dir) }
    }

    public func readRange(_ path: String, offset: Int, length: Int) throws -> [UInt8] {
        let target = url(path)
        let fd = open(target.path, O_RDONLY)
        guard fd >= 0 else { throw FsFailure.noSuchFile(path) }
        defer { close(fd) }
        let fileSize = Int(lseek(fd, 0, SEEK_END))
        guard offset >= 0, length >= 0, offset + length <= fileSize else {
            throw FsFailure.rangeOutOfBounds(path: path, offset: offset,
                                             length: length, size: fileSize)
        }
        var out = [UInt8](repeating: 0, count: length)
        if length > 0 {
            let n = out.withUnsafeMutableBytes { pread(fd, $0.baseAddress, length, off_t(offset)) }
            guard n == length else { throw FsFailure.io("short read of \(path)") }
        }
        return out
    }

    public func writeRange(_ path: String, offset: Int, data: [UInt8]) throws {
        let target = url(path)
        let fd = open(target.path, O_WRONLY)
        guard fd >= 0 else { throw FsFailure.noSuchFile(path) }
        defer { close(fd) }
        let fileSize = Int(lseek(fd, 0, SEEK_END))
        guard offset >= 0, offset + data.count <= fileSize else {
            throw FsFailure.rangeOutOfBounds(path: path, offset: offset,
                                             length: data.count, size: fileSize)
        }
        if !data.isEmpty {
            let n = data.withUnsafeBytes { pwrite(fd, $0.baseAddress, data.count, off_t(offset)) }
            guard n == data.count else { throw FsFailure.io("short write to \(path)") }
        }
        fullSync(fd)
    }

    public func exists(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: url(path).path)
    }

    public func remove(_ path: String) throws {
        let target = url(path)
        if FileManager.default.fileExists(atPath: target.path) {
            try FileManager.default.removeItem(at: target)
        }
    }

    public func size(_ path: String) throws -> Int? {
        let target = url(path)
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: target.path),
              let size = attrs[.size] as? NSNumber else { return nil }
        return size.intValue
    }

    public func list(_ prefix: String) throws -> [String] {
        let dir = prefix.isEmpty ? root : url(prefix)
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else {
            return []
        }
        return names.sorted()
    }

    public func withLock<T>(_ scope: String, _ fn: () throws -> T) throws -> T {
        // In-process mutual exclusion for app threads, PLUS a real OS file lock
        // for the process/filesystem boundary. Never a UI flag. Both layers are
        // BOUNDED: see Fs.withLock on why a phone verb must refuse rather than
        // block.
        let inProcess = LockTable.shared.lock(for: "darwin:\(root.path):\(scope)")
        let deadline = Date().addingTimeInterval(lockTimeoutSeconds)
        while !inProcess.try() {
            if Date() >= deadline { throw refuseLocked(scope, "in-process lock") }
            Thread.sleep(forTimeInterval: 0.025)
        }
        defer { inProcess.unlock() }

        let lockDir = root.appendingPathComponent(".locks")
        try Self.makeDirectory(lockDir, protection: fileProtection)
        let lockFile = lockDir.appendingPathComponent("\(scope).lock")
        if !FileManager.default.fileExists(atPath: lockFile.path) {
            FileManager.default.createFile(
                atPath: lockFile.path, contents: nil,
                attributes: [.posixPermissions: 0o600, .protectionKey: fileProtection])
        }
        let fd = open(lockFile.path, O_WRONLY | O_CREAT, 0o600)
        guard fd >= 0 else { throw FsFailure.io("open lock \(lockFile.path) failed") }
        defer { close(fd) }

        // flock with LOCK_NB and a poll, not a blocking acquire: a blocking call
        // would reintroduce the unbounded wait the timeout exists to prevent.
        while flock(fd, LOCK_EX | LOCK_NB) != 0 {
            if Date() >= deadline { throw refuseLocked(scope, "file lock") }
            Thread.sleep(forTimeInterval: 0.025)
        }
        defer { flock(fd, LOCK_UN) }
        return try fn()
    }
}
