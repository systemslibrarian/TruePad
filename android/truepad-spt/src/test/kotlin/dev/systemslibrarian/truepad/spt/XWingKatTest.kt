package dev.systemslibrarian.truepad.spt

import dev.systemslibrarian.truepad.core.bytesToHex
import dev.systemslibrarian.truepad.core.hexToBytes
import dev.systemslibrarian.truepad.core.parseJson
import dev.systemslibrarian.truepad.core.JsonArray
import dev.systemslibrarian.truepad.core.JsonObject
import dev.systemslibrarian.truepad.core.JsonString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.SecureRandom

/**
 * GATE 1 — X-Wing suite 0x0001, draft-10 Appendix C, reproduced by Bouncy Castle.
 *
 * The audit is not the proof. Before any product code depends on BC's X-Wing,
 * this reproduces the draft's own Appendix-C vectors BYTE-FOR-BYTE through the
 * Kotlin/BC wrapper, driving the KEM derandomized with a fixed RNG:
 *   - GenerateKeyPairDerand(seed) -> pk, and the packed private key IS the seed;
 *   - EncapsulateDerand(pk, eseed) -> ct, ss;
 *   - Decapsulate(ct, seed) -> ss.
 * A single byte mismatch means BC does not reproduce the frozen suite and the
 * parity work STOPS (Decision 1). It passing proves BC's construction — seed,
 * SHAKE256(96) expansion, ML-KEM-coins-then-X25519 randomness order, and the
 * SHA3-256(...‖label) combiner — matches @noble/the draft exactly.
 */
class XWingKatTest {

    /** A SecureRandom that returns pre-loaded bytes in order — the derandomization
     *  hook. If BC ever draws MORE than the supplied bytes, this throws, which is
     *  itself a finding (the draw size/order would differ from @noble's eseed). */
    private class FixedSecureRandom(private val data: ByteArray) : SecureRandom() {
        private var offset = 0
        override fun nextBytes(bytes: ByteArray) {
            if (offset + bytes.size > data.size) {
                throw IllegalStateException("FixedSecureRandom exhausted: needed ${bytes.size} at $offset of ${data.size}")
            }
            System.arraycopy(data, offset, bytes, 0, bytes.size)
            offset += bytes.size
        }
        fun consumed() = offset
    }

    private data class Vec(val seed: String, val sk: String, val pk: String, val eseed: String, val ct: String, val ss: String)

    private val vectors: List<Vec> = run {
        val text = File("../vectors/xwing-draft10-appendix-c.json").readText()
        val arr = parseJson(text) as JsonArray
        arr.items.map { it as JsonObject }.map { o ->
            fun s(k: String) = (o.members.getValue(k) as JsonString).value
            Vec(s("seed"), s("sk"), s("pk"), s("eseed"), s("ct"), s("ss"))
        }
    }

    private fun hx(s: String) = hexToBytes(s) ?: error("bad hex: $s")

    @Test
    fun theFixtureHasThreeCompleteVectorsAtTheFrozenSizes() {
        assertEquals(3, vectors.size)
        for (v in vectors) {
            assertEquals(XWING_SEED_BYTES, v.seed.length / 2)
            assertEquals(v.seed, v.sk) // the packed secret key IS the seed
            assertEquals(XWING_PUBLIC_KEY_BYTES, v.pk.length / 2)
            assertEquals(XWING_ESEED_BYTES, v.eseed.length / 2)
            assertEquals(XWING_CIPHERTEXT_BYTES, v.ct.length / 2)
            assertEquals(XWING_SHARED_SECRET_BYTES, v.ss.length / 2)
        }
    }

    @Test
    fun generateKeyPairDerandReproducesPkAndTheSeedIsThePrivateKey() {
        for ((i, v) in vectors.withIndex()) {
            val rng = FixedSecureRandom(hx(v.seed))
            val kp = XWing.generateKeyPair(rng)
            assertEquals("vector ${i + 1} pk", v.pk, bytesToHex(kp.encapsulationKey))
            assertEquals("vector ${i + 1} seed==private key", v.sk, bytesToHex(kp.decapsulationSeed))
            assertEquals("vector ${i + 1} keygen drew exactly the 32-byte seed", XWING_SEED_BYTES, rng.consumed())
        }
    }

    @Test
    fun encapsulateDerandReproducesCiphertextAndSharedSecret() {
        for ((i, v) in vectors.withIndex()) {
            val rng = FixedSecureRandom(hx(v.eseed))
            val enc = XWing.encapsulate(hx(v.pk), rng)
            assertEquals("vector ${i + 1} ct", v.ct, bytesToHex(enc.ciphertext))
            assertEquals("vector ${i + 1} ss", v.ss, bytesToHex(enc.sharedSecret))
            assertEquals("vector ${i + 1} encaps drew exactly the 64-byte eseed", XWING_ESEED_BYTES, rng.consumed())
        }
    }

    @Test
    fun decapsulateReproducesSharedSecret() {
        for ((i, v) in vectors.withIndex()) {
            assertEquals("vector ${i + 1} decaps ss", v.ss, bytesToHex(XWing.decapsulate(hx(v.ct), hx(v.seed))))
        }
    }

    @Test
    fun aFreshKeypairRoundTripsThroughEncapAndDecap() {
        val kp = XWing.generateKeyPair()
        val enc = XWing.encapsulate(kp.encapsulationKey)
        val ss = XWing.decapsulate(enc.ciphertext, kp.decapsulationSeed)
        assertTrue("round-trip shared secret agrees", enc.sharedSecret.contentEquals(ss))
    }
}
