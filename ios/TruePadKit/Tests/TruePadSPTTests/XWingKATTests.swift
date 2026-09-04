import Crypto
import Foundation
import TruePadKATSupport
import XCTest

/// The X-Wing gate. TruePad's iOS edition must speak the SAME frozen X-Wing as
/// the Browser (TypeScript/@noble) and Android (Bouncy Castle) editions, byte for
/// byte. The authority is `android/vectors/xwing-draft10-appendix-c.json`, the
/// committed draft-10 Appendix-C corpus both existing editions are held to.
final class XWingKATTests: XCTestCase {
    struct Vector: Decodable {
        let seed: String, sk: String, pk: String, eseed: String, ct: String, ss: String
    }

    // MARK: - helpers

    static func hex(_ s: String) -> [UInt8] {
        var out = [UInt8](); out.reserveCapacity(s.count / 2)
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            out.append(UInt8(s[i..<j], radix: 16)!)
            i = j
        }
        return out
    }

    static func hexString<C: Collection>(_ b: C) -> String where C.Element == UInt8 {
        b.map { String(format: "%02x", $0) }.joined()
    }

    static var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // TruePadSPTTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // TruePadKit
            .deletingLastPathComponent()   // ios
            .deletingLastPathComponent()   // repo root
    }

    func vectors() throws -> [Vector] {
        let url = Self.repoRoot.appendingPathComponent("android/vectors/xwing-draft10-appendix-c.json")
        return try JSONDecoder().decode([Vector].self, from: Data(contentsOf: url))
    }

    // MARK: - the gate

    /// All three Appendix-C vectors, all three directions, byte for byte.
    func testAppendixCKnownAnswers() throws {
        let vs = try vectors()
        XCTAssertEqual(vs.count, 3, "expected the 3 committed Appendix-C vectors")

        for (i, v) in vs.enumerated() {
            let seed = Self.hex(v.seed)
            let eseed = Self.hex(v.eseed)
            let expectedPK = Self.hex(v.pk)

            XCTAssertEqual(v.seed, v.sk, "vector \(i): X-Wing private key IS the 32-byte seed")

            // 1. seed -> private key -> public key
            let priv = try XWingMLKEM768X25519.PrivateKey(seedRepresentation: seed, publicKey: nil)
            XCTAssertEqual(Self.hexString(priv.publicKey.rawRepresentation), v.pk,
                           "vector \(i): public key mismatch")
            XCTAssertEqual([UInt8](priv.seedRepresentation), seed,
                           "vector \(i): seed round-trip mismatch")

            // 2. deterministic encapsulation: (pk, eseed) -> (ct, ss)
            //    Driven from the FIXTURE's public key, not from the key we just
            //    derived, so a keygen bug cannot mask an encapsulation bug.
            let enc = try DeterministicXWing.encapsulate(publicKey: expectedPK, eseed: eseed)
            XCTAssertEqual(Self.hexString(enc.ciphertext), v.ct,
                           "vector \(i): ciphertext mismatch")
            XCTAssertEqual(Self.hexString(enc.sharedSecret), v.ss,
                           "vector \(i): encapsulation shared secret mismatch")

            // 3. decapsulation: (ct, sk) -> ss, through the ORDINARY production API
            let dec = try priv.decapsulate(Data(Self.hex(v.ct)))
            XCTAssertEqual(Self.hexString(dec.withUnsafeBytes { [UInt8]($0) }), v.ss,
                           "vector \(i): decapsulation shared secret mismatch")
        }
    }

    /// Non-tautological structural check on the ciphertext and key layouts, using
    /// an INDEPENDENT X25519 implementation (Crypto's Curve25519) rather than the
    /// X-Wing code under test. Proves:
    ///   pk = ML-KEM-768 pk (1184) ‖ X25519 pk (32)
    ///   ct = ML-KEM-768 ct (1088) ‖ X25519 ct (32)
    ///   eseed = ML-KEM coins (32) ‖ ephemeral X25519 private key (32)
    func testWireLayoutAgainstIndependentX25519() throws {
        for (i, v) in try vectors().enumerated() {
            let eseed = Self.hex(v.eseed)
            let ct = Self.hex(v.ct)
            let pk = Self.hex(v.pk)

            let ephemeral = try Curve25519.KeyAgreement.PrivateKey(
                rawRepresentation: Data(eseed.suffix(32)))
            XCTAssertEqual(Self.hexString(ephemeral.publicKey.rawRepresentation),
                           Self.hexString(ct.suffix(32)),
                           "vector \(i): X25519 ciphertext tail is not the ephemeral public key")

            // And the recipient's X25519 public key really is the tail of the X-Wing pk:
            // agreeing with it from the ephemeral secret must succeed (non-zero).
            let recipientX = try Curve25519.KeyAgreement.PublicKey(
                rawRepresentation: Data(pk.suffix(32)))
            let shared = try ephemeral.sharedSecretFromKeyAgreement(with: recipientX)
            XCTAssertFalse(shared.withUnsafeBytes { $0.allSatisfy { $0 == 0 } },
                           "vector \(i): X25519 agreement degenerated to all-zero")
        }
    }

    /// Sizes are contract, not incidental.
    func testFrozenSizes() throws {
        XCTAssertEqual(DeterministicXWing.publicKeyBytes, 1216)
        XCTAssertEqual(DeterministicXWing.privateKeySeedBytes, 32)
        XCTAssertEqual(DeterministicXWing.ciphertextBytes, 1120)
        XCTAssertEqual(DeterministicXWing.sharedSecretBytes, 32)
        XCTAssertEqual(DeterministicXWing.entropyBytes, 64)

        let k = try XWingMLKEM768X25519.PrivateKey.generate()
        XCTAssertEqual(k.seedRepresentation.count, 32)
        XCTAssertEqual(k.publicKey.rawRepresentation.count, 1216)
        let e = try k.publicKey.encapsulate()
        XCTAssertEqual(e.encapsulated.count, 1120)
        XCTAssertEqual(e.sharedSecret.withUnsafeBytes { $0.count }, 32)
    }

    /// The KAT must be able to fail. Corrupting one bit of the ML-KEM coins half of
    /// the entropy must change the ML-KEM ciphertext and the shared secret, while
    /// leaving the X25519 tail (driven by the other half) untouched. Corrupting the
    /// X25519 half must do the converse. That asymmetry pins the entropy layout as
    /// ML-KEM coins (first 32) ‖ ephemeral X25519 private key (last 32).
    func testMutatedEntropyBreaksTheVectors() throws {
        for (i, v) in try vectors().enumerated() {
            let pk = Self.hex(v.pk)
            let eseed = Self.hex(v.eseed)
            let ctTail = Self.hexString(Self.hex(v.ct).suffix(32))
            let ctHead = Self.hexString(Self.hex(v.ct).prefix(1088))

            // (a) flip a bit of the ML-KEM coins
            var mlkemHalf = eseed; mlkemHalf[0] ^= 0x01
            let a = try DeterministicXWing.encapsulate(publicKey: pk, eseed: mlkemHalf)
            XCTAssertNotEqual(Self.hexString(a.ciphertext), v.ct,
                              "vector \(i): mutating ML-KEM coins did not change the ciphertext")
            XCTAssertNotEqual(Self.hexString(a.sharedSecret), v.ss,
                              "vector \(i): mutating ML-KEM coins did not change the shared secret")
            XCTAssertEqual(Self.hexString(a.ciphertext.suffix(32)), ctTail,
                           "vector \(i): ML-KEM coins must not affect the X25519 tail")

            // (b) flip a bit of the ephemeral X25519 scalar that survives clamping.
            //     Bit 3 of byte 0 is not cleared by clamping, so this must propagate.
            var xHalf = eseed; xHalf[32] ^= 0x08
            let b = try DeterministicXWing.encapsulate(publicKey: pk, eseed: xHalf)
            XCTAssertNotEqual(Self.hexString(b.ciphertext.suffix(32)), ctTail,
                              "vector \(i): mutating the X25519 half did not change its ciphertext")
            XCTAssertEqual(Self.hexString(b.ciphertext.prefix(1088)), ctHead,
                           "vector \(i): X25519 entropy must not affect the ML-KEM ciphertext")
            XCTAssertNotEqual(Self.hexString(b.sharedSecret), v.ss,
                              "vector \(i): mutating the X25519 half did not change the shared secret")
        }
    }

    /// X25519 scalar clamping is part of the frozen construction: bits 0-2 of the
    /// first byte, and bit 7 of the last, are not free. Flipping a bit that clamping
    /// discards MUST leave the ciphertext and shared secret byte-identical. This is
    /// asserted rather than assumed, because it is exactly the case that would
    /// otherwise look like a broken mutation test.
    func testClampedEntropyBitsAreDiscarded() throws {
        for (i, v) in try vectors().enumerated() {
            let pk = Self.hex(v.pk)
            let eseed = Self.hex(v.eseed)

            for (label, index, mask) in [("low bit 0", 32, UInt8(0x01)),
                                         ("low bit 1", 32, UInt8(0x02)),
                                         ("low bit 2", 32, UInt8(0x04)),
                                         ("high bit 7", 63, UInt8(0x80))] {
                var mutated = eseed; mutated[index] ^= mask
                let r = try DeterministicXWing.encapsulate(publicKey: pk, eseed: mutated)
                XCTAssertEqual(Self.hexString(r.ciphertext), v.ct,
                               "vector \(i): clamped \(label) changed the ciphertext")
                XCTAssertEqual(Self.hexString(r.sharedSecret), v.ss,
                               "vector \(i): clamped \(label) changed the shared secret")
            }
        }
    }

    /// Length discipline: the deterministic hook refuses anything but exact sizes.
    func testDeterministicHookRejectsWrongLengths() throws {
        let v = try vectors()[0]
        let pk = Self.hex(v.pk), eseed = Self.hex(v.eseed)
        XCTAssertThrowsError(try DeterministicXWing.encapsulate(publicKey: Array(pk.dropLast()), eseed: eseed))
        XCTAssertThrowsError(try DeterministicXWing.encapsulate(publicKey: pk, eseed: Array(eseed.dropLast())))
        XCTAssertThrowsError(try DeterministicXWing.encapsulate(publicKey: pk, eseed: eseed + [0]))
    }

    /// Availability proof: this file compiles and runs with NO `if #available`
    /// guard on a macOS 14 / iOS 16 deployment target. If the build ever silently
    /// reverted to the CryptoKit re-export, X-Wing would demand macOS 26 / iOS 26
    /// and this target would not compile at all.
    func testRunsBelowTheCryptoKitAvailabilityFloor() throws {
        let k = try XWingMLKEM768X25519.PrivateKey.generate()
        XCTAssertEqual(k.publicKey.rawRepresentation.count, 1216)
    }
}
