import Foundation
import TruePadCore
@testable import TruePadStorage
import XCTest

/// The iOS witness failure domain.
///
/// WHAT THESE TESTS COVER, AND WHAT THEY CANNOT. The data-protection Keychain —
/// the one that honours `ThisDeviceOnly` — returns `errSecMissingEntitlement`
/// (-34018) to an unsigned binary. That was measured, not assumed, so neither
/// `swift test` nor CI can exercise `SystemKeychainBackend`. These tests therefore
/// cover the LOGIC through an injected backend: the path guard, the fold, the
/// compaction, and the rollback behaviour that separation is FOR.
///
/// The platform behaviour — that a `ThisDeviceOnly` item really does not migrate
/// in a restore — is an Apple contract this code relies on and cannot verify
/// here. It stays on the physical-iPhone gate. Nothing in this file should be read
/// as evidence for it.
final class KeychainWitnessTests: XCTestCase {
    let pairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"

    func hw(_ o: Int, _ s: Int, _ a: Int) -> StoreHighWaters {
        StoreHighWaters(nextOffset: o, nextSequence: s, attemptsReserved: a)
    }

    // MARK: - pad material can never reach the Keychain

    /// The structural guarantee. This store accepts ONE path shape; every store
    /// path — above all `secret.bin` — is refused outright, so a mis-wiring is an
    /// immediate error rather than a silent secret leak.
    func testOnlyWitnessJournalPathsAreAccepted() throws {
        let fs = KeychainWitnessFs(backend: InMemoryKeychainBackend())

        XCTAssertNoThrow(try fs.appendFile("witness/\(pairId).log", [1, 2, 3]))

        for forbidden in [
            "\(pairId)/a-to-b/secret.bin",
            "\(pairId)/a-to-b/head.json",
            "\(pairId)/a-to-b/journal.log",
            "\(pairId)/handoff.json",
            "\(pairId)/pair.json",
            "\(pairId)/destroyed.json",
            "witness/not-hex.log",
            "witness/\(pairId).json",
            "witness/\(pairId)",
            "\(pairId).log",
            "",
        ] {
            XCTAssertThrowsError(try fs.appendFile(forbidden, [0]),
                                 "path \(forbidden) must be refused") { error in
                guard case KeychainWitnessError.pathNotAWitnessJournal = error else {
                    return XCTFail("\(forbidden): expected pathNotAWitnessJournal, got \(error)")
                }
            }
            XCTAssertThrowsError(try fs.readFile(forbidden))
        }
    }

    /// It is not a general filesystem and refuses to pretend to be one. Binding it
    /// as the STORE's Fs must fail loudly at the first write, not corrupt state.
    func testStoreOperationsAreRefused() throws {
        let fs = KeychainWitnessFs(backend: InMemoryKeychainBackend())
        XCTAssertThrowsError(try fs.writeFileAtomic("witness/\(pairId).log", [1]))
        XCTAssertThrowsError(try fs.readRange("witness/\(pairId).log", offset: 0, length: 1))
        XCTAssertThrowsError(try fs.writeRange("witness/\(pairId).log", offset: 0, data: [1]))
        XCTAssertThrowsError(try fs.list("witness"))
    }

    // MARK: - it behaves as a witness backing

    func testTheWitnessWorksOverTheKeychainBacking() throws {
        let fs = KeychainWitnessFs(backend: InMemoryKeychainBackend())
        let w = LocalWitness(fs: fs)
        try w.bootstrap(pairId: pairId, initial: nil)

        guard case .ok(.aligned) = w.preflight(pairId: pairId, direction: .aToB,
                                               store: hw(0, 0, 0)) else {
            return XCTFail("a bootstrapped witness should be aligned at genesis")
        }
        try w.advance(pairId: pairId, direction: .aToB,
                      counters: WitnessCounters(encryptionNextOffset: 256,
                                                authenticationNextSequence: 3,
                                                attemptsReserved: 2))
        guard case .refused(let reason, _) = w.preflight(pairId: pairId, direction: .aToB,
                                                         store: hw(0, 0, 0)) else {
            return XCTFail("a rewound store must be refused")
        }
        XCTAssertEqual(reason, "witness-regressed")
    }

    /// THE POINT OF THE WHOLE FILE. Wipe the app container — the shape of a
    /// restore, a reinstall, or a copied container — and the Keychain-backed
    /// witness still remembers, so the rewind is caught.
    func testWipingTheContainerDoesNotWipeTheWitness() throws {
        let keychain = InMemoryKeychainBackend()
        var container = MemoryFs()          // the store's domain
        let witnessFs = KeychainWitnessFs(backend: keychain)
        let w = LocalWitness(fs: witnessFs)

        try w.bootstrap(pairId: pairId, initial: nil)
        try container.writeFileAtomic("\(pairId)/a-to-b/head.json", Array("spent".utf8))
        try w.advance(pairId: pairId, direction: .aToB,
                      counters: WitnessCounters(encryptionNextOffset: 4096,
                                                authenticationNextSequence: 32,
                                                attemptsReserved: 9))

        // The container is replaced wholesale by an older one.
        container = MemoryFs()
        XCTAssertTrue(container.allPaths.isEmpty, "the container is gone")
        XCTAssertFalse(keychain.accounts.isEmpty, "the witness is NOT in the container")

        guard case .refused(let reason, _) = w.preflight(pairId: pairId, direction: .aToB,
                                                         store: hw(0, 0, 0)) else {
            return XCTFail("a container rollback must be caught by an out-of-container witness")
        }
        XCTAssertEqual(reason, "witness-regressed")
    }

    /// The contrast, kept deliberately. A witness sharing the container's domain
    /// is carried by whatever carries the container, and detects NOTHING. This
    /// passing is the point: it is what makes the Keychain path worth having.
    func testTheSameDomainWitnessStillCannotDetectTheSameRewind() throws {
        var shared = MemoryFs()
        let w = LocalWitness(fs: shared)
        try w.bootstrap(pairId: pairId, initial: nil)
        try w.advance(pairId: pairId, direction: .aToB,
                      counters: WitnessCounters(encryptionNextOffset: 4096,
                                                authenticationNextSequence: 32,
                                                attemptsReserved: 9))

        // Restore the container AND the witness together — one domain, one fate.
        shared = MemoryFs()
        let restored = LocalWitness(fs: shared)
        try restored.bootstrap(pairId: pairId, initial: nil)

        guard case .ok(.aligned) = restored.preflight(pairId: pairId, direction: .aToB,
                                                      store: hw(0, 0, 0)) else {
            return XCTFail("the same-domain configuration cannot detect this rewind; if it "
                           + "ever can, docs/IOS-SECURITY.md §5 must be updated")
        }
    }

    /// A witness that vanishes is never read as fresh — the fail-closed half.
    /// This matters more on iOS than Android, because Apple states that Keychain
    /// survival across app deletion is an implementation detail not to be relied
    /// upon, so "the witness is gone" is a case that WILL occur.
    func testAVanishedKeychainWitnessFailsClosed() throws {
        let keychain = InMemoryKeychainBackend()
        let fs = KeychainWitnessFs(backend: keychain)
        let w = LocalWitness(fs: fs)
        try w.bootstrap(pairId: pairId, initial: nil)
        try keychain.delete(account: pairId)

        guard case .refused(let reason, _) = w.preflight(pairId: pairId, direction: .aToB,
                                                         store: hw(0, 0, 0)) else {
            return XCTFail("a vanished witness must fail closed, never read as fresh")
        }
        XCTAssertEqual(reason, "witness-inconsistent")
    }

    // MARK: - compaction

    /// A Keychain item cannot grow without bound, and an item that grows until a
    /// write fails would take the witness down at the worst moment. Compaction
    /// folds the journal to its per-direction maximum — the same fold
    /// reconciliation already performs, pre-computed — so it can only move the
    /// recorded high-water UP and can never mask a rollback.
    func testCompactionPreservesTheHighWaterExactly() throws {
        let keychain = InMemoryKeychainBackend()
        let fs = KeychainWitnessFs(backend: keychain, compactionThreshold: 512)
        let w = LocalWitness(fs: fs)
        try w.bootstrap(pairId: pairId, initial: nil)

        for i in 1...200 {
            try w.advance(pairId: pairId, direction: .aToB,
                          counters: WitnessCounters(encryptionNextOffset: i * 16,
                                                    authenticationNextSequence: i,
                                                    attemptsReserved: i))
        }
        let stored = try XCTUnwrap(try fs.readFile("witness/\(pairId).log"))
        XCTAssertLessThan(stored.count, 512 + 256, "the journal must stay bounded")

        // The high-water survives exactly: at it, aligned; one below, refused.
        guard case .ok(.aligned) = w.preflight(pairId: pairId, direction: .aToB,
                                               store: hw(3200, 200, 200)) else {
            return XCTFail("compaction must preserve the exact high-water")
        }
        guard case .refused(let reason, _) = w.preflight(pairId: pairId, direction: .aToB,
                                                         store: hw(3199, 200, 200)) else {
            return XCTFail("one byte below the high-water must still be refused")
        }
        XCTAssertEqual(reason, "witness-regressed")

        // And the other direction's bootstrap record is not lost by compaction.
        guard case .ok = w.preflight(pairId: pairId, direction: .bToA, store: hw(0, 0, 0)) else {
            return XCTFail("compaction must not drop the other direction")
        }
    }

    /// Refusing to understand a blob is not a licence to destroy it: if nothing
    /// parses, compaction leaves it alone and the reader fails closed on it.
    func testCompactionNeverDiscardsAnUnparseableJournal() throws {
        let fs = KeychainWitnessFs(backend: InMemoryKeychainBackend(), compactionThreshold: 16)
        let junk = [UInt8](repeating: 0x41, count: 512)
        let out = fs.compactIfNeeded(junk)
        XCTAssertEqual(out, junk, "an unparseable journal must be preserved, not folded away")
    }
}
