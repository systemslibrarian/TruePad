/* ============================================================================
 * head.json validation, journal reconciliation (§12.1), and the durable
 * transitions of §12.4. The second half of the Store twin.
 *
 * A header is refused WHOLE rather than partially trusted, and a journal that is
 * malformed anywhere is refused rather than read up to the damage. The one
 * concession is the diagnosis: a malformed LAST line is named as the crash
 * signature, because that is the shape a crash actually leaves, and telling an
 * operator to remove exactly that line is different advice from telling them the
 * store is corrupt.
 * ========================================================================= */

import Foundation
import TruePadCore

// ---- header validation (§1.1) ----------------------------------------------

struct HeadValidation {
    let head: HeadV2?
    let why: String?
}

/// A non-negative safe integer, in the ONE canonical decimal spelling.
///
/// The TypeScript twin is `Number.isSafeInteger(value) && value >= 0`, which —
/// because JSON.parse has already folded `2.0` and `2e0` into the number 2 —
/// accepts those spellings too. This refuses them, exactly as the Kotlin twin
/// does: no shipping writer emits one, so the only inputs affected are
/// hand-edited headers, and for those the strict reading fails CLOSED.
func isSafeCount(_ v: JsonValue?) -> Bool {
    guard case .number(let raw)? = v, isCanonicalDecimal(raw), let n = Int(raw) else { return false }
    return n >= 0 && n <= maxSafeInteger
}

func asInt(_ v: JsonValue?) -> Int {
    guard case .number(let raw)? = v, let n = Int(raw) else { return 0 }
    return n
}

func keyMismatch(_ members: [String: JsonValue], _ expected: [String]) -> String? {
    let missing = expected.filter { members[$0] == nil }
    let extra = members.keys.filter { !expected.contains($0) }.sorted()
    if missing.isEmpty && extra.isEmpty { return nil }
    var parts: [String] = []
    if !missing.isEmpty { parts.append("missing \(missing.joined(separator: ", "))") }
    if !extra.isEmpty { parts.append("unexpected \(extra.joined(separator: ", "))") }
    return parts.joined(separator: "; ")
}

func validateHead(_ raw: JsonValue) -> HeadValidation {
    guard let top = raw.memberMap else { return HeadValidation(head: nil, why: "not a JSON object") }
    let topKeys = ["formatVersion", "pairId", "direction", "mode", "sourceDeclarations",
                   "encryption", "authentication", "recordPolicy", "rollback", "verification"]
    if let why = keyMismatch(top, topKeys) {
        return HeadValidation(head: nil, why: "top-level keys: \(why)")
    }
    guard case .number(let fv)? = top["formatVersion"], fv == "2" else {
        return HeadValidation(head: nil, why: "formatVersion must be the integer 2")
    }
    guard case .string(let pairId)? = top["pairId"], isHex32(pairId) else {
        return HeadValidation(head: nil, why: "pairId must be exactly 32 lowercase hex characters")
    }
    guard case .string(let directionText)? = top["direction"],
          let direction = PadDirection.fromWire(directionText) else {
        return HeadValidation(head: nil, why: "direction must be \"A->B\" or \"B->A\"")
    }
    guard case .string(let mode)? = top["mode"], mode == "bytes" else {
        return HeadValidation(head: nil, why: "mode must be \"bytes\"")
    }

    guard case .array(let sdItems)? = top["sourceDeclarations"] else {
        return HeadValidation(head: nil, why: "sourceDeclarations must be an array")
    }
    var sourceDeclarations: [SourceDeclaration] = []
    for (i, item) in sdItems.enumerated() {
        guard let e = item.memberMap else {
            return HeadValidation(head: nil, why: "sourceDeclarations[\(i)] is not an object")
        }
        if let why = keyMismatch(e, ["name", "declaredOrigin", "lengthBytes"]) {
            return HeadValidation(head: nil, why: "sourceDeclarations[\(i)]: \(why)")
        }
        guard case .string(let name)? = e["name"],
              case .string(let origin)? = e["declaredOrigin"],
              isSafeCount(e["lengthBytes"]) else {
            return HeadValidation(head: nil, why: "sourceDeclarations[\(i)] fields are malformed")
        }
        sourceDeclarations.append(SourceDeclaration(name: name, declaredOrigin: origin,
                                                    lengthBytes: asInt(e["lengthBytes"])))
    }

    guard let enc = top["encryption"]?.memberMap else {
        return HeadValidation(head: nil, why: "encryption is not an object")
    }
    if let why = keyMismatch(enc, ["capacity", "nextOffset"]) {
        return HeadValidation(head: nil, why: "encryption: \(why)")
    }
    guard isSafeCount(enc["capacity"]), isSafeCount(enc["nextOffset"]) else {
        return HeadValidation(head: nil, why: "encryption.capacity/nextOffset must be safe integers >= 0")
    }
    let capacity = asInt(enc["capacity"])
    let nextOffset = asInt(enc["nextOffset"])
    guard nextOffset <= capacity else {
        return HeadValidation(head: nil, why: "encryption.nextOffset exceeds capacity")
    }

    guard let auth = top["authentication"]?.memberMap else {
        return HeadValidation(head: nil, why: "authentication is not an object")
    }
    if let why = keyMismatch(auth, ["profile", "tagBits", "capacityRecords", "nextSequence",
                                    "verifyAttemptLimit", "maxCiphertextBytes", "maxAuthLookahead"]) {
        return HeadValidation(head: nil, why: "authentication: \(why)")
    }
    guard case .string(let profile)? = auth["profile"], profile == "wc-one-time-v1" else {
        return HeadValidation(head: nil, why: "authentication.profile must be wc-one-time-v1")
    }
    guard case .number(let tagBits)? = auth["tagBits"], tagBits == "128" else {
        return HeadValidation(head: nil, why: "authentication.tagBits must be 128")
    }
    guard isSafeCount(auth["capacityRecords"]), isSafeCount(auth["nextSequence"]) else {
        return HeadValidation(head: nil, why: "capacityRecords/nextSequence must be safe integers >= 0")
    }
    let capacityRecords = asInt(auth["capacityRecords"])
    let nextSequence = asInt(auth["nextSequence"])
    guard nextSequence <= capacityRecords else {
        return HeadValidation(head: nil, why: "authentication.nextSequence exceeds capacityRecords")
    }
    guard isSafeCount(auth["verifyAttemptLimit"]), isSafeCount(auth["maxAuthLookahead"]) else {
        return HeadValidation(head: nil, why: "verifyAttemptLimit/maxAuthLookahead must be safe integers >= 0")
    }
    guard case .number(let maxCt)? = auth["maxCiphertextBytes"],
          maxCt == String(WcOneTime.maxCiphertextBytes) else {
        return HeadValidation(head: nil,
                              why: "authentication.maxCiphertextBytes must equal \(WcOneTime.maxCiphertextBytes)")
    }

    guard let rp = top["recordPolicy"]?.memberMap else {
        return HeadValidation(head: nil, why: "recordPolicy is not an object")
    }
    let policyKeys = rp["record"] != nil
        ? ["authenticated", "downgradeAllowed", "record"]
        : ["authenticated", "downgradeAllowed"]
    if let why = keyMismatch(rp, policyKeys) {
        return HeadValidation(head: nil, why: "recordPolicy: \(why)")
    }
    guard case .string(let authenticated)? = rp["authenticated"], authenticated == "required",
          case .bool(let downgrade)? = rp["downgradeAllowed"], downgrade == false else {
        return HeadValidation(head: nil,
                              why: "recordPolicy.authenticated must be required and downgradeAllowed false")
    }
    var record: RecordSpec = .variable
    if let recordValue = rp["record"] {
        guard let rr = recordValue.memberMap else {
            return HeadValidation(head: nil, why: "recordPolicy.record is not an object")
        }
        guard case .string(let kind)? = rr["kind"] else {
            return HeadValidation(head: nil, why: "recordPolicy.record.kind must be variable or fixed")
        }
        switch kind {
        case "variable":
            if let why = keyMismatch(rr, ["kind"]) {
                return HeadValidation(head: nil, why: "recordPolicy.record: \(why)")
            }
            record = .variable
        case "fixed":
            if let why = keyMismatch(rr, ["kind", "bytes"]) {
                return HeadValidation(head: nil, why: "recordPolicy.record: \(why)")
            }
            guard isSafeCount(rr["bytes"]) else {
                return HeadValidation(head: nil, why: "recordPolicy.record.bytes malformed")
            }
            let bytes = asInt(rr["bytes"])
            guard bytes >= 32, bytes <= WcOneTime.maxCiphertextBytes, bytes % 16 == 0 else {
                return HeadValidation(head: nil,
                                      why: "recordPolicy.record.bytes must be a multiple of 16 with "
                                          + "32 <= F <= \(WcOneTime.maxCiphertextBytes)")
            }
            record = .fixed(bytes: bytes)
        default:
            return HeadValidation(head: nil, why: "recordPolicy.record.kind must be variable or fixed")
        }
    }

    guard let rb = top["rollback"]?.memberMap else {
        return HeadValidation(head: nil, why: "rollback is not an object")
    }
    if let why = keyMismatch(rb, ["witnessClass", "config"]) {
        return HeadValidation(head: nil, why: "rollback: \(why)")
    }
    guard let cfg = rb["config"]?.memberMap else {
        return HeadValidation(head: nil, why: "rollback.config is not an object")
    }
    // The frozen head carries EXACTLY { witnessClass:"none", config:{} }. A store
    // whose frozen witness class this edition cannot honour is REFUSED, never
    // downgraded — the iOS rollback witness lives outside the frozen store, as
    // Android's does.
    guard case .string(let witnessClass)? = rb["witnessClass"], witnessClass == "none" else {
        return HeadValidation(head: nil,
                              why: "rollback.witnessClass must be \"none\": this edition keeps its rollback "
                                  + "witness outside the frozen store; a frozen witness class it cannot "
                                  + "honour is refused, not downgraded")
    }
    guard cfg.isEmpty else {
        return HeadValidation(head: nil, why: "rollback.config must be {} for witnessClass none")
    }

    guard let ver = top["verification"]?.memberMap else {
        return HeadValidation(head: nil, why: "verification is not an object")
    }
    if let why = keyMismatch(ver, ["failurePolicy", "failureCount", "clearedAtFailureCount",
                                   "perSequenceAttempts"]) {
        return HeadValidation(head: nil, why: "verification: \(why)")
    }
    guard let fp = ver["failurePolicy"]?.memberMap else {
        return HeadValidation(head: nil, why: "verification.failurePolicy is not an object")
    }
    if let why = keyMismatch(fp, ["kind", "threshold"]) {
        return HeadValidation(head: nil, why: "verification.failurePolicy: \(why)")
    }
    guard case .string(let fpKind)? = fp["kind"], fpKind == "freeze", isSafeCount(fp["threshold"]) else {
        return HeadValidation(head: nil,
                              why: "verification.failurePolicy must be { kind:freeze, threshold:>=0 }")
    }
    guard isSafeCount(ver["failureCount"]), isSafeCount(ver["clearedAtFailureCount"]) else {
        return HeadValidation(head: nil,
                              why: "failureCount/clearedAtFailureCount must be safe integers >= 0")
    }
    guard let psa = ver["perSequenceAttempts"]?.memberMap else {
        return HeadValidation(head: nil, why: "verification.perSequenceAttempts is not an object")
    }
    var perSequence: [String: Int] = [:]
    for (k, v) in psa {
        guard isCanonicalDecimal(k), isSafeCount(v) else {
            return HeadValidation(head: nil,
                                  why: "perSequenceAttempts[\(k)] must map a decimal sequence to a "
                                      + "safe integer >= 0")
        }
        perSequence[k] = asInt(v)
    }

    return HeadValidation(head: HeadV2(
        pairId: pairId, direction: direction, sourceDeclarations: sourceDeclarations,
        capacity: capacity, nextOffset: nextOffset,
        capacityRecords: capacityRecords, nextSequence: nextSequence,
        verifyAttemptLimit: asInt(auth["verifyAttemptLimit"]),
        maxAuthLookahead: asInt(auth["maxAuthLookahead"]),
        record: record, failureThreshold: asInt(fp["threshold"]),
        failureCount: asInt(ver["failureCount"]),
        clearedAtFailureCount: asInt(ver["clearedAtFailureCount"]),
        perSequenceAttempts: perSequence), why: nil)
}

// ---- journal (§12.1) --------------------------------------------------------

struct JournalAggregates {
    var maxNextOffset = 0
    var maxNextSequence = 0
    var attemptCounts: [Int: Int] = [:]
    var attemptsReserved = 0
    var failureCount = 0
    var lastClearedAt = 0
}

enum JournalRead {
    case ok(JournalAggregates)
    case bad(reason: String, message: String)
}

func readJournal(_ text: String) -> JournalRead {
    var lines = text.components(separatedBy: "\n")
    if lines.last == "" { lines.removeLast() }
    var aggregates = JournalAggregates()
    for (index, line) in lines.enumerated() {
        let record = try? parseStrictJson(line)
        let members = record?.memberMap
        var op: String? = nil
        if case .string(let value)? = members?["op"] { op = value }
        if members == nil || op == nil || !applyJournal(&aggregates, members!, op!) {
            let isLast = index == lines.count - 1
            return .bad(
                reason: "corrupt-journal",
                message: isLast
                    ? "\(journalFile) ends in a malformed line — the crash signature. Remove only "
                        + "that last line and retry. Bad line: \(line)"
                    : "\(journalFile) holds a malformed record mid-file (line \(index + 1)); "
                        + "refusing. Bad line: \(line)")
        }
    }
    return .ok(aggregates)
}

func applyJournal(_ a: inout JournalAggregates, _ o: [String: JsonValue], _ op: String) -> Bool {
    func n(_ k: String) -> Int? {
        guard case .number(let raw)? = o[k], let v = Int(raw), v >= 0, v <= maxSafeInteger else {
            return nil
        }
        return v
    }
    func str(_ k: String) -> String? {
        guard case .string(let v)? = o[k] else { return nil }
        return v
    }

    switch op {
    case "init":
        guard str("pairId") != nil, let d = str("direction"), PadDirection.fromWire(d) != nil,
              n("capacity") != nil, n("capacityRecords") != nil else { return false }
        return true
    case "send":
        guard n("sequence") != nil, n("startOffset") != nil, n("consumed") != nil,
              let no = n("nextOffset"), let ns = n("nextSequence") else { return false }
        a.maxNextOffset = max(a.maxNextOffset, no)
        a.maxNextSequence = max(a.maxNextSequence, ns)
        return true
    case "attempt":
        guard let seq = n("sequence") else { return false }
        a.attemptCounts[seq, default: 0] += 1
        a.attemptsReserved += 1
        return true
    case "auth-fail":
        guard n("sequence") != nil, let fc = n("failureCount") else { return false }
        a.failureCount = max(a.failureCount + 1, fc)
        return true
    case "open":
        guard n("sequence") != nil, n("startOffset") != nil, n("consumed") != nil,
              n("skipped") != nil, let no = n("nextOffset"), let ns = n("nextSequence") else {
            return false
        }
        a.maxNextOffset = max(a.maxNextOffset, no)
        a.maxNextSequence = max(a.maxNextSequence, ns)
        return true
    case "retire":
        guard let ts = n("toSequence"), let to = n("toOffset"), str("reason") != nil else {
            return false
        }
        a.maxNextOffset = max(a.maxNextOffset, to)
        a.maxNextSequence = max(a.maxNextSequence, ts)
        return true
    case "clear-freeze":
        guard let at = n("atFailureCount") else { return false }
        a.lastClearedAt = at
        return true
    default:
        return false
    }
}

// ---- store lifecycle --------------------------------------------------------

public func secretLength(_ h: HeadV2) -> Int {
    h.capacity + WcOneTime.authRecordBytes * h.capacityRecords
}

public enum StoreError: Error, Equatable {
    case alreadyExists(String)
    case secretLengthMismatch(actual: Int, expected: Int)
    case outOfRange(String)
}

/// Write a fresh direction store: secret.bin durable FIRST, then head.json, then
/// the init line (§12.4). The order is the point — a crash between any two steps
/// leaves a state the loader refuses, never one it half-trusts.
public func initStore(fs: Fs, prefix: String, head: HeadV2, secret: [UInt8], at: String) throws {
    guard !fs.exists(storePath(prefix, headFile)) else {
        throw StoreError.alreadyExists("\(storePath(prefix, headFile)) already exists; "
                                       + "a v2 store is written once")
    }
    let expected = secretLength(head)
    guard secret.count == expected else {
        throw StoreError.secretLengthMismatch(actual: secret.count, expected: expected)
    }
    try fs.writeFileAtomic(storePath(prefix, secretFile), secret)
    try fs.writeFileAtomic(storePath(prefix, headFile), serializeHead(head))

    var line = "{\"op\":\"init\",\"pairId\":"
    appendJsonString(&line, head.pairId)
    line.append(",\"direction\":")
    appendJsonString(&line, head.direction.rawValue)
    line.append(",\"capacity\":\(head.capacity),\"capacityRecords\":\(head.capacityRecords),\"at\":")
    appendJsonString(&line, at)
    line.append("}\n")
    try fs.appendFile(storePath(prefix, journalFile), Array(line.utf8))
}

/// Load one direction store and reconcile the header against the journal (§12.1).
public func loadStore(fs: Fs, prefix: String) -> LoadResult {
    let headBytes: [UInt8]?
    do { headBytes = try fs.readFile(storePath(prefix, headFile)) } catch { headBytes = nil }

    guard let headBytes else {
        if fs.exists(storePath(prefix, v1PadFile)) {
            return .refused(reason: "v1-store",
                            message: "Refusing \(prefix): this holds a v1 pad store (\(v1PadFile)). "
                                + "v2 tooling cannot operate on it; no conversion exists.")
        }
        if fs.exists(storePath(prefix, secretFile)) || fs.exists(storePath(prefix, journalFile)) {
            return .refused(reason: "corrupt-store",
                            message: "\(prefix) holds \(secretFile) or \(journalFile) but no "
                                + "\(headFile) — a gen that crashed. Do not use the surviving files.")
        }
        return .refused(reason: "no-store", message: "no \(headFile) in \(prefix)")
    }

    let parsed: JsonValue
    do {
        parsed = try parseStrictJson(String(decoding: headBytes, as: UTF8.self))
    } catch {
        return .refused(reason: "corrupt-head",
                        message: "Refusing \(prefix): \(headFile) does not parse as JSON.")
    }
    let validation = validateHead(parsed)
    guard let head = validation.head else {
        return .refused(reason: "corrupt-head",
                        message: "Refusing \(prefix): \(headFile) fails validation — "
                            + "\(validation.why ?? "unknown"). A header is refused whole rather "
                            + "than partially trusted.")
    }

    var missing: [String] = []
    if !fs.exists(storePath(prefix, secretFile)) { missing.append(secretFile) }
    if !fs.exists(storePath(prefix, journalFile)) { missing.append(journalFile) }
    if !missing.isEmpty {
        return .refused(reason: "corrupt-store",
                        message: "Refusing \(prefix): \(headFile) present but "
                            + "\(missing.joined(separator: " and ")) missing.")
    }

    let expected = secretLength(head)
    let actual = (try? fs.size(storePath(prefix, secretFile))) ?? nil
    guard actual == expected else {
        return .refused(reason: "corrupt-secret-body",
                        message: "Refusing \(prefix): \(secretFile) is "
                            + "\(actual.map(String.init) ?? "absent") bytes but the header requires "
                            + "exactly \(expected) (E + 32*N).")
    }

    let journalBytes = ((try? fs.readFile(storePath(prefix, journalFile))) ?? nil) ?? []
    let aggregates: JournalAggregates
    switch readJournal(String(decoding: journalBytes, as: UTF8.self)) {
    case .bad(let reason, let message): return .refused(reason: reason, message: message)
    case .ok(let a): aggregates = a
    }

    // THE NO-REWIND CHECK. A header that is behind its own history is refused,
    // never trusted: trusting it would hand back offsets the journal says are
    // already spent, which is the exact shape of reuse.
    guard head.nextSequence >= aggregates.maxNextSequence else {
        return .refused(reason: "regressed-below-mark",
                        message: "Refusing \(prefix): \(headFile) nextSequence \(head.nextSequence) "
                            + "but \(journalFile) records retirement below "
                            + "\(aggregates.maxNextSequence). This header is older than its own history.")
    }
    guard head.nextOffset >= aggregates.maxNextOffset else {
        return .refused(reason: "regressed-below-mark",
                        message: "Refusing \(prefix): \(headFile) nextOffset \(head.nextOffset) but "
                            + "\(journalFile) burned through \(aggregates.maxNextOffset - 1).")
    }

    var attempts: [Int: Int] = [:]
    for (k, v) in head.perSequenceAttempts { attempts[Int(k) ?? 0] = v }
    for (seq, count) in aggregates.attemptCounts {
        attempts[seq] = max(attempts[seq] ?? 0, count)
    }

    return .ok(LoadedStore(head: head, effective: EffectiveState(
        nextOffset: head.nextOffset,
        nextSequence: head.nextSequence,
        attempts: attempts,
        attemptsReserved: aggregates.attemptsReserved,
        failureCount: max(head.failureCount, aggregates.failureCount),
        clearedAtFailureCount: max(head.clearedAtFailureCount, aggregates.lastClearedAt))))
}

// ---- secret body reads ------------------------------------------------------

public func readEncryption(fs: Fs, prefix: String, head: HeadV2,
                           offset: Int, length: Int) throws -> [UInt8] {
    guard offset >= 0, length >= 0, offset + length <= head.capacity else {
        throw StoreError.outOfRange("readEncryption [\(offset), \(offset + length)) "
                                    + "outside capacity \(head.capacity)")
    }
    return try fs.readRange(storePath(prefix, secretFile), offset: offset, length: length)
}

public func readAuthRecord(fs: Fs, prefix: String, head: HeadV2,
                           sequence: Int) throws -> (key: [UInt8], mask: [UInt8]) {
    guard sequence >= 0, sequence < head.capacityRecords else {
        throw StoreError.outOfRange("readAuthRecord out of range: \(sequence)")
    }
    let base = head.capacity + WcOneTime.authRecordBytes * sequence
    let record = try fs.readRange(storePath(prefix, secretFile), offset: base,
                                  length: WcOneTime.authRecordBytes)
    return (key: Array(record[0..<keyBytes]),
            mask: Array(record[keyBytes..<WcOneTime.authRecordBytes]))
}

// ---- durable transitions ----------------------------------------------------

/// OPEN O3: journal the attempt reservation, durably, and nothing else.
///
/// This is the write that makes a verification attempt cost something permanent.
/// It happens BEFORE the tag is computed, so a process that dies during
/// verification has still spent the attempt — which is what bounds a guessing
/// budget across crashes.
public func reserveAttempt(fs: Fs, prefix: String, sequence: Int, at: String) throws {
    var line = "{\"op\":\"attempt\",\"sequence\":\(sequence),\"at\":"
    appendJsonString(&line, at)
    line.append("}\n")
    try fs.appendFile(storePath(prefix, journalFile), Array(line.utf8))
}

/// OPEN O4 failure: append auth-fail FIRST, then rewrite the header.
public func persistAuthFail(fs: Fs, prefix: String, head: HeadV2,
                            sequence: Int, at: String) throws -> HeadV2 {
    let key = String(sequence)
    var perSequence = head.perSequenceAttempts
    perSequence[key] = (perSequence[key] ?? 0) + 1
    var newHead = head
    newHead.failureCount = head.failureCount + 1
    newHead.perSequenceAttempts = perSequence

    var line = "{\"op\":\"auth-fail\",\"sequence\":\(sequence),"
        + "\"failureCount\":\(newHead.failureCount),\"at\":"
    appendJsonString(&line, at)
    line.append("}\n")
    try fs.appendFile(storePath(prefix, journalFile), Array(line.utf8))
    try fs.writeFileAtomic(storePath(prefix, headFile), serializeHead(newHead))
    return newHead
}

/// SEND S2 / OPEN O5 / operator actions: rewrite the advanced header, THEN
/// append the line. The header moves first so a crash between the two leaves a
/// header that is AHEAD of its journal — which loses a record but never replays
/// one. The opposite order would leave a header behind its history, and the
/// loader would have to refuse the whole store.
public func commitAdvance(fs: Fs, prefix: String, newHead: HeadV2, journalLine: String) throws {
    try fs.writeFileAtomic(storePath(prefix, headFile), serializeHead(newHead))
    try fs.appendFile(storePath(prefix, journalFile), Array((journalLine + "\n").utf8))
}
