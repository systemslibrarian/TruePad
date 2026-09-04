import Foundation
import TruePadKATSupport
import TruePadSPT
import XCTest

/// The remaining legs of the interop matrix.
///
/// `SptInteropTests` covers the TypeScript corpus (Browser -> iOS, and iOS-seal ==
/// Browser-seal). This file covers packages produced by the OTHER editions'
/// generators, in the shared cross-edition corpus schema:
///
///   android/vectors/spt-android-generated.json   Android -> iOS
///   ios/vectors/spt-swift-generated.json         iOS -> iOS, on the committed file
///
/// The `reproducible: false` cases are the point of these files. Every
/// derandomized corpus — including the TypeScript one — drives sealing with fixed
/// entropy and therefore never exercises the production encapsulation path at
/// all. A fault confined to that path would be invisible to all of them. These
/// cases were sealed with each edition's real CSPRNG, so they cannot be
/// reproduced by anyone; they are opened, not compared.
final class SptCrossEditionCorpusTests: XCTestCase {
    struct Corpus: Decodable {
        let note: String
        let source: String
        let cases: [Case]
    }

    struct Case: Decodable {
        let label: String
        /// Absent in the original TypeScript corpus, which predates the field and
        /// whose cases are all deterministic. Read through `isReproducible` so
        /// that frozen file does not have to be rewritten to be comparable.
        let reproducible: Bool?
        let eseedHex: String?
        let requestBodyHex: String
        let decapSeedHex: String
        let payloadHex: String
        let packageHex: String
        let confirmValueHex: String
        let confirmationIndices: [Int]

        var isReproducible: Bool { reproducible ?? true }
    }

    struct FixedEntropyEncapsulator: XWingEncapsulating {
        let eseed: [UInt8]
        func encapsulate(encapsulationKey: [UInt8]) throws -> XWingEncapsulation {
            let r = try DeterministicXWing.encapsulate(publicKey: encapsulationKey, eseed: eseed)
            return XWingEncapsulation(ciphertext: r.ciphertext, sharedSecret: r.sharedSecret)
        }
    }

    func load(_ relativePath: String) throws -> Corpus {
        let url = XWingKATTests.repoRoot.appendingPathComponent(relativePath)
        return try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: url))
    }

    /// Open every package in a corpus, and reseal the deterministic ones to
    /// identical bytes.
    func check(_ corpus: Corpus, origin: String) throws {
        XCTAssertGreaterThanOrEqual(corpus.cases.count, 6, "\(origin): corpus is too small")
        var deterministic = 0
        var production = 0

        for k in corpus.cases {
            let body = SptInteropTests.hex(k.requestBodyHex)
            let package = SptInteropTests.hex(k.packageHex)
            let seed = SptInteropTests.hex(k.decapSeedHex)

            // The recipient key must be portable: the 32-byte seed re-derives the
            // public half the request carries, in every edition.
            guard case .ok(let request, _) = ReceiveRequestCodec.parseBody(body) else {
                XCTFail("\(origin) [\(k.label)]: request body did not parse")
                continue
            }
            XCTAssertEqual(try XWing.publicKey(fromSeed: seed), request.encapsulationKey,
                           "\(origin) [\(k.label)]: seed does not re-derive the encapsulation key")

            switch SptCryptoV1.open(packageBytes: package,
                                    canonicalRequestBody: body,
                                    decapsulationSeed: seed) {
            case .failed(let reason, let message):
                XCTFail("\(origin) [\(k.label)]: iOS refused the package: \(reason) — \(message)")
            case .ok(let opened):
                XCTAssertEqual(SptInteropTests.hexString(opened.payload), k.payloadHex,
                               "\(origin) [\(k.label)]: payload")
                XCTAssertEqual(SptInteropTests.hexString(opened.confirmValue), k.confirmValueHex,
                               "\(origin) [\(k.label)]: confirmation value")
                XCTAssertEqual(opened.confirmationIndices, k.confirmationIndices,
                               "\(origin) [\(k.label)]: confirmation word indices")
            }

            if k.isReproducible {
                deterministic += 1
                guard let eseedHex = k.eseedHex else {
                    XCTFail("\(origin) [\(k.label)]: a reproducible case must carry its eseed")
                    continue
                }
                let resealed = try SptCryptoV1.seal(
                    canonicalRequestBody: body,
                    payload: SptInteropTests.hex(k.payloadHex),
                    encapsulator: FixedEntropyEncapsulator(eseed: SptInteropTests.hex(eseedHex))
                )
                XCTAssertEqual(SptInteropTests.hexString(resealed.packageBytes), k.packageHex,
                               "\(origin) [\(k.label)]: iOS reseal is not byte-identical")
                XCTAssertEqual(SptInteropTests.hexString(resealed.confirmValue), k.confirmValueHex,
                               "\(origin) [\(k.label)]: iOS reseal confirmation value differs")
            } else {
                production += 1
                XCTAssertNil(k.eseedHex,
                             "\(origin) [\(k.label)]: a production-entropy case must not carry an eseed")
            }
        }

        XCTAssertGreaterThanOrEqual(deterministic, 3, "\(origin): expected deterministic cases")
        XCTAssertGreaterThanOrEqual(production, 3,
                                    "\(origin): expected production-entropy cases — without them no corpus exercises the CSPRNG seal path")
    }

    /// ANDROID -> IOS, directly: packages sealed by Bouncy Castle on the JVM,
    /// including three sealed with Android's own SecureRandom.
    func testOpensAndroidGeneratedPackages() throws {
        let corpus = try load("android/vectors/spt-android-generated.json")
        XCTAssertTrue(corpus.source.contains("android/truepad-spt"),
                      "this corpus should be the Android seal output")
        try check(corpus, origin: "android")
    }

    /// The committed iOS corpus must still be what this build produces and opens.
    /// If a change to this edition ever silently altered the wire, the committed
    /// evidence — which the TypeScript and Kotlin suites also consume — would stop
    /// matching here first.
    func testCommittedIosCorpusStillReproduces() throws {
        let corpus = try load("ios/vectors/spt-swift-generated.json")
        XCTAssertTrue(corpus.source.contains("ios/TruePadKit"),
                      "this corpus should be the iOS seal output")
        try check(corpus, origin: "ios")
    }

    /// The three editions must agree byte-for-byte on the deterministic cases they
    /// share. Comparing the corpora directly states that as one assertion, rather
    /// than leaving it implied by three separate suites.
    func testAllThreeEditionsAgreeOnTheSharedDeterministicCases() throws {
        let ts = try load("android/vectors/spt-interop.json")
        let android = try load("android/vectors/spt-android-generated.json")
        let ios = try load("ios/vectors/spt-swift-generated.json")

        let tsByLabel = Dictionary(uniqueKeysWithValues: ts.cases.map { ($0.label, $0) })
        var compared = 0

        for corpus in [(name: "android", value: android), (name: "ios", value: ios)] {
            for k in corpus.value.cases where k.isReproducible {
                guard let reference = tsByLabel[k.label] else { continue }
                XCTAssertEqual(k.requestBodyHex, reference.requestBodyHex,
                               "\(corpus.name) [\(k.label)]: request body differs from TypeScript")
                XCTAssertEqual(k.packageHex, reference.packageHex,
                               "\(corpus.name) [\(k.label)]: sealed package differs from TypeScript")
                XCTAssertEqual(k.confirmValueHex, reference.confirmValueHex,
                               "\(corpus.name) [\(k.label)]: confirmation value differs from TypeScript")
                XCTAssertEqual(k.confirmationIndices, reference.confirmationIndices,
                               "\(corpus.name) [\(k.label)]: confirmation indices differ from TypeScript")
                compared += 1
            }
        }
        XCTAssertGreaterThanOrEqual(compared, 6,
                                    "expected to compare 3 shared cases from each of Android and iOS")
    }
}
