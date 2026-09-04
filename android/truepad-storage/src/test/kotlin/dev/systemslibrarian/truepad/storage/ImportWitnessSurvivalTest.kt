package dev.systemslibrarian.truepad.storage

import dev.systemslibrarian.truepad.core.requiredSourceLength
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * AN IMPORT MUST NOT DESTROY A SURVIVING ROLLBACK WITNESS.
 *
 * The Android witness lives in a DIFFERENT failure domain from the store —
 * `getNoBackupFilesDir()` against `getFilesDir()` — and that separation is the
 * whole of §15.2. Anything that clears the store without clearing the no-backup
 * directory leaves a witness that still remembers what this device has spent.
 *
 * `discardIncompleteImport` used to delete that journal, faithfully ported from
 * the Browser Edition, where it is harmless: the browser's witness shares the
 * store's OPFS domain and cannot outlive it. On Android and iOS it is NOT
 * harmless — it deletes the one piece of evidence engineered to outlive the
 * store, so importing an OLDER bundle re-bootstraps at the rewound counters and
 * already-spent material becomes usable again.
 *
 * Keeping the journal cannot block a legitimate retry: it is append-only and
 * reconciliation takes the MAXIMUM, so re-importing the SAME bundle reads
 * aligned while re-importing an OLDER one reads `witness-regressed`.
 *
 * LOSS IS ACCEPTABLE; REUSE IS NOT.
 */
class ImportWitnessSurvivalTest {

    /** A genesis bundle for a fresh pad, exported before anything is consumed. */
    private fun genesisBundle(): ByteArray {
        val aliceFs = MemoryFs()
        val alice = fixedEngine(aliceFs)
        val need = requiredSourceLength(256, 4).toInt()
        alice.gen(
            "witness-survival",
            listOf(SourceInput("s.bin", "declared", genBytes(need, 21))),
            256, 4, witnessKind = WitnessKind.LOCAL,
        )
        return alice.exportPair(FIXED_PAIR_ID).container
    }

    @Test
    fun reimportingAnOlderBundleOverASurvivingWitnessIsRefused() {
        val bundle = genesisBundle()
        val witness = MemoryFs() // the OTHER failure domain
        val store = MemoryFs()

        fixedEngine(store, witnessFs = witness).importPair("from Alice", bundle)
        fixedEngine(store, witnessFs = witness).burn(FIXED_PAIR_ID, Party2.B, "spent".toByteArray())

        // The STORE is cleared; the witness is in another domain and survives.
        val wiped = MemoryFs()
        assertTrue(
            "the witness is NOT in the store's domain",
            witness.exists(witnessLogPath(FIXED_PAIR_ID)),
        )

        fixedEngine(wiped, witnessFs = witness).importPair("rewind", bundle)

        val refusal = refusalOf {
            fixedEngine(wiped, witnessFs = witness).burn(FIXED_PAIR_ID, Party2.B, "reuse?".toByteArray())
        }
        assertEquals(
            "a surviving witness must refuse pad material this device has already spent",
            "witness-regressed", refusal.reason,
        )
    }

    /** The legitimate case still works: re-importing the SAME bundle is aligned. */
    @Test
    fun reimportingTheSameUnconsumedBundleAfterAStoreWipeStillWorks() {
        val bundle = genesisBundle()
        val witness = MemoryFs()
        val store = MemoryFs()

        fixedEngine(store, witnessFs = witness).importPair("first", bundle)
        val wiped = MemoryFs()
        val summary = fixedEngine(wiped, witnessFs = witness).importPair("again", bundle)

        assertEquals(FIXED_PAIR_ID, summary.pairId)
        assertTrue(
            "an unconsumed re-import is aligned, not refused",
            summary.meters.values.all { it.witnessState == WitnessState.ALIGNED },
        )
    }

    /** And an INTERRUPTED import is still retryable — the reason the cleanup exists. */
    @Test
    fun anInterruptedImportIsStillRetryable() {
        val bundle = genesisBundle()
        val witness = MemoryFs()
        val store = MemoryFs()

        val failing = FailOnceOnWrite(store) { it.endsWith(PAIR_META_FILE) }
        try {
            fixedEngine(failing, witnessFs = witness).importPair("interrupted", bundle)
        } catch (_: Exception) {
            // expected: the commit write fails, leaving the marker in place
        }

        assertTrue(
            "the marker is present, so the pair is not active",
            store.exists(importMarkerPath(FIXED_PAIR_ID)),
        )
        val summary = fixedEngine(store, witnessFs = witness).importPair("retry", bundle)
        assertEquals(PairOrigin.IMPORTED, summary.origin)
        assertFalse(store.exists(importMarkerPath(FIXED_PAIR_ID)))
    }

    /** Fails the first atomic write matching the predicate, then behaves normally. */
    private class FailOnceOnWrite(
        private val inner: Fs,
        private val failWhen: (String) -> Boolean,
    ) : Fs {
        private var fired = false
        override fun readFile(path: String) = inner.readFile(path)
        override fun writeFileAtomic(path: String, data: ByteArray) {
            if (!fired && failWhen(path)) {
                fired = true
                throw IllegalStateException("simulated write failure: $path")
            }
            inner.writeFileAtomic(path, data)
        }
        override fun appendFile(path: String, data: ByteArray) = inner.appendFile(path, data)
        override fun readRange(path: String, offset: Long, length: Int) = inner.readRange(path, offset, length)
        override fun writeRange(path: String, offset: Long, data: ByteArray) = inner.writeRange(path, offset, data)
        override fun exists(path: String) = inner.exists(path)
        override fun remove(path: String) = inner.remove(path)
        override fun size(path: String) = inner.size(path)
        override fun list(prefix: String) = inner.list(prefix)
        override fun <T> withLock(scope: String, body: () -> T): T = inner.withLock(scope, body)
    }
}
