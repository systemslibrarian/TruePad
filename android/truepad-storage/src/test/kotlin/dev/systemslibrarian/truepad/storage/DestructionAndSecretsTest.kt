package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.core.bytesToHex
import dev.systemslibrarian.truepad.core.requiredSourceLength
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * §17 destruction, the secret boundary, and the no-telemetry rule.
 *
 * Destruction is the one irreversible verb, and the tombstone — not the absence
 * of files — is what makes it irreversible. The honest limitation is stated in
 * the tombstone itself and repeated here: software can forget its reference to
 * pad material; it cannot prove that flash forgot the bytes.
 */
class DestructionAndSecretsTest {

    private fun pair(fs: MemoryFs, capacity: Long = 512, records: Long = 8, seed: Int = 44): Engine {
        val e = fixedEngine(fs)
        val need = requiredSourceLength(capacity, records).toInt()
        e.gen("destroy", listOf(SourceInput("s", "o", genBytes(need, seed))), capacity, records, witnessKind = WitnessKind.LOCAL)
        return e
    }

    /* ---- destruction --------------------------------------------------------- */

    @Test
    fun destructionRequiresThePairIdAndNeverEchoesIt() {
        val fs = MemoryFs()
        val e = pair(fs)
        for (wrong in listOf("", "yes", "destroy", FIXED_PAIR_ID.uppercase(), FIXED_PAIR_ID.dropLast(1))) {
            val r = refusalOf { e.destroy(FIXED_PAIR_ID, wrong) }
            assertEquals("destroy-unconfirmed", r.reason)
            assertFalse(
                "the confirmation prompt must NOT echo the pairId — the operator confirms by knowing it",
                r.text.contains(FIXED_PAIR_ID),
            )
        }
        assertTrue("the pair is untouched", fs.exists(headPath(FIXED_PAIR_ID, Direction.A_TO_B)))
    }

    @Test
    fun aDestroyedPadCanNeverResurrect() {
        val fs = MemoryFs()
        val e = pair(fs)
        val container = e.exportPair(FIXED_PAIR_ID).container
        val env = e.burn(FIXED_PAIR_ID, Party2.A, "last words".toByteArray()).envelope

        val r = e.destroy(FIXED_PAIR_ID, FIXED_PAIR_ID, "operator destroy")
        assertFalse(r.alreadyDestroyed)
        assertEquals(DESTROY_LIMITATION, r.limitation)

        // Every file is gone.
        for (d in Direction.entries) {
            assertNull(fs.readFile(headPath(FIXED_PAIR_ID, d)))
            assertNull(fs.readFile(secretPath(FIXED_PAIR_ID, d)))
            assertNull(fs.readFile(journalPath(FIXED_PAIR_ID, d)))
        }
        // And the tombstone stands in their place. It, not their absence, is the
        // boundary: every verb is refused pair-destroyed from here on.
        assertTrue(fs.exists(tombstonePath(FIXED_PAIR_ID)))
        val fresh = fixedEngine(fs)
        for (verb in listOf<() -> Unit>(
            { fresh.status(FIXED_PAIR_ID) },
            { fresh.burn(FIXED_PAIR_ID, Party2.A, "hello".toByteArray()) },
            { fresh.open(FIXED_PAIR_ID, Party2.B, env) },
            { fresh.retire(FIXED_PAIR_ID, Direction.A_TO_B, 1) },
            { fresh.exportPair(FIXED_PAIR_ID) },
            { fresh.clearFreeze(FIXED_PAIR_ID) },
        )) {
            assertEquals("pair-destroyed", refusalOf(verb).reason)
        }
        // THE RESURRECTION ATTEMPT: re-importing the pad's own courier bundle,
        // which still holds every byte of the material. The tombstone refuses it.
        assertEquals("pair-destroyed", refusalOf { fresh.importPair("back from the dead", container) }.reason)
        assertNull("and no store was written", fs.readFile(headPath(FIXED_PAIR_ID, Direction.A_TO_B)))
    }

    @Test
    fun theTombstoneRecordsTheFinalHighWatersAndTheHonestLimitation() {
        val fs = MemoryFs()
        val e = pair(fs)
        e.burn(FIXED_PAIR_ID, Party2.A, "five!".toByteArray())
        e.destroy(FIXED_PAIR_ID, FIXED_PAIR_ID, "lost the phone")
        val t = textAt(fs, tombstonePath(FIXED_PAIR_ID))
        assertTrue(t.contains("\"formatVersion\": 2"))
        assertTrue(t.contains("\"pairId\": \"$FIXED_PAIR_ID\""))
        assertTrue(t.contains("\"reason\": \"lost the phone\""))
        assertTrue("A->B burned five bytes and one record", t.contains("\"nextOffset\": 5") && t.contains("\"nextSequence\": 1"))
        assertTrue("B->A never moved", t.contains("\"nextOffset\": 0"))
        assertTrue("the limitation is stated verbatim, not softened", t.contains(DESTROY_LIMITATION))
        assertTrue("no pad material may appear in the tombstone", !t.contains("secret"))
    }

    /** A pair too corrupt to name itself still has an escape hatch, and it is explicit. */
    @Test
    fun anUnreadablePairIsDestroyedWithTheLiteralToken() {
        val fs = MemoryFs()
        pair(fs)
        for (d in Direction.entries) fs.writeFileAtomic(headPath(FIXED_PAIR_ID, d), "{ruined".toByteArray())
        val e = fixedEngine(fs)
        val r = refusalOf { e.destroy(FIXED_PAIR_ID, FIXED_PAIR_ID) }
        assertEquals("destroy-unconfirmed", r.reason)
        assertTrue(r.text.contains(UNREADABLE_PAIR_TOKEN))
        val done = e.destroy(FIXED_PAIR_ID, UNREADABLE_PAIR_TOKEN)
        assertFalse(done.alreadyDestroyed)
        assertTrue(textAt(fs, tombstonePath(FIXED_PAIR_ID)).contains("\"pairId\": null"))
    }

    /** §17.2 step 3: secret.bin is zero-overwritten before it is unlinked. */
    @Test
    fun secretBinIsZeroOverwrittenBeforeUnlink() {
        val fs = MemoryFs()
        val rec = RecordingFs(fs)
        pair(fs)
        fixedEngine(rec, witnessFs = rec).destroy(FIXED_PAIR_ID, FIXED_PAIR_ID)
        val ab = rec.writes.filter { it.contains("a-to-b") }
        assertEquals("range:$FIXED_PAIR_ID/a-to-b/$SECRET_FILE", ab.first())
        assertTrue("the zero-overwrite precedes the unlink", ab.indexOf("remove:$FIXED_PAIR_ID/a-to-b/$SECRET_FILE") > 0)
    }

    /** A pad may leave this installation ONCE, by one route. */
    @Test
    fun aPadGetsExactlyOneHandoffAndATornMarkerIsSpentNotAbsent() {
        val fs = MemoryFs()
        val e = pair(fs)
        val first = e.exportPair(FIXED_PAIR_ID)
        assertTrue(fs.exists(handoffMarkerPath(FIXED_PAIR_ID)))
        val marker = textAt(fs, handoffMarkerPath(FIXED_PAIR_ID))
        // A re-export under an existing PHYSICAL marker is allowed under the
        // frozen legacy policy, and does NOT rewrite the marker: the recorded time
        // stays the time of the FIRST handoff.
        val second = e.exportPair(FIXED_PAIR_ID)
        assertEquals(marker, textAt(fs, handoffMarkerPath(FIXED_PAIR_ID)))
        assertEquals(bytesToHex(first.container), bytesToHex(second.container))

        // EXISTENCE IS LOAD-BEARING. A marker that cannot be read is not "no
        // handoff" — it is a handoff that may already have happened, so it fails
        // closed. There is deliberately no path that treats it as absence.
        for (torn in listOf("", "{", "{}", "{\"version\":1}", marker.replace("\"physical\"", "\"sealed\""))) {
            fs.writeFileAtomic(handoffMarkerPath(FIXED_PAIR_ID), torn.toByteArray())
            val r = refusalOf { fixedEngine(fs).exportPair(FIXED_PAIR_ID) }
            assertEquals("a torn marker must be spent, not absent: \"$torn\"", REFUSE_UNREADABLE, r.reason)
            assertTrue(r.text.contains("Generate a new pad"))
        }
        // A well-formed SEALED marker from another edition refuses with its own
        // reason — never ignored, never mistaken for absence.
        val sealedMarker = "{\"version\":1,\"pairId\":\"$FIXED_PAIR_ID\",\"mode\":\"sealed\",\"at\":\"$FIXED_NOW\"," +
            "\"requestHash\":\"" + "A".repeat(43) + "\",\"packageIdentity\":\"" + "A".repeat(43) + "\"," +
            "\"confirmHash\":\"" + "A".repeat(43) + "\"}"
        fs.writeFileAtomic(handoffMarkerPath(FIXED_PAIR_ID), sealedMarker.toByteArray())
        assertEquals(REFUSE_ALREADY_SEALED, refusalOf { fixedEngine(fs).exportPair(FIXED_PAIR_ID) }.reason)
    }

    /* ---- the secret boundary -------------------------------------------------- */

    /**
     * NO PAD MATERIAL MAY LEAVE THROUGH AN ERROR PATH.
     *
     * An Android exception message reaches logcat, a crash reporter, and
     * sometimes the screen. Refusals may name lengths, offsets, sequence numbers
     * and counters — all already visible in `status` — but never a pad byte, a
     * Wegman-Carter key or mask, a tag value, or a plaintext.
     */
    @Test
    fun noRefusalMessageEverCarriesASecret() {
        val fs = MemoryFs()
        val e = pair(fs, seed = 99)
        val container = e.exportPair(FIXED_PAIR_ID).container
        val secretHex = bytesToHex(fs.readFile(secretPath(FIXED_PAIR_ID, Direction.A_TO_B))!!)
        val plaintext = "TOP SECRET RENDEZVOUS AT DAWN"
        val env = e.burn(FIXED_PAIR_ID, Party2.A, plaintext.toByteArray()).envelope

        val bobFs = MemoryFs()
        fixedEngine(bobFs).importPair("bob", container)
        val bob = fixedEngine(bobFs)

        // The EXPECTED tag is as secret as the key that produced it: telling the
        // sender of a forgery what the tag should have been hands them a verifying
        // record for that sequence, which is the whole forgery bound gone.
        val expectedTag = Regex("\"tag\":\"([0-9a-f]{32})\"").find(env)!!.groupValues[1]

        val messages = ArrayList<String>()
        messages += refusalOf { bob.open(FIXED_PAIR_ID, Party2.B, tamperTag(env)) }.text
        messages += refusalOf { bob.open(FIXED_PAIR_ID, Party2.B, "garbage") }.text
        messages += refusalOf { bob.open(FIXED_PAIR_ID, Party2.B, env.replace(FIXED_PAIR_ID, "0".repeat(32))) }.text
        messages += refusalOf { e.burn(FIXED_PAIR_ID, Party2.A, ByteArray(10_000)) }.text
        messages += refusalOf { e.retire(FIXED_PAIR_ID, Direction.A_TO_B, 999) }.text
        messages += refusalOf { e.destroy(FIXED_PAIR_ID, "nope") }.text
        messages += refusalOf { fixedEngine(MemoryFs()).importPair("x", "junk".toByteArray()) }.text
        bob.open(FIXED_PAIR_ID, Party2.B, env) // succeed, then replay
        messages += refusalOf { bob.open(FIXED_PAIR_ID, Party2.B, env) }.text

        // Any 16-byte run of the secret body would be a whole key or mask.
        val windows = (0..(secretHex.length - 32) step 32).map { secretHex.substring(it, it + 32) }
        for (m in messages) {
            assertTrue("a refusal must not be empty", m.isNotEmpty())
            assertFalse("plaintext leaked into: $m", m.contains(plaintext))
            assertFalse("plaintext leaked case-folded into: $m", m.lowercase().contains("rendezvous"))
            assertFalse("the expected tag leaked into: $m", m.contains(expectedTag))
            for (w in windows) {
                assertFalse("pad material $w leaked into: $m", m.contains(w))
            }
        }
    }

    /**
     * TruePad needs no analytics, no crash reporting, and no network to function.
     * This is a source-level audit, not a runtime one: a dependency added later
     * would pass every behavioural test and still be a leak, so the check has to
     * look at the code.
     */
    @Test
    fun theEngineHasNoLoggingTelemetryOrNetworkSurface() {
        val roots = listOf(File("src/main/kotlin"), File("../truepad-core/src/main/kotlin"))
        val sources = roots.flatMap { it.walkTopDown().filter { f -> f.extension == "kt" }.toList() }
        assertTrue("the audit must actually find sources", sources.size >= 10)

        val banned = listOf(
            "android.util.Log", "Log.d(", "Log.e(", "Log.i(", "Log.v(", "Log.w(",
            "println(", "print(", "System.out", "System.err", "printStackTrace",
            "java.net.", "HttpURLConnection", "okhttp", "retrofit", "Socket(",
            "firebase", "crashlytics", "analytics", "Sentry", "WebSocket",
        )
        for (f in sources) {
            val text = f.readText()
            for (b in banned) {
                assertFalse("${f.name} must not reference $b", text.contains(b))
            }
        }

        // And no production dependency can bring one in: both modules depend on
        // the Kotlin stdlib and each other, and nothing else.
        for (g in listOf(File("build.gradle.kts"), File("../truepad-core/build.gradle.kts"))) {
            val deps = g.readText().substringAfter("dependencies {").substringBefore("}")
            for (line in deps.lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("//") }) {
                assertTrue(
                    "unexpected production dependency in ${g.path}: $line",
                    line.startsWith("testImplementation") || line == "api(project(\":truepad-core\"))",
                )
            }
        }
    }
}
