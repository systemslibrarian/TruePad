package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.requiredSourceLength
import dev.systemslibrarian.truepad.spt.RequestClaimState
import dev.systemslibrarian.truepad.spt.readRequestClaim
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * PRESENT-BUT-UNREADABLE IS NOT ABSENCE.
 *
 * `Absent` is the one handoff state that PERMITS a pad to be handed off. So the
 * distinction between "no marker" and "a marker exists but cannot be read" is
 * load-bearing, and getting it wrong is a reuse bug, not a robustness nit.
 *
 * `NioFs.readFile` returned null for a path that exists but is not a regular file
 * — a directory, a FIFO, a dangling symlink — which is exactly what "no such
 * path" returns. `readHandoffState` mapped that null to `Absent`, so planting a
 * directory at `<pairId>/handoff.json` made a pad that had already left look like
 * a pad that had never left.
 *
 * The SPT readers were already written for the correct behaviour:
 * `readRequestClaim` says in terms "a read that throws becomes `unreadable`,
 * never `absent`". They simply never received an exception, because the Fs
 * adapter swallowed the condition. The fix is therefore at the adapter, which
 * makes every one of those readers work as designed — and this suite checks the
 * behaviour through the readers rather than through the adapter alone.
 *
 * LOSS IS ACCEPTABLE; REUSE IS NOT.
 */
class HandoffFailClosedTest {

    private fun tempRoot(prefix: String): File = Files.createTempDirectory(prefix).toFile()

    private fun freshPadOn(fs: Fs, witnessFs: Fs): String {
        val engine = fixedEngine(fs, witnessFs = witnessFs)
        val need = requiredSourceLength(256, 4).toInt()
        engine.gen(
            "handoff-fail-closed",
            listOf(SourceInput("s.bin", "declared", genBytes(need, 7))),
            256, 4, witnessKind = WitnessKind.LOCAL,
        )
        return FIXED_PAIR_ID
    }

    /** Replace the marker path with something that is NOT a regular file. */
    private fun plant(root: File, pairId: String, make: (File) -> Unit) {
        val marker = File(File(root, pairId), "handoff.json")
        marker.parentFile.mkdirs()
        if (marker.exists()) marker.delete()
        make(marker)
    }

    // ---- the Fs-level distinction --------------------------------------------

    @Test
    fun aTrulyAbsentPathStillReadsAsAbsence() {
        val root = tempRoot("tp-absent")
        try {
            val fs = NioFs(root)
            assertEquals(null, fs.readFile("nothing/here.json"))
            assertTrue(readHandoffState(fs, FIXED_PAIR_ID) is HandoffState.Absent)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun aDirectoryAtTheMarkerPathIsUnreadableNotAbsent() {
        val root = tempRoot("tp-dir")
        try {
            val fs = NioFs(root)
            plant(root, FIXED_PAIR_ID) { it.mkdirs() }

            val state = readHandoffState(fs, FIXED_PAIR_ID)
            assertTrue(
                "a directory at the marker path must be UnreadableSpent, not Absent — " +
                    "Absent is what permits a second handoff. Got: $state",
                state is HandoffState.UnreadableSpent,
            )
        } finally {
            root.deleteRecursively()
        }
    }

    /**
     * A DANGLING SYMLINK is the sharpest case: it reports false from both
     * `isFile()` and `exists()`, so a check that used plain `exists()` would still
     * call it absence. The adapter uses NOFOLLOW_LINKS precisely for this.
     */
    @Test
    fun aDanglingSymlinkAtTheMarkerPathIsUnreadableNotAbsent() {
        val root = tempRoot("tp-symlink")
        try {
            val fs = NioFs(root)
            var created = false
            plant(root, FIXED_PAIR_ID) { marker ->
                try {
                    Files.createSymbolicLink(marker.toPath(), File(root, "does-not-exist").toPath())
                    created = true
                } catch (_: Exception) {
                    // Some filesystems/platforms disallow symlinks; skip rather than
                    // fail, but never silently pass the assertion below.
                }
            }
            if (!created) return

            assertFalse("precondition: a dangling symlink reports exists() == false",
                File(File(root, FIXED_PAIR_ID), "handoff.json").exists())
            val state = readHandoffState(fs, FIXED_PAIR_ID)
            assertTrue(
                "a dangling symlink must be UnreadableSpent, not Absent. Got: $state",
                state is HandoffState.UnreadableSpent,
            )
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun anEmptyMarkerIsUnreadableSpent() {
        val root = tempRoot("tp-empty")
        try {
            val fs = NioFs(root)
            plant(root, FIXED_PAIR_ID) { it.writeBytes(ByteArray(0)) }
            assertTrue(readHandoffState(fs, FIXED_PAIR_ID) is HandoffState.UnreadableSpent)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun aMalformedMarkerIsUnreadableSpent() {
        val root = tempRoot("tp-malformed")
        try {
            val fs = NioFs(root)
            for (junk in listOf("not json", "{}", "{\"version\":2}", "{\"version\":1}")) {
                plant(root, FIXED_PAIR_ID) { it.writeText(junk) }
                assertTrue(
                    "malformed marker <$junk> must be UnreadableSpent",
                    readHandoffState(fs, FIXED_PAIR_ID) is HandoffState.UnreadableSpent,
                )
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun aValidMarkerStillParsesNormally() {
        val root = tempRoot("tp-valid")
        val witnessRoot = tempRoot("tp-valid-w")
        try {
            val fs = NioFs(root)
            val pairId = freshPadOn(fs, NioFs(witnessRoot))
            val engine = fixedEngine(fs, witnessFs = NioFs(witnessRoot))

            assertTrue(readHandoffState(fs, pairId) is HandoffState.Absent)
            engine.exportPair(pairId) // writes the physical marker, marker-last
            val state = readHandoffState(fs, pairId)
            assertTrue("a real marker must parse to Physical, got $state",
                state is HandoffState.Physical)
        } finally {
            root.deleteRecursively(); witnessRoot.deleteRecursively()
        }
    }

    // ---- what the distinction actually protects -------------------------------

    /**
     * THE POINT. With an unreadable marker, a SECOND handoff must be refused —
     * for every unreadable shape, not just the malformed-content one.
     */
    @Test
    fun aSecondHandoffIsRefusedForEveryUnreadableShape() {
        val shapes: List<Pair<String, (File) -> Unit>> = listOf(
            "directory" to { f -> f.mkdirs() },
            "empty file" to { f -> f.writeBytes(ByteArray(0)) },
            "malformed json" to { f -> f.writeText("{\"version\":1,") },
            "wrong version" to { f -> f.writeText("{\"version\":9,\"pairId\":\"x\",\"mode\":\"physical\",\"at\":\"x\"}") },
        )

        for ((label, make) in shapes) {
            val root = tempRoot("tp-second-$label".replace(" ", "-"))
            val witnessRoot = tempRoot("tp-second-w")
            try {
                val fs = NioFs(root)
                val pairId = freshPadOn(fs, NioFs(witnessRoot))
                val engine = fixedEngine(fs, witnessFs = NioFs(witnessRoot))
                plant(root, pairId, make)

                val refusal = refusalOf { engine.exportPair(pairId) }
                assertEquals(
                    "$label: a pad whose handoff cannot be read must NOT be handed off again",
                    "handoff-state-unreadable", refusal.reason,
                )
                assertFalse(
                    "$label: the refusal must not advise deleting the marker — deleting it is " +
                        "exactly the action that turns a lost handoff into a reused pad",
                    refusal.text.lowercase().contains("delete"),
                )
            } finally {
                root.deleteRecursively(); witnessRoot.deleteRecursively()
            }
        }
    }

    /** The marker is never repaired, replaced or removed by being read. */
    @Test
    fun anUnreadableMarkerIsLeftExactlyAsFound() {
        val root = tempRoot("tp-untouched")
        val witnessRoot = tempRoot("tp-untouched-w")
        try {
            val fs = NioFs(root)
            val pairId = freshPadOn(fs, NioFs(witnessRoot))
            val engine = fixedEngine(fs, witnessFs = NioFs(witnessRoot))
            plant(root, pairId) { it.writeText("{\"version\":1,") }
            val before = File(File(root, pairId), "handoff.json").readText()

            refusalOf { engine.exportPair(pairId) }
            repeat(3) { readHandoffState(fs, pairId) }

            val after = File(File(root, pairId), "handoff.json")
            assertTrue("the marker must still exist", after.isFile)
            assertEquals("the marker must be byte-identical", before, after.readText())
        } finally {
            root.deleteRecursively(); witnessRoot.deleteRecursively()
        }
    }

    // ---- the same class of hole, elsewhere ------------------------------------

    /**
     * The fix is at the ADAPTER, so every load-bearing reader inherits it. The
     * request claim is checked here as a second witness to that, because it is the
     * other place where `absent` is the permissive value: an absent claim is what
     * allows a request to be bound to a pad.
     */
    @Test
    fun aNonRegularRequestClaimPathIsUnreadableNotAbsent() {
        val root = tempRoot("tp-claim")
        try {
            val fs = NioFs(root)
            val requestHash = ByteArray(32) { it.toByte() }
            val vfs = FsSptVfs(fs)

            assertTrue("precondition: no claim yet",
                readRequestClaim(vfs, requestHash) is RequestClaimState.Absent)

            val claimFile = File(root, dev.systemslibrarian.truepad.spt.claimPath(requestHash))
            claimFile.parentFile.mkdirs()
            claimFile.mkdirs()

            val state = readRequestClaim(vfs, requestHash)
            assertTrue(
                "a directory at the claim path must be Unreadable, not Absent — " +
                    "Absent is what permits binding this request to a pad. Got: $state",
                state is RequestClaimState.Unreadable,
            )
        } finally {
            root.deleteRecursively()
        }
    }

    /** A tombstone path that exists but cannot be read must not read as "no tombstone". */
    @Test
    fun aNonRegularTombstonePathDoesNotReadAsNoTombstone() {
        val root = tempRoot("tp-tomb")
        try {
            val fs = NioFs(root)
            val dir = File(File(root, FIXED_PAIR_ID), "destroyed.json")
            dir.mkdirs()
            try {
                val t = readTombstone(fs, FIXED_PAIR_ID)
                assertTrue(
                    "a non-regular tombstone path must not report 'no tombstone'; got exists=${t.exists}",
                    t.exists,
                )
            } catch (e: Exception) {
                // Propagating is also fail-closed: the operation aborts having
                // consumed nothing. What must NOT happen is a quiet "absent".
                assertTrue(
                    "the failure must name the non-regular path, got: ${e.message}",
                    (e.message ?: "").contains("not a regular file"),
                )
            }
        } finally {
            root.deleteRecursively()
        }
    }
}
