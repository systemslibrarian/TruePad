package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.AUTH_RECORD_BYTES
import dev.systemslibrarian.truepad.core.CanonicalFields
import dev.systemslibrarian.truepad.core.DeploymentAssessment
import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.core.EnvelopeDecode
import dev.systemslibrarian.truepad.core.EnvelopeV2
import dev.systemslibrarian.truepad.core.FREEZE_THRESHOLD_DEFAULT
import dev.systemslibrarian.truepad.core.MAX_AUTH_LOOKAHEAD_DEFAULT
import dev.systemslibrarian.truepad.core.MAX_CIPHERTEXT_BYTES
import dev.systemslibrarian.truepad.core.SourceClass
import dev.systemslibrarian.truepad.core.VERIFY_ATTEMPT_LIMIT_DEFAULT
import dev.systemslibrarian.truepad.core.assessDeployment
import dev.systemslibrarian.truepad.core.bytesToHex
import dev.systemslibrarian.truepad.core.buildFrame
import dev.systemslibrarian.truepad.core.combineSources
import dev.systemslibrarian.truepad.core.decodeEnvelopeTransport2
import dev.systemslibrarian.truepad.core.encodeEnvelope2
import dev.systemslibrarian.truepad.core.frameCapacity
import dev.systemslibrarian.truepad.core.hexToBytes
import dev.systemslibrarian.truepad.core.parseFrame
import dev.systemslibrarian.truepad.core.partition
import dev.systemslibrarian.truepad.core.requiredSourceLength
import dev.systemslibrarian.truepad.core.tagsEqual
import dev.systemslibrarian.truepad.core.wcTag
import java.security.SecureRandom
import java.time.Instant

/*
 * The §12 transaction engine — the Kotlin twin of src/browser/engine/verbs.ts,
 * minus the Sealed Pad Transfer verbs (not implemented on Android).
 *
 * Every verb runs under the pair's exclusive lock, holds the frozen gate order,
 * and obeys the two orderings that define TruePad's safety:
 *
 *   BURN-BEFORE-OUTPUT  the header and journal advance durably (S2) before the
 *                       envelope exists outside the call (S3).
 *   PERSIST-BEFORE-USE  an open reserves its verification attempt durably (O3)
 *                       before the tag is checked (O4), and retires both
 *                       namespaces durably (O5) before the plaintext is
 *                       released (O6).
 *
 * If a durable write fails at any of those points, the operation errors and its
 * OUTPUT IS WITHHELD. That is the whole design:
 *
 *     LOSS IS ACCEPTABLE. REUSE IS NOT.
 *
 * This engine is pure Kotlin over the Fs abstraction. It runs unchanged on the
 * JVM (fast tests, fault injection) and on Android/ART over the same java.nio
 * NioFs, so the security state machine that ships is the one the tests exercise.
 */

/* ---- paths ------------------------------------------------------------------ */

fun storeDir(pairId: String, direction: Direction): String = "$pairId/${SUBDIR.getValue(direction)}"
private fun filePath(prefix: String, name: String): String = "$prefix/$name"

private fun directionFor(role: Party2, op: Op): Direction = when (op) {
    Op.BURN -> if (role == Party2.A) Direction.A_TO_B else Direction.B_TO_A
    Op.OPEN -> if (role == Party2.A) Direction.B_TO_A else Direction.A_TO_B
}

enum class Party2 { A, B }
private enum class Op { BURN, OPEN }

/** The verbatim §7 verdict — scoped, never promoted to a stronger claim. */
const val GEN_VERDICT: String =
    "Uniform if at least one declared source was uniform and independent of the others."

private const val V1_PAD_FILE = "pad.json"

private val BUNDLE_FILES: List<String> = listOf(
    "${SUBDIR.getValue(Direction.A_TO_B)}/$HEAD_FILE",
    "${SUBDIR.getValue(Direction.A_TO_B)}/$SECRET_FILE",
    "${SUBDIR.getValue(Direction.A_TO_B)}/$JOURNAL_FILE",
    "${SUBDIR.getValue(Direction.B_TO_A)}/$HEAD_FILE",
    "${SUBDIR.getValue(Direction.B_TO_A)}/$SECRET_FILE",
    "${SUBDIR.getValue(Direction.B_TO_A)}/$JOURNAL_FILE",
)

/* ---- non-secret results ----------------------------------------------------- */

class SourceInput(val name: String, val declaredOrigin: String, val bytes: ByteArray)

class DirectionMeters(
    val direction: Direction,
    val capacity: Long,
    val nextOffset: Long,
    val remainingBytes: Long,
    val capacityRecords: Long,
    val nextSequence: Long,
    val remainingRecords: Long,
    val contestedLive: Int,
    val record: RecordSpec,
    val failureCount: Long,
    val frozen: Boolean,
    val maxRemainingSends: Long,
    val limitedBy: String,
    val witnessKind: WitnessKind,
    val witnessState: WitnessState,
    // The DERIVED deployment classification for this direction (§ shannon), and
    // the source class it was built from. NOT a stored verdict: recomputed from
    // live facts on every summary, never persisted. Always INSUFFICIENT or NOT
    // ELIGIBLE on Android — an Android pad is never CONDITIONALLY ELIGIBLE.
    val deployment: DeploymentAssessment,
    val sourceClass: SourceClass,
)

class PairSummary(
    val pairId: String,
    val label: String,
    val createdAt: String,
    val destroyed: Boolean,
    val origin: PairOrigin,
    val meters: Map<Direction, DirectionMeters>,
)

/**
 * One row of the pad list. A DESTROYED pair still has a row — its tombstone is
 * permanent and every verb refuses it — but it has no meters, because there is
 * no live store left to meter. Nullable rather than zero-filled: a pad with no
 * material left and a pad that no longer exists are different facts, and
 * fabricating zeros for the second would let the UI render it as the first.
 */
class PairListEntry(
    val pairId: String,
    val label: String,
    val createdAt: String,
    val destroyed: Boolean,
    val summary: PairSummary?,
)

class GenResult(val pair: PairSummary, val verdict: String, val requiredSourceLength: Long)
class BurnResult(val envelope: String, val encryptionBytes: Int, val authRecords: Int, val meters: PairSummary)
class OpenResult(val plaintext: ByteArray, val skippedBytes: Long, val skippedRecords: Long, val meters: PairSummary)
class DestroyResult(val alreadyDestroyed: Boolean, val limitation: String)
class ExportResult(val container: ByteArray, val fileCount: Int)

/* ---- the engine ------------------------------------------------------------- */

/**
 * @param fs the pad store: the pair directories and their FORMAT-V2 files.
 * @param witnessFs where the rollback witness journal lives. It DEFAULTS to [fs],
 *   which is honest but weak — a witness in the same tree as the store is
 *   restored alongside it and then knows nothing (the §15.2 caveat). A witness
 *   only detects a rollback if it is in a DIFFERENT failure domain from the
 *   thing being rolled back, so the Android app binds this to
 *   `Context.getNoBackupFilesDir()` while the store lives under
 *   `Context.getFilesDir()`. Android Auto Backup and device-to-device transfer
 *   carry the store and NOT the no-backup directory, so a restored store meets a
 *   witness that remembers the true high-water and refuses `witness-regressed`
 *   before anything is consumed. What this does NOT survive is uninstall or
 *   "Clear storage", which take both — and that is loss, not reuse, which is the
 *   trade this product always makes. See docs/ANDROID-SECURITY.md.
 * @param clock injectable so tests are deterministic; production passes the real clock.
 * @param pairIdSource 16 random bytes for a new pairId. This is the ONLY place the
 *   engine draws randomness, and a pairId is public metadata — never pad material.
 *   Pad material comes exclusively from the operator's declared sources (§7);
 *   the engine never manufactures a pad byte.
 */
class Engine(
    private val fs: Fs,
    private val witnessFs: Fs = fs,
    private val clock: () -> Instant = { Instant.now() },
    private val pairIdSource: () -> ByteArray = { ByteArray(16).also { SECURE_RANDOM.nextBytes(it) } },
) {
    private companion object {
        val SECURE_RANDOM = SecureRandom()
    }

    private fun now(): String = isoNow(clock())

    /* ---- pair gates & metadata ---------------------------------------------- */

    private fun requireNotDestroyed(pairId: String) {
        if (fs.exists(tombstonePath(pairId))) {
            throw EngineRefused(
                "pair-destroyed",
                "$pairId carries a durable $TOMBSTONE_FILE: destruction of this pair was initiated (§17), so it is " +
                    "permanently unusable. Its secret material may be partially overwritten or already absent, and " +
                    "there is no path back to an active state. Nothing was touched.",
            )
        }
    }

    private fun requireImportComplete(pairId: String) {
        if (fs.exists(importMarkerPath(pairId))) {
            throw EngineRefused(
                "import-incomplete",
                "$pairId has an unfinished courier import ($IMPORT_MARKER_FILE is present): the import did not " +
                    "commit, so the pair is not active. Re-run the import of the same bundle to complete it. " +
                    "Nothing was touched.",
            )
        }
    }

    private fun refuseIfV1(pairId: String) {
        for (d in Direction.entries) {
            if (fs.exists(filePath(storeDir(pairId, d), V1_PAD_FILE))) {
                throw EngineRefused(
                    "v1-store",
                    "${storeDir(pairId, d)} holds a v1 store ($V1_PAD_FILE). v2 tooling refuses every v1 store and " +
                        "no conversion exists (§9). Generate a fresh v2 pair for v2.",
                )
            }
        }
    }

    private fun requirePair(pairId: String) {
        refuseIfV1(pairId)
        val abHead = fs.exists(filePath(storeDir(pairId, Direction.A_TO_B), HEAD_FILE))
        val baHead = fs.exists(filePath(storeDir(pairId, Direction.B_TO_A), HEAD_FILE))
        if (!abHead && !baHead) {
            throw EngineRefused("no-store", "$pairId holds no v2 pad pair (no a-to-b/ or b-to-a/ $HEAD_FILE); run gen first.")
        }
        if (!abHead || !baHead) {
            val missing = if (!abHead) SUBDIR.getValue(Direction.A_TO_B) else SUBDIR.getValue(Direction.B_TO_A)
            throw EngineRefused(
                "half-pair",
                "$pairId is a half-pair: $missing/ is missing. gen did not complete. Do not use the surviving half.",
            )
        }
    }

    private fun loadHalf(pairId: String, direction: Direction): LoadedStore =
        when (val r = loadStore(fs, storeDir(pairId, direction))) {
            is LoadResult.Ok -> r.store
            is LoadResult.Refusal -> throw EngineRefused(r.reason, r.message)
        }

    /**
     * Hold the gates in the frozen order: the tombstone (§17) is checked BEFORE
     * anything else, then v1/wholeness, then both halves load. Both halves are
     * loaded even for single-direction verbs because the freeze is pair-wide.
     */
    private fun loadPair(pairId: String): Map<Direction, LoadedStore> {
        requireNotDestroyed(pairId)
        requireImportComplete(pairId)
        requirePair(pairId)
        return mapOf(
            Direction.A_TO_B to loadHalf(pairId, Direction.A_TO_B),
            Direction.B_TO_A to loadHalf(pairId, Direction.B_TO_A),
        )
    }

    private fun frozenHalf(s: LoadedStore): Boolean =
        s.effective.failureCount - s.effective.clearedAtFailureCount >= s.head.failureThreshold

    private fun requireNotFrozen(pair: Map<Direction, LoadedStore>) {
        val frozen = Direction.entries.filter { frozenHalf(pair.getValue(it)) }
        if (frozen.isNotEmpty()) {
            throw EngineRefused(
                "frozen",
                "The pair is frozen: ${frozen.joinToString(" and ") { it.wire }} reached the failure threshold. The " +
                    "freeze is the reversible operator brake (§8.4): it burns nothing and resets nothing. Run " +
                    "clear-freeze to resume. Nothing was burned.",
            )
        }
    }

    private fun highWaters(s: LoadedStore) =
        StoreHighWaters(s.effective.nextOffset, s.effective.nextSequence, s.effective.attemptsReserved)

    /**
     * §15.3 PREFLIGHT for one direction's store, returning the witness so the
     * caller can advance it after the durable commit. The witness KIND comes
     * from the Android-only pair.json, never the frozen head.
     */
    private fun witnessPreflight(store: LoadedStore, kind: WitnessKind): Witness {
        val witness = witnessFor(witnessFs, kind)
        when (val pf = witness.preflight(store.head.pairId, store.head.direction, highWaters(store))) {
            is WitnessPreflight.Refusal -> throw EngineRefused(pf.reason, pf.message)
            is WitnessPreflight.Ok -> Unit
        }
        return witness
    }

    private fun witnessKindFor(pairId: String): WitnessKind = readPairMeta(fs, pairId).witness

    /* ---- meters & summaries -------------------------------------------------- */

    private fun directionMeters(store: LoadedStore, kind: WitnessKind, origin: PairOrigin): DirectionMeters {
        val h = store.head
        val e = store.effective
        val remainingBytes = h.capacity - e.nextOffset
        val remainingRecords = h.capacityRecords - e.nextSequence
        var contestedLive = 0
        for ((sequence, count) in e.attempts) {
            if (sequence >= e.nextSequence && count >= h.verifyAttemptLimit) contestedLive += 1
        }
        val ceilRecordsForBytes = (remainingBytes + MAX_CIPHERTEXT_BYTES - 1) / MAX_CIPHERTEXT_BYTES
        val limitedBy = if (remainingRecords <= ceilRecordsForBytes) "AUTHENTICATION" else "ENCRYPTION"
        val state = witnessFor(witnessFs, kind).report(h.pairId, h.direction, highWaters(store))
        // Derive — never store — this direction's deployment classification from
        // the live facts assembled under this same lock (source declarations,
        // provenance, witness kind/state). The evaluator is core.assessDeployment,
        // the ONE authority; the Android facts can never reach the strongest verdict.
        val facts = deploymentFactsFor(h.sourceDeclarations, origin, kind, state)
        return DirectionMeters(
            direction = h.direction,
            capacity = h.capacity, nextOffset = e.nextOffset, remainingBytes = remainingBytes,
            capacityRecords = h.capacityRecords, nextSequence = e.nextSequence, remainingRecords = remainingRecords,
            contestedLive = contestedLive, record = h.record,
            failureCount = e.failureCount, frozen = frozenHalf(store),
            maxRemainingSends = remainingRecords, limitedBy = limitedBy,
            witnessKind = kind, witnessState = state,
            deployment = assessDeployment(facts), sourceClass = facts.source,
        )
    }

    /** A live pair's non-secret summary. loadPair enforces the gates, so a pair
     *  reaching here is not destroyed — destroyed=false always holds. */
    private fun buildSummary(pairId: String): PairSummary {
        val pair = loadPair(pairId)
        val meta = readPairMeta(fs, pairId)
        return PairSummary(
            pairId = pairId, label = meta.label, createdAt = meta.createdAt, destroyed = false,
            origin = meta.origin,
            meters = mapOf(
                Direction.A_TO_B to directionMeters(pair.getValue(Direction.A_TO_B), meta.witness, meta.origin),
                Direction.B_TO_A to directionMeters(pair.getValue(Direction.B_TO_A), meta.witness, meta.origin),
            ),
        )
    }

    /* ---- gen (multi-source generation, §7) ----------------------------------- */

    fun gen(
        label: String,
        sources: List<SourceInput>,
        encryptionBytes: Long,
        authRecords: Long,
        recordBytes: Int? = null,
        witnessKind: WitnessKind = WitnessKind.LOCAL,
        verifyAttemptLimit: Long = VERIFY_ATTEMPT_LIMIT_DEFAULT.toLong(),
        maxAuthLookahead: Long = MAX_AUTH_LOOKAHEAD_DEFAULT.toLong(),
        freezeThreshold: Long = FREEZE_THRESHOLD_DEFAULT.toLong(),
    ): GenResult {
        require(encryptionBytes > 0) { "encryptionBytes must be a positive integer" }
        require(authRecords > 0) { "authRecords must be a positive integer" }
        require(verifyAttemptLimit > 0) { "verifyAttemptLimit must be a positive integer" }
        require(maxAuthLookahead > 0) { "maxAuthLookahead must be a positive integer" }
        require(freezeThreshold > 0) { "freezeThreshold must be a positive integer" }
        val record: RecordSpec = if (recordBytes == null) {
            RecordSpec.Variable
        } else {
            require(recordBytes >= 32 && recordBytes <= MAX_CIPHERTEXT_BYTES && recordBytes % 16 == 0) {
                "recordBytes must be a multiple of 16 with 32 <= F <= $MAX_CIPHERTEXT_BYTES (§16); found $recordBytes"
            }
            RecordSpec.Fixed(recordBytes)
        }
        require(sources.isNotEmpty()) { "gen needs at least one source of declared-uniform material" }

        val required = requiredSourceLength(encryptionBytes, authRecords)
        val short = sources.filter { it.bytes.size < required }
        if (short.isNotEmpty()) {
            throw EngineRefused(
                "source-too-short",
                "every declared source must supply the complete $required bytes (2·(E + 32·N) for E=$encryptionBytes, " +
                    "N=$authRecords); too short: ${short.joinToString(", ") { it.name }}. Nothing was written.",
            )
        }
        // NO content-dependent deduplication, and NO inspection of the combined
        // bytes by value. If at least one declared source is uniform and
        // independent of the others, the XOR is exactly uniform over the FULL
        // space — every combined value, all-zeros included, is a legitimate
        // draw. Refusing a source because its bytes equal another's would
        // condition the accepted distribution, so it is not done.
        val declarations = sources.map {
            SourceDeclaration(
                it.name,
                it.declaredOrigin.ifEmpty { "declared by operator at gen; not verified by this tool" },
                it.bytes.size.toLong(),
            )
        }

        val combined = combineSources(sources.map { it.bytes }, required.toInt())
        val slices = try {
            partition(combined, encryptionBytes.toInt(), authRecords.toInt())
        } finally {
            // partition() returns COPIES, never views of `combined` (§7), so the
            // combined buffer is dead the moment it returns — or throws.
            // In-memory hygiene only; no erasure claim.
            combined.fill(0)
        }

        val pairIdBytes = pairIdSource()
        require(pairIdBytes.size == 16) { "a pairId is exactly 16 bytes" }
        val pairId = bytesToHex(pairIdBytes)

        fun headFor(direction: Direction) = HeadV2(
            pairId = pairId, direction = direction, sourceDeclarations = declarations,
            capacity = encryptionBytes, nextOffset = 0,
            capacityRecords = authRecords, nextSequence = 0,
            verifyAttemptLimit = verifyAttemptLimit, maxAuthLookahead = maxAuthLookahead,
            record = record, failureThreshold = freezeThreshold,
            failureCount = 0, clearedAtFailureCount = 0, perSequenceAttempts = LinkedHashMap(),
        )

        fun secretFor(enc: ByteArray, auth: ByteArray): ByteArray {
            val secret = ByteArray(enc.size + auth.size)
            System.arraycopy(enc, 0, secret, 0, enc.size)
            System.arraycopy(auth, 0, secret, enc.size, auth.size)
            return secret
        }
        val secretAB = secretFor(slices.abEncryption, slices.abAuthentication)
        val secretBA = secretFor(slices.baEncryption, slices.baAuthentication)
        val createdAt = now()

        try {
            fs.withLock(pairId) {
                // §12.4: per half, secret.bin is durable before head.json and the init line.
                initStore(fs, storeDir(pairId, Direction.A_TO_B), headFor(Direction.A_TO_B), secretAB, createdAt)
                initStore(fs, storeDir(pairId, Direction.B_TO_A), headFor(Direction.B_TO_A), secretBA, createdAt)
                // Provision the Android-local witness (the explicit event), THEN
                // commit the pair with pair.json LAST: a crash before pair.json
                // leaves a fresh store with no committed witness (android-none,
                // nothing advanced yet) rather than a provisioned-but-unusable one.
                witnessFor(witnessFs, witnessKind).bootstrap(pairId)
                writePairMeta(fs, PairMeta(pairId, label, createdAt, witnessKind, PairOrigin.GENERATED_HERE))
            }
        } finally {
            // AFTER the provisioning has settled — never before it, so nothing is
            // zeroed while initStore still needs the bytes. In-memory hygiene
            // only; no erasure claim.
            secretAB.fill(0); secretBA.fill(0)
            slices.abEncryption.fill(0); slices.abAuthentication.fill(0)
            slices.baEncryption.fill(0); slices.baAuthentication.fill(0)
        }
        return GenResult(buildSummary(pairId), GEN_VERDICT, required)
    }

    /* ---- status --------------------------------------------------------------- */

    fun status(pairId: String): PairSummary = fs.withLock(pairId) { buildSummary(pairId) }

    /**
     * The pad list, as the released engine's `list-pairs` op returns it.
     *
     * The Kotlin port previously exposed only the pairIds, which left an app
     * with no way to render a list: a label needs pair.json, and asking
     * [status] for a destroyed pair throws `pair-destroyed`. Callers worked
     * around that by catching an exception per row, which turns an ordinary
     * listing into exception control flow and makes "destroyed" and "corrupt"
     * indistinguishable.
     *
     * A pair that cannot be summarised at all — mid-write, corrupt, half-built —
     * is SKIPPED rather than surfaced as a broken row, matching the release. It
     * is still on disk and every verb still refuses it; it simply is not
     * something to put in a list.
     */
    fun listSummaries(): List<PairListEntry> = listPairs().mapNotNull { pairId ->
        try {
            if (fs.exists(tombstonePath(pairId))) {
                val meta = readPairMeta(fs, pairId)
                PairListEntry(pairId, meta.label, meta.createdAt, destroyed = true, summary = null)
            } else {
                val summary = status(pairId)
                PairListEntry(pairId, summary.label, summary.createdAt, destroyed = false, summary = summary)
            }
        } catch (_: Exception) {
            null
        }
    }

    fun listPairs(): List<String> = fs.list("").filter { name ->
        // A pair directory is named by its pairId, so anything that is not one
        // is not a pair — the staging root, the lock directory, a witness log
        // left by an older layout, or whatever else shares the root. Matching
        // the name is what the released list-pairs does, and it is stricter than
        // enumerating the known non-pair names one at a time.
        HEX_32_RE.matches(name) &&
            (
                fs.exists(filePath(storeDir(name, Direction.A_TO_B), HEAD_FILE)) ||
                    fs.exists(filePath(storeDir(name, Direction.B_TO_A), HEAD_FILE)) ||
                    fs.exists(tombstonePath(name))
                )
    }.sorted()

    /* ---- burn (SEND, §12.2) --------------------------------------------------- */

    fun burn(pairId: String, role: Party2, plaintext: ByteArray): BurnResult = fs.withLock(pairId) {
        val pair = loadPair(pairId)
        val kind = witnessKindFor(pairId)
        // S0 — checks, all free.
        requireNotFrozen(pair)
        val direction = directionFor(role, Op.BURN)
        val store = pair.getValue(direction)
        val head = store.head
        val effective = store.effective
        val prefix = storeDir(pairId, direction)
        val witness = witnessPreflight(store, kind)

        val payload: ByteArray = when (val r = head.record) {
            is RecordSpec.Fixed -> {
                val cap = frameCapacity(r.bytes)
                if (plaintext.size > cap) {
                    throw EngineRefused(
                        "record-size-mismatch",
                        "this store fixes every record at ${r.bytes} ciphertext bytes, so a message holds at most " +
                            "$cap bytes (F − 4); this one is ${plaintext.size}. Nothing was burned.",
                    )
                }
                buildFrame(plaintext, r.bytes)
            }
            is RecordSpec.Variable -> plaintext
        }
        val c = payload.size
        if (c > MAX_CIPHERTEXT_BYTES) {
            throw EngineRefused(
                "oversize-ciphertext",
                "this message is $c bytes; MAX_CIPHERTEXT_BYTES is $MAX_CIPHERTEXT_BYTES. Split it into multiple " +
                    "records. Nothing was burned.",
            )
        }
        if (effective.nextSequence >= head.capacityRecords) {
            throw EngineRefused(
                "auth-exhausted",
                "authentication records are exhausted (${head.capacityRecords} of ${head.capacityRecords} used). " +
                    "Auth exhaustion permanently kills sending on this direction. Nothing was burned.",
            )
        }
        if (effective.nextOffset + c > head.capacity) {
            throw EngineRefused(
                "encryption-exhausted",
                "this message needs $c encryption bytes but only ${head.capacity - effective.nextOffset} remain. " +
                    "A one-time pad cannot borrow, wrap, or reuse. Nothing was burned.",
            )
        }

        // S1 — staged in memory. Nothing on disk changes.
        val sequence = effective.nextSequence
        val startOffset = effective.nextOffset
        val (key, mask) = readAuthRecord(fs, prefix, head, sequence)
        val pad = readEncryption(fs, prefix, head, startOffset, c)
        val ciphertext = ByteArray(c)
        for (i in 0 until c) ciphertext[i] = (payload[i].toInt() xor pad[i].toInt()).toByte()
        val pairIdBytes = hexToBytes(head.pairId)
        if (pairIdBytes == null || pairIdBytes.size != 16) {
            throw EngineRefused("corrupt-head", "pairId in $HEAD_FILE is not 32 lowercase hex characters: ${head.pairId}")
        }
        val tag = wcTag(key, mask, CanonicalFields(pairIdBytes, direction, sequence, startOffset, ciphertext))
        val envelope = EnvelopeV2(head.pairId, direction, sequence, startOffset, c.toLong(), ciphertext, tag)

        // S2 — durable commit of BOTH namespaces. secret.bin is untouched (§1.2).
        val newHead = copyHead(head, nextOffset = startOffset + c, nextSequence = sequence + 1)
        val line = StringBuilder("{\"op\":\"send\",\"sequence\":").append(sequence)
            .append(",\"startOffset\":").append(startOffset)
            .append(",\"consumed\":").append(c)
            .append(",\"nextOffset\":").append(startOffset + c)
            .append(",\"nextSequence\":").append(sequence + 1)
            .append(",\"at\":")
        jsonString(line, now()); line.append('}')
        commitAdvance(fs, prefix, newHead, line.toString())

        // §15.3 advance — after the durable commit, before the emit. burn
        // reserves no verification attempt, so attemptsReserved is unchanged.
        witness.advance(
            pairId, direction,
            WitnessCounters(startOffset + c, sequence + 1, effective.attemptsReserved),
        )

        // S3 — only now does the envelope exist outside this call.
        val wire = encodeEnvelope2(envelope)
        // In-memory hygiene only; no erasure claim. `payload` aliases `plaintext`
        // on a variable-record store, so zero it before the caller's buffer.
        payload.fill(0); plaintext.fill(0); pad.fill(0); key.fill(0); mask.fill(0)

        BurnResult(wire, c, 1, buildSummary(pairId))
    }

    /* ---- open (OPEN, §12.3) ---------------------------------------------------- */

    fun open(pairId: String, role: Party2, envelopeText: String): OpenResult = fs.withLock(pairId) {
        val pair = loadPair(pairId)
        val kind = witnessKindFor(pairId)
        val direction = directionFor(role, Op.OPEN)
        val store = pair.getValue(direction)
        val head = store.head
        val effective = store.effective
        val prefix = storeDir(pairId, direction)

        // O0 — structural, free, before any secret is touched. Either spelling of
        // the SAME envelope is accepted: canonical §6.2 JSON, or the TP2 compact
        // transport, which decodes to an EnvelopeV2 and then goes through exactly
        // this pipeline. A malformed TP2 input is refused AS compact and never
        // re-tried as JSON.
        val envelope = when (val d = decodeEnvelopeTransport2(envelopeText)) {
            is EnvelopeDecode.Refusal -> throw EngineRefused(d.reason, d.message)
            is EnvelopeDecode.Ok -> d.envelope
        }
        if (envelope.pairId != head.pairId) {
            throw EngineRefused(
                "wrong-pair",
                "this envelope is addressed to pair ${envelope.pairId}, but this pair is ${head.pairId}. Nothing was burned.",
            )
        }
        if (envelope.direction != direction) {
            throw EngineRefused(
                "wrong-direction",
                "this envelope carries ${envelope.direction.wire} traffic; as $role you open ${direction.wire}. " +
                    "Nothing was burned.",
            )
        }
        val sequence = envelope.sequence
        val startOffset = envelope.startOffset
        val c = envelope.ciphertextLength.toInt()

        val recordSpec = head.record
        if (recordSpec is RecordSpec.Fixed && c != recordSpec.bytes) {
            throw EngineRefused(
                "record-size-mismatch",
                "this store fixes every record at ${recordSpec.bytes} ciphertext bytes, but this envelope declares " +
                    "ciphertextLength $c. It cannot be one of this store's records. Nothing was burned.",
            )
        }

        // O1 — window, free.
        if (sequence < effective.nextSequence) {
            throw EngineRefused(
                "sequence-retired",
                "sequence $sequence is below this store's auth high-water ${effective.nextSequence}: a replayed, " +
                    "late, or already-opened record. Its authentication material is retired in this copy, never " +
                    "again usable. Nothing was burned.",
            )
        }
        if (sequence >= head.capacityRecords) {
            throw EngineRefused(
                "sequence-malformed",
                "sequence $sequence does not exist in this store (capacityRecords ${head.capacityRecords}): " +
                    "malformed. Nothing was burned.",
            )
        }
        if (sequence >= effective.nextSequence + head.maxAuthLookahead) {
            throw EngineRefused(
                "sequence-out-of-window",
                "sequence $sequence is beyond the finite lookahead window [${effective.nextSequence}, " +
                    "${effective.nextSequence + head.maxAuthLookahead}). More than ${head.maxAuthLookahead} " +
                    "consecutive lost records need explicit operator recovery (retire); the channel does not heal " +
                    "silently. Nothing was burned.",
            )
        }
        if (startOffset < effective.nextOffset) {
            throw EngineRefused(
                "offset-retired",
                "startOffset $startOffset is below this store's encryption high-water ${effective.nextOffset}: a " +
                    "legitimate sender's offsets never run behind an accepting receiver. Nothing was burned.",
            )
        }
        if (startOffset + c > head.capacity) {
            throw EngineRefused(
                "encryption-exhausted",
                "this record's window [$startOffset, ${startOffset + c}) runs past the encryption capacity " +
                    "${head.capacity}. Nothing was burned.",
            )
        }

        // O2 — state gates, free.
        requireNotFrozen(pair)
        val witness = witnessPreflight(store, kind)
        val attempts = effective.attempts[sequence] ?: 0L
        if (attempts >= head.verifyAttemptLimit) {
            throw EngineRefused(
                "sequence-contested",
                "sequence $sequence has used all ${head.verifyAttemptLimit} verification attempts and is permanently " +
                    "contested: never verifiable again under its key and mask. Recovery is an explicit operator " +
                    "retire. Nothing was burned.",
            )
        }

        // O3 — the reservation. Durable BEFORE any verification.
        reserveAttempt(fs, prefix, sequence, now())
        val attemptsNow = attempts + 1

        // §15.3 advance with the new attempt total, still BEFORE the verification —
        // so a later restore that rolls the attempt budget back is refused
        // witness-regressed at preflight.
        witness.advance(
            pairId, direction,
            WitnessCounters(effective.nextOffset, effective.nextSequence, effective.attemptsReserved + 1),
        )

        // O4 — verify over canonical bytes.
        val (key, mask) = readAuthRecord(fs, prefix, head, sequence)
        val pairIdBytes = hexToBytes(head.pairId)
        if (pairIdBytes == null || pairIdBytes.size != 16) {
            throw EngineRefused("corrupt-head", "pairId in $HEAD_FILE is not 32 lowercase hex characters: ${head.pairId}")
        }
        val expected = wcTag(key, mask, CanonicalFields(pairIdBytes, direction, sequence, startOffset, envelope.ciphertext))
        if (!tagsEqual(expected, envelope.tag)) {
            // FAIL: burn neither namespace; persist the failure durably, THEN refuse.
            val baseAttempts = LinkedHashMap(head.perSequenceAttempts)
            if (attempts > 0) baseAttempts[sequence.toString()] = attempts
            val failHead = copyHead(head, failureCount = effective.failureCount, perSequenceAttempts = baseAttempts)
            persistAuthFail(fs, prefix, failHead, sequence, now())
            key.fill(0); mask.fill(0)
            val remaining = head.verifyAttemptLimit - attemptsNow
            throw EngineRefused(
                "auth-failed",
                "the tag does not verify: a tampered, corrupted, or forged record. No pad material was consumed. " +
                    "Sequence $sequence has $remaining verification attempt${if (remaining == 1L) "" else "s"} left " +
                    "before it is permanently contested. This refusal cost one durable attempt reservation — the " +
                    "stated availability price of a finite forgery bound (§8.4).",
            )
        }

        // PASS: plaintext in memory, then O5.
        val pad = readEncryption(fs, prefix, head, startOffset, c)
        val plaintext = ByteArray(c)
        for (i in 0 until c) plaintext[i] = (envelope.ciphertext[i].toInt() xor pad[i].toInt()).toByte()
        val skippedBytes = startOffset - effective.nextOffset
        val skippedRecords = sequence - effective.nextSequence

        // O5 — durably retire every position <= N in BOTH namespaces, including
        // the skipped material, which is destroyed unused.
        val prunedAttempts = LinkedHashMap<String, Long>()
        for ((k, v) in head.perSequenceAttempts) if (k.toLong() > sequence) prunedAttempts[k] = v
        val newHead = copyHead(
            head,
            nextOffset = startOffset + c, nextSequence = sequence + 1, perSequenceAttempts = prunedAttempts,
        )
        val line = StringBuilder("{\"op\":\"open\",\"sequence\":").append(sequence)
            .append(",\"startOffset\":").append(startOffset)
            .append(",\"consumed\":").append(c)
            .append(",\"skipped\":").append(skippedBytes)
            .append(",\"nextOffset\":").append(startOffset + c)
            .append(",\"nextSequence\":").append(sequence + 1)
            .append(",\"at\":")
        jsonString(line, now()); line.append('}')
        commitAdvance(fs, prefix, newHead, line.toString())

        // §15.3 advance — after the durable commit (O5), before the release (O6).
        witness.advance(
            pairId, direction,
            WitnessCounters(startOffset + c, sequence + 1, effective.attemptsReserved + 1),
        )

        // §16.2: on a fixed store the decrypted bytes are the frame; the length
        // prefix selects the released plaintext. A prefix past F − 4 cannot come
        // from a conforming sender — but if it occurs the material is already
        // retired (O5), so this is an error (nothing released), not a refusal.
        var released = plaintext
        if (recordSpec is RecordSpec.Fixed) {
            released = parseFrame(plaintext) ?: throw IllegalStateException(
                "record-frame-invalid: the decrypted frame's length prefix exceeds this store's " +
                    "${frameCapacity(recordSpec.bytes)}-byte capacity (F − 4 for F=${recordSpec.bytes}). The " +
                    "record's pad material is already retired (O5) and is LOST; no plaintext was released (§16.2, " +
                    "the same loss row as a crash after O5).",
            )
        }
        pad.fill(0); key.fill(0); mask.fill(0)

        // O6 — only now is the plaintext released, byte-exact.
        OpenResult(released, skippedBytes, skippedRecords, buildSummary(pairId))
    }

    /* ---- retire (§8.5 operator recovery) --------------------------------------- */

    fun retire(
        pairId: String,
        direction: Direction,
        throughSequence: Long,
        throughOffset: Long? = null,
        reason: String? = null,
    ): PairSummary = fs.withLock(pairId) {
        require(throughSequence >= 0) { "throughSequence must be a non-negative integer" }
        val pair = loadPair(pairId)
        val kind = witnessKindFor(pairId)
        val store = pair.getValue(direction)
        val head = store.head
        val effective = store.effective
        val prefix = storeDir(pairId, direction)
        val witness = witnessPreflight(store, kind)
        if (throughSequence >= head.capacityRecords) {
            throw EngineRefused(
                "sequence-malformed",
                "throughSequence $throughSequence does not exist (capacityRecords ${head.capacityRecords}).",
            )
        }
        if (throughSequence < effective.nextSequence) {
            throw EngineRefused(
                "sequence-retired",
                "sequences through $throughSequence are already retired (auth high-water ${effective.nextSequence}). " +
                    "Nothing to do; nothing was burned.",
            )
        }
        val newNextSequence = throughSequence + 1
        var newNextOffset = effective.nextOffset
        if (throughOffset != null) {
            require(throughOffset >= 0) { "throughOffset must be a non-negative integer" }
            if (throughOffset >= head.capacity) {
                throw EngineRefused(
                    "encryption-exhausted",
                    "throughOffset $throughOffset runs past capacity ${head.capacity}.",
                )
            }
            if (throughOffset + 1 < effective.nextOffset) {
                throw EngineRefused(
                    "offset-retired",
                    "offsets through $throughOffset are already retired (high-water ${effective.nextOffset}).",
                )
            }
            newNextOffset = throughOffset + 1
        }

        val prunedAttempts = LinkedHashMap<String, Long>()
        for ((k, v) in head.perSequenceAttempts) if (k.toLong() >= newNextSequence) prunedAttempts[k] = v
        val newHead = copyHead(
            head, nextOffset = newNextOffset, nextSequence = newNextSequence, perSequenceAttempts = prunedAttempts,
        )
        val line = StringBuilder("{\"op\":\"retire\",\"toSequence\":").append(newNextSequence)
            .append(",\"toOffset\":").append(newNextOffset).append(",\"reason\":")
        jsonString(line, reason ?: "operator retire")
        line.append(",\"at\":"); jsonString(line, now()); line.append('}')
        commitAdvance(fs, prefix, newHead, line.toString())
        witness.advance(pairId, direction, WitnessCounters(newNextOffset, newNextSequence, effective.attemptsReserved))
        buildSummary(pairId)
    }

    /* ---- clear-freeze (§8.4) ---------------------------------------------------- */

    fun clearFreeze(pairId: String): Int = fs.withLock(pairId) {
        val pair = loadPair(pairId)
        var cleared = 0
        for (direction in Direction.entries) {
            val store = pair.getValue(direction)
            if (!frozenHalf(store)) continue
            val prefix = storeDir(pairId, direction)
            val newHead = copyHead(
                store.head,
                failureCount = store.effective.failureCount,
                clearedAtFailureCount = store.effective.failureCount,
            )
            val line = StringBuilder("{\"op\":\"clear-freeze\",\"atFailureCount\":")
                .append(store.effective.failureCount).append(",\"at\":")
            jsonString(line, now()); line.append('}')
            commitAdvance(fs, prefix, newHead, line.toString())
            cleared += 1
        }
        cleared
    }

    /* ---- destroy (§17 destruction) ---------------------------------------------- */

    private class HalfSummary(val pairId: String?, val nextOffset: Long?, val nextSequence: Long?)

    private fun readHalfSummary(pairId: String, direction: Direction): HalfSummary {
        when (val loaded = loadStore(fs, storeDir(pairId, direction))) {
            is LoadResult.Ok -> return HalfSummary(
                loaded.store.head.pairId, loaded.store.effective.nextOffset, loaded.store.effective.nextSequence,
            )
            is LoadResult.Refusal -> Unit
        }
        // Too corrupt to load: try to salvage the pairId and counters by hand, so
        // the operator can still confirm the destruction by pairId.
        val bytes = fs.readFile(filePath(storeDir(pairId, direction), HEAD_FILE))
        if (bytes != null) {
            try {
                val parsed = dev.systemslibrarian.truepad.core.parseJson(String(bytes, Charsets.UTF_8))
                if (parsed is dev.systemslibrarian.truepad.core.JsonObject) {
                    val id = (parsed.members["pairId"] as? dev.systemslibrarian.truepad.core.JsonString)
                        ?.value?.takeIf { HEX_32_RE.matches(it) }
                    fun count(container: String, field: String): Long? {
                        val obj = parsed.members[container] as? dev.systemslibrarian.truepad.core.JsonObject
                        val n = obj?.members?.get(field) as? dev.systemslibrarian.truepad.core.JsonNumber
                        return n?.raw?.toLongOrNull()?.takeIf { it >= 0 }
                    }
                    return HalfSummary(id, count("encryption", "nextOffset"), count("authentication", "nextSequence"))
                }
            } catch (_: Exception) {
                /* head.json unparseable — the pairId stays unreadable */
            }
        }
        return HalfSummary(null, null, null)
    }

    private fun halfHasFiles(pairId: String, direction: Direction): Boolean {
        val prefix = storeDir(pairId, direction)
        return fs.exists(filePath(prefix, HEAD_FILE)) ||
            fs.exists(filePath(prefix, SECRET_FILE)) ||
            fs.exists(filePath(prefix, JOURNAL_FILE))
    }

    /** §17.2 step 3: best-effort zero-overwrite of one half's secret.bin. It
     *  proves nothing about the medium and claims no erasure — the file is
     *  removed anyway. */
    private fun overwriteSecretZeros(pairId: String, direction: Direction) {
        val secretPath = filePath(storeDir(pairId, direction), SECRET_FILE)
        val size = fs.size(secretPath) ?: return
        if (size == 0L) return
        try {
            fs.writeRange(secretPath, 0, ByteArray(size.toInt()))
        } catch (_: Exception) {
            /* best-effort: the file is removed regardless */
        }
    }

    fun destroy(pairId: String, confirm: String, reason: String? = null): DestroyResult = fs.withLock(pairId) {
        val priorTombstone = readTombstone(fs, pairId)
        // A v1 store is refused — unless this is already a tombstoned pair being
        // finished (a leftover pad.json must not misroute a destroy-resume to v1).
        if (!priorTombstone.exists) refuseIfV1(pairId)

        val abSum = readHalfSummary(pairId, Direction.A_TO_B)
        val baSum = readHalfSummary(pairId, Direction.B_TO_A)
        val resolvedPairId = abSum.pairId ?: baSum.pairId ?: priorTombstone.pairId

        // §17.1 confirmation: `confirm` MUST equal the pairId where a head yields
        // one; a pair too corrupt to yield one needs the literal token. The pairId
        // is deliberately NOT echoed — the operator confirms by knowing it.
        val requiredToken = resolvedPairId ?: UNREADABLE_PAIR_TOKEN
        if (confirm != requiredToken) {
            throw EngineRefused(
                "destroy-unconfirmed",
                if (resolvedPairId == null) {
                    "this pair is too corrupt to confirm by pairId — no half's $HEAD_FILE nor the tombstone yields " +
                        "one — so destroy requires confirm \"$UNREADABLE_PAIR_TOKEN\". Nothing was touched."
                } else {
                    "confirm must equal the pair's pairId to destroy it. It is NOT echoed here — read it from the " +
                        "pad book, a half's $HEAD_FILE, or $TOMBSTONE_FILE and pass it verbatim. Nothing was touched."
                },
            )
        }

        // Already fully torn down: idempotent — report and change nothing.
        if (priorTombstone.exists &&
            !halfHasFiles(pairId, Direction.A_TO_B) && !halfHasFiles(pairId, Direction.B_TO_A)
        ) {
            return@withLock DestroyResult(true, DESTROY_LIMITATION)
        }

        // §17.2 order is normative. 2 — the tombstone (durable, survives the
        // destruction). On a RESUME (a well-formed tombstone exists) it is
        // PRESERVED, not rewritten — its destroyedAt is the historical truth.
        if (!priorTombstone.wellFormed) {
            fun hw(s: HalfSummary) =
                if (s.nextOffset != null && s.nextSequence != null) HighWaters(s.nextOffset, s.nextSequence) else null
            writeTombstone(
                fs, pairId, resolvedPairId, now(), reason ?: "operator destroy", hw(abSum), hw(baSum),
            )
        }

        // 3 & 4 — per half: best-effort zero-overwrite of secret.bin, then unlink
        // the three files and the half directory.
        for (direction in Direction.entries) {
            overwriteSecretZeros(pairId, direction)
            val prefix = storeDir(pairId, direction)
            for (name in listOf(SECRET_FILE, HEAD_FILE, JOURNAL_FILE)) fs.remove(filePath(prefix, name))
            fs.remove(prefix)
        }
        DestroyResult(false, DESTROY_LIMITATION)
    }

    /* ---- export-pair / import-pair (the courier bundle) -------------------------
     * Export is a HANDOFF, and a pad gets one.
     *
     * PROVENANCE. An `imported` pad may never be exported onward. Alice hands
     * the pad to Bob; Bob imports it; Bob saves the pad file and gives it to
     * Charlie. Bob and Charlie would then hold independently consumable copies of
     * the same directional material and the same one-time authentication keys.
     * Software CAN tell this case apart from a first handoff, so it does.
     *
     * HANDOFF STATE, then, and MARKER-LAST. The container is built in memory and
     * NOT released until the marker has been written: bytes that left without a
     * record would be a handoff nothing knows about.
     * -------------------------------------------------------------------------- */

    /** The EXACT six-file courier container, read from the LIVE store. It mutates
     *  NO handoff state, and carries exactly the six FORMAT-V2 files — never
     *  pair.json, never the handoff record, never provenance, never witness data. */
    private fun buildLiveCourierContainer(pairId: String): ByteArray {
        val files = BUNDLE_FILES.map { rel ->
            val bytes = fs.readFile("$pairId/$rel")
                ?: throw EngineRefused("corrupt-store", "$rel is missing; the pair is not whole. Nothing was exported.")
            CourierFile(rel, bytes)
        }
        return packContainer(pairId, files)
    }

    fun exportPair(pairId: String): ExportResult = fs.withLock(pairId) {
        requireNotDestroyed(pairId)
        requireImportComplete(pairId)
        requirePair(pairId)

        val meta = readPairMeta(fs, pairId)
        if (meta.origin == PairOrigin.IMPORTED) {
            throw EngineRefused(
                "imported-pair-cannot-export",
                "This pad arrived from someone else, so TruePad will not save another copy of it to pass on. Two " +
                    "people holding the same pad would each use the same material, which is the one failure this " +
                    "product exists to prevent. Generate a new pad to share with someone new.",
            )
        }

        when (val handoff = readHandoffState(fs, pairId)) {
            is HandoffState.UnreadableSpent -> throw EngineRefused(REFUSE_UNREADABLE, handoff.message)
            is HandoffState.Sealed -> throw EngineRefused(
                REFUSE_ALREADY_SEALED,
                "This pad has already been sent by sealed transfer, so it will not also be saved as a file to pass " +
                    "on. Generate a new pad for any further transfer.",
            )
            else -> Unit
        }

        val container = buildLiveCourierContainer(pairId)

        // MARKER LAST, and before the container is released. A first export
        // records the handoff; a re-export under an existing physical marker
        // leaves it alone, so the recorded time stays the time of the FIRST handoff.
        if (readHandoffState(fs, pairId) is HandoffState.Absent) commitPhysicalHandoff(fs, pairId, now())
        ExportResult(container, BUNDLE_FILES.size)
    }

    /** Exactly the expected FORMAT-V2 files — no unknown, no duplicate, none missing. */
    private fun validateBundleFileSet(files: List<CourierFile>): String? {
        val seen = LinkedHashSet<String>()
        for (f in files) {
            if (f.path !in BUNDLE_FILES) return "bundle path \"${f.path}\" is not one of this store's files."
            if (!seen.add(f.path)) return "bundle path \"${f.path}\" appears more than once."
        }
        val missing = BUNDLE_FILES.filter { it !in seen }
        if (missing.isNotEmpty()) return "bundle is missing store file(s): ${missing.joinToString(", ")}."
        return null
    }

    private fun removeStoreFiles(root: String) {
        for (rel in BUNDLE_FILES) fs.remove("$root/$rel")
        fs.remove("$root/${SUBDIR.getValue(Direction.A_TO_B)}")
        fs.remove("$root/${SUBDIR.getValue(Direction.B_TO_A)}")
    }

    /** Discard any INCOMPLETE import of this pairId (never a committed pair — the
     *  caller checks that first). Idempotent. */
    private fun discardIncompleteImport(pairId: String) {
        removeStoreFiles(pairId)
        fs.remove(pairMetaPath(pairId))
        fs.remove(importMarkerPath(pairId))
        witnessFs.remove(witnessLogPath(pairId))
        fs.remove(pairId)
        removeStoreFiles(stagingDir(pairId))
        fs.remove(stagingDir(pairId))
    }

    /** A COMMITTED (active) pair with this id: a head.json is present AND the pair
     *  is not mid-import. A pair still carrying the import marker is not
     *  committed, so a retry may clean and redo it. */
    private fun committedPairExists(pairId: String): Boolean {
        if (fs.exists(importMarkerPath(pairId))) return false
        return fs.exists(filePath(storeDir(pairId, Direction.A_TO_B), HEAD_FILE)) ||
            fs.exists(filePath(storeDir(pairId, Direction.B_TO_A), HEAD_FILE))
    }

    fun importPair(label: String, container: ByteArray, witnessKind: WitnessKind = WitnessKind.LOCAL): PairSummary {
        val unpacked = when (val u = unpackContainer(container)) {
            is UnpackResult.Bad -> throw EngineRefused("malformed-bundle", "${u.message} Nothing was imported.")
            is UnpackResult.Ok -> u
        }
        val pairId = unpacked.pairId
        if (!HEX_32_RE.matches(pairId)) {
            throw EngineRefused(
                "malformed-bundle",
                "bundle pairId must be exactly 32 lowercase hex characters (found \"$pairId\"). Nothing was imported.",
            )
        }
        return fs.withLock(pairId) {
            requireNotDestroyed(pairId)
            if (committedPairExists(pairId)) {
                throw EngineRefused(
                    "pair-exists",
                    "a pair with id $pairId already exists here; importing would overwrite it. Nothing was imported.",
                )
            }
            // A prior interrupted/failed import of this same pairId leaves no
            // active pair, only removable partial/staging files: clear them so a
            // retry is never blocked by a ghost, and so bootstrap starts clean.
            discardIncompleteImport(pairId)

            // §6 STAGE + VALIDATE. The whole bundle is validated in
            // importing/<pairId>/ — file set, both headers (incl. rollback:none
            // only, so a store whose frozen witness class Android cannot honour is
            // REFUSED, not downgraded), journals, secret sizes, reconciliation,
            // pairId and direction agreement — before ANY of it is made active.
            validateBundleFileSet(unpacked.files)?.let {
                throw EngineRefused("malformed-bundle", "$it Nothing was imported.")
            }
            for (f in unpacked.files) fs.writeFileAtomic("${stagingDir(pairId)}/${f.path}", f.bytes)

            val ab: LoadedStore
            val ba: LoadedStore
            try {
                val loadedAB = loadStore(fs, "${stagingDir(pairId)}/${SUBDIR.getValue(Direction.A_TO_B)}")
                if (loadedAB is LoadResult.Refusal) {
                    throw EngineRefused(loadedAB.reason, "imported A->B store: ${loadedAB.message}")
                }
                val loadedBA = loadStore(fs, "${stagingDir(pairId)}/${SUBDIR.getValue(Direction.B_TO_A)}")
                if (loadedBA is LoadResult.Refusal) {
                    throw EngineRefused(loadedBA.reason, "imported B->A store: ${loadedBA.message}")
                }
                ab = (loadedAB as LoadResult.Ok).store
                ba = (loadedBA as LoadResult.Ok).store
                if (ab.head.pairId != pairId || ba.head.pairId != pairId) {
                    throw EngineRefused(
                        "malformed-bundle",
                        "the bundle's $HEAD_FILE pairId disagrees with the container pairId $pairId. Nothing was imported.",
                    )
                }
                if (ab.head.direction != Direction.A_TO_B || ba.head.direction != Direction.B_TO_A) {
                    throw EngineRefused(
                        "malformed-bundle",
                        "the bundle's two halves are not a matched A->B / B->A pair. Nothing was imported.",
                    )
                }
            } catch (e: Exception) {
                removeStoreFiles(stagingDir(pairId))
                fs.remove(stagingDir(pairId))
                throw e
            }

            // §6 COMMIT. Mark the pair provisioning FIRST (so a crash mid-copy
            // leaves an inactive, retryable pair — never a partial active one),
            // copy the validated files in, bootstrap the witness to the imported
            // high-waters (only after the FORMAT-V2 state is validated), write
            // pair.json (the commit), then clear the marker and the staging.
            val marker = StringBuilder("{\"pairId\":")
            jsonString(marker, pairId); marker.append(",\"at\":"); jsonString(marker, now()); marker.append('}')
            fs.writeFileAtomic(importMarkerPath(pairId), marker.toString().toByteArray(Charsets.UTF_8))
            for (f in unpacked.files) fs.writeFileAtomic("$pairId/${f.path}", f.bytes)
            if (witnessKind == WitnessKind.LOCAL) {
                witnessFor(witnessFs, WitnessKind.LOCAL).bootstrap(
                    pairId,
                    mapOf(
                        Direction.A_TO_B to WitnessCounters(
                            ab.effective.nextOffset, ab.effective.nextSequence, ab.effective.attemptsReserved,
                        ),
                        Direction.B_TO_A to WitnessCounters(
                            ba.effective.nextOffset, ba.effective.nextSequence, ba.effective.attemptsReserved,
                        ),
                    ),
                )
            }
            // origin is a FIELD of the pair.json the commit already writes, before
            // importing.json is removed. There is no ordering in which an imported
            // pair becomes active carrying "generated-here", and no ordering in
            // which a crash upgrades a pad's provenance.
            writePairMeta(fs, PairMeta(pairId, label, now(), witnessKind, PairOrigin.IMPORTED))
            fs.remove(importMarkerPath(pairId)) // COMMIT: the pair is now active
            removeStoreFiles(stagingDir(pairId))
            fs.remove(stagingDir(pairId))

            buildSummary(pairId)
        }
    }
}
