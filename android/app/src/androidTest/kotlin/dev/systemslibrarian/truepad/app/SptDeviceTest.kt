package dev.systemslibrarian.truepad.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.systemslibrarian.truepad.core.Assessment
import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.spt.SptRefused
import dev.systemslibrarian.truepad.storage.Engine
import dev.systemslibrarian.truepad.storage.NioFs
import dev.systemslibrarian.truepad.storage.PairOrigin
import dev.systemslibrarian.truepad.storage.Party2
import dev.systemslibrarian.truepad.storage.SourceInput
import dev.systemslibrarian.truepad.storage.WitnessKind
import dev.systemslibrarian.truepad.storage.sptCommitReceive
import dev.systemslibrarian.truepad.storage.sptConfirmRequest
import dev.systemslibrarian.truepad.storage.sptCreateReceiveRequest
import dev.systemslibrarian.truepad.storage.sptOpen
import dev.systemslibrarian.truepad.storage.sptPairArrivedSealed
import dev.systemslibrarian.truepad.storage.sptReviewRequest
import dev.systemslibrarian.truepad.storage.sptSeal
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.SecureRandom

/**
 * SEALED PAD TRANSFER, ON A REAL DEVICE.
 *
 * The JVM suite already proves the SPT state machine and that Bouncy Castle
 * reproduces the X-Wing draft-10 vectors and the cross-language interop corpus.
 * What this file adds is the one thing a JVM cannot answer: does BC's X-Wing
 * (ML-KEM-768 + X25519) actually run correctly on ART, through the release-shaped
 * classpath, on the device's own filesystem — a full seal on one store, opened
 * and imported on another, with the confirmation ceremony matching across the
 * gap and the durable sealed-ancestry verdict landing NOT ELIGIBLE.
 *
 * Two independent stores stand in for two devices; only the public TPR2 code and
 * the sealed .tps2 bytes cross between them.
 */
@RunWith(AndroidJUnit4::class)
class SptDeviceTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private fun scratch(name: String): Pair<File, File> {
        val store = File(context.filesDir, "spt-$name-store")
        val witness = File(context.noBackupFilesDir, "spt-$name-witness")
        store.deleteRecursively(); witness.deleteRecursively()
        return store to witness
    }

    private fun engine(roots: Pair<File, File>) = Engine(NioFs(roots.first), NioFs(roots.second))

    private fun sources(capacity: Long, records: Long): List<SourceInput> {
        val need = (2 * (capacity + 32 * records)).toInt()
        val bytes = ByteArray(need)
        SecureRandom().nextBytes(bytes)
        return listOf(SourceInput("device-random", "instrumentation test material", bytes))
    }

    @Test
    fun aSealedTransferRoundTripsOnDevice() {
        val aliceRoots = scratch("alice")
        val bobRoots = scratch("bob")
        val alice = engine(aliceRoots)
        val bob = engine(bobRoots)

        val pairId = alice.gen("to bob", sources(512, 8), 512, 8, witnessKind = WitnessKind.LOCAL).pair.pairId

        // RECEIVER creates a one-time code (X-Wing keypair on ART).
        val request = bob.sptCreateReceiveRequest()
        assertTrue(request.tpr2Text.startsWith("TPR2:"))

        // SENDER reviews, confirms, seals (X-Wing encapsulation on ART).
        val review = alice.sptReviewRequest(request.tpr2Text)
        assertEquals(request.requestHashHex, review.requestHashHex)
        assertArrayEquals("the twelve request words match across the gap", request.requestIndices, review.requestIndices)
        alice.sptConfirmRequest(review.canonicalBody)
        val seal = alice.sptSeal(review.requestHashHex, pairId)
        assertFalse(seal.reshared)

        // RECEIVER opens (X-Wing decapsulation on ART) and confirms.
        val session = bob.sptOpen(seal.packageBytes)
        assertArrayEquals("the eight confirmation words match across the gap", seal.confirmationIndices, session.confirmationIndices)
        val summary = bob.sptCommitReceive(session, "from alice")
        assertEquals(pairId, summary.pairId)

        // The sealed-ancestry verdict is durable and disqualifying.
        assertTrue(bob.sptPairArrivedSealed(pairId))
        for (d in Direction.entries) {
            assertEquals(Assessment.NOT_ELIGIBLE, summary.meters.getValue(d).deployment.assessment)
        }

        // The imported pad is a real working OTP pad on the device.
        val env = alice.burn(pairId, Party2.A, "the pad works on device".toByteArray())
        assertEquals("the pad works on device", String(bob.open(pairId, Party2.B, env.envelope).plaintext))

        listOf(aliceRoots.first, aliceRoots.second, bobRoots.first, bobRoots.second).forEach { it.deleteRecursively() }
    }

    @Test
    fun aConsumedReceiveRequestCannotReceiveASecondPadOnDevice() {
        val aliceRoots = scratch("consume-alice")
        val bobRoots = scratch("consume-bob")
        val alice = engine(aliceRoots)
        val bob = engine(bobRoots)

        val pairId = alice.gen("once", sources(256, 8), 256, 8, witnessKind = WitnessKind.LOCAL).pair.pairId
        val request = bob.sptCreateReceiveRequest()
        val review = alice.sptReviewRequest(request.tpr2Text)
        alice.sptConfirmRequest(review.canonicalBody)
        val seal = alice.sptSeal(review.requestHashHex, pairId)

        val session = bob.sptOpen(seal.packageBytes)
        val summary = bob.sptCommitReceive(session, "first import")
        assertEquals(PairOrigin.IMPORTED, summary.origin)
        assertNotNull(summary.pairId)

        // Consume-before-import: a second open of the same package is refused.
        val reopen = try {
            bob.sptOpen(seal.packageBytes); null
        } catch (e: SptRefused) { e }
        assertEquals("spt-request-consumed", reopen!!.reason)

        listOf(aliceRoots.first, aliceRoots.second, bobRoots.first, bobRoots.second).forEach { it.deleteRecursively() }
    }
}
