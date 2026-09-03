package dev.systemslibrarian.truepad.spt

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/* ============================================================================
 * HKDF-SHA-256 (RFC 5869) over the platform's HMAC-SHA-256.
 * Byte-exact twin of src/spt/hkdf.ts. Composed by hand (not a platform HKDF)
 * because §7.3's AEAD-key info is 1219 bytes and some platform HKDFs cap `info`.
 * Only the RFC 5869 arithmetic is ours; HMAC-SHA-256 is the platform's (JCA).
 *
 *   Extract(salt, IKM) = HMAC(key = salt, msg = IKM)
 *   Expand(PRK, info, L): T(i) = HMAC(PRK, T(i-1) ‖ info ‖ uint8(i)); OKM = first L
 * ========================================================================= */

private const val HASH_LEN = 32

private fun hmacSha256(key: ByteArray, message: ByteArray): ByteArray {
    // A zero-length salt is valid and means "HashLen zero bytes" per RFC 5869
    // §2.2 — JCA (like WebCrypto) refuses an empty MAC key, so substitute 32
    // zero bytes explicitly rather than let it throw.
    val k = if (key.isEmpty()) ByteArray(HASH_LEN) else key
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(k, "HmacSHA256"))
    return mac.doFinal(message)
}

fun hkdfExtract(salt: ByteArray, ikm: ByteArray): ByteArray = hmacSha256(salt, ikm)

fun hkdfExpand(prk: ByteArray, info: ByteArray, length: Int): ByteArray {
    require(length in 0..(255 * HASH_LEN)) { "hkdfExpand: length $length outside 0..${255 * HASH_LEN}" }
    val out = ByteArray(length)
    var previous = ByteArray(0)
    var at = 0
    var counter = 1
    while (at < length) {
        val block = hmacSha256(prk, concat(previous, info, byteArrayOf(counter.toByte())))
        val take = minOf(HASH_LEN, length - at)
        System.arraycopy(block, 0, out, at, take)
        previous = block
        at += take
        counter += 1
    }
    return out
}

/** Extract-then-Expand in one step. The seal/open paths extract ONCE and expand
 *  repeatedly (§7.3); this convenience is for the RFC vectors and single uses. */
fun hkdf(salt: ByteArray, ikm: ByteArray, info: ByteArray, length: Int): ByteArray =
    hkdfExpand(hkdfExtract(salt, ikm), info, length)
