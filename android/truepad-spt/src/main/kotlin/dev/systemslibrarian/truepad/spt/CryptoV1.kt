package dev.systemslibrarian.truepad.spt

import java.util.Arrays
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/* ============================================================================
 * Suite 0x0001 — key derivation, sealing, and opening.
 * Byte-exact twin of src/spt/crypto-v1.ts (§7.3, §7.4, §20).
 *
 * LOW-LEVEL, PURE operations over opaque bytes — NOT the product's authorization
 * boundary (a higher layer names the pad and reads the live store). Ordering is
 * not free to choose: padHash -> nonce -> header -> aeadKey/confirmValue.
 *
 * The primitives are the platform's: SHA-256, HMAC-SHA-256, AES-256-GCM (JCA),
 * and X-Wing (Bouncy Castle). Only the RFC 5869 composition and the schedule are
 * ours, both byte-checked against the released vectors.
 * ========================================================================= */

/** info = uint8(len(DS)) ‖ DS ‖ context — the SAME measured prefix as H_ds, and
 *  the ONLY place any of the three infos is built. */
private fun info(separator: String, context: ByteArray): ByteArray = concat(domainPrefix(separator), context)

/** PRK = HKDF-Extract(salt = requestHash, IKM = sharedSecret). §7.3. */
fun derivePrk(sharedSecret: ByteArray, requestHash: ByteArray): ByteArray = hkdfExtract(requestHash, sharedSecret)

fun derivePadHash(payload: ByteArray): ByteArray = hashDomain(DS_PAD, payload)

fun nonceFromPrk(prk: ByteArray, padHash: ByteArray): ByteArray = hkdfExpand(prk, info(DS_NONCE, padHash), AEAD_NONCE_BYTES)

fun aeadKeyFromPrk(prk: ByteArray, aad: ByteArray): ByteArray = hkdfExpand(prk, info(DS_AEAD_KEY, aad), AEAD_KEY_BYTES)

fun confirmValueFromPrk(prk: ByteArray, aad: ByteArray): ByteArray = hkdfExpand(prk, info(DS_CONFIRM, aad), CONFIRM_VALUE_BYTES)

private fun aesGcmSeal(key: ByteArray, nonce: ByteArray, aad: ByteArray, plaintext: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(AEAD_TAG_BYTES * 8, nonce))
    cipher.updateAAD(aad)
    return cipher.doFinal(plaintext) // ciphertext ‖ 16-byte tag, exactly as WebCrypto AES-GCM
}

/** Throws (AEADBadTagException) on verification failure, like WebCrypto's decrypt. */
private fun aesGcmOpen(key: ByteArray, nonce: ByteArray, aad: ByteArray, ciphertextAndTag: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(AEAD_TAG_BYTES * 8, nonce))
    cipher.updateAAD(aad)
    return cipher.doFinal(ciphertextAndTag)
}

private fun wipe(vararg buffers: ByteArray?) {
    for (b in buffers) if (b != null) Arrays.fill(b, 0)
}

class SealResult(
    /** The complete TPS2 bytes. */
    val packageBytes: ByteArray,
    val confirmValue: ByteArray,
    val confirmationIndices: IntArray,
    val requestHash: ByteArray,
    val packageIdentity: ByteArray,
)

class OpenResult(
    /** The exact bytes that were sealed; owned by the caller from here on. */
    val payload: ByteArray,
    val confirmValue: ByteArray,
    val confirmationIndices: IntArray,
    val requestHash: ByteArray,
    val packageIdentity: ByteArray,
)

sealed class OpenOutcome {
    class Ok(val result: OpenResult) : OpenOutcome()
    /** reason ∈ {wrong-magic, unsupported-version, unsupported-suite, too-short,
     *  declared-length-too-large, length-mismatch, malformed-request-body,
     *  request-mismatch, cryptographic-open-failed, derived-nonce-mismatch}. */
    class Fail(val reason: String, val message: String) : OpenOutcome()
}

/** LOW-LEVEL. `canonicalRequestBody` is the complete 1235-byte §5.1 body; the
 *  recipient's KEM identity is read out of it (the single authority). `payload`
 *  is opaque bytes — never parsed, normalized, or reserialized here.
 *  `eseedForVectorsOnly` is TEST ONLY; production omits it (fresh CSPRNG). */
fun sealPayloadV1(
    canonicalRequestBody: ByteArray,
    payload: ByteArray,
    eseedForVectorsOnly: ByteArray? = null,
): SealResult {
    if (payload.size > MAX_PLAINTEXT_BYTES) throw IllegalArgumentException("payload exceeds $MAX_PLAINTEXT_BYTES bytes")
    val parsed = parseRequestBody(canonicalRequestBody)
    if (parsed is RequestBodyParse.Fail) throw IllegalArgumentException("canonicalRequestBody: ${parsed.message}")
    val ok = parsed as RequestBodyParse.Ok
    val encapsulationKey = ok.request.encapsulationKey
    val requestHash = requestFingerprint(ok.canonicalBody)
    val enc = if (eseedForVectorsOnly != null) {
        XWing.encapsulateDerand(encapsulationKey, eseedForVectorsOnly)
    } else {
        XWing.encapsulate(encapsulationKey)
    }
    val sharedSecret = enc.sharedSecret
    var prk: ByteArray? = null
    var aeadKey: ByteArray? = null
    var padHash: ByteArray? = null
    try {
        prk = derivePrk(sharedSecret, requestHash)
        padHash = derivePadHash(payload)
        val nonce = nonceFromPrk(prk, padHash)
        val header = buildHeader(ok.request.requestId, requestHash, enc.ciphertext, nonce, payload.size)
        aeadKey = aeadKeyFromPrk(prk, header)
        val sealed = aesGcmSeal(aeadKey, nonce, header, payload)
        val confirmValue = confirmValueFromPrk(prk, header)
        val packageBytes = concat(header, sealed)
        return SealResult(
            packageBytes = packageBytes,
            confirmValue = confirmValue,
            confirmationIndices = confirmationIndices88(confirmValue),
            requestHash = requestHash,
            packageIdentity = packageIdentity(packageBytes),
        )
    } finally {
        wipe(sharedSecret, prk, aeadKey, padHash)
    }
}

/** LOW-LEVEL. The caller supplies the complete canonical request body; requestHash
 *  is recomputed from it and compared with the header. */
fun openPayloadV1(
    packageBytes: ByteArray,
    canonicalRequestBody: ByteArray,
    decapsulationSeed: ByteArray,
): OpenOutcome {
    val parsed = parseSealedPackage(packageBytes)
    if (parsed is PackageParse.Fail) return OpenOutcome.Fail(parsed.reason, parsed.message)
    val pp = (parsed as PackageParse.Ok).parsed

    // The SAME parser seal() uses: a 1235-ish buffer that is not a canonical
    // request must not silently become a different request domain.
    val request = parseRequestBody(canonicalRequestBody)
    if (request is RequestBodyParse.Fail) return OpenOutcome.Fail("malformed-request-body", request.message)
    val req = request as RequestBodyParse.Ok

    val requestHash = requestFingerprint(req.canonicalBody)
    if (!bytesEqual(pp.header.requestId, req.request.requestId) || !bytesEqual(pp.header.requestHash, requestHash)) {
        return OpenOutcome.Fail("request-mismatch", "this package is for a different receive request")
    }

    var sharedSecret: ByteArray? = null
    var prk: ByteArray? = null
    var aeadKey: ByteArray? = null
    var plaintext: ByteArray? = null
    var padHash: ByteArray? = null
    var expectedNonce: ByteArray? = null
    try {
        sharedSecret = try {
            XWing.decapsulate(pp.header.kemCiphertext, decapsulationSeed)
        } catch (_: Exception) {
            // Decapsulation and AEAD failure are ONE outcome; reporting them
            // apart would be a decapsulation oracle. The low-order rejection also
            // lands here (matching the reference build).
            return OpenOutcome.Fail("cryptographic-open-failed", "this package could not be opened for this request")
        }
        prk = derivePrk(sharedSecret, requestHash)
        aeadKey = aeadKeyFromPrk(prk, pp.aad)
        plaintext = try {
            aesGcmOpen(aeadKey, pp.header.nonce, pp.aad, concat(pp.ciphertext, pp.tag))
        } catch (_: Exception) {
            return OpenOutcome.Fail("cryptographic-open-failed", "this package could not be opened for this request")
        }

        // AFTER verification: re-derive the nonce from the plaintext and compare
        // it with the one the package carried (§7.4/§20).
        padHash = derivePadHash(plaintext)
        expectedNonce = nonceFromPrk(prk, padHash)
        if (!bytesEqual(expectedNonce, pp.header.nonce)) {
            return OpenOutcome.Fail("derived-nonce-mismatch", "the package nonce is not the one this payload derives")
        }

        val confirmValue = confirmValueFromPrk(prk, pp.aad)
        val result = OpenResult(
            payload = plaintext,
            confirmValue = confirmValue,
            confirmationIndices = confirmationIndices88(confirmValue),
            requestHash = requestHash,
            packageIdentity = packageIdentity(packageBytes),
        )
        plaintext = null // ownership passes to the caller; do not wipe
        return OpenOutcome.Ok(result)
    } finally {
        wipe(sharedSecret, prk, aeadKey, padHash, expectedNonce, plaintext)
    }
}
