import TruePadCore

/* ============================================================================
 * The SPT durable record codec — canonical serialization and STRICT parsing.
 *
 * Records are tiny JSON objects with a fixed key order. `serializeRecord`
 * produces exactly `{"k":v,...}` as `JSON.stringify` would; `parseRecord` demands
 * an object of the exact version and the EXACT key set, so a record copied from
 * one request's directory into another's is rejected rather than trusted.
 * ========================================================================= */

public let sptRecordVersion = 1

/// A record value is either an Int (only `version`) or an ASCII String.
enum RecordValue {
    case int(Int)
    case string(String)
}

func serializeRecord(_ entries: [(String, RecordValue)]) -> [UInt8] {
    var s = "{"
    for (i, e) in entries.enumerated() {
        if i > 0 { s.append(",") }
        appendSptJsonString(&s, e.0)
        s.append(":")
        switch e.1 {
        case .int(let v): s.append(String(v))
        case .string(let v): appendSptJsonString(&s, v)
        }
    }
    s.append("}")
    return Array(s.utf8)
}

/// `JSON.stringify`-compatible string escaping.
///
/// The record values are constrained ASCII — hex, base64url, ISO timestamps,
/// enum spellings — but this stays fully correct so a value can never smuggle an
/// unescaped byte into a record another edition will re-parse.
func appendSptJsonString(_ out: inout String, _ s: String) {
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
                out.unicodeScalars.append(scalar)
            }
        }
    }
    out.append("\"")
}

/// Strict parse: non-empty, valid JSON, an object, the exact record version, and
/// EXACTLY the given keys — no more, no fewer. Throws on any deviation.
func parseRecord(_ bytes: [UInt8], what: String, keys: [String]) throws -> [String: JsonValue] {
    if bytes.isEmpty { throw SptRejected(why: "the \(what) is empty") }
    guard let text = String(bytes: bytes, encoding: .utf8),
          let parsed = try? parseStrictJson(text) else {
        throw SptRejected(why: "the \(what) does not parse as JSON")
    }
    guard let members = parsed.memberMap, let actualKeys = parsed.memberKeys else {
        throw SptRejected(why: "the \(what) is not a JSON object")
    }
    guard case .number(let raw)? = members["version"], Int(raw) == sptRecordVersion else {
        throw SptRejected(why: "unsupported \(what) version")
    }
    guard actualKeys.sorted() == keys.sorted() else {
        throw SptRejected(why: "the \(what)'s fields are wrong")
    }
    return members
}

func recordString(_ members: [String: JsonValue], _ key: String) throws -> String {
    guard case .string(let v)? = members[key] else {
        throw SptRejected(why: "\(key) is not a string")
    }
    return v
}

/// A base64url field decoded to EXACTLY `length` bytes, canonical spelling
/// required — a re-encode must reproduce the same text, so padding or an
/// alternative alphabet is refused rather than silently accepted.
func decodeExact(_ value: String, length: Int, field: String) throws -> [UInt8] {
    guard let bytes = SptBytes.fromBase64Url(value) else {
        throw SptRejected(why: "\(field) is not canonical unpadded base64url")
    }
    guard bytes.count == length else {
        throw SptRejected(why: "\(field) decodes to \(bytes.count) bytes, expected \(length)")
    }
    guard SptBytes.toBase64Url(bytes) == value else {
        throw SptRejected(why: "\(field) has a non-canonical base64url spelling")
    }
    return bytes
}

func isSptHex32(_ s: String) -> Bool {
    s.count == 32 && s.allSatisfy { $0.isASCII && ($0.isNumber || ("a"..."f").contains(String($0))) }
}

func isSptHex64(_ s: String) -> Bool {
    s.count == 64 && s.allSatisfy { $0.isASCII && ($0.isNumber || ("a"..."f").contains(String($0))) }
}

func sptHex(_ bytes: [UInt8]) -> String {
    let digits = Array("0123456789abcdef")
    var out = ""
    out.reserveCapacity(bytes.count * 2)
    for b in bytes {
        out.append(digits[Int(b >> 4)])
        out.append(digits[Int(b & 0x0F)])
    }
    return out
}

/* ---- canonical timestamps --------------------------------------------------
 * The SPT durable records store and RE-VALIDATE timestamps in the exact
 * `YYYY-MM-DDTHH:mm:ss.sssZ` spelling. The arithmetic is TruePadCore.IsoTime,
 * shared with the store's bookkeeping so there is one implementation rather than
 * two that can disagree about a leap year — and a disagreement here is a REFUSAL,
 * because these fields are validated by round trip.
 * ------------------------------------------------------------------------- */

public enum SptTime {
    /// Exactly seven days as a duration — NOT "the same clock time seven days
    /// later", which stretches across a DST boundary.
    public static let requestTtlMillis = IsoTime.sevenDaysMillis

    public static func format(epochMillis: Int) -> String { IsoTime.format(epochMillis: epochMillis) }
    public static func isCanonicalIso(_ s: String) -> Bool { IsoTime.isCanonical(s) }
    public static func parseMillis(_ s: String) -> Int? { IsoTime.parseMillis(s) }
}
