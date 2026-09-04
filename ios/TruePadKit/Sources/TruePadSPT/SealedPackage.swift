/* ============================================================================
 * TPS2 — the Sealed Package header and parser
 * ----------------------------------------------------------------------------
 * Byte-exact twin of src/spt/sealed-package.ts.
 * docs/SEALED-PAD-TRANSFER.md §7.1 and §7.2. A 1195-byte header that is ALSO the
 * AAD in its entirety, then the AES-256-GCM ciphertext, then the 16-byte tag.
 * Fixed overhead 1211 bytes.
 *
 * Every public field is authenticated. There is no unauthenticated routing
 * metadata, because unauthenticated metadata that later changes semantics is how
 * protocols get confused.
 *
 * This module is STRUCTURE ONLY. It never decapsulates, never derives a key, and
 * never decrypts — so a caller can reject a malformed or hostile package without
 * having touched a private key, and without having allocated anything
 * proportional to what the package CLAIMS. The declared plaintext length is read
 * as a UInt64 and range-checked before it is ever converted to an Int.
 * ========================================================================= */

import Crypto
import Foundation

public struct SealedHeader: Sendable, Equatable {
    public let version: UInt8
    public let suite: UInt16
    public let requestId: [UInt8]
    public let requestHash: [UInt8]
    public let kemCiphertext: [UInt8]
    public let nonce: [UInt8]
    public let plaintextLength: Int
}

public struct ParsedPackage: Sendable {
    public let header: SealedHeader
    /// Bytes [0, 1195) — the AAD, verbatim.
    public let aad: [UInt8]
    public let ciphertext: [UInt8]
    public let tag: [UInt8]
}

public enum PackageParseError: String, Sendable, Equatable {
    case wrongMagic = "wrong-magic"
    case unsupportedVersion = "unsupported-version"
    case unsupportedSuite = "unsupported-suite"
    case tooShort = "too-short"
    case declaredLengthTooLarge = "declared-length-too-large"
    case lengthMismatch = "length-mismatch"
}

public enum PackageParse: Sendable {
    case ok(ParsedPackage)
    case failed(reason: PackageParseError, message: String)
}

public struct HeaderFields {
    public let requestId: [UInt8]
    public let requestHash: [UInt8]
    public let kemCiphertext: [UInt8]
    public let nonce: [UInt8]
    public let plaintextLength: Int

    public init(requestId: [UInt8], requestHash: [UInt8], kemCiphertext: [UInt8],
                nonce: [UInt8], plaintextLength: Int) {
        self.requestId = requestId
        self.requestHash = requestHash
        self.kemCiphertext = kemCiphertext
        self.nonce = nonce
        self.plaintextLength = plaintextLength
    }
}

public enum SealedPackageCodec {
    /// Build the 1195-byte header. It is returned as its own buffer because it is
    /// used twice — as the package prefix and as the AAD — and the two must be
    /// the same bytes by construction rather than by a later copy that could
    /// drift.
    public static func buildHeader(_ fields: HeaderFields) throws -> [UInt8] {
        let O = SptConstants.TPS2Offsets.self
        guard fields.requestId.count == SptConstants.requestIdBytes else {
            throw SptError.wrongLength("requestId", expected: SptConstants.requestIdBytes,
                                       got: fields.requestId.count)
        }
        guard fields.requestHash.count == SptConstants.requestHashBytes else {
            throw SptError.wrongLength("requestHash", expected: SptConstants.requestHashBytes,
                                       got: fields.requestHash.count)
        }
        guard fields.kemCiphertext.count == SptConstants.xwingCiphertextBytes else {
            throw SptError.wrongLength("kemCiphertext", expected: SptConstants.xwingCiphertextBytes,
                                       got: fields.kemCiphertext.count)
        }
        guard fields.nonce.count == SptConstants.aeadNonceBytes else {
            throw SptError.wrongLength("nonce", expected: SptConstants.aeadNonceBytes,
                                       got: fields.nonce.count)
        }
        guard fields.plaintextLength >= 0,
              fields.plaintextLength <= SptConstants.maxPlaintextBytes else {
            throw SptError.plaintextLengthOutOfRange(fields.plaintextLength)
        }

        var header = [UInt8](repeating: 0, count: SptConstants.tps2HeaderBytes)
        header.replaceSubrange(O.magic..<(O.magic + 4), with: SptConstants.tps2MagicBytes)
        header[O.version] = SptConstants.transferVersion
        SptBytes.writeUInt16BE(&header, O.suite, SptConstants.suiteId)
        header.replaceSubrange(O.requestId..<O.requestHash, with: fields.requestId)
        header.replaceSubrange(O.requestHash..<O.kemCiphertext, with: fields.requestHash)
        header.replaceSubrange(O.kemCiphertext..<O.nonce, with: fields.kemCiphertext)
        header.replaceSubrange(O.nonce..<O.plaintextLength, with: fields.nonce)
        SptBytes.writeUInt64BE(&header, O.plaintextLength, UInt64(fields.plaintextLength))
        return header
    }

    /// Structural parse. Ordered so that the cheapest and most discriminating
    /// checks run first and nothing large is allocated on the strength of a
    /// number the package chose for itself.
    public static func parse(_ bytes: [UInt8]) -> PackageParse {
        let O = SptConstants.TPS2Offsets.self
        guard bytes.count >= SptConstants.tps2FixedOverheadBytes else {
            return .failed(reason: .tooShort,
                           message: "a sealed package is at least \(SptConstants.tps2FixedOverheadBytes) bytes, got \(bytes.count)")
        }
        guard SptBytes.equal(Array(bytes[0..<4]), SptConstants.tps2MagicBytes) else {
            return .failed(reason: .wrongMagic, message: "not a sealed transfer package")
        }
        let version = bytes[O.version]
        guard version == SptConstants.transferVersion else {
            return .failed(reason: .unsupportedVersion,
                           message: "unsupported transfer version 0x\(String(version, radix: 16))")
        }
        let suite = SptBytes.readUInt16BE(bytes, O.suite)
        guard suite == SptConstants.suiteId else {
            let hex = String(format: "%04x", suite)
            return .failed(reason: .unsupportedSuite, message: "unsupported suite 0x\(hex)")
        }
        // UInt64 first, range second, Int last — in that order, always.
        let declared = SptBytes.readUInt64BE(bytes, O.plaintextLength)
        guard declared <= UInt64(SptConstants.maxPlaintextBytes) else {
            return .failed(reason: .declaredLengthTooLarge,
                           message: "declared plaintext length exceeds \(SptConstants.maxPlaintextBytes) bytes")
        }
        let plaintextLength = Int(declared)
        // Exact, not ">=": trailing bytes are a length disagreement, and a
        // package with something appended is not this package.
        let expected = SptConstants.tps2FixedOverheadBytes + plaintextLength
        guard bytes.count == expected else {
            return .failed(reason: .lengthMismatch,
                           message: "declared plaintext \(plaintextLength) implies \(expected) bytes, got \(bytes.count)")
        }

        let header = SealedHeader(
            version: version,
            suite: suite,
            requestId: Array(bytes[O.requestId..<O.requestHash]),
            requestHash: Array(bytes[O.requestHash..<O.kemCiphertext]),
            kemCiphertext: Array(bytes[O.kemCiphertext..<O.nonce]),
            nonce: Array(bytes[O.nonce..<O.plaintextLength]),
            plaintextLength: plaintextLength
        )
        return .ok(ParsedPackage(
            header: header,
            aad: Array(bytes[0..<SptConstants.tps2HeaderBytes]),
            ciphertext: Array(bytes[SptConstants.tps2HeaderBytes..<(SptConstants.tps2HeaderBytes + plaintextLength)]),
            tag: Array(bytes[(SptConstants.tps2HeaderBytes + plaintextLength)...])
        ))
    }

    /// SHA-256 over the COMPLETE package — magic through the final GCM tag.
    ///
    /// Not SHA-256(AAD): the AAD is only the 1195-byte header and commits to
    /// neither the ciphertext nor the tag, so two packages differing solely in
    /// one of those would have shared an identity (§10.1).
    ///
    /// This is local bookkeeping AFTER AEAD verification — "which package was
    /// this" — and never a security substitute for the tag.
    public static func packageIdentity(_ packageBytes: [UInt8]) -> [UInt8] {
        Array(SHA256.hash(data: packageBytes))
    }
}
