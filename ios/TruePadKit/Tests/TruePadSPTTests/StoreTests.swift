import Foundation
import TruePadCore
import TruePadStorage
import XCTest

/// Store Format v2: byte-exact head.json, the durable transitions, and the §12.1
/// reconciliation that refuses a header older than its own history.
final class StoreTests: XCTestCase {
    typealias H = OtpKernelVectorTests

    static let at = "2026-09-01T00:00:00.000Z"

    func vectors(_ name: String) throws -> [String: Any] {
        let url = XWingKATTests.repoRoot.appendingPathComponent("android/vectors/\(name)")
        return try JSONSerialization.jsonObject(with: try Data(contentsOf: url)) as! [String: Any]
    }

    func head(pairId: String = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4",
              capacity: Int = 4096,
              capacityRecords: Int = 24,
              sourceLength: Int = 9728,
              record: RecordSpec = .variable) -> HeadV2 {
        HeadV2(
            pairId: pairId, direction: .aToB,
            sourceDeclarations: [SourceDeclaration(name: "s.bin", declaredOrigin: "declared",
                                                   lengthBytes: sourceLength)],
            capacity: capacity, nextOffset: 0,
            capacityRecords: capacityRecords, nextSequence: 0,
            verifyAttemptLimit: 8, maxAuthLookahead: 64, record: record,
            failureThreshold: 32, failureCount: 0, clearedAtFailureCount: 0,
            perSequenceAttempts: [:])
    }

    // MARK: - the JavaScript property-order rule

    /// THE byte-exactness test for head.json.
    ///
    /// The fixture drives eight authentication failures in the deliberately
    /// jumbled order [12, 5, 19, 3, 11, 2, 10, 1] and pins the head the released
    /// implementation wrote. JavaScript emits integer-like object keys FIRST, in
    /// ascending NUMERIC order, whatever order they were inserted in — so a port
    /// that preserved insertion order would produce a head that parses identically
    /// and serializes DIFFERENTLY, silently breaking the interop claim head.json
    /// exists to make. Nothing but a fixture like this catches that.
    func testHeadIsByteIdenticalIncludingKeyOrder() throws {
        let fixture = try vectors("head-key-order.json")
        let failureOrder = fixture["failureOrder"] as! [Int]
        let expectedHead = fixture["headText"] as! String
        let expectedJournal = fixture["journalText"] as! String
        let expectedSubstring = fixture["perSequenceAttemptsSubstring"] as! String

        let fs = MemoryFs()
        let prefix = "pair/a-to-b"
        var h = head(pairId: fixture["pairId"] as! String,
                     capacity: fixture["capacity"] as! Int,
                     capacityRecords: fixture["capacityRecords"] as! Int,
                     sourceLength: fixture["requiredSourceLength"] as! Int)

        try initStore(fs: fs, prefix: prefix, head: h,
                      secret: [UInt8](repeating: 0x77, count: secretLength(h)), at: Self.at)

        // Each failure is a reservation followed by a persisted failure — the O3
        // then O4 order, which is what the journal records.
        for sequence in failureOrder {
            try reserveAttempt(fs: fs, prefix: prefix, sequence: sequence, at: Self.at)
            h = try persistAuthFail(fs: fs, prefix: prefix, head: h, sequence: sequence, at: Self.at)
        }

        let writtenHead = String(decoding: try fs.readFile(storePath(prefix, headFile))!, as: UTF8.self)
        XCTAssertTrue(writtenHead.contains(expectedSubstring),
                      "perSequenceAttempts keys must be in ascending NUMERIC order, not insertion order")
        XCTAssertEqual(writtenHead, expectedHead, "head.json is not byte-identical")

        let writtenJournal = String(decoding: try fs.readFile(storePath(prefix, journalFile))!,
                                    as: UTF8.self)
        XCTAssertEqual(writtenJournal, expectedJournal, "journal.log is not byte-identical")
    }

    /// The ordering rule itself, stated directly.
    func testJsPropertyOrderPutsIndexKeysFirstAscending() throws {
        var h = head()
        h.perSequenceAttempts = ["12": 1, "5": 2, "3": 1]
        let text = String(decoding: serializeHead(h), as: UTF8.self)
        XCTAssertTrue(text.contains("\"perSequenceAttempts\":{\"3\":1,\"5\":2,\"12\":1}"),
                      "integer-like keys are emitted first, in ascending numeric order")
    }

    // MARK: - round trip

    func testHeadRoundTripsThroughValidation() throws {
        var h = head(record: .fixed(bytes: 256))
        h.nextOffset = 512
        h.nextSequence = 3
        h.failureCount = 2
        h.clearedAtFailureCount = 1
        h.perSequenceAttempts = ["0": 1, "2": 3]

        let bytes = serializeHead(h)
        let fs = MemoryFs()
        try fs.writeFileAtomic("p/head.json", bytes)
        try fs.writeFileAtomic("p/secret.bin", [UInt8](repeating: 0, count: secretLength(h)))
        try fs.appendFile("p/journal.log", Array("".utf8))

        guard case .ok(let loaded) = loadStore(fs: fs, prefix: "p") else {
            return XCTFail("a head this edition wrote must load")
        }
        XCTAssertEqual(loaded.head, h)
        XCTAssertEqual(serializeHead(loaded.head), bytes, "re-serialization must be byte-stable")
    }

    // MARK: - refusals

    func testMissingAndCorruptStoresAreRefusedByReason() throws {
        let fs = MemoryFs()
        func reason(_ prefix: String) -> String? {
            if case .refused(let r, _) = loadStore(fs: fs, prefix: prefix) { return r }
            return nil
        }

        XCTAssertEqual(reason("empty"), "no-store")

        try fs.writeFileAtomic("v1/pad.json", Array("{}".utf8))
        XCTAssertEqual(reason("v1"), "v1-store", "a v1 store is named, not called corrupt")

        try fs.writeFileAtomic("half/secret.bin", [0])
        XCTAssertEqual(reason("half"), "corrupt-store", "a gen that crashed leaves no usable store")

        try fs.writeFileAtomic("badhead/head.json", Array("not json".utf8))
        XCTAssertEqual(reason("badhead"), "corrupt-head")

        var h = head()
        try fs.writeFileAtomic("shortsecret/head.json", serializeHead(h))
        try fs.writeFileAtomic("shortsecret/secret.bin", [UInt8](repeating: 0, count: 10))
        try fs.appendFile("shortsecret/journal.log", [])
        XCTAssertEqual(reason("shortsecret"), "corrupt-secret-body",
                       "a secret body of the wrong length is refused, never padded or truncated")

        // A header field outside its domain is refused WHOLE.
        h.nextOffset = h.capacity + 1
        try fs.writeFileAtomic("overrun/head.json", serializeHead(h))
        try fs.writeFileAtomic("overrun/secret.bin", [UInt8](repeating: 0, count: secretLength(h)))
        try fs.appendFile("overrun/journal.log", [])
        XCTAssertEqual(reason("overrun"), "corrupt-head")
    }

    /// NO STATE REWIND. A header behind its own journal is refused, because
    /// trusting it would hand back offsets the journal says are already spent —
    /// the exact shape of reuse. This is the property a restored backup attacks.
    func testHeaderBehindItsJournalIsRefused() throws {
        let fs = MemoryFs()
        let prefix = "p"
        var h = head()
        try initStore(fs: fs, prefix: prefix, head: h,
                      secret: [UInt8](repeating: 0, count: secretLength(h)), at: Self.at)

        // Advance: the header moves first, then the journal line.
        h.nextOffset = 128
        h.nextSequence = 1
        try commitAdvance(fs: fs, prefix: prefix, newHead: h,
                          journalLine: "{\"op\":\"send\",\"sequence\":0,\"startOffset\":0,"
                              + "\"consumed\":128,\"nextOffset\":128,\"nextSequence\":1,"
                              + "\"at\":\"\(Self.at)\"}")
        guard case .ok = loadStore(fs: fs, prefix: prefix) else {
            return XCTFail("the advanced store should load")
        }

        // Now put an OLDER header back — a restore, or a copied container.
        var rolledBack = h
        rolledBack.nextOffset = 0
        rolledBack.nextSequence = 0
        try fs.writeFileAtomic(storePath(prefix, headFile), serializeHead(rolledBack))

        guard case .refused(let reason, let message) = loadStore(fs: fs, prefix: prefix) else {
            return XCTFail("a header older than its own journal must be refused")
        }
        XCTAssertEqual(reason, "regressed-below-mark")
        XCTAssertTrue(message.contains("older than its own history")
                        || message.contains("burned through"),
                      "the refusal should say why: \(message)")
    }

    /// A header AHEAD of its journal is fine — that is the crash-after-header,
    /// before-journal state, and it LOSES a record rather than replaying one.
    /// This asymmetry is the whole reason §12.4 writes the header first.
    func testHeaderAheadOfItsJournalIsAccepted() throws {
        let fs = MemoryFs()
        let prefix = "p"
        var h = head()
        try initStore(fs: fs, prefix: prefix, head: h,
                      secret: [UInt8](repeating: 0, count: secretLength(h)), at: Self.at)

        h.nextOffset = 256
        h.nextSequence = 2
        try fs.writeFileAtomic(storePath(prefix, headFile), serializeHead(h))  // no journal line

        guard case .ok(let loaded) = loadStore(fs: fs, prefix: prefix) else {
            return XCTFail("a header ahead of its journal must load: it loses, it does not replay")
        }
        XCTAssertEqual(loaded.effective.nextOffset, 256)
        XCTAssertEqual(loaded.effective.nextSequence, 2)
    }

    /// A malformed LAST journal line is the crash signature and is named as such;
    /// a malformed line MID-FILE is not, and both refuse.
    func testJournalCorruptionIsRefusedAndDiagnosed() throws {
        let fs = MemoryFs()
        let prefix = "p"
        let h = head()
        try initStore(fs: fs, prefix: prefix, head: h,
                      secret: [UInt8](repeating: 0, count: secretLength(h)), at: Self.at)

        try fs.appendFile(storePath(prefix, journalFile), Array("{\"op\":\"att".utf8))
        guard case .refused(let lastReason, let lastMessage) = loadStore(fs: fs, prefix: prefix) else {
            return XCTFail("a torn last line must be refused")
        }
        XCTAssertEqual(lastReason, "corrupt-journal")
        XCTAssertTrue(lastMessage.contains("crash signature"),
                      "the last-line case should be diagnosed, not just refused")

        // Mid-file damage is a different diagnosis.
        let good = "{\"op\":\"attempt\",\"sequence\":0,\"at\":\"\(Self.at)\"}\n"
        try fs.writeFileAtomic(storePath(prefix, journalFile),
                               Array(("{\"op\":\"garbage\"}\n" + good).utf8))
        guard case .refused(let midReason, let midMessage) = loadStore(fs: fs, prefix: prefix) else {
            return XCTFail("mid-file damage must be refused")
        }
        XCTAssertEqual(midReason, "corrupt-journal")
        XCTAssertTrue(midMessage.contains("mid-file"))
    }

    /// Attempts reconcile as the MAXIMUM of what the header says and what the
    /// journal counted, never the header alone: the journal is the record a
    /// restore cannot rewrite by putting back an older head.
    func testAttemptsReconcileAsTheMaximum() throws {
        let fs = MemoryFs()
        let prefix = "p"
        var h = head()
        try initStore(fs: fs, prefix: prefix, head: h,
                      secret: [UInt8](repeating: 0, count: secretLength(h)), at: Self.at)

        for _ in 0..<3 { try reserveAttempt(fs: fs, prefix: prefix, sequence: 4, at: Self.at) }

        // A header that under-reports the attempts, as a restore would.
        h.perSequenceAttempts = ["4": 1]
        try fs.writeFileAtomic(storePath(prefix, headFile), serializeHead(h))

        guard case .ok(let loaded) = loadStore(fs: fs, prefix: prefix) else {
            return XCTFail("should load")
        }
        XCTAssertEqual(loaded.effective.attempts[4], 3,
                       "the journal's count wins over an under-reporting header")
        XCTAssertEqual(loaded.effective.attemptsReserved, 3,
                       "attemptsReserved is the monotone quantity the witness records")
    }

    // MARK: - init ordering

    func testInitWritesSecretBeforeHead() throws {
        let fs = MemoryFs()
        let h = head()

        // Die immediately before head.json is written: the store must NOT load,
        // and must not look like a usable one.
        struct Died: Error {}
        fs.beforeMutation = { operation, path in
            if operation == "writeFileAtomic" && path.hasSuffix(headFile) { throw Died() }
        }
        XCTAssertThrowsError(try initStore(fs: fs, prefix: "p", head: h,
                                           secret: [UInt8](repeating: 0, count: secretLength(h)),
                                           at: Self.at))
        fs.beforeMutation = nil

        XCTAssertTrue(fs.exists("p/secret.bin"), "the secret body was written first")
        XCTAssertFalse(fs.exists("p/head.json"))
        guard case .refused(let reason, _) = loadStore(fs: fs, prefix: "p") else {
            return XCTFail("a half-written store must be refused")
        }
        XCTAssertEqual(reason, "corrupt-store")
    }

    func testInitRefusesToOverwriteAnExistingStore() throws {
        let fs = MemoryFs()
        let h = head()
        let secret = [UInt8](repeating: 0, count: secretLength(h))
        try initStore(fs: fs, prefix: "p", head: h, secret: secret, at: Self.at)
        XCTAssertThrowsError(try initStore(fs: fs, prefix: "p", head: h, secret: secret, at: Self.at),
                             "a v2 store is written once")
    }

    func testInitRefusesAWrongLengthSecret() throws {
        let fs = MemoryFs()
        let h = head()
        XCTAssertThrowsError(try initStore(fs: fs, prefix: "p", head: h,
                                           secret: [UInt8](repeating: 0, count: 10), at: Self.at))
    }

    // MARK: - secret body reads

    func testAuthRecordSplitAndBounds() throws {
        let fs = MemoryFs()
        var h = head(capacity: 64, capacityRecords: 2, sourceLength: 256)
        h.perSequenceAttempts = [:]
        var secret = [UInt8](repeating: 0, count: secretLength(h))
        // Record 1 lives at capacity + 32, key then mask.
        for i in 0..<16 { secret[64 + 32 + i] = 0xAA }
        for i in 0..<16 { secret[64 + 32 + 16 + i] = 0xBB }
        try initStore(fs: fs, prefix: "p", head: h, secret: secret, at: Self.at)

        let record = try readAuthRecord(fs: fs, prefix: "p", head: h, sequence: 1)
        XCTAssertEqual(record.key, [UInt8](repeating: 0xAA, count: 16), "K_s is the FIRST 16 bytes")
        XCTAssertEqual(record.mask, [UInt8](repeating: 0xBB, count: 16), "R_s is the SECOND 16")

        XCTAssertThrowsError(try readAuthRecord(fs: fs, prefix: "p", head: h, sequence: 2),
                             "no record beyond capacityRecords exists")
        XCTAssertThrowsError(try readEncryption(fs: fs, prefix: "p", head: h, offset: 60, length: 8),
                             "an encryption read may not run into the authentication slice")
    }
}
