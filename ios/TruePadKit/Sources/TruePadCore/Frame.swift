/* ============================================================================
 * TruePad v2 fixed-size record frame (FORMAT-V2.md §16.1)
 * ----------------------------------------------------------------------------
 * Byte-exact twin of src/core/frame2.ts. Pure byte movement, nothing else.
 *
 * A fixed-size store freezes every record at one ciphertext size F (§16). The
 * message length moves INSIDE the encrypted-and-authenticated region so the
 * channel observes record count and timing but never message length:
 *
 *   frame = plaintextLength (u32 LE) || plaintext || 0x00 padding, exactly F bytes
 *
 * Plaintext capacity per record is F − 4. The frame is what §12.2 encrypts and
 * authenticates (C = F); the length prefix is recovered only AFTER the tag
 * verifies and the record is committed (§16.2), and it selects the released
 * bytes. The padding is 0x00 with no other meaning — it is never inspected on
 * parse; only the prefix decides the plaintext boundary.
 *
 * This module is a codec of the frame, not a store or a policy: it does not read
 * a header, decide whether a store is fixed, or judge F against §16's bounds
 * (32 ≤ F ≤ maxCiphertextBytes, multiple of 16). `build` throws on a domain
 * violation, because its callers pre-validate; `parse` returns nil for a length
 * field no conforming sender could write — the caller maps that nil to the
 * §16.2 `record-frame-invalid` error on the POST-COMMIT path, never a refusal.
 * ========================================================================= */

public enum Frame {
    /// The u32 little-endian length prefix: four bytes ahead of the plaintext.
    public static let lengthPrefixBytes = 4

    public enum Failure: Error, Equatable {
        case recordTooSmall(Int)
        case plaintextTooLarge(plaintext: Int, capacity: Int, recordBytes: Int)
    }

    /// Plaintext capacity of an F-byte record: the bytes left after the prefix.
    public static func capacity(recordBytes: Int) -> Int {
        recordBytes - lengthPrefixBytes
    }

    /// Build the exactly-F-byte frame for `plaintext`: u32 LE length prefix, the
    /// plaintext, then 0x00 padding to F. The fresh allocation is already zeroed,
    /// so the padding is written by construction.
    public static func build(plaintext: [UInt8], recordBytes: Int) throws -> [UInt8] {
        guard recordBytes >= lengthPrefixBytes else { throw Failure.recordTooSmall(recordBytes) }
        let cap = capacity(recordBytes: recordBytes)
        guard plaintext.count <= cap else {
            throw Failure.plaintextTooLarge(plaintext: plaintext.count,
                                            capacity: cap, recordBytes: recordBytes)
        }
        var frame = [UInt8](repeating: 0, count: recordBytes)
        var declared = UInt32(plaintext.count)
        for i in 0..<4 {
            frame[i] = UInt8(declared & 0xff)
            declared >>= 8
        }
        if !plaintext.isEmpty {
            frame.replaceSubrange(lengthPrefixBytes..<(lengthPrefixBytes + plaintext.count),
                                  with: plaintext)
        }
        return frame
    }

    /// Recover the plaintext from a decrypted frame. Returns the bytes the prefix
    /// selects, or nil when the length field exceeds frame.count − 4 — a value no
    /// conforming sender writes and that cannot be forged into existence below
    /// the §5 probability. The padding after the plaintext is NOT examined; the
    /// prefix alone is the boundary.
    public static func parse(_ frame: [UInt8]) -> [UInt8]? {
        guard frame.count >= lengthPrefixBytes else { return nil }
        var declared: UInt32 = 0
        for i in stride(from: 3, through: 0, by: -1) {
            declared = (declared << 8) | UInt32(frame[i])
        }
        // Compare in UInt64 so a prefix near 2^32 cannot wrap into range.
        guard UInt64(declared) <= UInt64(frame.count - lengthPrefixBytes) else { return nil }
        let count = Int(declared)
        return Array(frame[lengthPrefixBytes..<(lengthPrefixBytes + count)])
    }
}
