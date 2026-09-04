import Foundation

/* ============================================================================
 * The comparison wordlist — the BIP-39 English list, vendored.
 *
 * THESE ARE NOT MNEMONICS. TruePad uses this list as a human-readable encoding of
 * fixed 11-bit indices and nothing else. It does not create BIP-39 wallet
 * mnemonics, apply BIP-39 checksum rules, derive seeds, or accept a phrase typed
 * by a user. NOTHING HERE IS KEY MATERIAL. The words exist so that two people can
 * say twelve or eight things aloud and notice if they differ.
 *
 * INDEX POSITION IS THE PROTOCOL MAPPING. The confirmation ceremony compares the
 * SAME words on both devices, so this list must equal the Browser and Android
 * Editions' line for line. The resource is byte-identical to
 * src/browser/ui/wordlist/english.txt and android's comparison-words.txt, and
 * ComparisonWordsTests pins its SHA-256 — the same value Android pins — so a
 * build that ever diverges FAILS rather than silently disagreeing about a
 * fingerprint two people are reading to each other.
 *
 * Provenance, integrity and licence: see COMPARISON-WORDS-PROVENANCE.md beside
 * the resource (MIT; upstream bitcoin/bips bip-0039/english.txt).
 * ========================================================================= */

public enum ComparisonWords {
    /// Exactly 2048 words: an 11-bit index space, because the fingerprints emit
    /// 11-bit indices. Index 0 is "abandon"; index 2047 is "zoo".
    public static let count = 2048

    public enum Failure: Error, Equatable {
        case resourceMissing
        case wrongLength(Int)
        case malformedEntry(Int)
    }

    /// The list, loaded once and verified in SHAPE at load, so a corrupt or
    /// wrong-length resource fails closed rather than producing short phrases.
    public static let words: [String] = {
        guard let loaded = try? load() else {
            // A build without the resource cannot do the ceremony at all, and
            // must not fall back to anything. An empty list makes every lookup
            // refuse rather than return a plausible wrong word.
            return []
        }
        return loaded
    }()

    static func load() throws -> [String] {
        guard let url = Bundle.module.url(forResource: "comparison-words", withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8) else {
            throw Failure.resourceMissing
        }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard lines.count == count else { throw Failure.wrongLength(lines.count) }
        for (i, word) in lines.enumerated() {
            // ASCII lowercase letters only. Anything else means the resource was
            // re-encoded or edited, and two devices could then read different
            // things aloud while believing they agreed.
            guard !word.isEmpty, word.allSatisfy({ $0.isASCII && $0.isLowercase && $0.isLetter }) else {
                throw Failure.malformedEntry(i)
            }
        }
        return lines
    }

    /// The words for a list of 11-bit indices.
    ///
    /// Returns nil if ANY index is out of range or the list failed to load —
    /// never a partial phrase. A ceremony with a missing word is a ceremony where
    /// one side reads eleven and the other twelve, and notices too late.
    public static func render(_ indices: [Int]) -> [String]? {
        let list = words
        guard list.count == count else { return nil }
        var out: [String] = []
        out.reserveCapacity(indices.count)
        for index in indices {
            guard index >= 0, index < count else { return nil }
            out.append(list[index])
        }
        return out
    }
}
