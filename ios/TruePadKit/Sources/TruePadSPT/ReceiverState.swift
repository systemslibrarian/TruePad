import TruePadCore

/* ============================================================================
 * Receiver request state.
 *
 * The recipient holds a ONE-TIME X-Wing decapsulation seed. Its entire value is
 * that it decapsulates ONCE:
 *
 *     create -> PENDING -> CANCELLED | CONSUMED,  never PENDING again.
 *
 * The representation is immutable creation plus existence-based terminal markers.
 * Nothing is ever rewritten:
 *
 *   spt/receive/<idHex>/request.json    creation + publication marker (written LAST)
 *   spt/receive/<idHex>/dk.bin          the 32-byte X-Wing seed (written FIRST)
 *   spt/receive/<idHex>/cancelled.json  terminal, by existence
 *   spt/receive/<idHex>/consumed.json   terminal, by existence
 *
 *   EXISTENCE IS LOAD-BEARING.  LOSS IS ACCEPTABLE.  REUSE IS NOT.
 * ========================================================================= */

public let receiveRoot = "spt/receive"
public let requestFile = "request.json"
public let dkFile = "dk.bin"
public let cancelledFile = "cancelled.json"
public let consumedFile = "consumed.json"

let hashBytes = 32

public let refuseReceiveState = "receive-request-state"
public let refuseIdUnavailable = "request-id-unavailable"

public func receiveDir(_ idHex: String) -> String { "\(receiveRoot)/\(idHex)" }
public func requestPath(_ idHex: String) -> String { "\(receiveDir(idHex))/\(requestFile)" }
public func dkPath(_ idHex: String) -> String { "\(receiveDir(idHex))/\(dkFile)" }
public func cancelledPath(_ idHex: String) -> String { "\(receiveDir(idHex))/\(cancelledFile)" }
public func consumedPath(_ idHex: String) -> String { "\(receiveDir(idHex))/\(consumedFile)" }

public enum CancelReason: String, Sendable, Equatable, CaseIterable {
    case operatorCancelled = "operator"
    case expired
    case rejected
}

public enum ReceiverState: Sendable {
    case absent
    /// Only a valid, UNEXPIRED pending request carries the key, and it is a copy.
    case pending(requestId: String, requestHash: [UInt8], body: [UInt8],
                 createdAt: String, expiresAt: String, dk: [UInt8])
    case expiredPending(requestId: String, requestHash: [UInt8], body: [UInt8],
                        createdAt: String, expiresAt: String)
    case cancelled(requestId: String, reason: CancelReason, at: String)
    case consumed(requestId: String, pairId: String, packageIdentity: [UInt8], at: String)
    case unusable(message: String)
    case terminalUnreadable(message: String)
    case terminalInconsistent(message: String)
}

public let terminalAdvice =
    "TruePad cannot safely determine whether this receive request was already used, so it will not "
    + "use its one-time key again. Ask for a new receive request."

public struct StoredRequest: Sendable, Equatable {
    public let requestId: String
    public let requestHash: [UInt8]
    public let body: [UInt8]
    public let createdAt: String
    public let expiresAt: String
}

private let requestKeys = ["version", "requestId", "requestHash", "body", "createdAt", "expiresAt"]
private let cancelledKeys = ["version", "requestId", "at", "reason"]
private let consumedKeys = ["version", "requestId", "at", "pairId", "packageIdentity"]

private func requireIso(_ value: String, _ field: String) throws -> String {
    guard SptTime.isCanonicalIso(value) else {
        throw SptRejected(why: "\(field) is not a canonical ISO-8601 timestamp")
    }
    return value
}

/// Strict parse AND FULL RE-DERIVATION.
///
/// The body must be a canonical TPR2 body, its EMBEDDED requestId must equal the
/// path it was read from, and the stored requestHash must be the hash of that
/// body. A record moved between directories is rejected rather than believed.
public func parseStoredRequest(_ bytes: [UInt8], idHex: String) throws -> StoredRequest {
    let members = try parseRecord(bytes, what: requestFile, keys: requestKeys)
    let requestId = try recordString(members, "requestId")
    guard isSptHex32(requestId) else {
        throw SptRejected(why: "requestId is not 32 lowercase hex characters")
    }
    guard requestId == idHex else {
        throw SptRejected(why: "the record names a different request")
    }
    let requestHash = try decodeExact(try recordString(members, "requestHash"),
                                      length: hashBytes, field: "requestHash")
    let body = try decodeExact(try recordString(members, "body"),
                               length: SptConstants.tpr2BodyBytes, field: "body")
    let createdAt = try requireIso(try recordString(members, "createdAt"), "createdAt")
    let expiresAt = try requireIso(try recordString(members, "expiresAt"), "expiresAt")
    guard let created = SptTime.parseMillis(createdAt), let expires = SptTime.parseMillis(expiresAt),
          expires > created else {
        throw SptRejected(why: "expiresAt is not after createdAt")
    }
    guard case .ok(let request, _) = ReceiveRequestCodec.parseBody(body) else {
        throw SptRejected(why: "the stored body is not a canonical request")
    }
    guard sptHex(request.requestId) == idHex else {
        throw SptRejected(why: "the stored body names a different request")
    }
    guard let derived = try? SptFingerprint.requestFingerprint(body),
          SptBytes.equal(derived, requestHash) else {
        throw SptRejected(why: "the stored requestHash is not the hash of the stored body")
    }
    return StoredRequest(requestId: idHex, requestHash: requestHash, body: body,
                         createdAt: createdAt, expiresAt: expiresAt)
}

public struct CancelledMarker: Sendable, Equatable {
    public let requestId: String
    public let at: String
    public let reason: CancelReason
}

public struct ConsumedMarker: Sendable, Equatable {
    public let requestId: String
    public let at: String
    public let pairId: String
    public let packageIdentity: [UInt8]
}

public func parseCancelled(_ bytes: [UInt8], idHex: String) throws -> CancelledMarker {
    let members = try parseRecord(bytes, what: cancelledFile, keys: cancelledKeys)
    let requestId = try recordString(members, "requestId")
    guard requestId == idHex, isSptHex32(requestId) else {
        throw SptRejected(why: "the marker names a different request")
    }
    let at = try requireIso(try recordString(members, "at"), "at")
    guard let reason = CancelReason(rawValue: try recordString(members, "reason")) else {
        throw SptRejected(why: "unrecognised cancellation reason")
    }
    return CancelledMarker(requestId: idHex, at: at, reason: reason)
}

public func parseConsumed(_ bytes: [UInt8], idHex: String) throws -> ConsumedMarker {
    let members = try parseRecord(bytes, what: consumedFile, keys: consumedKeys)
    let requestId = try recordString(members, "requestId")
    guard requestId == idHex, isSptHex32(requestId) else {
        throw SptRejected(why: "the marker names a different request")
    }
    let at = try requireIso(try recordString(members, "at"), "at")
    let pairId = try recordString(members, "pairId")
    guard isSptHex32(pairId) else { throw SptRejected(why: "bad pairId") }
    let packageIdentity = try decodeExact(try recordString(members, "packageIdentity"),
                                          length: hashBytes, field: "packageIdentity")
    return ConsumedMarker(requestId: idHex, at: at, pairId: pairId, packageIdentity: packageIdentity)
}

/// Does ANYTHING live under this requestId?
///
/// A requestId whose namespace ever held anything is unavailable FOREVER, and is
/// never cleaned up for reuse — a reused identifier is how a second package gets
/// sealed to a request that already received one.
public func namespaceOccupied(vfs: SptVfs, idHex: String) throws -> Bool {
    !(try vfs.list(receiveDir(idHex)).isEmpty)
}

/// Did this pad arrive by SEALED ONLINE DELIVERY?
///
/// Scans the durable consumed.json markers for a matching pairId, so the
/// deployment evaluator can DERIVE "computational delivery" from a fact that
/// already persists rather than from a flag someone set. Fails safe in the
/// under-claiming direction: an unreadable or unparseable marker is skipped and
/// never reported as sealed.
public func pairArrivedSealed(vfs: SptVfs, pairId: String) -> Bool {
    let dirs: [String]
    do { dirs = try vfs.list(receiveRoot) } catch { return false }
    for idHex in dirs where isSptHex32(idHex) {
        let bytes: [UInt8]?
        do { bytes = try vfs.readFile(consumedPath(idHex)) } catch { continue }
        guard let bytes else { continue }
        // A torn or unparseable terminal marker is not a CONFIRMATION of sealed
        // delivery, so it is skipped here.
        if let marker = try? parseConsumed(bytes, idHex: idHex), marker.pairId == pairId {
            return true
        }
    }
    return false
}

private func terminalUnreadable(_ detail: String) -> ReceiverState {
    .terminalUnreadable(message: "\(terminalAdvice) (\(detail))")
}

/// The receiver's durable state.
///
/// TERMINAL MARKERS ARE EXAMINED BEFORE ANY PRIVATE KEY IS LOOKED AT, and a
/// terminal marker beats a still-present dk.bin. `nowMillis` is required rather
/// than defaulted, because expiry decides whether a one-time key is handed out
/// and a caller must not be able to omit it by accident.
public func readReceiverState(vfs: SptVfs, idHex: String, nowMillis: Int) -> ReceiverState {
    guard isSptHex32(idHex) else {
        return .unusable(message: "a requestId is exactly 32 lowercase hex characters")
    }

    let hasCancelled = vfs.exists(cancelledPath(idHex))
    let hasConsumed = vfs.exists(consumedPath(idHex))

    if hasCancelled && hasConsumed {
        return .terminalInconsistent(
            message: "\(terminalAdvice) (this request carries both a cancellation and a "
                + "consumption record)")
    }
    if hasCancelled {
        do {
            guard let bytes = try vfs.readFile(cancelledPath(idHex)) else {
                return terminalUnreadable("the cancellation record vanished while being read")
            }
            let m = try parseCancelled(bytes, idHex: idHex)
            return .cancelled(requestId: idHex, reason: m.reason, at: m.at)
        } catch let e as SptRejected {
            return terminalUnreadable(e.why)
        } catch {
            return terminalUnreadable("unreadable cancellation record (\(error))")
        }
    }
    if hasConsumed {
        do {
            guard let bytes = try vfs.readFile(consumedPath(idHex)) else {
                return terminalUnreadable("the consumption record vanished while being read")
            }
            let m = try parseConsumed(bytes, idHex: idHex)
            return .consumed(requestId: idHex, pairId: m.pairId,
                             packageIdentity: m.packageIdentity, at: m.at)
        } catch let e as SptRejected {
            return terminalUnreadable(e.why)
        } catch {
            return terminalUnreadable("unreadable consumption record (\(error))")
        }
    }

    let requestBytes: [UInt8]?
    do { requestBytes = try vfs.readFile(requestPath(idHex)) } catch {
        return .unusable(message: "this receive request cannot be read (\(error))")
    }
    guard let requestBytes else {
        // No request.json. If ANYTHING else is in the namespace, this identifier
        // was used by an attempt that did not complete — it is spent, not free.
        let occupied = (try? namespaceOccupied(vfs: vfs, idHex: idHex)) ?? true
        return occupied
            ? .unusable(message: "this receive request was never completed and cannot be used")
            : .absent
    }

    let stored: StoredRequest
    do {
        stored = try parseStoredRequest(requestBytes, idHex: idHex)
    } catch let e as SptRejected {
        return .unusable(message: "this receive request is not usable (\(e.why))")
    } catch {
        return .unusable(message: "this receive request is not usable (\(error))")
    }

    let dk: [UInt8]?
    do { dk = try vfs.readFile(dkPath(idHex)) } catch {
        return .unusable(message: "this receive request's key cannot be read (\(error))")
    }
    guard let dk, dk.count == SptConstants.xwingSeedBytes else {
        return .unusable(message: "this receive request's key is missing or the wrong size")
    }

    guard let expires = SptTime.parseMillis(stored.expiresAt) else {
        return .unusable(message: "this receive request has an unreadable expiry")
    }
    if nowMillis >= expires {
        return .expiredPending(requestId: stored.requestId, requestHash: stored.requestHash,
                               body: stored.body, createdAt: stored.createdAt,
                               expiresAt: stored.expiresAt)
    }
    return .pending(requestId: stored.requestId, requestHash: stored.requestHash,
                    body: stored.body, createdAt: stored.createdAt,
                    expiresAt: stored.expiresAt, dk: dk)
}

public struct PendingRequestInput: Sendable {
    public let body: [UInt8]
    public let requestId: [UInt8]
    public let requestHash: [UInt8]
    public let dk: [UInt8]
    public let createdAt: String
    public let expiresAt: String

    public init(body: [UInt8], requestId: [UInt8], requestHash: [UInt8],
                dk: [UInt8], createdAt: String, expiresAt: String) {
        self.body = body
        self.requestId = requestId
        self.requestHash = requestHash
        self.dk = dk
        self.createdAt = createdAt
        self.expiresAt = expiresAt
    }
}

private func refuse(_ message: String) -> SptRefused {
    SptRefused(reason: refuseReceiveState, message: message)
}

/// Create a PENDING receive request, with request.json written LAST as the commit
/// marker. Every relationship is RE-VERIFIED from what came back off the disk,
/// because a request that published but did not store is a one-time key nobody
/// can account for.
public func commitPendingReceiveRequest(vfs: SptVfs,
                                        input: PendingRequestInput) throws -> StoredRequest {
    guard input.requestId.count == SptConstants.requestIdBytes else {
        throw refuse("requestId must be \(SptConstants.requestIdBytes) bytes")
    }
    let idHex = sptHex(input.requestId)
    guard isSptHex32(idHex) else { throw refuse("requestId must render as 32 lowercase hex characters") }
    guard input.dk.count == SptConstants.xwingSeedBytes else {
        throw refuse("the decapsulation seed must be exactly \(SptConstants.xwingSeedBytes) bytes")
    }
    guard input.requestHash.count == hashBytes else {
        throw refuse("requestHash must be \(hashBytes) bytes")
    }
    guard case .ok(let parsedBody, _) = ReceiveRequestCodec.parseBody(input.body) else {
        throw refuse("the request body is not canonical")
    }
    guard SptBytes.equal(parsedBody.requestId, input.requestId) else {
        throw refuse("the request body names a different requestId")
    }
    guard let derived = try? SptFingerprint.requestFingerprint(input.body),
          SptBytes.equal(derived, input.requestHash) else {
        throw refuse("the supplied requestHash is not the hash of the supplied body")
    }
    guard SptTime.isCanonicalIso(input.createdAt), let created = SptTime.parseMillis(input.createdAt) else {
        throw refuse("createdAt is not a canonical ISO-8601 timestamp")
    }
    guard SptTime.isCanonicalIso(input.expiresAt), let expires = SptTime.parseMillis(input.expiresAt) else {
        throw refuse("expiresAt is not a canonical ISO-8601 timestamp")
    }
    guard expires - created == SptTime.requestTtlMillis else {
        throw refuse("expiresAt must be exactly seven days after createdAt")
    }

    if (try? namespaceOccupied(vfs: vfs, idHex: idHex)) ?? true {
        throw SptRefused(
            reason: refuseIdUnavailable,
            message: "This request identifier has already been used. Identifiers are never reused, "
                + "even when the earlier attempt left nothing usable behind. Generate another.")
    }

    // The key FIRST, and verified: a published request whose key did not store is
    // a request nobody can answer.
    try vfs.writeFileAtomic(dkPath(idHex), input.dk)
    guard let storedDk = try vfs.readFile(dkPath(idHex)),
          storedDk.count == SptConstants.xwingSeedBytes,
          SptBytes.equal(storedDk, input.dk) else {
        throw refuse("the decapsulation key did not store intact; nothing was published.")
    }

    // request.json LAST — the commit point.
    let record = serializeRecord([
        ("version", .int(sptRecordVersion)),
        ("requestId", .string(idHex)),
        ("requestHash", .string(SptBytes.toBase64Url(input.requestHash))),
        ("body", .string(SptBytes.toBase64Url(input.body))),
        ("createdAt", .string(input.createdAt)),
        ("expiresAt", .string(input.expiresAt)),
    ])
    try vfs.writeFileAtomic(requestPath(idHex), record)

    guard let readBack = try vfs.readFile(requestPath(idHex)) else {
        throw refuse("the receive request did not survive being written; nothing was published.")
    }
    let verified: StoredRequest
    do {
        verified = try parseStoredRequest(readBack, idHex: idHex)
    } catch {
        throw refuse("the receive request read back invalid (\(error)); nothing was published.")
    }
    guard SptBytes.equal(verified.body, input.body),
          SptBytes.equal(verified.requestHash, input.requestHash) else {
        throw refuse("the receive request read back with different contents; nothing was published.")
    }
    return verified
}

/// Establish durable terminal state, then REPORT WHAT THE DISK ACTUALLY SAYS.
///
/// A write that throws proves nothing — it may have landed — so the state is
/// re-read to decide. Only if the re-read still shows a usable request is the
/// caller told nothing changed.
private func writeTerminal(vfs: SptVfs, path: String, bytes: [UInt8],
                           idHex: String, nowMillis: Int) throws -> ReceiverState {
    do {
        try vfs.writeFileAtomic(path, bytes)
    } catch {
        let after = readReceiverState(vfs: vfs, idHex: idHex, nowMillis: nowMillis)
        switch after {
        case .pending, .expiredPending, .absent:
            throw SptRefused(
                reason: refuseReceiveState,
                message: "the request was not changed (\(error)); it has not been cancelled or "
                    + "consumed.")
        default:
            return after
        }
    }
    return readReceiverState(vfs: vfs, idHex: idHex, nowMillis: nowMillis)
}

/// PENDING -> CANCELLED. One terminal writer, three reasons.
public func cancelPendingReceiveRequest(vfs: SptVfs, idHex: String, reason: CancelReason,
                                        at: String, nowMillis: Int) throws -> ReceiverState {
    guard SptTime.isCanonicalIso(at) else {
        throw refuse("at is not a canonical ISO-8601 timestamp")
    }
    switch readReceiverState(vfs: vfs, idHex: idHex, nowMillis: nowMillis) {
    case .cancelled(let id, let r, let a):
        return .cancelled(requestId: id, reason: r, at: a)   // idempotent; the FIRST reason stands
    case .pending:
        break
    case .expiredPending:
        guard reason == .expired else {
            throw refuse("an expired receive request is terminalized as expired, not by any other "
                         + "reason.")
        }
    case .consumed:
        throw refuse("this receive request was already used to receive a pad; it cannot be cancelled.")
    case .absent:
        throw refuse("there is no such receive request.")
    case .unusable(let m), .terminalUnreadable(let m), .terminalInconsistent(let m):
        throw SptRefused(reason: refuseReceiveState, message: m)
    }
    let bytes = serializeRecord([
        ("version", .int(sptRecordVersion)),
        ("requestId", .string(idHex)),
        ("at", .string(at)),
        ("reason", .string(reason.rawValue)),
    ])
    return try writeTerminal(vfs: vfs, path: cancelledPath(idHex), bytes: bytes,
                             idHex: idHex, nowMillis: nowMillis)
}

public func expirePendingReceiveRequest(vfs: SptVfs, idHex: String, at: String,
                                        nowMillis: Int) throws -> ReceiverState {
    try cancelPendingReceiveRequest(vfs: vfs, idHex: idHex, reason: .expired,
                                    at: at, nowMillis: nowMillis)
}

public struct ConsumeInput: Sendable {
    public let pairId: String
    public let packageIdentity: [UInt8]
    public let at: String

    public init(pairId: String, packageIdentity: [UInt8], at: String) {
        self.pairId = pairId
        self.packageIdentity = packageIdentity
        self.at = at
    }
}

/// PENDING -> CONSUMED, the CONSUME-BEFORE-IMPORT commit boundary.
///
/// This must be called BEFORE the pair import commits. If the import then fails,
/// the transfer is LOST and the request is NEVER reopened — that is the trade:
/// a lost pad is recoverable by generating another, a reopened one-time key is
/// not recoverable at all.
public func consumePendingReceiveRequest(vfs: SptVfs, idHex: String, input: ConsumeInput,
                                         nowMillis: Int) throws -> ReceiverState {
    guard SptTime.isCanonicalIso(input.at) else {
        throw refuse("at is not a canonical ISO-8601 timestamp")
    }
    guard isSptHex32(input.pairId) else { throw refuse("pairId must be 32 lowercase hex characters") }
    guard input.packageIdentity.count == hashBytes else {
        throw refuse("packageIdentity must be \(hashBytes) bytes")
    }

    switch readReceiverState(vfs: vfs, idHex: idHex, nowMillis: nowMillis) {
    case .pending:
        break
    case .expiredPending:
        throw refuse("this receive request has expired and cannot receive a pad.")
    case .cancelled:
        throw refuse("this receive request was cancelled and cannot receive a pad.")
    case .consumed:
        throw refuse("this receive request has already received a pad.")
    case .absent:
        throw refuse("there is no such receive request.")
    case .unusable(let m), .terminalUnreadable(let m), .terminalInconsistent(let m):
        throw SptRefused(reason: refuseReceiveState, message: m)
    }
    let bytes = serializeRecord([
        ("version", .int(sptRecordVersion)),
        ("requestId", .string(idHex)),
        ("at", .string(input.at)),
        ("pairId", .string(input.pairId)),
        ("packageIdentity", .string(SptBytes.toBase64Url(input.packageIdentity))),
    ])
    return try writeTerminal(vfs: vfs, path: consumedPath(idHex), bytes: bytes,
                             idHex: idHex, nowMillis: nowMillis)
}

/// Best-effort removal of the stored key after a request is durably terminal.
///
/// THE TERMINAL MARKER IS THE AUTHORITY; a failure here does not change the state
/// and must never be reported as one. This narrows the window in which a spent
/// seed sits on disk; it proves nothing about the medium.
public func bestEffortDropKey(vfs: SptVfs, idHex: String) {
    if let size = (try? vfs.size(dkPath(idHex))) ?? nil, size > 0 {
        try? vfs.writeRange(dkPath(idHex), offset: 0, data: [UInt8](repeating: 0, count: size))
    }
    try? vfs.remove(dkPath(idHex))
}
