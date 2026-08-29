package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.AUTH_RECORD_BYTES
import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.core.JsonArray
import dev.systemslibrarian.truepad.core.JsonBool
import dev.systemslibrarian.truepad.core.JsonNumber
import dev.systemslibrarian.truepad.core.JsonObject
import dev.systemslibrarian.truepad.core.JsonString
import dev.systemslibrarian.truepad.core.JsonValue
import dev.systemslibrarian.truepad.core.MAX_CIPHERTEXT_BYTES
import dev.systemslibrarian.truepad.core.parseJson
import java.time.Instant

/*
 * One v2 direction store over the Fs — the Kotlin twin of src/browser/engine/
 * store.ts / src/cli/v2/store2.ts. The SAME frozen Store Format v2: the SAME
 * three files per direction, the SAME canonical JSON bytes, the SAME §12.1
 * reconciliation and §12.4 write order. head.json is serialized byte-identically
 * to the CLI/Browser (compact JSON, canonical key order), so a browser/CLI store
 * is Android-readable and vice versa. Only destruction overwrites secret.bin;
 * retirement is logical (the counters decide liveness, not content).
 */

const val HEAD_FILE = "head.json"
const val SECRET_FILE = "secret.bin"
const val JOURNAL_FILE = "journal.log"
private const val V1_PAD_FILE = "pad.json"
private const val KEY_BYTES = 16

val SUBDIR: Map<Direction, String> = mapOf(Direction.A_TO_B to "a-to-b", Direction.B_TO_A to "b-to-a")

private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
private val HEX_32 = Regex("^[0-9a-f]{32}$")
private val DECIMAL_KEY = Regex("^(?:0|[1-9][0-9]*)$")

private fun path(prefix: String, name: String) = "$prefix/$name"
private fun nowIso(): String = Instant.now().toString()

/* ---- typed refusal shared by store, witness, verbs -------------------------- */

class EngineRefused(val reason: String, message: String) : Exception(message)

/* ---- header shape (§1.1) ---------------------------------------------------- */

class SourceDeclaration(val name: String, val declaredOrigin: String, val lengthBytes: Long)

sealed class RecordSpec {
    data object Variable : RecordSpec()
    data class Fixed(val bytes: Int) : RecordSpec()
}

class HeadV2(
    val pairId: String,
    val direction: Direction,
    val sourceDeclarations: List<SourceDeclaration>,
    val capacity: Long,
    val nextOffset: Long,
    val capacityRecords: Long,
    val nextSequence: Long,
    val verifyAttemptLimit: Long,
    val maxAuthLookahead: Long,
    val record: RecordSpec,
    val failureThreshold: Long,
    val failureCount: Long,
    val clearedAtFailureCount: Long,
    val perSequenceAttempts: LinkedHashMap<String, Long>,
)

class EffectiveState(
    val nextOffset: Long,
    val nextSequence: Long,
    val attempts: Map<Long, Long>,
    // Count of `attempt` journal lines — the monotone quantity the rollback
    // witness records so a restore cannot refill the per-record attempt budget.
    val attemptsReserved: Long,
    val failureCount: Long,
    val clearedAtFailureCount: Long,
)

class LoadedStore(val head: HeadV2, val effective: EffectiveState)

sealed class LoadResult {
    data class Ok(val store: LoadedStore) : LoadResult()
    data class Refusal(val reason: String, val message: String) : LoadResult()
}

/* ---- JSON string escaping matching JSON.stringify (byte-exact interop) ------ */

private val HEXC = "0123456789abcdef".toCharArray()

internal fun jsonString(sb: StringBuilder, s: String) {
    sb.append('"')
    for (c in s) {
        when (c) {
            '"' -> sb.append("\\\"")
            '\\' -> sb.append("\\\\")
            '\b' -> sb.append("\\b")
            '' -> sb.append("\\f")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            else -> if (c.code < 0x20) {
                sb.append("\\u00").append(HEXC[(c.code ushr 4) and 0xF]).append(HEXC[c.code and 0xF])
            } else {
                sb.append(c) // >= 0x20 and non-ASCII emitted literally, as JSON.stringify does
            }
        }
    }
    sb.append('"')
}

/** Serialize a head to the EXACT compact JSON bytes the CLI/Browser emit (§1.1). */
fun serializeHead(h: HeadV2): ByteArray {
    val sb = StringBuilder(512)
    sb.append("{\"formatVersion\":2,\"pairId\":")
    jsonString(sb, h.pairId)
    sb.append(",\"direction\":")
    jsonString(sb, h.direction.wire)
    sb.append(",\"mode\":\"bytes\",\"sourceDeclarations\":[")
    for ((i, d) in h.sourceDeclarations.withIndex()) {
        if (i > 0) sb.append(',')
        sb.append("{\"name\":")
        jsonString(sb, d.name)
        sb.append(",\"declaredOrigin\":")
        jsonString(sb, d.declaredOrigin)
        sb.append(",\"lengthBytes\":").append(d.lengthBytes).append('}')
    }
    sb.append("],\"encryption\":{\"capacity\":").append(h.capacity)
        .append(",\"nextOffset\":").append(h.nextOffset)
        .append("},\"authentication\":{\"profile\":\"wc-one-time-v1\",\"tagBits\":128,\"capacityRecords\":")
        .append(h.capacityRecords).append(",\"nextSequence\":").append(h.nextSequence)
        .append(",\"verifyAttemptLimit\":").append(h.verifyAttemptLimit)
        .append(",\"maxCiphertextBytes\":").append(MAX_CIPHERTEXT_BYTES)
        .append(",\"maxAuthLookahead\":").append(h.maxAuthLookahead)
        .append("},\"recordPolicy\":{\"authenticated\":\"required\",\"downgradeAllowed\":false,\"record\":")
    when (val r = h.record) {
        is RecordSpec.Variable -> sb.append("{\"kind\":\"variable\"}")
        is RecordSpec.Fixed -> sb.append("{\"kind\":\"fixed\",\"bytes\":").append(r.bytes).append('}')
    }
    sb.append("},\"rollback\":{\"witnessClass\":\"none\",\"config\":{}},\"verification\":{\"failurePolicy\":{\"kind\":\"freeze\",\"threshold\":")
        .append(h.failureThreshold).append("},\"failureCount\":").append(h.failureCount)
        .append(",\"clearedAtFailureCount\":").append(h.clearedAtFailureCount)
        .append(",\"perSequenceAttempts\":{")
    var first = true
    for ((k, v) in h.perSequenceAttempts) {
        if (!first) sb.append(',')
        first = false
        jsonString(sb, k)
        sb.append(':').append(v)
    }
    sb.append("}}}")
    return sb.toString().toByteArray(Charsets.UTF_8)
}

/* ---- header validation (§1.1), ported from store.ts validateHead ------------ */

private fun isSafeCount(v: JsonValue?): Boolean {
    if (v !is JsonNumber) return false
    val n = v.raw.toLongOrNull() ?: return false
    return n in 0..MAX_SAFE_INTEGER && DECIMAL_KEY.matches(v.raw.removePrefix("-").let { v.raw })
}

private fun asLong(v: JsonValue?): Long = (v as JsonNumber).raw.toLong()
private fun JsonObject.get(k: String): JsonValue? = members[k]
private fun keySet(o: JsonObject) = o.members.keys

private fun mismatch(o: JsonObject, expected: List<String>): String? {
    val missing = expected.filter { it !in o.members.keys }
    val extra = o.members.keys.filter { it !in expected }
    if (missing.isEmpty() && extra.isEmpty()) return null
    val parts = buildList {
        if (missing.isNotEmpty()) add("missing ${missing.joinToString(", ")}")
        if (extra.isNotEmpty()) add("unexpected ${extra.joinToString(", ")}")
    }
    return parts.joinToString("; ")
}

private class HeadResult(val head: HeadV2?, val why: String?)

private fun validateHead(raw: JsonValue): HeadResult {
    if (raw !is JsonObject) return HeadResult(null, "not a JSON object")
    val top = listOf("formatVersion", "pairId", "direction", "mode", "sourceDeclarations", "encryption", "authentication", "recordPolicy", "rollback", "verification")
    mismatch(raw, top)?.let { return HeadResult(null, "top-level keys: $it") }
    if ((raw.get("formatVersion") as? JsonNumber)?.raw != "2") return HeadResult(null, "formatVersion must be the integer 2")
    val pairId = (raw.get("pairId") as? JsonString)?.value
    if (pairId == null || !HEX_32.matches(pairId)) return HeadResult(null, "pairId must be exactly 32 lowercase hex characters")
    val direction = (raw.get("direction") as? JsonString)?.value?.let { Direction.fromWire(it) }
        ?: return HeadResult(null, "direction must be \"A->B\" or \"B->A\"")
    if ((raw.get("mode") as? JsonString)?.value != "bytes") return HeadResult(null, "mode must be \"bytes\"")

    val sdArr = raw.get("sourceDeclarations") as? JsonArray ?: return HeadResult(null, "sourceDeclarations must be an array")
    val sourceDeclarations = ArrayList<SourceDeclaration>()
    for ((i, e) in sdArr.items.withIndex()) {
        if (e !is JsonObject) return HeadResult(null, "sourceDeclarations[$i] is not an object")
        mismatch(e, listOf("name", "declaredOrigin", "lengthBytes"))?.let { return HeadResult(null, "sourceDeclarations[$i]: $it") }
        val name = (e.get("name") as? JsonString)?.value
        val origin = (e.get("declaredOrigin") as? JsonString)?.value
        if (name == null || origin == null || !isSafeCount(e.get("lengthBytes"))) return HeadResult(null, "sourceDeclarations[$i] fields are malformed")
        sourceDeclarations.add(SourceDeclaration(name, origin, asLong(e.get("lengthBytes"))))
    }

    val enc = raw.get("encryption") as? JsonObject ?: return HeadResult(null, "encryption is not an object")
    mismatch(enc, listOf("capacity", "nextOffset"))?.let { return HeadResult(null, "encryption: $it") }
    if (!isSafeCount(enc.get("capacity")) || !isSafeCount(enc.get("nextOffset"))) return HeadResult(null, "encryption.capacity/nextOffset must be safe integers >= 0")
    val capacity = asLong(enc.get("capacity"))
    val nextOffset = asLong(enc.get("nextOffset"))
    if (nextOffset > capacity) return HeadResult(null, "encryption.nextOffset exceeds capacity")

    val auth = raw.get("authentication") as? JsonObject ?: return HeadResult(null, "authentication is not an object")
    mismatch(auth, listOf("profile", "tagBits", "capacityRecords", "nextSequence", "verifyAttemptLimit", "maxCiphertextBytes", "maxAuthLookahead"))?.let { return HeadResult(null, "authentication: $it") }
    if ((auth.get("profile") as? JsonString)?.value != "wc-one-time-v1") return HeadResult(null, "authentication.profile must be wc-one-time-v1")
    if ((auth.get("tagBits") as? JsonNumber)?.raw != "128") return HeadResult(null, "authentication.tagBits must be 128")
    if (!isSafeCount(auth.get("capacityRecords")) || !isSafeCount(auth.get("nextSequence"))) return HeadResult(null, "capacityRecords/nextSequence must be safe integers >= 0")
    val capacityRecords = asLong(auth.get("capacityRecords"))
    val nextSequence = asLong(auth.get("nextSequence"))
    if (nextSequence > capacityRecords) return HeadResult(null, "authentication.nextSequence exceeds capacityRecords")
    if (!isSafeCount(auth.get("verifyAttemptLimit")) || !isSafeCount(auth.get("maxAuthLookahead"))) return HeadResult(null, "verifyAttemptLimit/maxAuthLookahead must be safe integers >= 0")
    if ((auth.get("maxCiphertextBytes") as? JsonNumber)?.raw != MAX_CIPHERTEXT_BYTES.toString()) return HeadResult(null, "authentication.maxCiphertextBytes must equal $MAX_CIPHERTEXT_BYTES")

    val rp = raw.get("recordPolicy") as? JsonObject ?: return HeadResult(null, "recordPolicy is not an object")
    val policyKeys = if (rp.members.containsKey("record")) listOf("authenticated", "downgradeAllowed", "record") else listOf("authenticated", "downgradeAllowed")
    mismatch(rp, policyKeys)?.let { return HeadResult(null, "recordPolicy: $it") }
    if ((rp.get("authenticated") as? JsonString)?.value != "required" || (rp.get("downgradeAllowed") as? JsonBool)?.value != false) return HeadResult(null, "recordPolicy.authenticated must be required and downgradeAllowed false")
    val record: RecordSpec = if (!rp.members.containsKey("record")) {
        RecordSpec.Variable
    } else {
        val rr = rp.get("record") as? JsonObject ?: return HeadResult(null, "recordPolicy.record is not an object")
        when ((rr.get("kind") as? JsonString)?.value) {
            "variable" -> { mismatch(rr, listOf("kind"))?.let { return HeadResult(null, "recordPolicy.record: $it") }; RecordSpec.Variable }
            "fixed" -> {
                mismatch(rr, listOf("kind", "bytes"))?.let { return HeadResult(null, "recordPolicy.record: $it") }
                if (!isSafeCount(rr.get("bytes"))) return HeadResult(null, "recordPolicy.record.bytes malformed")
                val bytes = asLong(rr.get("bytes"))
                if (bytes < 32 || bytes > MAX_CIPHERTEXT_BYTES || bytes % 16 != 0L) return HeadResult(null, "recordPolicy.record.bytes must be a multiple of 16 with 32 <= F <= $MAX_CIPHERTEXT_BYTES")
                RecordSpec.Fixed(bytes.toInt())
            }
            else -> return HeadResult(null, "recordPolicy.record.kind must be variable or fixed")
        }
    }

    val rb = raw.get("rollback") as? JsonObject ?: return HeadResult(null, "rollback is not an object")
    mismatch(rb, listOf("witnessClass", "config"))?.let { return HeadResult(null, "rollback: $it") }
    val cfg = rb.get("config") as? JsonObject ?: return HeadResult(null, "rollback.config is not an object")
    // The frozen head carries EXACTLY the CLI's { witnessClass:"none", config:{} }.
    // A CLI store whose frozen witness class Android cannot honour is REFUSED,
    // never downgraded (docs/ANDROID-SECURITY.md §rollback).
    if ((rb.get("witnessClass") as? JsonString)?.value != "none") return HeadResult(null, "rollback.witnessClass must be \"none\": Android keeps its rollback witness outside the frozen store; a frozen witness class it cannot honour is refused, not downgraded")
    if (cfg.members.isNotEmpty()) return HeadResult(null, "rollback.config must be {} for witnessClass none")

    val ver = raw.get("verification") as? JsonObject ?: return HeadResult(null, "verification is not an object")
    mismatch(ver, listOf("failurePolicy", "failureCount", "clearedAtFailureCount", "perSequenceAttempts"))?.let { return HeadResult(null, "verification: $it") }
    val fp = ver.get("failurePolicy") as? JsonObject ?: return HeadResult(null, "verification.failurePolicy is not an object")
    mismatch(fp, listOf("kind", "threshold"))?.let { return HeadResult(null, "verification.failurePolicy: $it") }
    if ((fp.get("kind") as? JsonString)?.value != "freeze" || !isSafeCount(fp.get("threshold"))) return HeadResult(null, "verification.failurePolicy must be { kind:freeze, threshold:>=0 }")
    if (!isSafeCount(ver.get("failureCount")) || !isSafeCount(ver.get("clearedAtFailureCount"))) return HeadResult(null, "failureCount/clearedAtFailureCount must be safe integers >= 0")
    val psa = ver.get("perSequenceAttempts") as? JsonObject ?: return HeadResult(null, "verification.perSequenceAttempts is not an object")
    val perSeq = LinkedHashMap<String, Long>()
    for ((k, v) in psa.members) {
        if (!DECIMAL_KEY.matches(k) || !isSafeCount(v)) return HeadResult(null, "perSequenceAttempts[$k] must map a decimal sequence to a safe integer >= 0")
        perSeq[k] = asLong(v)
    }

    return HeadResult(
        HeadV2(
            pairId = pairId, direction = direction, sourceDeclarations = sourceDeclarations,
            capacity = capacity, nextOffset = nextOffset, capacityRecords = capacityRecords, nextSequence = nextSequence,
            verifyAttemptLimit = asLong(auth.get("verifyAttemptLimit")), maxAuthLookahead = asLong(auth.get("maxAuthLookahead")),
            record = record, failureThreshold = asLong(fp.get("threshold")),
            failureCount = asLong(ver.get("failureCount")), clearedAtFailureCount = asLong(ver.get("clearedAtFailureCount")),
            perSequenceAttempts = perSeq,
        ),
        null,
    )
}

/* ---- journal (§12.1) -------------------------------------------------------- */

private class JournalAggregates {
    var maxNextOffset = 0L
    var maxNextSequence = 0L
    val attemptCounts = HashMap<Long, Long>()
    var attemptsReserved = 0L
    var failureCount = 0L
    var lastClearedAt = 0L
}

private sealed class JournalRead {
    data class Ok(val agg: JournalAggregates) : JournalRead()
    data class Bad(val reason: String, val message: String) : JournalRead()
}

private fun readJournal(text: String): JournalRead {
    val lines = text.split("\n").toMutableList()
    if (lines.isNotEmpty() && lines.last() == "") lines.removeAt(lines.size - 1)
    val a = JournalAggregates()
    for ((index, line) in lines.withIndex()) {
        val rec = try { parseJson(line) } catch (_: Exception) { null }
        val obj = rec as? JsonObject
        val op = (obj?.get("op") as? JsonString)?.value
        if (obj == null || op == null || !applyJournal(a, obj, op)) {
            val isLast = index == lines.size - 1
            return JournalRead.Bad(
                "corrupt-journal",
                if (isLast) "$JOURNAL_FILE ends in a malformed line — the crash signature. Remove only that last line and retry. Bad line: $line"
                else "$JOURNAL_FILE holds a malformed record mid-file (line ${index + 1}); refusing. Bad line: $line",
            )
        }
    }
    return JournalRead.Ok(a)
}

private fun applyJournal(a: JournalAggregates, o: JsonObject, op: String): Boolean {
    fun n(k: String): Long? = (o.get(k) as? JsonNumber)?.raw?.toLongOrNull()?.takeIf { it in 0..MAX_SAFE_INTEGER }
    when (op) {
        "init" -> return (o.get("pairId") is JsonString) && Direction.fromWire((o.get("direction") as? JsonString)?.value ?: "") != null && n("capacity") != null && n("capacityRecords") != null
        "send" -> {
            val seq = n("sequence"); val so = n("startOffset"); val c = n("consumed"); val no = n("nextOffset"); val ns = n("nextSequence")
            if (seq == null || so == null || c == null || no == null || ns == null) return false
            a.maxNextOffset = maxOf(a.maxNextOffset, no); a.maxNextSequence = maxOf(a.maxNextSequence, ns); return true
        }
        "attempt" -> {
            val seq = n("sequence") ?: return false
            a.attemptCounts[seq] = (a.attemptCounts[seq] ?: 0) + 1; a.attemptsReserved += 1; return true
        }
        "auth-fail" -> {
            val seq = n("sequence"); val fc = n("failureCount")
            if (seq == null || fc == null) return false
            a.failureCount = maxOf(a.failureCount + 1, fc); return true
        }
        "open" -> {
            val seq = n("sequence"); val so = n("startOffset"); val c = n("consumed"); val sk = n("skipped"); val no = n("nextOffset"); val ns = n("nextSequence")
            if (seq == null || so == null || c == null || sk == null || no == null || ns == null) return false
            a.maxNextOffset = maxOf(a.maxNextOffset, no); a.maxNextSequence = maxOf(a.maxNextSequence, ns); return true
        }
        "retire" -> {
            val ts = n("toSequence"); val to = n("toOffset"); val reason = o.get("reason")
            if (ts == null || to == null || reason !is JsonString) return false
            a.maxNextOffset = maxOf(a.maxNextOffset, to); a.maxNextSequence = maxOf(a.maxNextSequence, ts); return true
        }
        "clear-freeze" -> {
            val at = n("atFailureCount") ?: return false
            a.lastClearedAt = at; return true
        }
        else -> return false
    }
}

/* ---- store lifecycle -------------------------------------------------------- */

fun secretLength(h: HeadV2): Long = h.capacity + AUTH_RECORD_BYTES * h.capacityRecords

/** Write a fresh direction store: secret.bin durable FIRST, then head.json, then init line (§12.4). */
fun initStore(fs: Fs, prefix: String, head: HeadV2, secret: ByteArray) {
    if (fs.exists(path(prefix, HEAD_FILE))) throw IllegalStateException("${path(prefix, HEAD_FILE)} already exists; a v2 store is written once")
    val expected = secretLength(head)
    require(secret.size.toLong() == expected) { "secret is ${secret.size} bytes but the header requires $expected" }
    fs.writeFileAtomic(path(prefix, SECRET_FILE), secret)
    fs.writeFileAtomic(path(prefix, HEAD_FILE), serializeHead(head))
    val init = StringBuilder("{\"op\":\"init\",\"pairId\":")
    jsonString(init, head.pairId); init.append(",\"direction\":"); jsonString(init, head.direction.wire)
    init.append(",\"capacity\":").append(head.capacity).append(",\"capacityRecords\":").append(head.capacityRecords)
    init.append(",\"at\":"); jsonString(init, nowIso()); init.append("}\n")
    fs.appendFile(path(prefix, JOURNAL_FILE), init.toString().toByteArray(Charsets.UTF_8))
}

/** Load one direction store and reconcile header against journal (§12.1). */
fun loadStore(fs: Fs, prefix: String): LoadResult {
    val headBytes = fs.readFile(path(prefix, HEAD_FILE))
    if (headBytes == null) {
        if (fs.exists(path(prefix, V1_PAD_FILE))) return LoadResult.Refusal("v1-store", "Refusing $prefix: this holds a v1 pad store ($V1_PAD_FILE). v2 tooling cannot operate on it; no conversion exists.")
        if (fs.exists(path(prefix, SECRET_FILE)) || fs.exists(path(prefix, JOURNAL_FILE))) return LoadResult.Refusal("corrupt-store", "$prefix holds $SECRET_FILE or $JOURNAL_FILE but no $HEAD_FILE — a gen that crashed. Do not use the surviving files.")
        return LoadResult.Refusal("no-store", "no $HEAD_FILE in $prefix")
    }
    val parsed = try { parseJson(String(headBytes, Charsets.UTF_8)) } catch (e: Exception) {
        return LoadResult.Refusal("corrupt-head", "Refusing $prefix: $HEAD_FILE does not parse as JSON (${e.message}).")
    }
    val hr = validateHead(parsed)
    if (hr.head == null) return LoadResult.Refusal("corrupt-head", "Refusing $prefix: $HEAD_FILE fails validation — ${hr.why}. A header is refused whole rather than partially trusted.")
    val head = hr.head

    val missing = buildList {
        if (!fs.exists(path(prefix, SECRET_FILE))) add(SECRET_FILE)
        if (!fs.exists(path(prefix, JOURNAL_FILE))) add(JOURNAL_FILE)
    }
    if (missing.isNotEmpty()) return LoadResult.Refusal("corrupt-store", "Refusing $prefix: $HEAD_FILE present but ${missing.joinToString(" and ")} missing.")

    val expected = secretLength(head)
    val actual = fs.size(path(prefix, SECRET_FILE))
    if (actual != expected) return LoadResult.Refusal("corrupt-secret-body", "Refusing $prefix: $SECRET_FILE is $actual bytes but the header requires exactly $expected (E + 32*N).")

    val journalBytes = fs.readFile(path(prefix, JOURNAL_FILE)) ?: ByteArray(0)
    val jr = readJournal(String(journalBytes, Charsets.UTF_8))
    val agg = when (jr) {
        is JournalRead.Bad -> return LoadResult.Refusal(jr.reason, jr.message)
        is JournalRead.Ok -> jr.agg
    }
    if (head.nextSequence < agg.maxNextSequence) return LoadResult.Refusal("regressed-below-mark", "Refusing $prefix: $HEAD_FILE nextSequence ${head.nextSequence} but $JOURNAL_FILE records retirement below ${agg.maxNextSequence}. This header is older than its own history.")
    if (head.nextOffset < agg.maxNextOffset) return LoadResult.Refusal("regressed-below-mark", "Refusing $prefix: $HEAD_FILE nextOffset ${head.nextOffset} but $JOURNAL_FILE burned through ${agg.maxNextOffset - 1}.")

    val attempts = HashMap<Long, Long>()
    for ((k, v) in head.perSequenceAttempts) attempts[k.toLong()] = v
    for ((seq, count) in agg.attemptCounts) attempts[seq] = maxOf(attempts[seq] ?: 0, count)

    val effective = EffectiveState(
        nextOffset = head.nextOffset, nextSequence = head.nextSequence, attempts = attempts,
        attemptsReserved = agg.attemptsReserved,
        failureCount = maxOf(head.failureCount, agg.failureCount),
        clearedAtFailureCount = maxOf(head.clearedAtFailureCount, agg.lastClearedAt),
    )
    return LoadResult.Ok(LoadedStore(head, effective))
}

/* ---- secret body reads ------------------------------------------------------ */

fun readEncryption(fs: Fs, prefix: String, head: HeadV2, offset: Long, length: Int): ByteArray {
    require(offset >= 0 && length >= 0 && offset + length <= head.capacity) { "readEncryption out of range" }
    return fs.readRange(path(prefix, SECRET_FILE), offset, length)
}

fun readAuthRecord(fs: Fs, prefix: String, head: HeadV2, sequence: Long): Pair<ByteArray, ByteArray> {
    require(sequence in 0 until head.capacityRecords) { "readAuthRecord out of range: $sequence" }
    val base = head.capacity + AUTH_RECORD_BYTES * sequence
    val record = fs.readRange(path(prefix, SECRET_FILE), base, AUTH_RECORD_BYTES)
    return record.copyOfRange(0, KEY_BYTES) to record.copyOfRange(KEY_BYTES, AUTH_RECORD_BYTES)
}

/* ---- durable transitions ---------------------------------------------------- */

/** OPEN O3: journal the attempt reservation, durably, and nothing else. */
fun reserveAttempt(fs: Fs, prefix: String, sequence: Long) {
    val sb = StringBuilder("{\"op\":\"attempt\",\"sequence\":").append(sequence).append(",\"at\":")
    jsonString(sb, nowIso()); sb.append("}\n")
    fs.appendFile(path(prefix, JOURNAL_FILE), sb.toString().toByteArray(Charsets.UTF_8))
}

/** OPEN O4 failure: append auth-fail FIRST, then rewrite the header. Returns the head it wrote. */
fun persistAuthFail(fs: Fs, prefix: String, head: HeadV2, sequence: Long): HeadV2 {
    val key = sequence.toString()
    val perSeq = LinkedHashMap(head.perSequenceAttempts)
    perSeq[key] = (perSeq[key] ?: 0) + 1
    val newHead = copyHead(head, failureCount = head.failureCount + 1, perSequenceAttempts = perSeq)
    val sb = StringBuilder("{\"op\":\"auth-fail\",\"sequence\":").append(sequence)
        .append(",\"failureCount\":").append(newHead.failureCount).append(",\"at\":")
    jsonString(sb, nowIso()); sb.append("}\n")
    fs.appendFile(path(prefix, JOURNAL_FILE), sb.toString().toByteArray(Charsets.UTF_8))
    fs.writeFileAtomic(path(prefix, HEAD_FILE), serializeHead(newHead))
    return newHead
}

/** SEND S2 / OPEN O5 / operator actions: rewrite the advanced header, THEN append the line. */
fun commitAdvance(fs: Fs, prefix: String, newHead: HeadV2, journalLine: String) {
    fs.writeFileAtomic(path(prefix, HEAD_FILE), serializeHead(newHead))
    fs.appendFile(path(prefix, JOURNAL_FILE), (journalLine + "\n").toByteArray(Charsets.UTF_8))
}

/** A copy of a head with selected fields overridden (heads are immutable). */
fun copyHead(
    h: HeadV2,
    nextOffset: Long = h.nextOffset,
    nextSequence: Long = h.nextSequence,
    failureCount: Long = h.failureCount,
    clearedAtFailureCount: Long = h.clearedAtFailureCount,
    perSequenceAttempts: LinkedHashMap<String, Long> = h.perSequenceAttempts,
): HeadV2 = HeadV2(
    pairId = h.pairId, direction = h.direction, sourceDeclarations = h.sourceDeclarations,
    capacity = h.capacity, nextOffset = nextOffset, capacityRecords = h.capacityRecords, nextSequence = nextSequence,
    verifyAttemptLimit = h.verifyAttemptLimit, maxAuthLookahead = h.maxAuthLookahead, record = h.record,
    failureThreshold = h.failureThreshold, failureCount = failureCount, clearedAtFailureCount = clearedAtFailureCount,
    perSequenceAttempts = perSequenceAttempts,
)
