import XCTest

/// THE VISUAL PARITY EVIDENCE.
///
/// This bundle asserts almost nothing. Its job is to walk the five screens the
/// operator asked to see and photograph each one, so that the iPhone and the
/// Android handset can be held side by side and judged — which is a human
/// decision, not one a test can make. What it DOES assert is that each screen
/// actually rendered before it was photographed, because a screenshot of a blank
/// view is worse than no screenshot: it looks like evidence.
///
/// NOTHING HERE IS A CLAIM ABOUT SECURITY. It creates one disposable pad from the
/// device generator — so it reads NOT ELIGIBLE and destroying it costs nothing —
/// and touches no operational pad. It does not open a message, does not perform a
/// ceremony, and does not exercise the camera.
final class VisualParityScreenshots: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// A screen below the fold is ABSENT from the element tree, not merely
    /// off-screen — the same lesson the physical bundle records. Scroll first.
    @discardableResult
    private func reveal(_ target: XCUIElement, in app: XCUIApplication, swipes: Int = 8) -> Bool {
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

    /// Photograph the WHOLE SCREEN, not the app's element tree, so the navigation
    /// bar, the tab bar and the status bar are all in the frame — those are the
    /// surfaces the theme had to reach and the ones most likely to be missed.
    private func shoot(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testPhotographTheFiveScreens() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))

        // 1. HOME
        XCTAssertTrue(app.tabBars.buttons["Pads"].waitForExistence(timeout: 25),
                      "the Pads tab must render before it is photographed")
        let create = app.buttons["Create a pad"]
        XCTAssertTrue(reveal(create, in: app), "the primary action must be on the home screen")
        shoot("01-home")

        // 2. CREATE A PAD
        create.tap()
        let name = app.textFields["A name for this pad. It stays on this device."]
        XCTAssertTrue(name.waitForExistence(timeout: 10), "the create sheet must render")
        shoot("02-create-pad")

        // With the size options and the source claim visible, one screen further
        // down — this is where the radios and the disclosure live.
        app.swipeUp()
        shoot("02b-create-pad-scrolled")

        // 3. PAD DETAIL. A pad is needed to have one, so make a disposable one.
        XCTAssertTrue(reveal(name, in: app))
        name.tap()
        let label = "parity-\(Int(Date().timeIntervalSince1970))"
        name.typeText(label)
        let submit = app.buttons["Create pad"]
        XCTAssertTrue(reveal(submit, in: app), "the create button must be reachable")
        submit.tap()

        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", label)).firstMatch
        XCTAssertTrue(reveal(row, in: app, swipes: 10), "the new pad must appear in the list")
        shoot("01b-home-with-a-pad")
        row.tap()

        let write = app.buttons["Write a message"]
        XCTAssertTrue(reveal(write, in: app), "the pad screen must render")
        shoot("03-pad-detail")

        // 4. SEND A MESSAGE
        write.tap()
        let encrypt = app.buttons["Encrypt and consume the pad"]
        XCTAssertTrue(reveal(encrypt, in: app), "the send screen must render")
        shoot("04-send-message")

        // 5. RECEIVE. Back out of the stack rather than relaunching, so the tab
        // bar in the frame is the one the operator would be looking at.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(reveal(write, in: app), "returning to the pad screen")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        app.tabBars.buttons["Inbox"].tap()
        let receive = app.buttons["Create a receive code"]
        let cancel = app.buttons["Cancel this code"]
        XCTAssertTrue(reveal(receive, in: app) || reveal(cancel, in: app),
                      "the receive screen must render")
        shoot("05-receive")

        // 6. ABOUT — the claims boundary, which is the screen most sensitive to
        // wording being shortened to fit a layout.
        app.tabBars.buttons["About"].tap()
        XCTAssertTrue(app.staticTexts["The one-time pad encrypts messages."]
                        .waitForExistence(timeout: 10),
                      "the claims boundary must render verbatim")
        shoot("06-about")
    }
}
