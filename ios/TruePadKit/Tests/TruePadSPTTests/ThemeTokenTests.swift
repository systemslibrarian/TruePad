import XCTest

/// THE TWO EDITIONS MUST NOT DRIFT APART, AND THE PALETTE MUST STAY IN ONE PLACE.
///
/// The iPhone app was rebuilt to look like the Android one. Nothing in a build
/// keeps it that way: a palette is seven numbers, and seven numbers copied into a
/// second file diverge the first time somebody nudges one of them. Worse, the
/// failure is invisible — a slightly different brass still compiles, still passes
/// every other test, and simply makes the two apps look like two products again.
///
/// So this file asserts three things that no other test can:
///
///   1. Every colour in the iOS theme is BYTE-FOR-BYTE the Android one.
///   2. No product view names a colour or a raw font size at all. The token layer
///      is the only place appearance is decided.
///   3. The two DELIBERATELY LIGHT camera surfaces are still light.
///
/// Rule 3 runs the opposite way from the other two, and that is the point. A later
/// pass that "finishes the theming" would darken the QR card and the full-screen
/// scan view, which looks like consistency and is actually a scan-reliability
/// regression the two-device physical run already paid for once. This test fails
/// if they go dark.
///
/// WHY SOURCE TEXT RATHER THAN THE TYPES. `Theme.swift` is `#if os(iOS)`, so on
/// the macOS host that runs `swift test` it compiles to nothing at all —
/// `TruePadPalette` does not exist here to be inspected. Reading the file is not a
/// shortcut; it is the only way this can be checked off-device.
final class ThemeTokenTests: XCTestCase {

    // MARK: - locating and reading

    private func repoRoot() -> URL {
        // #filePath is .../ios/TruePadKit/Tests/TruePadSPTTests/ThemeTokenTests.swift
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: repoRoot().appendingPathComponent(relative), encoding: .utf8)
    }

    private static let iosTheme = "ios/TruePadKit/Sources/TruePadUI/Theme.swift"
    private static let androidTheme =
        "android/app/src/main/kotlin/dev/systemslibrarian/truepad/app/ui/Theme.kt"

    /// Every file that draws product interface. The QR/scanner file is here too —
    /// its two light surfaces are handled by an explicit allow-list rather than by
    /// excluding the file, because excluding it would also stop policing the rest
    /// of it.
    private static let productViews = [
        "ios/TruePadKit/Sources/TruePadUI/RootView.swift",
        "ios/TruePadKit/Sources/TruePadUI/PadViews.swift",
        "ios/TruePadKit/Sources/TruePadUI/CeremonyViews.swift",
        "ios/TruePadKit/Sources/TruePadUI/MessageViews.swift",
        "ios/TruePadKit/Sources/TruePadUI/ScannerView.swift",
        "ios/TruePadApp/TruePadApp/TruePadAppMain.swift",
    ]

    /// Comments are prose, and prose discusses the very things this test forbids —
    /// the header of MessageViews.swift says the words "Color.white" on purpose.
    /// Scanning raw text would therefore flag the explanation of a rule as a
    /// violation of it. This removes `//` and `/* */`, and leaves string literals
    /// alone so that a `//` inside a URL or a message is not mistaken for one.
    private func stripComments(_ swift: String) -> String {
        var out = ""
        var inString = false
        var inLine = false
        var inBlock = false
        var escaped = false
        var i = swift.startIndex
        while i < swift.endIndex {
            let c = swift[i]
            let next = swift.index(after: i) < swift.endIndex ? swift[swift.index(after: i)] : nil

            if inLine {
                if c == "\n" { inLine = false; out.append(c) }
            } else if inBlock {
                if c == "*" && next == "/" { inBlock = false; i = swift.index(after: i) }
            } else if inString {
                out.append(c)
                if escaped { escaped = false }
                else if c == "\\" { escaped = true }
                else if c == "\"" { inString = false }
            } else if c == "/" && next == "/" {
                inLine = true; i = swift.index(after: i)
            } else if c == "/" && next == "*" {
                inBlock = true; i = swift.index(after: i)
            } else if c == "\"" {
                inString = true; out.append(c)
            } else {
                out.append(c)
            }
            i = swift.index(after: i)
        }
        return out
    }

    // MARK: - 1. the palette matches Android, byte for byte

    /// Android names these `Ground`, `Ink`, … ; iOS names them `ground`, `ink`, … .
    /// The VALUES are what must agree.
    private static let paletteNames: [(kotlin: String, swift: String)] = [
        ("Ground", "ground"), ("Ink", "ink"), ("Muted", "muted"), ("Raised", "raised"),
        ("Line", "line"), ("Accent", "accent"), ("Danger", "danger"), ("OnDanger", "onDanger"),
    ]

    private func kotlinColour(_ name: String, in kt: String) -> String? {
        // private val Ground = Color(0xFF11100C)
        guard let r = kt.range(of: "val \(name) = Color(0xFF") else { return nil }
        let rest = kt[r.upperBound...]
        let hex = rest.prefix { $0.isHexDigit }
        return hex.count == 6 ? hex.uppercased() : nil
    }

    private func swiftColour(_ name: String, in sw: String) -> String? {
        // public static let ground = Color(hex: 0x11_10_0C)
        guard let r = sw.range(of: "let \(name) = Color(hex: 0x") else { return nil }
        let rest = sw[r.upperBound...]
        let raw = rest.prefix { $0.isHexDigit || $0 == "_" }
        let hex = raw.filter { $0 != "_" }
        return hex.count == 6 ? hex.uppercased() : nil
    }

    func testTheIosPaletteIsExactlyTheAndroidPalette() throws {
        let kt = try source(Self.androidTheme)
        let sw = try source(Self.iosTheme)

        // POSITIVE CONTROL: both files loaded and are the files we think they are.
        XCTAssertTrue(kt.contains("TruePadTheme"), "the Android theme did not load")
        XCTAssertTrue(sw.contains("TruePadPalette"), "the iOS theme did not load")

        for pair in Self.paletteNames {
            guard let android = kotlinColour(pair.kotlin, in: kt) else {
                return XCTFail("Android theme no longer defines \(pair.kotlin); this test cannot "
                               + "compare what it cannot find")
            }
            guard let ios = swiftColour(pair.swift, in: sw) else {
                return XCTFail("iOS theme no longer defines \(pair.swift)")
            }
            XCTAssertEqual(ios, android,
                           "the \(pair.swift) colour has drifted: iOS #\(ios) vs Android "
                           + "#\(android). The Android file is the authority — the two editions "
                           + "are meant to read as one product.")
        }
    }

    /// `onAccent` is the ink ON a filled slab, and on Android it is `Ground`.
    /// Getting this wrong produces brass-on-brass, which is legible enough in a
    /// simulator screenshot and unreadable on a handset in daylight.
    func testTheLabelOnAFilledSlabIsTheGroundColour() throws {
        let sw = stripComments(try source(Self.iosTheme))
        XCTAssertTrue(sw.contains("let onAccent = ground"),
                      "the label colour for a filled slab is no longer the ground colour")
    }

    // MARK: - 2. nothing outside the theme names an appearance

    /// Each of these, found in a product view, means the token layer was bypassed.
    private static let forbidden: [(needle: String, why: String)] = [
        (".foregroundStyle(.secondary)", "the system grey, instead of TruePadPalette.muted"),
        (".foregroundStyle(.primary)", "the system ink, instead of TruePadPalette.ink"),
        (".foregroundStyle(.tint)", "the system accent, instead of TruePadPalette.accent"),
        (".foregroundStyle(.red)", "the system red, instead of TruePadPalette.danger"),
        ("Color.orange", "the system orange, which is not in the product palette"),
        ("Color.blue", "Apple blue, which the operator asked to see the back of"),
        ("Color.gray", "a system grey, instead of TruePadPalette.muted"),
        ("Color(.system", "a system semantic colour, instead of a product token"),
        ("Color(red:", "a raw colour, instead of a product token"),
        ("Color(hex:", "a raw colour; the palette lives in Theme.swift"),
        ("Color.white", "a raw white; only the two camera surfaces may be light"),
        (".foregroundStyle(.black", "on-light ink; only the scan caption sits on white"),
        ("DisclosureGroup", "the system disclosure, whose chevron cannot be retinted; use Details"),
        ("LabeledContent", "a system row; use KeyValueRow"),
        ("role: .destructive", "the system red button role; use QuietDangerButton"),
        // THE TYPOGRAPHY HALF, which this list did not actually have.
        //
        // A review caught it: the docstring promised "no product view names a
        // colour or a raw font size at all", the test was named
        // ...NamesAColourOrASystemTextStyle, and every one of the needles above is
        // a colour or a container. The type-scale half of the token claim was
        // asserted by a test NAME and checked by nothing, and two live bypasses
        // were already passing it. That is precisely the vacuous guard this
        // project keeps finding, written here by the same pass that added the
        // guard.
        (".font(.body", "a system text style; use a TruePadFont token"),
        (".font(.headline", "a system text style; use a TruePadFont token"),
        (".font(.subheadline", "a system text style; use a TruePadFont token"),
        (".font(.footnote", "a system text style; use a TruePadFont token"),
        (".font(.callout", "a system text style; use a TruePadFont token"),
        (".font(.caption", "a system text style; use a TruePadFont token"),
        (".font(.title", "a system text style; use a TruePadFont token"),
        (".font(.largeTitle", "a system text style; use a TruePadFont token"),
        (".font(.system(", "a raw font; the type scale lives in Theme.swift"),
        ("Font.custom(", "a bundled face; TruePad ships none"),
    ]

    /// A `Form` or a default `List` supplies its own background, insets and
    /// separators, and those are what made the app read as Settings rather than as
    /// TruePad. The pad list is the one legitimate `List` — it is kept for
    /// `.refreshable` — and it must strip its own chrome to earn that.
    func testNoProductScreenUsesAFormAndTheOneListStripsItsChrome() throws {
        for file in Self.productViews {
            let body = stripComments(try source(file))
            XCTAssertFalse(body.contains("Form {"),
                           "\(file) still builds a screen out of `Form`, which supplies system "
                           + "chrome that cannot be replaced. Use .truePadScreen().")
            if body.contains("List {") {
                XCTAssertTrue(body.contains(".listStyle(.plain)")
                              && body.contains(".scrollContentBackground(.hidden)"),
                              "\(file) uses a `List` without removing its system background and "
                              + "style. A List is only allowed where `.refreshable` needs it, and "
                              + "only with its own chrome stripped.")
            }
        }
    }

    func testNoProductViewNamesAColourOrASystemTextStyle() throws {
        var checked = 0
        for file in Self.productViews {
            let body = stripComments(try source(file))
            checked += body.count

            // POSITIVE CONTROL, per file: stripping did not eat the source.
            XCTAssertTrue(body.contains("struct") || body.contains("enum"),
                          "\(file) came back empty after comment stripping — the check would "
                          + "have passed vacuously")

            for rule in Self.forbidden where !Self.allowed(rule.needle, in: file) {
                XCTAssertFalse(body.contains(rule.needle),
                               "\(file) uses `\(rule.needle)` — \(rule.why). Appearance is "
                               + "decided in Theme.swift and nowhere else.")
            }
        }
        XCTAssertGreaterThan(checked, 20_000,
                             "the product views did not load; this test proved nothing")
    }

    // MARK: - 3. the two light surfaces are still light

    /// The exceptions, named individually.
    ///
    /// This list is deliberately BOTH halves of a rule. `Color.white` and the
    /// on-light caption ink are forbidden everywhere and permitted in exactly one
    /// file — and `testTheQrCardAndTheScanScreenAreStillLight` then asserts they
    /// are still THERE. An allow-list that only permitted would be an allow-list
    /// nothing depended on; this one fails if the exception is removed as well as
    /// if it spreads.
    private static func allowed(_ needle: String, in file: String) -> Bool {
        if file.hasSuffix("MessageViews.swift") {
            return needle == "Color.white" || needle == ".foregroundStyle(.black"
        }
        // TWO SF SYMBOL GLYPHS, which are sized rather than set.
        //
        // `.font` on an `Image(systemName:)` is how UIKit and SwiftUI express a
        // glyph's SIZE; there is no separate API. Neither of these is prose, so
        // neither is a Dynamic Type risk of the kind the rule exists to prevent —
        // and both are asserted below to still be attached to an Image, so this
        // cannot quietly become cover for a paragraph.
        if file.hasSuffix("TruePadAppMain.swift") { return needle == ".font(.largeTitle" }
        if file.hasSuffix("RootView.swift") { return needle == ".font(.system(" }
        return false
    }

    /// The font exceptions are glyph sizings, and must stay glyph sizings.
    func testTheFontExceptionsAreOnlyEverIconGlyphs() throws {
        for (file, needle) in [("ios/TruePadApp/TruePadApp/TruePadAppMain.swift", ".font(.largeTitle"),
                               ("ios/TruePadKit/Sources/TruePadUI/RootView.swift", ".font(.system(")] {
            let body = stripComments(try source(file))
            // Non-vacuous: the exception must still be in use, or it is guarding
            // nothing and should be deleted rather than left standing.
            XCTAssertTrue(body.contains(needle),
                          "\(file) no longer uses \(needle), so its exception is dead")
            // And it must sit in an IMAGE's modifier chain, not on prose.
            //
            // This first looked backwards a fixed 220 characters for
            // "Image(systemName:", and a mutation walked straight through it: in
            // StorageUnavailableView the icon is three lines above the headline, so
            // moving the exception onto the headline still found the Image inside
            // the window. Walking the actual chain — up past contiguous modifier
            // lines to the expression they attach to — is the thing that was meant.
            let lines = body.components(separatedBy: "\n")
            for (i, line) in lines.enumerated() where line.contains(needle) {
                var j = i
                while j > 0, lines[j].trimmingCharacters(in: .whitespaces).hasPrefix(".") {
                    j -= 1
                }
                XCTAssertTrue(lines[j].contains("Image(systemName:"),
                              "\(file) attaches \(needle) to `"
                              + lines[j].trimmingCharacters(in: .whitespaces)
                              + "`, which is not an SF Symbol glyph")
            }
        }
    }

    /// The allow-list must not quietly become dead. If MessageViews.swift stops
    /// using these, the exception is no longer an exception and this file is
    /// asserting nothing about them.
    func testTheAllowListIsNotVacuous() throws {
        let body = stripComments(try source("ios/TruePadKit/Sources/TruePadUI/MessageViews.swift"))
        for needle in ["Color.white", ".foregroundStyle(.black"] {
            XCTAssertTrue(Self.allowed(needle, in: "MessageViews.swift"),
                          "\(needle) is not actually allow-listed")
            XCTAssertTrue(body.contains(needle),
                          "\(needle) is allow-listed but no longer used, so the exception "
                          + "guards nothing")
        }
        // And the exception is genuinely narrow: it applies to ONE file.
        XCTAssertFalse(Self.allowed("Color.white", in: "PadViews.swift"),
                       "the light-surface exception has leaked to another file")
    }

    /// A camera has to read these two, and a decoder keys on the quiet zone and the
    /// contrast ratio. This is the test that fails when somebody makes the app
    /// consistent at the ceremony's expense.
    func testTheQrCardAndTheScanScreenAreStillLight() throws {
        let body = stripComments(try source("ios/TruePadKit/Sources/TruePadUI/MessageViews.swift"))

        XCTAssertTrue(body.contains(".background(Color.white)"),
                      "the inline QR card is no longer white. A dark QR surface is a visual "
                      + "preference paid for in scan reliability — the two-device run showed "
                      + "there is no room for it.")
        XCTAssertTrue(body.contains(".padding(12)"),
                      "the inline QR card lost its padding. That padding IS the quiet zone, and "
                      + "shrinking it is as damaging as darkening it.")
        XCTAssertTrue(body.contains("Color.white.ignoresSafeArea()"),
                      "the full-screen scan view is no longer pure white beyond the safe area.")
        XCTAssertTrue(body.contains(".foregroundStyle(.black.opacity(0.6))"),
                      "the full-screen scan caption is no longer on-light ink. It sits on white; "
                      + "an on-dark token would make it unreadable.")
        XCTAssertTrue(body.contains(".interpolation(.none)"),
                      "the QR is being smoothed. Scaling that blurs module edges is what stopped "
                      + "the code being readable in the first place.")

        // POSITIVE CONTROL: this file really is the one that was themed, so the
        // assertions above are exceptions to a rule that is otherwise in force.
        XCTAssertTrue(body.contains("TruePadPalette."),
                      "MessageViews.swift names no product token at all, so the light surfaces "
                      + "above are not exceptions to anything")
    }

    /// A DISCLOSURE MUST SAY WHETHER IT IS OPEN.
    ///
    /// `Details` replaced `DisclosureGroup`, which published expanded/collapsed for
    /// free. The replacement hides its own triangle from assistive technology — on
    /// purpose, so the button's NAME stays exactly the summary the physical suite
    /// matches — which left nothing at all carrying the state. Three toggles hiding
    /// the NOT ELIGIBLE explanation, the per-direction counters and verdict, and the
    /// external-material ceremony all sounded identical before and after a tap.
    func testTheDisclosureSpeaksItsState() throws {
        let theme = stripComments(try source(Self.iosTheme))

        // POSITIVE CONTROL: this really is the file that defines the disclosure.
        XCTAssertTrue(theme.contains("struct Details"), "the disclosure is gone")

        XCTAssertTrue(theme.contains("accessibilityValue(open ?"),
                      "the disclosure no longer publishes whether it is open, so a screen reader "
                      + "hears the same thing before and after it is activated")
        XCTAssertTrue(theme.contains("\"expanded\"") && theme.contains("\"collapsed\""),
                      "the disclosure's state is not spoken as expanded/collapsed")
        // The NAME must stay the bare summary: it is what the physical suite
        // matches, and state belongs in the value rather than the label.
        XCTAssertTrue(theme.contains("accessibilityLabel(summary)"),
                      "the disclosure's name is no longer the plain summary")
    }

    /// The chrome is applied ONCE. Applied per-screen it would be forgotten on the
    /// next one, and a half-tinted app is worse than an untinted one.
    func testTheRootAppliesTheChromeExactlyOnce() throws {
        let root = stripComments(try source("ios/TruePadKit/Sources/TruePadUI/RootView.swift"))
        let uses = root.components(separatedBy: ".truePadChrome()").count - 1
        XCTAssertEqual(uses, 1,
                       "the root applies .truePadChrome() \(uses) times; it must be exactly once")

        for file in Self.productViews where !file.hasSuffix("RootView.swift") {
            let body = stripComments(try source(file))
            XCTAssertFalse(body.contains(".truePadChrome()"),
                           "\(file) applies the chrome itself. It belongs at the root only.")
        }
    }
}
