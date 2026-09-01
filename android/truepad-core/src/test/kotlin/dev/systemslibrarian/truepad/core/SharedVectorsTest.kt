package dev.systemslibrarian.truepad.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The Kotlin core reproduces the frozen vectors in android/vectors/ byte-for-byte.
 *
 * Those files are EMITTED BY the authoritative TS reference (spec/reference/
 * vectors.mjs and src/core at tag v2.0.0) — regenerate or verify them with
 * android/tools/regenerate-vectors.sh — so a pass here is agreement with what the
 * released CLI and Browser Edition actually produce, not a re-transcription of it.
 *
 * Note what this is NOT: the TypeScript suite does not read android/vectors/, so
 * these files are a one-way snapshot of the release rather than a fixture shared
 * between two live suites. `--check` is what keeps the snapshot honest; it fails
 * if the committed vectors have drifted from what v2.0.0 emits today.
 *
 * Any mismatch is a release blocker.
 */
class SharedVectorsTest {
    private val vectorsDir = File("../vectors")

    private fun readJsonObject(name: String): JsonObject =
        parseJson(File(vectorsDir, name).readText()) as JsonObject

    private fun JsonObject.arr(key: String) = (members.getValue(key) as JsonArray).items
    private fun JsonValue.obj() = this as JsonObject
    private fun JsonObject.str(key: String) = (members.getValue(key) as JsonString).value
    private fun JsonObject.numL(key: String) = (members.getValue(key) as JsonNumber).raw.toLong()
    private fun JsonObject.has(key: String) = members.containsKey(key)
    private fun h(s: String) = hexToBytes(s) ?: error("bad hex: $s")

    @Test
    fun wcOneTimeVectorsReproduceExactly() {
        val root = readJsonObject("wc-one-time-v1.json")
        val cases = root.arr("cases").map { it.obj() }
        assertTrue("expected the 5 frozen cases", cases.size == 5)
        for (c in cases) {
            val name = c.str("name")
            val key = h(c.str("key"))
            val direction = if (c.numL("direction") == 0L) Direction.A_TO_B else Direction.B_TO_A
            val ciphertext = if (c.has("ciphertextRule")) {
                // max-ciphertext: byte[i] = i mod 256, not embedded.
                ByteArray(c.numL("ciphertextLength").toInt()) { (it and 0xFF).toByte() }
            } else {
                h(c.str("ciphertext"))
            }
            val fields = CanonicalFields(
                pairId = h(c.str("pairId")),
                direction = direction,
                sequence = c.numL("sequence"),
                startOffset = c.numL("startOffset"),
                ciphertext = ciphertext,
            )
            if (c.has("canonicalBytes")) {
                assertEquals("[$name] canonicalBytes", c.str("canonicalBytes"), bytesToHex(canonicalBytes(fields)))
            }
            assertEquals("[$name] hash", c.str("hash"), bytesToHex(wcHash(key, fields)))
            if (c.has("tag") && members(c, "mask") != null) {
                assertEquals("[$name] tag", c.str("tag"), bytesToHex(wcTag(key, h(c.str("mask")), fields)))
            }
        }
    }

    private fun members(o: JsonObject, key: String): JsonValue? =
        o.members[key]?.takeUnless { it is JsonNull }

    @Test
    fun envelopeEncodeVectorsAreByteExact() {
        val root = readJsonObject("envelope-encode.json")
        for (c in root.arr("cases").map { it.obj() }) {
            val input = c.members.getValue("input").obj()
            val env = EnvelopeV2(
                pairId = input.str("pairId"),
                direction = Direction.fromWire(input.str("direction"))!!,
                sequence = input.numL("sequence"),
                startOffset = input.numL("startOffset"),
                ciphertextLength = input.numL("ciphertextLength"),
                ciphertext = h(input.str("ciphertextHex")),
                tag = h(input.str("tagHex")),
            )
            val wire = c.str("wire")
            assertEquals("encode byte-exact", wire, encodeEnvelope2(env))
            // And it round-trips through the strict decoder.
            val decoded = decodeEnvelope2(wire)
            assertTrue(decoded is EnvelopeDecode.Ok)
            assertEquals(env.pairId, (decoded as EnvelopeDecode.Ok).envelope.pairId)
            assertEquals(env.sequence, decoded.envelope.sequence)
        }
    }
}
