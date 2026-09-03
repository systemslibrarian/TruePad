package dev.systemslibrarian.truepad.spt

/* ============================================================================
 * The comparison wordlist — the BIP-39 English list, vendored.
 * ----------------------------------------------------------------------------
 * THESE ARE NOT MNEMONICS. TruePad uses this list as a human-readable encoding
 * of fixed 11-bit indices and nothing else. It does not create BIP-39 wallet
 * mnemonics, apply BIP-39 checksum rules, derive seeds, or accept a phrase
 * typed by a user. Nothing here is key material; the words exist so two people
 * can say twelve or eight things aloud and notice if they differ.
 *
 * INDEX POSITION IS THE PROTOCOL MAPPING. The confirmation ceremony compares
 * the SAME words on both devices, so the Kotlin list must equal the Browser
 * Edition's COMPARISON_WORDS line for line. It is loaded from the vendored
 * `comparison-words.txt` resource (byte-identical to src/browser/ui/wordlist/
 * english.txt), and ComparisonWordsTest pins its SHA-256 and shape so a build
 * that ever diverges fails rather than silently disagreeing about a fingerprint.
 *
 * Provenance, integrity and licence: see COMPARISON-WORDS-PROVENANCE.md beside
 * the resource (MIT; upstream bitcoin/bips bip-0039/english.txt).
 * ========================================================================= */

/** The 2048-entry comparison wordlist, index-addressed. Loaded once, verified
 *  in shape at load so a corrupt or wrong-length resource fails closed. */
object ComparisonWords {

    /** Resource path, relative to this class's package on the classpath. */
    private const val RESOURCE = "/comparison-words.txt"

    /** Exactly 2048 words: an 11-bit index space (the fingerprints emit 11-bit
     *  indices), index 0 = "abandon" … index 2047 = "zoo". */
    const val COUNT: Int = 2048

    val words: List<String> by lazy { load() }

    private fun load(): List<String> {
        val stream = ComparisonWords::class.java.getResourceAsStream(RESOURCE)
            ?: error("comparison wordlist resource $RESOURCE is missing from the build")
        val lines = stream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            .split('\n')
            // The vendored file ends with a trailing newline, so the split yields
            // one empty tail element; drop only a single trailing empty entry.
            .let { if (it.isNotEmpty() && it.last().isEmpty()) it.dropLast(1) else it }
        require(lines.size == COUNT) { "comparison wordlist must hold $COUNT words, found ${lines.size}" }
        return lines
    }

    /** The word for one 11-bit index. Refuses an out-of-range index rather than
     *  wrapping or clamping — a bad index is a protocol error, not a display one. */
    fun wordAt(index: Int): String {
        require(index in 0 until COUNT) { "comparison index $index is outside 0..${COUNT - 1}" }
        return words[index]
    }

    /** Render a run of indices (the twelve request words, the eight confirmation
     *  words) as their words, in order — order is part of the ceremony. */
    fun wordsFor(indices: IntArray): List<String> = indices.map { wordAt(it) }
}
