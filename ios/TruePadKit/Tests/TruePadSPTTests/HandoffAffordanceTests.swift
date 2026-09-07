import Foundation
@testable import TruePadUI
import XCTest

/// AN AFFORDANCE IS A CLAIM. A button that offers to hand a pad over says the pad
/// can still be handed over, and TruePad must not say that from no evidence.
///
/// `Models.swift`, `PadViews.swift` and `CeremonyViews.swift` are `#if os(iOS)`,
/// so nothing in them can be constructed or driven on the machine that runs
/// `swift test`. These read the sources. That is weaker than exercising the code
/// and it is what is available; each assertion below is paired with a positive
/// control so the file cannot pass by finding nothing, and each ABSENCE assertion
/// names the exact text whose return is the regression.
///
/// The behaviour that CAN be exercised is, and is exercised elsewhere:
/// `SealedRequestBindingTests` drives the real engine for the request-binding half
/// of this, including a mutation that puts the old answer back.
final class HandoffAffordanceTests: XCTestCase {

    private func source(_ name: String) throws -> String {
        // Sources/TruePadUI, relative to this test file — the layout the rest of
        // the source-reading guards in this suite use.
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()          // TruePadSPTTests
            .deletingLastPathComponent()          // Tests
            .deletingLastPathComponent()          // TruePadKit
            .appendingPathComponent("Sources/TruePadUI/\(name)")
        return try String(contentsOf: url, encoding: .utf8)
    }

    private var models = ""
    private var padViews = ""
    private var ceremonyViews = ""
    private var messageViews = ""

    override func setUpWithError() throws {
        models = try source("Models.swift")
        padViews = try source("PadViews.swift")
        ceremonyViews = try source("CeremonyViews.swift")
        messageViews = try source("MessageViews.swift")
    }

    func testTheGuardReadTheFilesItThinksItRead() {
        // POSITIVE CONTROL for everything below. Every `XCTAssertFalse(contains:)`
        // in this file passes against an empty string.
        XCTAssertGreaterThan(models.count, 5_000)
        XCTAssertGreaterThan(padViews.count, 5_000)
        XCTAssertGreaterThan(ceremonyViews.count, 5_000)
        XCTAssertGreaterThan(messageViews.count, 3_000)
        XCTAssertTrue(models.contains("public final class PadDetailModel"))
        XCTAssertTrue(models.contains("public final class PadListModel"))
        XCTAssertTrue(padViews.contains("if model.mayHandOff {"))
        XCTAssertTrue(ceremonyViews.contains("model.isReshare"))
    }

    // MARK: - unknown is not permission

    func testMayHandOffDefaultsClosed() {
        // It was `= true`, the only fail-open flag of the three, and `reload()`'s
        // one throwing statement sits before every assignment to it — so a pad
        // whose handoff state was never read offered both routes.
        XCTAssertTrue(models.contains("@Published public private(set) var mayHandOff = false"),
                      "mayHandOff must default to false: unknown is not permission")
        XCTAssertFalse(models.contains("var mayHandOff = true"))
        XCTAssertTrue(models.contains("@Published public private(set) var mayReshareSealed = false"))
    }

    func testAFailedReloadResetsEveryHandoffFlag() throws {
        // The `catch` used to reset nothing, so the alert appeared OVER a screen
        // still advertising the act the refusal had just blocked.
        // SLICED TO THE CLASS FIRST. `models` holds two `reload()` methods and
        // `PadListModel`'s comes first, so an unanchored search checked the wrong
        // one — which is the same file-scoped-search defect this suite found in
        // `SharingPresentationTests`.
        let cls = try XCTUnwrap(models.range(of: "public final class PadDetailModel"))
        let detail = String(models[cls.upperBound...])
        let body = try XCTUnwrap(detail.range(of: "public func reload() {"))
        let afterReload = String(detail[body.upperBound...])
        let catchBlock = try XCTUnwrap(afterReload.range(of: "} catch {"))
        let tail = String(afterReload[catchBlock.upperBound...].prefix(900))
        for reset in ["mayHandOff = false", "mayReshareSealed = false",
                      "handOffRefusal = Self.handoffStateUnknown"] {
            XCTAssertTrue(tail.contains(reset), "reload()'s catch does not reset \(reset)")
        }
    }

    func testTheRefusalFallbackClaimsNothingItCannotSupport() {
        // "This pad has already been handed over" is a statement about the PAD.
        // With the flag failing closed it is exactly what a pad whose state could
        // not be read would have said about itself.
        XCTAssertFalse(padViews.contains("\"This pad has already been handed over.\""),
                       "the fallback asserts a handoff that may never have happened")
        XCTAssertTrue(padViews.contains("PadDetailModel.handoffStateUnknown"))
        XCTAssertTrue(models.contains("could not read this pad's handoff state"))
    }

    // MARK: - the prompt does not outlive its pad

    func testThePostCreationPromptIsRecheckedAgainstDurableState() {
        // `justCreated` was a remembered id cleared only by its own two buttons,
        // so destroying the pad left "Pad created — Share this pad" above the row
        // the list had just disabled, and the prompt's button wrote the id
        // straight into the navigation path, bypassing that guard.
        XCTAssertTrue(models.contains("private func stillOfferable(_ pairId: String) -> Bool"))
        XCTAssertTrue(models.contains("if let id = justCreated, !stillOfferable(id) { justCreated = nil }"),
                      "reload() no longer re-checks the prompt against the pads that exist")
        XCTAssertTrue(models.contains("guard let id = justCreated, stillOfferable(id) else"),
                      "openJustCreated() no longer re-checks at the moment of action")
        // Existence AND eligibility, not just existence.
        XCTAssertTrue(models.contains("engine.handoffState(pairId: pairId)"))
        XCTAssertTrue(models.contains("case .physical, .sealed, .unreadableSpent:"))
    }

    // MARK: - "this request" is a claim about a request

    func testTheSealScreenNamesAllThreeStates() throws {
        // Sealed-to-this-request, sealed-to-a-different-request, and not sealed.
        // The middle one used to fall into the third, which promises "A sealed
        // transfer sends the WHOLE pad" to an operator whose next tap can only
        // produce a refusal.
        XCTAssertTrue(ceremonyViews.contains("if model.isSealedToAnotherRequest {"))
        XCTAssertTrue(ceremonyViews.contains("already been sealed to a DIFFERENT receive"))

        // AND IT IS SAID BEFORE THE TWELVE WORDS, not after. It first shipped
        // inside `if model.confirmed`, so the operator only learned the seal was
        // impossible after reading twelve words aloud to the other person and
        // writing a durable confirmation record — the exact cost the check exists
        // to avoid. Position is the property, so position is what is asserted.
        let review = try XCTUnwrap(ceremonyViews.range(of: "if model.review != nil {"))
        let words = try XCTUnwrap(ceremonyViews.range(of: "Compare these twelve words"))
        let warning = try XCTUnwrap(ceremonyViews.range(of: "if model.isSealedToAnotherRequest {"))
        XCTAssertTrue(warning.lowerBound > review.lowerBound,
                      "the warning is drawn before the request has been reviewed")
        XCTAssertTrue(warning.lowerBound < words.lowerBound,
                      "the warning is drawn after the twelve words the operator must read aloud")

        // And the declaration itself is withheld, so the words are never declared
        // matched for a request that cannot be sealed to.
        XCTAssertTrue(ceremonyViews.contains("|| model.isSealedToAnotherRequest)"),
                      "the operator can still declare the words matched for a request the engine "
                      + "is going to refuse")
    }

    func testIsReshareComparesTheRequestAndNotMerelyThePad() throws {
        let ceremonyModels = try source("CeremonyModels.swift")
        XCTAssertTrue(ceremonyModels.contains("engine.sptSealedToRequest(pairId: pairId,"),
                      "isReshare is back to asking a pad-level question")
        XCTAssertFalse(
            ceremonyModels.contains("""
            public var isReshare: Bool {
                if case .sealed = engine.handoffState(pairId: pairId) { return true }
            """),
            "isReshare answers from a type that cannot carry request identity")
    }

    // MARK: - one role authority

    func testNeitherMessageScreenOffersARolePicker() {
        // A picker is a SECOND role authority beside the pad's origin, which is
        // the architecture the cross-copy reuse fix exists to prevent. It also
        // stood one line under a prompt saying a picked role "would be a guess
        // wearing a different name".
        for gone in ["Picker(\"Send as\"", "Picker(\"Open as\"", "selection: $model.role"] {
            XCTAssertFalse(messageViews.contains(gone), "a role control is back: \(gone)")
        }
        // The PROMPT stays: refusing without saying why is its own defect.
        XCTAssertEqual(messageViews.components(separatedBy: "FaintText(PartyRole.unknownOriginPrompt)").count - 1, 2,
                       "both the Send and the Open screen must still explain the refusal")
    }
}
