import Foundation
import TruePadCore
@testable import TruePadSPT
@testable import TruePadStorage
import XCTest

/// TWO MODULES, ONE FILE.
///
/// `<pairId>/handoff.json` is written and read by BOTH layers, deliberately:
///
///   - TruePadStorage reads it to answer "may this pad be exported?" and to
///     derive sealed ancestry for the deployment evaluator;
///   - TruePadSPT writes it as the commit point of a sealed transfer, and reads
///     it to decide whether a pad may leave at all.
///
/// They do not share code — TruePadSPT is deliberately independent of the store,
/// the same separation Android draws between its two modules — so nothing but a
/// test stops them drifting apart. A drift here is not cosmetic: if the store
/// could not parse a sealed marker the SPT layer wrote, an already-sent pad would
/// read as `absent` and could be exported a second time.
///
/// LOSS IS ACCEPTABLE; REUSE IS NOT.
final class HandoffAgreementTests: XCTestCase {
    let pairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
    let at = "2025-09-01T00:00:00.000Z"

    /// A bridge so one set of bytes can be shown to both readers.
    ///
    /// The SPT symbols are referenced UNQUALIFIED throughout this file: the module
    /// declares `public enum TruePadSPT`, which shadows the module name, so
    /// `TruePadSPT.SptVfs` resolves to a member of that enum and fails. Only the
    /// store's `refuseAlreadySealed` needs qualifying, because both modules define
    /// one -- with the same value, which is itself the point.
    final class BothFs: TruePadStorage.Fs, SptVfs, @unchecked Sendable {
        var files: [String: [UInt8]] = [:]

        func readFile(_ path: String) throws -> [UInt8]? { files[path] }
        func writeFileAtomic(_ path: String, _ data: [UInt8]) throws { files[path] = data }
        func appendFile(_ path: String, _ data: [UInt8]) throws { files[path, default: []] += data }
        func readRange(_ path: String, offset: Int, length: Int) throws -> [UInt8] {
            guard let f = files[path], offset + length <= f.count else {
                throw TruePadStorage.FsFailure.io(path)
            }
            return Array(f[offset..<(offset + length)])
        }
        func writeRange(_ path: String, offset: Int, data: [UInt8]) throws {
            guard var f = files[path], offset + data.count <= f.count else {
                throw TruePadStorage.FsFailure.io(path)
            }
            f.replaceSubrange(offset..<(offset + data.count), with: data)
            files[path] = f
        }
        func exists(_ path: String) -> Bool { files[path] != nil }
        func remove(_ path: String) throws { files.removeValue(forKey: path) }
        func size(_ path: String) throws -> Int? { files[path]?.count }
        func list(_ prefix: String) throws -> [String] {
            let norm = prefix.isEmpty ? "" : (prefix.hasSuffix("/") ? prefix : prefix + "/")
            var names: [String] = []
            var seen = Set<String>()
            for key in files.keys.sorted() where norm.isEmpty || key.hasPrefix(norm) {
                let rest = key.dropFirst(norm.count)
                let name = rest.firstIndex(of: "/").map { String(rest[rest.startIndex..<$0]) } ?? String(rest)
                if !name.isEmpty, seen.insert(name).inserted { names.append(name) }
            }
            return names
        }
        func withLock<T>(_ scope: String, _ body: () throws -> T) throws -> T { try body() }
    }

    /// The two layers must produce the SAME BYTES for a physical handoff.
    func testBothLayersWriteAnIdenticalPhysicalMarker() throws {
        let a = BothFs()
        let b = BothFs()
        try TruePadStorage.commitPhysicalHandoff(fs: a, pairId: pairId, at: at)
        try sptCommitPhysicalHandoff(vfs: b, pairId: pairId, at: at)

        let fromStore = try XCTUnwrap(a.files["\(pairId)/handoff.json"])
        let fromSpt = try XCTUnwrap(b.files["\(pairId)/handoff.json"])
        XCTAssertEqual(String(decoding: fromStore, as: UTF8.self),
                       String(decoding: fromSpt, as: UTF8.self),
                       "one file, one format — the two layers must not drift")
    }

    /// Each layer must READ what the other wrote.
    func testEachLayerReadsTheOthersPhysicalMarker() throws {
        let fs = BothFs()
        try sptCommitPhysicalHandoff(vfs: fs, pairId: pairId, at: at)
        XCTAssertEqual(TruePadStorage.readHandoffState(fs: fs, pairId: pairId),
                       .physical(at: at),
                       "the store must see the SPT layer's marker")

        let fs2 = BothFs()
        try TruePadStorage.commitPhysicalHandoff(fs: fs2, pairId: pairId, at: at)
        guard case .physical = sptReadHandoffState(vfs: fs2, pairId: pairId) else {
            return XCTFail("the SPT layer must see the store's marker")
        }
    }

    /// THE ONE THAT MATTERS MOST. A sealed marker written by the SPT layer must be
    /// understood by the store — if the store read it as `absent`, an
    /// already-sealed pad could be exported as a file as well.
    func testTheStoreUnderstandsASealedMarkerWrittenByTheSptLayer() throws {
        let fs = BothFs()
        // A REAL pair, so the export gate actually reaches the handoff check
        // rather than stopping at `no-store` — which is what it did when this
        // test was first written against an empty store, proving nothing.
        let engine = TruePadStorage.Engine(
            fs: fs, clock: { Date(timeIntervalSince1970: 1_756_684_800) },
            pairIdSource: { TruePadCore.Hex.decode(self.pairId)! })
        let need = try TruePadCore.Partition.requiredSourceLength(capacity: 256, capacityRecords: 4)
        _ = try engine.gen(label: "agreement",
                           sources: [TruePadStorage.SourceInput(
                            name: "s.bin", declaredOrigin: "declared",
                            bytes: [UInt8](repeating: 0x2B, count: need))],
                           encryptionBytes: 256, authRecords: 4)

        let requestHash = [UInt8](repeating: 0xAA, count: 32)
        _ = try claimRequestForPair(vfs: fs, requestHash: requestHash, pairId: pairId, at: at)
        let packageBytes = Array("a sealed package".utf8)
        _ = try commitSealedHandoff(
            vfs: fs, pairId: pairId,
            input: SealedHandoffInput(
                packageBytes: packageBytes,
                requestHash: requestHash,
                confirmValue: [UInt8](repeating: 0x5A, count: SptConstants.confirmValueBytes),
                packageIdentity: SealedPackageCodec.packageIdentity(packageBytes)),
            at: at)

        XCTAssertEqual(TruePadStorage.readHandoffState(fs: fs, pairId: pairId),
                       .sealed(at: at),
                       "the store must recognise a sealed marker, not read it as absence")

        // And the store's export gate refuses on it.
        do {
            _ = try engine.exportPair(pairId: pairId)
            XCTFail("an already-sealed pad must not also be exported as a file")
        } catch let refused as TruePadStorage.EngineRefused {
            // `no-store` would mean the gate never got as far as the handoff check.
            XCTAssertEqual(refused.reason, TruePadStorage.refuseAlreadySealed)
        }
    }

    /// A TORN marker is spent in BOTH layers. Neither may read it as absence.
    func testATornMarkerIsSpentInBothLayers() throws {
        for torn in ["", "{", "[]", #"{"version":1,"pairId":"WRONG","mode":"physical","at":"AT"}"#] {
            let fs = BothFs()
            let body = torn
                .replacingOccurrences(of: "WRONG", with: String(repeating: "f", count: 32))
                .replacingOccurrences(of: "AT", with: at)
            fs.files["\(pairId)/handoff.json"] = Array(body.utf8)

            guard case .unreadableSpent = TruePadStorage.readHandoffState(fs: fs, pairId: pairId) else {
                return XCTFail("[\(torn)] the store must read a torn marker as spent")
            }
            guard case .unreadableSpent = sptReadHandoffState(vfs: fs, pairId: pairId) else {
                return XCTFail("[\(torn)] the SPT layer must read a torn marker as spent")
            }
        }
    }

    /// Both layers agree on the canonical timestamp spelling, because both go
    /// through TruePadCore.IsoTime. A marker one layer wrote must not be rejected
    /// by the other for a formatting reason.
    func testBothLayersAgreeOnTheCanonicalTimestamp() {
        for millis in [0, 1, -1, 1_756_684_800_000, 951_782_400_000] {
            let rendered = TruePadStorage.isoNow(Date(timeIntervalSince1970: Double(millis) / 1000))
            XCTAssertEqual(rendered, SptTime.format(epochMillis: millis))
            XCTAssertTrue(SptTime.isCanonicalIso(rendered))
        }
    }
}
