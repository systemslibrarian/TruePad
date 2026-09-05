import XCTest
@testable import TruePadUI

/// THE CREATE SCREEN'S PRESENTATION DECISIONS, PINNED.
///
/// The operator's finding was specific: making an ordinary pad on the iPhone was
/// harder than in the browser, the first thing the normal path said was an orange
/// "This pad will read NOT ELIGIBLE", and raw byte counts were on the surface.
/// Every fix here is presentation — the engine receives the same two integers it
/// always did, and the evaluator's returned value is untouched.
///
/// Two kinds of test live here. The values and the wording are host-testable
/// because they live in Presentation.swift. The view and model behaviour is not:
/// CeremonyModels.swift and CeremonyViews.swift are `#if os(iOS)`, so `swift
/// test` on a Mac never compiles them. Those decisions are guarded by reading the
/// source, and every such guard carries a POSITIVE CONTROL — a static check that
/// cannot fail is not a check.
final class CreateFlowUxTests: XCTestCase {

    // MARK: - the sizes a normal operator chooses between

    /// The three presets, pinned by value.
    func testTheThreePresetsArePinned() {
        XCTAssertEqual(PadSize.small.bytes, 16_384)
        XCTAssertEqual(PadSize.small.records, 64)
        XCTAssertEqual(PadSize.medium.bytes, 262_144)
        XCTAssertEqual(PadSize.medium.records, 512)
        XCTAssertEqual(PadSize.large.bytes, 4_194_304)
        XCTAssertEqual(PadSize.large.records, 4096)
        XCTAssertEqual(PadSize.allCases.count, 3)
    }

    /// AND THEY MATCH THE BROWSER EDITION, read out of its actual source.
    ///
    /// A person who used TruePad in a browser and then on a phone must be offered
    /// the same pads. The two editions share no build, so the only thing that can
    /// keep them honest is a test that reads the other one.
    func testThePresetsMatchTheBrowserEditionExactly() throws {
        let url = XWingKATTests.repoRoot.appendingPathComponent("src/browser/ui/create-pair.ts")
        let text = try String(contentsOf: url, encoding: .utf8)

        for size in PadSize.allCases {
            // { key: "small", title: "Small", blurb: "...", e: 16384, n: 64 }
            let pattern = "key:\\s*\"\(size.rawValue)\"[^}]*?e:\\s*(\\d+)[^}]*?n:\\s*(\\d+)"
            let re = try NSRegularExpression(pattern: pattern)
            let range = NSRange(text.startIndex..., in: text)
            guard let m = re.firstMatch(in: text, range: range),
                  let eRange = Range(m.range(at: 1), in: text),
                  let nRange = Range(m.range(at: 2), in: text) else {
                return XCTFail("the browser no longer declares a \(size.rawValue) preset in the shape this test reads")
            }
            XCTAssertEqual(Int(text[eRange]), size.bytes,
                           "\(size.rawValue): encryption bytes diverged from the Browser Edition")
            XCTAssertEqual(Int(text[nRange]), size.records,
                           "\(size.rawValue): record count diverged from the Browser Edition")
        }
    }

    /// The Browser opens on Medium; so does this.
    func testTheDefaultSizeIsMedium() {
        XCTAssertEqual(PadSize.default, .medium)
    }

    /// A preset is two integers, and `matching` is how the screen knows which row
    /// to tick. Numbers the operator typed themselves match no preset — that is
    /// what makes the size section able to say "Custom" truthfully.
    func testMatchingIdentifiesPresetsAndRefusesCustomNumbers() {
        for size in PadSize.allCases {
            XCTAssertEqual(PadSize.matching(bytes: size.bytes, records: size.records), size)
        }
        XCTAssertNil(PadSize.matching(bytes: 4096, records: 64))
        XCTAssertNil(PadSize.matching(bytes: PadSize.small.bytes, records: PadSize.large.records),
                     "half a preset is not a preset")
    }

    /// The cap is stated as a cap, and it is the record count — the hard ceiling
    /// on messages in one direction — not a rounded promise.
    func testTheCapacityLineStatesTheRecordCeiling() {
        XCTAssertEqual(PadSize.small.capacityLine, "Up to 64 messages each way.")
        XCTAssertEqual(PadSize.large.capacityLine, "Up to 4096 messages each way.")
        for size in PadSize.allCases {
            XCTAssertTrue(size.capacityLine.contains("\(size.records)"))
        }
    }

    // MARK: - what the wording is allowed to say

    /// The calm sentences are calm, and the full claim is still the full claim.
    func testTheDeviceClaimKeepsEveryQualifierItHadBefore() {
        let detail = SourceClaimText.deviceDetail
        for required in ["CSPRNG", "computational", "platform assumptions",
                         "does not call this physically proven randomness",
                         "information-theoretic"] {
            XCTAssertTrue(detail.contains(required),
                          "the device claim dropped \"\(required)\" — that is a weakened claim, not a friendlier one")
        }
        // The surface wording must be accurate but must NOT be the verdict.
        XCTAssertFalse(SourceClaimText.deviceHeadline.contains("NOT ELIGIBLE"))
        XCTAssertFalse(SourceClaimText.deviceSupporting.contains("NOT ELIGIBLE"))
        // And it must not overclaim in the other direction either.
        for banned in ["perfect", "unbreakable", "physically proven", "verified random"] {
            XCTAssertFalse(SourceClaimText.deviceHeadline.lowercased().contains(banned))
            XCTAssertFalse(SourceClaimText.deviceSupporting.lowercased().contains(banned))
        }
    }

    /// The classification is explained, not renamed, and what it does NOT mean is
    /// said out loud — that was the operator's actual misreading.
    func testTheVerdictIsExplainedRatherThanSoftened() {
        XCTAssertTrue(SourceClaimText.notEligibleMeaning.lowercased().contains("information-theoretic"))
        XCTAssertTrue(SourceClaimText.notEligibleReason.lowercased().contains("random generator"))
        let denials = SourceClaimText.notEligibleDoesNotMean.lowercased()
        for property in ["encryption is off", "reuse protection", "one-time-pad", "malformed"] {
            XCTAssertTrue(denials.contains(property),
                          "the explanation no longer says NOT ELIGIBLE does not mean \"\(property)\"")
        }
    }

    // MARK: - source guards over the iOS-only files

    private func source(_ name: String) throws -> String {
        let url = XWingKATTests.repoRoot
            .appendingPathComponent("ios/TruePadKit/Sources/TruePadUI/\(name)")
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// Just the create screen, not the whole file. CeremonyViews.swift also holds
    /// the sealed-transfer screens, and one of those legitimately draws an orange
    /// warning — the comparison words failing to render is an ACTUAL refusal, and
    /// §8's rule is that dramatic styling is for refusals and destructive actions.
    /// A guard that could not tell the two apart would force that warning to be
    /// toned down, which is the opposite of what this pass is for.
    private func createScreenSource() throws -> String {
        let all = try source("CeremonyViews.swift")
        guard let start = all.range(of: "public struct CreatePadView") else {
            throw XCTSkip("CreatePadView not found")
        }
        let rest = all[start.upperBound...]
        // The create screen ends where the next top-level section begins.
        if let end = rest.range(of: "\n// MARK:") {
            return String(all[start.lowerBound..<end.lowerBound])
        }
        return String(all[start.lowerBound...])
    }

    /// THE NORMAL PATH IS THE DEFAULT PATH. It used to open on `.file`, so a new
    /// operator met the expert ceremony before they could make an ordinary pad.
    func testTheModelDefaultsToDeviceGenerationAndAPreset() throws {
        let models = try source("CeremonyModels.swift")
        XCTAssertTrue(models.contains("public var source: Source = .device"),
                      "create must open on the device generator, not the file ceremony")
        XCTAssertFalse(models.contains("public var source: Source = .file"))
        XCTAssertTrue(models.contains("encryptionBytes = PadSize.default.bytes"))
        XCTAssertTrue(models.contains("authRecords = PadSize.default.records"))

        // POSITIVE CONTROL: the strings these assertions look for are the ones
        // the file actually uses, so a rename cannot silently pass them.
        XCTAssertTrue(models.contains("public var source: Source"),
                      "the property this test guards no longer exists under that name")
    }

    /// THE PRIMARY FLOW NO LONGER SHOUTS THE VERDICT. The evaluator still returns
    /// it and the screen still explains it — inside "Security details", not as a
    /// standalone orange warning before the operator has chosen anything.
    func testThePrimaryCreateFlowDoesNotLeadWithTheVerdict() throws {
        let views = try createScreenSource()
        XCTAssertFalse(views.contains("This pad will read NOT ELIGIBLE"),
                       "the alarming standalone label is back in the create flow")
        XCTAssertFalse(views.contains("foregroundStyle(.orange)"),
                       "the create flow is styling an ordinary source choice as a warning")
        XCTAssertTrue(views.contains("DisclosureGroup(\"Security details\")"),
                      "the explanation must still be reachable")

        // POSITIVE CONTROL: this really is the create screen and the slice really
        // has content, so the two absences above are meaningful rather than a
        // mis-sliced empty string silently passing.
        XCTAssertTrue(views.contains("struct CreatePadView"))
        XCTAssertTrue(views.contains("Create pad"))
        XCTAssertGreaterThan(views.count, 1500, "the create-screen slice is implausibly short")
        // And the slice must NOT have swallowed the rest of the file — if it had,
        // the WordGrid refusal warning would be inside it.
        XCTAssertFalse(views.contains("struct WordGrid"),
                       "the slice ran past the create screen, so its absences prove nothing")
    }

    /// The expert ceremony is MOVED, not deleted, and its refusals are intact.
    func testTheExternalCeremonyRemainsReachableAndUnsoftened() throws {
        let views = try source("CeremonyViews.swift")
        XCTAssertTrue(views.contains("DisclosureGroup(\"Advanced\")"))
        XCTAssertTrue(views.contains("Use external random material"))
        XCTAssertTrue(views.contains("Self.fileSourceNote"))
        XCTAssertTrue(views.contains("CreatePadModel.Source.file"),
                      "the file path must still be selectable")
        // The declaration-is-not-evidence sentence survives verbatim.
        XCTAssertTrue(views.contains("TruePad cannot check where it came from"))
        XCTAssertTrue(views.contains("a declaration is not evidence"))
    }

    /// The raw capacity controls still exist, still reach the same two engine
    /// inputs, and are no longer the first thing on the screen.
    func testRawCapacityControlsLiveUnderAdvanced() throws {
        let views = try source("CeremonyViews.swift")
        for control in ["Message bytes:", "Messages:", "Material needed"] {
            XCTAssertTrue(views.contains(control), "\(control) was deleted rather than moved")
        }
        // Each raw control must appear AFTER the Advanced disclosure opens.
        guard let advanced = views.range(of: "DisclosureGroup(\"Advanced\")") else {
            return XCTFail("no Advanced disclosure")
        }
        for control in ["Message bytes:", "Messages:", "Material needed"] {
            guard let at = views.range(of: control) else { continue }
            XCTAssertTrue(at.lowerBound > advanced.lowerBound,
                          "\(control) is still outside Advanced")
        }
    }

    /// THE ENGINE'S INPUTS ARE UNCHANGED. A preset writes the same two integers a
    /// stepper writes, and the frozen wire name for the device source is
    /// untouched — it is what the evaluator matches to classify the source.
    func testPresetsDoNotChangeWhatTheEngineIsHanded() throws {
        let models = try source("CeremonyModels.swift")
        XCTAssertTrue(models.contains("encryptionBytes = size.bytes"))
        XCTAssertTrue(models.contains("authRecords = size.records"))
        XCTAssertTrue(models.contains("engine.gen(label: label, sources: sources,"),
                      "gen must still be called with the same arguments")
        XCTAssertTrue(models.contains("encryptionBytes: encryptionBytes, authRecords: authRecords"))
        XCTAssertTrue(models.contains("SourceInput(name: deviceSourceNameWire"),
                      "the frozen device-source wire name must not be renamed by a UX pass")
    }
}
