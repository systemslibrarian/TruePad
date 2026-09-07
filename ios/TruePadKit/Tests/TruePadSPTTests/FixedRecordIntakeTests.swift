import XCTest
@testable import TruePadUI
import TruePadCore

/// THE FIXED-RECORD DECISION, which is the only new thing the create screen can
/// get wrong.
///
/// A fixed record size is the operator's length-privacy control. Three ways it
/// could be wrong all matter:
///
///   · accepting a value the ENGINE will refuse, which turns a create into a
///     developer-worded failure after the operator has committed;
///   · silently ROUNDING a value to one that works, which tells the operator
///     something false about their own pad; and
///   · saying the option hides more than it does.
///
/// The first of those is not hypothetical. The Android edition VALIDATED the
/// typed size against the pad's encryption capacity alone, while its engine
/// refuses anything above MAX_CIPHERTEXT_BYTES — so on the Large preset it
/// accepted up to 4,194,304 and the engine refused above 1,048,576. The Browser
/// had the same shape. Both take the minimum now
/// (`FixedRecordIntake.ceiling`, `create-pair.ts`), and
/// `tests/fixed-record-parity.test.ts` holds the three editions together. Past
/// tense deliberately: this described a live sibling defect, and leaving it in
/// the present would make this file wrong about a product it does not test.
/// That exact case is pinned below.
final class FixedRecordIntakeTests: XCTestCase {

    private let large = 4_194_304      // the Large preset's encryption capacity
    private let engine = WcOneTime.maxCiphertextBytes  // 1_048_576

    // MARK: - the ceiling is the lower of the two limits

    func testTheCeilingIsTheLowerOfTheCapacityAndTheEngineLimit() {
        XCTAssertEqual(FixedRecordIntake.ceiling(encryptionCapacity: large, engineLimit: engine),
                       engine, "a huge pad is still bounded by what the engine will carry")
        XCTAssertEqual(FixedRecordIntake.ceiling(encryptionCapacity: 16_384, engineLimit: engine),
                       16_384, "a small pad is bounded by its own capacity")
        // POSITIVE CONTROL: the two limits really are different, so the min above
        // is choosing between two distinct numbers rather than returning the only
        // one there is.
        XCTAssertNotEqual(large, engine)
    }

    /// THE ANDROID DEFECT, pinned so iOS cannot acquire it.
    func testAValueTheEngineWouldRefuseIsRefusedByTheScreenFirst() {
        // 2,000,000 is a multiple of 16 and is under the Large preset's capacity,
        // so a capacity-only rule would accept it. The engine would not.
        XCTAssertEqual(2_000_000 % FixedRecordIntake.multipleOf, 0)
        XCTAssertLessThan(2_000_000, large)
        XCTAssertGreaterThan(2_000_000, engine)

        let r = FixedRecordIntake.readiness(fixed: true, typed: "2000000",
                                            encryptionCapacity: large, engineLimit: engine)
        XCTAssertEqual(r, .tooLarge(have: 2_000_000, limit: engine))
        XCTAssertFalse(r.isReady, "the screen must refuse what the engine would refuse")
        XCTAssertEqual(r.explanation,
                       "2000000 bytes is larger than this pad can carry. The largest message size "
                       + "for this pad is 1048576 bytes.")
    }

    // MARK: - the ordinary answers

    func testTheToggleOffMeansThereIsNothingToCheck() {
        // Even nonsense in the field is irrelevant while the option is off — the
        // value is not used, so it must not block creation.
        for typed in ["", "0", "banana", "7"] {
            let r = FixedRecordIntake.readiness(fixed: false, typed: typed,
                                                encryptionCapacity: large)
            XCTAssertEqual(r, .notFixed, "\(typed) blocked creation while fixed lengths were off")
            XCTAssertTrue(r.isReady)
            XCTAssertNil(r.explanation)
        }
    }

    func testTheDefaultIsUsableOnEveryShippedPreset() {
        for capacity in [16_384, 262_144, 4_194_304] {
            let r = FixedRecordIntake.readiness(fixed: true,
                                                typed: String(FixedRecordIntake.defaultBytes),
                                                encryptionCapacity: capacity)
            XCTAssertEqual(r, .ready(bytes: FixedRecordIntake.defaultBytes),
                           "the offered default must not be refused on a \(capacity)-byte pad")
        }
        XCTAssertEqual(FixedRecordIntake.defaultBytes, 256)
        XCTAssertEqual(FixedRecordIntake.defaultBytes % FixedRecordIntake.multipleOf, 0)
    }

    func testAnEmptyOrNonNumericFieldAsksForANumberRatherThanGuessing() {
        for typed in ["", "   ", "banana", "25.6", "-64", "1e3"] {
            let r = FixedRecordIntake.readiness(fixed: true, typed: typed,
                                                encryptionCapacity: large)
            XCTAssertEqual(r, .notANumber, "\(typed) was read as a number")
            XCTAssertFalse(r.isReady)
        }
    }

    func testSurroundingSpaceIsNotAReasonToRefuse() {
        XCTAssertEqual(FixedRecordIntake.readiness(fixed: true, typed: "  256 ",
                                                   encryptionCapacity: large),
                       .ready(bytes: 256))
    }

    func testTooSmallNamesTheFloor() {
        let r = FixedRecordIntake.readiness(fixed: true, typed: "16", encryptionCapacity: large)
        XCTAssertEqual(r, .tooSmall(have: 16, need: 32))
        XCTAssertEqual(r.explanation,
                       "16 bytes is too small. The smallest message size is 32 bytes.")
        // The floor itself is usable.
        XCTAssertEqual(FixedRecordIntake.readiness(fixed: true, typed: "32",
                                                   encryptionCapacity: large),
                       .ready(bytes: 32))
    }

    func testAValueLargerThanASMALLPadIsBoundedByThatPad() {
        // 16,384-byte pad: the capacity, not the engine limit, is what binds.
        let r = FixedRecordIntake.readiness(fixed: true, typed: "32768",
                                            encryptionCapacity: 16_384, engineLimit: engine)
        XCTAssertEqual(r, .tooLarge(have: 32_768, limit: 16_384))
    }

    // MARK: - nothing is rounded

    func testAValueThatIsNotAMultipleIsRefusedAndSaysSoRatherThanBeingRounded() {
        let r = FixedRecordIntake.readiness(fixed: true, typed: "100", encryptionCapacity: large)
        XCTAssertEqual(r, .notAMultiple(have: 100, of: 16))
        XCTAssertFalse(r.isReady)
        let why = r.explanation ?? ""
        XCTAssertTrue(why.contains("not a multiple of 16"))
        // It must say ROUNDING WILL NOT HAPPEN. An operator who typed 100 and got
        // a 112-byte record would have been told something false about their pad.
        XCTAssertTrue(why.contains("will not round"),
                      "the refusal does not promise that the number is left alone: \(why)")
        // And the neighbouring values it was NOT rounded to are the ones that work.
        XCTAssertEqual(FixedRecordIntake.readiness(fixed: true, typed: "96",
                                                   encryptionCapacity: large),
                       .ready(bytes: 96))
        XCTAssertEqual(FixedRecordIntake.readiness(fixed: true, typed: "112",
                                                   encryptionCapacity: large),
                       .ready(bytes: 112))
    }

    /// THE FIRST THING WRONG IS THE THING REPORTED. A number that is both far too
    /// large and not a multiple must send the operator to the size, not the step.
    func testTheReportedProblemIsTheOneWorthFixingFirst() {
        let r = FixedRecordIntake.readiness(fixed: true, typed: "4194300",
                                            encryptionCapacity: large, engineLimit: engine)
        XCTAssertEqual(4_194_300 % 16, 12, "the fixture must be a non-multiple, or this proves nothing")
        XCTAssertEqual(r, .tooLarge(have: 4_194_300, limit: engine),
                       "size is reported before the step, because the step is not the problem")
    }

    // MARK: - the claim

    /// Only the property the format actually provides.
    func testTheCostSentenceNamesWhatIsStillVisible() {
        let text = FixedRecordIntake.costAndLimit
        XCTAssertTrue(text.contains("exact length is hidden"),
                      "the sentence does not state the property fixed records provide")
        XCTAssertTrue(text.contains("spends the full size"),
                      "the sentence does not state the cost")
        XCTAssertTrue(text.contains("number of messages") && text.contains("timing"),
                      "the sentence does not name what remains visible, so it overclaims")
        // It must not promise metadata privacy in general.
        let lowered = text.lowercased()
        for overclaim in ["hides all", "completely hidden", "anonymous", "untraceable",
                         "no metadata", "cannot be seen"] {
            XCTAssertFalse(lowered.contains(overclaim),
                           "the sentence claims \(overclaim), which the format does not provide")
        }
    }

    // MARK: - the wiring

    /// A DECISION NOTHING CONSULTS IS NOT A DECISION. These three lines are the
    /// whole difference between a tested rule and a tested rule that the screen
    /// ignores.
    func testTheScreenAndTheEngineActuallyUseTheDecision() throws {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        let models = try String(
            contentsOf: repo.appendingPathComponent(
                "ios/TruePadKit/Sources/TruePadUI/CeremonyModels.swift"), encoding: .utf8)
        let views = try String(
            contentsOf: repo.appendingPathComponent(
                "ios/TruePadKit/Sources/TruePadUI/CeremonyViews.swift"), encoding: .utf8)

        // POSITIVE CONTROL: the files loaded and are the ones intended.
        XCTAssertTrue(models.contains("class CreatePadModel"))
        XCTAssertTrue(views.contains("struct CreatePadView"))

        XCTAssertTrue(models.contains("recordBytes: recordBytes"),
                      "the chosen record size never reaches the engine, so the control is inert")
        XCTAssertTrue(models.contains("guard recordReadiness.isReady else { return false }"),
                      "creation is not gated on the record size being usable")
        XCTAssertTrue(views.contains("FixedRecordIntake.costAndLimit"),
                      "the screen no longer states what fixed lengths do and do not hide")
        XCTAssertTrue(views.contains("model.recordReadiness.explanation"),
                      "the screen does not say why creation is blocked")
    }

    /// The two mobile editions must say the SAME thing about it.
    func testTheCostSentenceIsWordForWordTheAndroidOne() throws {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        let kt = try String(
            contentsOf: repo.appendingPathComponent(
                "android/app/src/main/kotlin/dev/systemslibrarian/truepad/app/ui/Screens.kt"),
            encoding: .utf8)
        // POSITIVE CONTROL: the Android screen really did load.
        XCTAssertTrue(kt.contains("Hide exact message lengths"),
                      "the Android create screen no longer offers this control")

        // Android splits the sentence across a Kotlin concatenation; rejoin it.
        let joined = kt.replacingOccurrences(of: "\" +\n                \"", with: "")
        XCTAssertTrue(joined.contains(FixedRecordIntake.costAndLimit),
                      "iOS and Android no longer say the same thing about what fixed lengths hide")
    }
}
