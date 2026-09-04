/* ============================================================================
 * TruePad v2 wire envelope (FORMAT-V2.md §6.2, §9.1)
 * ----------------------------------------------------------------------------
 * Byte-exact twin of src/core/envelope2.ts and android/truepad-core Envelope.kt.
 *
 * One line of JSON with exactly eight fields, emitted in exactly this order:
 *
 *   {formatVersion, pairId, direction, sequence, startOffset,
 *    ciphertextLength, ciphertext, tag}
 *
 * Parsing is strict: exactly those eight keys, one accepted spelling per token.
 * Property names and string VALUES are literal on the wire — no JSON escape
 * sequences, no duplicate keys — enforced by a LEXICAL scan of the raw text,
 * because any JSON parser decodes escapes and collapses duplicates before a
 * check on the parsed value could see them. Number values obey a one-spelling
 * rule too. Every refusal here is structural (§14.1): typed, first-class, fired
 * before any secret is touched, and it burns nothing — this module never sees a
 * store.
 *
 * The v1-signature check runs FIRST, before the eight-key rule: a JSON object
 * with a `label` field and no `formatVersion` is the v1 wire shape, refused
 * `envelope-v1`, never `malformed-envelope`. That precedence is normative
 * (ledger claim N4 depends on it). There is no compatibility parse and no
 * --legacy flag; the refusal message says so instead of hinting at a bridge.
 *
 * What this module is NOT: it does not verify the tag, check the pairId against
 * a store, or window the sequence — those are the OPEN pipeline's later stages.
 * It validates wire shape and wire domains, nothing more.
 * ========================================================================= */

public enum Party: Sendable, Equatable { case a, b }

extension PadDirection {
    public var sender: Party { self == .aToB ? .a : .b }
    public var receiver: Party { self == .aToB ? .b : .a }
    public var opposite: PadDirection { self == .aToB ? .bToA : .aToB }

    public static func fromWire(_ s: String) -> PadDirection? {
        switch s {
        case "A->B": return .aToB
        case "B->A": return .bToA
        default: return nil
        }
    }
}

public struct EnvelopeV2: Sendable, Equatable {
    public let pairId: String       // 32 lowercase hex characters (16 bytes)
    public let direction: PadDirection
    public let sequence: Int
    public let startOffset: Int
    public let ciphertextLength: Int
    public let ciphertext: [UInt8]
    public let tag: [UInt8]         // 16 bytes

    public init(pairId: String, direction: PadDirection, sequence: Int, startOffset: Int,
                ciphertextLength: Int, ciphertext: [UInt8], tag: [UInt8]) {
        self.pairId = pairId
        self.direction = direction
        self.sequence = sequence
        self.startOffset = startOffset
        self.ciphertextLength = ciphertextLength
        self.ciphertext = ciphertext
        self.tag = tag
    }
}

public enum EnvelopeRefusalReason: String, Sendable, Equatable {
    case envelopeV1 = "envelope-v1"
    case malformedEnvelope = "malformed-envelope"
    case oversizeCiphertext = "oversize-ciphertext"
}

public enum EnvelopeDecode: Sendable {
    case ok(EnvelopeV2)
    case refused(reason: EnvelopeRefusalReason, message: String)
}

public enum Hex {
    /// One byte -> two lowercase hex characters, in order.
    public static func encode(_ bytes: [UInt8]) -> String {
        let digits = Array("0123456789abcdef")
        var out = String()
        out.reserveCapacity(bytes.count * 2)
        for b in bytes {
            out.append(digits[Int(b >> 4)])
            out.append(digits[Int(b & 0x0f)])
        }
        return out
    }

    /// Strict inverse. Accepts `^(?:[0-9a-f]{2})*$` only — the empty string
    /// decodes to no bytes; uppercase, odd length, whitespace and `0x` prefixes
    /// are all refused as nil, never normalized. Refusal is a value, not an
    /// error: "not hex" is an expected wire condition.
    public static func decode(_ hex: String) -> [UInt8]? {
        let chars = Array(hex.utf8)
        guard chars.count % 2 == 0 else { return nil }
        var out = [UInt8]()
        out.reserveCapacity(chars.count / 2)
        func nibble(_ c: UInt8) -> UInt8? {
            switch c {
            case 0x30...0x39: return c - 0x30              // 0-9
            case 0x61...0x66: return c - 0x61 + 10         // a-f (lowercase only)
            default: return nil
            }
        }
        var i = 0
        while i < chars.count {
            guard let hi = nibble(chars[i]), let lo = nibble(chars[i + 1]) else { return nil }
            out.append((hi << 4) | lo)
            i += 2
        }
        return out
    }
}

public enum EnvelopeCodec {
    /// The eight wire keys, in the §6.2 emission order. Parse does not care about
    /// key order (JSON objects are unordered); emission does.
    public static let wireKeys = [
        "formatVersion", "pairId", "direction", "sequence",
        "startOffset", "ciphertextLength", "ciphertext", "tag",
    ]

    /// A non-negative JavaScript "safe integer": < 2^53. Counters above this
    /// decode in-domain in JS as an imprecise float and are refused there; this
    /// edition matches that ceiling rather than accepting what its own Int could
    /// hold, because the ceiling is part of the wire contract.
    public static let maxSafeInteger = 9_007_199_254_740_991

    static func malformed(_ why: String) -> EnvelopeDecode {
        .refused(reason: .malformedEnvelope, message: "Malformed envelope: \(why). Nothing was burned.")
    }

    static func refuseV1() -> EnvelopeDecode {
        .refused(reason: .envelopeV1, message:
            "This is a v1 envelope: it carries a label field and no formatVersion. "
            + "v2 tooling cannot open a v1 envelope — there is no --legacy flag and no compatibility "
            + "parse, by design. Open it with the v1 tooling that made it. Nothing was burned.")
    }

    static func refuseOversize(_ declared: Int) -> EnvelopeDecode {
        .refused(reason: .oversizeCiphertext, message:
            "Oversize ciphertext: the envelope declares \(declared) ciphertext bytes but the v2 maximum "
            + "is \(WcOneTime.maxCiphertextBytes). Larger payloads travel as multiple records, each with "
            + "its own auth record. Nothing was burned.")
    }

    /// Refusal messages quote the offending spelling, clipped: a hostile line can
    /// put megabytes behind one escape, and a refusal is not an echo chamber.
    static func clip(_ spelling: String) -> String {
        spelling.count > 48 ? String(spelling.prefix(48)) + "…" : spelling
    }

    // ---- the lexical scan --------------------------------------------------

    struct WireToken {
        enum Kind { case name, value }
        let kind: Kind
        let spelling: String
        let escaped: Bool
    }

    struct NumberMember {
        let name: String
        let spelling: String
    }

    /// Lexical scan of the top level of an envelope line. Precondition: `text` is
    /// valid JSON whose top-level value is a non-null, non-array object, so the
    /// walk never meets a truncated string or an unbalanced brace.
    ///
    /// It lexes strings properly — opening quote to unescaped closing quote, a
    /// backslash always consuming the character after it, so the four hex digits
    /// of \uXXXX cannot be mistaken for the terminator — and tracks brace depth,
    /// so braces, colons and escaped quotes INSIDE values never miscount. One
    /// pass, linear: ciphertext hex can be long. Tokens below the top level are
    /// not collected; an envelope with a nested value has an extra key and the
    /// eight-key rule refuses it.
    static func scanTopLevel(_ text: String) -> (tokens: [WireToken], numbers: [NumberMember]) {
        let s = Array(text.unicodeScalars)
        var tokens: [WireToken] = []
        var numbers: [NumberMember] = []
        var depth = 0
        var expectName = false
        var pendingName = ""
        var i = 0

        let numberChars = Set(String("+-.eE0123456789").unicodeScalars)

        while i < s.count {
            let ch = s[i]
            if ch == "\"" {
                let start = i + 1
                var j = start
                var escaped = false
                while j < s.count {
                    let c = s[j]
                    if c == "\\" { escaped = true; j += 2; continue }
                    if c == "\"" { break }
                    j += 1
                }
                if depth == 1 {
                    let end = min(j, s.count)
                    let spelling = start <= end
                        ? String(String.UnicodeScalarView(s[start..<end]))
                        : ""
                    tokens.append(WireToken(kind: expectName ? .name : .value,
                                            spelling: spelling, escaped: escaped))
                    if expectName { pendingName = spelling }
                    expectName = false
                }
                i = j + 1
            } else if ch == "{" || ch == "[" {
                depth += 1
                if depth == 1 { expectName = true }
                i += 1
            } else if ch == "}" || ch == "]" {
                depth -= 1
                if depth == 0 { break }
                i += 1
            } else if depth == 1 && !expectName && (ch == "-" || (ch >= "0" && ch <= "9")) {
                // A top-level number value: capture its exact source spelling so a
                // non-canonical spelling (7.0, 7e0, -0, 2.000) is distinguishable
                // from the canonical decimal integer, which a parser would hide.
                var j = i + 1
                while j < s.count, numberChars.contains(s[j]) { j += 1 }
                numbers.append(NumberMember(name: pendingName,
                                            spelling: String(String.UnicodeScalarView(s[i..<j]))))
                i = j
            } else {
                if ch == "," && depth == 1 { expectName = true }
                i += 1
            }
        }
        return (tokens, numbers)
    }

    static func isCanonicalCounter(_ spelling: String) -> Bool {
        guard !spelling.isEmpty else { return false }
        if spelling == "0" { return true }
        let chars = Array(spelling.utf8)
        guard chars[0] >= 0x31, chars[0] <= 0x39 else { return false }   // no leading zero, no sign
        return chars.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
    }

    static func isLowercaseHex(_ s: String, length: Int? = nil) -> Bool {
        let chars = Array(s.utf8)
        if let length, chars.count != length { return false }
        guard chars.count % 2 == 0 else { return false }
        return chars.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }

    // ---- decode ------------------------------------------------------------

    /// Strict §6.2 parse. Check order is normative: (1) JSON, (2) the v1
    /// signature, (3) wire spellings — lexical: escape-free property names, then
    /// no duplicate keys, then escape-free string values, then canonical number
    /// spellings, all on the raw text — (4) exactly eight keys, (5) per-field
    /// domains, (6) oversize on the DECLARED length, (7) declared length vs
    /// ciphertext hex length.
    public static func decode(_ text: String) -> EnvelopeDecode {
        let parsed: JsonValue
        do {
            parsed = try parseStrictJson(text)
        } catch {
            return malformed("not JSON")
        }
        guard case .object = parsed, let raw = parsed.memberMap else {
            return malformed("not a JSON object")
        }

        // v1 signature FIRST — a v1 envelope also fails the eight-key rule below,
        // and it must land here, not there (§9.1).
        if raw["label"] != nil && raw["formatVersion"] == nil { return refuseV1() }

        let (tokens, numbers) = scanTopLevel(text)

        // The canonical grammar has exactly one spelling per key: a property name
        // spelled with ANY escape sequence — of any key, required or extra — is
        // ambiguity, refused before further processing.
        for t in tokens where t.kind == .name && t.escaped {
            return malformed("the property name \"\(clip(t.spelling))\" is spelled with JSON escape "
                             + "sequences; the v2 wire grammar has exactly one spelling per key")
        }
        // Surviving names are literal, so duplicate logical keys are duplicate
        // spellings and refuse next.
        var nameCounts: [String: Int] = [:]
        for t in tokens where t.kind == .name { nameCounts[t.spelling, default: 0] += 1 }
        for (name, count) in nameCounts.sorted(by: { $0.key < $1.key }) where count > 1 {
            return malformed("the key \(clip(name)) appears \(count) times; a v2 envelope carries "
                             + "each of its keys exactly once")
        }
        // String VALUES are held to the same one-spelling rule: an escaped value
        // is refused even when it decodes to an in-domain string.
        for t in tokens where t.kind == .value && t.escaped {
            return malformed("the string value \"\(clip(t.spelling))\" is spelled with JSON escape "
                             + "sequences; each value has exactly one accepted wire spelling, and the "
                             + "decoded-equivalent form is refused")
        }
        // Number values obey the one-spelling rule too: 7.0, 7e0, -0 and 2.000 all
        // decode in-domain but are non-canonical spellings.
        for n in numbers {
            if n.name == "formatVersion" {
                if n.spelling != "2" {
                    return malformed("formatVersion must be spelled exactly 2, not \(clip(n.spelling))")
                }
            } else if n.name == "sequence" || n.name == "startOffset" || n.name == "ciphertextLength" {
                if !isCanonicalCounter(n.spelling) {
                    return malformed("\(n.name) must be a canonical decimal integer (no leading zero, "
                                     + "sign, fraction, or exponent), not \(clip(n.spelling))")
                }
            }
        }

        let keys = parsed.memberKeys ?? []
        let missing = wireKeys.filter { raw[$0] == nil }
        let extra = keys.filter { !wireKeys.contains($0) }
        if !missing.isEmpty || !extra.isEmpty {
            var parts: [String] = []
            if !missing.isEmpty { parts.append("missing \(missing.joined(separator: ", "))") }
            if !extra.isEmpty { parts.append("unexpected \(extra.joined(separator: ", "))") }
            return malformed("a v2 envelope has exactly eight fields "
                             + "(\(wireKeys.joined(separator: ", "))); this one is "
                             + parts.joined(separator: " and "))
        }

        guard case .number(let fv)? = raw["formatVersion"], fv == "2" else {
            return malformed("formatVersion must be the integer 2")
        }
        guard case .string(let pairId)? = raw["pairId"], isLowercaseHex(pairId, length: 32) else {
            return malformed("pairId must be exactly 32 lowercase hex characters")
        }
        guard case .string(let directionText)? = raw["direction"],
              let direction = PadDirection.fromWire(directionText) else {
            return malformed("direction must be exactly \"A->B\" or \"B->A\"")
        }
        guard let sequence = counterValue(raw["sequence"]) else {
            return malformed("sequence must be a non-negative safe integer")
        }
        guard let startOffset = counterValue(raw["startOffset"]) else {
            return malformed("startOffset must be a non-negative safe integer")
        }
        guard let ciphertextLength = counterValue(raw["ciphertextLength"]) else {
            return malformed("ciphertextLength must be a non-negative safe integer")
        }
        guard case .string(let tagHex)? = raw["tag"], isLowercaseHex(tagHex, length: 32) else {
            return malformed("tag must be exactly 32 lowercase hex characters (a 128-bit tag; "
                             + "lowercase only)")
        }
        guard case .string(let ciphertextHex)? = raw["ciphertext"], isLowercaseHex(ciphertextHex) else {
            return malformed("ciphertext must be lowercase hex, two characters per byte "
                             + "(uppercase is refused)")
        }

        // Oversize fires on the DECLARED length, before the ciphertext hex is
        // decoded — a truncated hex string does not demote this to malformed.
        if ciphertextLength > WcOneTime.maxCiphertextBytes { return refuseOversize(ciphertextLength) }
        if ciphertextHex.utf8.count != 2 * ciphertextLength {
            return malformed("ciphertextLength says \(ciphertextLength) bytes but the ciphertext hex "
                             + "holds \(ciphertextHex.utf8.count / 2)")
        }

        guard let ciphertext = Hex.decode(ciphertextHex), let tag = Hex.decode(tagHex) else {
            // Unreachable after the checks above; kept so a codec change cannot
            // silently turn strict parse into a crash.
            return malformed("ciphertext or tag failed strict hex decoding")
        }
        return .ok(EnvelopeV2(pairId: pairId, direction: direction, sequence: sequence,
                              startOffset: startOffset, ciphertextLength: ciphertextLength,
                              ciphertext: ciphertext, tag: tag))
    }

    /// A number whose value is a non-negative safe integer; else nil. The lexical
    /// scan already required a canonical decimal spelling, so this only bounds
    /// range.
    static func counterValue(_ v: JsonValue?) -> Int? {
        guard case .number(let raw)? = v, let n = Int(raw) else { return nil }
        return (n >= 0 && n <= maxSafeInteger) ? n : nil
    }

    // ---- encode ------------------------------------------------------------

    public enum EncodeFailure: Error, Equatable {
        case badPairId
        case counterOutOfRange
        case oversizeCiphertext(Int)
        case lengthDisagrees(declared: Int, actual: Int)
        case tagLength(Int)
    }

    /// One line of JSON, the eight §6.2 fields in the §6.2 order, lowercase hex.
    /// Hand-built rather than produced by a serializer, so the wire bytes are
    /// byte-identical to the other editions' output — a serializer is free to
    /// choose key order, spacing and escaping, and this wire is not.
    ///
    /// Domain violations throw: an envelope this function cannot emit in a form
    /// `decode` would accept is a programmer error, not a wire condition, because
    /// callers construct envelopes from validated store state.
    public static func encode(_ e: EnvelopeV2) throws -> String {
        guard isLowercaseHex(e.pairId, length: 32) else { throw EncodeFailure.badPairId }
        guard e.sequence >= 0, e.sequence <= maxSafeInteger,
              e.startOffset >= 0, e.startOffset <= maxSafeInteger,
              e.ciphertextLength >= 0, e.ciphertextLength <= maxSafeInteger else {
            throw EncodeFailure.counterOutOfRange
        }
        guard e.ciphertextLength <= WcOneTime.maxCiphertextBytes else {
            throw EncodeFailure.oversizeCiphertext(e.ciphertextLength)
        }
        guard e.ciphertext.count == e.ciphertextLength else {
            throw EncodeFailure.lengthDisagrees(declared: e.ciphertextLength, actual: e.ciphertext.count)
        }
        guard e.tag.count == 16 else { throw EncodeFailure.tagLength(e.tag.count) }

        return "{\"formatVersion\":2,\"pairId\":\"\(e.pairId)\",\"direction\":\"\(e.direction.rawValue)\","
            + "\"sequence\":\(e.sequence),\"startOffset\":\(e.startOffset),"
            + "\"ciphertextLength\":\(e.ciphertextLength),"
            + "\"ciphertext\":\"\(Hex.encode(e.ciphertext))\",\"tag\":\"\(Hex.encode(e.tag))\"}"
    }
}
