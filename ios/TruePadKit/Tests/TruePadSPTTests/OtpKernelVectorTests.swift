import Foundation
import TruePadCore
import XCTest

/// The authenticated-OTP kernel, against the FROZEN v2.0.0 wire vectors.
///
/// `android/vectors/*.json` were generated from the released TruePad v2.0.0 and
/// are the same files the Android Edition is held to. Nothing here is generated
/// by this edition; every expected byte was produced by the reference
/// implementation and committed before this port existed.
final class OtpKernelVectorTests: XCTestCase {
    static func hex(_ s: String) -> [UInt8] {
        var out = [UInt8](); out.reserveCapacity(s.count / 2)
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            out.append(UInt8(s[i..<j], radix: 16)!)
            i = j
        }
        return out
    }

    static func hexString<C: Collection>(_ b: C) -> String where C.Element == UInt8 {
        b.map { String(format: "%02x", $0) }.joined()
    }

    func vectors(_ name: String) throws -> [String: Any] {
        let url = XWingKATTests.repoRoot.appendingPathComponent("android/vectors/\(name)")
        let data = try Data(contentsOf: url)
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    // MARK: - wc-one-time-v1

    /// POLYVAL, the canonical byte layout, and the masked tag — all three, from
    /// the same fixtures, so a canonical-bytes fault cannot hide behind a
    /// compensating POLYVAL fault.
    func testWcOneTimeVectors() throws {
        let doc = try vectors("wc-one-time-v1.json")
        let cases = doc["cases"] as! [[String: Any]]
        XCTAssertGreaterThanOrEqual(cases.count, 5)

        for c in cases {
            let name = c["name"] as! String
            let key = Self.hex(c["key"] as! String)
            let length = c["ciphertextLength"] as! Int
            // The max-ciphertext case is described by a RULE rather than a
            // megabyte of inline hex: "byte[i] = i mod 256".
            let ciphertext: [UInt8] = {
                if let hex = c["ciphertext"] as? String { return Self.hex(hex) }
                return (0..<length).map { UInt8($0 % 256) }
            }()
            XCTAssertEqual(ciphertext.count, length, "[\(name)] ciphertext length")
            let directionOctet = c["direction"] as! Int
            let fields = WcOneTime.CanonicalFields(
                pairId: Self.hex(c["pairId"] as! String),
                direction: directionOctet == 0 ? .aToB : .bToA,
                sequence: c["sequence"] as! Int,
                startOffset: c["startOffset"] as! Int,
                ciphertext: ciphertext
            )

            // 1. the canonical bytes, byte for byte where the fixture spells
            //    them out, and by length/block count for the 1 MiB case.
            let canonical = try WcOneTime.canonicalBytes(fields)
            if let expected = c["canonicalBytes"] as? String {
                XCTAssertEqual(Self.hexString(canonical), expected, "[\(name)] canonical bytes")
            }
            if let expectedLength = c["canonicalLength"] as? Int {
                XCTAssertEqual(canonical.count, expectedLength, "[\(name)] canonical length")
            }
            XCTAssertEqual(canonical.count % 16, 0, "[\(name)] canonical bytes must be whole blocks")
            XCTAssertEqual(canonical.count / 16, c["canonicalBlocks"] as! Int,
                           "[\(name)] canonical block count")

            // 2. the unmasked POLYVAL hash
            let hash = try WcOneTime.hash(key: key, fields: fields)
            if let expectedHash = c["hash"] as? String {
                XCTAssertEqual(Self.hexString(hash), expectedHash, "[\(name)] POLYVAL hash")
            }

            // 3. the masked tag, when the case carries a mask
            if let maskHex = c["mask"] as? String {
                let mask = Self.hex(maskHex)
                let tag = try WcOneTime.tag(key: key, mask: mask, fields: fields)
                XCTAssertEqual(Self.hexString(tag), c["tag"] as! String, "[\(name)] tag")
                // tag = hash XOR mask, stated independently of the implementation
                let recomputed = zip(hash, mask).map { $0 ^ $1 }
                XCTAssertEqual(tag, recomputed, "[\(name)] tag must be hash XOR mask")
            }
        }
    }

    /// The domain separator is fixed, nonzero, and FIRST — §5.1's cross-length
    /// injectivity argument depends on all three.
    func testCanonicalHeaderShape() throws {
        let fields = WcOneTime.CanonicalFields(
            pairId: [UInt8](repeating: 0xa0, count: 16),
            direction: .bToA, sequence: 7, startOffset: 4096, ciphertext: []
        )
        let bytes = try WcOneTime.canonicalBytes(fields)

        // An empty ciphertext yields exactly the 64-byte header.
        XCTAssertEqual(bytes.count, WcOneTime.canonicalHeaderBytes)
        XCTAssertEqual(Array(bytes[0..<16]), WcOneTime.domainSeparator)
        XCTAssertEqual(Self.hexString(WcOneTime.domainSeparator), "77632d6f6e652d74696d652d76310000")
        XCTAssertEqual(bytes[32], 0x02, "formatVersion")
        XCTAssertEqual(bytes[33], 0x01, "B->A direction octet")
        // Bytes [34, 40) are reserved and supplied here, never by the wire.
        XCTAssertEqual(Array(bytes[34..<40]), [UInt8](repeating: 0, count: 6))
        // sequence, startOffset, ciphertextLength as u64 LE
        XCTAssertEqual(Array(bytes[40..<48]), [7, 0, 0, 0, 0, 0, 0, 0])
        XCTAssertEqual(Array(bytes[48..<56]), [0, 0x10, 0, 0, 0, 0, 0, 0])
        XCTAssertEqual(Array(bytes[56..<64]), [0, 0, 0, 0, 0, 0, 0, 0])
    }

    /// The A->B and B->A octets differ, so one direction's tag never authenticates
    /// the other's record. This is what stops two peers who each hold a copy of
    /// one pair from validating each other's traffic as their own.
    func testDirectionIsAuthenticated() throws {
        let key = [UInt8](repeating: 0x11, count: 16)
        let base = { (d: PadDirection) in
            WcOneTime.CanonicalFields(pairId: [UInt8](repeating: 0x22, count: 16),
                                      direction: d, sequence: 3, startOffset: 64,
                                      ciphertext: [0xde, 0xad, 0xbe, 0xef])
        }
        XCTAssertNotEqual(try WcOneTime.hash(key: key, fields: base(.aToB)),
                          try WcOneTime.hash(key: key, fields: base(.bToA)))
        XCTAssertEqual(PadDirection.aToB.octet, 0x00)
        XCTAssertEqual(PadDirection.bToA.octet, 0x01)
    }

    /// Padding to a 16-byte boundary is 0x00 and carries no meaning, but the
    /// AUTHENTICATED ciphertextLength distinguishes messages that pad alike.
    func testShortCiphertextsArePaddedButStillDistinguished() throws {
        let key = [UInt8](repeating: 0x33, count: 16)
        func fields(_ ct: [UInt8]) -> WcOneTime.CanonicalFields {
            WcOneTime.CanonicalFields(pairId: [UInt8](repeating: 0x44, count: 16),
                                      direction: .aToB, sequence: 0, startOffset: 0, ciphertext: ct)
        }
        let one = try WcOneTime.canonicalBytes(fields([0x01]))
        let two = try WcOneTime.canonicalBytes(fields([0x01, 0x00]))
        XCTAssertEqual(one.count, two.count, "both pad to the same block boundary")
        XCTAssertNotEqual(one, two, "ciphertextLength must still separate them")
        XCTAssertNotEqual(try WcOneTime.hash(key: key, fields: fields([0x01])),
                          try WcOneTime.hash(key: key, fields: fields([0x01, 0x00])))
    }

    func testTagsEqualRejectsWrongWidths() {
        let sixteen = [UInt8](repeating: 0, count: 16)
        XCTAssertTrue(WcOneTime.tagsEqual(sixteen, sixteen))
        XCTAssertFalse(WcOneTime.tagsEqual(sixteen, [UInt8](repeating: 0, count: 8)),
                       "64-bit tags are forbidden in v2")
        XCTAssertFalse(WcOneTime.tagsEqual([UInt8](repeating: 0, count: 15), sixteen))
        var off = sixteen; off[15] = 1
        XCTAssertFalse(WcOneTime.tagsEqual(sixteen, off))
    }

    // MARK: - partition-v2

    /// The four-slice layout, the XOR combination, and the (K_s, R_s) split.
    func testPartitionVectors() throws {
        let doc = try vectors("partition-v2.json")
        let cases = doc["cases"] as! [[String: Any]]
        XCTAssertGreaterThanOrEqual(cases.count, 4)

        for c in cases {
            let capacity = c["capacity"] as! Int
            let records = c["capacityRecords"] as! Int
            let sources = (c["sourcesHex"] as! [String]).map { Self.hex($0) }

            let required = try Partition.requiredSourceLength(capacity: capacity,
                                                              capacityRecords: records)
            XCTAssertEqual(required, c["requiredSourceLength"] as! Int,
                           "L = 2*(E + 32N) for E=\(capacity) N=\(records)")

            let combined = try Partition.combineSources(sources, length: required)
            XCTAssertEqual(Self.hexString(combined), c["combinedHex"] as! String,
                           "combined material (bytewise XOR, no KDF)")

            let slices = try Partition.partition(combined, capacity: capacity,
                                                 capacityRecords: records)
            XCTAssertEqual(Self.hexString(slices.abEncryption), c["abEncryptionHex"] as! String)
            XCTAssertEqual(Self.hexString(slices.abAuthentication), c["abAuthenticationHex"] as! String)
            XCTAssertEqual(Self.hexString(slices.baEncryption), c["baEncryptionHex"] as! String)
            XCTAssertEqual(Self.hexString(slices.baAuthentication), c["baAuthenticationHex"] as! String)

            // Every combined byte lands in exactly one slice at exactly one place.
            XCTAssertEqual(slices.abEncryption + slices.abAuthentication
                            + slices.baEncryption + slices.baAuthentication,
                           combined, "the partition must be an exact, ordered carve")

            for r in c["abAuthRecords"] as! [[String: Any]] {
                let sequence = r["sequence"] as! Int
                let record = try Partition.authRecord(in: slices.abAuthentication, sequence: sequence)
                XCTAssertEqual(Self.hexString(record.key), r["keyHex"] as! String,
                               "K_\(sequence) is the FIRST 16 bytes")
                XCTAssertEqual(Self.hexString(record.mask), r["maskHex"] as! String,
                               "R_\(sequence) is the SECOND 16 bytes")
            }
        }
    }

    func testPartitionRefusals() throws {
        // A source shorter than L is refused before any byte is combined.
        XCTAssertThrowsError(try Partition.combineSources([[UInt8](repeating: 0, count: 10)],
                                                          length: 16))
        XCTAssertThrowsError(try Partition.combineSources([], length: 16))
        // No auth record beyond capacityRecords exists, and none is invented.
        let slice = [UInt8](repeating: 0, count: 64)   // exactly 2 records
        XCTAssertNoThrow(try Partition.authRecord(in: slice, sequence: 1))
        XCTAssertThrowsError(try Partition.authRecord(in: slice, sequence: 2))
        // Combined material of the wrong length is refused.
        XCTAssertThrowsError(try Partition.partition([UInt8](repeating: 0, count: 10),
                                                      capacity: 8, capacityRecords: 1))
    }

    // MARK: - frame-v2

    func testFrameVectors() throws {
        let doc = try vectors("frame-v2.json")

        for c in doc["build"] as! [[String: Any]] {
            let recordBytes = c["recordBytes"] as! Int
            let plaintext = Self.hex(c["plaintextHex"] as! String)
            XCTAssertEqual(Frame.capacity(recordBytes: recordBytes), c["capacity"] as! Int,
                           "capacity is F - 4")
            let frame = try Frame.build(plaintext: plaintext, recordBytes: recordBytes)
            XCTAssertEqual(frame.count, recordBytes, "a frame is exactly F bytes")
            XCTAssertEqual(Self.hexString(frame), c["frameHex"] as! String)
            XCTAssertEqual(Self.hexString(Frame.parse(frame) ?? []), c["parsedHex"] as! String)
        }

        // Despite the fixture's name, `parseRejects` also carries the BOUNDARY
        // case that must parse (a prefix of exactly F-4). Follow `parsedHex`:
        // null means refuse, a string means accept exactly those bytes. Asserting
        // "all of these are refused" would have been wrong in the direction that
        // matters -- it would have demanded a refusal of a legitimate full record.
        var refused = 0
        var accepted = 0
        for c in doc["parseRejects"] as! [[String: Any]] {
            let name = c["name"] as! String
            let frame = Self.hex(c["frameHex"] as! String)
            if let expected = c["parsedHex"] as? String {
                XCTAssertEqual(Self.hexString(Frame.parse(frame) ?? []), expected,
                               "[\(name)] should parse to exactly these bytes")
                accepted += 1
            } else {
                XCTAssertNil(Frame.parse(frame),
                             "[\(name)] a length field no conforming sender writes must yield nil")
                refused += 1
            }
        }
        XCTAssertGreaterThanOrEqual(refused, 3, "expected refusal cases")
        XCTAssertGreaterThanOrEqual(accepted, 1, "expected the exactly-capacity boundary case")
    }

    /// The frame hides message length from the channel: two different plaintexts
    /// in the same fixed-size store produce the same number of bytes.
    func testFrameHidesLength() throws {
        let short = try Frame.build(plaintext: [0x41], recordBytes: 64)
        let long = try Frame.build(plaintext: [UInt8](repeating: 0x42, count: 60), recordBytes: 64)
        XCTAssertEqual(short.count, long.count)
        XCTAssertEqual(Frame.parse(short), [0x41])
        XCTAssertEqual(Frame.parse(long), [UInt8](repeating: 0x42, count: 60))
        // Capacity is F - 4, and one byte more is refused at build time.
        XCTAssertThrowsError(try Frame.build(plaintext: [UInt8](repeating: 0, count: 61),
                                             recordBytes: 64))
    }

    /// The padding carries no meaning: only the prefix decides the boundary.
    func testFramePaddingIsNotInspected() throws {
        var frame = try Frame.build(plaintext: [0xaa, 0xbb], recordBytes: 32)
        XCTAssertEqual(Frame.parse(frame), [0xaa, 0xbb])
        for i in 6..<32 { frame[i] = 0xff }          // scribble over the padding
        XCTAssertEqual(Frame.parse(frame), [0xaa, 0xbb], "padding must not be examined")
    }
}
