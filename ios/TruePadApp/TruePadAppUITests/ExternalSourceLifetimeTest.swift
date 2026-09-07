import XCTest

/// THE ONE THING A HOST TEST CANNOT ANSWER about the create sheet's ownership.
///
/// `ExternalSourceIntakeTests` proves the SOURCE says `@StateObject` and that
/// nothing assigns `source = .device`. It cannot prove what SwiftUI actually does
/// with that declaration on a real device, because `TruePadUI` is `#if os(iOS)`
/// and never compiles under `swift test` on macOS. The defect this guards against
/// was a LIFETIME defect — the model was rebuilt by the runtime, not by any line
/// of code — so only the runtime can confirm it is fixed.
///
/// WHAT IS BEING PROTECTED. An operator who selects "use external random
/// material", leaves to fetch the file, and comes back must not find the app
/// quietly showing "generate for me" again. Creating at that point would produce
/// a device-CSPRNG pad — permanently NOT ELIGIBLE — that the operator believed
/// was built from their own material. TruePad must never make that substitution
/// silently.
///
/// NO PAD IS CREATED HERE, and no file is chosen: the test drives the selection,
/// forces the transitions that used to destroy it, and reads the screen back.
///
/// MUTATION-PROVEN ON THE HANDSET. With `RootView` reverted to the exact pre-fix
/// construction — `CreatePadView(model: CreatePadModel(engine: engine))` inside
/// the sheet closure — this test FAILS on an iPhone 12 / iOS 18.6.2 at the
/// backgrounding assertion, with the screen back on device-generated material.
///
/// AND IT FAILS THERE, NOT AT THE PICKER. In the mutated build the picker round
/// trip alone still passed: presenting and dismissing the document picker did not
/// by itself re-evaluate the root's body. It is the background/foreground cycle
/// that does, because the root reads `scenePhase` for the privacy cover. That is
/// worth knowing — a test that only opened and closed the picker would have
/// reported this defect fixed while it was still present.
final class ExternalSourceLifetimeTest: XCTestCase {

    override func setUp() { continueAfterFailure = false }

    /// Keep what the screen looked like, so a later reader is not taking the
    /// assertions' word for it.
    private func screenshot(_ app: XCUIApplication, _ name: String) -> XCTAttachment {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        return a
    }

    /// Bring an element into existence in a LAZY SwiftUI Form.
    ///
    /// A `Form` is backed by a lazy collection view: rows below the fold are not
    /// merely off-screen, they are ABSENT FROM THE TREE. A plain
    /// `waitForExistence` on the Advanced disclosure therefore fails forever no
    /// matter how long it waits — the first run of this test spent 24 seconds
    /// proving exactly that.
    @discardableResult
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, swipes: Int = 6) -> Bool {
        if element.exists && element.isHittable { return true }
        for _ in 0..<swipes {
            if element.exists && element.isHittable { return true }
            app.swipeUp(velocity: .slow)
        }
        return element.exists && element.isHittable
    }

    private func openAdvancedCreateSheet() -> XCUIApplication {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        XCTAssertTrue(app.tabBars.buttons["Pads"].waitForExistence(timeout: 25),
                      "the root must render")
        app.tabBars.buttons["Pads"].tap()

        let add = app.buttons["Create a pad"]
        XCTAssertTrue(add.waitForExistence(timeout: 20), "the create affordance must exist")
        add.tap()
        XCTAssertTrue(app.textFields["A name for this pad. It stays on this device."]
                        .waitForExistence(timeout: 20), "the create sheet must appear")

        // A SwiftUI DisclosureGroup in a Form is not reliably a `button`. Try the
        // shapes it actually takes, and print the tree if none match rather than
        // failing with nothing to act on.
        for q in [app.buttons["Advanced"], app.staticTexts["Advanced"],
                  app.otherElements["Advanced"]] {
            if reveal(q, in: app) { q.tap(); return app }
        }
        XCTFail("no reachable element labelled Advanced. Tree:\n\(app.debugDescription)")
        return app
    }

    /// Select external material, then force the transitions that used to discard
    /// it: the file importer opening and closing, and a real background/foreground
    /// cycle. The selection must survive both.
    func testTheChosenSourceSurvivesThePickerAndABackgroundCycle() {
        let app = openAdvancedCreateSheet()

        let external = app.buttons["Use external random material"]
        XCTAssertTrue(reveal(external, in: app),
                      "the external-material option must be offered")
        external.tap()

        // The declaration field only exists on the external branch, so its
        // presence is the screen's own statement of which source is selected.
        let declaration = app.textFields["Where these bytes came from. Your own note."]
        XCTAssertTrue(reveal(declaration, in: app),
                      "choosing external material must ask where the bytes came from")
        declaration.tap()
        declaration.typeText("hardware TRNG, run 7")

        // --- transition 1: the file importer opens and is dismissed ------------
        let choose = app.buttons["Choose a file…"]
        XCTAssertTrue(reveal(choose, in: app), "the file button must exist")
        choose.tap()

        // THE PICKER IS ANOTHER PROCESS. `.fileImporter` presents
        // UIDocumentPickerViewController, which is hosted out of process, so none
        // of it appears in `app`'s element tree. Querying `app.buttons["Cancel"]`
        // here finds the CREATE SHEET's own Cancel and tapping it would dismiss
        // the very screen under test — a green run that proved nothing, or a red
        // one blaming the wrong thing.
        // PROVE SOMETHING WAS ACTUALLY PRESENTED. Without this the test would pass
        // identically if `.fileImporter` were wired to nothing at all: tap a
        // button, background the app, come back, find the field intact. The
        // declaration field belongs to the create sheet; if a modal is covering
        // that sheet it stops being hittable while remaining in the tree.
        XCTAssertTrue(declaration.exists, "the create sheet must still be present")
        var covered = false
        for _ in 0..<20 {
            if !declaration.isHittable { covered = true; break }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(covered,
                      "nothing was presented over the create sheet after tapping the file "
                      + "button — the picker never opened, so this test would be proving "
                      + "nothing about a picker round trip")
        add(screenshot(app, "picker-presented"))

        // DISMISSING IT IS THE AWKWARD PART, and worth recording why. Pressing
        // Home and reactivating does NOT close the picker — the app returns with
        // it still presented, which is how an earlier version of this test failed.
        // The picker's own Cancel lives in a process the test cannot always
        // address by bundle id, so the reliable route is the sheet gesture, which
        // is delivered to whatever is frontmost.
        var route = "none"
        for id in ["com.apple.DocumentManagerUICore", "com.apple.DocumentsApp"] {
            let cancel = XCUIApplication(bundleIdentifier: id).buttons["Cancel"].firstMatch
            if cancel.waitForExistence(timeout: 5) { cancel.tap(); route = "picker Cancel (\(id))"; break }
        }
        if route == "none" {
            for _ in 0..<3 where !declaration.isHittable {
                app.swipeDown(velocity: .fast)
                Thread.sleep(forTimeInterval: 1.5)
            }
            route = "swipe-down dismissal"
        }
        XCTContext.runActivity(named: "picker dismissed via \(route)") { _ in }

        // And it must be interactive again once the picker is gone.
        var uncovered = false
        for _ in 0..<40 {
            if declaration.exists && declaration.isHittable { uncovered = true; break }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertTrue(uncovered,
                      "the create sheet never became interactive again — the picker was not "
                      + "dismissed, so the return half of the round trip did not happen. "
                      + "Tree:\n\(app.debugDescription)")
        add(screenshot(app, "after-picker-dismissed"))

        XCTAssertTrue(declaration.waitForExistence(timeout: 20),
                      "AFTER THE PICKER: the screen reverted to device-generated material. "
                      + "The operator's source choice was discarded silently.")
        XCTAssertEqual(declaration.value as? String, "hardware TRNG, run 7",
                       "AFTER THE PICKER: the source survived but the operator's declaration "
                       + "was discarded")

        // --- transition 2: a real background/foreground cycle -----------------
        // This is the one that actually rebuilt the model: the root reads
        // scenePhase to drive the privacy cover, so every transition re-evaluates
        // the body and used to re-run the sheet's content closure.
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 3)
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))

        XCTAssertTrue(declaration.waitForExistence(timeout: 25),
                      "AFTER BACKGROUNDING: the screen reverted to device-generated material. "
                      + "An operator who left to fetch their file would return to a create "
                      + "screen offering to generate the pad instead, with no notice.")
        XCTAssertEqual(declaration.value as? String, "hardware TRNG, run 7",
                       "AFTER BACKGROUNDING: the declaration was discarded")

        // And the device-source headline must NOT be back on screen.
        XCTAssertFalse(app.staticTexts["Generated securely on this iPhone"].exists,
                       "the device-source claim is showing while external material is selected")
        add(screenshot(app, "after-background-cycle"))
    }
}
