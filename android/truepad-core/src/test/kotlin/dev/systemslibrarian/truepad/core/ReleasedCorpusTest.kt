package dev.systemslibrarian.truepad.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The hostile §6.2 corpus, the §16 frame, and the §7 partition — all judged
 * against the RELEASED v2.0.0 implementation's own answers.
 *
 * These vectors are emitted by running the released TypeScript, so a mismatch
 * here is a real divergence between what Android would do and what the shipping
 * CLI and Browser Edition do, not a disagreement with a hand-written table.
 */
class ReleasedCorpusTest {

    /* ---- §6.2 strict envelope grammar --------------------------------------- */

    @Test
    fun envelopeRefusalsMatchTheRelease() {
        val cases = Vectors.obj("envelope-refusals.json").arr("corpus")
        assertTrue("expected a corpus", cases.size >= 15)
        val reasonsSeen = HashSet<String>()
        for (case in cases.map { it.asObj() }) {
            val name = case.str("name")
            val decoded = decodeEnvelope2(case.str("text"))
            if (case.bool("ok")) {
                assertTrue("$name should be accepted", decoded is EnvelopeDecode.Ok)
            } else {
                assertTrue("$name should be refused, got Ok", decoded is EnvelopeDecode.Refusal)
                val reason = (decoded as EnvelopeDecode.Refusal).reason
                assertEquals("refusal reason for $name", case.str("reason"), reason)
                reasonsSeen.add(reason)
            }
        }
        // The three typed reasons the frozen grammar can produce must all appear,
        // so a corpus that silently collapsed to one reason cannot pass.
        assertEquals(setOf("malformed-envelope", "envelope-v1", "oversize-ciphertext"), reasonsSeen)
    }

    /* ---- §16 fixed-size records ---------------------------------------------- */

    @Test
    fun frameBuildAndParseMatchTheRelease() {
        val v = Vectors.obj("frame-v2.json")
        for (case in v.arr("build").map { it.asObj() }) {
            val recordBytes = case.int("recordBytes")
            val plaintext = vhex(case.str("plaintextHex"))
            assertEquals("capacity for F=$recordBytes", case.int("capacity"), frameCapacity(recordBytes))
            val frame = buildFrame(plaintext, recordBytes)
            assertEquals("frame bytes for F=$recordBytes/${plaintext.size}", case.str("frameHex"), bytesToHex(frame))
            assertEquals("frame is exactly F bytes", recordBytes, frame.size)
            val parsed = parseFrame(frame)
            assertEquals("round trip for F=$recordBytes", case.strOrNull("parsedHex"), parsed?.let { bytesToHex(it) })
        }
        for (case in v.arr("parseRejects").map { it.asObj() }) {
            val name = case.str("name")
            val parsed = parseFrame(vhex(case.str("frameHex")))
            assertEquals("parseFrame verdict for $name", case.strOrNull("parsedHex"), parsed?.let { bytesToHex(it) })
        }
    }

    @Test
    fun aFrameRefusesAPlaintextPastCapacity() {
        try {
            buildFrame(ByteArray(29), 32)
            error("buildFrame accepted a plaintext past F-4")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("at most 28"))
        }
    }

    /* ---- §7 source-material partition ---------------------------------------- */

    @Test
    fun partitionMatchesTheRelease() {
        val cases = Vectors.obj("partition-v2.json").arr("cases")
        assertTrue(cases.isNotEmpty())
        for (case in cases.map { it.asObj() }) {
            val capacity = case.int("capacity")
            val capacityRecords = case.int("capacityRecords")
            val required = case.long("requiredSourceLength")
            assertEquals(
                "L = 2*(E + 32N) for E=$capacity N=$capacityRecords",
                required,
                requiredSourceLength(capacity.toLong(), capacityRecords.toLong()),
            )
            val sources = case.arr("sourcesHex").map { vhex((it as JsonString).value) }
            val combined = combineSources(sources, required.toInt())
            assertEquals("combined XOR", case.str("combinedHex"), bytesToHex(combined))
            val p = partition(combined, capacity, capacityRecords)
            assertEquals("abEncryption", case.str("abEncryptionHex"), bytesToHex(p.abEncryption))
            assertEquals("abAuthentication", case.str("abAuthenticationHex"), bytesToHex(p.abAuthentication))
            assertEquals("baEncryption", case.str("baEncryptionHex"), bytesToHex(p.baEncryption))
            assertEquals("baAuthentication", case.str("baAuthenticationHex"), bytesToHex(p.baAuthentication))
            for (rec in case.arr("abAuthRecords").map { it.asObj() }) {
                val (key, mask) = authRecordAt(p.abAuthentication, rec.int("sequence"))
                assertEquals("K_${rec.int("sequence")}", rec.str("keyHex"), bytesToHex(key))
                assertEquals("R_${rec.int("sequence")}", rec.str("maskHex"), bytesToHex(mask))
            }
        }
    }

    /**
     * §7: the partition NEVER inspects or conditions on content. Two identical
     * sources XOR to all zeros, and that is a legitimate draw — refusing it would
     * condition the accepted distribution, which is the mistake the removed
     * all-zero tripwire made.
     */
    @Test
    fun anAllZeroCombinedResultIsALegitimateDraw() {
        val src = ByteArray(96) { (it * 7).toByte() }
        val combined = combineSources(listOf(src, src.copyOf()), 96)
        assertTrue("identical sources must XOR to zero", combined.all { it == 0.toByte() })
        val p = partition(combined, 16, 1)
        assertEquals(16, p.abEncryption.size)
        assertEquals(32, p.abAuthentication.size)
    }

    @Test
    fun combineSourcesIsAllOrNothing() {
        try {
            combineSources(listOf(ByteArray(10), ByteArray(4)), 8)
            error("a short source was accepted")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("source 1 supplies 4 bytes"))
        }
        try {
            combineSources(emptyList(), 0)
            error("zero sources were accepted")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun partitionReturnsCopiesSoTheCombinedBufferCanBeZeroed() {
        val combined = ByteArray(96) { (it + 1).toByte() }
        val p = partition(combined, 16, 1)
        val before = bytesToHex(p.abEncryption)
        combined.fill(0)
        assertEquals("slices must not alias the combined buffer", before, bytesToHex(p.abEncryption))
    }

    /**
     * THE ALIASING TRAP. `sequence * 32` computed in Int wraps at 2^27: sequence
     * 134217728 gives 0, the bound check then passes, and the caller is handed
     * auth record 0's K and R for a completely different sequence — the same
     * one-time key used twice, which is the single failure this product exists to
     * prevent. The reference computes in Number and simply throws, so the Kotlin
     * must compute the offset in Long. This test fails loudly if it is ever
     * narrowed back.
     */
    @Test
    fun authRecordAtNeverAliasesRecordZeroThroughIntOverflow() {
        val slice = ByteArray(64) { (it + 1).toByte() }
        val recordZero = authRecordAt(slice, 0)
        for (sequence in listOf(1 shl 27, (1 shl 27) + 1, 1 shl 28, Int.MAX_VALUE)) {
            try {
                val (key, mask) = authRecordAt(slice, sequence)
                error(
                    "authRecordAt($sequence) returned K=${bytesToHex(key)} M=${bytesToHex(mask)} from a 64-byte " +
                        "slice — Int overflow aliased it onto record " +
                        (if (bytesToHex(key) == bytesToHex(recordZero.first)) "0" else "?"),
                )
            } catch (_: IllegalArgumentException) {
                // Correct: the record is out of range and is refused.
            }
        }
    }

    @Test
    fun authRecordAtRefusesPastTheSlice() {
        val slice = ByteArray(64)
        authRecordAt(slice, 0)
        authRecordAt(slice, 1)
        try {
            authRecordAt(slice, 2)
            error("read past the auth slice")
        } catch (_: IllegalArgumentException) {
        }
    }

    /* ---- hex strictness (both directions) ------------------------------------- */

    @Test
    fun hexAcceptsExactlyOneSpelling() {
        assertEquals("00ff", bytesToHex(byteArrayOf(0, 0xff.toByte())))
        assertNull("uppercase is refused, never normalised", hexToBytes("00FF"))
        assertNull(hexToBytes("f"))
        assertNull(hexToBytes("0x00"))
        assertNull(hexToBytes(" 00"))
        assertNull(hexToBytes("00 "))
        assertEquals(0, hexToBytes("")!!.size)
    }
}
