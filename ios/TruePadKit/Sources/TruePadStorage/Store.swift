/* ============================================================================
 * One v2 direction store over the Fs — the Swift twin of
 * android/truepad-storage Store.kt, src/browser/engine/store.ts and
 * src/cli/v2/store2.ts.
 *
 * The SAME frozen Store Format v2: the SAME three files per direction, the SAME
 * canonical JSON bytes, the SAME §12.1 reconciliation and §12.4 write order.
 * head.json is serialized byte-identically to the other editions — compact JSON,
 * canonical key order — so a Browser or CLI store is readable here and a store
 * written here is readable there.
 *
 * Only destruction overwrites secret.bin; retirement is LOGICAL — the counters
 * decide liveness, not the content.
 * ========================================================================= */

import Foundation
import TruePadCore

public let headFile = "head.json"
public let secretFile = "secret.bin"
public let journalFile = "journal.log"
let v1PadFile = "pad.json"
let keyBytes = 16

public let directionSubdirectory: [PadDirection: String] = [
    .aToB: "a-to-b",
    .bToA: "b-to-a",
]

let maxSafeInteger = 9_007_199_254_740_991

/// Public so tests and callers can name the three store files without
/// re-deriving the layout.
public func storePath(_ prefix: String, _ name: String) -> String { "\(prefix)/\(name)" }

// ---- header shape (§1.1) ---------------------------------------------------

public struct SourceDeclaration: Sendable, Equatable {
    public let name: String
    public let declaredOrigin: String
    public let lengthBytes: Int

    public init(name: String, declaredOrigin: String, lengthBytes: Int) {
        self.name = name
        self.declaredOrigin = declaredOrigin
        self.lengthBytes = lengthBytes
    }
}

public enum RecordSpec: Sendable, Equatable {
    case variable
    case fixed(bytes: Int)
}

public struct HeadV2: Sendable, Equatable {
    public var pairId: String
    public var direction: PadDirection
    public var sourceDeclarations: [SourceDeclaration]
    public var capacity: Int
    public var nextOffset: Int
    public var capacityRecords: Int
    public var nextSequence: Int
    public var verifyAttemptLimit: Int
    public var maxAuthLookahead: Int
    public var record: RecordSpec
    public var failureThreshold: Int
    public var failureCount: Int
    public var clearedAtFailureCount: Int
    /// Sequence number (as a decimal string) -> attempts. Ordered by the
    /// JavaScript property-order rule at serialization time, never by insertion.
    public var perSequenceAttempts: [String: Int]

    public init(pairId: String, direction: PadDirection, sourceDeclarations: [SourceDeclaration],
                capacity: Int, nextOffset: Int, capacityRecords: Int, nextSequence: Int,
                verifyAttemptLimit: Int, maxAuthLookahead: Int, record: RecordSpec,
                failureThreshold: Int, failureCount: Int, clearedAtFailureCount: Int,
                perSequenceAttempts: [String: Int]) {
        self.pairId = pairId
        self.direction = direction
        self.sourceDeclarations = sourceDeclarations
        self.capacity = capacity
        self.nextOffset = nextOffset
        self.capacityRecords = capacityRecords
        self.nextSequence = nextSequence
        self.verifyAttemptLimit = verifyAttemptLimit
        self.maxAuthLookahead = maxAuthLookahead
        self.record = record
        self.failureThreshold = failureThreshold
        self.failureCount = failureCount
        self.clearedAtFailureCount = clearedAtFailureCount
        self.perSequenceAttempts = perSequenceAttempts
    }
}

public struct EffectiveState: Sendable, Equatable {
    public let nextOffset: Int
    public let nextSequence: Int
    public let attempts: [Int: Int]
    /// Count of `attempt` journal lines — the monotone quantity the rollback
    /// witness records, so a restore cannot refill the per-record attempt budget.
    public let attemptsReserved: Int
    public let failureCount: Int
    public let clearedAtFailureCount: Int
}

public struct LoadedStore: Sendable {
    public let head: HeadV2
    public let effective: EffectiveState
}

public enum LoadResult: Sendable {
    case ok(LoadedStore)
    case refused(reason: String, message: String)
}

// ---- JSON string escaping matching JSON.stringify (byte-exact interop) ------

/// Escape exactly as `JSON.stringify` does, so head.json bytes match the other
/// editions.
///
/// The Kotlin twin additionally handles unpaired surrogates, which UTF-16
/// strings can hold. A Swift `String` cannot represent one at all — the type is
/// validated Unicode — so that branch has no analogue here. The hazard is not
/// ignored: it is moved to the READER, where `parseStrictJson` refuses a lone
/// surrogate escape outright rather than substituting a replacement character
/// and later re-serializing different bytes.
func appendJsonString(_ out: inout String, _ s: String) {
    let hexDigits = Array("0123456789abcdef")
    out.append("\"")
    for scalar in s.unicodeScalars {
        switch scalar {
        case "\"": out.append("\\\"")
        case "\\": out.append("\\\\")
        case "\u{08}": out.append("\\b")
        case "\u{0C}": out.append("\\f")
        case "\n": out.append("\\n")
        case "\r": out.append("\\r")
        case "\t": out.append("\\t")
        default:
            if scalar.value < 0x20 {
                out.append("\\u00")
                out.append(hexDigits[Int((scalar.value >> 4) & 0xF)])
                out.append(hexDigits[Int(scalar.value & 0xF)])
            } else {
                // >= 0x20 and non-ASCII emitted literally, as JSON.stringify does.
                out.unicodeScalars.append(scalar)
            }
        }
    }
    out.append("\"")
}

/// JavaScript object property order is NOT insertion order for keys that look
/// like array indices: an integer-like key in [0, 2^32-2] is emitted FIRST, in
/// ascending NUMERIC order, before any other key. So `JSON.stringify` of
/// `{"12":1,"5":2,"3":1}` is `{"3":1,"5":2,"12":1}`, whatever order the other
/// editions happened to insert them in.
///
/// `perSequenceAttempts` is the only map in head.json with operator-influenced
/// keys, and its keys are sequence numbers. Any out-of-order authentication
/// failure inside the 64-record lookahead window would otherwise produce a
/// head.json that is NOT byte-identical to the one the CLI and Browser write —
/// falsifying this file's headline claim. Sorting here makes the output
/// canonical regardless of the order the failures actually arrived in.
///
/// A sequence at or above 2^32-1 is not an array index in JavaScript and keeps
/// insertion order there. Such a store would need over four billion
/// authentication records — 128 GiB of authentication material in one direction
/// — so it is unreachable; those keys are emitted last, sorted, which is the
/// closest faithful reading available without an insertion order to preserve.
let maxArrayIndex = 4_294_967_294

func jsPropertyOrder(_ map: [String: Int]) -> [(key: String, value: Int)] {
    var indexKeys: [(key: String, value: Int)] = []
    var stringKeys: [(key: String, value: Int)] = []
    for key in map.keys {
        let n = isCanonicalDecimal(key) ? Int(key) : nil
        if let n, n <= maxArrayIndex {
            indexKeys.append((key: key, value: map[key]!))
        } else {
            stringKeys.append((key: key, value: map[key]!))
        }
    }
    indexKeys.sort { (Int($0.key) ?? 0) < (Int($1.key) ?? 0) }
    stringKeys.sort { $0.key < $1.key }
    return indexKeys + stringKeys
}

func isCanonicalDecimal(_ s: String) -> Bool {
    if s.isEmpty { return false }
    if s == "0" { return true }
    let bytes = Array(s.utf8)
    guard bytes[0] >= 0x31, bytes[0] <= 0x39 else { return false }
    return bytes.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
}

func isHex32(_ s: String) -> Bool {
    let bytes = Array(s.utf8)
    guard bytes.count == 32 else { return false }
    return bytes.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
}

/// Serialize a head to the EXACT compact JSON bytes the other editions emit.
public func serializeHead(_ h: HeadV2) -> [UInt8] {
    var s = ""
    s.reserveCapacity(512)
    s.append("{\"formatVersion\":2,\"pairId\":")
    appendJsonString(&s, h.pairId)
    s.append(",\"direction\":")
    appendJsonString(&s, h.direction.rawValue)
    s.append(",\"mode\":\"bytes\",\"sourceDeclarations\":[")
    for (i, d) in h.sourceDeclarations.enumerated() {
        if i > 0 { s.append(",") }
        s.append("{\"name\":")
        appendJsonString(&s, d.name)
        s.append(",\"declaredOrigin\":")
        appendJsonString(&s, d.declaredOrigin)
        s.append(",\"lengthBytes\":\(d.lengthBytes)}")
    }
    s.append("],\"encryption\":{\"capacity\":\(h.capacity),\"nextOffset\":\(h.nextOffset)},")
    s.append("\"authentication\":{\"profile\":\"wc-one-time-v1\",\"tagBits\":128,")
    s.append("\"capacityRecords\":\(h.capacityRecords),\"nextSequence\":\(h.nextSequence),")
    s.append("\"verifyAttemptLimit\":\(h.verifyAttemptLimit),")
    s.append("\"maxCiphertextBytes\":\(WcOneTime.maxCiphertextBytes),")
    s.append("\"maxAuthLookahead\":\(h.maxAuthLookahead)},")
    s.append("\"recordPolicy\":{\"authenticated\":\"required\",\"downgradeAllowed\":false,\"record\":")
    switch h.record {
    case .variable: s.append("{\"kind\":\"variable\"}")
    case .fixed(let bytes): s.append("{\"kind\":\"fixed\",\"bytes\":\(bytes)}")
    }
    s.append("},\"rollback\":{\"witnessClass\":\"none\",\"config\":{}},")
    s.append("\"verification\":{\"failurePolicy\":{\"kind\":\"freeze\",")
    s.append("\"threshold\":\(h.failureThreshold)},\"failureCount\":\(h.failureCount),")
    s.append("\"clearedAtFailureCount\":\(h.clearedAtFailureCount),\"perSequenceAttempts\":{")
    var first = true
    for entry in jsPropertyOrder(h.perSequenceAttempts) {
        if !first { s.append(",") }
        first = false
        appendJsonString(&s, entry.key)
        s.append(":\(entry.value)")
    }
    s.append("}}}")
    return Array(s.utf8)
}
