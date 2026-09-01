package dev.systemslibrarian.truepad.core

import java.io.File

/**
 * Reader for the SHARED frozen vectors in android/vectors/. Those files are
 * emitted by the RELEASED TruePad v2.0.0 implementation itself (see each file's
 * `note`), so a pass here is byte-for-byte agreement with what ships — not a
 * re-transcription of it.
 */
object Vectors {
    private val dir = File("../vectors")

    fun obj(name: String): JsonObject {
        val f = File(dir, name)
        check(f.isFile) { "missing vector file ${f.absolutePath}; regenerate with _gen/android-vectors.mjs" }
        return parseJson(f.readText()) as JsonObject
    }
}

fun JsonObject.arr(key: String): List<JsonValue> = (members.getValue(key) as JsonArray).items
fun JsonObject.obj(key: String): JsonObject = members.getValue(key) as JsonObject
fun JsonObject.str(key: String): String = (members.getValue(key) as JsonString).value
fun JsonObject.strOrNull(key: String): String? = (members[key] as? JsonString)?.value
fun JsonObject.long(key: String): Long = (members.getValue(key) as JsonNumber).raw.toLong()
fun JsonObject.int(key: String): Int = long(key).toInt()
fun JsonObject.bool(key: String): Boolean = (members.getValue(key) as JsonBool).value
fun JsonObject.has(key: String): Boolean = members.containsKey(key)
fun JsonValue.asObj(): JsonObject = this as JsonObject

fun vhex(s: String): ByteArray = hexToBytes(s) ?: error("bad hex in vector: $s")
