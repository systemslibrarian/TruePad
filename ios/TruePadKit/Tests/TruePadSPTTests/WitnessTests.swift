import Foundation
import TruePadCore
@testable import TruePadStorage
import XCTest

/// The rollback witness.
///
/// The interesting tests here are the ones that demonstrate the LIMITS rather
/// than the capability: the weak same-domain configuration in which the witness
/// detects nothing, and the fail-open/fail-closed split. A witness that were only
/// tested in its happy configuration would look far stronger than it is.
final class WitnessTests: XCTestCase {
    let pairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"

    func highWaters(_ o: Int, _ s: Int, _ a: Int) -> StoreHighWaters {
        StoreHighWaters(nextOffset: o, nextSequence: s, attemptsReserved: a)
    }

    func journalText(_ fs: MemoryFs) -> String {
        String(decoding: ((try? fs.readFile(witnessLogPath(pairId))) ?? nil) ?? [], as: UTF8.self)
    }

    // MARK: - provisioning

    func testBootstrapWritesExactlyTwoRecordsLeadingFramed() throws {
        let fs = MemoryFs()
        let w = LocalWitness(fs: fs)
        try w.bootstrap(pairId: pairId, initial: nil)

        let text = journalText(fs)
        XCTAssertTrue(text.hasPrefix("\n"), "records are LEADING-newline framed")
        XCTAssertFalse(text.hasSuffix("\n"), "there is no trailing framing")
        let records = text.split(separator: "\n").map(String.init)
        XCTAssertEqual(records.count, 2, "bootstrap writes exactly two records")
        XCTAssertTrue(records[0].contains("\"d\":\"A->B\""), "A->B first")
        XCTAssertTrue(records[1].contains("\"d\":\"B->A\""), "B->A second")
        XCTAssertEqual(records[0], "{\"d\":\"A->B\",\"eno\":0,\"ans\":0,\"ar\":0}",
                       "the record is exactly four keys in this order")
    }

    /// A mid-life import must seed the witness with the imported high-waters, or
    /// the very first operation would be refused witness-regressed on a
    /// perfectly good pad.
    func testBootstrapSeedsImportedHighWaters() throws {
        let fs = MemoryFs()
        let w = LocalWitness(fs: fs)
        try w.bootstrap(pairId: pairId, initial: [
            .aToB: WitnessCounters(encryptionNextOffset: 512, authenticationNextSequence: 4,
                                   attemptsReserved: 2),
            .bToA: .zero,
        ])
        guard case .ok(let state) = w.preflight(pairId: pairId, direction: .aToB,
                                                store: highWaters(512, 4, 2)) else {
            return XCTFail("a freshly imported pair must not be refused")
        }
        XCTAssertEqual(state, .aligned)
    }

    // MARK: - rollback detection

    /// ANY one counter strictly below the witness is a rollback. All three are
    /// checked, because a restore that only put the header back would move only
    /// some of them.
    func testAnySingleCounterBelowTheWitnessIsARollback() throws {
        let fs = MemoryFs()
        let w = LocalWitness(fs: fs)
        try w.bootstrap(pairId: pairId, initial: nil)
        try w.advance(pairId: pairId, direction: .aToB,
                      counters: WitnessCounters(encryptionNextOffset: 256,
                                                authenticationNextSequence: 3,
                                                attemptsReserved: 5))

        // Control: exactly at the witness is aligned.
        guard case .ok(.aligned) = w.preflight(pairId: pairId, direction: .aToB,
                                               store: highWaters(256, 3, 5)) else {
            return XCTFail("equal high-waters should be aligned")
        }

        for (label, store) in [("offset", highWaters(255, 3, 5)),
                               ("sequence", highWaters(256, 2, 5)),
                               ("attemptsReserved", highWaters(256, 3, 4))] {
            guard case .refused(let reason, let message) =
                    w.preflight(pairId: pairId, direction: .aToB, store: store) else {
                return XCTFail("\(label) below the witness must be refused")
            }
            XCTAssertEqual(reason, "witness-regressed", label)
            XCTAssertTrue(message.contains("Nothing was burned."),
                          "\(label): the message must say nothing was burned")
        }
    }

    /// attemptsReserved is witnessed precisely so a restore cannot refill a
    /// contested record's verification budget. This is the counter a naive
    /// witness would omit.
    func testRestoringOnlyTheHeaderCannotRefillTheAttemptBudget() throws {
        let fs = MemoryFs()
        let w = LocalWitness(fs: fs)
        try w.bootstrap(pairId: pairId, initial: nil)
        // Eight attempts were reserved against a contested record.
        try w.advance(pairId: pairId, direction: .aToB,
                      counters: WitnessCounters(encryptionNextOffset: 0,
                                                authenticationNextSequence: 0,
                                                attemptsReserved: 8))
        // A restore puts back a store whose cursors match but whose attempt
        // budget is fresh.
        guard case .refused(let reason, _) = w.preflight(pairId: pairId, direction: .aToB,
                                                         store: highWaters(0, 0, 0)) else {
            return XCTFail("a refilled attempt budget must be refused")
        }
        XCTAssertEqual(reason, "witness-regressed")
    }

    /// AHEAD is normal, not a warning: it is what a store looks like after a torn
    /// advance or a crash between the commit and the advance.
    func testAStoreAheadOfItsWitnessIsAccepted() throws {
        let fs = MemoryFs()
        let w = LocalWitness(fs: fs)
        try w.bootstrap(pairId: pairId, initial: nil)
        guard case .ok(let state) = w.preflight(pairId: pairId, direction: .aToB,
                                                store: highWaters(128, 1, 1)) else {
            return XCTFail("a store ahead of its witness must be accepted")
        }
        XCTAssertEqual(state, .ahead)
    }

    // MARK: - the crash property that the framing exists for

    /// A crash mid-append leaves a newline-free partial. With LEADING framing
    /// that partial is bounded on the left by its own newline and on the right by
    /// the NEXT record's newline, so it is an isolated line the reader drops — it
    /// can never fuse into and destroy the record before or after it.
    func testATornAppendCannotDestroyTheRecordsAroundIt() throws {
        let fs = MemoryFs()
        let w = LocalWitness(fs: fs)
        try w.bootstrap(pairId: pairId, initial: nil)
        try w.advance(pairId: pairId, direction: .aToB,
                      counters: WitnessCounters(encryptionNextOffset: 100,
                                                authenticationNextSequence: 1,
                                                attemptsReserved: 1))

        // Now tear an append halfway through.
        let torn = Array("\n{\"d\":\"A->B\",\"eno\":200,\"a".utf8)
        try fs.appendFile(witnessLogPath(pairId), torn)

        // The good record before it must survive.
        guard case .refused(let reason, _) = w.preflight(pairId: pairId, direction: .aToB,
                                                         store: highWaters(99, 1, 1)) else {
            return XCTFail("the surviving record must still detect a rollback")
        }
        XCTAssertEqual(reason, "witness-regressed",
                       "a torn append must not erase the record before it")

        // And a subsequent clean advance re-records the high-water (self-heal).
        try w.advance(pairId: pairId, direction: .aToB,
                      counters: WitnessCounters(encryptionNextOffset: 300,
                                                authenticationNextSequence: 2,
                                                attemptsReserved: 2))
        guard case .ok(.aligned) = w.preflight(pairId: pairId, direction: .aToB,
                                               store: highWaters(300, 2, 2)) else {
            return XCTFail("the next clean advance must re-record the high-water")
        }
    }

    // MARK: - fail open vs fail closed

    /// Malformed lines are SKIPPED, and cannot pull the fold down. The fold is a
    /// maximum, so a junk or replayed low line is inert.
    func testMalformedLinesAreSkippedAndCannotLowerTheFold() throws {
        let fs = MemoryFs()
        let w = LocalWitness(fs: fs)
        try w.bootstrap(pairId: pairId, initial: nil)
        try w.advance(pairId: pairId, direction: .aToB,
                      counters: WitnessCounters(encryptionNextOffset: 500,
                                                authenticationNextSequence: 5,
                                                attemptsReserved: 5))

        for junk in [
            "\nnot json at all",
            "\n{\"d\":\"A->B\",\"eno\":0,\"ans\":0,\"ar\":0,\"extra\":1}",  // FIVE keys
            "\n{\"d\":\"A->B\",\"eno\":0,\"ans\":0}",                        // THREE keys
            "\n{\"d\":\"nope\",\"eno\":0,\"ans\":0,\"ar\":0}",               // bad direction
            "\n{\"d\":\"A->B\",\"eno\":1.0,\"ans\":0,\"ar\":0}",             // non-integer spelling
            "\n{\"d\":\"A->B\",\"eno\":1e3,\"ans\":0,\"ar\":0}",             // exponent spelling
            "\n{\"d\":\"A->B\",\"eno\":-5,\"ans\":0,\"ar\":0}",              // negative
        ] {
            try fs.appendFile(witnessLogPath(pairId), Array(junk.utf8))
        }

        // A replayed LOW record must also be inert, because the fold is a max.
        try fs.appendFile(witnessLogPath(pairId),
                          encodeWitnessRecord(.aToB, WitnessCounters(encryptionNextOffset: 1,
                                                                     authenticationNextSequence: 1,
                                                                     attemptsReserved: 1)))

        guard case .ok(.aligned) = w.preflight(pairId: pairId, direction: .aToB,
                                               store: highWaters(500, 5, 5)) else {
            return XCTFail("junk lines must not disturb the fold")
        }
        guard case .refused = w.preflight(pairId: pairId, direction: .aToB,
                                          store: highWaters(499, 5, 5)) else {
            return XCTFail("the high-water must still be 500")
        }
    }

    /// A PROVISIONED pair whose journal is missing, empty or entirely corrupt
    /// fails CLOSED. An established witness never reads as fresh, because a
    /// vanished witness is indistinguishable from a rollback that took it.
    func testAVanishedWitnessFailsClosed() throws {
        let w = LocalWitness(fs: MemoryFs())
        guard case .refused(let reason, let message) =
                w.preflight(pairId: pairId, direction: .aToB, store: highWaters(0, 0, 0)) else {
            return XCTFail("an absent journal must fail closed")
        }
        XCTAssertEqual(reason, "witness-inconsistent")
        XCTAssertTrue(message.contains(witnessLogPath(pairId)),
                      "the message names the journal path")
        XCTAssertTrue(message.hasSuffix("Nothing was burned."))

        // Empty, and all-corrupt, are the same case and the same message.
        for content in ["", "\ngarbage\nmore garbage"] {
            let fs = MemoryFs()
            try fs.writeFileAtomic(witnessLogPath(pairId), Array(content.utf8))
            guard case .refused(let r, _) = LocalWitness(fs: fs)
                    .preflight(pairId: pairId, direction: .aToB, store: highWaters(0, 0, 0)) else {
                return XCTFail("an unreadable journal must fail closed")
            }
            XCTAssertEqual(r, "witness-inconsistent")
        }
    }

    /// A journal with records for only ONE direction is a DIFFERENT case, with a
    /// different message. Swapping the two messages is a visible behaviour change.
    func testAMissingDirectionHasItsOwnMessage() throws {
        let fs = MemoryFs()
        try fs.appendFile(witnessLogPath(pairId), encodeWitnessRecord(.bToA, .zero))
        let w = LocalWitness(fs: fs)

        guard case .refused(let reason, let message) =
                w.preflight(pairId: pairId, direction: .aToB, store: highWaters(0, 0, 0)) else {
            return XCTFail("a missing direction must fail closed")
        }
        XCTAssertEqual(reason, "witness-inconsistent")
        XCTAssertTrue(message.contains("no record for A->B"),
                      "the per-direction message must name the direction: \(message)")
        XCTAssertTrue(message.hasSuffix("Nothing was burned."))
        XCTAssertFalse(message.contains("Nothing was burned. Nothing was burned."),
                       "the suffix must not be doubled")

        // The direction that IS present still works.
        guard case .ok = w.preflight(pairId: pairId, direction: .bToA,
                                     store: highWaters(0, 0, 0)) else {
            return XCTFail("the present direction should be fine")
        }
    }

    // MARK: - the honest limits

    /// THE WEAK CONFIGURATION, demonstrated rather than argued away.
    ///
    /// A witness that shares a failure domain with the store is carried along by
    /// whatever carries the store. Restore both together and the rollback is
    /// INVISIBLE. This is why the Engine takes a separate Fs, and why binding
    /// both to one root is called honest-but-weak rather than "the default".
    func testAWitnessInTheSameDomainCannotDetectTheRollback() throws {
        let shared = MemoryFs()
        let w = LocalWitness(fs: shared)
        try w.bootstrap(pairId: pairId, initial: nil)
        try w.advance(pairId: pairId, direction: .aToB,
                      counters: WitnessCounters(encryptionNextOffset: 4096,
                                                authenticationNextSequence: 32,
                                                attemptsReserved: 9))

        // Snapshot BOTH (they are the same domain), then roll BOTH back.
        let backup = MemoryFs().snapshot()  // an empty "earlier" state
        _ = backup
        let earlier = MemoryFs()
        try earlier.appendFile(witnessLogPath(pairId), encodeWitnessRecord(.aToB, .zero))
        try earlier.appendFile(witnessLogPath(pairId), encodeWitnessRecord(.bToA, .zero))
        let restored = LocalWitness(fs: earlier)

        // The restored store is at genesis, and so is the restored witness. The
        // rollback is undetectable: this is a PASS, and it is the point.
        guard case .ok(.aligned) = restored.preflight(pairId: pairId, direction: .aToB,
                                                      store: highWaters(0, 0, 0)) else {
            return XCTFail("the same-domain configuration cannot detect the rollback — "
                           + "if this ever refuses, the limitation has changed and "
                           + "docs/IOS-SECURITY.md must be updated")
        }

        // Whereas a SEPARATE domain — a witness the restore did not touch — does
        // catch exactly the same rollback.
        guard case .refused(let reason, _) = w.preflight(pairId: pairId, direction: .aToB,
                                                         store: highWaters(0, 0, 0)) else {
            return XCTFail("a separate-domain witness must catch the rollback")
        }
        XCTAssertEqual(reason, "witness-regressed")
    }

    /// The witness records ONLY the three counters and the direction. No secret,
    /// no pad byte, no ciphertext, ever reaches it.
    func testTheJournalCarriesNothingButCountersAndDirection() throws {
        let fs = MemoryFs()
        let w = LocalWitness(fs: fs)
        try w.bootstrap(pairId: pairId, initial: nil)
        try w.advance(pairId: pairId, direction: .aToB,
                      counters: WitnessCounters(encryptionNextOffset: 7,
                                                authenticationNextSequence: 8,
                                                attemptsReserved: 9))
        let text = journalText(fs)
        for line in text.split(separator: "\n") {
            guard let parsed = try? parseStrictJson(String(line)),
                  let map = parsed.memberMap else {
                return XCTFail("every record should parse")
            }
            XCTAssertEqual(Set(map.keys), ["d", "eno", "ans", "ar"],
                           "a record carries exactly these four keys and nothing else")
        }
    }

    /// `report` is the status path and must refuse nothing, ever — it maps the
    /// same comparisons onto a state instead.
    func testReportRefusesNothing() throws {
        let empty = LocalWitness(fs: MemoryFs())
        XCTAssertEqual(empty.report(pairId: pairId, direction: .aToB, store: highWaters(0, 0, 0)),
                       .inconsistent)

        let fs = MemoryFs()
        let w = LocalWitness(fs: fs)
        try w.bootstrap(pairId: pairId, initial: nil)
        try w.advance(pairId: pairId, direction: .aToB,
                      counters: WitnessCounters(encryptionNextOffset: 10,
                                                authenticationNextSequence: 1,
                                                attemptsReserved: 1))
        XCTAssertEqual(w.report(pairId: pairId, direction: .aToB, store: highWaters(10, 1, 1)),
                       .aligned)
        XCTAssertEqual(w.report(pairId: pairId, direction: .aToB, store: highWaters(20, 2, 2)),
                       .ahead)
        XCTAssertEqual(w.report(pairId: pairId, direction: .aToB, store: highWaters(9, 1, 1)),
                       .regressed)
    }

    /// A `none` witness is a total no-op reporting n/a — no witness, no claim.
    func testNoneWitnessIsATotalNoOp() throws {
        let w = NoneWitness()
        XCTAssertEqual(w.kind, .none)
        try w.bootstrap(pairId: pairId, initial: nil)
        try w.advance(pairId: pairId, direction: .aToB, counters: .zero)
        guard case .ok(.na) = w.preflight(pairId: pairId, direction: .aToB,
                                          store: highWaters(0, 0, 0)) else {
            return XCTFail("none always reports n/a")
        }
        XCTAssertEqual(w.report(pairId: pairId, direction: .aToB, store: highWaters(0, 0, 0)), .na)
    }

    func testWitnessKindWireSpellings() {
        XCTAssertEqual(WitnessKind.none.rawValue, "ios-none")
        XCTAssertEqual(WitnessKind.local.rawValue, "ios-local-witness")
        XCTAssertEqual(WitnessKind.fromWire("ios-local-witness"), .local)
        XCTAssertNil(WitnessKind.fromWire("android-local-witness"),
                     "an unrecognised kind is nil, so the caller can fail closed")
        XCTAssertNil(WitnessKind.fromWire(nil))
    }
}
