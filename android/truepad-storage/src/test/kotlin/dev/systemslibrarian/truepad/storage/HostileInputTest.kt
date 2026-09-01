package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.core.bytesToHex
import dev.systemslibrarian.truepad.core.requiredSourceLength
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * EVERYTHING FROM OUTSIDE IS UNTRUSTED.
 *
 * On Android an envelope arrives from the clipboard, a share intent, or a text
 * field, and a pad bundle arrives as a content:// URI some other app chose. None
 * of it is trustworthy, none of it is even necessarily well-formed, and a hostile
 * app can send an arbitrary byte sequence to any component that accepts one.
 *
 * The requirement is not "handle it gracefully". It is FAIL CLOSED: a refusal
 * that consumes nothing, names what was wrong, and leaves the store exactly as it
 * was found.
 */
class HostileInputTest {

    private fun pair(fs: MemoryFs, capacity: Long = 512, records: Long = 8): Engine {
        val e = fixedEngine(fs)
        val need = requiredSourceLength(capacity, records).toInt()
        e.gen("hostile", listOf(SourceInput("s", "o", genBytes(need, 31))), capacity, records, witnessKind = WitnessKind.LOCAL)
        return e
    }

    /** A snapshot of every byte, so "consumed nothing" can be checked literally. */
    private fun fingerprint(fs: MemoryFs, pairId: String): String =
        allPaths(fs, pairId).joinToString("|") { p -> p + "=" + (fs.readFile(p)?.let { bytesToHex(it) } ?: "-") }

    @Test
    fun everyHostileEnvelopeIsRefusedAndConsumesNothing() {
        val fs = MemoryFs()
        val e = pair(fs)
        val before = fingerprint(fs, FIXED_PAIR_ID)

        val hostile = listOf(
            "empty" to "",
            "whitespace" to "   \n\t ",
            "not json" to "hello there",
            "an array" to "[1,2,3]",
            "a bare number" to "42",
            "null" to "null",
            "a v1 envelope" to "{\"label\":\"x\",\"ciphertext\":\"00\"}",
            "an object with no fields" to "{}",
            "a truncated envelope" to "{\"formatVersion\":2,\"pairId\":\"",
            "a half-typed compact paste" to "TP2:",
            "compact garbage" to "TP2:!!!!",
            "a huge repeated key" to "{" + "\"a\":1,".repeat(5000) + "\"b\":2}",
            "deep nesting" to "[".repeat(20_000) + "]".repeat(20_000),
            // Written as \u0000, never as a raw NUL byte in the source: a control
            // character embedded in a source file makes git treat the whole file
            // as binary, so it stops being diffable and reviewable. The value the
            // parser sees is identical.
            "a NUL byte" to "{\"formatVersion\":2,\u0000}",
            "unicode confusables in direction" to
                "{\"formatVersion\":2,\"pairId\":\"$FIXED_PAIR_ID\",\"direction\":\"А->B\",\"sequence\":0," +
                "\"startOffset\":0,\"ciphertextLength\":0,\"ciphertext\":\"\",\"tag\":\"${"0".repeat(32)}\"}",
        )
        for ((why, text) in hostile) {
            val r = refusalOf { e.open(FIXED_PAIR_ID, Party2.B, text) }
            assertTrue("$why must carry a typed reason", r.reason.isNotEmpty())
            assertEquals("nothing may be consumed by: $why", before, fingerprint(fs, FIXED_PAIR_ID))
        }
    }

    /** An envelope for someone else's pad, or the wrong direction, is refused. */
    @Test
    fun anEnvelopeForAnotherPairOrDirectionIsRefused() {
        val fs = MemoryFs()
        val e = pair(fs)
        val other = MemoryFs()
        fixedEngine(other, pairIdHex = "ffffffffffffffffffffffffffffffff").gen(
            "other", listOf(SourceInput("s", "o", genBytes(requiredSourceLength(512, 8).toInt(), 9))), 512, 8,
        )
        val foreign = fixedEngine(other, pairIdHex = "ffffffffffffffffffffffffffffffff")
            .burn("ffffffffffffffffffffffffffffffff", Party2.A, "not yours".toByteArray()).envelope
        assertEquals("wrong-pair", refusalOf { e.open(FIXED_PAIR_ID, Party2.B, foreign) }.reason)

        // A->B traffic opened by the party who SENDS A->B is the wrong direction.
        val own = e.burn(FIXED_PAIR_ID, Party2.A, "mine".toByteArray()).envelope
        assertEquals("wrong-direction", refusalOf { e.open(FIXED_PAIR_ID, Party2.A, own) }.reason)
    }

    /** Every malformed bundle is refused WHOLE, before anything becomes active. */
    @Test
    fun everyMalformedBundleIsRefusedAndLeavesNoPair() {
        val aliceFs = MemoryFs()
        val alice = pair(aliceFs)
        val good = String(alice.exportPair(FIXED_PAIR_ID).container, Charsets.UTF_8)

        val hostile = listOf(
            "empty" to "",
            "not json" to "just some bytes",
            "wrong tag" to good.replace(CONTAINER_TAG, "some-other-bundle"),
            "no pairId" to good.replace("\"pairId\": \"$FIXED_PAIR_ID\"", "\"pairId\": 7"),
            "non-hex pairId" to good.replace(FIXED_PAIR_ID, "not-a-pair-id-at-all-really-32ch"),
            "uppercase pairId" to good.replace(FIXED_PAIR_ID, FIXED_PAIR_ID.uppercase()),
            "no files" to good.replace("\"files\"", "\"filez\""),
            "a path outside the store" to good.replace("a-to-b/head.json", "../../../etc/passwd"),
            "an absolute path" to good.replace("a-to-b/head.json", "/system/bin/sh"),
            "a duplicated file" to good.replace("\"path\": \"b-to-a/head.json\"", "\"path\": \"a-to-b/head.json\""),
            "invalid base64" to good.replace(Regex("\"bytesB64\": \"[A-Za-z0-9+/=]{8}"), "\"bytesB64\": \"!!!!!!!!"),
        )
        for ((why, text) in hostile) {
            val fs = MemoryFs()
            val r = refusalOf { fixedEngine(fs).importPair("in", text.toByteArray()) }
            assertTrue("$why must be typed, got ${r.reason}", r.reason.isNotEmpty())
            assertFalse("$why must leave no active pair", fs.exists(pairMetaPath(FIXED_PAIR_ID)))
            assertFalse("$why must leave no head", fs.exists(headPath(FIXED_PAIR_ID, Direction.A_TO_B)))
            assertTrue("$why must leave no staging", fs.list(STAGING_ROOT).isEmpty())
        }
        // A truncated file body passes the container grammar and is caught by the
        // FORMAT-V2 validation in staging — still before anything becomes active.
        val shortSecret = good.replace(Regex("(\"path\": \"a-to-b/secret.bin\",\\s*\"bytesB64\": \")[A-Za-z0-9+/=]+"), "$1AAAA")
        val fs = MemoryFs()
        val r = refusalOf { fixedEngine(fs).importPair("in", shortSecret.toByteArray()) }
        assertEquals("corrupt-secret-body", r.reason)
        assertFalse(fs.exists(pairMetaPath(FIXED_PAIR_ID)))
        assertTrue(fs.list(STAGING_ROOT).isEmpty())
    }

    /**
     * A bundle whose two halves are not a matched pair — the same direction
     * twice, or a header naming a different pairId — is refused. Importing one
     * would create a store that cannot talk to anybody and might collide.
     */
    @Test
    fun aMismatchedBundleIsRefused() {
        val aliceFs = MemoryFs()
        val alice = pair(aliceFs)
        val good = String(alice.exportPair(FIXED_PAIR_ID).container, Charsets.UTF_8)

        // Give the b-to-a slot the a-to-b header: the halves no longer match.
        val abHead = Regex("\\{\\s*\"path\": \"a-to-b/head\\.json\",\\s*\"bytesB64\": \"([^\"]+)\"").find(good)!!.groupValues[1]
        val baHead = Regex("\\{\\s*\"path\": \"b-to-a/head\\.json\",\\s*\"bytesB64\": \"([^\"]+)\"").find(good)!!.groupValues[1]
        val swapped = good.replace(baHead, abHead)
        val fs = MemoryFs()
        val r = refusalOf { fixedEngine(fs).importPair("in", swapped.toByteArray()) }
        assertTrue("expected a mismatch refusal, got ${r.reason}", r.reason == "malformed-bundle" || r.reason == "corrupt-head")
        assertFalse(fs.exists(pairMetaPath(FIXED_PAIR_ID)))
    }

    /** A pad that already exists here is never overwritten by an import. */
    @Test
    fun importingOverAnExistingPairIsRefused() {
        val aliceFs = MemoryFs()
        val alice = pair(aliceFs)
        val container = alice.exportPair(FIXED_PAIR_ID).container
        val bobFs = MemoryFs()
        fixedEngine(bobFs).importPair("bob", container)
        val spent = fixedEngine(bobFs)
        spent.burn(FIXED_PAIR_ID, Party2.B, "bob used some".toByteArray())
        val before = fingerprint(bobFs, FIXED_PAIR_ID)

        val r = refusalOf { fixedEngine(bobFs).importPair("again", container) }
        assertEquals("pair-exists", r.reason)
        assertEquals("re-importing must not roll the store back", before, fingerprint(bobFs, FIXED_PAIR_ID))
    }

    /** Source material shorter than L is refused before a single byte is written. */
    @Test
    fun shortSourceMaterialIsRefusedBeforeAnythingIsWritten() {
        val fs = MemoryFs()
        val r = refusalOf {
            fixedEngine(fs).gen("short", listOf(SourceInput("tiny.bin", "o", ByteArray(10))), 256, 4)
        }
        assertEquals("source-too-short", r.reason)
        assertTrue(r.text.contains("tiny.bin"))
        assertTrue("nothing may be written", fs.list("").isEmpty())
    }

    /** gen's domain violations are programming errors, not typed refusals. */
    @Test
    fun genRefusesOutOfDomainParameters() {
        val fs = MemoryFs()
        val e = fixedEngine(fs)
        val src = listOf(SourceInput("s", "o", genBytes(4096, 1)))
        for (bad in listOf<() -> Unit>(
            { e.gen("x", src, 0, 4) },
            { e.gen("x", src, -1, 4) },
            { e.gen("x", src, 256, 0) },
            { e.gen("x", emptyList(), 256, 4) },
            { e.gen("x", src, 256, 4, recordBytes = 31) },
            { e.gen("x", src, 256, 4, recordBytes = 40) },
            { e.gen("x", src, 256, 4, recordBytes = 16) },
        )) {
            try {
                bad()
                error("an out-of-domain gen was accepted")
            } catch (_: IllegalArgumentException) {
            }
        }
        assertTrue("nothing may be written", fs.list("").isEmpty())
    }

    /**
     * §16: a fixed-record store accepts exactly F ciphertext bytes and nothing
     * else, in both directions of the protocol.
     */
    @Test
    fun aFixedRecordStoreRefusesAnyOtherSize() {
        val fs = MemoryFs()
        val e = fixedEngine(fs)
        val need = requiredSourceLength(1024, 8).toInt()
        e.gen("fixed", listOf(SourceInput("s", "o", genBytes(need, 4))), 1024, 8, recordBytes = 64, witnessKind = WitnessKind.LOCAL)
        val container = e.exportPair(FIXED_PAIR_ID).container

        // F - 4 is the capacity; one more is refused at SEND.
        e.burn(FIXED_PAIR_ID, Party2.A, ByteArray(60))
        val r = refusalOf { e.burn(FIXED_PAIR_ID, Party2.A, ByteArray(61)) }
        assertEquals("record-size-mismatch", r.reason)
        assertTrue(r.text.contains("at most 60"))

        // And a variable-size envelope is refused at OPEN, even before any window
        // check: it cannot be one of this store's records.
        val varFs = MemoryFs()
        val varEngine = fixedEngine(varFs, pairIdHex = FIXED_PAIR_ID)
        varEngine.gen("var", listOf(SourceInput("s", "o", genBytes(need, 4))), 1024, 8)
        val bobFs = MemoryFs()
        fixedEngine(bobFs).importPair("bob", container)
        val shortEnvelope = varEngine.burn(FIXED_PAIR_ID, Party2.A, ByteArray(3)).envelope
        assertEquals("record-size-mismatch", refusalOf { fixedEngine(bobFs).open(FIXED_PAIR_ID, Party2.B, shortEnvelope) }.reason)
    }

    /**
     * The pad LIST is what an app renders, so it has its own contract: a
     * destroyed pair still appears (its tombstone is permanent) but carries no
     * meters, a pair too broken to summarise is skipped rather than shown as a
     * broken row, and nothing that is not a pair directory is ever listed.
     */
    @Test
    fun theListDistinguishesLiveDestroyedAndUnsummarisablePairs() {
        val fs = MemoryFs()
        val live = fixedEngine(fs, pairIdHex = "aa".repeat(16))
        live.gen("live one", traceSources(256, 4), 256, 4, witnessKind = WitnessKind.LOCAL)
        val dead = fixedEngine(fs, pairIdHex = "bb".repeat(16))
        dead.gen("dead one", traceSources(256, 4), 256, 4, witnessKind = WitnessKind.LOCAL)
        dead.destroy("bb".repeat(16), "bb".repeat(16), "operator destroy")

        // Junk that shares the store root must never be mistaken for a pad:
        // the lock directory, the staging root, and a stray file.
        fs.writeFileAtomic("$STAGING_ROOT/leftover/x", ByteArray(1))
        fs.writeFileAtomic("not-a-pair-id/$HEAD_FILE", ByteArray(1))
        fs.writeFileAtomic("witness/${"cc".repeat(16)}.log", ByteArray(1))

        val entries = fixedEngine(fs).listSummaries()
        assertEquals(listOf("aa".repeat(16), "bb".repeat(16)), entries.map { it.pairId })

        val liveEntry = entries.first { it.pairId == "aa".repeat(16) }
        assertFalse(liveEntry.destroyed)
        assertEquals("live one", liveEntry.label)
        assertEquals(256L, liveEntry.summary!!.meters.getValue(Direction.A_TO_B).capacity)

        val deadEntry = entries.first { it.pairId == "bb".repeat(16) }
        assertTrue("a destroyed pad still has a row", deadEntry.destroyed)
        assertEquals("dead one", deadEntry.label)
        assertNull("and no meters can be fabricated for it", deadEntry.summary)

        // A half-built pair is skipped, not surfaced as a broken row — but it is
        // still on disk and every verb still refuses it.
        fs.writeFileAtomic("${storeDir("dd".repeat(16), Direction.A_TO_B)}/$HEAD_FILE", "{".toByteArray())
        val after = fixedEngine(fs).listSummaries()
        assertEquals("the broken pair is not listed", 2, after.size)
        assertTrue("but listPairs still sees the directory", fixedEngine(fs).listPairs().contains("dd".repeat(16)))
        assertEquals("half-pair", refusalOf { fixedEngine(fs).status("dd".repeat(16)) }.reason)
    }

    /** Every record is padded to F, so ciphertext length leaks no message length. */
    @Test
    fun aFixedRecordStoreHidesMessageLength() {
        val fs = MemoryFs()
        val e = fixedEngine(fs)
        val need = requiredSourceLength(1024, 8).toInt()
        e.gen("fixed", listOf(SourceInput("s", "o", genBytes(need, 4))), 1024, 8, recordBytes = 64, witnessKind = WitnessKind.LOCAL)
        val container = e.exportPair(FIXED_PAIR_ID).container
        val lengths = listOf(0, 1, 17, 60).map { e.burn(FIXED_PAIR_ID, Party2.A, ByteArray(it)).encryptionBytes }
        assertEquals("every record is exactly F bytes on the wire", listOf(64, 64, 64, 64), lengths)

        val bobFs = MemoryFs()
        fixedEngine(bobFs).importPair("bob", container)
        val bob = fixedEngine(bobFs)
        val e2 = fixedEngine(fs)
        assertTrue(e2.status(FIXED_PAIR_ID).meters.getValue(Direction.A_TO_B).nextOffset == 256L)
        assertTrue(bob.status(FIXED_PAIR_ID).meters.getValue(Direction.A_TO_B).nextOffset == 0L)
    }
}
