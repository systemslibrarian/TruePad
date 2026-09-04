import Crypto
import Foundation
import TruePadKATSupport
import TruePadSPT
import XCTest

/// THE PRIMARY SPT GATE.
///
/// `android/vectors/spt-interop.json` is the RELEASED TypeScript implementation's
/// own seal output — its own note says so: *"A second implementation must
/// reproduce packageHex and open it to payloadHex."* The Android Edition is held
/// to it; iOS is now held to the same bytes, from the same file, without
/// regenerating anything.
///
/// This is deliberately NOT a Swift-to-Swift round trip. A round trip proves only
/// that a build agrees with itself; it would pass just as happily if every
/// derivation in this edition were subtly wrong in a self-consistent way. What is
/// asserted here is equality with bytes that were produced by a different
/// language, a different KEM library, and a different HKDF composition, and then
/// committed.
final class SptInteropTests: XCTestCase {
    struct Corpus: Decodable {
        let note: String
        let source: String
        let cases: [Case]
    }

    struct Case: Decodable {
        let label: String
        let eseedHex: String
        let requestBodyHex: String
        let decapSeedHex: String
        let payloadHex: String
        let packageHex: String
        let confirmValueHex: String
        let confirmationIndices: [Int]
    }

    /// Deterministic encapsulation, supplied from the TEST target only.
    ///
    /// This is the whole reason `seal` takes an `XWingEncapsulating` rather than
    /// an `eseed`: the entropy lives here, in a type the shipping app cannot
    /// construct because it cannot import the module that makes it possible.
    struct FixedEntropyEncapsulator: XWingEncapsulating {
        let eseed: [UInt8]
        func encapsulate(encapsulationKey: [UInt8]) throws -> XWingEncapsulation {
            let r = try DeterministicXWing.encapsulate(publicKey: encapsulationKey, eseed: eseed)
            return XWingEncapsulation(ciphertext: r.ciphertext, sharedSecret: r.sharedSecret)
        }
    }

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

    func corpus() throws -> Corpus {
        let url = XWingKATTests.repoRoot.appendingPathComponent("android/vectors/spt-interop.json")
        return try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: url))
    }

    // MARK: - A/B/C/D from the plan

    /// D. Deterministic RESEAL must be byte-for-byte identical to the committed
    /// TypeScript package. This is the strongest statement available short of
    /// running both implementations side by side: identical ciphertext means
    /// identical shared secret, PRK, nonce, AAD, AEAD key and tag.
    func testResealReproducesTheCommittedPackageByteForByte() throws {
        let c = try corpus()
        XCTAssertEqual(c.cases.count, 3, "expected the 3 committed interop cases")
        XCTAssertTrue(c.source.contains("sealPayloadV1"),
                      "the corpus should still be the TypeScript seal output")

        for k in c.cases {
            let body = Self.hex(k.requestBodyHex)
            let payload = Self.hex(k.payloadHex)
            let result = try SptCryptoV1.seal(
                canonicalRequestBody: body,
                payload: payload,
                encapsulator: FixedEntropyEncapsulator(eseed: Self.hex(k.eseedHex))
            )

            XCTAssertEqual(Self.hexString(result.packageBytes), k.packageHex,
                           "[\(k.label)] resealed TPS2 differs from the committed TypeScript package")
            XCTAssertEqual(Self.hexString(result.confirmValue), k.confirmValueHex,
                           "[\(k.label)] confirmation value differs")
            XCTAssertEqual(result.confirmationIndices, k.confirmationIndices,
                           "[\(k.label)] confirmation word indices differ")
        }
    }

    /// A + B + C. Swift parses the TypeScript-generated TPR2 body, opens the
    /// TypeScript-generated TPS2 package, and derives the same request hash,
    /// package identity, confirmation value and plaintext.
    func testOpensTheCommittedTypeScriptPackage() throws {
        for k in try corpus().cases {
            let body = Self.hex(k.requestBodyHex)
            let package = Self.hex(k.packageHex)

            guard case .ok(let request, let canonicalBody) =
                    ReceiveRequestCodec.parseBody(body) else {
                return XCTFail("[\(k.label)] the committed request body did not parse")
            }
            XCTAssertEqual(request.version, 1)
            XCTAssertEqual(request.suite, 0x0001)
            XCTAssertEqual(canonicalBody, body)

            // The recipient's stored private key is the 32-byte seed; the public
            // half in the request must be exactly what that seed re-derives.
            XCTAssertEqual(Self.hexString(try XWing.publicKey(fromSeed: Self.hex(k.decapSeedHex))),
                           Self.hexString(request.encapsulationKey),
                           "[\(k.label)] decapSeed does not re-derive the request's encapsulation key")

            switch SptCryptoV1.open(packageBytes: package,
                                    canonicalRequestBody: body,
                                    decapsulationSeed: Self.hex(k.decapSeedHex)) {
            case .failed(let reason, let message):
                XCTFail("[\(k.label)] open refused the committed package: \(reason) — \(message)")
            case .ok(let opened):
                XCTAssertEqual(Self.hexString(opened.payload), k.payloadHex,
                               "[\(k.label)] recovered payload differs")
                XCTAssertEqual(Self.hexString(opened.confirmValue), k.confirmValueHex,
                               "[\(k.label)] confirmation value differs on open")
                XCTAssertEqual(opened.confirmationIndices, k.confirmationIndices,
                               "[\(k.label)] confirmation indices differ on open")
                XCTAssertEqual(Self.hexString(opened.packageIdentity),
                               Self.hexString(Array(SHA256.hash(data: package))),
                               "[\(k.label)] package identity is not SHA-256 over the whole package")
            }
        }
    }

    /// Seal and open must agree on every derived value for the same inputs —
    /// including that the sealer's confirmation words are the ones the opener will
    /// read aloud. If these ever diverged, two honest people would compare
    /// different words and conclude they were under attack.
    func testSealerAndOpenerAgreeOnTheCeremonyValues() throws {
        for k in try corpus().cases {
            let body = Self.hex(k.requestBodyHex)
            let sealed = try SptCryptoV1.seal(
                canonicalRequestBody: body,
                payload: Self.hex(k.payloadHex),
                encapsulator: FixedEntropyEncapsulator(eseed: Self.hex(k.eseedHex))
            )
            guard case .ok(let opened) = SptCryptoV1.open(
                packageBytes: sealed.packageBytes,
                canonicalRequestBody: body,
                decapsulationSeed: Self.hex(k.decapSeedHex)
            ) else {
                return XCTFail("[\(k.label)] could not open the package this build just sealed")
            }
            XCTAssertEqual(sealed.confirmValue, opened.confirmValue)
            XCTAssertEqual(sealed.confirmationIndices, opened.confirmationIndices)
            XCTAssertEqual(sealed.requestHash, opened.requestHash)
            XCTAssertEqual(sealed.packageIdentity, opened.packageIdentity)
        }
    }

    /// The corpus covers an empty payload and a 1 KiB payload; make that explicit,
    /// because a zero-length AEAD plaintext is exactly the case an implementation
    /// is most likely to special-case wrongly.
    func testCorpusCoversTheEmptyPayload() throws {
        let lengths = try corpus().cases.map { $0.payloadHex.count / 2 }
        XCTAssertTrue(lengths.contains(0), "the corpus should still exercise an empty payload")
        XCTAssertTrue(lengths.contains(1024), "the corpus should still exercise a 1 KiB payload")
    }

    // MARK: - production path

    /// The PRODUCTION seal path — system CSPRNG, no injected entropy — must
    /// produce packages this edition can open, and must produce a DIFFERENT
    /// package every time. Two seals of the same payload to the same request
    /// sharing a KEM ciphertext would mean the entropy was not fresh.
    func testProductionSealIsFreshAndOpenable() throws {
        let k = try corpus().cases[0]
        let body = Self.hex(k.requestBodyHex)
        let payload = Self.hex(k.payloadHex)
        let seed = Self.hex(k.decapSeedHex)

        let first = try SptCryptoV1.seal(canonicalRequestBody: body, payload: payload)
        let second = try SptCryptoV1.seal(canonicalRequestBody: body, payload: payload)

        XCTAssertNotEqual(first.packageBytes, second.packageBytes,
                          "two production seals produced identical packages — entropy is not fresh")
        XCTAssertNotEqual(first.confirmValue, second.confirmValue,
                          "two production seals produced identical confirmation values")

        for sealed in [first, second] {
            guard case .ok(let opened) = SptCryptoV1.open(packageBytes: sealed.packageBytes,
                                                          canonicalRequestBody: body,
                                                          decapsulationSeed: seed) else {
                return XCTFail("a production-sealed package could not be opened")
            }
            XCTAssertEqual(opened.payload, payload)
            XCTAssertEqual(opened.confirmValue, sealed.confirmValue)
        }
    }
}
