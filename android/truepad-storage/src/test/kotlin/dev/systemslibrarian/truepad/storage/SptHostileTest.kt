package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.spt.ReceiverState as SptReceiverState
import dev.systemslibrarian.truepad.spt.SptRefused
import dev.systemslibrarian.truepad.spt.SptTime
import dev.systemslibrarian.truepad.spt.readReceiverState as sptReadReceiverState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/**
 * SEALED TRANSFER UNDER HOSTILE AND CRASHING CONDITIONS.
 *
 * The happy path is proven in SptRoundTripTest; this is the other half — every
 * verb must FAIL CLOSED, and a crash must lose the transfer without ever letting
 * a request or a package be reused. LOSS IS ACCEPTABLE; REUSE IS NOT.
 */
class SptHostileTest {

    private fun sender() = fixedEngine(MemoryFs())
    private fun receiver() = fixedEngine(MemoryFs())

    private fun Engine.freshPad(label: String): String =
        gen(label, traceSources(256, 4), 256, 4, witnessKind = WitnessKind.LOCAL).pair.pairId

    private fun sptRefusalOf(body: () -> Unit): SptRefused = try {
        body()
        error("expected an SptRefused, but the operation succeeded")
    } catch (e: SptRefused) {
        e
    }

    /** Drive a real sender+receiver up to a sealed package, ready to be attacked. */
    private data class Staged(
        val alice: Engine,
        val bob: Engine,
        val pairId: String,
        val requestHashHex: String,
        val packageBytes: ByteArray,
    )

    private fun stageSeal(): Staged {
        val alice = sender()
        val bob = receiver()
        val pairId = alice.freshPad("staged")
        val request = bob.sptCreateReceiveRequest()
        val review = alice.sptReviewRequest(request.tpr2Text)
        alice.sptConfirmRequest(review.canonicalBody)
        val seal = alice.sptSeal(review.requestHashHex, pairId)
        return Staged(alice, bob, pairId, review.requestHashHex, seal.packageBytes)
    }

    /* ---- malformed / corrupt wire ------------------------------------------- */

    @Test
    fun aMalformedReceiveCodeIsRefused() {
        val alice = sender()
        for (bad in listOf("", "TPR2:", "not a code", "TPR2:!!!!not-base64url!!!!", "TP2:wrongprefix")) {
            val refusal = sptRefusalOf { alice.sptReviewRequest(bad) }
            assertEquals("spt-request-unavailable", refusal.reason)
        }
    }

    @Test
    fun aMalformedSealedPackageIsRefused() {
        val bob = receiver()
        for (bad in listOf(ByteArray(0), ByteArray(10), ByteArray(50) { 0x7f }, ByteArray(2000))) {
            val refusal = sptRefusalOf { bob.sptOpen(bad) }
            assertTrue(
                "a malformed package must be refused as malformed, was ${refusal.reason}",
                refusal.reason == "spt-package-malformed",
            )
        }
    }

    @Test
    fun aPackageForADifferentRequestIsRefused() {
        val staged = stageSeal()
        // A SECOND, unrelated receiver with its own request. The package sealed to
        // the first receiver must not open against the second's request.
        val other = receiver()
        other.sptCreateReceiveRequest()
        val refusal = sptRefusalOf { other.sptOpen(staged.packageBytes) }
        // The second receiver has no record of this package's request id at all.
        assertEquals("spt-request-unavailable", refusal.reason)
    }

    @Test
    fun aCorruptedSealedPackageIsRefused() {
        val staged = stageSeal()
        // Flip the final ciphertext byte: the request authority still resolves, so
        // this reaches the AEAD, which must reject it — not silently release a pad.
        val corrupt = staged.packageBytes.copyOf()
        corrupt[corrupt.size - 1] = (corrupt[corrupt.size - 1].toInt() xor 0x01).toByte()
        val refusal = sptRefusalOf { staged.bob.sptOpen(corrupt) }
        assertEquals("spt-package-open-failed", refusal.reason)
        // And the request is untouched — a fresh, correct open still works.
        val session = staged.bob.sptOpen(staged.packageBytes)
        assertEquals(staged.pairId, session.pairId)
    }

    @Test
    fun aTamperedHeaderIsRefused() {
        val staged = stageSeal()
        // Flip a byte inside the header (the AAD): parse may still pass, but the
        // request-hash binding or the AEAD's AAD check must fail. Either way, no pad.
        val tampered = staged.packageBytes.copyOf()
        tampered[40] = (tampered[40].toInt() xor 0x01).toByte()
        val refusal = sptRefusalOf { staged.bob.sptOpen(tampered) }
        assertTrue(
            "a tampered header must be refused, was ${refusal.reason}",
            refusal.reason in setOf("spt-package-malformed", "spt-request-unavailable", "spt-package-open-failed"),
        )
    }

    /* ---- provenance / laundering -------------------------------------------- */

    @Test
    fun aPadReceivedBySealedTransferCannotBeSealedOnwardOrExported() {
        // Alice seals to Bob; Bob imports. Bob's pad is imported (not generated
        // here), and it arrived sealed — it must not be re-sealed to anyone, and it
        // must not be exported as a file either. No provenance laundering.
        val alice = sender()
        val bob = receiver()
        val pairId = alice.freshPad("laundering")
        val request = bob.sptCreateReceiveRequest()
        val review = alice.sptReviewRequest(request.tpr2Text)
        alice.sptConfirmRequest(review.canonicalBody)
        val seal = alice.sptSeal(review.requestHashHex, pairId)
        val session = bob.sptOpen(seal.packageBytes)
        bob.sptCommitReceive(session, "from alice")

        // Bob now tries to seal the received pad to a fresh request of his own.
        val charlie = receiver()
        val charlieReq = charlie.sptCreateReceiveRequest()
        val charlieReview = bob.sptReviewRequest(charlieReq.tpr2Text)
        bob.sptConfirmRequest(charlieReview.canonicalBody)
        val sealRefusal = sptRefusalOf { bob.sptSeal(charlieReview.requestHashHex, pairId) }
        assertEquals("spt-pad-ineligible", sealRefusal.reason)

        // And it cannot be handed off as a plain file either.
        val exportRefusal = refusalOf { bob.exportPair(pairId) }
        assertEquals("imported-pair-cannot-export", exportRefusal.reason)

        // The sealed-ancestry fact is still true and disqualifying.
        assertTrue(bob.sptPairArrivedSealed(pairId))
    }

    /* ---- expiry ------------------------------------------------------------- */

    @Test
    fun anExpiredRequestRefusesOpenAndBecomesTerminal() {
        val alice = sender()
        val bobFs = MemoryFs()
        val bob = fixedEngine(bobFs)
        val pairId = alice.freshPad("expiry")
        val request = bob.sptCreateReceiveRequest()
        val review = alice.sptReviewRequest(request.tpr2Text)
        alice.sptConfirmRequest(review.canonicalBody)
        val seal = alice.sptSeal(review.requestHashHex, pairId)

        // A NEW receiver engine over the same store, but with a clock eight days
        // on — past the 7-day TTL. Opening must refuse expired and cancel it.
        val later = Instant.parse(FIXED_NOW).plusMillis(SptTime.REQUEST_TTL_MS + 86_400_000L)
        val bobLater = Engine(bobFs, bobFs, clock = { later }, pairIdSource = { thex(FIXED_PAIR_ID) })
        val refusal = sptRefusalOf { bobLater.sptOpen(seal.packageBytes) }
        assertEquals("spt-request-expired", refusal.reason)

        // The request is now durably cancelled: a second attempt is not "expired"
        // again but a terminal refusal, and it can never receive a pad.
        val second = sptRefusalOf { bobLater.sptOpen(seal.packageBytes) }
        assertEquals("spt-request-cancelled", second.reason)
    }

    /* ---- crash: loss, never reuse ------------------------------------------- */

    @Test
    fun aCrashImportingAfterConsumeIsLossNotReuse() {
        val alice = sender()
        val pairId = alice.freshPad("crash-loss")

        // Bob's store is fault-injected: the FIRST write into the imported pad's
        // a-to-b store throws, modelling a process death mid-import. Crucially the
        // consume marker (spt/receive/...) is written BEFORE that, so the request
        // is already consumed when the crash hits.
        val bobRaw = MemoryFs()
        val faulty = FaultFs(bobRaw, op = "writeFileAtomic", pathMatches = { it.contains("a-to-b") }, ordinal = 1, timing = When.BEFORE)
        val bob = fixedEngine(faulty)

        val request = bob.sptCreateReceiveRequest()
        val review = alice.sptReviewRequest(request.tpr2Text)
        alice.sptConfirmRequest(review.canonicalBody)
        val seal = alice.sptSeal(review.requestHashHex, pairId)
        val session = bob.sptOpen(seal.packageBytes)

        val loss = sptRefusalOf { bob.sptCommitReceive(session, "crashes") }
        assertEquals("spt-receive-loss", loss.reason)
        assertTrue("the crash actually fired", faulty.fired)

        // THE REQUEST IS CONSUMED, PERMANENTLY. A fresh receiver engine over the
        // same store (a restarted process) sees it consumed and refuses to open the
        // package again — the pad is lost, but nothing can be reused.
        val bobRestarted = fixedEngine(bobRaw)
        val reuse = sptRefusalOf { bobRestarted.sptOpen(seal.packageBytes) }
        assertEquals("spt-request-consumed", reuse.reason)

        // And the durable receiver record confirms the consumed terminal state.
        val state = sptReadReceiverState(FsSptVfs(bobRaw), request.requestIdHex, Instant.parse(FIXED_NOW))
        assertTrue("the request must be durably consumed", state is SptReceiverState.Consumed)
    }
}
