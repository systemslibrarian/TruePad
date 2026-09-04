package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.requiredSourceLength
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * THE TERMINAL MARKER MUST FAIL CLOSED (FORMAT-V2.md §17).
 *
 * `destroyed.json` is the irreversible boundary: once it is durable the pair must
 * never perform a cryptographic operation again. So the gate asks "is this path
 * NOT KNOWN TO BE ABSENT", not "is there a readable regular file here" — every
 * way of being unreadable has to close the boundary, not open it.
 *
 * A REAL FAIL-OPEN, MEASURED RATHER THAN ASSUMED. `requireNotDestroyed` used
 * `Fs.exists`, which was `File.exists()`, which FOLLOWS SYMLINKS and answers
 * false for a symlink whose target is gone. A tombstone in that shape read as
 * absent and the destroyed pair became usable again — pad reuse. Node's
 * `existsSync` and Foundation's `fileExists` answer false there too, so the
 * Browser/CLI and iOS editions carried the identical defect and were corrected in
 * the same change; `tests/terminal-marker-fail-closed.test.ts` and
 * `TerminalMarkerFailClosedTests.swift` assert the same list of shapes.
 *
 * This is the sibling of [HandoffFailClosedTest]: the same "present but
 * unreadable is not absence" rule, applied to the marker that is permanent.
 *
 * LOSS IS ACCEPTABLE; REUSE IS NOT.
 */
class TerminalMarkerFailClosedTest {

    private fun tempRoot(prefix: String): File = Files.createTempDirectory(prefix).toFile()

    private fun freshPadOn(fs: Fs): String {
        val engine = fixedEngine(fs)
        val need = requiredSourceLength(256, 4).toInt()
        engine.gen(
            "terminal-fail-closed",
            listOf(SourceInput("s.bin", "declared", genBytes(need, 23))),
            256, 4, witnessKind = WitnessKind.LOCAL,
        )
        return FIXED_PAIR_ID
    }

    /** Replace the tombstone path with something that is NOT a readable file. */
    private fun plant(root: File, pairId: String, make: (File) -> Unit): Boolean {
        val marker = File(File(root, pairId), TOMBSTONE_FILE)
        marker.parentFile.mkdirs()
        if (Files.exists(marker.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            marker.deleteRecursively()
        }
        return try {
            make(marker)
            true
        } catch (_: Exception) {
            // Some filesystems disallow symlinks or special files. Skip rather
            // than fail — but never silently pass the assertion.
            false
        }
    }

    /** Every shape a tombstone can take that is NOT a well-formed readable file. */
    private val shapes: List<Pair<String, (File) -> Unit>> = listOf(
        "a symlink whose target does not exist" to { m: File ->
            Files.createSymbolicLink(m.toPath(), File(m.parentFile, "does-not-exist").toPath())
        },
        "a symlink to a deleted file" to { m: File ->
            val t = File(m.parentFile, "t.bin")
            t.writeText("x")
            Files.createSymbolicLink(m.toPath(), t.toPath())
            t.delete()
        },
        "a directory" to { m: File -> m.mkdirs() },
        "a non-empty directory" to { m: File ->
            m.mkdirs()
            File(m, "inner").writeText("x")
        },
        "an empty file (a torn write)" to { m: File -> m.writeBytes(ByteArray(0)) },
        "a truncated JSON object" to { m: File -> m.writeText("{\"formatVersion\":2,\"pairId\":\"aaaa") },
        "not JSON at all" to { m: File -> m.writeText("  not json") },
        "JSON that is not an object" to { m: File -> m.writeText("[1,2,3]") },
        "a JSON object naming a DIFFERENT pair" to { m: File ->
            m.writeText("{\"formatVersion\":2,\"pairId\":\"${"f".repeat(32)}\"}")
        },
        "a file with no read permission" to { m: File ->
            m.writeText("{}")
            check(m.setReadable(false, false)) { "could not drop read permission" }
        },
    )

    // ---- the gate ------------------------------------------------------------

    @Test
    fun everyUnreadableTombstoneShapeStillRefusesEveryConsumingVerb() {
        var exercised = 0
        for ((name, make) in shapes) {
            val root = tempRoot("tp-terminal")
            try {
                val fs = NioFs(root)
                val pairId = freshPadOn(fs)

                // CONTROL FIRST: without the marker this exact call succeeds, so
                // the refusal below is caused by the marker and nothing else.
                val engine = fixedEngine(fs)
                engine.burn(pairId, Party2.A, "before".toByteArray())

                if (!plant(root, pairId) { make(it) }) continue
                exercised += 1

                for (verb in listOf<Pair<String, () -> Unit>>(
                    "burn" to { engine.burn(pairId, Party2.A, "after".toByteArray()) },
                    "status" to { engine.status(pairId) },
                )) {
                    val refusal = refusalOf { verb.second() }
                    assertEquals(
                        "[$name] ${verb.first} must refuse pair-destroyed, not proceed",
                        "pair-destroyed", refusal.reason,
                    )
                }
            } finally {
                root.setWritable(true, false)
                root.walkBottomUp().forEach { it.setReadable(true, false); it.setWritable(true, false) }
                root.deleteRecursively()
            }
        }
        assertTrue("no shape was exercised — the suite proved nothing", exercised >= 8)
    }

    /**
     * The end-to-end shape of the original defect: destroy for real, then let a
     * restore or a sync tool leave a broken link where the tombstone was.
     */
    @Test
    fun aDestroyedPairWhoseTombstoneBecomesADanglingSymlinkStaysDestroyed() {
        val root = tempRoot("tp-terminal-e2e")
        try {
            val fs = NioFs(root)
            val pairId = freshPadOn(fs)
            val engine = fixedEngine(fs)
            engine.destroy(pairId, pairId, "operator destroy")

            val marker = File(File(root, pairId), TOMBSTONE_FILE)
            assertTrue("the tombstone should exist after destroy", marker.isFile)
            marker.delete()
            try {
                Files.createSymbolicLink(marker.toPath(), File(root, "gone-target").toPath())
            } catch (_: Exception) {
                return // no symlink support here; the shape test above still ran
            }
            assertFalse("precondition: File.exists() is exactly what fooled the old gate", marker.exists())

            assertEquals(
                "a destroyed pair must not resurrect because its tombstone became a broken link",
                "pair-destroyed",
                refusalOf { engine.burn(pairId, Party2.A, "resurrected?".toByteArray()) }.reason,
            )
        } finally {
            root.deleteRecursively()
        }
    }

    // ---- the Fs-level contract ------------------------------------------------

    /**
     * `Fs.exists` means NOT KNOWN TO BE ABSENT. Only a definitive "nothing is
     * here" may be false.
     */
    @Test
    fun existsReportsPresenceForEveryNonAbsentShapeAndAbsenceOnlyWhenDefinite() {
        val root = tempRoot("tp-terminal-fs")
        try {
            val fs = NioFs(root)
            var exercised = 0
            for ((index, shape) in shapes.withIndex()) {
                val probe = File(root, "probe-$index")
                try {
                    shape.second(probe)
                } catch (_: Exception) {
                    continue
                }
                exercised += 1
                assertTrue("[${shape.first}] must read as present", fs.exists("probe-$index"))
            }
            assertTrue("no shape was exercised", exercised >= 8)

            // The ONE definitive negative: there is no such path.
            assertFalse(fs.exists("nothing-here"))
            assertFalse(fs.exists("no/such/directory/at/all.json"))

            // And a path whose parent is not a directory is NOT a definitive
            // negative -- the JDK does not map that errno portably, so the
            // conservative answer is the one all three editions give.
            File(root, "plain.bin").writeText("x")
            assertTrue(
                "a path that cannot be resolved is not a path known to be clear",
                fs.exists("plain.bin/under"),
            )
        } finally {
            root.walkBottomUp().forEach { it.setReadable(true, false); it.setWritable(true, false) }
            root.deleteRecursively()
        }
    }
}
