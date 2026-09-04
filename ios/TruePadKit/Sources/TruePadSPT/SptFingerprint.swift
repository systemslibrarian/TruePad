/* ============================================================================
 * Domain-separated hashing, requestHash, and the two word renderings
 * ----------------------------------------------------------------------------
 * Byte-exact twin of src/spt/fingerprint.ts.
 * docs/SEALED-PAD-TRANSFER.md §6.2, §6.3 and §8.2.
 *
 *   H_ds(DS, X) = SHA-256( uint8(len(DS)) ‖ DS ‖ X )
 *
 * The length octet is MEASURED. A wrong constant here does not fail loudly; it
 * silently forks requestHash — and with it the safety words, the HKDF salt and
 * AAD bytes [23, 55) — between two conforming builds, producing exactly the
 * symptom of an active attack. There is one function that builds the prefix, it
 * takes the string, and it measures.
 *
 * The two renderings are named apart on purpose. `requestIndices132`
 * authenticates the receive request against an OFFLINE, known-target grind and
 * carries 132 bits. `confirmationIndices88` authenticates the sealed package in
 * an ONLINE, unknown-target ceremony and carries 88. They are different values
 * at different strengths for different threat models, and §8.2 says confusing
 * them would be easy and bad.
 * ========================================================================= */

import Crypto
import Foundation

public enum SptFingerprint {
    /// `uint8(len(DS)) ‖ DS`, with the length measured from the encoded bytes and
    /// asserted into 1..255. Exported because the HKDF `info` strings of §7.3 are
    /// built the same way and must not grow a second, subtly different builder.
    public static func domainPrefix(_ separator: String) throws -> [UInt8] {
        let ds = try SptBytes.asciiBytes(separator)
        guard ds.count >= 1, ds.count <= 255 else {
            throw SptError.domainSeparatorLength(ds.count)
        }
        return [UInt8(ds.count)] + ds
    }

    /// H_ds(DS, X).
    public static func hashDomain(_ separator: String, _ payload: [UInt8]) throws -> [UInt8] {
        var input = try domainPrefix(separator)
        input.append(contentsOf: payload)
        return Array(SHA256.hash(data: input))
    }

    /// requestHash = H_ds(DS_REQUEST_FP, canonicalRequestBody) — over the
    /// COMPLETE 1235-byte body of §5.1, never a subset. Substituting the version,
    /// the suite, the requestId or the encapsulation key changes the fingerprint.
    public static func requestFingerprint(_ canonicalRequestBody: [UInt8]) throws -> [UInt8] {
        try hashDomain(SptConstants.dsRequestFP, canonicalRequestBody)
    }

    /// §6.3. requestHash[0..17) as a big-endian 136-bit integer, low 4 bits
    /// discarded, the remaining 132 split into twelve 11-bit indices,
    /// most-significant first. An exact, non-overlapping partition: every one of
    /// the 132 bits lands in exactly one index, and the four discarded bits land
    /// in none.
    public static func requestIndices132(_ requestHash: [UInt8]) throws -> [Int] {
        guard requestHash.count >= 17 else {
            throw SptError.wrongLength("requestIndices132", expected: 17, got: requestHash.count)
        }
        return SptBytes.elevenBitIndices(requestHash, count: SptConstants.requestWordsCount)
    }

    /// §8.2. confirmValue[0..11) as a big-endian 88-bit integer split into eight
    /// 11-bit indices. Nothing is discarded here: 88 is already 8 × 11.
    public static func confirmationIndices88(_ confirmValue: [UInt8]) throws -> [Int] {
        guard confirmValue.count >= SptConstants.confirmValueBytes else {
            throw SptError.wrongLength("confirmationIndices88",
                                       expected: SptConstants.confirmValueBytes,
                                       got: confirmValue.count)
        }
        return SptBytes.elevenBitIndices(confirmValue, count: SptConstants.confirmWordsCount)
    }
}
