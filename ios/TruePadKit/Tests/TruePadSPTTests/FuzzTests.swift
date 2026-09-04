import Foundation
@testable import TruePadCore
@testable import TruePadSPT
@testable import TruePadStorage
import XCTest

/// EVERY PARSER MEETS HOSTILE BYTES AND REFUSES.
///
/// Each of these decoders sits at a boundary where the input came from somewhere
/// else — a scanned code, a pasted string, a file the operator chose, a store that
/// may have been restored from a backup. The property under test is the same for
/// all of them:
///
///     for ANY input, the parser returns a typed refusal or a valid value.
///     It never crashes, never traps, and never returns something half-built.
///
/// The generator is SEEDED, so a failure is reproducible from the seed printed in
/// the assertion rather than being a story about a run nobody can repeat.
///
/// WHAT THIS IS NOT: it is not coverage-guided fuzzing, and it is not a claim that
/// these parsers are exhaustively explored. It is a broad randomized sweep plus
/// the structure-aware mutations that actually reach past a length check.
final class FuzzTests: XCTestCase {
    /// A small deterministic PRNG. Not cryptographic and does not need to be —
    /// its only job is to be reproducible from a seed.
    struct Rng {
        var state: UInt64
        init(seed: UInt64) { state = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407 }
        mutating func next() -> UInt64 {
            state ^= state << 13
            state ^= state >> 7
            state ^= state << 17
            return state
        }
        mutating func byte() -> UInt8 { UInt8(truncatingIfNeeded: next()) }
        mutating func int(_ upper: Int) -> Int { upper <= 0 ? 0 : Int(next() % UInt64(upper)) }
        mutating func bytes(_ count: Int) -> [UInt8] { (0..<count).map { _ in byte() } }
    }

    /// Iterations per parser. Kept modest so this runs in CI on every push rather
    /// than being a thing someone remembers to do.
    let rounds = 3000

    // MARK: - random bytes and random text

    func testEveryWireParserSurvivesRandomInput() {
        var rng = Rng(seed: 0xA5A5_1234_DEAD_BEEF)
        for round in 0..<rounds {
            let length = rng.int(2400)
            let raw = rng.bytes(length)
            let text = String(decoding: raw, as: UTF8.self)
            let context = "round \(round), length \(length)"

            // Each of these must return, not trap. A crash here is the finding.
            _ = EnvelopeCodec.decode(text)
            _ = CompactEnvelope.decode(text)
            _ = CompactEnvelope.decodeTransport(text)
            _ = ReceiveRequestCodec.decode(text)
            _ = ReceiveRequestCodec.parseBody(raw)
            _ = SealedPackageCodec.parse(raw)
            _ = SealedPackageCodec.packageIdentity(raw)
            _ = unpackContainer(raw)
            _ = try? parseStrictJson(text)
            _ = CompactEnvelope.fromBase64Url(text)
            _ = SptBytes.fromBase64Url(text)
            _ = IsoTime.parseMillis(text)
            _ = Hex.decode(text)
            XCTAssertTrue(true, context)   // reached: nothing trapped
        }
    }

    /// Text that LOOKS like each format, so the parser gets past its first gate
    /// and into the interesting code.
    func testStructureAwareMutationsAreRefusedNotAccepted() throws {
        var rng = Rng(seed: 0x0BAD_C0DE_0BAD_C0DE)
        let prefixes = ["TPR2:", "TP2:", "TPS2", "{", "[", "{\"formatVersion\":2,",
                        "{\"version\":1,", "\"", "-", "0"]
        for round in 0..<rounds {
            let prefix = prefixes[rng.int(prefixes.count)]
            let body = rng.bytes(rng.int(400))
            let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=+/{}\":,")
            let text = prefix + String(body.map { alphabet[Int($0) % alphabet.count] })
            let context = "round \(round), prefix \(prefix)"

            // Whatever comes back must be a REFUSAL or a value — never a partial.
            switch CompactEnvelope.decodeTransport(text) {
            case .ok(let e):
                // If it decoded, it must survive a round trip through the
                // canonical encoder. A parser that accepts something it cannot
                // re-emit has accepted a message with no canonical form.
                XCTAssertNoThrow(try EnvelopeCodec.encode(e), context)
            case .refused(_, let message):
                XCTAssertFalse(message.isEmpty, "\(context): a refusal must say something")
            }
            switch ReceiveRequestCodec.decode(text) {
            case .ok(let request, let canonicalBody):
                XCTAssertEqual(canonicalBody.count, SptConstants.tpr2BodyBytes, context)
                XCTAssertEqual(request.requestId.count, SptConstants.requestIdBytes, context)
            case .failed(_, let message):
                XCTAssertFalse(message.isEmpty, context)
            }
            _ = unpackContainer(Array(text.utf8))
        }
    }

    /// BIT FLIPS IN A VALID MESSAGE. Every single-bit change to a real envelope,
    /// request or package must either decode to something still canonical, or be
    /// refused — never accepted as a DIFFERENT valid message with no canonical
    /// spelling.
    func testSingleBitFlipsInValidMessagesNeverProduceANonCanonicalAccept() throws {
        let fs = MemoryFs()
        let e = Engine(fs: fs, clock: { Date(timeIntervalSince1970: 1_756_684_800) },
                       pairIdSource: { Hex.decode("5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4")! })
        let need = try Partition.requiredSourceLength(capacity: 256, capacityRecords: 4)
        let pairId = try e.gen(label: "fuzz",
                               sources: [SourceInput(name: "s", declaredOrigin: "d",
                                                     bytes: [UInt8](repeating: 0x2B, count: need))],
                               encryptionBytes: 256, authRecords: 4).pair.pairId
        let burned = try e.burn(pairId: pairId, role: .a, plaintext: Array("fuzz me".utf8))
        guard case .ok(let envelope) = EnvelopeCodec.decode(burned.envelope) else {
            return XCTFail("setup")
        }
        let compact = try CompactEnvelope.encode(envelope)
        let request = try e.sptCreateReceiveRequest()

        for (name, original) in [("compact envelope", compact), ("receive request", request.tpr2Text)] {
            var chars = Array(original)
            let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
            // Every position, one substitution each — cheap and exhaustive over
            // positions, which is where a length or offset bug lives.
            for i in chars.indices {
                let saved = chars[i]
                chars[i] = alphabet[(alphabet.firstIndex(of: saved).map { $0 + 1 } ?? 0) % alphabet.count]
                let mutated = String(chars)
                chars[i] = saved
                guard mutated != original else { continue }

                if name == "compact envelope" {
                    if case .ok(let decoded) = CompactEnvelope.decode(mutated) {
                        // Accepted: then it must re-encode to EXACTLY the text
                        // that produced it. One message, one spelling.
                        XCTAssertEqual(try? CompactEnvelope.encode(decoded), mutated,
                                       "\(name) position \(i): accepted a non-canonical spelling")
                    }
                } else {
                    if case .ok(let r, let body) = ReceiveRequestCodec.decode(mutated) {
                        XCTAssertEqual(body.count, SptConstants.tpr2BodyBytes, "\(name) position \(i)")
                        XCTAssertEqual(
                            try? ReceiveRequestCodec.encode(requestId: r.requestId,
                                                            encapsulationKey: r.encapsulationKey),
                            mutated,
                            "\(name) position \(i): accepted a non-canonical spelling")
                    }
                }
            }
        }
    }

    /// THE ALIAS CASE: two spellings of the SAME bytes.
    ///
    /// A single in-alphabet substitution changes the decoded bytes, so it can
    /// never produce a second spelling of one message — which is why the bit-flip
    /// sweep above cannot test the canonicality rule, and does not claim to. The
    /// real alias lives in the FINAL base64url character, whose low bits encode
    /// nothing when the byte count is not a multiple of three. Every such alias
    /// must be REFUSED, or one message would have several valid spellings and
    /// there would be no answer to which was "the" message.
    func testAliasSpellingsOfTheSameBytesAreRefused() throws {
        let fs = MemoryFs()
        let e = Engine(fs: fs, clock: { Date(timeIntervalSince1970: 1_756_684_800) },
                       pairIdSource: { Hex.decode("5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4")! })
        // Enough records for one burn per message length below.
        let need = try Partition.requiredSourceLength(capacity: 512, capacityRecords: 16)
        let pairId = try e.gen(label: "alias",
                               sources: [SourceInput(name: "s", declaredOrigin: "d",
                                                     bytes: [UInt8](repeating: 0x2B, count: need))],
                               encryptionBytes: 512, authRecords: 16).pair.pairId

        var aliasesFound = 0
        // Several message lengths, so at least some payloads land on a byte count
        // that leaves spare bits in the last character.
        for length in 1...12 {
            let burned = try e.burn(pairId: pairId, role: .a,
                                    plaintext: [UInt8](repeating: 0x41, count: length))
            guard case .ok(let envelope) = EnvelopeCodec.decode(burned.envelope) else { continue }
            let original = try CompactEnvelope.encode(envelope)
            let payload = String(original.dropFirst(CompactEnvelope.prefix.count))
            guard let bytes = CompactEnvelope.fromBase64Url(payload) else { continue }

            var chars = Array(payload)
            let last = chars.count - 1
            let saved = chars[last]
            for candidate in CompactEnvelope.b64urlAlphabet where candidate != saved {
                chars[last] = candidate
                let aliasPayload = String(chars)
                chars[last] = saved
                // An ALIAS is a different text that decodes to the SAME bytes.
                guard CompactEnvelope.fromBase64Url(aliasPayload) == bytes else { continue }
                aliasesFound += 1
                guard case .refused = CompactEnvelope.decode(CompactEnvelope.prefix + aliasPayload) else {
                    return XCTFail("an alias spelling of the same message must be REFUSED "
                                   + "(length \(length))")
                }
            }
        }
        XCTAssertGreaterThan(aliasesFound, 0,
                             "no alias was constructible, so this test proved nothing")
    }

    /// TRUNCATION AT EVERY LENGTH. A parser that reads past the end of a short
    /// buffer is the classic finding here, and every prefix of a valid message
    /// exercises exactly that.
    func testEveryTruncationOfAValidMessageIsRefusedCleanly() throws {
        let fs = MemoryFs()
        let e = Engine(fs: fs, clock: { Date(timeIntervalSince1970: 1_756_684_800) },
                       pairIdSource: { Hex.decode("5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4")! })
        let need = try Partition.requiredSourceLength(capacity: 256, capacityRecords: 4)
        let pairId = try e.gen(label: "fuzz",
                               sources: [SourceInput(name: "s", declaredOrigin: "d",
                                                     bytes: [UInt8](repeating: 0x2B, count: need))],
                               encryptionBytes: 256, authRecords: 4).pair.pairId
        let container = try e.exportPair(pairId: pairId).container
        let burned = try e.burn(pairId: pairId, role: .a, plaintext: Array("truncate me".utf8))

        // Every prefix of the courier container.
        for cut in stride(from: 0, to: container.count, by: max(1, container.count / 400)) {
            if case .ok = unpackContainer(Array(container[0..<cut])), cut < container.count {
                XCTFail("a truncated container must not unpack (cut at \(cut))")
            }
        }
        // Every prefix of the canonical envelope text.
        let text = Array(burned.envelope)
        for cut in 0..<text.count {
            if case .ok = EnvelopeCodec.decode(String(text[0..<cut])) {
                XCTFail("a truncated envelope must not decode (cut at \(cut))")
            }
        }
    }

    /// The DURABLE readers meet hostile bytes too. A store file, a witness log or
    /// an SPT record may have been restored, copied, or corrupted; none of these
    /// may crash, and none may report a torn record as absence.
    func testTheDurableReadersSurviveHostileBytes() {
        var rng = Rng(seed: 0xFEED_FACE_CAFE_D00D)
        let pairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        for round in 0..<600 {
            let blob = rng.bytes(rng.int(300))
            let fs = MemoryFs()
            let vfs = MemorySptVfs()
            let context = "round \(round)"

            try? fs.writeFileAtomic(pairMetaPath(pairId), blob)
            _ = try? readPairMeta(fs: fs, pairId: pairId)

            try? fs.writeFileAtomic(tombstonePath(pairId), blob)
            XCTAssertTrue(readTombstone(fs: fs, pairId: pairId).exists,
                          "\(context): a present tombstone is never absent")

            try? fs.writeFileAtomic(handoffMarkerPath(pairId), blob)
            XCTAssertNotEqual(readHandoffState(fs: fs, pairId: pairId), .absent,
                              "\(context): a present handoff marker is never absent")

            try? vfs.writeFileAtomic(markerPath(pairId), blob)
            if case .absent = sptReadHandoffState(vfs: vfs, pairId: pairId) {
                XCTFail("\(context): a present SPT marker is never absent")
            }

            try? vfs.writeFileAtomic(consumedPath(pairId), blob)
            if case .absent = readReceiverState(vfs: vfs, idHex: pairId, nowMillis: 0) {
                XCTFail("\(context): a present terminal marker is never absent")
            }

            _ = try? parseClaim(blob, requestHash: [UInt8](repeating: 0, count: 32))
            _ = try? parseConfirmed(blob, requestHashHex: String(repeating: "a", count: 64))
            _ = try? parseStoredRequest(blob, idHex: pairId)
            _ = loadStore(fs: fs, prefix: storeDir(pairId, .aToB))
        }
    }

    /// A head.json mutated one byte at a time either loads to something coherent
    /// or is refused. It must never load to a store whose counters disagree with
    /// the file it came from.
    func testAMutatedStoreHeaderNeverLoadsIncoherently() throws {
        let fs = MemoryFs()
        let e = Engine(fs: fs, clock: { Date(timeIntervalSince1970: 1_756_684_800) },
                       pairIdSource: { Hex.decode("5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4")! })
        let need = try Partition.requiredSourceLength(capacity: 256, capacityRecords: 4)
        let pairId = try e.gen(label: "fuzz",
                               sources: [SourceInput(name: "s", declaredOrigin: "d",
                                                     bytes: [UInt8](repeating: 0x2B, count: need))],
                               encryptionBytes: 256, authRecords: 4).pair.pairId
        let prefix = storeDir(pairId, .aToB)
        let original = try XCTUnwrap(try fs.readFile(storePath(prefix, headFile)))

        var rng = Rng(seed: 0x1234_5678_9ABC_DEF0)
        for _ in 0..<800 {
            var mutated = original
            mutated[rng.int(mutated.count)] = rng.byte()
            let probe = MemoryFs()
            for path in fs.allPaths {
                if let bytes = try fs.readFile(path) { try probe.writeFileAtomic(path, bytes) }
            }
            try probe.writeFileAtomic(storePath(prefix, headFile), mutated)

            switch loadStore(fs: probe, prefix: prefix) {
            case .refused(let reason, let message):
                XCTAssertFalse(reason.isEmpty)
                XCTAssertFalse(message.isEmpty)
            case .ok(let store):
                // If it loaded, the invariants the rest of the engine relies on
                // must hold — a store that loads incoherently is worse than one
                // that refuses.
                XCTAssertGreaterThanOrEqual(store.effective.nextOffset, 0)
                XCTAssertLessThanOrEqual(store.effective.nextOffset, store.head.capacity)
                XCTAssertGreaterThanOrEqual(store.effective.nextSequence, 0)
                XCTAssertLessThanOrEqual(store.effective.nextSequence, store.head.capacityRecords)
                XCTAssertEqual(store.head.pairId.count, 32)
            }
        }
    }
}
