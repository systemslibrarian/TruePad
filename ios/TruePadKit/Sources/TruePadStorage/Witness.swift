/* ============================================================================
 * The rollback witness — an append-only journal of three monotone counters.
 * ----------------------------------------------------------------------------
 * Swift twin of android/truepad-storage Witness.kt and src/browser/engine's
 * witness. FORMAT-V2 §15.
 *
 * A restore is the classic pad-reuse vector: put yesterday's store back, and
 * every byte spent since becomes spendable again. Worse, restoring only the
 * header refills a contested record's verification-attempt budget and defeats the
 * finite forgery bound of §5. The witness records exactly three frozen monotone
 * counters per direction — encryptionNextOffset, authenticationNextSequence,
 * attemptsReserved — and nothing else. Never pad contents, keys, masks,
 * plaintext, or ciphertext.
 *
 * A WITNESS ONLY DETECTS A ROLLBACK IF IT IS IN A DIFFERENT FAILURE DOMAIN FROM
 * THE THING BEING ROLLED BACK. That is why the Engine takes a SEPARATE `Fs` for
 * it. Android binds the store to getFilesDir() and the witness to
 * getNoBackupFilesDir(), because Android's backup carries the former and not the
 * latter.
 *
 * iOS HAS NO SUCH DIRECTORY. There is no documented "the backup system skips
 * this folder" root. So on iOS the different domain has to come from somewhere
 * else, and the witness is deliberately written against the small `Fs` surface it
 * actually uses — readFile, appendFile, exists, remove — so that a
 * Keychain-backed conformer can supply that domain without the engine changing.
 * Until the app binds one, `witnessFs` defaults to the store's own `Fs`, which is
 * the honest-but-weak configuration in which a restore carries the witness too
 * and the rollback is invisible. That weak case is TESTED rather than hidden.
 *
 * See docs/IOS-SECURITY.md §5 for what is relied upon and what is not.
 * ========================================================================= */

import Foundation
import TruePadCore

/// The witness kind, as recorded in the platform-local pair metadata — never in
/// the frozen head, which always carries `rollback: { witnessClass: "none" }`.
public enum WitnessKind: String, Sendable, Equatable {
    case none = "ios-none"
    case local = "ios-local-witness"

    public static func fromWire(_ s: String?) -> WitnessKind? {
        guard let s else { return nil }
        return WitnessKind(rawValue: s)
    }
}

/// The three frozen monotone counters, and nothing else (§15.1).
public struct WitnessCounters: Sendable, Equatable {
    public let encryptionNextOffset: Int
    public let authenticationNextSequence: Int
    /// The store's count of `attempt` journal lines. This is the quantity that
    /// stops a restore refilling a contested record's verification budget, which
    /// is why it is witnessed alongside the two obvious cursors.
    public let attemptsReserved: Int

    public init(encryptionNextOffset: Int, authenticationNextSequence: Int, attemptsReserved: Int) {
        self.encryptionNextOffset = encryptionNextOffset
        self.authenticationNextSequence = authenticationNextSequence
        self.attemptsReserved = attemptsReserved
    }

    public static let zero = WitnessCounters(encryptionNextOffset: 0,
                                             authenticationNextSequence: 0,
                                             attemptsReserved: 0)

    func elementwiseMax(_ other: WitnessCounters) -> WitnessCounters {
        WitnessCounters(
            encryptionNextOffset: max(encryptionNextOffset, other.encryptionNextOffset),
            authenticationNextSequence: max(authenticationNextSequence, other.authenticationNextSequence),
            attemptsReserved: max(attemptsReserved, other.attemptsReserved))
    }
}

/// The non-secret comparison of a store against its witness, for status (§15.3).
public enum WitnessState: String, Sendable, Equatable {
    case na = "n/a"
    case aligned = "aligned"
    case ahead = "ahead"
    case regressed = "regressed"
    case inconsistent = "inconsistent"
}

public enum WitnessPreflight: Sendable {
    case ok(WitnessState)
    case refused(reason: String, message: String)
}

/// The store's effective high-waters, for the comparison.
public struct StoreHighWaters: Sendable, Equatable {
    public let nextOffset: Int
    public let nextSequence: Int
    public let attemptsReserved: Int

    public init(nextOffset: Int, nextSequence: Int, attemptsReserved: Int) {
        self.nextOffset = nextOffset
        self.nextSequence = nextSequence
        self.attemptsReserved = attemptsReserved
    }
}

public func witnessLogPath(_ pairId: String) -> String { "witness/\(pairId).log" }

/// Serialize one record with a LEADING newline, four short keys in fixed order.
///
/// THE LEADING NEWLINE IS LOAD-BEARING. `appendFile` writes at EOF with no record
/// boundary, so a crash mid-append leaves a newline-free partial. With leading
/// framing every record — the torn one included — is bounded on the LEFT by its
/// own `\n` and on the RIGHT by the NEXT record's `\n`, so a torn partial is
/// always an isolated line the reader drops, and can never fuse into and destroy
/// the record before or after it. TRAILING framing would let a torn partial
/// swallow the following clean record, which is exactly the crash case this
/// design exists for.
func encodeWitnessRecord(_ direction: PadDirection, _ c: WitnessCounters) -> [UInt8] {
    var s = "\n{\"d\":"
    appendJsonString(&s, direction.rawValue)
    s.append(",\"eno\":\(c.encryptionNextOffset)")
    s.append(",\"ans\":\(c.authenticationNextSequence)")
    s.append(",\"ar\":\(c.attemptsReserved)}")
    return Array(s.utf8)
}

public protocol Witness {
    var kind: WitnessKind { get }

    /// The explicit provisioning event, at gen or a successful import.
    func bootstrap(pairId: String, initial: [PadDirection: WitnessCounters]?) throws

    /// §15.3 PREFLIGHT — a free state gate before anything is consumed.
    func preflight(pairId: String, direction: PadDirection, store: StoreHighWaters) -> WitnessPreflight

    /// §15.3 ADVANCE — after the durable §12 commit, before the emit.
    func advance(pairId: String, direction: PadDirection, counters: WitnessCounters) throws

    /// §15.3 status: read-only comparison. Refuses nothing, ever.
    func report(pairId: String, direction: PadDirection, store: StoreHighWaters) -> WitnessState
}

/// No witness, no claim. A bare FORMAT-V2 store this app never provisioned — a
/// CLI store copied in — is `none`. Restoring it regresses it and resets the
/// attempt budget, and FORMAT-V2 §9.4 stands as written.
public struct NoneWitness: Witness {
    public let kind: WitnessKind = .none
    public init() {}
    public func bootstrap(pairId: String, initial: [PadDirection: WitnessCounters]?) throws {}
    public func preflight(pairId: String, direction: PadDirection,
                          store: StoreHighWaters) -> WitnessPreflight { .ok(.na) }
    public func advance(pairId: String, direction: PadDirection, counters: WitnessCounters) throws {}
    public func report(pairId: String, direction: PadDirection,
                       store: StoreHighWaters) -> WitnessState { .na }
}

public struct LocalWitness: Witness {
    public let kind: WitnessKind = .local
    let fs: Fs

    public init(fs: Fs) { self.fs = fs }

    /// The per-direction elementwise maximum over the SURVIVING records, or nil
    /// when the journal is absent or holds no surviving record.
    ///
    /// A lower value in any record — including a junk or replayed line — can
    /// never pull the fold down, because the fold is a maximum.
    func readEffective(_ pairId: String) -> [PadDirection: WitnessCounters]? {
        guard let bytes = ((try? fs.readFile(witnessLogPath(pairId))) ?? nil) else { return nil }
        let text = String(decoding: bytes, as: UTF8.self)
        var out: [PadDirection: WitnessCounters] = [:]

        for line in text.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            // Malformed lines FAIL OPEN — they are skipped. That is safe because
            // the witness cannot defend against an attacker who can already
            // rewrite this app's private storage; its jobs are crash-safety and
            // detecting a rollback of the PAIR store. A missing/empty/all-corrupt
            // journal on a PROVISIONED pair is the opposite case and fails closed.
            guard let parsed = try? parseStrictJson(trimmed),
                  case .object(let members) = parsed,
                  members.count == 4,                       // EXACTLY four keys
                  let map = parsed.memberMap,
                  case .string(let dirText)? = map["d"],
                  let direction = PadDirection.fromWire(dirText),
                  let eno = safeCount(map["eno"]),
                  let ans = safeCount(map["ans"]),
                  let ar = safeCount(map["ar"]) else { continue }

            let record = WitnessCounters(encryptionNextOffset: eno,
                                         authenticationNextSequence: ans,
                                         attemptsReserved: ar)
            out[direction] = out[direction].map { $0.elementwiseMax(record) } ?? record
        }
        return out.isEmpty ? nil : out
    }

    /// A non-negative safe integer in its RAW spelling. `1.0` and `1e3` are
    /// rejected — the record is dropped — even though JavaScript would read them
    /// as integer-valued. The parser keeps the raw text precisely so nothing is
    /// folded away.
    func safeCount(_ v: JsonValue?) -> Int? {
        guard case .number(let raw)? = v, let n = Int(raw), n >= 0, n <= maxSafeInteger else {
            return nil
        }
        return n
    }

    static func belowWitness(_ s: StoreHighWaters, _ w: WitnessCounters) -> Bool {
        s.nextOffset < w.encryptionNextOffset
            || s.nextSequence < w.authenticationNextSequence
            || s.attemptsReserved < w.attemptsReserved
    }

    static func alignedWith(_ s: StoreHighWaters, _ w: WitnessCounters) -> Bool {
        s.nextOffset == w.encryptionNextOffset
            && s.nextSequence == w.authenticationNextSequence
            && s.attemptsReserved == w.attemptsReserved
    }

    /// Both inconsistency messages get " Nothing was burned." appended — a space
    /// then the sentence. The regression message carries it inside its own
    /// literal instead, so a port must not append it uniformly or it will be
    /// doubled.
    static func inconsistent(_ message: String) -> WitnessPreflight {
        .refused(reason: "witness-inconsistent", message: "\(message) Nothing was burned.")
    }

    public func bootstrap(pairId: String, initial: [PadDirection: WitnessCounters]? = nil) throws {
        // Exactly two records, A->B then B->A. Bootstrap is the ONLY writer that
        // creates the first records: freshness is never inferred from an empty or
        // absent file.
        for direction in [PadDirection.aToB, PadDirection.bToA] {
            let counters = initial?[direction] ?? .zero
            try fs.appendFile(witnessLogPath(pairId), encodeWitnessRecord(direction, counters))
        }
    }

    public func preflight(pairId: String, direction: PadDirection,
                          store: StoreHighWaters) -> WitnessPreflight {
        guard let effective = readEffective(pairId) else {
            // Absent, empty, or no surviving record — one case, one message. An
            // established witness NEVER reads as fresh, because a vanished
            // witness is indistinguishable from a rollback that took it.
            return Self.inconsistent(
                "\(witnessLogPath(pairId)) is missing or holds no readable record, but this pair is "
                + "provisioned with a local rollback witness. A provisioned witness is never emptied "
                + "by normal use, so this is either a restore that dropped it or damage; either way "
                + "the pair cannot be shown to have moved forward.")
        }
        guard let w = effective[direction] else {
            return Self.inconsistent(
                "\(witnessLogPath(pairId)) holds no record for \(direction.rawValue), but this pair "
                + "is provisioned with a local rollback witness. This direction cannot be shown to "
                + "have moved forward.")
        }
        if Self.belowWitness(store, w) {
            return .refused(reason: "witness-regressed", message:
                "This store is BEHIND its rollback witness for \(direction.rawValue): the store is at "
                + "offset \(store.nextOffset) / sequence \(store.nextSequence) / "
                + "\(store.attemptsReserved) reserved attempts, but \(witnessLogPath(pairId)) records "
                + "\(w.encryptionNextOffset) / \(w.authenticationNextSequence) / \(w.attemptsReserved). "
                + "That is the signature of a restored or copied store, and going on would reuse "
                + "material this device has already spent. Nothing was burned.")
        }
        // AHEAD is a normal, accepted state — it is what a store looks like after
        // a torn advance or a crash between commit and advance. Only
        // strictly-below refuses.
        return .ok(Self.alignedWith(store, w) ? .aligned : .ahead)
    }

    public func advance(pairId: String, direction: PadDirection,
                        counters: WitnessCounters) throws {
        // Throws on I/O failure. The caller has ALREADY committed, so the output
        // is withheld: the LOSS row. A torn advance under-reports its own value,
        // which is safe only because the operation that tore also errored and
        // withheld its output — so the witness never under-reports below a state
        // whose output was RELEASED, and the next clean advance re-records the
        // high-water.
        try fs.appendFile(witnessLogPath(pairId), encodeWitnessRecord(direction, counters))
    }

    public func report(pairId: String, direction: PadDirection,
                       store: StoreHighWaters) -> WitnessState {
        guard let effective = readEffective(pairId), let w = effective[direction] else {
            return .inconsistent
        }
        if Self.belowWitness(store, w) { return .regressed }
        return Self.alignedWith(store, w) ? .aligned : .ahead
    }
}

/// `fs` is the WITNESS Fs, never the store Fs unless the caller deliberately
/// passes the weak same-domain configuration.
public func witnessFor(fs: Fs, kind: WitnessKind) -> Witness {
    kind == .local ? LocalWitness(fs: fs) : NoneWitness()
}
