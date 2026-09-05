package dev.systemslibrarian.truepad.storage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE REUSE DEFECT THIS CLOSES, stated as the scenario that produced it.
 *
 * The Browser Edition pins the role per pair at acquisition and the CLI refuses
 * to guess. Android carried a single GLOBAL `UiState.role = Party2.A` — not even
 * per pad — so two devices holding one pair both burned `A_TO_B` at the same
 * offsets against the same one-time authentication record.
 *
 * No engine could catch it: each store's counters advance monotonically on its
 * own copy, so the reuse is ACROSS copies, not within a store. That is why the
 * guard has to live above the engine, and why it is tested here.
 */
class PartyRoleTest {

    @Test
    fun `the role is derived from how the pad was acquired`() {
        assertEquals(Party2.A, PartyRole.derive(PairOrigin.GENERATED_HERE))
        assertEquals(Party2.B, PartyRole.derive(PairOrigin.IMPORTED))
    }

    /**
     * AN UNKNOWN ORIGIN MUST NOT DEFAULT TO A. Returning A here would reinstate
     * the defect for exactly the pads most likely to be wrong — the ones whose
     * provenance evidence was lost. Refusing costs LOSS, which this project
     * accepts. Guessing costs REUSE, which it does not.
     */
    @Test
    fun `an unknown origin refuses to guess`() {
        assertNull(PartyRole.derive(PairOrigin.UNKNOWN))
        assertTrue(PartyRole.UNKNOWN_ORIGIN_PROMPT.isNotEmpty())
    }

    /** Two copies of one pair must never be the same party. */
    @Test
    fun `the creator and the importer are opposite halves`() {
        val creator = PartyRole.derive(PairOrigin.GENERATED_HERE)
        val importer = PartyRole.derive(PairOrigin.IMPORTED)
        assertNotEquals(creator, importer)
    }

    /**
     * Every origin is mapped deliberately. A new enum constant must be an
     * explicit decision, not an accident that silently picks a side.
     */
    @Test
    fun `every origin has a considered answer`() {
        for (origin in PairOrigin.entries) {
            val role = PartyRole.derive(origin)
            when (origin) {
                PairOrigin.UNKNOWN -> assertNull("UNKNOWN must not resolve to a party", role)
                else -> assertTrue("a known origin must resolve to a party", role != null)
            }
        }
    }
}
