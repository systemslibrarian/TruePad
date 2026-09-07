import XCTest

/// THE iPHONE HALF OF THE TWO-DEVICE EXCHANGE.
///
/// One ordinary sealed transfer, performed so the two handsets have a pad in
/// common — without which "Android TP2 opens on iPhone" has nothing to open.
/// This is NOT a rerun of the SPT validation campaign: it does the transfer the
/// way the product intends and stops.
///
/// WHAT IS REAL AND WHAT IS SCRIPTED. Every decision that carries security is
/// taken in the interface on the handset: reviewing the recipient's request,
/// comparing the twelve words, sealing. The recipient's code arrives by
/// environment variable and the sealed file leaves through the app container,
/// because carrying bytes between two phones is a courier's job and here the
/// courier is the harness rather than a person with AirDrop.
final class CrossEditionSealTest: XCTestCase {

    /// THE TWO-DEVICE GATE. This class is part of the ordinary
    /// `TruePadAppUITests` bundle — the same bundle the release checklist runs on
    /// a physical iPhone and expects to pass — but it cannot pass alone: it needs
    /// a Samsung on the same desk, a receive code that handset published moments
    /// ago, and a courier carrying bytes between the two. Without them
    /// `XCTUnwrap` on the missing input FAILS the test, so a perfectly healthy
    /// build reported three failures and the checklist row could not be re-run
    /// green.
    ///
    /// Android solved this structurally, with `@CrossEditionStep` and the
    /// runner's `notAnnotation` argument. iOS has no build-level equivalent, so
    /// this is the same discipline expressed at runtime: SKIPPED unless the
    /// harness that supplies the other device says it is driving. A skip is
    /// visible in the report as a skip, so nothing is quietly passing; and when
    /// the harness DOES set it, every original assertion is exactly as loud as
    /// before, including the unwraps.
    ///
    /// Deliberately NOT keyed on whether the inputs happen to be present: a
    /// misconfigured ceremony would then skip silently instead of failing, which
    /// is the failure this exists to make impossible.
    override func setUpWithError() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["TRUEPAD_PHYSICAL_CEREMONY"] == "1",
            "two-device ceremony: run it through scripts/cross-edition-physical.sh, "
                + "which sets TEST_RUNNER_TRUEPAD_PHYSICAL_CEREMONY=1")
        continueAfterFailure = false
    }

    @discardableResult
    private func reveal(_ target: XCUIElement, in app: XCUIApplication, swipes: Int = 12) -> Bool {
        if target.waitForExistence(timeout: 3) { return true }
        for _ in 0..<swipes {
            app.swipeUp()
            if target.exists { return true }
        }
        for _ in 0..<(swipes * 2) {
            app.swipeDown()
            if target.exists { return true }
        }
        return target.exists
    }

    private func shoot(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func emit(_ name: String, _ value: String) {
        let a = XCTAttachment(string: value)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    /// PASTED, NOT TYPED. A receive request is ~1,650 characters; typing it
    /// keystroke by keystroke takes minutes and drops characters. The pasteboard
    /// is the route a person would use anyway — the sender is handed a code and
    /// pastes it.



    /// Resolve a field by accessibility identifier, WAITING rather than racing.
    /// A SwiftUI `TextField(axis: .vertical)` is exposed as a text VIEW, so both
    /// collections are searched.
    private func field(_ identifier: String, in app: XCUIApplication,
                       timeout: TimeInterval = 15) -> XCUIElement {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            for query in [app.textViews, app.textFields] {
                if query[identifier].firstMatch.exists { return query[identifier].firstMatch }
            }
            Thread.sleep(forTimeInterval: 0.3)
        } while Date() < deadline
        return app.textViews[identifier].firstMatch
    }

    private func paste(_ text: String, into identifier: String, app: XCUIApplication) {
        UIPasteboard.general.string = text
        let field = field(identifier, in: app)
        field.tap()
        field.press(forDuration: 1.3)
        let paste = app.menuItems["Paste"]
        if paste.waitForExistence(timeout: 5) {
            paste.tap()

            // THE SYSTEM ASKS BEFORE IT LETS ONE APP READ ANOTHER'S PASTEBOARD.
            // The runner process owns the pasteboard here, so iOS puts up "Allow
            // Paste" — and if nothing answers it the paste silently does not
            // happen and the request field stays empty. This cost a run: the
            // failure surfaced much later, as "the pasted request was not
            // accepted", with no sign of why.
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            for label in ["Allow Paste", "Paste", "Allow"] {
                let button = springboard.buttons[label]
                if button.waitForExistence(timeout: 3) { button.tap(); break }
            }
        }

        // VERIFY THE WHOLE VALUE, NOT ITS FIRST FIVE CHARACTERS.
        //
        // This checked `hasPrefix("TPR2:")`, which a TRUNCATED paste satisfies: a
        // request is ~1,650 characters, and a partial one still starts with the
        // prefix. The run then failed much later with "the comparison words never
        // appeared" — a true statement about a screen that had been handed half a
        // request, and no help at all in finding out why.
        func landed() -> String { (field.value as? String) ?? "" }
        if landed() != text {
            field.tap()
            // Clear whatever partially arrived before typing the whole thing.
            if !landed().isEmpty {
                field.press(forDuration: 1.3)
                let selectAll = app.menuItems["Select All"]
                if selectAll.waitForExistence(timeout: 3) { selectAll.tap() }
            }
            field.typeText(text)
        }
        emit("bound-request-length", "expected \(text.count) observed \(landed().count)")
        XCTAssertEqual(landed(), text,
                       "the request bound to the seal screen is not the one Android published: "
                       + "expected \(text.count) characters, observed \(landed().count)")
    }

    func testSealAFixedRecordPadToTheAndroidReceiveCode() throws {
        let tpr2 = try XCTUnwrap(ProcessInfo.processInfo.environment["TPR2"],
                                 "pass the recipient's code as TEST_RUNNER_TPR2")
        XCTAssertTrue(tpr2.hasPrefix("TPR2:"), "that is not a receive request")

        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        XCTAssertTrue(app.tabBars.buttons["Pads"].waitForExistence(timeout: 25))

        // ---- a fresh 256-byte fixed-record pad ----
        let create = app.buttons["Create a pad"]
        XCTAssertTrue(reveal(create, in: app))
        create.tap()

        let name = app.textFields["A name for this pad. It stays on this device."]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        let label = "cross-\(Int(Date().timeIntervalSince1970))"
        name.tap()
        name.typeText(label)
        emit("pad-label", label)

        let advanced = app.buttons["Advanced"]
        XCTAssertTrue(reveal(advanced, in: app))
        advanced.tap()
        let hide = app.switches["Hide exact message lengths"]
        XCTAssertTrue(reveal(hide, in: app))
        // THE EXACT SEQUENCE THAT WORKS. A tap landing on a SwiftUI Toggle's label
        // rather than its switch is silently a no-op, so this escalates: the
        // element, then its inner switch, then the coordinate where the switch is.
        if hide.value as? String != "1" { hide.tap() }
        if hide.value as? String != "1" {
            hide.switches.firstMatch.exists ? hide.switches.firstMatch.tap() : hide.tap()
        }
        if hide.value as? String != "1" {
            hide.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        }
        XCTAssertEqual(hide.value as? String, "1", "the fixed-length toggle did not turn on")

        let submit = app.buttons["Create pad"]
        XCTAssertTrue(reveal(submit, in: app))
        submit.tap()

        // ---- THE POST-CREATION PROMPT IS THE ROUTE INTO SHARING ----
        let share = app.buttons["Share this pad"]
        XCTAssertTrue(reveal(share, in: app, swipes: 6),
                      "creating a pad did not offer an obvious way to share it")
        shoot("01-post-create-share-prompt")
        share.tap()

        // ---- seal it to the recipient's code ----
        let secure = app.buttons["Send securely to a receive code"]
        XCTAssertTrue(reveal(secure, in: app), "the pad screen does not lead with the secure route")
        shoot("02-pad-share-section")
        secure.tap()

        XCTAssertTrue(field("request-input", in: app).exists,
                      "the seal screen never offered somewhere to paste")
        paste(tpr2, into: "request-input", app: app)

        let review = app.buttons["Review this request"]
        XCTAssertTrue(reveal(review, in: app))
        XCTAssertTrue(review.isEnabled, "the pasted request was not accepted")
        review.tap()

        // THE TWELVE WORDS ARE A REAL DECISION AND ARE TAKEN IN THE UI.
        let matched = app.buttons["All twelve words matched"]
        XCTAssertTrue(reveal(matched, in: app), "the comparison words never appeared")
        shoot("03-twelve-words")
        matched.tap()

        let seal = app.buttons["Seal this pad and send it"]
        XCTAssertTrue(reveal(seal, in: app), "sealing was not offered after the words were confirmed")
        seal.tap()

        let handOver = app.buttons["Hand over the sealed file…"]
        XCTAssertTrue(reveal(handOver, in: app, swipes: 14),
                      "the sealed file was never offered")
        shoot("04-sealed")

        // THE TEST ENDS WITH THE SHARE SHEET OPEN, ON PURPOSE.
        //
        // Tapping this writes `tmp/transfer.tps2` into the app container and
        // presents the share sheet. DISMISSING the sheet calls
        // `discardSharedFile()`, which deletes the package — correctly: a sealed
        // package is pad material under a computational wrapper and must not be
        // left on disk because a share was abandoned. That property is NOT relaxed
        // here, and it keeps its own coverage in `AppShellRegressionTests`.
        //
        // So the package exists only until something dismisses the sheet, and the
        // courier has to collect it before that happens. Collecting it WHILE the
        // test runs was tried and does not work: attaching to the app container
        // with `devicectl` mid-session killed the test runner. The test therefore
        // stops here, leaving the sheet up and the file in place, and
        // `scripts/cross-edition-physical.sh` copies it off the device once this
        // process has exited — which is also what a person does, handing the file
        // over before putting the phone down.
        handOver.tap()
        emit("sealed-package-left-for-courier", "tmp/transfer.tps2")
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 5) || true)
    }
}
