import Crypto
import TruePadCore

/* ============================================================================
 * The one-handoff record.
 *
 * A pad may leave this installation ONCE, by ONE route. MARKER-LAST:
 *
 *   stage package.tps2 -> read back -> stage confirm.bin -> read back
 *     -> write handoff.json (THE COMMIT POINT)
 *
 * EXISTENCE IS LOAD-BEARING: a handoff.json that is empty, torn, invalid, or
 * merely unreadable is `unreadableSpent`, NEVER "no handoff". It is never
 * auto-deleted and never repaired, because the one thing a torn marker can mean
 * is that a copy already left.
 *
 *   <pairId>/handoff.json            the permanent commit marker
 *   <pairId>/handoff/package.tps2    the exact TPS2 bytes   (sealed only)
 *   <pairId>/handoff/confirm.bin     the exact 11 bytes     (sealed only)
 *
 * LOSS IS ACCEPTABLE. REUSE IS NOT.
 *
 * THE MARKER FILE IS SHARED WITH THE STORE LAYER. TruePadStorage reads the same
 * `<pairId>/handoff.json` to answer "may this pad be exported?" and to derive
 * sealed ancestry; both must agree on the format, and they are held to the same
 * key sets and the same "torn is spent" rule.
 * ========================================================================= */

public let handoffMarkerFileName = "handoff.json"
public let handoffDir = "handoff"
public let handoffPackageFile = "package.tps2"
public let handoffConfirmFile = "confirm.bin"

private let handoffHashBytes = 32

public let refuseHandoffUnreadable = "handoff-state-unreadable"
public let refuseAlreadySealed = "pad-already-sealed"
public let refuseAlreadyHandedOff = "pad-already-handed-off"
public let refuseUnrecoverable = "handoff-unrecoverable"

public let handoffUnreadableAdvice =
    "TruePad cannot safely determine this pad's handoff state, so it refuses to create another "
    + "copy. A record of a handoff exists but cannot be read. Generate a new pad for any further "
    + "transfer."

public func markerPath(_ pairId: String) -> String { "\(pairId)/\(handoffMarkerFileName)" }
public func handoffPackagePath(_ pairId: String) -> String { "\(pairId)/\(handoffDir)/\(handoffPackageFile)" }
public func handoffConfirmPath(_ pairId: String) -> String { "\(pairId)/\(handoffDir)/\(handoffConfirmFile)" }

public enum HandoffMarker: Sendable, Equatable {
    case physical(pairId: String, at: String)
    case sealed(pairId: String, at: String, requestHash: String,
                packageIdentity: String, confirmHash: String)

    public var pairId: String {
        switch self {
        case .physical(let id, _): return id
        case .sealed(let id, _, _, _, _): return id
        }
    }

    public var at: String {
        switch self {
        case .physical(_, let a): return a
        case .sealed(_, let a, _, _, _): return a
        }
    }
}

public enum SptHandoffState: Sendable {
    case absent
    case physical(marker: HandoffMarker)
    case sealed(marker: HandoffMarker, packageAvailable: Bool, confirmationAvailable: Bool)
    /// Present and untrustworthy. NOT absence.
    case unreadableSpent(message: String)
}

private let physicalKeys = ["version", "pairId", "mode", "at"]
private let sealedKeys = ["version", "pairId", "mode", "at",
                          "requestHash", "packageIdentity", "confirmHash"]

private func sha256(_ bytes: [UInt8]) -> [UInt8] { Array(SHA256.hash(data: bytes)) }

private func serializeMarker(_ marker: HandoffMarker) -> [UInt8] {
    switch marker {
    case .physical(let pairId, let at):
        return serializeRecord([
            ("version", .int(sptRecordVersion)),
            ("pairId", .string(pairId)),
            ("mode", .string("physical")),
            ("at", .string(at)),
        ])
    case .sealed(let pairId, let at, let requestHash, let packageIdentity, let confirmHash):
        return serializeRecord([
            ("version", .int(sptRecordVersion)),
            ("pairId", .string(pairId)),
            ("mode", .string("sealed")),
            ("at", .string(at)),
            ("requestHash", .string(requestHash)),
            ("packageIdentity", .string(packageIdentity)),
            ("confirmHash", .string(confirmHash)),
        ])
    }
}

/// Strict parse; EVERY failure throws.
///
/// Catches both a physical marker wearing sealed fields and a sealed marker
/// missing one — the exact-key-set check is what makes that impossible to fake.
public func parseMarker(_ bytes: [UInt8], pairId: String) throws -> HandoffMarker {
    if bytes.isEmpty { throw SptRejected(why: "the handoff marker is empty") }
    guard let text = String(bytes: bytes, encoding: .utf8),
          let parsed = try? parseStrictJson(text) else {
        throw SptRejected(why: "the handoff marker does not parse as JSON")
    }
    guard let members = parsed.memberMap, let keys = parsed.memberKeys else {
        throw SptRejected(why: "the handoff marker is not a JSON object")
    }
    guard case .number(let raw)? = members["version"], Int(raw) == sptRecordVersion else {
        throw SptRejected(why: "unsupported handoff marker version")
    }
    let markerPairId = try recordString(members, "pairId")
    guard isSptHex32(markerPairId) else {
        throw SptRejected(why: "the handoff marker has no valid pairId")
    }
    guard markerPairId == pairId else {
        throw SptRejected(why: "the handoff marker names a different pair")
    }
    let mode = try recordString(members, "mode")
    guard mode == "physical" || mode == "sealed" else {
        throw SptRejected(why: "the handoff marker has an unsupported mode")
    }
    let at = try recordString(members, "at")
    guard SptTime.isCanonicalIso(at) else {
        throw SptRejected(why: "at is not a canonical ISO-8601 timestamp")
    }
    let wanted = (mode == "sealed" ? sealedKeys : physicalKeys).sorted()
    guard keys.sorted() == wanted else {
        throw SptRejected(why: "the handoff marker's fields do not match mode \(mode)")
    }
    if mode == "physical" { return .physical(pairId: pairId, at: at) }

    let requestHash = try recordString(members, "requestHash")
    _ = try decodeExact(requestHash, length: handoffHashBytes, field: "requestHash")
    let packageIdentity = try recordString(members, "packageIdentity")
    _ = try decodeExact(packageIdentity, length: handoffHashBytes, field: "packageIdentity")
    let confirmHash = try recordString(members, "confirmHash")
    _ = try decodeExact(confirmHash, length: handoffHashBytes, field: "confirmHash")
    return .sealed(pairId: pairId, at: at, requestHash: requestHash,
                   packageIdentity: packageIdentity, confirmHash: confirmHash)
}

/// The pad's handoff state. There is NO path from a present-but-bad marker to
/// `absent`.
public func sptReadHandoffState(vfs: SptVfs, pairId: String) -> SptHandoffState {
    let bytes: [UInt8]?
    do { bytes = try vfs.readFile(markerPath(pairId)) } catch {
        return .unreadableSpent(message: "\(handoffUnreadableAdvice) (\(error))")
    }
    guard let bytes else { return .absent }
    let marker: HandoffMarker
    do {
        marker = try parseMarker(bytes, pairId: pairId)
    } catch let e as SptRejected {
        return .unreadableSpent(message: "\(handoffUnreadableAdvice) (\(e.why))")
    } catch {
        return .unreadableSpent(message: "\(handoffUnreadableAdvice) (\(error))")
    }
    if case .physical = marker { return .physical(marker: marker) }
    return .sealed(marker: marker,
                   packageAvailable: vfs.exists(handoffPackagePath(pairId)),
                   confirmationAvailable: vfs.exists(handoffConfirmPath(pairId)))
}

/// The refusal a caller that must not create another copy should raise, or nil.
public func refusalForNewHandoff(_ state: SptHandoffState) -> SptRefused? {
    switch state {
    case .absent:
        return nil
    case .physical:
        return SptRefused(
            reason: refuseAlreadyHandedOff,
            message: "This pad has already been handed off by the physical route, so it cannot "
                + "also be sent by sealed transfer. Generate a new pad for that.")
    case .sealed:
        return SptRefused(
            reason: refuseAlreadySealed,
            message: "This pad has already been sent by sealed transfer, so it cannot be handed "
                + "off again. Generate a new pad for any further transfer.")
    case .unreadableSpent(let message):
        return SptRefused(reason: refuseHandoffUnreadable, message: message)
    }
}

/// Remove staged payload files — safe ONLY when no marker exists, because with a
/// marker present those files are not orphans.
public func cleanPreCommitStaging(vfs: SptVfs, pairId: String) throws {
    let state = sptReadHandoffState(vfs: vfs, pairId: pairId)
    switch state {
    case .absent:
        break
    case .unreadableSpent(let message):
        throw SptRefused(reason: refuseHandoffUnreadable, message: message)
    default:
        throw SptRefused(
            reason: refuseAlreadySealed,
            message: "This pad's handoff is already committed; its staged files are not orphans "
                + "and are not removed.")
    }
    try? vfs.remove(handoffPackagePath(pairId))
    try? vfs.remove(handoffConfirmPath(pairId))
}

/// Write the marker and RE-READ it. A write that throws may still have landed, and
/// a landed marker means the pad is spent — so this never reports "nothing
/// happened" unless nothing is there.
private func writeAndVerifyMarker(vfs: SptVfs, pairId: String,
                                  marker: HandoffMarker) throws -> HandoffMarker {
    do {
        try vfs.writeFileAtomic(markerPath(pairId), serializeMarker(marker))
    } catch {
        let landed: Bool
        do { landed = (try vfs.readFile(markerPath(pairId))) != nil } catch { landed = true }
        if !landed { throw error }   // nothing committed — the pad is still free
        throw SptRefused(
            reason: refuseHandoffUnreadable,
            message: "\(handoffUnreadableAdvice) (writing the handoff record failed after it had "
                + "begun: \(error))")
    }
    guard let readBack = try vfs.readFile(markerPath(pairId)) else {
        throw SptRefused(reason: refuseHandoffUnreadable,
                         message: "\(handoffUnreadableAdvice) (the handoff record did not survive "
                             + "being written)")
    }
    do {
        return try parseMarker(readBack, pairId: pairId)
    } catch {
        throw SptRefused(reason: refuseHandoffUnreadable,
                         message: "\(handoffUnreadableAdvice) (the handoff record read back "
                             + "invalid: \(error))")
    }
}

/// Record a PHYSICAL handoff. The caller holds the pad lock and has checked
/// provenance.
@discardableResult
public func sptCommitPhysicalHandoff(vfs: SptVfs, pairId: String,
                                     at: String) throws -> HandoffMarker {
    let verified = try writeAndVerifyMarker(vfs: vfs, pairId: pairId,
                                            marker: .physical(pairId: pairId, at: at))
    guard case .physical = verified else {
        throw SptRefused(reason: refuseHandoffUnreadable,
                         message: "\(handoffUnreadableAdvice) (the record read back with the wrong mode)")
    }
    return verified
}

public struct SealedHandoffInput: Sendable {
    public let packageBytes: [UInt8]
    public let requestHash: [UInt8]
    public let confirmValue: [UInt8]
    public let packageIdentity: [UInt8]

    public init(packageBytes: [UInt8], requestHash: [UInt8],
                confirmValue: [UInt8], packageIdentity: [UInt8]) {
        self.packageBytes = packageBytes
        self.requestHash = requestHash
        self.confirmValue = confirmValue
        self.packageIdentity = packageIdentity
    }
}

/// The marker-last sealed transaction.
///
/// STORAGE ONLY: it persists bytes the caller has already produced, under the
/// one-handoff rule. It refuses if any handoff exists, and REQUIRES that the
/// request is already bound to THIS pair. The caller holds the pad lock.
@discardableResult
public func commitSealedHandoff(vfs: SptVfs, pairId: String,
                                input: SealedHandoffInput, at: String) throws -> HandoffMarker {
    guard input.confirmValue.count == SptConstants.confirmValueBytes else {
        throw SptRefused(reason: "bad-request",
                         message: "confirmValue must be exactly \(SptConstants.confirmValueBytes) bytes")
    }
    guard input.requestHash.count == handoffHashBytes,
          input.packageIdentity.count == handoffHashBytes else {
        throw SptRefused(reason: "bad-request",
                         message: "requestHash and packageIdentity must be \(handoffHashBytes) bytes")
    }
    // 1a — the PAD's handoff must not already exist, in ANY state. Checked first.
    if let refusal = refusalForNewHandoff(sptReadHandoffState(vfs: vfs, pairId: pairId)) {
        throw refusal
    }
    // 1b — the REQUEST must already be bound to THIS pair.
    _ = try requireClaimedByPair(vfs: vfs, requestHash: input.requestHash, pairId: pairId)
    // 2 — with no marker present, any staged files are PROVABLY pre-commit.
    try? vfs.remove(handoffPackagePath(pairId))
    try? vfs.remove(handoffConfirmPath(pairId))
    // 3, 4 — stage the package, read it back byte for byte.
    try vfs.writeFileAtomic(handoffPackagePath(pairId), input.packageBytes)
    guard let storedPackage = try vfs.readFile(handoffPackagePath(pairId)),
          SptBytes.equal(storedPackage, input.packageBytes) else {
        throw SptRefused(reason: "storage-failed",
                         message: "the sealed package did not store intact; nothing was committed.")
    }
    // 5 — the SUPPLIED identity must be the identity of what is actually on disk.
    let identity = SealedPackageCodec.packageIdentity(storedPackage)
    guard SptBytes.equal(identity, input.packageIdentity) else {
        throw SptRefused(reason: "storage-failed",
                         message: "the stored package does not match its supplied identity.")
    }
    // 6, 7 — stage the confirmation value, read it back.
    try vfs.writeFileAtomic(handoffConfirmPath(pairId), input.confirmValue)
    guard let storedConfirm = try vfs.readFile(handoffConfirmPath(pairId)),
          SptBytes.equal(storedConfirm, input.confirmValue) else {
        throw SptRefused(reason: "storage-failed",
                         message: "the confirmation value did not store intact; nothing was committed.")
    }
    // 8-10 — the marker LAST. This is the commit point.
    let marker = HandoffMarker.sealed(
        pairId: pairId, at: at,
        requestHash: SptBytes.toBase64Url(input.requestHash),
        packageIdentity: SptBytes.toBase64Url(identity),
        confirmHash: SptBytes.toBase64Url(sha256(storedConfirm)))
    let verified = try writeAndVerifyMarker(vfs: vfs, pairId: pairId, marker: marker)
    guard case .sealed(_, _, let vRequest, let vIdentity, let vConfirm) = verified,
          case .sealed(_, _, let mRequest, let mIdentity, let mConfirm) = marker,
          vRequest == mRequest, vIdentity == mIdentity, vConfirm == mConfirm else {
        throw SptRefused(reason: refuseHandoffUnreadable,
                         message: "\(handoffUnreadableAdvice) (the record read back with different "
                             + "contents)")
    }
    return verified
}

public struct CommittedSealedHandoff: Sendable {
    public let marker: HandoffMarker
    public let packageBytes: [UInt8]
    public let confirmValue: [UInt8]
}

/// Re-read a committed sealed handoff and VERIFY both payloads against the
/// marker.
///
/// This is how a retry returns the EXACT original package instead of
/// re-encapsulating — re-encapsulating would produce a second package with a
/// different confirmation code for the same request, which is precisely what the
/// one-request claim exists to prevent.
public func loadCommittedSealedHandoff(vfs: SptVfs, pairId: String) throws -> CommittedSealedHandoff {
    let state = sptReadHandoffState(vfs: vfs, pairId: pairId)
    guard case .sealed(let marker, _, _) = state else {
        throw refusalForNewHandoff(state)
            ?? SptRefused(reason: refuseUnrecoverable,
                          message: "this pad has no committed sealed handoff.")
    }
    guard case .sealed(_, _, _, let markerIdentity, let markerConfirmHash) = marker else {
        throw SptRefused(reason: refuseUnrecoverable, message: "this pad has no committed sealed handoff.")
    }
    let packageBytes = try vfs.readFile(handoffPackagePath(pairId))
    let confirmValue = try vfs.readFile(handoffConfirmPath(pairId))
    guard let packageBytes, let confirmValue else {
        throw SptRefused(
            reason: refuseUnrecoverable,
            message: "This pad's handoff is committed, but the sealed package is no longer stored, "
                + "so it cannot be produced again. The pad stays handed off; generate a new pad for "
                + "any further transfer.")
    }
    guard SptBytes.toBase64Url(SealedPackageCodec.packageIdentity(packageBytes)) == markerIdentity else {
        throw SptRefused(
            reason: refuseUnrecoverable,
            message: "This pad's stored sealed package does not match the committed record, so it "
                + "cannot be produced again. The pad stays handed off; generate a new pad for any "
                + "further transfer.")
    }
    guard confirmValue.count == SptConstants.confirmValueBytes,
          SptBytes.toBase64Url(sha256(confirmValue)) == markerConfirmHash else {
        throw SptRefused(
            reason: refuseUnrecoverable,
            message: "This pad's stored confirmation value does not match the committed record. The "
                + "pad stays handed off; generate a new pad for any further transfer.")
    }
    return CommittedSealedHandoff(marker: marker, packageBytes: packageBytes,
                                  confirmValue: confirmValue)
}

/// Drop the sealed payload while KEEPING the marker.
///
/// The pad stays permanently handed off. handoff.json is NOT removed — not here,
/// not anywhere.
public func dismissSealedPayload(vfs: SptVfs, pairId: String) throws {
    let state = sptReadHandoffState(vfs: vfs, pairId: pairId)
    if case .unreadableSpent(let message) = state {
        throw SptRefused(reason: refuseHandoffUnreadable, message: message)
    }
    guard case .sealed = state else {
        throw SptRefused(reason: refuseUnrecoverable,
                         message: "this pad has no committed sealed handoff to dismiss.")
    }
    try? vfs.remove(handoffPackagePath(pairId))
    try? vfs.remove(handoffConfirmPath(pairId))
}
