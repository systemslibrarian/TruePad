package dev.systemslibrarian.truepad.spt

import dev.systemslibrarian.truepad.core.bytesToHex
import java.time.Instant

/* ============================================================================
 * The sender's CONFIRMED declaration (Kotlin twin of src/browser/engine/
 * spt-confirmed.ts). spt/confirmed/<requestHashHex>.json means exactly: the UI
 * reported the operator said all twelve request words matched — a DECLARATION,
 * not proof. Unlike the claim/handoff it is REPLACEABLE (records only that a
 * human looked); a fresh review of the SAME body may replace it, and it never
 * touches the claim or the handoff (those prevent a second package).
 * ========================================================================= */

const val CONFIRMED_DIR = "spt/confirmed"

const val REFUSE_CONFIRMATION_MISSING = "spt-confirmation-missing"
const val REFUSE_CONFIRMATION_EXPIRED = "spt-confirmation-expired"

fun confirmedPath(requestHashHex: String) = "$CONFIRMED_DIR/$requestHashHex.json"

private val CONFIRMED_KEYS = listOf("version", "requestHash", "body", "confirmedAt", "expiresAt")
private val HEX_64_RE = Regex("^[0-9a-f]{64}$")
private fun isHex64(s: String) = HEX_64_RE.matches(s)
private const val CONFIRMED_HASH_BYTES = 32

class ConfirmedRecord(
    val requestHash: ByteArray,
    /** The exact canonical 1235-byte body the operator reviewed. */
    val body: ByteArray,
    val confirmedAt: String,
    val expiresAt: String,
)

sealed class ConfirmationState {
    object Absent : ConfirmationState()
    class Confirmed(val record: ConfirmedRecord) : ConfirmationState()
    class Expired(val record: ConfirmedRecord) : ConfirmationState()
    class Unusable(val message: String) : ConfirmationState()
}

/** Strict parse AND full re-derivation: the body must parse as a canonical §5.1
 *  request and hash to the requestHash this record is filed under. */
fun parseConfirmed(bytes: ByteArray, requestHashHex: String): ConfirmedRecord {
    val obj = parseRecord(bytes, "confirmation record", CONFIRMED_KEYS)
    val requestHash = decodeExact(obj.str("requestHash"), CONFIRMED_HASH_BYTES, "requestHash")
    if (bytesToHex(requestHash) != requestHashHex) throw IllegalArgumentException("the record names a different request")
    val body = decodeExact(obj.str("body"), TPR2_BODY_BYTES, "body")
    val confirmedAt = obj.str("confirmedAt")
    if (!SptTime.isCanonicalIso(confirmedAt)) throw IllegalArgumentException("confirmedAt is not a canonical ISO-8601 timestamp")
    val expiresAt = obj.str("expiresAt")
    if (!SptTime.isCanonicalIso(expiresAt)) throw IllegalArgumentException("expiresAt is not a canonical ISO-8601 timestamp")
    if (SptTime.parseMillis(expiresAt) - SptTime.parseMillis(confirmedAt) != SptTime.REQUEST_TTL_MS) {
        throw IllegalArgumentException("expiresAt is not exactly seven days after confirmedAt")
    }
    val request = parseRequestBody(body)
    if (request !is RequestBodyParse.Ok) throw IllegalArgumentException("the confirmed body is not a canonical request")
    if (!bytesEqual(requestFingerprint(body), requestHash)) throw IllegalArgumentException("the confirmed body does not hash to this request")
    return ConfirmedRecord(requestHash, body, confirmedAt, expiresAt)
}

fun readConfirmation(vfs: SptVfs, requestHashHex: String, now: Instant): ConfirmationState {
    if (!isHex64(requestHashHex)) return ConfirmationState.Unusable("a requestHash is 64 lowercase hex characters")
    val bytes = try {
        vfs.readFile(confirmedPath(requestHashHex))
    } catch (e: Exception) {
        return ConfirmationState.Unusable("the confirmation could not be read (${e.message})")
    } ?: return ConfirmationState.Absent
    val record = try {
        parseConfirmed(bytes, requestHashHex)
    } catch (e: Exception) {
        return ConfirmationState.Unusable("the confirmation is not usable (${e.message})")
    }
    return if (now.toEpochMilli() >= SptTime.parseMillis(record.expiresAt)) ConfirmationState.Expired(record) else ConfirmationState.Confirmed(record)
}

/** Record the operator's declaration for the body the WORKER reviewed. Re-derives
 *  the hash from the bytes, so the file cannot be filed under a mismatched name. */
fun commitConfirmation(vfs: SptVfs, body: ByteArray, confirmedAt: String, now: Instant): Pair<String, ConfirmedRecord> {
    val request = parseRequestBody(body)
    if (request !is RequestBodyParse.Ok) throw SptRefused("spt-request-unavailable", "this is not a canonical receive request")
    if (!SptTime.isCanonicalIso(confirmedAt)) throw SptRefused("spt-request-unavailable", "confirmedAt is not a canonical ISO-8601 timestamp")
    val requestHash = requestFingerprint(body)
    val requestHashHex = bytesToHex(requestHash)
    val expiresAt = SptTime.format(Instant.ofEpochMilli(SptTime.parseMillis(confirmedAt) + SptTime.REQUEST_TTL_MS))

    val record = serializeRecord(
        "version" to SPT_RECORD_VERSION,
        "requestHash" to toBase64Url(requestHash),
        "body" to toBase64Url(body),
        "confirmedAt" to confirmedAt,
        "expiresAt" to expiresAt,
    )
    vfs.writeFileAtomic(confirmedPath(requestHashHex), record)

    val state = readConfirmation(vfs, requestHashHex, now)
    if (state !is ConfirmationState.Confirmed) {
        throw SptRefused(REFUSE_CONFIRMATION_MISSING, "the confirmation did not store intact, so nothing is authorized to be sealed. Review the request again.")
    }
    return requestHashHex to state.record
}

/** The gate spt-seal runs before a NEW handoff. Returns the exact confirmed body;
 *  refuses if there is no usable, unexpired confirmation. NOT called on the exact-
 *  re-share path. */
fun requireConfirmedBody(vfs: SptVfs, requestHashHex: String, now: Instant): ConfirmedRecord {
    return when (val state = readConfirmation(vfs, requestHashHex, now)) {
        is ConfirmationState.Confirmed -> state.record
        is ConfirmationState.Expired -> throw SptRefused(REFUSE_CONFIRMATION_EXPIRED, "the confirmation for this receive request has expired. Compare the twelve words again to re-confirm it.")
        is ConfirmationState.Absent -> throw SptRefused(REFUSE_CONFIRMATION_MISSING, "this receive request has not been confirmed on this device. Review it and compare the twelve words first.")
        is ConfirmationState.Unusable -> throw SptRefused(REFUSE_CONFIRMATION_MISSING, "${state.message} Review the request again.")
    }
}
