package dev.systemslibrarian.truepad.spt

import dev.systemslibrarian.truepad.core.bytesToHex
import dev.systemslibrarian.truepad.core.hexToBytes
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest

/**
 * GATE 2 — the TruePad SPT layer, reproduced byte-for-byte against VECTOR C.
 *
 * VECTOR C (tests/spt-vectors.test.ts) pins EVERY intermediate of a full seal:
 * requestHash, the X-Wing shared secret, padHash, the derived nonce, the AEAD
 * key, the AAD hash, the GCM ciphertext and tag, the whole package, its identity,
 * the confirmation value, and the eight confirmation word indices. Reproducing
 * all of them through the Kotlin/BC layer proves the HKDF-SHA-256 schedule, the
 * derived-nonce AES-256-GCM, the TPR2/TPS2 wire, and the fingerprints are all
 * byte-exact to the released Browser/CLI implementation. A single mismatch means
 * the parity work STOPS (Decision 1).
 */
class SptVectorCTest {

    private fun hx(s: String) = hexToBytes(s) ?: error("bad hex: $s")

    private val seed = "01060b10151a1f24292e33383d42474c51565b60656a6f74797e83888d92979c"
    private val requestId = "031425364758697a8b9cadbecfe0f102"
    private val eseed =
        "07121d28333e49545f6a75808b96a1acb7c2cdd8e3eef9040f1a25303b46515c" +
            "67727d88939ea9b4bfcad5e0ebf6010c17222d38434e59646f7a85909ba6b1bc"

    private val payloadText = "TruePad SPT vector C payload — opaque bytes.\n"
    private val expected = mapOf(
        "requestHash" to "5288daabb08983e5eddd4ebcb27a905e4c9422e9866a47d53826c3347f971744",
        "sharedSecret" to "39531bc48ed91c4b9f380ced5e4c42c39ac3ed2ae15596ac9bd48b5ccc4f512d",
        "padHash" to "1684ace251c5079c5252ecef929a1ae45f7b7022b8575396932b92a50c0752c1",
        "nonce" to "9a72341dc800ec07808ec9b9",
        "aeadKey" to "9dacc1378705c095519f5c1b03c3e92a8d1ee313db62135313e4858175f30f63",
        "aadHash" to "a73f7507937ec3cfe37e763d61b1b356eb0185648de4267d29045c0e5891d372",
        "ciphertext" to "f3c9d38117729267c7b08adee1d0c1dc66b74c290e23204e13a42d4ab7d790dcac0f531c28c1074d0b40c29ba0e412",
        "tag" to "67d728b46573735bdd85d17de14242ff",
        "packageIdentity" to "a966c11a63be7a4a20f52c846449b5fab2296ec775694f43fbad45fbcd167d16",
        "confirmValue" to "5d05c0d7749762262ff678",
    )
    private val expectedPackageLength = 1258
    private val expectedConfirmationIndices = intArrayOf(744, 368, 430, 1865, 945, 152, 1534, 1656)

    private fun sha256(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b)

    @Test
    fun theWholeSealReproducesVectorCByteForByte() {
        val payload = payloadText.toByteArray(Charsets.UTF_8)
        assertEquals("payload length", 47, payload.size)

        val keys = XWing.generateKeyPairDerand(hx(seed))
        val body = encodeRequestBody(hx(requestId), keys.encapsulationKey)

        // Cross-check the individual intermediates first, so a mismatch names the
        // exact stage that diverged.
        val requestHash = requestFingerprint(body)
        assertEquals("requestHash", expected["requestHash"], bytesToHex(requestHash))
        val enc = XWing.encapsulateDerand(keys.encapsulationKey, hx(eseed))
        assertEquals("sharedSecret", expected["sharedSecret"], bytesToHex(enc.sharedSecret))
        val padHash = derivePadHash(payload)
        assertEquals("padHash", expected["padHash"], bytesToHex(padHash))
        val prk = derivePrk(enc.sharedSecret, requestHash)
        val nonce = nonceFromPrk(prk, padHash)
        assertEquals("nonce", expected["nonce"], bytesToHex(nonce))
        val header = buildHeader(hx(requestId), requestHash, enc.ciphertext, nonce, payload.size)
        assertEquals("aadHash (SHA-256 of the 1195-byte header)", expected["aadHash"], bytesToHex(sha256(header)))
        assertEquals("aeadKey", expected["aeadKey"], bytesToHex(aeadKeyFromPrk(prk, header)))
        assertEquals("confirmValue", expected["confirmValue"], bytesToHex(confirmValueFromPrk(prk, header)))

        // Now the full seal, derandomized, must match every output.
        val sealed = sealPayloadV1(body, payload, eseedForVectorsOnly = hx(eseed))
        assertEquals("package length", expectedPackageLength, sealed.packageBytes.size)
        val ct = sealed.packageBytes.copyOfRange(TPS2_HEADER_BYTES, sealed.packageBytes.size - AEAD_TAG_BYTES)
        val tag = sealed.packageBytes.copyOfRange(sealed.packageBytes.size - AEAD_TAG_BYTES, sealed.packageBytes.size)
        assertEquals("ciphertext", expected["ciphertext"], bytesToHex(ct))
        assertEquals("tag", expected["tag"], bytesToHex(tag))
        assertEquals("requestHash (seal)", expected["requestHash"], bytesToHex(sealed.requestHash))
        assertEquals("confirmValue (seal)", expected["confirmValue"], bytesToHex(sealed.confirmValue))
        assertEquals("packageIdentity", expected["packageIdentity"], bytesToHex(sealed.packageIdentity))
        assertArrayEquals("confirmationIndices", expectedConfirmationIndices, sealed.confirmationIndices)
    }

    @Test
    fun openReversesSealAndRecoversTheExactPayloadAndConfirmValue() {
        val payload = payloadText.toByteArray(Charsets.UTF_8)
        val keys = XWing.generateKeyPairDerand(hx(seed))
        val body = encodeRequestBody(hx(requestId), keys.encapsulationKey)
        val sealed = sealPayloadV1(body, payload, eseedForVectorsOnly = hx(eseed))

        val opened = openPayloadV1(sealed.packageBytes, body, keys.decapsulationSeed)
        assertTrue("open must succeed", opened is OpenOutcome.Ok)
        val r = (opened as OpenOutcome.Ok).result
        assertArrayEquals("recovered payload", payload, r.payload)
        assertEquals("confirmValue matches the seal", expected["confirmValue"], bytesToHex(r.confirmValue))
        assertArrayEquals("confirmationIndices match the seal", expectedConfirmationIndices, r.confirmationIndices)
    }

    @Test
    fun aFreshRandomSealRoundTripsThroughOpen() {
        val keys = XWing.generateKeyPair()
        val body = encodeRequestBody(ByteArray(16) { 0x11 }, keys.encapsulationKey)
        val payload = "an ordinary courier bundle would go here".toByteArray()
        val sealed = sealPayloadV1(body, payload) // production randomness
        val opened = openPayloadV1(sealed.packageBytes, body, keys.decapsulationSeed)
        assertTrue(opened is OpenOutcome.Ok)
        assertArrayEquals(payload, (opened as OpenOutcome.Ok).result.payload)
    }

    @Test
    fun aLowOrderCtXIsRejectedAtDecapsulationMatchingTheReference() {
        // Case 1 of tests/spt-lowzero-divergence.test.ts: an honest package's ct_X
        // replaced with an all-zero low-order point. The reference (@noble) throws
        // at the X25519 layer; Android must do the same (Decision 2).
        val bob = XWing.generateKeyPairDerand(hx("42".repeat(32)))
        val eseed64 = ByteArray(64) { it.toByte() }
        val enc = XWing.encapsulateDerand(bob.encapsulationKey, eseed64)
        val tampered = enc.ciphertext.copyOf()
        // ct_X = ct[MLKEM_CIPHERTEXT_BYTES .. +32) set to all zeros (low order).
        java.util.Arrays.fill(tampered, MLKEM_CIPHERTEXT_BYTES, MLKEM_CIPHERTEXT_BYTES + X25519_BYTES, 0)
        assertThrows(Exception::class.java) { XWing.decapsulate(tampered, bob.decapsulationSeed) }
    }
}
