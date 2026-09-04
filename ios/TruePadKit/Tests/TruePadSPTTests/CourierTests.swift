import Foundation
import TruePadCore
@testable import TruePadStorage
import XCTest

/// The courier bundle: the pad leaving, and the pad arriving.
///
/// THE CONTAINER BYTES ARE NOT INVENTED HERE. `android/vectors/courier-container.json`
/// was generated from the RELEASED TruePad v2.0.0, and it carries both the input
/// files and the exact `containerText` that release produced. iOS is held to those
/// bytes, so a pad couriered from iOS imports into the Browser/CLI and back.
///
/// The rules under test are the ones that keep a pad in ONE pair of hands:
///
///   - a pad may leave this installation ONCE;
///   - an IMPORTED pad may never be exported onward;
///   - the marker is written BEFORE the bytes are released;
///   - a torn marker is spent, never absent.
final class CourierTests: XCTestCase {
    let fixedPairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
    let fixedInstant = Date(timeIntervalSince1970: 1_756_684_800)

    struct Vector: Decodable {
        struct File: Decodable { let path: String; let bytesHex: String }
        let pairId: String
        let files: [File]
        let containerText: String
    }

    func vector() throws -> Vector {
        let url = XWingKATTests.repoRoot.appendingPathComponent("android/vectors/courier-container.json")
        return try JSONDecoder().decode(Vector.self, from: Data(contentsOf: url))
    }

    func engine(_ fs: Fs, witnessFs: Fs? = nil, pairId: String? = nil) -> Engine {
        Engine(fs: fs, witnessFs: witnessFs, clock: { self.fixedInstant },
               pairIdSource: { Hex.decode(pairId ?? self.fixedPairId)! })
    }

    func sourceBytes(_ n: Int, seed: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: n)
        for i in 0..<n {
            let mixed: Int = seed &+ (i &* 31) &+ ((i &* i) % 251)
            out[i] = UInt8(mixed & 0xff)
        }
        return out
    }

    @discardableResult
    func genPair(_ e: Engine, capacity: Int = 256, records: Int = 4) throws -> String {
        let need = try Partition.requiredSourceLength(capacity: capacity, capacityRecords: records)
        return try e.gen(label: "test",
                         sources: [SourceInput(name: "s.bin", declaredOrigin: "declared",
                                               bytes: sourceBytes(need, seed: 7))],
                         encryptionBytes: capacity, authRecords: records).pair.pairId
    }

    func refusal(_ body: () throws -> Void) -> EngineRefused? {
        do { try body(); return nil } catch let r as EngineRefused { return r } catch { return nil }
    }

    // MARK: - byte-exact against the released container

    func testPackedContainerMatchesTheReleasedBytesExactly() throws {
        let v = try vector()
        let files = v.files.map { CourierFile(path: $0.path, bytes: Hex.decode($0.bytesHex) ?? []) }
        let packed = packContainer(pairId: v.pairId, files: files)
        XCTAssertEqual(String(decoding: packed, as: UTF8.self), v.containerText,
                       "the container must be byte-identical to the released v2.0.0 output")
    }

    func testTheReleasedContainerUnpacksToTheSameFiles() throws {
        let v = try vector()
        guard case .ok(let pairId, let files) = unpackContainer(Array(v.containerText.utf8)) else {
            return XCTFail("the released container must unpack")
        }
        XCTAssertEqual(pairId, v.pairId)
        XCTAssertEqual(files.count, v.files.count)
        for (got, want) in zip(files, v.files) {
            XCTAssertEqual(got.path, want.path)
            XCTAssertEqual(got.bytes, Hex.decode(want.bytesHex))
        }
    }

    func testAnEmptyFileListStillRoundTrips() {
        let packed = packContainer(pairId: fixedPairId, files: [])
        guard case .ok(let id, let files) = unpackContainer(packed) else {
            return XCTFail("an empty container is well-formed, just useless")
        }
        XCTAssertEqual(id, fixedPairId)
        XCTAssertTrue(files.isEmpty)
    }

    /// A malformed container never reaches the store. Each of these is refused
    /// with a message that says what the file is, not what to do to force it.
    func testEveryMalformedContainerIsRefused() throws {
        let v = try vector()
        let cases: [(String, String)] = [
            ("not JSON", "{"),
            ("not an object", "[1,2,3]"),
            ("the wrong format tag", v.containerText.replacingOccurrences(
                of: "truepad2-pair-bundle", with: "truepad2-pair-bundl3")),
            ("no pairId", #"{"format":"truepad2-pair-bundle","version":1,"files":[]}"#),
            ("no files array", #"{"format":"truepad2-pair-bundle","version":1,"pairId":"x"}"#),
            ("a file entry that is not an object",
             #"{"format":"truepad2-pair-bundle","version":1,"pairId":"x","files":[1]}"#),
            ("a file entry with no path",
             #"{"format":"truepad2-pair-bundle","version":1,"pairId":"x","files":[{"bytesB64":"AA=="}]}"#),
            ("a file entry with no body",
             #"{"format":"truepad2-pair-bundle","version":1,"pairId":"x","files":[{"path":"p"}]}"#),
            ("a body that is not base64",
             #"{"format":"truepad2-pair-bundle","version":1,"pairId":"x","files":[{"path":"p","bytesB64":"not base64!"}]}"#),
        ]
        for (why, text) in cases {
            guard case .bad = unpackContainer(Array(text.utf8)) else {
                return XCTFail("[\(why)] must be refused, not unpacked")
            }
        }
    }

    // MARK: - export is a handoff, and a pad gets one

    func testExportCarriesExactlyTheSixStoreFilesAndNothingElse() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let pairId = try genPair(e)

        let exported = try e.exportPair(pairId: pairId)
        XCTAssertEqual(exported.fileCount, 6)
        guard case .ok(let id, let files) = unpackContainer(exported.container) else {
            return XCTFail("the exported container must unpack")
        }
        XCTAssertEqual(id, pairId)
        XCTAssertEqual(Set(files.map { $0.path }), Set([
            "a-to-b/head.json", "a-to-b/secret.bin", "a-to-b/journal.log",
            "b-to-a/head.json", "b-to-a/secret.bin", "b-to-a/journal.log",
        ]))
        // NEVER this installation's own bookkeeping.
        let text = String(decoding: exported.container, as: UTF8.self)
        for forbidden in ["pair.json", "handoff.json", "destroyed.json", "importing.json",
                          "witness/", "origin", "generated-here"] {
            XCTAssertFalse(text.contains(forbidden),
                           "the bundle carries the PAD, not this installation's record: \(forbidden)")
        }
    }

    /// MARKER LAST, and before the bytes are released: bytes that left without a
    /// record would be a handoff nothing knows about.
    func testTheHandoffMarkerIsWrittenBeforeTheContainerIsReleased() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let pairId = try genPair(e)
        XCTAssertEqual(readHandoffState(fs: fs, pairId: pairId), .absent, "control")

        _ = try e.exportPair(pairId: pairId)
        guard case .physical(let at) = readHandoffState(fs: fs, pairId: pairId) else {
            return XCTFail("a first export must record the handoff")
        }
        XCTAssertEqual(at, isoNow(fixedInstant))
    }

    /// A re-export under an EXISTING physical marker leaves it alone, so the
    /// recorded time stays the time of the FIRST handoff.
    func testAReExportDoesNotRewriteTheOriginalHandoffTime() throws {
        let fs = MemoryFs()
        var tick = fixedInstant
        let e = Engine(fs: fs, clock: { tick },
                       pairIdSource: { Hex.decode(self.fixedPairId)! })
        let pairId = try genPair(e)
        _ = try e.exportPair(pairId: pairId)
        let first = try XCTUnwrap(try fs.readFile(handoffMarkerPath(pairId)))

        tick = fixedInstant.addingTimeInterval(3600)
        _ = try e.exportPair(pairId: pairId)
        XCTAssertEqual(try fs.readFile(handoffMarkerPath(pairId)), first,
                       "the recorded time is the FIRST handoff, not the latest save")
    }

    /// A torn marker is SPENT, never absent — absence is the one state that
    /// permits another copy to leave.
    func testATornHandoffMarkerRefusesAnyFurtherExport() throws {
        for torn in ["", "{not json", "[1,2,3]",
                     #"{"version":1,"pairId":"5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4","mode":"physical","at":"nope"}"#] {
            let fs = MemoryFs()
            let e = engine(fs)
            let pairId = try genPair(e)
            try fs.writeFileAtomic(handoffMarkerPath(pairId), Array(torn.utf8))

            let r = refusal { _ = try e.exportPair(pairId: pairId) }
            XCTAssertEqual(r?.reason, refuseUnreadable, "torn: \(torn)")
            XCTAssertTrue(r?.message.contains("Generate a new pad") ?? false)
        }
    }

    /// A pad already SENT sealed will not also be saved as a file to pass on.
    func testAPadAlreadySentSealedIsNotAlsoExportedAsAFile() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let pairId = try genPair(e)
        let marker = #"{"version":1,"pairId":"\#(pairId)","mode":"sealed","at":"\#(isoNow(fixedInstant))","requestHash":"a","packageIdentity":"b","confirmHash":"c"}"#
        try fs.writeFileAtomic(handoffMarkerPath(pairId), Array(marker.utf8))

        XCTAssertEqual(refusal { _ = try e.exportPair(pairId: pairId) }?.reason, refuseAlreadySealed)
    }

    func testADestroyedPairIsNeverExported() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let pairId = try genPair(e)
        _ = try e.destroy(pairId: pairId, confirm: pairId)
        XCTAssertEqual(refusal { _ = try e.exportPair(pairId: pairId) }?.reason, "pair-destroyed")
    }

    // MARK: - import, and the provenance rule that keeps a pad in two hands only

    func testAnImportedPairIsUsableAndCarriesImportedProvenance() throws {
        let aliceFs = MemoryFs()
        let alice = engine(aliceFs)
        let pairId = try genPair(alice)
        let container = try alice.exportPair(pairId: pairId).container

        let bobFs = MemoryFs()
        let bob = engine(bobFs)
        let summary = try bob.importPair(label: "from Alice", container: container)

        XCTAssertEqual(summary.pairId, pairId)
        XCTAssertEqual(summary.label, "from Alice")
        XCTAssertEqual(summary.origin, .imported)
        XCTAssertFalse(bobFs.exists(importMarkerPath(pairId)), "the import marker is cleared on commit")
        XCTAssertFalse(bobFs.exists(stagingDir(pairId)), "the staging area is cleaned up")

        // And the pad WORKS across the two installations.
        let burned = try alice.burn(pairId: pairId, role: .a, plaintext: Array("hello Bob".utf8))
        XCTAssertEqual(try bob.open(pairId: pairId, role: .b, envelopeText: burned.envelope).plaintext,
                       Array("hello Bob".utf8))
    }

    /// THE RULE. Bob imported the pad; Bob may not pass it on to Charlie. Two
    /// people holding the same pad would each consume the same material.
    func testAnImportedPadCanNeverBeExportedOnward() throws {
        let aliceFs = MemoryFs()
        let alice = engine(aliceFs)
        let pairId = try genPair(alice)
        let container = try alice.exportPair(pairId: pairId).container

        let bobFs = MemoryFs()
        let bob = engine(bobFs)
        _ = try bob.importPair(label: "from Alice", container: container)

        let r = refusal { _ = try bob.exportPair(pairId: pairId) }
        XCTAssertEqual(r?.reason, "imported-pair-cannot-export")
        XCTAssertTrue(r?.message.contains("Generate a new pad") ?? false)
        XCTAssertEqual(readHandoffState(fs: bobFs, pairId: pairId), .absent,
                       "a refused export records nothing")
    }

    func testImportingOverACommittedPairIsRefused() throws {
        let aliceFs = MemoryFs()
        let alice = engine(aliceFs)
        let pairId = try genPair(alice)
        let container = try alice.exportPair(pairId: pairId).container

        // Alice still holds the pair; re-importing it would overwrite her counters.
        let r = refusal { _ = try alice.importPair(label: "again", container: container) }
        XCTAssertEqual(r?.reason, "pair-exists")
        XCTAssertTrue(r?.message.contains("Nothing was imported") ?? false)
    }

    func testImportingIntoADestroyedIdIsRefused() throws {
        let aliceFs = MemoryFs()
        let alice = engine(aliceFs)
        let pairId = try genPair(alice)
        let container = try alice.exportPair(pairId: pairId).container

        let bobFs = MemoryFs()
        let bob = engine(bobFs)
        _ = try bob.importPair(label: "from Alice", container: container)
        _ = try bob.destroy(pairId: pairId, confirm: pairId)

        // The tombstone is permanent: re-importing the pad's own bundle is refused.
        XCTAssertEqual(refusal { _ = try bob.importPair(label: "again", container: container) }?.reason,
                       "pair-destroyed")
        XCTAssertEqual(refusal { try bob.requireImportable(pairId) }?.reason, "pair-destroyed")
    }

    /// The whole bundle is validated in staging before ANY of it becomes active.
    func testAnIncompleteOrForeignBundleNeverBecomesActive() throws {
        let aliceFs = MemoryFs()
        let alice = engine(aliceFs)
        let pairId = try genPair(alice)
        let container = try alice.exportPair(pairId: pairId).container
        guard case .ok(_, let files) = unpackContainer(container) else { return XCTFail("setup") }

        let cases: [(String, [CourierFile])] = [
            ("a missing store file", Array(files.dropLast())),
            ("a duplicated store file", files + [files[0]]),
            ("an unknown path", files + [CourierFile(path: "a-to-b/extra.bin", bytes: [1])]),
        ]
        for (why, mutated) in cases {
            let bobFs = MemoryFs()
            let bob = engine(bobFs)
            let r = refusal { _ = try bob.importPair(label: "x",
                                                     container: packContainer(pairId: pairId,
                                                                              files: mutated)) }
            XCTAssertEqual(r?.reason, "malformed-bundle", why)
            XCTAssertFalse(bobFs.exists(pairMetaPath(pairId)), "[\(why)] nothing became active")
            XCTAssertFalse(bobFs.exists(filePath(storeDir(pairId, .aToB), headFile)), why)
        }
    }

    /// A bundle whose headers disagree with the container is refused, and leaves
    /// no staging behind.
    func testAHeaderThatDisagreesWithTheContainerIsRefusedAndCleanedUp() throws {
        let aliceFs = MemoryFs()
        let alice = engine(aliceFs)
        let pairId = try genPair(alice)
        let container = try alice.exportPair(pairId: pairId).container
        guard case .ok(_, let files) = unpackContainer(container) else { return XCTFail("setup") }

        // Same six files, a DIFFERENT container pairId.
        let foreign = "ffffffffffffffffffffffffffffffff"
        let bobFs = MemoryFs()
        let bob = engine(bobFs)
        let r = refusal { _ = try bob.importPair(label: "x",
                                                 container: packContainer(pairId: foreign,
                                                                          files: files)) }
        XCTAssertEqual(r?.reason, "malformed-bundle")
        XCTAssertTrue(r?.message.contains("disagrees") ?? false)
        XCTAssertTrue(bobFs.allPaths.filter { $0.hasPrefix(stagingRoot) }.isEmpty,
                      "the staging area must be cleaned up after a refusal")
    }

    /// The imported witness starts at the IMPORTED high-waters, not at genesis —
    /// otherwise a spent pad would arrive claiming a full budget.
    func testTheWitnessIsBootstrappedToTheImportedHighWaters() throws {
        let aliceFs = MemoryFs()
        let alice = engine(aliceFs)
        let pairId = try genPair(alice)
        _ = try alice.burn(pairId: pairId, role: .a, plaintext: Array("spent already".utf8))
        let container = try alice.exportPair(pairId: pairId).container

        let bobFs = MemoryFs()
        let bobWitness = MemoryFs()
        let bob = Engine(fs: bobFs, witnessFs: bobWitness, clock: { self.fixedInstant },
                         pairIdSource: { Hex.decode(self.fixedPairId)! })
        _ = try bob.importPair(label: "from Alice", container: container)

        let m = try XCTUnwrap(try bob.status(pairId).meters[.aToB])
        XCTAssertEqual(m.nextOffset, "spent already".utf8.count,
                       "the imported store carries Alice's consumption")
        XCTAssertEqual(m.witnessState, .aligned,
                       "the witness was bootstrapped to those high-waters, not to genesis")

    }

    /// THE CONTAINER-WIPE REWIND. Bob's store is gone but the out-of-container
    /// witness survives — exactly what KeychainWitnessFs exists for. Re-importing
    /// an OLDER bundle of the same pad must not resurrect the spent material.
    func testReimportingAnOlderBundleOverASurvivingWitnessIsRefused() throws {
        let aliceFs = MemoryFs()
        let alice = engine(aliceFs)
        let pairId = try genPair(alice)
        // The GENESIS bundle, captured before anything is consumed.
        let genesisBundle = try alice.exportPair(pairId: pairId).container

        let bobFs = MemoryFs()
        let bobWitness = MemoryFs()
        func bobEngine(_ store: Fs) -> Engine {
            Engine(fs: store, witnessFs: bobWitness, clock: { self.fixedInstant },
                   pairIdSource: { Hex.decode(self.fixedPairId)! })
        }
        _ = try bobEngine(bobFs).importPair(label: "from Alice", container: genesisBundle)
        _ = try bobEngine(bobFs).burn(pairId: pairId, role: .b, plaintext: Array("spent".utf8))

        // The CONTAINER is wiped; the witness is in another failure domain and
        // survives. Bob re-imports the genesis bundle.
        let wiped = MemoryFs()
        XCTAssertFalse(bobWitness.allPaths.isEmpty, "the witness is NOT in the container")
        _ = try? bobEngine(wiped).importPair(label: "rewind", container: genesisBundle)

        let r = refusal { _ = try bobEngine(wiped).burn(pairId: pairId, role: .b,
                                                        plaintext: Array("reuse?".utf8)) }
        XCTAssertEqual(r?.reason, "witness-regressed",
                       "a surviving witness must refuse pad material it has already seen spent")
    }

    /// An interrupted import leaves an INACTIVE, retryable pair — never a partial
    /// active one — and a retry completes cleanly.
    func testAnInterruptedImportIsRetryableAndNeverPartiallyActive() throws {
        let aliceFs = MemoryFs()
        let alice = engine(aliceFs)
        let pairId = try genPair(alice)
        let container = try alice.exportPair(pairId: pairId).container

        let bobFs = MemoryFs()
        // Fail the pair.json write — the commit — leaving the marker in place.
        let failing = FailOnceOnWriteFs(inner: bobFs, failWhen: { $0.hasSuffix(pairMetaFile) })
        let interrupted = engine(failing)
        XCTAssertThrowsError(try interrupted.importPair(label: "x", container: container))

        XCTAssertTrue(bobFs.exists(importMarkerPath(pairId)),
                      "the import marker is still present, so the pair is NOT active")
        let bob = engine(bobFs)
        XCTAssertEqual(refusal { _ = try bob.status(pairId) }?.reason, "import-incomplete")

        // The retry completes.
        let summary = try bob.importPair(label: "retry", container: container)
        XCTAssertEqual(summary.origin, .imported)
        XCTAssertFalse(bobFs.exists(importMarkerPath(pairId)))
    }
}

extension Engine {
    /// Test-only access to the live container builder, which is internal because
    /// it mutates no handoff state and must not be a public way around export.
    func buildLiveCourierContainerForTest(_ pairId: String) throws -> [UInt8] {
        try buildLiveCourierContainer(pairId)
    }
}

private final class FailOnceOnWriteFs: Fs, @unchecked Sendable {
    let inner: Fs
    let failWhen: (String) -> Bool
    private var fired = false

    init(inner: Fs, failWhen: @escaping (String) -> Bool) {
        self.inner = inner
        self.failWhen = failWhen
    }

    func readFile(_ path: String) throws -> [UInt8]? { try inner.readFile(path) }
    func writeFileAtomic(_ path: String, _ data: [UInt8]) throws {
        if !fired, failWhen(path) { fired = true; throw FsFailure.io("simulated: \(path)") }
        try inner.writeFileAtomic(path, data)
    }
    func appendFile(_ path: String, _ data: [UInt8]) throws { try inner.appendFile(path, data) }
    func readRange(_ path: String, offset: Int, length: Int) throws -> [UInt8] {
        try inner.readRange(path, offset: offset, length: length)
    }
    func writeRange(_ path: String, offset: Int, data: [UInt8]) throws {
        try inner.writeRange(path, offset: offset, data: data)
    }
    func exists(_ path: String) -> Bool { inner.exists(path) }
    func remove(_ path: String) throws { try inner.remove(path) }
    func size(_ path: String) throws -> Int? { try inner.size(path) }
    func list(_ prefix: String) throws -> [String] { try inner.list(prefix) }
    func withLock<T>(_ scope: String, _ body: () throws -> T) throws -> T { try inner.withLock(scope, body) }
}
