import Foundation
import TruePadCore
import XCTest

/// The v2 envelope wire — the strict §6.2 parse and the byte-exact emission.
///
/// `envelope-refusals.json` is a 20-case corpus generated from the released
/// TruePad v2.0.0, and it is the interesting file: it pins not just WHETHER each
/// line is refused but WITH WHICH TYPED REASON. That precedence is normative —
/// a v1 envelope must be `envelope-v1` and never `malformed-envelope`, and an
/// oversize declaration must be `oversize-ciphertext` and never demoted to
/// malformed by a truncated hex string.
final class EnvelopeWireTests: XCTestCase {
    typealias H = OtpKernelVectorTests

    func vectors(_ name: String) throws -> [String: Any] {
        let url = XWingKATTests.repoRoot.appendingPathComponent("android/vectors/\(name)")
        return try JSONSerialization.jsonObject(with: try Data(contentsOf: url)) as! [String: Any]
    }

    /// Byte-exact emission: the eight fields, in the §6.2 order, lowercase hex.
    func testEncodeVectors() throws {
        let doc = try vectors("envelope-encode.json")
        let cases = doc["cases"] as! [[String: Any]]
        XCTAssertGreaterThanOrEqual(cases.count, 2)

        for c in cases {
            let input = c["input"] as! [String: Any]
            let envelope = EnvelopeV2(
                pairId: input["pairId"] as! String,
                direction: PadDirection.fromWire(input["direction"] as! String)!,
                sequence: input["sequence"] as! Int,
                startOffset: input["startOffset"] as! Int,
                ciphertextLength: input["ciphertextLength"] as! Int,
                ciphertext: H.hex(input["ciphertextHex"] as! String),
                tag: H.hex(input["tagHex"] as! String)
            )
            let wire = try EnvelopeCodec.encode(envelope)
            XCTAssertEqual(wire, c["wire"] as! String, "emitted wire bytes")

            // And what this edition emits, it must accept, recovering every field.
            guard case .ok(let decoded) = EnvelopeCodec.decode(wire) else {
                return XCTFail("this edition refused its own emission")
            }
            XCTAssertEqual(decoded, envelope)
        }
    }

    /// The refusal corpus, reason by reason.
    func testRefusalCorpus() throws {
        let doc = try vectors("envelope-refusals.json")
        let corpus = doc["corpus"] as! [[String: Any]]
        XCTAssertGreaterThanOrEqual(corpus.count, 20, "the refusal corpus should not have shrunk")

        var accepted = 0
        var refusedByReason: [String: Int] = [:]

        for c in corpus {
            let name = c["name"] as! String
            let text = c["text"] as! String
            let shouldBeOk = c["ok"] as! Bool
            let outcome = EnvelopeCodec.decode(text)

            switch outcome {
            case .ok:
                XCTAssertTrue(shouldBeOk, "[\(name)] was accepted but the corpus refuses it")
                accepted += 1
            case .refused(let reason, _):
                XCTAssertFalse(shouldBeOk, "[\(name)] was refused but the corpus accepts it")
                if let expected = c["reason"] as? String {
                    XCTAssertEqual(reason.rawValue, expected,
                                   "[\(name)] refused with the wrong typed reason")
                }
                refusedByReason[reason.rawValue, default: 0] += 1
            }
        }

        XCTAssertGreaterThanOrEqual(accepted, 1, "the corpus should contain a valid line")
        XCTAssertGreaterThanOrEqual(refusedByReason.count, 2,
                                    "the corpus should exercise more than one refusal reason")
    }

    /// The v1 signature is checked FIRST. A v1 envelope also fails the eight-key
    /// rule, so without that precedence it would land on `malformed-envelope` and
    /// the operator would be told the line is corrupt rather than that it is a v1
    /// envelope needing v1 tooling. Ledger claim N4 depends on this.
    func testV1SignatureTakesPrecedenceOverTheEightKeyRule() {
        let v1 = "{\"label\":\"page-1\",\"startOffset\":0,\"consumed\":5,\"payload\":\"ABCDE\"}"
        guard case .refused(let reason, let message) = EnvelopeCodec.decode(v1) else {
            return XCTFail("a v1 envelope must be refused")
        }
        XCTAssertEqual(reason, .envelopeV1)
        XCTAssertTrue(message.contains("no --legacy flag"),
                      "the refusal should say there is no bridge, not hint at one")
    }

    /// Oversize fires on the DECLARED length, before the ciphertext hex is
    /// decoded, so a truncated hex string cannot demote it to malformed.
    func testOversizeIsNotDemotedByTruncatedHex() {
        let declared = WcOneTime.maxCiphertextBytes + 1
        let text = "{\"formatVersion\":2,\"pairId\":\"\(String(repeating: "a", count: 32))\","
            + "\"direction\":\"A->B\",\"sequence\":0,\"startOffset\":0,"
            + "\"ciphertextLength\":\(declared),\"ciphertext\":\"00\","
            + "\"tag\":\"\(String(repeating: "b", count: 32))\"}"
        guard case .refused(let reason, _) = EnvelopeCodec.decode(text) else {
            return XCTFail("an oversize declaration must be refused")
        }
        XCTAssertEqual(reason, .oversizeCiphertext,
                       "the short hex must not demote this to malformed-envelope")
    }

    /// One spelling per token. These all decode to in-domain values under an
    /// ordinary JSON parser, which is exactly why the lexical scan exists.
    func testOneSpellingPerToken() {
        func valid(_ overrides: [String: String] = [:]) -> String {
            var fields: [(String, String)] = [
                ("formatVersion", "2"),
                ("pairId", "\"\(String(repeating: "a", count: 32))\""),
                ("direction", "\"A->B\""),
                ("sequence", "0"),
                ("startOffset", "0"),
                ("ciphertextLength", "0"),
                ("ciphertext", "\"\""),
                ("tag", "\"\(String(repeating: "b", count: 32))\""),
            ]
            fields = fields.map { (k, v) in (k, overrides[k] ?? v) }
            return "{" + fields.map { "\"\($0.0)\":\($0.1)" }.joined(separator: ",") + "}"
        }

        // Control.
        guard case .ok = EnvelopeCodec.decode(valid()) else {
            return XCTFail("the control line should decode")
        }

        // Non-canonical NUMBER spellings that all fold to the same value.
        for spelling in ["0.0", "0e0", "-0", "00"] {
            guard case .refused(let reason, _) =
                    EnvelopeCodec.decode(valid(["sequence": spelling])) else {
                return XCTFail("sequence spelled \(spelling) should be refused")
            }
            XCTAssertEqual(reason, .malformedEnvelope, "sequence spelled \(spelling)")
        }
        for spelling in ["2.0", "2e0", "02"] {
            guard case .refused = EnvelopeCodec.decode(valid(["formatVersion": spelling])) else {
                return XCTFail("formatVersion spelled \(spelling) should be refused")
            }
        }

        // An escaped property NAME that decodes to a required key.
        let escapedName = "{\"\\u0070airId\":\"\(String(repeating: "a", count: 32))\","
            + "\"formatVersion\":2,\"direction\":\"A->B\",\"sequence\":0,\"startOffset\":0,"
            + "\"ciphertextLength\":0,\"ciphertext\":\"\",\"tag\":\"\(String(repeating: "b", count: 32))\"}"
        guard case .refused(let nameReason, _) = EnvelopeCodec.decode(escapedName) else {
            return XCTFail("an escaped property name should be refused")
        }
        XCTAssertEqual(nameReason, .malformedEnvelope)

        // An escaped string VALUE that decodes to an in-domain direction.
        guard case .refused = EnvelopeCodec.decode(valid(["direction": "\"A-\\u003eB\""])) else {
            return XCTFail("an escaped string value should be refused")
        }

        // A duplicate key. A JSON parser keeps the last one silently.
        let duplicate = "{\"formatVersion\":2,\"formatVersion\":2,"
            + "\"pairId\":\"\(String(repeating: "a", count: 32))\",\"direction\":\"A->B\","
            + "\"sequence\":0,\"startOffset\":0,\"ciphertextLength\":0,\"ciphertext\":\"\","
            + "\"tag\":\"\(String(repeating: "b", count: 32))\"}"
        guard case .refused(let dupReason, let dupMessage) = EnvelopeCodec.decode(duplicate) else {
            return XCTFail("a duplicate key should be refused")
        }
        XCTAssertEqual(dupReason, .malformedEnvelope)
        XCTAssertTrue(dupMessage.contains("appears 2 times"))

        // Uppercase hex is a second spelling of the same bytes.
        guard case .refused = EnvelopeCodec.decode(valid(["tag": "\"\(String(repeating: "B", count: 32))\""])) else {
            return XCTFail("uppercase hex should be refused")
        }
    }

    /// A deeply nested hostile document must produce a typed refusal, not a stack
    /// overflow. Recursive descent without a cap would crash the process, and a
    /// crash is not a refusal.
    func testDeepNestingIsRefusedNotCrashed() {
        let deep = String(repeating: "[", count: 5000) + String(repeating: "]", count: 5000)
        guard case .refused(let reason, _) = EnvelopeCodec.decode(deep) else {
            return XCTFail("a deeply nested document should be refused")
        }
        XCTAssertEqual(reason, .malformedEnvelope)
    }

    /// The strict JSON reader itself: the acceptance envelope the grammar assumes.
    func testStrictJsonAcceptanceBoundaries() {
        let rejected = [
            "{\"a\":1,}",            // trailing comma
            "{'a':1}",               // single quotes
            "{a:1}",                 // bare key
            "{\"a\":01}",            // leading zero
            "{\"a\":+1}",            // explicit plus
            "{\"a\":.5}",            // bare fraction
            "{\"a\":1} trailing",    // trailing content
            "{\"a\":\"\u{01}\"}",    // unescaped control character
            "// comment\n{}",        // comments
        ]
        for text in rejected {
            XCTAssertThrowsError(try parseStrictJson(text), "should refuse: \(text)")
        }
        XCTAssertNoThrow(try parseStrictJson("{\"a\":[1,2,{\"b\":null}],\"c\":true}"))
        // The raw number spelling survives the parse — the whole point.
        guard case .object(let members) = try! parseStrictJson("{\"a\":7.0}") else {
            return XCTFail("expected an object")
        }
        XCTAssertEqual(members.first?.value, .number(raw: "7.0"))
    }

    func testHexCodecIsStrictAndLowercaseOnly() {
        XCTAssertEqual(Hex.encode([0x00, 0x0f, 0xa5, 0xff]), "000fa5ff")
        XCTAssertEqual(Hex.decode("000fa5ff"), [0x00, 0x0f, 0xa5, 0xff])
        XCTAssertEqual(Hex.decode(""), [])
        XCTAssertNil(Hex.decode("00FF"), "uppercase is refused, never normalized")
        XCTAssertNil(Hex.decode("0"), "odd length")
        XCTAssertNil(Hex.decode("0x00"))
        XCTAssertNil(Hex.decode("00 11"))
    }
}
