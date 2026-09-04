/* ============================================================================
 * X-Wing (suite 0x0001) — the narrow TruePad wrapper
 * ----------------------------------------------------------------------------
 * Byte-exact twin of src/spt/xwing-v1.ts.
 *
 * docs/SEALED-PAD-TRANSFER.md §2.2 freezes the WHOLE of
 * draft-connolly-cfrg-xwing-kem-10 as suite 0x0001. This file does not implement
 * it; it wraps swift-crypto's `XWingMLKEM768X25519`, whose construction is
 * BoringSSL's and is validated here against the draft's own Appendix C vectors
 * (XWingKATTests) and the cross-language SPT interop corpus.
 *
 * What this wrapper is FOR, given the library already exposes a KEM:
 *
 *   · it pins the sizes, so a library change that altered any of them fails here
 *     rather than three layers up;
 *   · it fixes TruePad's persisted private key as the 32-byte X-Wing SEED and
 *     never an expanded, implementation-specific key structure — the reason a
 *     recipient key stays portable across any conforming X-Wing implementation,
 *     and across editions;
 *   · it keeps encapsulation behind a protocol, so tests can supply the
 *     derandomized variant the reference vectors need WITHOUT that capability
 *     existing in a shipping build (see TruePadKATSupport).
 *
 * It adds NO cryptography. There is no TruePad combiner, no extra KDF, and no
 * all-zero X25519 policy of our own: adding any of those would take suite 0x0001
 * outside the construction that was analysed, which §2.2 refuses in terms.
 * BoringSSL already rejects a degenerate X25519 result, matching the Browser and
 * Android Editions; XWingHostileInputTests pins that as a contract.
 * ========================================================================= */

import Crypto
import Foundation

public struct XWingKeyPair: Sendable {
    /// The 32-byte X-Wing seed. THIS is the recipient's private key; everything
    /// else is re-derivable.
    public let decapsulationSeed: [UInt8]
    public let encapsulationKey: [UInt8]
}

public struct XWingEncapsulation: Sendable {
    public let ciphertext: [UInt8]
    public let sharedSecret: [UInt8]

    public init(ciphertext: [UInt8], sharedSecret: [UInt8]) {
        self.ciphertext = ciphertext
        self.sharedSecret = sharedSecret
    }
}

/// How a shared secret is encapsulated to a recipient.
///
/// Production has exactly one conformer, `SystemXWingEncapsulator`, which draws
/// its entropy from the system CSPRNG. The protocol exists so the deterministic
/// variant needed by the frozen reference vectors can be supplied by TESTS
/// without any production type ever accepting an `eseed`: note that the method
/// below takes the recipient's key and nothing else. There is deliberately no
/// entropy parameter anywhere in this module.
public protocol XWingEncapsulating: Sendable {
    func encapsulate(encapsulationKey: [UInt8]) throws -> XWingEncapsulation
}

public enum XWing {
    static func requireLength(_ bytes: [UInt8], _ expected: Int, _ what: String) throws {
        guard bytes.count == expected else {
            throw SptError.wrongLength(what, expected: expected, got: bytes.count)
        }
    }

    /// Production key generation. Randomness comes from the platform CSPRNG;
    /// §13 forbids a seed argument on this path.
    public static func generateKeyPair() throws -> XWingKeyPair {
        let priv = try XWingMLKEM768X25519.PrivateKey.generate()
        let seed = [UInt8](priv.seedRepresentation)
        let pub = [UInt8](priv.publicKey.rawRepresentation)
        try requireLength(seed, SptConstants.xwingSeedBytes, "decapsulationSeed")
        try requireLength(pub, SptConstants.xwingPublicKeyBytes, "encapsulationKey")
        return XWingKeyPair(decapsulationSeed: seed, encapsulationKey: pub)
    }

    /// Re-derive the encapsulation key from a stored seed. The seed is the
    /// persisted private key; this is how a recipient recovers its public half
    /// after a restart without having stored it.
    public static func publicKey(fromSeed seed: [UInt8]) throws -> [UInt8] {
        try requireLength(seed, SptConstants.xwingSeedBytes, "decapsulationSeed")
        let priv = try XWingMLKEM768X25519.PrivateKey(seedRepresentation: seed, publicKey: nil)
        let pub = [UInt8](priv.publicKey.rawRepresentation)
        try requireLength(pub, SptConstants.xwingPublicKeyBytes, "encapsulationKey")
        return pub
    }

    public static func decapsulate(ciphertext: [UInt8], decapsulationSeed: [UInt8]) throws -> [UInt8] {
        try requireLength(ciphertext, SptConstants.xwingCiphertextBytes, "ciphertext")
        try requireLength(decapsulationSeed, SptConstants.xwingSeedBytes, "decapsulationSeed")
        let priv = try XWingMLKEM768X25519.PrivateKey(
            seedRepresentation: decapsulationSeed, publicKey: nil)
        let ss = try priv.decapsulate(Data(ciphertext))
        let bytes = ss.withUnsafeBytes { [UInt8]($0) }
        try requireLength(bytes, SptConstants.xwingSharedSecretBytes, "sharedSecret")
        return bytes
    }
}

/// Production encapsulation. Randomness comes from the platform CSPRNG inside
/// swift-crypto; §13 forbids a seed argument on this path.
public struct SystemXWingEncapsulator: XWingEncapsulating {
    public init() {}

    public func encapsulate(encapsulationKey: [UInt8]) throws -> XWingEncapsulation {
        try XWing.requireLength(encapsulationKey,
                                SptConstants.xwingPublicKeyBytes, "encapsulationKey")
        let pub = try XWingMLKEM768X25519.PublicKey(rawRepresentation: encapsulationKey)
        let result = try pub.encapsulate()
        let ct = [UInt8](result.encapsulated)
        let ss = result.sharedSecret.withUnsafeBytes { [UInt8]($0) }
        try XWing.requireLength(ct, SptConstants.xwingCiphertextBytes, "ciphertext")
        try XWing.requireLength(ss, SptConstants.xwingSharedSecretBytes, "sharedSecret")
        return XWingEncapsulation(ciphertext: ct, sharedSecret: ss)
    }
}
