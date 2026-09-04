import Foundation
import TruePadClaims
import TruePadCore
@testable import TruePadSPT
@testable import TruePadStorage
@testable import TruePadUI
import XCTest

/// THE UI'S SECURITY-CARRYING DECISIONS.
///
/// SwiftUI layout and VoiceOver behaviour cannot be tested on CI without a
/// device, and are NOT claimed here — that is what the physical-device gate is
/// for. What IS tested is everything a view could get wrong that would not be a
/// cosmetic bug: the bytes that go in a QR code, whether a verdict was derived,
/// whether a limitation was softened, and whether a confirmation prompt echoes
/// the value it is asking for.
final class PresentationTests: XCTestCase {
    let fixedPairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
    let clock = Date(timeIntervalSince1970: 1_756_684_800)

    override func setUp() {
        // The composition root wires this; tests that need a real receive
        // request wire it the same way, through the SPT codec.
        SptConstantsBridge.isCanonicalReceiveRequest = { text in
            guard case .ok(let request, let body) = ReceiveRequestCodec.decode(text) else { return false }
            return (try? ReceiveRequestCodec.encode(requestId: request.requestId,
                                                    encapsulationKey: request.encapsulationKey)) == text
                && body.count == SptConstants.tpr2BodyBytes
        }
    }

    func engine(_ fs: Fs) -> Engine {
        Engine(fs: fs, clock: { self.clock }, pairIdSource: { Hex.decode(self.fixedPairId)! })
    }

    @discardableResult
    func genPair(_ e: Engine) throws -> String {
        let need = try Partition.requiredSourceLength(capacity: 256, capacityRecords: 4)
        return try e.gen(label: "ui",
                         sources: [SourceInput(name: "dice.bin", declaredOrigin: "physical dice",
                                               bytes: [UInt8](repeating: 0x2B, count: need))],
                         encryptionBytes: 256, authRecords: 4).pair.pairId
    }

    // MARK: - a QR carries public data, and NOTHING else

    /// THE RULE. A real receive request renders; a real compact envelope renders;
    /// and every other kind of bytes TruePad holds is refused.
    func testOnlyAPublicRequestOrEnvelopeCanBecomeAQr() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let pairId = try genPair(e)

        // The two things that ARE allowed.
        let request = try e.sptCreateReceiveRequest()
        guard case .success(.receiveRequest) = QrPayloadBuilder.from(request.tpr2Text) else {
            return XCTFail("a canonical receive request must render")
        }
        let burned = try e.burn(pairId: pairId, role: .a, plaintext: Array("hi".utf8))
        guard case .ok(let envelope) = EnvelopeCodec.decode(burned.envelope) else {
            return XCTFail("setup")
        }
        let compact = try CompactEnvelope.encode(envelope)
        guard case .success(.envelope) = QrPayloadBuilder.from(compact) else {
            return XCTFail("a canonical compact envelope must render")
        }

        // EVERYTHING ELSE the app can lay hands on.
        let container = try e.exportPair(pairId: pairId).container
        let secret = try XCTUnwrap(try fs.readFile(storePath(storeDir(pairId, .aToB), secretFile)))
        let head = try XCTUnwrap(try fs.readFile(storePath(storeDir(pairId, .aToB), headFile)))
        let forbidden: [(String, String)] = [
            ("the courier bundle", String(decoding: container, as: UTF8.self)),
            ("raw pad material", String(decoding: secret, as: UTF8.self)),
            ("a store header", String(decoding: head, as: UTF8.self)),
            ("the canonical envelope JSON", burned.envelope),
            ("plaintext", "attack at dawn"),
            ("a pairId", pairId),
            ("a sealed package", "TPS2" + String(repeating: "A", count: 64)),
            ("a decapsulation seed", String(repeating: "f", count: 64)),
            ("empty", ""),
            ("a lookalike prefix", "TPR2" + String(repeating: "A", count: 32)),
        ]
        for (why, text) in forbidden {
            guard case .failure = QrPayloadBuilder.from(text) else {
                return XCTFail("[\(why)] must NEVER be rendered as a QR code")
            }
        }
    }

    /// A view cannot hand the builder a string it assembled or truncated: the
    /// payload is decoded and RE-ENCODED and must come back identical.
    func testANonCanonicalOrTruncatedPayloadIsRefused() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let request = try e.sptCreateReceiveRequest()

        for (why, text) in [
            ("truncated", String(request.tpr2Text.dropLast(4))),
            ("one character changed", request.tpr2Text.replacingOccurrences(
                of: "TPR2:A", with: "TPR2:B")),
            ("padded", request.tpr2Text + "="),
            ("with trailing space", request.tpr2Text + " "),
        ] where text != request.tpr2Text {
            guard case .failure = QrPayloadBuilder.from(text) else {
                return XCTFail("[\(why)] must be refused")
            }
        }
    }

    /// NO multi-frame or animated QR: a payload too large is refused rather than
    /// split, because a pad that arrives in pieces is a pad whose pieces can be
    /// mixed.
    func testAnOversizePayloadIsRefusedRatherThanSplit() {
        let huge = CompactEnvelope.prefix + String(repeating: "A",
                                                   count: QrPayloadBuilder.maxQrCharacters + 1)
        XCTAssertEqual(try? QrPayloadBuilder.from(huge).get(), nil)
        guard case .failure(let reason) = QrPayloadBuilder.from(huge) else {
            return XCTFail("an oversize payload must be refused")
        }
        XCTAssertEqual(reason, .tooLong)
    }

    /// With no composition root wired, a receive-request QR is REFUSED rather
    /// than rendered unvalidated. Failing closed is the default.
    func testAnUnwiredValidatorRefusesRatherThanRenderingUnchecked() throws {
        let fs = MemoryFs()
        let request = try engine(fs).sptCreateReceiveRequest()
        SptConstantsBridge.isCanonicalReceiveRequest = { _ in false }
        defer { setUp() }

        guard case .failure(.notCanonical) = QrPayloadBuilder.from(request.tpr2Text) else {
            return XCTFail("an unvalidated request must not be rendered")
        }
    }

    // MARK: - the verdict is derived, and the words are not softened

    func testTheDisplayedVerdictIsDerivedFromTheLiveMetersEveryTime() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let pairId = try genPair(e)

        let before = MeterRow(try XCTUnwrap(try e.status(pairId).meters[.aToB]))
        XCTAssertNotEqual(before.verdict, "CONDITIONALLY ELIGIBLE",
                          "an iOS pad can never display the strongest verdict")
        XCTAssertNotNil(before.whyNotStronger, "a non-eligible verdict must say why")

        // Change a live fact — a sealed send — and the SAME code path must show a
        // different verdict, because it derives rather than remembers.
        try commitPhysicalHandoff(fs: fs, pairId: pairId, at: isoNow(clock))
        let marker = #"{"version":1,"pairId":"\#(pairId)","mode":"sealed","at":"\#(isoNow(clock))","requestHash":"a","packageIdentity":"b","confirmHash":"c"}"#
        try fs.writeFileAtomic(handoffMarkerPath(pairId), Array(marker.utf8))

        let after = MeterRow(try XCTUnwrap(try e.status(pairId).meters[.aToB]))
        XCTAssertEqual(after.verdict, "NOT ELIGIBLE")
        XCTAssertTrue(after.whyNotStronger?.contains("sealed") ?? false)
    }

    func testTheMeterRowReportsTheEnginesNumbersUnchanged() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let pairId = try genPair(e)
        _ = try e.burn(pairId: pairId, role: .a, plaintext: Array("five!".utf8))

        let m = try XCTUnwrap(try e.status(pairId).meters[.aToB])
        let row = MeterRow(m)
        XCTAssertEqual(row.encryptionUsed, m.nextOffset)
        XCTAssertEqual(row.encryptionCapacity, m.capacity)
        XCTAssertEqual(row.recordsUsed, m.nextSequence)
        XCTAssertEqual(row.recordsCapacity, m.capacityRecords)
        XCTAssertEqual(row.maxRemainingSends, m.maxRemainingSends)
        XCTAssertEqual(row.limitedBy, m.limitedBy)
        XCTAssertEqual(row.frozen, m.frozen)
    }

    /// The operator is entitled to read these sentences UNALTERED. A UI that
    /// paraphrases one has quietly made a different claim.
    func testTheVerbatimSentencesAreTheEnginesOwn() {
        XCTAssertEqual(VerbatimText.destructionLimitation, destroyLimitation)
        XCTAssertEqual(VerbatimText.sourceVerdict, genVerdict)
        XCTAssertEqual(VerbatimText.destructionLimitation,
                       "Software can forget its reference to pad material; it cannot prove that "
                       + "flash forgot the bytes.")
        XCTAssertTrue(VerbatimText.sourceVerdict.hasPrefix("Uniform if at least one"),
                      "the §7 verdict is SCOPED and must never be promoted")
    }

    /// The explanatory text must not overclaim in the other direction either.
    func testTheExplanatoryTextClaimsNothingItCannotSupport() {
        // The QR note says what the code carries, and does not promise the
        // photograph is harmless in every sense.
        XCTAssertTrue(VerbatimText.qrCarriesOnlyPublicData.contains("never contains pad material"))

        // The share sheet is named as a CARRIER, with no transport claim.
        for forbidden in ["secure", "encrypted channel", "private transport", "end-to-end"] {
            XCTAssertFalse(VerbatimText.shareSheetIsACarrier.localizedCaseInsensitiveContains(forbidden),
                           "the share sheet must not be described as \(forbidden)")
        }
        XCTAssertTrue(VerbatimText.shareSheetIsACarrier.contains("no server"))

        // The word comparison is a DECLARATION, and says so.
        XCTAssertTrue(VerbatimText.wordComparisonIsADeclaration.contains("cannot check"))
        for forbidden in ["proves", "verifies that you", "guarantees"] {
            XCTAssertFalse(VerbatimText.wordComparisonIsADeclaration.localizedCaseInsensitiveContains(forbidden))
        }
    }

    // MARK: - destroy confirms by knowing

    func testTheDestroyPromptNeverEchoesThePairId() throws {
        let fs = MemoryFs()
        let pairId = try genPair(engine(fs))
        for unreadable in [true, false] {
            let prompt = DestroyPrompt.text(forUnreadablePair: unreadable)
            XCTAssertFalse(DestroyPrompt.leaks(prompt, pairId: pairId),
                           "the prompt must not contain the value it asks for")
        }
        XCTAssertTrue(DestroyPrompt.text(forUnreadablePair: false).contains("will not show it"))
        XCTAssertTrue(DestroyPrompt.text(forUnreadablePair: true).contains(unreadablePairToken),
                      "an unidentifiable pad needs the literal token, so the prompt names it")
    }

    // MARK: - what may leave the app, and how

    /// PAD MATERIAL NEVER REACHES THE CLIPBOARD. The clipboard is readable by
    /// other apps and syncs across devices by Handoff; the share sheet hands
    /// bytes to an app the operator picked, which is a different risk they are
    /// choosing.
    func testPadMaterialNeverReachesTheClipboardOrAQr() {
        XCTAssertFalse(EgressPolicy.mayCopyToClipboard(.fileOnly))
        XCTAssertFalse(EgressPolicy.mayRenderAsQr(.fileOnly))
        XCTAssertTrue(EgressPolicy.mayShareAsFile(.fileOnly))

        XCTAssertTrue(EgressPolicy.mayCopyToClipboard(.publicText))
        XCTAssertTrue(EgressPolicy.mayRenderAsQr(.publicText))
    }

    /// A file name is metadata that survives in places the file's contents do
    /// not, so it carries no label, no date, and no pairId.
    func testTheOfferedFileNameCarriesNoMetadata() throws {
        let fs = MemoryFs()
        let pairId = try genPair(engine(fs))
        for sealed in [true, false] {
            let name = EgressPolicy.fileName(for: .fileOnly, sealed: sealed)
            XCTAssertFalse(name.contains(pairId))
            XCTAssertFalse(name.contains("ui"), "the pad's label must not leak into the name")
            // The STEM carries no date and no counter. The extension is a format
            // name -- `.tps2` is the sealed-package format, not a sequence number
            // -- so the digits there are meaning, not metadata.
            let stem = name.split(separator: ".").first.map(String.init) ?? name
            for digit in "0123456789" {
                XCTAssertFalse(stem.contains(digit), "no date or counter in \(name)")
            }
        }
        XCTAssertEqual(EgressPolicy.fileName(for: .fileOnly, sealed: true), "transfer.tps2")
        XCTAssertEqual(EgressPolicy.fileName(for: .fileOnly, sealed: false), "pad.tpair")
    }

    // MARK: - the UI module's own posture

    /// The presentation layer must not reach the KEM, and must not import SwiftUI
    /// in the file that holds the security-carrying decisions — that file has to
    /// stay testable without a device.
    func testThePresentationLogicImportsNoUiFrameworkAndNoKem() throws {
        let path = PostureGuardTests.kitRoot
            .appendingPathComponent("Sources/TruePadUI/Presentation.swift")
        let text = PostureGuardTests.stripComments(try String(contentsOf: path, encoding: .utf8))
        for forbidden in ["import SwiftUI", "import UIKit", "import TruePadSPT",
                          "import Crypto", "import AVFoundation"] {
            XCTAssertFalse(text.contains(forbidden),
                           "Presentation.swift must not \(forbidden) — it has to stay testable "
                           + "without a device, and the UI has no business reaching the KEM")
        }
    }
}
