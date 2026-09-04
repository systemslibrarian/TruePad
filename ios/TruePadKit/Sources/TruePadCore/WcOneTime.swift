/* ============================================================================
 * TruePad wc-one-time-v1 — canonical bytes, hash, tag
 * ----------------------------------------------------------------------------
 * Byte-exact twin of src/core/wc-one-time.ts.
 *
 * wc-one-time-v1 is TruePad's instantiation and encoding of POLYVAL (RFC 8452)
 * under a Wegman–Carter one-time mask. It is NOT a new hash, and this module is
 * NOT the security argument — FORMAT-V2.md §5 is, by citation. For the record
 * with sequence s and auth record (K_s, R_s):
 *
 *   tag = POLYVAL(K_s, canonical bytes) XOR R_s
 *
 * where the canonical bytes are the §6.1 layout built here: a fixed 64-byte
 * header (domain separator, pairId, formatVersion, direction, reserved zeros,
 * sequence, startOffset, ciphertextLength — all integers u64 LE), then the
 * ciphertext, then 0x00 padding to a 16-byte boundary. Tags are computed over
 * these bytes and NEVER over JSON or any re-serialization of JSON.
 *
 * Each (K_s, R_s) authenticates exactly one canonical byte string, ever;
 * enforcing that one-time discipline — sequence windows, attempt limits, durable
 * reservation — is the store's job, not this module's. This module also does no
 * wire parsing: the envelope parser owns the strict parse and projects into
 * CanonicalFields, so every domain violation here throws rather than returning a
 * typed refusal.
 *
 * All 2^128 key values are legal, including zero — the §5 bound accounts for
 * every key, so there is no rejection step and no conditioning of any kind
 * between pad material and key. POLYVAL under an all-zero key hashes everything
 * to zero; that is a fact about the family the bound already prices, not a state
 * this format manufactures.
 * ========================================================================= */

public enum PadDirection: String, Sendable, Equatable {
    case aToB = "A->B"
    case bToA = "B->A"

    /// §6.1: the direction octet in the canonical header.
    public var octet: UInt8 { self == .aToB ? 0x00 : 0x01 }
}

public enum WcOneTime {
    // ---- pinned constants (FORMAT-V2.md §§2.2, 4, 6.1, 8) ------------------

    /// §4: the one v2 ciphertext ceiling; §5.2 evaluates ε exactly here.
    public static let maxCiphertextBytes = 1_048_576

    /// §8.2: how far past nextSequence an envelope may reach (default).
    public static let maxAuthLookaheadDefault = 64

    /// §8.3: verification attempts per sequence, permanently (default).
    public static let verifyAttemptLimitDefault = 8

    /// §8.4: auth failures before the pair freezes (default).
    public static let freezeThresholdDefault = 32

    /// §1.2/§7: one auth record is K (16 bytes) then R (16 bytes).
    public static let authRecordBytes = 32

    /// §2.2: 128-bit tags are the only v2 width; 64-bit tags are forbidden.
    public static let tagBytes = 16

    /// §6.1: the fixed-width canonical header preceding the ciphertext.
    public static let canonicalHeaderBytes = 64

    /// §2.2: canonical block 1 — ASCII "wc-one-time-v1" then two 0x00 bytes.
    /// Fixed, nonzero, and first; the nonzero part is what §5.1's cross-length
    /// injectivity argument uses.
    public static let domainSeparator: [UInt8] = [
        0x77, 0x63, 0x2d, 0x6f, 0x6e, 0x65, 0x2d, 0x74,
        0x69, 0x6d, 0x65, 0x2d, 0x76, 0x31, 0x00, 0x00,
    ]

    // ---- canonical authenticated bytes (FORMAT-V2.md §6.1) ------------------

    /// The authenticated fields, post-parse: raw bytes and in-domain numbers,
    /// never wire spellings.
    public struct CanonicalFields: Sendable {
        public let pairId: [UInt8]        // exactly 16 bytes
        public let direction: PadDirection
        public let sequence: Int          // >= 0
        public let startOffset: Int       // >= 0
        public let ciphertext: [UInt8]    // count <= maxCiphertextBytes

        public init(pairId: [UInt8], direction: PadDirection,
                    sequence: Int, startOffset: Int, ciphertext: [UInt8]) {
            self.pairId = pairId
            self.direction = direction
            self.sequence = sequence
            self.startOffset = startOffset
            self.ciphertext = ciphertext
        }
    }

    public enum Failure: Error, Equatable {
        case pairIdLength(Int)
        case ciphertextTooLarge(Int)
        case negativeOrUnsafe(String, Int)
        case maskLength(Int)
    }

    /// A non-negative integer as 8 little-endian bytes.
    static func writeU64LE(_ out: inout [UInt8], _ offset: Int, _ value: Int, _ name: String) throws {
        guard value >= 0 else { throw Failure.negativeOrUnsafe(name, value) }
        var rest = UInt64(value)
        for i in 0..<8 {
            out[offset + i] = UInt8(rest & 0xff)
            rest >>= 8
        }
    }

    /// The exact byte string tags are computed over: the §6.1 layout, byte for
    /// byte. Total length 64 + C + p where p pads C to a 16-byte boundary; an
    /// empty ciphertext yields exactly the 64-byte header.
    public static func canonicalBytes(_ fields: CanonicalFields) throws -> [UInt8] {
        guard fields.pairId.count == 16 else { throw Failure.pairIdLength(fields.pairId.count) }
        guard fields.ciphertext.count <= maxCiphertextBytes else {
            throw Failure.ciphertextTooLarge(fields.ciphertext.count)
        }
        let padded = (fields.ciphertext.count + 15) / 16 * 16
        // A fresh allocation is already zeroed, so the reserved bytes [34, 40)
        // and the trailing padding are written by construction.
        var out = [UInt8](repeating: 0, count: canonicalHeaderBytes + padded)
        out.replaceSubrange(0..<16, with: domainSeparator)
        out.replaceSubrange(16..<32, with: fields.pairId)
        out[32] = 0x02                        // formatVersion
        out[33] = fields.direction.octet
        try writeU64LE(&out, 40, fields.sequence, "sequence")
        try writeU64LE(&out, 48, fields.startOffset, "startOffset")
        try writeU64LE(&out, 56, fields.ciphertext.count, "ciphertextLength")
        if !fields.ciphertext.isEmpty {
            out.replaceSubrange(canonicalHeaderBytes..<(canonicalHeaderBytes + fields.ciphertext.count),
                                with: fields.ciphertext)
        }
        return out
    }

    // ---- hash and tag -------------------------------------------------------

    /// The unmasked hash: POLYVAL(K, canonical bytes). NOT a tag — without the
    /// mask it is not safe to emit anywhere. Exposed for the verifier and for the
    /// frozen vectors' hash-only case.
    public static func hash(key: [UInt8], fields: CanonicalFields) throws -> [UInt8] {
        try Gf128.polyval(key: key, message: canonicalBytes(fields))
    }

    /// The tag: POLYVAL(K, canonical bytes) XOR R. The mask R is a one-time pad
    /// on the hash output — uniform, fresh, used once — which is what keeps the
    /// observed tag from revealing anything about K.
    public static func tag(key: [UInt8], mask: [UInt8], fields: CanonicalFields) throws -> [UInt8] {
        guard mask.count == tagBytes else { throw Failure.maskLength(mask.count) }
        let h = try hash(key: key, fields: fields)
        var out = [UInt8](repeating: 0, count: tagBytes)
        for i in 0..<tagBytes { out[i] = h[i] ^ mask[i] }
        return out
    }

    /// Tag comparison without a byte-position-dependent early return: one pass
    /// over all 16 bytes with an OR-accumulator, one comparison at the end.
    /// Anything that is not 16 bytes on either side is false up front — a length
    /// check, not a byte-wise walk.
    ///
    /// The claim is scoped honestly: what this code guarantees is the SHAPE (no
    /// early exit inside the byte loop), not a cycle count. The optimiser is not
    /// under our control and no constant-time claim is made anywhere in the spec.
    public static func tagsEqual(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        if a.count != tagBytes || b.count != tagBytes { return false }
        var diff: UInt8 = 0
        for i in 0..<tagBytes { diff |= a[i] ^ b[i] }
        return diff == 0
    }
}
