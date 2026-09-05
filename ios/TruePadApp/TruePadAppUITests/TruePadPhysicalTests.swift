import XCTest

/// THE PHYSICAL-DEVICE PASS, driven through the real UI on a real iPhone.
///
/// WHAT THIS IS FOR. Everything else in this repository runs on a Mac against an
/// in-memory or temp-directory filesystem. These tests run against the actual app
/// container, the actual data-protection Keychain, and the actual app lifecycle —
/// which is where the properties that matter either hold or do not:
///
///   · durable state survives process death and relaunch;
///   · a refused destruction changes nothing;
///   · a published receive request survives a force-quit, and a cancelled one
///     does not come back;
///   · the camera is not touched until the operator asks for it.
///
/// WHAT IT IS NOT. It is NOT a VoiceOver assessment. It can assert that the
/// elements carrying decisions have labels and that those labels say what a
/// number MEANS, but whether the screen is USABLE with VoiceOver is a human
/// judgement and remains outstanding. It is also NOT the two-device ceremony:
/// one handset cannot perform a comparison between two people.
///
/// Every pad created here is DISPOSABLE and generated from the device CSPRNG —
/// deliberately the weakest kind TruePad makes, so it reads NOT ELIGIBLE and
/// destroying it costs nothing. No operational pad is touched.
final class TruePadPhysicalTests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    // MARK: - helpers

    /// Most of this app's rows are `accessibilityElement(children: .combine)` with
    /// a label that says what the row MEANS, so an exact-string query would match
    /// nothing. Prefix matching is how a test addresses a row that is deliberately
    /// described rather than named.
    func element(beginningWith prefix: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", prefix))
            .firstMatch
    }

    func element(containing needle: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", needle))
            .firstMatch
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
    /// would satisfy a bare "did it launch" check, and that is exactly the failure
    /// a composition root can produce.
    func assertRootRendered(_ app: XCUIApplication, _ note: String = "") {
        XCTAssertTrue(app.tabBars.buttons["Pads"].waitForExistence(timeout: 25),
                      "the Pads tab must render. \(note)")
        XCTAssertTrue(app.tabBars.buttons["Receive"].exists, "the Receive tab must render")
        XCTAssertTrue(app.tabBars.buttons["About"].exists, "the About tab must render")
    }

    /// Create a disposable pad from the device CSPRNG. No file picker is involved,
    /// which is what makes this path automatable at all.
    func createDisposablePad(_ app: XCUIApplication, label: String) {
        app.tabBars.buttons["Pads"].tap()
        let add = app.buttons["Create a pad"]
        XCTAssertTrue(add.waitForExistence(timeout: 20), "the create affordance must exist")
        add.tap()

        let name = app.textFields["A name for this pad. It stays on this device."]
        XCTAssertTrue(name.waitForExistence(timeout: 20), "the create sheet must appear")
        name.tap()
        name.typeText(label)

        chooseDeviceSource(app)

        let create = app.buttons["Create this pad"]
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        XCTAssertTrue(create.isEnabled, "a named pad with a source must be creatable")
        create.tap()

        XCTAssertTrue(element(beginningWith: label + ".", in: app).waitForExistence(timeout: 60),
                      "the new pad must appear in the list")
    }

    /// The source picker is an inline `Picker` in a `Form`, so the option is a row
    /// rather than a control with a stable type.
    func chooseDeviceSource(_ app: XCUIApplication) {
        let option = element(beginningWith: "This device's random generator", in: app)
        XCTAssertTrue(option.waitForExistence(timeout: 10), "the device source must be offered")
        option.tap()
        XCTAssertTrue(app.staticTexts["This pad will read NOT ELIGIBLE"]
                        .waitForExistence(timeout: 10),
                      "the consequence must be stated BEFORE the operator commits")
    }

    func uniqueLabel(_ stem: String) -> String {
        "\(stem)-\(Int(Date().timeIntervalSince1970))"
    }

    // MARK: - 1. it launches, and it says what it is

    func test01_LaunchesAndStatesItsClaimsBoundary() {
        let app = launchFresh()
        assertRootRendered(app, "on a first launch")

        // The claims boundary is a product commitment, not decoration. If this
        // ever stops being on screen, that is a change to what TruePad says it
        // does — and the person holding the phone is who it is for.
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

    /// THE DURABILITY CLAIM, on real storage. A pad created before a force-quit
    /// must still be there afterwards, with the material a sent message consumed
    /// still consumed. This is `fcntl(F_FULLFSYNC)` and the §12.4 write order
    /// observed on APFS rather than argued about.
    func test03_APadAndItsConsumedMaterialSurviveAForceQuit() {
        let app = launchFresh()
        let label = uniqueLabel("disposable")
        createDisposablePad(app, label: label)

        element(beginningWith: label + ".", in: app).tap()

        // The meters are labelled by MEANING, so this both navigates and asserts
        // the accessibility contract at the same time.
        let sendsBefore = element(containing: "You can still send", in: app)
        XCTAssertTrue(sendsBefore.waitForExistence(timeout: 30),
                      "the remaining-sends meter must render on the device")
        let before = sendsBefore.label

        app.buttons["Write a message"].tap()
        let field = element(beginningWith: "The message to send.", in: app)
        XCTAssertTrue(field.waitForExistence(timeout: 20), "the message field must exist")
        field.tap()
        field.typeText("physical validation message")

        let encrypt = app.buttons["Encrypt and consume the pad"]
        XCTAssertTrue(encrypt.waitForExistence(timeout: 10))
        encrypt.tap()

        // The envelope is shown only AFTER the durable commit. That ordering is
        // BURN-BEFORE-OUTPUT, and this is it observed on a handset.
        XCTAssertTrue(app.staticTexts["The encrypted message, as text you can copy."]
                        .waitForExistence(timeout: 60),
                      "an envelope must be produced")

        // FORCE-QUIT with a pad in the store, then relaunch.
        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 30))
        app.launch()
        assertRootRendered(app, "after a quit with durable state on disk")

        let row = element(beginningWith: label + ".", in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 60),
                      "the pad must survive process death — this is the durability claim")

        // AND THE CONSUMPTION MUST HAVE STUCK. If the meter read the same as it
        // did before the send, material would have been silently reusable.
        row.tap()
        let sendsAfter = element(containing: "You can still send", in: app)
        XCTAssertTrue(sendsAfter.waitForExistence(timeout: 30))
        XCTAssertNotEqual(sendsAfter.label, before,
                          "the consumed record must still be consumed after a relaunch — "
                          + "an unchanged meter would mean the burn did not persist")
    }

    // MARK: - 4. a refused destruction changes nothing

    /// The prompt must not hand over the answer, and a wrong confirmation must
    /// leave the pad exactly as it was. Checked on the real screen because this is
    /// the one irreversible verb in the app.
    func test04_TheDestroyPromptWithholdsTheIdentifierAndRefusesAWrongOne() {
        let app = launchFresh()
        let label = uniqueLabel("destroy-refusal")
        createDisposablePad(app, label: label)

        element(beginningWith: label + ".", in: app).tap()

        let destroyLink = app.buttons["Destroy this pad…"]
        XCTAssertTrue(destroyLink.waitForExistence(timeout: 30))
        destroyLink.tap()

        // THE PROMPT NEVER CONTAINS THE VALUE IT ASKS FOR. A prompt that shows the
        // identifier is not a confirmation, it is a copy exercise.
        XCTAssertTrue(app.staticTexts["Destroying a pad is permanent. Type the pad's identifier "
                                      + "to confirm. TruePad will not show it to you here."]
                        .waitForExistence(timeout: 20),
                      "the destroy prompt must be shown and must withhold the identifier")

        let confirm = app.textFields["Type the pad's identifier to confirm destruction. "
                                     + "TruePad will not show it to you here."]
        XCTAssertTrue(confirm.waitForExistence(timeout: 20))

        // The button is disabled until something is typed: no empty-tap destruction.
        XCTAssertFalse(app.buttons["Destroy this pad"].isEnabled,
                       "destruction must not be one stray tap away")

        confirm.tap()
        confirm.typeText("definitely-not-the-pair-id")
        app.buttons["Destroy this pad"].tap()

        XCTAssertTrue(app.alerts["TruePad refused"].waitForExistence(timeout: 30),
                      "a wrong confirmation must be refused")
        app.alerts["TruePad refused"].buttons["OK"].tap()

        // Back out and confirm the pad is untouched and still usable.
        app.navigationBars.buttons.firstMatch.tap()
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(element(beginningWith: label + ".", in: app).waitForExistence(timeout: 30),
                      "a refused destruction must leave the pad alone")
    }

    // MARK: - 5. the receive request is durable, and cancelling it is terminal

    func test05_AReceiveRequestSurvivesAQuitAndACancellationIsPermanent() {
        let app = launchFresh()
        app.tabBars.buttons["Receive"].tap()

        let create = app.buttons["Create a receive request"]
        XCTAssertTrue(create.waitForExistence(timeout: 30), "the Receive tab must offer a request")
        create.tap()

        // THE TWELVE WORDS MUST ACTUALLY RENDER. If the wordlist failed to load on
        // device, `WordGrid` refuses and shows the failure text instead — which is
        // the correct fail-closed behaviour, but it is NOT the good path, and a
        // test that accepted either would be asserting nothing.
        XCTAssertTrue(element(beginningWith: "Word 1:", in: app).waitForExistence(timeout: 30),
                      "the twelve comparison words must render on the device")
        XCTAssertTrue(element(beginningWith: "Word 12:", in: app).exists,
                      "all twelve must render, not the first few")
        XCTAssertFalse(app.staticTexts["The comparison words cannot be displayed. This transfer "
                                       + "cannot be confirmed on this device."].exists,
                       "the fail-closed path must NOT be the one taken on a working build")

        // The request's one-time key is durable: it must survive process death.
        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 30))
        app.launch()
        app.tabBars.buttons["Receive"].tap()
        XCTAssertTrue(app.buttons["Cancel this request"].waitForExistence(timeout: 45),
                      "a published request must survive a force-quit")

        app.buttons["Cancel this request"].tap()
        XCTAssertTrue(app.buttons["Create a receive request"].waitForExistence(timeout: 45),
                      "cancelling must leave the tab ready for a new request")

        // AND THE CANCELLATION IS TERMINAL. Checked across a relaunch so it is the
        // on-disk state being trusted, not anything still in memory.
        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 30))
        app.launch()
        app.tabBars.buttons["Receive"].tap()
        XCTAssertTrue(app.buttons["Create a receive request"].waitForExistence(timeout: 45),
                      "a cancelled request must not return as pending after a relaunch")
    }

    // MARK: - 6. the camera is not reached for until asked

    /// A permission dialog at launch teaches people to dismiss dialogs, and would
    /// mean the app touched the camera without being asked. Ordinary navigation
    /// must produce none.
    func test06_NoCameraPromptFromOrdinaryNavigation() {
        let app = launchFresh()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

        assertRootRendered(app)
        app.tabBars.buttons["Receive"].tap()
        XCTAssertTrue(app.buttons["Create a receive request"].waitForExistence(timeout: 30)
                        || app.buttons["Cancel this request"].exists)
        app.tabBars.buttons["About"].tap()
        XCTAssertTrue(app.staticTexts["The one-time pad encrypts messages."]
                        .waitForExistence(timeout: 20))
        app.tabBars.buttons["Pads"].tap()

        XCTAssertEqual(springboard.alerts.count, 0,
                       "no permission prompt may appear from ordinary navigation")
    }

    // MARK: - 7. the numbers that carry decisions are described, not recited

    /// NOT A VOICEOVER ASSESSMENT — see the type comment. This asserts the labels
    /// exist and say what the number MEANS. "59, 64, 7, 8" would pass a
    /// label-exists check and tell a blind operator nothing.
    func test07_DecisionCarryingElementsAreDescribedByMeaning() {
        let app = launchFresh()
        let label = uniqueLabel("a11y")
        createDisposablePad(app, label: label)

        element(beginningWith: label + ".", in: app).tap()

        XCTAssertTrue(element(containing: "You can still send", in: app)
                        .waitForExistence(timeout: 30),
                      "the remaining-sends meter must be described, not just numbered")
        XCTAssertTrue(element(containing: "bytes of pad material remain", in: app).exists,
                      "the pad-material meter must be described")
        XCTAssertTrue(element(containing: "authentication records", in: app).exists,
                      "the records meter must be described, including that each message uses one")
        XCTAssertTrue(element(containing: "Whichever runs out first", in: app).exists,
                      "the binding constraint must be stated")
        XCTAssertTrue(element(containing: "Deployment assessment", in: app).exists,
                      "the derived verdict must be announced as an assessment")
    }

    // MARK: - 8. the device-generated pad is labelled honestly

    /// The Create screen promises a device-generated pad reads NOT ELIGIBLE. This
    /// checks the app keeps that promise on the device itself, because a warning
    /// the product then contradicts is worse than no warning.
    func test08_ADeviceGeneratedPadReadsNotEligible() {
        let app = launchFresh()
        let label = uniqueLabel("verdict")
        createDisposablePad(app, label: label)

        element(beginningWith: label + ".", in: app).tap()
        XCTAssertTrue(app.staticTexts["NOT ELIGIBLE"].waitForExistence(timeout: 30),
                      "the pad must read exactly what the Create screen promised")
    }
}
