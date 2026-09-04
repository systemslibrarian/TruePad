import CryptoKit
import Foundation
@testable import TruePadSPT
import XCTest

/// THE WORDS TWO PEOPLE READ TO EACH OTHER MUST BE THE SAME WORDS.
///
/// Index position IS the protocol mapping: the fingerprints emit 11-bit indices,
/// and the ceremony compares the words those indices name on two different
/// devices, possibly two different editions. If the lists differ by one line, two
/// people reading aloud would disagree about a transfer that is actually fine —
/// or, far worse, agree about one that is not.
///
/// So the list is pinned by SHA-256 to THE SAME VALUE Android pins, and that value
/// is the hash of the Browser Edition's file. Nothing here is key material: the
/// words are a human-readable encoding of indices and nothing else.
final class ComparisonWordsTests: XCTestCase {
    /// The SHA-256 recorded in COMPARISON-WORDS-PROVENANCE.md, pinned identically
    /// by Android's ComparisonWordsTest and equal to the hash of
    /// src/browser/ui/wordlist/english.txt.
    let pinnedSha256 = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"

    func resourceURL() throws -> URL {
        try XCTUnwrap(Bundle.module.url(forResource: "comparison-words", withExtension: "txt"),
                      "the vendored wordlist is missing from the build")
    }

    func testTheVendoredListMatchesItsPinnedHash() throws {
        let bytes = try Data(contentsOf: try resourceURL())
        let hex = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(hex, pinnedSha256,
                       "the vendored wordlist must match its pinned SHA-256 — the SAME value "
                       + "Android pins, so the two editions cannot disagree about a fingerprint")
    }

    /// And it is byte-identical to the Browser Edition's file, checked against the
    /// actual file rather than against a hash I could have copied wrong.
    func testTheListIsByteIdenticalToTheBrowserEditions() throws {
        let browser = XWingKATTests.repoRoot
            .appendingPathComponent("src/browser/ui/wordlist/english.txt")
        let mine = try Data(contentsOf: try resourceURL())
        XCTAssertEqual(mine, try Data(contentsOf: browser),
                       "the iOS list must be the Browser Edition's file, byte for byte")
    }

    func testTheListIsExactlyTheElevenBitIndexSpace() throws {
        let words = try ComparisonWords.load()
        XCTAssertEqual(words.count, 2048, "an 11-bit index space is exactly 2048 entries")
        XCTAssertEqual(words.first, "abandon")
        XCTAssertEqual(words.last, "zoo")
        XCTAssertEqual(Set(words).count, words.count, "no word may appear at two indices")
        for (i, word) in words.enumerated() {
            XCTAssertTrue(word.allSatisfy { $0.isASCII && $0.isLowercase && $0.isLetter },
                          "entry \(i) is not plain lowercase ASCII: \(word)")
        }
        // Sorted, which is what makes a disagreement easy to spot by eye.
        XCTAssertEqual(words, words.sorted(), "the list must stay in its upstream order")
    }

    func testRenderingMapsIndicesToWordsInOrder() {
        XCTAssertEqual(ComparisonWords.render([0, 2047, 1]), ["abandon", "zoo", "ability"])
        XCTAssertEqual(ComparisonWords.render([]), [])
    }

    /// AN OUT-OF-RANGE INDEX RENDERS NOTHING, not a short phrase. A ceremony where
    /// one side reads eleven words and the other twelve is a ceremony that fails
    /// in the worst possible way: quietly, and only after the fact.
    func testAnyBadIndexRendersNothingRatherThanAPartialPhrase() {
        for bad in [[0, 2048], [-1], [0, 1, 2, -5], [Int.max]] {
            XCTAssertNil(ComparisonWords.render(bad), "\(bad) must render nothing at all")
        }
    }

    /// The twelve request words and the eight confirmation words are what the
    /// ceremony actually shows, so both must render completely.
    func testTheCeremonyLengthsRenderCompletely() throws {
        let requestHash = [UInt8](repeating: 0x5A, count: 32)
        let request = try SptFingerprint.requestIndices132(requestHash)
        XCTAssertEqual(request.count, 12)
        XCTAssertEqual(ComparisonWords.render(request)?.count, 12)

        let confirmValue = [UInt8](repeating: 0xA5, count: SptConstants.confirmValueBytes)
        let confirmation = try SptFingerprint.confirmationIndices88(confirmValue)
        XCTAssertEqual(confirmation.count, 8)
        XCTAssertEqual(ComparisonWords.render(confirmation)?.count, 8)
    }

    /// Every index the fingerprints can emit must be in range, for any input.
    func testEveryIndexAFingerprintCanEmitIsRenderable() throws {
        for seed in 0..<200 {
            var hash = [UInt8](repeating: 0, count: 32)
            for i in 0..<32 { hash[i] = UInt8((seed &* 31 &+ i &* 7) & 0xff) }
            let indices = try SptFingerprint.requestIndices132(hash)
            XCTAssertNotNil(ComparisonWords.render(indices),
                            "seed \(seed) produced an index outside the wordlist")
            for index in indices {
                XCTAssertTrue((0..<2048).contains(index), "index \(index) is not 11-bit")
            }
        }
    }
}
