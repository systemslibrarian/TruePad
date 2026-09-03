package dev.systemslibrarian.truepad.spt

/* ============================================================================
 * TPR2 — the Receive Request codec (byte-exact twin of src/spt/receive-request.ts,
 * §5). A 1235-byte canonical body rendered as `TPR2:` + canonical unpadded
 * base64url (exactly 1652 chars). The body carries four things: version, suite,
 * a 16-byte public requestId, and the 1216-byte X-Wing encapsulation key. No
 * algorithm negotiation — an unknown version/suite is refused, never downgraded.
 * parseRequestBody is the SINGLE authority on what a canonical body is.
 * ========================================================================= */

class ReceiveRequest(
    val version: Int,
    val suite: Int,
    val requestId: ByteArray,
    val encapsulationKey: ByteArray,
)

sealed class RequestBodyParse {
    class Ok(val request: ReceiveRequest, val canonicalBody: ByteArray) : RequestBodyParse()
    /** reason ∈ {wrong-body-length, unsupported-version, unsupported-suite}. */
    class Fail(val reason: String, val message: String) : RequestBodyParse()
}

sealed class RequestDecode {
    class Ok(val request: ReceiveRequest, val canonicalBody: ByteArray) : RequestDecode()
    /** reason ∈ {wrong-prefix, not-base64url, noncanonical-base64url,
     *  wrong-body-length, unsupported-version, unsupported-suite}. */
    class Fail(val reason: String, val message: String) : RequestDecode()
}

/** THE single authority on what a canonical request body is. Returns COPIES, so
 *  a caller cannot mutate what the body said after the fact. */
fun parseRequestBody(body: ByteArray): RequestBodyParse {
    if (body.size != TPR2_BODY_BYTES) {
        return RequestBodyParse.Fail("wrong-body-length", "a request body is $TPR2_BODY_BYTES bytes, got ${body.size}")
    }
    val version = body[0].toInt() and 0xFF
    if (version != TRANSFER_VERSION) {
        return RequestBodyParse.Fail("unsupported-version", "unsupported transfer version 0x${version.toString(16)}")
    }
    val suite = readUint16BE(body, 1)
    if (suite != SUITE_ID) {
        return RequestBodyParse.Fail("unsupported-suite", "unsupported suite 0x${suite.toString(16).padStart(4, '0')}")
    }
    return RequestBodyParse.Ok(
        ReceiveRequest(
            version = version,
            suite = suite,
            requestId = body.copyOfRange(3, 19),
            encapsulationKey = body.copyOfRange(19, body.size),
        ),
        canonicalBody = body.copyOf(),
    )
}

/** Build the canonical 1235-byte body. */
fun encodeRequestBody(requestId: ByteArray, encapsulationKey: ByteArray): ByteArray {
    require(requestId.size == REQUEST_ID_BYTES) { "requestId: expected $REQUEST_ID_BYTES bytes, got ${requestId.size}" }
    require(encapsulationKey.size == XWING_PUBLIC_KEY_BYTES) {
        "encapsulationKey: expected $XWING_PUBLIC_KEY_BYTES bytes, got ${encapsulationKey.size}"
    }
    val body = ByteArray(TPR2_BODY_BYTES)
    body[0] = TRANSFER_VERSION.toByte()
    writeUint16BE(body, 1, SUITE_ID)
    System.arraycopy(requestId, 0, body, 3, REQUEST_ID_BYTES)
    System.arraycopy(encapsulationKey, 0, body, 19, XWING_PUBLIC_KEY_BYTES)
    return body
}

fun encodeReceiveRequest(requestId: ByteArray, encapsulationKey: ByteArray): String =
    TPR2_PREFIX + toBase64Url(encodeRequestBody(requestId, encapsulationKey))

/** Decode a pasted/scanned request. Surrounding whitespace is trimmed; interior
 *  whitespace, `=` padding, `+`, `/` are invalid; the decoded body is re-encoded
 *  and compared char-for-char, which is what makes the encoding canonical. */
fun decodeReceiveRequest(text: String): RequestDecode {
    val trimmed = text.trim()
    if (!trimmed.startsWith(TPR2_PREFIX)) {
        return RequestDecode.Fail("wrong-prefix", "a receive request starts with \"$TPR2_PREFIX\"")
    }
    if (trimmed.length > TPR2_TEXT_CHARS + 64) {
        return RequestDecode.Fail("wrong-body-length", "a receive request is exactly $TPR2_TEXT_CHARS characters, got ${trimmed.length}")
    }
    val encoded = trimmed.substring(TPR2_PREFIX.length)
    // Alphabet before length, so `=` padding, `+`, `/`, interior whitespace are
    // named for what they are.
    if (!isBase64UrlAlphabet(encoded)) {
        return RequestDecode.Fail("not-base64url", "the request is not canonical unpadded base64url")
    }
    if (trimmed.length != TPR2_TEXT_CHARS) {
        return RequestDecode.Fail("wrong-body-length", "a receive request is exactly $TPR2_TEXT_CHARS characters, got ${trimmed.length}")
    }
    val body = fromBase64Url(encoded) ?: return RequestDecode.Fail("not-base64url", "the request is not canonical unpadded base64url")
    if (toBase64Url(body) != encoded) {
        return RequestDecode.Fail("noncanonical-base64url", "the request has a non-canonical base64url spelling")
    }
    return when (val parsed = parseRequestBody(body)) {
        is RequestBodyParse.Ok -> RequestDecode.Ok(parsed.request, parsed.canonicalBody)
        is RequestBodyParse.Fail -> RequestDecode.Fail(parsed.reason, parsed.message)
    }
}
