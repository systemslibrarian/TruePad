package dev.systemslibrarian.truepad.core

/*
 * TruePad v2 source-material partition — byte-exact twin of src/core/partition2.ts.
 *
 * Combine declared sources by bytewise XOR and carve the combined material into
 * the four secret slices [abEnc E][abAuth 32N][baEnc E][baAuth 32N], with
 * L = 2·(E + 32·N) the length every source must supply. The XOR and this
 * partition are the only operations between sources and secret body — NO KDF,
 * extractor, hash conditioner, or content-based rejection, ever (§7).
 */

private const val KEY_BYTES = 16

/** L = 2·(E + 32·N): the exact byte count every declared source must supply. */
fun requiredSourceLength(capacity: Long, capacityRecords: Long): Long {
    require(capacity >= 0) { "capacity must be non-negative, not $capacity" }
    require(capacityRecords >= 0) { "capacityRecords must be non-negative, not $capacityRecords" }
    return 2 * (capacity + AUTH_RECORD_BYTES * capacityRecords)
}

class PairSlices(
    val abEncryption: ByteArray,
    val abAuthentication: ByteArray,
    val baEncryption: ByteArray,
    val baAuthentication: ByteArray,
)

/**
 * Bytewise XOR of the first `length` bytes of every source. All-or-nothing: a
 * source shorter than `length` (or no sources) throws before any byte is
 * combined. Bytes beyond `length` are not read. NEVER inspects or conditions on
 * content — an all-zero combined result is a legitimate draw.
 */
fun combineSources(sources: List<ByteArray>, length: Int): ByteArray {
    require(length >= 0) { "length must be non-negative, not $length" }
    require(sources.isNotEmpty()) { "combineSources needs at least one source" }
    for (i in sources.indices) {
        require(sources[i].size >= length) {
            "source $i supplies ${sources[i].size} bytes but $length are required"
        }
    }
    val combined = ByteArray(length)
    for (source in sources) {
        for (i in 0 until length) combined[i] = (combined[i].toInt() xor source[i].toInt()).toByte()
    }
    return combined
}

/** The §7 partition, exactly. Returns COPIES so a caller can zero `combined`. */
fun partition(combined: ByteArray, capacity: Int, capacityRecords: Int): PairSlices {
    val length = requiredSourceLength(capacity.toLong(), capacityRecords.toLong()).toInt()
    require(combined.size == length) {
        "combined material is ${combined.size} bytes but the partition needs exactly $length " +
            "(2*($capacity + 32*$capacityRecords))"
    }
    val authBytes = AUTH_RECORD_BYTES * capacityRecords
    var cursor = 0
    fun take(count: Int): ByteArray {
        val copy = combined.copyOfRange(cursor, cursor + count)
        cursor += count
        return copy
    }
    return PairSlices(
        abEncryption = take(capacity),
        abAuthentication = take(authBytes),
        baEncryption = take(capacity),
        baAuthentication = take(authBytes),
    )
}

/** Auth record `sequence`: K_s = [32s,32s+16), R_s = [32s+16,32s+32) (slice-local). */
fun authRecordAt(authSlice: ByteArray, sequence: Int): Pair<ByteArray, ByteArray> {
    require(sequence >= 0) { "sequence must be non-negative, not $sequence" }
    val start = sequence * AUTH_RECORD_BYTES
    require(start + AUTH_RECORD_BYTES <= authSlice.size) {
        "auth record $sequence needs slice bytes [$start, ${start + AUTH_RECORD_BYTES}) but the slice holds ${authSlice.size}"
    }
    val key = authSlice.copyOfRange(start, start + KEY_BYTES)
    val mask = authSlice.copyOfRange(start + KEY_BYTES, start + AUTH_RECORD_BYTES)
    return key to mask
}
