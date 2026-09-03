package dev.systemslibrarian.truepad.spt

import dev.systemslibrarian.truepad.core.JsonNumber
import dev.systemslibrarian.truepad.core.JsonObject
import dev.systemslibrarian.truepad.core.JsonString
import dev.systemslibrarian.truepad.core.parseJson

/* ============================================================================
 * The SPT durable record codec — canonical serialization and strict parsing,
 * the Kotlin mirror of the shared validators in the browser engine's state files.
 *
 * Records are tiny JSON objects with a fixed key order. `serialize` produces
 * exactly `{"k":v,...}` as JSON.stringify would; `parseRecord` demands an object
 * of the exact version and the exact key set, so a record copied from one
 * request's directory into another's is rejected, not trusted.
 * ========================================================================= */

const val SPT_RECORD_VERSION = 1

/** A record value is either an Int (only `version`) or an ASCII String. */
internal fun serializeRecord(vararg entries: Pair<String, Any>): ByteArray {
    val sb = StringBuilder("{")
    for ((i, e) in entries.withIndex()) {
        if (i > 0) sb.append(',')
        jsonString(sb, e.first)
        sb.append(':')
        when (val v = e.second) {
            is Int -> sb.append(v.toString())
            is String -> jsonString(sb, v)
            else -> throw IllegalArgumentException("unsupported record value type: ${v::class}")
        }
    }
    sb.append('}')
    return sb.toString().toByteArray(Charsets.UTF_8)
}

/** JSON.stringify-compatible string escaping. The record values are constrained
 *  ASCII (hex/base64url/ISO/enum), but this stays fully correct so a value can
 *  never smuggle an unescaped byte. */
private val HEXC = "0123456789abcdef".toCharArray()

private fun jsonString(sb: StringBuilder, s: String) {
    sb.append('"')
    for (c in s) {
        when (c) {
            '"' -> sb.append("\\\"")
            '\\' -> sb.append("\\\\")
            '\b' -> sb.append("\\b")
            '\u000C' -> sb.append("\\f")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            else -> if (c.code < 0x20) {
                sb.append("\\u00").append(HEXC[(c.code ushr 4) and 0xF]).append(HEXC[c.code and 0xF])
            } else {
                sb.append(c)
            }
        }
    }
    sb.append('"')
}

/** Strict parse: non-empty, valid JSON, an object, the exact record version, and
 *  exactly the given keys (no more, no fewer). Throws on any deviation. */
internal fun parseRecord(bytes: ByteArray, what: String, keys: List<String>): JsonObject {
    if (bytes.isEmpty()) throw IllegalArgumentException("the $what is empty")
    val parsed = try {
        parseJson(String(bytes, Charsets.UTF_8))
    } catch (_: Exception) {
        throw IllegalArgumentException("the $what does not parse as JSON")
    }
    val obj = parsed as? JsonObject ?: throw IllegalArgumentException("the $what is not a JSON object")
    val version = (obj.members["version"] as? JsonNumber)?.raw?.toIntOrNull()
    if (version != SPT_RECORD_VERSION) throw IllegalArgumentException("unsupported $what version")
    val actual = obj.members.keys.sorted()
    val wanted = keys.sorted()
    if (actual != wanted) throw IllegalArgumentException("the $what's fields are wrong")
    return obj
}

internal fun JsonObject.str(key: String): String =
    (members[key] as? JsonString)?.value ?: throw IllegalArgumentException("$key is not a string")

/** base64url field decoded to EXACTLY [length] bytes, canonical spelling required. */
internal fun decodeExact(value: String, length: Int, field: String): ByteArray {
    val bytes = fromBase64Url(value) ?: throw IllegalArgumentException("$field is not canonical unpadded base64url")
    if (bytes.size != length) throw IllegalArgumentException("$field decodes to ${bytes.size} bytes, expected $length")
    if (toBase64Url(bytes) != value) throw IllegalArgumentException("$field has a non-canonical base64url spelling")
    return bytes
}

private val HEX_32_RE = Regex("^[0-9a-f]{32}$")
internal fun isHex32(s: String): Boolean = HEX_32_RE.matches(s)
