import Foundation
import TruePadCore
@testable import TruePadSPT
@testable import TruePadStorage
import XCTest

/// CONCURRENCY, where the one-time guarantees actually live.
///
/// Every claim in this file is about a race that would be a REUSE bug, not a
/// crash: two burns taking the same sequence, two packages sealed to one request,
/// two receives consuming one key. Reasoning about a lock order is not the same
/// as running it, and these tests run it — under ThreadSanitizer in CI as well.
///
/// LOSS IS ACCEPTABLE; REUSE IS NOT.
final class ConcurrencyTests: XCTestCase {
    let fixedPairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
    let clock = Date(timeIntervalSince1970: 1_756_684_800)

    func engine(_ fs: Fs, pairId: String? = nil) -> Engine {
        Engine(fs: fs, clock: { self.clock },
               pairIdSource: { Hex.decode(pairId ?? self.fixedPairId)! })
    }

    func sourceBytes(_ n: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: n)
        for i in 0..<n { out[i] = UInt8((11 &+ i &* 31 &+ ((i &* i) % 251)) & 0xff) }
        return out
    }

    @discardableResult
    func genPair(_ e: Engine, capacity: Int = 4096, records: Int = 64) throws -> String {
        let need = try Partition.requiredSourceLength(capacity: capacity, capacityRecords: records)
        return try e.gen(label: "concurrent",
                         sources: [SourceInput(name: "s.bin", declaredOrigin: "declared",
                                               bytes: sourceBytes(need))],
                         encryptionBytes: capacity, authRecords: records).pair.pairId
    }

    /// Run `body` on `count` threads at once and collect what each returned.
    func inParallel<T>(_ count: Int, _ body: @escaping @Sendable (Int) -> T) -> [T] {
        let lock = NSLock()
        var results: [T] = []
        DispatchQueue.concurrentPerform(iterations: count) { i in
            let value = body(i)
            lock.lock(); results.append(value); lock.unlock()
        }
        return results
    }

    // MARK: - the OTP verbs

    /// CONCURRENT BURNS MUST NOT SHARE A SEQUENCE OR AN OFFSET.
    ///
    /// If two burns could take the same sequence, two messages would be
    /// authenticated with the SAME one-time key and mask — the exact failure a
    /// one-time pad exists to prevent.
    func testConcurrentBurnsNeverShareASequenceOrAnOffset() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let pairId = try genPair(e)

        let attempts = 24
        let envelopes = inParallel(attempts) { i -> String? in
            try? e.burn(pairId: pairId, role: .a,
                        plaintext: Array("message \(i)".utf8)).envelope
        }
        let succeeded = envelopes.compactMap { $0 }
        XCTAssertGreaterThan(succeeded.count, 1, "the test must actually contend")

        var sequences = Set<Int>()
        var windows: [(Int, Int)] = []
        for text in succeeded {
            guard case .ok(let envelope) = EnvelopeCodec.decode(text) else {
                return XCTFail("every emitted envelope must decode")
            }
            XCTAssertTrue(sequences.insert(envelope.sequence).inserted,
                          "sequence \(envelope.sequence) was issued TWICE — that is key reuse")
            windows.append((envelope.startOffset,
                            envelope.startOffset + envelope.ciphertextLength))
        }
        // No two encryption windows may overlap, either.
        for (i, a) in windows.enumerated() {
            for b in windows[(i + 1)...] {
                XCTAssertTrue(a.1 <= b.0 || b.1 <= a.0,
                              "encryption windows \(a) and \(b) overlap — that is pad reuse")
            }
        }

        // And the store's high-water agrees with what was actually issued.
        let m = try XCTUnwrap(try e.status(pairId).meters[.aToB])
        XCTAssertEqual(m.nextSequence, succeeded.count)
        XCTAssertEqual(m.nextOffset, windows.map { $0.1 - $0.0 }.reduce(0, +))
    }

    /// Concurrent opens of the SAME envelope: exactly one may succeed, and the
    /// rest must be refused rather than silently replaying.
    func testConcurrentOpensOfOneEnvelopeYieldExactlyOneSuccess() throws {
        let aliceFs = MemoryFs()
        let alice = engine(aliceFs)
        let pairId = try genPair(alice)

        let bobFs = MemoryFs()
        for path in aliceFs.allPaths {
            if let bytes = try aliceFs.readFile(path) { try bobFs.writeFileAtomic(path, bytes) }
        }
        let bob = engine(bobFs)
        let burned = try alice.burn(pairId: pairId, role: .a, plaintext: Array("once only".utf8))

        let opened = inParallel(16) { _ -> [UInt8]? in
            try? bob.open(pairId: pairId, role: .b, envelopeText: burned.envelope).plaintext
        }
        XCTAssertEqual(opened.compactMap { $0 }.count, 1,
                       "a record opens exactly once, however many callers race for it")
    }

    /// Concurrent destroys are idempotent, and the tombstone is written once.
    func testConcurrentDestroysAreIdempotent() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let pairId = try genPair(e)

        let results = inParallel(12) { _ -> Bool? in
            try? e.destroy(pairId: pairId, confirm: pairId).alreadyDestroyed
        }
        let outcomes = results.compactMap { $0 }
        XCTAssertEqual(outcomes.count, 12, "destroy is idempotent, so every caller gets an answer")
        XCTAssertEqual(outcomes.filter { !$0 }.count, 1, "exactly one caller did the work")
        XCTAssertTrue(fs.exists(tombstonePath(pairId)))
    }

    // MARK: - the SPT gates

    /// THE CLAIM GATE, RACED: one request yields exactly ONE package, however many
    /// pads go for it at once.
    ///
    /// WHAT THIS TEST SHOWS, AND WHAT IT DOES NOT. It asserts the INVARIANT, and
    /// the invariant holds. It does NOT show that the request-scoped inner lock is
    /// individually necessary, and I tried: with that lock removed and the claim's
    /// read-then-write window widened to 50 ms, the invariant still held, because
    /// `commitSealedHandoff` RE-READS the claim under the pad lock and refuses a
    /// pad the request is no longer bound to. Two independent gates cover this,
    /// and this test cannot separate them.
    ///
    /// The lock stays regardless: it is what makes the claim a real
    /// compare-and-set rather than a read-then-write that happens to be caught
    /// downstream, and the frozen Browser Edition takes it in the same order. But
    /// the evidence here is for the invariant, not for the lock, and saying
    /// otherwise would be citing a test for something it did not test.
    func testTwoPadsRacingForOneRequestYieldExactlyOnePackage() throws {
        let bobFs = MemoryFs()
        let bob = engine(bobFs, pairId: "ffffffffffffffffffffffffffffffff")
        let request = try bob.sptCreateReceiveRequest()

        let aliceFs = MemoryFs()
        let padIds = (0..<8).map { String(repeating: String($0), count: 32) }
        for padId in padIds { _ = try genPair(engine(aliceFs, pairId: padId), capacity: 256, records: 4) }
        let alice = engine(aliceFs)
        let review = try alice.sptReviewRequest(request.tpr2Text)
        _ = try alice.sptConfirmRequest(canonicalBody: review.canonicalBody)

        // The claim's read-then-write window is microseconds wide, so 8 threads
        // would not interleave inside it by luck. Slowing the claim READ through
        // the existing Fs seam holds every thread inside that read until all of
        // them have seen "absent" — the worst interleaving available — and the
        // invariant is asserted against THAT rather than against a lucky schedule.
        let slow = SlowClaimReadFs(inner: aliceFs, delay: 0.05)
        let racing = Engine(fs: slow, clock: { self.clock })
        let sealed = inParallel(padIds.count) { i -> String? in
            try? racing.sptSeal(requestHashHex: review.requestHashHex,
                                pairId: padIds[i]).packageIdentityB64
        }
        let identities = Set(sealed.compactMap { $0 })
        XCTAssertEqual(identities.count, 1,
                       "one request yields exactly ONE package identity, however many pads race "
                       + "for it — got \(identities.count)")

        // And exactly one pad is spent; the rest are untouched and still sealable.
        let spent = padIds.filter { padId in
            if case .sealed = sptReadHandoffState(vfs: FsSptVfs(aliceFs), pairId: padId) { return true }
            return false
        }
        XCTAssertEqual(spent.count, 1, "exactly one pad left; the others must be untouched")
    }

    /// Concurrent seals of the SAME pad to the same request: every caller gets the
    /// IDENTICAL package back, because a retry re-shares rather than re-seals.
    func testConcurrentSealsOfOnePadAllReturnTheIdenticalPackage() throws {
        let bobFs = MemoryFs()
        let bob = engine(bobFs, pairId: "ffffffffffffffffffffffffffffffff")
        let request = try bob.sptCreateReceiveRequest()

        let aliceFs = MemoryFs()
        let alice = engine(aliceFs)
        let padId = try genPair(alice, capacity: 256, records: 4)
        let review = try alice.sptReviewRequest(request.tpr2Text)
        _ = try alice.sptConfirmRequest(canonicalBody: review.canonicalBody)

        let packages = inParallel(12) { _ -> [UInt8]? in
            try? alice.sptSeal(requestHashHex: review.requestHashHex, pairId: padId).packageBytes
        }
        let distinct = Set(packages.compactMap { $0 }.map { Hex.encode($0) })
        XCTAssertEqual(distinct.count, 1,
                       "a retry returns the EXACT committed package; re-encapsulating would be a "
                       + "second package with a different confirmation code")
    }

    /// THE RECEIVER'S ONE-TIME KEY, RACED. However many callers open and commit
    /// the same package at once, exactly one may consume the request.
    func testConcurrentReceivesConsumeTheRequestExactlyOnce() throws {
        let aliceFs = MemoryFs()
        let alice = engine(aliceFs)
        let padId = try genPair(alice, capacity: 256, records: 4)
        let bobFs = MemoryFs()
        let bob = engine(bobFs, pairId: "ffffffffffffffffffffffffffffffff")

        let request = try bob.sptCreateReceiveRequest()
        let review = try alice.sptReviewRequest(request.tpr2Text)
        _ = try alice.sptConfirmRequest(canonicalBody: review.canonicalBody)
        let sealed = try alice.sptSeal(requestHashHex: review.requestHashHex, pairId: padId)

        let committed = inParallel(10) { _ -> String? in
            guard let session = try? bob.sptOpen(packageBytes: sealed.packageBytes) else { return nil }
            return try? bob.sptCommitReceive(session: session, label: "raced").pairId
        }
        XCTAssertEqual(committed.compactMap { $0 }.count, 1,
                       "a one-time receive request receives exactly one pad")

        guard case .consumed = readReceiverState(vfs: FsSptVfs(bobFs),
                                                 idHex: request.requestIdHex,
                                                 nowMillis: Int(clock.timeIntervalSince1970 * 1000)) else {
            return XCTFail("the request must end consumed")
        }
    }

    /// Concurrent request creation never issues the same identifier twice.
    func testConcurrentRequestCreationNeverReusesAnIdentifier() throws {
        let fs = MemoryFs()
        let e = Engine(fs: fs, clock: { self.clock })   // real random ids
        let ids = inParallel(16) { _ -> String? in
            try? e.sptCreateReceiveRequest().requestIdHex
        }
        let issued = ids.compactMap { $0 }
        XCTAssertGreaterThan(issued.count, 8, "the test must actually create requests")
        XCTAssertEqual(Set(issued).count, issued.count, "identifiers are never reused")
    }

    // MARK: - the witness

    /// The rollback witness is an APPEND-ONLY journal, and concurrent advances
    /// must never lose one: reconciliation takes the maximum, so a lost record
    /// would understate what has been spent.
    func testConcurrentWitnessAdvancesNeverLoseAHighWater() throws {
        let store = MemoryFs()
        let witnessFs = MemoryFs()
        let e = Engine(fs: store, witnessFs: witnessFs, clock: { self.clock },
                       pairIdSource: { Hex.decode(self.fixedPairId)! })
        let pairId = try genPair(e)

        let sent = inParallel(20) { i -> Int? in
            try? e.burn(pairId: pairId, role: .a, plaintext: Array("m\(i)".utf8)).encryptionBytes
        }
        let total = sent.compactMap { $0 }.reduce(0, +)

        // The witness must be at least as far along as the store — never behind,
        // which is the state that would let spent material be reused.
        let w = witnessFor(fs: witnessFs, kind: .local)
        let m = try XCTUnwrap(try e.status(pairId).meters[.aToB])
        XCTAssertEqual(m.nextOffset, total)
        let state = w.report(pairId: pairId, direction: .aToB,
                             store: StoreHighWaters(nextOffset: m.nextOffset,
                                                    nextSequence: m.nextSequence,
                                                    attemptsReserved: 0))
        XCTAssertTrue(state == .aligned || state == .ahead,
                      "the witness must never fall behind the store; it read \(state)")
    }

    /// Delays reads of the claim record so the compare-and-set window is wide
    /// enough to actually race. Test-only, and it uses nothing but the `Fs`
    /// abstraction the engine already takes.
    final class SlowClaimReadFs: Fs, @unchecked Sendable {
        let inner: Fs
        let delay: TimeInterval

        init(inner: Fs, delay: TimeInterval) {
            self.inner = inner
            self.delay = delay
        }

        func readFile(_ path: String) throws -> [UInt8]? {
            if path.hasPrefix("spt/claims") { Thread.sleep(forTimeInterval: delay) }
            return try inner.readFile(path)
        }
        func writeFileAtomic(_ path: String, _ data: [UInt8]) throws { try inner.writeFileAtomic(path, data) }
        func appendFile(_ path: String, _ data: [UInt8]) throws { try inner.appendFile(path, data) }
        func readRange(_ path: String, offset: Int, length: Int) throws -> [UInt8] {
            try inner.readRange(path, offset: offset, length: length)
        }
        func writeRange(_ path: String, offset: Int, data: [UInt8]) throws {
            try inner.writeRange(path, offset: offset, data: data)
        }
        func exists(_ path: String) -> Bool { inner.exists(path) }
        func remove(_ path: String) throws { try inner.remove(path) }
        func size(_ path: String) throws -> Int? { try inner.size(path) }
        func list(_ prefix: String) throws -> [String] { try inner.list(prefix) }
        func withLock<T>(_ scope: String, _ body: () throws -> T) throws -> T {
            try inner.withLock(scope, body)
        }
    }
}
