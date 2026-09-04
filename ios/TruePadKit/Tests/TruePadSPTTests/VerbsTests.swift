import Foundation
import TruePadClaims
import TruePadCore
@testable import TruePadStorage
import XCTest

/// The §12 transaction engine.
///
/// These drive the REAL engine — never a transcription of its predicates — so a
/// change that breaks an invariant fails here rather than being restated as still
/// holding. The two orderings that define TruePad's safety are tested by
/// INTERRUPTING them, not by reading the code:
///
///   BURN-BEFORE-OUTPUT  a durable write that fails at S2 withholds the envelope.
///   PERSIST-BEFORE-USE  an open reserves its attempt durably before verifying.
///
/// LOSS IS ACCEPTABLE; REUSE IS NOT.
final class VerbsTests: XCTestCase {
    let fixedPairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
    let fixedInstant = Date(timeIntervalSince1970: 1_756_684_800)   // 2025-09-01T00:00:00.000Z

    func engine(_ fs: Fs, witnessFs: Fs? = nil, pairId: String? = nil) -> Engine {
        Engine(fs: fs, witnessFs: witnessFs,
               clock: { self.fixedInstant },
               pairIdSource: { Hex.decode(pairId ?? self.fixedPairId)! })
    }

    /// Deterministic but non-uniform-looking material. Its VALUE is irrelevant to
    /// every assertion here — the engine never inspects source bytes by value.
    func sourceBytes(_ n: Int, seed: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: n)
        for i in 0..<n {
            let mixed: Int = seed &+ (i &* 31) &+ ((i &* i) % 251)
            out[i] = UInt8(mixed & 0xff)
        }
        return out
    }

    @discardableResult
    func genPair(_ e: Engine, capacity: Int = 256, records: Int = 4,
                 recordBytes: Int? = nil, witness: WitnessKind = .local,
                 label: String = "test") throws -> String {
        let need = try Partition.requiredSourceLength(capacity: capacity, capacityRecords: records)
        let result = try e.gen(label: label,
                               sources: [SourceInput(name: "s.bin", declaredOrigin: "declared",
                                                     bytes: sourceBytes(need, seed: 7))],
                               encryptionBytes: capacity, authRecords: records,
                               recordBytes: recordBytes, witnessKind: witness)
        return result.pair.pairId
    }

    func refusal(_ body: () throws -> Void) -> EngineRefused? {
        do { try body(); return nil } catch let r as EngineRefused { return r } catch { return nil }
    }

    /// THE COURIER MODEL. A and B hold SEPARATE copies of the same pair — that is
    /// what makes a pad a pad. Testing a round trip against ONE store would have A
    /// burning and B opening the same a-to-b counters, which is not the deployment
    /// and would quietly assert the wrong thing. (It did: the first version of
    /// these tests shared a store and every open was refused `sequence-retired`.)
    ///
    /// This copies the store bytes directly rather than through export/import,
    /// which is not implemented on iOS yet.
    func genPeers(capacity: Int = 256, records: Int = 4, recordBytes: Int? = nil,
                  verifyAttemptLimit: Int = WcOneTime.verifyAttemptLimitDefault,
                  freezeThreshold: Int = WcOneTime.freezeThresholdDefault)
        throws -> (alice: Engine, aliceFs: MemoryFs, bob: Engine, bobFs: MemoryFs, pairId: String) {
        let aliceFs = MemoryFs()
        let alice = engine(aliceFs)
        let need = try Partition.requiredSourceLength(capacity: capacity, capacityRecords: records)
        let pairId = try alice.gen(
            label: "test",
            sources: [SourceInput(name: "s.bin", declaredOrigin: "declared",
                                  bytes: sourceBytes(need, seed: 7))],
            encryptionBytes: capacity, authRecords: records, recordBytes: recordBytes,
            verifyAttemptLimit: verifyAttemptLimit, freezeThreshold: freezeThreshold).pair.pairId
        // The handover happens HERE, at gen — before either side consumes
        // anything. After this the two copies advance independently.
        let (bob, bobFs) = try peer(of: aliceFs)
        return (alice, aliceFs, bob, bobFs, pairId)
    }

    func peer(of fs: MemoryFs, witnessFs: Fs? = nil) throws -> (Engine, MemoryFs) {
        let copy = MemoryFs()
        for path in fs.allPaths {
            if let bytes = try fs.readFile(path) { try copy.writeFileAtomic(path, bytes) }
        }
        return (Engine(fs: copy, witnessFs: witnessFs,
                       clock: { self.fixedInstant },
                       pairIdSource: { Hex.decode(self.fixedPairId)! }), copy)
    }

    // MARK: - gen

    func testGenProducesAWholePairAndTheScopedVerdict() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let need = try Partition.requiredSourceLength(capacity: 256, capacityRecords: 4)
        let result = try e.gen(label: "my pad",
                               sources: [SourceInput(name: "s.bin", declaredOrigin: "dice",
                                                     bytes: sourceBytes(need, seed: 3))],
                               encryptionBytes: 256, authRecords: 4)

        XCTAssertEqual(result.pair.pairId, fixedPairId)
        XCTAssertEqual(result.requiredSourceLength, need)
        XCTAssertEqual(result.verdict, genVerdict)
        XCTAssertTrue(result.verdict.hasPrefix("Uniform if at least one"),
                      "the §7 verdict is scoped and must never be promoted")
        XCTAssertEqual(result.pair.origin, .generatedHere)
        XCTAssertFalse(result.pair.destroyed)

        for d in [PadDirection.aToB, .bToA] {
            for name in [headFile, secretFile, journalFile] {
                XCTAssertTrue(fs.exists(storePath(storeDir(fixedPairId, d), name)),
                              "\(d.rawValue)/\(name) must exist")
            }
            let m = try XCTUnwrap(result.pair.meters[d])
            XCTAssertEqual(m.capacity, 256)
            XCTAssertEqual(m.nextOffset, 0)
            XCTAssertEqual(m.capacityRecords, 4)
            XCTAssertEqual(m.nextSequence, 0)
        }
    }

    /// pair.json is the COMMIT, and it is written last: a crash before it leaves a
    /// fresh store with no committed witness rather than a provisioned-but-unusable
    /// pair.
    func testGenWritesPairMetaLastAsTheCommit() throws {
        let inner = MemoryFs()
        let fs = FailOnWriteFs(inner: inner, failWhen: { $0.hasSuffix(pairMetaFile) })
        XCTAssertThrowsError(try engine(fs).gen(
            label: "x",
            sources: [SourceInput(name: "s.bin", declaredOrigin: "d",
                                  bytes: sourceBytes(try Partition.requiredSourceLength(
                                    capacity: 256, capacityRecords: 4), seed: 1))],
            encryptionBytes: 256, authRecords: 4))

        XCTAssertTrue(inner.exists(storePath(storeDir(fixedPairId, .aToB), headFile)),
                      "the store was written before the commit")
        XCTAssertFalse(inner.exists(pairMetaPath(fixedPairId)),
                       "pair.json is the commit and must not exist")
        // And the pair is not usable as a witnessed pad: with no committed
        // pair.json it reads as the legacy no-witness default, never as the
        // provisioned witness the interrupted gen was creating.
        let meta = try readPairMeta(fs: inner, pairId: fixedPairId)
        XCTAssertEqual(meta.witness, .none, "an uncommitted pair claims no witness")
        XCTAssertEqual(meta.origin, .unknown, "and no provenance")
    }

    func testGenRefusesASourceShorterThanTheWholeRequirement() throws {
        let need = try Partition.requiredSourceLength(capacity: 256, capacityRecords: 4)
        let r = refusal {
            _ = try self.engine(MemoryFs()).gen(
                label: "x",
                sources: [SourceInput(name: "short.bin", declaredOrigin: "d",
                                      bytes: self.sourceBytes(need - 1, seed: 1))],
                encryptionBytes: 256, authRecords: 4)
        }
        XCTAssertEqual(r?.reason, "source-too-short")
        XCTAssertTrue(r?.message.contains("short.bin") ?? false, "it must name the short source")
        XCTAssertTrue(r?.message.contains("Nothing was written") ?? false)
    }

    /// NO content-dependent deduplication. Two IDENTICAL sources are accepted:
    /// refusing them would condition the accepted distribution, and if one source
    /// is uniform and independent the XOR is uniform over the full space.
    func testGenAcceptsIdenticalSourcesWithoutInspectingTheirValues() throws {
        let need = try Partition.requiredSourceLength(capacity: 256, capacityRecords: 4)
        let same = sourceBytes(need, seed: 5)
        let result = try engine(MemoryFs()).gen(
            label: "x",
            sources: [SourceInput(name: "a.bin", declaredOrigin: "d", bytes: same),
                      SourceInput(name: "b.bin", declaredOrigin: "d", bytes: same)],
            encryptionBytes: 256, authRecords: 4)
        XCTAssertEqual(result.pair.pairId, fixedPairId)

        // And an ALL-ZERO combination is equally legitimate — it is one draw of a
        // uniform variable, not evidence of anything.
        let zeros = [UInt8](repeating: 0, count: need)
        XCTAssertNoThrow(try self.engine(MemoryFs()).gen(
            label: "x",
            sources: [SourceInput(name: "a.bin", declaredOrigin: "d", bytes: zeros)],
            encryptionBytes: 256, authRecords: 4))
    }

    func testGenRejectsMalformedParameters() {
        let need = 4096
        for (why, body) in [
            ("zero encryption bytes", { try self.engine(MemoryFs()).gen(
                label: "x", sources: [SourceInput(name: "s", declaredOrigin: "d", bytes: self.sourceBytes(need, seed: 1))],
                encryptionBytes: 0, authRecords: 4) }),
            ("zero auth records", { try self.engine(MemoryFs()).gen(
                label: "x", sources: [SourceInput(name: "s", declaredOrigin: "d", bytes: self.sourceBytes(need, seed: 1))],
                encryptionBytes: 256, authRecords: 0) }),
            ("no sources at all", { try self.engine(MemoryFs()).gen(
                label: "x", sources: [], encryptionBytes: 256, authRecords: 4) }),
            ("a record size that is not a multiple of 16", { try self.engine(MemoryFs()).gen(
                label: "x", sources: [SourceInput(name: "s", declaredOrigin: "d", bytes: self.sourceBytes(need, seed: 1))],
                encryptionBytes: 256, authRecords: 4, recordBytes: 33) }),
            ("a record size below 32", { try self.engine(MemoryFs()).gen(
                label: "x", sources: [SourceInput(name: "s", declaredOrigin: "d", bytes: self.sourceBytes(need, seed: 1))],
                encryptionBytes: 256, authRecords: 4, recordBytes: 16) }),
        ] as [(String, () throws -> GenResult)] {
            XCTAssertThrowsError(try body(), why)
        }
    }

    // MARK: - burn / open round trip

    func testAMessageRoundTripsAndConsumesExactlyItsLength() throws {
        let (e, _, bob, _, pairId) = try genPeers()
        let message = Array("attack at dawn".utf8)

        let burned = try e.burn(pairId: pairId, role: .a, plaintext: message)
        XCTAssertEqual(burned.encryptionBytes, message.count)
        XCTAssertEqual(burned.authRecords, 1)

        let abAfterBurn = try XCTUnwrap(burned.meters.meters[.aToB])
        XCTAssertEqual(abAfterBurn.nextOffset, message.count, "exactly the message length")
        XCTAssertEqual(abAfterBurn.nextSequence, 1)
        XCTAssertEqual(try XCTUnwrap(burned.meters.meters[.bToA]).nextOffset, 0,
                       "the other direction is untouched")

        // B opens A->B traffic, on B's OWN copy of the pair.
        let opened = try bob.open(pairId: pairId, role: .b, envelopeText: burned.envelope)
        XCTAssertEqual(opened.plaintext, message, "byte-exact")
        XCTAssertEqual(opened.skippedBytes, 0)
        XCTAssertEqual(opened.skippedRecords, 0)
    }

    /// A one-time pad is one-time. The SAME envelope opened twice is refused, and
    /// the refusal names the reason rather than silently succeeding.
    func testAnEnvelopeCannotBeOpenedTwice() throws {
        let (e, _, bob, _, pairId) = try genPeers()
        let burned = try e.burn(pairId: pairId, role: .a, plaintext: Array("once".utf8))
        _ = try bob.open(pairId: pairId, role: .b, envelopeText: burned.envelope)

        let r = refusal { _ = try bob.open(pairId: pairId, role: .b, envelopeText: burned.envelope) }
        XCTAssertEqual(r?.reason, "sequence-retired")
        XCTAssertTrue(r?.message.contains("Nothing was burned") ?? false)
    }

    func testTheWrongRoleAndTheWrongPairAreRefused() throws {
        let (e, _, bob, _, pairId) = try genPeers()
        let burned = try e.burn(pairId: pairId, role: .a, plaintext: Array("hi".utf8))

        // A burned A->B; A opening would be opening B->A traffic.
        XCTAssertEqual(refusal { _ = try bob.open(pairId: pairId, role: .a,
                                                  envelopeText: burned.envelope) }?.reason,
                       "wrong-direction")

        // A second, independent pair cannot open the first pair's envelope.
        let other = MemoryFs()
        let e2 = Engine(fs: other, clock: { self.fixedInstant },
                        pairIdSource: { Hex.decode("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")! })
        let otherId = try genPair(e2)
        XCTAssertEqual(refusal { _ = try e2.open(pairId: otherId, role: .b,
                                                 envelopeText: burned.envelope) }?.reason,
                       "wrong-pair")
    }

    /// A tampered tag costs a durable attempt and burns NEITHER namespace — the
    /// stated availability price of a finite forgery bound (§8.4).
    func testATamperedEnvelopeCostsAnAttemptAndConsumesNoPadMaterial() throws {
        let (e, _, bob, _, pairId) = try genPeers()
        let burned = try e.burn(pairId: pairId, role: .a, plaintext: Array("genuine".utf8))

        // Flip one hex digit of the tag.
        var forged = burned.envelope
        let tagRange = try XCTUnwrap(forged.range(of: "\"tag\":\""))
        let flipAt = forged.index(tagRange.upperBound, offsetBy: 1)
        forged.replaceSubrange(flipAt...flipAt, with: forged[flipAt] == "0" ? "1" : "0")

        let before = try XCTUnwrap(try bob.status(pairId).meters[.aToB])
        let r = refusal { _ = try bob.open(pairId: pairId, role: .b, envelopeText: forged) }
        XCTAssertEqual(r?.reason, "auth-failed")
        XCTAssertTrue(r?.message.contains("No pad material was consumed") ?? false)

        let after = try XCTUnwrap(try bob.status(pairId).meters[.aToB])
        XCTAssertEqual(after.nextOffset, before.nextOffset, "no encryption material consumed")
        XCTAssertEqual(after.nextSequence, before.nextSequence, "no auth material consumed")

        // And the genuine envelope still opens: a forgery attempt does not destroy
        // the real record.
        XCTAssertEqual(try bob.open(pairId: pairId, role: .b,
                                    envelopeText: burned.envelope).plaintext,
                       Array("genuine".utf8))
    }

    /// Exhausting the verification attempts makes a sequence permanently contested.
    func testASequenceBecomesPermanentlyContestedAfterItsAttemptLimit() throws {
        let (e, _, bob, _, pairId) = try genPeers(verifyAttemptLimit: 2, freezeThreshold: 100)
        let burned = try e.burn(pairId: pairId, role: .a, plaintext: Array("x".utf8))
        var forged = burned.envelope
        let tagRange = try XCTUnwrap(forged.range(of: "\"tag\":\""))
        let flipAt = forged.index(tagRange.upperBound, offsetBy: 1)
        forged.replaceSubrange(flipAt...flipAt, with: forged[flipAt] == "0" ? "1" : "0")

        XCTAssertEqual(refusal { _ = try bob.open(pairId: pairId, role: .b, envelopeText: forged) }?.reason,
                       "auth-failed")
        XCTAssertEqual(refusal { _ = try bob.open(pairId: pairId, role: .b, envelopeText: forged) }?.reason,
                       "auth-failed")
        // The budget is spent — and now even the GENUINE envelope cannot be
        // verified. That is the stated cost, not a bug.
        XCTAssertEqual(refusal { _ = try bob.open(pairId: pairId, role: .b,
                                                  envelopeText: burned.envelope) }?.reason,
                       "sequence-contested")
    }

    func testExhaustionIsRefusedRatherThanWrappingOrReusing() throws {
        let e = engine(MemoryFs())
        // Four records, and enough encryption for exactly four one-byte messages.
        let pairId = try genPair(e, capacity: 4, records: 4)
        for _ in 0..<4 { _ = try e.burn(pairId: pairId, role: .a, plaintext: [0x41]) }

        let r = refusal { _ = try e.burn(pairId: pairId, role: .a, plaintext: [0x41]) }
        XCTAssertTrue(r?.reason == "auth-exhausted" || r?.reason == "encryption-exhausted",
                      "got \(r?.reason ?? "nil")")
        XCTAssertTrue(r?.message.contains("Nothing was burned") ?? false)
    }

    func testAMessageLongerThanTheRemainingPadIsRefusedWhole() throws {
        let e = engine(MemoryFs())
        let pairId = try genPair(e, capacity: 8, records: 4)
        let r = refusal { _ = try e.burn(pairId: pairId, role: .a,
                                         plaintext: [UInt8](repeating: 0x41, count: 9)) }
        XCTAssertEqual(r?.reason, "encryption-exhausted")
        XCTAssertTrue(r?.message.contains("cannot borrow, wrap, or reuse") ?? false)
        XCTAssertEqual(try XCTUnwrap(try e.status(pairId).meters[.aToB]).nextOffset, 0,
                       "a refused burn consumes nothing")
    }

    // MARK: - fixed records (§16)

    func testAFixedRecordStoreHidesTheExactPlaintextLength() throws {
        let (e, _, bob, _, pairId) = try genPeers(recordBytes: 64)

        let short = try e.burn(pairId: pairId, role: .a, plaintext: Array("hi".utf8))
        XCTAssertEqual(short.encryptionBytes, 64, "every record costs exactly F")

        let opened = try bob.open(pairId: pairId, role: .b, envelopeText: short.envelope)
        XCTAssertEqual(opened.plaintext, Array("hi".utf8), "the frame's prefix selects the plaintext")

        // A message longer than F − 4 cannot be framed.
        let r = refusal { _ = try e.burn(pairId: pairId, role: .a,
                                         plaintext: [UInt8](repeating: 0x41, count: 61)) }
        XCTAssertEqual(r?.reason, "record-size-mismatch")
    }

    // MARK: - the freeze (§8.4)

    func testTheFreezeIsPairWideAndReversibleAndBurnsNothing() throws {
        let (e, _, bob, _, pairId) = try genPeers(verifyAttemptLimit: 8, freezeThreshold: 2)
        let burned = try e.burn(pairId: pairId, role: .a, plaintext: Array("x".utf8))
        var forged = burned.envelope
        let tagRange = try XCTUnwrap(forged.range(of: "\"tag\":\""))
        let flipAt = forged.index(tagRange.upperBound, offsetBy: 1)
        forged.replaceSubrange(flipAt...flipAt, with: forged[flipAt] == "0" ? "1" : "0")

        _ = refusal { _ = try bob.open(pairId: pairId, role: .b, envelopeText: forged) }
        _ = refusal { _ = try bob.open(pairId: pairId, role: .b, envelopeText: forged) }

        // Frozen — and the freeze is PAIR-WIDE: Bob's OTHER direction cannot burn
        // either, though nothing failed there.
        XCTAssertEqual(refusal { _ = try bob.burn(pairId: pairId, role: .b,
                                                  plaintext: Array("y".utf8)) }?.reason, "frozen")

        let offsetWhileFrozen = try XCTUnwrap(try bob.status(pairId).meters[.bToA]).nextOffset
        XCTAssertEqual(try bob.clearFreeze(pairId: pairId), 1, "one half was frozen")
        XCTAssertEqual(try XCTUnwrap(try bob.status(pairId).meters[.bToA]).nextOffset,
                       offsetWhileFrozen, "clear-freeze burns nothing and resets nothing")
        XCTAssertNoThrow(try bob.burn(pairId: pairId, role: .b, plaintext: Array("y".utf8)))
    }

    // MARK: - retire (§8.5)

    func testRetireSkipsForwardAndDestroysTheSkippedMaterialUnused() throws {
        let e = engine(MemoryFs())
        let pairId = try genPair(e, capacity: 256, records: 4)

        let summary = try e.retire(pairId: pairId, direction: .aToB, throughSequence: 1,
                                   throughOffset: 63, reason: "lost in transit")
        let m = try XCTUnwrap(summary.meters[.aToB])
        XCTAssertEqual(m.nextSequence, 2, "sequences 0 and 1 are retired")
        XCTAssertEqual(m.nextOffset, 64, "offsets through 63 are retired")

        // Retiring backwards is refused; retiring past capacity is refused.
        XCTAssertEqual(refusal { _ = try e.retire(pairId: pairId, direction: .aToB,
                                                  throughSequence: 0) }?.reason, "sequence-retired")
        XCTAssertEqual(refusal { _ = try e.retire(pairId: pairId, direction: .aToB,
                                                  throughSequence: 99) }?.reason, "sequence-malformed")
    }

    // MARK: - destroy (§17)

    func testDestroyRequiresThePairIdAndNeverEchoesIt() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let pairId = try genPair(e)

        for wrong in ["", "yes", "destroy", pairId.uppercased(), String(pairId.dropLast())] {
            let r = refusal { _ = try e.destroy(pairId: pairId, confirm: wrong) }
            XCTAssertEqual(r?.reason, "destroy-unconfirmed", "confirm=\"\(wrong)\"")
            XCTAssertFalse(r?.message.contains(pairId) ?? true,
                           "the prompt must NOT echo the pairId — the operator confirms by knowing it")
        }
        XCTAssertTrue(fs.exists(storePath(storeDir(pairId, .aToB), headFile)), "untouched")
    }

    func testADestroyedPadCanNeverResurrect() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let pairId = try genPair(e)
        _ = try e.burn(pairId: pairId, role: .a, plaintext: Array("last words".utf8))

        let result = try e.destroy(pairId: pairId, confirm: pairId, reason: "operator destroy")
        XCTAssertFalse(result.alreadyDestroyed)
        XCTAssertEqual(result.limitation, destroyLimitation)

        // Every store file is gone; the tombstone remains.
        for d in [PadDirection.aToB, .bToA] {
            for name in [headFile, secretFile, journalFile] {
                XCTAssertFalse(fs.exists(storePath(storeDir(pairId, d), name)), "\(d.rawValue)/\(name)")
            }
        }
        XCTAssertTrue(fs.exists(tombstonePath(pairId)))

        for (why, body) in [
            ("burn", { _ = try e.burn(pairId: pairId, role: .a, plaintext: [0x41]) }),
            ("status", { _ = try e.status(pairId) }),
            ("retire", { _ = try e.retire(pairId: pairId, direction: .aToB, throughSequence: 1) }),
            ("clear-freeze", { _ = try e.clearFreeze(pairId: pairId) }),
        ] as [(String, () throws -> Void)] {
            XCTAssertEqual(refusal(body)?.reason, "pair-destroyed", why)
        }
    }

    /// Destroy is IDEMPOTENT: finishing an already-finished destruction reports it
    /// and changes nothing — including the recorded destroyedAt.
    func testDestroyIsIdempotentAndPreservesTheOriginalTombstone() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let pairId = try genPair(e)
        _ = try e.destroy(pairId: pairId, confirm: pairId)
        let first = try XCTUnwrap(try fs.readFile(tombstonePath(pairId)))

        let again = try e.destroy(pairId: pairId, confirm: pairId, reason: "different reason")
        XCTAssertTrue(again.alreadyDestroyed)
        XCTAssertEqual(try fs.readFile(tombstonePath(pairId)), first,
                       "the original destroyedAt is the historical truth and is preserved")
    }

    /// A store too corrupt to yield a pairId still destroys — under the literal
    /// token, so the operator cannot destroy the wrong thing by guessing.
    func testAPairTooCorruptToNameIsDestroyedUnderTheLiteralToken() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let pairId = try genPair(e)
        // Corrupt BOTH heads so no pairId can be salvaged.
        for d in [PadDirection.aToB, .bToA] {
            try fs.writeFileAtomic(storePath(storeDir(pairId, d), headFile), Array("{".utf8))
        }
        XCTAssertEqual(refusal { _ = try e.destroy(pairId: pairId, confirm: pairId) }?.reason,
                       "destroy-unconfirmed")
        XCTAssertNoThrow(try e.destroy(pairId: pairId, confirm: unreadablePairToken))
        XCTAssertTrue(fs.exists(tombstonePath(pairId)))
    }

    // MARK: - listing

    func testTheListShowsDestroyedPairsWithoutFabricatingMeters() throws {
        let fs = MemoryFs()
        let alive = try genPair(engine(fs, pairId: "11111111111111111111111111111111"))
        let dead = try genPair(engine(fs, pairId: "22222222222222222222222222222222"))
        _ = try engine(fs).destroy(pairId: dead, confirm: dead)

        let rows = try engine(fs).listSummaries()
        XCTAssertEqual(rows.count, 2)
        let aliveRow = try XCTUnwrap(rows.first { $0.pairId == alive })
        let deadRow = try XCTUnwrap(rows.first { $0.pairId == dead })

        XCTAssertFalse(aliveRow.destroyed)
        XCTAssertNotNil(aliveRow.summary)
        XCTAssertTrue(deadRow.destroyed)
        XCTAssertNil(deadRow.summary,
                     "a destroyed pair has NO meters — zero-filling would render it as an "
                     + "exhausted-but-live pad, which is a different fact")
    }

    func testListPairsIgnoresAnythingThatIsNotAPairDirectory() throws {
        let fs = MemoryFs()
        _ = try genPair(engine(fs))
        try fs.writeFileAtomic("witness/\(fixedPairId).log", [1])
        try fs.writeFileAtomic("\(stagingRoot)/x/y", [1])
        try fs.writeFileAtomic("not-a-pair-id/a-to-b/head.json", [1])

        XCTAssertEqual(try engine(fs).listPairs(), [fixedPairId])
    }

    // MARK: - the deployment verdict is derived, never stored

    func testTheVerdictIsDerivedAndAnIosPadNeverReachesTheStrongestOne() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let pairId = try genPair(e)
        let m = try XCTUnwrap(try e.status(pairId).meters[.aToB])

        XCTAssertNotEqual(m.deployment.assessment, .conditionallyEligible,
                          "an iOS pad must never reach CONDITIONALLY ELIGIBLE")
        XCTAssertEqual(m.sourceClass, .externalDeclared, "an operator-declared source")
        XCTAssertNotNil(m.deployment.knownReason, "a non-eligible verdict must say why")

        // NOT STORED: no file the engine writes carries a verdict field.
        for path in fs.allPaths {
            guard let bytes = try fs.readFile(path),
                  let text = String(bytes: bytes, encoding: .utf8) else { continue }
            for token in ["conditionally-eligible", "not-eligible", "insufficient-evidence",
                          "perfectSecrecy", "shannonSecure"] {
                XCTAssertFalse(text.contains(token), "\(path) must not persist a verdict (\(token))")
            }
        }
    }

    /// A pad whose only source is the platform CSPRNG is a HARD disqualifier, and
    /// it is derived from the recorded source name, not from a flag.
    func testADeviceRandomOnlyPadIsNotEligible() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let need = try Partition.requiredSourceLength(capacity: 256, capacityRecords: 4)
        let pairId = try e.gen(label: "x",
                               sources: [SourceInput(name: deviceSourceNameWire,
                                                     declaredOrigin: "the device CSPRNG",
                                                     bytes: sourceBytes(need, seed: 13))],
                               encryptionBytes: 256, authRecords: 4).pair.pairId
        let m = try XCTUnwrap(try e.status(pairId).meters[.aToB])
        XCTAssertEqual(m.sourceClass, .softwareCsprng)
        XCTAssertEqual(m.deployment.assessment, .notEligible)
        XCTAssertEqual(m.deployment.knownReason,
                       "the source material was generated by a software CSPRNG")
    }

    /// A pad SENT by sealed transfer is permanently NOT ELIGIBLE — and a TORN
    /// sealed marker counts too, because an honesty evaluator may only under-claim.
    func testSealedSendIsPermanentlyDisqualifyingIncludingWhenTheMarkerIsTorn() throws {
        for (why, marker) in [
            ("a valid sealed marker",
             #"{"version":1,"pairId":"PAIR","mode":"sealed","at":"2025-09-01T00:00:00.000Z","requestHash":"a","packageIdentity":"b","confirmHash":"c"}"#),
            ("a torn marker", "{not json"),
        ] {
            let fs = MemoryFs()
            let e = engine(fs)
            let pairId = try genPair(e)
            XCTAssertNotEqual(try XCTUnwrap(try e.status(pairId).meters[.aToB]).deployment.assessment,
                              .notEligible, "[\(why)] control: not disqualified before the marker")

            try fs.writeFileAtomic(handoffMarkerPath(pairId),
                                   Array(marker.replacingOccurrences(of: "PAIR", with: pairId).utf8))
            let m = try XCTUnwrap(try e.status(pairId).meters[.aToB])
            XCTAssertEqual(m.deployment.assessment, .notEligible, "[\(why)]")
            XCTAssertTrue(m.deployment.knownReason?.contains("sealed") ?? false, "[\(why)]")
        }
    }

    /// A PHYSICAL handoff is the air-gapped route and is deliberately NOT
    /// disqualifying.
    func testAPhysicalHandoffIsNotSealedAncestry() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let pairId = try genPair(e)
        try commitPhysicalHandoff(fs: fs, pairId: pairId, at: isoNow(fixedInstant))
        let m = try XCTUnwrap(try e.status(pairId).meters[.aToB])
        XCTAssertNotEqual(m.deployment.assessment, .notEligible,
                          "a physically handed-off pad is not computationally delivered")
    }

    // MARK: - BURN-BEFORE-OUTPUT and PERSIST-BEFORE-USE

    /// If the durable commit at S2 fails, the envelope MUST NOT exist outside the
    /// call. Loss is acceptable; an emitted envelope over unadvanced counters
    /// would be reuse.
    func testAFailedDurableCommitWithholdsTheEnvelope() throws {
        let inner = MemoryFs()
        let seed = engine(inner)
        let pairId = try genPair(seed)
        let before = try XCTUnwrap(try seed.status(pairId).meters[.aToB])

        let failing = FailOnWriteFs(inner: inner, failWhen: { $0.hasSuffix("a-to-b/\(headFile)") })
        let e = Engine(fs: failing, clock: { self.fixedInstant })
        XCTAssertThrowsError(try e.burn(pairId: pairId, role: .a, plaintext: Array("secret".utf8)),
                             "a failed S2 must throw, not return an envelope")

        let after = try XCTUnwrap(try seed.status(pairId).meters[.aToB])
        XCTAssertEqual(after.nextOffset, before.nextOffset)
        XCTAssertEqual(after.nextSequence, before.nextSequence)
    }

    /// The attempt is reserved DURABLY before the tag is checked, so a crash
    /// between them cannot refill the attempt budget.
    func testTheVerificationAttemptIsReservedBeforeTheTagIsChecked() throws {
        let inner = MemoryFs()
        let e = engine(inner)
        let pairId = try genPair(e)
        let burned = try e.burn(pairId: pairId, role: .a, plaintext: Array("x".utf8))

        // Fail the journal APPEND that records the reservation. The open must not
        // proceed to verify at all.
        let failing = FailOnAppendFs(inner: inner, failWhen: { $0.hasSuffix(journalFile) })
        let e2 = Engine(fs: failing, clock: { self.fixedInstant })
        XCTAssertThrowsError(try e2.open(pairId: pairId, role: .b, envelopeText: burned.envelope))

        // Nothing was released and nothing advanced.
        let m = try XCTUnwrap(try e.status(pairId).meters[.bToA])
        XCTAssertEqual(m.nextSequence, 0)
        XCTAssertEqual(m.nextOffset, 0)
    }

    // MARK: - the rollback witness

    /// A witness in a SEPARATE domain catches a store rewind before anything is
    /// consumed. This is what the Keychain backing is for.
    func testAWitnessInASeparateDomainRefusesARewoundStore() throws {
        let store = MemoryFs()
        let witness = MemoryFs()
        let e = Engine(fs: store, witnessFs: witness, clock: { self.fixedInstant },
                       pairIdSource: { Hex.decode(self.fixedPairId)! })
        let pairId = try genPair(e)
        _ = try e.burn(pairId: pairId, role: .a, plaintext: Array("spent".utf8))

        // Roll the STORE back to genesis, leaving the witness alone — the shape of
        // a restore from a backup that does not carry the witness.
        let rewound = MemoryFs()
        let e2 = Engine(fs: rewound, witnessFs: witness, clock: { self.fixedInstant },
                        pairIdSource: { Hex.decode(self.fixedPairId)! })
        _ = try genPair(e2)

        let r = refusal { _ = try e2.burn(pairId: pairId, role: .a, plaintext: Array("reuse?".utf8)) }
        XCTAssertEqual(r?.reason, "witness-regressed",
                       "a rewound store must be refused BEFORE any material is consumed")
    }

    /// pair.json's witness field is load-bearing: a corrupt one must not silently
    /// become "no witness", which would bypass a provisioned one.
    func testACorruptPairMetaRefusesEveryVerbRatherThanBypassingTheWitness() throws {
        let fs = MemoryFs()
        let e = engine(fs)
        let pairId = try genPair(e)
        try fs.writeFileAtomic(pairMetaPath(pairId), Array("{\"witness\":\"nope\"}".utf8))

        for (why, body) in [
            ("burn", { _ = try e.burn(pairId: pairId, role: .a, plaintext: [0x41]) }),
            ("status", { _ = try e.status(pairId) }),
        ] as [(String, () throws -> Void)] {
            XCTAssertEqual(refusal(body)?.reason, "corrupt-pair-meta", why)
        }
    }
}

// MARK: - fault injection

/// Fails the FIRST atomic write whose path matches, then behaves normally — the
/// shape of a device that fills up or a container that goes away mid-transaction.
private final class FailOnWriteFs: Fs, @unchecked Sendable {
    let inner: Fs
    let failWhen: (String) -> Bool
    private var fired = false

    init(inner: Fs, failWhen: @escaping (String) -> Bool) {
        self.inner = inner
        self.failWhen = failWhen
    }

    func readFile(_ path: String) throws -> [UInt8]? { try inner.readFile(path) }
    func writeFileAtomic(_ path: String, _ data: [UInt8]) throws {
        if !fired, failWhen(path) { fired = true; throw FsFailure.io("simulated write failure: \(path)") }
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

/// The same, for appends — the journal's write shape.
private final class FailOnAppendFs: Fs, @unchecked Sendable {
    let inner: Fs
    let failWhen: (String) -> Bool
    private var fired = false

    init(inner: Fs, failWhen: @escaping (String) -> Bool) {
        self.inner = inner
        self.failWhen = failWhen
    }

    func readFile(_ path: String) throws -> [UInt8]? { try inner.readFile(path) }
    func writeFileAtomic(_ path: String, _ data: [UInt8]) throws { try inner.writeFileAtomic(path, data) }
    func appendFile(_ path: String, _ data: [UInt8]) throws {
        if !fired, failWhen(path) { fired = true; throw FsFailure.io("simulated append failure: \(path)") }
        try inner.appendFile(path, data)
    }
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
