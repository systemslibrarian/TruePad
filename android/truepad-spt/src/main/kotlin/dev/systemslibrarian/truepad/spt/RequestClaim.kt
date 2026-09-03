package dev.systemslibrarian.truepad.spt

import dev.systemslibrarian.truepad.core.bytesToHex

/* ============================================================================
 * The one-request claim (Kotlin twin of src/browser/engine/request-claim.ts).
 *
 * THE SECOND DURABLE GATE. handoff.json protects a PAD (keyed by pairId).
 * spt/claims/<requestHashHex>.json binds a REQUEST to a pair, permanently, so a
 * second FRESH pad cannot be sealed to the same request:
 *
 *     <pairId>/handoff.json               one pad, one handoff
 *     spt/claims/<requestHash>.json       one request, one package
 *
 * CLAIMED IS NOT CONSUMED: retry R -> P is allowed (resumption); retry R -> Q is
 * refused permanently. Write order: claim -> encapsulate -> handoff (marker-last).
 * ========================================================================= */

const val CLAIMS_DIR = "spt/claims"
private const val CLAIM_HASH_BYTES = 32

const val REFUSE_CLAIMED_ELSEWHERE = "request-claimed-elsewhere"
const val REFUSE_CLAIM_UNREADABLE = "request-claim-unreadable"
const val REFUSE_NOT_CLAIMED = "request-not-claimed"

const val CLAIM_UNREADABLE_ADVICE =
    "TruePad cannot safely determine which pad this receive request was already bound to, so it refuses to seal " +
        "anything to it. A record of that binding exists but cannot be read. Ask for a new receive request."

fun claimPath(requestHash: ByteArray): String {
    require(requestHash.size == CLAIM_HASH_BYTES) { "requestHash must be $CLAIM_HASH_BYTES bytes, got ${requestHash.size}" }
    return "$CLAIMS_DIR/${bytesToHex(requestHash)}.json"
}

class RequestClaim(val requestHash: String, val pairId: String, val at: String)

sealed class RequestClaimState {
    object Absent : RequestClaimState()
    class Claimed(val claim: RequestClaim) : RequestClaimState()
    class Unreadable(val message: String) : RequestClaimState()
}

private val CLAIM_KEYS = listOf("version", "requestHash", "pairId", "at")

/** Strict parse: the record must name the request whose file it was read from. */
fun parseClaim(bytes: ByteArray, requestHash: ByteArray): RequestClaim {
    val obj = parseRecord(bytes, "request claim", CLAIM_KEYS)
    val requestHashB64 = obj.str("requestHash")
    val decoded = decodeExact(requestHashB64, CLAIM_HASH_BYTES, "requestHash")
    if (!bytesEqual(decoded, requestHash)) throw IllegalArgumentException("the request claim names a different request")
    val pairId = obj.str("pairId")
    if (!isHex32(pairId)) throw IllegalArgumentException("the request claim has no valid pairId")
    val at = obj.str("at")
    if (!SptTime.isCanonicalIso(at)) throw IllegalArgumentException("at is not a canonical ISO-8601 timestamp")
    return RequestClaim(requestHashB64, pairId, at)
}

/** A read that throws becomes `unreadable`, never `absent`. */
fun readRequestClaim(vfs: SptVfs, requestHash: ByteArray): RequestClaimState {
    val path = claimPath(requestHash)
    val bytes = try {
        vfs.readFile(path)
    } catch (e: Exception) {
        return RequestClaimState.Unreadable("$CLAIM_UNREADABLE_ADVICE (${e.message})")
    } ?: return RequestClaimState.Absent
    return try {
        RequestClaimState.Claimed(parseClaim(bytes, requestHash))
    } catch (e: Exception) {
        RequestClaimState.Unreadable("$CLAIM_UNREADABLE_ADVICE (${e.message})")
    }
}

/** Bind a request to a pair, permanently — step (1). Idempotent for the SAME pair
 *  (retry of an interrupted pre-handoff attempt); R -> Q when bound to P is
 *  refused permanently. */
fun claimRequestForPair(vfs: SptVfs, requestHash: ByteArray, pairId: String, at: String): RequestClaim {
    require(isHex32(pairId)) { "pairId must be 32 lowercase hex characters" }
    val path = claimPath(requestHash)
    when (val existing = readRequestClaim(vfs, requestHash)) {
        is RequestClaimState.Unreadable -> throw SptRefused(REFUSE_CLAIM_UNREADABLE, existing.message)
        is RequestClaimState.Claimed -> {
            if (existing.claim.pairId != pairId) {
                throw SptRefused(
                    REFUSE_CLAIMED_ELSEWHERE,
                    "This receive request is already bound to a different pad. A request receives one pad and one " +
                        "package; sealing a second pad to it would leave the recipient two packages with two different " +
                        "confirmation codes and no way to tell which is real. Ask for a new receive request.",
                )
            }
            return existing.claim // same pair — the retry; first binding time stands
        }
        is RequestClaimState.Absent -> {}
    }

    val record = serializeRecord(
        "version" to SPT_RECORD_VERSION,
        "requestHash" to toBase64Url(requestHash),
        "pairId" to pairId,
        "at" to at,
    )
    try {
        vfs.writeFileAtomic(path, record)
    } catch (e: Exception) {
        val landed = try {
            vfs.readFile(path) != null
        } catch (_: Exception) {
            true
        }
        if (!landed) throw e
        throw SptRefused(REFUSE_CLAIM_UNREADABLE, "$CLAIM_UNREADABLE_ADVICE (writing the binding failed after it had begun: ${e.message})")
    }

    val readBack = vfs.readFile(path)
        ?: throw SptRefused(REFUSE_CLAIM_UNREADABLE, "$CLAIM_UNREADABLE_ADVICE (the binding did not survive being written)")
    val verified = try {
        parseClaim(readBack, requestHash)
    } catch (e: Exception) {
        throw SptRefused(REFUSE_CLAIM_UNREADABLE, "$CLAIM_UNREADABLE_ADVICE (the binding read back invalid: ${e.message})")
    }
    if (verified.pairId != pairId) {
        throw SptRefused(REFUSE_CLAIM_UNREADABLE, "$CLAIM_UNREADABLE_ADVICE (the binding read back naming another pad)")
    }
    return verified
}

/** commitSealedHandoff's precheck: this request must already be bound to THIS pair. */
fun requireClaimedByPair(vfs: SptVfs, requestHash: ByteArray, pairId: String): RequestClaim {
    when (val state = readRequestClaim(vfs, requestHash)) {
        is RequestClaimState.Unreadable -> throw SptRefused(REFUSE_CLAIM_UNREADABLE, state.message)
        is RequestClaimState.Absent -> throw SptRefused(
            REFUSE_NOT_CLAIMED,
            "This receive request was never bound to this pad, so no package may be committed for it. The binding is " +
                "written before anything is encapsulated.",
        )
        is RequestClaimState.Claimed -> {
            if (state.claim.pairId != pairId) {
                throw SptRefused(REFUSE_CLAIMED_ELSEWHERE, "This receive request is bound to a different pad. Ask for a new receive request.")
            }
            return state.claim
        }
    }
}
