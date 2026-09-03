package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.core.JsonParseException
import dev.systemslibrarian.truepad.core.parseJson
import dev.systemslibrarian.truepad.core.requiredSourceLength
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Store Format v2 on disk: the canonical head bytes, the header's accept/reject
 * rule set, the journal grammar, and the §12.1 reconciliation.
 *
 * A header is refused WHOLE rather than partially trusted, and every refusal
 * carries the same typed reason the CLI and Browser Edition use, so the three
 * editions agree about what a broken store is.
 */
class StoreFormatTest {

    private fun pair(fs: MemoryFs, capacity: Long = 4096, records: Long = 24, seed: Int = 77): Engine {
        val e = fixedEngine(fs)
        val need = requiredSourceLength(capacity, records).toInt()
        e.gen("fmt", listOf(SourceInput("s.bin", "declared", genBytes(need, seed))), capacity, records, witnessKind = WitnessKind.LOCAL)
        return e
    }

    /**
     * THE KEY-ORDER TRAP. JavaScript emits integer-like object keys in ascending
     * NUMERIC order, never insertion order — so the released engine writes
     * {"1":..,"2":..,"10":..} even when the failures arrived as 12, 5, 19, 3, …
     * A Kotlin LinkedHashMap would emit insertion order and silently stop being
     * byte-identical to the CLI and Browser. Note "5" before "10": the order is
     * numeric, so lexicographic sorting fails this test too.
     */
    @Test
    fun perSequenceAttemptsIsEmittedInJavaScriptPropertyOrder() {
        val v = V.obj("head-key-order.json")
        val fs = MemoryFs()
        val alice = pair(fs, v.long("capacity"), v.long("capacityRecords"), v.int("sourceSeed"))
        val pairId = v.str("pairId")

        val bobFs = MemoryFs()
        fixedEngine(bobFs).importPair("bob", alice.exportPair(pairId).container)
        val bob = fixedEngine(bobFs)

        val envelopes = v.arr("plaintexts").map { (it as dev.systemslibrarian.truepad.core.JsonString).value }
            .map { alice.burn(pairId, Party2.A, it.toByteArray()).envelope }

        for (r in v.arr("refusals").map { it.asObj() }) {
            val seq = r.int("sequence")
            val refusal = refusalOf { bob.open(pairId, Party2.B, tamperTag(envelopes[seq])) }
            assertEquals("refusal for sequence $seq", r.str("reason"), refusal.reason)
        }

        val head = textAt(bobFs, headPath(pairId, Direction.A_TO_B))
        assertEquals(
            "perSequenceAttempts must be in ascending numeric key order",
            v.str("perSequenceAttemptsSubstring"),
            head.substring(head.indexOf("\"perSequenceAttempts\"")),
        )
        assertEquals("the whole head must be byte-identical", v.str("headText"), head)
        assertEquals("and so must the journal", v.str("journalText"), textAt(bobFs, journalPath(pairId, Direction.A_TO_B)))
    }

    /** The unit behind that fix, stated directly. */
    @Test
    fun jsPropertyOrderSortsIndexKeysNumericallyAndKeepsTheRestLast() {
        val m = LinkedHashMap<String, Long>()
        for (k in listOf("12", "5", "19", "3", "0", "10")) m[k] = 1
        assertEquals(listOf("0", "3", "5", "10", "12", "19"), jsPropertyOrder(m).map { it.key })
        // 2^32-1 is NOT an array index in JavaScript, so it keeps insertion order
        // and follows every real index key.
        val big = LinkedHashMap<String, Long>()
        big["4294967295"] = 1
        big["7"] = 1
        assertEquals(listOf("7", "4294967295"), jsPropertyOrder(big).map { it.key })
    }

    /**
     * JSON.stringify is WELL-FORMED (ES2019): a lone surrogate is escaped, never
     * emitted raw. Emitting it raw would both diverge from the released bytes and
     * corrupt the value, since encoding a lone surrogate to UTF-8 substitutes '?'.
     * An operator's source-declaration name reaches this path.
     */
    @Test
    fun aLoneSurrogateInADeclaredNameIsEscapedNotCorrupted() {
        val sb = StringBuilder()
        jsonString(sb, "a\uD800b")
        assertEquals("\"a\\ud800b\"", sb.toString())
        // A well-formed PAIR is emitted literally, as JSON.stringify does.
        val paired = StringBuilder()
        jsonString(paired, "x\uD83D\uDE00y")
        assertEquals("\"x\uD83D\uDE00y\"", paired.toString())
        // And it survives a real gen -> head.json -> reload round trip.
        val fs = MemoryFs()
        val e = fixedEngine(fs)
        val need = requiredSourceLength(256, 4).toInt()
        e.gen("surrogate", listOf(SourceInput("lone\uD800name", "o", genBytes(need, 3))), 256, 4)
        val head = textAt(fs, headPath(FIXED_PAIR_ID, Direction.A_TO_B))
        assertTrue("the escape must be in the bytes", head.contains("\"lone\\ud800name\""))
        assertTrue("and no '?' substitution", !head.contains("lone?name"))
        val reloaded = loadStore(fs, storeDir(FIXED_PAIR_ID, Direction.A_TO_B))
        assertTrue(reloaded is LoadResult.Ok)
        assertEquals("lone\uD800name", (reloaded as LoadResult.Ok).store.head.sourceDeclarations[0].name)
    }

    /** The strict JSON reader must accept exactly what JSON.parse accepts. */
    @Test
    fun theJsonReaderIsExactlyAsStrictAsJsonParse() {
        // A \u escape is EXACTLY four hex digits — a sign is not a hex digit,
        // even though a naive radix-16 parse would take it.
        for (bad in listOf("\"\\u+123\"", "\"\\u-123\"", "\"\\u 123\"", "\"\\uzzzz\"")) {
            try {
                parseJson(bad)
                error("accepted $bad, which JSON.parse refuses")
            } catch (_: JsonParseException) {
            }
        }
        assertEquals("\u0123", (parseJson("\"\\u0123\"") as dev.systemslibrarian.truepad.core.JsonString).value)
        // Deep nesting is a clean typed refusal, never a StackOverflowError that
        // would escape every caller's catch and kill the operation.
        val deep = "[".repeat(50_000) + "]".repeat(50_000)
        try {
            parseJson(deep)
            error("accepted a 50000-deep nest")
        } catch (_: JsonParseException) {
        }
        // And through the store's own door: a hostile head is a refusal, not a crash.
        val fs = MemoryFs()
        fs.writeFileAtomic("p/a-to-b/$HEAD_FILE", deep.toByteArray())
        fs.writeFileAtomic("p/a-to-b/$SECRET_FILE", ByteArray(0))
        fs.appendFile("p/a-to-b/$JOURNAL_FILE", ByteArray(0))
        val r = loadStore(fs, "p/a-to-b")
        assertTrue(r is LoadResult.Refusal)
        assertEquals("corrupt-head", (r as LoadResult.Refusal).reason)
    }

    /** A header is refused whole. Each mutation names its typed reason. */
    @Test
    fun everyHeaderMutationIsRefusedWithItsTypedReason() {
        val fs = MemoryFs()
        pair(fs, 256, 4)
        val prefix = storeDir(FIXED_PAIR_ID, Direction.A_TO_B)
        val good = textAt(fs, headPath(FIXED_PAIR_ID, Direction.A_TO_B))

        val mutations = listOf(
            "not JSON at all" to "{",
            "an array, not an object" to "[]",
            "formatVersion 1" to good.replace("\"formatVersion\":2", "\"formatVersion\":1"),
            "an extra top-level key" to good.dropLast(1) + ",\"extra\":1}",
            "a missing top-level key" to good.replace(",\"rollback\":{\"witnessClass\":\"none\",\"config\":{}}", ""),
            "uppercase pairId" to good.replace(FIXED_PAIR_ID, FIXED_PAIR_ID.uppercase()),
            "an unknown direction" to good.replace("\"direction\":\"A->B\"", "\"direction\":\"A=>B\""),
            "mode other than bytes" to good.replace("\"mode\":\"bytes\"", "\"mode\":\"chars\""),
            "a foreign auth profile" to good.replace("\"profile\":\"wc-one-time-v1\"", "\"profile\":\"hmac-sha256\""),
            "a tag width other than 128" to good.replace("\"tagBits\":128", "\"tagBits\":64"),
            "a different ciphertext ceiling" to good.replace("\"maxCiphertextBytes\":1048576", "\"maxCiphertextBytes\":2097152"),
            "authentication downgrade allowed" to good.replace("\"downgradeAllowed\":false", "\"downgradeAllowed\":true"),
            "authentication not required" to good.replace("\"authenticated\":\"required\"", "\"authenticated\":\"optional\""),
            "nextOffset past capacity" to good.replace("\"nextOffset\":0", "\"nextOffset\":257"),
            "nextSequence past capacityRecords" to good.replace("\"nextSequence\":0", "\"nextSequence\":5"),
            "a negative counter" to good.replace("\"nextOffset\":0", "\"nextOffset\":-1"),
            "a non-canonical numeric spelling" to good.replace("\"nextOffset\":0", "\"nextOffset\":0.0"),
            "a non-decimal attempt key" to good.replace("\"perSequenceAttempts\":{}", "\"perSequenceAttempts\":{\"0x1\":1}"),
            "a failure policy that is not freeze" to good.replace("\"kind\":\"freeze\"", "\"kind\":\"wipe\""),
        )
        for ((why, text) in mutations) {
            fs.writeFileAtomic(headPath(FIXED_PAIR_ID, Direction.A_TO_B), text.toByteArray())
            val r = loadStore(fs, prefix)
            assertTrue("$why should be refused", r is LoadResult.Refusal)
            assertEquals("reason for: $why", "corrupt-head", (r as LoadResult.Refusal).reason)
        }
        // Restoring the good header brings the store back — the refusals were
        // judgements about the bytes, never damage to them.
        fs.writeFileAtomic(headPath(FIXED_PAIR_ID, Direction.A_TO_B), good.toByteArray())
        assertTrue(loadStore(fs, prefix) is LoadResult.Ok)
    }

    /**
     * A frozen witness class Android cannot honour is REFUSED, never silently
     * downgraded to "no rollback protection". This mirrors the released Browser
     * Edition exactly (src/browser/engine/store.ts): the CLI can write
     * separate-state-file and platform-monotonic stores, and an edition that
     * quietly accepted one while enforcing nothing would be claiming a protection
     * it does not provide.
     */
    @Test
    fun aWitnessClassThisEditionCannotHonourIsRefusedNotDowngraded() {
        val fs = MemoryFs()
        pair(fs, 256, 4)
        val prefix = storeDir(FIXED_PAIR_ID, Direction.A_TO_B)
        val good = textAt(fs, headPath(FIXED_PAIR_ID, Direction.A_TO_B))
        val foreign = listOf(
            "\"rollback\":{\"witnessClass\":\"separate-state-file\",\"config\":{\"path\":\"/var/truepad/w.json\"}}",
            "\"rollback\":{\"witnessClass\":\"platform-monotonic\",\"config\":{\"provider\":\"tpm2-nv-counter-v1\"}}",
            "\"rollback\":{\"witnessClass\":\"remote-monotonic\",\"config\":{}}",
            "\"rollback\":{\"witnessClass\":\"none\",\"config\":{\"path\":\"/x\"}}",
        )
        for (r0 in foreign) {
            val text = good.replace("\"rollback\":{\"witnessClass\":\"none\",\"config\":{}}", r0)
            assertTrue("the mutation must actually apply", text != good)
            fs.writeFileAtomic(headPath(FIXED_PAIR_ID, Direction.A_TO_B), text.toByteArray())
            val r = loadStore(fs, prefix)
            assertTrue("$r0 must be refused", r is LoadResult.Refusal)
            assertEquals("corrupt-head", (r as LoadResult.Refusal).reason)
        }
    }

    /** Every store-level refusal reason, reached from a real broken store. */
    @Test
    fun theStoreRefusalTaxonomyIsComplete() {
        fun reason(build: (MemoryFs) -> Unit): String {
            val fs = MemoryFs()
            build(fs)
            val r = loadStore(fs, "p/a-to-b")
            assertTrue("expected a refusal, got $r", r is LoadResult.Refusal)
            return (r as LoadResult.Refusal).reason
        }
        assertEquals("no-store", reason { })
        assertEquals("v1-store", reason { it.writeFileAtomic("p/a-to-b/pad.json", "{}".toByteArray()) })
        assertEquals("corrupt-store", reason { it.writeFileAtomic("p/a-to-b/$SECRET_FILE", ByteArray(4)) })

        // The rest need a real store to damage.
        val base = MemoryFs()
        pair(base, 256, 4)
        val good = textAt(base, headPath(FIXED_PAIR_ID, Direction.A_TO_B))
        val secret = base.readFile(secretPath(FIXED_PAIR_ID, Direction.A_TO_B))!!
        val journal = base.readFile(journalPath(FIXED_PAIR_ID, Direction.A_TO_B))!!
        fun seeded(mutate: (MemoryFs) -> Unit): String = reason { fs ->
            fs.writeFileAtomic("p/a-to-b/$HEAD_FILE", good.toByteArray())
            fs.writeFileAtomic("p/a-to-b/$SECRET_FILE", secret)
            fs.writeFileAtomic("p/a-to-b/$JOURNAL_FILE", journal)
            mutate(fs)
        }
        assertEquals("corrupt-head", seeded { it.writeFileAtomic("p/a-to-b/$HEAD_FILE", "{}".toByteArray()) })
        assertEquals("corrupt-store", seeded { it.remove("p/a-to-b/$JOURNAL_FILE") })
        assertEquals("corrupt-secret-body", seeded { it.writeFileAtomic("p/a-to-b/$SECRET_FILE", secret.copyOf(secret.size - 1)) })
        assertEquals(
            "corrupt-journal",
            seeded { it.appendFile("p/a-to-b/$JOURNAL_FILE", "{\"op\":\"nonsense\"}\n".toByteArray()) },
        )
        assertEquals(
            "regressed-below-mark",
            seeded {
                it.appendFile(
                    "p/a-to-b/$JOURNAL_FILE",
                    "{\"op\":\"send\",\"sequence\":0,\"startOffset\":0,\"consumed\":9,\"nextOffset\":9,\"nextSequence\":1,\"at\":\"x\"}\n".toByteArray(),
                )
            },
        )
    }

    /**
     * A journal that ends in a torn line is the CRASH signature and says so; a
     * malformed line in the MIDDLE is not, and says that instead. Both refuse —
     * the difference is what the operator is told to do about it.
     */
    @Test
    fun aTornLastJournalLineIsDistinguishedFromMidFileDamage() {
        val fs = MemoryFs()
        pair(fs, 256, 4)
        val e = fixedEngine(fs)
        e.burn(FIXED_PAIR_ID, Party2.A, "one".toByteArray())
        val path = journalPath(FIXED_PAIR_ID, Direction.A_TO_B)
        val good = textAt(fs, path)

        fs.writeFileAtomic(path, (good + "{\"op\":\"se").toByteArray())
        val torn = loadStore(fs, storeDir(FIXED_PAIR_ID, Direction.A_TO_B)) as LoadResult.Refusal
        assertEquals("corrupt-journal", torn.reason)
        assertTrue("the torn-tail message must name the crash signature", torn.message.contains("crash signature"))

        val lines = good.trimEnd('\n').split("\n")
        fs.writeFileAtomic(path, (lines[0] + "\n{\"op\":\"junk\"}\n" + lines[1] + "\n").toByteArray())
        val mid = loadStore(fs, storeDir(FIXED_PAIR_ID, Direction.A_TO_B)) as LoadResult.Refusal
        assertEquals("corrupt-journal", mid.reason)
        assertTrue("mid-file damage must NOT be reported as a crash", mid.message.contains("mid-file"))
    }

    /** §12.4: secret.bin is durable BEFORE head.json, which is before the init line. */
    @Test
    fun genWritesTheThreeFilesInTheNormativeOrder() {
        val inner = MemoryFs()
        val rec = RecordingFs(inner)
        val need = requiredSourceLength(256, 4).toInt()
        Engine(rec, rec, clock = { FIXED_INSTANT }, pairIdSource = { thex(FIXED_PAIR_ID) })
            .gen("order", listOf(SourceInput("s", "o", genBytes(need, 1))), 256, 4, witnessKind = WitnessKind.LOCAL)

        val ab = rec.writes.filter { it.contains("a-to-b") }
        assertEquals(
            listOf(
                "write:$FIXED_PAIR_ID/a-to-b/$SECRET_FILE",
                "write:$FIXED_PAIR_ID/a-to-b/$HEAD_FILE",
                "append:$FIXED_PAIR_ID/a-to-b/$JOURNAL_FILE",
            ),
            ab,
        )
        // pair.json is the COMMIT and lands last, after both halves and the
        // witness bootstrap: a crash before it leaves a store with no committed
        // witness, never a provisioned-but-unusable one.
        assertEquals("write:${pairMetaPath(FIXED_PAIR_ID)}", rec.writes.last())
        assertTrue(
            "the witness must be provisioned before pair.json",
            rec.writes.indexOf("append:${witnessLogPath(FIXED_PAIR_ID)}") < rec.writes.lastIndex,
        )
    }

    /**
     * SEND advances the header THEN journals it; an authentication FAILURE is the
     * one deliberate inversion — the journal line first, then the header.
     */
    @Test
    fun theDurableWriteOrderMatchesTheReleaseForBothAdvanceAndFailure() {
        val inner = MemoryFs()
        pair(inner, 256, 4)
        val container = fixedEngine(inner).exportPair(FIXED_PAIR_ID).container
        val env = fixedEngine(inner).burn(FIXED_PAIR_ID, Party2.A, "hi".toByteArray()).envelope

        val bobInner = MemoryFs()
        fixedEngine(bobInner).importPair("b", container)

        val rec = RecordingFs(bobInner)
        val bob = Engine(rec, rec, clock = { FIXED_INSTANT }, pairIdSource = { thex(FIXED_PAIR_ID) })
        refusalOf { bob.open(FIXED_PAIR_ID, Party2.B, tamperTag(env)) }
        val ab = rec.writes.filter { it.contains("a-to-b") }
        assertEquals(
            "the attempt reservation, then the auth-fail line, then the header",
            listOf(
                "append:$FIXED_PAIR_ID/a-to-b/$JOURNAL_FILE", // O3 reservation
                "append:$FIXED_PAIR_ID/a-to-b/$JOURNAL_FILE", // the auth-fail line
                "write:$FIXED_PAIR_ID/a-to-b/$HEAD_FILE", // and only then the header
            ),
            ab,
        )

        val rec2 = RecordingFs(inner)
        Engine(rec2, rec2, clock = { FIXED_INSTANT }, pairIdSource = { thex(FIXED_PAIR_ID) })
            .burn(FIXED_PAIR_ID, Party2.A, "again".toByteArray())
        assertEquals(
            "an advance writes the header first, then journals it",
            listOf(
                "write:$FIXED_PAIR_ID/a-to-b/$HEAD_FILE",
                "append:$FIXED_PAIR_ID/a-to-b/$JOURNAL_FILE",
            ),
            rec2.writes.filter { it.contains("a-to-b") },
        )
    }
}
