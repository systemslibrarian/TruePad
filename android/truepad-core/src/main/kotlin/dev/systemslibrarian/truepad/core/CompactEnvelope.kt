package dev.systemslibrarian.truepad.core

/*
 * TP2 Compact Transport v1 — byte-exact twin of src/core/compact-envelope2.ts.
 *
 * A PRESENTATION codec for Envelope v2 and nothing else. What a person copies
 * today is 200-odd characters of JSON with two hex characters per ciphertext
 * byte; what they should copy is `TP2:AbCd…`. That is a packaging problem.
 *
 * WHAT THIS IS NOT, because the distinction is the whole point:
 *   · not a cipher, not a MAC, not a second cryptographic protocol
 *   · not a new envelope meaning and not a Store Format change
 *   · NOT an authentication canonicalization. The Wegman-Carter tag is computed
 *     over the SEMANTIC fields (WcOneTime.canonicalBytes) — never over the JSON
 *     text and never over these compact bytes. A compact message decodes to an
 *     EnvelopeV2 and is then verified by the existing pipeline, unchanged.
 *
 *     TP2:<canonical unpadded base64url(binary envelope)>
 *          -> EnvelopeV2 -> the exact existing validation/auth/open pipeline
 *
 * Two canonicality rules keep one message from having many spellings: the
 * varints are minimal (`80 00` for zero is refused), and the base64url text is
 * re-encoded and compared character-for-character with what arrived.
 *
 * This module is REQUIRED for v2.0.0 interoperability: the released open verb
 * accepts either spelling through decodeEnvelopeTransport2, so an Android build
 * without it would refuse envelopes the shipping CLI and Browser Edition emit.
 */

const val COMPACT_PREFIX: String = "TP2:"
const val COMPACT_TRANSPORT_VERSION: Int = 0x01
private const val ENVELOPE_FORMAT_VERSION = 0x02
private const val PAIR_ID_BYTES = 16
private const val DIRECTION_AB = 0x00
private const val DIRECTION_BA = 0x01

// Refuse a hostile paste long before decoding it. The largest legitimate compact
// message is a max-size ciphertext plus a small fixed header, and base64url
// costs 4 characters per 3 bytes. Integer ceil, exactly as the TS Math.ceil.
private const val MAX_COMPACT_CHARS: Int =
    (((MAX_CIPHERTEXT_BYTES + 64).toLong() * 4 + 2) / 3).toInt() + COMPACT_PREFIX.length

private const val B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

private val B64URL_INDEX: IntArray = IntArray(128) { -1 }.also { table ->
    for (i in B64URL.indices) table[B64URL[i].code] = i
}

private fun refuse(message: String): EnvelopeDecode =
    EnvelopeDecode.Refusal("malformed-envelope", message)

/* ---- canonical unpadded base64url ----------------------------------------- */

fun toBase64Url(bytes: ByteArray): String {
    val out = StringBuilder((bytes.size + 2) / 3 * 4)
    var i = 0
    while (i < bytes.size) {
        val remaining = bytes.size - i
        val b0 = bytes[i].toInt() and 0xFF
        val b1 = if (remaining > 1) bytes[i + 1].toInt() and 0xFF else 0
        val b2 = if (remaining > 2) bytes[i + 2].toInt() and 0xFF else 0
        out.append(B64URL[b0 ushr 2])
        out.append(B64URL[((b0 and 0x03) shl 4) or (b1 ushr 4)])
        if (remaining > 1) out.append(B64URL[((b1 and 0x0F) shl 2) or (b2 ushr 6)])
        if (remaining > 2) out.append(B64URL[b2 and 0x3F])
        i += 3
    }
    return out.toString()
}

/**
 * Strict: the RFC 4648 §5 alphabet only, no `=` padding, no `+` or `/`, and no
 * whitespace anywhere inside. A group of length 1 is impossible in base64.
 * "" is the encoding of zero bytes — a faithful primitive; whether an EMPTY
 * payload is a legitimate compact envelope is the envelope decoder's question.
 */
fun fromBase64Url(text: String): ByteArray? {
    if (text.length % 4 == 1) return null // impossible: groups are never 1 character
    if (text.isEmpty()) return ByteArray(0)

    fun idx(c: Char): Int = if (c.code < 128) B64URL_INDEX[c.code] else -1

    val out = ByteArray(text.length * 3 / 4)
    var written = 0
    var i = 0
    while (i < text.length) {
        val group = text.length - i
        val c0 = idx(text[i])
        val c1 = idx(text[i + 1])
        if (c0 < 0 || c1 < 0) return null
        out[written++] = ((c0 shl 2) or (c1 ushr 4)).toByte()
        if (group > 2) {
            val c2 = idx(text[i + 2])
            if (c2 < 0) return null
            out[written++] = (((c1 and 0x0F) shl 4) or (c2 ushr 2)).toByte()
            if (group > 3) {
                val c3 = idx(text[i + 3])
                if (c3 < 0) return null
                out[written++] = (((c2 and 0x03) shl 6) or c3).toByte()
            }
        }
        i += 4
    }
    return if (written == out.size) out else out.copyOfRange(0, written)
}

/* ---- canonical unsigned LEB128 -------------------------------------------- */

/** Minimal encoding only: the writer never emits a redundant group, so `0` is `00`. */
private fun writeUleb128(out: MutableList<Byte>, value: Long) {
    require(value >= 0) { "uleb128 is unsigned; $value is negative" }
    var v = value
    do {
        val byte = (v and 0x7F).toInt()
        v = v ushr 7
        out.add((if (v > 0) byte or 0x80 else byte).toByte())
    } while (v > 0)
}

private class UlebRead(val ok: Boolean, val value: Long = 0, val next: Int = 0, val why: String = "")

/**
 * The TS twin reads into a BigInt so an overlong or oversized varint is caught
 * before it could become an imprecise Number. A 64-bit Long cannot hold every
 * value this loop may see (shift runs to 63, so a final group can address bits
 * past 63), so instead of widening we track the ONLY thing the range check needs:
 * whether any set bit lands at index >= 53. A value exceeds MAX_SAFE_INTEGER
 * (2^53 - 1) exactly when such a bit exists, so this is equivalent to the TS
 * comparison and keeps truepad-core free of BigInteger.
 */
private fun readUleb128(bytes: ByteArray, offset: Int, field: String): UlebRead {
    var value = 0L
    var overflow = false
    var shift = 0
    var i = offset
    while (true) {
        if (i >= bytes.size) return UlebRead(false, why = "$field varint is truncated")
        val byte = bytes[i].toInt() and 0xFF
        val chunk = byte and 0x7F
        if (chunk != 0) {
            val highestBit = 31 - Integer.numberOfLeadingZeros(chunk) // 0..6
            if (shift + highestBit >= 53) overflow = true else value = value or (chunk.toLong() shl shift)
        }
        i += 1
        if ((byte and 0x80) == 0) {
            // Canonical: a multi-byte encoding may not end in a group carrying
            // nothing. `80 00` is the same number as `00` and is refused.
            if (i - offset > 1 && byte == 0x00) {
                return UlebRead(false, why = "$field varint is not minimally encoded")
            }
            break
        }
        shift += 7
        if (shift > 63) return UlebRead(false, why = "$field varint is longer than 64 bits")
    }
    if (overflow) return UlebRead(false, why = "$field exceeds the safe-integer range")
    return UlebRead(true, value = value, next = i)
}

/* ---- encode ---------------------------------------------------------------- */

/**
 * Refuses anything [encodeEnvelope2] would refuse, by asking it: the compact
 * form may only ever represent an envelope the canonical implementation would
 * itself emit. It is not a looser door into the same house.
 */
fun encodeCompactEnvelope2(envelope: EnvelopeV2): String {
    encodeEnvelope2(envelope) // throws on any domain violation; output discarded
    val pairId = hexToBytes(envelope.pairId)
    require(pairId != null && pairId.size == PAIR_ID_BYTES) {
        "pairId must be exactly 32 lowercase hex characters"
    }
    val head = ArrayList<Byte>(32)
    head.add(COMPACT_TRANSPORT_VERSION.toByte())
    head.add(ENVELOPE_FORMAT_VERSION.toByte())
    for (b in pairId!!) head.add(b)
    head.add((if (envelope.direction == Direction.A_TO_B) DIRECTION_AB else DIRECTION_BA).toByte())
    writeUleb128(head, envelope.sequence)
    writeUleb128(head, envelope.startOffset)
    writeUleb128(head, envelope.ciphertextLength)

    val bytes = ByteArray(head.size + envelope.ciphertext.size + TAG_BYTES)
    for (i in head.indices) bytes[i] = head[i]
    System.arraycopy(envelope.ciphertext, 0, bytes, head.size, envelope.ciphertext.size)
    System.arraycopy(envelope.tag, 0, bytes, head.size + envelope.ciphertext.size, TAG_BYTES)
    return COMPACT_PREFIX + toBase64Url(bytes)
}

/* ---- decode ---------------------------------------------------------------- */

/**
 * Structural parse, then the EXISTING canonical machinery decides. The
 * round-trip through encode/decodeEnvelope2 is deliberate: envelope domain
 * rules live in exactly one place, and a compact message can represent only
 * what that place accepts.
 */
fun decodeCompactEnvelope2(text: String): EnvelopeDecode {
    val trimmed = text.trim()
    if (!trimmed.startsWith(COMPACT_PREFIX)) {
        return refuse("a compact envelope begins with \"$COMPACT_PREFIX\"")
    }
    if (trimmed.length > MAX_COMPACT_CHARS) {
        return refuse("this compact envelope is ${trimmed.length} characters; the largest possible is $MAX_COMPACT_CHARS")
    }
    val payload = trimmed.substring(COMPACT_PREFIX.length)
    if (payload.isEmpty()) return refuse("\"$COMPACT_PREFIX\" carries no payload")
    if (payload.contains('=')) {
        return refuse("compact payloads are unpadded base64url; \"=\" padding is not part of the spelling")
    }
    val bytes = fromBase64Url(payload)
        ?: return refuse("the compact payload is not canonical unpadded base64url (A-Z a-z 0-9 - _)")
    // One message, one spelling: re-encode and require the exact same text.
    if (toBase64Url(bytes) != payload) {
        return refuse("the compact payload is not the canonical base64url spelling of its own bytes")
    }

    var at = 0
    fun need(count: Int): Boolean = bytes.size - at >= count

    if (!need(2)) return refuse("the compact envelope is truncated before its version bytes")
    val transportVersion = bytes[at].toInt() and 0xFF
    if (transportVersion != COMPACT_TRANSPORT_VERSION) {
        return refuse("compact transport version $transportVersion is not supported (this build speaks $COMPACT_TRANSPORT_VERSION)")
    }
    at += 1
    val formatVersion = bytes[at].toInt() and 0xFF
    if (formatVersion != ENVELOPE_FORMAT_VERSION) {
        // v1 envelopes are refused by their own reason everywhere else; keep that.
        return if (formatVersion == 0x01) {
            EnvelopeDecode.Refusal(
                "envelope-v1",
                "this compact envelope declares Envelope v1, which this build does not accept",
            )
        } else {
            refuse("envelope formatVersion $formatVersion is not 2")
        }
    }
    at += 1

    if (!need(PAIR_ID_BYTES)) return refuse("the compact envelope is truncated inside its pairId")
    val pairId = bytesToHex(bytes.copyOfRange(at, at + PAIR_ID_BYTES))
    at += PAIR_ID_BYTES

    if (!need(1)) return refuse("the compact envelope is truncated before its direction")
    val directionByte = bytes[at].toInt() and 0xFF
    if (directionByte != DIRECTION_AB && directionByte != DIRECTION_BA) {
        val hex = directionByte.toString(16).padStart(2, '0')
        return refuse("direction byte 0x$hex is neither 0x00 (A->B) nor 0x01 (B->A)")
    }
    val direction = if (directionByte == DIRECTION_AB) Direction.A_TO_B else Direction.B_TO_A
    at += 1

    val sequence = readUleb128(bytes, at, "sequence")
    if (!sequence.ok) return refuse(sequence.why)
    at = sequence.next
    val startOffset = readUleb128(bytes, at, "startOffset")
    if (!startOffset.ok) return refuse(startOffset.why)
    at = startOffset.next
    val ciphertextLength = readUleb128(bytes, at, "ciphertextLength")
    if (!ciphertextLength.ok) return refuse(ciphertextLength.why)
    at = ciphertextLength.next

    if (ciphertextLength.value > MAX_CIPHERTEXT_BYTES) {
        return EnvelopeDecode.Refusal(
            "oversize-ciphertext",
            "ciphertextLength ${ciphertextLength.value} exceeds MAX_CIPHERTEXT_BYTES $MAX_CIPHERTEXT_BYTES",
        )
    }
    // The declared length is checked against what is actually carried, exactly
    // as the JSON grammar checks it — never inferred from what is left over.
    val remaining = bytes.size - at
    val declared = ciphertextLength.value.toInt()
    if (remaining < declared + TAG_BYTES) {
        return refuse(
            "ciphertextLength declares $declared bytes plus a $TAG_BYTES-byte tag, but only $remaining bytes remain",
        )
    }
    if (remaining > declared + TAG_BYTES) {
        return refuse(
            "${remaining - declared - TAG_BYTES} trailing byte(s) follow the tag; a compact envelope carries nothing else",
        )
    }
    val ciphertext = bytes.copyOfRange(at, at + declared)
    val tag = bytes.copyOfRange(at + declared, bytes.size)

    // Hand the candidate to the canonical implementation and let IT decide.
    val json = try {
        encodeEnvelope2(
            EnvelopeV2(
                pairId = pairId,
                direction = direction,
                sequence = sequence.value,
                startOffset = startOffset.value,
                ciphertextLength = ciphertextLength.value,
                ciphertext = ciphertext,
                tag = tag,
            ),
        )
    } catch (e: IllegalArgumentException) {
        return refuse("the compact envelope does not describe a valid Envelope v2 — ${e.message}")
    }
    return decodeEnvelope2(json)
}

/* ---- the transport door ---------------------------------------------------- */

/**
 * Accepts either spelling, with no mode selector anywhere above it. A `TP2:`
 * input is decoded as compact and REFUSED as compact if malformed — it never
 * falls through to the JSON parser, because a half-typed compact string is not
 * a JSON document and pretending otherwise would report the wrong error and
 * invite a parser-confusion bug. Anything else goes to the existing strict
 * canonical parser, byte for byte as before.
 */
fun decodeEnvelopeTransport2(text: String): EnvelopeDecode {
    val trimmed = text.trim()
    return if (trimmed.startsWith(COMPACT_PREFIX)) decodeCompactEnvelope2(trimmed) else decodeEnvelope2(text)
}

fun isCompactEnvelope2(text: String): Boolean = text.trim().startsWith(COMPACT_PREFIX)
