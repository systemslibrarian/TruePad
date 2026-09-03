package dev.systemslibrarian.truepad.spt

import java.security.MessageDigest

/* ============================================================================
 * TPS2 — the Sealed Package header and parser (byte-exact twin of
 * src/spt/sealed-package.ts, §7.1/§7.2). A 1195-byte header that is ALSO the AAD
 * in its entirety, then the AES-256-GCM ciphertext, then the 16-byte tag.
 * STRUCTURE ONLY: never decapsulates, derives a key, or decrypts. The declared
 * length is range-checked before it is trusted as a size.
 * ========================================================================= */

class SealedHeader(
    val version: Int,
    val suite: Int,
    val requestId: ByteArray,
    val requestHash: ByteArray,
    val kemCiphertext: ByteArray,
    val nonce: ByteArray,
    val plaintextLength: Int,
)

class ParsedPackage(
    val header: SealedHeader,
    /** Bytes [0, 1195) — the AAD, verbatim. */
    val aad: ByteArray,
    val ciphertext: ByteArray,
    val tag: ByteArray,
)

sealed class PackageParse {
    class Ok(val parsed: ParsedPackage) : PackageParse()
    /** reason ∈ {wrong-magic, unsupported-version, unsupported-suite, too-short,
     *  declared-length-too-large, length-mismatch}. */
    class Fail(val reason: String, val message: String) : PackageParse()
}

/** Build the 1195-byte header. Returned as its own buffer because it is used
 *  twice — the package prefix and the AAD — and the two must be the same bytes
 *  by construction. */
fun buildHeader(
    requestId: ByteArray,
    requestHash: ByteArray,
    kemCiphertext: ByteArray,
    nonce: ByteArray,
    plaintextLength: Int,
): ByteArray {
    require(requestId.size == REQUEST_ID_BYTES) { "requestId: expected 16 bytes" }
    require(requestHash.size == REQUEST_HASH_BYTES) { "requestHash: expected 32 bytes" }
    require(kemCiphertext.size == XWING_CIPHERTEXT_BYTES) { "kemCiphertext: expected $XWING_CIPHERTEXT_BYTES bytes" }
    require(nonce.size == AEAD_NONCE_BYTES) { "nonce: expected 12 bytes" }
    require(plaintextLength in 0..MAX_PLAINTEXT_BYTES) { "plaintextLength out of range: $plaintextLength" }
    val header = ByteArray(TPS2_HEADER_BYTES)
    System.arraycopy(TPS2_MAGIC_BYTES, 0, header, Tps2Offsets.MAGIC, 4)
    header[Tps2Offsets.VERSION] = TRANSFER_VERSION.toByte()
    writeUint16BE(header, Tps2Offsets.SUITE, SUITE_ID)
    System.arraycopy(requestId, 0, header, Tps2Offsets.REQUEST_ID, REQUEST_ID_BYTES)
    System.arraycopy(requestHash, 0, header, Tps2Offsets.REQUEST_HASH, REQUEST_HASH_BYTES)
    System.arraycopy(kemCiphertext, 0, header, Tps2Offsets.KEM_CIPHERTEXT, XWING_CIPHERTEXT_BYTES)
    System.arraycopy(nonce, 0, header, Tps2Offsets.NONCE, AEAD_NONCE_BYTES)
    writeUint64BE(header, Tps2Offsets.PLAINTEXT_LENGTH, plaintextLength.toLong())
    return header
}

/** Structural parse — cheapest and most discriminating checks first; nothing
 *  large is allocated on the strength of a number the package chose. */
fun parseSealedPackage(bytes: ByteArray): PackageParse {
    if (bytes.size < TPS2_FIXED_OVERHEAD_BYTES) {
        return PackageParse.Fail("too-short", "a sealed package is at least $TPS2_FIXED_OVERHEAD_BYTES bytes, got ${bytes.size}")
    }
    if (!bytesEqual(bytes.copyOfRange(0, 4), TPS2_MAGIC_BYTES)) {
        return PackageParse.Fail("wrong-magic", "not a sealed transfer package")
    }
    val version = bytes[Tps2Offsets.VERSION].toInt() and 0xFF
    if (version != TRANSFER_VERSION) {
        return PackageParse.Fail("unsupported-version", "unsupported transfer version 0x${version.toString(16)}")
    }
    val suite = readUint16BE(bytes, Tps2Offsets.SUITE)
    if (suite != SUITE_ID) {
        return PackageParse.Fail("unsupported-suite", "unsupported suite 0x${suite.toString(16).padStart(4, '0')}")
    }
    // Range-check the declared length before using it as a size.
    val declared = readUint64BE(bytes, Tps2Offsets.PLAINTEXT_LENGTH)
    if (declared > MAX_PLAINTEXT_BYTES) {
        return PackageParse.Fail("declared-length-too-large", "declared plaintext length exceeds $MAX_PLAINTEXT_BYTES bytes")
    }
    val plaintextLength = declared.toInt()
    // Exact, not ">=": trailing bytes are a length disagreement.
    val expected = TPS2_FIXED_OVERHEAD_BYTES + plaintextLength
    if (bytes.size != expected) {
        return PackageParse.Fail("length-mismatch", "declared plaintext $plaintextLength implies $expected bytes, got ${bytes.size}")
    }
    val header = SealedHeader(
        version = version,
        suite = suite,
        requestId = bytes.copyOfRange(Tps2Offsets.REQUEST_ID, Tps2Offsets.REQUEST_HASH),
        requestHash = bytes.copyOfRange(Tps2Offsets.REQUEST_HASH, Tps2Offsets.KEM_CIPHERTEXT),
        kemCiphertext = bytes.copyOfRange(Tps2Offsets.KEM_CIPHERTEXT, Tps2Offsets.NONCE),
        nonce = bytes.copyOfRange(Tps2Offsets.NONCE, Tps2Offsets.PLAINTEXT_LENGTH),
        plaintextLength = plaintextLength,
    )
    return PackageParse.Ok(
        ParsedPackage(
            header = header,
            aad = bytes.copyOfRange(0, TPS2_HEADER_BYTES),
            ciphertext = bytes.copyOfRange(TPS2_HEADER_BYTES, TPS2_HEADER_BYTES + plaintextLength),
            tag = bytes.copyOfRange(TPS2_HEADER_BYTES + plaintextLength, bytes.size),
        ),
    )
}

/** SHA-256 over the COMPLETE package — magic through the final GCM tag (NOT the
 *  AAD). Local bookkeeping AFTER AEAD verification; never a substitute for the tag. */
fun packageIdentity(packageBytes: ByteArray): ByteArray =
    MessageDigest.getInstance("SHA-256").digest(packageBytes)
