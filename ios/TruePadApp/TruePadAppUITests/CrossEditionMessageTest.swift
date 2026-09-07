import XCTest
import CommonCrypto

/// THE iPHONE'S MESSAGING HALF OF THE TWO-DEVICE EXCHANGE.
///
/// Runs against the pad the seal step placed on both handsets. It opens what the
/// Samsung wrote — in both spellings — and then writes one of its own for the
/// Samsung to open.
///
/// EVERYTHING IS THE REAL UI. The envelopes arrive as text the operator pastes,
/// exactly as they would from a messaging app, and the one this device sends is
/// read back from the pasteboard through its own Copy control — so what the
/// harness carries is precisely what the operator would have handed over.
final class CrossEditionMessageTest: XCTestCase {

    /// SHA-256 of a string, so the harness can state exactly what reached the
    /// binding rather than describing it.
    static func sha(_ s: String) -> String {
        var hash = [UInt8](repeating: 0, count: 32)
        let data = Array(s.utf8)
        CC_SHA256(data, CC_LONG(data.count), &hash)
        return hash.map { String(format: "%02x", $0) }.joined()
    }

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

    private func emit(_ name: String, _ value: String) {
        let a = XCTAttachment(string: value)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    private func env(_ key: String) throws -> String {
        try XCTUnwrap(ProcessInfo.processInfo.environment[key], "pass TEST_RUNNER_\(key)")
    }

    /// PASTED, NOT TYPED, and then CHECKED.
    ///
    /// The system asks before it lets one app read another's pasteboard, and the
    /// runner process owns the pasteboard here — so iOS puts up "Allow Paste". If
    /// nothing answers it the paste silently does not happen, the field stays
    /// empty, and the failure surfaces much later as an envelope that would not
    /// open. That is exactly how it presented: `nil` from `open()`, reported as
    /// "the compact message from Android did not open to what it sent", which
    /// reads like a cross-edition incompatibility and is not one.
    /// THE FIELD IS RE-RESOLVED, NEVER HELD.
    ///
    /// Whether "Paste it here" is a TextField or a TextView is not knowable until
    /// the screen has rendered, and SwiftUI may swap it once it has content — so a
    /// reference captured up front goes stale, and reading `.value` from it fails
    /// with "no matches found" rather than anything that names the real problem.
    /// This cost a run. Every use resolves the field again.
    /// ADDRESSED BY IDENTIFIER, NOT BY PLACEHOLDER.
    ///
    /// "Paste it here" is the field's PLACEHOLDER, and a placeholder stops
    /// existing the moment the field has content. Re-resolving by it after entry
    /// therefore matches nothing, reads back empty, and reports that the text
    /// never arrived — which is what the previous oracle did, and why the Seal
    /// screen appeared to work while the Open screen appeared to fail. The two
    /// controls are identical; only the two tests differed.
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

    private func text(of identifier: String, in app: XCUIApplication) -> String {
        let element = field(identifier, in: app, timeout: 2)
        guard element.exists else { return "" }
        return (element.value as? String) ?? ""
    }



    /// Put text on the pasteboard and have the APP paste it into its own field.
    ///
    /// The runner writing to the pasteboard needs no permission; only reading what
    /// another app wrote does. The field is resolved here, at the moment it is
    /// used, rather than passed in from a caller that may have looked it up before
    /// the screen settled.
    private func paste(_ text: String, into identifier: String, app: XCUIApplication) {
        UIPasteboard.general.string = text
        let field = field(identifier, in: app)
        field.tap()
        field.press(forDuration: 1.3)
        let paste = app.menuItems["Paste"]
        if paste.waitForExistence(timeout: 5) {
            paste.tap()
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            for label in ["Allow Paste", "Paste", "Allow"] {
                let button = springboard.buttons[label]
                if button.waitForExistence(timeout: 3) { button.tap(); break }
            }
        }

        // Read it back rather than trusting the taps. Typing is the fallback: slow,
        // but the difference between a run and a mystery.
        let head = String(text.prefix(12))
        if !self.text(of: identifier, in: app).hasPrefix(head) {
            let again = self.field(identifier, in: app, timeout: 5)
            again.tap()
            again.typeText(text)
        }
        // AN OBJECTIVE COMPARISON AT THE BOUNDARY THE OPEN ACTION CONSUMES.
        // Digests, not prefixes: this says whether the exact bytes Android
        // produced are the exact bytes bound to this screen.
        let bound = self.text(of: identifier, in: app)
        emit("bound-input-length", "expected \(text.count) observed \(bound.count)")
        emit("bound-input-sha256", "expected \(Self.sha(text)) observed \(Self.sha(bound))")
        XCTAssertEqual(Self.sha(bound), Self.sha(text),
                       "what is bound to the Open screen is not what Android produced: "
                       + "expected \(text.count) chars, observed \(bound.count)")
    }

    private func openPad(_ label: String, in app: XCUIApplication) {
        app.tabBars.buttons["Pads"].tap()
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", label)).firstMatch
        XCTAssertTrue(reveal(row, in: app, swipes: 14), "the shared pad \(label) is not on this device")
        row.tap()
    }

    /// Open one envelope and return the plaintext the screen shows.
    ///
    /// The opened message carries its text in its accessibility label — "The
    /// opened message: …" — which is deliberate and is what lets this be checked
    /// without the harness ever touching the engine.
    private func open(_ envelope: String, in app: XCUIApplication) -> String? {
        let openLink = app.buttons["Open a message"]
        XCTAssertTrue(reveal(openLink, in: app), "the pad screen offers no way to open a message")
        openLink.tap()

        XCTAssertTrue(field("envelope-input", in: app).exists,
                      "the open-a-message screen never offered somewhere to paste")
        paste(envelope, into: "envelope-input", app: app)

        let go = app.buttons["Open"]
        XCTAssertTrue(reveal(go, in: app))
        go.tap()

        let shown = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "The opened message: ")).firstMatch
        guard reveal(shown, in: app) else { return nil }
        return String(shown.label.dropFirst("The opened message: ".count))
    }


    /// Read back what a Copy control put on the clipboard, WITHOUT the runner ever
    /// reading another app's pasteboard.
    ///
    /// `UIPasteboard.general` belongs to TruePad once TruePad has written to it,
    /// and a UI-test runner is a different app: iOS refuses that read, and the
    /// "Allow Paste" prompt is not reliably reachable from the runner either. So
    /// the app pastes its own clipboard into its own field — no permission is
    /// involved, because nothing crosses an app boundary — and the harness reads
    /// the field's accessibility value, which is the ordinary way a test observes
    /// a text field.
    ///
    /// The value read back is therefore exactly what the operator's Copy produced.
    private func copyThenReadBack(_ copyButton: XCUIElement,
                                  expecting prefix: String,
                                  in app: XCUIApplication) -> String {
        XCTAssertTrue(reveal(copyButton, in: app), "the Copy control is missing")
        copyButton.tap()

        // Go somewhere with a field the app can paste into, and paste there.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let openLink = app.buttons["Open a message"]
        XCTAssertTrue(reveal(openLink, in: app))
        openLink.tap()

        let field = field("envelope-input", in: app)
        XCTAssertTrue(field.exists, "the paste field never appeared")
        field.tap()
        field.press(forDuration: 1.3)
        let paste = app.menuItems["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 8), "the app could not paste its own clipboard")
        paste.tap()

        var text = ""
        for _ in 0..<20 {
            text = (field.value as? String) ?? ""
            if text.hasPrefix(prefix) { break }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(text.hasPrefix(prefix),
                      "Copy did not hand over a value beginning \(prefix): \(text.prefix(24))")
        // Leave without opening: this envelope is for the other handset.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        return text
    }

    /// THE CANONICAL LEG ON ITS OWN.
    ///
    /// Separate from the combined walk so that a failure late in that walk does not
    /// force replaying envelopes the other handset has already opened — a record is
    /// one-time, and a replay is correctly refused. This sends a FRESH message and
    /// takes its canonical spelling through the Technical form's own Copy control.
    func testSendCanonicalFormOnly() throws {
        let label = try env("PAD")
        let message = ProcessInfo.processInfo.environment["JSON_MESSAGE"]
            ?? "the iPhone in canonical form"

        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        XCTAssertTrue(app.tabBars.buttons["Pads"].waitForExistence(timeout: 25))
        openPad(label, in: app)

        let write = app.buttons["Write a message"]
        XCTAssertTrue(reveal(write, in: app))
        write.tap()

        // FOUND BY ITS ACCESSIBILITY LABEL, not by a new identifier. The shipping
        // set of identifiers is deliberately two, and adding a third to make a
        // test easier is exactly the drift the guard exists to stop.
        let messageLabel = "The message to send. It is encrypted with pad material "
            + "that is then destroyed."
        var target = app.textViews[messageLabel].firstMatch
        if !target.waitForExistence(timeout: 15) {
            target = app.textFields[messageLabel].firstMatch
            _ = target.waitForExistence(timeout: 10)
        }
        XCTAssertTrue(target.exists, "the message field never appeared")
        target.tap()
        target.typeText(message)

        let encrypt = app.buttons["Encrypt and consume the pad"]
        XCTAssertTrue(reveal(encrypt, in: app))
        encrypt.tap()

        let technical = app.buttons["Technical form"]
        XCTAssertTrue(reveal(technical, in: app), "the canonical form is not reachable")
        technical.tap()

        let json = copyThenReadBack(app.buttons["Copy JSON"], expecting: "{", in: app)
        emit("iphone-json", json)
    }

    func testOpenBothSpellingsFromAndroidThenSendBack() throws {
        let label = try env("PAD")
        let androidTp2 = try env("ANDROID_TP2")
        let androidJson = try env("ANDROID_JSON")
        let expectTp2 = try env("EXPECT_TP2")
        let expectJson = try env("EXPECT_JSON")
        let message = ProcessInfo.processInfo.environment["MESSAGE"] ?? "hello from the iPhone"
        let jsonMessage = ProcessInfo.processInfo.environment["JSON_MESSAGE"]
            ?? "the iPhone in canonical form"

        XCTAssertTrue(androidTp2.hasPrefix("TP2:"), "the Samsung's message is not compact")

        // THE CONSUMER PROVES IT RECEIVED THE PRODUCER'S EXACT BYTES.
        // The courier hashes on both sides, but a hash the courier checks against
        // itself is weaker than one the consuming edition checks on arrival. If a
        // digest was supplied, this side must agree with it before anything else.
        if let expectedSha = ProcessInfo.processInfo.environment["ANDROID_TP2_SHA"], !expectedSha.isEmpty {
            XCTAssertEqual(Self.sha(androidTp2), expectedSha,
                           "what reached this iPhone is not what Android produced")
        }
        XCTAssertTrue(androidJson.hasPrefix("{"), "the Samsung's canonical envelope is not JSON")

        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        XCTAssertTrue(app.tabBars.buttons["Pads"].waitForExistence(timeout: 25))

        // ---- the Samsung's TP2 opens here ----
        openPad(label, in: app)
        XCTAssertEqual(open(androidTp2, in: app), expectTp2,
                       "the compact message from Android did not open to what it sent")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // ---- and so does its canonical JSON, on a DIFFERENT message ----
        //
        // A different one on purpose: a record is one-time, so opening both
        // spellings of the SAME message would be refused — correctly — and would
        // prove nothing about the spelling.
        XCTAssertEqual(open(androidJson, in: app), expectJson,
                       "canonical JSON from Android did not open on this device")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // ---- now write one back ----
        let write = app.buttons["Write a message"]
        XCTAssertTrue(reveal(write, in: app))
        write.tap()

        let field = app.textViews["The message to send. It is encrypted with pad material "
                                  + "that is then destroyed."].firstMatch
        let target = field.exists ? field
            : app.textFields["The message to send. It is encrypted with pad material "
                             + "that is then destroyed."].firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 10))
        target.tap()
        target.typeText(message)

        let encrypt = app.buttons["Encrypt and consume the pad"]
        XCTAssertTrue(reveal(encrypt, in: app))
        encrypt.tap()

        // EXACTLY WHAT THE OPERATOR WOULD HAND OVER: the value the Copy control
        // puts on the pasteboard, read back from it.
        let carried = copyThenReadBack(app.buttons["Copy"], expecting: "TP2:", in: app)
        emit("iphone-tp2", carried)

        // ---- a SECOND message, taken in its canonical spelling ----
        //
        // A different message on purpose: a record is one-time, so the other
        // handset cannot open both spellings of the same one.
        //
        // NO BACK TAP HERE. `copyThenReadBack` already returns to the pad screen;
        // popping again landed on the pad LIST, where "Write a message" does not
        // exist — which is what broke this leg the first time.
        let write2 = app.buttons["Write a message"]
        XCTAssertTrue(reveal(write2, in: app))
        write2.tap()

        let field2 = app.textViews["The message to send. It is encrypted with pad material "
                                   + "that is then destroyed."].firstMatch
        let target2 = field2.exists ? field2
            : app.textFields["The message to send. It is encrypted with pad material "
                             + "that is then destroyed."].firstMatch
        XCTAssertTrue(target2.waitForExistence(timeout: 10))
        target2.tap()
        target2.typeText(jsonMessage)

        let encrypt2 = app.buttons["Encrypt and consume the pad"]
        XCTAssertTrue(reveal(encrypt2, in: app))
        encrypt2.tap()

        // THE TECHNICAL FORM, through its own Copy control — the same path an
        // operator uses when a channel mangles the compact spelling.
        let technical = app.buttons["Technical form"]
        XCTAssertTrue(reveal(technical, in: app), "the canonical form is not reachable")
        technical.tap()
        let json = copyThenReadBack(app.buttons["Copy JSON"], expecting: "{", in: app)
        emit("iphone-json", json)
    }
}
