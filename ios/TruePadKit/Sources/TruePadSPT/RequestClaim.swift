import TruePadCore

/* ============================================================================
 * The one-request claim.
 *
 * THE SECOND DURABLE GATE. handoff.json protects a PAD (keyed by pairId);
 * spt/claims/<requestHashHex>.json binds a REQUEST to a pair, permanently, so a
 * second FRESH pad cannot be sealed to the same request:
 *
 *     <pairId>/handoff.json               one pad, one handoff
 *     spt/claims/<requestHash>.json       one request, one package
 *
 * CLAIMED IS NOT CONSUMED. Retry R -> P is allowed (resumption); R -> Q when R is
 * already bound to P is refused permanently. Write order is
 * claim -> encapsulate -> handoff, marker-last.
 * ========================================================================= */

public let claimsDir = "spt/claims"
let claimHashBytes = 32

public let refuseClaimedElsewhere = "request-claimed-elsewhere"
public let refuseClaimUnreadable = "request-claim-unreadable"
public let refuseNotClaimed = "request-not-claimed"

public let claimUnreadableAdvice =
    "TruePad cannot safely determine which pad this receive request was already bound to, so it "
    + "refuses to seal anything to it. A record of that binding exists but cannot be read. Ask for "
    + "a new receive request."

public func claimPath(_ requestHash: [UInt8]) throws -> String {
    guard requestHash.count == claimHashBytes else {
        throw SptRejected(why: "requestHash must be \(claimHashBytes) bytes, got \(requestHash.count)")
    }
    return "\(claimsDir)/\(sptHex(requestHash)).json"
}

public struct RequestClaim: Sendable, Equatable {
    public let requestHash: String
    public let pairId: String
    public let at: String
}

public enum RequestClaimState: Sendable {
    case absent
    case claimed(RequestClaim)
    /// The record is there and cannot be trusted. NOT absence.
    case unreadable(message: String)
}

private let claimKeys = ["version", "requestHash", "pairId", "at"]

/// Strict parse: the record must NAME the request whose file it was read from, so
/// a claim copied between directories is rejected rather than believed.
public func parseClaim(_ bytes: [UInt8], requestHash: [UInt8]) throws -> RequestClaim {
    let members = try parseRecord(bytes, what: "request claim", keys: claimKeys)
    let requestHashB64 = try recordString(members, "requestHash")
    let decoded = try decodeExact(requestHashB64, length: claimHashBytes, field: "requestHash")
    guard SptBytes.equal(decoded, requestHash) else {
        throw SptRejected(why: "the request claim names a different request")
    }
    let pairId = try recordString(members, "pairId")
    guard isSptHex32(pairId) else {
        throw SptRejected(why: "the request claim has no valid pairId")
    }
    let at = try recordString(members, "at")
    guard SptTime.isCanonicalIso(at) else {
        throw SptRejected(why: "at is not a canonical ISO-8601 timestamp")
    }
    return RequestClaim(requestHash: requestHashB64, pairId: pairId, at: at)
}

/// A read that THROWS becomes `unreadable`, never `absent`.
public func readRequestClaim(vfs: SptVfs, requestHash: [UInt8]) -> RequestClaimState {
    let path: String
    do { path = try claimPath(requestHash) } catch {
        return .unreadable(message: "\(claimUnreadableAdvice) (\(error))")
    }
    let bytes: [UInt8]?
    do { bytes = try vfs.readFile(path) } catch {
        return .unreadable(message: "\(claimUnreadableAdvice) (\(error))")
    }
    guard let bytes else { return .absent }
    do {
        return .claimed(try parseClaim(bytes, requestHash: requestHash))
    } catch let e as SptRejected {
        return .unreadable(message: "\(claimUnreadableAdvice) (\(e.why))")
    } catch {
        return .unreadable(message: "\(claimUnreadableAdvice) (\(error))")
    }
}

/// Bind a request to a pair, permanently — step (1).
///
/// Idempotent for the SAME pair, which is the retry of an interrupted
/// pre-handoff attempt; R -> Q while R is bound to P is refused permanently. The
/// record is READ BACK and re-parsed before this returns, so a write that landed
/// corrupt is a refusal rather than a binding nothing can verify.
public func claimRequestForPair(vfs: SptVfs, requestHash: [UInt8],
                                pairId: String, at: String) throws -> RequestClaim {
    guard isSptHex32(pairId) else {
        throw SptRefused(reason: refuseClaimUnreadable,
                         message: "pairId must be 32 lowercase hex characters.")
    }
    let path = try claimPath(requestHash)

    switch readRequestClaim(vfs: vfs, requestHash: requestHash) {
    case .unreadable(let message):
        throw SptRefused(reason: refuseClaimUnreadable, message: message)
    case .claimed(let existing):
        guard existing.pairId == pairId else {
            throw SptRefused(
                reason: refuseClaimedElsewhere,
                message: "This receive request is already bound to a different pad. A request "
                    + "receives one pad and one package; sealing a second pad to it would leave the "
                    + "recipient two packages with two different confirmation codes and no way to "
                    + "tell which is real. Ask for a new receive request.")
        }
        return existing   // the same pair — the retry; the FIRST binding time stands
    case .absent:
        break
    }

    let record = serializeRecord([
        ("version", .int(sptRecordVersion)),
        ("requestHash", .string(SptBytes.toBase64Url(requestHash))),
        ("pairId", .string(pairId)),
        ("at", .string(at)),
    ])
    do {
        try vfs.writeFileAtomic(path, record)
    } catch {
        // A write that failed may still have LANDED. If anything is there, the
        // binding may exist and must not be re-attempted against another pad.
        let landed: Bool
        do { landed = (try vfs.readFile(path)) != nil } catch { landed = true }
        if !landed { throw error }
        throw SptRefused(
            reason: refuseClaimUnreadable,
            message: "\(claimUnreadableAdvice) (writing the binding failed after it had begun: \(error))")
    }

    guard let readBack = try vfs.readFile(path) else {
        throw SptRefused(reason: refuseClaimUnreadable,
                         message: "\(claimUnreadableAdvice) (the binding did not survive being written)")
    }
    let verified: RequestClaim
    do {
        verified = try parseClaim(readBack, requestHash: requestHash)
    } catch {
        throw SptRefused(reason: refuseClaimUnreadable,
                         message: "\(claimUnreadableAdvice) (the binding read back invalid: \(error))")
    }
    guard verified.pairId == pairId else {
        throw SptRefused(reason: refuseClaimUnreadable,
                         message: "\(claimUnreadableAdvice) (the binding read back naming another pad)")
    }
    return verified
}

/// The commit precheck: this request must ALREADY be bound to THIS pair.
public func requireClaimedByPair(vfs: SptVfs, requestHash: [UInt8],
                                 pairId: String) throws -> RequestClaim {
    switch readRequestClaim(vfs: vfs, requestHash: requestHash) {
    case .unreadable(let message):
        throw SptRefused(reason: refuseClaimUnreadable, message: message)
    case .absent:
        throw SptRefused(
            reason: refuseNotClaimed,
            message: "This receive request was never bound to this pad, so no package may be "
                + "committed for it. The binding is written before anything is encapsulated.")
    case .claimed(let claim):
        guard claim.pairId == pairId else {
            throw SptRefused(reason: refuseClaimedElsewhere,
                             message: "This receive request is bound to a different pad. Ask for a "
                                 + "new receive request.")
        }
        return claim
    }
}
