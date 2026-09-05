import Foundation
import TruePadCore
import TruePadSPT

/* ============================================================================
 * Bridging the durable store to the SPT layer.
 *
 * `FsSptVfs` adapts this module's `Fs` to the SPT layer's `SptVfs` — SAME files,
 * SAME locks — so the SPT durable protocol and the OTP store share one filesystem
 * and one per-scope lock. The orchestration verbs live on `Engine`; the frozen
 * OTP crypto and verbs are untouched.
 *
 *   SENDER:   claim -> encapsulate -> handoff (marker-last) -> release
 *   RECEIVER: parse -> request authority -> decapsulate -> preflight -> compare
 *             -> CONSUME -> import
 * ========================================================================= */

/// A 64-character lowercase hex request fingerprint.
///
/// Defined here rather than imported: the SPT layer's own predicate is internal
/// to that module, and `TruePadSPT` cannot be used as a module qualifier at all
/// because the module declares `public enum TruePadSPT`, which shadows the name.
func isHex64(_ s: String) -> Bool {
    s.count == 64 && s.allSatisfy { $0.isASCII && ($0.isNumber || ("a"..."f").contains(String($0))) }
}

/// A pass-through adapter: `Fs` already has every method `SptVfs` needs.
public final class FsSptVfs: SptVfs, @unchecked Sendable {
    private let fs: Fs
    public init(_ fs: Fs) { self.fs = fs }

    public func readFile(_ path: String) throws -> [UInt8]? { try fs.readFile(path) }
    public func writeFileAtomic(_ path: String, _ data: [UInt8]) throws { try fs.writeFileAtomic(path, data) }
    public func exists(_ path: String) -> Bool { fs.exists(path) }
    public func remove(_ path: String) throws { try fs.remove(path) }
    public func writeRange(_ path: String, offset: Int, data: [UInt8]) throws {
        try fs.writeRange(path, offset: offset, data: data)
    }
    public func size(_ path: String) throws -> Int? { try fs.size(path) }
    public func list(_ prefix: String) throws -> [String] { try fs.list(prefix) }
    public func withLock<T>(_ scope: String, _ body: () throws -> T) throws -> T {
        try fs.withLock(scope, body)
    }
}

// MARK: - SPT verb result types

/// Show this to the recipient: the TPR2 text (paste or QR), the requestId, the
/// 64-hex requestHash, the twelve request-word indices, and the expiry.
public struct SptCreateResult: Sendable {
    public let requestIdHex: String
    public let requestHashHex: String
    public let tpr2Text: String
    public let requestIndices: [Int]
    public let expiresAt: String
}

/// A decoded receive request the sender is reviewing. The CANONICAL BODY is
/// handed back for the caller to hold and re-supply to confirm/seal — never
/// re-derived from an untrusted layer.
public struct SptReviewResult: Sendable {
    public let canonicalBody: [UInt8]
    public let requestIdHex: String
    public let requestHashHex: String
    public let requestIndices: [Int]
}

/// The sealed package to hand over, plus the eight confirmation-word indices the
/// sender reads aloud. `reshared` is true when an already-committed package was
/// returned rather than a fresh seal.
public struct SptSealResult: Sendable {
    public let requestHashHex: String
    public let packageIdentityB64: String
    public let packageBytes: [UInt8]
    public let confirmationIndices: [Int]
    public let reshared: Bool
}

/// A TRANSIENT receive session, held by the caller between "open" and "commit".
///
/// It carries the decrypted pad bytes — a SECRET, which the caller must keep in
/// memory only — and everything the commit needs. The eight indices are the words
/// the recipient compares against what the sender reads aloud.
public struct SptOpenResult: Sendable {
    public let requestIdHex: String
    public let requestHash: [UInt8]
    public let pairId: String
    public let packageIdentity: [UInt8]
    public let padFileBytes: [UInt8]
    public let confirmValue: [UInt8]
    public let confirmationIndices: [Int]
}

// MARK: - the SPT verbs

extension Engine {
    var sptVfs: SptVfs { FsSptVfs(fs) }

    func nowMillis() -> Int { Int((clock().timeIntervalSince1970 * 1000).rounded()) }

    /// True if this pad was DELIVERED by sealed transfer — derived from the
    /// durable consumed.json markers, so the deployment evaluator reads a fact
    /// that already persists rather than a flag someone set.
    public func sptPairArrivedSealed(_ pairId: String) -> Bool {
        pairArrivedSealed(vfs: sptVfs, pairId: pairId)
    }

    // ---- RECEIVER: publish a one-time request ------------------------------

    /// Create a one-time recipient key and publish a receive request.
    ///
    /// The TPR2 text is produced ONLY after dk.bin and request.json are written
    /// and read back — a published request whose key did not store is a request
    /// nobody can answer.
    public func sptCreateReceiveRequest() throws -> SptCreateResult {
        let vfs = sptVfs
        for _ in 0..<16 {
            let requestId = randomBytes(SptConstants.requestIdBytes)
            let idHex = Hex.encode(requestId)
            if (try? namespaceOccupied(vfs: vfs, idHex: idHex)) ?? true { continue }
            let keys = try XWing.generateKeyPair()
            let body = try ReceiveRequestCodec.encodeBody(requestId: requestId,
                                                          encapsulationKey: keys.encapsulationKey)
            let requestHash = try SptFingerprint.requestFingerprint(body)
            do {
                return try fs.withLock("spt-req:\(idHex)") {
                    let millis = nowMillis()
                    let createdAt = SptTime.format(epochMillis: millis)
                    let expiresAt = SptTime.format(epochMillis: millis + SptTime.requestTtlMillis)
                    _ = try commitPendingReceiveRequest(
                        vfs: vfs,
                        input: PendingRequestInput(body: body, requestId: requestId,
                                                   requestHash: requestHash,
                                                   dk: keys.decapsulationSeed,
                                                   createdAt: createdAt, expiresAt: expiresAt))
                    return SptCreateResult(
                        requestIdHex: idHex,
                        requestHashHex: Hex.encode(requestHash),
                        tpr2Text: try ReceiveRequestCodec.encode(
                            requestId: requestId, encapsulationKey: keys.encapsulationKey),
                        requestIndices: try SptFingerprint.requestIndices132(requestHash),
                        expiresAt: expiresAt)
                }
            } catch let e as SptRefused where e.reason == refuseIdUnavailable {
                continue   // astronomically unlikely; retried rather than reused
            }
        }
        throw SptRefused(reason: "spt-request-unavailable",
                         message: "could not allocate a new receive request identifier. Nothing "
                             + "was created.")
    }

    /// The receive request that survived a restart, if there is one.
    ///
    /// WHY THIS EXISTS. `request.json` and `dk.bin` are durable, and nothing ever
    /// read them back. The Receive tab held the published request in memory only,
    /// so a force-quit left a LIVE one-time key on disk that the interface could
    /// no longer reach: the operator could not cancel it, could not REJECT it
    /// after a failed word comparison, and could not re-display the twelve words
    /// the ceremony depends on. The key stayed pending until it expired or a
    /// package consumed it. Losing the reject affordance is the part that
    /// matters — rejecting is how a comparison that does not match is supposed to
    /// end.
    ///
    /// THE PRIVATE KEY IS DELIBERATELY NOT RETURNED. `.pending` carries `dk`, and
    /// this drops it on the floor: everything above the engine needs the public
    /// request, its words and its expiry, and nothing above the engine has any
    /// business holding a decapsulation seed.
    ///
    /// A pending request whose TTL has passed comes back as `.expiredPending` and
    /// is NOT returned here — it is not usable, and offering it would invite a
    /// ceremony that cannot complete.
    ///
    /// If several are pending — which only happens because the missing restore
    /// let the operator publish another one — the most recently created is
    /// returned, so cancelling repeatedly drains them rather than stranding them.
    public func sptRestorePendingReceiveRequest() throws -> SptCreateResult? {
        let vfs = sptVfs
        let ids: [String]
        do { ids = try vfs.list(receiveRoot) } catch { return nil }

        let now = nowMillis()
        var newest: (createdAt: String, result: SptCreateResult)?
        for idHex in ids where isSptHex32(idHex) {
            guard case .pending(let requestId, let requestHash, let body,
                                let createdAt, let expiresAt, _) =
                    readReceiverState(vfs: vfs, idHex: idHex, nowMillis: now) else { continue }
            // Rebuilt from the STORED body, not re-derived from anything the UI
            // holds: the text the sender scanned is a function of the bytes on
            // disk, and this is those bytes.
            let result = SptCreateResult(
                requestIdHex: requestId,
                requestHashHex: Hex.encode(requestHash),
                tpr2Text: SptConstants.tpr2Prefix + SptBytes.toBase64Url(body),
                requestIndices: try SptFingerprint.requestIndices132(requestHash),
                expiresAt: expiresAt)
            // ISO-8601 with a fixed shape, so lexicographic order is chronological.
            if newest == nil || createdAt > newest!.createdAt {
                newest = (createdAt, result)
            }
        }
        return newest?.result
    }

    /// The recipient withdraws a request they published.
    ///
    /// TERMINAL AND PERMANENT. The one-time key behind it is never usable again,
    /// and the identifier is never reissued — cancelling is as final as using it,
    /// which is what makes "cancel" a safe thing to offer.
    @discardableResult
    public func sptCancelReceiveRequest(requestIdHex: String,
                                        reason: CancelReason = .operatorCancelled) throws -> ReceiverState {
        try fs.withLock("spt-req:\(requestIdHex)") {
            let millis = nowMillis()
            return try cancelPendingReceiveRequest(vfs: sptVfs, idHex: requestIdHex,
                                                   reason: reason,
                                                   at: SptTime.format(epochMillis: millis),
                                                   nowMillis: millis)
        }
    }

    /// The recipient compared the eight words and they did NOT match.
    ///
    /// This is a distinct outcome from an ordinary cancellation, and it is
    /// recorded as one: `rejected` says a human looked at a package and said it
    /// was wrong, which is the single most important signal this protocol can
    /// carry. Nothing is imported, and the request is spent.
    @discardableResult
    public func sptRejectReceiveRequest(requestIdHex: String) throws -> ReceiverState {
        try sptCancelReceiveRequest(requestIdHex: requestIdHex, reason: .rejected)
    }

    // ---- SENDER: review, confirm, seal --------------------------------------

    /// Decode a scanned or pasted TPR2 and return the twelve words to compare.
    ///
    /// The canonical body is handed BACK for the caller to hold and re-supply,
    /// never re-derived later from an untrusted layer.
    public func sptReviewRequest(_ tpr2Text: String) throws -> SptReviewResult {
        switch ReceiveRequestCodec.decode(tpr2Text) {
        case .failed(_, let message):
            throw SptRefused(reason: "spt-request-unavailable",
                             message: "this is not a usable receive request: \(message)")
        case .ok(let request, let canonicalBody):
            let requestHash = try SptFingerprint.requestFingerprint(canonicalBody)
            return SptReviewResult(
                canonicalBody: canonicalBody,
                requestIdHex: Hex.encode(request.requestId),
                requestHashHex: Hex.encode(requestHash),
                requestIndices: try SptFingerprint.requestIndices132(requestHash))
        }
    }

    /// Record the operator's twelve-word match for the reviewed body. A
    /// DECLARATION that a human looked — never evidence that they did.
    @discardableResult
    public func sptConfirmRequest(canonicalBody: [UInt8]) throws -> String {
        let millis = nowMillis()
        return try commitConfirmation(vfs: sptVfs, body: canonicalBody,
                                      confirmedAt: SptTime.format(epochMillis: millis),
                                      nowMillis: millis).hex
    }

    /// A pad is sealable only if it originated HERE and is at GENESIS.
    ///
    /// ALL THREE counters, both directions. `attemptsReserved` is not a
    /// bookkeeping detail: a pad that took a FAILED OPEN at genesis still reads
    /// nextOffset == 0 and nextSequence == 0, but it has already spent part of its
    /// freeze budget and one record already carries a recorded verification
    /// attempt. Sealing it would hand the receiver a store that is NOT pristine
    /// and whose §5 forgery bound is already partly consumed, without their being
    /// able to tell. Android omitted this check once and sealed pads the Browser
    /// refuses.
    func requirePadSealable(_ pairId: String) throws {
        try requireNotDestroyed(pairId)
        try requireImportComplete(pairId)
        try requirePair(pairId)
        let meta = try readPairMeta(fs: fs, pairId: pairId)
        guard meta.origin == .generatedHere else {
            throw SptRefused(
                reason: "spt-pad-ineligible",
                message: "This pad did not originate on this device, so it will not be sent by "
                    + "sealed transfer. Generate a new pad to share.")
        }
        let pair = try loadPair(pairId)
        let atGenesis = pair.values.allSatisfy {
            $0.effective.nextOffset == 0 && $0.effective.nextSequence == 0
                && $0.effective.attemptsReserved == 0
        }
        guard atGenesis else {
            throw SptRefused(
                reason: "spt-pad-ineligible",
                message: "This pad has already been used, so it cannot be sent by sealed transfer "
                    + "— a sealed transfer sends the whole pad. Generate a fresh pad to share.")
        }
    }

    /// Seal a live, generated-here, genesis pad to a CONFIRMED request — or
    /// return the exact already-committed package.
    ///
    /// LOCK ORDER IS LOAD-BEARING: the pad lock is OUTERMOST and the
    /// request-scoped send lock is INNER, never the reverse. Two seals of
    /// DIFFERENT pads to the SAME request take DIFFERENT pad locks, so only the
    /// request-scoped lock makes the claim's read-then-write a real
    /// compare-and-set. Without it the gate has a TOCTOU window and one request
    /// could yield two valid packages with two different confirmation codes.
    public func sptSeal(requestHashHex: String, pairId: String) throws -> SptSealResult {
        guard isHex64(requestHashHex) else {
            throw SptRefused(reason: "spt-request-unavailable",
                             message: "a request fingerprint is 64 lowercase hex characters.")
        }
        guard isHex32(pairId) else {
            throw SptRefused(reason: "spt-pad-ineligible",
                             message: "a pad id is 32 lowercase hex characters.")
        }
        let vfs = sptVfs
        return try fs.withLock(pairId) {
            try requireNotDestroyed(pairId)
            switch sptReadHandoffState(vfs: vfs, pairId: pairId) {
            case .unreadableSpent(let message):
                throw SptRefused(reason: refuseHandoffUnreadable, message: message)

            case .physical:
                throw SptRefused(
                    reason: refuseAlreadyHandedOff,
                    message: "This pad has already been handed off as a file, so it cannot also be "
                        + "sent by sealed transfer. Generate a new pad for that.")

            case .sealed(let marker, _, _):
                // EXACT RE-SHARE. No new cryptography, no fresh confirmation.
                guard case .sealed(_, _, let markerRequestHash, let markerIdentity, _) = marker,
                      let wanted = Hex.decode(requestHashHex),
                      markerRequestHash == SptBytes.toBase64Url(wanted) else {
                    throw SptRefused(
                        reason: refuseAlreadySealed,
                        message: "This pad was already sealed to a different receive request. "
                            + "Generate a new pad for this one.")
                }
                let committed = try loadCommittedSealedHandoff(vfs: vfs, pairId: pairId)
                return SptSealResult(
                    requestHashHex: requestHashHex,
                    packageIdentityB64: markerIdentity,
                    packageBytes: committed.packageBytes,
                    confirmationIndices: try SptFingerprint.confirmationIndices88(committed.confirmValue),
                    reshared: true)

            case .absent:
                // ABSENT — and only NOW does live eligibility apply, before the
                // inner lock, exactly as the frozen sealImpl orders it.
                try requirePadSealable(pairId)
                return try fs.withLock("spt-send:\(requestHashHex)") {
                    // Re-check the pad's handoff with BOTH locks held.
                    guard case .absent = sptReadHandoffState(vfs: vfs, pairId: pairId) else {
                        throw SptRefused(reason: refuseAlreadySealed,
                                         message: "this pad's handoff was committed concurrently.")
                    }
                    // The time is read HERE, under both locks, immediately before
                    // the decision it governs — never a clock read from before
                    // this call waited in the queue, which could authorize a seal
                    // on a confirmation that expired while it waited.
                    let millis = nowMillis()
                    let confirmed = try requireConfirmedBody(vfs: vfs, requestHashHex: requestHashHex,
                                                             nowMillis: millis)
                    let requestHash = try SptFingerprint.requestFingerprint(confirmed.body)
                    guard Hex.encode(requestHash) == requestHashHex else {
                        throw SptRefused(reason: "spt-request-unavailable",
                                         message: "the stored confirmation does not match this request.")
                    }
                    _ = try claimRequestForPair(vfs: vfs, requestHash: requestHash, pairId: pairId,
                                                at: SptTime.format(epochMillis: millis))
                    let container = try buildLiveCourierContainer(pairId)
                    guard container.count <= SptConstants.maxPlaintextBytes else {
                        throw SptRefused(reason: "spt-pad-ineligible",
                                         message: "this pad is too large to send by sealed transfer.")
                    }
                    let sealed = try SptCryptoV1.seal(canonicalRequestBody: confirmed.body,
                                                      payload: container)
                    _ = try commitSealedHandoff(
                        vfs: vfs, pairId: pairId,
                        input: SealedHandoffInput(packageBytes: sealed.packageBytes,
                                                  requestHash: requestHash,
                                                  confirmValue: sealed.confirmValue,
                                                  packageIdentity: sealed.packageIdentity),
                        at: SptTime.format(epochMillis: millis))
                    let committed = try loadCommittedSealedHandoff(vfs: vfs, pairId: pairId)
                    return SptSealResult(
                        requestHashHex: requestHashHex,
                        packageIdentityB64: SptBytes.toBase64Url(sealed.packageIdentity),
                        packageBytes: committed.packageBytes,
                        confirmationIndices: try SptFingerprint.confirmationIndices88(committed.confirmValue),
                        reshared: false)
                }
            }
        }
    }

    // ---- RECEIVER: open, compare, commit ------------------------------------

    /// In-memory bundle validation: write the unpacked files to a SCRATCH store
    /// and load both halves, so a bad bundle is refused BEFORE the one-time
    /// request is consumed. Nothing durable is written. Returns nil when the
    /// bundle is a whole, valid, matched pair; a message otherwise.
    func sptPreflightBundle(pairId: String, files: [CourierFile]) -> String? {
        guard isHex32(pairId) else { return "this pad file has an invalid identifier." }
        let scratch = MemoryFs()
        for f in files {
            try? scratch.writeFileAtomic("\(pairId)/\(f.path)", f.bytes)
        }
        var heads: [PadDirection: HeadV2] = [:]
        for d in [PadDirection.aToB, .bToA] {
            switch loadStore(fs: scratch, prefix: "\(pairId)/\(directionSubdirectory[d]!)") {
            case .refused(_, let message):
                return "the received \(d.rawValue) store is not usable: \(message)"
            case .ok(let store):
                heads[d] = store.head
            }
        }
        guard heads[.aToB]?.pairId == pairId, heads[.bToA]?.pairId == pairId else {
            return "the bundle's head pairId disagrees with the container pairId."
        }
        guard heads[.aToB]?.direction == .aToB, heads[.bToA]?.direction == .bToA else {
            return "the bundle's two halves are not a matched A->B / B->A pair."
        }
        return nil
    }

    /// Open a sealed package into a TRANSIENT session held by the caller.
    ///
    /// Ordering: structural parse -> request authority (which refuses a terminal
    /// or expired request BEFORE any key is used) -> requestHash binding ->
    /// decapsulate and AEAD -> in-memory preflight. NO PAD BYTES TOUCH DURABLE
    /// STORAGE, and nothing is consumed.
    public func sptOpen(packageBytes: [UInt8]) throws -> SptOpenResult {
        let parsed: ParsedPackage
        switch SealedPackageCodec.parse(packageBytes) {
        case .failed(_, let message):
            throw SptRefused(reason: "spt-package-malformed",
                             message: "this sealed file is not usable: \(message)")
        case .ok(let p):
            parsed = p
        }
        let requestIdHex = Hex.encode(parsed.header.requestId)
        let vfs = sptVfs
        return try fs.withLock("spt-req:\(requestIdHex)") {
            let millis = nowMillis()
            let pendingBody: [UInt8]
            let pendingHash: [UInt8]
            let pendingDk: [UInt8]
            switch readReceiverState(vfs: vfs, idHex: requestIdHex, nowMillis: millis) {
            case .pending(_, let hash, let body, _, _, let dk):
                pendingHash = hash; pendingBody = body; pendingDk = dk
            case .expiredPending:
                _ = try? cancelPendingReceiveRequest(vfs: vfs, idHex: requestIdHex, reason: .expired,
                                                     at: SptTime.format(epochMillis: millis),
                                                     nowMillis: millis)
                throw SptRefused(reason: "spt-request-expired",
                                 message: "this receive request has expired.")
            case .cancelled:
                throw SptRefused(reason: "spt-request-cancelled",
                                 message: "this receive request was cancelled and cannot be used.")
            case .consumed:
                throw SptRefused(reason: "spt-request-consumed",
                                 message: "this receive request has already received a pad.")
            case .absent:
                throw SptRefused(reason: "spt-request-unavailable",
                                 message: "there is no such receive request on this device.")
            case .unusable(let m), .terminalUnreadable(let m), .terminalInconsistent(let m):
                throw SptRefused(reason: "spt-request-unavailable", message: m)
            }
            guard SptBytes.equal(parsed.header.requestHash, pendingHash) else {
                throw SptRefused(reason: "spt-request-unavailable",
                                 message: "this sealed file is for a different receive request.")
            }
            // NOTE: the opened result is bound INSIDE the switch rather than
            // declared first, because both modules export a type named
            // `OpenResult` (the OTP open and the SPT open) and `TruePadSPT`
            // cannot disambiguate -- the module declares an enum of that name,
            // which shadows the module itself.
            let payload: [UInt8]
            let openedIdentity: [UInt8]
            let openedConfirmValue: [UInt8]
            let openedIndices: [Int]
            switch SptCryptoV1.open(packageBytes: packageBytes, canonicalRequestBody: pendingBody,
                                    decapsulationSeed: pendingDk) {
            case .failed:
                throw SptRefused(reason: "spt-package-open-failed",
                                 message: "this sealed file could not be opened for this receive "
                                     + "request.")
            case .ok(let r):
                payload = r.payload
                openedIdentity = r.packageIdentity
                openedConfirmValue = r.confirmValue
                openedIndices = r.confirmationIndices
            }
            let pairId: String
            let files: [CourierFile]
            switch unpackContainer(payload) {
            case .bad(let message):
                throw SptRefused(reason: "spt-package-not-importable",
                                 message: "this is not a usable pad file: \(message)")
            case .ok(let id, let f):
                pairId = id; files = f
            }
            if let problem = sptPreflightBundle(pairId: pairId, files: files) {
                throw SptRefused(reason: "spt-package-not-importable",
                                 message: "\(problem) Nothing was imported.")
            }
            // Against the REAL store, non-mutating: refuse a pad id already
            // committed (or destroyed) here BEFORE opening a session. FREE —
            // nothing is consumed, no importer runs. Re-checked at commit,
            // because state moves.
            try requireImportable(pairId)
            return SptOpenResult(requestIdHex: requestIdHex, requestHash: pendingHash,
                                 pairId: pairId, packageIdentity: openedIdentity,
                                 padFileBytes: payload, confirmValue: openedConfirmValue,
                                 confirmationIndices: openedIndices)
        }
    }

    /// CONSUME the request, THEN import.
    ///
    /// After a valid consume, ANY import failure is LOSS and the request stays
    /// consumed — never reopened. That is the trade this product always makes: a
    /// lost pad can be replaced by generating another; a reopened one-time key
    /// cannot be un-reopened.
    public func sptCommitReceive(session: SptOpenResult, label: String) throws -> PairSummary {
        let vfs = sptVfs
        return try fs.withLock("spt-req:\(session.requestIdHex)") {
            let millis = nowMillis()
            let pendingHash: [UInt8]
            switch readReceiverState(vfs: vfs, idHex: session.requestIdHex, nowMillis: millis) {
            case .pending(_, let hash, _, _, _, _):
                pendingHash = hash
            case .expiredPending:
                _ = try? cancelPendingReceiveRequest(vfs: vfs, idHex: session.requestIdHex,
                                                     reason: .expired,
                                                     at: SptTime.format(epochMillis: millis),
                                                     nowMillis: millis)
                throw SptRefused(reason: "spt-request-expired",
                                 message: "this receive request expired before the pad was saved.")
            case .cancelled:
                throw SptRefused(reason: "spt-request-cancelled",
                                 message: "this receive request was cancelled.")
            case .consumed:
                throw SptRefused(reason: "spt-request-consumed",
                                 message: "this receive request has already received a pad.")
            case .absent:
                throw SptRefused(reason: "spt-request-unavailable",
                                 message: "there is no such receive request.")
            case .unusable(let m), .terminalUnreadable(let m), .terminalInconsistent(let m):
                throw SptRefused(reason: "spt-request-unavailable", message: m)
            }
            guard SptBytes.equal(pendingHash, session.requestHash) else {
                throw SptRefused(reason: "spt-request-unavailable",
                                 message: "this transfer no longer matches its receive request.")
            }
            let pairId: String
            switch unpackContainer(session.padFileBytes) {
            case .bad(let message):
                throw SptRefused(reason: "spt-package-not-importable",
                                 message: "this pad file is not usable: \(message)")
            case .ok(let id, _):
                pairId = id
            }
            // Re-run the cheap real-state check under the request lock: a pair or
            // a tombstone can appear between open and now. Refusing HERE is FREE
            // — nothing is consumed. importPair re-checks authoritatively under
            // the pad lock; this only spares the common case a spent request.
            try requireImportable(pairId)

            // CONSUME. After this returns valid, any failure below is LOSS.
            let consumed = try consumePendingReceiveRequest(
                vfs: vfs, idHex: session.requestIdHex,
                input: ConsumeInput(pairId: pairId, packageIdentity: session.packageIdentity,
                                    at: SptTime.format(epochMillis: millis)),
                nowMillis: millis)
            guard case .consumed = consumed else {
                throw SptRefused(
                    reason: "spt-receive-loss",
                    message: "TruePad could not safely record that this receive request was used, "
                        + "so the pad was not saved. The request cannot be used again — ask the "
                        + "sender to generate a new pad and start a new transfer.")
            }
            do {
                return try importPair(label: label, container: session.padFileBytes)
            } catch {
                throw SptRefused(
                    reason: "spt-receive-loss",
                    message: "The one-time receive request was used, but the pad did not finish "
                        + "saving (\(error)). The request cannot be used again — ask the sender to "
                        + "generate a new pad and start a new transfer.")
            }
        }
    }
}
