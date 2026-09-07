import XCTest
@testable import TruePadUI
import TruePadCore
import TruePadStorage

/// WHAT THE OPERATOR IS HANDED, AND WHAT THE BUTTONS HAND OVER.
///
/// The engine emits canonical §6.2 JSON. That is correct for the engine and wrong
/// for a human: it is several hundred characters of structure where `TP2:` is one
/// token. The compact spelling was already being computed on the Send screen to
/// feed the QR and then discarded, so the iPhone displayed the JSON.
///
/// Three things must hold and none of them is visible from a screenshot:
///
///   1. the COMPACT form is the primary one shown;
///   2. Copy and Share hand over EXACTLY the displayed value, not a re-derived
///      one — a screen that re-spells on the way to the clipboard can hand over
///      something the operator never saw; and
///   3. both spellings still open, because changing what is shown must not
///      change what is accepted.
final class TransportPresentationTests: XCTestCase {

    private func source(_ relative: String) throws -> String {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(contentsOf: repo.appendingPathComponent(relative), encoding: .utf8)
    }

    private var sendView: String { (try? source("ios/TruePadKit/Sources/TruePadUI/MessageViews.swift")) ?? "" }
    private var receiveView: String { (try? source("ios/TruePadKit/Sources/TruePadUI/CeremonyViews.swift")) ?? "" }
    private var sendModel: String { (try? source("ios/TruePadKit/Sources/TruePadUI/Models.swift")) ?? "" }

    // MARK: - the validated type

    func testOnlyCanonicalPublicMaterialCanBecomeTransport() {
        // Plaintext, pad material and arbitrary strings are refused by
        // construction — there is no way to get a PublicTransport out of them.
        for text in ["hello", "", "TP2", "TPR2", "{\"formatVersion\":2}",
                     "not a message at all", "TP2:!!!!not-base64!!!!"] {
            guard case .failure = PublicTransport.from(text) else {
                return XCTFail("\(text) was accepted as public transport material")
            }
        }
    }

    /// The SHARED cross-edition corpus, the same file CompactEnvelopeTests drives.
    private struct Corpus: Decodable {
        struct EncodeCase: Decodable { let compact: String; let json: String }
        let encode: [EncodeCase]
    }

    private func corpus() throws -> Corpus {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repo.appendingPathComponent("android/vectors/compact-envelope-v1.json")
        return try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: url))
    }

    func testTheCompactSpellingRoundTripsAndIsWhatIsCarried() throws {
        let compacts = try corpus().encode.map(\.compact)
        // POSITIVE CONTROL: the shared corpus really loaded and has content.
        XCTAssertGreaterThanOrEqual(compacts.count, 5, "the compact corpus did not load")

        for text in compacts {
            guard case .success(let material) = PublicTransport.envelope(text) else {
                return XCTFail("a released compact vector was refused: \(text.prefix(24))…")
            }
            XCTAssertEqual(material.text, text, "the carried text is not the validated text")
            XCTAssertEqual(material.kind, .envelope)
            XCTAssertEqual(material.egress, .publicText)
        }
    }

    /// A LONG MESSAGE IS STILL COPYABLE. Gating copy on the QR type would refuse
    /// exactly the messages most in need of a copy button.
    func testCopyabilityIsNotBoundedByWhatFitsInAQr() {
        let big = "TP2:" + String(repeating: "A", count: QrPayloadBuilder.maxQrCharacters + 10)
        // It is refused here because it is not canonical, not because of length —
        // and the QR builder refuses it for length. The two are separate gates.
        if case .failure(let qrReason) = QrPayloadBuilder.envelope(big) {
            XCTAssertEqual(qrReason, .tooLong)
        } else {
            XCTFail("an over-long payload was accepted as a QR")
        }
        // PublicTransport has no length ceiling of its own.
        let presentation = try? source("ios/TruePadKit/Sources/TruePadUI/Presentation.swift")
        XCTAssertNotNil(presentation)
        guard let text = presentation,
              let decl = text.range(of: "public struct PublicTransport"),
              let end = text.range(of: "public enum QrPayloadBuilder") else {
            return XCTFail("PublicTransport is no longer where this guard looks")
        }
        let body = String(text[decl.lowerBound..<end.lowerBound])
        XCTAssertFalse(body.contains("maxQrCharacters"),
                       "copying is gated on QR capacity, so long messages cannot be copied")
    }

    /// THE CANONICAL SPELLING IS PUBLIC TOO, and is re-validated the same way.
    func testCanonicalJsonIsCarriedOnlyWhenItRoundTrips() throws {
        let cases = try corpus().encode
        XCTAssertGreaterThanOrEqual(cases.count, 5, "the corpus did not load")

        for c in cases {
            guard case .success(let material) = PublicTransport.canonicalJson(c.json) else {
                return XCTFail("a released canonical envelope was refused")
            }
            XCTAssertEqual(material.text, c.json, "the carried text is not the validated text")
            XCTAssertEqual(material.kind, .canonicalJson)
            XCTAssertEqual(material.egress, .publicText)
            // `from` must route it without being told which spelling it is.
            guard case .success(let routed) = PublicTransport.from(c.json) else {
                return XCTFail("from() does not recognise canonical JSON")
            }
            XCTAssertEqual(routed.kind, .canonicalJson)
        }
    }

    func testAnythingThatIsNotACanonicalEnvelopeIsStillRefused() {
        for text in ["{}", "{\"formatVersion\":2}", "{not json", "hello",
                     "{\"formatVersion\":2,\"pairId\":\"x\"}"] {
            guard case .failure = PublicTransport.canonicalJson(text) else {
                return XCTFail("\(text) was accepted as a canonical envelope")
            }
        }
    }

    func testTheTechnicalFormCanBeCopiedThroughTheAuditedBoundary() {
        XCTAssertTrue(sendView.contains("SecondaryButton(\"Copy JSON\")"),
                      "the technical form cannot be copied, so a channel that mangles the compact "
                      + "form leaves the operator with no way to hand the message over")
        // RE-VALIDATED ONCE, IN THE MODEL — the same rule the compact spelling and
        // the QR already follow, and the rule the view broke by validating inside
        // its own body. `Details` stores its content eagerly, so that call ran on
        // every body evaluation whether the disclosure was open or not, and the
        // compose field's binding meant every keystroke: a full JSON decode, a
        // whole-envelope scalar scan, a hex decode of the ciphertext, a re-encode
        // and a string comparison, on the main thread, per character typed.
        //
        // The property this guard is for is unchanged — nothing reaches the
        // pasteboard that was not decoded and re-encoded to an identical string —
        // so it is asserted where that now happens.
        XCTAssertTrue(sendModel.contains("PublicTransport.canonicalJson(result.envelope)"),
                      "the technical form is copied without being re-validated")
        XCTAssertTrue(sendModel.contains("var canonicalJson: PublicTransport?"),
                      "the validated canonical form is not published for the view to copy")
        XCTAssertFalse(sendView.contains("PublicTransport.canonicalJson("),
                       "the view validates the envelope itself again, which puts a full "
                       + "decode/re-encode on every keystroke in the compose field")
        XCTAssertTrue(sendView.contains("if let json = model.canonicalJson"),
                      "Copy JSON no longer carries the model's validated value")
        XCTAssertTrue(sendView.contains("PublicTransportPasteboard.copy(json)"),
                      "Copy JSON does not go through the audited pasteboard boundary")
    }

    // MARK: - what the send screen shows and what its buttons carry

    func testTheSendScreenShowsTheCompactFormAndDemotesTheJson() {
        // POSITIVE CONTROL.
        XCTAssertTrue(sendView.contains("struct SendView"))

        XCTAssertTrue(sendView.contains("if let material = model.compact"),
                      "the send screen no longer leads with the compact form")
        XCTAssertTrue(sendView.contains("Text(material.text)"),
                      "the compact form is not what is displayed")
        XCTAssertTrue(sendView.contains("Details(\"Technical form\")"),
                      "the canonical JSON is no longer offered at all, or is no longer demoted")
        // The JSON must still be REACHABLE — demoted, not deleted.
        XCTAssertTrue(sendView.contains("Text(envelope)"),
                      "the canonical JSON was removed rather than moved")
    }

    /// COPY AND SHARE CARRY THE DISPLAYED VALUE. Both take the same `material`
    /// the screen rendered; neither re-derives a spelling of its own.
    func testCopyAndShareCarryExactlyWhatIsDisplayed() {
        XCTAssertTrue(sendView.contains("PublicTransportPasteboard.copy(material)"),
                      "Copy does not hand over the displayed value")
        XCTAssertTrue(sendView.contains("ShareSheet(items: [text])")
                      && sendView.contains("model.compact?.text"),
                      "Share does not hand over the displayed value")
        // It must NOT copy the canonical JSON, which is not what is on screen.
        XCTAssertFalse(sendView.contains("PublicTransportPasteboard.copy(PublicTransport"),
                       "Copy constructs its own value instead of using the displayed one")
    }

    func testTheModelPublishesOneValidatedValueForEveryEgress() {
        XCTAssertTrue(sendModel.contains("case .success(let material) = PublicTransport.envelope(encoded)"),
                      "the compact form is no longer re-validated before being offered")
        XCTAssertTrue(sendModel.contains("QrPayloadBuilder.envelope(material.text)"),
                      "the QR is built from a different string than the one displayed")
    }

    // MARK: - the receive code

    func testTheReceiveCodeHasExplicitCopyAndShare() {
        XCTAssertTrue(receiveView.contains("struct ReceiveRequestView"))
        XCTAssertTrue(receiveView.contains("PrimaryButton(\"Copy code\")"),
                      "the receive screen lost its Copy code control")
        XCTAssertTrue(receiveView.contains("SecondaryButton(\"Share code\")"),
                      "the receive screen lost its Share code control")
        XCTAssertTrue(receiveView.contains("PublicTransportPasteboard.copy(material)"),
                      "Copy code does not go through the audited boundary")
        XCTAssertTrue(receiveView.contains("model.code?.text"),
                      "Share code does not hand over the displayed value")
    }

    // MARK: - both spellings still open

    /// CHANGING WHAT IS SHOWN MUST NOT CHANGE WHAT IS ACCEPTED.
    func testBothSpellingsStillDecodeToTheSameEnvelope() throws {
        var checked = 0
        for c in try corpus().encode {
            let compact = c.compact, json = c.json
            guard case .ok(let fromCompact) = CompactEnvelope.decodeTransport(compact),
                  case .ok(let fromJson) = CompactEnvelope.decodeTransport(json) else {
                return XCTFail("a released vector no longer decodes through the transport path")
            }
            XCTAssertEqual(try CompactEnvelope.encode(fromCompact),
                           try CompactEnvelope.encode(fromJson),
                           "the two spellings decoded to different envelopes")
            checked += 1
        }
        XCTAssertGreaterThan(checked, 0, "no vector carried both spellings, so this proved nothing")
    }

    /// And the ENGINE's open path is the spelling-agnostic one, not a JSON-only
    /// parser that happens to work today.
    func testTheEngineOpensThroughTheTransportDecoder() throws {
        let verbs = try source("ios/TruePadKit/Sources/TruePadStorage/Verbs.swift")
        XCTAssertTrue(verbs.contains("CompactEnvelope.decodeTransport(envelopeText)"),
                      "open no longer routes through the spelling-agnostic decoder, so one of the "
                      + "two forms may have stopped being accepted")
    }
}
