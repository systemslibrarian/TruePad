import Crypto
import Foundation
@testable import TruePadSPT
import XCTest

/// THE SENDER'S TWO DURABLE GATES, and the marker-last transaction between them.
///
///     <pairId>/handoff.json            one pad, one handoff
///     spt/claims/<requestHash>.json    one request, one package
///
/// The first stops a pad leaving twice. The second stops a SECOND pad being
/// sealed to the same request — which would leave the recipient two packages with
/// two different confirmation codes and no way to tell which is real.
///
/// LOSS IS ACCEPTABLE. REUSE IS NOT.
final class HandoffAndClaimTests: XCTestCase {
    let now = 1_756_684_800_000
    var at: String { SptTime.format(epochMillis: now) }
    let pairP = String(repeating: "1", count: 32)
    let pairQ = String(repeating: "2", count: 32)

    func hash(_ byte: UInt8) -> [UInt8] { [UInt8](repeating: byte, count: 32) }

    func refusal(_ body: () throws -> Void) -> SptRefused? {
        do { try body(); return nil } catch let r as SptRefused { return r } catch { return nil }
    }

    // MARK: - the one-request claim

    /// CLAIMED IS NOT CONSUMED. Retrying the same pad is resumption; a different
    /// pad is refused permanently.
    func testARequestBindsToOnePadForever() throws {
        let vfs = MemorySptVfs()
        let requestHash = hash(0xAA)

        let first = try claimRequestForPair(vfs: vfs, requestHash: requestHash,
                                            pairId: pairP, at: at)
        XCTAssertEqual(first.pairId, pairP)

        // The retry of an interrupted attempt: same pad, and the FIRST binding
        // time stands.
        let later = SptTime.format(epochMillis: now + 60_000)
        let retry = try claimRequestForPair(vfs: vfs, requestHash: requestHash,
                                            pairId: pairP, at: later)
        XCTAssertEqual(retry.at, at, "the first binding time stands")

        let r = refusal { _ = try claimRequestForPair(vfs: vfs, requestHash: requestHash,
                                                       pairId: pairQ, at: at) }
        XCTAssertEqual(r?.reason, refuseClaimedElsewhere)
        XCTAssertTrue(r?.message.contains("two different confirmation codes") ?? false,
                      "the refusal must say WHY a second package is dangerous")
    }

    /// A claim record moved into another request's file names the wrong request
    /// and is refused rather than believed.
    func testAClaimNamingAnotherRequestIsNotBelieved() throws {
        let vfs = MemorySptVfs()
        _ = try claimRequestForPair(vfs: vfs, requestHash: hash(0xAA), pairId: pairP, at: at)
        let record = try XCTUnwrap(try vfs.readFile(try claimPath(hash(0xAA))))
        try vfs.writeFileAtomic(try claimPath(hash(0xBB)), record)

        guard case .unreadable = readRequestClaim(vfs: vfs, requestHash: hash(0xBB)) else {
            return XCTFail("a claim naming a different request must not be trusted")
        }
    }

    func testATornClaimRefusesRatherThanRebinding() throws {
        for torn in ["", "{", "[]", #"{"version":2,"requestHash":"x","pairId":"y","at":"z"}"#,
                     #"{"version":1,"requestHash":"AA","pairId":"nothex","at":"2025-09-01T00:00:00.000Z"}"#] {
            let vfs = MemorySptVfs()
            try vfs.writeFileAtomic(try claimPath(hash(0xAA)), Array(torn.utf8))

            let r = refusal { _ = try claimRequestForPair(vfs: vfs, requestHash: hash(0xAA),
                                                           pairId: pairP, at: at) }
            XCTAssertEqual(r?.reason, refuseClaimUnreadable, "torn: \(torn)")
            XCTAssertTrue(r?.message.contains("Ask for a new receive request") ?? false)
        }
    }

    /// A claim that cannot be READ is unreadable, never absent — absence is what
    /// would permit binding a second pad.
    func testAnUnreadableClaimIsNeverAbsent() throws {
        let inner = MemorySptVfs()
        _ = try claimRequestForPair(vfs: inner, requestHash: hash(0xAA), pairId: pairP, at: at)
        let vfs = FailOnReadSptVfs(inner: inner, failWhen: { $0.hasPrefix(claimsDir) })

        guard case .unreadable = readRequestClaim(vfs: vfs, requestHash: hash(0xAA)) else {
            return XCTFail("an unreadable claim must never read as absent")
        }
    }

    func testCommitRequiresTheRequestToBeBoundToThisPair() throws {
        let vfs = MemorySptVfs()
        XCTAssertEqual(refusal { _ = try requireClaimedByPair(vfs: vfs, requestHash: hash(0xAA),
                                                               pairId: pairP) }?.reason,
                       refuseNotClaimed)

        _ = try claimRequestForPair(vfs: vfs, requestHash: hash(0xAA), pairId: pairP, at: at)
        XCTAssertEqual(try requireClaimedByPair(vfs: vfs, requestHash: hash(0xAA),
                                                pairId: pairP).pairId, pairP)
        XCTAssertEqual(refusal { _ = try requireClaimedByPair(vfs: vfs, requestHash: hash(0xAA),
                                                               pairId: pairQ) }?.reason,
                       refuseClaimedElsewhere)
    }

    /// A write that FAILS after landing must not let the caller try another pad.
    func testAClaimWriteThatLandedButFailedIsTreatedAsBinding() throws {
        let inner = MemorySptVfs()
        let vfs = LandThenFailSptVfs(inner: inner, failWhen: { $0.hasPrefix(claimsDir) })

        let r = refusal { _ = try claimRequestForPair(vfs: vfs, requestHash: hash(0xAA),
                                                       pairId: pairP, at: at) }
        XCTAssertEqual(r?.reason, refuseClaimUnreadable)
        XCTAssertTrue(r?.message.contains("failed after it had begun") ?? false)
    }

    // MARK: - the handoff marker

    func testAPhysicalHandoffCommitsAndBlocksASealedOne() throws {
        let vfs = MemorySptVfs()
        try sptCommitPhysicalHandoff(vfs: vfs, pairId: pairP, at: at)

        guard case .physical(let marker) = sptReadHandoffState(vfs: vfs, pairId: pairP) else {
            return XCTFail("a physical handoff is recorded")
        }
        XCTAssertEqual(marker.at, at)

        let refused = try XCTUnwrap(refusalForNewHandoff(sptReadHandoffState(vfs: vfs, pairId: pairP)))
        XCTAssertEqual(refused.reason, refuseAlreadyHandedOff)
    }

    func testATornMarkerIsSpentAndBlocksEverything() throws {
        for torn in ["", "{", "[]",
                     #"{"version":1,"pairId":"PAIR","mode":"courier","at":"2025-09-01T00:00:00.000Z"}"#,
                     #"{"version":1,"pairId":"PAIR","mode":"physical","at":"2025-09-01T00:00:00Z"}"#,
                     #"{"version":1,"pairId":"PAIR","mode":"physical","at":"2025-09-01T00:00:00.000Z","extra":1}"#] {
            let vfs = MemorySptVfs()
            try vfs.writeFileAtomic(markerPath(pairP),
                                    Array(torn.replacingOccurrences(of: "PAIR", with: pairP).utf8))

            guard case .unreadableSpent = sptReadHandoffState(vfs: vfs, pairId: pairP) else {
                return XCTFail("[\(torn)] a torn marker is spent, never absent")
            }
            XCTAssertEqual(refusalForNewHandoff(sptReadHandoffState(vfs: vfs, pairId: pairP))?.reason,
                           refuseHandoffUnreadable)
        }
    }

    /// A physical marker wearing sealed fields, and a sealed marker missing one,
    /// are both caught by the exact-key-set check.
    func testAMarkerCannotWearAnotherModesClothes() throws {
        let sealedFields = #""requestHash":"\#(SptBytes.toBase64Url(hash(1)))","packageIdentity":"\#(SptBytes.toBase64Url(hash(2)))","confirmHash":"\#(SptBytes.toBase64Url(hash(3)))""#
        for (why, body) in [
            ("physical wearing sealed clothes",
             #"{"version":1,"pairId":"\#(pairP)","mode":"physical","at":"\#(at)",\#(sealedFields)}"#),
            ("sealed missing a field",
             #"{"version":1,"pairId":"\#(pairP)","mode":"sealed","at":"\#(at)","requestHash":"\#(SptBytes.toBase64Url(hash(1)))","packageIdentity":"\#(SptBytes.toBase64Url(hash(2)))"}"#),
        ] {
            let vfs = MemorySptVfs()
            try vfs.writeFileAtomic(markerPath(pairP), Array(body.utf8))
            guard case .unreadableSpent = sptReadHandoffState(vfs: vfs, pairId: pairP) else {
                return XCTFail("[\(why)] must be refused")
            }
        }
    }

    // MARK: - the sealed transaction, marker-last

    /// A realistic package: any bytes will do, because this layer stores what the
    /// caller produced and verifies it against ITS OWN identity function.
    func sealedInput(packageBytes: [UInt8] = Array("a sealed package".utf8),
                     requestHash: [UInt8]? = nil) -> SealedHandoffInput {
        let bytes = packageBytes
        return SealedHandoffInput(
            packageBytes: bytes,
            requestHash: requestHash ?? hash(0xAA),
            confirmValue: [UInt8](repeating: 0x5A, count: SptConstants.confirmValueBytes),
            packageIdentity: SealedPackageCodec.packageIdentity(bytes))
    }

    func testASealedHandoffCommitsOnlyAfterBothPayloadsAreVerified() throws {
        let vfs = MemorySptVfs()
        _ = try claimRequestForPair(vfs: vfs, requestHash: hash(0xAA), pairId: pairP, at: at)
        let marker = try commitSealedHandoff(vfs: vfs, pairId: pairP, input: sealedInput(), at: at)

        guard case .sealed(_, _, let requestHash, let identity, _) = marker else {
            return XCTFail("a sealed marker")
        }
        XCTAssertEqual(requestHash, SptBytes.toBase64Url(hash(0xAA)))
        XCTAssertEqual(identity,
                       SptBytes.toBase64Url(SealedPackageCodec.packageIdentity(
                        Array("a sealed package".utf8))))
        XCTAssertTrue(vfs.exists(handoffPackagePath(pairP)))
        XCTAssertTrue(vfs.exists(handoffConfirmPath(pairP)))
    }

    /// THE ORDER IS THE POINT. If the marker cannot be written, the pad is still
    /// FREE — nothing has been handed off, so a retry is allowed.
    func testAFailureBeforeTheMarkerLeavesThePadFree() throws {
        let inner = MemorySptVfs()
        _ = try claimRequestForPair(vfs: inner, requestHash: hash(0xAA), pairId: pairP, at: at)
        let vfs = FailOnWriteSptVfs(inner: inner, failWhen: { $0.hasSuffix(handoffMarkerFileName) })

        XCTAssertThrowsError(try commitSealedHandoff(vfs: vfs, pairId: pairP,
                                                     input: sealedInput(), at: at))
        guard case .absent = sptReadHandoffState(vfs: inner, pairId: pairP) else {
            return XCTFail("with no marker the pad has NOT been handed off")
        }
        // And the retry succeeds, because the pad was never spent.
        XCTAssertNoThrow(try commitSealedHandoff(vfs: inner, pairId: pairP,
                                                 input: sealedInput(), at: at))
    }

    func testASealedHandoffRequiresTheRequestToBeClaimedFirst() throws {
        let vfs = MemorySptVfs()
        let r = refusal { _ = try commitSealedHandoff(vfs: vfs, pairId: pairP,
                                                       input: sealedInput(), at: at) }
        XCTAssertEqual(r?.reason, refuseNotClaimed)
        guard case .absent = sptReadHandoffState(vfs: vfs, pairId: pairP) else {
            return XCTFail("nothing was committed")
        }
    }

    func testASealedHandoffIsRefusedIfThePadAlreadyLeftByAnyRoute() throws {
        for (why, setUp) in [
            ("physically", { (v: SptVfs) in try sptCommitPhysicalHandoff(vfs: v, pairId: self.pairP, at: self.at) }),
        ] as [(String, (SptVfs) throws -> Void)] {
            let vfs = MemorySptVfs()
            _ = try claimRequestForPair(vfs: vfs, requestHash: hash(0xAA), pairId: pairP, at: at)
            try setUp(vfs)
            XCTAssertEqual(refusal { _ = try commitSealedHandoff(vfs: vfs, pairId: pairP,
                                                                  input: sealedInput(), at: at) }?.reason,
                           refuseAlreadyHandedOff, why)
        }
        // And a second sealed handoff is refused too.
        let vfs = MemorySptVfs()
        _ = try claimRequestForPair(vfs: vfs, requestHash: hash(0xAA), pairId: pairP, at: at)
        _ = try commitSealedHandoff(vfs: vfs, pairId: pairP, input: sealedInput(), at: at)
        XCTAssertEqual(refusal { _ = try commitSealedHandoff(vfs: vfs, pairId: pairP,
                                                              input: sealedInput(), at: at) }?.reason,
                       refuseAlreadySealed)
    }

    /// The supplied identity must be the identity of what actually landed.
    func testAMismatchedPackageIdentityIsRefusedBeforeAnyCommit() throws {
        let vfs = MemorySptVfs()
        _ = try claimRequestForPair(vfs: vfs, requestHash: hash(0xAA), pairId: pairP, at: at)
        let lying = SealedHandoffInput(packageBytes: Array("real bytes".utf8),
                                       requestHash: hash(0xAA),
                                       confirmValue: [UInt8](repeating: 1, count: SptConstants.confirmValueBytes),
                                       packageIdentity: hash(0xFF))

        XCTAssertEqual(refusal { _ = try commitSealedHandoff(vfs: vfs, pairId: pairP,
                                                              input: lying, at: at) }?.reason,
                       "storage-failed")
        guard case .absent = sptReadHandoffState(vfs: vfs, pairId: pairP) else {
            return XCTFail("nothing was committed")
        }
    }

    // MARK: - the retry returns the ORIGINAL package

    /// Re-sharing must return the EXACT original bytes. Re-encapsulating would
    /// produce a second package with a different confirmation code for the same
    /// request — the thing the claim exists to prevent.
    func testARetryReturnsTheExactCommittedPackage() throws {
        let vfs = MemorySptVfs()
        _ = try claimRequestForPair(vfs: vfs, requestHash: hash(0xAA), pairId: pairP, at: at)
        let input = sealedInput()
        _ = try commitSealedHandoff(vfs: vfs, pairId: pairP, input: input, at: at)

        let loaded = try loadCommittedSealedHandoff(vfs: vfs, pairId: pairP)
        XCTAssertEqual(loaded.packageBytes, input.packageBytes)
        XCTAssertEqual(loaded.confirmValue, input.confirmValue)
    }

    /// If the stored payload no longer matches the marker, the pad STAYS handed
    /// off and the package simply cannot be produced again. That is loss.
    func testAMismatchedOrMissingPayloadIsUnrecoverableAndThePadStaysHandedOff() throws {
        for (why, damage) in [
            ("the package is gone", { (v: MemorySptVfs) in try v.remove(handoffPackagePath(self.pairP)) }),
            ("the confirmation is gone", { (v: MemorySptVfs) in try v.remove(handoffConfirmPath(self.pairP)) }),
            ("the package was altered", { (v: MemorySptVfs) in
                try v.writeFileAtomic(handoffPackagePath(self.pairP), Array("different".utf8)) }),
            ("the confirmation was altered", { (v: MemorySptVfs) in
                try v.writeFileAtomic(handoffConfirmPath(self.pairP),
                                      [UInt8](repeating: 0x77, count: SptConstants.confirmValueBytes)) }),
        ] as [(String, (MemorySptVfs) throws -> Void)] {
            let vfs = MemorySptVfs()
            _ = try claimRequestForPair(vfs: vfs, requestHash: hash(0xAA), pairId: pairP, at: at)
            _ = try commitSealedHandoff(vfs: vfs, pairId: pairP, input: sealedInput(), at: at)
            try damage(vfs)

            let r = refusal { _ = try loadCommittedSealedHandoff(vfs: vfs, pairId: pairP) }
            XCTAssertEqual(r?.reason, refuseUnrecoverable, why)
            XCTAssertTrue(r?.message.contains("stays handed off") ?? false, why)
            // THE MARKER SURVIVES. The pad is still spent.
            guard case .sealed = sptReadHandoffState(vfs: vfs, pairId: pairP) else {
                return XCTFail("[\(why)] the marker must never be removed")
            }
        }
    }

    /// Dismissing the payload keeps the marker. handoff.json is not removed —
    /// not here, not anywhere.
    func testDismissingThePayloadKeepsThePadHandedOff() throws {
        let vfs = MemorySptVfs()
        _ = try claimRequestForPair(vfs: vfs, requestHash: hash(0xAA), pairId: pairP, at: at)
        _ = try commitSealedHandoff(vfs: vfs, pairId: pairP, input: sealedInput(), at: at)

        try dismissSealedPayload(vfs: vfs, pairId: pairP)
        XCTAssertFalse(vfs.exists(handoffPackagePath(pairP)))
        XCTAssertFalse(vfs.exists(handoffConfirmPath(pairP)))
        guard case .sealed(_, let packageAvailable, _) = sptReadHandoffState(vfs: vfs, pairId: pairP) else {
            return XCTFail("the pad is still permanently handed off")
        }
        XCTAssertFalse(packageAvailable)
        XCTAssertEqual(refusalForNewHandoff(sptReadHandoffState(vfs: vfs, pairId: pairP))?.reason,
                       refuseAlreadySealed)
    }

    /// Staged files may be cleaned ONLY while no marker exists; with one present
    /// they are not orphans.
    func testStagingIsCleanedOnlyBeforeCommit() throws {
        let vfs = MemorySptVfs()
        try vfs.writeFileAtomic(handoffPackagePath(pairP), Array("staged".utf8))
        XCTAssertNoThrow(try cleanPreCommitStaging(vfs: vfs, pairId: pairP))
        XCTAssertFalse(vfs.exists(handoffPackagePath(pairP)))

        _ = try claimRequestForPair(vfs: vfs, requestHash: hash(0xAA), pairId: pairP, at: at)
        _ = try commitSealedHandoff(vfs: vfs, pairId: pairP, input: sealedInput(), at: at)
        XCTAssertNotNil(refusal { try cleanPreCommitStaging(vfs: vfs, pairId: pairP) })
        XCTAssertTrue(vfs.exists(handoffPackagePath(pairP)), "committed payloads are not orphans")
    }

    // MARK: - the confirmation declaration

    func makeBody() throws -> [UInt8] {
        let keys = try XWing.generateKeyPair()
        return try ReceiveRequestCodec.encodeBody(
            requestId: [UInt8](repeating: 0x33, count: SptConstants.requestIdBytes),
            encapsulationKey: keys.encapsulationKey)
    }

    func testAConfirmationExpiresExactlySevenDaysLater() throws {
        let vfs = MemorySptVfs()
        let body = try makeBody()
        let (hex, record) = try commitConfirmation(vfs: vfs, body: body, confirmedAt: at,
                                                   nowMillis: now)
        XCTAssertEqual(record.body, body)
        XCTAssertEqual(SptTime.parseMillis(record.expiresAt)! - SptTime.parseMillis(record.confirmedAt)!,
                       SptTime.requestTtlMillis)

        // One millisecond before the expiry it is still usable; at it, expired.
        XCTAssertNoThrow(try requireConfirmedBody(vfs: vfs, requestHashHex: hex,
                                                  nowMillis: now + SptTime.requestTtlMillis - 1))
        XCTAssertEqual(refusal { _ = try requireConfirmedBody(
            vfs: vfs, requestHashHex: hex,
            nowMillis: now + SptTime.requestTtlMillis) }?.reason, refuseConfirmationExpired)
    }

    /// The hash is RE-DERIVED from the body, so a record filed under another
    /// request's name cannot make the app believe an operator confirmed something
    /// they never saw.
    func testAConfirmationFiledUnderTheWrongNameIsRefused() throws {
        let vfs = MemorySptVfs()
        let body = try makeBody()
        let (hex, _) = try commitConfirmation(vfs: vfs, body: body, confirmedAt: at, nowMillis: now)
        let record = try XCTUnwrap(try vfs.readFile(confirmedPath(hex)))

        let foreign = String(repeating: "a", count: 64)
        try vfs.writeFileAtomic(confirmedPath(foreign), record)
        guard case .unusable = readConfirmation(vfs: vfs, requestHashHex: foreign, nowMillis: now) else {
            return XCTFail("a confirmation naming a different request must not be believed")
        }
    }

    func testAnUnconfirmedRequestAuthorizesNothing() throws {
        let vfs = MemorySptVfs()
        XCTAssertEqual(refusal { _ = try requireConfirmedBody(
            vfs: vfs, requestHashHex: String(repeating: "b", count: 64),
            nowMillis: now) }?.reason, refuseConfirmationMissing)
    }

    /// The confirmation is REPLACEABLE — it records only that a human looked, and
    /// replacing it never touches the claim or the handoff.
    func testAConfirmationIsReplaceableAndTouchesNoOtherGate() throws {
        let vfs = MemorySptVfs()
        _ = try claimRequestForPair(vfs: vfs, requestHash: hash(0xAA), pairId: pairP, at: at)
        let body = try makeBody()
        let (hex, _) = try commitConfirmation(vfs: vfs, body: body, confirmedAt: at, nowMillis: now)

        let later = SptTime.format(epochMillis: now + 3600_000)
        let (hexAgain, again) = try commitConfirmation(vfs: vfs, body: body, confirmedAt: later,
                                                       nowMillis: now + 3600_000)
        XCTAssertEqual(hexAgain, hex, "the same body files under the same name")
        XCTAssertEqual(again.confirmedAt, later, "a fresh review replaces the old one")

        // The claim is untouched.
        XCTAssertEqual(try requireClaimedByPair(vfs: vfs, requestHash: hash(0xAA),
                                                pairId: pairP).at, at)
    }
}

/// A write that LANDS and then reports failure — the shape of an fsync error
/// after the bytes are already visible.
final class LandThenFailSptVfs: SptVfs, @unchecked Sendable {
    let inner: SptVfs
    let failWhen: (String) -> Bool

    init(inner: SptVfs, failWhen: @escaping (String) -> Bool) {
        self.inner = inner
        self.failWhen = failWhen
    }

    func readFile(_ path: String) throws -> [UInt8]? { try inner.readFile(path) }
    func writeFileAtomic(_ path: String, _ data: [UInt8]) throws {
        try inner.writeFileAtomic(path, data)
        if failWhen(path) { throw SptVfsError.io("landed, then failed: \(path)") }
    }
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
