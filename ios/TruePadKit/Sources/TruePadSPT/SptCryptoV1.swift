/* ============================================================================
 * Suite 0x0001 — key derivation, sealing, and opening
 * ----------------------------------------------------------------------------
 * Byte-exact twin of src/spt/crypto-v1.ts.
 * docs/SEALED-PAD-TRANSFER.md §7.3, §7.4 and §20.
 *
 * WHAT THIS LAYER IS, AND WHAT IT IS NOT
 * --------------------------------------
 * `seal` and `open` are LOW-LEVEL, PURE operations over opaque bytes. They exist
 * so the cryptography can be composed and given reference vectors. They are NOT
 * the product's authorization boundary.
 *
 * The product operation names the PAD and reads the live store. §18 forbids
 * exporting pad material in plaintext so a caller can encrypt it, and taking pad
 * bytes from a caller would also make the §10.6 genesis check evaluate a
 * snapshot the CALLER chose: sealing weeks-old genesis bytes to a second
 * recipient would pass every check and produce a two-time pad. There must never
 * be an API named `seal(body, padFileBytes)`. The byte-taking functions below are
 * for cryptographic composition and tests; the durable layer wraps them and does
 * not expose them.
 *
 * ORDERING, WHICH IS NOT FREE TO CHOOSE
 * -------------------------------------
 * The nonce depends on padHash alone; the AEAD key and the confirmation value
 * depend on the AAD, which CONTAINS the nonce. So: padHash → nonce → header →
 * aeadKey and confirmValue. Any other order is a different protocol.
 *
 * HKDF here is swift-crypto's own RFC 5869 (`HKDF<SHA256>.extract` / `.expand`),
 * not a TruePad composition. The Browser Edition composes HKDF by hand only
 * because WebCrypto caps `algorithm.info` at 1024 bytes on Node while §7.3's
 * AEAD-key info is 1219 bytes; Swift has no such cap, so the platform's HKDF is
 * used directly and the RFC 5869 arithmetic is not re-implemented here.
 * ========================================================================= */

import Crypto
import Foundation

public struct SealResult: Sendable {
    /// The complete TPS2 bytes.
    public let packageBytes: [UInt8]
    public let confirmValue: [UInt8]
    public let confirmationIndices: [Int]
    public let requestHash: [UInt8]
    public let packageIdentity: [UInt8]
}

public struct OpenResult: Sendable {
    /// The exact bytes that were sealed.
    public let payload: [UInt8]
    public let confirmValue: [UInt8]
    public let confirmationIndices: [Int]
    public let requestHash: [UInt8]
    public let packageIdentity: [UInt8]
}

public enum OpenError: String, Sendable, Equatable {
    // Structural refusals, forwarded verbatim from the package parser.
    case wrongMagic = "wrong-magic"
    case unsupportedVersion = "unsupported-version"
    case unsupportedSuite = "unsupported-suite"
    case tooShort = "too-short"
    case declaredLengthTooLarge = "declared-length-too-large"
    case lengthMismatch = "length-mismatch"
    /// The supplied request body is not a canonical §5.1 body at all. Refused
    /// before it is hashed, sliced, or used to name a request domain.
    case malformedRequestBody = "malformed-request-body"
    /// The package is for a different request than the one supplied.
    case requestMismatch = "request-mismatch"
    /// ONE outcome for decapsulation failure AND AEAD verification failure. §11:
    /// the protocol offers no decapsulation oracle, so these are deliberately
    /// indistinguishable from outside.
    case cryptographicOpenFailed = "cryptographic-open-failed"
    /// DISTINCT by design (§7.4, §20). padHash never travels and the nonce is
    /// carried rather than re-derived, so a wrong DS_PAD length octet would fork
    /// the nonce silently between builds and every package would still verify.
    /// Re-deriving and comparing turns that whole bug class into a refusal.
    case derivedNonceMismatch = "derived-nonce-mismatch"

    init(_ parse: PackageParseError) {
        switch parse {
        case .wrongMagic: self = .wrongMagic
        case .unsupportedVersion: self = .unsupportedVersion
        case .unsupportedSuite: self = .unsupportedSuite
        case .tooShort: self = .tooShort
        case .declaredLengthTooLarge: self = .declaredLengthTooLarge
        case .lengthMismatch: self = .lengthMismatch
        }
    }
}

public enum OpenOutcome: Sendable {
    case ok(OpenResult)
    case failed(reason: OpenError, message: String)
}

public enum SptCryptoV1 {
    // ---- the derivations of §7.3 / §7.4 ------------------------------------

    /// info = uint8(len(DS)) ‖ DS ‖ context — the same measured prefix as H_ds,
    /// and the ONLY place any of the three infos is built. Three near-identical
    /// builders would be three chances to reorder a field.
    static func info(_ separator: String, _ context: [UInt8]) throws -> [UInt8] {
        var out = try SptFingerprint.domainPrefix(separator)
        out.append(contentsOf: context)
        return out
    }

    /// PRK = HKDF-Extract(salt = requestHash, IKM = ss). §7.3.
    public static func derivePrk(sharedSecret: [UInt8], requestHash: [UInt8]) -> [UInt8] {
        let prk = HKDF<SHA256>.extract(
            inputKeyMaterial: SymmetricKey(data: sharedSecret),
            salt: requestHash
        )
        return Array(prk)
    }

    public static func derivePadHash(_ payload: [UInt8]) throws -> [UInt8] {
        try SptFingerprint.hashDomain(SptConstants.dsPad, payload)
    }

    static func expand(prk: [UInt8], separator: String, context: [UInt8], count: Int) throws -> [UInt8] {
        let key = HKDF<SHA256>.expand(
            pseudoRandomKey: prk,
            info: try info(separator, context),
            outputByteCount: count
        )
        return key.withUnsafeBytes { [UInt8]($0) }
    }

    public static func nonce(prk: [UInt8], padHash: [UInt8]) throws -> [UInt8] {
        try expand(prk: prk, separator: SptConstants.dsNonce, context: padHash,
                   count: SptConstants.aeadNonceBytes)
    }

    public static func aeadKey(prk: [UInt8], aad: [UInt8]) throws -> [UInt8] {
        try expand(prk: prk, separator: SptConstants.dsAeadKey, context: aad,
                   count: SptConstants.aeadKeyBytes)
    }

    public static func confirmValue(prk: [UInt8], aad: [UInt8]) throws -> [UInt8] {
        try expand(prk: prk, separator: SptConstants.dsConfirm, context: aad,
                   count: SptConstants.confirmValueBytes)
    }

    // ---- seal --------------------------------------------------------------

    /// LOW-LEVEL. See the banner: this takes bytes; the product operation takes a
    /// pairId.
    ///
    /// **There is exactly one authority for the recipient's KEM identity: the
    /// request body.** The encapsulation key is read out of the body that names
    /// it, never passed alongside it — otherwise an honest caller mixing up two
    /// open requests (body `B` with the key from `B'`) would produce a package
    /// whose `requestHash` names `B` while the KEM ciphertext is for `B'`:
    /// unopenable by `B`, and, once the durable layer wraps this, a package that
    /// spends the sender's one handoff (§10.6) on nothing.
    ///
    /// `encapsulator` exists so the frozen reference vectors can be reproduced
    /// with fixed entropy from a TEST target. It defaults to the system CSPRNG
    /// and, crucially, cannot carry entropy: `XWingEncapsulating` takes the
    /// recipient's key and nothing else.
    public static func seal(
        canonicalRequestBody: [UInt8],
        payload: [UInt8],
        encapsulator: any XWingEncapsulating = SystemXWingEncapsulator()
    ) throws -> SealResult {
        guard payload.count <= SptConstants.maxPlaintextBytes else {
            throw SptError.payloadTooLarge(payload.count)
        }
        // Validate BEFORE any KEM work: no cryptographic operation over a body
        // this build does not recognise as a request.
        let request: ReceiveRequest
        let canonicalBody: [UInt8]
        switch ReceiveRequestCodec.parseBody(canonicalRequestBody) {
        case .failed(let reason, let message):
            throw SptError.malformedRequestBody(reason: reason, message: message)
        case .ok(let r, let body):
            request = r
            canonicalBody = body
        }

        let requestHash = try SptFingerprint.requestFingerprint(canonicalBody)
        let encapsulation = try encapsulator.encapsulate(encapsulationKey: request.encapsulationKey)
        try XWing.requireLength(encapsulation.ciphertext,
                                SptConstants.xwingCiphertextBytes, "ciphertext")
        try XWing.requireLength(encapsulation.sharedSecret,
                                SptConstants.xwingSharedSecretBytes, "sharedSecret")

        var sharedSecret = encapsulation.sharedSecret
        var prk = derivePrk(sharedSecret: sharedSecret, requestHash: requestHash)
        var aeadKeyBytes = [UInt8]()
        defer {
            // Buffers this function owns. NOT `payload`, `encapsulationKey` or
            // `canonicalRequestBody` — those belong to the caller.
            SptBytes.wipe(&sharedSecret)
            SptBytes.wipe(&prk)
            SptBytes.wipe(&aeadKeyBytes)
        }

        var padHash = try derivePadHash(payload)
        let nonceBytes = try nonce(prk: prk, padHash: padHash)
        SptBytes.wipe(&padHash)

        let header = try SealedPackageCodec.buildHeader(HeaderFields(
            requestId: request.requestId,
            requestHash: requestHash,
            kemCiphertext: encapsulation.ciphertext,
            nonce: nonceBytes,
            plaintextLength: payload.count
        ))

        aeadKeyBytes = try aeadKey(prk: prk, aad: header)
        let sealedBox = try AES.GCM.seal(
            payload,
            using: SymmetricKey(data: aeadKeyBytes),
            nonce: try AES.GCM.Nonce(data: nonceBytes),
            authenticating: header
        )
        let confirm = try confirmValue(prk: prk, aad: header)
        let packageBytes = SptBytes.concat(header,
                                           [UInt8](sealedBox.ciphertext),
                                           [UInt8](sealedBox.tag))

        return SealResult(
            packageBytes: packageBytes,
            confirmValue: confirm,
            confirmationIndices: try SptFingerprint.confirmationIndices88(confirm),
            requestHash: requestHash,
            packageIdentity: SealedPackageCodec.packageIdentity(packageBytes)
        )
    }

    // ---- open --------------------------------------------------------------

    /// LOW-LEVEL. The request binding is supplied by the caller at this layer:
    /// the complete canonical request body, from which requestHash is recomputed
    /// and compared with the header. A higher layer looks that body up by
    /// requestId; this one is told.
    public static func open(
        packageBytes: [UInt8],
        canonicalRequestBody: [UInt8],
        decapsulationSeed: [UInt8]
    ) -> OpenOutcome {
        let parsed: ParsedPackage
        switch SealedPackageCodec.parse(packageBytes) {
        case .failed(let reason, let message):
            return .failed(reason: OpenError(reason), message: message)
        case .ok(let p):
            parsed = p
        }

        // The SAME parser the text decoder and seal() use. A caller buffer that
        // is 1235-ish but not a canonical request must not silently become a
        // different request domain by being hashed as though it were one.
        let request: ReceiveRequest
        let canonicalBody: [UInt8]
        switch ReceiveRequestCodec.parseBody(canonicalRequestBody) {
        case .failed(_, let message):
            return .failed(reason: .malformedRequestBody, message: message)
        case .ok(let r, let body):
            request = r
            canonicalBody = body
        }

        do {
            let requestHash = try SptFingerprint.requestFingerprint(canonicalBody)
            guard SptBytes.equal(parsed.header.requestId, request.requestId),
                  SptBytes.equal(parsed.header.requestHash, requestHash) else {
                return .failed(reason: .requestMismatch,
                               message: "this package is for a different receive request")
            }

            var sharedSecret: [UInt8]
            do {
                sharedSecret = try XWing.decapsulate(ciphertext: parsed.header.kemCiphertext,
                                                     decapsulationSeed: decapsulationSeed)
            } catch {
                // Decapsulation and AEAD failures are ONE outcome. Reporting them
                // apart would be a decapsulation oracle.
                return .failed(reason: .cryptographicOpenFailed,
                               message: "this package could not be opened for this request")
            }

            var prk = derivePrk(sharedSecret: sharedSecret, requestHash: requestHash)
            var aeadKeyBytes = [UInt8]()
            defer {
                SptBytes.wipe(&sharedSecret)
                SptBytes.wipe(&prk)
                SptBytes.wipe(&aeadKeyBytes)
            }

            aeadKeyBytes = try aeadKey(prk: prk, aad: parsed.aad)
            var plaintext: [UInt8]
            do {
                let box = try AES.GCM.SealedBox(
                    nonce: try AES.GCM.Nonce(data: parsed.header.nonce),
                    ciphertext: parsed.ciphertext,
                    tag: parsed.tag
                )
                plaintext = [UInt8](try AES.GCM.open(box,
                                                     using: SymmetricKey(data: aeadKeyBytes),
                                                     authenticating: parsed.aad))
            } catch {
                return .failed(reason: .cryptographicOpenFailed,
                               message: "this package could not be opened for this request")
            }

            // AFTER verification, never before: re-derive the nonce from the
            // plaintext we now hold and compare it with the one the package
            // carried.
            var padHash = try derivePadHash(plaintext)
            let expectedNonce = try nonce(prk: prk, padHash: padHash)
            SptBytes.wipe(&padHash)
            guard SptBytes.equal(expectedNonce, parsed.header.nonce) else {
                SptBytes.wipe(&plaintext)
                return .failed(reason: .derivedNonceMismatch,
                               message: "the package nonce is not the one this payload derives")
            }

            let confirm = try confirmValue(prk: prk, aad: parsed.aad)
            return .ok(OpenResult(
                payload: plaintext,
                confirmValue: confirm,
                confirmationIndices: try SptFingerprint.confirmationIndices88(confirm),
                requestHash: requestHash,
                packageIdentity: SealedPackageCodec.packageIdentity(packageBytes)
            ))
        } catch {
            return .failed(reason: .cryptographicOpenFailed,
                           message: "this package could not be opened for this request")
        }
    }
}
