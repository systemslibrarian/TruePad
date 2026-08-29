package dev.systemslibrarian.truepad.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The strict decoder gives the SAME typed refusal as tests/browser-interop.test.ts
 * §5 and the CLI for each hostile input. Only the `reason` is compared (as the
 * interop suite does); messages may differ. A base valid envelope is mutated per
 * case, exactly as the corpus does.
 */
class EnvelopeGrammarTest {
    private val base = encodeEnvelope2(
        EnvelopeV2(
            pairId = "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
            direction = Direction.A_TO_B,
            sequence = 0,
            startOffset = 0,
            ciphertextLength = 4,
            ciphertext = hexToBytes("deadbeef")!!,
            tag = hexToBytes("00".repeat(16))!!,
        ),
    )

    private fun reason(text: String): String {
        val d = decodeEnvelope2(text)
        assertTrue("expected a refusal for: $text", d is EnvelopeDecode.Refusal)
        return (d as EnvelopeDecode.Refusal).reason
    }

    @Test fun validDecodes() {
        assertTrue(decodeEnvelope2(base) is EnvelopeDecode.Ok)
    }

    @Test fun notJson() = assertEquals("malformed-envelope", reason("this is not json"))
    @Test fun notObject() = assertEquals("malformed-envelope", reason("[1,2,3]"))

    @Test fun v1SignatureFirst() {
        val v1 = """{"label":"PAD-TEST-AB","startOffset":0,"consumed":5,"payload":"deadbeef"}"""
        assertEquals("envelope-v1", reason(v1))
    }

    @Test fun duplicateKey() {
        assertEquals("malformed-envelope", reason(base.replace("\"sequence\":0", "\"sequence\":0,\"sequence\":0")))
    }

    @Test fun unicodeEscapedKey() {
        assertEquals("malformed-envelope", reason(base.replace("\"pairId\"", "\"\\u0070airId\"")))
    }

    @Test fun escapedValue() {
        // Escape a char inside the direction value: decodes to "A->B" but is refused.
        assertEquals("malformed-envelope", reason(base.replace("\"A->B\"", "\"A-\\u003eB\"")))
    }

    @Test fun nonCanonicalNumber() {
        assertEquals("malformed-envelope", reason(base.replace("\"sequence\":0", "\"sequence\":0.0")))
    }

    @Test fun missingField() {
        // Drop the tag member entirely.
        val noTag = base.replace(",\"tag\":\"" + "00".repeat(16) + "\"}", "}")
        assertEquals("malformed-envelope", reason(noTag))
    }

    @Test fun extraField() {
        assertEquals("malformed-envelope", reason(base.replace("}", ",\"extra\":\"x\"}")))
    }

    @Test fun wrongPairId() {
        assertEquals("malformed-envelope", reason(base.replace("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf", "ZZ")))
    }

    @Test fun uppercaseHexTagRefused() {
        assertEquals("malformed-envelope", reason(base.replace("00".repeat(16), "AA" + "00".repeat(15))))
    }

    @Test fun oversize() {
        val over = """{"formatVersion":2,"pairId":"a0a1a2a3a4a5a6a7a8a9aaabacadaeaf","direction":"A->B","sequence":0,"startOffset":0,"ciphertextLength":1048577,"ciphertext":"00","tag":"${"0".repeat(32)}"}"""
        assertEquals("oversize-ciphertext", reason(over))
    }

    @Test fun lengthMismatch() {
        // ciphertextLength 4 but hex holds 2 bytes.
        assertEquals("malformed-envelope", reason(base.replace("\"ciphertext\":\"deadbeef\"", "\"ciphertext\":\"dead\"")))
    }
}
