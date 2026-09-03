package dev.systemslibrarian.truepad.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * TP2 Compact Transport v1 against the RELEASED v2.0.0 codec.
 *
 * android/vectors/compact-envelope-v1.json is emitted by the released
 * src/core/compact-envelope2.ts itself, so every `compact` string here is what
 * the shipping CLI and Browser Edition actually produce, and every refusal
 * `reason` is what they actually return for that hostile input. This module is
 * the interop gap the preserved branch had: the released `open` verb accepts
 * either spelling through decodeEnvelopeTransport2, so an Android build without
 * it would refuse envelopes the shipping product emits.
 */
class CompactEnvelopeTest {
    private val v = Vectors.obj("compact-envelope-v1.json")

    private fun envelopeOf(input: JsonObject): EnvelopeV2 = EnvelopeV2(
        pairId = input.str("pairId"),
        direction = Direction.fromWire(input.str("direction"))!!,
        sequence = input.long("sequence"),
        startOffset = input.long("startOffset"),
        ciphertextLength = input.long("ciphertextLength"),
        ciphertext = vhex(input.str("ciphertextHex")),
        tag = vhex(input.str("tagHex")),
    )

    @Test
    fun encodesExactlyWhatTheReleaseEncodes() {
        val cases = v.arr("encode")
        assertTrue("expected encode vectors", cases.isNotEmpty())
        for (case in cases.map { it.asObj() }) {
            val name = case.str("name")
            val envelope = envelopeOf(case.obj("input"))
            assertEquals("compact spelling for $name", case.str("compact"), encodeCompactEnvelope2(envelope))
            assertEquals("canonical JSON for $name", case.str("json"), encodeEnvelope2(envelope))
        }
    }

    @Test
    fun compactRoundTripsBackToTheSameEnvelope() {
        for (case in v.arr("encode").map { it.asObj() }) {
            val name = case.str("name")
            val expected = envelopeOf(case.obj("input"))
            val decoded = decodeCompactEnvelope2(case.str("compact"))
            assertTrue("$name should decode", decoded is EnvelopeDecode.Ok)
            val got = (decoded as EnvelopeDecode.Ok).envelope
            assertEquals(name, expected.pairId, got.pairId)
            assertEquals(name, expected.direction, got.direction)
            assertEquals(name, expected.sequence, got.sequence)
            assertEquals(name, expected.startOffset, got.startOffset)
            assertEquals(name, expected.ciphertextLength, got.ciphertextLength)
            assertEquals(name, bytesToHex(expected.ciphertext), bytesToHex(got.ciphertext))
            assertEquals(name, bytesToHex(expected.tag), bytesToHex(got.tag))
            // And the two spellings are interchangeable at the door.
            assertEquals(name, case.str("json"), encodeEnvelope2(got))
        }
    }

    @Test
    fun theHostileCorpusGetsTheReleasedVerdict() {
        val cases = v.arr("decode")
        assertTrue("expected decode vectors", cases.isNotEmpty())
        var refusals = 0
        for (case in cases.map { it.asObj() }) {
            val name = case.str("name")
            val decoded = decodeCompactEnvelope2(case.str("text"))
            if (case.bool("ok")) {
                assertTrue("$name should be accepted", decoded is EnvelopeDecode.Ok)
            } else {
                refusals += 1
                assertTrue("$name should be refused", decoded is EnvelopeDecode.Refusal)
                assertEquals("refusal reason for $name", case.str("reason"), (decoded as EnvelopeDecode.Refusal).reason)
            }
        }
        assertTrue("the corpus must actually exercise refusals", refusals >= 10)
    }

    @Test
    fun theTransportDoorRoutesBothSpellings() {
        for (case in v.arr("transportDoor").map { it.asObj() }) {
            val name = case.str("name")
            val decoded = decodeEnvelopeTransport2(case.str("text"))
            if (case.bool("ok")) {
                assertTrue("$name should be accepted", decoded is EnvelopeDecode.Ok)
            } else {
                assertTrue("$name should be refused", decoded is EnvelopeDecode.Refusal)
                assertEquals("reason for $name", case.str("reason"), (decoded as EnvelopeDecode.Refusal).reason)
            }
        }
    }

    /**
     * A half-typed compact string is NOT a JSON document. It must be refused AS
     * compact and never fall through to the JSON parser, which would report the
     * wrong error and invite a parser-confusion bug.
     */
    @Test
    fun aTp2InputNeverFallsThroughToTheJsonParser() {
        val d = decodeEnvelopeTransport2("TP2:")
        assertTrue(d is EnvelopeDecode.Refusal)
        assertTrue(
            "must be refused as compact, not as JSON",
            (d as EnvelopeDecode.Refusal).message.contains("TP2:"),
        )
    }

    @Test
    fun base64UrlIsCanonicalInBothDirections() {
        // "" is the encoding of zero bytes; a 1-character group is impossible.
        assertEquals("", toBase64Url(ByteArray(0)))
        assertEquals(0, fromBase64Url("")!!.size)
        assertNull(fromBase64Url("A"))
        assertNull(fromBase64Url("AAAAA"))
        // Standard-alphabet and padded spellings are not the base64url alphabet.
        assertNull(fromBase64Url("+A=="))
        assertNull(fromBase64Url("/AAA"))
        assertNull(fromBase64Url("AA=="))
        assertNull(fromBase64Url("AA A"))
        // Round-trip over every byte value.
        val all = ByteArray(256) { it.toByte() }
        for (n in 0..64) {
            val slice = all.copyOfRange(0, n)
            assertEquals("round trip at $n", bytesToHex(slice), bytesToHex(fromBase64Url(toBase64Url(slice))!!))
        }
    }

    @Test
    fun oversizeIsItsOwnReasonNotMalformed() {
        // Built by hand: a declared ciphertextLength above the v2 ceiling.
        val head = mutableListOf<Byte>(0x01, 0x02)
        repeat(16) { head.add(0xaa.toByte()) }
        head.add(0x00)
        head.add(0x00) // sequence 0
        head.add(0x00) // startOffset 0
        // ciphertextLength = 1048577 as a minimal uleb128
        var v2 = 1_048_577
        do {
            val b = v2 and 0x7f
            v2 = v2 ushr 7
            head.add((if (v2 > 0) b or 0x80 else b).toByte())
        } while (v2 > 0)
        val d = decodeCompactEnvelope2(COMPACT_PREFIX + toBase64Url(head.toByteArray()))
        assertTrue(d is EnvelopeDecode.Refusal)
        assertEquals("oversize-ciphertext", (d as EnvelopeDecode.Refusal).reason)
    }

    @Test
    fun anEmptyCiphertextIsAValidCompactEnvelope() {
        val env = EnvelopeV2(
            pairId = "00112233445566778899aabbccddeeff",
            direction = Direction.B_TO_A,
            sequence = 0, startOffset = 0, ciphertextLength = 0,
            ciphertext = ByteArray(0), tag = ByteArray(16),
        )
        val text = encodeCompactEnvelope2(env)
        assertTrue(isCompactEnvelope2(text))
        assertFalse(isCompactEnvelope2(encodeEnvelope2(env)))
        val d = decodeCompactEnvelope2(text)
        assertTrue(d is EnvelopeDecode.Ok)
        assertEquals(0, (d as EnvelopeDecode.Ok).envelope.ciphertext.size)
    }
}
