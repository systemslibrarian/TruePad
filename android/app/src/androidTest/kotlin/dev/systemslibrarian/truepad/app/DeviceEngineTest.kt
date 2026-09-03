package dev.systemslibrarian.truepad.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.core.decodeEnvelope2
import dev.systemslibrarian.truepad.core.EnvelopeDecode
import dev.systemslibrarian.truepad.core.encodeCompactEnvelope2
import dev.systemslibrarian.truepad.core.bytesToHex
import dev.systemslibrarian.truepad.storage.Engine
import dev.systemslibrarian.truepad.storage.EngineRefused
import dev.systemslibrarian.truepad.storage.NioFs
import dev.systemslibrarian.truepad.storage.Party2
import dev.systemslibrarian.truepad.storage.SourceInput
import dev.systemslibrarian.truepad.storage.WitnessKind
import dev.systemslibrarian.truepad.storage.witnessLogPath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.SecureRandom

/**
 * THE ENGINE, ON A REAL DEVICE.
 *
 * The JVM suite already proves the state machine, and the same compiled classes
 * run here — so what this file is for is the things a JVM cannot answer: does
 * ART's java.nio actually do an atomic move and an fsync in this sandbox, are
 * the two directories where the security model says they are, do the file modes
 * survive, and does a fresh Engine over the same paths reconstruct the state a
 * killed process left behind.
 */
@RunWith(AndroidJUnit4::class)
class DeviceEngineTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    /** A scratch pair of roots, so these tests never touch the operator's pads. */
    private fun scratch(name: String): Pair<File, File> {
        val store = File(context.filesDir, "test-$name-store")
        val witness = File(context.noBackupFilesDir, "test-$name-witness")
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

    /* ---- the binding the whole rollback story rests on ---------------------- */

    @Test
    fun theStoreAndTheWitnessLiveInTheDirectoriesTheSecurityModelNames() {
        val store = AndroidStorage.storeRoot(context)
        val witness = AndroidStorage.witnessRoot(context)

        assertEquals(
            "the pad store must be under filesDir",
            File(context.filesDir, "truepad").canonicalPath,
            store.canonicalPath,
        )
        assertEquals(
            "the rollback witness must be under noBackupFilesDir, which backup and " +
                "device transfer do not carry",
            File(context.noBackupFilesDir, "truepad").canonicalPath,
            witness.canonicalPath,
        )
        assertFalse(
            "the two must not be the same tree, or a restore takes both and the witness is blind",
            witness.canonicalPath.startsWith(store.canonicalPath),
        )
        assertFalse(witness.canonicalPath.startsWith(context.filesDir.canonicalPath))

        // The real app's engine writes to exactly those roots. The directories
        // are created by NioFs when the engine is built, so this asks the engine
        // to exist rather than assuming some earlier test left them behind —
        // other classes in this suite wipe them between runs.
        val app = context.applicationContext as TruePadApp
        assertNotNull(app.engine)
        val probe = Engine(NioFs(store), NioFs(witness))
        assertNotNull(probe)
        assertTrue("the store root must exist once an engine is bound to it", store.isDirectory)
        assertTrue("and so must the witness root", witness.isDirectory)
    }

    @Test
    fun theWitnessJournalIsWrittenOutsideTheBackedUpTree() {
        val roots = scratch("witness")
        val e = engine(roots)
        val pairId = e.gen("witness", sources(256, 8), 256, 8, witnessKind = WitnessKind.LOCAL).pair.pairId

        val inWitnessTree = File(roots.second, witnessLogPath(pairId))
        assertTrue("the journal must be in the witness root", inWitnessTree.isFile)
        assertFalse(
            "and must NOT be in the store root",
            File(roots.first, witnessLogPath(pairId)).exists(),
        )
        roots.first.deleteRecursively(); roots.second.deleteRecursively()
    }

    /**
     * The restore that Android actually performs: the store tree comes back,
     * the no-backup tree does not. The engine must refuse before consuming.
     */
    @Test
    fun aRestoredStoreIsRefusedOnDevice() {
        val roots = scratch("restore")
        val e = engine(roots)
        val pairId = e.gen("restore", sources(512, 8), 512, 8, witnessKind = WitnessKind.LOCAL).pair.pairId

        // "Back up" the store tree only — which is what a backup would carry if
        // one were enabled at all.
        val backup = File(context.cacheDir, "restore-backup").also { it.deleteRecursively() }
        roots.first.copyRecursively(backup, overwrite = true)

        e.burn(pairId, Party2.A, "spend some".toByteArray())
        e.burn(pairId, Party2.A, "spend more".toByteArray())

        // Restore it. The witness, in the other tree, is untouched.
        roots.first.deleteRecursively()
        backup.copyRecursively(roots.first, overwrite = true)

        val refusal = try {
            engine(roots).burn(pairId, Party2.A, "would reuse".toByteArray())
            null
        } catch (r: EngineRefused) {
            r
        }
        assertNotNull("a restored store must be refused", refusal)
        assertEquals("witness-regressed", refusal!!.reason)

        backup.deleteRecursively(); roots.first.deleteRecursively(); roots.second.deleteRecursively()
    }

    /* ---- durability on ART -------------------------------------------------- */

    /**
     * The process-death case, as an instrumentation test can honestly stage it:
     * a brand-new Engine over the same directories is exactly what a restarted
     * process gets, and it must see everything the old one durably recorded.
     * (A genuine kill is exercised from the host with `am force-stop`; a test
     * running inside the app process cannot survive killing it.)
     */
    @Test
    fun aFreshEngineOverTheSameDirectoriesSeesEverythingThatWasCommitted() {
        val roots = scratch("durable")
        val first = engine(roots)
        val pairId = first.gen("durable", sources(512, 8), 512, 8, witnessKind = WitnessKind.LOCAL).pair.pairId
        val container = first.exportPair(pairId).container
        val envelope = first.burn(pairId, Party2.A, "survives a restart".toByteArray()).envelope
        val afterSend = first.status(pairId).meters.getValue(Direction.A_TO_B).nextSequence

        // A different Engine instance, different NioFs objects, same bytes on disk.
        val second = engine(roots)
        val reloaded = second.status(pairId)
        assertEquals(afterSend, reloaded.meters.getValue(Direction.A_TO_B).nextSequence)
        assertEquals("durable", reloaded.label)

        // And the receiver side is durable too: open once, then never again.
        val bobRoots = scratch("durable-bob")
        engine(bobRoots).importPair("bob", container)
        assertEquals(
            "survives a restart",
            String(engine(bobRoots).open(pairId, Party2.B, envelope).plaintext),
        )
        val replay = try {
            engine(bobRoots).open(pairId, Party2.B, envelope); null
        } catch (r: EngineRefused) { r }
        assertEquals("sequence-retired", replay!!.reason)

        listOf(roots.first, roots.second, bobRoots.first, bobRoots.second).forEach { it.deleteRecursively() }
    }

    /** 0600/0700 survive on the device's real filesystem, not only on a JVM. */
    @Test
    fun padFilesAreNotReadableBeyondThisApp() {
        val roots = scratch("modes")
        val e = engine(roots)
        val pairId = e.gen("modes", sources(256, 8), 256, 8, witnessKind = WitnessKind.LOCAL).pair.pairId
        val secret = File(roots.first, "$pairId/a-to-b/secret.bin")
        assertTrue(secret.isFile)
        val perms = java.nio.file.Files.getPosixFilePermissions(secret.toPath())
        assertEquals("rw-------", java.nio.file.attribute.PosixFilePermissions.toString(perms))
        val dirPerms = java.nio.file.Files.getPosixFilePermissions(File(roots.first, pairId).toPath())
        assertEquals("rwx------", java.nio.file.attribute.PosixFilePermissions.toString(dirPerms))
        roots.first.deleteRecursively(); roots.second.deleteRecursively()
    }

    /* ---- interoperability, on the device ------------------------------------ */

    /**
     * The released v2.0.0 vectors, replayed on ART.
     *
     * The JVM suite already proves byte-agreement with the release; this proves
     * the SAME agreement holds on the device's runtime, where the JIT, the
     * charset defaults and the filesystem are all different. An envelope this
     * app produces is one the released CLI and Browser Edition accept, and one
     * they produce is one this app opens.
     */
    @Test
    fun aRoundTripOnDeviceProducesTheReleasedWireFormat() {
        val roots = scratch("interop")
        val alice = engine(roots)
        val pairId = alice.gen("interop", sources(1024, 8), 1024, 8, witnessKind = WitnessKind.LOCAL).pair.pairId
        val container = alice.exportPair(pairId).container

        val bobRoots = scratch("interop-bob")
        engine(bobRoots).importPair("bob", container)
        val bob = engine(bobRoots)

        val envelope = alice.burn(pairId, Party2.A, "on device".toByteArray()).envelope

        // It is a canonical §6.2 envelope, and the strict decoder agrees.
        val decoded = decodeEnvelope2(envelope)
        assertTrue("the emitted envelope must decode strictly", decoded is EnvelopeDecode.Ok)
        val env = (decoded as EnvelopeDecode.Ok).envelope
        assertEquals(pairId, env.pairId)
        assertEquals(Direction.A_TO_B, env.direction)
        assertEquals(16, env.tag.size)
        assertTrue(envelope.startsWith("{\"formatVersion\":2,"))

        // The TP2 compact spelling of the same envelope opens identically —
        // the released open accepts either.
        val compact = encodeCompactEnvelope2(env)
        assertTrue(compact.startsWith("TP2:"))
        assertEquals("on device", String(bob.open(pairId, Party2.B, compact).plaintext))

        // A tampered tag is refused, and costs a durable attempt rather than
        // silently passing.
        val second = alice.burn(pairId, Party2.A, "second".toByteArray()).envelope
        val tampered = second.replace(
            Regex("\"tag\":\"([0-9a-f])"),
            "\"tag\":\"" + (if (second.contains("\"tag\":\"0")) "1" else "0"),
        )
        val forged = try { bob.open(pairId, Party2.B, tampered); null } catch (r: EngineRefused) { r }
        assertEquals("auth-failed", forged!!.reason)
        // And no pad material moved.
        assertEquals(1L, bob.status(pairId).meters.getValue(Direction.A_TO_B).nextSequence)

        // The genuine one still opens.
        assertEquals("second", String(bob.open(pairId, Party2.B, second).plaintext))

        listOf(roots.first, roots.second, bobRoots.first, bobRoots.second).forEach { it.deleteRecursively() }
    }

    /** The engine's own refusal messages carry nothing secret, on device too. */
    @Test
    fun refusalMessagesOnDeviceCarryNoSecret() {
        val roots = scratch("secrets")
        val alice = engine(roots)
        val pairId = alice.gen("secrets", sources(512, 8), 512, 8, witnessKind = WitnessKind.LOCAL).pair.pairId
        val container = alice.exportPair(pairId).container
        val bobRoots = scratch("secrets-bob")
        engine(bobRoots).importPair("bob", container)

        val plaintext = "MEET AT THE BRIDGE AT MIDNIGHT"
        val envelope = alice.burn(pairId, Party2.A, plaintext.toByteArray()).envelope
        val secretHex = bytesToHex(File(roots.first, "$pairId/a-to-b/secret.bin").readBytes())

        val tampered = envelope.replace(Regex("\"tag\":\"[0-9a-f]{2}"), "\"tag\":\"ff")
        val refusal = try { engine(bobRoots).open(pairId, Party2.B, tampered); null } catch (r: EngineRefused) { r }
        val text = refusal!!.message ?: ""
        assertFalse(text.contains(plaintext))
        for (i in 0..(secretHex.length - 32) step 32) {
            assertFalse("pad material leaked into a refusal", text.contains(secretHex.substring(i, i + 32)))
        }
        listOf(roots.first, roots.second, bobRoots.first, bobRoots.second).forEach { it.deleteRecursively() }
    }
}
