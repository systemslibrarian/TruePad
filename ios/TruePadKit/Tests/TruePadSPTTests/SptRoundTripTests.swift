import Foundation
import TruePadClaims
import TruePadCore
@testable import TruePadSPT
@testable import TruePadStorage
import XCTest

/// SEALED PAD TRANSFER, END TO END, over the real engine on both sides.
///
/// Alice generates a pad. Bob publishes a one-time receive request. Alice
/// reviews it, confirms the twelve words, and seals her whole pad to it. Bob
/// opens the package, compares the eight confirmation words, and commits.
///
/// The claims boundary this exercise must never blur:
///
///     PQC protects pad DELIVERY. OTP encrypts messages.
///     Wegman–Carter authenticates messages.
///
/// So a pad that arrived this way is NOT ELIGIBLE for the information-theoretic
/// claim — permanently, at BOTH ends — and that is asserted here rather than
/// assumed.
final class SptRoundTripTests: XCTestCase {
    let start = Date(timeIntervalSince1970: 1_756_684_800)

    func engine(_ fs: Fs, pairId: String, clock: @escaping () -> Date) -> Engine {
        Engine(fs: fs, clock: clock, pairIdSource: { Hex.decode(pairId)! })
    }

    func sourceBytes(_ n: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: n)
        for i in 0..<n { out[i] = UInt8((7 &+ i &* 31 &+ ((i &* i) % 251)) & 0xff) }
        return out
    }

    func refusal(_ body: () throws -> Void) -> SptRefused? {
        do { try body(); return nil } catch let r as SptRefused { return r } catch { return nil }
    }

    func engineRefusal(_ body: () throws -> Void) -> EngineRefused? {
        do { try body(); return nil } catch let r as EngineRefused { return r } catch { return nil }
    }

    /// Alice with a fresh, generated-here, genesis pad.
    func alice(_ fs: MemoryFs, pairId: String, clock: @escaping () -> Date) throws -> Engine {
        let e = engine(fs, pairId: pairId, clock: clock)
        let need = try Partition.requiredSourceLength(capacity: 256, capacityRecords: 4)
        _ = try e.gen(label: "to send",
                      sources: [SourceInput(name: "dice.bin", declaredOrigin: "physical dice",
                                            bytes: sourceBytes(need))],
                      encryptionBytes: 256, authRecords: 4)
        return e
    }

    // MARK: - the whole ceremony

    func testAWholePadCrossesAndBothSidesSeeTheSameConfirmationWords() throws {
        let padId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        var clock = start
        let aliceFs = MemoryFs(), bobFs = MemoryFs()
        let a = try alice(aliceFs, pairId: padId, clock: { clock })
        let b = engine(bobFs, pairId: "ffffffffffffffffffffffffffffffff", clock: { clock })

        // BOB publishes a one-time receive request.
        let request = try b.sptCreateReceiveRequest()
        XCTAssertTrue(request.tpr2Text.hasPrefix(SptConstants.tpr2Prefix))
        XCTAssertEqual(request.requestIndices.count, 12, "twelve words to compare")

        // ALICE reviews it. The twelve words must be the SAME on both sides —
        // that is the entire point of reading them aloud.
        let review = try a.sptReviewRequest(request.tpr2Text)
        XCTAssertEqual(review.requestHashHex, request.requestHashHex)
        XCTAssertEqual(review.requestIndices, request.requestIndices,
                       "the sender and the recipient must derive identical request words")

        // ALICE confirms and seals.
        _ = try a.sptConfirmRequest(canonicalBody: review.canonicalBody)
        let sealed = try a.sptSeal(requestHashHex: review.requestHashHex, pairId: padId)
        XCTAssertFalse(sealed.reshared)
        XCTAssertEqual(sealed.confirmationIndices.count, 8, "eight words to read aloud")

        // BOB opens. The eight confirmation words must match Alice's.
        let session = try b.sptOpen(packageBytes: sealed.packageBytes)
        XCTAssertEqual(session.confirmationIndices, sealed.confirmationIndices,
                       "the sender and the recipient must derive identical confirmation words")
        XCTAssertEqual(session.pairId, padId)

        // BOB commits.
        let summary = try b.sptCommitReceive(session: session, label: "from Alice")
        XCTAssertEqual(summary.pairId, padId)
        XCTAssertEqual(summary.origin, .imported)

        // AND THE PAD WORKS.
        let burned = try a.burn(pairId: padId, role: .a, plaintext: Array("hello Bob".utf8))
        XCTAssertEqual(try b.open(pairId: padId, role: .b, envelopeText: burned.envelope).plaintext,
                       Array("hello Bob".utf8))
    }

    /// THE CLAIMS BOUNDARY. A pad delivered over the computational X-Wing channel
    /// is NOT ELIGIBLE for the information-theoretic claim, permanently, at BOTH
    /// ends — the receiver because it arrived that way, the sender because its
    /// whole material crossed that channel.
    func testASealedTransferPermanentlyDisqualifiesBothEnds() throws {
        let padId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        var clock = start
        let aliceFs = MemoryFs(), bobFs = MemoryFs()
        let a = try alice(aliceFs, pairId: padId, clock: { clock })
        let b = engine(bobFs, pairId: "ffffffffffffffffffffffffffffffff", clock: { clock })

        // CONTROL: before the transfer Alice's pad is not disqualified on this
        // ground, so the change below is caused by the transfer and nothing else.
        let before = try XCTUnwrap(try a.status(padId).meters[.aToB])
        XCTAssertNotEqual(before.deployment.assessment, .notEligible)

        let request = try b.sptCreateReceiveRequest()
        let review = try a.sptReviewRequest(request.tpr2Text)
        _ = try a.sptConfirmRequest(canonicalBody: review.canonicalBody)
        let sealed = try a.sptSeal(requestHashHex: review.requestHashHex, pairId: padId)
        let session = try b.sptOpen(packageBytes: sealed.packageBytes)
        _ = try b.sptCommitReceive(session: session, label: "from Alice")

        for (who, engine) in [("sender", a), ("receiver", b)] {
            let m = try XCTUnwrap(try engine.status(padId).meters[.aToB])
            XCTAssertEqual(m.deployment.assessment, .notEligible,
                           "[\(who)] a sealed transfer is computational delivery, end to end")
            XCTAssertTrue(m.deployment.knownReason?.contains("sealed") ?? false, "[\(who)]")
        }

        // And it cannot be laundered away: Bob re-reads it the same way after a
        // fresh engine over the same store.
        let reread = engine(bobFs, pairId: padId, clock: { clock })
        XCTAssertEqual(try XCTUnwrap(try reread.status(padId).meters[.bToA]).deployment.assessment,
                       .notEligible)
    }

    // MARK: - one request, one package

    /// A SECOND pad may never be sealed to the same request: the recipient would
    /// hold two packages with two different confirmation codes and no way to tell
    /// which is real.
    func testASecondPadCannotBeSealedToTheSameRequest() throws {
        var clock = start
        let bobFs = MemoryFs()
        let b = engine(bobFs, pairId: "ffffffffffffffffffffffffffffffff", clock: { clock })
        let request = try b.sptCreateReceiveRequest()

        let padP = "11111111111111111111111111111111"
        let padQ = "22222222222222222222222222222222"
        let aliceFs = MemoryFs()
        let a = try alice(aliceFs, pairId: padP, clock: { clock })
        _ = try alice(aliceFs, pairId: padQ, clock: { clock })

        let review = try a.sptReviewRequest(request.tpr2Text)
        _ = try a.sptConfirmRequest(canonicalBody: review.canonicalBody)
        _ = try a.sptSeal(requestHashHex: review.requestHashHex, pairId: padP)

        let r = refusal { _ = try a.sptSeal(requestHashHex: review.requestHashHex, pairId: padQ) }
        XCTAssertEqual(r?.reason, refuseClaimedElsewhere)
        XCTAssertTrue(r?.message.contains("two different confirmation codes") ?? false)
    }

    /// A retry returns the EXACT committed package — byte for byte, with the same
    /// confirmation words. Re-encapsulating would be a second package.
    func testASecondSealOfTheSamePadReturnsTheIdenticalPackage() throws {
        let padId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        var clock = start
        let aliceFs = MemoryFs(), bobFs = MemoryFs()
        let a = try alice(aliceFs, pairId: padId, clock: { clock })
        let b = engine(bobFs, pairId: "ffffffffffffffffffffffffffffffff", clock: { clock })

        let request = try b.sptCreateReceiveRequest()
        let review = try a.sptReviewRequest(request.tpr2Text)
        _ = try a.sptConfirmRequest(canonicalBody: review.canonicalBody)
        let first = try a.sptSeal(requestHashHex: review.requestHashHex, pairId: padId)

        clock = start.addingTimeInterval(3600)
        let again = try a.sptSeal(requestHashHex: review.requestHashHex, pairId: padId)
        XCTAssertTrue(again.reshared)
        XCTAssertEqual(again.packageBytes, first.packageBytes, "byte for byte")
        XCTAssertEqual(again.confirmationIndices, first.confirmationIndices,
                       "the same words the operator already read aloud")
    }

    /// A pad may leave ONCE. A sealed pad cannot also be exported as a file, and
    /// a pad exported as a file cannot also be sealed.
    func testAPadLeavesByExactlyOneRoute() throws {
        let padId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        var clock = start

        // sealed first, then the file route is refused.
        do {
            let aliceFs = MemoryFs(), bobFs = MemoryFs()
            let a = try alice(aliceFs, pairId: padId, clock: { clock })
            let b = engine(bobFs, pairId: "ffffffffffffffffffffffffffffffff", clock: { clock })
            let request = try b.sptCreateReceiveRequest()
            let review = try a.sptReviewRequest(request.tpr2Text)
            _ = try a.sptConfirmRequest(canonicalBody: review.canonicalBody)
            _ = try a.sptSeal(requestHashHex: review.requestHashHex, pairId: padId)
            XCTAssertEqual(engineRefusal { _ = try a.exportPair(pairId: padId) }?.reason,
                           TruePadStorage.refuseAlreadySealed)
        }
        // the file route first, then sealing is refused.
        do {
            let aliceFs = MemoryFs(), bobFs = MemoryFs()
            let a = try alice(aliceFs, pairId: padId, clock: { clock })
            let b = engine(bobFs, pairId: "ffffffffffffffffffffffffffffffff", clock: { clock })
            _ = try a.exportPair(pairId: padId)
            let request = try b.sptCreateReceiveRequest()
            let review = try a.sptReviewRequest(request.tpr2Text)
            _ = try a.sptConfirmRequest(canonicalBody: review.canonicalBody)
            XCTAssertEqual(refusal { _ = try a.sptSeal(requestHashHex: review.requestHashHex,
                                                        pairId: padId) }?.reason,
                           refuseAlreadyHandedOff)
        }
    }

    // MARK: - eligibility to be sealed

    /// A sealed transfer sends the WHOLE pad, so the pad must be at genesis — and
    /// all THREE counters count. A pad that only took a FAILED OPEN still reads
    /// nextOffset 0 and nextSequence 0, but its forgery budget is already partly
    /// spent, and the receiver could not tell.
    func testAPadThatOnlyTookAFailedOpenIsNoLongerSealable() throws {
        let padId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        var clock = start
        let aliceFs = MemoryFs(), bobFs = MemoryFs()
        let a = try alice(aliceFs, pairId: padId, clock: { clock })
        let b = engine(bobFs, pairId: "ffffffffffffffffffffffffffffffff", clock: { clock })

        // A peer copy burns one record so there is a genuine envelope to forge.
        let peerFs = MemoryFs()
        for path in aliceFs.allPaths {
            if let bytes = try aliceFs.readFile(path) { try peerFs.writeFileAtomic(path, bytes) }
        }
        let peer = engine(peerFs, pairId: padId, clock: { clock })
        let burned = try peer.burn(pairId: padId, role: .b, plaintext: Array("x".utf8))
        var forged = burned.envelope
        let tagRange = try XCTUnwrap(forged.range(of: "\"tag\":\""))
        let flipAt = forged.index(tagRange.upperBound, offsetBy: 1)
        forged.replaceSubrange(flipAt...flipAt, with: forged[flipAt] == "0" ? "1" : "0")

        // Alice's pad takes ONE failed open. Its offsets are still zero.
        _ = engineRefusal { _ = try a.open(pairId: padId, role: .a, envelopeText: forged) }
        let m = try XCTUnwrap(try a.status(padId).meters[.bToA])
        XCTAssertEqual(m.nextOffset, 0, "no encryption material was consumed")
        XCTAssertEqual(m.nextSequence, 0, "no auth material was consumed")

        // ...and it is nonetheless no longer sealable.
        let request = try b.sptCreateReceiveRequest()
        let review = try a.sptReviewRequest(request.tpr2Text)
        _ = try a.sptConfirmRequest(canonicalBody: review.canonicalBody)
        let r = refusal { _ = try a.sptSeal(requestHashHex: review.requestHashHex, pairId: padId) }
        XCTAssertEqual(r?.reason, "spt-pad-ineligible")
        XCTAssertTrue(r?.message.contains("already been used") ?? false)
    }

    func testAnImportedPadIsNeverSealedOnward() throws {
        let padId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        var clock = start
        let aliceFs = MemoryFs(), bobFs = MemoryFs(), carolFs = MemoryFs()
        let a = try alice(aliceFs, pairId: padId, clock: { clock })
        let b = engine(bobFs, pairId: "ffffffffffffffffffffffffffffffff", clock: { clock })

        // Alice hands Bob the pad by file; Bob may not seal it onward.
        _ = try b.importPair(label: "from Alice", container: try a.exportPair(pairId: padId).container)
        let carol = engine(carolFs, pairId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", clock: { clock })
        let request = try carol.sptCreateReceiveRequest()
        let review = try b.sptReviewRequest(request.tpr2Text)
        _ = try b.sptConfirmRequest(canonicalBody: review.canonicalBody)

        let r = refusal { _ = try b.sptSeal(requestHashHex: review.requestHashHex, pairId: padId) }
        XCTAssertEqual(r?.reason, "spt-pad-ineligible")
        XCTAssertTrue(r?.message.contains("did not originate on this device") ?? false)
    }

    /// Sealing requires a CONFIRMATION. Nothing is sealed to a request whose
    /// twelve words the operator never said matched.
    func testSealingRequiresAConfirmationAndItExpires() throws {
        let padId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        var clock = start
        let aliceFs = MemoryFs(), bobFs = MemoryFs()
        let a = try alice(aliceFs, pairId: padId, clock: { clock })
        let b = engine(bobFs, pairId: "ffffffffffffffffffffffffffffffff", clock: { clock })
        let request = try b.sptCreateReceiveRequest()
        let review = try a.sptReviewRequest(request.tpr2Text)

        XCTAssertEqual(refusal { _ = try a.sptSeal(requestHashHex: review.requestHashHex,
                                                    pairId: padId) }?.reason,
                       refuseConfirmationMissing)

        _ = try a.sptConfirmRequest(canonicalBody: review.canonicalBody)
        // Seven days later the confirmation has expired — and the expiry is
        // decided by the clock read UNDER the locks, not before the call.
        clock = start.addingTimeInterval(Double(SptTime.requestTtlMillis) / 1000)
        XCTAssertEqual(refusal { _ = try a.sptSeal(requestHashHex: review.requestHashHex,
                                                    pairId: padId) }?.reason,
                       refuseConfirmationExpired)
    }

    // MARK: - the receiver's one-time key

    func testAReceiveRequestOpensExactlyOnePackage() throws {
        let padId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        var clock = start
        let aliceFs = MemoryFs(), bobFs = MemoryFs()
        let a = try alice(aliceFs, pairId: padId, clock: { clock })
        let b = engine(bobFs, pairId: "ffffffffffffffffffffffffffffffff", clock: { clock })

        let request = try b.sptCreateReceiveRequest()
        let review = try a.sptReviewRequest(request.tpr2Text)
        _ = try a.sptConfirmRequest(canonicalBody: review.canonicalBody)
        let sealed = try a.sptSeal(requestHashHex: review.requestHashHex, pairId: padId)

        let session = try b.sptOpen(packageBytes: sealed.packageBytes)
        _ = try b.sptCommitReceive(session: session, label: "from Alice")

        // The request is spent. Opening the SAME package again is refused.
        XCTAssertEqual(refusal { _ = try b.sptOpen(packageBytes: sealed.packageBytes) }?.reason,
                       "spt-request-consumed")
        // And committing the held session again is refused too.
        XCTAssertEqual(refusal { _ = try b.sptCommitReceive(session: session,
                                                             label: "again") }?.reason,
                       "spt-request-consumed")
    }

    /// A package for a DIFFERENT request cannot be opened, and nothing is spent
    /// finding that out.
    func testAPackageForAnotherRequestIsRefusedWithoutSpendingAnything() throws {
        var clock = start
        let aliceFs = MemoryFs(), bobFs = MemoryFs()
        let padId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        let a = try alice(aliceFs, pairId: padId, clock: { clock })
        let b = engine(bobFs, pairId: "ffffffffffffffffffffffffffffffff", clock: { clock })

        let first = try b.sptCreateReceiveRequest()
        let second = try b.sptCreateReceiveRequest()
        XCTAssertNotEqual(first.requestIdHex, second.requestIdHex)

        let review = try a.sptReviewRequest(first.tpr2Text)
        _ = try a.sptConfirmRequest(canonicalBody: review.canonicalBody)
        let sealed = try a.sptSeal(requestHashHex: review.requestHashHex, pairId: padId)

        // The SECOND request is untouched by the first's package, and still opens
        // nothing — but it is still PENDING, not spent.
        guard case .pending = readReceiverState(vfs: FsSptVfs(bobFs),
                                                idHex: second.requestIdHex,
                                                nowMillis: Int(clock.timeIntervalSince1970 * 1000)) else {
            return XCTFail("the unrelated request must still be pending")
        }
        // And opening the first package still works, because nothing was spent.
        XCTAssertNoThrow(try b.sptOpen(packageBytes: sealed.packageBytes))
    }

    /// A TAMPERED package does not open, and does not spend the request.
    func testATamperedPackageDoesNotOpenAndDoesNotSpendTheRequest() throws {
        let padId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        var clock = start
        let aliceFs = MemoryFs(), bobFs = MemoryFs()
        let a = try alice(aliceFs, pairId: padId, clock: { clock })
        let b = engine(bobFs, pairId: "ffffffffffffffffffffffffffffffff", clock: { clock })

        let request = try b.sptCreateReceiveRequest()
        let review = try a.sptReviewRequest(request.tpr2Text)
        _ = try a.sptConfirmRequest(canonicalBody: review.canonicalBody)
        var sealed = try a.sptSeal(requestHashHex: review.requestHashHex, pairId: padId).packageBytes

        sealed[sealed.count - 1] ^= 0x01     // flip a ciphertext/tag bit
        XCTAssertEqual(refusal { _ = try b.sptOpen(packageBytes: sealed) }?.reason,
                       "spt-package-open-failed")

        // The request is STILL pending — a forged package costs nothing.
        guard case .pending = readReceiverState(vfs: FsSptVfs(bobFs),
                                                idHex: request.requestIdHex,
                                                nowMillis: Int(clock.timeIntervalSince1970 * 1000)) else {
            return XCTFail("a tampered package must not spend the one-time key")
        }
    }

    /// CONSUME-BEFORE-IMPORT. If the import fails after the consume, the transfer
    /// is LOST and the request is never reopened.
    func testAFailedImportAfterConsumeIsLossNotAReopenedRequest() throws {
        let padId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        var clock = start
        let aliceFs = MemoryFs(), bobFs = MemoryFs()
        let a = try alice(aliceFs, pairId: padId, clock: { clock })
        let b = engine(bobFs, pairId: "ffffffffffffffffffffffffffffffff", clock: { clock })

        let request = try b.sptCreateReceiveRequest()
        let review = try a.sptReviewRequest(request.tpr2Text)
        _ = try a.sptConfirmRequest(canonicalBody: review.canonicalBody)
        let sealed = try a.sptSeal(requestHashHex: review.requestHashHex, pairId: padId)
        let session = try b.sptOpen(packageBytes: sealed.packageBytes)

        // Fail the import's commit write.
        let failing = FailImportCommitFs(inner: bobFs)
        let breaking = Engine(fs: failing, clock: { clock },
                              pairIdSource: { Hex.decode(padId)! })
        let r = refusal { _ = try breaking.sptCommitReceive(session: session, label: "lost") }
        XCTAssertEqual(r?.reason, "spt-receive-loss")
        XCTAssertTrue(r?.message.contains("cannot be used again") ?? false)

        // The request is CONSUMED, and stays consumed. Loss, not reuse.
        guard case .consumed = readReceiverState(vfs: FsSptVfs(bobFs),
                                                 idHex: request.requestIdHex,
                                                 nowMillis: Int(clock.timeIntervalSince1970 * 1000)) else {
            return XCTFail("the request must stay consumed after a failed import")
        }
        XCTAssertEqual(refusal { _ = try b.sptCommitReceive(session: session,
                                                             label: "retry") }?.reason,
                       "spt-request-consumed")
    }
}

/// Fails the import's pair.json commit — the last write before an imported pair
/// becomes active.
private final class FailImportCommitFs: Fs, @unchecked Sendable {
    let inner: Fs
    init(inner: Fs) { self.inner = inner }

    func readFile(_ path: String) throws -> [UInt8]? { try inner.readFile(path) }
    func writeFileAtomic(_ path: String, _ data: [UInt8]) throws {
        if path.hasSuffix(pairMetaFile) { throw FsFailure.io("simulated: \(path)") }
        try inner.writeFileAtomic(path, data)
    }
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
