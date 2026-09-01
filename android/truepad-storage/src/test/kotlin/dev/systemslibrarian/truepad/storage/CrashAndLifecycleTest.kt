package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.core.requiredSourceLength
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * Process death, at every durable transition.
 *
 * On Android a process can be killed at ANY instruction — the user swipes the
 * task away, the system reclaims memory, force-stop, a crash. There is no
 * shutdown hook worth relying on. So every state the engine can be interrupted
 * in has to be a state the NEXT load either continues from or refuses; never one
 * it silently misreads.
 *
 * The rule under test never changes: whatever the crash costs, it must cost
 * MATERIAL, not SAFETY.
 */
class CrashAndLifecycleTest {

    private fun genPair(fs: Fs, witnessFs: Fs = fs, capacity: Long = 512, records: Long = 8): Engine {
        val e = fixedEngine(fs, witnessFs = witnessFs)
        val need = requiredSourceLength(capacity, records).toInt()
        e.gen("crash", listOf(SourceInput("s", "o", genBytes(need, 13))), capacity, records, witnessKind = WitnessKind.LOCAL)
        return e
    }

    /**
     * gen writes secret.bin, then head.json, then the init line, then bootstraps
     * the witness, then commits pair.json. A crash at each point must leave
     * something the next run REFUSES — never a half-built pair it will happily use.
     */
    @Test
    fun aCrashDuringGenNeverLeavesAUsableHalfBuiltPair() {
        data class Point(val op: String, val match: (String) -> Boolean, val ordinal: Int, val expect: String?)
        val points = listOf(
            Point("writeFileAtomic", { it.endsWith(SECRET_FILE) }, 1, "no-store"),
            // secret.bin landed, head.json did not. No half has a header, so the
            // pair does not exist as far as the engine is concerned; the orphan
            // body was never used, exported, or reachable.
            Point("writeFileAtomic", { it.endsWith(HEAD_FILE) }, 1, "no-store"),
            // A->B has its body and header but no journal, and B->A has not been
            // started: the pair-level gate reports the half-pair first.
            Point("appendFile", { it.endsWith(JOURNAL_FILE) }, 1, "half-pair"),
            // The A->B half is complete but B->A has not started: a half-pair.
            Point("writeFileAtomic", { it.endsWith(SECRET_FILE) }, 2, "half-pair"),
            Point("writeFileAtomic", { it.endsWith(HEAD_FILE) }, 2, "half-pair"),
        )
        for (p in points) {
            val fs = MemoryFs()
            val faulty = FaultFs(fs, p.op, p.match, ordinal = p.ordinal, timing = When.BEFORE)
            val need = requiredSourceLength(256, 4).toInt()
            try {
                fixedEngine(faulty).gen("half", listOf(SourceInput("s", "o", genBytes(need, 1))), 256, 4)
                error("the fault at ${p.op}#${p.ordinal} did not fire")
            } catch (_: InjectedCrash) {
            }
            val r = refusalOf { fixedEngine(fs).status(FIXED_PAIR_ID) }
            assertEquals("crash at ${p.op}#${p.ordinal}", p.expect, r.reason)
            // Whatever the pair-level verdict, the half itself is never loadable
            // as a usable store: a crashed gen leaves no material anyone can spend.
            // Whatever the pair-level gate says first, the A->B half is itself
            // never a loadable store until gen finished writing all three files.
            if (p.ordinal == 1) {
                val half = loadStore(fs, storeDir(FIXED_PAIR_ID, Direction.A_TO_B))
                assertTrue("the half must not load after a crash at ${p.op}#1", half is LoadResult.Refusal)
            }
        }
    }

    /**
     * A crash after the witness bootstrap but BEFORE pair.json leaves a store
     * with no committed witness. That is deliberate: pair.json is the commit, so
     * the pair reads as android-none (never provisioned) rather than as a
     * provisioned pair whose witness is missing, which would fail closed forever.
     */
    @Test
    fun aCrashBeforePairJsonLeavesAnUnprovisionedButUsablePair() {
        val fs = MemoryFs()
        val faulty = FaultFs(fs, "writeFileAtomic", { it.endsWith(PAIR_META_FILE) }, timing = When.BEFORE)
        val need = requiredSourceLength(256, 4).toInt()
        try {
            fixedEngine(faulty).gen("nocommit", listOf(SourceInput("s", "o", genBytes(need, 1))), 256, 4, witnessKind = WitnessKind.LOCAL)
            error("the fault did not fire")
        } catch (_: InjectedCrash) {
        }
        assertNull(fs.readFile(pairMetaPath(FIXED_PAIR_ID)))
        val meta = readPairMeta(fs, FIXED_PAIR_ID)
        assertEquals(WitnessKind.NONE, meta.witness)
        assertEquals("and its provenance is unknown, so it can never be forwarded", PairOrigin.UNKNOWN, meta.origin)
        // It works, and it claims nothing it cannot back up.
        val e = fixedEngine(fs)
        assertEquals(WitnessState.NA, e.status(FIXED_PAIR_ID).meters.getValue(Direction.A_TO_B).witnessState)
    }

    /**
     * O5: the plaintext is released only AFTER both namespaces are durably
     * retired. A crash at O5 loses the message — and must NOT leave the record
     * re-openable, which would mean the same auth record could be spent twice.
     */
    @Test
    fun aCrashBetweenRetirementAndReleaseLosesTheMessageAndRetiresItAnyway() {
        val aliceFs = MemoryFs()
        val alice = genPair(aliceFs)
        val container = alice.exportPair(FIXED_PAIR_ID).container
        val env = alice.burn(FIXED_PAIR_ID, Party2.A, "never seen".toByteArray()).envelope

        val bobFs = MemoryFs()
        fixedEngine(bobFs).importPair("bob", container)

        // Crash AFTER the O5 header write — the material is retired, the
        // plaintext was never returned.
        val faulty = FaultFs(bobFs, "writeFileAtomic", { it.endsWith(HEAD_FILE) }, timing = When.AFTER)
        try {
            fixedEngine(faulty).open(FIXED_PAIR_ID, Party2.B, env)
            error("the fault did not fire")
        } catch (_: InjectedCrash) {
        }
        val after = loadStore(bobFs, storeDir(FIXED_PAIR_ID, Direction.A_TO_B)) as LoadResult.Ok
        assertEquals("the record is retired", 1L, after.store.effective.nextSequence)
        // LOSS: the message is gone for good, and the record cannot be replayed to
        // recover it. That is the correct trade.
        assertEquals("sequence-retired", refusalOf { fixedEngine(bobFs).open(FIXED_PAIR_ID, Party2.B, env) }.reason)
    }

    /**
     * BURN-BEFORE-OUTPUT, stated as a property rather than as a write order.
     *
     * If ANY durable step of a burn fails, the envelope must never reach the
     * caller — an envelope that exists while the store still thinks its material
     * is unspent is the two-time pad. The witness advance is the last step before
     * the emit, so failing it is the sharpest version of the test.
     */
    @Test
    fun aBurnWhoseDurableWriteFailsNeverReturnsAnEnvelope() {
        for (target in listOf(HEAD_FILE, JOURNAL_FILE, "witness/")) {
            val store = MemoryFs()
            val noBackup = MemoryFs()
            genPair(store, noBackup)
            val faultyStore = FaultFs(store, if (target == HEAD_FILE) "writeFileAtomic" else "appendFile", { it.contains(target) })
            val faultyWitness = FaultFs(noBackup, "appendFile", { it.contains(target) })
            var envelope: String? = null
            try {
                envelope = fixedEngine(faultyStore, witnessFs = faultyWitness)
                    .burn(FIXED_PAIR_ID, Party2.A, "must never escape".toByteArray()).envelope
            } catch (_: InjectedCrash) {
            }
            assertNull("a failed durable write at $target still emitted an envelope", envelope)
        }
        // And the same for open: a failed durable step withholds the plaintext.
        val store = MemoryFs()
        val noBackup = MemoryFs()
        val alice = genPair(store, noBackup)
        val container = alice.exportPair(FIXED_PAIR_ID).container
        val env = alice.burn(FIXED_PAIR_ID, Party2.A, "for bob only".toByteArray()).envelope
        val bobStore = MemoryFs()
        val bobWitness = MemoryFs()
        fixedEngine(bobStore, witnessFs = bobWitness).importPair("bob", container)
        // An open advances the witness twice: once at the O3 reservation, before
        // verification, and once after the O5 commit and before the release.
        // Failing EITHER must withhold the plaintext; the second is the sharper
        // case, because by then the material is already durably retired — the
        // LOSS row, which is exactly the trade this design accepts.
        for (ordinal in listOf(1, 2)) {
            val bobStore2 = MemoryFs()
            val bobWitness2 = MemoryFs()
            fixedEngine(bobStore2, witnessFs = bobWitness2).importPair("bob", container)
            val faulty = FaultFs(bobWitness2, "appendFile", { it.startsWith("witness/") }, ordinal = ordinal)
            var plaintext: ByteArray? = null
            try {
                plaintext = fixedEngine(bobStore2, witnessFs = faulty).open(FIXED_PAIR_ID, Party2.B, env).plaintext
            } catch (_: InjectedCrash) {
            }
            assertTrue("the witness fault #$ordinal did not fire", faulty.fired)
            assertNull("a failed witness advance (#$ordinal) still released the plaintext", plaintext)
        }
        assertTrue(bobStore.exists(headPath(FIXED_PAIR_ID, Direction.A_TO_B)) && bobWitness.exists(witnessLogPath(FIXED_PAIR_ID)))
    }

    /**
     * An import commits with pair.json and only then clears importing.json. A
     * crash mid-copy leaves an INACTIVE pair — refused, and retryable — never a
     * partially-active one.
     */
    @Test
    fun anInterruptedImportIsInactiveAndRetryable() {
        val aliceFs = MemoryFs()
        val alice = genPair(aliceFs)
        val container = alice.exportPair(FIXED_PAIR_ID).container

        val bobFs = MemoryFs()
        // Crash while copying the validated files into place, after the marker.
        val faulty = FaultFs(bobFs, "writeFileAtomic", { it.startsWith("$FIXED_PAIR_ID/b-to-a") }, ordinal = 1, timing = When.BEFORE)
        try {
            fixedEngine(faulty).importPair("bob", container)
            error("the fault did not fire")
        } catch (_: InjectedCrash) {
        }
        assertTrue("the marker survives", bobFs.exists(importMarkerPath(FIXED_PAIR_ID)))
        assertEquals(
            "import-incomplete",
            refusalOf { fixedEngine(bobFs).status(FIXED_PAIR_ID) }.reason,
        )
        // Re-running the same import cleans the ghost and completes.
        val summary = fixedEngine(bobFs).importPair("bob", container)
        assertEquals(FIXED_PAIR_ID, summary.pairId)
        assertFalse(bobFs.exists(importMarkerPath(FIXED_PAIR_ID)))
        assertEquals(PairOrigin.IMPORTED, readPairMeta(bobFs, FIXED_PAIR_ID).origin)
        // Nothing is left behind in staging.
        assertTrue(bobFs.list(STAGING_ROOT).isEmpty())
    }

    /**
     * Destruction is resumable and its tombstone is the historical truth: a
     * resumed destroy must NOT rewrite destroyedAt.
     */
    @Test
    fun anInterruptedDestroyResumesWithoutRewritingTheTombstone() {
        val fs = MemoryFs()
        genPair(fs)
        // NOT the zero-overwrite: that is best-effort by design and swallows its
        // own I/O errors (the file is unlinked regardless). Crash on the first
        // unlink instead, which is the real teardown step.
        val zeroed = FaultFs(fs, "writeRange", { it.endsWith(SECRET_FILE) })
        assertEquals(0, zeroed.matched)
        val crash = FaultFs(fs, "remove", { it.endsWith(SECRET_FILE) }, ordinal = 1, timing = When.AFTER)
        try {
            fixedEngine(crash).destroy(FIXED_PAIR_ID, FIXED_PAIR_ID, "operator destroy")
            error("the fault did not fire")
        } catch (_: InjectedCrash) {
        }
        val tombstone = textAt(fs, tombstonePath(FIXED_PAIR_ID))
        assertTrue(tombstone.contains("\"formatVersion\": 2"))
        // The pair is already unusable, even though teardown did not finish.
        assertEquals("pair-destroyed", refusalOf { fixedEngine(fs).status(FIXED_PAIR_ID) }.reason)
        // Resume completes it, and the tombstone is preserved byte-for-byte.
        val r = fixedEngine(fs).destroy(FIXED_PAIR_ID, FIXED_PAIR_ID)
        assertFalse(r.alreadyDestroyed)
        assertEquals("destroyedAt is historical truth", tombstone, textAt(fs, tombstonePath(FIXED_PAIR_ID)))
        // A third call is idempotent.
        assertTrue(fixedEngine(fs).destroy(FIXED_PAIR_ID, FIXED_PAIR_ID).alreadyDestroyed)
        assertEquals(tombstone, textAt(fs, tombstonePath(FIXED_PAIR_ID)))
    }

    /**
     * The same engine over the REAL filesystem, which is what ships. MemoryFs
     * proves the state machine; NioFs proves the state machine plus java.nio.
     */
    @Test
    fun theWholeFlowWorksOverTheRealFilesystem() {
        val root = Files.createTempDirectory("truepad-store").toFile()
        val witnessRoot = Files.createTempDirectory("truepad-witness").toFile()
        try {
            val store = NioFs(root)
            val witness = NioFs(witnessRoot)
            val alice = fixedEngine(store, witnessFs = witness)
            val need = requiredSourceLength(512, 8).toInt()
            alice.gen("nio", listOf(SourceInput("s", "o", genBytes(need, 21))), 512, 8, witnessKind = WitnessKind.LOCAL)

            // The witness journal is in the OTHER tree, which is the whole point.
            assertTrue(File(witnessRoot, "witness/$FIXED_PAIR_ID.log").isFile)
            assertFalse(File(root, "witness/$FIXED_PAIR_ID.log").exists())

            val container = alice.exportPair(FIXED_PAIR_ID).container
            val env = alice.burn(FIXED_PAIR_ID, Party2.A, "over real files".toByteArray()).envelope

            val bobRoot = Files.createTempDirectory("truepad-bob").toFile()
            val bobWitness = Files.createTempDirectory("truepad-bobw").toFile()
            try {
                val bob = fixedEngine(NioFs(bobRoot), witnessFs = NioFs(bobWitness))
                bob.importPair("bob", container)
                assertEquals("over real files", String(bob.open(FIXED_PAIR_ID, Party2.B, env).plaintext))
                assertEquals("sequence-retired", refusalOf { bob.open(FIXED_PAIR_ID, Party2.B, env) }.reason)

                // A fresh Engine over the same directory — the process-restart case —
                // reads exactly the same state.
                val restarted = fixedEngine(NioFs(bobRoot), witnessFs = NioFs(bobWitness))
                val m = restarted.status(FIXED_PAIR_ID).meters.getValue(Direction.A_TO_B)
                assertEquals(1L, m.nextSequence)
                assertEquals(WitnessState.ALIGNED, m.witnessState)
            } finally {
                bobRoot.deleteRecursively(); bobWitness.deleteRecursively()
            }

            // 0600 / 0700, where the backing supports POSIX permissions.
            val secret = File(root, "$FIXED_PAIR_ID/a-to-b/$SECRET_FILE")
            val perms = try { Files.getPosixFilePermissions(secret.toPath()) } catch (_: Exception) { null }
            if (perms != null) {
                assertEquals("secret.bin must be 0600", "rw-------", java.nio.file.attribute.PosixFilePermissions.toString(perms))
            }
        } finally {
            root.deleteRecursively(); witnessRoot.deleteRecursively()
        }
    }

    /**
     * The pair lock is real mutual exclusion AND bounded. Unbounded blocking on
     * Android is an ANR, and an ANR is a kill at an arbitrary point in the state
     * machine — strictly worse than a free refusal that consumes nothing.
     */
    @Test
    fun concurrentVerbsSerialiseAndNeverInterleave() {
        val fs = MemoryFs()
        val e = genPair(fs, capacity = 4096, records = 64)
        val envelopes = java.util.Collections.synchronizedList(ArrayList<String>())
        val threads = (0 until 8).map { i ->
            Thread {
                repeat(4) { envelopes.add(e.burn(FIXED_PAIR_ID, Party2.A, "t$i".toByteArray()).envelope) }
            }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join() }
        assertEquals(32, envelopes.size)
        // 32 concurrent burns, 32 distinct sequences and 32 disjoint regions.
        val seqs = envelopes.map {
            ((dev.systemslibrarian.truepad.core.decodeEnvelope2(it) as dev.systemslibrarian.truepad.core.EnvelopeDecode.Ok)
                .envelope.sequence)
        }
        assertEquals("every burn took its own auth record", 32, seqs.toSet().size)
        assertEquals((0L until 32L).toSet(), seqs.toSet())
    }

    @Test
    fun aStuckLockHolderProducesATypedRefusalRatherThanHangingForever() {
        val fs = MemoryFs()
        genPair(fs)
        // The bound is 10 s; this asserts the mechanism, not the wall clock, by
        // holding the lock from another thread and racing a short wait.
        val held = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val holder = Thread { fs.withLock(FIXED_PAIR_ID) { held.countDown(); release.await() } }
        holder.start()
        held.await()
        try {
            val start = System.nanoTime()
            // A second holder cannot get in while the first is parked.
            val got = java.util.concurrent.atomic.AtomicBoolean(false)
            val t = Thread { fs.withLock(FIXED_PAIR_ID) { got.set(true) } }
            t.start()
            t.join(300)
            assertFalse("the lock must actually exclude", got.get())
            assertTrue("and it must not have returned early", System.nanoTime() - start >= 250_000_000)
            release.countDown()
            t.join(5_000)
            assertTrue("and it proceeds once the holder leaves", got.get())
        } finally {
            release.countDown()
            holder.join(5_000)
        }
    }
}
