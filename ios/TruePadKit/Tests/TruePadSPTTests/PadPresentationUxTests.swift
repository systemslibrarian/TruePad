import XCTest
@testable import TruePadCore
@testable import TruePadStorage
@testable import TruePadUI

/// THE LIST, THE DETAIL AND THE RECEIVE SCREEN'S PRESENTATION DECISIONS.
///
/// Same discipline as CreateFlowUxTests: the decisions live in Presentation.swift
/// so they can be tested on the host, and the iOS-only views are covered by
/// source guards with positive controls.
final class PadPresentationUxTests: XCTestCase {

    // MARK: - the pad list

    /// DESTROYED OUTRANKS EVERYTHING. A pad that is gone must never be rendered
    /// as merely frozen or merely low, whatever else is true of it.
    func testTheRowStatePriorityIsDestroyedThenRollbackThenPaused() {
        // Destroyed outranks everything, whatever else is true.
        XCTAssertEqual(PadRowState.of(destroyed: true, rollbackSuspected: true,
                                      frozen: true, remainingSends: 0), .destroyed)
        XCTAssertEqual(PadRowState.of(destroyed: true, frozen: false, remainingSends: 99), .destroyed)
        // A suspected rollback outranks a pause: one is a reuse risk, the other
        // is a brake the operator can release.
        XCTAssertEqual(PadRowState.of(destroyed: false, rollbackSuspected: true,
                                      frozen: true, remainingSends: 99), .rollbackSuspected)
        XCTAssertEqual(PadRowState.of(destroyed: false, frozen: true, remainingSends: 99), .paused)
        XCTAssertEqual(PadRowState.of(destroyed: false, frozen: false, remainingSends: 7),
                       .ready(sends: 7))
    }

    /// Destroyed must be unmistakable, in the line and to VoiceOver.
    func testDestroyedIsUnmistakableAndNeverReadsAsUsable() {
        let d = PadRowState.destroyed
        XCTAssertTrue(d.line.lowercased().contains("destroyed"))
        XCTAssertTrue(d.line.lowercased().contains("unusable"))
        XCTAssertTrue(d.isProblem)
        XCTAssertTrue(d.spoken(label: "pad").lowercased().contains("permanently unusable"))
        // It must never say anything that sounds like remaining capacity.
        XCTAssertFalse(d.line.lowercased().contains("left"))
    }

    /// A LOW PAD IS NOT AN ERROR. Running out of messages is normal use; only
    /// destroyed and frozen are problems.
    func testRunningLowIsNotStyledAsAProblem() {
        XCTAssertFalse(PadRowState.ready(sends: 0).isProblem)
        XCTAssertFalse(PadRowState.ready(sends: 1).isProblem)
        XCTAssertEqual(PadRowState.ready(sends: 1).line, "1 message left")
        XCTAssertEqual(PadRowState.ready(sends: 5).line, "5 messages left")
        XCTAssertTrue(PadRowState.paused.isProblem)
        XCTAssertTrue(PadRowState.rollbackSuspected.isProblem)
    }

    /// Negative remaining sends can never produce a negative count on screen.
    func testRemainingSendsIsNeverNegative() {
        XCTAssertEqual(PadRowState.of(destroyed: false, frozen: false, remainingSends: -3),
                       .ready(sends: 0))
    }

    /// THE FREEZE IS PAIR-WIDE AND BLOCKS OPENING TOO. `requireNotFrozen` is
    /// called by both `burn` and `open` and refuses if EITHER half has tripped, so
    /// a line saying only "cannot send" would leave an operator wondering why a
    /// message they received will not open either.
    func testThePausedStateDoesNotUnderstateWhatAFreezeBlocks() {
        let line = PadRowState.paused.line.lowercased()
        XCTAssertTrue(line.contains("send"))
        XCTAssertTrue(line.contains("open"), "the freeze blocks opening too")
        XCTAssertTrue(PadRowState.paused.spoken(label: "p").lowercased().contains("cannot send or open"))
    }

    /// And the PER-DIRECTION line must not claim that pair-wide fact.
    func testThePerDirectionLineSaysNothingAboutTheFreeze() throws {
        let engine = Engine(fs: MemoryFs(), clock: { Date(timeIntervalSince1970: 0) })
        let pair = try engine.gen(label: "f", sources: [
            SourceInput(name: "device-random", declaredOrigin: "test",
                        bytes: randomBytes(try Partition.requiredSourceLength(capacity: 256,
                                                                             capacityRecords: 4)))
        ], encryptionBytes: 256, authRecords: 4)
        let summary = try engine.status(pair.pair.pairId)
        let row = try XCTUnwrap(summary.meters[PadDirection.aToB].map(MeterRow.init))
        for banned in ["frozen", "paused", "cannot send", "needs attention"] {
            XCTAssertFalse(row.remainingLine.lowercased().contains(banned),
                           "the per-direction line is reporting a pair-wide state")
        }
    }

    /// A REGRESSED WITNESS IS THE ROLLBACK SIGNAL and must reach the row. Removing
    /// the deployment verdict from every row also removed the only hint this state
    /// used to have there.
    func testARegressedWitnessIsSurfacedOnTheRow() {
        let state = PadRowState.of(destroyed: false, rollbackSuspected: true,
                                   frozen: false, remainingSends: 50)
        XCTAssertEqual(state, .rollbackSuspected)
        XCTAssertTrue(state.isProblem)
        XCTAssertTrue(state.line.lowercased().contains("rollback"))
        XCTAssertTrue(state.spoken(label: "p").lowercased().contains("restored"),
                      "VoiceOver must say what a rollback suspicion means")
        XCTAssertFalse(state.line.contains("messages left"),
                       "a pad under rollback suspicion must not read as ordinarily usable")
    }

    /// THE VERDICT IS NOT IN THE ROW. It was in every row, so every
    /// device-generated pad read NOT ELIGIBLE next to its name forever.
    func testTheRowNeverCarriesTheDeploymentVerdict() {
        let states: [PadRowState] = [.destroyed, .paused, .rollbackSuspected,
                                     .ready(sends: 0), .ready(sends: 64)]
        for state in states {
            XCTAssertFalse(state.line.contains("ELIGIBLE"), "\(state) puts the verdict in the row")
            XCTAssertFalse(state.spoken(label: "x").contains("ELIGIBLE"))
            XCTAssertFalse(state.spoken(label: "x").contains("Deployment assessment"))
        }
    }

    // MARK: - which half is which

    /// TRANSLATING A DIRECTION REQUIRES THE ROLE. For party B, "A->B" is the half
    /// they RECEIVE on; calling it "messages you send" would hand the operator
    /// the wrong number as their sending budget.
    func testDirectionWordingDependsOnTheDevicesRole() throws {
        let engine = Engine(fs: MemoryFs(), clock: { Date(timeIntervalSince1970: 0) })
        let pair = try engine.gen(label: "m", sources: [
            SourceInput(name: "device-random", declaredOrigin: "test",
                        bytes: randomBytes(try Partition.requiredSourceLength(capacity: 256,
                                                                             capacityRecords: 4)))
        ], encryptionBytes: 256, authRecords: 4)
        let summary = try engine.status(pair.pair.pairId)
        let aToB = try XCTUnwrap(summary.meters[PadDirection.aToB].map(MeterRow.init))
        let bToA = try XCTUnwrap(summary.meters[PadDirection.bToA].map(MeterRow.init))

        XCTAssertEqual(aToB.plainDirection(role: Party.a), "Messages you send")
        XCTAssertEqual(aToB.plainDirection(role: Party.b), "Messages you receive")
        XCTAssertEqual(bToA.plainDirection(role: Party.b), "Messages you send")
        XCTAssertEqual(bToA.plainDirection(role: Party.a), "Messages you receive")

        // With no derived role there is nothing honest to say, so it does not
        // guess — it names the direction and leaves interpretation alone.
        let noRole: Party? = nil
        XCTAssertEqual(aToB.plainDirection(role: noRole), "A to B")
        XCTAssertEqual(bToA.plainDirection(role: noRole), "B to A")
    }

    // MARK: - receive-request states

    /// EVERYTHING EXCEPT PENDING IS FINISHED. Nothing here resurrects.
    func testOnlyPendingIsNonTerminal() {
        XCTAssertFalse(ReceiveRequestStatus.pending.isTerminal)
        for status: ReceiveRequestStatus in [.consumed, .cancelled, .rejected, .expired,
                                             .absent, .unreadable] {
            XCTAssertTrue(status.isTerminal, "\(status) must be terminal")
        }
    }

    /// Every ending the operator can reach is explained, and every explanation
    /// points at the only recovery there is — a new request.
    func testEveryTerminalOutcomeIsExplainedAndOffersTheOnlyRecovery() {
        for status: ReceiveRequestStatus in [.consumed, .cancelled, .rejected, .expired, .unreadable] {
            let headline = ReceiveRequestOutcomeText.headline(status)
            let detail = ReceiveRequestOutcomeText.detail(status)
            XCTAssertNotNil(headline, "\(status) has no headline")
            XCTAssertNotNil(detail, "\(status) has no explanation")
            XCTAssertTrue(detail!.lowercased().contains("create a new one")
                          || detail!.lowercased().contains("create a new"),
                          "\(status) does not point at the recovery path")
            // And none of them may suggest the request can come back.
            for forbidden in ["resume", "reopen", "try again with the same", "reuse"] {
                XCTAssertFalse(detail!.lowercased().contains(forbidden),
                               "\(status) hints the request can be resurrected")
            }
        }
        // A live request gets no notice at all.
        XCTAssertNil(ReceiveRequestOutcomeText.headline(.pending))
        XCTAssertNil(ReceiveRequestOutcomeText.detail(.pending))
    }

    /// CONSUMED DOES NOT MEAN A PAD ARRIVED. The engine spends the one-time key
    /// BEFORE importing — "CONSUME. After this returns valid, any failure below
    /// is LOSS." — so a request can read consumed with nothing saved. The notice
    /// must not tell the operator they hold a pad they may not have.
    func testConsumedNeverAssertsThatAPadWasSaved() {
        let headline = ReceiveRequestOutcomeText.headline(.consumed)!
        let detail = ReceiveRequestOutcomeText.detail(.consumed)!
        XCTAssertFalse(headline.lowercased().contains("pad received"),
                       "the headline asserts a pad arrived, which consumed does not establish")
        XCTAssertTrue(headline.lowercased().contains("used"))
        // It must account for the loss case explicitly.
        XCTAssertTrue(detail.lowercased().contains("lost in transfer"))
        XCTAssertTrue(detail.lowercased().contains("spent"))
    }

    /// A REJECTION IS NAMED AS ONE. It is the outcome the comparison exists to
    /// produce, and it must not be blurred into an ordinary cancellation.
    func testRejectionIsDistinguishedFromCancellation() {
        XCTAssertNotEqual(ReceiveRequestOutcomeText.headline(.rejected),
                          ReceiveRequestOutcomeText.headline(.cancelled))
        let rejected = try! XCTUnwrap(ReceiveRequestOutcomeText.detail(.rejected)).lowercased()
        XCTAssertTrue(rejected.contains("did not match"))
        XCTAssertTrue(rejected.contains("right outcome"),
                      "a mismatch is the comparison working, and should not read as a failure")
    }

    /// The engine agrees with the enum, on real durable state.
    func testTheEngineReportsTheTerminalStatusItActuallyWrote() throws {
        let fs = MemoryFs()
        let engine = Engine(fs: fs, clock: { Date(timeIntervalSince1970: 0) })

        let a = try engine.sptCreateReceiveRequest()
        XCTAssertEqual(engine.sptReceiveRequestStatus(requestIdHex: a.requestIdHex), .pending)
        _ = try engine.sptCancelReceiveRequest(requestIdHex: a.requestIdHex)
        XCTAssertEqual(engine.sptReceiveRequestStatus(requestIdHex: a.requestIdHex), .cancelled)

        let b = try engine.sptCreateReceiveRequest()
        _ = try engine.sptRejectReceiveRequest(requestIdHex: b.requestIdHex)
        XCTAssertEqual(engine.sptReceiveRequestStatus(requestIdHex: b.requestIdHex), .rejected)

        // Never published, and malformed. Both fail closed rather than reading fresh.
        XCTAssertEqual(engine.sptReceiveRequestStatus(requestIdHex: String(repeating: "a", count: 32)),
                       .absent)
        XCTAssertEqual(engine.sptReceiveRequestStatus(requestIdHex: "nonsense"), .absent)
    }

    /// THE STATUS SUMMARY CARRIES NO KEY MATERIAL. `ReceiverState.pending` holds
    /// the decapsulation key; that type must never reach a view.
    func testTheStatusSummaryCannotCarryAKey() throws {
        let source = try String(
            contentsOf: XWingKATTests.repoRoot
                .appendingPathComponent("ios/TruePadKit/Sources/TruePadStorage/SptEngine.swift"),
            encoding: .utf8)
        guard let decl = source.range(of: "public enum ReceiveRequestStatus") else {
            return XCTFail("the status enum is gone")
        }
        let end = source.range(of: "\n}", range: decl.upperBound..<source.endIndex)!
        let body = String(source[decl.lowerBound..<end.upperBound])
        for leak in ["dk", "[UInt8]", "body", "requestHash"] {
            XCTAssertFalse(body.contains(leak),
                           "ReceiveRequestStatus carries \(leak) — it must be a flat summary")
        }
        // POSITIVE CONTROL: the slice really is the enum.
        XCTAssertTrue(body.contains("case pending"))
        XCTAssertTrue(body.contains("case rejected"))
    }

    // MARK: - source guards over the iOS-only views

    private func source(_ path: String) throws -> String {
        try String(contentsOf: XWingKATTests.repoRoot.appendingPathComponent(path), encoding: .utf8)
    }

    /// A CONSUMED REQUEST OFFERS NO CANCEL. The Cancel button lives inside the
    /// `if let request = model.request` branch, and `refresh()` clears `request`
    /// the moment the engine says the status is terminal — so a finished request
    /// cannot present an action that could only throw.
    func testCancelIsOnlyOfferedWhileARequestIsLive() throws {
        let views = try source("ios/TruePadKit/Sources/TruePadUI/CeremonyViews.swift")
        let models = try source("ios/TruePadKit/Sources/TruePadUI/CeremonyModels.swift")

        guard let live = views.range(of: "if let request = model.request"),
              let elseBranch = views.range(of: "} else {", range: live.upperBound..<views.endIndex),
              let cancel = views.range(of: "Cancel this code") else {
            return XCTFail("the receive screen no longer has the shape this guard reads")
        }
        XCTAssertTrue(cancel.lowerBound > live.lowerBound && cancel.lowerBound < elseBranch.lowerBound,
                      "the cancel action escaped the live-request branch")

        // And the model really does drop a terminal request.
        XCTAssertTrue(models.contains("if status.isTerminal"))
        XCTAssertTrue(models.contains("engine.sptReceiveRequestStatus(requestIdHex:"))

        // POSITIVE CONTROL: the strings this reasons about exist.
        XCTAssertTrue(views.contains("Create a receive code"))
    }

    /// RE-SHARE MUST NOT LOOK LIKE A SECOND SEALING. One request, one pad, one
    /// committed package.
    func testResharePresentsItselfAsTheSamePackage() throws {
        let views = try source("ios/TruePadKit/Sources/TruePadUI/CeremonyViews.swift")
        let pad = try source("ios/TruePadKit/Sources/TruePadUI/PadViews.swift")
        XCTAssertTrue(views.contains("sealed.reshared"),
                      "the seal screen must distinguish a re-share from a first seal")
        XCTAssertTrue(views.contains("same sealed file you made before, not a new one"))
        XCTAssertTrue(pad.contains("Hand over the same sealed file…"))
        // The raw pad stays blocked once handed over, which is the reuse-relevant half.
        XCTAssertTrue(pad.contains("model.mayHandOff"))
        XCTAssertTrue(pad.contains("model.mayReshareSealed"))
    }

    /// THE PAD SCREEN LEADS WITH WHAT THE OPERATOR CAME TO DO, and the counters
    /// and assessment are organised behind a disclosure rather than deleted.
    func testThePadScreenLeadsWithActionsAndKeepsEveryNumber() throws {
        let pad = try source("ios/TruePadKit/Sources/TruePadUI/PadViews.swift")
        guard let messages = pad.range(of: "Section(\"Messages\")"),
              let details = pad.range(of: "DisclosureGroup(\"Security details\")") else {
            return XCTFail("the pad screen no longer has the shape this guard reads")
        }
        XCTAssertTrue(messages.lowerBound < details.lowerBound,
                      "the technical disclosure is above the actions again")
        XCTAssertTrue(pad.contains("MeterSection(row: row)"),
                      "the exact counters were deleted rather than moved")
        XCTAssertTrue(pad.contains("Write a message"))
        XCTAssertTrue(pad.contains("Open a message"))
        XCTAssertTrue(pad.contains("Destroy this pad…"))
    }

    /// THE QR KEEPS A LIGHT SURFACE AND ITS PROVEN GEOMETRY inside a dark app.
    func testTheQrSurvivesTheDarkAppearance() throws {
        let messages = try source("ios/TruePadKit/Sources/TruePadUI/MessageViews.swift")
        let root = try source("ios/TruePadKit/Sources/TruePadUI/RootView.swift")
        XCTAssertTrue(root.contains(".preferredColorScheme(.dark)"))
        // Light surfaces, both the inline card and the full-screen scan path.
        XCTAssertTrue(messages.contains(".background(Color.white)"))
        XCTAssertTrue(messages.contains("Color.white.ignoresSafeArea()"))
        // The load-bearing geometry is untouched.
        XCTAssertTrue(messages.contains(".interpolation(.none)"))
        XCTAssertTrue(messages.contains("QrCorrection.level(forByteCount:"),
                      "the readability-first correction choice must remain")
    }
}
