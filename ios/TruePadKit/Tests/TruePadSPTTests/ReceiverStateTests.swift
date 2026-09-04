import Foundation
@testable import TruePadSPT
import XCTest

/// THE RECEIVER'S ONE-TIME KEY.
///
/// The whole value of the decapsulation seed is that it decapsulates ONCE:
/// create -> PENDING -> CANCELLED | CONSUMED, never PENDING again. Everything
/// here exists to make sure no torn write, no vanished file, and no reused
/// identifier can put it back.
///
///   EXISTENCE IS LOAD-BEARING.  LOSS IS ACCEPTABLE.  REUSE IS NOT.
final class ReceiverStateTests: XCTestCase {
    let now = 1_756_684_800_000                              // 2025-09-01T00:00:00.000Z
    var createdAt: String { SptTime.format(epochMillis: now) }
    var expiresAt: String { SptTime.format(epochMillis: now + SptTime.requestTtlMillis) }

    /// A real request: a real X-Wing key pair, a canonical body, and the body's
    /// own fingerprint. Nothing here is a fixture that could drift from the code.
    func makeInput(requestIdByte: UInt8 = 0x11) throws -> (PendingRequestInput, String) {
        let keys = try XWing.generateKeyPair()
        let requestId = [UInt8](repeating: requestIdByte, count: SptConstants.requestIdBytes)
        let body = try ReceiveRequestCodec.encodeBody(requestId: requestId,
                                                      encapsulationKey: keys.encapsulationKey)
        let hash = try SptFingerprint.requestFingerprint(body)
        return (PendingRequestInput(body: body, requestId: requestId, requestHash: hash,
                                    dk: keys.decapsulationSeed, createdAt: createdAt,
                                    expiresAt: expiresAt),
                sptHex(requestId))
    }

    @discardableResult
    func create(_ vfs: SptVfs, requestIdByte: UInt8 = 0x11) throws -> String {
        let (input, idHex) = try makeInput(requestIdByte: requestIdByte)
        _ = try commitPendingReceiveRequest(vfs: vfs, input: input)
        return idHex
    }

    func refusal(_ body: () throws -> Void) -> SptRefused? {
        do { try body(); return nil } catch let r as SptRefused { return r } catch { return nil }
    }

    // MARK: - creation

    func testACreatedRequestIsPendingAndCarriesItsKey() throws {
        let vfs = MemorySptVfs()
        let (input, idHex) = try makeInput()
        let stored = try commitPendingReceiveRequest(vfs: vfs, input: input)
        XCTAssertEqual(stored.requestId, idHex)

        guard case .pending(let id, let hash, let body, let created, let expires, let dk) =
                readReceiverState(vfs: vfs, idHex: idHex, nowMillis: now) else {
            return XCTFail("a freshly created request is pending")
        }
        XCTAssertEqual(id, idHex)
        XCTAssertEqual(hash, input.requestHash)
        XCTAssertEqual(body, input.body)
        XCTAssertEqual(created, createdAt)
        XCTAssertEqual(expires, expiresAt)
        XCTAssertEqual(dk, input.dk, "only a valid, unexpired pending request carries the key")
    }

    /// request.json is written LAST and is the commit point. A crash before it
    /// leaves the key on disk with no published request — and that identifier is
    /// spent, not free.
    func testAnInterruptedCreationLeavesTheIdentifierSpentNotFree() throws {
        let inner = MemorySptVfs()
        let vfs = FailOnWriteSptVfs(inner: inner, failWhen: { $0.hasSuffix(requestFile) })
        let (input, idHex) = try makeInput()
        XCTAssertThrowsError(try commitPendingReceiveRequest(vfs: vfs, input: input))

        guard case .unusable = readReceiverState(vfs: inner, idHex: idHex, nowMillis: now) else {
            return XCTFail("an interrupted creation is unusable, never absent and never pending")
        }
        // And the identifier can never be used again, even though nothing usable
        // was left behind.
        let r = refusal { _ = try commitPendingReceiveRequest(vfs: inner, input: input) }
        XCTAssertEqual(r?.reason, refuseIdUnavailable)
        XCTAssertTrue(r?.message.contains("never reused") ?? false)
    }

    func testAnIdentifierIsNeverReusedEvenAfterATerminalOutcome() throws {
        let vfs = MemorySptVfs()
        let (input, idHex) = try makeInput()
        _ = try commitPendingReceiveRequest(vfs: vfs, input: input)
        _ = try cancelPendingReceiveRequest(vfs: vfs, idHex: idHex, reason: .operatorCancelled,
                                            at: createdAt, nowMillis: now)

        XCTAssertEqual(refusal { _ = try commitPendingReceiveRequest(vfs: vfs, input: input) }?.reason,
                       refuseIdUnavailable)
    }

    func testCreationRefusesEveryInconsistentInput() throws {
        let (good, _) = try makeInput()
        let cases: [(String, PendingRequestInput)] = [
            ("a requestHash that is not the body's hash",
             PendingRequestInput(body: good.body, requestId: good.requestId,
                                 requestHash: [UInt8](repeating: 0, count: 32), dk: good.dk,
                                 createdAt: good.createdAt, expiresAt: good.expiresAt)),
            ("a body naming a different requestId",
             PendingRequestInput(body: good.body,
                                 requestId: [UInt8](repeating: 0x22, count: 16),
                                 requestHash: good.requestHash, dk: good.dk,
                                 createdAt: good.createdAt, expiresAt: good.expiresAt)),
            ("a key of the wrong size",
             PendingRequestInput(body: good.body, requestId: good.requestId,
                                 requestHash: good.requestHash, dk: [1, 2, 3],
                                 createdAt: good.createdAt, expiresAt: good.expiresAt)),
            ("a non-canonical createdAt",
             PendingRequestInput(body: good.body, requestId: good.requestId,
                                 requestHash: good.requestHash, dk: good.dk,
                                 createdAt: "2025-09-01T00:00:00Z", expiresAt: good.expiresAt)),
            ("an expiry that is not exactly seven days out",
             PendingRequestInput(body: good.body, requestId: good.requestId,
                                 requestHash: good.requestHash, dk: good.dk,
                                 createdAt: good.createdAt,
                                 expiresAt: SptTime.format(epochMillis: now + 1000))),
        ]
        for (why, input) in cases {
            XCTAssertNotNil(refusal { _ = try commitPendingReceiveRequest(vfs: MemorySptVfs(),
                                                                          input: input) }, why)
        }
    }

    // MARK: - terminal markers beat everything

    /// A terminal marker is examined BEFORE any private key is looked at, and it
    /// beats a still-present dk.bin.
    func testATerminalMarkerBeatsAStillPresentKey() throws {
        let vfs = MemorySptVfs()
        let idHex = try create(vfs)
        XCTAssertTrue(vfs.exists(dkPath(idHex)), "the key is still on disk")

        _ = try cancelPendingReceiveRequest(vfs: vfs, idHex: idHex, reason: .rejected,
                                            at: createdAt, nowMillis: now)
        guard case .cancelled(_, let reason, _) = readReceiverState(vfs: vfs, idHex: idHex,
                                                                    nowMillis: now) else {
            return XCTFail("a cancelled request stays cancelled while its key is still there")
        }
        XCTAssertEqual(reason, .rejected)
        XCTAssertTrue(vfs.exists(dkPath(idHex)), "and the key being present changes nothing")
    }

    func testBothTerminalMarkersIsInconsistentNotAPick() throws {
        let vfs = MemorySptVfs()
        let idHex = try create(vfs)
        try vfs.writeFileAtomic(cancelledPath(idHex), Array("{}".utf8))
        try vfs.writeFileAtomic(consumedPath(idHex), Array("{}".utf8))

        guard case .terminalInconsistent(let message) =
                readReceiverState(vfs: vfs, idHex: idHex, nowMillis: now) else {
            return XCTFail("two terminal markers is a contradiction, not a choice")
        }
        XCTAssertTrue(message.contains("Ask for a new receive request"))
    }

    /// A TORN terminal marker never reads as absent or pending. This is the whole
    /// point: the one thing it can mean is that the key was already used.
    func testATornTerminalMarkerIsUnreadableNeverPending() throws {
        for (why, body) in [("empty", ""), ("not JSON", "{"), ("not an object", "[]"),
                            ("wrong version", #"{"version":2,"requestId":"x","at":"y","reason":"operator"}"#),
                            ("a different request", #"{"version":1,"requestId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","at":"2025-09-01T00:00:00.000Z","reason":"operator"}"#),
                            ("an unknown reason", #"{"version":1,"requestId":"REQ","at":"2025-09-01T00:00:00.000Z","reason":"whatever"}"#)] {
            let vfs = MemorySptVfs()
            let idHex = try create(vfs)
            try vfs.writeFileAtomic(cancelledPath(idHex),
                                    Array(body.replacingOccurrences(of: "REQ", with: idHex).utf8))

            guard case .terminalUnreadable = readReceiverState(vfs: vfs, idHex: idHex,
                                                               nowMillis: now) else {
                return XCTFail("[\(why)] a torn terminal marker must be unreadable, never pending")
            }
        }
    }

    /// A read that THROWS is not absence either.
    func testAMarkerThatCannotBeReadIsUnreadable() throws {
        let inner = MemorySptVfs()
        let idHex = try create(inner)
        try inner.writeFileAtomic(cancelledPath(idHex), Array("{}".utf8))
        let vfs = FailOnReadSptVfs(inner: inner, failWhen: { $0.hasSuffix(cancelledFile) })

        guard case .terminalUnreadable = readReceiverState(vfs: vfs, idHex: idHex, nowMillis: now) else {
            return XCTFail("an unreadable terminal marker must never read as pending")
        }
    }

    /// A stored request whose fields no longer agree is unusable, not pending —
    /// including one moved into another request's directory.
    func testARecordMovedBetweenDirectoriesIsRejected() throws {
        let vfs = MemorySptVfs()
        let idA = try create(vfs, requestIdByte: 0x11)
        let idB = try create(vfs, requestIdByte: 0x22)

        let aRecord = try XCTUnwrap(try vfs.readFile(requestPath(idA)))
        try vfs.writeFileAtomic(requestPath(idB), aRecord)

        guard case .unusable = readReceiverState(vfs: vfs, idHex: idB, nowMillis: now) else {
            return XCTFail("a record naming another request must not be believed")
        }
    }

    // MARK: - expiry

    func testAnExpiredRequestHandsOutNoKey() throws {
        let vfs = MemorySptVfs()
        let idHex = try create(vfs)
        let after = now + SptTime.requestTtlMillis

        guard case .expiredPending = readReceiverState(vfs: vfs, idHex: idHex, nowMillis: after) else {
            return XCTFail("at exactly the expiry the request is expired")
        }
        // One millisecond earlier it is still pending — the boundary is exact.
        guard case .pending = readReceiverState(vfs: vfs, idHex: idHex, nowMillis: after - 1) else {
            return XCTFail("one millisecond before expiry it is still pending")
        }
    }

    func testAnExpiredRequestIsTerminalizedOnlyAsExpired() throws {
        let vfs = MemorySptVfs()
        let idHex = try create(vfs)
        let after = now + SptTime.requestTtlMillis
        let at = SptTime.format(epochMillis: after)

        XCTAssertNotNil(refusal { _ = try cancelPendingReceiveRequest(
            vfs: vfs, idHex: idHex, reason: .operatorCancelled, at: at, nowMillis: after) })
        guard case .cancelled(_, let reason, _) = try expirePendingReceiveRequest(
            vfs: vfs, idHex: idHex, at: at, nowMillis: after) else {
            return XCTFail("an expired request terminalizes as expired")
        }
        XCTAssertEqual(reason, .expired)
    }

    func testAnExpiredRequestCannotReceiveAPad() throws {
        let vfs = MemorySptVfs()
        let idHex = try create(vfs)
        let after = now + SptTime.requestTtlMillis
        let r = refusal { _ = try consumePendingReceiveRequest(
            vfs: vfs, idHex: idHex,
            input: ConsumeInput(pairId: String(repeating: "a", count: 32),
                                packageIdentity: [UInt8](repeating: 7, count: 32),
                                at: SptTime.format(epochMillis: after)),
            nowMillis: after) }
        XCTAssertEqual(r?.reason, refuseReceiveState)
        XCTAssertTrue(r?.message.contains("expired") ?? false)
    }

    // MARK: - cancel and consume

    func testCancellationIsIdempotentAndTheFirstReasonStands() throws {
        let vfs = MemorySptVfs()
        let idHex = try create(vfs)
        _ = try cancelPendingReceiveRequest(vfs: vfs, idHex: idHex, reason: .rejected,
                                            at: createdAt, nowMillis: now)
        let again = try cancelPendingReceiveRequest(vfs: vfs, idHex: idHex,
                                                    reason: .operatorCancelled,
                                                    at: SptTime.format(epochMillis: now + 60_000),
                                                    nowMillis: now)
        guard case .cancelled(_, let reason, let at) = again else {
            return XCTFail("still cancelled")
        }
        XCTAssertEqual(reason, .rejected, "the FIRST reason stands")
        XCTAssertEqual(at, createdAt, "and the first time stands")
    }

    func testARequestReceivesExactlyOnePad() throws {
        let vfs = MemorySptVfs()
        let idHex = try create(vfs)
        let pairId = String(repeating: "b", count: 32)
        let identity = [UInt8](repeating: 9, count: 32)

        guard case .consumed(_, let gotPair, let gotIdentity, _) = try consumePendingReceiveRequest(
            vfs: vfs, idHex: idHex,
            input: ConsumeInput(pairId: pairId, packageIdentity: identity, at: createdAt),
            nowMillis: now) else {
            return XCTFail("the first consume succeeds")
        }
        XCTAssertEqual(gotPair, pairId)
        XCTAssertEqual(gotIdentity, identity)

        let r = refusal { _ = try consumePendingReceiveRequest(
            vfs: vfs, idHex: idHex,
            input: ConsumeInput(pairId: String(repeating: "c", count: 32),
                                packageIdentity: identity, at: createdAt),
            nowMillis: now) }
        XCTAssertTrue(r?.message.contains("already received a pad") ?? false)
    }

    func testAConsumedRequestCannotBeCancelled() throws {
        let vfs = MemorySptVfs()
        let idHex = try create(vfs)
        _ = try consumePendingReceiveRequest(
            vfs: vfs, idHex: idHex,
            input: ConsumeInput(pairId: String(repeating: "b", count: 32),
                                packageIdentity: [UInt8](repeating: 9, count: 32), at: createdAt),
            nowMillis: now)
        let r = refusal { _ = try cancelPendingReceiveRequest(vfs: vfs, idHex: idHex,
                                                              reason: .operatorCancelled,
                                                              at: createdAt, nowMillis: now) }
        XCTAssertTrue(r?.message.contains("cannot be cancelled") ?? false)
    }

    /// A terminal write that FAILS proves nothing — it may have landed. The state
    /// is re-read, and only a still-usable request is reported as unchanged.
    func testAFailedTerminalWriteReportsWhatTheDiskActuallySays() throws {
        let inner = MemorySptVfs()
        let idHex = try create(inner)
        let vfs = FailOnWriteSptVfs(inner: inner, failWhen: { $0.hasSuffix(cancelledFile) })

        let r = refusal { _ = try cancelPendingReceiveRequest(vfs: vfs, idHex: idHex,
                                                              reason: .operatorCancelled,
                                                              at: createdAt, nowMillis: now) }
        XCTAssertEqual(r?.reason, refuseReceiveState)
        XCTAssertTrue(r?.message.contains("has not been cancelled or consumed") ?? false)
        guard case .pending = readReceiverState(vfs: inner, idHex: idHex, nowMillis: now) else {
            return XCTFail("nothing landed, so the request is genuinely still pending")
        }
    }

    // MARK: - sealed ancestry, derived from what already persists

    func testSealedArrivalIsDerivedFromTheConsumedMarker() throws {
        let vfs = MemorySptVfs()
        let idHex = try create(vfs)
        let pairId = String(repeating: "d", count: 32)
        XCTAssertFalse(pairArrivedSealed(vfs: vfs, pairId: pairId), "control")

        _ = try consumePendingReceiveRequest(
            vfs: vfs, idHex: idHex,
            input: ConsumeInput(pairId: pairId, packageIdentity: [UInt8](repeating: 3, count: 32),
                                at: createdAt),
            nowMillis: now)
        XCTAssertTrue(pairArrivedSealed(vfs: vfs, pairId: pairId))
        XCTAssertFalse(pairArrivedSealed(vfs: vfs, pairId: String(repeating: "e", count: 32)),
                       "and only for the pad that actually arrived")
    }

    /// A TORN consumed marker is not a CONFIRMATION of sealed delivery, so it is
    /// skipped. This under-claims rather than over-claims, which is the safe
    /// direction for a fact that only ever disqualifies.
    func testATornConsumedMarkerIsNotReadAsSealedDelivery() throws {
        let vfs = MemorySptVfs()
        let idHex = try create(vfs)
        try vfs.writeFileAtomic(consumedPath(idHex), Array("{not json".utf8))
        XCTAssertFalse(pairArrivedSealed(vfs: vfs, pairId: String(repeating: "d", count: 32)))
    }

    // MARK: - key hygiene

    /// Dropping the key is best-effort and the terminal marker is the authority: a
    /// request stays consumed whether or not the key file could be removed.
    func testDroppingTheKeyNeverChangesTheDurableState() throws {
        let vfs = MemorySptVfs()
        let idHex = try create(vfs)
        _ = try consumePendingReceiveRequest(
            vfs: vfs, idHex: idHex,
            input: ConsumeInput(pairId: String(repeating: "b", count: 32),
                                packageIdentity: [UInt8](repeating: 9, count: 32), at: createdAt),
            nowMillis: now)

        bestEffortDropKey(vfs: vfs, idHex: idHex)
        XCTAssertFalse(vfs.exists(dkPath(idHex)))
        guard case .consumed = readReceiverState(vfs: vfs, idHex: idHex, nowMillis: now) else {
            return XCTFail("the terminal marker is the authority, not the key file")
        }

        // And a failure to drop it changes nothing either.
        let stubborn = FailOnWriteSptVfs(inner: vfs, failWhen: { _ in true })
        bestEffortDropKey(vfs: stubborn, idHex: idHex)
        guard case .consumed = readReceiverState(vfs: vfs, idHex: idHex, nowMillis: now) else {
            return XCTFail("still consumed")
        }
    }
}

// MARK: - fault injection

final class FailOnWriteSptVfs: SptVfs, @unchecked Sendable {
    let inner: SptVfs
    let failWhen: (String) -> Bool

    init(inner: SptVfs, failWhen: @escaping (String) -> Bool) {
        self.inner = inner
        self.failWhen = failWhen
    }

    func readFile(_ path: String) throws -> [UInt8]? { try inner.readFile(path) }
    func writeFileAtomic(_ path: String, _ data: [UInt8]) throws {
        if failWhen(path) { throw SptVfsError.io("simulated write failure: \(path)") }
        try inner.writeFileAtomic(path, data)
    }
    func exists(_ path: String) -> Bool { inner.exists(path) }
    func remove(_ path: String) throws {
        if failWhen(path) { throw SptVfsError.io("simulated remove failure: \(path)") }
        try inner.remove(path)
    }
    func writeRange(_ path: String, offset: Int, data: [UInt8]) throws {
        if failWhen(path) { throw SptVfsError.io("simulated writeRange failure: \(path)") }
        try inner.writeRange(path, offset: offset, data: data)
    }
    func size(_ path: String) throws -> Int? { try inner.size(path) }
    func list(_ prefix: String) throws -> [String] { try inner.list(prefix) }
    func withLock<T>(_ scope: String, _ body: () throws -> T) throws -> T {
        try inner.withLock(scope, body)
    }
}

final class FailOnReadSptVfs: SptVfs, @unchecked Sendable {
    let inner: SptVfs
    let failWhen: (String) -> Bool

    init(inner: SptVfs, failWhen: @escaping (String) -> Bool) {
        self.inner = inner
        self.failWhen = failWhen
    }

    func readFile(_ path: String) throws -> [UInt8]? {
        if failWhen(path) { throw SptVfsError.io("simulated read failure: \(path)") }
        return try inner.readFile(path)
    }
    func writeFileAtomic(_ path: String, _ data: [UInt8]) throws { try inner.writeFileAtomic(path, data) }
    func exists(_ path: String) -> Bool { inner.exists(path) }
    func remove(_ path: String) throws { try inner.remove(path) }
    func writeRange(_ path: String, offset: Int, data: [UInt8]) throws {
        try inner.writeRange(path, offset: offset, data: data)
    }
    func size(_ path: String) throws -> Int? { try inner.size(path) }
    func list(_ prefix: String) throws -> [String] { try inner.list(prefix) }
    func withLock<T>(_ scope: String, _ body: () throws -> T) throws -> T {
        try inner.withLock(scope, body)
    }
}
