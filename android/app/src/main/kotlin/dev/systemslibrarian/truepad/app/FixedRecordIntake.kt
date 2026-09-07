package dev.systemslibrarian.truepad.app

import dev.systemslibrarian.truepad.core.MAX_CIPHERTEXT_BYTES
import dev.systemslibrarian.truepad.storage.RecordSpec

/**
 * WHETHER A TYPED FIXED RECORD SIZE IS USABLE.
 *
 * A fixed record pads every message to the same ciphertext length, so the exact
 * length of what was written stops being visible on the wire (§16).
 *
 * THIS EXISTS BECAUSE THE SCREEN GOT THE CEILING WRONG. The create screen
 * validated the typed size against the selected preset's encryption capacity
 * ALONE — `parsedF.toLong() <= size.encryptionBytes` — while the engine refuses
 * anything above [MAX_CIPHERTEXT_BYTES]. On the Large preset those are 4,194,304
 * and 1,048,576, so a size of 2,000,000 was a multiple of 16, under capacity, and
 * enabled the Create button; the engine then refused it. The sentence explaining
 * the range quoted the capacity too, so it told the operator the wrong limit as
 * well as accepting the wrong value.
 *
 * The effective ceiling is the LOWER of the two, which is the only bound that is
 * true of both. The rule now lives here rather than inline in a Composable so it
 * can be tested, which is the other half of why that defect survived.
 *
 * NOTHING IS ROUNDED. A value that is not a multiple of [MULTIPLE_OF] is refused,
 * not nudged to one that works: an operator who typed 100 and got a 112-byte
 * record would have been told something false about their own pad.
 */
object FixedRecordIntake {
    /** §16's floor. */
    const val MINIMUM_BYTES = 32

    /** §16's granularity. */
    const val MULTIPLE_OF = 16

    /** The largest fixed record this pad can actually use. */
    fun ceiling(encryptionCapacity: Long, engineLimit: Int = MAX_CIPHERTEXT_BYTES): Long =
        minOf(encryptionCapacity, engineLimit.toLong())

    /**
     * True when creation may proceed. Note that an unticked checkbox is USABLE:
     * there is no record size to be wrong about.
     */
    fun isUsable(
        fixedLength: Boolean,
        typed: String,
        encryptionCapacity: Long,
        engineLimit: Int = MAX_CIPHERTEXT_BYTES,
    ): Boolean {
        if (!fixedLength) return true
        val value = typed.trim().toIntOrNull() ?: return false
        return value >= MINIMUM_BYTES &&
            value.toLong() <= ceiling(encryptionCapacity, engineLimit) &&
            value % MULTIPLE_OF == 0
    }

    /** What the engine is handed. Null means variable-length. */
    fun recordBytes(
        fixedLength: Boolean,
        typed: String,
        encryptionCapacity: Long,
        engineLimit: Int = MAX_CIPHERTEXT_BYTES,
    ): Int? {
        if (!isUsable(fixedLength, typed, encryptionCapacity, engineLimit)) return null
        return if (fixedLength) typed.trim().toIntOrNull() else null
    }

    /**
     * The sentence shown when the typed size cannot be used. It states the
     * EFFECTIVE ceiling — not the pad's capacity, which on a Large pad is four
     * times what the engine will carry.
     */
    fun explanation(encryptionCapacity: Long, engineLimit: Int = MAX_CIPHERTEXT_BYTES): String =
        "Message size must be a multiple of $MULTIPLE_OF, at least $MINIMUM_BYTES, and no more " +
            "than the largest size this pad can carry (${ceiling(encryptionCapacity, engineLimit)} bytes)."

    /**
     * HOW THIS DIRECTION PACKAGES A MESSAGE, in the operator's terms.
     *
     * Shown beside the message count because the count DEPENDS on it: a fixed
     * store spends a whole record per send, so its "Messages left" is bounded by
     * the encryption budget rather than by the record total, and without this row
     * the smaller number has no visible explanation. Same words as the Browser's
     * `recordModeLabel` (src/browser/ui/format.ts) and the iOS twin.
     */
    fun recordModeLabel(record: RecordSpec): String = when (record) {
        is RecordSpec.Fixed -> "Fixed · ${record.bytes} B per record"
        is RecordSpec.Variable -> "Variable length"
    }
}
