/* ============================================================================
 * Sealed Pad Transfer v1 — byte utilities
 * ----------------------------------------------------------------------------
 * Byte-exact twin of src/spt/bytes.ts.
 *
 * The base64url codec is written out rather than taken from Foundation, for the
 * same reason the Browser Edition does not use `btoa`: RFC 4648 §5 alphabet, no
 * padding, no `+`, no `/`, no internal whitespace. A transport that admits
 * several spellings of one request is a transport that will eventually be asked
 * which spelling was "the" request, and there is no good answer.
 * ========================================================================= */

import Foundation

public enum SptBytes {
    static let b64urlAlphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

    /// Reverse lookup; 0xff marks a character outside the alphabet.
    static let b64urlIndex: [UInt8] = {
        var table = [UInt8](repeating: 0xff, count: 256)
        for (i, ch) in b64urlAlphabet.enumerated() {
            table[Int(ch.asciiValue!)] = UInt8(i)
        }
        return table
    }()

    public static func concat(_ parts: [UInt8]...) -> [UInt8] {
        var out = [UInt8]()
        out.reserveCapacity(parts.reduce(0) { $0 + $1.count })
        for p in parts { out.append(contentsOf: p) }
        return out
    }

    /// Compare in time independent of WHERE the first difference is. Length is
    /// not secret here — every value compared has a fixed, public length — so an
    /// early return on a length mismatch leaks nothing.
    public static func equal(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        if a.count != b.count { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[i] ^ b[i] }
        return diff == 0
    }

    /// Best-effort in-memory hygiene for buffers the caller OWNS. It does not
    /// prove a copy the runtime made is gone, that the allocator forgot the
    /// bytes, or that physical RAM was erased — the same limitation every other
    /// edition records. Never call it on a buffer owned by someone else.
    public static func wipe(_ buffer: inout [UInt8]) {
        for i in 0..<buffer.count { buffer[i] = 0 }
    }

    public static func writeUInt16BE(_ out: inout [UInt8], _ offset: Int, _ value: UInt16) {
        out[offset] = UInt8((value >> 8) & 0xff)
        out[offset + 1] = UInt8(value & 0xff)
    }

    public static func readUInt16BE(_ bytes: [UInt8], _ offset: Int) -> UInt16 {
        (UInt16(bytes[offset]) << 8) | UInt16(bytes[offset + 1])
    }

    /// uint64 big-endian. Read as UInt64 and range-checked BEFORE any conversion
    /// to Int: a declared length near 2^53 pushed through floating-point
    /// arithmetic would round, and a rounded length is a bounds check that
    /// passes for a package it should refuse.
    public static func writeUInt64BE(_ out: inout [UInt8], _ offset: Int, _ value: UInt64) {
        var v = value
        for i in stride(from: 7, through: 0, by: -1) {
            out[offset + i] = UInt8(v & 0xff)
            v >>= 8
        }
    }

    public static func readUInt64BE(_ bytes: [UInt8], _ offset: Int) -> UInt64 {
        var v: UInt64 = 0
        for i in 0..<8 { v = (v << 8) | UInt64(bytes[offset + i]) }
        return v
    }

    // ---- canonical unpadded base64url --------------------------------------

    public static func toBase64Url(_ bytes: [UInt8]) -> String {
        var out = ""
        out.reserveCapacity((bytes.count + 2) / 3 * 4)
        var i = 0
        while i < bytes.count {
            let remaining = bytes.count - i
            let b0 = bytes[i]
            let b1 = remaining > 1 ? bytes[i + 1] : 0
            let b2 = remaining > 2 ? bytes[i + 2] : 0
            out.append(b64urlAlphabet[Int(b0 >> 2)])
            out.append(b64urlAlphabet[Int(((b0 & 0x03) << 4) | (b1 >> 4))])
            if remaining > 1 { out.append(b64urlAlphabet[Int(((b1 & 0x0f) << 2) | (b2 >> 6))]) }
            if remaining > 2 { out.append(b64urlAlphabet[Int(b2 & 0x3f)]) }
            i += 3
        }
        return out
    }

    /// Strict decode. Returns nil rather than throwing: at this layer a bad paste
    /// is an ordinary outcome, not an exception. A group of length 1 is
    /// impossible in base64; `=`, `+`, `/` and any whitespace are outside the
    /// alphabet and are rejected by the same lookup that rejects any other stray
    /// character.
    ///
    /// This does NOT by itself make the encoding canonical: trailing bits in the
    /// final group can be non-zero and would decode to the same bytes. Callers
    /// re-encode and compare — see ReceiveRequest.decode.
    public static func fromBase64Url(_ text: String) -> [UInt8]? {
        let chars = Array(text.utf8)
        let remainder = chars.count % 4
        if remainder == 1 { return nil }
        var out = [UInt8]()
        out.reserveCapacity(chars.count / 4 * 3 + (remainder == 0 ? 0 : remainder - 1))

        var i = 0
        while i < chars.count {
            let chunk = chars.count - i
            let c0 = b64urlIndex[Int(chars[i])]
            let c1 = b64urlIndex[Int(chars[i + 1])]
            if c0 == 0xff || c1 == 0xff { return nil }
            out.append((c0 << 2) | (c1 >> 4))
            if chunk > 2 {
                let c2 = b64urlIndex[Int(chars[i + 2])]
                if c2 == 0xff { return nil }
                out.append(((c1 & 0x0f) << 4) | (c2 >> 2))
                if chunk > 3 {
                    let c3 = b64urlIndex[Int(chars[i + 3])]
                    if c3 == 0xff { return nil }
                    out.append(((c2 & 0x03) << 6) | c3)
                }
            }
            i += 4
        }
        return out
    }

    /// ASCII-only, so `uint8(len(DS))` is the character count and cannot drift
    /// from the byte count for any separator this protocol uses.
    public static func asciiBytes(_ text: String) throws -> [UInt8] {
        var out = [UInt8]()
        out.reserveCapacity(text.unicodeScalars.count)
        for scalar in text.unicodeScalars {
            guard scalar.value >= 0x20, scalar.value <= 0x7e else {
                throw SptError.expectedPrintableASCII(text)
            }
            out.append(UInt8(scalar.value))
        }
        return out
    }

    /// Is every character in the RFC 4648 §5 alphabet? `=`, `+`, `/` and every
    /// whitespace character — including the interior ones a wrapped paste
    /// introduces — fall outside it.
    public static func isBase64UrlAlphabet(_ text: String) -> Bool {
        for byte in Array(text.utf8) where b64urlIndex[Int(byte)] == 0xff { return false }
        return true
    }

    // ---- 11-bit index extraction (§6.3, §8.2) ------------------------------

    /// Split the leading `count * 11` bits of `bytes`, most-significant first,
    /// into 11-bit indices.
    ///
    /// The Browser Edition expresses this with BigInt arithmetic:
    /// requestIndices132 reads 17 bytes as a 136-bit integer, discards the low 4
    /// bits, and takes shifts 121, 110, … 0; confirmationIndices88 reads 11
    /// bytes as an 88-bit integer and takes shifts 77, 66, … 0. Both reduce to
    /// exactly this: consecutive, non-overlapping 11-bit fields starting at the
    /// most significant bit. (For the 132-bit case the four discarded low bits
    /// are the four bits past the twelfth field, which this never reads.)
    /// SptFingerprintTests pins that equivalence against an independent
    /// arbitrary-precision reference rather than leaving it as a comment.
    static func elevenBitIndices(_ bytes: [UInt8], count: Int) -> [Int] {
        var out = [Int]()
        out.reserveCapacity(count)
        for i in 0..<count {
            let bitOffset = 11 * i
            var value = 0
            for bit in 0..<11 {
                let absolute = bitOffset + bit
                let byte = bytes[absolute >> 3]
                let taken = (byte >> (7 - UInt8(absolute & 7))) & 1
                value = (value << 1) | Int(taken)
            }
            out.append(value)
        }
        return out
    }
}

/// Errors raised by the byte layer and the codecs. Protocol-level refusals are
/// modelled as returned reasons, not thrown errors — see ReceiveRequest and
/// SealedPackage — because a bad paste is an ordinary outcome.
public enum SptError: Error, Equatable {
    case expectedPrintableASCII(String)
    case domainSeparatorLength(Int)
    case wrongLength(String, expected: Int, got: Int)
    case payloadTooLarge(Int)
    case plaintextLengthOutOfRange(Int)
    /// `seal` refuses a body that is not a canonical §5.1 request. Thrown rather
    /// than returned because, unlike a pasted request, this is a programming
    /// error at the call site: the durable layer looked the body up itself.
    case malformedRequestBody(reason: RequestBodyError, message: String)
}
