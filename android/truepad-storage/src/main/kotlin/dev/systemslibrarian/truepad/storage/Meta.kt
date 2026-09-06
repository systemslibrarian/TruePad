package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.core.JsonNumber
import dev.systemslibrarian.truepad.core.JsonObject
import dev.systemslibrarian.truepad.core.JsonString
import dev.systemslibrarian.truepad.core.parseJson
import java.time.Instant
import java.time.format.DateTimeParseException

/*
 * The Android-product bookkeeping ABOUT a pad, which is not part of the pad.
 *
 * None of these files is Store Format v2 and none travels in the six-file
 * courier bundle: they are this installation's record of its own acts. Twin of
 * the browser-only files in src/browser/engine/{verbs,handoff}.ts.
 *
 *   <pairId>/pair.json        witness kind + provenance + display metadata
 *   <pairId>/destroyed.json   the §17 tombstone — the irreversible boundary
 *   <pairId>/importing.json   the import commit gate
 *   <pairId>/handoff.json     the one-handoff record; EXISTENCE is load-bearing
 */

const val PAIR_META_FILE = "pair.json"
const val TOMBSTONE_FILE = "destroyed.json"
const val IMPORT_MARKER_FILE = "importing.json"
const val HANDOFF_MARKER_FILE = "handoff.json"
const val STAGING_ROOT = "importing"

internal val HEX_32_RE = Regex("^[0-9a-f]{32}$")

fun pairMetaPath(pairId: String) = "$pairId/$PAIR_META_FILE"
fun tombstonePath(pairId: String) = "$pairId/$TOMBSTONE_FILE"
fun importMarkerPath(pairId: String) = "$pairId/$IMPORT_MARKER_FILE"
fun handoffMarkerPath(pairId: String) = "$pairId/$HANDOFF_MARKER_FILE"
fun stagingDir(pairId: String) = "$STAGING_ROOT/$pairId"

/* ---- provenance ------------------------------------------------------------
 * WHERE A PAD CAME FROM, recorded by the installation about ITSELF.
 *
 * pair.json is Android-local and is NOT one of the six courier files, so a
 * sender cannot put a chosen origin into a bundle and have the importer believe
 * it. The value is written by whichever installation created or imported the pad.
 *
 *   GENERATED_HERE -> may perform the first software-mediated handoff
 *   IMPORTED       -> may NEVER export onward
 *   UNKNOWN        -> legacy: an absent field. NEVER written to disk, never
 *                     backfilled, never inferred from counters or from whether
 *                     the pad happens to sit at genesis. The absence of the
 *                     field is information: it means nobody recorded this, and
 *                     guessing in the direction that permits forwarding is
 *                     exactly how a pad ends up in two hands.
 *
 * A field that is PRESENT but unrecognised is corruption and fails closed, the
 * same way an unrecognised `witness` does. A MISSING field is legacy.
 */
enum class PairOrigin(val wire: String?) {
    GENERATED_HERE("generated-here"),
    IMPORTED("imported"),
    UNKNOWN(null);

    companion object {
        fun fromWire(s: String): PairOrigin? = when (s) {
            "generated-here" -> GENERATED_HERE
            "imported" -> IMPORTED
            else -> null
        }
    }
}

class PairMeta(
    val pairId: String,
    val label: String,
    val createdAt: String,
    val witness: WitnessKind,
    val origin: PairOrigin,
)

/**
 * Read pair.json. Its `witness` field is LOAD-BEARING: it says whether a
 * rollback witness applies, so a present-but-corrupt pair.json fails CLOSED
 * rather than silently defaulting to no-witness (which would bypass a
 * provisioned witness). A pair with NO pair.json is a bare FORMAT-V2 store this
 * app never provisioned (e.g. a CLI store copied in): android-none, with
 * defaulted display fields and an `unknown` origin.
 */
fun readPairMeta(fs: Fs, pairId: String): PairMeta {
    val bytes = fs.readFile(pairMetaPath(pairId))
        ?: return PairMeta(pairId, pairId, "", WitnessKind.NONE, PairOrigin.UNKNOWN)
    val parsed = try {
        parseJson(String(bytes, Charsets.UTF_8))
    } catch (_: Exception) {
        throw EngineRefused(
            "corrupt-pair-meta",
            "$PAIR_META_FILE for $pairId does not parse as JSON, so TruePad cannot tell whether this pair carries a " +
                "rollback witness. It fails closed rather than assume none. Nothing was touched.",
        )
    }
    val obj: JsonObject? = parsed as? JsonObject
    val witness: WitnessKind = WitnessKind.fromWire((obj?.members?.get("witness") as? JsonString)?.value)
        ?: throw EngineRefused(
            "corrupt-pair-meta",
            "$PAIR_META_FILE for $pairId has no recognised witness kind. It fails closed rather than guess whether a " +
                "rollback witness applies. Nothing was touched.",
        )
    // A recognised witness kind proves the document was an object.
    val members = obj!!.members
    // Provenance is load-bearing in the same way `witness` is: a value we do not
    // recognise means we cannot tell where this pad came from, and the safe
    // reading of "cannot tell" is not "it was made here".
    val originValue = members["origin"]
    val origin: PairOrigin = if (originValue == null) {
        PairOrigin.UNKNOWN // MISSING is legacy, not corruption
    } else {
        val wire = (originValue as? JsonString)?.value
        (wire?.let { PairOrigin.fromWire(it) })
            ?: throw EngineRefused(
                "corrupt-pair-meta",
                "$PAIR_META_FILE for $pairId has an unrecognised origin. It fails closed rather than guess whether " +
                    "this pad was generated here or arrived from elsewhere. Nothing was touched.",
            )
    }
    val label = (members["label"] as? JsonString)?.value ?: pairId
    val createdAt = (members["createdAt"] as? JsonString)?.value ?: ""
    return PairMeta(pairId, label, createdAt, witness, origin)
}

/** Write pair.json. `origin` must be one of the two real values — never UNKNOWN. */
fun writePairMeta(fs: Fs, meta: PairMeta) {
    val wire = meta.origin.wire
        ?: throw IllegalArgumentException("pair.json never serializes an unknown origin; it is an in-memory state only")
    val sb = StringBuilder("{\"pairId\":")
    jsonString(sb, meta.pairId)
    sb.append(",\"label\":"); jsonString(sb, meta.label)
    sb.append(",\"createdAt\":"); jsonString(sb, meta.createdAt)
    sb.append(",\"witness\":"); jsonString(sb, meta.witness.wire)
    sb.append(",\"origin\":"); jsonString(sb, wire)
    sb.append('}')
    fs.writeFileAtomic(pairMetaPath(meta.pairId), sb.toString().toByteArray(Charsets.UTF_8))
}

/* ---- the tombstone (§17.3) -------------------------------------------------- */

/** The verbatim §17 sentence — identical in the tombstone and the UI. */
const val DESTROY_LIMITATION: String =
    "Software can forget its reference to pad material; it cannot prove that flash forgot the bytes."

const val UNREADABLE_PAIR_TOKEN: String = "destroy-unreadable-pair"

class ExistingTombstone(val exists: Boolean, val pairId: String?, val wellFormed: Boolean)

fun readTombstone(fs: Fs, pairId: String): ExistingTombstone {
    val bytes = fs.readFile(tombstonePath(pairId)) ?: return ExistingTombstone(false, null, false)
    try {
        val parsed = parseJson(String(bytes, Charsets.UTF_8))
        if (parsed is JsonObject) {
            val id = (parsed.members["pairId"] as? JsonString)?.value?.takeIf { HEX_32_RE.matches(it) }
            val wellFormed = (parsed.members["formatVersion"] as? JsonNumber)?.raw == "2"
            return ExistingTombstone(true, id, wellFormed)
        }
    } catch (_: Exception) {
        /* unparseable tombstone: the boundary stands, rewrite a clean one */
    }
    return ExistingTombstone(true, null, false)
}

class HighWaters(val nextOffset: Long, val nextSequence: Long)

/**
 * The §17.2 step-2 tombstone: durable, and it survives the destruction. Two
 * spaces of indentation, matching the released `JSON.stringify(t, null, 2)`.
 */
fun writeTombstone(
    fs: Fs,
    pairId: String,
    resolvedPairId: String?,
    destroyedAt: String,
    reason: String,
    ab: HighWaters?,
    ba: HighWaters?,
) {
    fun hw(sb: StringBuilder, h: HighWaters?, indent: String) {
        if (h == null) {
            sb.append("null")
        } else {
            sb.append("{\n$indent  \"nextOffset\": ").append(h.nextOffset)
                .append(",\n$indent  \"nextSequence\": ").append(h.nextSequence)
                .append("\n$indent}")
        }
    }
    val sb = StringBuilder("{\n  \"formatVersion\": 2,\n  \"pairId\": ")
    if (resolvedPairId == null) sb.append("null") else jsonString(sb, resolvedPairId)
    sb.append(",\n  \"destroyedAt\": "); jsonString(sb, destroyedAt)
    sb.append(",\n  \"reason\": "); jsonString(sb, reason)
    sb.append(",\n  \"finalHighWaters\": {\n    \"A->B\": ")
    hw(sb, ab, "    ")
    sb.append(",\n    \"B->A\": ")
    hw(sb, ba, "    ")
    sb.append("\n  },\n  \"limitation\": ")
    jsonString(sb, DESTROY_LIMITATION)
    sb.append("\n}")
    fs.writeFileAtomic(tombstonePath(pairId), sb.toString().toByteArray(Charsets.UTF_8))
}

/* ---- the one-handoff record -------------------------------------------------
 * A pad may leave this installation ONCE. THE RULE THAT MATTERS MOST: EXISTENCE
 * IS LOAD-BEARING. If handoff.json exists but is empty, truncated, malformed,
 * semantically invalid, or merely unreadable, that is NOT "no handoff" — it is
 * UNREADABLE_SPENT. The file is never auto-deleted, never auto-repaired, and
 * never treated as absence, because the one thing a torn marker can mean is
 * that a copy already left.
 *
 *     LOSS IS ACCEPTABLE. REUSE IS NOT.
 *
 * There is deliberately no `catch { return absent }` anywhere in this section.
 *
 * This Android build performs BOTH handoff routes: the physical one (save the pad
 * file) and Sealed Pad Transfer. This comment used to say SPT "is not implemented
 * here", which was true when it was written and stopped being true when
 * `truepad-spt` landed.
 *
 * Either marker is parsed and either refuses a second handoff — never ignored,
 * and never mistaken for absence. ONE PAD LEAVES ONCE, by whichever route.
 */

const val REFUSE_UNREADABLE = "handoff-state-unreadable"
const val REFUSE_ALREADY_SEALED = "pad-already-sealed"

/** The one sentence the operator gets about a torn marker. It says what TruePad
 *  does not know and what it therefore will not do — and deliberately does not
 *  suggest deleting the file, because deleting it is exactly the action that
 *  would turn a lost handoff into a reused pad. */
const val UNREADABLE_ADVICE: String =
    "TruePad cannot safely determine this pad's handoff state, so it refuses to create another copy. " +
        "A record of a handoff exists but cannot be read. Generate a new pad for any further transfer."

sealed class HandoffState {
    data object Absent : HandoffState()
    data class Physical(val at: String) : HandoffState()
    data class Sealed(val at: String) : HandoffState()
    /** The file exists and cannot be trusted. NOT absence. */
    data class UnreadableSpent(val message: String) : HandoffState()
}

private const val MARKER_VERSION = 1
private val PHYSICAL_KEYS = listOf("version", "pairId", "mode", "at")
private val SEALED_KEYS = listOf("version", "pairId", "mode", "at", "requestHash", "packageIdentity", "confirmHash")

/** The exact `YYYY-MM-DDTHH:mm:ss.sssZ` form, checked by round-trip so no other
 *  spelling of the same instant is accepted. */
private fun requireIsoTimestamp(value: String?): String {
    if (value == null) throw IllegalArgumentException("at is not a string")
    val instant = try { Instant.parse(value) } catch (_: DateTimeParseException) {
        throw IllegalArgumentException("at is not a canonical ISO-8601 timestamp")
    }
    if (isoNow(instant) != value) throw IllegalArgumentException("at is not a canonical ISO-8601 timestamp")
    return value
}

/**
 * Strict parse. Every failure throws; NOTHING here defaults, coerces, or
 * tolerates an extra field. A reader that shrugged at an unexpected key would be
 * a reader that could be handed a physical marker wearing sealed clothes.
 */
internal fun parseHandoffMarker(bytes: ByteArray, pairId: String): HandoffState {
    if (bytes.isEmpty()) throw IllegalArgumentException("the handoff marker is empty")
    val parsed = try { parseJson(String(bytes, Charsets.UTF_8)) } catch (_: Exception) {
        throw IllegalArgumentException("the handoff marker does not parse as JSON")
    }
    val obj = parsed as? JsonObject ?: throw IllegalArgumentException("the handoff marker is not a JSON object")
    if ((obj.members["version"] as? JsonNumber)?.raw != MARKER_VERSION.toString()) {
        throw IllegalArgumentException("unsupported handoff marker version")
    }
    val id = (obj.members["pairId"] as? JsonString)?.value
    if (id == null || !HEX_32_RE.matches(id)) throw IllegalArgumentException("the handoff marker has no valid pairId")
    if (id != pairId) throw IllegalArgumentException("the handoff marker names a different pair")
    val mode = (obj.members["mode"] as? JsonString)?.value
    if (mode != "physical" && mode != "sealed") throw IllegalArgumentException("the handoff marker has an unsupported mode")
    val at = requireIsoTimestamp((obj.members["at"] as? JsonString)?.value)
    val expected = if (mode == "sealed") SEALED_KEYS else PHYSICAL_KEYS
    // Catches BOTH a physical marker carrying sealed-only fields and a sealed
    // marker missing one.
    if (obj.members.keys.sorted() != expected.sorted()) {
        throw IllegalArgumentException("the handoff marker's fields do not match mode $mode")
    }
    return if (mode == "physical") HandoffState.Physical(at) else HandoffState.Sealed(at)
}

fun readHandoffState(fs: Fs, pairId: String): HandoffState {
    // The READ itself is wrapped, not just the parse. `Absent` is the one state
    // that permits a second handoff, so anything that is present-but-unreadable —
    // a directory or other non-regular file at the marker path, an I/O failure —
    // must land on UnreadableSpent. Only a genuinely absent path is Absent.
    // This mirrors Handoff.readHandoffState, which already had the right shape,
    // and the frozen authority's readOrThrow in src/browser/engine/handoff.ts.
    val bytes = try {
        fs.readFile(handoffMarkerPath(pairId))
    } catch (e: Exception) {
        return HandoffState.UnreadableSpent("$UNREADABLE_ADVICE (${e.message})")
    } ?: return HandoffState.Absent
    return try {
        parseHandoffMarker(bytes, pairId)
    } catch (e: Exception) {
        HandoffState.UnreadableSpent("$UNREADABLE_ADVICE (${e.message})")
    }
}

/** Serialize with the frozen property order, built from an ordered list rather
 *  than a map literal so the order is a fact of the code. */
fun commitPhysicalHandoff(fs: Fs, pairId: String, at: String) {
    val sb = StringBuilder("{\"version\":").append(MARKER_VERSION).append(",\"pairId\":")
    jsonString(sb, pairId)
    sb.append(",\"mode\":\"physical\",\"at\":")
    jsonString(sb, at)
    sb.append('}')
    fs.writeFileAtomic(handoffMarkerPath(pairId), sb.toString().toByteArray(Charsets.UTF_8))
}

/** The exact `YYYY-MM-DDTHH:mm:ss.sssZ` spelling `new Date().toISOString()` emits. */
internal fun isoNow(instant: Instant): String {
    val millis = instant.toEpochMilli()
    return java.time.format.DateTimeFormatter
        .ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'")
        .withZone(java.time.ZoneOffset.UTC)
        .format(Instant.ofEpochMilli(millis))
}
