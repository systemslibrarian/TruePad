package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.spt.CancelReason
import dev.systemslibrarian.truepad.spt.MemorySptVfs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A PUBLISHED RECEIVE REQUEST MUST BE REACHABLE AFTER A RESTART.
 *
 * Found by the two-device physical ceremony. The receive screen held the request
 * in memory only — and entering it resets the transient session — so leaving the
 * screen or restarting stranded a LIVE one-time key: pending on disk, and
 * unreachable. The operator could not cancel it, could not REJECT it after a
 * failed word comparison, and could not open the sealed file the sender returned.
 * The iOS edition carried the identical defect.
 */
class SptRestoreTest {

    @Test
    fun `a pending request is recovered from disk alone`() {
        val fs = MemoryFs()
        // TWO ENGINES OVER ONE STORE: the second stands in for the process that
        // comes back, sharing no memory with the first.
        val first = Engine(fs)
        val created = first.sptCreateReceiveRequest()

        val second = Engine(fs)
        val restored = second.sptRestorePendingReceiveRequest()
        assertNotNull("a pending request must be recoverable from disk alone", restored)

        assertEquals(created.requestIdHex, restored!!.requestIdHex)
        assertEquals(created.requestHashHex, restored.requestHashHex)
        // THE PUBLISHED TEXT MUST BE BYTE-IDENTICAL. The sender scanned this; a
        // restored request that re-encoded differently would be a different
        // request, and the twelve words would not match.
        assertEquals(created.tpr2Text, restored.tpr2Text)
        assertEquals(created.expiresAt, restored.expiresAt)
        assertEquals(
            created.requestIndices.toList(),
            restored.requestIndices.toList(),
        )
    }

    // NOTE: the "a cancelled request is not restored" case is covered by
    // readReceiverState's terminality handling, which both editions share, and by
    // the iOS regression test. The Kotlin Engine exposes no cancel verb to reach
    // it from here, and adding one purely for a test would be the wrong trade.

    /** An empty store restores nothing rather than inventing something. */
    @Test
    fun `an empty store restores no request`() {
        assertNull(Engine(MemoryFs()).sptRestorePendingReceiveRequest())
    }

    /**
     * A REJECTED REQUEST IS NEVER RESTORED.
     *
     * This is the pairing that makes the restore safe. Restoring pending requests
     * is what lets an operator finish a ceremony after a restart — and it is also
     * what would resurrect a request the operator had just REJECTED because the
     * eight confirmation words did not match. A mismatch is the outcome the
     * comparison exists to produce; if navigating away undoes it, the sealed
     * package the mismatch was warning about gets a second chance.
     *
     * Before this, the reject button only cleared the screen: nothing was written,
     * the request stayed Pending on disk, and the next visit to the Receive screen
     * offered it again.
     */
    @Test
    fun `a rejected request is not restored`() {
        val fs = MemoryFs()
        val first = Engine(fs)
        val created = first.sptCreateReceiveRequest()
        assertNotNull(Engine(fs).sptRestorePendingReceiveRequest())

        first.sptEndReceiveRequest(created.requestIdHex, CancelReason.REJECTED)

        assertNull(
            "a request the operator rejected must never come back",
            Engine(fs).sptRestorePendingReceiveRequest(),
        )
    }

    /**
     * A REQUEST THAT CANNOT BE READ IS NOT A REQUEST THAT IS NOT THERE.
     *
     * The restore returned a plain null for BOTH, so an unreadable pending request
     * — a torn write, a truncated `request.json`, a `dk.bin` that will not load —
     * was reported to the interface as "nothing pending". The interface then
     * offered "Create a receive code" over a live one-time key that could not be
     * cancelled, could not be rejected after a failed word comparison, and could
     * not open the sealed file that came back for it. That is precisely the
     * stranding this whole verb was written to close, surviving inside it.
     *
     * It refuses now. Null still means, and only means, nothing pending.
     */
    @Test
    fun `an unreadable pending request refuses rather than reading as absent`() {
        val fs = MemoryFs()
        val created = Engine(fs).sptCreateReceiveRequest()
        assertNotNull("precondition: the request is restorable while it is readable",
                      Engine(fs).sptRestorePendingReceiveRequest())

        // Corrupt the request body on disk, leaving the directory entry in place —
        // the shape a torn write leaves behind.
        val path = "spt/receive/${created.requestIdHex}/request.json"
        assertNotNull("the fixture no longer writes where this test looks", fs.readFile(path))
        fs.writeFileAtomic(path, "{ not json".toByteArray())

        val refusal = try {
            Engine(fs).sptRestorePendingReceiveRequest()
            null
        } catch (e: dev.systemslibrarian.truepad.spt.SptRefused) {
            e
        }
        assertNotNull("an unreadable request was reported as nothing pending", refusal)
        assertEquals("receive-request-state", refusal!!.reason)
    }

    /** The operator's own cancellation is equally terminal. */
    @Test
    fun `a cancelled request is not restored`() {
        val fs = MemoryFs()
        val first = Engine(fs)
        val created = first.sptCreateReceiveRequest()
        first.sptEndReceiveRequest(created.requestIdHex, CancelReason.OPERATOR)
        assertNull(Engine(fs).sptRestorePendingReceiveRequest())
    }

    /**
     * THE FIRST REASON STANDS. A later cancel must not be able to rewrite a
     * rejection into something milder — the durable record of "the words did not
     * match" is the one that matters.
     */
    @Test
    fun `a cancel after a rejection does not overwrite the rejection`() {
        val fs = MemoryFs()
        val engine = Engine(fs)
        val created = engine.sptCreateReceiveRequest()
        engine.sptEndReceiveRequest(created.requestIdHex, CancelReason.REJECTED)
        engine.sptEndReceiveRequest(created.requestIdHex, CancelReason.OPERATOR)

        val record = String(fs.readFile("spt/receive/${created.requestIdHex}/cancelled.json")!!)
        assertTrue("the rejection must survive a later cancel: $record", record.contains("rejected"))
    }

    /** Expiry is the clock's decision, not the operator's. */
    @Test
    fun `the operator cannot terminalize a request as expired`() {
        val fs = MemoryFs()
        val engine = Engine(fs)
        val created = engine.sptCreateReceiveRequest()
        try {
            engine.sptEndReceiveRequest(created.requestIdHex, CancelReason.EXPIRED)
            org.junit.Assert.fail("expiry must not be an operator-supplied reason")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("clock"))
        }
    }
}
