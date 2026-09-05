import Foundation
import TruePadCore
@testable import TruePadSPT
@testable import TruePadStorage
@testable import TruePadUI
import XCTest

/// REGRESSIONS FOR WHAT THE APP-SHELL AUDIT FOUND.
///
/// Each test here corresponds to a defect that an adversarial review of the new
/// iOS app shell surfaced and that was real. They are written as the audit's
/// questions rather than as descriptions of the fix, so they keep answering the
/// question if the fix is ever reworked.
final class AppShellRegressionTests: XCTestCase {

    // MARK: - the ceremony must not be confirmable without visible words

    /// THE ONE THAT MATTERED. `WordGrid` rendered whatever list it was given, so a
    /// wordlist that failed to load produced an EMPTY phrase — and the operator
    /// was still offered "All twelve words matched". Confirming a comparison that
    /// was never displayed is the worst outcome that screen can produce.
    ///
    /// The completeness predicates are what the buttons are now gated on, so this
    /// tests the gate rather than the layout.
    func testAPhraseThatCannotBeFullyRenderedIsNotConfirmable() {
        let twelve = (0..<12).map { "word\($0)" }
        let eight = (0..<8).map { "word\($0)" }

        XCTAssertTrue(CeremonyPhrase.isComplete(twelve, expecting: 12))
        XCTAssertTrue(CeremonyPhrase.isComplete(eight, expecting: 8))

        // THE CASE THAT WAS REACHABLE: a wordlist that failed to load rendered an
        // empty array, and the confirm button stayed enabled.
        XCTAssertFalse(CeremonyPhrase.isComplete([], expecting: 12),
                       "an empty phrase must never be confirmable")
        // And a phrase that is short, long, or has a hole in it.
        XCTAssertFalse(CeremonyPhrase.isComplete(Array(twelve.dropLast()), expecting: 12))
        XCTAssertFalse(CeremonyPhrase.isComplete(twelve + ["extra"], expecting: 12))
        XCTAssertFalse(CeremonyPhrase.isComplete(twelve.map { $0 == "word4" ? "" : $0 },
                                                 expecting: 12),
                       "a blank in the middle is a hole the operator would read straight past")
    }

    /// The predicates are LENGTH-EXACT, not merely non-empty: eleven words is not
    /// a shorter phrase, it is a different one, and it is the case where two
    /// people would read past each other without noticing.
    func testCompletenessIsExactLengthNotMerelyNonEmpty() {
        XCTAssertEqual(CeremonyPhrase.requestWordCount, 12)
        XCTAssertEqual(CeremonyPhrase.confirmationWordCount, 8)

        // The protocol's own index counts must agree with what the UI expects.
        let requestHash = [UInt8](repeating: 0x5A, count: 32)
        XCTAssertEqual(try SptFingerprint.requestIndices132(requestHash).count,
                       CeremonyPhrase.requestWordCount)
        let confirmValue = [UInt8](repeating: 0xA5, count: SptConstants.confirmValueBytes)
        XCTAssertEqual(try SptFingerprint.confirmationIndices88(confirmValue).count,
                       CeremonyPhrase.confirmationWordCount)
    }

    /// The default renderer REFUSES, so an unwired build cannot show a phrase at
    /// all — and, with the gate above, cannot confirm one either.
    func testAnUnrenderedPhraseIsAlsoIncomplete() {
        // The renderer returns nil unless EVERY index is in range; the caller maps
        // that to an empty array, and an empty array is not complete. The two
        // halves of the fail-closed path meet here.
        XCTAssertNil(ComparisonWords.render([0, 2048]))
        let mapped = ComparisonWords.render([0, 2048]) ?? []
        XCTAssertFalse(CeremonyPhrase.isComplete(mapped,
                                                 expecting: CeremonyPhrase.requestWordCount))
    }

    // MARK: - one implementation of the canonicality rule, not two

    /// The predicate the app wires into the UI was written out in the composition
    /// root AND hand-copied into the test suite, so the shipping copy was never
    /// the tested copy. It now lives in the codec, and this is that copy.
    func testTheShippingCanonicalityPredicateIsTheTestedOne() throws {
        let engine = Engine(fs: MemoryFs(), clock: { Date(timeIntervalSince1970: 0) })
        let request = try engine.sptCreateReceiveRequest()

        XCTAssertTrue(ReceiveRequestCodec.isCanonicalText(request.tpr2Text))
        for bad in [String(request.tpr2Text.dropLast(4)),
                    request.tpr2Text + "=",
                    request.tpr2Text + " ",
                    "TPR2:" + String(repeating: "A", count: 40),
                    ""] {
            XCTAssertFalse(ReceiveRequestCodec.isCanonicalText(bad), "must refuse: \(bad.prefix(24))")
        }
    }

    /// The UI's prefix constant and the protocol's must be the same string. They
    /// are declared in two modules — deliberately, so the UI does not link the
    /// KEM — which means only a test keeps them equal.
    func testTheTwoDeclarationsOfTheRequestPrefixAgree() {
        XCTAssertEqual(SptConstantsBridge.tpr2Prefix, SptConstants.tpr2Prefix,
                       "the UI and the protocol must agree on the receive-request prefix")
    }

    // MARK: - the store's backup exclusion is verified, not assumed

    /// docs/IOS-SECURITY.md §6 states flatly that the store is excluded from
    /// iCloud and Finder backups. The exclusion previously ran only on the branch
    /// that CREATED the directory and swallowed any failure, so that documented
    /// property could have been false with nothing able to notice.
    func testTheStoreIsMarkedExcludedFromBackupOnEveryOpen() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("truepad-backup-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }

        let first = try DarwinFs(root: root)
        XCTAssertFalse(first.backupExclusionUnavailable,
                       "the platform should honour the exclusion in a temp directory")
        var values = try root.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)

        // CLEAR IT, then reopen: the second open must reassert it. This is the
        // case the old code missed entirely, because the directory already
        // existed and `makeDirectory` returned early.
        var mutable = root
        var clear = URLResourceValues()
        clear.isExcludedFromBackup = false
        try mutable.setResourceValues(clear)
        values = try root.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, false, "precondition: the flag is cleared")

        _ = try DarwinFs(root: root)
        values = try root.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true,
                       "re-opening the store must reassert the backup exclusion")
    }

    /// A weaker guarantee than the documentation states must be REPORTABLE.
    func testTheWeakerGuaranteesAreObservable() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("truepad-flags-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let fs = try DarwinFs(root: root)
        // Both flags exist and are readable; their VALUES depend on the platform,
        // and the point is that a caller can ask rather than assume.
        XCTAssertFalse(fs.backupExclusionUnavailable)
        XCTAssertFalse(fs.fullFsyncUnsupported,
                       "APFS should honour F_FULLFSYNC; if it did not, this flag is how you know")
    }

    // MARK: - the screen is covered before iOS photographs it

    /// FOUND ON A REAL HANDSET. `Library/SplashBoard/Snapshots/` existed in the
    /// app's container and was being written on every background transition —
    /// iOS renders the view hierarchy to a file when the app leaves the
    /// foreground. TruePad shows decrypted plaintext on the Open screen, so that
    /// file could hold the one thing the pad exists to protect, in a directory
    /// the app does not own and outliving a force-quit.
    func testTheScreenIsObscuredForEveryNonActivePhase() {
        XCTAssertFalse(ScreenPrivacy.shouldObscure(.active),
                       "an active app must not cover its own screen")

        // THE ONE THAT MATTERS. The snapshot is taken during the .inactive
        // transition, NOT after .background is reached. Covering only at
        // .background leaves the plaintext in the file while making the
        // app-switcher card look blank — the bug that inspects as fixed.
        XCTAssertTrue(ScreenPrivacy.shouldObscure(.inactive),
                      "the snapshot is taken while INACTIVE — covering later is too late")
        XCTAssertTrue(ScreenPrivacy.shouldObscure(.background))
    }

    /// The rule is "cover unless active", not "cover if background". Stated as an
    /// exhaustive switch so a new phase cannot be silently treated as safe.
    func testOnlyTheActivePhaseIsUncovered() {
        for visibility in [AppVisibility.active, .inactive, .background] {
            XCTAssertEqual(ScreenPrivacy.shouldObscure(visibility), visibility != .active)
        }
    }

    // MARK: - the handoff scratch file does not outlive the pad

    /// FOUND BY AUDIT, CONFIRMED IN THE CODE. Handing a pad over wrote the WHOLE
    /// pad to `tmp/pad.tpair` so the share sheet had something to pass along, and
    /// nothing ever removed it — `ShareableFile`'s own comment said it was
    /// "removed afterwards", which was the intent and not the code. The file
    /// outlived `destroy`, which zero-overwrites inside the store and never looks
    /// at `tmp/`.
    func testTheHandoffScratchFilesAreSweptAway() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("truepad-scratch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        // Nothing there: a sweep must report nothing removed, so a caller can
        // tell "there was none" from "the remove failed".
        XCTAssertEqual(HandoffScratch.sweep(dir), 0)

        for name in HandoffScratch.fileNames {
            try Data("pad material".utf8).write(to: dir.appendingPathComponent(name))
        }
        XCTAssertEqual(HandoffScratch.sweep(dir), HandoffScratch.fileNames.count,
                       "every known scratch name must be removed")
        for name in HandoffScratch.fileNames {
            XCTAssertFalse(FileManager.default.fileExists(atPath:
                dir.appendingPathComponent(name).path), "\(name) must be gone")
        }
        // Idempotent — the launch sweep runs on every start.
        XCTAssertEqual(HandoffScratch.sweep(dir), 0)
    }

    /// The sweep must not wander. It removes two known names and nothing else.
    func testTheSweepTouchesOnlyTheNamesItOwns() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("truepad-scratch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let bystander = dir.appendingPathComponent("something-else.txt")
        try Data("keep me".utf8).write(to: bystander)
        try Data("x".utf8).write(to: dir.appendingPathComponent("pad.tpair"))

        XCTAssertEqual(HandoffScratch.sweep(dir), 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: bystander.path),
                      "the sweep must not delete files it does not own")
    }

    // MARK: - a published receive request is reachable after a restart

    /// FOUND ON THE HANDSET. The Receive tab held the published request in memory
    /// only, so a force-quit stranded a LIVE one-time key: still pending on disk,
    /// and unreachable from the interface. The operator could not cancel it,
    /// could not REJECT it after a failed word comparison, and could not show the
    /// twelve words again. Rejecting is how a comparison that does not match is
    /// supposed to end, and there was no way to do it.
    func testAPendingReceiveRequestIsRecoveredAfterARestart() throws {
        let fs = MemoryFs()
        // TWO ENGINES OVER ONE STORE is the whole point: the second stands in for
        // the process that comes back after a force-quit and shares no memory
        // with the first.
        let first = Engine(fs: fs, clock: { Date(timeIntervalSince1970: 0) })
        let created = try first.sptCreateReceiveRequest()

        let second = Engine(fs: fs, clock: { Date(timeIntervalSince1970: 0) })
        let restored = try XCTUnwrap(try second.sptRestorePendingReceiveRequest(),
                                     "a pending request must be recoverable from disk alone")

        XCTAssertEqual(restored.requestIdHex, created.requestIdHex)
        XCTAssertEqual(restored.requestHashHex, created.requestHashHex)
        // THE PUBLISHED TEXT MUST BE BYTE-IDENTICAL. The sender scanned this; a
        // restored request that re-encoded differently would be a different
        // request, and the words would not match.
        XCTAssertEqual(restored.tpr2Text, created.tpr2Text)
        XCTAssertEqual(restored.requestIndices, created.requestIndices)
        XCTAssertEqual(restored.expiresAt, created.expiresAt)
        XCTAssertTrue(ReceiveRequestCodec.isCanonicalText(restored.tpr2Text))
    }

    /// AND A TERMINAL REQUEST IS NOT OFFERED BACK. Restoring a cancelled request
    /// would hand the operator a screen for a one-time key that is already spent.
    func testACancelledRequestIsNotRestored() throws {
        let fs = MemoryFs()
        let first = Engine(fs: fs, clock: { Date(timeIntervalSince1970: 0) })
        let created = try first.sptCreateReceiveRequest()
        _ = try first.sptCancelReceiveRequest(requestIdHex: created.requestIdHex)

        let second = Engine(fs: fs, clock: { Date(timeIntervalSince1970: 0) })
        XCTAssertNil(try second.sptRestorePendingReceiveRequest(),
                     "a cancelled request is terminal and must not come back as pending")
    }

    /// An empty store restores nothing rather than inventing something.
    func testAnEmptyStoreRestoresNoRequest() throws {
        let engine = Engine(fs: MemoryFs(), clock: { Date(timeIntervalSince1970: 0) })
        XCTAssertNil(try engine.sptRestorePendingReceiveRequest())
    }

    // MARK: - the decrypted message does not reach the pasteboard

    /// The `Egress` enum had no case for the decrypted message, so the policy
    /// that says "pad material NEVER reaches the clipboard" had nothing to say
    /// about the one thing the pad exists to protect — and the Open screen
    /// rendered it with `.textSelection(.enabled)`, which routes text to the
    /// GENERAL pasteboard. That pasteboard is Universal-Clipboard-eligible, so
    /// the plaintext could leave the handset for any Mac or iPad on the same
    /// Apple ID.
    func testPlaintextMayNotLeaveByAnyEgress() {
        XCTAssertFalse(EgressPolicy.mayCopyToClipboard(.plaintext))
        XCTAssertFalse(EgressPolicy.mayRenderAsQr(.plaintext))
        XCTAssertFalse(EgressPolicy.mayShareAsFile(.plaintext))

        // The other two classes are unchanged: an envelope is meant to be copied,
        // and a courier bundle is meant to be handed over as a file.
        XCTAssertTrue(EgressPolicy.mayCopyToClipboard(.publicText))
        XCTAssertTrue(EgressPolicy.mayRenderAsQr(.publicText))
        XCTAssertTrue(EgressPolicy.mayShareAsFile(.fileOnly))
        XCTAssertFalse(EgressPolicy.mayCopyToClipboard(.fileOnly))
        XCTAssertFalse(EgressPolicy.mayRenderAsQr(.fileOnly))
    }

    /// AND THE POLICY IS APPLIED, not merely declared.
    ///
    /// A symbol ban cannot catch this: `LeakageAuditTests` forbids `UIPasteboard`
    /// in shipping source, and `.textSelection(.enabled)` is a declarative
    /// modifier that reaches the same pasteboard without the banned symbol ever
    /// appearing. So this asserts the modifier's ABSENCE at the one place that
    /// renders plaintext.
    func testTheOpenScreenDoesNotMakePlaintextSelectable() throws {
        let file = PostureGuardTests.kitRoot
            .appendingPathComponent("Sources/TruePadUI/MessageViews.swift")
        let text = PostureGuardTests.stripComments(
            try String(contentsOf: file, encoding: .utf8))

        // The region that renders the decrypted message.
        guard let start = text.range(of: "if let plaintext = model.plaintext") else {
            return XCTFail("the Open screen no longer renders `model.plaintext` — "
                           + "this guard is now looking at nothing")
        }
        let region = text[start.lowerBound...].prefix(700)
        XCTAssertTrue(region.contains("Text(plaintext)"),
                      "precondition: this region must be the one that renders the message")
        XCTAssertFalse(region.contains("textSelection"),
                       "the decrypted message must not be selectable — selection routes it to "
                       + "the general pasteboard, which syncs across the operator's devices")

        // POSITIVE CONTROL. The envelope IS selectable, so this probe can see a
        // `textSelection` when one is present and is not passing vacuously.
        XCTAssertTrue(text.contains("textSelection(.enabled)"),
                      "the envelope must still be selectable — if nothing in this file is, the "
                      + "check above proves nothing")
    }

    // MARK: - the claims the UI makes about itself

    /// The About screen and the empty state both used to say TruePad "never
    /// invents pad material" / "does not invent pad bytes". The app's own Create
    /// screen generates pad bytes from the device CSPRNG, so both were false.
    func testNoUiTextClaimsTruePadNeverGeneratesPadMaterial() throws {
        let root = PostureGuardTests.kitRoot.appendingPathComponent("Sources/TruePadUI")
        let files = try FileManager.default.subpathsOfDirectory(atPath: root.path)
            .filter { $0.hasSuffix(".swift") }
        XCTAssertFalse(files.isEmpty)

        var scanned = 0
        for name in files {
            // COMMENTS STRIPPED. The fix left a comment saying NOT to make this
            // claim, and the first version of this test failed on that sentence —
            // the same prose-versus-code mistake the posture guards already
            // learned. What is asserted is what the app DISPLAYS.
            let raw = try String(contentsOf: root.appendingPathComponent(name), encoding: .utf8)
            let text = PostureGuardTests.stripComments(raw)
            scanned += 1
            for claim in ["never invents pad material",
                          "does not invent pad bytes",
                          "never generates pad"] {
                XCTAssertFalse(text.contains(claim),
                               "\(name) states \"\(claim)\", which the Create screen contradicts")
            }
        }
        XCTAssertGreaterThan(scanned, 3)
    }

    /// And the device-CSPRNG path must still record the frozen wire name, because
    /// that name is what makes the evaluator classify it as software-csprng — the
    /// hard disqualifier the Create screen warns about.
    func testTheDeviceSourcePathWouldBeClassifiedAsSoftwareCsprng() throws {
        let fs = MemoryFs()
        let pairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        let engine = Engine(fs: fs, clock: { Date(timeIntervalSince1970: 0) },
                            pairIdSource: { Hex.decode(pairId)! })
        let need = try Partition.requiredSourceLength(capacity: 256, capacityRecords: 4)
        _ = try engine.gen(label: "device",
                           sources: [SourceInput(name: deviceSourceNameWire,
                                                 declaredOrigin: "this device's random generator",
                                                 bytes: randomBytes(need))],
                           encryptionBytes: 256, authRecords: 4)
        let row = MeterRow(try XCTUnwrap(try engine.status(pairId).meters[.aToB]))
        XCTAssertEqual(row.verdict, "NOT ELIGIBLE",
                       "a device-generated pad must read exactly what the Create screen promises")
    }
}
