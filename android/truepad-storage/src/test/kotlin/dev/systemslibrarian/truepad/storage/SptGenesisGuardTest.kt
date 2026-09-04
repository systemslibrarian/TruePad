package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.core.EnvelopeV2
import dev.systemslibrarian.truepad.core.encodeEnvelope2
import dev.systemslibrarian.truepad.spt.HandoffState
import dev.systemslibrarian.truepad.spt.SptRefused
import dev.systemslibrarian.truepad.spt.RequestClaimState
import dev.systemslibrarian.truepad.spt.readHandoffState
import dev.systemslibrarian.truepad.spt.readRequestClaim
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A SEALED TRANSFER SENDS THE WHOLE PAD, SO THE PAD MUST BE PRISTINE — and
 * "pristine" is all THREE counters, not two.
 *
 * `requirePadSealable` used to test only `nextOffset == 0 && nextSequence == 0`.
 * A pad that took a FAILED OPEN at genesis passes both of those and is NOT
 * pristine: it has already spent part of its pair-wide freeze budget, and one
 * record carries a durably recorded verification attempt. Sealing it hands the
 * receiver a store whose §5 forgery bound is already partly consumed, with no way
 * for them to tell.
 *
 * The frozen authority — src/browser/engine/verbs.ts `requirePadSealable` — has
 * always tested `nextOffset !== 0 || nextSequence !== 0 || attemptsReserved !== 0`.
 * Android omitted the third arm, so Android sealed pads the Browser refuses.
 *
 * LOSS IS ACCEPTABLE; REUSE IS NOT — and shipping a partly-spent attempt budget
 * to someone who believes it is fresh is on the wrong side of that line.
 */
class SptGenesisGuardTest {

    /** SPT refuses with SptRefused, which is NOT an EngineRefused, so the shared
     *  `refusalOf` helper does not catch it. */
    private fun sptRefusalOf(body: () -> Unit): SptRefused = try {
        body()
        error("expected an SptRefused, but the operation succeeded")
    } catch (e: SptRefused) {
        e
    }

    private fun sender() = fixedEngine(MemoryFs())
    private fun receiver() = fixedEngine(MemoryFs())

    private fun Engine.freshPad(label: String): String =
        gen(label, traceSources(256, 4), 256, 4, witnessKind = WitnessKind.LOCAL).pair.pairId

    /**
     * Drive exactly one FAILED open against the pad's receiving half.
     *
     * The envelope is well-formed enough to pass O0 (structure), O1 (window) and
     * O2 (state gates) and to reach O3, where the attempt is durably reserved,
     * before failing at O4 on the tag. That is precisely the state the old guard
     * could not see: the reservation lands, and neither cursor moves.
     */
    private fun Engine.spendOneAttemptAtGenesis(pairId: String) {
        val envelope = encodeEnvelope2(
            EnvelopeV2(
                pairId = pairId,
                direction = Direction.B_TO_A, // party A opens with B->A
                sequence = 0,
                startOffset = 0,
                ciphertextLength = 4,
                ciphertext = byteArrayOf(1, 2, 3, 4),
                tag = ByteArray(16), // deliberately not the real tag
            ),
        )
        assertEquals("auth-failed", refusalOf { open(pairId, Party2.A, envelope) }.reason)
    }

    private fun Engine.countersOf(pairId: String, direction: Direction): Triple<Long, Long, Long> {
        val half = loadPair(pairId).getValue(direction)
        return Triple(
            half.effective.nextOffset,
            half.effective.nextSequence,
            half.effective.attemptsReserved,
        )
    }

    /** The exact state the old guard was blind to, stated as a precondition. */
    @Test
    fun aFailedOpenLeavesBothCursorsAtZeroButSpendsAnAttempt() {
        val alice = sender()
        val pairId = alice.freshPad("precondition")
        alice.spendOneAttemptAtGenesis(pairId)

        val (offset, sequence, attempts) = alice.countersOf(pairId, Direction.B_TO_A)
        assertEquals("nextOffset must still read genesis", 0L, offset)
        assertEquals("nextSequence must still read genesis", 0L, sequence)
        assertTrue("but an attempt has been durably reserved", attempts > 0L)
    }

    /** THE FIX. A pad with a spent attempt is no longer sealable. */
    @Test
    fun aPadWithASpentAttemptIsRefusedEvenThoughBothCursorsReadGenesis() {
        val alice = sender()
        val bob = receiver()
        val pairId = alice.freshPad("to bob")
        alice.spendOneAttemptAtGenesis(pairId)

        val request = bob.sptCreateReceiveRequest()
        val review = alice.sptReviewRequest(request.tpr2Text)
        alice.sptConfirmRequest(review.canonicalBody)

        val refusal = sptRefusalOf { alice.sptSeal(review.requestHashHex, pairId) }
        assertEquals("spt-pad-ineligible", refusal.reason)
        assertTrue(
            "the refusal should say the pad has been used: ${refusal.message}",
            (refusal.message ?: "").contains("already been used"),
        )
    }

    /** The refusal is PRE-SEAL and PRE-OUTPUT: nothing is claimed, nothing committed. */
    @Test
    fun theRefusalLeavesNoHandoffAndNoRequestClaim() {
        val fs = MemoryFs()
        val alice = fixedEngine(fs)
        val bob = receiver()
        val pairId = alice.freshPad("to bob")
        alice.spendOneAttemptAtGenesis(pairId)

        val request = bob.sptCreateReceiveRequest()
        val review = alice.sptReviewRequest(request.tpr2Text)
        alice.sptConfirmRequest(review.canonicalBody)
        sptRefusalOf { alice.sptSeal(review.requestHashHex, pairId) }

        val vfs = FsSptVfs(fs)
        assertTrue(
            "a refused seal must leave the pad's handoff ABSENT — the pad has not left",
            readHandoffState(vfs, pairId) is HandoffState.Absent,
        )
        assertTrue(
            "a refused seal must not claim the request; the receiver may still use it",
            readRequestClaim(vfs, thex(review.requestHashHex)) is RequestClaimState.Absent,
        )
        assertTrue(
            "no handoff marker file may exist at all",
            !fs.exists("$pairId/handoff.json"),
        )
    }

    /** The guard must not over-refuse: a genuinely pristine pad still seals. */
    @Test
    fun aGenuinelyPristinePadStillSeals() {
        val alice = sender()
        val bob = receiver()
        val pairId = alice.freshPad("to bob")

        val (offset, sequence, attempts) = alice.countersOf(pairId, Direction.B_TO_A)
        assertEquals(0L, offset)
        assertEquals(0L, sequence)
        assertEquals("a fresh pad has reserved no attempts", 0L, attempts)

        val request = bob.sptCreateReceiveRequest()
        val review = alice.sptReviewRequest(request.tpr2Text)
        alice.sptConfirmRequest(review.canonicalBody)
        val seal = alice.sptSeal(review.requestHashHex, pairId)
        assertTrue("a pristine pad must still seal", seal.packageBytes.isNotEmpty())
    }

    /**
     * BROWSER/ANDROID PARITY, driven through the REAL engine so the divergence
     * cannot return silently.
     *
     * An earlier version of this test transcribed the authority's predicate into
     * the test body and compared it with a transcription of Kotlin's. That proved
     * nothing: it passed happily with the bug reinstated, because it never touched
     * SptEngine at all. A parity test that cannot fail when the implementation
     * changes is worse than no parity test, because it reads like protection.
     *
     * This version puts a real pad into each "used" state and asks the real
     * sptSeal, so re-narrowing the guard fails here.
     */
    @Test
    fun everyUsedCounterStateIsRefusedByTheRealEngine() {
        // src/browser/engine/verbs.ts requirePadSealable:
        //   used = nextOffset !== 0 || nextSequence !== 0 || attemptsReserved !== 0
        //
        // Each case below reaches one of those arms through ordinary operation.
        val cases: List<Pair<String, (Engine, String) -> Unit>> = listOf(
            "attempt spent (offset and sequence still zero)" to { e, p -> e.spendOneAttemptAtGenesis(p) },
            "offset and sequence spent by a real send" to { e, p ->
                e.burn(p, Party2.A, "spent".toByteArray())
                Unit
            },
        )

        for ((label, makeUsed) in cases) {
            val alice = sender()
            val bob = receiver()
            val pairId = alice.freshPad("parity: $label")
            makeUsed(alice, pairId)

            val request = bob.sptCreateReceiveRequest()
            val review = alice.sptReviewRequest(request.tpr2Text)
            alice.sptConfirmRequest(review.canonicalBody)

            val refusal = sptRefusalOf { alice.sptSeal(review.requestHashHex, pairId) }
            assertEquals("$label: must be refused as ineligible", "spt-pad-ineligible", refusal.reason)
            assertTrue(
                "$label: must be refused for being USED, not for some other reason",
                (refusal.message ?: "").contains("already been used"),
            )
        }
    }
}
