import XCTest
@testable import TruePadUI

/// SHARING A NEW PAD IS THE NEXT STEP, AND IT LOOKS LIKE ONE.
///
/// A pad nobody else has is a pad that cannot be used. This edition dismissed the
/// create sheet back to a list and said nothing at all about what to do next, and
/// the pad screen offered two equal-weight outlined buttons — so "save a copy of
/// the whole pad to a file" looked exactly as normal as sealing it to the other
/// person's receive code. Those are not equally normal.
final class SharingPresentationTests: XCTestCase {

    private func source(_ relative: String) throws -> String {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        // Swift string concatenations rejoined, so a sentence the compiler builds
        // from two literals is searched as the sentence a person will read.
        let raw = try String(contentsOf: repo.appendingPathComponent(relative), encoding: .utf8)
        return raw.replacingOccurrences(of: "\"\\s*\\+\\s*\"", with: "",
                                        options: .regularExpression)
    }

    private var padViews: String { (try? source("ios/TruePadKit/Sources/TruePadUI/PadViews.swift")) ?? "" }
    private var rootView: String { (try? source("ios/TruePadKit/Sources/TruePadUI/RootView.swift")) ?? "" }
    private var models: String { (try? source("ios/TruePadKit/Sources/TruePadUI/Models.swift")) ?? "" }
    private var ceremony: String { (try? source("ios/TruePadKit/Sources/TruePadUI/CeremonyViews.swift")) ?? "" }

    private let instruction = "Ask the other person to open TruePad and create a receive code"

    // MARK: immediately after creation

    /// The just-created prompt's own block, sliced out before anything is asserted
    /// about its wording.
    ///
    /// SCOPED, BECAUSE FILE-SCOPED SEARCHING MADE THIS TEST VACUOUS. Two of its
    /// assertions looked for `instruction` and "send that code to you" anywhere in
    /// PadViews.swift. Both strings ARE in the file — in the pad-detail Share
    /// section, a thousand lines below — and NEITHER is in the prompt, whose own
    /// wording is "ask them to open TruePad and create a receive code". So the two
    /// assertions named the prompt, passed on a different screen's copy, and had
    /// never once been satisfied by the thing they claimed to check. Deleting the
    /// prompt's entire explanatory sentence left all six tests green.
    private func justCreatedBlock() throws -> String {
        let start = try XCTUnwrap(padViews.range(of: "if model.justCreated != nil {"),
                                  "the just-created prompt is gone from PadListView")
        let rest = String(padViews[start.upperBound...])
        let end = try XCTUnwrap(rest.range(of: ".plainRow()"),
                                "the prompt block does not end where this guard expects")
        return String(rest[..<end.lowerBound])
    }

    func testTheListOffersSharingTheJustCreatedPad() throws {
        // POSITIVE CONTROL.
        XCTAssertTrue(padViews.contains("struct PadListView"))

        let prompt = try justCreatedBlock()
        // And the slice really is a slice: small, and not the whole file.
        XCTAssertGreaterThan(prompt.count, 200)
        XCTAssertLessThan(prompt.count, padViews.count / 4)

        XCTAssertTrue(prompt.contains("PrimaryButton(\"Share this pad\")"),
                      "there is no obvious way to share the pad that was just made")
        XCTAssertTrue(prompt.contains("create a receive code"),
                      "the prompt does not explain that the other person creates a receive code")
        XCTAssertTrue(prompt.contains("send that code to you"),
                      "the prompt does not say the code comes back to the sender")
        // CREATING A PAD MUST NOT FORCE AN IMMEDIATE HANDOFF.
        XCTAssertTrue(prompt.contains("SecondaryButton(\"Not now\")"),
                      "there is no way out of the prompt")
        XCTAssertTrue(prompt.contains("model.dismissCreated()"))
    }

    /// The pad-detail Share section is a DIFFERENT screen with its own wording,
    /// and this is what proves the slice above is doing real work: the string the
    /// old assertions were actually matching lives here, outside the prompt.
    func testThePadDetailShareSectionCarriesItsOwnInstruction() throws {
        XCTAssertTrue(padViews.contains(instruction),
                      "the pad screen no longer explains the receive-code route")
        XCTAssertFalse(try justCreatedBlock().contains(instruction),
                       "the two screens' wording has merged; the slice above no longer "
                        + "distinguishes them and this guard is measuring nothing")
    }

    /// The prompt must be about the pad that was actually made.
    func testTheCreateSheetReportsWhichPadItMade() {
        XCTAssertTrue(rootView.contains("CreatePadSheet(engine: engine) { pads.noteCreated($0) }"),
                      "the sheet no longer reports the pad it created")
        XCTAssertTrue(models.contains("public func openJustCreated()"),
                      "nothing opens the pad the prompt is about")
        XCTAssertTrue(models.contains("path = [id]"),
                      "the prompt does not navigate to the pad it named")
    }

    // MARK: on an existing pad

    func testThePadScreenLeadsWithTheSecureRoute() throws {
        // THE GATED BLOCK, walked by braces rather than counted in characters.
        // The section is now inside `if model.mayHandOff { ... }`, which is the
        // region these assertions are actually about, and a fixed window over it
        // would drift the moment a sentence changed length.
        let block = try XCTUnwrap(
            PostureGuardTests.blockAfter("if model.mayHandOff {", in: padViews),
            "the pad screen's share section is no longer gated on handoff eligibility")
        XCTAssertTrue(block.hasSuffix("}"))

        XCTAssertTrue(block.contains("PrimaryButton(\"Send securely to a receive code\")"),
                      "the secure route is not the primary action")
        XCTAssertTrue(block.contains("model.beginSealedTransfer()"),
                      "the primary action does not enter the sealed-transfer flow")
        XCTAssertTrue(block.contains(instruction),
                      "the pad screen does not explain the receive code")
        // The file route survives, demoted — not promoted, not deleted.
        XCTAssertTrue(block.contains("SecondaryButton(\"Save the pad to a file…\")"),
                      "the file route was deleted rather than demoted")
        XCTAssertFalse(block.contains("PrimaryButton(\"Save the pad to a file…\")"),
                       "saving a raw pad file is a primary action again")
    }

    /// A pad that cannot be handed over must not advertise a fresh handoff.
    func testAPadThatCannotBeHandedOverDoesNotOfferOne() {
        XCTAssertTrue(padViews.contains("if model.mayHandOff {"),
                      "the share section no longer asks whether a handoff is possible")
        XCTAssertTrue(padViews.contains("model.mayReshareSealed"),
                      "the re-share path is gone, so a stranded sealed package is unreachable")
        XCTAssertTrue(padViews.contains("Hand over the same sealed file…"),
                      "re-share no longer presents itself as the SAME package")
    }

    // MARK: the receiving side

    func testTheReceiveScreenTellsTheRecipientWhatToDoWithTheCode() {
        XCTAssertTrue(ceremony.contains("PrimaryButton(\"Copy code\")"))
        XCTAssertTrue(ceremony.contains("SecondaryButton(\"Share code\")"))
        XCTAssertTrue(ceremony.contains("PublicTransportPasteboard.copy(material)"),
                      "Copy code does not go through the audited public-transport boundary")
    }

    /// The sharing prompt must not be able to export a raw pad by accident.
    func testTheSharePromptCannotTriggerARawExport() throws {
        // THE WHOLE BLOCK, WALKED BY BRACES. `prefix(900)` over a block of 692
        // characters left 208 characters of margin — the same shape, and roughly
        // the same margin, as the 79-character case this suite already had to
        // fix. A NEGATIVE assertion inside a fixed window is the worst version of
        // it: ordinary prose added to the prompt pushes the thing being banned
        // out of the window, and the guard reports success for having stopped
        // looking. See `PostureGuardTests.blockAfter`.
        let block = try XCTUnwrap(
            PostureGuardTests.blockAfter("if model.justCreated != nil", in: padViews),
            "the prompt is gone")
        XCTAssertTrue(block.hasSuffix("}"))
        XCTAssertTrue(block.contains("Share this pad"),
                      "precondition: this is the block that offers the share")
        XCTAssertFalse(block.contains("exportPad"),
                       "the post-creation share prompt can export a raw pad file")
    }
}
