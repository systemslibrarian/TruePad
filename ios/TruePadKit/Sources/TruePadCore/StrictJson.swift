/* ============================================================================
 * A small STRICT JSON reader (RFC 8259)
 * ----------------------------------------------------------------------------
 * Twin of android/truepad-core Json.kt, and written for the same reason: the
 * envelope grammar cannot be enforced on top of an ordinary JSON parser.
 *
 * Foundation's JSONSerialization — like JavaScript's JSON.parse — decodes escape
 * sequences and collapses duplicate keys before any check on the parsed value
 * could see them, and folds 7, 7.0 and 7e0 into one number. FORMAT-V2.md §6.2
 * requires exactly one accepted spelling per token, so the raw spellings have to
 * survive the parse. `JsonValue.number` therefore keeps the RAW source text; the
 * separate lexical scan in Envelope.swift is what refuses duplicate keys and
 * escaped spellings.
 *
 * Acceptance mirrors JSON.parse closely enough for this grammar: one top-level
 * value, no trailing content, no comments, no trailing commas, strict number
 * grammar (no leading zeros, no `+`, no bare fraction), strict string escapes,
 * unescaped control characters refused. Duplicate object keys are last-wins,
 * matching JSON.parse, because the lexical scan owns that refusal.
 * ========================================================================= */

public indirect enum JsonValue: Equatable {
    case object(members: [(key: String, value: JsonValue)])
    case array([JsonValue])
    case string(String)
    /// The RAW source spelling, never a parsed numeric value: the one-spelling
    /// rule (7 vs 7.0 vs 7e0 vs -0) is enforced on this text.
    case number(raw: String)
    case bool(Bool)
    case null

    public static func == (a: JsonValue, b: JsonValue) -> Bool {
        switch (a, b) {
        case (.object(let x), .object(let y)):
            return x.count == y.count && zip(x, y).allSatisfy { $0.key == $1.key && $0.value == $1.value }
        case (.array(let x), .array(let y)): return x == y
        case (.string(let x), .string(let y)): return x == y
        case (.number(let x), .number(let y)): return x == y
        case (.bool(let x), .bool(let y)): return x == y
        case (.null, .null): return true
        default: return false
        }
    }

    /// Members as a dictionary, LAST-WINS on a duplicate key — the behaviour
    /// JSON.parse has, and the reason duplicate keys must be caught lexically
    /// rather than here.
    public var memberMap: [String: JsonValue]? {
        guard case .object(let members) = self else { return nil }
        var out = [String: JsonValue]()
        for m in members { out[m.key] = m.value }
        return out
    }

    /// Member keys in source order, duplicates included.
    public var memberKeys: [String]? {
        guard case .object(let members) = self else { return nil }
        return members.map { $0.key }
    }
}

public struct JsonParseError: Error, Equatable {
    public let message: String
}

/// A hostile document can nest thousands of levels deep. This parser is
/// recursive descent, so without a cap a deep nest is a stack overflow — an
/// uncatchable crash, not the typed refusal every caller expects. JSON.parse has
/// its own engine limit and throws a catchable error; this keeps the failure
/// inside the same channel.
let maxJsonDepth = 200

public func parseStrictJson(_ text: String) throws -> JsonValue {
    var parser = StrictJsonParser(Array(text.unicodeScalars))
    parser.skipWhitespace()
    let value = try parser.parseValue()
    parser.skipWhitespace()
    guard parser.atEnd else {
        throw JsonParseError(message: "trailing content after top-level value at index \(parser.pos)")
    }
    return value
}

struct StrictJsonParser {
    private let s: [Unicode.Scalar]
    private(set) var pos = 0
    private var depth = 0

    init(_ scalars: [Unicode.Scalar]) { self.s = scalars }

    var atEnd: Bool { pos >= s.count }

    mutating func skipWhitespace() {
        while pos < s.count {
            switch s[pos] {
            case " ", "\t", "\n", "\r": pos += 1
            default: return
            }
        }
    }

    private func peek() throws -> Unicode.Scalar {
        guard pos < s.count else { throw JsonParseError(message: "unexpected end of input") }
        return s[pos]
    }

    private mutating func nested<T>(_ build: (inout StrictJsonParser) throws -> T) throws -> T {
        depth += 1
        defer { depth -= 1 }
        guard depth <= maxJsonDepth else {
            throw JsonParseError(message: "JSON nested deeper than \(maxJsonDepth) at index \(pos)")
        }
        return try build(&self)
    }

    mutating func parseValue() throws -> JsonValue {
        skipWhitespace()
        switch try peek() {
        case "{": return try nested { try $0.parseObject() }
        case "[": return try nested { try $0.parseArray() }
        case "\"": return .string(try parseString())
        case "t", "f": return .bool(try parseBool())
        case "n": try expect("null"); return .null
        case "-", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9":
            return .number(raw: try parseNumberRaw())
        default:
            throw JsonParseError(message: "unexpected character '\(try peek())' at index \(pos)")
        }
    }

    private mutating func expect(_ word: String) throws {
        for scalar in word.unicodeScalars {
            guard pos < s.count, s[pos] == scalar else {
                throw JsonParseError(message: "expected '\(word)' at index \(pos)")
            }
            pos += 1
        }
    }

    private mutating func parseBool() throws -> Bool {
        if try peek() == "t" { try expect("true"); return true }
        try expect("false")
        return false
    }

    private mutating func parseObject() throws -> JsonValue {
        pos += 1 // '{'
        var members: [(key: String, value: JsonValue)] = []
        skipWhitespace()
        if try peek() == "}" { pos += 1; return .object(members: members) }
        while true {
            skipWhitespace()
            guard try peek() == "\"" else {
                throw JsonParseError(message: "object key must be a string at index \(pos)")
            }
            let key = try parseString()
            skipWhitespace()
            guard try peek() == ":" else {
                throw JsonParseError(message: "expected ':' at index \(pos)")
            }
            pos += 1
            let value = try parseValue()
            members.append((key: key, value: value))
            skipWhitespace()
            switch try peek() {
            case ",": pos += 1
            case "}": pos += 1; return .object(members: members)
            default: throw JsonParseError(message: "expected ',' or '}' at index \(pos)")
            }
        }
    }

    private mutating func parseArray() throws -> JsonValue {
        pos += 1 // '['
        var items: [JsonValue] = []
        skipWhitespace()
        if try peek() == "]" { pos += 1; return .array(items) }
        while true {
            items.append(try parseValue())
            skipWhitespace()
            switch try peek() {
            case ",": pos += 1
            case "]": pos += 1; return .array(items)
            default: throw JsonParseError(message: "expected ',' or ']' at index \(pos)")
            }
        }
    }

    private mutating func parseString() throws -> String {
        pos += 1 // opening quote
        var out = String.UnicodeScalarView()
        while true {
            guard pos < s.count else { throw JsonParseError(message: "unterminated string") }
            let c = s[pos]
            if c == "\"" { pos += 1; return String(out) }
            if c == "\\" {
                pos += 1
                guard pos < s.count else { throw JsonParseError(message: "unterminated escape") }
                let e = s[pos]
                switch e {
                case "\"": out.append("\""); pos += 1
                case "\\": out.append("\\"); pos += 1
                case "/": out.append("/"); pos += 1
                case "b": out.append(Unicode.Scalar(0x08)!); pos += 1
                case "f": out.append(Unicode.Scalar(0x0c)!); pos += 1
                case "n": out.append("\n"); pos += 1
                case "r": out.append("\r"); pos += 1
                case "t": out.append("\t"); pos += 1
                case "u":
                    guard pos + 4 < s.count else { throw JsonParseError(message: "bad \\u escape") }
                    let hex = String(String.UnicodeScalarView(s[(pos + 1)...(pos + 4)]))
                    guard let code = UInt32(hex, radix: 16) else {
                        throw JsonParseError(message: "bad \\u escape '\(hex)'")
                    }
                    // Lone surrogates are preserved as replacement, matching how a
                    // permissive reader would treat them; the envelope grammar
                    // refuses every escaped spelling anyway.
                    out.append(Unicode.Scalar(code) ?? Unicode.Scalar(0xfffd)!)
                    pos += 5
                default:
                    throw JsonParseError(message: "invalid escape '\\\(e)'")
                }
                continue
            }
            if c.value < 0x20 {
                throw JsonParseError(message: "unescaped control character in string at index \(pos)")
            }
            out.append(c)
            pos += 1
        }
    }

    /// Strict RFC 8259 number grammar, returning the RAW spelling.
    private mutating func parseNumberRaw() throws -> String {
        let start = pos
        if pos < s.count, s[pos] == "-" { pos += 1 }
        guard pos < s.count else { throw JsonParseError(message: "bad number at index \(start)") }
        // int: 0 | [1-9][0-9]*  — no leading zeros
        if s[pos] == "0" {
            pos += 1
        } else if s[pos] >= "1" && s[pos] <= "9" {
            while pos < s.count, s[pos] >= "0", s[pos] <= "9" { pos += 1 }
        } else {
            throw JsonParseError(message: "bad number at index \(start)")
        }
        // frac
        if pos < s.count, s[pos] == "." {
            pos += 1
            guard pos < s.count, s[pos] >= "0", s[pos] <= "9" else {
                throw JsonParseError(message: "bad number fraction at index \(start)")
            }
            while pos < s.count, s[pos] >= "0", s[pos] <= "9" { pos += 1 }
        }
        // exp
        if pos < s.count, s[pos] == "e" || s[pos] == "E" {
            pos += 1
            if pos < s.count, s[pos] == "+" || s[pos] == "-" { pos += 1 }
            guard pos < s.count, s[pos] >= "0", s[pos] <= "9" else {
                throw JsonParseError(message: "bad number exponent at index \(start)")
            }
            while pos < s.count, s[pos] >= "0", s[pos] <= "9" { pos += 1 }
        }
        return String(String.UnicodeScalarView(s[start..<pos]))
    }
}
