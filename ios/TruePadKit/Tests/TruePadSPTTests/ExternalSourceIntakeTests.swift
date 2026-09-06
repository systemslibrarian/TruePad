import XCTest
@testable import TruePadCore
@testable import TruePadUI

/// THE EXTERNAL-MATERIAL PATH, WHICH WAS INERT.
///
/// `CreatePadView` offered Advanced -> "Use external random material" ->
/// "Choose a file…", and that button set `choosingFile = true`. No `.fileImporter`
/// anywhere observed that flag — the only one in the file belonged to
/// `OpenSealedView` and a different model. So no picker appeared,
/// `chosenFileBytes` stayed nil, `canCreate` stayed false, and the only route to
/// the strongest deployment classification was a dead end.
///
/// It survived every gate because `CeremonyModels.swift` and `CeremonyViews.swift`
/// are `#if os(iOS)` — invisible to `swift test` on a Mac — and because the iOS
/// physical suite deliberately avoids the file picker, as its own comment says:
/// "No file picker is involved, which is what makes this path automatable at all."
///
/// So the decision now lives in `ExternalSourceIntake`, in a file the host DOES
/// compile, and the wiring is held by source guards that each carry a positive
/// control.
final class ExternalSourceIntakeTests: XCTestCase {

    // MARK: - the decision, on the host

    /// A readable file is taken AS SUPPLIED. TruePad does not inspect it, score
    /// it, or form any view about whether it is random — it cannot, and claiming
    /// otherwise is the one thing this project must never do.
    func testAReadableFileIsAcceptedAsSupplied() {
        XCTAssertEqual(ExternalSourceIntake.decide(name: "dice.bin", bytes: 36_864),
                       .accept(name: "dice.bin", byteCount: 36_864))
    }

    /// A file that could not be read is a REFUSAL, not a silent no-op. The silent
    /// no-op is precisely what the defect looked like from the outside.
    func testAnUnreadableFileRefusesRatherThanDoingNothing() {
        let outcome = ExternalSourceIntake.decide(name: "locked.bin", bytes: nil)
        guard case .refuse(let message) = outcome else {
            return XCTFail("an unreadable file must refuse, got \(outcome)")
        }
        XCTAssertTrue(message.lowercased().contains("could not be read"))
        // And it must say that nothing happened, because nothing did.
        XCTAssertTrue(message.lowercased().contains("nothing was used"))
        XCTAssertTrue(message.lowercased().contains("no pad was created"))
    }

    /// SIZE IS NOT DECIDED HERE. A short file reads fine; it is `canCreate` that
    /// refuses it, exactly as before. Calling a readable file "unreadable" would
    /// be untrue, and it would send the operator to look for a file problem that
    /// does not exist.
    func testAShortButReadableFileIsNotCalledUnreadable() {
        XCTAssertEqual(ExternalSourceIntake.decide(name: "tiny.bin", bytes: 1),
                       .accept(name: "tiny.bin", byteCount: 1))
        XCTAssertEqual(ExternalSourceIntake.decide(name: "empty.bin", bytes: 0),
                       .accept(name: "empty.bin", byteCount: 0))
    }

    /// THE SIZE RULE IS UNCHANGED, and it is the partition's rule. A preset's
    /// required source length is still `2 * (E + 32 * N)`.
    func testTheSizeRuleThatGatesCreationIsTheUnchangedPartitionRule() throws {
        for size in PadSize.allCases {
            let required = try Partition.requiredSourceLength(capacity: size.bytes,
                                                              capacityRecords: size.records)
            XCTAssertEqual(required, 2 * (size.bytes + 32 * size.records))
        }
        // Small needs 36 864 bytes; one byte short is short.
        let small = try Partition.requiredSourceLength(capacity: PadSize.small.bytes,
                                                       capacityRecords: PadSize.small.records)
        XCTAssertEqual(small, 36_864)
    }

    /// NO FALLBACK TO THE DEVICE GENERATOR, ever. An operator who asked for their
    /// own material and whose file failed must not receive a quietly
    /// device-generated pad that reads NOT ELIGIBLE for a reason they did not
    /// choose.
    func testRefusalNeverMentionsOrImpliesFallingBackToTheDeviceGenerator() {
        guard case .refuse(let message) = ExternalSourceIntake.decide(name: "x", bytes: nil) else {
            return XCTFail("expected a refusal")
        }
        for forbidden in ["instead", "device", "generated for you", "we will"] {
            XCTAssertFalse(message.lowercased().contains(forbidden),
                           "the refusal hints at a fallback: \(forbidden)")
        }
    }

    // MARK: - the wiring, by source guard

    private func source(_ path: String) throws -> String {
        try String(contentsOf: XWingKATTests.repoRoot.appendingPathComponent(path), encoding: .utf8)
    }

    private func createScreen() throws -> String {
        let all = try source("ios/TruePadKit/Sources/TruePadUI/CeremonyViews.swift")
        guard let start = all.range(of: "public struct CreatePadView") else {
            throw XCTSkip("CreatePadView not found")
        }
        let rest = all[start.upperBound...]
        if let end = rest.range(of: "\n// MARK:") {
            return String(all[start.lowerBound..<end.lowerBound])
        }
        return String(all[start.lowerBound...])
    }

    /// THE DEFECT ITSELF: the create screen must actually present a picker.
    func testTheCreateScreenPresentsARealFileImporter() throws {
        let view = try createScreen()
        XCTAssertTrue(view.contains(".fileImporter(isPresented: $model.choosingFile"),
                      "the create screen has no file importer bound to its own model — "
                      + "\"Choose a file…\" would set a flag nothing observes")
        XCTAssertTrue(view.contains("model.acceptPickedFile("),
                      "the picker result must reach the model")
        XCTAssertTrue(view.contains("startAccessingSecurityScopedResource"),
                      "a picked file is outside the sandbox until opened under a security scope")
        XCTAssertTrue(view.contains("stopAccessingSecurityScopedResource"),
                      "the security scope must be released")

        // POSITIVE CONTROLS. Without these, a mis-sliced or empty string would
        // pass every assertion above, and a slice that ran past the create screen
        // would find OpenSealedView's importer and report success for the wrong
        // view — which is exactly the confusion that hid this defect.
        XCTAssertTrue(view.contains("struct CreatePadView"))
        XCTAssertGreaterThan(view.count, 1500, "the create-screen slice is implausibly short")
        XCTAssertFalse(view.contains("struct OpenSealedView"),
                       "the slice ran past the create screen, so its findings prove nothing")
    }

    /// The expert path is still selectable, and still declares what it is.
    func testTheExternalPathIsStillOfferedAndStillHonest() throws {
        let view = try createScreen()
        XCTAssertTrue(view.contains("Use external random material"))
        XCTAssertTrue(view.contains("CreatePadModel.Source.file"))
        XCTAssertTrue(view.contains("Choose a file…"))
        // The declaration-is-not-evidence sentence survives.
        XCTAssertTrue(view.contains("TruePad cannot check where it came from"))
        XCTAssertTrue(view.contains("a declaration is not evidence"))
    }

    /// Cancelling creates nothing and says nothing.
    func testCancellingThePickerIsNotTreatedAsARefusal() throws {
        let view = try createScreen()
        XCTAssertTrue(view.contains("case .failure:"))
        XCTAssertTrue(view.contains("Cancelling is not a refusal"),
                      "the cancel branch must stay explicitly inert")
    }

    /// The model applies the decision rather than re-deciding, and never falls
    /// back to the device generator on failure.
    func testTheModelAppliesTheDecisionAndNeverFallsBack() throws {
        let models = try source("ios/TruePadKit/Sources/TruePadUI/CeremonyModels.swift")
        XCTAssertTrue(models.contains("ExternalSourceIntake.decide(name: name, bytes: bytes?.count)"))
        XCTAssertTrue(models.contains("public func acceptPickedFile("))
        // On refusal it clears the choice; it must not set a device source.
        guard let fn = models.range(of: "public func acceptPickedFile("),
              let end = models.range(of: "\n    }", range: fn.upperBound..<models.endIndex) else {
            return XCTFail("acceptPickedFile not found in the shape this guard reads")
        }
        let body = String(models[fn.lowerBound..<end.upperBound])
        XCTAssertFalse(body.contains("deviceSourceNameWire"),
                       "the intake path must never reach for device material")
        XCTAssertFalse(body.contains("source = .device"),
                       "a failed file must never silently become a device-generated pad")
        // POSITIVE CONTROL: the slice really is the function.
        XCTAssertTrue(body.contains("chosenFileBytes"))
    }
}
