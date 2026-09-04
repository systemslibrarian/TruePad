import Foundation
@testable import TruePadCore
@testable import TruePadStorage
import XCTest

/// TP2 COMPACT TRANSPORT, held to the released bytes.
///
/// `android/vectors/compact-envelope-v1.json` was GENERATED from the released
/// TruePad v2.0.0 and carries the exact compact spelling of each envelope, an
/// 18-case decode corpus, and the transport-door cases. Nothing in this file is a
/// literal I chose.
///
/// This is a PRESENTATION codec and nothing else. The Wegman–Carter tag is
/// computed over the SEMANTIC fields, never over these bytes, so a compact
/// message decodes to an EnvelopeV2 and is then verified by the existing
/// pipeline, unchanged.
final class CompactEnvelopeTests: XCTestCase {
    struct Vector: Decodable {
        struct EncodeCase: Decodable {
            struct Input: Decodable {
                let name: String
                let pairId: String
                let direction: String
                let sequence: Int
                let startOffset: Int
                let ciphertextHex: String
                let tagHex: String
                let ciphertextLength: Int
            }
            let name: String
            let input: Input
            let compact: String
            let json: String
        }
        struct DecodeCase: Decodable {
            let name: String
            let text: String
            let ok: Bool
            let reason: String?
        }
        let prefix: String
        let transportVersion: Int
        let encode: [EncodeCase]
        let decode: [DecodeCase]
        let transportDoor: [DecodeCase]
    }

    func vector() throws -> Vector {
        let url = XWingKATTests.repoRoot
            .appendingPathComponent("android/vectors/compact-envelope-v1.json")
        return try JSONDecoder().decode(Vector.self, from: Data(contentsOf: url))
    }

    func envelope(_ i: Vector.EncodeCase.Input) throws -> EnvelopeV2 {
        EnvelopeV2(pairId: i.pairId,
                   direction: try XCTUnwrap(PadDirection.fromWire(i.direction)),
                   sequence: i.sequence, startOffset: i.startOffset,
                   ciphertextLength: i.ciphertextLength,
                   ciphertext: try XCTUnwrap(Hex.decode(i.ciphertextHex)),
                   tag: try XCTUnwrap(Hex.decode(i.tagHex)))
    }

    func testTheConstantsMatchTheReleasedTransport() throws {
        let v = try vector()
        XCTAssertEqual(CompactEnvelope.prefix, v.prefix)
        XCTAssertEqual(Int(CompactEnvelope.transportVersion), v.transportVersion)
    }

    /// Every released encoding, character for character.
    func testEveryEncodeVectorMatchesTheReleasedSpelling() throws {
        let v = try vector()
        XCTAssertGreaterThanOrEqual(v.encode.count, 5, "the corpus should not have shrunk")
        for c in v.encode {
            XCTAssertEqual(try CompactEnvelope.encode(try envelope(c.input)), c.compact,
                           "[\(c.name)] the compact spelling must match the release")
        }
    }

    /// And each one decodes back to the SAME envelope the canonical JSON does —
    /// the two spellings must describe one message.
    func testEveryEncodeVectorRoundTripsToTheSameEnvelope() throws {
        let v = try vector()
        for c in v.encode {
            guard case .ok(let fromCompact) = CompactEnvelope.decode(c.compact) else {
                return XCTFail("[\(c.name)] the released compact form must decode")
            }
            guard case .ok(let fromJson) = EnvelopeCodec.decode(c.json) else {
                return XCTFail("[\(c.name)] the released JSON must decode")
            }
            XCTAssertEqual(fromCompact, fromJson,
                           "[\(c.name)] one message, two spellings — they must agree")
            XCTAssertEqual(try EnvelopeCodec.encode(fromCompact), c.json,
                           "[\(c.name)] and re-encoding gives the canonical JSON back")
        }
    }

    /// The 18-case decode corpus, verdict for verdict — including the refusal
    /// REASON, because "malformed" and "envelope-v1" are different answers.
    func testTheDecodeCorpusAgreesCaseForCase() throws {
        let v = try vector()
        XCTAssertGreaterThanOrEqual(v.decode.count, 17, "the corpus should not have shrunk")
        var refusedCount = 0
        for c in v.decode {
            switch CompactEnvelope.decode(c.text) {
            case .ok:
                XCTAssertTrue(c.ok, "[\(c.name)] accepted something the release refuses")
            case .refused(let reason, let message):
                refusedCount += 1
                XCTAssertFalse(c.ok, "[\(c.name)] refused something the release accepts: \(message)")
                if let expected = c.reason {
                    XCTAssertEqual(reason.rawValue, expected, "[\(c.name)] wrong refusal reason")
                }
            }
        }
        XCTAssertGreaterThan(refusedCount, 10, "the corpus must actually exercise refusals")
    }

    /// The transport door accepts EITHER spelling with no mode selector.
    func testTheTransportDoorAgreesCaseForCase() throws {
        let v = try vector()
        for c in v.transportDoor {
            switch CompactEnvelope.decodeTransport(c.text) {
            case .ok:
                XCTAssertTrue(c.ok, "[\(c.name)] accepted something the release refuses")
            case .refused(let reason, _):
                XCTAssertFalse(c.ok, "[\(c.name)] refused something the release accepts")
                if let expected = c.reason {
                    XCTAssertEqual(reason.rawValue, expected, "[\(c.name)]")
                }
            }
        }
    }

    /// A `TP2:` input is refused AS COMPACT and never retried as JSON. A
    /// half-typed compact string is not a JSON document, and pretending otherwise
    /// would report the wrong error and invite a parser-confusion bug.
    func testAMalformedCompactInputIsNeverRetriedAsJson() {
        for bad in ["TP2:", "TP2:!!!!", "TP2:AQ", "  TP2:zzzz  "] {
            guard case .refused(_, let message) = CompactEnvelope.decodeTransport(bad) else {
                return XCTFail("[\(bad)] must be refused")
            }
            XCTAssertFalse(message.lowercased().contains("json"),
                           "[\(bad)] must be refused AS COMPACT, not as JSON: \(message)")
        }
    }

    // MARK: - one message, one spelling

    /// A non-canonical base64url spelling of the same bytes is refused, so a
    /// message cannot arrive wearing two faces.
    func testANonCanonicalSpellingOfTheSameBytesIsRefused() throws {
        let v = try vector()
        let good = v.encode[0].compact
        for bad in [good + "=", good + "==",
                    good.replacingOccurrences(of: "_", with: "/"),
                    good.replacingOccurrences(of: "-", with: "+")] where bad != good {
            guard case .refused = CompactEnvelope.decode(bad) else {
                return XCTFail("[\(bad)] a non-canonical spelling must be refused")
            }
        }
    }

    /// A NON-MINIMAL varint is refused: `80 00` is the same number as `00`.
    func testANonMinimalVarintIsRefused() throws {
        // Build the bytes by hand: header, pairId, direction, then sequence
        // encoded as the redundant two-byte form of zero.
        var bytes: [UInt8] = [CompactEnvelope.transportVersion, 0x02]
        bytes.append(contentsOf: [UInt8](repeating: 0xA0, count: 16))
        bytes.append(0x00)                       // A->B
        bytes.append(contentsOf: [0x80, 0x00])   // sequence = 0, non-minimally
        bytes.append(0x00)                       // startOffset = 0
        bytes.append(0x00)                       // ciphertextLength = 0
        bytes.append(contentsOf: [UInt8](repeating: 0x5B, count: 16))   // tag

        guard case .refused(_, let message) =
                CompactEnvelope.decode(CompactEnvelope.prefix + CompactEnvelope.toBase64Url(bytes)) else {
            return XCTFail("a non-minimal varint must be refused")
        }
        XCTAssertTrue(message.contains("minimally encoded"), message)
    }

    /// TRAILING BYTES after the tag are refused — a compact envelope carries
    /// nothing else, so there is no place to smuggle anything.
    func testTrailingBytesAfterTheTagAreRefused() throws {
        let v = try vector()
        guard case .ok(let e) = CompactEnvelope.decode(v.encode[0].compact) else {
            return XCTFail("setup")
        }
        var bytes: [UInt8] = [CompactEnvelope.transportVersion, 0x02]
        bytes.append(contentsOf: try XCTUnwrap(Hex.decode(e.pairId)))
        bytes.append(e.direction == .aToB ? 0x00 : 0x01)
        CompactEnvelope.writeUleb128(&bytes, e.sequence)
        CompactEnvelope.writeUleb128(&bytes, e.startOffset)
        CompactEnvelope.writeUleb128(&bytes, e.ciphertextLength)
        bytes.append(contentsOf: e.ciphertext)
        bytes.append(contentsOf: e.tag)
        bytes.append(0xFF)                       // one byte too many

        guard case .refused(_, let message) =
                CompactEnvelope.decode(CompactEnvelope.prefix + CompactEnvelope.toBase64Url(bytes)) else {
            return XCTFail("trailing bytes must be refused")
        }
        XCTAssertTrue(message.contains("trailing"), message)
    }

    /// The compact form is not a LOOSER door: it may only represent an envelope
    /// the canonical encoder would itself emit.
    func testTheCompactFormRefusesWhateverTheCanonicalEncoderRefuses() {
        let bad = EnvelopeV2(pairId: "not-hex", direction: .aToB, sequence: 0, startOffset: 0,
                             ciphertextLength: 1, ciphertext: [0x41],
                             tag: [UInt8](repeating: 0, count: 16))
        XCTAssertThrowsError(try CompactEnvelope.encode(bad))
    }

    // MARK: - the engine accepts either spelling

    /// The verb layer must open a compact envelope exactly as it opens the
    /// canonical JSON — same plaintext, same consumption.
    func testTheEngineOpensACompactEnvelopeIdentically() throws {
        let fixedPairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        let clock = Date(timeIntervalSince1970: 1_756_684_800)
        func engine(_ fs: Fs) -> Engine {
            Engine(fs: fs, clock: { clock }, pairIdSource: { Hex.decode(fixedPairId)! })
        }
        let aliceFs = MemoryFs()
        let a = engine(aliceFs)
        let need = try Partition.requiredSourceLength(capacity: 256, capacityRecords: 4)
        _ = try a.gen(label: "compact",
                      sources: [SourceInput(name: "s.bin", declaredOrigin: "declared",
                                            bytes: [UInt8](repeating: 0x2B, count: need))],
                      encryptionBytes: 256, authRecords: 4)

        // Bob holds his own copy, handed over at gen.
        let bobFs = MemoryFs()
        for path in aliceFs.allPaths {
            if let bytes = try aliceFs.readFile(path) { try bobFs.writeFileAtomic(path, bytes) }
        }
        let b = engine(bobFs)

        let message = Array("compact please".utf8)
        let burned = try a.burn(pairId: fixedPairId, role: .a, plaintext: message)
        guard case .ok(let e) = EnvelopeCodec.decode(burned.envelope) else {
            return XCTFail("the burned envelope must decode")
        }
        let compact = try CompactEnvelope.encode(e)
        XCTAssertTrue(compact.hasPrefix("TP2:"))
        XCTAssertLessThan(compact.count, burned.envelope.count,
                          "the whole point is that it is shorter to carry")

        XCTAssertEqual(try b.open(pairId: fixedPairId, role: .b, envelopeText: compact).plaintext,
                       message, "the compact spelling opens to the same plaintext")
    }
}
