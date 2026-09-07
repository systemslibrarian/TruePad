import XCTest

/// THE FIXED-RECORD PROPERTY, OBSERVED ON THE HANDSET.
///
/// The engine's §16 behaviour is proven on the JVM and again in the Swift suite.
/// What is not proven there is that ticking a box in the real create flow produces
/// a pad whose messages all cost the same amount of pad — and that is the thing an
/// operator actually experiences.
///
/// WHY THE METERS ARE THE PROBE, not the transport string. The envelope on the
/// Send screen carries an explicit accessibility label — deliberately, so a screen
/// reader does not spell out several hundred characters of transport — which means
/// its text is not readable from the element tree. The pad's own "Pad material
/// left" row IS readable, and it is the better evidence anyway: it is the
/// operator-visible consequence of the property. Two plaintexts of very different
/// lengths must cost exactly the same number of bytes.
///
/// Every pad created here is DISPOSABLE and device-generated, so it reads NOT
/// ELIGIBLE and costs nothing. No operational pad is touched.
final class FixedRecordSmokeTest: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    @discardableResult
    private func reveal(_ target: XCUIElement, in app: XCUIApplication, swipes: Int = 10) -> Bool {
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

    /// "N bytes of pad material remain, out of M." -> N
    private func padMaterialRemaining(in app: XCUIApplication) -> Int? {
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "bytes of pad material remain"))
            .firstMatch
        guard reveal(row, in: app) else { return nil }
        let label = row.label
        guard let r = label.range(of: "[0-9]+", options: .regularExpression) else { return nil }
        return Int(label[r])
    }

    /// Read the meter, opening "Security details" if it is not already showing.
    ///
    /// DELIBERATELY NOT DRIVEN BY THE DISCLOSURE'S REPORTED STATE. Keying on
    /// `value == "expanded"` made this depend on the very accessibility value the
    /// pass had just added, and on the disclosure being hittable at the moment it
    /// was asked — so a read could skip the tap and then find nothing. Looking for
    /// the meter first and only tapping when it is absent works whether the
    /// section is open, closed, or freshly rebuilt by a navigation.
    private func remainingBytes(in app: XCUIApplication) -> Int? {
        if let n = padMaterialRemaining(in: app) { return n }
        let details = app.buttons["Security details"]
        guard reveal(details, in: app) else { return nil }
        details.tap()
        return padMaterialRemaining(in: app)
    }

    private func send(_ message: String, in app: XCUIApplication) {
        let write = app.buttons["Write a message"]
        XCTAssertTrue(reveal(write, in: app), "the pad screen must offer Write a message")
        write.tap()

        let field = app.textViews["The message to send. It is encrypted with pad material "
                                  + "that is then destroyed."].firstMatch
        let target = field.exists ? field
            : app.textFields["The message to send. It is encrypted with pad material "
                             + "that is then destroyed."].firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 10), "the message field must render")
        target.tap()
        target.typeText(message)

        let encrypt = app.buttons["Encrypt and consume the pad"]
        XCTAssertTrue(reveal(encrypt, in: app), "the encrypt control must be reachable")
        encrypt.tap()

        // EXPLICIT CONTROLS FOR PUBLIC TRANSPORT MATERIAL.
        XCTAssertTrue(reveal(app.buttons["Copy"], in: app),
                      "the encrypted message has no explicit Copy control")
        XCTAssertTrue(app.buttons["Share"].exists,
                      "the encrypted message has no explicit Share control")
        XCTAssertTrue(reveal(app.buttons["Technical form"], in: app),
                      "the canonical JSON is no longer reachable")

        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    func testTwoMessagesOfDifferentLengthsCostTheSamePad() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        XCTAssertTrue(app.tabBars.buttons["Pads"].waitForExistence(timeout: 25))

        // ---- create a 256-byte fixed-record pad, through the real screen ----
        let create = app.buttons["Create a pad"]
        XCTAssertTrue(reveal(create, in: app))
        create.tap()

        let name = app.textFields["A name for this pad. It stays on this device."]
        XCTAssertTrue(name.waitForExistence(timeout: 10), "the create sheet must render")
        let label = "fixed-\(Int(Date().timeIntervalSince1970))"
        name.tap()
        name.typeText(label)

        // LENGTH PRIVACY LIVES UNDER "ADVANCED", collapsed by default.
        let advanced = app.buttons["Advanced"]
        XCTAssertTrue(reveal(advanced, in: app), "the Advanced disclosure must be reachable")
        advanced.tap()

        let hide = app.switches["Hide exact message lengths"]
        XCTAssertTrue(reveal(hide, in: app), "the fixed-length control is missing")
        // ASSERT THE TOGGLE ACTUALLY FLIPPED. A tap that lands on a SwiftUI
        // Toggle's label rather than its switch is silently a no-op, and the first
        // run of this test failed further down looking for a field that never
        // appeared — which reads as a missing control rather than an unflipped
        // switch. Checking the value turns that into a truthful failure.
        if hide.value as? String != "1" {
            hide.switches.firstMatch.exists ? hide.switches.firstMatch.tap() : hide.tap()
        }
        if hide.value as? String != "1" {
            hide.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        }
        XCTAssertEqual(hide.value as? String, "1",
                       "the fixed-length toggle did not turn on")
        shoot("01-create-fixed-length")

        // The field already offers 256, which is exactly what this pad wants.
        let size = app.textFields["Message size in bytes. Every message will use exactly "
                                  + "this much of the pad."]
        XCTAssertTrue(reveal(size, in: app), "the message size field did not appear")
        XCTAssertEqual(size.value as? String, "256",
                       "the offered fixed size is not the documented default")

        let submit = app.buttons["Create pad"]
        XCTAssertTrue(reveal(submit, in: app))
        XCTAssertTrue(submit.isEnabled, "Create is disabled with a valid 256-byte record size")
        submit.tap()

        // ---- open it ----
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", label)).firstMatch
        XCTAssertTrue(reveal(row, in: app, swipes: 12), "the new pad must appear in the list")
        row.tap()

        let readBefore = remainingBytes(in: app)
        if readBefore == nil { shoot("00-meter-unreadable") }
        let before = try XCTUnwrap(readBefore, "could not read the pad material meter")
        shoot("02-pad-detail-before")

        // ---- two plaintexts of clearly different lengths, both of which fit ----
        send("hi", in: app)
        let afterShort = try XCTUnwrap(remainingBytes(in: app))

        send("this one is a great deal longer than the other, on purpose", in: app)
        let afterLong = try XCTUnwrap(remainingBytes(in: app))
        shoot("03-pad-detail-after")

        let firstCost = before - afterShort
        let secondCost = afterShort - afterLong
        XCTAssertGreaterThan(firstCost, 0, "the first message consumed nothing")
        XCTAssertEqual(firstCost, secondCost,
                       "a two-character message and a fifty-eight-character message cost "
                       + "\(firstCost) and \(secondCost) bytes, so the fixed-record property does "
                       + "not hold on this device")
        XCTAssertEqual(firstCost, 256,
                       "each message cost \(firstCost) bytes, not the 256 that was asked for")
    }

    /// THE RECEIVE CODE HAS EXPLICIT CONTROLS TOO.
    ///
    /// Public transport material, like the encrypted message — and until this pass
    /// the iPhone offered neither, leaving the operator to select the text by hand.
    /// This publishes a request, checks the controls, and cancels it again; it does
    /// NOT perform a transfer and does not re-run the ceremony.
    func testTheReceiveCodeOffersCopyAndShare() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        app.tabBars.buttons["Inbox"].tap()

        // Start from a known state: drain anything a previous run published.
        var guardCount = 0
        while reveal(app.buttons["Cancel this code"], in: app, swipes: 4), guardCount < 6 {
            app.buttons["Cancel this code"].tap()
            guardCount += 1
        }

        let create = app.buttons["Create a receive code"]
        XCTAssertTrue(reveal(create, in: app), "the receive screen must offer a new code")
        create.tap()

        XCTAssertTrue(reveal(app.buttons["Copy code"], in: app),
                      "the receive code has no explicit Copy control")
        XCTAssertTrue(app.buttons["Share code"].exists,
                      "the receive code has no explicit Share control")
        shoot("04-receive-code-controls")

        // Leave the device as it was found.
        let cancel = app.buttons["Cancel this code"]
        if reveal(cancel, in: app) { cancel.tap() }
    }
}
