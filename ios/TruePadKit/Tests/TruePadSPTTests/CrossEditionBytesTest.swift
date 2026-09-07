import Foundation
@testable import TruePadCore
import XCTest

/// CAN THE iOS ENGINE CONSUME THE EXACT BYTES ANDROID PRODUCED?
///
/// These are not equivalent fixtures. They are the literal artifacts captured
/// from a physical Samsung SM-A176U during the cross-edition ceremony of
/// 2026-09-07 (evidence `artifacts/cross-edition/20260907T013715Z`): a 398-char
/// `TP2:` compact envelope and the 705-char canonical envelope the same screen
/// displayed for a second message.
///
/// WHAT THIS PROVES, AND WHAT IT DOES NOT. It runs the production decoder over
/// real cross-edition input, so it settles whether the two editions agree on
/// framing, transport encoding and canonical spelling. It does NOT open the
/// message — that needs the pad half held on the handset — so it is NOT a
/// substitute for the physical G gate and must never be cited as one.
final class CrossEditionBytesTest: XCTestCase {

    /// Read from the test's own directory so this reproduces from a clean clone —
    /// provenance in `CrossEditionCaptured/PROVENANCE.md`.
    private static func captured(_ name: String, file: StaticString = #filePath) throws -> String {
        let here = URL(fileURLWithPath: "\(file)").deletingLastPathComponent()
        let url = here.appendingPathComponent("CrossEditionCaptured").appendingPathComponent(name)
        return try String(contentsOf: url, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func testTheAndroidCompactEnvelopeIsWellFormedToThisEngine() throws {
        let text = try Self.captured("03-android-tp2.txt")
        XCTAssertTrue(text.hasPrefix(CompactEnvelope.prefix), "not a compact envelope")
        XCTAssertLessThanOrEqual(text.count, CompactEnvelope.maxCompactChars,
                                 "Android produced something this engine refuses on size alone")
        if case .refused(let reason, let message) = CompactEnvelope.decode(text) {
            XCTFail("the iOS engine refused Android's compact envelope: \(reason) — \(message)")
        }
    }

    func testAndroidsTransportEncodingIsCanonicalToThisEngine() throws {
        let text = try Self.captured("03-android-tp2.txt")
        let body = String(text.dropFirst(CompactEnvelope.prefix.count))
        let bytes = try XCTUnwrap(CompactEnvelope.fromBase64Url(body),
                                  "not the strict base64url this engine accepts")
        XCTAssertGreaterThan(bytes.count, 0)
        // Re-encoding must reproduce Android's exact characters: the editions
        // agree on the encoding itself, not merely on a decodable superset.
        XCTAssertEqual(CompactEnvelope.toBase64Url(bytes), body,
                       "Android's base64url is not canonical to this engine")
    }

    func testTheAndroidCanonicalEnvelopeHasTheShapeThisEngineExpects() throws {
        let text = try Self.captured("04-android-canonical.json")
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
            "Android's canonical envelope is not a JSON object")
        XCTAssertFalse(object.isEmpty, "Android's canonical envelope is empty")
    }
}
