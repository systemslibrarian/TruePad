import Foundation
import TruePadCore
@testable import TruePadStorage
import XCTest

/// THE TERMINAL MARKER MUST FAIL CLOSED (FORMAT-V2.md §17).
///
/// `destroyed.json` is the irreversible boundary: once it is durable the pair
/// must never perform a cryptographic operation again. So the gate asks "is this
/// path NOT KNOWN TO BE ABSENT", not "is there a readable regular file here" —
/// every way of being unreadable has to close the boundary, not open it.
///
/// A REAL FAIL-OPEN, MEASURED RATHER THAN ASSUMED. `FileManager.fileExists`
/// follows symlinks and answers `false` for a symlink whose target is gone, and
/// `readFile` reported a directory as `nil` — the same value a genuinely empty
/// path returns. Node's `existsSync` and the JVM's `File.exists()` answer `false`
/// on a dangling link too, so all three editions carried the identical defect and
/// were corrected together. The Kotlin and TypeScript halves are
/// `TerminalMarkerFailClosedTest.kt` and `tests/terminal-marker-fail-closed.test.ts`,
/// and all three assert the same list of shapes.
///
/// WHAT THIS FILE COVERS. iOS has the durable store but not yet the verb layer,
/// so this holds the Fs CONTRACT that the gate will rest on, at the exact level
/// where the defect lived. It is not a claim that an iOS `destroy` verb exists.
///
/// LOSS IS ACCEPTABLE; REUSE IS NOT.
final class TerminalMarkerFailClosedTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("truepad-terminal-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let root { try? FileManager.default.removeItem(at: root) }
    }

    /// Every shape a terminal marker can take that is NOT a well-formed readable
    /// file. Each returns false if this filesystem cannot produce the shape.
    private func shapes() -> [(name: String, make: (URL) throws -> Bool)] {
        [
            ("a symlink whose target does not exist", { url in
                try FileManager.default.createSymbolicLink(
                    at: url, withDestinationURL: self.root.appendingPathComponent("gone-target"))
                return true
            }),
            ("a symlink to a deleted file", { url in
                let t = self.root.appendingPathComponent("t.bin")
                try Data("x".utf8).write(to: t)
                try FileManager.default.createSymbolicLink(at: url, withDestinationURL: t)
                try FileManager.default.removeItem(at: t)
                return true
            }),
            ("a directory", { url in
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                return true
            }),
            ("a non-empty directory", { url in
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                try Data("x".utf8).write(to: url.appendingPathComponent("inner"))
                return true
            }),
            ("a FIFO", { url in
                return mkfifo(url.path, 0o600) == 0
            }),
        ]
    }

    /// Shapes that ARE regular files but carry no usable content. These must read
    /// back as bytes — `readFile` is not a parser — and the refusal has to come
    /// from the gate treating presence, not content, as the boundary.
    private func contentShapes() -> [(name: String, bytes: [UInt8])] {
        [
            ("an empty file (a torn write)", []),
            ("a truncated JSON object", Array(#"{"formatVersion":2,"pairId":"aaaa"#.utf8)),
            ("not JSON at all", Array("  not json".utf8)),
            ("JSON that is not an object", Array("[1,2,3]".utf8)),
            ("a JSON object naming a DIFFERENT pair", Array(#"{"formatVersion":2,"pairId":"ffffffffffffffffffffffffffffffff"}"#.utf8)),
        ]
    }

    // MARK: - exists means NOT KNOWN TO BE ABSENT

    func testEveryNonAbsentShapeReadsAsPresent() throws {
        let fs = try DarwinFs(root: root)
        var exercised = 0
        for (index, shape) in shapes().enumerated() {
            let name = "marker-\(index).json"
            guard (try? shape.make(root.appendingPathComponent(name))) == true else { continue }
            exercised += 1
            XCTAssertTrue(fs.exists(name),
                          "[\(shape.name)] must read as present, not as an absent path")
        }
        XCTAssertGreaterThanOrEqual(exercised, 4, "too few shapes were exercised to prove anything")

        for (index, shape) in contentShapes().enumerated() {
            let name = "content-\(index).json"
            try Data(shape.bytes).write(to: root.appendingPathComponent(name))
            XCTAssertTrue(fs.exists(name), "[\(shape.name)] must read as present")
        }
    }

    /// THE ORIGINAL DEFECT, pinned. `FileManager.fileExists` is what was wrong;
    /// this asserts the wrong answer really is wrong here, so the test cannot
    /// quietly stop testing anything if the platform ever changes.
    func testADanglingSymlinkIsPresentEvenThoughFileManagerSaysOtherwise() throws {
        let marker = root.appendingPathComponent("destroyed.json")
        try FileManager.default.createSymbolicLink(
            at: marker, withDestinationURL: root.appendingPathComponent("gone-target"))

        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path),
                       "precondition: fileExists is exactly what fooled the old gate")
        XCTAssertTrue(try DarwinFs(root: root).exists("destroyed.json"),
                      "a terminal marker that is a broken link must still close the boundary")
    }

    func testOnlyADefinitivelyMissingPathReadsAsAbsent() throws {
        let fs = try DarwinFs(root: root)
        XCTAssertFalse(fs.exists("nothing-here"))
        XCTAssertFalse(fs.exists("no/such/directory/at/all.json"))

        // A path whose parent is not a directory is NOT a definitive negative.
        // ENOENT is the only answer Node, the JVM and Foundation all report
        // identically, so it is the only one the editions treat as absence.
        try Data("x".utf8).write(to: root.appendingPathComponent("plain.bin"))
        XCTAssertTrue(fs.exists("plain.bin/under"),
                      "a path that cannot be resolved is not a path known to be clear")
    }

    // MARK: - readFile: absent and malformed are different answers

    func testReadFileThrowsRatherThanReportingAnUnreadableShapeAsAbsent() throws {
        let fs = try DarwinFs(root: root)
        var exercised = 0
        for (index, shape) in shapes().enumerated() {
            let name = "r-\(index).json"
            guard (try? shape.make(root.appendingPathComponent(name))) == true else { continue }
            exercised += 1
            XCTAssertThrowsError(try fs.readFile(name),
                                 "[\(shape.name)] must throw, never return nil") { error in
                XCTAssertTrue(error is FsFailure, "[\(shape.name)] unexpected error \(error)")
            }
        }
        XCTAssertGreaterThanOrEqual(exercised, 4)
    }

    /// `nil` is reserved for "definitively nothing here" — the one answer a
    /// caller may treat as a fresh, unwritten path.
    func testReadFileReturnsNilOnlyForDefiniteAbsence() throws {
        let fs = try DarwinFs(root: root)
        XCTAssertNil(try fs.readFile("nothing-here"))
        XCTAssertNil(try fs.readFile("no/such/directory/at/all.json"))
    }

    /// A regular file reached THROUGH a valid symlink still reads. Android's
    /// `File.isFile` follows, and the two editions must answer alike.
    func testAValidSymlinkToARegularFileStillReads() throws {
        let target = root.appendingPathComponent("real.json")
        try Data("{}".utf8).write(to: target)
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("link.json"), withDestinationURL: target)

        XCTAssertEqual(try DarwinFs(root: root).readFile("link.json"), Array("{}".utf8))
    }

    /// Content is not the gate's business: a torn or nonsensical marker still
    /// reads back as bytes, and presence alone is what closes the boundary.
    func testMalformedContentStillReadsAsBytesSoPresenceIsTheGate() throws {
        let fs = try DarwinFs(root: root)
        for (index, shape) in contentShapes().enumerated() {
            let name = "c-\(index).json"
            try Data(shape.bytes).write(to: root.appendingPathComponent(name))
            XCTAssertEqual(try fs.readFile(name), shape.bytes, "[\(shape.name)]")
            XCTAssertTrue(fs.exists(name), "[\(shape.name)] presence is what the gate reads")
        }
    }
}
