package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.spt.SptVfs
import dev.systemslibrarian.truepad.spt.CancelReason
import dev.systemslibrarian.truepad.spt.ConsumeInput
import dev.systemslibrarian.truepad.spt.HandoffState as SptHandoffState
import dev.systemslibrarian.truepad.spt.OpenOutcome
import dev.systemslibrarian.truepad.spt.PackageParse
import dev.systemslibrarian.truepad.spt.PendingRequestInput
import dev.systemslibrarian.truepad.spt.ReceiverState as SptReceiverState
import dev.systemslibrarian.truepad.spt.RequestDecode
import dev.systemslibrarian.truepad.spt.SealedHandoffInput
import dev.systemslibrarian.truepad.spt.SptRefused
import dev.systemslibrarian.truepad.spt.SptTime
import dev.systemslibrarian.truepad.spt.XWing
import dev.systemslibrarian.truepad.spt.cancelPendingReceiveRequest
import dev.systemslibrarian.truepad.spt.claimRequestForPair
import dev.systemslibrarian.truepad.spt.commitConfirmation
import dev.systemslibrarian.truepad.spt.commitPendingReceiveRequest
import dev.systemslibrarian.truepad.spt.commitSealedHandoff
import dev.systemslibrarian.truepad.spt.confirmationIndices88
import dev.systemslibrarian.truepad.spt.consumePendingReceiveRequest
import dev.systemslibrarian.truepad.spt.decodeReceiveRequest
import dev.systemslibrarian.truepad.spt.encodeReceiveRequest
import dev.systemslibrarian.truepad.spt.encodeRequestBody
import dev.systemslibrarian.truepad.spt.loadCommittedSealedHandoff
import dev.systemslibrarian.truepad.spt.namespaceOccupied
import dev.systemslibrarian.truepad.spt.openPayloadV1
import dev.systemslibrarian.truepad.spt.pairArrivedSealed
import dev.systemslibrarian.truepad.spt.parseSealedPackage
import dev.systemslibrarian.truepad.spt.readHandoffState as sptReadHandoffState
import dev.systemslibrarian.truepad.spt.readReceiverState as sptReadReceiverState
import dev.systemslibrarian.truepad.spt.requestFingerprint
import dev.systemslibrarian.truepad.spt.requestIndices132
import dev.systemslibrarian.truepad.spt.requireConfirmedBody
import dev.systemslibrarian.truepad.spt.sealPayloadV1
import dev.systemslibrarian.truepad.spt.toBase64Url
import dev.systemslibrarian.truepad.spt.MAX_PLAINTEXT_BYTES as SPT_MAX_PLAINTEXT
import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.core.bytesToHex
import dev.systemslibrarian.truepad.core.hexToBytes
import java.security.SecureRandom

/* ============================================================================
 * Bridging the durable store to the SPT layer.
 *
 * FsSptVfs adapts this module's Fs to the SPT layer's SptVfs — SAME files, SAME
 * locks — so the SPT durable protocol and the OTP store share one filesystem and
 * one per-scope lock. The SPT orchestration verbs live on Engine (SptEngine.kt is
 * this bridge plus the result types); the frozen OTP crypto/verbs are untouched.
 * ========================================================================= */

/** A pass-through adapter: Fs already has every method SptVfs needs. */
class FsSptVfs(private val fs: Fs) : SptVfs {
    override fun readFile(path: String): ByteArray? = fs.readFile(path)
    override fun writeFileAtomic(path: String, data: ByteArray) = fs.writeFileAtomic(path, data)
    override fun exists(path: String): Boolean = fs.exists(path)
    override fun remove(path: String) = fs.remove(path)
    override fun writeRange(path: String, offset: Long, data: ByteArray) = fs.writeRange(path, offset, data)
    override fun size(path: String): Long? = fs.size(path)
    override fun list(prefix: String): List<String> = fs.list(prefix)
    override fun <T> withLock(scope: String, fn: () -> T): T = fs.withLock(scope, fn)
}

/* ---- SPT verb result types ------------------------------------------------ */

/** Show this to the recipient. The TPR2 text (paste/QR), the 16-byte requestId,
 *  the 64-hex requestHash, the twelve request-word indices, and the expiry. */
class SptCreateResult(
    val requestIdHex: String,
    val requestHashHex: String,
    val tpr2Text: String,
    val requestIndices: IntArray,
    val expiresAt: String,
)

/** A decoded receive request the sender is reviewing. The canonical body is held
 *  by the caller (never re-supplied by an untrusted layer) for the confirm/seal
 *  steps; the twelve indices are the words to compare aloud. */
class SptReviewResult(
    val canonicalBody: ByteArray,
    val requestIdHex: String,
    val requestHashHex: String,
    val requestIndices: IntArray,
)

/** The sealed package to hand over, plus the eight confirmation-word indices the
 *  sender reads aloud. `reshared` is true when an already-committed package was
 *  returned rather than a fresh seal. */
class SptSealResult(
    val requestHashHex: String,
    val packageIdentityB64: String,
    val packageBytes: ByteArray,
    val confirmationIndices: IntArray,
    val reshared: Boolean,
)

/** A transient receive session, held by the caller between "open" and "commit".
 *  It carries the decrypted pad bytes (a secret — the caller must keep it in
 *  memory only) and everything the commit needs. The eight indices are the words
 *  the recipient compares against what the sender reads. */
class SptOpenResult(
    val requestIdHex: String,
    val requestHash: ByteArray,
    val pairId: String,
    val packageIdentity: ByteArray,
    val padFileBytes: ByteArray,
    val confirmValue: ByteArray,
    val confirmationIndices: IntArray,
)

/* ============================================================================
 * The SPT verbs — the Kotlin twin of the essential orderings in
 * src/browser/engine/spt-verbs.ts, composed over this module's store. Android
 * needs no worker runtime/session (the ViewModel is the trusted layer and holds
 * the transient SptOpenResult in memory between the ceremony and the commit); the
 * durable authorities and the frozen orderings are what carry over.
 *
 * SENDER:   claim -> encapsulate -> handoff (marker-last) -> release
 * RECEIVER: parse -> request authority -> decapsulate -> preflight -> compare
 *           -> CONSUME -> import
 * ========================================================================= */


private val SPT_RANDOM = SecureRandom()
private val HEX_32_ID = Regex("^[0-9a-f]{32}$")
private val HEX_64_ID = Regex("^[0-9a-f]{64}$")

private fun Engine.sptVfs(): dev.systemslibrarian.truepad.spt.SptVfs = FsSptVfs(fs)

/** RECEIVER — create a one-time recipient key and publish a receive request. The
 *  TPR2 text is produced only after dk.bin and request.json are written and
 *  read back. */
fun Engine.sptCreateReceiveRequest(): SptCreateResult {
    val vfs = sptVfs()
    for (attempt in 0 until 16) {
        val requestId = ByteArray(16).also { SPT_RANDOM.nextBytes(it) }
        val idHex = bytesToHex(requestId)
        if (namespaceOccupied(vfs, idHex)) continue
        val keys = XWing.generateKeyPair()
        val body = encodeRequestBody(requestId, keys.encapsulationKey)
        val requestHash = requestFingerprint(body)
        try {
            return fs.withLock("spt-req:$idHex") {
                val nowI = clock()
                val createdAt = SptTime.format(nowI)
                val expiresAt = SptTime.format(nowI.plusMillis(SptTime.REQUEST_TTL_MS))
                commitPendingReceiveRequest(vfs, PendingRequestInput(body, requestId, requestHash, keys.decapsulationSeed, createdAt, expiresAt))
                SptCreateResult(idHex, bytesToHex(requestHash), encodeReceiveRequest(requestId, keys.encapsulationKey), requestIndices132(requestHash), expiresAt)
            }
        } catch (e: SptRefused) {
            if (e.reason == "request-id-unavailable") continue
            throw e
        }
    }
    throw SptRefused("spt-request-unavailable", "could not allocate a new receive request identifier. Nothing was created.")
}

/** SENDER — decode a scanned/pasted TPR2 and return the twelve words to compare.
 *  The canonical body is handed back for the caller to hold and re-supply to
 *  confirm/seal (never re-derived from an untrusted layer). */
/**
 * The receive request that survived a restart, if there is one.
 *
 * WHY THIS EXISTS. `request.json` and `dk.bin` are durable, and nothing read them
 * back. The receive screen held the published request in memory only — and
 * navigating into it resets `SptUi()` — so a force-quit, or simply leaving the
 * screen, stranded a LIVE one-time key: still pending on disk, and unreachable
 * from the interface. The operator could not cancel it, could not REJECT it after
 * a failed word comparison, and could not open the sealed file that came back.
 *
 * Found by the two-device physical ceremony: the iPhone sealed a pad to this
 * device's request, and this device then had no way to open it. The iOS edition
 * carried the identical defect and is fixed the same way.
 *
 * THE PRIVATE KEY IS DELIBERATELY NOT RETURNED. `Pending` carries `dk`, and this
 * drops it: everything above the engine needs the public request, its words and
 * its expiry, and nothing above the engine has any business holding a
 * decapsulation seed.
 *
 * An EXPIRED pending request is not returned — it is not usable, and offering it
 * would invite a ceremony that cannot complete. If several are pending, the most
 * recently created is returned, so cancelling repeatedly drains them.
 */
fun Engine.sptRestorePendingReceiveRequest(): SptCreateResult? {
    val vfs = sptVfs()
    val ids = runCatching { vfs.list("spt/receive") }.getOrElse { return null }
    val now = clock()
    var newest: Pair<String, SptCreateResult>? = null
    for (idHex in ids) {
        // The listing is untrusted input like any other: a name that is not a
        // request identifier is skipped rather than parsed.
        if (idHex.length != 32 || !idHex.all { it.isDigit() || it in 'a'..'f' }) continue
        val state = sptReadReceiverState(vfs, idHex, now) as? SptReceiverState.Pending ?: continue
        // Rebuilt from the STORED body, not re-derived from anything the UI holds:
        // the text the sender scanned is a function of the bytes on disk.
        val result = SptCreateResult(
            state.requestId,
            bytesToHex(state.requestHash),
            "TPR2:" + toBase64Url(state.body),
            requestIndices132(state.requestHash),
            state.expiresAt,
        )
        // ISO-8601 with a fixed shape, so lexicographic order is chronological.
        if (newest == null || state.createdAt > newest!!.first) newest = state.createdAt to result
    }
    return newest?.second
}

/**
 * RECEIVER — end a pending receive request DURABLY.
 *
 * This existed only as an SPT primitive, reachable from the engine for expiry and
 * nothing else, so the two places the operator can end a request both merely
 * cleared the screen. The request stayed Pending on disk.
 *
 * That was survivable while nothing read pending requests back. It stopped being
 * survivable the moment `sptRestorePendingReceiveRequest` started restoring them:
 * an operator who compared the eight confirmation words, found they DID NOT
 * MATCH, and pressed the reject button would have that same request — and with it
 * the sealed package the mismatch was warning about — offered again the next time
 * the Receive screen opened. A failed word comparison is how the ceremony is
 * supposed to END; it must not be a step that can be walked back by navigating.
 *
 * REJECTED and OPERATOR are kept distinct because they are different facts.
 * REJECTED means the words did not match, which is the outcome the comparison
 * exists to produce. OPERATOR means the person simply changed their mind. The
 * underlying primitive is idempotent and keeps the FIRST reason, so a later
 * cancel cannot overwrite a rejection.
 */
fun Engine.sptEndReceiveRequest(requestIdHex: String, reason: CancelReason) {
    require(reason != CancelReason.EXPIRED) {
        "expiry is decided by the clock, not by the operator"
    }
    val vfs = sptVfs()
    fs.withLock("spt-req:$requestIdHex") {
        val nowI = clock()
        cancelPendingReceiveRequest(vfs, requestIdHex, reason, SptTime.format(nowI), nowI)
    }
}

fun Engine.sptReviewRequest(tpr2Text: String): SptReviewResult {
    val decoded = decodeReceiveRequest(tpr2Text)
    if (decoded is RequestDecode.Fail) throw SptRefused("spt-request-unavailable", "this is not a usable receive request: ${decoded.message}")
    val ok = decoded as RequestDecode.Ok
    val requestHash = requestFingerprint(ok.canonicalBody)
    return SptReviewResult(ok.canonicalBody, bytesToHex(ok.request.requestId), bytesToHex(requestHash), requestIndices132(requestHash))
}

/** SENDER — record the operator's twelve-word match for the reviewed body. */
fun Engine.sptConfirmRequest(canonicalBody: ByteArray) {
    val nowI = clock()
    commitConfirmation(sptVfs(), canonicalBody, SptTime.format(nowI), nowI)
}

private fun Engine.requirePadSealable(pairId: String) {
    requireNotDestroyed(pairId)
    requireImportComplete(pairId)
    requirePair(pairId)
    val meta = readPairMeta(fs, pairId)
    if (meta.origin != PairOrigin.GENERATED_HERE) {
        throw SptRefused("spt-pad-ineligible", "This pad did not originate on this device, so it will not be sent by sealed transfer. Generate a new pad to share.")
    }
    val pair = loadPair(pairId)
    // ALL THREE counters, both directions. `attemptsReserved` is not optional and
    // is not a bookkeeping detail: a pad that took a FAILED OPEN at genesis still
    // reads nextOffset == 0 and nextSequence == 0, but it has already spent part of
    // its freeze budget and one record already carries a recorded verification
    // attempt. Sealing it hands the receiver a store that is NOT pristine and whose
    // §5 forgery bound is already partly consumed, without them being able to tell.
    // The frozen authority (src/browser/engine/verbs.ts requirePadSealable) tests
    // all three; omitting one here made Android seal pads the Browser refuses.
    val atGenesis = pair.values.all {
        it.effective.nextOffset == 0L &&
            it.effective.nextSequence == 0L &&
            it.effective.attemptsReserved == 0L
    }
    if (!atGenesis) {
        throw SptRefused("spt-pad-ineligible", "This pad has already been used, so it cannot be sent by sealed transfer — a sealed transfer sends the whole pad. Generate a fresh pad to share.")
    }
}

/** SENDER — seal a live, generated-here, genesis pad to a confirmed request, or
 *  return the exact already-committed package (re-share). Pad lock outermost. */
fun Engine.sptSeal(requestHashHex: String, pairId: String): SptSealResult {
    if (!HEX_64_ID.matches(requestHashHex)) throw SptRefused("spt-request-unavailable", "a request fingerprint is 64 lowercase hex characters.")
    if (!HEX_32_ID.matches(pairId)) throw SptRefused("spt-pad-ineligible", "a pad id is 32 lowercase hex characters.")
    val vfs = sptVfs()
    return fs.withLock(pairId) {
        requireNotDestroyed(pairId)
        when (val handoff = sptReadHandoffState(vfs, pairId)) {
            is SptHandoffState.UnreadableSpent -> throw SptRefused("handoff-state-unreadable", handoff.message)
            is SptHandoffState.Physical -> throw SptRefused("pad-already-handed-off", "This pad has already been handed off as a file, so it cannot also be sent by sealed transfer. Generate a new pad for that.")
            is SptHandoffState.Sealed -> {
                // EXACT RE-SHARE. No new cryptography, no fresh confirmation.
                if (handoff.marker.requestHash != toBase64Url(hexToBytes(requestHashHex)!!)) {
                    throw SptRefused("pad-already-sealed", "This pad was already sealed to a different receive request. Generate a new pad for this one.")
                }
                val committed = loadCommittedSealedHandoff(vfs, pairId)
                SptSealResult(requestHashHex, handoff.marker.packageIdentity, committed.packageBytes.copyOf(), confirmationIndices88(committed.confirmValue), true)
            }
            is SptHandoffState.Absent -> {
                // ABSENT — and only NOW does live eligibility apply (before the
                // inner lock, exactly as the frozen sealImpl orders it).
                requirePadSealable(pairId)
                // THE REQUEST-SCOPED SENDER LOCK, nested inside the pad lock
                // (pad OUTERMOST, request-send INNER — never the reverse). Two
                // seals of DIFFERENT pads to the SAME request take DIFFERENT pad
                // locks, so only this request-scoped lock makes claimRequestForPair's
                // read-then-write compare-and-set atomic. Without it the claim gate
                // has a TOCTOU window and one request could yield two valid packages
                // with two different confirmation codes.
                fs.withLock("spt-send:$requestHashHex") {
                    // Re-check the pad's handoff with BOTH locks held.
                    val again = sptReadHandoffState(vfs, pairId)
                    if (again !is SptHandoffState.Absent) {
                        throw SptRefused("pad-already-sealed", "this pad's handoff was committed concurrently.")
                    }
                    // The time is read HERE, under both locks, immediately before
                    // the decision it governs — never a clock read from before this
                    // call waited in the queue (which could authorize a seal on a
                    // confirmation that expired while it waited).
                    val nowI = clock()
                    val confirmed = requireConfirmedBody(vfs, requestHashHex, nowI)
                    val requestHash = requestFingerprint(confirmed.body)
                    if (bytesToHex(requestHash) != requestHashHex) throw SptRefused("spt-request-unavailable", "the stored confirmation does not match this request.")
                    claimRequestForPair(vfs, requestHash, pairId, SptTime.format(nowI))
                    val container = buildLiveCourierContainer(pairId)
                    if (container.size > SPT_MAX_PLAINTEXT) throw SptRefused("spt-pad-ineligible", "this pad is too large to send by sealed transfer.")
                    val sealed = sealPayloadV1(confirmed.body, container)
                    commitSealedHandoff(vfs, pairId, SealedHandoffInput(sealed.packageBytes, requestHash, sealed.confirmValue, sealed.packageIdentity), SptTime.format(nowI))
                    val committed = loadCommittedSealedHandoff(vfs, pairId)
                    SptSealResult(requestHashHex, toBase64Url(sealed.packageIdentity), committed.packageBytes.copyOf(), confirmationIndices88(committed.confirmValue), false)
                }
            }
        }
    }
}

/** In-memory bundle validation: write the unpacked files to a scratch store and
 *  loadStore both halves, so a bad bundle is refused BEFORE the request is
 *  consumed. Nothing durable is written. Returns null when the bundle is a whole,
 *  valid, matched pair; a message otherwise. */
private fun sptPreflightBundle(unpacked: UnpackResult.Ok): String? {
    val scratch = MemoryFs()
    val pairId = unpacked.pairId
    if (!HEX_32_ID.matches(pairId)) return "this pad file has an invalid identifier."
    for (f in unpacked.files) scratch.writeFileAtomic("$pairId/${f.path}", f.bytes)
    val ab = loadStore(scratch, "$pairId/${SUBDIR.getValue(Direction.A_TO_B)}")
    if (ab is LoadResult.Refusal) return "the received A->B store is not usable: ${ab.message}"
    val ba = loadStore(scratch, "$pairId/${SUBDIR.getValue(Direction.B_TO_A)}")
    if (ba is LoadResult.Refusal) return "the received B->A store is not usable: ${ba.message}"
    val abHead = (ab as LoadResult.Ok).store.head
    val baHead = (ba as LoadResult.Ok).store.head
    if (abHead.pairId != pairId || baHead.pairId != pairId) return "the bundle's head pairId disagrees with the container pairId."
    if (abHead.direction != Direction.A_TO_B || baHead.direction != Direction.B_TO_A) return "the bundle's two halves are not a matched A->B / B->A pair."
    return null
}

/** RECEIVER — open a sealed package into a transient session held by the caller.
 *  Ordering: structural parse -> request authority (refuses terminal/expired
 *  before any key use) -> requestHash binding -> decapsulate/AEAD -> in-memory
 *  preflight. No pad bytes touch durable storage. */
fun Engine.sptOpen(packageBytes: ByteArray): SptOpenResult {
    val parsed = parseSealedPackage(packageBytes)
    if (parsed is PackageParse.Fail) throw SptRefused("spt-package-malformed", "this sealed file is not usable: ${parsed.message}")
    val pp = (parsed as PackageParse.Ok).parsed
    val requestIdHex = bytesToHex(pp.header.requestId)
    val vfs = sptVfs()
    return fs.withLock("spt-req:$requestIdHex") {
        val nowI = clock()
        val pending = when (val state = sptReadReceiverState(vfs, requestIdHex, nowI)) {
            is SptReceiverState.Pending -> state
            is SptReceiverState.ExpiredPending -> {
                cancelPendingReceiveRequest(vfs, requestIdHex, CancelReason.EXPIRED, SptTime.format(nowI), nowI)
                throw SptRefused("spt-request-expired", "this receive request has expired.")
            }
            is SptReceiverState.Cancelled -> throw SptRefused("spt-request-cancelled", "this receive request was cancelled and cannot be used.")
            is SptReceiverState.Consumed -> throw SptRefused("spt-request-consumed", "this receive request has already received a pad.")
            is SptReceiverState.Absent -> throw SptRefused("spt-request-unavailable", "there is no such receive request on this device.")
            is SptReceiverState.Unusable -> throw SptRefused("spt-request-unavailable", state.message)
            is SptReceiverState.TerminalUnreadable -> throw SptRefused("spt-request-unavailable", state.message)
            is SptReceiverState.TerminalInconsistent -> throw SptRefused("spt-request-unavailable", state.message)
        }
        if (!pp.header.requestHash.contentEquals(pending.requestHash)) {
            throw SptRefused("spt-request-unavailable", "this sealed file is for a different receive request.")
        }
        val outcome = openPayloadV1(packageBytes, pending.body, pending.dk)
        if (outcome is OpenOutcome.Fail) throw SptRefused("spt-package-open-failed", "this sealed file could not be opened for this receive request.")
        val r = (outcome as OpenOutcome.Ok).result
        val unpacked = when (val u = unpackContainer(r.payload)) {
            is UnpackResult.Bad -> throw SptRefused("spt-package-not-importable", "this is not a usable pad file: ${u.message}")
            is UnpackResult.Ok -> u
        }
        sptPreflightBundle(unpacked)?.let { throw SptRefused("spt-package-not-importable", "$it Nothing was imported.") }
        // 6b — against the REAL store, non-mutating: refuse a pad id already
        // committed (or destroyed) here BEFORE opening a session. FREE — nothing
        // is consumed, no importer runs. Re-checked at commit, because state moves.
        requireImportable(unpacked.pairId)
        SptOpenResult(requestIdHex, pending.requestHash.copyOf(), unpacked.pairId, r.packageIdentity, r.payload, r.confirmValue, r.confirmationIndices)
    }
}

/** RECEIVER — CONSUME the request, then import. After a valid consume, any import
 *  failure is LOSS and the request stays consumed (never reopened). */
fun Engine.sptCommitReceive(session: SptOpenResult, label: String): PairSummary {
    val vfs = sptVfs()
    return fs.withLock("spt-req:${session.requestIdHex}") {
        val nowI = clock()
        val pending = when (val state = sptReadReceiverState(vfs, session.requestIdHex, nowI)) {
            is SptReceiverState.Pending -> state
            is SptReceiverState.ExpiredPending -> {
                cancelPendingReceiveRequest(vfs, session.requestIdHex, CancelReason.EXPIRED, SptTime.format(nowI), nowI)
                throw SptRefused("spt-request-expired", "this receive request expired before the pad was saved.")
            }
            is SptReceiverState.Cancelled -> throw SptRefused("spt-request-cancelled", "this receive request was cancelled.")
            is SptReceiverState.Consumed -> throw SptRefused("spt-request-consumed", "this receive request has already received a pad.")
            is SptReceiverState.Absent -> throw SptRefused("spt-request-unavailable", "there is no such receive request.")
            is SptReceiverState.Unusable -> throw SptRefused("spt-request-unavailable", state.message)
            is SptReceiverState.TerminalUnreadable -> throw SptRefused("spt-request-unavailable", state.message)
            is SptReceiverState.TerminalInconsistent -> throw SptRefused("spt-request-unavailable", state.message)
        }
        if (!pending.requestHash.contentEquals(session.requestHash)) throw SptRefused("spt-request-unavailable", "this transfer no longer matches its receive request.")
        val unpacked = when (val u = unpackContainer(session.padFileBytes)) {
            is UnpackResult.Bad -> throw SptRefused("spt-package-not-importable", "this pad file is not usable: ${u.message}")
            is UnpackResult.Ok -> u
        }
        // Re-run the cheap real-state check under the request lock: a pair or a
        // tombstone can appear between open and now. Refusing HERE is FREE —
        // nothing is consumed. importPair re-checks authoritatively under the pad
        // lock; this only spares the common case a spent one-time receive request.
        requireImportable(unpacked.pairId)
        // CONSUME. After this returns valid, any failure below is LOSS.
        val consumed = consumePendingReceiveRequest(vfs, session.requestIdHex, ConsumeInput(unpacked.pairId, session.packageIdentity, SptTime.format(nowI)), nowI)
        if (consumed !is SptReceiverState.Consumed) {
            throw SptRefused("spt-receive-loss", "TruePad could not safely record that this receive request was used, so the pad was not saved. The request cannot be used again — ask the sender to generate a new pad and start a new transfer.")
        }
        try {
            importPair(label, session.padFileBytes)
        } catch (e: Exception) {
            throw SptRefused("spt-receive-loss", "The one-time receive request was used, but the pad did not finish saving (${e.message}). The request cannot be used again — ask the sender to generate a new pad and start a new transfer.")
        }
    }
}

/** True if this pad was delivered by sealed transfer — derived from the durable
 *  consumed.json marker (the sealed-ancestry fact for the deployment evaluator). */
fun Engine.sptPairArrivedSealed(pairId: String): Boolean = pairArrivedSealed(sptVfs(), pairId)

/** True if this pad was SENT by sealed transfer — from its durable handoff.json.
 *  The sender's retained copy of a pad whose whole material was sealed and sent
 *  has, by that act, had that material cross the computational X-Wing channel; it
 *  is only computationally confidential, exactly as the receiver's copy is, and is
 *  equally disqualifying (NOT ELIGIBLE) — the "sealed .tps2 is computational
 *  delivery, end to end" thesis, and the sender is one end.
 *
 *  FAILS CLOSED. Unlike the receiver-side `pairArrivedSealed` — which mirrors the
 *  frozen Browser Edition and can lean on a source/storage disqualifier as a
 *  backstop — an Android generated-here pad may be EXTERNAL_DECLARED, so this
 *  sealed-ancestry fact is the SOLE disqualifier. A torn/tampered handoff.json
 *  must therefore NOT let the verdict flip back to a stronger one: an honesty
 *  evaluator may only ever under-claim. So an UnreadableSpent marker counts as
 *  sent-sealed too — consistent with the handoff module, where a present-but-torn
 *  marker is already "spent, not absent" and blocks any further handoff. A
 *  PHYSICAL handoff (the eligible air-gapped route) is deliberately NOT this; the
 *  rare cost is a physically-handed pad whose marker later corrupts reading
 *  NOT ELIGIBLE instead of its true verdict — the safe direction. */
fun Engine.sptPairSentSealed(pairId: String): Boolean =
    when (sptReadHandoffState(sptVfs(), pairId)) {
        is SptHandoffState.Sealed -> true
        is SptHandoffState.UnreadableSpent -> true
        is SptHandoffState.Physical -> false
        SptHandoffState.Absent -> false
    }

