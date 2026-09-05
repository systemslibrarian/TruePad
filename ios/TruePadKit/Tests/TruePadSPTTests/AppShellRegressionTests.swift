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

        // READ THROUGH A FRESH URL EVERY TIME. `URL` CACHES resource values, so a
        // URL that has already been asked once answers from that cache and not
        // from the filesystem. Reading the same `root` value after clearing the
        // flag through a copy returned the STALE `true` and failed the
        // precondition — the test was reporting on its own cache rather than on
        // the directory.
        func excluded() throws -> Bool? {
            try URL(fileURLWithPath: root.path)
                .resourceValues(forKeys: [.isExcludedFromBackupKey])
                .isExcludedFromBackup
        }

        let first = try DarwinFs(root: root)
        XCTAssertFalse(first.backupExclusionUnavailable,
                       "the platform should honour the exclusion in a temp directory")
        XCTAssertEqual(try excluded(), true)

        // CLEAR IT, then reopen: the second open must reassert it. This is the
        // case the old code missed entirely, because the directory already
        // existed and `makeDirectory` returned early.
        var mutable = URL(fileURLWithPath: root.path)
        var clear = URLResourceValues()
        clear.isExcludedFromBackup = false
        try mutable.setResourceValues(clear)
        XCTAssertEqual(try excluded(), false, "precondition: the flag is cleared")

        _ = try DarwinFs(root: root)
        XCTAssertEqual(try excluded(), true,
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

    // MARK: - the role survives view evaluation order

    /// AN ORDERING DEPENDENCY, removed — not an observed defect. The models were
    /// handed a role their parent computed in `reload()` on appear, while
    /// `NavigationLink` builds its destination eagerly. On the device the role was
    /// in fact derived correctly; a bad accessibility query during the two-device
    /// ceremony made it look otherwise. The dependency was still worth removing.
    ///
    /// The models are `#if os(iOS)` and CI cannot execute them, so the RULE lives
    /// in `PartyRoleResolver` — which CI can — and the models call it.
    func testTheRoleIsResolvedFromTheStoreNotFromAParentView() throws {
        let fs = MemoryFs()
        let pairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        let engine = Engine(fs: fs, clock: { Date(timeIntervalSince1970: 0) },
                            pairIdSource: { Hex.decode(pairId)! })
        let need = try Partition.requiredSourceLength(capacity: 256, capacityRecords: 4)
        _ = try engine.gen(label: "created-here",
                           sources: [SourceInput(name: deviceSourceNameWire,
                                                 declaredOrigin: "test",
                                                 bytes: randomBytes(need))],
                           encryptionBytes: 256, authRecords: 4)

        // No parent, no reload — exactly the eager-destination case.
        XCTAssertEqual(PartyRoleResolver.resolve(engine: engine, pairId: pairId), Party.a,
                       "a pad generated here resolves to A with nothing else loaded")

        // And the importing side, which is the half the ceremony exercised.
        let exported = try engine.exportPair(pairId: pairId)
        let fsB = MemoryFs()
        let b = Engine(fs: fsB, clock: { Date(timeIntervalSince1970: 0) })
        _ = try b.importPair(label: "p", container: exported.container)
        XCTAssertEqual(PartyRoleResolver.resolve(engine: b, pairId: pairId), Party.b,
                       "an imported pad resolves to B, which is what the ceremony needs")

        // A pad that is not there resolves to nothing rather than guessing.
        XCTAssertNil(PartyRoleResolver.resolve(engine: b, pairId: "0000000000000000000000000000dead"))
    }

    // MARK: - one role per pair, derived, never guessed

    /// THE REUSE DEFECT THIS CLOSES, stated as the scenario that produced it.
    ///
    /// The Browser Edition pins the role per pair at acquisition and the CLI
    /// refuses to guess. Both mobile editions dropped that guard: iOS carried two
    /// INDEPENDENT defaults, `SendModel.role = .a` and `OpenModel.role = .b`. A
    /// device that IMPORTED a pad therefore opened correctly at its default —
    /// which is what hid the problem — and then SENT on party A's half.
    ///
    /// Two devices holding one pair both burned `A->B` at the same offsets
    /// against the same one-time authentication record. No engine could catch it:
    /// each store's counters advance monotonically on its own copy, so the reuse
    /// is ACROSS copies, not within a store.
    func testTheRoleIsDerivedFromHowThePadWasAcquired() {
        // The creating device is A; the importing device is B. That is the whole
        // rule, and it is what makes two copies of one pair burn opposite halves.
        XCTAssertEqual(PartyRole.derive(from: .generatedHere), .a)
        XCTAssertEqual(PartyRole.derive(from: .imported), .b)
    }

    /// AN UNKNOWN ORIGIN MUST NOT DEFAULT TO A.
    ///
    /// Returning `.a` here would reinstate the defect for exactly the pads most
    /// likely to be wrong — the ones whose provenance evidence was lost. Refusing
    /// costs LOSS, which this project accepts. Guessing costs REUSE, which it
    /// does not.
    func testAnUnknownOriginRefusesToGuess() {
        XCTAssertNil(PartyRole.derive(from: .unknown),
                     "an unknown origin must ask the operator, not pick a side")
        XCTAssertFalse(PartyRole.unknownOriginPrompt.isEmpty,
                       "and it must have something to say when it asks")
    }

    /// TWO COPIES OF ONE PAIR BURN OPPOSITE HALVES. This is the property the
    /// defect violated, exercised end to end against the real engine.
    func testTwoCopiesOfOnePairBurnOppositeDirections() throws {
        // A generates; B imports the courier bundle. Two independent stores, as
        // two handsets would have.
        let fsA = MemoryFs()
        let pairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        let engineA = Engine(fs: fsA, clock: { Date(timeIntervalSince1970: 0) },
                             pairIdSource: { Hex.decode(pairId)! })
        let need = try Partition.requiredSourceLength(capacity: 512, capacityRecords: 8)
        _ = try engineA.gen(label: "pair", sources: [SourceInput(name: deviceSourceNameWire,
                                                                declaredOrigin: "test",
                                                                bytes: randomBytes(need))],
                            encryptionBytes: 512, authRecords: 8)

        let exported = try engineA.exportPair(pairId: pairId)
        let fsB = MemoryFs()
        let engineB = Engine(fs: fsB, clock: { Date(timeIntervalSince1970: 0) })
        _ = try engineB.importPair(label: "pair", container: exported.container)

        let originA = try engineA.status(pairId).origin
        let originB = try engineB.status(pairId).origin
        XCTAssertEqual(originA, .generatedHere)
        XCTAssertEqual(originB, .imported, "the importing device must record that it imported")

        let roleA = try XCTUnwrap(PartyRole.derive(from: originA))
        let roleB = try XCTUnwrap(PartyRole.derive(from: originB))
        XCTAssertNotEqual(roleA, roleB,
                          "two copies of one pair must not be the same party — that is the "
                          + "reuse this rule exists to prevent")

        // AND THE DIRECTIONS THEY BURN MUST DIFFER. Identical roles produced
        // identical directions, identical offsets and an identical auth record.
        let sentA = try engineA.burn(pairId: pairId, role: roleA, plaintext: Array("from A".utf8))
        let sentB = try engineB.burn(pairId: pairId, role: roleB, plaintext: Array("from B".utf8))
        XCTAssertNotEqual(sentA.envelope, sentB.envelope)

        // Each side opens what the other sent, which is only possible if they
        // spent opposite halves.
        let atB = try engineB.open(pairId: pairId, role: roleB, envelopeText: sentA.envelope)
        XCTAssertEqual(String(decoding: atB.plaintext, as: UTF8.self), "from A")
        let atA = try engineA.open(pairId: pairId, role: roleA, envelopeText: sentB.envelope)
        XCTAssertEqual(String(decoding: atA.plaintext, as: UTF8.self), "from B")
    }

    /// THE OLD DEFAULTS, DEMONSTRATED AS THE FAILURE THEY WERE. Had both devices
    /// used the previous send default of `.a`, they would have produced two
    /// envelopes over the same pad material.
    func testTheOldSharedDefaultWouldHaveSpentTheSameMaterialTwice() throws {
        let pairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        func freshCopy() throws -> Engine {
            let fs = MemoryFs()
            let e = Engine(fs: fs, clock: { Date(timeIntervalSince1970: 0) },
                           pairIdSource: { Hex.decode(pairId)! })
            let need = try Partition.requiredSourceLength(capacity: 512, capacityRecords: 8)
            _ = try e.gen(label: "pair",
                          sources: [SourceInput(name: deviceSourceNameWire,
                                                declaredOrigin: "test",
                                                bytes: [UInt8](repeating: 0x5A, count: need))],
                          encryptionBytes: 512, authRecords: 8)
            return e
        }
        // Two copies of the SAME pad material, as two handsets holding one pair.
        let copy1 = try freshCopy()
        let copy2 = try freshCopy()

        // Both at the old default role .a — the bug.
        let one = try copy1.burn(pairId: pairId, role: .a, plaintext: Array("aaaa".utf8))
        let two = try copy2.burn(pairId: pairId, role: .a, plaintext: Array("bbbb".utf8))

        // Neither engine refused. Both succeeded. That is precisely why this had
        // to be fixed above the engine: one-time material spent twice, and
        // nothing in the store could see it.
        XCTAssertNotEqual(one.envelope, two.envelope,
                          "different plaintexts, but the SAME pad offsets and the same "
                          + "one-time authentication record — this is the reuse")
    }

    // MARK: - a receive-request QR can actually be drawn

    /// FOUND ON A HANDSET, and only on a handset. `QrCodeView.render` hardcoded
    /// error-correction level "H", whose byte-mode capacity is 1273 bytes. A TPR2
    /// receive request is ~1652. CoreImage on the device produced no image, the
    /// Receive screen fell back to "This code could not be drawn", and the
    /// SENDER HAD NOTHING TO SCAN — the optical ceremony was impossible on iOS.
    ///
    /// macOS CoreImage renders the same over-capacity payload anyway, so a host
    /// test of the renderer would have passed. What is testable on the host is
    /// the DECISION, so that is what lives in `QrCorrection` and what this pins.
    func testAReceiveRequestFitsTheChosenCorrectionLevel() throws {
        let engine = Engine(fs: MemoryFs(), clock: { Date(timeIntervalSince1970: 0) })
        let request = try engine.sptCreateReceiveRequest()
        let byteCount = Data(request.tpr2Text.utf8).count

        // The real thing, not a stand-in: a request is past H and must not be
        // offered H.
        XCTAssertGreaterThan(byteCount, 1273,
                             "precondition: a receive request really is past H's capacity")
        let level = try XCTUnwrap(QrCorrection.strongestLevel(forByteCount: byteCount),
                                  "a receive request must be drawable at SOME level")
        XCTAssertNotEqual(level, "H", "H cannot carry a receive request")

        // And the level chosen must genuinely have room for it.
        let capacity = try XCTUnwrap(QrCorrection.capacities.first { $0.level == level }?.bytes)
        XCTAssertLessThanOrEqual(byteCount, capacity)
    }

    /// STRONGEST-FIRST, because these codes are read off a screen at an angle in
    /// bad light. A level is only given up when the payload leaves no choice.
    func testTheStrongestLevelThatFitsIsChosen() {
        XCTAssertEqual(QrCorrection.strongestLevel(forByteCount: 1), "H")
        XCTAssertEqual(QrCorrection.strongestLevel(forByteCount: 1273), "H")
        XCTAssertEqual(QrCorrection.strongestLevel(forByteCount: 1274), "Q")
        XCTAssertEqual(QrCorrection.strongestLevel(forByteCount: 1663), "Q")
        XCTAssertEqual(QrCorrection.strongestLevel(forByteCount: 1664), "M")
        XCTAssertEqual(QrCorrection.strongestLevel(forByteCount: 2331), "M")
        XCTAssertEqual(QrCorrection.strongestLevel(forByteCount: 2332), "L")
        XCTAssertEqual(QrCorrection.strongestLevel(forByteCount: 2953), "L")
    }

    /// THE FUNCTION THE RENDERER ACTUALLY CALLS.
    ///
    /// The tests above pin `strongestLevel`, which is the STRONGEST level the QR
    /// specification allows for a payload — and is precisely the policy that made
    /// a 1652-byte receive code unreadable on a real handset, because it picks Q
    /// and a 179-module symbol. `renderModules` calls `level(forByteCount:)`
    /// instead, which deliberately gives redundancy away above H's capacity to
    /// get bigger modules.
    ///
    /// Pinning only `strongestLevel` left the shipping policy untested: the two
    /// functions disagree on every payload above 1273 bytes, so a change that
    /// reverted `level` to "strongest that fits" would have broken the physical
    /// scan again with the whole suite still green.
    func testTheRendererChoosesReadabilityOverRedundancyAboveHsCapacity() {
        // At or below H's capacity the strongest level is free, and both agree.
        XCTAssertEqual(QrCorrection.level(forByteCount: 1), "H")
        XCTAssertEqual(QrCorrection.level(forByteCount: 1273), "H")
        XCTAssertEqual(QrCorrection.level(forByteCount: 1273),
                       QrCorrection.strongestLevel(forByteCount: 1273))

        // Above it, the renderer takes the LOWEST redundancy — the smallest
        // symbol, the largest modules — and the two functions part company.
        for dense in [1274, 1663, 1664, 2331, 2332, 2953] {
            XCTAssertEqual(QrCorrection.level(forByteCount: dense), "L",
                           "\(dense) bytes must draw at L for the modules to stay resolvable")
        }
        XCTAssertNotEqual(QrCorrection.level(forByteCount: 1274),
                          QrCorrection.strongestLevel(forByteCount: 1274),
                          "if these agree the readability policy has been reverted")

        // A real receive code is the case that failed on hardware.
        let tpr2Bytes = 1652
        XCTAssertEqual(QrCorrection.level(forByteCount: tpr2Bytes), "L")
        XCTAssertEqual(QrCorrection.strongestLevel(forByteCount: tpr2Bytes), "Q",
                       "the old policy is what chose Q, and Q is what the camera could not read")

        // Nothing above version 40's byte-mode capacity may claim a level.
        XCTAssertNil(QrCorrection.level(forByteCount: 2954))
        XCTAssertNil(QrCorrection.strongestLevel(forByteCount: 2954))

        // Past the largest symbol there is no honest answer, and the builder's
        // own maxQrCharacters refuses before this is ever reached.
        XCTAssertNil(QrCorrection.strongestLevel(forByteCount: 2954))
        XCTAssertEqual(QrPayloadBuilder.maxQrCharacters, 2953,
                       "the builder's ceiling and L's capacity must agree")
    }

    // MARK: - the share-sheet cleanup actually removes the file

    /// THE FIRST VERSION OF THIS FIX WAS A NO-OP, and every test was green.
    ///
    /// `discardSharedFile()` read `fileToShare` — the same property the
    /// `.sheet(item:)` presentation is bound to — and SwiftUI clears an `item:`
    /// binding BEFORE it calls `onDismiss`. The binding was already nil, the
    /// `if let` failed, nothing was removed, and a complete copy of the pad
    /// stayed in `tmp/` for the rest of the session.
    ///
    /// Two things had to change for CI to be able to see that. The lifetime now
    /// lives in `HandoffScratchFile`, which is host-reachable — the models are
    /// `#if os(iOS)` and `swift test` cannot execute them at all — and the rule
    /// is stated as "remember the file independently of anything the view layer
    /// may clear".
    func testTheScratchFileIsRemovedWithoutConsultingAnyBinding() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("truepad-scratch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let file = dir.appendingPathComponent("pad.tpair")
        try Data("a whole pad".utf8).write(to: file)

        let scratch = HandoffScratchFile()
        XCTAssertFalse(scratch.isTracking)
        scratch.track(file)
        XCTAssertTrue(scratch.isTracking)

        XCTAssertTrue(scratch.discard(), "a tracked file must actually be removed")
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path),
                       "the scratch copy of the pad must be gone")
        XCTAssertFalse(scratch.isTracking)
    }

    /// Idempotent, and honest about what it did: a second discard removes nothing
    /// and says so, rather than reporting a deletion that did not happen.
    func testDiscardIsIdempotentAndReportsWhatItActuallyDid() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("truepad-scratch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let scratch = HandoffScratchFile()
        XCTAssertFalse(scratch.discard(), "nothing tracked means nothing removed")

        let file = dir.appendingPathComponent("transfer.tps2")
        try Data("sealed".utf8).write(to: file)
        scratch.track(file)
        XCTAssertTrue(scratch.discard())
        XCTAssertFalse(scratch.discard(), "a second dismiss must not claim a removal")

        // A tracked file that vanished underneath us reports false rather than
        // pretending. The launch sweep is what covers that case.
        let ghost = dir.appendingPathComponent("pad.tpair")
        scratch.track(ghost)
        XCTAssertFalse(scratch.discard(), "removing an absent file is not a deletion")
    }

    /// THE GUARD THAT WOULD HAVE CAUGHT THE ORIGINAL BUG.
    ///
    /// The models cannot be executed by `swift test`, so their WIRING is checked
    /// as source instead: neither `discardSharedFile` may decide what to delete by
    /// reading `fileToShare`, because that binding is already nil when SwiftUI
    /// calls it.
    func testNeitherModelDecidesWhatToDeleteFromThePresentationBinding() throws {
        for name in ["Models.swift", "CeremonyModels.swift"] {
            let file = PostureGuardTests.kitRoot
                .appendingPathComponent("Sources/TruePadUI/\(name)")
            let text = PostureGuardTests.stripComments(
                try String(contentsOf: file, encoding: .utf8))

            guard let r = text.range(of: "func discardSharedFile()") else {
                return XCTFail("\(name) no longer has discardSharedFile — this guard is "
                               + "now looking at nothing")
            }
            let body = text[r.lowerBound...].prefix(320)
            XCTAssertTrue(body.contains("scratch.discard()"),
                          "\(name) must delegate to HandoffScratchFile")
            XCTAssertFalse(body.contains("if let file = fileToShare"),
                           "\(name) must not read the presentation binding to decide what to "
                           + "remove — SwiftUI has already cleared it by then")
        }
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

    /// SEALING MUST NOT STRAND THE PAD, and must not unblock the raw pad either.
    ///
    /// One flag was answering two questions. Sealing commits the package to disk
    /// and the engine will hand back those exact bytes for the same request, but
    /// the pad screen hid the sealed-transfer button as soon as the handoff marker
    /// said `.sealed` — so dismissing the sheet before saving the file left the
    /// operator with a committed package and no affordance that could reach it.
    func testAlreadySealedPadsCanStillHandOverThePackageButNotTheRawPad() {
        // Sealed: the package may be re-offered, the raw pad may not.
        XCTAssertTrue(HandoffPolicy.mayResharedSealedPackage(sealed: true, imported: false))
        XCTAssertFalse(HandoffPolicy.mayExportRawPad(handedOver: true, imported: false),
                       "a pad that has been handed over must never leave as a file again")

        // Handed over physically: neither. There is no committed package to
        // re-offer, and the raw pad is spent.
        XCTAssertFalse(HandoffPolicy.mayResharedSealedPackage(sealed: false, imported: false))
        XCTAssertFalse(HandoffPolicy.mayExportRawPad(handedOver: true, imported: false))

        // Untouched and created here: the raw pad may leave; there is nothing
        // sealed to re-offer yet.
        XCTAssertTrue(HandoffPolicy.mayExportRawPad(handedOver: false, imported: false))
        XCTAssertFalse(HandoffPolicy.mayResharedSealedPackage(sealed: false, imported: false))

        // IMPORTED IS NEVER PASSED ON, by either route, in any state. Two people
        // holding the same pad is the reuse this app exists to prevent.
        XCTAssertFalse(HandoffPolicy.mayExportRawPad(handedOver: false, imported: true))
        XCTAssertFalse(HandoffPolicy.mayResharedSealedPackage(sealed: true, imported: true))
    }

    /// THE RECEIVE SCREEN MUST BE ABLE TO ASK ABOUT THE REQUEST IT IS HOLDING.
    ///
    /// `sptRestorePendingReceiveRequest` answers "what is the newest pending
    /// request?", which is a different question and cannot decide whether the one
    /// already on screen is still live. Once opening a sealed pad became
    /// reachable, the screen went on advertising a request that an open had
    /// consumed — QR, twelve words, and a Cancel button that could only throw,
    /// because the engine refuses to cancel a consumed request.
    func testAConsumedOrCancelledRequestStopsBeingPending() throws {
        let engine = Engine(fs: MemoryFs(), clock: { Date(timeIntervalSince1970: 0) })

        let created = try engine.sptCreateReceiveRequest()
        XCTAssertTrue(engine.sptReceiveRequestIsPending(requestIdHex: created.requestIdHex),
                      "a freshly published request is pending")

        _ = try engine.sptCancelReceiveRequest(requestIdHex: created.requestIdHex)
        XCTAssertFalse(engine.sptReceiveRequestIsPending(requestIdHex: created.requestIdHex),
                       "a cancelled request must not read as pending")

        // An identifier that was never published, and a malformed one, are both
        // "not pending" rather than an error the screen has to handle.
        XCTAssertFalse(engine.sptReceiveRequestIsPending(
            requestIdHex: String(repeating: "a", count: 32)))
        XCTAssertFalse(engine.sptReceiveRequestIsPending(requestIdHex: "not-a-request-id"))
    }

    /// A REJECTED request is equally finished. Rejecting is how a failed word
    /// comparison is meant to end, so it must not read as pending afterwards.
    func testARejectedRequestStopsBeingPending() throws {
        let engine = Engine(fs: MemoryFs(), clock: { Date(timeIntervalSince1970: 0) })
        let created = try engine.sptCreateReceiveRequest()
        _ = try engine.sptRejectReceiveRequest(requestIdHex: created.requestIdHex)
        XCTAssertFalse(engine.sptReceiveRequestIsPending(requestIdHex: created.requestIdHex))
        XCTAssertNil(try engine.sptRestorePendingReceiveRequest(),
                     "and it must never be restored onto the screen again")
    }
}
