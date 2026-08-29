package dev.systemslibrarian.truepad.core

/*
 * A small STRICT JSON reader (RFC 8259), dependency-free, whose acceptance
 * mirrors JavaScript's JSON.parse closely enough for the envelope grammar: one
 * top-level value, no trailing content, no comments, no trailing commas, strict
 * number grammar (no leading zeros, no +, no bare fraction), strict string
 * escapes, control characters refused unescaped. Duplicate object keys are
 * last-wins (as JSON.parse), because the envelope's separate lexical scan
 * (Envelope.kt) is what refuses duplicate keys.
 *
 * JsonNumber keeps the RAW source spelling so the envelope's one-spelling rule
 * (7 vs 7.0 vs 7e0) can be enforced on it — the parse folds nothing away.
 */

sealed class JsonValue
data class JsonObject(val members: LinkedHashMap<String, JsonValue>) : JsonValue()
data class JsonArray(val items: List<JsonValue>) : JsonValue()
data class JsonString(val value: String) : JsonValue()
data class JsonNumber(val raw: String) : JsonValue()
data class JsonBool(val value: Boolean) : JsonValue()
data object JsonNull : JsonValue()

class JsonParseException(message: String) : Exception(message)

/** Parse `text` as strict JSON, or throw [JsonParseException]. */
fun parseJson(text: String): JsonValue {
    val p = JsonParser(text)
    p.skipWs()
    val v = p.parseValue()
    p.skipWs()
    if (!p.atEnd()) throw JsonParseException("trailing content after top-level value at index ${p.pos}")
    return v
}

private class JsonParser(private val s: String) {
    var pos = 0

    fun atEnd(): Boolean = pos >= s.length

    fun skipWs() {
        while (pos < s.length) {
            when (s[pos]) {
                ' ', '\t', '\n', '\r' -> pos++
                else -> return
            }
        }
    }

    private fun peek(): Char {
        if (pos >= s.length) throw JsonParseException("unexpected end of input")
        return s[pos]
    }

    fun parseValue(): JsonValue {
        skipWs()
        return when (peek()) {
            '{' -> parseObject()
            '[' -> parseArray()
            '"' -> JsonString(parseString())
            't', 'f' -> parseBool()
            'n' -> { expect("null"); JsonNull }
            '-', in '0'..'9' -> JsonNumber(parseNumberRaw())
            else -> throw JsonParseException("unexpected character '${peek()}' at index $pos")
        }
    }

    private fun expect(word: String) {
        if (pos + word.length > s.length || s.substring(pos, pos + word.length) != word) {
            throw JsonParseException("expected '$word' at index $pos")
        }
        pos += word.length
    }

    private fun parseBool(): JsonBool =
        if (peek() == 't') { expect("true"); JsonBool(true) } else { expect("false"); JsonBool(false) }

    private fun parseObject(): JsonObject {
        pos++ // consume {
        val map = LinkedHashMap<String, JsonValue>()
        skipWs()
        if (peek() == '}') { pos++; return JsonObject(map) }
        while (true) {
            skipWs()
            if (peek() != '"') throw JsonParseException("object key must be a string at index $pos")
            val key = parseString()
            skipWs()
            if (peek() != ':') throw JsonParseException("expected ':' at index $pos")
            pos++
            val value = parseValue()
            map[key] = value // last-wins, as JSON.parse
            skipWs()
            when (peek()) {
                ',' -> { pos++; continue }
                '}' -> { pos++; return JsonObject(map) }
                else -> throw JsonParseException("expected ',' or '}' at index $pos")
            }
        }
    }

    private fun parseArray(): JsonArray {
        pos++ // consume [
        val items = ArrayList<JsonValue>()
        skipWs()
        if (peek() == ']') { pos++; return JsonArray(items) }
        while (true) {
            items.add(parseValue())
            skipWs()
            when (peek()) {
                ',' -> { pos++; continue }
                ']' -> { pos++; return JsonArray(items) }
                else -> throw JsonParseException("expected ',' or ']' at index $pos")
            }
        }
    }

    private fun parseString(): String {
        pos++ // consume opening quote
        val sb = StringBuilder()
        while (true) {
            if (pos >= s.length) throw JsonParseException("unterminated string")
            val c = s[pos]
            when {
                c == '"' -> { pos++; return sb.toString() }
                c == '\\' -> {
                    pos++
                    if (pos >= s.length) throw JsonParseException("unterminated escape")
                    when (val e = s[pos]) {
                        '"' -> sb.append('"')
                        '\\' -> sb.append('\\')
                        '/' -> sb.append('/')
                        'b' -> sb.append('\b')
                        'f' -> sb.append(0x0C.toChar())
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'u' -> {
                            if (pos + 4 >= s.length) throw JsonParseException("bad \\u escape")
                            val hex = s.substring(pos + 1, pos + 5)
                            val code = hex.toIntOrNull(16) ?: throw JsonParseException("bad \\u escape '$hex'")
                            sb.append(code.toChar())
                            pos += 4
                        }
                        else -> throw JsonParseException("invalid escape '\\$e'")
                    }
                    pos++
                }
                c.code < 0x20 -> throw JsonParseException("unescaped control character in string at index $pos")
                else -> { sb.append(c); pos++ }
            }
        }
    }

    // Strict number grammar; returns the raw spelling (no folding).
    private fun parseNumberRaw(): String {
        val start = pos
        if (peek() == '-') pos++
        if (atEnd()) throw JsonParseException("bad number at index $start")
        if (s[pos] == '0') {
            pos++
        } else if (s[pos] in '1'..'9') {
            while (pos < s.length && s[pos] in '0'..'9') pos++
        } else {
            throw JsonParseException("bad number at index $start")
        }
        if (pos < s.length && s[pos] == '.') {
            pos++
            if (pos >= s.length || s[pos] !in '0'..'9') throw JsonParseException("bad fraction at index $start")
            while (pos < s.length && s[pos] in '0'..'9') pos++
        }
        if (pos < s.length && (s[pos] == 'e' || s[pos] == 'E')) {
            pos++
            if (pos < s.length && (s[pos] == '+' || s[pos] == '-')) pos++
            if (pos >= s.length || s[pos] !in '0'..'9') throw JsonParseException("bad exponent at index $start")
            while (pos < s.length && s[pos] in '0'..'9') pos++
        }
        return s.substring(start, pos)
    }
}
