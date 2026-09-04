import Foundation

/* ============================================================================
 * The filesystem abstraction the SPT durable protocol runs over.
 *
 * Kept HERE rather than as a dependency on TruePadStorage, so TruePadSPT stays
 * self-contained and the frozen OTP engine is untouched — the same separation
 * Android draws between :truepad-spt and :truepad-storage. The app adapts its
 * real filesystem to this.
 *
 * The protocol's whole safety rests on three properties: `writeFileAtomic` is the
 * ONLY writer, `exists` is reliable, and NOTHING ever rewrites a committed
 * marker.
 * ========================================================================= */

public protocol SptVfs: AnyObject {
    /// The file's bytes, or nil if it does not exist.
    ///
    /// A read that THROWS is not absence. Every caller in this module treats a
    /// throw as "present but unreadable", because absence is the state that
    /// permits a second package, and a marker that cannot be read is not a marker
    /// that is not there.
    func readFile(_ path: String) throws -> [UInt8]?

    /// Create or replace a file with its complete contents. The one writer.
    func writeFileAtomic(_ path: String, _ data: [UInt8]) throws

    func exists(_ path: String) -> Bool

    func remove(_ path: String) throws

    /// Overwrite `data.count` bytes at `offset` in an existing file. Best-effort
    /// key hygiene only — the terminal marker is the authority, never this.
    func writeRange(_ path: String, offset: Int, data: [UInt8]) throws

    func size(_ path: String) throws -> Int?

    /// Direct children (one level) under a prefix directory, names only.
    func list(_ prefix: String) throws -> [String]

    /// Run `body` holding an exclusive lock named `scope`.
    func withLock<T>(_ scope: String, _ body: () throws -> T) throws -> T
}

/// An in-memory SptVfs for tests — a byte-exact stand-in for the durable one.
/// Paths are opaque keys; `list` returns one-level child names under a prefix.
public final class MemorySptVfs: SptVfs, @unchecked Sendable {
    private var files: [String: [UInt8]] = [:]
    private let mutex = NSRecursiveLock()

    public init() {}

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        mutex.lock(); defer { mutex.unlock() }
        return try body()
    }

    public func readFile(_ path: String) throws -> [UInt8]? { locked { files[path] } }

    public func writeFileAtomic(_ path: String, _ data: [UInt8]) throws {
        locked { files[path] = data }
    }

    public func exists(_ path: String) -> Bool { locked { files[path] != nil } }

    public func remove(_ path: String) throws {
        locked {
            files.removeValue(forKey: path)
            let prefix = path + "/"
            for key in files.keys where key.hasPrefix(prefix) { files.removeValue(forKey: key) }
        }
    }

    public func writeRange(_ path: String, offset: Int, data: [UInt8]) throws {
        try locked {
            guard var current = files[path] else {
                throw SptVfsError.noSuchFile("writeRange on missing file \(path)")
            }
            guard offset >= 0, offset + data.count <= current.count else {
                throw SptVfsError.outOfRange("writeRange out of bounds for \(path)")
            }
            current.replaceSubrange(offset..<(offset + data.count), with: data)
            files[path] = current
        }
    }

    public func size(_ path: String) throws -> Int? { locked { files[path]?.count } }

    public func list(_ prefix: String) throws -> [String] {
        locked {
            let norm = prefix.hasSuffix("/") ? prefix : prefix + "/"
            var names: [String] = []
            var seen = Set<String>()
            for key in files.keys.sorted() where key.hasPrefix(norm) {
                let rest = key.dropFirst(norm.count)
                let name = rest.firstIndex(of: "/").map { String(rest[rest.startIndex..<$0]) } ?? String(rest)
                if !name.isEmpty, seen.insert(name).inserted { names.append(name) }
            }
            return names
        }
    }

    public func withLock<T>(_ scope: String, _ body: () throws -> T) throws -> T {
        try locked(body)
    }

    /// Test surface: every path currently held.
    public var allPaths: [String] { locked { files.keys.sorted() } }
}

public enum SptVfsError: Error, Equatable {
    case noSuchFile(String)
    case outOfRange(String)
    case io(String)
}

/// The SPT layer's typed refusal — a reason code plus a human message, mirroring
/// the storage engine's `EngineRefused` without depending on it.
public struct SptRefused: Error, Equatable {
    public let reason: String
    public let message: String

    public init(reason: String, message: String) {
        self.reason = reason
        self.message = message
    }
}

/// An internal rejection carrying only WHY, used by the strict parsers. It is
/// always converted into a typed `SptRefused` (or a "…Unreadable" state) before
/// it can reach a caller, so a parse failure can never be mistaken for absence.
struct SptRejected: Error {
    let why: String
}
