import Crypto
import Foundation
import TruePadKATSupport
import TruePadSPT
import XCTest

/// The TPR2 / TPS2 wire, the domain-separated hashing, and the refusals.
///
/// The interop corpora prove the HAPPY path is byte-identical across editions.
/// These are the other half: that malformed, hostile and near-miss inputs are
/// refused, refused for the RIGHT stated reason, and refused before anything
/// expensive or irreversible happens.
final class SptWireTests: XCTestCase {
    typealias H = SptInteropTests

    func sampleRequestBody() throws -> [UInt8] {
        let corpus = try SptInteropTests().corpus()
        return H.hex(corpus.cases[0].requestBodyHex)
    }

    // MARK: - domain separators

    /// §6.2: the length octet is MEASURED, never written down. These counts are
    /// informative comments in the constants of every edition; assert them here
    /// against the measured strings, because a wrong one does not fail loudly —
    /// it silently forks requestHash between two conforming builds.
    func testDomainSeparatorLengths() throws {
        let expected: [(String, Int)] = [
            (SptConstants.dsRequestFP, 34),
            (SptConstants.dsAeadKey, 23),
            (SptConstants.dsConfirm, 36),
            (SptConstants.dsNonce, 25),
            (SptConstants.dsPad, 29),
        ]
        for (ds, count) in expected {
            XCTAssertEqual(ds.utf8.count, count, "domain separator '\(ds)' changed length")
            let prefix = try SptFingerprint.domainPrefix(ds)
            XCTAssertEqual(Int(prefix[0]), count, "the length octet must be the measured length")
            XCTAssertEqual(prefix.count, count + 1)
        }
    }

    func testDomainSeparatorsAreTheFrozenStrings() {
        XCTAssertEqual(SptConstants.dsRequestFP, "TruePad/SPT/v1/request-fingerprint")
        XCTAssertEqual(SptConstants.dsAeadKey, "TruePad/SPT/v1/aead-key")
        XCTAssertEqual(SptConstants.dsConfirm, "TruePad/SPT/v1/transfer-confirmation")
        XCTAssertEqual(SptConstants.dsNonce, "TruePad/SPT/v1/aead-nonce")
        XCTAssertEqual(SptConstants.dsPad, "TruePad/SPT/v1/pad-commitment")
    }

    // MARK: - 11-bit index extraction

    /// The bit-walking implementation must agree with the arbitrary-precision
    /// definition the Browser Edition uses. The reference here builds a binary
    /// STRING and slices it — a genuinely different route to the same answer, so
    /// a shared off-by-one is unlikely to cancel out.
    func testElevenBitIndicesMatchAnIndependentReference() throws {
        func reference(_ bytes: [UInt8], count: Int) -> [Int] {
            let bits = bytes.map { byte -> String in
                let s = String(byte, radix: 2)
                return String(repeating: "0", count: 8 - s.count) + s
            }.joined()
            return (0..<count).map { i in
                let start = bits.index(bits.startIndex, offsetBy: 11 * i)
                let end = bits.index(start, offsetBy: 11)
                return Int(bits[start..<end], radix: 2)!
            }
        }

        for trial in 0..<64 {
            var hash = [UInt8](repeating: 0, count: 32)
            for i in 0..<32 { hash[i] = UInt8((trial &* 31 &+ i &* 17) & 0xff) }

            XCTAssertEqual(try SptFingerprint.requestIndices132(hash),
                           reference(hash, count: 12),
                           "requestIndices132 disagrees with the reference on trial \(trial)")
            XCTAssertEqual(try SptFingerprint.confirmationIndices88(Array(hash.prefix(11))),
                           reference(Array(hash.prefix(11)), count: 8),
                           "confirmationIndices88 disagrees with the reference on trial \(trial)")
        }
    }

    func testWordIndicesAreInRange() throws {
        for trial in 0..<32 {
            var hash = [UInt8](repeating: 0, count: 32)
            for i in 0..<32 { hash[i] = UInt8((trial &* 7 &+ i &* 43) & 0xff) }
            for index in try SptFingerprint.requestIndices132(hash) {
                XCTAssertTrue((0..<SptConstants.wordlistSize).contains(index))
            }
            for index in try SptFingerprint.confirmationIndices88(Array(hash.prefix(11))) {
                XCTAssertTrue((0..<SptConstants.wordlistSize).contains(index))
            }
        }
    }

    /// The 12-word request rendering and the 8-word confirmation rendering are
    /// different values at different strengths for different threat models (§8.2):
    /// 132 bits authenticating a receive request against an OFFLINE, known-target
    /// grind, versus 88 bits authenticating a sealed package in an ONLINE,
    /// unknown-target ceremony.
    ///
    /// Note what does NOT distinguish them. Both take consecutive 11-bit fields
    /// most-significant-first from bit 0, so given the SAME input bytes the first
    /// eight indices coincide by construction. What keeps them apart in practice
    /// is that they are never computed over the same input: one is over
    /// requestHash (SHA-256 of the request body), the other over confirmValue (an
    /// HKDF output under a different domain separator). This test asserts that
    /// real separation, rather than a property the arithmetic does not have.
    func testTheTwoWordRenderingsCoverDifferentValues() throws {
        let corpus = try SptInteropTests().corpus()
        let k = corpus.cases[0]
        let body = H.hex(k.requestBodyHex)

        guard case .ok(let opened) = SptCryptoV1.open(packageBytes: H.hex(k.packageHex),
                                                      canonicalRequestBody: body,
                                                      decapsulationSeed: H.hex(k.decapSeedHex)) else {
            return XCTFail("the committed package should open")
        }

        let requestWords = try SptFingerprint.requestIndices132(opened.requestHash)
        let confirmWords = try SptFingerprint.confirmationIndices88(opened.confirmValue)

        XCTAssertEqual(requestWords.count, SptConstants.requestWordsCount)
        XCTAssertEqual(confirmWords.count, SptConstants.confirmWordsCount)
        XCTAssertEqual(SptConstants.requestWordsCount * 11, SptConstants.requestWordsBits)
        XCTAssertEqual(SptConstants.confirmWordsCount * 11, SptConstants.confirmWordsBits)

        // The two ceremonies must not read the same words out for one transfer.
        XCTAssertNotEqual(Array(requestWords.prefix(8)), confirmWords,
                          "the request words and the confirmation words coincided for a real transfer")
        XCTAssertNotEqual(Array(opened.requestHash.prefix(11)), opened.confirmValue,
                          "requestHash and confirmValue must be independently derived values")
    }

    /// The confirmation words a sealer reads are the ones the opener reads. This
    /// is the property the ceremony actually rests on.
    func testConfirmationWordsMatchTheCommittedCorpus() throws {
        for k in try SptInteropTests().corpus().cases {
            guard case .ok(let opened) = SptCryptoV1.open(
                packageBytes: H.hex(k.packageHex),
                canonicalRequestBody: H.hex(k.requestBodyHex),
                decapsulationSeed: H.hex(k.decapSeedHex)
            ) else { return XCTFail("[\(k.label)] should open") }
            XCTAssertEqual(try SptFingerprint.confirmationIndices88(opened.confirmValue),
                           k.confirmationIndices,
                           "[\(k.label)] rendered confirmation words differ from the corpus")
        }
    }

    // MARK: - TPR2

    func testReceiveRequestRoundTrip() throws {
        let body = try sampleRequestBody()
        guard case .ok(let request, _) = ReceiveRequestCodec.parseBody(body) else {
            return XCTFail("sample body did not parse")
        }
        let text = try ReceiveRequestCodec.encode(requestId: request.requestId,
                                                  encapsulationKey: request.encapsulationKey)
        XCTAssertTrue(text.hasPrefix("TPR2:"))
        XCTAssertEqual(text.count, SptConstants.tpr2TextChars)

        guard case .ok(let decoded, let canonical) = ReceiveRequestCodec.decode(text) else {
            return XCTFail("round-trip decode failed")
        }
        XCTAssertEqual(decoded, request)
        XCTAssertEqual(canonical, body)
    }

    func testSurroundingWhitespaceIsTrimmedButInteriorIsNot() throws {
        let body = try sampleRequestBody()
        guard case .ok(let r, _) = ReceiveRequestCodec.parseBody(body) else { return XCTFail() }
        let text = try ReceiveRequestCodec.encode(requestId: r.requestId,
                                                  encapsulationKey: r.encapsulationKey)

        guard case .ok = ReceiveRequestCodec.decode("  \n\(text)\t ") else {
            return XCTFail("surrounding whitespace should be trimmed")
        }
        // A wrapped paste puts a newline INSIDE. That is not the same request.
        let wrapped = text.prefix(800) + "\n" + text.dropFirst(800)
        guard case .failed(let reason, _) = ReceiveRequestCodec.decode(String(wrapped)) else {
            return XCTFail("interior whitespace must be refused")
        }
        XCTAssertEqual(reason, .notBase64Url)
    }

    func testReceiveRequestRefusals() throws {
        let body = try sampleRequestBody()
        guard case .ok(let r, _) = ReceiveRequestCodec.parseBody(body) else { return XCTFail() }
        let text = try ReceiveRequestCodec.encode(requestId: r.requestId,
                                                  encapsulationKey: r.encapsulationKey)
        let encoded = String(text.dropFirst(5))

        func reason(_ s: String) -> RequestDecodeError? {
            if case .failed(let reason, _) = ReceiveRequestCodec.decode(s) { return reason }
            return nil
        }

        XCTAssertEqual(reason("TPR3:" + encoded), .wrongPrefix)
        XCTAssertEqual(reason("TPR2:" + encoded + "="), .notBase64Url, "padding is not the alphabet")
        XCTAssertEqual(reason("TPR2:" + encoded.replacingOccurrences(of: "-", with: "+")),
                       .notBase64Url, "the standard alphabet is not base64url")
        XCTAssertEqual(reason("TPR2:" + String(encoded.dropLast())), .wrongBodyLength)
        // A hostile paste is bounded before it is walked per-character.
        XCTAssertEqual(reason("TPR2:" + String(repeating: "A", count: 100_000)), .wrongBodyLength)
    }

    /// Canonicality is what stops one request having several spellings. base64url
    /// leaves spare bits in a final group; changing them decodes to the same 1235
    /// bytes under a different text, and that must be refused.
    func testNonCanonicalBase64IsRefused() throws {
        let body = try sampleRequestBody()
        guard case .ok(let r, _) = ReceiveRequestCodec.parseBody(body) else { return XCTFail() }
        let text = try ReceiveRequestCodec.encode(requestId: r.requestId,
                                                  encapsulationKey: r.encapsulationKey)

        // 1235 bytes = 411 groups + 2 bytes, so the final character carries spare
        // bits. Find an alternative spelling that decodes identically.
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        let last = text.last!
        var found = false
        for candidate in alphabet where candidate != last {
            let mutated = String(text.dropLast()) + String(candidate)
            guard let decoded = SptBytes.fromBase64Url(String(mutated.dropFirst(5))) else { continue }
            if decoded == body {
                found = true
                guard case .failed(let reason, _) = ReceiveRequestCodec.decode(mutated) else {
                    return XCTFail("a non-canonical spelling was accepted")
                }
                XCTAssertEqual(reason, .noncanonicalBase64Url)
            }
        }
        XCTAssertTrue(found, "expected at least one alternative spelling of the final group")
    }

    func testUnsupportedVersionAndSuiteAreRefusedNotDowngraded() throws {
        var body = try sampleRequestBody()
        body[0] = 0x02
        guard case .failed(let v, _) = ReceiveRequestCodec.parseBody(body) else { return XCTFail() }
        XCTAssertEqual(v, .unsupportedVersion)

        body = try sampleRequestBody()
        body[1] = 0x00; body[2] = 0x02
        guard case .failed(let s, _) = ReceiveRequestCodec.parseBody(body) else { return XCTFail() }
        XCTAssertEqual(s, .unsupportedSuite)
    }

    // MARK: - TPS2

    func testSealedPackageStructuralRefusals() throws {
        let corpus = try SptInteropTests().corpus()
        let package = H.hex(corpus.cases[0].packageHex)

        func reason(_ b: [UInt8]) -> PackageParseError? {
            if case .failed(let reason, _) = SealedPackageCodec.parse(b) { return reason }
            return nil
        }

        XCTAssertNil(reason(package), "the committed package must parse")
        XCTAssertEqual(reason(Array(package.prefix(1210))), .tooShort)

        var wrongMagic = package; wrongMagic[0] = 0x54; wrongMagic[1] = 0x50; wrongMagic[2] = 0x53; wrongMagic[3] = 0x33
        XCTAssertEqual(reason(wrongMagic), .wrongMagic)

        var badVersion = package; badVersion[SptConstants.TPS2Offsets.version] = 0x02
        XCTAssertEqual(reason(badVersion), .unsupportedVersion)

        var badSuite = package
        badSuite[SptConstants.TPS2Offsets.suite] = 0x00
        badSuite[SptConstants.TPS2Offsets.suite + 1] = 0x09
        XCTAssertEqual(reason(badSuite), .unsupportedSuite)

        // Trailing bytes are a length DISAGREEMENT: a package with something
        // appended is not this package.
        XCTAssertEqual(reason(package + [0x00]), .lengthMismatch)

        // A declared length near 2^63 must be refused on range, never converted.
        var huge = package
        SptBytes.writeUInt64BE(&huge, SptConstants.TPS2Offsets.plaintextLength, 0x7fff_ffff_ffff_ffff)
        XCTAssertEqual(reason(huge), .declaredLengthTooLarge)

        // And one just over the cap, which is the boundary that actually matters.
        var overCap = package
        SptBytes.writeUInt64BE(&overCap, SptConstants.TPS2Offsets.plaintextLength,
                               UInt64(SptConstants.maxPlaintextBytes) + 1)
        XCTAssertEqual(reason(overCap), .declaredLengthTooLarge)
    }

    /// The header IS the AAD, byte for byte. If those ever diverged, every field
    /// the header claims would stop being authenticated.
    func testHeaderIsExactlyTheAad() throws {
        let corpus = try SptInteropTests().corpus()
        let package = H.hex(corpus.cases[0].packageHex)
        guard case .ok(let parsed) = SealedPackageCodec.parse(package) else { return XCTFail() }
        XCTAssertEqual(parsed.aad, Array(package.prefix(SptConstants.tps2HeaderBytes)))
        XCTAssertEqual(parsed.aad.count, 1195)

        let rebuilt = try SealedPackageCodec.buildHeader(HeaderFields(
            requestId: parsed.header.requestId,
            requestHash: parsed.header.requestHash,
            kemCiphertext: parsed.header.kemCiphertext,
            nonce: parsed.header.nonce,
            plaintextLength: parsed.header.plaintextLength
        ))
        XCTAssertEqual(rebuilt, parsed.aad, "buildHeader must reproduce the parsed header exactly")
    }

    // MARK: - open refusals

    func testOpenRefusalReasons() throws {
        let corpus = try SptInteropTests().corpus()
        let k = corpus.cases[0]
        let body = H.hex(k.requestBodyHex)
        let package = H.hex(k.packageHex)
        let seed = H.hex(k.decapSeedHex)

        func reason(_ pkg: [UInt8], _ b: [UInt8], _ s: [UInt8]) -> OpenError? {
            if case .failed(let reason, _) = SptCryptoV1.open(packageBytes: pkg,
                                                              canonicalRequestBody: b,
                                                              decapsulationSeed: s) { return reason }
            return nil
        }

        XCTAssertNil(reason(package, body, seed), "control: the committed package opens")

        // A body that is not a canonical request is refused BEFORE it is hashed or
        // used to name a request domain.
        XCTAssertEqual(reason(package, Array(body.dropLast()), seed), .malformedRequestBody)

        // A different request: same shape, different bytes.
        var otherBody = body
        otherBody[3] ^= 0xff  // flip a requestId byte
        XCTAssertEqual(reason(package, otherBody, seed), .requestMismatch)

        // A wrong decapsulation key and a corrupted tag are ONE outcome — the
        // protocol offers no decapsulation oracle.
        var wrongSeed = seed; wrongSeed[0] ^= 0x01
        XCTAssertEqual(reason(package, body, wrongSeed), .cryptographicOpenFailed)

        var corruptedTag = package; corruptedTag[corruptedTag.count - 1] ^= 0x01
        XCTAssertEqual(reason(corruptedTag, body, seed), .cryptographicOpenFailed)

        var corruptedCiphertext = package
        corruptedCiphertext[SptConstants.tps2HeaderBytes] ^= 0x01
        XCTAssertEqual(reason(corruptedCiphertext, body, seed), .cryptographicOpenFailed)

        // Tampering with the AAD must fail the same way: every header field is
        // authenticated, so there is no unauthenticated routing metadata to abuse.
        var tamperedNonce = package
        tamperedNonce[SptConstants.TPS2Offsets.nonce] ^= 0x01
        XCTAssertEqual(reason(tamperedNonce, body, seed), .cryptographicOpenFailed)
    }

    /// §7.4 / §20. The nonce is CARRIED, not re-derived, so a build with a wrong
    /// DS_PAD length octet would derive a different nonce for the same pad and
    /// every package would still verify. Re-deriving after AEAD verification and
    /// comparing turns that whole bug class into a refusal — and this test proves
    /// the check is reachable, by sealing a package whose carried nonce is a
    /// deliberate lie while its AEAD remains valid.
    func testDerivedNonceMismatchIsDetected() throws {
        let corpus = try SptInteropTests().corpus()
        let k = corpus.cases[0]
        let body = H.hex(k.requestBodyHex)
        let payload = H.hex(k.payloadHex)
        let seed = H.hex(k.decapSeedHex)
        let eseed = H.hex(k.eseedHex)

        guard case .ok(let request, let canonicalBody) = ReceiveRequestCodec.parseBody(body) else {
            return XCTFail()
        }
        let requestHash = try SptFingerprint.requestFingerprint(canonicalBody)
        let enc = try DeterministicXWing.encapsulate(publicKey: request.encapsulationKey, eseed: eseed)
        let prk = SptCryptoV1.derivePrk(sharedSecret: enc.sharedSecret, requestHash: requestHash)

        // A nonce that is NOT the one this payload derives, but is otherwise
        // well-formed — then seal consistently with it, so the AEAD verifies.
        let honestNonce = try SptCryptoV1.nonce(prk: prk, padHash: try SptCryptoV1.derivePadHash(payload))
        var lyingNonce = honestNonce
        lyingNonce[0] ^= 0x01

        let header = try SealedPackageCodec.buildHeader(HeaderFields(
            requestId: request.requestId,
            requestHash: requestHash,
            kemCiphertext: enc.ciphertext,
            nonce: lyingNonce,
            plaintextLength: payload.count
        ))
        let key = try SptCryptoV1.aeadKey(prk: prk, aad: header)
        let box = try AES.GCM.seal(payload,
                                   using: SymmetricKey(data: key),
                                   nonce: try AES.GCM.Nonce(data: lyingNonce),
                                   authenticating: header)
        let forged = header + [UInt8](box.ciphertext) + [UInt8](box.tag)

        guard case .failed(let reason, _) = SptCryptoV1.open(packageBytes: forged,
                                                             canonicalRequestBody: body,
                                                             decapsulationSeed: seed) else {
            return XCTFail("a package with a lying nonce was accepted")
        }
        XCTAssertEqual(reason, OpenError.derivedNonceMismatch,
                       "the re-derived-nonce check must be what refuses this, not the AEAD")
    }
}
