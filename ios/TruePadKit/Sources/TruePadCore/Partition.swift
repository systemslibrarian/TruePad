/* ============================================================================
 * TruePad v2 source-material partition (FORMAT-V2.md §7, §1.2)
 * ----------------------------------------------------------------------------
 * Byte-exact twin of src/core/partition2.ts. Pure byte movement, nothing else.
 *
 * This module combines declared sources by bytewise XOR and carves the combined
 * material into the four secret slices of a pair:
 *
 *   M[0        .. E)          A->B encryption slice  (byte e ↦ offset e)
 *   M[E        .. E+32N)      A->B authentication slice
 *   M[E+32N    .. 2E+32N)     B->A encryption slice  (byte E+32N+e ↦ offset e)
 *   M[2E+32N   .. 2E+64N)     B->A authentication slice
 *
 * with E = capacity, N = capacityRecords, and L = 2·(E + 32·N) the length every
 * declared source must supply. Every combined byte lands in exactly one slice at
 * exactly one position; the XOR and this partition are the ONLY operations
 * between declared sources and secret body — no KDF, no extractor, no hash
 * conditioner, ever (§7). Within an authentication slice, record s is bytes
 * [32s, 32s+16) as K_s and [32s+16, 32s+32) as R_s (§1.2) — key first, then mask.
 *
 * What this module is NOT: it does not read files, judge uniformity, or enforce
 * the one-file-one-source rule. The verdict for combined material belongs to the
 * generation layer ("Uniform if at least one declared source was uniform and
 * independent of the others").
 *
 * It also never zeroizes: `partition` returns fresh copies precisely so the
 * caller can zero the combined buffer, and each slice, on its own schedule
 * without the copies aliasing it. (Swift arrays are value types, so the copies
 * are structural rather than a discipline anyone has to remember.)
 * ========================================================================= */

public enum Partition {
    /// K_s is the first 16 bytes of a 32-byte auth record; R_s the second 16.
    static let keyBytes = 16

    public enum Failure: Error, Equatable {
        case negativeBudget(String, Int)
        case noSources
        case sourceTooShort(index: Int, supplied: Int, required: Int)
        case combinedWrongLength(supplied: Int, required: Int)
        case authRecordOutOfRange(sequence: Int, sliceCount: Int)
    }

    static func assertBudget(_ name: String, _ value: Int) throws {
        guard value >= 0 else { throw Failure.negativeBudget(name, value) }
    }

    /// L = 2·(E + 32·N): the exact byte count every declared source must supply
    /// (§7). Surplus beyond L is never used.
    public static func requiredSourceLength(capacity: Int, capacityRecords: Int) throws -> Int {
        try assertBudget("capacity", capacity)
        try assertBudget("capacityRecords", capacityRecords)
        return 2 * (capacity + WcOneTime.authRecordBytes * capacityRecords)
    }

    public struct PairSlices: Sendable {
        public let abEncryption: [UInt8]
        public let abAuthentication: [UInt8]
        public let baEncryption: [UInt8]
        public let baAuthentication: [UInt8]
    }

    /// Bytewise XOR of the first `length` bytes of every source. All-or-nothing:
    /// a source shorter than `length` — or no sources at all — throws before any
    /// byte is combined. Bytes beyond `length` are not read.
    public static func combineSources(_ sources: [[UInt8]], length: Int) throws -> [UInt8] {
        try assertBudget("length", length)
        guard !sources.isEmpty else { throw Failure.noSources }
        for (i, source) in sources.enumerated() where source.count < length {
            throw Failure.sourceTooShort(index: i, supplied: source.count, required: length)
        }
        var combined = [UInt8](repeating: 0, count: length)
        for source in sources {
            for i in 0..<length { combined[i] ^= source[i] }
        }
        return combined
    }

    /// The §7 partition, exactly: [abEnc E][abAuth 32N][baEnc E][baAuth 32N].
    /// `combined` must be exactly L = 2·(E + 32·N) bytes.
    public static func partition(_ combined: [UInt8],
                                 capacity: Int,
                                 capacityRecords: Int) throws -> PairSlices {
        let length = try requiredSourceLength(capacity: capacity, capacityRecords: capacityRecords)
        guard combined.count == length else {
            throw Failure.combinedWrongLength(supplied: combined.count, required: length)
        }
        let authBytes = WcOneTime.authRecordBytes * capacityRecords
        var cursor = 0
        func take(_ count: Int) -> [UInt8] {
            let out = Array(combined[cursor..<(cursor + count)])
            cursor += count
            return out
        }
        return PairSlices(
            abEncryption: take(capacity),
            abAuthentication: take(authBytes),
            baEncryption: take(capacity),
            baAuthentication: take(authBytes)
        )
    }

    public struct AuthRecord: Sendable, Equatable {
        public let key: [UInt8]
        public let mask: [UInt8]
    }

    /// Auth record `sequence` out of a direction's authentication slice: bytes
    /// [32s, 32s+16) as the hash key K_s, [32s+16, 32s+32) as the mask R_s —
    /// slice-local offsets (§1.2). A sequence past the slice throws: no record
    /// beyond capacityRecords exists, and this module never invents one.
    public static func authRecord(in authSlice: [UInt8], sequence: Int) throws -> AuthRecord {
        try assertBudget("sequence", sequence)
        let start = sequence * WcOneTime.authRecordBytes
        guard start + WcOneTime.authRecordBytes <= authSlice.count else {
            throw Failure.authRecordOutOfRange(sequence: sequence, sliceCount: authSlice.count)
        }
        return AuthRecord(
            key: Array(authSlice[start..<(start + keyBytes)]),
            mask: Array(authSlice[(start + keyBytes)..<(start + WcOneTime.authRecordBytes)])
        )
    }
}
