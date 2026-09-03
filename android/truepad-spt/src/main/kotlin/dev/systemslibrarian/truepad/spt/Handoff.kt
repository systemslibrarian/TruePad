package dev.systemslibrarian.truepad.spt

import dev.systemslibrarian.truepad.core.JsonNumber
import dev.systemslibrarian.truepad.core.JsonObject
import dev.systemslibrarian.truepad.core.parseJson
import java.security.MessageDigest

/* ============================================================================
 * The one-handoff record (Kotlin twin of src/browser/engine/handoff.ts).
 *
 * A pad may leave this installation ONCE, by ONE route. MARKER-LAST:
 *   stage package.tps2 -> read back -> stage confirm.bin -> read back -> write
 *   handoff.json (the COMMIT POINT).
 *
 * EXISTENCE IS LOAD-BEARING: a handoff.json that is empty/torn/invalid/unreadable
 * is `unreadable-spent`, never "no handoff". Never auto-deleted, never repaired.
 * LOSS IS ACCEPTABLE. REUSE IS NOT.
 *
 *   <pairId>/handoff.json            the permanent commit marker
 *   <pairId>/handoff/package.tps2    the exact TPS2 bytes   (sealed only)
 *   <pairId>/handoff/confirm.bin     the exact 11 bytes     (sealed only)
 * ========================================================================= */

const val HANDOFF_MARKER_FILE = "handoff.json"
const val HANDOFF_DIR = "handoff"
const val HANDOFF_PACKAGE_FILE = "package.tps2"
const val HANDOFF_CONFIRM_FILE = "confirm.bin"

private const val HANDOFF_HASH_BYTES = 32

const val REFUSE_UNREADABLE = "handoff-state-unreadable"
const val REFUSE_ALREADY_SEALED = "pad-already-sealed"
const val REFUSE_ALREADY_HANDED_OFF = "pad-already-handed-off"
const val REFUSE_UNRECOVERABLE = "handoff-unrecoverable"

const val UNREADABLE_ADVICE =
    "TruePad cannot safely determine this pad's handoff state, so it refuses to create another copy. A record of a " +
        "handoff exists but cannot be read. Generate a new pad for any further transfer."

fun markerPath(pairId: String) = "$pairId/$HANDOFF_MARKER_FILE"
fun handoffPackagePath(pairId: String) = "$pairId/$HANDOFF_DIR/$HANDOFF_PACKAGE_FILE"
fun handoffConfirmPath(pairId: String) = "$pairId/$HANDOFF_DIR/$HANDOFF_CONFIRM_FILE"

sealed class HandoffMarker {
    abstract val pairId: String
    abstract val at: String
    class Physical(override val pairId: String, override val at: String) : HandoffMarker()
    class Sealed(
        override val pairId: String, override val at: String,
        val requestHash: String, val packageIdentity: String, val confirmHash: String,
    ) : HandoffMarker()
}

sealed class HandoffState {
    object Absent : HandoffState()
    class Physical(val marker: HandoffMarker.Physical) : HandoffState()
    class Sealed(val marker: HandoffMarker.Sealed, val packageAvailable: Boolean, val confirmationAvailable: Boolean) : HandoffState()
    class UnreadableSpent(val message: String) : HandoffState()
}

private val PHYSICAL_KEYS = listOf("version", "pairId", "mode", "at")
private val SEALED_KEYS = listOf("version", "pairId", "mode", "at", "requestHash", "packageIdentity", "confirmHash")

private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

private fun serializeMarker(marker: HandoffMarker): ByteArray = when (marker) {
    is HandoffMarker.Physical -> serializeRecord(
        "version" to SPT_RECORD_VERSION, "pairId" to marker.pairId, "mode" to "physical", "at" to marker.at,
    )
    is HandoffMarker.Sealed -> serializeRecord(
        "version" to SPT_RECORD_VERSION, "pairId" to marker.pairId, "mode" to "sealed", "at" to marker.at,
        "requestHash" to marker.requestHash, "packageIdentity" to marker.packageIdentity, "confirmHash" to marker.confirmHash,
    )
}

/** Strict parse; every failure throws. Catches a physical marker wearing sealed
 *  fields and a sealed marker missing one. */
fun parseMarker(bytes: ByteArray, pairId: String): HandoffMarker {
    if (bytes.isEmpty()) throw IllegalArgumentException("the handoff marker is empty")
    val parsed = try {
        parseJson(String(bytes, Charsets.UTF_8))
    } catch (_: Exception) {
        throw IllegalArgumentException("the handoff marker does not parse as JSON")
    }
    val obj = parsed as? JsonObject ?: throw IllegalArgumentException("the handoff marker is not a JSON object")
    if ((obj.members["version"] as? JsonNumber)?.raw?.toIntOrNull() != SPT_RECORD_VERSION) {
        throw IllegalArgumentException("unsupported handoff marker version")
    }
    val markerPairId = obj.str("pairId")
    if (!isHex32(markerPairId)) throw IllegalArgumentException("the handoff marker has no valid pairId")
    if (markerPairId != pairId) throw IllegalArgumentException("the handoff marker names a different pair")
    val mode = obj.str("mode")
    if (mode != "physical" && mode != "sealed") throw IllegalArgumentException("the handoff marker has an unsupported mode")
    val at = obj.str("at")
    if (!SptTime.isCanonicalIso(at)) throw IllegalArgumentException("at is not a canonical ISO-8601 timestamp")
    val wanted = (if (mode == "sealed") SEALED_KEYS else PHYSICAL_KEYS).sorted()
    if (obj.members.keys.sorted() != wanted) throw IllegalArgumentException("the handoff marker's fields do not match mode $mode")
    if (mode == "physical") return HandoffMarker.Physical(pairId, at)
    val requestHash = obj.str("requestHash"); decodeExact(requestHash, HANDOFF_HASH_BYTES, "requestHash")
    val packageIdentity = obj.str("packageIdentity"); decodeExact(packageIdentity, HANDOFF_HASH_BYTES, "packageIdentity")
    val confirmHash = obj.str("confirmHash"); decodeExact(confirmHash, HANDOFF_HASH_BYTES, "confirmHash")
    return HandoffMarker.Sealed(pairId, at, requestHash, packageIdentity, confirmHash)
}

/** The pad's handoff state. No path from a present-but-bad marker to `absent`. */
fun readHandoffState(vfs: SptVfs, pairId: String): HandoffState {
    val bytes = try {
        vfs.readFile(markerPath(pairId))
    } catch (e: Exception) {
        return HandoffState.UnreadableSpent("$UNREADABLE_ADVICE (${e.message})")
    } ?: return HandoffState.Absent
    val marker = try {
        parseMarker(bytes, pairId)
    } catch (e: Exception) {
        return HandoffState.UnreadableSpent("$UNREADABLE_ADVICE (${e.message})")
    }
    if (marker is HandoffMarker.Physical) return HandoffState.Physical(marker)
    val sealedM = marker as HandoffMarker.Sealed
    return try {
        HandoffState.Sealed(sealedM, vfs.exists(handoffPackagePath(pairId)), vfs.exists(handoffConfirmPath(pairId)))
    } catch (e: Exception) {
        HandoffState.UnreadableSpent("$UNREADABLE_ADVICE (${e.message})")
    }
}

/** The refusal a caller that must not create another copy should raise, or null. */
fun refusalForNewHandoff(state: HandoffState): SptRefused? = when (state) {
    is HandoffState.Absent -> null
    is HandoffState.Physical -> SptRefused(
        REFUSE_ALREADY_HANDED_OFF,
        "This pad has already been handed off by the physical route, so it cannot also be sent by sealed transfer. " +
            "Generate a new pad for that.",
    )
    is HandoffState.Sealed -> SptRefused(
        REFUSE_ALREADY_SEALED,
        "This pad has already been sent by sealed transfer, so it cannot be handed off again. Generate a new pad for " +
            "any further transfer.",
    )
    is HandoffState.UnreadableSpent -> SptRefused(REFUSE_UNREADABLE, state.message)
}

/** Remove staged payload files — safe ONLY when no marker exists. */
fun cleanPreCommitStaging(vfs: SptVfs, pairId: String) {
    val state = readHandoffState(vfs, pairId)
    if (state !is HandoffState.Absent) {
        throw SptRefused(
            if (state is HandoffState.UnreadableSpent) REFUSE_UNREADABLE else REFUSE_ALREADY_SEALED,
            if (state is HandoffState.UnreadableSpent) state.message
            else "This pad's handoff is already committed; its staged files are not orphans and are not removed.",
        )
    }
    vfs.remove(handoffPackagePath(pairId))
    vfs.remove(handoffConfirmPath(pairId))
}

private fun writeAndVerifyMarker(vfs: SptVfs, pairId: String, marker: HandoffMarker): HandoffMarker {
    try {
        vfs.writeFileAtomic(markerPath(pairId), serializeMarker(marker))
    } catch (e: Exception) {
        val landed = try {
            vfs.readFile(markerPath(pairId)) != null
        } catch (_: Exception) {
            true
        }
        if (!landed) throw e // nothing committed — the pad is still free
        throw SptRefused(REFUSE_UNREADABLE, "$UNREADABLE_ADVICE (writing the handoff record failed after it had begun: ${e.message})")
    }
    val readBack = vfs.readFile(markerPath(pairId))
        ?: throw SptRefused(REFUSE_UNREADABLE, "$UNREADABLE_ADVICE (the handoff record did not survive being written)")
    return try {
        parseMarker(readBack, pairId)
    } catch (e: Exception) {
        throw SptRefused(REFUSE_UNREADABLE, "$UNREADABLE_ADVICE (the handoff record read back invalid: ${e.message})")
    }
}

/** Record a PHYSICAL handoff. The caller holds the pad lock and checked provenance. */
fun commitPhysicalHandoff(vfs: SptVfs, pairId: String, at: String): HandoffMarker.Physical {
    val verified = writeAndVerifyMarker(vfs, pairId, HandoffMarker.Physical(pairId, at))
    if (verified !is HandoffMarker.Physical) {
        throw SptRefused(REFUSE_UNREADABLE, "$UNREADABLE_ADVICE (the record read back with the wrong mode)")
    }
    return verified
}

class SealedHandoffInput(
    val packageBytes: ByteArray, val requestHash: ByteArray, val confirmValue: ByteArray, val packageIdentity: ByteArray,
)

/** The marker-last sealed transaction. STORAGE ONLY: persists bytes a caller has
 *  already produced, under the one-handoff rule, refusing if a handoff exists AND
 *  requiring the request already bound to THIS pair. Caller holds the pad lock. */
fun commitSealedHandoff(vfs: SptVfs, pairId: String, input: SealedHandoffInput, at: String): HandoffMarker.Sealed {
    if (input.confirmValue.size != CONFIRM_VALUE_BYTES) throw SptRefused("bad-request", "confirmValue must be exactly $CONFIRM_VALUE_BYTES bytes")
    if (input.requestHash.size != HANDOFF_HASH_BYTES || input.packageIdentity.size != HANDOFF_HASH_BYTES) {
        throw SptRefused("bad-request", "requestHash and packageIdentity must be $HANDOFF_HASH_BYTES bytes")
    }
    // 1a — the PAD's handoff must not already exist, in any state (checked first).
    refusalForNewHandoff(readHandoffState(vfs, pairId))?.let { throw it }
    // 1b — the REQUEST must already be bound to THIS pair.
    requireClaimedByPair(vfs, input.requestHash, pairId)
    // 2 — with no marker present, staged files are provably pre-commit.
    vfs.remove(handoffPackagePath(pairId))
    vfs.remove(handoffConfirmPath(pairId))
    // 3, 4 — stage the package, read back byte-for-byte.
    vfs.writeFileAtomic(handoffPackagePath(pairId), input.packageBytes)
    val storedPackage = vfs.readFile(handoffPackagePath(pairId))
    if (storedPackage == null || !bytesEqual(storedPackage, input.packageBytes)) {
        throw SptRefused("storage-failed", "the sealed package did not store intact; nothing was committed.")
    }
    // 5 — the supplied identity must be the identity of what is on disk.
    val identity = packageIdentity(storedPackage)
    if (!bytesEqual(identity, input.packageIdentity)) throw SptRefused("storage-failed", "the stored package does not match its supplied identity.")
    // 6, 7 — stage the confirmation value, read back.
    vfs.writeFileAtomic(handoffConfirmPath(pairId), input.confirmValue)
    val storedConfirm = vfs.readFile(handoffConfirmPath(pairId))
    if (storedConfirm == null || !bytesEqual(storedConfirm, input.confirmValue)) {
        throw SptRefused("storage-failed", "the confirmation value did not store intact; nothing was committed.")
    }
    // 8-10 — the marker LAST (the commit point).
    val marker = HandoffMarker.Sealed(
        pairId, at, toBase64Url(input.requestHash), toBase64Url(identity), toBase64Url(sha256(storedConfirm)),
    )
    val verified = writeAndVerifyMarker(vfs, pairId, marker)
    if (verified !is HandoffMarker.Sealed) throw SptRefused(REFUSE_UNREADABLE, "$UNREADABLE_ADVICE (the record read back with the wrong mode)")
    if (verified.packageIdentity != marker.packageIdentity || verified.confirmHash != marker.confirmHash || verified.requestHash != marker.requestHash) {
        throw SptRefused(REFUSE_UNREADABLE, "$UNREADABLE_ADVICE (the record read back with different contents)")
    }
    return verified
}

class CommittedSealedHandoff(val marker: HandoffMarker.Sealed, val packageBytes: ByteArray, val confirmValue: ByteArray)

/** Re-read a committed sealed handoff and verify both payloads against the marker
 *  — how a retry returns the EXACT original package instead of re-encapsulating. */
fun loadCommittedSealedHandoff(vfs: SptVfs, pairId: String): CommittedSealedHandoff {
    val state = readHandoffState(vfs, pairId)
    if (state !is HandoffState.Sealed) {
        throw refusalForNewHandoff(state) ?: SptRefused(REFUSE_UNRECOVERABLE, "this pad has no committed sealed handoff.")
    }
    val packageBytes = vfs.readFile(handoffPackagePath(pairId))
    val confirmValue = vfs.readFile(handoffConfirmPath(pairId))
    if (packageBytes == null || confirmValue == null) {
        throw SptRefused(
            REFUSE_UNRECOVERABLE,
            "This pad's handoff is committed, but the sealed package is no longer stored, so it cannot be produced " +
                "again. The pad stays handed off; generate a new pad for any further transfer.",
        )
    }
    if (toBase64Url(packageIdentity(packageBytes)) != state.marker.packageIdentity) {
        throw SptRefused(
            REFUSE_UNRECOVERABLE,
            "This pad's stored sealed package does not match the committed record, so it cannot be produced again. " +
                "The pad stays handed off; generate a new pad for any further transfer.",
        )
    }
    if (confirmValue.size != CONFIRM_VALUE_BYTES || toBase64Url(sha256(confirmValue)) != state.marker.confirmHash) {
        throw SptRefused(
            REFUSE_UNRECOVERABLE,
            "This pad's stored confirmation value does not match the committed record. The pad stays handed off; " +
                "generate a new pad for any further transfer.",
        )
    }
    return CommittedSealedHandoff(state.marker, packageBytes, confirmValue)
}

/** Drop the sealed payload while KEEPING the marker. The pad stays permanently
 *  handed off; handoff.json is NOT removed, not here, not anywhere. */
fun dismissSealedPayload(vfs: SptVfs, pairId: String) {
    val state = readHandoffState(vfs, pairId)
    if (state is HandoffState.UnreadableSpent) throw SptRefused(REFUSE_UNREADABLE, state.message)
    if (state !is HandoffState.Sealed) throw SptRefused(REFUSE_UNRECOVERABLE, "this pad has no committed sealed handoff to dismiss.")
    vfs.remove(handoffPackagePath(pairId))
    vfs.remove(handoffConfirmPath(pairId))
}
