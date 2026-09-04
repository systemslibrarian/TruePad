import Crypto
import Foundation
import TruePadKATSupport
import XCTest

/// TruePad chose a CROSS-EDITION policy: an X25519 agreement that degenerates to
/// all-zero (a low-order / small-subgroup point) is REJECTED, not accepted. The
/// Browser edition rejects via @noble, Android via Bouncy Castle's own all-zero
/// detection. iOS must not become the odd edition out, so this is asserted as a
/// compatibility contract even though BoringSSL already rejects: if a future
/// vendored bump changed the behaviour, an edition-specific acceptance
/// difference would appear here rather than in the field.
final class XWingHostileInputTests: XCTestCase {
    typealias K = XWingKATTests

    /// The classic X25519 small-order / degenerate inputs.
    static let lowOrderPoints: [(String, String)] = [
        ("zero",        "0000000000000000000000000000000000000000000000000000000000000000"),
        ("one",         "0100000000000000000000000000000000000000000000000000000000000000"),
        ("order-8 a",   "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800"),
        ("order-8 b",   "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157"),
        ("p-1",         "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
        ("p",           "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
        ("p+1",         "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
    ]

    /// Decapsulation: a hostile SENDER supplies a ciphertext whose X25519 half is a
    /// low-order point. The receiver must refuse, not derive a predictable secret.
    func testDecapsulationRejectsLowOrderCiphertext() throws {
        let v = try XWingKATTests().vectors()[0]
        let priv = try XWingMLKEM768X25519.PrivateKey(
            seedRepresentation: K.hex(v.seed), publicKey: nil)
        let validCT = K.hex(v.ct)

        // Control: the untampered ciphertext still opens.
        XCTAssertNoThrow(try priv.decapsulate(Data(validCT)))

        for (name, point) in Self.lowOrderPoints {
            var hostile = validCT
            hostile.replaceSubrange(1088..<1120, with: K.hex(point))
            XCTAssertThrowsError(try priv.decapsulate(Data(hostile)),
                                 "low-order X25519 ciphertext (\(name)) was NOT rejected") { _ in }
        }
    }

    /// Encapsulation: a hostile RECIPIENT publishes a public key whose X25519 half
    /// is a low-order point. The sender must refuse rather than seal to a secret
    /// the attacker can predict.
    func testEncapsulationRejectsLowOrderPublicKey() throws {
        let v = try XWingKATTests().vectors()[0]
        let validPK = K.hex(v.pk)
        let eseed = K.hex(v.eseed)

        XCTAssertNoThrow(try DeterministicXWing.encapsulate(publicKey: validPK, eseed: eseed))

        for (name, point) in Self.lowOrderPoints {
            var hostile = validPK
            hostile.replaceSubrange(1184..<1216, with: K.hex(point))
            XCTAssertThrowsError(try DeterministicXWing.encapsulate(publicKey: hostile, eseed: eseed),
                                 "low-order X25519 public key (\(name)) was NOT rejected") { error in
                guard case DeterministicXWing.Failure.encapsulationRejected = error else {
                    return XCTFail("\(name): expected encapsulationRejected, got \(error)")
                }
            }
        }
    }

    /// A malformed ML-KEM half must be refused by the parser, not coerced.
    func testMalformedMLKEMPublicKeyIsRejected() throws {
        let v = try XWingKATTests().vectors()[0]
        var hostile = K.hex(v.pk)
        // ML-KEM-768 public keys are rejected unless every coefficient is canonical;
        // saturating the polynomial region is reliably non-canonical.
        for i in 0..<1152 { hostile[i] = 0xff }
        XCTAssertThrowsError(try DeterministicXWing.encapsulate(
            publicKey: hostile, eseed: K.hex(v.eseed)))
    }

    /// Truncated / oversized ciphertexts are refused on length, before any crypto.
    func testDecapsulationRejectsWrongCiphertextLength() throws {
        let v = try XWingKATTests().vectors()[0]
        let priv = try XWingMLKEM768X25519.PrivateKey(
            seedRepresentation: K.hex(v.seed), publicKey: nil)
        let ct = K.hex(v.ct)
        XCTAssertThrowsError(try priv.decapsulate(Data(ct.dropLast())))
        XCTAssertThrowsError(try priv.decapsulate(Data(ct + [0])))
        XCTAssertThrowsError(try priv.decapsulate(Data()))
    }
}
