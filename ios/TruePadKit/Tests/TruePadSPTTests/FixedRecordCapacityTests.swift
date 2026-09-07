import Foundation
import TruePadCore
@testable import TruePadStorage
import XCTest

/// WHAT "MESSAGES YOU CAN STILL SEND" PROMISES, AND WHETHER IT KEEPS IT.
///
/// FORMAT-V2 §16: on a FIXED store every send spends exactly F encryption bytes
/// and one authentication record however short the message — `burn` builds a full
/// F-byte frame, so `c` is always F. The message count is therefore bounded by
/// BOTH budgets: `min(remainingRecords, remainingBytes / F)`.
///
/// Every engine reported `remainingRecords` alone. On a variable store that is a
/// true upper bound — a send can be one byte — so that half was always honest. On
/// a fixed store it overstated: a Small pad (E = 16,384 per direction, N = 64)
/// fixed at F = 4096 can send FOUR messages and then reported SIXTY, and the pad
/// list still said "Ready" for a pad that could never send again.
///
/// THESE TESTS DO NOT RESTATE THE FORMULA — a test that recomputes it beside the
/// engine agrees with itself whatever either one says. The central test BURNS
/// UNTIL THE ENGINE REFUSES and checks that the number of sends it managed is
/// exactly the number the meter promised. That is the claim the operator reads,
/// checked against the only authority for it.
final class FixedRecordCapacityTests: XCTestCase {
    let pairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
    let instant = Date(timeIntervalSince1970: 1_756_684_800)

    private func sourceBytes(_ n: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: n)
        for i in 0..<n { out[i] = UInt8((7 &+ (i &* 31) &+ ((i &* i) % 251)) & 0xff) }
        return out
    }

    private func pad(capacity: Int, records: Int, recordBytes: Int? = nil) throws -> Engine {
        let e = Engine(fs: MemoryFs(), witnessFs: nil,
                       clock: { self.instant },
                       pairIdSource: { Hex.decode(self.pairId)! })
        let need = try Partition.requiredSourceLength(capacity: capacity, capacityRecords: records)
        _ = try e.gen(label: "capacity",
                      sources: [SourceInput(name: "s.bin", declaredOrigin: "declared",
                                            bytes: sourceBytes(need))],
                      encryptionBytes: capacity, authRecords: records,
                      recordBytes: recordBytes, witnessKind: .local)
        return e
    }

    private func meters(_ e: Engine) throws -> DirectionMeters {
        try XCTUnwrap(try e.status(pairId).meters[.aToB])
    }

    /// Burn one-byte messages until the engine refuses; report how many landed.
    private func sendsUntilRefused(_ e: Engine) throws -> (count: Int, reason: String) {
        var count = 0
        while count < 10_000 {
            do {
                _ = try e.burn(pairId: pairId, role: .a, plaintext: [0x41])
                count += 1
            } catch let r as EngineRefused {
                return (count, r.reason)
            }
        }
        XCTFail("the engine never refused; the budget under test is not small enough to exhaust")
        return (count, "")
    }

    func testAFixedStorePromisesExactlyTheSendsTheEngineWillAllow() throws {
        // F = 256 against E = 2048 affords eight sends while one hundred records
        // survive — the budgets disagree by 92, so the figure cannot be right by
        // coincidence.
        let e = try pad(capacity: 2048, records: 100, recordBytes: 256)
        let promised = try meters(e).maxRemainingSends
        XCTAssertEqual(promised, 8)

        let (count, reason) = try sendsUntilRefused(e)
        XCTAssertEqual(count, promised, "the meter promised more sends than the engine allowed")
        XCTAssertEqual(reason, "encryption-exhausted")
        XCTAssertEqual(try meters(e).remainingRecords, 92)
        XCTAssertEqual(try meters(e).maxRemainingSends, 0)
    }

    func testEveryMessageCostsOneRecordWhateverItsLength() throws {
        // A fixed record's whole point is that a short message and a long one are
        // indistinguishable on the wire. They must be indistinguishable in the
        // budget too.
        let e = try pad(capacity: 2048, records: 100, recordBytes: 256)
        XCTAssertEqual(try meters(e).maxRemainingSends, 8)

        let short = try e.burn(pairId: pairId, role: .a, plaintext: [UInt8](repeating: 0, count: 1))
        XCTAssertEqual(short.encryptionBytes, 256)
        XCTAssertEqual(try meters(e).maxRemainingSends, 7)

        // 252 is F − 4, the largest plaintext this record can carry.
        let full = try e.burn(pairId: pairId, role: .a, plaintext: [UInt8](repeating: 0, count: 252))
        XCTAssertEqual(full.encryptionBytes, 256)
        XCTAssertEqual(try meters(e).maxRemainingSends, 6)
    }

    func testTheBoundaryDoesNotOfferOneMoreMessageThanTheBytesCanPayFor() throws {
        // 2048 / 768 = 2 remainder 512. After two sends 512 bytes remain — more
        // than nothing, and not enough for a record. The old figure counted the
        // 98 records that survive; not one of them can be spent.
        let e = try pad(capacity: 2048, records: 100, recordBytes: 768)
        XCTAssertEqual(try meters(e).maxRemainingSends, 2)
        _ = try e.burn(pairId: pairId, role: .a, plaintext: [0x41])
        _ = try e.burn(pairId: pairId, role: .a, plaintext: [0x41])

        let m = try meters(e)
        XCTAssertEqual(m.remainingBytes, 512)
        XCTAssertEqual(m.remainingRecords, 98)
        XCTAssertEqual(m.maxRemainingSends, 0)

        var refusal: String?
        do { _ = try e.burn(pairId: pairId, role: .a, plaintext: [0x41]) }
        catch let r as EngineRefused { refusal = r.reason }
        XCTAssertEqual(refusal, "encryption-exhausted")
    }

    func testTheSmallPresetCaseTheReviewFound() throws {
        // E = 16,384 per direction and N = 64 are the Small preset; F = 4096 is
        // accepted by the create screen. Four sends — and the old figure said 64.
        let e = try pad(capacity: 16_384, records: 64, recordBytes: 4096)
        XCTAssertEqual(try meters(e).maxRemainingSends, 4)
        XCTAssertEqual(try meters(e).remainingRecords, 64)
        XCTAssertEqual(try sendsUntilRefused(e).count, 4)
    }

    func testLimitedByNamesWhicheverBudgetActuallyBinds() throws {
        let bytesBound = try pad(capacity: 2048, records: 100, recordBytes: 256)
        XCTAssertEqual(try meters(bytesBound).limitedBy, "ENCRYPTION")

        // 4096 bytes affords sixteen 256-byte records, but only four exist.
        let authBound = try pad(capacity: 4096, records: 4, recordBytes: 256)
        XCTAssertEqual(try meters(authBound).limitedBy, "AUTHENTICATION")
        XCTAssertEqual(try meters(authBound).maxRemainingSends, 4)
    }

    func testAVariableStoreIsUnchanged() throws {
        let e = try pad(capacity: 2048, records: 6)
        let before = try meters(e)
        XCTAssertEqual(before.record, .variable)
        XCTAssertEqual(before.maxRemainingSends, 6)
        XCTAssertEqual(before.maxRemainingSends, before.remainingRecords)

        let (count, reason) = try sendsUntilRefused(e)
        XCTAssertEqual(count, 6)
        XCTAssertEqual(reason, "auth-exhausted")
    }

    func testAVariableStoreKeepsBothLimitedByVerdicts() throws {
        // The frozen §13 display rule, unchanged: AUTHENTICATION binds when even
        // maximum-size sends cannot spend the bytes first.
        XCTAssertEqual(try meters(try pad(capacity: 16, records: 1)).limitedBy, "AUTHENTICATION")
        XCTAssertEqual(try meters(try pad(capacity: 16, records: 2)).limitedBy, "ENCRYPTION")
    }
}
