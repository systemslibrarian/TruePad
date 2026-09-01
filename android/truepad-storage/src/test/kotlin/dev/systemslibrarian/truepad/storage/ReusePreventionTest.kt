package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.core.EnvelopeDecode
import dev.systemslibrarian.truepad.core.VERIFY_ATTEMPT_LIMIT_DEFAULT
import dev.systemslibrarian.truepad.core.decodeEnvelope2
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE CENTRAL INVARIANT.
 *
 *     LOSS IS ACCEPTABLE. REUSE IS NOT.
 *
 * Every test here asks the same question in a different way: can any sequence of
 * operations, crashes, retries, or restores cause one region of encryption
 * material — or one authentication record — to be used twice?
 */
class ReusePreventionTest {

    private fun engine(fs: Fs) = fixedEngine(fs)

    private fun freshPair(fs: MemoryFs, capacity: Long = 512, records: Long = 8, recordBytes: Int? = null): Engine {
        val e = engine(fs)
        e.gen("reuse", traceSources(capacity, records), capacity, records, recordBytes, WitnessKind.LOCAL)
        return e
    }

    private fun region(envelope: String): Pair<Long, LongRange> {
        val env = (decodeEnvelope2(envelope) as EnvelopeDecode.Ok).envelope
        return env.sequence to (env.startOffset until env.startOffset + env.ciphertextLength)
    }

    /** Every emitted envelope must occupy a region disjoint from every other. */
    private fun assertNoOverlap(envelopes: List<String>) {
        val seenSequences = HashSet<Long>()
        val used = ArrayList<LongRange>()
        for (e in envelopes) {
            val (seq, range) = region(e)
            assertTrue("sequence $seq was emitted twice", seenSequences.add(seq))
            for (prior in used) {
                val overlaps = range.first <= prior.last && prior.first <= range.last
                assertFalse("encryption region $range overlaps $prior — PAD REUSE", overlaps && !range.isEmpty())
            }
            used.add(range)
        }
    }

    @Test
    fun sendConsumesExactlyOneAllowedRegionAndNoMore() {
        val fs = MemoryFs()
        val e = freshPair(fs)
        var expectedOffset = 0L
        val envelopes = ArrayList<String>()
        for (i in 0 until 8) {
            val body = "message number $i".toByteArray()
            val size = body.size
            val r = e.burn(FIXED_PAIR_ID, Party2.A, body)
            val (seq, range) = region(r.envelope)
            assertEquals("one auth record per send", 1, r.authRecords)
            assertEquals("exactly the plaintext's bytes", size, r.encryptionBytes)
            assertEquals("sequences are consecutive", i.toLong(), seq)
            assertEquals("offsets are contiguous", expectedOffset, range.first)
            expectedOffset += size
            envelopes.add(r.envelope)
            val m = e.status(FIXED_PAIR_ID).meters.getValue(Direction.A_TO_B)
            assertEquals(expectedOffset, m.nextOffset)
            assertEquals(i + 1L, m.nextSequence)
        }
        assertNoOverlap(envelopes)
        // Auth records are the binding budget here: the 9th send is refused.
        assertEquals("auth-exhausted", refusalOf { e.burn(FIXED_PAIR_ID, Party2.A, "one more".toByteArray()) }.reason)
    }

    /**
     * A "retry" after a successful burn is a NEW burn. It must never re-emit the
     * previous region — the operator who did not see the first envelope has lost
     * that material, and that is the accepted price.
     */
    @Test
    fun aRetryAfterASuccessfulBurnNeverReusesTheRegion() {
        val fs = MemoryFs()
        val e = freshPair(fs)
        val first = e.burn(FIXED_PAIR_ID, Party2.A, "same text".toByteArray()).envelope
        val second = e.burn(FIXED_PAIR_ID, Party2.A, "same text".toByteArray()).envelope
        assertFalse("identical plaintext must not produce an identical envelope", first == second)
        assertNoOverlap(listOf(first, second))
    }

    /**
     * A crash at ANY durable point in a burn, followed by a reload and a retry:
     * whatever was emitted before the crash must never share a region with what
     * is emitted after it. Both timings are exercised — the write that never
     * landed, and the write that landed just before the process died.
     */
    @Test
    fun noCrashPointInBurnCanCauseReuse() {
        data class Point(val op: String, val file: String, val timing: When)
        val points = listOf(
            Point("writeFileAtomic", HEAD_FILE, When.BEFORE),
            Point("writeFileAtomic", HEAD_FILE, When.AFTER),
            Point("appendFile", JOURNAL_FILE, When.BEFORE),
            Point("appendFile", JOURNAL_FILE, When.AFTER),
            Point("appendFile", "witness/", When.BEFORE),
            Point("appendFile", "witness/", When.AFTER),
        )
        for (p in points) {
            val fs = MemoryFs()
            freshPair(fs)
            val emitted = ArrayList<String>()
            // Two clean burns first, so the crash lands mid-life, not at genesis.
            val clean = engine(fs)
            emitted.add(clean.burn(FIXED_PAIR_ID, Party2.A, "before one".toByteArray()).envelope)
            emitted.add(clean.burn(FIXED_PAIR_ID, Party2.A, "before two".toByteArray()).envelope)

            val faulty = FaultFs(fs, p.op, { it.contains(p.file) }, ordinal = 1, timing = p.timing)
            var crashed = false
            try {
                engine(faulty).burn(FIXED_PAIR_ID, Party2.A, "the crashing one".toByteArray())
            } catch (_: InjectedCrash) {
                crashed = true
            }
            assertTrue("the fault at ${p.op}:${p.file}/${p.timing} did not fire", crashed)
            // The envelope from the crashed burn NEVER left the call, so it is not
            // in `emitted`. The store must now be reloadable and must not hand out
            // a region any emitted envelope already used.
            val after = engine(fs)
            emitted.add(after.burn(FIXED_PAIR_ID, Party2.A, "after the crash".toByteArray()).envelope)
            emitted.add(after.burn(FIXED_PAIR_ID, Party2.A, "and one more".toByteArray()).envelope)
            assertNoOverlap(emitted)
        }
    }

    /**
     * O3: the verification attempt is durable BEFORE the tag is checked. A crash
     * between the reservation and the verdict must still cost the attempt — that
     * is what bounds an attacker's guesses across restarts (§5, §8.3).
     */
    @Test
    fun anAttemptIsReservedDurablyBeforeVerification() {
        val fs = MemoryFs()
        val a = freshPair(fs)
        // Courier the pad at genesis, THEN burn: the receiver must still be at
        // sequence 0 for the envelope to be in its window.
        val bobFs = MemoryFs()
        engine(bobFs).importPair("bob", a.exportPair(FIXED_PAIR_ID).container)
        val env = a.burn(FIXED_PAIR_ID, Party2.A, "for bob".toByteArray()).envelope

        // Crash immediately AFTER the attempt line is appended, before the verdict.
        val faulty = FaultFs(bobFs, "appendFile", { it.endsWith(JOURNAL_FILE) }, ordinal = 1, timing = When.AFTER)
        try {
            engine(faulty).open(FIXED_PAIR_ID, Party2.B, env)
            error("the fault did not fire")
        } catch (_: InjectedCrash) {
        }
        val loaded = loadStore(bobFs, storeDir(FIXED_PAIR_ID, Direction.A_TO_B)) as LoadResult.Ok
        assertEquals("the reservation survived the crash", 1L, loaded.store.effective.attemptsReserved)
        assertEquals(1L, loaded.store.effective.attempts[0L])
        assertEquals("no material was consumed", 0L, loaded.store.effective.nextOffset)
        assertEquals(0L, loaded.store.effective.nextSequence)

        // The retry succeeds but the attempt budget is one lower for good.
        val bob = engine(bobFs)
        assertEquals("for bob", String(bob.open(FIXED_PAIR_ID, Party2.B, env).plaintext))
    }

    /** The attempt budget is finite and per-record, and it does not refill. */
    @Test
    fun aContestedRecordIsPermanentlyContested() {
        val fs = MemoryFs()
        val a = freshPair(fs)
        val container = a.exportPair(FIXED_PAIR_ID).container
        val env = a.burn(FIXED_PAIR_ID, Party2.A, "genuine".toByteArray()).envelope
        val bobFs = MemoryFs()
        val bob = engine(bobFs)
        bob.importPair("bob", container)

        val tampered = tamperTag(env)
        val limit = VERIFY_ATTEMPT_LIMIT_DEFAULT
        for (i in 0 until limit) {
            assertEquals("auth-failed", refusalOf { bob.open(FIXED_PAIR_ID, Party2.B, tampered) }.reason)
        }
        // The budget is spent: even the GENUINE envelope can never be opened now.
        assertEquals("sequence-contested", refusalOf { bob.open(FIXED_PAIR_ID, Party2.B, tampered) }.reason)
        assertEquals("sequence-contested", refusalOf { bob.open(FIXED_PAIR_ID, Party2.B, env) }.reason)
        // Reloading from disk does not refill it.
        assertEquals("sequence-contested", refusalOf { engine(bobFs).open(FIXED_PAIR_ID, Party2.B, env) }.reason)
    }

    /**
     * §9.4 / §15: a backup-restore that rolls the pair store back is the classic
     * reuse vector. With a witness provisioned, it is caught before anything is
     * consumed. This is the property the whole Witness module exists for.
     */
    @Test
    fun aRestoredStoreIsRefusedBeforeAnythingIsConsumed() {
        val fs = MemoryFs()
        val e = freshPair(fs)
        val before = e.burn(FIXED_PAIR_ID, Party2.A, "first".toByteArray()).envelope

        // Back up ONLY the pair directory — exactly what a per-app backup takes.
        val pairPaths = allPaths(fs, FIXED_PAIR_ID).filterNot { it.startsWith("witness/") }
        val backup = snapshot(fs, pairPaths)

        val after = e.burn(FIXED_PAIR_ID, Party2.A, "second".toByteArray()).envelope
        assertNoOverlap(listOf(before, after))

        // Restore the pair store. The witness, in its own directory, is untouched.
        restore(fs, backup)
        val restored = engine(fs)
        val refusal = refusalOf { restored.burn(FIXED_PAIR_ID, Party2.A, "would reuse".toByteArray()) }
        assertEquals("witness-regressed", refusal.reason)
        assertTrue(refusal.text.contains("Nothing was burned"))
        assertEquals("witness-regressed", refusalOf { restored.retire(FIXED_PAIR_ID, Direction.A_TO_B, 3) }.reason)
        // An open is refused too — the gate is on the state, not on the verb.
        // `after` is at sequence 1, which the restored store still considers
        // in-window, so it reaches the O2 witness gate rather than stopping at O1.
        assertEquals("witness-regressed", refusalOf { restored.open(FIXED_PAIR_ID, Party2.B, after) }.reason)
        // ORDER MATTERS: the free O1 window checks come BEFORE the witness gate,
        // so a replayed record is still reported as replayed, not as a rollback.
        // Diagnosing a restored store must not hide a replay, or vice versa.
        assertEquals("sequence-retired", refusalOf { restored.open(FIXED_PAIR_ID, Party2.B, before) }.reason)
    }

    /**
     * A restore that rolls back ONLY the attempt budget — leaving the high-waters
     * alone — would hand an attacker verifyAttemptLimit fresh guesses per restore.
     * attemptsReserved is the counter that closes it (§15.1).
     */
    @Test
    fun aRestoreCannotRefillTheAttemptBudget() {
        val fs = MemoryFs()
        val a = freshPair(fs)
        val container = a.exportPair(FIXED_PAIR_ID).container
        val env = a.burn(FIXED_PAIR_ID, Party2.A, "genuine".toByteArray()).envelope

        val bobFs = MemoryFs()
        engine(bobFs).importPair("bob", container)
        val bob = engine(bobFs)
        val tampered = tamperTag(env)

        val pairPaths = allPaths(bobFs, FIXED_PAIR_ID).filterNot { it.startsWith("witness/") }
        val fresh = snapshot(bobFs, pairPaths)

        repeat(3) { assertEquals("auth-failed", refusalOf { bob.open(FIXED_PAIR_ID, Party2.B, tampered) }.reason) }
        val spent = loadStore(bobFs, storeDir(FIXED_PAIR_ID, Direction.A_TO_B)) as LoadResult.Ok
        assertEquals(3L, spent.store.effective.attemptsReserved)

        // Roll the pair store back to before the guesses. The high-waters never
        // moved, so ONLY attemptsReserved can detect this.
        restore(bobFs, fresh)
        val rolled = loadStore(bobFs, storeDir(FIXED_PAIR_ID, Direction.A_TO_B)) as LoadResult.Ok
        assertEquals("the rollback did reset the budget on disk", 0L, rolled.store.effective.attemptsReserved)
        assertEquals("the high-waters are unchanged, so only attemptsReserved can catch this", 0L, rolled.store.effective.nextSequence)

        assertEquals("witness-regressed", refusalOf { engine(bobFs).open(FIXED_PAIR_ID, Party2.B, tampered) }.reason)
    }

    /** Retirement destroys material unused; it can never be walked back. */
    @Test
    fun retirementIsMonotoneAndCannotBeUndone() {
        val fs = MemoryFs()
        val e = freshPair(fs)
        e.retire(FIXED_PAIR_ID, Direction.A_TO_B, 3, throughOffset = 99, reason = "lost in transit")
        val m = e.status(FIXED_PAIR_ID).meters.getValue(Direction.A_TO_B)
        assertEquals(4L, m.nextSequence)
        assertEquals(100L, m.nextOffset)
        assertEquals("sequence-retired", refusalOf { e.retire(FIXED_PAIR_ID, Direction.A_TO_B, 2) }.reason)
        // A burn after retirement starts past the retired region.
        val (seq, range) = region(e.burn(FIXED_PAIR_ID, Party2.A, "after retire".toByteArray()).envelope)
        assertEquals(4L, seq)
        assertEquals(100L, range.first)
        // And the header cannot be talked backwards: a hand-rolled regression is
        // refused against the journal's own history.
        val head = textAt(fs, headPath(FIXED_PAIR_ID, Direction.A_TO_B))
        fs.writeFileAtomic(
            headPath(FIXED_PAIR_ID, Direction.A_TO_B),
            head.replace("\"nextSequence\":5", "\"nextSequence\":1").toByteArray(),
        )
        val r = loadStore(fs, storeDir(FIXED_PAIR_ID, Direction.A_TO_B))
        assertTrue(r is LoadResult.Refusal)
        assertEquals("regressed-below-mark", (r as LoadResult.Refusal).reason)
    }

    /** A one-time pad cannot borrow, wrap, or reuse when it runs out. */
    @Test
    fun exhaustionRefusesRatherThanWrapping() {
        val fs = MemoryFs()
        val e = engine(fs)
        e.gen("tiny", traceSources(16, 4), 16, 4, witnessKind = WitnessKind.LOCAL)
        e.burn(FIXED_PAIR_ID, Party2.A, ByteArray(10))
        val refusal = refusalOf { e.burn(FIXED_PAIR_ID, Party2.A, ByteArray(10)) }
        assertEquals("encryption-exhausted", refusal.reason)
        assertTrue(refusal.text.contains("cannot borrow, wrap, or reuse"))
        // The refusal cost nothing: the store is exactly where it was.
        assertEquals(10L, e.status(FIXED_PAIR_ID).meters.getValue(Direction.A_TO_B).nextOffset)
        // Six bytes remain, and they are still spendable.
        assertEquals(6, e.burn(FIXED_PAIR_ID, Party2.A, ByteArray(6)).encryptionBytes)
    }
}
