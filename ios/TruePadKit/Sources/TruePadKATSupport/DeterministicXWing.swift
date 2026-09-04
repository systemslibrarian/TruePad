//===----------------------------------------------------------------------===//
//
// TEST SUPPORT ONLY -- NOT LINKED BY THE SHIPPING TRUEPAD APP.
//
// TruePad must prove, byte for byte, that its iOS X-Wing is the same
// construction the Browser and Android editions use. The proofs that establish
// that -- the draft-10 Appendix-C known-answer vectors, and TruePad's own
// deterministic SPT interop fixtures -- pin the encapsulation entropy and the
// resulting ciphertext. Reproducing them requires derandomized encapsulation.
//
// Handing a caller control of encapsulation entropy is catastrophic in
// production: reused entropy means a reused ML-KEM ciphertext and a reused
// shared secret. So this capability is kept structurally out of reach:
//
//   * it lives in a target that is NOT a package product;
//   * TruePadSPT (the only product) does not depend on that target;
//   * therefore an app linking TruePadSPT cannot reference this code at all;
//   * and the file additionally refuses to compile without TRUEPAD_KAT_SUPPORT,
//     which only this target defines.
//
// Production sealing obtains its entropy from the system CSPRNG via
// XWingMLKEM768X25519.PublicKey.encapsulate(); no production type accepts an
// `eseed` parameter.
//
//===----------------------------------------------------------------------===//

#if !TRUEPAD_KAT_SUPPORT
#error("TruePadKATSupport must never be compiled into a production target.")
#endif

import CCryptoBoringSSL
import Foundation

/// Deterministic X-Wing encapsulation, for known-answer and interop fixtures only.
public enum DeterministicXWing {
    /// Byte counts, taken from the vendored BoringSSL header so a size drift is a
    /// compile-time/precondition failure rather than a silent truncation.
    public static let publicKeyBytes = Int(XWING_PUBLIC_KEY_BYTES)     // 1216
    public static let privateKeySeedBytes = Int(XWING_PRIVATE_KEY_BYTES) // 32
    public static let ciphertextBytes = Int(XWING_CIPHERTEXT_BYTES)    // 1120
    public static let sharedSecretBytes = Int(XWING_SHARED_SECRET_BYTES) // 32
    /// ML-KEM-768 encapsulation coins (32) ‖ ephemeral X25519 private key (32).
    public static let entropyBytes = 64

    public enum Failure: Error {
        case badPublicKeyLength(Int)
        case badEntropyLength(Int)
        /// BoringSSL refused: a malformed ML-KEM key, or an X25519 result that is
        /// all-zero (the low-order / hostile-point case TruePad rejects).
        case encapsulationRejected
    }

    /// Encapsulate to `publicKey` using exactly the supplied `eseed`.
    ///
    /// - Parameters:
    ///   - publicKey: 1216 bytes, ML-KEM-768 public key ‖ X25519 public key.
    ///   - eseed: 64 bytes, ML-KEM-768 coins ‖ ephemeral X25519 private key.
    /// - Returns: the 1120-byte ciphertext and 32-byte shared secret.
    public static func encapsulate(
        publicKey: [UInt8],
        eseed: [UInt8]
    ) throws -> (ciphertext: [UInt8], sharedSecret: [UInt8]) {
        guard publicKey.count == publicKeyBytes else {
            throw Failure.badPublicKeyLength(publicKey.count)
        }
        guard eseed.count == entropyBytes else {
            throw Failure.badEntropyLength(eseed.count)
        }

        var ciphertext = [UInt8](repeating: 0, count: ciphertextBytes)
        var sharedSecret = [UInt8](repeating: 0, count: sharedSecretBytes)

        let rc = ciphertext.withUnsafeMutableBufferPointer { ct in
            sharedSecret.withUnsafeMutableBufferPointer { ss in
                publicKey.withUnsafeBufferPointer { pk in
                    eseed.withUnsafeBufferPointer { es in
                        CCryptoBoringSSL_XWING_encap_external_entropy(
                            ct.baseAddress, ss.baseAddress, pk.baseAddress, es.baseAddress
                        )
                    }
                }
            }
        }
        guard rc == 1 else { throw Failure.encapsulationRejected }
        return (ciphertext, sharedSecret)
    }
}
