package dev.systemslibrarian.truepad.spt

import dev.systemslibrarian.truepad.core.bytesToHex
import java.time.Instant

/* ============================================================================
 * Receiver request state — the Kotlin twin of src/browser/engine/spt-receiver-state.ts.
 *
 * The recipient holds a ONE-TIME X-Wing decapsulation seed. Its value is that it
 * decapsulates once:  create -> PENDING -> CANCELLED | CONSUMED, never PENDING
 * again. The representation is immutable creation plus existence-based terminal
 * markers — nothing is ever rewritten:
 *
 *   spt/receive/<idHex>/request.json    creation + publication marker (written LAST)
 *   spt/receive/<idHex>/dk.bin          the 32-byte X-Wing seed (written FIRST)
 *   spt/receive/<idHex>/cancelled.json  terminal, by existence
 *   spt/receive/<idHex>/consumed.json   terminal, by existence
 *
 *   EXISTENCE IS LOAD-BEARING.  LOSS IS ACCEPTABLE.  REUSE IS NOT.
 * ========================================================================= */

const val RECEIVE_ROOT = "spt/receive"
const val REQUEST_FILE = "request.json"
const val DK_FILE = "dk.bin"
const val CANCELLED_FILE = "cancelled.json"
const val CONSUMED_FILE = "consumed.json"

private const val HASH_BYTES = 32

const val REFUSE_RECEIVE_STATE = "receive-request-state"
const val REFUSE_ID_UNAVAILABLE = "request-id-unavailable"

fun receiveDir(idHex: String) = "$RECEIVE_ROOT/$idHex"
fun requestPath(idHex: String) = "${receiveDir(idHex)}/$REQUEST_FILE"
fun dkPath(idHex: String) = "${receiveDir(idHex)}/$DK_FILE"
fun cancelledPath(idHex: String) = "${receiveDir(idHex)}/$CANCELLED_FILE"
fun consumedPath(idHex: String) = "${receiveDir(idHex)}/$CONSUMED_FILE"

enum class CancelReason(val wire: String) {
    OPERATOR("operator"), EXPIRED("expired"), REJECTED("rejected");

    companion object {
        fun fromWire(s: String): CancelReason? = entries.firstOrNull { it.wire == s }
    }
}

sealed class ReceiverState {
    object Absent : ReceiverState()
    class Pending(
        val requestId: String, val requestHash: ByteArray, val body: ByteArray,
        val createdAt: String, val expiresAt: String,
        /** A COPY. Only a valid, unexpired PENDING carries one. */
        val dk: ByteArray,
    ) : ReceiverState()
    class ExpiredPending(
        val requestId: String, val requestHash: ByteArray, val body: ByteArray,
        val createdAt: String, val expiresAt: String,
    ) : ReceiverState()
    class Cancelled(val requestId: String, val reason: CancelReason, val at: String) : ReceiverState()
    class Consumed(val requestId: String, val pairId: String, val packageIdentity: ByteArray, val at: String) : ReceiverState()
    class Unusable(val message: String) : ReceiverState()
    class TerminalUnreadable(val message: String) : ReceiverState()
    class TerminalInconsistent(val message: String) : ReceiverState()
}

const val TERMINAL_ADVICE =
    "TruePad cannot safely determine whether this receive request was already used, so it will not use its " +
        "one-time key again. Ask for a new receive request."

class StoredRequest(
    val requestId: String, val requestHash: ByteArray, val body: ByteArray,
    val createdAt: String, val expiresAt: String,
)

private val REQUEST_KEYS = listOf("version", "requestId", "requestHash", "body", "createdAt", "expiresAt")
private val CANCELLED_KEYS = listOf("version", "requestId", "at", "reason")
private val CONSUMED_KEYS = listOf("version", "requestId", "at", "pairId", "packageIdentity")

private fun requireIso(value: String, field: String): String {
    if (!SptTime.isCanonicalIso(value)) throw IllegalArgumentException("$field is not a canonical ISO-8601 timestamp")
    return value
}

/** Strict parse AND full re-derivation: the body must be a canonical TPR2 body,
 *  its embedded requestId must equal the path, and the stored requestHash must be
 *  the hash of that body. A record moved between directories is rejected. */
fun parseStoredRequest(bytes: ByteArray, idHex: String): StoredRequest {
    val obj = parseRecord(bytes, REQUEST_FILE, REQUEST_KEYS)
    val requestId = obj.str("requestId")
    if (!isHex32(requestId)) throw IllegalArgumentException("requestId is not 32 lowercase hex characters")
    if (requestId != idHex) throw IllegalArgumentException("the record names a different request")
    val requestHash = decodeExact(obj.str("requestHash"), HASH_BYTES, "requestHash")
    val body = decodeExact(obj.str("body"), TPR2_BODY_BYTES, "body")
    val createdAt = requireIso(obj.str("createdAt"), "createdAt")
    val expiresAt = requireIso(obj.str("expiresAt"), "expiresAt")
    if (SptTime.parseMillis(expiresAt) <= SptTime.parseMillis(createdAt)) {
        throw IllegalArgumentException("expiresAt is not after createdAt")
    }
    val parsedBody = parseRequestBody(body)
    if (parsedBody !is RequestBodyParse.Ok) throw IllegalArgumentException("the stored body is not a canonical request")
    if (bytesToHex(parsedBody.request.requestId) != idHex) throw IllegalArgumentException("the stored body names a different request")
    if (!bytesEqual(requestFingerprint(body), requestHash)) {
        throw IllegalArgumentException("the stored requestHash is not the hash of the stored body")
    }
    return StoredRequest(idHex, requestHash, body, createdAt, expiresAt)
}

class CancelledMarker(val requestId: String, val at: String, val reason: CancelReason)
class ConsumedMarker(val requestId: String, val at: String, val pairId: String, val packageIdentity: ByteArray)

fun parseCancelled(bytes: ByteArray, idHex: String): CancelledMarker {
    val obj = parseRecord(bytes, CANCELLED_FILE, CANCELLED_KEYS)
    val requestId = obj.str("requestId")
    if (requestId != idHex || !isHex32(requestId)) throw IllegalArgumentException("the marker names a different request")
    val at = requireIso(obj.str("at"), "at")
    val reason = CancelReason.fromWire(obj.str("reason")) ?: throw IllegalArgumentException("unrecognised cancellation reason")
    return CancelledMarker(idHex, at, reason)
}

fun parseConsumed(bytes: ByteArray, idHex: String): ConsumedMarker {
    val obj = parseRecord(bytes, CONSUMED_FILE, CONSUMED_KEYS)
    val requestId = obj.str("requestId")
    if (requestId != idHex || !isHex32(requestId)) throw IllegalArgumentException("the marker names a different request")
    val at = requireIso(obj.str("at"), "at")
    val pairId = obj.str("pairId")
    if (!isHex32(pairId)) throw IllegalArgumentException("bad pairId")
    val packageIdentity = decodeExact(obj.str("packageIdentity"), HASH_BYTES, "packageIdentity")
    return ConsumedMarker(idHex, at, pairId, packageIdentity)
}

/** Does ANYTHING live under this requestId? A requestId whose namespace ever held
 *  anything is unavailable forever, never cleaned up for reuse. */
fun namespaceOccupied(vfs: SptVfs, idHex: String): Boolean = vfs.list(receiveDir(idHex)).isNotEmpty()

/** Did this pad arrive by SEALED ONLINE DELIVERY? Scans the durable consumed.json
 *  markers for a matching pairId, so the deployment evaluator can DERIVE
 *  "computational delivery" from a fact that already persists. Fails safe: an
 *  unreadable/unparseable marker is skipped (never reported sealed). */
fun pairArrivedSealed(vfs: SptVfs, pairId: String): Boolean {
    val dirs = try {
        vfs.list(RECEIVE_ROOT)
    } catch (_: Exception) {
        return false
    }
    for (idHex in dirs) {
        if (!isHex32(idHex)) continue
        val bytes = try {
            vfs.readFile(consumedPath(idHex))
        } catch (_: Exception) {
            continue
        } ?: continue
        try {
            if (parseConsumed(bytes, idHex).pairId == pairId) return true
        } catch (_: Exception) {
            // torn/unparseable terminal marker is not a confirmation of sealed delivery
        }
    }
    return false
}

private fun terminalUnreadable(detail: String) = ReceiverState.TerminalUnreadable("$TERMINAL_ADVICE ($detail)")

/** The receiver's durable state. Terminal markers are examined BEFORE any private
 *  key is looked at, and a terminal marker beats a still-present dk.bin. `now` is
 *  required, not defaulted — expiry decides whether a one-time key is handed out. */
fun readReceiverState(vfs: SptVfs, idHex: String, now: Instant): ReceiverState {
    if (!isHex32(idHex)) return ReceiverState.Unusable("a requestId is exactly 32 lowercase hex characters")

    val hasCancelled: Boolean
    val hasConsumed: Boolean
    try {
        hasCancelled = vfs.exists(cancelledPath(idHex))
        hasConsumed = vfs.exists(consumedPath(idHex))
    } catch (e: Exception) {
        return terminalUnreadable(e.message ?: "cannot read terminal markers")
    }

    if (hasCancelled && hasConsumed) {
        return ReceiverState.TerminalInconsistent("$TERMINAL_ADVICE (this request carries both a cancellation and a consumption record)")
    }
    if (hasCancelled) {
        return try {
            val bytes = vfs.readFile(cancelledPath(idHex)) ?: return terminalUnreadable("the cancellation record vanished while being read")
            val m = parseCancelled(bytes, idHex)
            ReceiverState.Cancelled(idHex, m.reason, m.at)
        } catch (e: Exception) {
            terminalUnreadable(e.message ?: "unreadable cancellation record")
        }
    }
    if (hasConsumed) {
        return try {
            val bytes = vfs.readFile(consumedPath(idHex)) ?: return terminalUnreadable("the consumption record vanished while being read")
            val m = parseConsumed(bytes, idHex)
            ReceiverState.Consumed(idHex, m.pairId, m.packageIdentity, m.at)
        } catch (e: Exception) {
            terminalUnreadable(e.message ?: "unreadable consumption record")
        }
    }

    val requestBytes = try {
        vfs.readFile(requestPath(idHex))
    } catch (e: Exception) {
        return ReceiverState.Unusable("this receive request cannot be read (${e.message})")
    }
    if (requestBytes == null) {
        val occupied = try {
            namespaceOccupied(vfs, idHex)
        } catch (_: Exception) {
            true
        }
        return if (occupied) ReceiverState.Unusable("this receive request was never completed and cannot be used") else ReceiverState.Absent
    }

    val stored = try {
        parseStoredRequest(requestBytes, idHex)
    } catch (e: Exception) {
        return ReceiverState.Unusable("this receive request is not usable (${e.message})")
    }

    val dk = try {
        vfs.readFile(dkPath(idHex))
    } catch (e: Exception) {
        return ReceiverState.Unusable("this receive request's key cannot be read (${e.message})")
    }
    if (dk == null || dk.size != XWING_SEED_BYTES) {
        return ReceiverState.Unusable("this receive request's key is missing or the wrong size")
    }

    val expired = now.toEpochMilli() >= SptTime.parseMillis(stored.expiresAt)
    if (expired) {
        return ReceiverState.ExpiredPending(stored.requestId, stored.requestHash, stored.body, stored.createdAt, stored.expiresAt)
    }
    return ReceiverState.Pending(stored.requestId, stored.requestHash, stored.body, stored.createdAt, stored.expiresAt, dk.copyOf())
}

class PendingRequestInput(
    val body: ByteArray, val requestId: ByteArray, val requestHash: ByteArray,
    val dk: ByteArray, val createdAt: String, val expiresAt: String,
)

private fun refuse(message: String): Nothing = throw SptRefused(REFUSE_RECEIVE_STATE, message)

private fun refuseUnlessIso(value: String, field: String): String {
    if (!SptTime.isCanonicalIso(value)) refuse("$field is not a canonical ISO-8601 timestamp")
    return value
}

/** Create a PENDING receive request, request.json LAST (the commit marker). Every
 *  relationship is re-verified from what came back off the disk. */
fun commitPendingReceiveRequest(vfs: SptVfs, input: PendingRequestInput): StoredRequest {
    if (input.requestId.size != REQUEST_ID_BYTES) refuse("requestId must be $REQUEST_ID_BYTES bytes")
    val idHex = bytesToHex(input.requestId)
    if (!isHex32(idHex)) refuse("requestId must render as 32 lowercase hex characters")
    if (input.dk.size != XWING_SEED_BYTES) refuse("the decapsulation seed must be exactly $XWING_SEED_BYTES bytes")
    if (input.requestHash.size != HASH_BYTES) refuse("requestHash must be $HASH_BYTES bytes")

    val parsedBody = parseRequestBody(input.body)
    if (parsedBody !is RequestBodyParse.Ok) refuse("the request body is not canonical")
    if (!bytesEqual(parsedBody.request.requestId, input.requestId)) refuse("the request body names a different requestId")
    if (!bytesEqual(requestFingerprint(input.body), input.requestHash)) refuse("the supplied requestHash is not the hash of the supplied body")
    refuseUnlessIso(input.createdAt, "createdAt")
    refuseUnlessIso(input.expiresAt, "expiresAt")
    if (SptTime.parseMillis(input.expiresAt) - SptTime.parseMillis(input.createdAt) != SptTime.REQUEST_TTL_MS) {
        refuse("expiresAt must be exactly seven days after createdAt")
    }

    if (namespaceOccupied(vfs, idHex)) {
        throw SptRefused(
            REFUSE_ID_UNAVAILABLE,
            "This request identifier has already been used. Identifiers are never reused, even when the earlier " +
                "attempt left nothing usable behind. Generate another.",
        )
    }

    // The key first, verified.
    vfs.writeFileAtomic(dkPath(idHex), input.dk)
    val storedDk = vfs.readFile(dkPath(idHex))
    if (storedDk == null || storedDk.size != XWING_SEED_BYTES || !bytesEqual(storedDk, input.dk)) {
        refuse("the decapsulation key did not store intact; nothing was published.")
    }

    // request.json LAST — the commit point.
    val record = serializeRecord(
        "version" to SPT_RECORD_VERSION,
        "requestId" to idHex,
        "requestHash" to toBase64Url(input.requestHash),
        "body" to toBase64Url(input.body),
        "createdAt" to input.createdAt,
        "expiresAt" to input.expiresAt,
    )
    vfs.writeFileAtomic(requestPath(idHex), record)

    val readBack = vfs.readFile(requestPath(idHex)) ?: refuse("the receive request did not survive being written; nothing was published.")
    val verified = try {
        parseStoredRequest(readBack, idHex)
    } catch (e: Exception) {
        refuse("the receive request read back invalid (${e.message}); nothing was published.")
    }
    if (!bytesEqual(verified.body, input.body) || !bytesEqual(verified.requestHash, input.requestHash)) {
        refuse("the receive request read back with different contents; nothing was published.")
    }
    return verified
}

/** Establish durable terminal state, then report what the disk actually says. A
 *  write that throws proves nothing; re-read to decide. */
private fun writeTerminal(vfs: SptVfs, path: String, bytes: ByteArray, idHex: String, now: Instant): ReceiverState {
    try {
        vfs.writeFileAtomic(path, bytes)
    } catch (e: Exception) {
        val after = readReceiverState(vfs, idHex, now)
        if (after is ReceiverState.Pending || after is ReceiverState.ExpiredPending || after is ReceiverState.Absent) {
            throw SptRefused(REFUSE_RECEIVE_STATE, "the request was not changed (${e.message}); it has not been cancelled or consumed.")
        }
        return after
    }
    return readReceiverState(vfs, idHex, now)
}

/** PENDING -> CANCELLED. One terminal writer, three reasons. */
fun cancelPendingReceiveRequest(vfs: SptVfs, idHex: String, reason: CancelReason, at: String, now: Instant): ReceiverState {
    refuseUnlessIso(at, "at")
    when (val state = readReceiverState(vfs, idHex, now)) {
        is ReceiverState.Cancelled -> return state // idempotent; first reason stands
        is ReceiverState.Pending -> {}
        is ReceiverState.ExpiredPending -> if (reason != CancelReason.EXPIRED) {
            refuse("an expired receive request is terminalized as expired, not by any other reason.")
        }
        is ReceiverState.Consumed -> refuse("this receive request was already used to receive a pad; it cannot be cancelled.")
        is ReceiverState.Absent -> refuse("there is no such receive request.")
        is ReceiverState.Unusable -> throw SptRefused(REFUSE_RECEIVE_STATE, state.message)
        is ReceiverState.TerminalUnreadable -> throw SptRefused(REFUSE_RECEIVE_STATE, state.message)
        is ReceiverState.TerminalInconsistent -> throw SptRefused(REFUSE_RECEIVE_STATE, state.message)
    }
    val bytes = serializeRecord("version" to SPT_RECORD_VERSION, "requestId" to idHex, "at" to at, "reason" to reason.wire)
    return writeTerminal(vfs, cancelledPath(idHex), bytes, idHex, now)
}

fun expirePendingReceiveRequest(vfs: SptVfs, idHex: String, at: String, now: Instant): ReceiverState =
    cancelPendingReceiveRequest(vfs, idHex, CancelReason.EXPIRED, at, now)

class ConsumeInput(val pairId: String, val packageIdentity: ByteArray, val at: String)

/** PENDING -> CONSUMED, the CONSUME-BEFORE-IMPORT commit boundary. Must be called
 *  BEFORE the pair import commits; if the import then fails the transfer is LOST
 *  and the request is never reopened. */
fun consumePendingReceiveRequest(vfs: SptVfs, idHex: String, input: ConsumeInput, now: Instant): ReceiverState {
    refuseUnlessIso(input.at, "at")
    if (!isHex32(input.pairId)) refuse("pairId must be 32 lowercase hex characters")
    if (input.packageIdentity.size != HASH_BYTES) refuse("packageIdentity must be $HASH_BYTES bytes")

    when (val state = readReceiverState(vfs, idHex, now)) {
        is ReceiverState.Pending -> {}
        is ReceiverState.ExpiredPending -> refuse("this receive request has expired and cannot receive a pad.")
        is ReceiverState.Cancelled -> refuse("this receive request was cancelled and cannot receive a pad.")
        is ReceiverState.Consumed -> refuse("this receive request has already received a pad.")
        is ReceiverState.Absent -> refuse("there is no such receive request.")
        is ReceiverState.Unusable -> throw SptRefused(REFUSE_RECEIVE_STATE, state.message)
        is ReceiverState.TerminalUnreadable -> throw SptRefused(REFUSE_RECEIVE_STATE, state.message)
        is ReceiverState.TerminalInconsistent -> throw SptRefused(REFUSE_RECEIVE_STATE, state.message)
    }
    val bytes = serializeRecord(
        "version" to SPT_RECORD_VERSION,
        "requestId" to idHex,
        "at" to input.at,
        "pairId" to input.pairId,
        "packageIdentity" to toBase64Url(input.packageIdentity),
    )
    return writeTerminal(vfs, consumedPath(idHex), bytes, idHex, now)
}

/** Best-effort removal of the stored key after a request is durably terminal. The
 *  terminal marker is the authority; a failure here does not change the state. */
fun bestEffortDropKey(vfs: SptVfs, idHex: String) {
    try {
        val size = vfs.size(dkPath(idHex))
        if (size != null && size > 0) vfs.writeRange(dkPath(idHex), 0, ByteArray(size.toInt()))
    } catch (_: Exception) {
    }
    try {
        vfs.remove(dkPath(idHex))
    } catch (_: Exception) {
    }
}
