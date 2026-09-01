package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.JsonArray
import dev.systemslibrarian.truepad.core.JsonObject
import dev.systemslibrarian.truepad.core.JsonString
import dev.systemslibrarian.truepad.core.parseJson
import java.util.Base64

/*
 * The courier container format — byte-exact twin of
 * src/browser/engine/courier-format.ts.
 *
 * A pair's store IS the pad. The courier step packs the exact FORMAT-V2 store
 * files into ONE self-describing byte container the peer can import, and unpacks
 * one on import. The container is a small JSON envelope with base64 file bodies;
 * base64 is the on-container encoding only.
 *
 * A container written here is byte-identical to one written by the released
 * Browser Edition for the same six files, so a pad couriered from Android
 * imports into the Browser/CLI and back.
 */

const val CONTAINER_TAG = "truepad2-pair-bundle"

class CourierFile(val path: String, val bytes: ByteArray)

sealed class UnpackResult {
    data class Ok(val pairId: String, val files: List<CourierFile>) : UnpackResult()
    data class Bad(val message: String) : UnpackResult()
}

/**
 * Pack the store files into the container bytes. Two spaces of indentation,
 * matching the released `JSON.stringify(doc, null, 2)`.
 */
fun packContainer(pairId: String, files: List<CourierFile>): ByteArray {
    val b64 = Base64.getEncoder()
    val sb = StringBuilder(1024)
    sb.append("{\n  \"format\": ")
    jsonString(sb, CONTAINER_TAG)
    sb.append(",\n  \"version\": 1,\n  \"pairId\": ")
    jsonString(sb, pairId)
    sb.append(",\n  \"files\": [")
    for ((i, f) in files.withIndex()) {
        if (i > 0) sb.append(',')
        sb.append("\n    {\n      \"path\": ")
        jsonString(sb, f.path)
        sb.append(",\n      \"bytesB64\": ")
        jsonString(sb, b64.encodeToString(f.bytes))
        sb.append("\n    }")
    }
    if (files.isEmpty()) sb.append("]") else sb.append("\n  ]")
    sb.append("\n}")
    return sb.toString().toByteArray(Charsets.UTF_8)
}

/**
 * Parse and structurally validate a container. Deeper validation (exact file
 * set, headers, reconciliation, pairId agreement) is the importer's
 * transactional job — this just turns bytes into a typed, well-formed shape or
 * a clear refusal, and never lets a malformed container reach the store.
 */
fun unpackContainer(bytes: ByteArray): UnpackResult {
    val doc = try {
        parseJson(String(bytes, Charsets.UTF_8))
    } catch (_: Exception) {
        return UnpackResult.Bad("This file is not valid JSON — it is not a TruePad pad bundle.")
    }
    val rec = doc as? JsonObject ?: return UnpackResult.Bad("This file is not a TruePad pad bundle.")
    if ((rec.members["format"] as? JsonString)?.value != CONTAINER_TAG) {
        return UnpackResult.Bad("This file is not a TruePad pad bundle (wrong format tag).")
    }
    val pairId = (rec.members["pairId"] as? JsonString)?.value
        ?: return UnpackResult.Bad("Bundle is missing its pairId.")
    val arr = rec.members["files"] as? JsonArray ?: return UnpackResult.Bad("Bundle is missing its files.")
    val decoder = Base64.getDecoder()
    val files = ArrayList<CourierFile>(arr.items.size)
    for (entry in arr.items) {
        val e = entry as? JsonObject ?: return UnpackResult.Bad("Bundle contains a malformed file entry.")
        val path = (e.members["path"] as? JsonString)?.value
        val b64 = (e.members["bytesB64"] as? JsonString)?.value
        if (path == null || b64 == null) return UnpackResult.Bad("Bundle contains a malformed file entry.")
        val fileBytes = try {
            decoder.decode(b64)
        } catch (_: IllegalArgumentException) {
            return UnpackResult.Bad("Bundle file \"$path\" is not valid base64.")
        }
        files.add(CourierFile(path, fileBytes))
    }
    return UnpackResult.Ok(pairId, files)
}
