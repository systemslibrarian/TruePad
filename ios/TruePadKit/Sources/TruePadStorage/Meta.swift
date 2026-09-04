import Foundation
import TruePadCore

/* ============================================================================
 * The iOS-product bookkeeping ABOUT a pad, which is not part of the pad.
 *
 * None of these files is Store Format v2 and none travels in the six-file
 * courier bundle: they are this installation's record of its own acts. Twin of
 * Android's Meta.kt and of the browser-only files in src/browser/engine.
 *
 *   <pairId>/pair.json        witness kind + provenance + display metadata
 *   <pairId>/destroyed.json   the §17 tombstone — the irreversible boundary
 *   <pairId>/importing.json   the import commit gate
 *   <pairId>/handoff.json     the one-handoff record; EXISTENCE is load-bearing
 * ========================================================================= */

public let pairMetaFile = "pair.json"
public let tombstoneFile = "destroyed.json"
public let importMarkerFile = "importing.json"
public let handoffMarkerFile = "handoff.json"
public let stagingRoot = "importing"

public func pairMetaPath(_ pairId: String) -> String { "\(pairId)/\(pairMetaFile)" }
public func tombstonePath(_ pairId: String) -> String { "\(pairId)/\(tombstoneFile)" }
public func importMarkerPath(_ pairId: String) -> String { "\(pairId)/\(importMarkerFile)" }
public func handoffMarkerPath(_ pairId: String) -> String { "\(pairId)/\(handoffMarkerFile)" }
public func stagingDir(_ pairId: String) -> String { "\(stagingRoot)/\(pairId)" }

// MARK: - provenance

/// WHERE A PAD CAME FROM, recorded by the installation about ITSELF.
///
/// pair.json is iOS-local and is NOT one of the six courier files, so a sender
/// cannot put a chosen origin into a bundle and have the importer believe it.
///
///   generatedHere -> may perform the first software-mediated handoff
///   imported      -> may NEVER export onward
///   unknown       -> legacy: an absent field. NEVER written to disk, never
///                    backfilled, never inferred from counters or from whether
///                    the pad happens to sit at genesis. The absence of the field
///                    is information: it means nobody recorded this, and guessing
///                    in the direction that permits forwarding is exactly how a
///                    pad ends up in two hands.
///
/// A field that is PRESENT but unrecognised is corruption and fails closed, the
/// same way an unrecognised `witness` does. A MISSING field is legacy.
public enum PairOrigin: Sendable, Equatable {
    case generatedHere
    case imported
    case unknown

    public var wire: String? {
        switch self {
        case .generatedHere: return "generated-here"
        case .imported: return "imported"
        case .unknown: return nil
        }
    }

    public static func fromWire(_ s: String) -> PairOrigin? {
        switch s {
        case "generated-here": return .generatedHere
        case "imported": return .imported
        default: return nil
        }
    }
}

public struct PairMeta: Sendable, Equatable {
    public let pairId: String
    public let label: String
    public let createdAt: String
    public let witness: WitnessKind
    public let origin: PairOrigin

    public init(pairId: String, label: String, createdAt: String,
                witness: WitnessKind, origin: PairOrigin) {
        self.pairId = pairId
        self.label = label
        self.createdAt = createdAt
        self.witness = witness
        self.origin = origin
    }
}

/// Read pair.json.
///
/// Its `witness` field is LOAD-BEARING: it says whether a rollback witness
/// applies, so a present-but-corrupt pair.json fails CLOSED rather than silently
/// defaulting to no-witness, which would bypass a provisioned witness. A pair
/// with NO pair.json is a bare FORMAT-V2 store this app never provisioned (a CLI
/// store copied in, say): no witness, defaulted display fields, unknown origin.
public func readPairMeta(fs: Fs, pairId: String) throws -> PairMeta {
    // A read that THROWS is not absence — see the Fs.readFile contract. Only a
    // definitively missing file is the legacy no-metadata case.
    guard let bytes = try fs.readFile(pairMetaPath(pairId)) else {
        return PairMeta(pairId: pairId, label: pairId, createdAt: "",
                        witness: .none, origin: .unknown)
    }
    guard let text = String(bytes: bytes, encoding: .utf8),
          let parsed = try? parseStrictJson(text) else {
        throw EngineRefused(
            reason: "corrupt-pair-meta",
            message: "\(pairMetaFile) for \(pairId) does not parse as JSON, so TruePad cannot tell "
                + "whether this pair carries a rollback witness. It fails closed rather than assume "
                + "none. Nothing was touched.")
    }
    let members = parsed.memberMap
    guard case .string(let witnessWire)? = members?["witness"],
          let witness = WitnessKind(rawValue: witnessWire) else {
        throw EngineRefused(
            reason: "corrupt-pair-meta",
            message: "\(pairMetaFile) for \(pairId) has no recognised witness kind. It fails closed "
                + "rather than guess whether a rollback witness applies. Nothing was touched.")
    }
    // Provenance is load-bearing in the same way `witness` is: a value we do not
    // recognise means we cannot tell where this pad came from, and the safe
    // reading of "cannot tell" is not "it was made here".
    let origin: PairOrigin
    if let originValue = members?["origin"] {
        guard case .string(let wire) = originValue, let parsedOrigin = PairOrigin.fromWire(wire) else {
            throw EngineRefused(
                reason: "corrupt-pair-meta",
                message: "\(pairMetaFile) for \(pairId) has an unrecognised origin. It fails closed "
                    + "rather than guess whether this pad was generated here or arrived from "
                    + "elsewhere. Nothing was touched.")
        }
        origin = parsedOrigin
    } else {
        origin = .unknown   // MISSING is legacy, not corruption
    }
    var label = pairId
    if case .string(let l)? = members?["label"] { label = l }
    var createdAt = ""
    if case .string(let c)? = members?["createdAt"] { createdAt = c }
    return PairMeta(pairId: pairId, label: label, createdAt: createdAt,
                    witness: witness, origin: origin)
}

/// Write pair.json. `origin` must be one of the two real values — never unknown.
public func writePairMeta(fs: Fs, meta: PairMeta) throws {
    guard let wire = meta.origin.wire else {
        throw EngineRefused(
            reason: "internal-unknown-origin",
            message: "pair.json never serializes an unknown origin; it is an in-memory state only.")
    }
    var s = "{\"pairId\":"
    appendJsonString(&s, meta.pairId)
    s.append(",\"label\":"); appendJsonString(&s, meta.label)
    s.append(",\"createdAt\":"); appendJsonString(&s, meta.createdAt)
    s.append(",\"witness\":"); appendJsonString(&s, meta.witness.rawValue)
    s.append(",\"origin\":"); appendJsonString(&s, wire)
    s.append("}")
    try fs.writeFileAtomic(pairMetaPath(meta.pairId), Array(s.utf8))
}

// MARK: - the tombstone (§17.3)

/// The verbatim §17 sentence — identical in the tombstone and the UI.
public let destroyLimitation =
    "Software can forget its reference to pad material; it cannot prove that flash forgot the bytes."

public let unreadablePairToken = "destroy-unreadable-pair"

public struct ExistingTombstone: Sendable, Equatable {
    public let exists: Bool
    public let pairId: String?
    public let wellFormed: Bool
}

/// Read the tombstone WITHOUT letting any failure become absence.
///
/// A read that throws — a directory, a dangling symlink, an I/O error at the
/// marker path — is `exists: true`, because the one thing a torn terminal marker
/// can mean is that this pair was destroyed. Only a definitively missing file is
/// absence. See TerminalMarkerFailClosedTests.
public func readTombstone(fs: Fs, pairId: String) -> ExistingTombstone {
    let bytes: [UInt8]?
    do {
        bytes = try fs.readFile(tombstonePath(pairId))
    } catch {
        return ExistingTombstone(exists: true, pairId: nil, wellFormed: false)
    }
    guard let bytes else { return ExistingTombstone(exists: false, pairId: nil, wellFormed: false) }
    if let text = String(bytes: bytes, encoding: .utf8),
       let parsed = try? parseStrictJson(text),
       let members = parsed.memberMap {
        var id: String?
        if case .string(let s)? = members["pairId"], isHex32(s) { id = s }
        var wellFormed = false
        if case .number(let raw)? = members["formatVersion"], raw == "2" { wellFormed = true }
        return ExistingTombstone(exists: true, pairId: id, wellFormed: wellFormed)
    }
    // Unparseable tombstone: the boundary stands, and destroy rewrites a clean one.
    return ExistingTombstone(exists: true, pairId: nil, wellFormed: false)
}

public struct HighWaters: Sendable, Equatable {
    public let nextOffset: Int
    public let nextSequence: Int

    public init(nextOffset: Int, nextSequence: Int) {
        self.nextOffset = nextOffset
        self.nextSequence = nextSequence
    }
}

/// The §17.2 step-2 tombstone: durable, and it survives the destruction. Two
/// spaces of indentation, matching the released `JSON.stringify(t, null, 2)`.
public func writeTombstone(fs: Fs, pairId: String, resolvedPairId: String?,
                           destroyedAt: String, reason: String,
                           ab: HighWaters?, ba: HighWaters?) throws {
    func hw(_ out: inout String, _ h: HighWaters?, _ indent: String) {
        guard let h else { out.append("null"); return }
        out.append("{\n\(indent)  \"nextOffset\": \(h.nextOffset)")
        out.append(",\n\(indent)  \"nextSequence\": \(h.nextSequence)")
        out.append("\n\(indent)}")
    }
    var s = "{\n  \"formatVersion\": 2,\n  \"pairId\": "
    if let resolvedPairId { appendJsonString(&s, resolvedPairId) } else { s.append("null") }
    s.append(",\n  \"destroyedAt\": "); appendJsonString(&s, destroyedAt)
    s.append(",\n  \"reason\": "); appendJsonString(&s, reason)
    s.append(",\n  \"finalHighWaters\": {\n    \"A->B\": ")
    hw(&s, ab, "    ")
    s.append(",\n    \"B->A\": ")
    hw(&s, ba, "    ")
    s.append("\n  },\n  \"limitation\": ")
    appendJsonString(&s, destroyLimitation)
    s.append("\n}")
    try fs.writeFileAtomic(tombstonePath(pairId), Array(s.utf8))
}

// MARK: - the one-handoff record

/*
 * A pad may leave this installation ONCE. THE RULE THAT MATTERS MOST: EXISTENCE
 * IS LOAD-BEARING. If handoff.json exists but is empty, truncated, malformed,
 * semantically invalid, or merely unreadable, that is NOT "no handoff" — it is
 * unreadableSpent. The file is never auto-deleted, never auto-repaired, and never
 * treated as absence, because the one thing a torn marker can mean is that a copy
 * already left.
 *
 *     LOSS IS ACCEPTABLE. REUSE IS NOT.
 *
 * There is deliberately no "catch and return absent" anywhere in this section.
 */

public let refuseUnreadable = "handoff-state-unreadable"
public let refuseAlreadySealed = "pad-already-sealed"

/// The one sentence the operator gets about a torn marker. It says what TruePad
/// does not know and what it therefore will not do — and deliberately does not
/// suggest deleting the file, because deleting it is exactly the action that
/// would turn a lost handoff into a reused pad.
public let unreadableAdvice =
    "TruePad cannot safely determine this pad's handoff state, so it refuses to create another copy. "
    + "A record of a handoff exists but cannot be read. Generate a new pad for any further transfer."

public enum HandoffState: Sendable, Equatable {
    case absent
    case physical(at: String)
    case sealed(at: String)
    /// The file exists and cannot be trusted. NOT absence.
    case unreadableSpent(message: String)
}

private let markerVersion = 1
private let physicalKeys = ["version", "pairId", "mode", "at"]
private let sealedKeys = ["version", "pairId", "mode", "at",
                          "requestHash", "packageIdentity", "confirmHash"]

struct MarkerRejected: Error { let why: String }

/// The exact `YYYY-MM-DDTHH:mm:ss.sssZ` form, checked by ROUND-TRIP so no other
/// spelling of the same instant is accepted.
private func requireIsoTimestamp(_ value: String?) throws -> String {
    guard let value else { throw MarkerRejected(why: "at is not a string") }
    guard let instant = parseIsoInstant(value), isoNow(instant) == value else {
        throw MarkerRejected(why: "at is not a canonical ISO-8601 timestamp")
    }
    return value
}

/// Strict parse. Every failure throws; NOTHING here defaults, coerces, or
/// tolerates an extra field. A reader that shrugged at an unexpected key would be
/// a reader that could be handed a physical marker wearing sealed clothes.
func parseHandoffMarker(_ bytes: [UInt8], pairId: String) throws -> HandoffState {
    if bytes.isEmpty { throw MarkerRejected(why: "the handoff marker is empty") }
    guard let text = String(bytes: bytes, encoding: .utf8),
          let parsed = try? parseStrictJson(text) else {
        throw MarkerRejected(why: "the handoff marker does not parse as JSON")
    }
    guard let members = parsed.memberMap, let keys = parsed.memberKeys else {
        throw MarkerRejected(why: "the handoff marker is not a JSON object")
    }
    guard case .number(let version)? = members["version"], version == String(markerVersion) else {
        throw MarkerRejected(why: "unsupported handoff marker version")
    }
    guard case .string(let id)? = members["pairId"], isHex32(id) else {
        throw MarkerRejected(why: "the handoff marker has no valid pairId")
    }
    guard id == pairId else { throw MarkerRejected(why: "the handoff marker names a different pair") }
    guard case .string(let mode)? = members["mode"], mode == "physical" || mode == "sealed" else {
        throw MarkerRejected(why: "the handoff marker has an unsupported mode")
    }
    var at = ""
    if case .string(let raw)? = members["at"] { at = try requireIsoTimestamp(raw) } else {
        _ = try requireIsoTimestamp(nil)
    }
    // Catches BOTH a physical marker carrying sealed-only fields and a sealed
    // marker missing one.
    let expected = mode == "sealed" ? sealedKeys : physicalKeys
    guard keys.sorted() == expected.sorted() else {
        throw MarkerRejected(why: "the handoff marker's fields do not match mode \(mode)")
    }
    return mode == "physical" ? .physical(at: at) : .sealed(at: at)
}

public func readHandoffState(fs: Fs, pairId: String) -> HandoffState {
    // The READ itself is wrapped, not just the parse. `absent` is the one state
    // that permits a second handoff, so anything that is present-but-unreadable —
    // a directory or other non-regular file at the marker path, an I/O failure —
    // must land on unreadableSpent. Only a genuinely absent path is absent.
    let bytes: [UInt8]?
    do {
        bytes = try fs.readFile(handoffMarkerPath(pairId))
    } catch {
        return .unreadableSpent(message: "\(unreadableAdvice) (\(error))")
    }
    guard let bytes else { return .absent }
    do {
        return try parseHandoffMarker(bytes, pairId: pairId)
    } catch let e as MarkerRejected {
        return .unreadableSpent(message: "\(unreadableAdvice) (\(e.why))")
    } catch {
        return .unreadableSpent(message: "\(unreadableAdvice) (\(error))")
    }
}

/// Serialize with the frozen property order, built from an ordered append rather
/// than a dictionary so the order is a fact of the code.
public func commitPhysicalHandoff(fs: Fs, pairId: String, at: String) throws {
    var s = "{\"version\":\(markerVersion),\"pairId\":"
    appendJsonString(&s, pairId)
    s.append(",\"mode\":\"physical\",\"at\":")
    appendJsonString(&s, at)
    s.append("}")
    try fs.writeFileAtomic(handoffMarkerPath(pairId), Array(s.utf8))
}

// MARK: - timestamps

/// The exact `YYYY-MM-DDTHH:mm:ss.sssZ` spelling `new Date().toISOString()`
/// emits.
///
/// The arithmetic lives in `TruePadCore.IsoTime` — dependency-free, and shared
/// with the SPT durable records — so there is ONE implementation to disagree
/// with itself. This is only the `Date` boundary.
public func isoNow(_ date: Date) -> String {
    // NEAREST, not floor. `Date` holds seconds as a Double, so a value built from
    // an integer number of milliseconds does not multiply back exactly: -0.001 s
    // becomes -1.0000000000000002 ms, and flooring that yields -2 — one
    // millisecond in the past, and a timestamp that no longer round-trips.
    IsoTime.format(epochMillis: Int((date.timeIntervalSince1970 * 1000).rounded()))
}

/// Parse exactly the canonical spelling and nothing else.
func parseIsoInstant(_ text: String) -> Date? {
    guard let millis = IsoTime.parseMillis(text) else { return nil }
    return Date(timeIntervalSince1970: Double(millis) / 1000.0)
}
