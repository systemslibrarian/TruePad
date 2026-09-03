package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.core.JsonNumber
import dev.systemslibrarian.truepad.core.JsonObject
import dev.systemslibrarian.truepad.core.JsonString
import dev.systemslibrarian.truepad.core.JsonValue
import dev.systemslibrarian.truepad.core.parseJson

/*
 * The crash-safe Android rollback witness — the Kotlin twin of
 * src/browser/engine/witness.ts (FORMAT-V2.md §15).
 *
 * The witness remembers how far a store has advanced, so a store rolled back by
 * a backup/device-transfer restore refuses to move (`witness-regressed`) instead
 * of reusing retired positions or refilling a contested record's attempt budget.
 * It records EXACTLY the three frozen monotone counters and nothing else (§15.1):
 *
 *   { encryptionNextOffset, authenticationNextSequence, attemptsReserved }
 *
 * This is an ANDROID-PRODUCT layer, NOT a class of the frozen store. head.json
 * always carries the CLI's rollback:{witnessClass:"none"} (Store.kt); whether a
 * pair also carries an Android-local witness is recorded in the Android-only
 * pair.json (`witness`). The two kinds mirror the Browser Edition's exactly:
 *
 *   android-none          — no witness. A no-op. Restoring app-private storage
 *                           regresses the store and resets the per-record
 *                           attempt budget; docs/ANDROID-SECURITY.md says so.
 *                           A bare FORMAT-V2 store this app never provisioned
 *                           (e.g. a CLI store copied in) is android-none.
 *   android-local-witness — an APPEND-ONLY journal at `witness/<pairId>.log`,
 *                           written through the Engine's SEPARATE witness Fs.
 *
 * WHERE THE JOURNAL LIVES IS THE WHOLE POINT. A witness only detects a rollback
 * if it sits in a different failure domain from the thing being rolled back. The
 * Android app therefore puts the store under `Context.getFilesDir()` and this
 * journal under `Context.getNoBackupFilesDir()`: Android Auto Backup and
 * device-to-device transfer carry the former and NOT the latter, so a restored
 * pair store meets a witness that still remembers the true high-water and the
 * true attempt budget, and refuses `witness-regressed` before anything is
 * consumed.
 *
 * Named honestly: android-LOCAL. It is one directory on one device, not an
 * independent host, and it claims nothing more. Uninstall and "Clear storage"
 * take both trees — and that is LOSS, not reuse, which is the trade this product
 * always makes. An attacker who can already rewrite this app's private storage
 * is outside what any local witness can defend against.
 *
 * CRASH SAFETY. The journal is APPEND-ONLY and is NEVER truncated, so no write
 * interruption can shrink it, and records are LEADING-newline framed
 * (`\n<json>`, encodeRecord). appendFile gives no record boundary, so a crash
 * mid-append can leave a newline-free partial at EOF — but leading framing
 * bounds every record by its own `\n` and the next record's `\n`, so a torn
 * partial is always an isolated line, never fused with the record before or
 * after it. The read DROPS any line that does not parse and folds the SURVIVING
 * records into the per-direction elementwise max. So only a TORN advance loses
 * its own value; every advance whose append COMPLETED is preserved. Crucially, a
 * torn advance's operation ERRORED and WITHHELD its output (burn emits the
 * envelope / open releases the plaintext only AFTER a successful advance), so
 * the witness never under-reports below a state whose output was RELEASED, and
 * the very next clean advance re-records the current high-water (self-heal).
 *
 * Because a provisioned journal is never emptied by an advance, an established
 * android-local witness NEVER reads as "fresh": a provisioned pair whose journal
 * is missing, empty, all-corrupt, or missing a direction fails CLOSED as
 * `witness-inconsistent`. Bootstrap — the explicit provisioning event — is the
 * only writer that creates the first records, at gen or a successful import,
 * never inferred from an empty file.
 *
 * (Skipping — not failing closed on — a malformed line is safe: the witness
 * cannot defend against an attacker who can already rewrite this app's private
 * storage. Its jobs are crash-safety and detecting a rollback of the PAIR store.)
 */

/** The Android-product witness kind, as recorded in pair.json. */
enum class WitnessKind(val wire: String) {
    NONE("android-none"),
    LOCAL("android-local-witness");

    companion object {
        fun fromWire(s: String?): WitnessKind? = when (s) {
            "android-none" -> NONE
            "android-local-witness" -> LOCAL
            else -> null
        }
    }
}

/** The three frozen monotone counters, and nothing else (§15.1, ledger N17). */
data class WitnessCounters(
    val encryptionNextOffset: Long,
    val authenticationNextSequence: Long,
    val attemptsReserved: Long,
) {
    companion object {
        val ZERO = WitnessCounters(0, 0, 0)
    }
}

/** The non-secret comparison of a store against its witness, for status (§15.3). */
enum class WitnessState(val wire: String) {
    NA("n/a"), ALIGNED("aligned"), AHEAD("ahead"), REGRESSED("regressed"), INCONSISTENT("inconsistent")
}

sealed class WitnessPreflight {
    data class Ok(val state: WitnessState) : WitnessPreflight()
    /** reason ∈ {"witness-regressed","witness-inconsistent"}. */
    data class Refusal(val reason: String, val message: String) : WitnessPreflight()
}

/** The store's effective high-waters, for the preflight/report comparison. */
data class StoreHighWaters(val nextOffset: Long, val nextSequence: Long, val attemptsReserved: Long)

fun witnessLogPath(pairId: String): String = "witness/$pairId.log"

/* ---- the append-only journal ---------------------------------------------- */

private const val MAX_SAFE = 9_007_199_254_740_991L

private fun safeCount(v: JsonValue?): Long? {
    if (v !is JsonNumber) return null
    val n = v.raw.toLongOrNull() ?: return null
    return if (n in 0..MAX_SAFE) n else null
}

/**
 * Each record is framed with a LEADING newline (`\n<json>`), NOT a trailing one.
 * This is what makes a torn append harmless to its neighbours: appendFile writes
 * at EOF with no boundary, so a crash mid-append can leave a newline-free
 * partial. With leading framing, every record — the torn one included — is
 * bounded on the LEFT by its own `\n` and on the RIGHT by the NEXT record's
 * `\n`, so a torn partial is always an isolated line that the reader drops, and
 * it can never fuse into and destroy the record before OR after it. (Trailing
 * framing would let a torn partial swallow the following clean record.)
 *
 * The four short keys and their order match the Browser Edition byte for byte.
 */
internal fun encodeWitnessRecord(direction: Direction, c: WitnessCounters): ByteArray {
    val sb = StringBuilder("\n{\"d\":")
    jsonString(sb, direction.wire)
    sb.append(",\"eno\":").append(c.encryptionNextOffset)
        .append(",\"ans\":").append(c.authenticationNextSequence)
        .append(",\"ar\":").append(c.attemptsReserved)
        .append('}')
    return sb.toString().toByteArray(Charsets.UTF_8)
}

private class WitnessRecord(val direction: Direction, val counters: WitnessCounters)

private fun parseWitnessRecord(raw: JsonValue): WitnessRecord? {
    if (raw !is JsonObject) return null
    if (raw.members.size != 4) return null
    val direction = Direction.fromWire((raw.members["d"] as? JsonString)?.value ?: "") ?: return null
    val eno = safeCount(raw.members["eno"]) ?: return null
    val ans = safeCount(raw.members["ans"]) ?: return null
    val ar = safeCount(raw.members["ar"]) ?: return null
    return WitnessRecord(direction, WitnessCounters(eno, ans, ar))
}

/**
 * Read the append-only journal and fold the SURVIVING records into the
 * per-direction elementwise maximum. This is what makes the journal crash-safe
 * WITHOUT relying on any atomic replace. `null` means absent / empty / no
 * surviving record — no provisioned high-water.
 */
private fun readEffective(fs: Fs, pairId: String): Map<Direction, WitnessCounters>? {
    val bytes = fs.readFile(witnessLogPath(pairId)) ?: return null
    val byDirection = LinkedHashMap<Direction, WitnessCounters>()
    for (line in String(bytes, Charsets.UTF_8).split("\n")) {
        if (line.isEmpty()) continue
        val parsed = try { parseJson(line) } catch (_: Exception) { continue } // torn/corrupt — drop it
        val record = parseWitnessRecord(parsed) ?: continue
        val prev = byDirection[record.direction]
        byDirection[record.direction] = if (prev == null) {
            record.counters
        } else {
            WitnessCounters(
                maxOf(prev.encryptionNextOffset, record.counters.encryptionNextOffset),
                maxOf(prev.authenticationNextSequence, record.counters.authenticationNextSequence),
                maxOf(prev.attemptsReserved, record.counters.attemptsReserved),
            )
        }
    }
    return if (byDirection.isEmpty()) null else byDirection
}

private fun belowWitness(s: StoreHighWaters, w: WitnessCounters): Boolean =
    s.nextOffset < w.encryptionNextOffset ||
        s.nextSequence < w.authenticationNextSequence ||
        s.attemptsReserved < w.attemptsReserved

private fun alignedWith(s: StoreHighWaters, w: WitnessCounters): Boolean =
    s.nextOffset == w.encryptionNextOffset &&
        s.nextSequence == w.authenticationNextSequence &&
        s.attemptsReserved == w.attemptsReserved

/* ---- the witness contract -------------------------------------------------- */

interface Witness {
    val kind: WitnessKind

    /**
     * Provision the witness — the explicit event at gen or a successful import.
     * `initial` seeds each direction (gen: zeros; import: the imported store's
     * high-waters, so a mid-life import is not spuriously refused
     * witness-regressed). [WitnessKind.NONE] is a no-op.
     */
    fun bootstrap(pairId: String, initial: Map<Direction, WitnessCounters>? = null)

    /**
     * §15.3 PREFLIGHT: a free state gate before anything is consumed. A store
     * below its witness refuses `witness-regressed`; a missing/empty/torn/
     * absent-direction PROVISIONED witness refuses `witness-inconsistent`
     * (fail closed — an established witness never reads as fresh).
     */
    fun preflight(pairId: String, direction: Direction, store: StoreHighWaters): WitnessPreflight

    /**
     * §15.3 ADVANCE: after the durable §12 commit, before the emit. Appends one
     * record. Throws on an I/O failure — the caller has already committed, so
     * the output is withheld (the LOSS row: material, never reuse).
     */
    fun advance(pairId: String, direction: Direction, counters: WitnessCounters)

    /** §15.3 status: read-only comparison; refuses nothing. */
    fun report(pairId: String, direction: Direction, store: StoreHighWaters): WitnessState
}

/** android-none: no witness. Every touchpoint is a no-op; status reports "n/a". */
private object NoneWitness : Witness {
    override val kind = WitnessKind.NONE
    override fun bootstrap(pairId: String, initial: Map<Direction, WitnessCounters>?) { /* nothing to provision */ }
    override fun preflight(pairId: String, direction: Direction, store: StoreHighWaters) =
        WitnessPreflight.Ok(WitnessState.NA)
    override fun advance(pairId: String, direction: Direction, counters: WitnessCounters) { /* nothing to advance */ }
    override fun report(pairId: String, direction: Direction, store: StoreHighWaters) = WitnessState.NA
}

private fun inconsistent(message: String) =
    WitnessPreflight.Refusal("witness-inconsistent", "$message Nothing was burned.")

/** android-local-witness: the append-only journal at `witness/<pairId>.log`. */
private class LocalWitness(private val fs: Fs) : Witness {
    override val kind = WitnessKind.LOCAL

    override fun bootstrap(pairId: String, initial: Map<Direction, WitnessCounters>?) {
        // Provision both directions; protection begins here. Append-only: these
        // two records are the journal's first durable content.
        for (d in listOf(Direction.A_TO_B, Direction.B_TO_A)) {
            val seed = initial?.get(d) ?: WitnessCounters.ZERO
            fs.appendFile(witnessLogPath(pairId), encodeWitnessRecord(d, seed))
        }
    }

    override fun preflight(pairId: String, direction: Direction, store: StoreHighWaters): WitnessPreflight {
        val eff = readEffective(fs, pairId)
            ?: return inconsistent(
                "this pair is provisioned with an Android-local rollback witness, but its journal " +
                    "${witnessLogPath(pairId)} is missing, empty, or holds no surviving record. An established " +
                    "witness is never treated as fresh: a vanished witness is a possible rollback, so this fails closed.",
            )
        val w = eff[direction]
            ?: return inconsistent(
                "the Android-local rollback witness ${witnessLogPath(pairId)} carries no record for " +
                    "${direction.wire}: its provisioning record for this direction is gone, so it fails closed " +
                    "rather than assume a fresh store.",
            )
        if (belowWitness(store, w)) {
            return WitnessPreflight.Refusal(
                "witness-regressed",
                "this store is behind its rollback witness: the witness records encryptionNextOffset " +
                    "${w.encryptionNextOffset}, authenticationNextSequence ${w.authenticationNextSequence}, and " +
                    "attemptsReserved ${w.attemptsReserved}, but this store is at nextOffset ${store.nextOffset}, " +
                    "nextSequence ${store.nextSequence}, and attemptsReserved ${store.attemptsReserved}. A store " +
                    "below its witness is the restored-store signature (§9.4): the pair store was rolled back while " +
                    "the witness, in a separate directory the pair's own files do not include, remembers the true " +
                    "high-water and attempt budget. Refusing before anything is consumed. Nothing was burned.",
            )
        }
        return WitnessPreflight.Ok(if (alignedWith(store, w)) WitnessState.ALIGNED else WitnessState.AHEAD)
    }

    override fun advance(pairId: String, direction: Direction, counters: WitnessCounters) {
        fs.appendFile(witnessLogPath(pairId), encodeWitnessRecord(direction, counters))
    }

    override fun report(pairId: String, direction: Direction, store: StoreHighWaters): WitnessState {
        val eff = readEffective(fs, pairId) ?: return WitnessState.INCONSISTENT
        val w = eff[direction] ?: return WitnessState.INCONSISTENT
        if (belowWitness(store, w)) return WitnessState.REGRESSED
        return if (alignedWith(store, w)) WitnessState.ALIGNED else WitnessState.AHEAD
    }
}

/** Build the witness for a pair's Android-product witness kind (from pair.json). */
fun witnessFor(fs: Fs, kind: WitnessKind): Witness =
    if (kind == WitnessKind.LOCAL) LocalWitness(fs) else NoneWitness
