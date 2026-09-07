package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.Direction
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * WHAT "MESSAGES YOU CAN STILL SEND" PROMISES, AND WHETHER IT KEEPS IT.
 *
 * FORMAT-V2 §16: on a FIXED store every send spends exactly F encryption bytes
 * and one authentication record however short the message — [Engine.burn] builds
 * a full F-byte frame, so `c` is always F. The message count is therefore bounded
 * by BOTH budgets: `min(remainingRecords, remainingBytes / F)`.
 *
 * Every engine reported `remainingRecords` alone. On a variable store that is a
 * true upper bound — a send can be one byte — so that half was always honest. On
 * a fixed store it overstated: a Small pad (E = 16,384 per direction, N = 64)
 * fixed at F = 4096 can send FOUR messages and then reported SIXTY, and the pad
 * list still said "Ready" for a pad that could never send again.
 *
 * THESE TESTS DO NOT RESTATE THE FORMULA — a test that recomputes it beside the
 * engine agrees with itself whatever either one says. The central test BURNS
 * UNTIL THE ENGINE REFUSES and checks that the number of sends it managed is
 * exactly the number the meter promised. That is the claim the operator reads,
 * checked against the only authority for it.
 */
class FixedRecordCapacityTest {

    private fun pair(fs: MemoryFs, capacity: Long, records: Long, recordBytes: Int? = null): Engine {
        val e = fixedEngine(fs)
        e.gen("capacity", traceSources(capacity, records), capacity, records, recordBytes, WitnessKind.LOCAL)
        return e
    }

    private fun meters(e: Engine): DirectionMeters =
        e.status(FIXED_PAIR_ID).meters.getValue(Direction.A_TO_B)

    /** Burn one-byte messages until the engine refuses; report how many landed. */
    private fun sendsUntilRefused(e: Engine): Pair<Int, String> {
        var count = 0
        while (count < 10_000) {
            try {
                e.burn(FIXED_PAIR_ID, Party2.A, byteArrayOf(0x41))
                count += 1
            } catch (r: EngineRefused) {
                return count to r.reason
            }
        }
        error("the engine never refused; the budget under test is not small enough to exhaust")
    }

    @Test
    fun aFixedStorePromisesExactlyTheSendsTheEngineWillAllow() {
        // F = 256 against E = 2048 affords eight sends, while one hundred records
        // survive — the two budgets disagree by 92, so the figure cannot be right
        // by coincidence.
        val e = pair(MemoryFs(), 2048, 100, recordBytes = 256)
        val promised = meters(e).maxRemainingSends
        assertEquals(8L, promised)

        val (count, reason) = sendsUntilRefused(e)
        assertEquals("the meter promised more sends than the engine allowed", promised, count.toLong())
        assertEquals("encryption-exhausted", reason)
        assertEquals(92L, meters(e).remainingRecords)
        assertEquals(0L, meters(e).maxRemainingSends)
    }

    @Test
    fun everyMessageCostsOneRecordWhateverItsLength() {
        // A fixed record's whole point is that a short message and a long one are
        // indistinguishable on the wire. They must be indistinguishable in the
        // budget too.
        val e = pair(MemoryFs(), 2048, 100, recordBytes = 256)
        assertEquals(8L, meters(e).maxRemainingSends)

        val short = e.burn(FIXED_PAIR_ID, Party2.A, ByteArray(1))
        assertEquals(256, short.encryptionBytes)
        assertEquals(7L, meters(e).maxRemainingSends)

        // 252 is F − 4, the largest plaintext this record can carry.
        val full = e.burn(FIXED_PAIR_ID, Party2.A, ByteArray(252))
        assertEquals(256, full.encryptionBytes)
        assertEquals(6L, meters(e).maxRemainingSends)
    }

    @Test
    fun theBoundaryDoesNotOfferOneMoreMessageThanTheBytesCanPayFor() {
        // 2048 / 768 = 2 remainder 512. After two sends 512 bytes remain — more
        // than nothing, and not enough for a record. The old figure counted the
        // 98 records that survive; not one of them can be spent.
        val e = pair(MemoryFs(), 2048, 100, recordBytes = 768)
        assertEquals(2L, meters(e).maxRemainingSends)
        e.burn(FIXED_PAIR_ID, Party2.A, ByteArray(1))
        e.burn(FIXED_PAIR_ID, Party2.A, ByteArray(1))

        val m = meters(e)
        assertEquals(512L, m.remainingBytes)
        assertEquals(98L, m.remainingRecords)
        assertEquals(0L, m.maxRemainingSends)
        assertEquals("encryption-exhausted",
                     refusalOf { e.burn(FIXED_PAIR_ID, Party2.A, ByteArray(1)) }.reason)
    }

    @Test
    fun theSmallPresetCaseTheReviewFound() {
        // E = 16,384 per direction and N = 64 are the Small preset; F = 4096 is
        // accepted by the create screen. Four sends — and the old figure said 64.
        val e = pair(MemoryFs(), 16_384, 64, recordBytes = 4096)
        assertEquals(4L, meters(e).maxRemainingSends)
        assertEquals(64L, meters(e).remainingRecords)
        assertEquals(4, sendsUntilRefused(e).first)
    }

    @Test
    fun limitedByNamesWhicheverBudgetActuallyBinds() {
        val bytesBound = pair(MemoryFs(), 2048, 100, recordBytes = 256)
        assertEquals("ENCRYPTION", meters(bytesBound).limitedBy)

        // 4096 bytes affords sixteen 256-byte records, but only four exist.
        val authBound = pair(MemoryFs(), 4096, 4, recordBytes = 256)
        assertEquals("AUTHENTICATION", meters(authBound).limitedBy)
        assertEquals(4L, meters(authBound).maxRemainingSends)
    }

    @Test
    fun aVariableStoreIsUnchanged() {
        val e = pair(MemoryFs(), 2048, 6)
        val before = meters(e)
        assertEquals(RecordSpec.Variable, before.record)
        assertEquals(6L, before.maxRemainingSends)
        assertEquals(before.remainingRecords, before.maxRemainingSends)

        val (count, reason) = sendsUntilRefused(e)
        assertEquals(6, count)
        assertEquals("auth-exhausted", reason)
    }

    @Test
    fun aVariableStoreKeepsBothLimitedByVerdicts() {
        // The frozen §13 display rule, unchanged: AUTHENTICATION binds when even
        // maximum-size sends cannot spend the bytes first.
        assertEquals("AUTHENTICATION", meters(pair(MemoryFs(), 16, 1)).limitedBy)
        assertEquals("ENCRYPTION", meters(pair(MemoryFs(), 16, 2)).limitedBy)
    }
}
