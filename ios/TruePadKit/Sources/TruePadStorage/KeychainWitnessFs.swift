/* ============================================================================
 * The iOS witness failure domain — a Keychain-backed `Fs` for the witness ONLY.
 * ----------------------------------------------------------------------------
 * A rollback witness only detects a rollback if it lives in a DIFFERENT FAILURE
 * DOMAIN from the store it is witnessing. Android gets that free:
 * `getNoBackupFilesDir()` is a directory its backup system contractually skips.
 *
 * iOS HAS NO EQUIVALENT DIRECTORY. Every path inside the app container shares one
 * fate: whatever carries the container carries the witness with it, and a witness
 * restored alongside the store detects nothing. Putting the witness in a second
 * FILE therefore buys nothing at all, and claiming otherwise would be the exact
 * kind of unearned authority this project refuses.
 *
 * The Keychain is the one store Apple provides that is NOT part of the app
 * container, and `...ThisDeviceOnly` items are wrapped with a device-bound key so
 * they cannot be restored to a different device. That is the separation this file
 * exists to obtain.
 *
 * WHAT IS AND IS NOT ESTABLISHED, precisely:
 *
 *   RELIED-UPON APPLE CONTRACT — `ThisDeviceOnly` items are device-bound and are
 *   not restorable to another device. Documented behaviour.
 *
 *   NOT RELIED UPON — that Keychain items survive app deletion. They historically
 *   do, but Apple states this is an implementation detail that should not be
 *   relied upon. The design must therefore fail CLOSED when the witness is gone,
 *   and it does: a provisioned pair whose witness cannot be read is refused.
 *
 *   NOT ESTABLISHED HERE, AND THIS IS THE IMPORTANT ONE — none of this is
 *   verified by the test suite, because it CANNOT be. The data-protection
 *   Keychain returns errSecMissingEntitlement (-34018) to an unsigned binary, so
 *   neither `swift test` on a developer machine nor CI can exercise the real
 *   backend. That was measured, not assumed. What the tests cover is the LOGIC,
 *   through an injected backend; what remains unverified is the platform
 *   behaviour, and it stays on the physical-iPhone gate until a signed build runs
 *   on a device.
 *
 *   NOT A TPM. The Keychain is not a monotonic counter and the Secure Enclave is
 *   not the desktop TPM authority. This changes iOS's failure domain; it does not
 *   change its assurance class, and iOS still cannot reach CONDITIONALLY ELIGIBLE.
 *
 * PAD MATERIAL NEVER GOES HERE, and that is enforced structurally rather than by
 * discipline: this type accepts only the witness journal path shape, and rejects
 * every other path outright. It is not a general filesystem and refuses to
 * pretend to be one.
 * ========================================================================= */

import Foundation
import TruePadCore

#if canImport(Security)
import Security
#endif

/// The narrow key/value surface the witness needs. Injected so the LOGIC above it
/// is testable without a signed binary — see the entitlement note above.
public protocol KeychainBackend: AnyObject {
    func get(account: String) throws -> [UInt8]?
    func set(account: String, data: [UInt8]) throws
    func delete(account: String) throws
}

public enum KeychainWitnessError: Error, Equatable {
    /// A path that is not a witness journal was offered. Never widen this.
    case pathNotAWitnessJournal(String)
    /// An operation this store deliberately does not implement.
    case unsupportedOperation(String)
    case backend(String, OSStatus)
}

/// An `Fs` that stores ONLY witness journals, in the Keychain.
///
/// Bind it as the Engine's `witnessFs`. Binding it as the STORE's `fs` is
/// impossible by construction: every store path is refused.
public final class KeychainWitnessFs: Fs, @unchecked Sendable {
    let backend: KeychainBackend

    /// Above this many bytes the journal is compacted. See `compactIfNeeded`.
    let compactionThreshold: Int

    public init(backend: KeychainBackend, compactionThreshold: Int = 64 * 1024) {
        self.backend = backend
        self.compactionThreshold = compactionThreshold
    }

    /// `witness/<32 lowercase hex>.log` and nothing else.
    ///
    /// This is the structural guarantee that pad material cannot reach the
    /// Keychain: `secret.bin`, `head.json`, `journal.log`, `handoff.json` and every
    /// other store path fail this check and are refused, so a mis-wiring is an
    /// immediate error rather than a silent secret leak into a store that is not
    /// designed to hold one.
    static func account(forWitnessPath path: String) throws -> String {
        let prefix = "witness/"
        let suffix = ".log"
        guard path.hasPrefix(prefix), path.hasSuffix(suffix) else {
            throw KeychainWitnessError.pathNotAWitnessJournal(path)
        }
        let pairId = String(path.dropFirst(prefix.count).dropLast(suffix.count))
        guard isHex32(pairId) else { throw KeychainWitnessError.pathNotAWitnessJournal(path) }
        return pairId
    }

    // ---- the operations the witness actually uses ---------------------------

    public func readFile(_ path: String) throws -> [UInt8]? {
        try backend.get(account: try Self.account(forWitnessPath: path))
    }

    public func appendFile(_ path: String, _ data: [UInt8]) throws {
        let account = try Self.account(forWitnessPath: path)
        let existing = (try backend.get(account: account)) ?? []
        try backend.set(account: account, data: compactIfNeeded(existing + data))
    }

    public func remove(_ path: String) throws {
        try backend.delete(account: try Self.account(forWitnessPath: path))
    }

    public func exists(_ path: String) -> Bool {
        guard let account = try? Self.account(forWitnessPath: path) else { return false }
        return ((try? backend.get(account: account)) ?? nil) != nil
    }

    public func size(_ path: String) throws -> Int? {
        try readFile(path)?.count
    }

    /// COMPACTION, and why it is safe.
    ///
    /// A file journal can grow without bound; a Keychain item cannot, and an item
    /// that grows until a write fails would take the witness down at exactly the
    /// wrong moment. So above a threshold the journal is folded.
    ///
    /// This preserves the semantics EXACTLY, because reconciliation is already a
    /// per-direction elementwise MAXIMUM over surviving records: replacing many
    /// records with the single record holding their maximum is the same fold,
    /// pre-computed. It can only ever move the recorded high-water UP, never down,
    /// so it cannot mask a rollback.
    ///
    /// The append-only-and-never-truncated property that leading-newline framing
    /// protects is about a TORN append fusing with its neighbours. That hazard is
    /// a file-append hazard; a Keychain write replaces the item atomically, so a
    /// failed compaction leaves the previous value intact rather than a half one.
    func compactIfNeeded(_ blob: [UInt8]) -> [UInt8] {
        guard blob.count > compactionThreshold else { return blob }
        var folded: [PadDirection: WitnessCounters] = [:]
        for line in String(decoding: blob, as: UTF8.self).components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            guard let parsed = try? parseStrictJson(trimmed),
                  case .object(let members) = parsed, members.count == 4,
                  let map = parsed.memberMap,
                  case .string(let d)? = map["d"], let direction = PadDirection.fromWire(d),
                  case .number(let eno)? = map["eno"], let e = Int(eno),
                  case .number(let ans)? = map["ans"], let a = Int(ans),
                  case .number(let ar)? = map["ar"], let r = Int(ar) else { continue }
            let record = WitnessCounters(encryptionNextOffset: e,
                                         authenticationNextSequence: a,
                                         attemptsReserved: r)
            folded[direction] = folded[direction].map { $0.elementwiseMax(record) } ?? record
        }
        // If nothing survived, keep the original: refusing to understand a blob is
        // not a licence to destroy it. The witness reader will fail closed on it.
        guard !folded.isEmpty else { return blob }
        var out: [UInt8] = []
        for direction in [PadDirection.aToB, PadDirection.bToA] {
            if let c = folded[direction] { out += encodeWitnessRecord(direction, c) }
        }
        return out
    }

    // ---- everything else is refused, on purpose -----------------------------

    public func writeFileAtomic(_ path: String, _ data: [UInt8]) throws {
        throw KeychainWitnessError.unsupportedOperation("writeFileAtomic")
    }
    public func readRange(_ path: String, offset: Int, length: Int) throws -> [UInt8] {
        throw KeychainWitnessError.unsupportedOperation("readRange")
    }
    public func writeRange(_ path: String, offset: Int, data: [UInt8]) throws {
        throw KeychainWitnessError.unsupportedOperation("writeRange")
    }
    public func list(_ prefix: String) throws -> [String] {
        throw KeychainWitnessError.unsupportedOperation("list")
    }

    /// The witness is written under the pair lock the store already holds, so this
    /// adds no second lock scope of its own.
    public func withLock<T>(_ scope: String, _ fn: () throws -> T) throws -> T { try fn() }
}

#if canImport(Security)
/// The real backend: the data-protection Keychain, `ThisDeviceOnly`.
///
/// Requires a signed application with Keychain entitlements. An unsigned binary
/// gets errSecMissingEntitlement (-34018), which is why the suite exercises the
/// logic through an injected backend and this type's platform behaviour stays on
/// the physical-device gate.
public final class SystemKeychainBackend: KeychainBackend, @unchecked Sendable {
    let service: String

    public init(service: String = "dev.systemslibrarian.truepad.witness") {
        self.service = service
    }

    private func baseQuery(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            // The data-protection Keychain is the one that honours ThisDeviceOnly.
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    public func get(account: String) throws -> [UInt8]? {
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw KeychainWitnessError.backend("SecItemCopyMatching", status)
        }
        guard let data = out as? Data else {
            // Present but unreadable is NOT absence — the same rule the file
            // backing follows. Fail closed.
            throw KeychainWitnessError.backend("SecItemCopyMatching returned no data",
                                               errSecInternalError)
        }
        return [UInt8](data)
    }

    public func set(account: String, data: [UInt8]) throws {
        let query = baseQuery(account)
        let attributes: [String: Any] = [kSecValueData as String: Data(data)]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else {
            throw KeychainWitnessError.backend("SecItemUpdate", updated)
        }
        var add = query
        add[kSecValueData as String] = Data(data)
        // AfterFirstUnlock so a verb can still advance the witness while the device
        // is locked; ThisDeviceOnly so the item is device-bound and does not
        // migrate to another device in a restore.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainWitnessError.backend("SecItemAdd", status)
        }
    }

    public func delete(account: String) throws {
        let status = SecItemDelete(baseQuery(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainWitnessError.backend("SecItemDelete", status)
        }
    }
}
#endif

/// A deterministic in-memory backend for tests. NOT a security boundary — it
/// models the key/value shape so the logic above can be exercised where the real
/// Keychain is unreachable.
public final class InMemoryKeychainBackend: KeychainBackend, @unchecked Sendable {
    private var items: [String: [UInt8]] = [:]
    private let mutex = NSLock()

    public init() {}

    public func get(account: String) throws -> [UInt8]? {
        mutex.lock(); defer { mutex.unlock() }
        return items[account]
    }
    public func set(account: String, data: [UInt8]) throws {
        mutex.lock(); defer { mutex.unlock() }
        items[account] = data
    }
    public func delete(account: String) throws {
        mutex.lock(); defer { mutex.unlock() }
        items.removeValue(forKey: account)
    }

    /// Test inspection: what the "device" still holds after a container is wiped.
    public var accounts: [String] { mutex.lock(); defer { mutex.unlock() }; return items.keys.sorted() }
}
