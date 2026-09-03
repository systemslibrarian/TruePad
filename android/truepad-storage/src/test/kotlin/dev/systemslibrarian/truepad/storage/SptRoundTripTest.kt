package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.Assessment
import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.spt.SptRefused
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE SEALED-PAD-TRANSFER END-TO-END PROOF (Android side).
 *
 * This drives the whole SPT durable protocol through the storage Engine — the
 * exact verbs the Android UI will call — with two independent stores standing in
 * for two devices across an air gap. Only bytes cross between them: the public
 * TPR2 receive request and the sealed .tps2 package. Everything else (the
 * one-time recipient key, the durable receiver/claim/handoff/confirmed
 * authorities) stays device-local, as it must.
 *
 * What it establishes, in the user's own order (steps 2 and 3 of the parity plan):
 *
 *   RECEIVE — the receiver creates a TPR2, the sender seals to it, the receiver
 *   opens and CONSUMES-before-import, the imported pad is a real working OTP pad,
 *   and the deployment evaluator PERMANENTLY marks it sealed/computational
 *   (NOT ELIGIBLE) via the durable consumed.json marker.
 *
 *   The confirmation ceremony matches across the gap: the twelve request words
 *   the sender reviews equal the twelve the receiver published, and the eight
 *   confirmation words the sender reads aloud equal the eight the receiver sees.
 *
 *   The protocol's non-reuse invariants hold: a request is consumed exactly once
 *   (a second open is refused), and a pad takes exactly one handoff (a re-seal to
 *   the SAME request returns the identical package — never new cryptography — and
 *   a sealed pad can no longer be physically exported).
 *
 * LOSS IS ACCEPTABLE; REUSE IS NOT. These tests are about the second half.
 */
class SptRoundTripTest {

    /** Two devices: a SENDER store (Alice) and a RECEIVER store (Bob). The clock
     *  is pinned so the 7-day request TTL never trips mid-test; the pairId is
     *  pinned only for Alice's gen (Bob adopts the pad's id on import). */
    private fun sender() = fixedEngine(MemoryFs())
    private fun receiver() = fixedEngine(MemoryFs())

    /** Alice makes a fresh, generated-here, genesis pad — the only kind sealable. */
    private fun Engine.freshPad(label: String): String {
        val gen = gen(label, traceSources(256, 4), 256, 4, witnessKind = WitnessKind.LOCAL)
        return gen.pair.pairId
    }

    @Test
    fun receivePadEndToEndAgainstAFreshSeal() {
        val alice = sender()
        val bob = receiver()
        val pairId = alice.freshPad("to bob, sealed")

        // RECEIVER publishes a one-time receive request (the TPR2 text is the QR /
        // paste payload; it carries only the PUBLIC recipient key).
        val request = bob.sptCreateReceiveRequest()
        assertTrue("the TPR2 is the wire receive code", request.tpr2Text.startsWith("TPR2:"))

        // SENDER reviews the scanned/pasted TPR2 and gets the twelve words to read.
        val review = alice.sptReviewRequest(request.tpr2Text)
        assertEquals("both sides derive the same request fingerprint", request.requestHashHex, review.requestHashHex)
        assertArrayEquals(
            "the twelve request words match across the gap",
            request.requestIndices, review.requestIndices,
        )

        // SENDER confirms the twelve-word match, then seals the whole pad to it.
        alice.sptConfirmRequest(review.canonicalBody)
        val seal = alice.sptSeal(review.requestHashHex, pairId)
        assertFalse("a first seal is a fresh seal, not a re-share", seal.reshared)

        // RECEIVER opens the sealed package into a transient session.
        val session = bob.sptOpen(seal.packageBytes)
        assertArrayEquals(
            "the eight confirmation words match across the gap",
            seal.confirmationIndices, session.confirmationIndices,
        )
        assertEquals("the sealed pad carries the right id", pairId, session.pairId)

        // RECEIVER consumes-then-imports. The returned summary is the live pad.
        val summary = bob.sptCommitReceive(session, "from alice (sealed)")
        assertEquals(pairId, summary.pairId)
        assertEquals("the received pad is recorded as imported", PairOrigin.IMPORTED, readPairMeta(bob.fs, pairId).origin)

        // THE SEALED-ANCESTRY FACT IS DURABLE AND DISQUALIFYING, both directions.
        assertTrue("Bob's pad is known to have arrived sealed", bob.sptPairArrivedSealed(pairId))
        assertFalse("Alice's generated pad did not arrive sealed", alice.sptPairArrivedSealed(pairId))
        for (d in Direction.entries) {
            val deployment = summary.meters.getValue(d).deployment
            assertEquals("sealed delivery is NOT ELIGIBLE ($d)", Assessment.NOT_ELIGIBLE, deployment.assessment)
            assertTrue(
                "the reason names sealed .tps2 delivery ($d): ${deployment.knownReason}",
                deployment.knownReason?.contains("sealed .tps2") == true,
            )
        }
        // Re-reading status independently gives the same permanent verdict.
        assertEquals(Assessment.NOT_ELIGIBLE, bob.status(pairId).meters.getValue(Direction.A_TO_B).deployment.assessment)

        // AND THE IMPORTED PAD IS A REAL, WORKING OTP PAD: an envelope Alice burns
        // on her copy opens on Bob's sealed-delivered copy, plaintext for plaintext.
        val env = alice.burn(pairId, Party2.A, "the pad works".toByteArray(Charsets.UTF_8)).envelope
        assertEquals("the pad works", String(bob.open(pairId, Party2.B, env).plaintext, Charsets.UTF_8))
    }

    @Test
    fun aReceiveRequestIsConsumedExactlyOnce() {
        val alice = sender()
        val bob = receiver()
        val pairId = alice.freshPad("consume once")

        val request = bob.sptCreateReceiveRequest()
        val review = alice.sptReviewRequest(request.tpr2Text)
        alice.sptConfirmRequest(review.canonicalBody)
        val seal = alice.sptSeal(review.requestHashHex, pairId)

        val session = bob.sptOpen(seal.packageBytes)
        bob.sptCommitReceive(session, "first and only import")

        // CONSUME-BEFORE-IMPORT: the request is now durably consumed, so a second
        // open of the very same package is refused — no second pad, ever.
        val reopen = try {
            bob.sptOpen(seal.packageBytes)
            error("a consumed request must not open again")
        } catch (e: SptRefused) {
            e
        }
        assertEquals("spt-request-consumed", reopen.reason)
    }

    @Test
    fun aPadTakesExactlyOneHandoff() {
        val alice = sender()
        val bob = receiver()
        val pairId = alice.freshPad("one handoff")

        val request = bob.sptCreateReceiveRequest()
        val review = alice.sptReviewRequest(request.tpr2Text)
        alice.sptConfirmRequest(review.canonicalBody)
        val first = alice.sptSeal(review.requestHashHex, pairId)

        // RE-SHARE to the SAME request returns the EXACT package (bytes and
        // confirmation words) — a fresh recipient never re-runs the cryptography.
        val again = alice.sptSeal(review.requestHashHex, pairId)
        assertTrue("the second seal to the same request is a re-share", again.reshared)
        assertArrayEquals("the re-shared package is byte-identical", first.packageBytes, again.packageBytes)
        assertArrayEquals("the confirmation words are unchanged", first.confirmationIndices, again.confirmationIndices)

        // A DIFFERENT receive request cannot claim the already-sealed pad.
        val other = receiver().sptCreateReceiveRequest()
        val otherReview = alice.sptReviewRequest(other.tpr2Text)
        assertNotEquals(review.requestHashHex, otherReview.requestHashHex)
        alice.sptConfirmRequest(otherReview.canonicalBody)
        val refusedReseal = try {
            alice.sptSeal(otherReview.requestHashHex, pairId)
            error("a sealed pad must not be sealed to a second request")
        } catch (e: SptRefused) {
            e
        }
        assertEquals("pad-already-sealed", refusedReseal.reason)

        // AND a sealed pad can no longer be handed off as a plain file — the two
        // handoff modes are mutually exclusive.
        val refusedExport = refusalOf { alice.exportPair(pairId) }
        assertTrue(
            "the export refusal explains the pad was already sealed: ${refusalOf { alice.exportPair(pairId) }.text}",
            refusedExport.text.contains("sealed", ignoreCase = true),
        )
    }

    @Test
    fun onlyAGeneratedHereGenesisPadCanBeSealed() {
        val alice = sender()
        val bob = receiver()
        val pairId = alice.freshPad("genesis only")

        val request = bob.sptCreateReceiveRequest()
        val review = alice.sptReviewRequest(request.tpr2Text)
        alice.sptConfirmRequest(review.canonicalBody)

        // Burn one message first, so the pad is no longer at genesis — a sealed
        // transfer sends the WHOLE pad, so a partly-spent pad is refused.
        alice.burn(pairId, Party2.A, "spend a little".toByteArray(Charsets.UTF_8))
        val refused = try {
            alice.sptSeal(review.requestHashHex, pairId)
            error("a spent pad must not be sealable")
        } catch (e: SptRefused) {
            e
        }
        assertEquals("spt-pad-ineligible", refused.reason)
    }
}
