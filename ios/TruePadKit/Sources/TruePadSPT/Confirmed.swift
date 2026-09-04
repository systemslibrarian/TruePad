import TruePadCore

/* ============================================================================
 * The sender's CONFIRMED declaration.
 *
 * spt/confirmed/<requestHashHex>.json means exactly one thing: the UI reported
 * that the operator said all twelve request words matched. It is a DECLARATION,
 * not proof, and nothing here should ever be read as evidence that two humans
 * really compared anything.
 *
 * Unlike the claim and the handoff it is REPLACEABLE — it records only that a
 * human looked, so a fresh review of the SAME body may replace it — and it never
 * touches the claim or the handoff, which are what prevent a second package.
 * ========================================================================= */

public let confirmedDir = "spt/confirmed"

public let refuseConfirmationMissing = "spt-confirmation-missing"
public let refuseConfirmationExpired = "spt-confirmation-expired"

public func confirmedPath(_ requestHashHex: String) -> String {
    "\(confirmedDir)/\(requestHashHex).json"
}

private let confirmedKeys = ["version", "requestHash", "body", "confirmedAt", "expiresAt"]
private let confirmedHashBytes = 32

public struct ConfirmedRecord: Sendable, Equatable {
    public let requestHash: [UInt8]
    /// The exact canonical §5.1 request body the operator reviewed.
    public let body: [UInt8]
    public let confirmedAt: String
    public let expiresAt: String
}

public enum ConfirmationState: Sendable {
    case absent
    case confirmed(ConfirmedRecord)
    case expired(ConfirmedRecord)
    case unusable(message: String)
}

/// Strict parse AND FULL RE-DERIVATION.
///
/// The body must parse as a canonical §5.1 request and must hash to the
/// requestHash this record is filed under. Re-deriving rather than trusting the
/// stored hash is the point: a record moved or renamed cannot make the app
/// believe an operator confirmed a request they never saw.
public func parseConfirmed(_ bytes: [UInt8], requestHashHex: String) throws -> ConfirmedRecord {
    let members = try parseRecord(bytes, what: "confirmation record", keys: confirmedKeys)
    let requestHash = try decodeExact(try recordString(members, "requestHash"),
                                      length: confirmedHashBytes, field: "requestHash")
    guard sptHex(requestHash) == requestHashHex else {
        throw SptRejected(why: "the record names a different request")
    }
    let body = try decodeExact(try recordString(members, "body"),
                               length: SptConstants.tpr2BodyBytes, field: "body")
    let confirmedAt = try recordString(members, "confirmedAt")
    guard SptTime.isCanonicalIso(confirmedAt) else {
        throw SptRejected(why: "confirmedAt is not a canonical ISO-8601 timestamp")
    }
    let expiresAt = try recordString(members, "expiresAt")
    guard SptTime.isCanonicalIso(expiresAt) else {
        throw SptRejected(why: "expiresAt is not a canonical ISO-8601 timestamp")
    }
    guard let expires = SptTime.parseMillis(expiresAt),
          let confirmed = SptTime.parseMillis(confirmedAt),
          expires - confirmed == SptTime.requestTtlMillis else {
        throw SptRejected(why: "expiresAt is not exactly seven days after confirmedAt")
    }
    guard case .ok = ReceiveRequestCodec.parseBody(body) else {
        throw SptRejected(why: "the confirmed body is not a canonical request")
    }
    guard let derived = try? SptFingerprint.requestFingerprint(body),
          SptBytes.equal(derived, requestHash) else {
        throw SptRejected(why: "the confirmed body does not hash to this request")
    }
    return ConfirmedRecord(requestHash: requestHash, body: body,
                           confirmedAt: confirmedAt, expiresAt: expiresAt)
}

public func readConfirmation(vfs: SptVfs, requestHashHex: String,
                             nowMillis: Int) -> ConfirmationState {
    guard isSptHex64(requestHashHex) else {
        return .unusable(message: "a requestHash is 64 lowercase hex characters")
    }
    let bytes: [UInt8]?
    do { bytes = try vfs.readFile(confirmedPath(requestHashHex)) } catch {
        return .unusable(message: "the confirmation could not be read (\(error))")
    }
    guard let bytes else { return .absent }
    let record: ConfirmedRecord
    do {
        record = try parseConfirmed(bytes, requestHashHex: requestHashHex)
    } catch let e as SptRejected {
        return .unusable(message: "the confirmation is not usable (\(e.why))")
    } catch {
        return .unusable(message: "the confirmation is not usable (\(error))")
    }
    guard let expires = SptTime.parseMillis(record.expiresAt) else {
        return .unusable(message: "the confirmation has an unreadable expiry")
    }
    return nowMillis >= expires ? .expired(record) : .confirmed(record)
}

/// Record the operator's declaration for the body the CALLER reviewed.
///
/// The hash is re-derived from the bytes, so the file cannot be filed under a
/// mismatched name, and the record is read back before this returns — a
/// confirmation that did not store intact authorizes nothing.
public func commitConfirmation(vfs: SptVfs, body: [UInt8], confirmedAt: String,
                               nowMillis: Int) throws -> (hex: String, record: ConfirmedRecord) {
    guard case .ok = ReceiveRequestCodec.parseBody(body) else {
        throw SptRefused(reason: "spt-request-unavailable",
                         message: "this is not a canonical receive request")
    }
    guard SptTime.isCanonicalIso(confirmedAt), let confirmedMillis = SptTime.parseMillis(confirmedAt) else {
        throw SptRefused(reason: "spt-request-unavailable",
                         message: "confirmedAt is not a canonical ISO-8601 timestamp")
    }
    let requestHash = try SptFingerprint.requestFingerprint(body)
    let requestHashHex = sptHex(requestHash)
    let expiresAt = SptTime.format(epochMillis: confirmedMillis + SptTime.requestTtlMillis)

    let record = serializeRecord([
        ("version", .int(sptRecordVersion)),
        ("requestHash", .string(SptBytes.toBase64Url(requestHash))),
        ("body", .string(SptBytes.toBase64Url(body))),
        ("confirmedAt", .string(confirmedAt)),
        ("expiresAt", .string(expiresAt)),
    ])
    try vfs.writeFileAtomic(confirmedPath(requestHashHex), record)

    guard case .confirmed(let stored) = readConfirmation(vfs: vfs, requestHashHex: requestHashHex,
                                                         nowMillis: nowMillis) else {
        throw SptRefused(
            reason: refuseConfirmationMissing,
            message: "the confirmation did not store intact, so nothing is authorized to be sealed. "
                + "Review the request again.")
    }
    return (requestHashHex, stored)
}

/// The gate a NEW seal runs first. Returns the EXACT confirmed body; refuses if
/// there is no usable, unexpired confirmation. Deliberately NOT called on the
/// exact-re-share path, which releases bytes that already exist rather than
/// sealing anything new.
public func requireConfirmedBody(vfs: SptVfs, requestHashHex: String,
                                 nowMillis: Int) throws -> ConfirmedRecord {
    switch readConfirmation(vfs: vfs, requestHashHex: requestHashHex, nowMillis: nowMillis) {
    case .confirmed(let record):
        return record
    case .expired:
        throw SptRefused(
            reason: refuseConfirmationExpired,
            message: "the confirmation for this receive request has expired. Compare the twelve "
                + "words again to re-confirm it.")
    case .absent:
        throw SptRefused(
            reason: refuseConfirmationMissing,
            message: "this receive request has not been confirmed on this device. Review it and "
                + "compare the twelve words first.")
    case .unusable(let message):
        throw SptRefused(reason: refuseConfirmationMissing,
                         message: "\(message) Review the request again.")
    }
}
