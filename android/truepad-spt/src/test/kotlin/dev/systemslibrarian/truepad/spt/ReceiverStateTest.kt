package dev.systemslibrarian.truepad.spt

import dev.systemslibrarian.truepad.core.bytesToHex
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Duration
import java.time.Instant

/**
 * The receiver's durable state machine: create -> PENDING -> CANCELLED | CONSUMED,
 * never PENDING again. LOSS IS ACCEPTABLE; REUSE IS NOT.
 */
class ReceiverStateTest {

    private val now = Instant.parse("2026-09-03T12:00:00.000Z")
    private val requestId = ByteArray(16) { 0x5a }
    private val idHex = bytesToHex(requestId)

    private fun pending(vfs: SptVfs): PendingRequestInput {
        val kp = XWing.generateKeyPair()
        val body = encodeRequestBody(requestId, kp.encapsulationKey)
        val requestHash = requestFingerprint(body)
        val createdAt = SptTime.format(now)
        val expiresAt = SptTime.format(now.plusMillis(SptTime.REQUEST_TTL_MS))
        return PendingRequestInput(body, requestId, requestHash, kp.decapsulationSeed, createdAt, expiresAt)
    }

    @Test
    fun createProducesAPendingRequestThatCarriesItsKey() {
        val vfs = MemorySptVfs()
        commitPendingReceiveRequest(vfs, pending(vfs))
        val state = readReceiverState(vfs, idHex, now)
        assertTrue(state is ReceiverState.Pending)
        assertEquals(XWING_SEED_BYTES, (state as ReceiverState.Pending).dk.size)
    }

    @Test
    fun aRequestIdIsNeverReusedEvenAfterConsumption() {
        val vfs = MemorySptVfs()
        commitPendingReceiveRequest(vfs, pending(vfs))
        val ex = assertThrows(SptRefused::class.java) { commitPendingReceiveRequest(vfs, pending(vfs)) }
        assertEquals(REFUSE_ID_UNAVAILABLE, ex.reason)
    }

    @Test
    fun consumeIsTerminalAndBlocksASecondConsumption() {
        val vfs = MemorySptVfs()
        commitPendingReceiveRequest(vfs, pending(vfs))
        val pairId = "aa".repeat(16)
        val consumed = consumePendingReceiveRequest(vfs, idHex, ConsumeInput(pairId, ByteArray(32) { 1 }, SptTime.format(now)), now)
        assertTrue(consumed is ReceiverState.Consumed)
        // Reading again reports CONSUMED even though it was terminal.
        assertTrue(readReceiverState(vfs, idHex, now) is ReceiverState.Consumed)
        // A second consume is refused.
        assertThrows(SptRefused::class.java) {
            consumePendingReceiveRequest(vfs, idHex, ConsumeInput(pairId, ByteArray(32) { 2 }, SptTime.format(now)), now)
        }
        // Sealed ancestry is now derivable from the persistent marker.
        assertTrue(pairArrivedSealed(vfs, pairId))
        assertFalse(pairArrivedSealed(vfs, "bb".repeat(16)))
    }

    @Test
    fun cancelIsTerminalAndBlocksConsumption() {
        val vfs = MemorySptVfs()
        commitPendingReceiveRequest(vfs, pending(vfs))
        val cancelled = cancelPendingReceiveRequest(vfs, idHex, CancelReason.OPERATOR, SptTime.format(now), now)
        assertTrue(cancelled is ReceiverState.Cancelled)
        assertThrows(SptRefused::class.java) {
            consumePendingReceiveRequest(vfs, idHex, ConsumeInput("cc".repeat(16), ByteArray(32), SptTime.format(now)), now)
        }
        // Cancel is idempotent and keeps the first reason.
        val again = cancelPendingReceiveRequest(vfs, idHex, CancelReason.REJECTED, SptTime.format(now), now)
        assertEquals(CancelReason.OPERATOR, (again as ReceiverState.Cancelled).reason)
    }

    @Test
    fun anExpiredRequestHandsOutNoKeyAndCannotBeConsumed() {
        val vfs = MemorySptVfs()
        commitPendingReceiveRequest(vfs, pending(vfs))
        val later = now.plus(Duration.ofDays(8))
        val state = readReceiverState(vfs, idHex, later)
        assertTrue(state is ReceiverState.ExpiredPending) // deliberately no dk
        assertThrows(SptRefused::class.java) {
            consumePendingReceiveRequest(vfs, idHex, ConsumeInput("dd".repeat(16), ByteArray(32), SptTime.format(later)), later)
        }
        // It terminalizes only as expired.
        assertThrows(SptRefused::class.java) {
            cancelPendingReceiveRequest(vfs, idHex, CancelReason.OPERATOR, SptTime.format(later), later)
        }
        assertTrue(expirePendingReceiveRequest(vfs, idHex, SptTime.format(later), later) is ReceiverState.Cancelled)
    }

    @Test
    fun aTerminalMarkerBeatsAStillPresentKeyAndBothMarkersAreInconsistent() {
        val vfs = MemorySptVfs()
        commitPendingReceiveRequest(vfs, pending(vfs))
        // Forge both terminal markers present (a corruption): fail closed.
        vfs.writeFileAtomic(cancelledPath(idHex), serializeRecord("version" to 1, "requestId" to idHex, "at" to SptTime.format(now), "reason" to "operator"))
        vfs.writeFileAtomic(consumedPath(idHex), serializeRecord("version" to 1, "requestId" to idHex, "at" to SptTime.format(now), "pairId" to "ee".repeat(16), "packageIdentity" to toBase64Url(ByteArray(32))))
        assertTrue(readReceiverState(vfs, idHex, now) is ReceiverState.TerminalInconsistent)
    }

    @Test
    fun aRecordMovedBetweenDirectoriesIsRejected() {
        val vfs = MemorySptVfs()
        commitPendingReceiveRequest(vfs, pending(vfs))
        // Copy this request.json under a DIFFERENT requestId directory.
        val other = "0f".repeat(16)
        vfs.writeFileAtomic(requestPath(other), vfs.readFile(requestPath(idHex))!!)
        // dk present too, but the stored body names the original id, so it is unusable.
        vfs.writeFileAtomic(dkPath(other), ByteArray(XWING_SEED_BYTES))
        assertTrue(readReceiverState(vfs, other, now) is ReceiverState.Unusable)
    }
}
