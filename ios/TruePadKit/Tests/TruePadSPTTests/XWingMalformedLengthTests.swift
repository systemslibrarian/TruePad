import Crypto
import Foundation
import TruePadKATSupport
import TruePadSPT
import XCTest

/// Malformed X-Wing lengths must be refused BY TRUEPAD, BEFORE the bytes cross
/// into the vendored C implementation.
///
/// Why the boundary matters, and not just the outcome. swift-crypto and BoringSSL
/// perform their own length checks, and today they refuse these inputs correctly.
/// But "the library will catch it" is a dependency on someone else's validation
/// staying correct across every future bump — and the X-Wing code in question is
/// young. TruePad's own wrapper therefore validates first, and these tests assert
/// the SOURCE of the refusal, not merely that a refusal happened: a TruePad error
/// type means the bytes never reached the C layer at all.
///
/// The requirement being satisfied: no crash, no out-of-bounds access, no state
/// consumption, no output, and a typed refusal, for lengths 0, 1, 1119, 1120,
/// 1121 and a large bounded hostile input.
final class XWingMalformedLengthTests: XCTestCase {
    typealias H = SptInteropTests

    static let validCiphertextBytes = 1120
    static let validPublicKeyBytes = 1216
    static let validSeedBytes = 32
    static let validEseedBytes = 64

    /// The lengths the closure requirement names, plus the neighbours of every
    /// boundary. 1 MiB stands in for "large bounded hostile input": big enough to
    /// be a real allocation, bounded so the test cannot become the denial of
    /// service it is checking for.
    static let hostileLengths = [0, 1, 15, 16, 31, 32, 1087, 1088, 1119, 1121, 1152, 1215,
                                 1217, 2240, 65_536, 1_048_576]

    func validKeyMaterial() throws -> (seed: [UInt8], publicKey: [UInt8], ciphertext: [UInt8]) {
        let k = try SptInteropTests().corpus().cases[0]
        let seed = H.hex(k.decapSeedHex)
        let pk = try XWing.publicKey(fromSeed: seed)
        let enc = try DeterministicXWing.encapsulate(publicKey: pk, eseed: H.hex(k.eseedHex))
        return (seed, pk, enc.ciphertext)
    }

    // MARK: - decapsulation

    /// Every wrong ciphertext length is refused by TruePad's own check.
    func testDecapsulationRefusesEveryWrongCiphertextLength() throws {
        let material = try validKeyMaterial()

        // Control: the correct length opens.
        XCTAssertNoThrow(try XWing.decapsulate(ciphertext: material.ciphertext,
                                               decapsulationSeed: material.seed))

        for length in Self.hostileLengths where length != Self.validCiphertextBytes {
            let hostile = [UInt8](repeating: 0xab, count: length)
            do {
                _ = try XWing.decapsulate(ciphertext: hostile, decapsulationSeed: material.seed)
                XCTFail("ciphertext of \(length) bytes was accepted")
            } catch let error as SptError {
                guard case .wrongLength(let what, let expected, let got) = error else {
                    return XCTFail("\(length): unexpected SptError \(error)")
                }
                XCTAssertEqual(what, "ciphertext")
                XCTAssertEqual(expected, Self.validCiphertextBytes)
                XCTAssertEqual(got, length)
            } catch {
                XCTFail("ciphertext of \(length) bytes was refused by the LIBRARY (\(error)), "
                        + "not by TruePad — the bytes reached the C layer")
            }
        }
    }

    /// Same for the decapsulation seed: a wrong-length private key never reaches
    /// the parser.
    func testDecapsulationRefusesEveryWrongSeedLength() throws {
        let material = try validKeyMaterial()
        for length in [0, 1, 31, 33, 64, 1216, 65_536] {
            let hostile = [UInt8](repeating: 0x5a, count: length)
            do {
                _ = try XWing.decapsulate(ciphertext: material.ciphertext, decapsulationSeed: hostile)
                XCTFail("seed of \(length) bytes was accepted")
            } catch let error as SptError {
                guard case .wrongLength(let what, _, _) = error, what == "decapsulationSeed" else {
                    return XCTFail("\(length): unexpected SptError \(error)")
                }
            } catch {
                XCTFail("seed of \(length) bytes was refused by the LIBRARY (\(error)), not by TruePad")
            }
        }
    }

    // MARK: - encapsulation

    func testProductionEncapsulationRefusesEveryWrongPublicKeyLength() throws {
        let material = try validKeyMaterial()
        let encapsulator = SystemXWingEncapsulator()
        XCTAssertNoThrow(try encapsulator.encapsulate(encapsulationKey: material.publicKey))

        for length in Self.hostileLengths where length != Self.validPublicKeyBytes {
            let hostile = [UInt8](repeating: 0xcd, count: length)
            do {
                _ = try encapsulator.encapsulate(encapsulationKey: hostile)
                XCTFail("public key of \(length) bytes was accepted")
            } catch let error as SptError {
                guard case .wrongLength(let what, let expected, let got) = error else {
                    return XCTFail("\(length): unexpected SptError \(error)")
                }
                XCTAssertEqual(what, "encapsulationKey")
                XCTAssertEqual(expected, Self.validPublicKeyBytes)
                XCTAssertEqual(got, length)
            } catch {
                XCTFail("public key of \(length) bytes was refused by the LIBRARY (\(error)), "
                        + "not by TruePad")
            }
        }
    }

    /// The deterministic (test-support) hook validates both of its inputs before
    /// calling the C entry point too. It is test-only, but it is the one place
    /// that calls BoringSSL directly, so it is the one place where a missing
    /// length check would hand a raw pointer to the wrong-sized buffer.
    func testDeterministicHookRefusesBeforeReachingC() throws {
        let material = try validKeyMaterial()
        let goodEseed = [UInt8](repeating: 0x11, count: Self.validEseedBytes)

        for length in Self.hostileLengths where length != Self.validPublicKeyBytes {
            do {
                _ = try DeterministicXWing.encapsulate(
                    publicKey: [UInt8](repeating: 0, count: length), eseed: goodEseed)
                XCTFail("public key of \(length) bytes was accepted")
            } catch let error as DeterministicXWing.Failure {
                guard case .badPublicKeyLength(let got) = error else {
                    return XCTFail("\(length): expected badPublicKeyLength, got \(error)")
                }
                XCTAssertEqual(got, length)
            }
        }

        for length in [0, 1, 32, 63, 65, 128, 65_536] {
            do {
                _ = try DeterministicXWing.encapsulate(
                    publicKey: material.publicKey,
                    eseed: [UInt8](repeating: 0, count: length))
                XCTFail("eseed of \(length) bytes was accepted")
            } catch let error as DeterministicXWing.Failure {
                guard case .badEntropyLength(let got) = error else {
                    return XCTFail("\(length): expected badEntropyLength, got \(error)")
                }
                XCTAssertEqual(got, length)
            }
        }
    }

    // MARK: - the SPT layer above it

    /// A malformed package is refused STRUCTURALLY, before any decapsulation is
    /// attempted — so a hostile sender cannot even reach the KEM with a bad
    /// length, let alone the C code under it.
    func testMalformedPackageIsRefusedBeforeAnyDecapsulation() throws {
        let k = try SptInteropTests().corpus().cases[0]
        let body = H.hex(k.requestBodyHex)
        let seed = H.hex(k.decapSeedHex)
        let valid = H.hex(k.packageHex)

        // Control.
        guard case .ok = SptCryptoV1.open(packageBytes: valid, canonicalRequestBody: body,
                                          decapsulationSeed: seed) else {
            return XCTFail("the committed package should open")
        }

        // Truncations and extensions across the whole structural range, including
        // a large bounded hostile input. None may crash, none may open.
        var lengths = [0, 1, 4, 5, 7, 23, 55, 1174, 1194, 1195, 1210, 1211, 1257, 1259]
        lengths.append(contentsOf: [65_536, 1_048_576])
        for length in lengths {
            var hostile = [UInt8](repeating: 0x00, count: length)
            // Give it the right magic where it fits, so the parse gets past the
            // cheapest check and exercises the length arithmetic.
            for i in 0..<min(4, length) { hostile[i] = SptConstants.tps2MagicBytes[i] }
            if length > 4 { hostile[4] = SptConstants.transferVersion }
            if length > 6 { hostile[5] = 0x00; hostile[6] = 0x01 }

            switch SptCryptoV1.open(packageBytes: hostile, canonicalRequestBody: body,
                                    decapsulationSeed: seed) {
            case .ok:
                XCTFail("a \(length)-byte hostile package was OPENED")
            case .failed(let reason, _):
                XCTAssertNotEqual(reason, .derivedNonceMismatch,
                                  "\(length): a structural refusal must not present as a crypto one")
            }
        }
    }

    /// A hostile TPR2 body of any wrong length is refused by the one parser, with
    /// no allocation proportional to what it claims.
    func testMalformedRequestBodyLengthsAreRefused() throws {
        for length in [0, 1, 1234, 1236, 65_536, 1_048_576] {
            switch ReceiveRequestCodec.parseBody([UInt8](repeating: 0x01, count: length)) {
            case .ok:
                XCTFail("a \(length)-byte request body was accepted")
            case .failed(let reason, _):
                XCTAssertEqual(reason, .wrongBodyLength, "\(length)")
            }
        }
    }

    /// Nothing above allocated or consumed anything: the crypto layer is pure, so
    /// "no state consumption" is structural here. This test states that
    /// explicitly rather than leaving it implied, and will fail loudly if a future
    /// change gives the crypto layer durable state without revisiting these paths.
    func testTheCryptoLayerHoldsNoState() throws {
        let k = try SptInteropTests().corpus().cases[0]
        let body = H.hex(k.requestBodyHex)
        let seed = H.hex(k.decapSeedHex)
        let valid = H.hex(k.packageHex)

        // Hammer the malformed paths, then confirm the valid package still opens
        // identically — no counter moved, no budget was spent, nothing latched.
        for _ in 0..<50 {
            _ = SptCryptoV1.open(packageBytes: [0, 1, 2, 3], canonicalRequestBody: body,
                                 decapsulationSeed: seed)
            _ = try? XWing.decapsulate(ciphertext: [UInt8](repeating: 9, count: 1119),
                                       decapsulationSeed: seed)
        }
        guard case .ok(let opened) = SptCryptoV1.open(packageBytes: valid,
                                                      canonicalRequestBody: body,
                                                      decapsulationSeed: seed) else {
            return XCTFail("the valid package must still open after 50 malformed attempts")
        }
        XCTAssertEqual(SptInteropTests.hexString(opened.payload), k.payloadHex)
    }
}
