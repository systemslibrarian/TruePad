package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.core.requiredSourceLength
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Android rollback witness (§15).
 *
 * Two things are being tested, and they are different. One is CRASH SAFETY: a
 * torn append must cost only its own record, never a neighbour's. The other is
 * ROLLBACK DETECTION: a store restored from a backup must be caught before it
 * can reuse anything — which is only possible because the journal lives in a
 * different failure domain from the store.
 */
class WitnessTest {

    private fun pairWithSplitDomains(): Triple<MemoryFs, MemoryFs, Engine> {
        val store = MemoryFs()
        val noBackup = MemoryFs() // the app binds this to Context.getNoBackupFilesDir()
        val e = fixedEngine(store, witnessFs = noBackup)
        val need = requiredSourceLength(512, 8).toInt()
        e.gen("split", listOf(SourceInput("s", "o", genBytes(need, 5))), 512, 8, witnessKind = WitnessKind.LOCAL)
        return Triple(store, noBackup, e)
    }

    /**
     * THE ANDROID DECISION, tested. Android Auto Backup and device-to-device
     * transfer take getFilesDir() and NOT getNoBackupFilesDir(). Restoring the
     * store therefore meets a witness that still remembers the true high-water.
     */
    @Test
    fun aWitnessOutsideTheBackupDomainCatchesARestoredStore() {
        val (store, noBackup, e) = pairWithSplitDomains()
        // What a backup captures: the store tree only.
        val backup = snapshot(store, allPaths(store, FIXED_PAIR_ID))
        assertNull("the witness is NOT in the backed-up tree", store.readFile(witnessLogPath(FIXED_PAIR_ID)))
        assertTrue("it is in the no-backup tree", noBackup.exists(witnessLogPath(FIXED_PAIR_ID)))

        e.burn(FIXED_PAIR_ID, Party2.A, "spend some".toByteArray())
        e.burn(FIXED_PAIR_ID, Party2.A, "spend more".toByteArray())

        // Restore the backup. Every store file goes back; the witness does not.
        restore(store, backup)
        val restored = fixedEngine(store, witnessFs = noBackup)
        assertEquals(
            "witness-regressed",
            refusalOf { restored.burn(FIXED_PAIR_ID, Party2.A, "would reuse offset 0".toByteArray()) }.reason,
        )
        assertEquals(
            WitnessState.REGRESSED,
            restored.status(FIXED_PAIR_ID).meters.getValue(Direction.A_TO_B).witnessState,
        )
    }

    /**
     * The honest counter-case, stated as a test so it cannot be quietly forgotten:
     * a witness sharing the store's tree is restored WITH it and knows nothing.
     * This is the §15.2 caveat, and it is why the app must split the domains.
     */
    @Test
    fun aWitnessInsideTheBackupDomainCannotDetectTheRollback() {
        val fs = MemoryFs()
        val e = fixedEngine(fs) // witnessFs defaults to fs — the weak configuration
        val need = requiredSourceLength(512, 8).toInt()
        e.gen("same-domain", listOf(SourceInput("s", "o", genBytes(need, 5))), 512, 8, witnessKind = WitnessKind.LOCAL)
        val backup = snapshot(fs, allPaths(fs, FIXED_PAIR_ID)) // includes witness/
        e.burn(FIXED_PAIR_ID, Party2.A, "spend".toByteArray())
        restore(fs, backup)
        // The witness went back too, so the store is aligned with it and the
        // rollback is invisible. Nothing here is a bug; it is the reason the
        // Engine takes a separate witnessFs at all.
        val after = fixedEngine(fs)
        assertEquals(WitnessState.ALIGNED, after.status(FIXED_PAIR_ID).meters.getValue(Direction.A_TO_B).witnessState)
        after.burn(FIXED_PAIR_ID, Party2.A, "reuses offset 0".toByteArray())
    }

    /**
     * Leading-newline framing is what makes a torn append harmless. A partial
     * record must be an isolated line the reader drops — never one fused with the
     * record before or after it, which trailing framing would allow.
     */
    @Test
    fun aTornAppendCostsOnlyItsOwnRecord() {
        val (store, noBackup, e) = pairWithSplitDomains()
        e.burn(FIXED_PAIR_ID, Party2.A, "one".toByteArray())
        e.burn(FIXED_PAIR_ID, Party2.A, "two".toByteArray())
        val whole = textAt(noBackup, witnessLogPath(FIXED_PAIR_ID))
        assertTrue("records are LEADING-newline framed", whole.startsWith("\n"))
        assertTrue("and never trailing-newline terminated", !whole.endsWith("\n"))

        // Tear the last record mid-write, as a crash inside appendFile would.
        noBackup.writeFileAtomic(witnessLogPath(FIXED_PAIR_ID), (whole.dropLast(9)).toByteArray())
        val torn = fixedEngine(store, witnessFs = noBackup)
        // The surviving records still bound the store, and the next clean advance
        // re-records the true high-water — the witness self-heals.
        val state = torn.status(FIXED_PAIR_ID).meters.getValue(Direction.A_TO_B).witnessState
        assertTrue("a torn tail must not read as regressed or inconsistent", state == WitnessState.AHEAD || state == WitnessState.ALIGNED)
        torn.burn(FIXED_PAIR_ID, Party2.A, "three".toByteArray())
        assertEquals(WitnessState.ALIGNED, torn.status(FIXED_PAIR_ID).meters.getValue(Direction.A_TO_B).witnessState)
    }

    /** Garbage in the middle of the journal is skipped, not fatal. */
    @Test
    fun malformedRecordsAreSkippedAndTheMaximumStillHolds() {
        val (store, noBackup, e) = pairWithSplitDomains()
        e.burn(FIXED_PAIR_ID, Party2.A, "advance".toByteArray())
        val whole = textAt(noBackup, witnessLogPath(FIXED_PAIR_ID))
        noBackup.writeFileAtomic(
            witnessLogPath(FIXED_PAIR_ID),
            (whole + "\nnot json\n{\"d\":\"A->B\"}\n{\"d\":\"A->B\",\"eno\":0,\"ans\":0,\"ar\":0,\"extra\":1}").toByteArray(),
        )
        // None of those three lines parses as a witness record, so the fold is
        // unchanged and a LOWER counter in a junk line cannot pull the max down.
        val e2 = fixedEngine(store, witnessFs = noBackup)
        assertEquals(WitnessState.ALIGNED, e2.status(FIXED_PAIR_ID).meters.getValue(Direction.A_TO_B).witnessState)
        e2.burn(FIXED_PAIR_ID, Party2.A, "still fine".toByteArray())
    }

    /**
     * An ESTABLISHED witness is never read as fresh. A pair whose pair.json says
     * it is provisioned, but whose journal has vanished, fails CLOSED — because a
     * vanished witness is indistinguishable from a rollback that took it.
     */
    @Test
    fun aVanishedWitnessFailsClosed() {
        val (store, noBackup, _) = pairWithSplitDomains()
        noBackup.remove(witnessLogPath(FIXED_PAIR_ID))
        val e = fixedEngine(store, witnessFs = noBackup)
        val r = refusalOf { e.burn(FIXED_PAIR_ID, Party2.A, "nope".toByteArray()) }
        assertEquals("witness-inconsistent", r.reason)
        assertTrue(r.text.contains("never treated as fresh"))
        assertTrue(r.text.contains("Nothing was burned"))

        // An empty file is the same answer: emptiness is not bootstrap.
        noBackup.writeFileAtomic(witnessLogPath(FIXED_PAIR_ID), ByteArray(0))
        assertEquals("witness-inconsistent", refusalOf { fixedEngine(store, witnessFs = noBackup).burn(FIXED_PAIR_ID, Party2.A, "nope".toByteArray()) }.reason)

        // So is a journal that has lost only ONE direction's record.
        noBackup.writeFileAtomic(
            witnessLogPath(FIXED_PAIR_ID),
            "\n{\"d\":\"B->A\",\"eno\":0,\"ans\":0,\"ar\":0}".toByteArray(),
        )
        val oneSided = refusalOf { fixedEngine(store, witnessFs = noBackup).burn(FIXED_PAIR_ID, Party2.A, "nope".toByteArray()) }
        assertEquals("witness-inconsistent", oneSided.reason)
        assertTrue(oneSided.text.contains("no record for A->B"))
    }

    /** An import seeds the witness at the imported high-waters, not at zero. */
    @Test
    fun importBootstrapsTheWitnessToTheImportedState() {
        val (store, noBackup, alice) = pairWithSplitDomains()
        alice.burn(FIXED_PAIR_ID, Party2.A, "used already".toByteArray())
        // A pad exported mid-life carries its advanced counters. Seeding the
        // witness at zero would leave the receiver permanently "ahead"; seeding it
        // at the imported state means a later rollback of THAT is still caught.
        val container = alice.exportPair(FIXED_PAIR_ID).container

        val bobStore = MemoryFs()
        val bobNoBackup = MemoryFs()
        fixedEngine(bobStore, witnessFs = bobNoBackup).importPair("bob", container)
        val bob = fixedEngine(bobStore, witnessFs = bobNoBackup)
        assertEquals(WitnessState.ALIGNED, bob.status(FIXED_PAIR_ID).meters.getValue(Direction.A_TO_B).witnessState)

        val backup = snapshot(bobStore, allPaths(bobStore, FIXED_PAIR_ID))
        bob.burn(FIXED_PAIR_ID, Party2.B, "bob replies".toByteArray())
        restore(bobStore, backup)
        assertEquals(
            "witness-regressed",
            refusalOf { fixedEngine(bobStore, witnessFs = bobNoBackup).burn(FIXED_PAIR_ID, Party2.B, "again".toByteArray()) }.reason,
        )
    }

    /** android-none claims nothing, and says so rather than pretending. */
    @Test
    fun theNoneWitnessIsANoOpAndReportsNotApplicable() {
        val store = MemoryFs()
        val e = fixedEngine(store)
        val need = requiredSourceLength(256, 4).toInt()
        e.gen("none", listOf(SourceInput("s", "o", genBytes(need, 2))), 256, 4, witnessKind = WitnessKind.NONE)
        assertNull("no journal is created", store.readFile(witnessLogPath(FIXED_PAIR_ID)))
        assertEquals(WitnessKind.NONE, readPairMeta(store, FIXED_PAIR_ID).witness)
        val m = e.status(FIXED_PAIR_ID).meters.getValue(Direction.A_TO_B)
        assertEquals(WitnessState.NA, m.witnessState)
        // A rollback is NOT caught here, and the meter never claims it was.
        val backup = snapshot(store, allPaths(store, FIXED_PAIR_ID))
        e.burn(FIXED_PAIR_ID, Party2.A, "spend".toByteArray())
        restore(store, backup)
        fixedEngine(store).burn(FIXED_PAIR_ID, Party2.A, "reuses".toByteArray())
    }

    /**
     * pair.json's witness field is LOAD-BEARING: it decides whether a rollback
     * witness applies. A corrupt one must fail closed rather than default to
     * "no witness", which would silently bypass a provisioned one.
     */
    @Test
    fun aCorruptPairJsonFailsClosedRatherThanAssumingNoWitness() {
        val (store, noBackup, _) = pairWithSplitDomains()
        for (bad in listOf("{", "[]", "{\"witness\":\"browser-local-witness\"}", "{\"witness\":null}", "{}")) {
            store.writeFileAtomic(pairMetaPath(FIXED_PAIR_ID), bad.toByteArray())
            val r = refusalOf { fixedEngine(store, witnessFs = noBackup).burn(FIXED_PAIR_ID, Party2.A, "x".toByteArray()) }
            assertEquals("pair.json = $bad must fail closed", "corrupt-pair-meta", r.reason)
        }
        // An unrecognised PROVENANCE is corruption too — guessing in the direction
        // that permits forwarding is how a pad ends up in two hands.
        store.writeFileAtomic(
            pairMetaPath(FIXED_PAIR_ID),
            "{\"pairId\":\"$FIXED_PAIR_ID\",\"label\":\"x\",\"createdAt\":\"\",\"witness\":\"android-local-witness\",\"origin\":\"borrowed\"}".toByteArray(),
        )
        assertEquals(
            "corrupt-pair-meta",
            refusalOf { fixedEngine(store, witnessFs = noBackup).exportPair(FIXED_PAIR_ID) }.reason,
        )
    }

    /** The record shape is frozen at exactly three counters (§15.1, ledger N17). */
    @Test
    fun theWitnessRecordCarriesExactlyTheThreeFrozenCounters() {
        val bytes = encodeWitnessRecord(Direction.A_TO_B, WitnessCounters(7, 3, 11))
        assertEquals("\n{\"d\":\"A->B\",\"eno\":7,\"ans\":3,\"ar\":11}", String(bytes, Charsets.UTF_8))
        // Never pad contents, keys, masks, plaintext, or ciphertext — the
        // content-confidentiality half of the §15.1 claim.
        val text = String(bytes, Charsets.UTF_8)
        assertEquals(4, Regex("\"[a-z]+\":").findAll(text).count())
    }
}
