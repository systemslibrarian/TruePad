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

    /// SIZE IS NOT DECIDED BY `decide`. A short file reads fine, and calling it
    /// "unreadable" would be untrue — it would send the operator to look for a
    /// file problem that does not exist. The length rule lives in `readiness`,
    /// which is what `canCreate` now consults; this comment used to name
    /// `canCreate` as the place that compares lengths, and that stopped being
    /// true when the screen gained its explanation.
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

    /// Source with `//` and `///` comments removed.
    ///
    /// NEEDED, and the need was found the hard way: the first version of the
    /// ownership guard below searched the raw file for the construction it
    /// forbids, and failed — because the DOC COMMENT explaining the defect quotes
    /// that construction verbatim. A guard that cannot tell code from prose about
    /// code is not a guard.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> Substring in
                guard let r = line.range(of: "//") else { return line }
                return line[line.startIndex..<r.lowerBound]
            }
            .joined(separator: "\n")
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

    // MARK: - the model must outlive a rebuild

    /// OWNERSHIP, NOT STYLE. `CreatePadModel` holds the operator's chosen source
    /// and, once the picker worked, the chosen BYTES. If SwiftUI does not own it,
    /// every scene-phase transition rebuilds it — and a fresh model comes back
    /// with `source == .device`, silently replacing supplied material with the
    /// device generator.
    func testTheCreateModelIsOwnedBySwiftUIAndNotBuiltInTheSheetClosure() throws {
        let root = code(try source("ios/TruePadKit/Sources/TruePadUI/RootView.swift"))

        // The exact construction that caused it must not come back — checked
        // against CODE, because the comment above it quotes the old line.
        XCTAssertFalse(root.contains("CreatePadView(model: CreatePadModel(engine: engine))"),
                       "the create model is being built inside the sheet closure again — a "
                       + "scene-phase change will discard the operator's chosen source and bytes")

        // It must be owned at a StateObject boundary.
        XCTAssertTrue(root.contains("struct CreatePadSheet"))
        XCTAssertTrue(root.contains("@StateObject private var model: CreatePadModel"))
        XCTAssertTrue(root.contains("_model = StateObject(wrappedValue: CreatePadModel(engine: engine))"))
        XCTAssertTrue(root.contains("CreatePadSheet(engine: engine)"),
                      "the sheet must present the owning view, not CreatePadView directly")

        // POSITIVE CONTROLS. Without these a renamed file or an empty read would
        // pass all four absences above.
        XCTAssertTrue(root.contains("struct TruePadRootView"))
        XCTAssertTrue(root.contains("scenePhase"),
                      "the body still depends on scenePhase — which is exactly why ownership matters")
        XCTAssertGreaterThan(root.count, 2000)
    }

    /// AND THE OTHER TWO MODELS WERE ALWAYS OWNED. Stated so the asymmetry that
    /// hid this cannot quietly return in the other direction.
    func testEveryLongLivedRootModelIsOwnedTheSameWay() throws {
        let root = try source("ios/TruePadKit/Sources/TruePadUI/RootView.swift")
        for owned in ["@StateObject private var pads: PadListModel",
                      "@StateObject private var receive: ReceiveRequestModel",
                      "@StateObject private var model: CreatePadModel"] {
            XCTAssertTrue(root.contains(owned), "not owned by SwiftUI: \(owned)")
        }
    }

    /// NOTHING MAY SET THE SOURCE BACK TO THE DEVICE GENERATOR. The only place
    /// `source` is assigned `.device` is its declaration; every other assignment
    /// would be a silent substitution of material the operator did not choose.
    func testNothingSilentlyResetsTheSourceToTheDeviceGenerator() throws {
        let models = code(try source("ios/TruePadKit/Sources/TruePadUI/CeremonyModels.swift"))
        let views = code(try source("ios/TruePadKit/Sources/TruePadUI/CeremonyViews.swift"))

        // The DECLARED default is the only place the device generator is chosen
        // for the operator. Note the capital S: `Source = .device` is the
        // declaration; a lowercase `source = .device` would be an ASSIGNMENT, and
        // there must be none anywhere.
        XCTAssertTrue(models.contains("public var source: Source = .device"),
                      "the declared default is missing")
        for file in [models, views] {
            XCTAssertFalse(file.contains("source = .device"),
                           "something assigns the source back to the device generator — that is a "
                           + "silent substitution of material the operator did not choose")
        }

        // POSITIVE CONTROL: the stripper did not hand back an empty string, and
        // the files really are the ones intended.
        XCTAssertTrue(models.contains("class CreatePadModel"))
        XCTAssertTrue(views.contains("struct CreatePadView"))

        // The refusal path clears the choice; it must not choose for the operator.
        guard let fn = models.range(of: "public func acceptPickedFile("),
              let end = models.range(of: "\n    }", range: fn.upperBound..<models.endIndex) else {
            return XCTFail("acceptPickedFile not found")
        }
        XCTAssertFalse(String(models[fn.lowerBound..<end.upperBound]).contains(".device"))
    }

    // MARK: - the operator's declaration, not the app's

    /// PARITY WITH THE BROWSER, WHICH ASKS. The Browser's create flow puts an
    /// "Where did these bytes come from?" field on screen and records what the
    /// operator typed. iOS used to write that sentence ITSELF — every external
    /// pad carried the same app-authored declaration, so the manifest read as
    /// though a person had made a statement that no person had made. That is a
    /// STRONGER provenance claim than the Browser makes on the same evidence,
    /// which is the wrong direction for a claim to drift.
    func testTheExternalDeclarationIsAskedForRatherThanWrittenByTheApp() throws {
        let models = code(try source("ios/TruePadKit/Sources/TruePadUI/CeremonyModels.swift"))
        let views = code(try source("ios/TruePadKit/Sources/TruePadUI/CeremonyViews.swift"))

        XCTAssertTrue(models.contains("@Published public var declaredOrigin"),
                      "the operator has nowhere to put their declaration")
        XCTAssertTrue(views.contains("$model.declaredOrigin"),
                      "the create screen never asks where the bytes came from, so whatever is "
                      + "recorded was not stated by the operator")

        // The old hardcoded sentence, and the shape of any replacement for it:
        // a string literal handed to `declaredOrigin:` on the FILE branch.
        XCTAssertFalse(models.contains("declaredOrigin: \"declared by operator"),
                       "the app is still writing the operator's declaration for them")

        // POSITIVE CONTROL: the device branch's declaration IS app-authored, and
        // must stay that way — nobody declares the device generator into being
        // something else. If this stops being found, the guard above is reading
        // the wrong file and its silence means nothing.
        XCTAssertTrue(models.contains("declaredOrigin: \"this device's random generator\""),
                      "positive control failed: the device declaration is not where expected")
    }

    /// The two conditions must be ONE authority. A button whose enablement is
    /// computed separately from the text explaining it is a button that will
    /// eventually sit grey under a sentence saying everything is ready.
    func testCreationEnablementDefersToTheSameDecisionTheScreenExplains() throws {
        let models = code(try source("ios/TruePadKit/Sources/TruePadUI/CeremonyModels.swift"))
        XCTAssertTrue(models.contains("case .file: return readiness == .ready"),
                      "canCreate re-derives its own conditions instead of using readiness")
        XCTAssertTrue(models.contains("ExternalSourceIntake.readiness(have:"),
                      "positive control failed: the model does not consult the shared decision")
    }

    // MARK: - a short file is explained, never repaired

    func testAFileTooShortForThePadSaysSoInsteadOfGoingQuiet() throws {
        let r = ExternalSourceIntake.readiness(have: 100, need: 16_384, declaration: "dice")
        XCTAssertEqual(r, .tooShort(have: 100, need: 16_384))
        let why = try XCTUnwrap(r.explanation)
        XCTAssertTrue(why.contains("100 bytes and this pad needs 16384"),
                      "the explanation does not state both numbers, so it cannot be acted on")
        // IT MUST RULE OUT THE REPAIRS, not merely decline to perform them. An
        // operator who is not told why will reach for the obvious fix.
        for forbidden in ["stretch", "repeat", "pad or derive"] {
            XCTAssertTrue(why.contains(forbidden),
                          "the explanation does not rule out \(forbidden)")
        }
        XCTAssertFalse(ExternalSourceIntake.readiness(have: 100, need: 16_384,
                                                      declaration: "dice") == .ready)
    }

    func testTheOrderOfExplanationsFollowsWhatTheOperatorCanActOn() {
        XCTAssertEqual(ExternalSourceIntake.readiness(have: nil, need: 64, declaration: ""),
                       .needsFile)
        // Length is checked BEFORE the declaration: asking someone to describe
        // the origin of a file that cannot be used is wasted work.
        XCTAssertEqual(ExternalSourceIntake.readiness(have: 10, need: 64, declaration: ""),
                       .tooShort(have: 10, need: 64))
        XCTAssertEqual(ExternalSourceIntake.readiness(have: 64, need: 64, declaration: "   "),
                       .needsDeclaration,
                       "whitespace was accepted as a declaration")
        XCTAssertEqual(ExternalSourceIntake.readiness(have: 64, need: 64, declaration: "dice"),
                       .ready)
        XCTAssertNil(ExternalSourceIntake.Readiness.ready.explanation)
    }

    /// The declaration is recorded VERBATIM. Nothing supplements a short answer,
    /// and nothing decorates it into sounding more like evidence than it is.
    func testTheDeclarationIsRecordedAsWrittenAndNotEmbellished() throws {
        let models = code(try source("ios/TruePadKit/Sources/TruePadUI/CeremonyModels.swift"))
        guard let fn = models.range(of: "public func create()"),
              let end = models.range(of: "\n    }", range: fn.upperBound..<models.endIndex) else {
            return XCTFail("create() not found")
        }
        let body = String(models[fn.lowerBound..<end.upperBound])
        XCTAssertTrue(body.contains("declaredOrigin\n") || body.contains("declaredOrigin\r\n")
                      || body.contains("declaredOrigin "),
                      "positive control failed: create() no longer mentions declaredOrigin")
        // Trimming is the ONLY permitted transformation on the file branch.
        for smell in ["declaredOrigin +", "+ declaredOrigin", "declaredOrigin.isEmpty ?"] {
            XCTAssertFalse(body.contains(smell),
                           "create() alters the operator's words (\(smell))")
        }
    }

    /// AND THE SCREEN MUST NOT OVERSTATE IT EITHER. It is a declaration; TruePad
    /// cannot check it. The field's own explanation has to say so, because that
    /// is the only place the operator meets the claim.
    func testTheScreenSaysTheDeclarationIsNotAMeasurement() throws {
        let why = ExternalSourceIntake.Readiness.needsDeclaration.explanation
        XCTAssertNotNil(why)
        XCTAssertTrue(why?.contains("cannot check it") ?? false)
        XCTAssertTrue(why?.contains("not a measurement") ?? false)
    }
}
