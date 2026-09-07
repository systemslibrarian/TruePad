import Foundation
import TruePadCore
@testable import TruePadSPT
@testable import TruePadStorage
@testable import TruePadUI
import XCTest

/// WHERE SECRETS COULD ESCAPE, AND THE FACT THAT THEY DO NOT.
///
/// A pad-management app leaks by accident, not by design: a `print` left in a
/// hot path, a pasteboard convenience, a temp file written without protection, an
/// error message that carries the bytes it failed on. Each of those is a one-line
/// change nobody would flag in review, so each gets a test.
///
/// The strongest of these is not a source sweep at all — it runs the real engine
/// through a whole pad lifecycle and then searches EVERY byte it wrote for the
/// pad material, and for the plaintext.
final class LeakageAuditTests: XCTestCase {
    static var kitRoot: URL { PostureGuardTests.kitRoot }

    /// Production sources of every shipping target, comments stripped — PLUS the
    /// app shell, which is shipping code too.
    ///
    /// The sweep walked `TruePadKit/Sources/<target>` only. `ios/TruePadApp/
    /// TruePadApp/` is compiled into the binary an operator installs, and it was
    /// outside every guard here: no logging ban, no pasteboard ban, no
    /// accessibility-identifier check. It happens to be clean today, which is
    /// exactly the kind of fact that stops being true without anyone noticing —
    /// the blind spot is the finding, not its current contents.
    func productionSources() throws -> [(name: String, text: String)] {
        var out: [(String, String)] = []
        // ONE LIST OF SHIPPING TARGETS, shared with PostureGuardTests, which now
        // includes the app shell — so the two sweeps cannot cover different sets.
        for target in PostureGuardTests.shippingSourceTargets {
            for file in try PostureGuardTests().sources(of: target) {
                out.append((file.name, PostureGuardTests.stripComments(file.text)))
            }
        }
        XCTAssertGreaterThan(out.count, 15, "the sweep found suspiciously few sources")
        // POSITIVE CONTROL for the addition: the app shell really is in scope now.
        XCTAssertTrue(out.contains { $0.0.hasPrefix("TruePadApp/") },
                      "the app shell is not in the sweep, so nothing here guards it")
        return out
    }

    // MARK: - nothing is logged

    /// NO LOGGING AT ALL in the shipping code.
    ///
    /// Not "no logging of secrets" — no logging, full stop. The distinction
    /// matters because the leak is never the line someone wrote meaning to log a
    /// secret; it is the line that logs a struct which later gains a field. A
    /// codebase with no logging surface cannot acquire that bug.
    func testNoShippingSourceLogsAnything() throws {
        let forbidden = ["print(", "debugPrint(", "dump(", "NSLog(", "os_log", "Logger(",
                         "OSLog", "FileHandle.standardOutput", "FileHandle.standardError",
                         "fputs(", "fwrite(stdout"]
        for file in try productionSources() {
            for needle in forbidden {
                // WORD BOUNDARY. Plain `contains` matched `print(` inside
                // `requestFingerprint(` -- the same substring mistake that made an
                // earlier guard vacuous, caught here because this one fired.
                XCTAssertFalse(Self.containsAsCall(file.text, needle),
                               "\(file.name) contains \(needle): TruePad ships no logging surface, "
                               + "so it cannot grow one that prints a struct which later gains a "
                               + "secret field")
            }
        }
    }

    /// NO PASTEBOARD from the engine or the presentation logic. The clipboard is
    /// readable by other apps and syncs across devices by Handoff, so anything
    /// that reaches it has left the app's control.
    /// EXACTLY ONE FILE MAY REFERENCE THE PASTEBOARD.
    ///
    /// The ban used to be absolute. It is now narrower and stronger: one audited
    /// boundary, `PublicTransportPasteboard`, which takes a `PublicTransport`
    /// value — a type that cannot be constructed from arbitrary text — and every
    /// other reference still fails. A blanket ban that the product had to route
    /// around with text selection was not actually protecting anything; a typed
    /// boundary is.
    static let pasteboardBoundary = "TruePadUI/PublicTransportPasteboard.swift"

    func testNoShippingSourceTouchesThePasteboard() throws {
        var boundarySeen = false
        for file in try productionSources() {
            for needle in ["UIPasteboard", "NSPasteboard", "generalPasteboard"] {
                guard Self.containsAsCall(file.text, needle) else { continue }
                XCTAssertEqual(file.name, Self.pasteboardBoundary,
                               "\(file.name) references \(needle) — only the audited public "
                               + "transport boundary may touch the clipboard. Pad material and "
                               + "plaintext must never reach it.")
                boundarySeen = true
            }
        }
        // NON-VACUOUS: the exception must still be in use. If the boundary stops
        // touching the pasteboard, this test has stopped constraining anything and
        // the exception should be deleted rather than left standing.
        XCTAssertTrue(boundarySeen,
                      "no file references the pasteboard at all, so the named exception guards "
                      + "nothing")
    }

    /// The boundary takes a TYPE, not a string. This is the assertion that stops
    /// it quietly becoming a general-purpose copy facility.
    func testThePasteboardBoundaryOnlyAcceptsValidatedPublicTransport() throws {
        let file = try productionSources().first { $0.name == Self.pasteboardBoundary }
        let text = try XCTUnwrap(file?.text, "the audited pasteboard boundary is missing")

        XCTAssertTrue(text.contains("func copy(_ material: PublicTransport)"),
                      "the boundary no longer takes a validated PublicTransport value")
        XCTAssertFalse(text.contains(": String"),
                       "the boundary accepts a raw String, so a view could hand it anything")
        // One assignment, of the value's own text, and nothing else.
        XCTAssertTrue(text.contains("UIPasteboard.general.string = material.text"))
        let writes = text.components(separatedBy: "UIPasteboard.general").count - 1
        XCTAssertEqual(writes, 1, "the boundary touches the pasteboard \(writes) times; it must be once")
    }

    /// ACCESSIBILITY IDENTIFIERS ARE NAMES, NEVER VALUES.
    ///
    /// Two identifiers ship — `envelope-input` and `request-input` — so the
    /// physical two-device harness can find the fields an operator pastes into.
    /// They are deliberately NOT hidden behind DEBUG: a build that is tested is
    /// the build that should ship, and gating them would make the physically
    /// exercised binary differ from the released one.
    ///
    /// What makes that safe is that an identifier is a static generic NAME. It
    /// carries no pad id, no key, no plaintext, no transport value, no filename
    /// and no role; it is not interpolated from anything; and nothing in the app
    /// reads one, so no behaviour, authorisation or validation can depend on it.
    /// This asserts all of that, and pins the set so a third one is a decision
    /// somebody makes on purpose rather than a habit that spreads.
    func testAccessibilityIdentifiersAreStaticNamesCarryingNoValue() throws {
        let approved: Set<String> = ["envelope-input", "request-input"]
        var found: Set<String> = []

        for file in try productionSources() {
            var rest = Substring(file.text)
            while let call = rest.range(of: ".accessibilityIdentifier(") {
                let after = rest[call.upperBound...]
                guard let close = after.firstIndex(of: ")") else { break }
                let argument = String(after[..<close]).trimmingCharacters(in: .whitespaces)

                // A STRING LITERAL, and only that. An interpolated identifier is
                // how a pairId or a filename would end up in the tree.
                XCTAssertTrue(argument.hasPrefix("\"") && argument.hasSuffix("\""),
                              "\(file.name) builds an accessibility identifier from an "
                              + "expression: \(argument). Identifiers must be literals.")
                XCTAssertFalse(argument.contains("\\("),
                               "\(file.name) interpolates a value into an accessibility "
                               + "identifier: \(argument)")

                let value = argument.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
                found.insert(value)
                rest = after[close...]
            }
        }

        // POSITIVE CONTROL: the scan actually found the identifiers that exist.
        XCTAssertEqual(found, approved,
                       "the set of shipping accessibility identifiers changed. Adding one is a "
                       + "decision to take deliberately: it must be a static generic name that "
                       + "carries no value.")

        // And none of them reads like a value rather than a name.
        for value in found {
            for forbidden in ["TP2", "TPR2", "pair", "pad", "key", "secret", "plaintext",
                              "role", "party", ".json", ".tps2", "witness"] {
                XCTAssertFalse(value.lowercased().contains(forbidden.lowercased()),
                               "the identifier \(value) names \(forbidden) — an identifier is a "
                               + "name, not a value")
            }
            XCTAssertFalse(value.contains(where: \.isNumber),
                           "the identifier \(value) carries digits, which is how an index or an "
                           + "id gets into the accessibility tree")
        }
    }

    /// NOTHING BRANCHES ON AN IDENTIFIER. If no shipping code reads one, no
    /// behaviour can depend on one — which is the property that makes a
    /// testability hook safe to ship.
    func testNoShippingCodeReadsAnAccessibilityIdentifier() throws {
        for file in try productionSources() {
            for needle in ["accessibilityIdentifier ==", "== accessibilityIdentifier",
                           "accessibilityIdentifier)", ".identifier =="] {
                XCTAssertFalse(file.text.contains(needle),
                               "\(file.name) reads an accessibility identifier (\(needle)); "
                               + "behaviour must never depend on one")
            }
        }
    }

    /// PLAINTEXT REMAINS STRUCTURALLY UNCOPYABLE. Not by convention — the Open
    /// screen has no copy affordance and the policy says so.
    func testTheDecryptedMessageStillHasNoWayToTheClipboard() throws {
        XCTAssertFalse(EgressPolicy.mayCopyToClipboard(.plaintext))
        XCTAssertFalse(EgressPolicy.mayRenderAsQr(.plaintext))
        XCTAssertFalse(EgressPolicy.mayShareAsFile(.plaintext))
        XCTAssertTrue(EgressPolicy.mayCopyToClipboard(.publicText))

        let views = try productionSources().first { $0.name == "TruePadUI/MessageViews.swift" }
        let text = try XCTUnwrap(views?.text)
        // POSITIVE CONTROL: this is the file holding both screens.
        XCTAssertTrue(text.contains("struct OpenView"))
        XCTAssertTrue(text.contains("struct SendView"))

        // The plaintext block must not gain selection or a copy control.
        //
        // THE WHOLE BLOCK, WALKED BY BRACES — not `prefix(900)`. The block ends
        // 621 characters in, so that window left 79 characters of margin and a
        // paragraph of ordinary prose inside the block put a `.textSelection`
        // outside it while every assertion here still passed. See
        // `PostureGuardTests.blockAfter`.
        guard let tail = PostureGuardTests.blockAfter("if let plaintext = model.plaintext", in: text) else {
            return XCTFail("the Open screen no longer has the shape this guard reads")
        }
        // The region really is the whole block, and really is bounded.
        XCTAssertTrue(tail.hasSuffix("}"))
        XCTAssertTrue(tail.contains("Text(plaintext)"),
                      "precondition: this region must be the one that renders the message")
        XCTAssertFalse(tail.contains("textSelection"),
                       "the decrypted message became selectable, which routes it to the general "
                       + "pasteboard")
        XCTAssertFalse(tail.contains("PublicTransportPasteboard"),
                       "the decrypted message gained a copy control")
    }

    /// NO ANALYTICS, NO CRASH REPORTING, NO THIRD-PARTY TELEMETRY. A crash
    /// reporter that uploads a stack with a buffer in it is a leak with a
    /// respectable name.
    func testNoShippingSourceCarriesTelemetry() throws {
        let forbidden = ["Analytics", "Crashlytics", "Sentry", "Bugsnag", "Firebase",
                         "MetricKit", "os_signpost", "AppMetrics"]
        for file in try productionSources() {
            for needle in forbidden {
                XCTAssertFalse(Self.containsAsCall(file.text, needle),
                               "\(file.name) references \(needle)")
            }
        }
    }

    /// Every file this app writes is created WITH a protection class, not
    /// protected afterwards. A file that exists unprotected for a moment is a
    /// file that was readable in that moment.
    func testEveryFileIsCreatedWithProtectionRatherThanProtectedAfterwards() throws {
        let darwinFs = try String(
            contentsOf: Self.kitRoot.appendingPathComponent("Sources/TruePadStorage/DarwinFs.swift"),
            encoding: .utf8)
        XCTAssertTrue(darwinFs.contains(".protectionKey"),
                      "files must be created with a protection class")
        // And the temp file the share sheet hands over is written protected too.
        let models = try String(
            contentsOf: Self.kitRoot.appendingPathComponent("Sources/TruePadUI/Models.swift"),
            encoding: .utf8)
        XCTAssertTrue(models.contains(".completeFileProtection"),
                      "the exported pad file must be written with complete protection")
    }

    // MARK: - the real test: run the engine and search everything it wrote

    /// THE ONE THAT WOULD CATCH A REAL LEAK.
    ///
    /// Run a whole lifecycle — generate, send, open, export, seal — then search
    /// EVERY byte the engine wrote for the pad material and for the plaintext.
    /// The only file allowed to contain pad material is the one whose entire
    /// purpose is to hold it.
    func testNoPadMaterialOrPlaintextAppearsOutsideTheFilesThatMustHoldIt() throws {
        let fs = MemoryFs()
        let clock = Date(timeIntervalSince1970: 1_756_684_800)
        let pairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        let e = Engine(fs: fs, clock: { clock }, pairIdSource: { Hex.decode(pairId)! })

        // Distinctive source material, so a match is unambiguous rather than a
        // coincidence of common bytes.
        let need = try Partition.requiredSourceLength(capacity: 512, capacityRecords: 8)
        // NON-PERIODIC. The first version used 0xC0 + i*7 mod 256, which repeats
        // every 256 bytes -- so a window taken from one half's tail reappeared in
        // the other half, and the test failed on its own arithmetic rather than on
        // a leak. An LCG over the full period does not repeat within this buffer.
        var marker: [UInt8] = []
        var lcg: UInt64 = 0xC0FFEE_1234_5678
        for _ in 0..<need {
            lcg = lcg &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            marker.append(UInt8(truncatingIfNeeded: lcg >> 33))
        }
        _ = try e.gen(label: "leak-audit",
                      sources: [SourceInput(name: "dice.bin", declaredOrigin: "physical dice",
                                            bytes: marker)],
                      encryptionBytes: 512, authRecords: 8)

        let plaintext = "SENTINEL-PLAINTEXT-do-not-leak-me"
        let burned = try e.burn(pairId: pairId, role: .a, plaintext: Array(plaintext.utf8))

        // The actual pad bytes now on disk, taken from the file that holds them.
        let secretPath = storePath(storeDir(pairId, .aToB), secretFile)
        let secret = try XCTUnwrap(try fs.readFile(secretPath))
        XCTAssertGreaterThan(secret.count, 64)
        // A window from the UNCONSUMED region — long enough that an accidental
        // match is not plausible.
        let window = Array(secret[(secret.count - 48)...])

        for path in fs.allPaths {
            guard let bytes = try fs.readFile(path) else { continue }
            // BOTH halves' secret.bin legitimately hold pad material.
            if path.hasSuffix(secretFile) { continue }

            XCTAssertFalse(Self.contains(bytes, window),
                           "\(path) contains live pad material")
            XCTAssertFalse(Self.contains(bytes, Array(plaintext.utf8)),
                           "\(path) contains the plaintext")
        }

        // The ENVELOPE the operator hands over must not contain the plaintext
        // either — that is the whole point of encrypting it.
        XCTAssertFalse(burned.envelope.contains(plaintext))
        XCTAssertFalse(Self.contains(Array(burned.envelope.utf8), window),
                       "the envelope must not carry pad material")

        // Nor may the courier bundle carry the plaintext, or this installation's
        // own bookkeeping.
        let container = try e.exportPair(pairId: pairId).container
        XCTAssertFalse(Self.contains(container, Array(plaintext.utf8)))
        let containerText = String(decoding: container, as: UTF8.self)
        for forbidden in ["leak-audit", "handoff.json", "generated-here"] {
            XCTAssertFalse(containerText.contains(forbidden),
                           "the bundle carries the PAD, not this installation's record: \(forbidden)")
        }
    }

    /// A REFUSAL MESSAGE MUST NOT CARRY WHAT IT REFUSED. Error text is shown to
    /// the operator, and on other platforms would be logged; a message that
    /// echoes the bytes that failed is a leak with a helpful tone.
    func testNoRefusalMessageEchoesSecretInput() throws {
        let fs = MemoryFs()
        let clock = Date(timeIntervalSince1970: 1_756_684_800)
        let pairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        let e = Engine(fs: fs, clock: { clock }, pairIdSource: { Hex.decode(pairId)! })
        let need = try Partition.requiredSourceLength(capacity: 256, capacityRecords: 4)
        _ = try e.gen(label: "refusals",
                      sources: [SourceInput(name: "s", declaredOrigin: "d",
                                            bytes: [UInt8](repeating: 0x2B, count: need))],
                      encryptionBytes: 256, authRecords: 4)

        let sentinel = "SENTINEL-SECRET-0123456789"
        var messages: [String] = []
        func collect(_ body: () throws -> Void) {
            do { try body() } catch let r as EngineRefused { messages.append(r.message) }
            catch let r as SptRefused { messages.append(r.message) }
            catch { messages.append("\(error)") }
        }

        collect { _ = try e.open(pairId: pairId, role: .b, envelopeText: sentinel) }
        collect { _ = try e.open(pairId: pairId, role: .b, envelopeText: "TP2:" + sentinel) }
        collect { _ = try e.importPair(label: "x", container: Array(sentinel.utf8)) }
        collect { _ = try e.sptOpen(packageBytes: Array(sentinel.utf8)) }
        collect { _ = try e.sptReviewRequest("TPR2:" + sentinel) }
        collect { _ = try e.destroy(pairId: pairId, confirm: sentinel) }

        XCTAssertGreaterThanOrEqual(messages.count, 5, "the refusals must actually have fired")
        for message in messages {
            XCTAssertFalse(message.contains(sentinel),
                           "a refusal echoed the input it refused: \(message)")
        }
    }

    /// And a destroy refusal must not echo the pairId — the operator confirms by
    /// knowing it, so a message that prints it hands over the answer.
    func testTheDestroyRefusalNeverEchoesThePairId() throws {
        let fs = MemoryFs()
        let clock = Date(timeIntervalSince1970: 1_756_684_800)
        let pairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        let e = Engine(fs: fs, clock: { clock }, pairIdSource: { Hex.decode(pairId)! })
        let need = try Partition.requiredSourceLength(capacity: 256, capacityRecords: 4)
        _ = try e.gen(label: "confirm",
                      sources: [SourceInput(name: "s", declaredOrigin: "d",
                                            bytes: [UInt8](repeating: 0x2B, count: need))],
                      encryptionBytes: 256, authRecords: 4)

        do {
            _ = try e.destroy(pairId: pairId, confirm: "wrong")
            XCTFail("a wrong confirmation must refuse")
        } catch let refused as EngineRefused {
            XCTAssertEqual(refused.reason, "destroy-unconfirmed")
            XCTAssertFalse(refused.message.contains(pairId),
                           "the refusal must not hand over the value it is asking for")
        }
    }

    // MARK: - helper

    /// `needle` appearing as its own token, not as the tail of an identifier.
    static func containsAsCall(_ text: String, _ needle: String) -> Bool {
        var index = text.startIndex
        while let found = text.range(of: needle, range: index..<text.endIndex) {
            let precededByIdentifier: Bool
            if found.lowerBound == text.startIndex {
                precededByIdentifier = false
            } else {
                let before = text[text.index(before: found.lowerBound)]
                precededByIdentifier = before.isLetter || before.isNumber || before == "_"
            }
            if !precededByIdentifier { return true }
            index = found.upperBound
        }
        return false
    }

    static func contains(_ haystack: [UInt8], _ needle: [UInt8]) -> Bool {
        guard !needle.isEmpty, haystack.count >= needle.count else { return false }
        for start in 0...(haystack.count - needle.count)
        where Array(haystack[start..<(start + needle.count)]) == needle {
            return true
        }
        return false
    }
}
