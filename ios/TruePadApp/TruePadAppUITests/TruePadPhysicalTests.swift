import XCTest

/// THE PHYSICAL-DEVICE PASS, driven through the real UI on a real iPhone.
///
/// WHAT THIS IS FOR. Everything else in this repository runs on a Mac against an
/// in-memory or temp-directory filesystem. These tests run against the actual app
/// container, the actual data-protection Keychain, and the actual app lifecycle —
/// which is where the properties that matter either hold or do not:
///
///   · durable state survives process death and relaunch;
///   · material consumed by a send is still consumed after a force-quit;
///   · a message that does not verify consumes no pad material;
///   · a refused destruction changes nothing;
///   · a published receive request survives a force-quit, and a cancelled one
///     does not come back;
///   · the camera is not touched until the operator asks for it.
///
/// WHAT IT IS NOT.
///
/// It is NOT a VoiceOver assessment. It asserts that the elements carrying
/// decisions have labels and that those labels say what a number MEANS, but
/// whether the screen is USABLE with VoiceOver is a human judgement.
///
/// It is NOT the two-device ceremony: one handset cannot perform a comparison
/// between two people, and nothing here exercises a transfer between parties.
///
/// It does NOT cover a COMPLETED destruction. Doing that through the interface
/// requires typing the pairId, and TruePad deliberately never displays it — the
/// operator is expected to know it from the pad book, a head.json, or the
/// tombstone. A UI test has no such source, so only the REFUSAL path is
/// reachable from here. That is a real limit of this bundle, not an oversight.
///
/// Every pad created here is DISPOSABLE and generated from the device CSPRNG, so
/// it reads NOT ELIGIBLE for the strongest deployment classification and
/// destroying it costs nothing. No operational pad is touched.
final class TruePadPhysicalTests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    // MARK: - helpers

    /// Most rows here are `accessibilityElement(children: .combine)` with a label
    /// that says what the row MEANS, so an exact-string query matches nothing.
    func element(beginningWith prefix: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    func element(containing needle: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", needle)).firstMatch
    }

    /// SCROLL UNTIL IT EXISTS.
    ///
    /// A SwiftUI `Form` is a collection view, and a row below the fold is not in
    /// the accessibility hierarchy at all — not merely un-hittable, ABSENT. The
    /// first run of this bundle failed five tests on exactly that: "Create this
    /// pad" and the twelve comparison words both sit under enough content to be
    /// off-screen on an iPhone 12, so `waitForExistence` was waiting for
    /// something that could not appear without a scroll.
    @discardableResult
    func reveal(_ target: XCUIElement, in app: XCUIApplication, swipes: Int = 8) -> Bool {
        if target.waitForExistence(timeout: 3) { return true }
        for _ in 0..<swipes {
            app.swipeUp()
            if target.exists { return true }
        }
        return target.exists
    }

    /// The first integer in an accessibility label, e.g. "You can still send 4
    /// messages in this direction." -> 4.
    func firstNumber(in text: String) -> Int? {
        guard let r = text.range(of: "[0-9]+", options: .regularExpression) else { return nil }
        return Int(text[r])
    }

    @discardableResult
    func launchFresh() -> XCUIApplication {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30),
                      "the app must reach the foreground")
        return app
    }

    /// The root must actually RENDER. A process that is alive but showing nothing
    /// would satisfy a bare "did it launch" check.
    func assertRootRendered(_ app: XCUIApplication, _ note: String = "") {
        XCTAssertTrue(app.tabBars.buttons["Pads"].waitForExistence(timeout: 25),
                      "the Pads tab must render. \(note)")
        XCTAssertTrue(app.tabBars.buttons["Receive"].exists, "the Receive tab must render")
        XCTAssertTrue(app.tabBars.buttons["About"].exists, "the About tab must render")
    }

    func uniqueLabel(_ stem: String) -> String { "\(stem)-\(Int(Date().timeIntervalSince1970))" }

    /// Drain EVERY receive request left over from earlier runs, so a test that
    /// needs to publish one starts from a known state.
    ///
    /// A LOOP, not a single cancel. Cancelling now surfaces the next pending
    /// request rather than stranding it — that is the drain behaviour the restore
    /// fix introduced — so one cancel only clears one. Several accumulate because
    /// each run of this bundle publishes one.
    ///
    /// Cancelling is terminal and costs nothing here: these are disposable
    /// requests this bundle created.
    func drainPendingRequests(_ app: XCUIApplication) {
        for _ in 0..<12 {
            if app.buttons["Create a receive code"].waitForExistence(timeout: 4) { return }
            let cancel = app.buttons["Cancel this code"]
            guard cancel.exists || reveal(cancel, in: app, swipes: 4) else { return }
            cancel.tap()
        }
        XCTFail("could not drain the pending receive requests on this device")
    }

    /// Create a disposable pad from the device CSPRNG. No file picker is
    /// involved, which is what makes this path automatable at all.
    func createDisposablePad(_ app: XCUIApplication, label: String) {
        app.tabBars.buttons["Pads"].tap()
        let add = app.buttons["Create a pad"]
        XCTAssertTrue(add.waitForExistence(timeout: 20), "the create affordance must exist")
        add.tap()

        let name = app.textFields["A name for this pad. It stays on this device."]
        XCTAssertTrue(name.waitForExistence(timeout: 20), "the create sheet must appear")
        name.tap()
        name.typeText(label)

        // THE DEVICE GENERATOR IS NOW THE DEFAULT, so there is nothing to select:
        // the normal path is the normal path. What must still be true is that the
        // operator can read the consequence BEFORE committing — it moved from a
        // standalone orange label into "Security details", which this opens and
        // reads rather than taking on trust.
        XCTAssertTrue(reveal(element(containing: "Generated securely on this iPhone", in: app), in: app),
                      "the normal path must name its source plainly")

        let details = app.buttons["Security details"].exists
            ? app.buttons["Security details"]
            : element(containing: "Security details", in: app)
        XCTAssertTrue(reveal(details, in: app), "the source explanation must be reachable")
        details.tap()
        XCTAssertTrue(reveal(element(containing: "information-theoretic", in: app), in: app),
                      "the consequence must be readable BEFORE the operator commits")
        XCTAssertTrue(reveal(element(containing: "computational and platform assumptions", in: app), in: app),
                      "the claim must still name the assumption it rests on")

        let create = app.buttons["Create pad"]
        XCTAssertTrue(reveal(create, in: app), "the create button must be reachable")
        XCTAssertTrue(create.isEnabled, "a named pad with a source must be creatable")
        create.tap()

        // MORE SWIPES THAN ELSEWHERE. Pads accumulate across runs — there is no
        // reset affordance and there should not be one — so by the time this
        // bundle has run a few times the newest row is a long way down.
        XCTAssertTrue(reveal(element(beginningWith: label + ".", in: app), in: app, swipes: 20),
                      "the new pad must appear in the list")
    }

    func openPad(_ app: XCUIApplication, label: String) {
        let row = element(beginningWith: label + ".", in: app)
        XCTAssertTrue(reveal(row, in: app), "the pad row must be reachable")
        row.tap()
    }

    /// OPEN "Security details", which is where the exact counters and the
    /// deployment assessment now live.
    ///
    /// The pad screen used to open on two sections of meters; the UX parity pass
    /// put the actions first and moved every number one disclosure down. Nothing
    /// was deleted, so these tests still assert on exactly the same labels — they
    /// just have to open the drawer first.
    ///
    /// Idempotent: if a meter is already on screen the disclosure is open, and
    /// tapping it again would CLOSE it.
    @discardableResult
    func openSecurityDetails(_ app: XCUIApplication) -> Bool {
        if element(containing: "You can still send", in: app).exists { return true }
        let disclosure = app.buttons["Security details"].exists
            ? app.buttons["Security details"]
            : element(containing: "Security details", in: app)
        guard reveal(disclosure, in: app, swipes: 12) else { return false }
        disclosure.tap()
        return element(containing: "You can still send", in: app).waitForExistence(timeout: 5)
    }

    /// The bytes-of-pad-material-remaining figure for the first direction shown.
    func padMaterialRemaining(_ app: XCUIApplication) -> Int? {
        openSecurityDetails(app)
        let meter = element(containing: "bytes of pad material remain", in: app)
        guard reveal(meter, in: app) else { return nil }
        return firstNumber(in: meter.label)
    }

    /// The remaining-sends figure for the first direction shown.
    func remainingSends(_ app: XCUIApplication) -> Int? {
        openSecurityDetails(app)
        let meter = element(containing: "You can still send", in: app)
        guard reveal(meter, in: app) else { return nil }
        return firstNumber(in: meter.label)
    }

    // MARK: - 1. it launches, and it says what it is

    func test01_LaunchesAndStatesItsClaimsBoundary() {
        let app = launchFresh()
        assertRootRendered(app, "on a first launch")

        // The claims boundary is a product commitment, not decoration, and the
        // person holding the phone is who it is for.
        app.tabBars.buttons["About"].tap()
        XCTAssertTrue(app.staticTexts["Post-quantum cryptography protects pad DELIVERY."]
                        .waitForExistence(timeout: 20),
                      "the claims boundary must be readable without the documentation")
        XCTAssertTrue(app.staticTexts["The one-time pad encrypts messages."].exists)
        XCTAssertTrue(app.staticTexts["Wegman–Carter authenticates messages."].exists)
        XCTAssertTrue(app.staticTexts["No server, no account, no transport of its own"].exists)
    }

    // MARK: - 2. lifecycle

    func test02_SurvivesBackgroundForegroundAndAForceQuit() {
        let app = launchFresh()
        assertRootRendered(app)

        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 30),
                      "the app must background cleanly")

        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30),
                      "the app must return to the foreground")
        assertRootRendered(app, "after a background/foreground cycle")

        // PROCESS DEATH, not a suspend.
        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 30))
        app.launch()
        assertRootRendered(app, "after a force-quit and relaunch")
    }

    // MARK: - 3. a pad, and its consumed material, survive process death

    /// THE DURABILITY CLAIM, on real storage: `fcntl(F_FULLFSYNC)` and the §12.4
    /// write order observed on APFS rather than argued about.
    func test03_ConsumedMaterialIsStillConsumedAfterAForceQuit() {
        let app = launchFresh()
        let label = uniqueLabel("disposable")
        createDisposablePad(app, label: label)
        openPad(app, label: label)

        let before = remainingSends(app)
        XCTAssertNotNil(before, "the remaining-sends meter must render on the device")

        let write = app.buttons["Write a message"]
        XCTAssertTrue(reveal(write, in: app), "the send affordance must be reachable")
        write.tap()
        let field = element(beginningWith: "The message to send.", in: app)
        XCTAssertTrue(reveal(field, in: app), "the message field must exist")
        field.tap()
        field.typeText("physical validation message")

        let encrypt = app.buttons["Encrypt and consume the pad"]
        XCTAssertTrue(reveal(encrypt, in: app))
        encrypt.tap()

        // The envelope appears only AFTER the durable commit. That ordering is
        // BURN-BEFORE-OUTPUT, observed on a handset.
        XCTAssertTrue(reveal(app.staticTexts["The encrypted message, as text you can copy."],
                             in: app),
                      "an envelope must be produced")

        // FORCE-QUIT with a pad in the store, then relaunch.
        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 30))
        app.launch()
        assertRootRendered(app, "after a quit with durable state on disk")

        XCTAssertTrue(reveal(element(beginningWith: label + ".", in: app), in: app, swipes: 20),
                      "the pad must survive process death — this is the durability claim")
        openPad(app, label: label)

        // THE NUMBER MUST HAVE GONE DOWN, and stayed down. An unchanged meter
        // would mean the burn did not persist and the material was reusable —
        // which is the one outcome this project treats as unacceptable.
        let after = remainingSends(app)
        XCTAssertNotNil(after)
        if let b = before, let a = after {
            XCTAssertLessThan(a, b,
                              "remaining sends must be strictly lower after a send that survived "
                              + "a force-quit (before: \(b), after: \(a))")
        }
    }

    // MARK: - 4. a message that does not verify consumes no pad material

    /// THE BOUNDED-FORGERY CLAIM, checked on real storage.
    ///
    /// The Open screen states: "A message that does not verify costs one
    /// verification attempt and consumes no pad material." That is a promise
    /// about what a forgery costs the honest party, and it is the difference
    /// between a bounded guarantee and a denial-of-service: if a rejected message
    /// burned pad material, anyone who could hand the operator garbage could
    /// exhaust the pad. This asserts the pad-material meter is UNCHANGED after a
    /// refusal, against the real store rather than a temp directory.
    ///
    /// WHY NOT A FULL ROUND TRIP. Sending and reopening on one device would need
    /// the envelope moved from the Send screen to the Open screen, and the only
    /// route the interface offers is the system edit menu — the ciphertext is
    /// deliberately not exposed as an accessibility value, because reading a
    /// base64 blob aloud helps nobody. Driving Copy then Paste through XCUITest
    /// did not reliably land the text, and a flaky assertion about cryptographic
    /// correctness is worse than none. The round trip IS covered by the host
    /// suite; what a handset adds is durable consumption on APFS, and test03
    /// establishes that. So this tests a claim the SCREEN makes instead.
    func test04_AMessageThatDoesNotVerifyConsumesNoPadMaterial() {
        let app = launchFresh()
        let label = uniqueLabel("forgery")
        createDisposablePad(app, label: label)
        openPad(app, label: label)

        let materialBefore = padMaterialRemaining(app)
        XCTAssertNotNil(materialBefore, "the pad-material meter must render")

        let openLink = app.buttons["Open a message"]
        XCTAssertTrue(reveal(openLink, in: app))
        openLink.tap()

        let field = app.textFields["Paste it here"]
        XCTAssertTrue(reveal(field, in: app), "the paste field must exist")
        field.tap()
        field.typeText("TP2:this-is-not-a-real-envelope")

        let openButton = app.buttons["Open"]
        XCTAssertTrue(reveal(openButton, in: app))
        XCTAssertTrue(openButton.isEnabled, "a non-empty envelope must be openable")
        openButton.tap()

        XCTAssertTrue(app.alerts["TruePad refused"].waitForExistence(timeout: 30),
                      "a malformed envelope must be refused, not opened")
        app.alerts["TruePad refused"].buttons["OK"].tap()

        // Back to the pad and re-read the meter FROM DISK — the detail view
        // reloads on appear, so this is the store's answer, not a cached one.
        app.navigationBars.buttons.firstMatch.tap()
        let materialAfter = padMaterialRemaining(app)
        XCTAssertNotNil(materialAfter)
        XCTAssertEqual(materialAfter, materialBefore,
                       "a refused message must consume NO pad material — anything else means "
                       + "garbage handed to the operator can exhaust their pad")
    }

    // MARK: - 5. a refused destruction changes nothing

    /// Only the REFUSAL path is reachable from the interface — see the type
    /// comment. The prompt must not hand over the answer, and a wrong
    /// confirmation must leave the pad exactly as it was.
    func test05_TheDestroyPromptWithholdsTheIdentifierAndRefusesAWrongOne() {
        let app = launchFresh()
        let label = uniqueLabel("destroy-refusal")
        createDisposablePad(app, label: label)
        openPad(app, label: label)

        let destroyLink = app.buttons["Destroy this pad…"]
        XCTAssertTrue(reveal(destroyLink, in: app), "the destroy affordance must be reachable")
        destroyLink.tap()

        // THE PROMPT NEVER CONTAINS THE VALUE IT ASKS FOR. A prompt that shows
        // the identifier is not a confirmation, it is a copy exercise.
        let prompt = app.staticTexts["Destroying a pad is permanent. Type the pad's identifier "
                                     + "to confirm. TruePad will not show it to you here."]
        XCTAssertTrue(reveal(prompt, in: app),
                      "the destroy prompt must be shown and must withhold the identifier")

        let confirm = app.textFields["Type the pad's identifier to confirm destruction. "
                                     + "TruePad will not show it to you here."]
        XCTAssertTrue(reveal(confirm, in: app))

        // Disabled until something is typed: destruction is not one stray tap away.
        XCTAssertFalse(app.buttons["Destroy this pad"].isEnabled,
                       "destruction must not be one stray tap away")

        confirm.tap()
        confirm.typeText("definitely-not-the-pair-id")
        app.buttons["Destroy this pad"].tap()

        XCTAssertTrue(app.alerts["TruePad refused"].waitForExistence(timeout: 30),
                      "a wrong confirmation must be refused")
        app.alerts["TruePad refused"].buttons["OK"].tap()

        // Back out and confirm the pad is untouched and still listed.
        app.navigationBars.buttons.firstMatch.tap()
        app.navigationBars.buttons.firstMatch.tap()

        // NOT `BEGINSWITH label + "."`. A destroyed pad's row reads
        // "<label>. Destroyed, and permanently unusable." and a live one reads
        // "<label>. You can send N more messages." — both begin with the label,
        // so a prefix check passes whether the pad survived or not, which is the
        // opposite of what this test exists to establish. Assert the live text
        // and the absence of the tombstone text instead.
        XCTAssertTrue(element(containing: label + ". You can send", in: app)
                        .waitForExistence(timeout: 30),
                      "a refused destruction must leave the pad USABLE, not merely listed")
        XCTAssertFalse(element(containing: "Destroyed, and permanently unusable", in: app).exists,
                       "nothing may have been tombstoned by a refused destruction")
    }

    // MARK: - 6. the receive request is durable, and cancelling it is terminal

    func test06_AReceiveRequestSurvivesAQuitAndACancellationIsPermanent() {
        let app = launchFresh()
        app.tabBars.buttons["Receive"].tap()

        // A REQUEST MAY ALREADY BE HERE, restored from an earlier run of this
        // bundle. That is the restore path working — a published request is
        // supposed to survive a restart — so clear it before publishing a new
        // one rather than treating it as a failure.
        drainPendingRequests(app)

        let create = app.buttons["Create a receive code"]
        XCTAssertTrue(reveal(create, in: app), "the Receive tab must offer a request")
        create.tap()

        // THE TWELVE WORDS MUST ACTUALLY RENDER. If the wordlist failed to load,
        // `WordGrid` refuses and shows the failure text instead — correct
        // fail-closed behaviour, but NOT the good path, and a test that accepted
        // either would assert nothing.
        XCTAssertTrue(reveal(element(beginningWith: "Word 1:", in: app), in: app),
                      "the twelve comparison words must render on the device")
        XCTAssertTrue(reveal(element(beginningWith: "Word 12:", in: app), in: app),
                      "all twelve must render, not the first few")
        XCTAssertFalse(app.staticTexts["The comparison words cannot be displayed. This transfer "
                                       + "cannot be confirmed on this device."].exists,
                       "the fail-closed path must NOT be the one taken on a working build")

        // The request's one-time key is durable: it must survive process death.
        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 30))
        app.launch()
        app.tabBars.buttons["Receive"].tap()
        let cancel = app.buttons["Cancel this code"]
        XCTAssertTrue(reveal(cancel, in: app), "a published request must survive a force-quit")
        cancel.tap()

        XCTAssertTrue(reveal(app.buttons["Create a receive code"], in: app),
                      "cancelling must leave the tab ready for a new request")

        // AND THE CANCELLATION IS TERMINAL. Checked across a relaunch so it is
        // the on-disk state being trusted, not anything still in memory.
        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 30))
        app.launch()
        app.tabBars.buttons["Receive"].tap()
        XCTAssertTrue(reveal(app.buttons["Create a receive code"], in: app),
                      "a cancelled request must not return as pending after a relaunch")
    }

    // MARK: - 7. the camera is not reached for until asked

    /// A permission dialog at launch teaches people to dismiss dialogs, and would
    /// mean the app touched the camera without being asked.
    func test07_NoCameraPromptFromOrdinaryNavigation() {
        let app = launchFresh()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

        assertRootRendered(app)
        app.tabBars.buttons["Receive"].tap()
        XCTAssertTrue(reveal(app.buttons["Create a receive code"], in: app)
                        || reveal(app.buttons["Cancel this code"], in: app),
                      "the Receive tab must have finished rendering before this is asserted")
        app.tabBars.buttons["About"].tap()
        XCTAssertTrue(app.staticTexts["The one-time pad encrypts messages."]
                        .waitForExistence(timeout: 20),
                      "the About tab must have finished rendering before this is asserted")
        app.tabBars.buttons["Pads"].tap()
        XCTAssertTrue(app.tabBars.buttons["Pads"].waitForExistence(timeout: 20))

        XCTAssertEqual(springboard.alerts.count, 0,
                       "no permission prompt may appear from ordinary navigation")
    }

    // MARK: - 8. the numbers that carry decisions are described, not recited

    /// NOT A VOICEOVER ASSESSMENT. This asserts the labels exist and say what the
    /// number MEANS. "59, 64, 7, 8" would pass a label-exists check and tell a
    /// blind operator nothing.
    func test08_DecisionCarryingElementsAreDescribedByMeaning() {
        let app = launchFresh()
        let label = uniqueLabel("a11y")
        createDisposablePad(app, label: label)
        openPad(app, label: label)

        XCTAssertTrue(openSecurityDetails(app), "the counters must be reachable")
        XCTAssertTrue(reveal(element(containing: "You can still send", in: app), in: app),
                      "the remaining-sends meter must be described, not just numbered")
        XCTAssertTrue(reveal(element(containing: "bytes of pad material remain", in: app), in: app),
                      "the pad-material meter must be described")
        XCTAssertTrue(reveal(element(containing: "authentication records", in: app), in: app),
                      "the records meter must be described, including that each message uses one")
        XCTAssertTrue(reveal(element(containing: "Whichever runs out first", in: app), in: app),
                      "the binding constraint must be stated")
        XCTAssertTrue(reveal(element(containing: "Deployment assessment", in: app), in: app),
                      "the derived verdict must be announced as an assessment")
    }

    // MARK: - 9. the device-generated pad is labelled honestly

    /// The Create screen's "Security details" says a device-generated pad reads
    /// NOT ELIGIBLE. A statement the product then contradicts is worse than no
    /// statement — and moving it out of the primary flow must not make it any
    /// less true, which is what this checks.
    func test09_ADeviceGeneratedPadReadsNotEligible() {
        let app = launchFresh()
        let label = uniqueLabel("verdict")
        createDisposablePad(app, label: label)
        openPad(app, label: label)

        XCTAssertTrue(openSecurityDetails(app), "the assessment must be reachable")
        XCTAssertTrue(reveal(app.staticTexts["NOT ELIGIBLE"], in: app),
                      "the pad must read exactly what the Create screen promised")
    }
}
