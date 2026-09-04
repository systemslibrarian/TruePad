import Foundation
import TruePadCore
@testable import TruePadStorage
import XCTest

/// The product bookkeeping ABOUT a pad — pair.json, the §17 tombstone, and the
/// one-handoff marker.
///
/// WHERE THE EXPECTED BYTES COME FROM. They are not invented here. The tombstone
/// string is what `node bin/truepad2.mjs destroy` actually wrote to disk — the
/// frozen authority, captured byte for byte. The pair.json and handoff.json
/// strings are what Android's `writePairMeta` / `commitPhysicalHandoff` actually
/// produced for the same inputs, and the ISO timestamps are what Android's
/// `isoNow` returned for the same epoch milliseconds. Only the `witness` value
/// differs, and that is deliberate: pair.json is edition-LOCAL and is not one of
/// the six courier files, so `ios-local-witness` is the correct value there in a
/// way `android-local-witness` would not be.
final class MetaTests: XCTestCase {
    let pairId = "8ff10e82d663d7b0bc26e3fefab0cd7f"
    let at = "2026-09-04T11:28:34.679Z"

    func text(_ fs: Fs, _ path: String) throws -> String {
        String(decoding: try XCTUnwrap(try fs.readFile(path)), as: UTF8.self)
    }

    // MARK: - byte-exact serialization

    func testPairMetaSerializesExactlyLikeTheOtherEditions() throws {
        let fs = MemoryFs()
        try writePairMeta(fs: fs, meta: PairMeta(
            pairId: pairId, label: #"my "pad""#, createdAt: at,
            witness: .local, origin: .generatedHere))

        XCTAssertEqual(
            try text(fs, pairMetaPath(pairId)),
            #"{"pairId":"8ff10e82d663d7b0bc26e3fefab0cd7f","label":"my \"pad\"","createdAt":"2026-09-04T11:28:34.679Z","witness":"ios-local-witness","origin":"generated-here"}"#)
    }

    /// The exact bytes `truepad2 destroy` writes, including the two-space
    /// indentation of `JSON.stringify(t, null, 2)` and no trailing newline.
    func testTombstoneSerializesExactlyLikeTheFrozenCli() throws {
        let fs = MemoryFs()
        try writeTombstone(fs: fs, pairId: pairId, resolvedPairId: pairId,
                           destroyedAt: at, reason: "operator destroy",
                           ab: HighWaters(nextOffset: 5, nextSequence: 1),
                           ba: HighWaters(nextOffset: 0, nextSequence: 0))

        XCTAssertEqual(try text(fs, tombstonePath(pairId)), """
        {
          "formatVersion": 2,
          "pairId": "8ff10e82d663d7b0bc26e3fefab0cd7f",
          "destroyedAt": "2026-09-04T11:28:34.679Z",
          "reason": "operator destroy",
          "finalHighWaters": {
            "A->B": {
              "nextOffset": 5,
              "nextSequence": 1
            },
            "B->A": {
              "nextOffset": 0,
              "nextSequence": 0
            }
          },
          "limitation": "Software can forget its reference to pad material; it cannot prove that flash forgot the bytes."
        }
        """)
    }

    /// A store too corrupt to read still gets a tombstone: the boundary does not
    /// depend on being able to parse what is being destroyed.
    func testTombstoneWithNoResolvablePairIdOrCounters() throws {
        let fs = MemoryFs()
        try writeTombstone(fs: fs, pairId: "aa", resolvedPairId: nil,
                           destroyedAt: at, reason: "unreadable", ab: nil, ba: nil)

        XCTAssertEqual(try text(fs, tombstonePath("aa")), """
        {
          "formatVersion": 2,
          "pairId": null,
          "destroyedAt": "2026-09-04T11:28:34.679Z",
          "reason": "unreadable",
          "finalHighWaters": {
            "A->B": null,
            "B->A": null
          },
          "limitation": "Software can forget its reference to pad material; it cannot prove that flash forgot the bytes."
        }
        """)
    }

    func testHandoffMarkerSerializesExactlyLikeAndroid() throws {
        let fs = MemoryFs()
        try commitPhysicalHandoff(fs: fs, pairId: pairId, at: at)
        XCTAssertEqual(
            try text(fs, handoffMarkerPath(pairId)),
            #"{"version":1,"pairId":"8ff10e82d663d7b0bc26e3fefab0cd7f","mode":"physical","at":"2026-09-04T11:28:34.679Z"}"#)
    }

    // MARK: - timestamps

    /// Built by hand rather than by DateFormatter, so it cannot pick up a locale,
    /// a calendar or a time zone from the device. The values are Android's.
    func testIsoNowMatchesTheOtherEditionsIncludingBeforeTheEpoch() {
        XCTAssertEqual(isoNow(Date(timeIntervalSince1970: 0)), "1970-01-01T00:00:00.000Z")
        XCTAssertEqual(isoNow(Date(timeIntervalSince1970: -0.001)), "1969-12-31T23:59:59.999Z")
        XCTAssertEqual(isoNow(Date(timeIntervalSince1970: 1_757_000_914.679)),
                       "2025-09-04T15:48:34.679Z")
        // A leap day, and the century rule that catches a naive implementation.
        XCTAssertEqual(isoNow(Date(timeIntervalSince1970: 951_782_400)), "2000-02-29T00:00:00.000Z")
    }

    func testIsoRoundTripsForEveryMillisecondBoundaryWeCareAbout() throws {
        for seconds in [0.0, 1.0, 86_399.0, 86_400.0, 1_000_000_000.0, 1_757_000_914.679, -1.0] {
            let rendered = isoNow(Date(timeIntervalSince1970: seconds))
            let parsed = try XCTUnwrap(parseIsoInstant(rendered), "\(rendered) must re-parse")
            XCTAssertEqual(isoNow(parsed), rendered, "round trip must be exact for \(seconds)")
        }
    }

    func testOnlyTheCanonicalSpellingParses() {
        for bad in [
            "2026-09-04T11:28:34Z",             // no milliseconds
            "2026-09-04T11:28:34.679+00:00",    // offset rather than Z
            "2026-09-04T11:28:34.6790Z",        // too many digits
            "2026-9-04T11:28:34.679Z",          // unpadded month
            "2026-09-04 11:28:34.679Z",         // space rather than T
            "2026-09-04T11:28:34.679z",         // lowercase z
            "2026-13-04T11:28:34.679Z",         // month 13
            "2026-09-04T24:28:34.679Z",         // hour 24
            "",
        ] {
            XCTAssertNil(parseIsoInstant(bad), "\(bad) must not parse")
        }
    }

    // MARK: - pair.json fails CLOSED

    /// A pair with NO pair.json is a bare FORMAT-V2 store this app never
    /// provisioned. That is legacy, not corruption.
    func testAnAbsentPairMetaIsTheLegacyDefault() throws {
        let meta = try readPairMeta(fs: MemoryFs(), pairId: pairId)
        XCTAssertEqual(meta.witness, .none)
        XCTAssertEqual(meta.origin, .unknown)
        XCTAssertEqual(meta.label, pairId)
        XCTAssertEqual(meta.createdAt, "")
    }

    /// `witness` says whether a rollback witness applies. Defaulting a corrupt
    /// file to "none" would BYPASS a provisioned witness, so it refuses instead.
    func testACorruptPairMetaRefusesRatherThanDefaultingToNoWitness() throws {
        for (why, body) in [
            ("not JSON", "{not json"),
            ("not an object", "[1,2,3]"),
            ("no witness field", #"{"pairId":"x"}"#),
            ("witness is not a string", #"{"witness":7}"#),
            ("an unrecognised witness kind", #"{"witness":"android-local-witness"}"#),
            ("an empty witness", #"{"witness":""}"#),
        ] {
            let fs = MemoryFs()
            try fs.writeFileAtomic(pairMetaPath(pairId), Array(body.utf8))
            XCTAssertThrowsError(try readPairMeta(fs: fs, pairId: pairId), why) { error in
                XCTAssertEqual((error as? EngineRefused)?.reason, "corrupt-pair-meta", why)
            }
        }
    }

    /// A MISSING origin is legacy; a PRESENT but unrecognised one is corruption.
    /// The difference matters because "cannot tell" must never resolve to "it was
    /// made here", which is what would permit forwarding a pad that arrived.
    func testOriginIsLegacyWhenMissingAndCorruptWhenUnrecognised() throws {
        let fs = MemoryFs()
        try fs.writeFileAtomic(pairMetaPath(pairId), Array(#"{"witness":"ios-local-witness"}"#.utf8))
        XCTAssertEqual(try readPairMeta(fs: fs, pairId: pairId).origin, .unknown,
                       "an absent origin is legacy, and stays unknown")

        for bad in [#"{"witness":"ios-none","origin":"generated_here"}"#,
                    #"{"witness":"ios-none","origin":""}"#,
                    #"{"witness":"ios-none","origin":"GENERATED-HERE"}"#,
                    #"{"witness":"ios-none","origin":true}"#] {
            try fs.writeFileAtomic(pairMetaPath(pairId), Array(bad.utf8))
            XCTAssertThrowsError(try readPairMeta(fs: fs, pairId: pairId), bad) { error in
                XCTAssertEqual((error as? EngineRefused)?.reason, "corrupt-pair-meta")
            }
        }
    }

    /// UNKNOWN is an in-memory state only. Writing it would fabricate provenance.
    func testAnUnknownOriginIsNeverSerialized() {
        XCTAssertThrowsError(try writePairMeta(fs: MemoryFs(), meta: PairMeta(
            pairId: pairId, label: "l", createdAt: at, witness: .none, origin: .unknown)))
    }

    func testPairMetaRoundTrips() throws {
        let fs = MemoryFs()
        for origin in [PairOrigin.generatedHere, .imported] {
            for witness in [WitnessKind.none, .local] {
                let written = PairMeta(pairId: pairId, label: "café ✓", createdAt: at,
                                       witness: witness, origin: origin)
                try writePairMeta(fs: fs, meta: written)
                XCTAssertEqual(try readPairMeta(fs: fs, pairId: pairId), written)
            }
        }
    }

    // MARK: - the tombstone reader never reports absence it cannot prove

    func testAnUnparseableTombstoneStillMarksTheBoundary() throws {
        for body in ["", "{not json", "[1,2,3]", #"{"formatVersion":1}"#, "null"] {
            let fs = MemoryFs()
            try fs.writeFileAtomic(tombstonePath(pairId), Array(body.utf8))
            let t = readTombstone(fs: fs, pairId: pairId)
            XCTAssertTrue(t.exists, "[\(body)] the boundary stands whatever the content is")
            XCTAssertFalse(t.wellFormed, "[\(body)] must not be treated as a well-formed record")
        }
    }

    func testAWellFormedTombstoneYieldsItsPairId() throws {
        let fs = MemoryFs()
        try writeTombstone(fs: fs, pairId: pairId, resolvedPairId: pairId, destroyedAt: at,
                           reason: "operator destroy", ab: nil, ba: nil)
        let t = readTombstone(fs: fs, pairId: pairId)
        XCTAssertTrue(t.exists)
        XCTAssertTrue(t.wellFormed)
        XCTAssertEqual(t.pairId, pairId)
    }

    /// A pairId that is not 32 lowercase hex characters is not lifted — the
    /// destroy confirmation token must never come from an unvalidated field.
    func testAnInvalidPairIdInTheTombstoneIsNotLifted() throws {
        for bad in ["", "not-hex", "8FF10E82D663D7B0BC26E3FEFAB0CD7F", "8ff10e82d663d7b0bc26e3fefab0cd7"] {
            let fs = MemoryFs()
            var s = #"{"formatVersion":2,"pairId":"# ; appendJsonString(&s, bad); s += "}"
            try fs.writeFileAtomic(tombstonePath(pairId), Array(s.utf8))
            XCTAssertNil(readTombstone(fs: fs, pairId: pairId).pairId, bad)
        }
    }

    /// A read that THROWS is not absence. This is the terminal-marker rule at the
    /// reader level; see TerminalMarkerFailClosedTests for the Fs level.
    func testATombstoneThatCannotBeReadIsStillPresent() {
        let t = readTombstone(fs: ThrowingFs(), pairId: pairId)
        XCTAssertTrue(t.exists, "an unreadable tombstone must never read as absent")
        XCTAssertFalse(t.wellFormed)
    }

    // MARK: - the handoff marker: existence is load-bearing

    func testAnAbsentHandoffMarkerIsTheOnlyAbsence() {
        XCTAssertEqual(readHandoffState(fs: MemoryFs(), pairId: pairId), .absent)
    }

    func testAValidPhysicalAndSealedMarkerParse() throws {
        let fs = MemoryFs()
        try commitPhysicalHandoff(fs: fs, pairId: pairId, at: at)
        XCTAssertEqual(readHandoffState(fs: fs, pairId: pairId), .physical(at: at))

        let sealedMarker = #"{"version":1,"pairId":"\#(pairId)","mode":"sealed","at":"\#(at)","requestHash":"a","packageIdentity":"b","confirmHash":"c"}"#
        try fs.writeFileAtomic(handoffMarkerPath(pairId), Array(sealedMarker.utf8))
        XCTAssertEqual(readHandoffState(fs: fs, pairId: pairId), .sealed(at: at),
                       "a sealed marker written by another edition is parsed, never ignored")
    }

    /// NOTHING here defaults, coerces, or tolerates an extra field. A reader that
    /// shrugged at an unexpected key could be handed a physical marker wearing
    /// sealed clothes.
    func testEveryMalformedMarkerIsUnreadableSpentAndNeverAbsent() throws {
        let sealedFields = #""requestHash":"a","packageIdentity":"b","confirmHash":"c""#
        let cases: [(String, String)] = [
            ("empty", ""),
            ("not JSON", "{"),
            ("not an object", "[]"),
            ("wrong version", #"{"version":2,"pairId":"\#(pairId)","mode":"physical","at":"\#(at)"}"#),
            ("missing version", #"{"pairId":"\#(pairId)","mode":"physical","at":"\#(at)"}"#),
            ("bad pairId", #"{"version":1,"pairId":"nope","mode":"physical","at":"\#(at)"}"#),
            ("a DIFFERENT pair", #"{"version":1,"pairId":"\#(String(repeating: "a", count: 32))","mode":"physical","at":"\#(at)"}"#),
            ("unknown mode", #"{"version":1,"pairId":"\#(pairId)","mode":"courier","at":"\#(at)"}"#),
            ("non-canonical at", #"{"version":1,"pairId":"\#(pairId)","mode":"physical","at":"2026-09-04T11:28:34Z"}"#),
            ("an extra key", #"{"version":1,"pairId":"\#(pairId)","mode":"physical","at":"\#(at)","extra":1}"#),
            ("physical wearing sealed clothes", #"{"version":1,"pairId":"\#(pairId)","mode":"physical","at":"\#(at)",\#(sealedFields)}"#),
            ("sealed missing a field", #"{"version":1,"pairId":"\#(pairId)","mode":"sealed","at":"\#(at)","requestHash":"a","packageIdentity":"b"}"#),
        ]
        for (why, body) in cases {
            let fs = MemoryFs()
            try fs.writeFileAtomic(handoffMarkerPath(pairId), Array(body.utf8))
            guard case .unreadableSpent = readHandoffState(fs: fs, pairId: pairId) else {
                return XCTFail("[\(why)] must be unreadableSpent, never absent — absence is what "
                               + "permits a second handoff")
            }
        }
    }

    /// A read that throws is unreadableSpent too. LOSS IS ACCEPTABLE; REUSE IS NOT.
    func testAMarkerThatCannotBeReadIsSpentNotAbsent() {
        guard case .unreadableSpent = readHandoffState(fs: ThrowingFs(), pairId: pairId) else {
            return XCTFail("an unreadable marker must never read as absence")
        }
    }

    /// The advice deliberately does NOT suggest deleting the file: deleting it is
    /// exactly the action that turns a lost handoff into a reused pad.
    func testTheOperatorAdviceNeverSuggestsDeletingTheMarker() {
        for word in ["delete", "remove", "clear", "reset"] {
            XCTAssertFalse(unreadableAdvice.lowercased().contains(word),
                           "the advice must not suggest \"\(word)\"")
        }
        XCTAssertTrue(unreadableAdvice.contains("Generate a new pad"))
    }
}

/// Every read fails with an I/O error — the shape of a directory at the path, a
/// dangling symlink, or a genuine device error.
private final class ThrowingFs: Fs, @unchecked Sendable {
    func readFile(_ path: String) throws -> [UInt8]? { throw FsFailure.io("simulated I/O failure on \(path)") }
    func writeFileAtomic(_ path: String, _ data: [UInt8]) throws { throw FsFailure.io(path) }
    func appendFile(_ path: String, _ data: [UInt8]) throws { throw FsFailure.io(path) }
    func readRange(_ path: String, offset: Int, length: Int) throws -> [UInt8] { throw FsFailure.io(path) }
    func writeRange(_ path: String, offset: Int, data: [UInt8]) throws { throw FsFailure.io(path) }
    func exists(_ path: String) -> Bool { true }
    func remove(_ path: String) throws { throw FsFailure.io(path) }
    func size(_ path: String) throws -> Int? { throw FsFailure.io(path) }
    func list(_ prefix: String) throws -> [String] { throw FsFailure.io(prefix) }
    func withLock<T>(_ scope: String, _ body: () throws -> T) throws -> T { try body() }
}
