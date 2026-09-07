import Foundation
import TruePadCore
@testable import TruePadSPT
@testable import TruePadStorage
import XCTest

/// "ALREADY SEALED TO THIS REQUEST" IS A CLAIM ABOUT A REQUEST, AND IT IS CHECKED.
///
/// The seal screen worded its button and its explanation from `SealModel.isReshare`,
/// which asked `Engine.handoffState(pairId:)` — a pad-level answer whose type
/// carries a timestamp and NOTHING ELSE. It structurally cannot carry request
/// identity. On that answer the screen asserted "This pad was already sealed to
/// this request. TruePad will hand back the SAME sealed file it made then" — about
/// EVERY request, including a different one `sptSeal` was about to refuse with
/// `pad-already-sealed`.
///
/// The binding was on disk the whole time: the sealed handoff marker stores
/// `requestHash`, and `sptSeal` compares it. What was missing was a way for the
/// interface to ask the same question, so `sptSealedToRequest` exists and both
/// callers now run the SAME comparison — `sealedMarkerIdentity`. These tests hold
/// the two against each other, because a prediction that disagrees with the act it
/// predicts is worse than no prediction at all.
final class SealedRequestBindingTests: XCTestCase {
    let start = Date(timeIntervalSince1970: 1_756_684_800)
    let padId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"

    private func engine(_ fs: Fs, pairId: String) -> Engine {
        Engine(fs: fs, clock: { self.start }, pairIdSource: { Hex.decode(pairId)! })
    }

    private func sourceBytes(_ n: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: n)
        for i in 0..<n { out[i] = UInt8((7 &+ i &* 31 &+ ((i &* i) % 251)) & 0xff) }
        return out
    }

    /// Alice, with one fresh generated-here pad.
    private func alice(_ fs: MemoryFs) throws -> Engine {
        let e = engine(fs, pairId: padId)
        let need = try Partition.requiredSourceLength(capacity: 256, capacityRecords: 4)
        _ = try e.gen(label: "to send",
                      sources: [SourceInput(name: "dice.bin", declaredOrigin: "physical dice",
                                            bytes: sourceBytes(need))],
                      encryptionBytes: 256, authRecords: 4)
        return e
    }

    /// A recipient publishing a one-time receive request. Each gets its own store,
    /// so the two requests are genuinely independent.
    private func recipient(_ fs: MemoryFs, pairId: String) throws -> SptCreateResult {
        try engine(fs, pairId: pairId).sptCreateReceiveRequest()
    }

    func testBeforeAnySealNothingIsAReshare() throws {
        let a = try alice(MemoryFs())
        let request = try recipient(MemoryFs(), pairId: "ffffffffffffffffffffffffffffffff")
        let review = try a.sptReviewRequest(request.tpr2Text)
        XCTAssertFalse(a.sptSealedToRequest(pairId: padId, requestHashHex: review.requestHashHex),
                       "a pad with no handoff marker cannot have been sealed to anything")
    }

    func testTheSameRequestIsARestateAndTheEngineAgrees() throws {
        let a = try alice(MemoryFs())
        let request = try recipient(MemoryFs(), pairId: "ffffffffffffffffffffffffffffffff")
        let review = try a.sptReviewRequest(request.tpr2Text)
        _ = try a.sptConfirmRequest(canonicalBody: review.canonicalBody)
        let first = try a.sptSeal(requestHashHex: review.requestHashHex, pairId: padId)
        XCTAssertFalse(first.reshared)

        // THE PREDICTION.
        XCTAssertTrue(a.sptSealedToRequest(pairId: padId, requestHashHex: review.requestHashHex))
        // THE ACT. Same bytes, same confirmation words, flagged as a re-share —
        // so the sentence the screen shows is true of what actually happens.
        let again = try a.sptSeal(requestHashHex: review.requestHashHex, pairId: padId)
        XCTAssertTrue(again.reshared)
        XCTAssertEqual(again.packageBytes, first.packageBytes,
                       "a re-share must hand back the committed package, not make a second one")
        XCTAssertEqual(again.confirmationIndices, first.confirmationIndices)
    }

    func testADifferentRequestIsNotAReshareAndTheEngineRefusesIt() throws {
        let a = try alice(MemoryFs())
        let first = try recipient(MemoryFs(), pairId: "ffffffffffffffffffffffffffffffff")
        let firstReview = try a.sptReviewRequest(first.tpr2Text)
        _ = try a.sptConfirmRequest(canonicalBody: firstReview.canonicalBody)
        _ = try a.sptSeal(requestHashHex: firstReview.requestHashHex, pairId: padId)

        // A SECOND, GENUINELY DIFFERENT RECEIVE REQUEST.
        let second = try recipient(MemoryFs(), pairId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")
        let secondReview = try a.sptReviewRequest(second.tpr2Text)
        XCTAssertNotEqual(secondReview.requestHashHex, firstReview.requestHashHex,
                          "the two requests must actually differ for this test to mean anything")

        // THE PREDICTION: not a re-share. This is the case the old code got wrong —
        // it answered "yes, already sealed to this request" for this very request.
        XCTAssertFalse(a.sptSealedToRequest(pairId: padId, requestHashHex: secondReview.requestHashHex))

        // THE ACT: refused, and for exactly that reason.
        _ = try a.sptConfirmRequest(canonicalBody: secondReview.canonicalBody)
        var refusal: SptRefused?
        do { _ = try a.sptSeal(requestHashHex: secondReview.requestHashHex, pairId: padId) }
        catch let r as SptRefused { refusal = r }
        XCTAssertEqual(refusal?.reason, "pad-already-sealed")
        XCTAssertTrue(refusal?.message.contains("different receive request") ?? false)
    }

    func testThePredictionAndTheActNeverDisagree() throws {
        // THE PROPERTY, STATED DIRECTLY. For every request the screen might be
        // showing, `sptSealedToRequest` is true exactly when `sptSeal` will hand
        // the committed package back rather than refuse. A prediction that can
        // diverge from the act is what produced the false sentence.
        let a = try alice(MemoryFs())
        let sealedTo = try recipient(MemoryFs(), pairId: "ffffffffffffffffffffffffffffffff")
        let sealedReview = try a.sptReviewRequest(sealedTo.tpr2Text)
        _ = try a.sptConfirmRequest(canonicalBody: sealedReview.canonicalBody)
        _ = try a.sptSeal(requestHashHex: sealedReview.requestHashHex, pairId: padId)

        var checked = 0
        for (i, otherPairId) in ["eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                                 "dddddddddddddddddddddddddddddddd",
                                 "cccccccccccccccccccccccccccccccc"].enumerated() {
            let candidate = i == 0
                ? sealedReview
                : try a.sptReviewRequest(try recipient(MemoryFs(), pairId: otherPairId).tpr2Text)
            let predicted = a.sptSealedToRequest(pairId: padId, requestHashHex: candidate.requestHashHex)
            // NOT `try?`. A confirm that throws would make the seal below refuse
            // for a reason that has nothing to do with the binding, and the
            // comparison would pass by accident.
            _ = try a.sptConfirmRequest(canonicalBody: candidate.canonicalBody)
            // AND THE ENGINE'S OWN REASON IS THE AUTHORITY, not a bare boolean.
            // Both sides call one helper, so `predicted == handedBack` alone is
            // close to true by construction; pinning the refusal REASON means the
            // engine must actually be refusing for the binding, and a seal that
            // failed some other way cannot satisfy it.
            var handedBack = false
            var reason: String?
            do { handedBack = try a.sptSeal(requestHashHex: candidate.requestHashHex,
                                            pairId: padId).reshared }
            catch let r as SptRefused { reason = r.reason }
            XCTAssertEqual(predicted, handedBack,
                           "the screen would have predicted \(predicted) and the engine did \(handedBack)")
            if !predicted {
                XCTAssertEqual(reason, "pad-already-sealed",
                               "the engine refused for something other than the request binding")
            } else {
                XCTAssertNil(reason)
            }
            checked += 1
        }
        XCTAssertEqual(checked, 3, "the loop must actually have run, or this asserts nothing")
    }

    func testAMalformedRequestFingerprintIsNeverAReshare() throws {
        let a = try alice(MemoryFs())
        for bad in ["", "not-hex", String(repeating: "a", count: 63), String(repeating: "A", count: 64)] {
            XCTAssertFalse(a.sptSealedToRequest(pairId: padId, requestHashHex: bad),
                           "\(bad) was treated as a request fingerprint")
        }
        XCTAssertFalse(a.sptSealedToRequest(pairId: "not-a-pad-id",
                                            requestHashHex: String(repeating: "a", count: 64)))
    }
}
