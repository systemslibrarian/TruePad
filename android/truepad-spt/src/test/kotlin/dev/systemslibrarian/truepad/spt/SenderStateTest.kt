package dev.systemslibrarian.truepad.spt

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** The sender's durable gates: one request -> one package (claim), one pad -> one
 *  handoff (handoff), and the replaceable confirmation. */
class SenderStateTest {

    private val now = Instant.parse("2026-09-03T12:00:00.000Z")
    private val at = SptTime.format(now)
    private val padP = "aa".repeat(16)
    private val padQ = "bb".repeat(16)

    private class Req(val body: ByteArray, val requestHash: ByteArray, val seed: ByteArray)

    private fun request(): Req {
        val kp = XWing.generateKeyPair()
        val body = encodeRequestBody(ByteArray(16) { 0x5a }, kp.encapsulationKey)
        return Req(body, requestFingerprint(body), kp.decapsulationSeed)
    }

    @Test
    fun aRequestBindsToOnePadPermanently() {
        val vfs = MemorySptVfs()
        val r = request()
        claimRequestForPair(vfs, r.requestHash, padP, at)
        // Same pair re-claim is idempotent.
        assertEquals(padP, claimRequestForPair(vfs, r.requestHash, padP, at).pairId)
        // A different pad is refused, permanently.
        val ex = assertThrows(SptRefused::class.java) { claimRequestForPair(vfs, r.requestHash, padQ, at) }
        assertEquals(REFUSE_CLAIMED_ELSEWHERE, ex.reason)
        // requireClaimedByPair mirrors it.
        assertEquals(padP, requireClaimedByPair(vfs, r.requestHash, padP).pairId)
        assertThrows(SptRefused::class.java) { requireClaimedByPair(vfs, r.requestHash, padQ) }
    }

    @Test
    fun committingASealedHandoffRequiresTheClaimAndIsOneShot() {
        val vfs = MemorySptVfs()
        val r = request()
        val payload = "a courier bundle".toByteArray()
        val sealed = sealPayloadV1(r.body, payload)

        // Without a claim, commit refuses (the frozen write order is structural).
        assertThrows(SptRefused::class.java) {
            commitSealedHandoff(vfs, padP, SealedHandoffInput(sealed.packageBytes, r.requestHash, sealed.confirmValue, sealed.packageIdentity), at)
        }
        // Claim, then commit.
        claimRequestForPair(vfs, r.requestHash, padP, at)
        val marker = commitSealedHandoff(vfs, padP, SealedHandoffInput(sealed.packageBytes, r.requestHash, sealed.confirmValue, sealed.packageIdentity), at)
        assertTrue(marker is HandoffMarker.Sealed)
        // A second handoff of the same pad is refused (already sealed).
        val ex = assertThrows(SptRefused::class.java) {
            commitSealedHandoff(vfs, padP, SealedHandoffInput(sealed.packageBytes, r.requestHash, sealed.confirmValue, sealed.packageIdentity), at)
        }
        assertEquals(REFUSE_ALREADY_SEALED, ex.reason)
    }

    @Test
    fun reShareReturnsTheExactCommittedPackageNotAFreshSeal() {
        val vfs = MemorySptVfs()
        val r = request()
        val sealed = sealPayloadV1(r.body, "bundle".toByteArray())
        claimRequestForPair(vfs, r.requestHash, padP, at)
        commitSealedHandoff(vfs, padP, SealedHandoffInput(sealed.packageBytes, r.requestHash, sealed.confirmValue, sealed.packageIdentity), at)

        val reshared = loadCommittedSealedHandoff(vfs, padP)
        assertArrayEquals(sealed.packageBytes, reshared.packageBytes)
        assertArrayEquals(sealed.confirmValue, reshared.confirmValue)

        // Dismissing the payload keeps the marker; re-share then becomes unavailable.
        dismissSealedPayload(vfs, padP)
        assertThrows(SptRefused::class.java) { loadCommittedSealedHandoff(vfs, padP) }
        // ...but the pad is STILL spent — no new seal may replace it.
        assertThrows(SptRefused::class.java) {
            commitSealedHandoff(vfs, padP, SealedHandoffInput(sealed.packageBytes, r.requestHash, sealed.confirmValue, sealed.packageIdentity), at)
        }
    }

    @Test
    fun aPhysicalHandoffBlocksASealedOneAndViceVersa() {
        val vfs = MemorySptVfs()
        val r = request()
        commitPhysicalHandoff(vfs, padP, at)
        claimRequestForPair(vfs, r.requestHash, padP, at)
        val sealed = sealPayloadV1(r.body, "x".toByteArray())
        val ex = assertThrows(SptRefused::class.java) {
            commitSealedHandoff(vfs, padP, SealedHandoffInput(sealed.packageBytes, r.requestHash, sealed.confirmValue, sealed.packageIdentity), at)
        }
        assertEquals(REFUSE_ALREADY_HANDED_OFF, ex.reason)
    }

    @Test
    fun theConfirmationIsReplaceableAndExpires() {
        val vfs = MemorySptVfs()
        val r = request()
        // Absent -> requireConfirmedBody refuses.
        assertThrows(SptRefused::class.java) { requireConfirmedBody(vfs, dev.systemslibrarian.truepad.core.bytesToHex(r.requestHash), now) }
        val (hex, rec) = commitConfirmation(vfs, r.body, at, now)
        assertArrayEquals(r.body, rec.body)
        assertArrayEquals(r.body, requireConfirmedBody(vfs, hex, now).body)
        // Expired after 8 days.
        val later = now.plusSeconds(8L * 24 * 3600)
        assertThrows(SptRefused::class.java) { requireConfirmedBody(vfs, hex, later) }
    }
}
