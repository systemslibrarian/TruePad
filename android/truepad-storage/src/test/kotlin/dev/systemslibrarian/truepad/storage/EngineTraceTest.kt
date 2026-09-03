package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.core.JsonObject
import dev.systemslibrarian.truepad.core.bytesToHex
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE INTEROPERABILITY PROOF.
 *
 * android/vectors/engine-trace.json is a complete gen -> export -> import ->
 * burn x3 -> open/forge/open/replay transcript recorded from the RELEASED
 * TruePad v2.0.0 engine (src/browser/engine/verbs.ts at tag v2.0.0), with the
 * pairId draw and the clock pinned so it is reproducible. Nothing in it was
 * written by hand.
 *
 * This test replays that transcript through the Kotlin engine with the same
 * pinned pairId and clock, and requires byte-for-byte agreement on:
 *
 *   · head.json at genesis, after each burn, after the forged open, and after
 *     the successful opens — the whole canonical serialization, key order
 *     included;
 *   · secret.bin — so the §7 partition landed the same bytes in the same slots;
 *   · journal.log — every line, every op, every counter;
 *   · the witness journal — every appended record, in order;
 *   · pair.json on both sides, including provenance;
 *   · the courier container;
 *   · every emitted envelope — the ciphertext AND the Wegman-Carter tag;
 *   · every released plaintext;
 *   · every typed refusal reason.
 *
 * A pass means an Android build and the shipping CLI/Browser Edition produce and
 * accept the same bytes. A failure is a release blocker.
 */
class EngineTraceTest {

    private fun runTrace(key: String) {
        val t = V.obj("engine-trace.json").obj(key)
        val pairId = t.str("pairId")
        assertEquals("the generator pinned the pairId", FIXED_PAIR_ID, pairId)
        val capacity = t.long("capacity")
        val capacityRecords = t.long("capacityRecords")
        val recordBytes = (t.members["recordBytes"] as? dev.systemslibrarian.truepad.core.JsonNumber)?.raw?.toInt()

        val alice = MemoryFs()
        val engineA = fixedEngine(alice)

        /* ---- gen ------------------------------------------------------------- */

        val gen = engineA.gen(
            label = t.str("label"),
            sources = traceSources(capacity, capacityRecords),
            encryptionBytes = capacity,
            authRecords = capacityRecords,
            recordBytes = recordBytes,
            witnessKind = WitnessKind.LOCAL,
        )
        assertEquals(pairId, gen.pair.pairId)
        assertEquals(t.long("requiredSourceLength"), gen.requiredSourceLength)

        // The declared sources must be the ones the release used, or every byte
        // below would be compared against a different pad.
        for ((i, s) in t.arr("sources").map { it.asObj() }.withIndex()) {
            assertEquals("source $i bytes", s.str("bytesHex"), bytesToHex(traceSources(capacity, capacityRecords)[i].bytes))
        }

        assertHeads(alice, pairId, t, "genHeads")
        for ((i, d) in Direction.entries.withIndex()) {
            assertEquals(
                "genesis journal ${d.wire}",
                t.arr("genJournals")[i].asObj().str("text"),
                textAt(alice, journalPath(pairId, d)),
            )
        }
        assertEquals("genesis witness journal", t.str("genWitness"), textAt(alice, witnessLogPath(pairId)))
        assertEquals("secret.bin A->B", t.str("genSecretABHex"), bytesToHex(alice.readFile(secretPath(pairId, Direction.A_TO_B))!!))
        assertEquals("secret.bin B->A", t.str("genSecretBAHex"), bytesToHex(alice.readFile(secretPath(pairId, Direction.B_TO_A))!!))
        assertEquals("alice pair.json", androidised(t.str("alicePairJson")), textAt(alice, pairMetaPath(pairId)))

        /* ---- courier the pad to Bob at genesis -------------------------------- */

        val exported = engineA.exportPair(pairId)
        assertEquals("courier container", t.str("containerText"), String(exported.container, Charsets.UTF_8))
        assertEquals(6, exported.fileCount)

        val bob = MemoryFs()
        val engineB = fixedEngine(bob)
        engineB.importPair("from alice", exported.container, WitnessKind.LOCAL)
        assertEquals("bob pair.json", androidised(t.str("bobPairJson")), textAt(bob, pairMetaPath(pairId)))

        /* ---- burns ------------------------------------------------------------ */

        val burns = t.arr("burns").map { it.asObj() }
        val emitted = ArrayList<String>()
        for (b in burns) {
            val r = engineA.burn(pairId, Party2.A, b.str("plaintextUtf8").toByteArray(Charsets.UTF_8))
            assertEquals("emitted envelope for \"${b.str("plaintextUtf8")}\"", b.str("envelope"), r.envelope)
            assertEquals(b.obj("consumed").int("encryptionBytes"), r.encryptionBytes)
            assertEquals(b.obj("consumed").int("authRecords"), r.authRecords)
            emitted.add(r.envelope)
        }
        assertHeads(alice, pairId, t, "afterBurnHeads")
        assertEquals("witness after the burns", t.str("afterBurnWitness"), textAt(alice, witnessLogPath(pairId)))

        /* ---- opens, a forgery, and the replays -------------------------------- */

        val opens = t.arr("opens").map { it.asObj() }
        val first = opens[0]
        val r0 = engineB.open(pairId, Party2.B, emitted[first.int("envelopeIndex")])
        assertEquals("released plaintext #0", first.str("plaintextUtf8"), String(r0.plaintext, Charsets.UTF_8))
        assertEquals(first.obj("skipped").long("encryptionBytes"), r0.skippedBytes)
        assertEquals(first.obj("skipped").long("authRecords"), r0.skippedRecords)

        // A tampered tag: one durable attempt is reserved, the failure is
        // persisted, and NO pad material is consumed.
        val forged = refusalOf { engineB.open(pairId, Party2.B, t.str("forgedEnvelope")) }
        assertEquals(t.str("forgedRefusal"), forged.reason)
        assertHeads(bob, pairId, t, "afterForgeHeads")
        assertEquals("witness after the forgery", t.str("afterForgeWitness"), textAt(bob, witnessLogPath(pairId)))

        val second = opens[1]
        val r2 = engineB.open(pairId, Party2.B, emitted[second.int("envelopeIndex")])
        assertEquals("released plaintext #2", second.str("plaintextUtf8"), String(r2.plaintext, Charsets.UTF_8))
        assertEquals(
            "the lost record's encryption bytes are destroyed unused",
            second.obj("skipped").long("encryptionBytes"), r2.skippedBytes,
        )
        assertEquals(second.obj("skipped").long("authRecords"), r2.skippedRecords)

        assertEquals(t.str("replayRefusal"), refusalOf { engineB.open(pairId, Party2.B, emitted[0]) }.reason)
        assertEquals(t.str("skippedReplayRefusal"), refusalOf { engineB.open(pairId, Party2.B, emitted[1]) }.reason)

        assertHeads(bob, pairId, t, "afterOpenHeads")
        for ((i, d) in Direction.entries.withIndex()) {
            assertEquals(
                "receiver journal ${d.wire}",
                t.arr("afterOpenJournals")[i].asObj().str("text"),
                textAt(bob, journalPath(pairId, d)),
            )
        }
        assertEquals("witness after the opens", t.str("afterOpenWitness"), textAt(bob, witnessLogPath(pairId)))

        /* ---- provenance: an imported pad may never be passed on ---------------- */

        assertEquals(t.str("bobExportRefusal"), refusalOf { engineB.exportPair(pairId) }.reason)
    }

    /**
     * The ONE field that legitimately differs from the released bytes.
     *
     * pair.json is product-local bookkeeping: it is not Store Format v2, and it
     * is not one of the six courier files, so its contents never reach a peer
     * (see [pairJsonNeverTravelsInTheCourierBundle]). Its `witness` field names
     * THIS product's own rollback witness, and naming an Android journal
     * "browser-local-witness" would be a false claim about where the witness
     * lives. Every byte that a peer can actually observe — head.json,
     * secret.bin, journal.log, the envelope, the container — is compared
     * unmodified.
     */
    private fun androidised(pairJson: String): String =
        pairJson.replace("\"browser-local-witness\"", "\"android-local-witness\"")
            .replace("\"browser-none\"", "\"android-none\"")

    private fun assertHeads(fs: Fs, pairId: String, t: JsonObject, key: String) {
        for ((i, d) in Direction.entries.withIndex()) {
            val expected = t.arr(key)[i].asObj()
            assertEquals("$key path", "$pairId/${SUBDIR.getValue(d)}/$HEAD_FILE", expected.str("path"))
            assertEquals("$key ${d.wire}", expected.str("text"), textAt(fs, headPath(pairId, d)))
        }
    }

    @Test
    fun variableRecordPadMatchesTheReleaseByteForByte() = runTrace("variable")

    @Test
    fun fixedRecordPadMatchesTheReleaseByteForByte() = runTrace("fixed")

    /**
     * The witness kind is the only Android-named value in the whole system, and
     * this is why that is safe: it lives in a file the courier bundle does not
     * carry. A peer importing an Android-exported pad sees exactly the six
     * FORMAT-V2 files and nothing else.
     */
    @Test
    fun pairJsonNeverTravelsInTheCourierBundle() {
        val alice = MemoryFs()
        val a = fixedEngine(alice)
        a.gen("no leakage", traceSources(256, 4), 256, 4, witnessKind = WitnessKind.LOCAL)
        val container = String(a.exportPair(FIXED_PAIR_ID).container, Charsets.UTF_8)
        assertTrue("pair.json exists locally", alice.exists(pairMetaPath(FIXED_PAIR_ID)))
        for (leaked in listOf("pair.json", "android-local-witness", "browser-local-witness", "handoff.json", "witness/")) {
            assertTrue("the container must not mention $leaked", !container.contains(leaked))
        }
        val paths = (unpackContainer(container.toByteArray()) as UnpackResult.Ok).files.map { it.path }
        assertEquals(
            listOf(
                "a-to-b/head.json", "a-to-b/secret.bin", "a-to-b/journal.log",
                "b-to-a/head.json", "b-to-a/secret.bin", "b-to-a/journal.log",
            ),
            paths,
        )
        // And the head a peer reads carries the CLI's frozen rollback object,
        // never an Android-specific witness class.
        val head = textAt(alice, headPath(FIXED_PAIR_ID, Direction.A_TO_B))
        assertTrue(head.contains("\"rollback\":{\"witnessClass\":\"none\",\"config\":{}}"))
    }

    /**
     * The courier container is the pad's wire format between installations. Its
     * exact bytes come from the released packContainer.
     */
    @Test
    fun courierContainerIsByteExact() {
        val v = V.obj("courier-container.json")
        val files = v.arr("files").map { it.asObj() }.map { CourierFile(it.str("path"), thex(it.str("bytesHex"))) }
        assertEquals(v.str("containerText"), String(packContainer(v.str("pairId"), files), Charsets.UTF_8))

        val back = unpackContainer(v.str("containerText").toByteArray(Charsets.UTF_8))
        assertTrue(back is UnpackResult.Ok)
        val ok = back as UnpackResult.Ok
        assertEquals(v.str("pairId"), ok.pairId)
        assertEquals(files.size, ok.files.size)
        for ((i, f) in ok.files.withIndex()) {
            assertEquals(files[i].path, f.path)
            assertEquals(bytesToHex(files[i].bytes), bytesToHex(f.bytes))
        }
    }

    /** A pad couriered out of Android and back in must survive unchanged. */
    @Test
    fun aPadRoundTripsThroughTheCourierContainer() {
        val alice = MemoryFs()
        val a = fixedEngine(alice)
        a.gen("round trip", traceSources(256, 4), 256, 4, witnessKind = WitnessKind.LOCAL)
        val container = a.exportPair(FIXED_PAIR_ID).container

        val bob = MemoryFs()
        val b = fixedEngine(bob)
        b.importPair("imported", container)

        for (d in Direction.entries) {
            assertEquals("head ${d.wire}", textAt(alice, headPath(FIXED_PAIR_ID, d)), textAt(bob, headPath(FIXED_PAIR_ID, d)))
            assertEquals(
                "secret ${d.wire}",
                bytesToHex(alice.readFile(secretPath(FIXED_PAIR_ID, d))!!),
                bytesToHex(bob.readFile(secretPath(FIXED_PAIR_ID, d))!!),
            )
            assertEquals("journal ${d.wire}", textAt(alice, journalPath(FIXED_PAIR_ID, d)), textAt(bob, journalPath(FIXED_PAIR_ID, d)))
        }
        // Bob's copy is `imported`; Alice's stays `generated-here`.
        assertEquals(PairOrigin.IMPORTED, readPairMeta(bob, FIXED_PAIR_ID).origin)
        assertEquals(PairOrigin.GENERATED_HERE, readPairMeta(alice, FIXED_PAIR_ID).origin)
        // And an envelope Alice burns opens on Bob's copy.
        val env = a.burn(FIXED_PAIR_ID, Party2.A, "over the wire".toByteArray()).envelope
        assertEquals("over the wire", String(b.open(FIXED_PAIR_ID, Party2.B, env).plaintext))
    }

    /**
     * The released open accepts EITHER spelling of the same envelope. An Android
     * build that could not open a TP2 paste would refuse messages the shipping
     * product produces.
     */
    @Test
    fun openAcceptsTheCompactSpellingOfTheSameEnvelope() {
        val alice = MemoryFs()
        val a = fixedEngine(alice)
        a.gen("compact", traceSources(256, 4), 256, 4)
        val container = a.exportPair(FIXED_PAIR_ID).container
        val bob = MemoryFs()
        val b = fixedEngine(bob)
        b.importPair("imported", container)

        val json = a.burn(FIXED_PAIR_ID, Party2.A, "compact please".toByteArray()).envelope
        val decoded = dev.systemslibrarian.truepad.core.decodeEnvelope2(json)
        val compact = dev.systemslibrarian.truepad.core.encodeCompactEnvelope2(
            (decoded as dev.systemslibrarian.truepad.core.EnvelopeDecode.Ok).envelope,
        )
        assertTrue(compact.startsWith("TP2:"))
        assertEquals("compact please", String(b.open(FIXED_PAIR_ID, Party2.B, compact).plaintext))
    }

    /** A pad this installation never provisioned is android-none, not an error. */
    @Test
    fun aBarePlacedStoreHasNoWitnessAndStillWorks() {
        val alice = MemoryFs()
        val a = fixedEngine(alice)
        a.gen("bare", traceSources(256, 4), 256, 4, witnessKind = WitnessKind.LOCAL)
        val container = a.exportPair(FIXED_PAIR_ID).container

        // Place the six FORMAT-V2 files directly, with no pair.json and no
        // witness journal — what copying a CLI store in looks like.
        val bare = MemoryFs()
        val unpacked = unpackContainer(container) as UnpackResult.Ok
        for (f in unpacked.files) bare.writeFileAtomic("$FIXED_PAIR_ID/${f.path}", f.bytes)
        assertNull(bare.readFile(pairMetaPath(FIXED_PAIR_ID)))

        val e = fixedEngine(bare)
        val meta = readPairMeta(bare, FIXED_PAIR_ID)
        assertEquals(WitnessKind.NONE, meta.witness)
        assertEquals(PairOrigin.UNKNOWN, meta.origin)
        val summary = e.status(FIXED_PAIR_ID)
        assertEquals(WitnessState.NA, summary.meters.getValue(Direction.A_TO_B).witnessState)
        // It still burns and opens; it simply claims no rollback protection.
        val env = e.burn(FIXED_PAIR_ID, Party2.A, "no witness here".toByteArray()).envelope
        assertTrue(env.contains("\"sequence\":0"))
    }
}
