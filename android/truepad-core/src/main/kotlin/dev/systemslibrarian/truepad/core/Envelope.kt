package dev.systemslibrarian.truepad.core

/*
 * TruePad v2 wire envelope — byte-exact twin of src/core/envelope2.ts.
 *
 * One line of JSON with exactly eight fields, emitted in exactly this order:
 *   {formatVersion, pairId, direction, sequence, startOffset,
 *    ciphertextLength, ciphertext, tag}
 *
 * Parsing is strict (§6.2): exactly those eight keys, one accepted spelling per
 * token. Property names and string VALUES are literal on the wire — no JSON
 * escape sequences, no duplicate keys — enforced by a LEXICAL scan of the raw
 * text, because JSON parsing decodes escapes and collapses duplicates before any
 * check on the parsed object could see them. Number values obey a one-spelling
 * rule too. The v1-signature check runs FIRST (a {label,...} object with no
 * formatVersion is `envelope-v1`, never `malformed-envelope`). Refusals carry
 * the SAME typed reason the CLI/Browser use, so the interop corpus agrees.
 */

// A non-negative JS "safe integer": < 2^53. Counters above this decode in-domain
// in JS as an imprecise float and are refused; we match that ceiling.
private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

class EnvelopeV2(
    val pairId: String, // 32 lowercase hex characters (16 bytes)
    val direction: Direction,
    val sequence: Long,
    val startOffset: Long,
    val ciphertextLength: Long,
    val ciphertext: ByteArray,
    val tag: ByteArray, // 16 bytes
)

sealed class EnvelopeDecode {
    data class Ok(val envelope: EnvelopeV2) : EnvelopeDecode()
    /** reason ∈ {"envelope-v1","malformed-envelope","oversize-ciphertext"}. */
    data class Refusal(val reason: String, val message: String) : EnvelopeDecode()
}

private val WIRE_KEYS = listOf(
    "formatVersion", "pairId", "direction", "sequence",
    "startOffset", "ciphertextLength", "ciphertext", "tag",
)
private val PAIR_ID_RE = Regex("^[0-9a-f]{32}$")
private val TAG_RE = Regex("^[0-9a-f]{32}$")
private val CIPHERTEXT_RE = Regex("^(?:[0-9a-f]{2})*$")
private val CANONICAL_INT_RE = Regex("^(?:0|[1-9][0-9]*)$")

private fun malformed(why: String) =
    EnvelopeDecode.Refusal("malformed-envelope", "Malformed envelope: $why. Nothing was burned.")

private fun refuseV1() = EnvelopeDecode.Refusal(
    "envelope-v1",
    "This is a v1 envelope: it carries a label field and no formatVersion. v2 tooling cannot open a v1 " +
        "envelope — there is no --legacy flag and no compatibility parse, by design. Nothing was burned.",
)

private fun refuseOversize(declared: Long) = EnvelopeDecode.Refusal(
    "oversize-ciphertext",
    "Oversize ciphertext: the envelope declares $declared ciphertext bytes but the v2 maximum is " +
        "$MAX_CIPHERTEXT_BYTES. Larger payloads travel as multiple records. Nothing was burned.",
)

private fun clip(s: String): String = if (s.length > 48) s.substring(0, 48) + "…" else s

private data class WireToken(val kind: Kind, val spelling: String, val escaped: Boolean) {
    enum class Kind { NAME, VALUE }
}
private data class NumberMember(val name: String, val spelling: String)
private data class WireScan(val tokens: List<WireToken>, val numbers: List<NumberMember>)

/**
 * Lexical scan of the top level of an envelope line. Precondition: `text` is
 * valid JSON whose top-level value is a non-null, non-array object. Ports
 * scanTopLevelStrings from envelope2.ts one-for-one.
 */
private fun scanTopLevelStrings(text: String): WireScan {
    val tokens = ArrayList<WireToken>()
    val numbers = ArrayList<NumberMember>()
    var depth = 0
    var expectName = false
    var pendingName = ""
    var i = 0
    while (i < text.length) {
        val ch = text[i]
        if (ch == '"') {
            val start = i + 1
            var j = start
            var escaped = false
            while (j < text.length) {
                val c = text[j]
                if (c == '\\') { escaped = true; j += 2; continue }
                if (c == '"') break
                j += 1
            }
            if (depth == 1) {
                val spelling = text.substring(start, minOf(j, text.length))
                tokens.add(WireToken(if (expectName) WireToken.Kind.NAME else WireToken.Kind.VALUE, spelling, escaped))
                if (expectName) pendingName = spelling
                expectName = false
            }
            i = j + 1
        } else if (ch == '{' || ch == '[') {
            depth += 1
            if (depth == 1) expectName = true
            i += 1
        } else if (ch == '}' || ch == ']') {
            depth -= 1
            if (depth == 0) break
            i += 1
        } else if (depth == 1 && !expectName && (ch == '-' || ch in '0'..'9')) {
            var j = i + 1
            while (j < text.length && "+-.eE0123456789".indexOf(text[j]) >= 0) j += 1
            numbers.add(NumberMember(pendingName, text.substring(i, j)))
            i = j
        } else {
            if (ch == ',' && depth == 1) expectName = true
            i += 1
        }
    }
    return WireScan(tokens, numbers)
}

/** Strict §6.2 parse; check order is normative (ports decodeEnvelope2). */
fun decodeEnvelope2(text: String): EnvelopeDecode {
    val parsed: JsonValue = try {
        parseJson(text)
    } catch (_: JsonParseException) {
        return malformed("not JSON")
    }
    if (parsed !is JsonObject) return malformed("not a JSON object")
    val raw = parsed.members

    // v1 signature FIRST.
    if (raw.containsKey("label") && !raw.containsKey("formatVersion")) return refuseV1()

    val (tokens, numbers) = scanTopLevelStrings(text)
    for (t in tokens) {
        if (t.kind == WireToken.Kind.NAME && t.escaped) {
            return malformed("the property name \"${clip(t.spelling)}\" is spelled with JSON escape sequences; the v2 wire grammar has exactly one spelling per key")
        }
    }
    val nameCounts = HashMap<String, Int>()
    for (t in tokens) if (t.kind == WireToken.Kind.NAME) nameCounts[t.spelling] = (nameCounts[t.spelling] ?: 0) + 1
    for ((name, count) in nameCounts) {
        if (count > 1) return malformed("the key ${clip(name)} appears $count times; a v2 envelope carries each of its keys exactly once")
    }
    for (t in tokens) {
        if (t.kind == WireToken.Kind.VALUE && t.escaped) {
            return malformed("the string value \"${clip(t.spelling)}\" is spelled with JSON escape sequences; each value has exactly one accepted wire spelling")
        }
    }
    for (n in numbers) {
        when (n.name) {
            "formatVersion" -> if (n.spelling != "2") return malformed("formatVersion must be spelled exactly 2, not ${clip(n.spelling)}")
            "sequence", "startOffset", "ciphertextLength" ->
                if (!CANONICAL_INT_RE.matches(n.spelling)) {
                    return malformed("${n.name} must be a canonical decimal integer (no leading zero, sign, fraction, or exponent), not ${clip(n.spelling)}")
                }
        }
    }

    val keys = raw.keys
    val missing = WIRE_KEYS.filter { it !in keys }
    val extra = keys.filter { it !in WIRE_KEYS }
    if (missing.isNotEmpty() || extra.isNotEmpty()) {
        val parts = buildList {
            if (missing.isNotEmpty()) add("missing ${missing.joinToString(", ")}")
            if (extra.isNotEmpty()) add("unexpected ${extra.joinToString(", ")}")
        }
        return malformed("a v2 envelope has exactly eight fields (${WIRE_KEYS.joinToString(", ")}); this one is ${parts.joinToString(" and ")}")
    }

    val fv = raw["formatVersion"]
    if (fv !is JsonNumber || fv.raw != "2") return malformed("formatVersion must be the integer 2")
    val pairId = (raw["pairId"] as? JsonString)?.value
    if (pairId == null || !PAIR_ID_RE.matches(pairId)) return malformed("pairId must be exactly 32 lowercase hex characters")
    val directionStr = (raw["direction"] as? JsonString)?.value
    val direction = directionStr?.let { Direction.fromWire(it) }
        ?: return malformed("direction must be exactly \"A->B\" or \"B->A\"")
    val sequence = counterValue(raw["sequence"]) ?: return malformed("sequence must be a non-negative safe integer")
    val startOffset = counterValue(raw["startOffset"]) ?: return malformed("startOffset must be a non-negative safe integer")
    val ciphertextLength = counterValue(raw["ciphertextLength"]) ?: return malformed("ciphertextLength must be a non-negative safe integer")
    val tagHex = (raw["tag"] as? JsonString)?.value
    if (tagHex == null || !TAG_RE.matches(tagHex)) return malformed("tag must be exactly 32 lowercase hex characters")
    val ciphertextHex = (raw["ciphertext"] as? JsonString)?.value
    if (ciphertextHex == null || !CIPHERTEXT_RE.matches(ciphertextHex)) return malformed("ciphertext must be lowercase hex, two characters per byte")

    if (ciphertextLength > MAX_CIPHERTEXT_BYTES) return refuseOversize(ciphertextLength)
    if (ciphertextHex.length.toLong() != 2 * ciphertextLength) {
        return malformed("ciphertextLength says $ciphertextLength bytes but the ciphertext hex holds ${ciphertextHex.length / 2}")
    }

    val ciphertext = hexToBytes(ciphertextHex)
    val tag = hexToBytes(tagHex)
    if (ciphertext == null || tag == null) return malformed("ciphertext or tag failed strict hex decoding")
    return EnvelopeDecode.Ok(
        EnvelopeV2(pairId, direction, sequence, startOffset, ciphertextLength, ciphertext, tag),
    )
}

// A JsonNumber whose value is a non-negative safe integer; else null. The lexical
// scan already required a canonical decimal spelling, so this only bounds range.
private fun counterValue(v: JsonValue?): Long? {
    if (v !is JsonNumber) return null
    val n = v.raw.toLongOrNull() ?: return null // overflows Long -> not safe
    return if (n in 0..MAX_SAFE_INTEGER) n else null
}

/**
 * One line of JSON, the eight §6.2 fields in the §6.2 order, lowercase hex.
 * Hand-built (not via a JSON library) so the wire bytes are byte-identical to
 * src/core/encodeEnvelope2's JSON.stringify output. Domain violations throw.
 */
fun encodeEnvelope2(env: EnvelopeV2): String {
    require(PAIR_ID_RE.matches(env.pairId)) { "pairId must be exactly 32 lowercase hex characters" }
    require(env.sequence in 0..MAX_SAFE_INTEGER && env.startOffset in 0..MAX_SAFE_INTEGER && env.ciphertextLength in 0..MAX_SAFE_INTEGER) {
        "sequence, startOffset, and ciphertextLength must be non-negative safe integers"
    }
    require(env.ciphertextLength <= MAX_CIPHERTEXT_BYTES) {
        "ciphertextLength ${env.ciphertextLength} exceeds MAX_CIPHERTEXT_BYTES $MAX_CIPHERTEXT_BYTES"
    }
    require(env.ciphertext.size.toLong() == env.ciphertextLength) {
        "ciphertextLength says ${env.ciphertextLength} bytes but the ciphertext holds ${env.ciphertext.size}"
    }
    require(env.tag.size == 16) { "tag must be exactly 16 bytes, not ${env.tag.size}" }
    return "{\"formatVersion\":2,\"pairId\":\"${env.pairId}\",\"direction\":\"${env.direction.wire}\"," +
        "\"sequence\":${env.sequence},\"startOffset\":${env.startOffset}," +
        "\"ciphertextLength\":${env.ciphertextLength},\"ciphertext\":\"${bytesToHex(env.ciphertext)}\"," +
        "\"tag\":\"${bytesToHex(env.tag)}\"}"
}
