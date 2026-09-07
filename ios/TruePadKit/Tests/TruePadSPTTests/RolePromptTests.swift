import XCTest
@testable import TruePadUI

/// THE UNKNOWN-ORIGIN REFUSAL MUST POINT SOMEWHERE REAL.
///
/// The Browser edition shipped a version of this message naming a control on the
/// pad screen that had never been built; iOS shipped one telling the operator to
/// "Choose the role you were given", when no iOS screen chooses a role at all.
/// Both were the same defect: a refusal is only useful if the way out of it
/// exists, and an operator sent to a button they cannot find concludes the app is
/// broken — which makes guessing look like the only way forward, and guessing is
/// the single thing this message is trying to prevent.
final class RolePromptTests: XCTestCase {

    private func source(_ relative: String) throws -> String {
        // #filePath is .../ios/TruePadKit/Tests/TruePadSPTTests/RolePromptTests.swift
        let here = URL(fileURLWithPath: #filePath)
        let repo = here.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(contentsOf: repo.appendingPathComponent(relative), encoding: .utf8)
    }

    /// Every phrase the prompt puts in typographic quotes is an instruction to go
    /// and tap something. If the string is not in the UI source, that control does
    /// not exist under that name.
    func testEveryControlTheRefusalNamesExistsInTheInterface() throws {
        let ui = try ["CeremonyViews.swift", "RootView.swift", "PadViews.swift", "MessageViews.swift"]
            .compactMap { try? source("ios/TruePadKit/Sources/TruePadUI/\($0)") }
            .joined(separator: "\n")

        // POSITIVE CONTROL: the concatenation is the real interface, not empty.
        XCTAssertGreaterThan(ui.count, 5000, "the UI sources did not load")
        XCTAssertTrue(ui.contains("\"Create a pad\""),
                      "positive control failed: a known affordance is missing")

        let prompt = PartyRole.unknownOriginPrompt
        var quoted: [String] = []
        var rest = Substring(prompt)
        while let open = rest.firstIndex(of: "\u{201C}"),
              let close = rest[rest.index(after: open)...].firstIndex(of: "\u{201D}") {
            quoted.append(String(rest[rest.index(after: open)..<close]))
            rest = rest[rest.index(after: close)...]
        }
        XCTAssertGreaterThanOrEqual(quoted.count, 2,
                                    "the refusal names no controls the operator can act on")
        for label in quoted {
            XCTAssertTrue(ui.contains("\"\(label)\""),
                          "the refusal tells the operator to use \"\(label)\", which appears "
                          + "nowhere in the iOS interface")
        }

        // THE UNQUOTED HALF OF THE SENTENCE — the destinations those controls
        // live ON — which this guard did not hold and which drifted.
        //
        // The prompt said to create a receive code "on the Receive screen". The
        // tab has been called Inbox since the navigation shell landed, and the
        // empty-state copy two files away was updated in the same diff. Only the
        // typographically-quoted spans were checked, so the route name sailed
        // through while the doc comment above the prompt claimed every route it
        // names is "spelled as the operator sees it".
        for tab in ["Pads", "Inbox", "About"] {
            guard prompt.contains(tab) else { continue }
            XCTAssertTrue(ui.contains("Label(\"\(tab)\""),
                          "the refusal sends the operator to \"\(tab)\", which is not a "
                          + "destination this app declares")
        }
        for gone in ["Receive screen", "Receive tab"] {
            XCTAssertFalse(prompt.contains(gone),
                           "the refusal names \"\(gone)\"; that destination is called Inbox")
        }
    }

    /// It must REFUSE, not delegate. The role is derived from a recorded fact;
    /// inviting the operator to pick one just moves the guess to a human.
    func testTheRefusalDoesNotAskTheOperatorToChooseARole() {
        let p = PartyRole.unknownOriginPrompt.lowercased()
        XCTAssertTrue(p.contains("will not guess"))
        XCTAssertFalse(p.contains("choose the role"),
                       "the prompt asks the operator to choose a role — that is the guess it "
                       + "just said TruePad will not make, relocated")
        XCTAssertFalse(p.contains("select the role"))
        XCTAssertTrue(p.contains("nothing for you to set by hand"),
                      "the prompt does not say that setting a role by hand is not an option, "
                      + "so an operator may still go looking for the control")
    }

    /// The consequence must be stated, because it is the reason for the refusal.
    func testTheRefusalSaysWhyGuessingIsTheOneThingItWillNotDo() {
        let p = PartyRole.unknownOriginPrompt.lowercased()
        XCTAssertTrue(p.contains("spends material the other person is spending too"))
        // It must say guessing does NOT corrupt the pad. Overstating the harm is
        // its own defect: an operator who believes a wrong guess destroys the pad
        // reasons differently from one who understands the real cost, which is
        // that both sides quietly spend the same one-time material.
        XCTAssertTrue(p.contains("does not corrupt the pad"),
                      "the prompt does not say that guessing leaves the pad intact, so it "
                      + "overstates the harm and misdescribes the actual risk")
    }
}
