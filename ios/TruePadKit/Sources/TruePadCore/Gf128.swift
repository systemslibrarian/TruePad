/* ============================================================================
 * TruePad GF(2^128) / POLYVAL core
 * ----------------------------------------------------------------------------
 * Byte-exact twin of src/core/gf128.ts. Pure arithmetic: no Foundation, no
 * crypto library, no imports at all.
 *
 * POLYVAL exactly as specified in RFC 8452 Section 3, with every constant
 * pinned by FORMAT-V2.md §2.2:
 *
 *   - field: GF(2^128) defined by x^128 + x^127 + x^126 + x^121 + 1;
 *   - encoding: little-endian in both bytes and bits — the least significant
 *     bit of the first byte is the coefficient of x^0, so a field element as a
 *     128-bit integer is a little-endian read of its 16 bytes;
 *   - dot(a, b) = a · b · x^-128, with x^-128 = x^127 + x^124 + x^121 + x^114 + 1;
 *   - evaluation: S_0 = 0; S_j = dot(S_{j-1} XOR X_j, H); result S_m.
 *
 * The arithmetic is bit-serial ON PURPOSE: this module is written to be held
 * against RFC 8452 line by line, not to be fast.
 *
 * WHY A HAND-ROLLED 128-BIT TYPE. The Browser Edition uses BigInt and Android
 * uses two Longs. Swift 6 does have a standard `UInt128`, but it carries an
 * availability floor of iOS 18 / macOS 15, and TruePad's iOS Edition is not
 * going to require iOS 18 for the sake of a two-word integer. `Element` below is
 * the same lo/hi pair Android uses, and the shift-and-reduce is the identical
 * algorithm: the Browser Edition shifts into a 129th bit and XORs a POLY that
 * includes it, which clears that bit and XORs the low part — exactly what
 * testing the top bit before the shift and XORing `reductionR` does here.
 *
 * This module is NOT a security argument (FORMAT-V2.md §5 is, by citation), NOT
 * a general-purpose field library, and makes NO timing claims: `multiply`
 * branches on the KEY's bits, so POLYVAL timing depends on the key. The
 * one-time mask R protects the tag VALUE only — it does nothing for timing.
 * What bounds the exposure is the durable attempt reservation, and the spec
 * claims no timing resistance anywhere.
 * ========================================================================= */

public enum Gf128 {
    /// A field element: `lo` carries coefficients of x^0..x^63, `hi` x^64..x^127.
    public struct Element: Equatable, Sendable {
        public var lo: UInt64
        public var hi: UInt64

        public init(lo: UInt64 = 0, hi: UInt64 = 0) {
            self.lo = lo
            self.hi = hi
        }

        public static let zero = Element()

        static func ^ (a: Element, b: Element) -> Element {
            Element(lo: a.lo ^ b.lo, hi: a.hi ^ b.hi)
        }

        /// Multiply by x: a one-bit left shift across the two words.
        func shiftedLeftByOne() -> Element {
            Element(lo: lo << 1, hi: (hi << 1) | (lo >> 63))
        }

        /// The coefficient of x^127 — the bit that overflows on the next shift.
        var topBit: UInt64 { hi >> 63 }

        func bit(_ i: Int) -> UInt64 {
            i < 64 ? (lo >> UInt64(i)) & 1 : (hi >> UInt64(i - 64)) & 1
        }
    }

    /// The low 128 bits of x^128 + x^127 + x^126 + x^121 + 1, i.e. the value to
    /// XOR in after a shift that overflowed. Bit 0, and bits 121, 126, 127.
    static let reductionR = Element(lo: 1, hi: (1 << 57) | (1 << 62) | (1 << 63))

    /// x^-128 = x^127 + x^124 + x^121 + x^114 + 1 (RFC 8452 Section 3).
    static let xNeg128 = Element(lo: 1, hi: (1 << 63) | (1 << 60) | (1 << 57) | (1 << 50))

    public enum Failure: Error, Equatable {
        case notAFieldElement(Int)
        case notWholeBlocks(Int)
    }

    /// 16 bytes -> field element: a little-endian 128-bit read, which is exactly
    /// RFC 8452's bit/byte mapping. Anything but 16 bytes is a programmer error.
    public static func bytesToField(_ bytes: ArraySlice<UInt8>) throws -> Element {
        guard bytes.count == 16 else { throw Failure.notAFieldElement(bytes.count) }
        var lo: UInt64 = 0
        var hi: UInt64 = 0
        let base = bytes.startIndex
        for i in 0..<8 {
            lo |= UInt64(bytes[base + i]) << UInt64(8 * i)
            hi |= UInt64(bytes[base + 8 + i]) << UInt64(8 * i)
        }
        return Element(lo: lo, hi: hi)
    }

    public static func bytesToField(_ bytes: [UInt8]) throws -> Element {
        try bytesToField(bytes[...])
    }

    /// Field element -> 16 bytes, the same little-endian mapping.
    public static func fieldToBytes(_ fe: Element) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: 16)
        for i in 0..<8 {
            out[i] = UInt8((fe.lo >> UInt64(8 * i)) & 0xff)
            out[8 + i] = UInt8((fe.hi >> UInt64(8 * i)) & 0xff)
        }
        return out
    }

    /// Product of two field elements. Bit-serial: for each set bit i of b,
    /// accumulate a · x^i, keeping the running a · x^i reduced modulo the field
    /// polynomial.
    public static func multiply(_ a: Element, _ b: Element) -> Element {
        var result = Element.zero
        var shifted = a
        for i in 0..<128 {
            if b.bit(i) == 1 { result = result ^ shifted }
            let overflow = shifted.topBit          // multiply by x ...
            shifted = shifted.shiftedLeftByOne()
            if overflow == 1 { shifted = shifted ^ reductionR }  // ... and reduce
        }
        return result
    }

    /// dot(a, b) = a · b · x^-128 (RFC 8452 Section 3).
    public static func dot(_ a: Element, _ b: Element) -> Element {
        multiply(multiply(a, b), xNeg128)
    }

    /// POLYVAL(H, X_1, ..., X_m): the LITERAL RFC 8452 Section 3 iteration —
    /// S_0 = 0; S_j = dot(S_{j-1} XOR X_j, H); the result is S_m. No hoisted
    /// H·x^-128, no precomputed tables: one dot per block, exactly as written in
    /// the RFC. `message` must be a whole number of 16-byte blocks; the canonical
    /// encoding never produces anything else, so a partial block throws.
    public static func polyval(key h: [UInt8], message: [UInt8]) throws -> [UInt8] {
        guard message.count % 16 == 0 else { throw Failure.notWholeBlocks(message.count) }
        let key = try bytesToField(h)
        var s = Element.zero
        var offset = 0
        while offset < message.count {
            let block = try bytesToField(message[offset..<(offset + 16)])
            s = dot(s ^ block, key)
            offset += 16
        }
        return fieldToBytes(s)
    }
}
