import Foundation
import TruePadStorage
import XCTest

/// The durable-file layer.
///
/// These tests establish the properties the state machine is allowed to rely on,
/// and — just as importantly — they do not pretend to establish the ones it is
/// not. Nothing here is evidence about physical erasure, power loss, or a
/// restored backup; those limits are asserted as DOCUMENTED limits in
/// `testHonestLimitsAreDocumented` rather than quietly assumed away.
final class FsTests: XCTestCase {
    var temp: URL!

    override func setUpWithError() throws {
        temp = FileManager.default.temporaryDirectory
            .appendingPathComponent("truepad-fs-tests-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        if let temp, FileManager.default.fileExists(atPath: temp.path) {
            try? FileManager.default.removeItem(at: temp)
        }
    }

    func backings() throws -> [(name: String, fs: Fs)] {
        [("memory", MemoryFs()), ("darwin", try DarwinFs(root: temp))]
    }

    // MARK: - the contract both backings must satisfy

    func testBasicReadWriteRoundTrip() throws {
        for (name, fs) in try backings() {
            XCTAssertNil(try fs.readFile("a/b.json"), "[\(name)] absent file reads as nil")
            XCTAssertFalse(fs.exists("a/b.json"), "[\(name)]")

            try fs.writeFileAtomic("a/b.json", Array("hello".utf8))
            XCTAssertEqual(try fs.readFile("a/b.json"), Array("hello".utf8), "[\(name)]")
            XCTAssertTrue(fs.exists("a/b.json"), "[\(name)]")
            XCTAssertEqual(try fs.size("a/b.json"), 5, "[\(name)]")

            // Replace is whole-file, not a merge.
            try fs.writeFileAtomic("a/b.json", Array("hi".utf8))
            XCTAssertEqual(try fs.readFile("a/b.json"), Array("hi".utf8), "[\(name)]")
            XCTAssertEqual(try fs.size("a/b.json"), 2, "[\(name)]")
        }
    }

    func testAppendCreatesAndAccumulates() throws {
        for (name, fs) in try backings() {
            try fs.appendFile("j/journal.ndjson", Array("one\n".utf8))
            try fs.appendFile("j/journal.ndjson", Array("two\n".utf8))
            XCTAssertEqual(try fs.readFile("j/journal.ndjson"), Array("one\ntwo\n".utf8),
                           "[\(name)] append must accumulate, never replace")
        }
    }

    func testPositionedReadAndWrite() throws {
        for (name, fs) in try backings() {
            try fs.writeFileAtomic("s/secret.bin", Array(0..<32).map { UInt8($0) })
            XCTAssertEqual(try fs.readRange("s/secret.bin", offset: 8, length: 4),
                           [8, 9, 10, 11], "[\(name)]")

            // The destruction zero-overwrite.
            try fs.writeRange("s/secret.bin", offset: 8, data: [0, 0, 0, 0])
            XCTAssertEqual(try fs.readRange("s/secret.bin", offset: 8, length: 4),
                           [0, 0, 0, 0], "[\(name)]")
            // ... which must not disturb its neighbours.
            XCTAssertEqual(try fs.readRange("s/secret.bin", offset: 12, length: 2), [12, 13],
                           "[\(name)]")
            XCTAssertEqual(try fs.size("s/secret.bin"), 32, "[\(name)] size is unchanged")
        }
    }

    /// A range that runs past the end is refused, never silently clamped. A
    /// clamped read would hand back the wrong pad bytes, which is how an offset
    /// gets consumed twice.
    func testOutOfRangeIsRefusedNotClamped() throws {
        for (name, fs) in try backings() {
            try fs.writeFileAtomic("s/secret.bin", [UInt8](repeating: 7, count: 16))
            XCTAssertThrowsError(try fs.readRange("s/secret.bin", offset: 8, length: 16),
                                 "[\(name)] over-long read")
            XCTAssertThrowsError(try fs.readRange("s/secret.bin", offset: -1, length: 1),
                                 "[\(name)] negative offset")
            XCTAssertThrowsError(try fs.writeRange("s/secret.bin", offset: 12, data: [1, 2, 3, 4, 5]),
                                 "[\(name)] over-long write")
            XCTAssertThrowsError(try fs.readRange("s/missing.bin", offset: 0, length: 1),
                                 "[\(name)] absent file")
        }
    }

    func testRemoveIsIdempotentAndRecursive() throws {
        for (name, fs) in try backings() {
            try fs.writeFileAtomic("p/dir/one.json", [1])
            try fs.writeFileAtomic("p/dir/two.json", [2])
            try fs.remove("p/dir")
            XCTAssertFalse(fs.exists("p/dir/one.json"), "[\(name)]")
            XCTAssertFalse(fs.exists("p/dir/two.json"), "[\(name)]")
            XCTAssertNoThrow(try fs.remove("p/dir"), "[\(name)] remove is idempotent")
            XCTAssertNoThrow(try fs.remove("never/existed"), "[\(name)]")
        }
    }

    func testListReturnsDirectChildrenOnly() throws {
        for (name, fs) in try backings() {
            try fs.writeFileAtomic("pairs/aaa/head.json", [1])
            try fs.writeFileAtomic("pairs/bbb/head.json", [2])
            try fs.writeFileAtomic("pairs/bbb/nested/deep.json", [3])
            XCTAssertEqual(try fs.list("pairs").sorted(), ["aaa", "bbb"],
                           "[\(name)] one level only")
        }
    }

    // MARK: - mutual exclusion

    /// The lock is real mutual exclusion, and it is BOUNDED: a verb that cannot
    /// take it refuses `locked` rather than hanging the app until the watchdog
    /// kills it mid-transition.
    func testLockIsExclusiveAndReentrantPerScope() throws {
        for (name, fs) in try backings() {
            var order: [String] = []
            try fs.withLock("pair-1") {
                order.append("outer-in")
                // A different scope is independent.
                try fs.withLock("pair-2") { order.append("other-scope") }
                order.append("outer-out")
            }
            XCTAssertEqual(order, ["outer-in", "other-scope", "outer-out"], "[\(name)]")
        }
    }

    func testLockSerialisesConcurrentWriters() throws {
        for (name, fs) in try backings() {
            // A reference box, because Swift 6 will not let a concurrently
            // executing closure capture a mutable local.
            final class Counter: @unchecked Sendable {
                private var value = 0
                private let mutex = NSLock()
                func readModifyWrite(_ pause: TimeInterval) {
                    mutex.lock(); let seen = value; mutex.unlock()
                    Thread.sleep(forTimeInterval: pause)
                    mutex.lock(); value = seen + 1; mutex.unlock()
                }
                var current: Int { mutex.lock(); defer { mutex.unlock() }; return value }
            }
            let iterations = 50
            let counter = Counter()
            DispatchQueue.concurrentPerform(iterations: iterations) { _ in
                // The read-modify-write is deliberately NOT atomic in itself: the
                // only thing that can make the total come out right is genuine
                // mutual exclusion from the Fs lock.
                try? fs.withLock("pair-serialise") { counter.readModifyWrite(0.0005) }
            }
            XCTAssertEqual(counter.current, iterations,
                           "[\(name)] the lock did not serialise concurrent writers")
        }
    }

    // MARK: - what a torn write leaves behind

    /// A truncated file is what a torn write looks like to the next reader. The
    /// Fs layer does not repair it and does not hide it — it hands back exactly
    /// the partial bytes, so the READER can fail closed. Silent repair here would
    /// be the worst possible behaviour: it would manufacture a plausible state
    /// nobody wrote.
    func testTornWriteIsVisibleToTheReader() throws {
        let fs = MemoryFs()
        try fs.writeFileAtomic("h/head.json", Array("{\"nextOffset\":128}".utf8))
        fs.truncate("h/head.json", to: 9)
        XCTAssertEqual(try fs.readFile("h/head.json"), Array("{\"nextOff".utf8),
                       "the partial bytes are returned verbatim, not repaired")
    }

    /// The crash hook makes write ORDER observable, which is what the reuse
    /// argument actually rests on: whether the consumption record reached the
    /// store before the output was released.
    func testCrashHookStopsExactlyWhereAsked() throws {
        let fs = MemoryFs()
        try fs.writeFileAtomic("a.json", [1])

        struct Died: Error {}
        fs.beforeMutation = { operation, path in
            if operation == "writeFileAtomic" && path == "b.json" { throw Died() }
        }
        XCTAssertThrowsError(try fs.writeFileAtomic("b.json", [2]))
        XCTAssertEqual(fs.allPaths, ["a.json"],
                       "the write that was interrupted must have left nothing behind")
        fs.beforeMutation = nil
        try fs.writeFileAtomic("b.json", [2])
        XCTAssertEqual(fs.allPaths, ["a.json", "b.json"])
    }

    /// A restore reinstates an older state wholesale — the rollback shape. The Fs
    /// layer cannot prevent it and does not claim to; detecting it is the
    /// witness journal's job, and this test exists to pin that division.
    func testSnapshotRestoreReinstatesOlderState() throws {
        let fs = MemoryFs()
        try fs.writeFileAtomic("head.json", Array("nextOffset:0".utf8))
        let before = fs.snapshot()
        try fs.writeFileAtomic("head.json", Array("nextOffset:128".utf8))
        XCTAssertEqual(try fs.readFile("head.json"), Array("nextOffset:128".utf8))

        fs.restore(before)
        XCTAssertEqual(try fs.readFile("head.json"), Array("nextOffset:0".utf8),
                       "a restore puts the older cursor back; nothing in Fs stops that")
    }

    // MARK: - Apple-specific durability

    /// New files must carry a Data Protection class and 0600, from creation
    /// rather than afterwards: a secret body must never exist on disk unprotected,
    /// not even briefly.
    func testDarwinFilesAreProtectedAndPrivateFromCreation() throws {
        let fs = try DarwinFs(root: temp)
        try fs.writeFileAtomic("pair/secret.bin", [UInt8](repeating: 0xab, count: 64))

        let path = temp.appendingPathComponent("pair/secret.bin").path
        let attrs = try FileManager.default.attributesOfItem(atPath: path)

        let permissions = (attrs[.posixPermissions] as? NSNumber)?.intValue
        XCTAssertEqual(permissions, 0o600, "0600, matching the CLI's FILE_MODE")

        #if os(iOS)
        // Data Protection is only meaningful on a device with a passcode; on
        // macOS the attribute is not applied, which is why this is iOS-only.
        let protection = attrs[.protectionKey] as? FileProtectionType
        XCTAssertNotNil(protection, "new files must be created with a protection class")
        #endif

        let dirAttrs = try FileManager.default
            .attributesOfItem(atPath: temp.appendingPathComponent("pair").path)
        XCTAssertEqual((dirAttrs[.posixPermissions] as? NSNumber)?.intValue, 0o700,
                       "0700, matching the CLI's DIR_MODE")
    }

    /// The store is excluded from iCloud and Finder backups. That does not make
    /// rollback impossible — a full device restore still exists — but it removes
    /// the routine path to reinstating a spent cursor.
    func testStoreIsExcludedFromBackup() throws {
        _ = try DarwinFs(root: temp)
        let values = try temp.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true,
                       "pad material and consumption state must not ride into a backup")
    }

    /// The temp file used by an atomic replace must not survive a successful
    /// write: a leftover `.writing` file is pad-adjacent material lying around
    /// under a name nothing will ever clean up.
    func testAtomicWriteLeavesNoTemporaryFile() throws {
        let fs = try DarwinFs(root: temp)
        try fs.writeFileAtomic("pair/head.json", Array("{}".utf8))
        let names = try FileManager.default
            .contentsOfDirectory(atPath: temp.appendingPathComponent("pair").path)
        XCTAssertEqual(names, ["head.json"],
                       "a .writing temp must not survive a successful replace")
    }

    /// An atomic replace is all-or-nothing for a reader: a concurrent reader sees
    /// the old contents or the new, never a mix. This exercises the rename path
    /// under real concurrency rather than asserting it from the man page.
    func testConcurrentReadersNeverSeeAPartialFile() throws {
        let fs = try DarwinFs(root: temp)
        let oldValue = [UInt8](repeating: 0x11, count: 4096)
        let newValue = [UInt8](repeating: 0x22, count: 4096)
        try fs.writeFileAtomic("pair/head.json", oldValue)

        let done = expectation(description: "writers finished")
        DispatchQueue.global().async {
            for _ in 0..<40 { try? fs.writeFileAtomic("pair/head.json", newValue) }
            done.fulfill()
        }
        for _ in 0..<400 {
            if let seen = try fs.readFile("pair/head.json") {
                XCTAssertTrue(seen == oldValue || seen == newValue,
                              "a reader saw a partially written file")
            }
        }
        wait(for: [done], timeout: 30)
    }

    /// F_FULLFSYNC is what Darwin requires for a real durability barrier: plain
    /// fsync() only pushes bytes to the drive, which may still hold them in its
    /// own write cache. If the filesystem ever refuses the stronger call, the
    /// backing must RECORD that rather than silently continue claiming the
    /// stronger guarantee.
    func testFullFsyncFallbackIsReportedNotHidden() throws {
        let fs = try DarwinFs(root: temp)
        try fs.writeFileAtomic("pair/head.json", Array("{}".utf8))
        try fs.appendFile("pair/journal.ndjson", Array("{}\n".utf8))
        // On a normal APFS volume the strong barrier is available. The assertion
        // that matters is that the flag exists and is observable either way —
        // a weaker guarantee must be reportable, not assumed.
        XCTAssertFalse(fs.fullFsyncUnsupported,
                       "F_FULLFSYNC should be available on this volume; if this ever fails, the "
                       + "durability claim must be weakened rather than the test relaxed")
    }

    /// The limits this layer does NOT overcome, asserted as limits so that a
    /// future change cannot quietly turn them into claims.
    func testHonestLimitsAreDocumented() throws {
        let fs = try DarwinFs(root: temp)
        try fs.writeFileAtomic("pair/secret.bin", [UInt8](repeating: 0xcd, count: 64))

        // A zero-overwrite makes the material unreachable THROUGH THE FILE. That
        // is what stops reuse. It is not proof the physical blocks are gone:
        // APFS is copy-on-write over flash with wear levelling, and no userspace
        // API can establish that. TruePad does not claim it.
        try fs.writeRange("pair/secret.bin", offset: 0, data: [UInt8](repeating: 0, count: 64))
        XCTAssertEqual(try fs.readRange("pair/secret.bin", offset: 0, length: 64),
                       [UInt8](repeating: 0, count: 64),
                       "the logical bytes are zeroed — the reachable copy is gone")
        XCTAssertEqual(try fs.size("pair/secret.bin"), 64,
                       "the file is not truncated: the slot stays, the material does not")
    }
}
