/* ============================================================================
 * MemoryFs — the in-memory backing for fault-injection tests.
 * ----------------------------------------------------------------------------
 * The twin of android/truepad-storage MemoryFs. It exists so the state machine's
 * crash behaviour can be exercised exhaustively and fast: a test can stop the
 * world between any two writes and inspect exactly what a reader would see.
 *
 * It is NOT a durability model. Nothing here is durable — that is the point. It
 * makes the ORDER of writes observable, which is what the reuse argument
 * actually rests on: whether the consumption record was written before the
 * output was released. Whether those bytes then reached flash is DarwinFs's
 * business, and no test in this file should be read as evidence about it.
 * ========================================================================= */

import Foundation

public final class MemoryFs: Fs, @unchecked Sendable {
    private var files: [String: [UInt8]] = [:]
    private let mutex = NSRecursiveLock()

    /// Optional hook: called before every mutating operation, so a test can make
    /// the process "die" at an exact point by throwing. This is how crash-between
    /// -two-writes cases are expressed without actually killing anything.
    public var beforeMutation: ((_ operation: String, _ path: String) throws -> Void)?

    public init() {}

    private func locked<T>(_ fn: () throws -> T) rethrows -> T {
        mutex.lock()
        defer { mutex.unlock() }
        return try fn()
    }

    public func readFile(_ path: String) throws -> [UInt8]? {
        locked { files[path] }
    }

    public func writeFileAtomic(_ path: String, _ data: [UInt8]) throws {
        try beforeMutation?("writeFileAtomic", path)
        locked { files[path] = data }
    }

    public func appendFile(_ path: String, _ data: [UInt8]) throws {
        try beforeMutation?("appendFile", path)
        locked { files[path, default: []].append(contentsOf: data) }
    }

    public func readRange(_ path: String, offset: Int, length: Int) throws -> [UInt8] {
        try locked {
            guard let f = files[path] else { throw FsFailure.noSuchFile(path) }
            guard offset >= 0, length >= 0, offset + length <= f.count else {
                throw FsFailure.rangeOutOfBounds(path: path, offset: offset,
                                                 length: length, size: f.count)
            }
            return Array(f[offset..<(offset + length)])
        }
    }

    public func writeRange(_ path: String, offset: Int, data: [UInt8]) throws {
        try beforeMutation?("writeRange", path)
        try locked {
            guard var f = files[path] else { throw FsFailure.noSuchFile(path) }
            guard offset >= 0, offset + data.count <= f.count else {
                throw FsFailure.rangeOutOfBounds(path: path, offset: offset,
                                                 length: data.count, size: f.count)
            }
            if !data.isEmpty { f.replaceSubrange(offset..<(offset + data.count), with: data) }
            files[path] = f
        }
    }

    public func exists(_ path: String) -> Bool {
        locked { files[path] != nil }
    }

    public func remove(_ path: String) throws {
        try beforeMutation?("remove", path)
        locked {
            files.removeValue(forKey: path)
            let prefix = path + "/"
            for key in files.keys where key.hasPrefix(prefix) { files.removeValue(forKey: key) }
        }
    }

    public func size(_ path: String) throws -> Int? {
        locked { files[path]?.count }
    }

    public func list(_ prefix: String) throws -> [String] {
        locked {
            let norm = prefix.isEmpty ? "" : prefix.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/"
            var names = Set<String>()
            for key in files.keys where norm.isEmpty || key.hasPrefix(norm) {
                let rest = String(key.dropFirst(norm.count))
                let first = rest.split(separator: "/", maxSplits: 1).first.map(String.init) ?? ""
                if !first.isEmpty { names.insert(first) }
            }
            return names.sorted()
        }
    }

    public func withLock<T>(_ scope: String, _ fn: () throws -> T) throws -> T {
        let lock = LockTable.shared.lock(for: "mem:\(ObjectIdentifier(self)):\(scope)")
        let deadline = Date().addingTimeInterval(lockTimeoutSeconds)
        while !lock.try() {
            if Date() >= deadline { throw refuseLocked(scope, "in-process lock") }
            Thread.sleep(forTimeInterval: 0.005)
        }
        defer { lock.unlock() }
        return try fn()
    }

    // ---- test inspection ----------------------------------------------------

    /// Every path currently present, sorted. For asserting on exactly what a
    /// crash left behind.
    public var allPaths: [String] { locked { files.keys.sorted() } }

    /// Truncate a file to `count` bytes, simulating a torn write of the target.
    /// Readers must refuse such a file CLOSED, never accept a partial mix.
    public func truncate(_ path: String, to count: Int) {
        locked {
            guard let f = files[path], count <= f.count else { return }
            files[path] = Array(f.prefix(count))
        }
    }

    /// A snapshot that can be restored — the shape of a backup/restore rollback,
    /// which is exactly the attack the witness journal exists to detect.
    public func snapshot() -> [String: [UInt8]] { locked { files } }

    public func restore(_ snapshot: [String: [UInt8]]) {
        locked { files = snapshot }
    }
}
