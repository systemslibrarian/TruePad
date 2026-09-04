import Foundation
import TruePadCore
@testable import TruePadSPT
@testable import TruePadStorage
@testable import TruePadUI
import XCTest

/// WHERE SECRETS COULD ESCAPE, AND THE FACT THAT THEY DO NOT.
///
/// A pad-management app leaks by accident, not by design: a `print` left in a
/// hot path, a pasteboard convenience, a temp file written without protection, an
/// error message that carries the bytes it failed on. Each of those is a one-line
/// change nobody would flag in review, so each gets a test.
///
/// The strongest of these is not a source sweep at all — it runs the real engine
/// through a whole pad lifecycle and then searches EVERY byte it wrote for the
/// pad material, and for the plaintext.
final class LeakageAuditTests: XCTestCase {
    static var kitRoot: URL { PostureGuardTests.kitRoot }

    /// Production sources of every shipping target, comments stripped.
    func productionSources() throws -> [(name: String, text: String)] {
        var out: [(String, String)] = []
        for target in PostureGuardTests.shippingTargets {
            let dir = Self.kitRoot.appendingPathComponent("Sources/\(target)")
            for path in try FileManager.default.subpathsOfDirectory(atPath: dir.path)
            where path.hasSuffix(".swift") {
                let raw = try String(contentsOf: dir.appendingPathComponent(path), encoding: .utf8)
                out.append(("\(target)/\(path)", PostureGuardTests.stripComments(raw)))
            }
        }
        XCTAssertGreaterThan(out.count, 15, "the sweep found suspiciously few sources")
        return out
    }

    // MARK: - nothing is logged

    /// NO LOGGING AT ALL in the shipping code.
    ///
    /// Not "no logging of secrets" — no logging, full stop. The distinction
    /// matters because the leak is never the line someone wrote meaning to log a
    /// secret; it is the line that logs a struct which later gains a field. A
    /// codebase with no logging surface cannot acquire that bug.
    func testNoShippingSourceLogsAnything() throws {
        let forbidden = ["print(", "debugPrint(", "dump(", "NSLog(", "os_log", "Logger(",
                         "OSLog", "FileHandle.standardOutput", "FileHandle.standardError",
                         "fputs(", "fwrite(stdout"]
        for file in try productionSources() {
            for needle in forbidden {
                // WORD BOUNDARY. Plain `contains` matched `print(` inside
                // `requestFingerprint(` -- the same substring mistake that made an
                // earlier guard vacuous, caught here because this one fired.
                XCTAssertFalse(Self.containsAsCall(file.text, needle),
                               "\(file.name) contains \(needle): TruePad ships no logging surface, "
                               + "so it cannot grow one that prints a struct which later gains a "
                               + "secret field")
            }
        }
    }

    /// NO PASTEBOARD from the engine or the presentation logic. The clipboard is
    /// readable by other apps and syncs across devices by Handoff, so anything
    /// that reaches it has left the app's control.
    func testNoShippingSourceTouchesThePasteboard() throws {
        for file in try productionSources() {
            for needle in ["UIPasteboard", "NSPasteboard", "generalPasteboard"] {
                XCTAssertFalse(Self.containsAsCall(file.text, needle),
                               "\(file.name) references \(needle) — pad material must never reach "
                               + "the clipboard, and the copy affordance belongs to the operator's "
                               + "own selection, not to TruePad")
            }
        }
    }

    /// NO ANALYTICS, NO CRASH REPORTING, NO THIRD-PARTY TELEMETRY. A crash
    /// reporter that uploads a stack with a buffer in it is a leak with a
    /// respectable name.
    func testNoShippingSourceCarriesTelemetry() throws {
        let forbidden = ["Analytics", "Crashlytics", "Sentry", "Bugsnag", "Firebase",
                         "MetricKit", "os_signpost", "AppMetrics"]
        for file in try productionSources() {
            for needle in forbidden {
                XCTAssertFalse(Self.containsAsCall(file.text, needle),
                               "\(file.name) references \(needle)")
            }
        }
    }

    /// Every file this app writes is created WITH a protection class, not
    /// protected afterwards. A file that exists unprotected for a moment is a
    /// file that was readable in that moment.
    func testEveryFileIsCreatedWithProtectionRatherThanProtectedAfterwards() throws {
        let darwinFs = try String(
            contentsOf: Self.kitRoot.appendingPathComponent("Sources/TruePadStorage/DarwinFs.swift"),
            encoding: .utf8)
        XCTAssertTrue(darwinFs.contains(".protectionKey"),
                      "files must be created with a protection class")
        // And the temp file the share sheet hands over is written protected too.
        let models = try String(
            contentsOf: Self.kitRoot.appendingPathComponent("Sources/TruePadUI/Models.swift"),
            encoding: .utf8)
        XCTAssertTrue(models.contains(".completeFileProtection"),
                      "the exported pad file must be written with complete protection")
    }

    // MARK: - the real test: run the engine and search everything it wrote

    /// THE ONE THAT WOULD CATCH A REAL LEAK.
    ///
    /// Run a whole lifecycle — generate, send, open, export, seal — then search
    /// EVERY byte the engine wrote for the pad material and for the plaintext.
    /// The only file allowed to contain pad material is the one whose entire
    /// purpose is to hold it.
    func testNoPadMaterialOrPlaintextAppearsOutsideTheFilesThatMustHoldIt() throws {
        let fs = MemoryFs()
        let clock = Date(timeIntervalSince1970: 1_756_684_800)
        let pairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        let e = Engine(fs: fs, clock: { clock }, pairIdSource: { Hex.decode(pairId)! })

        // Distinctive source material, so a match is unambiguous rather than a
        // coincidence of common bytes.
        let need = try Partition.requiredSourceLength(capacity: 512, capacityRecords: 8)
        // NON-PERIODIC. The first version used 0xC0 + i*7 mod 256, which repeats
        // every 256 bytes -- so a window taken from one half's tail reappeared in
        // the other half, and the test failed on its own arithmetic rather than on
        // a leak. An LCG over the full period does not repeat within this buffer.
        var marker: [UInt8] = []
        var lcg: UInt64 = 0xC0FFEE_1234_5678
        for _ in 0..<need {
            lcg = lcg &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            marker.append(UInt8(truncatingIfNeeded: lcg >> 33))
        }
        _ = try e.gen(label: "leak-audit",
                      sources: [SourceInput(name: "dice.bin", declaredOrigin: "physical dice",
                                            bytes: marker)],
                      encryptionBytes: 512, authRecords: 8)

        let plaintext = "SENTINEL-PLAINTEXT-do-not-leak-me"
        let burned = try e.burn(pairId: pairId, role: .a, plaintext: Array(plaintext.utf8))

        // The actual pad bytes now on disk, taken from the file that holds them.
        let secretPath = storePath(storeDir(pairId, .aToB), secretFile)
        let secret = try XCTUnwrap(try fs.readFile(secretPath))
        XCTAssertGreaterThan(secret.count, 64)
        // A window from the UNCONSUMED region — long enough that an accidental
        // match is not plausible.
        let window = Array(secret[(secret.count - 48)...])

        for path in fs.allPaths {
            guard let bytes = try fs.readFile(path) else { continue }
            // BOTH halves' secret.bin legitimately hold pad material.
            if path.hasSuffix(secretFile) { continue }

            XCTAssertFalse(Self.contains(bytes, window),
                           "\(path) contains live pad material")
            XCTAssertFalse(Self.contains(bytes, Array(plaintext.utf8)),
                           "\(path) contains the plaintext")
        }

        // The ENVELOPE the operator hands over must not contain the plaintext
        // either — that is the whole point of encrypting it.
        XCTAssertFalse(burned.envelope.contains(plaintext))
        XCTAssertFalse(Self.contains(Array(burned.envelope.utf8), window),
                       "the envelope must not carry pad material")

        // Nor may the courier bundle carry the plaintext, or this installation's
        // own bookkeeping.
        let container = try e.exportPair(pairId: pairId).container
        XCTAssertFalse(Self.contains(container, Array(plaintext.utf8)))
        let containerText = String(decoding: container, as: UTF8.self)
        for forbidden in ["leak-audit", "handoff.json", "generated-here"] {
            XCTAssertFalse(containerText.contains(forbidden),
                           "the bundle carries the PAD, not this installation's record: \(forbidden)")
        }
    }

    /// A REFUSAL MESSAGE MUST NOT CARRY WHAT IT REFUSED. Error text is shown to
    /// the operator, and on other platforms would be logged; a message that
    /// echoes the bytes that failed is a leak with a helpful tone.
    func testNoRefusalMessageEchoesSecretInput() throws {
        let fs = MemoryFs()
        let clock = Date(timeIntervalSince1970: 1_756_684_800)
        let pairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        let e = Engine(fs: fs, clock: { clock }, pairIdSource: { Hex.decode(pairId)! })
        let need = try Partition.requiredSourceLength(capacity: 256, capacityRecords: 4)
        _ = try e.gen(label: "refusals",
                      sources: [SourceInput(name: "s", declaredOrigin: "d",
                                            bytes: [UInt8](repeating: 0x2B, count: need))],
                      encryptionBytes: 256, authRecords: 4)

        let sentinel = "SENTINEL-SECRET-0123456789"
        var messages: [String] = []
        func collect(_ body: () throws -> Void) {
            do { try body() } catch let r as EngineRefused { messages.append(r.message) }
            catch let r as SptRefused { messages.append(r.message) }
            catch { messages.append("\(error)") }
        }

        collect { _ = try e.open(pairId: pairId, role: .b, envelopeText: sentinel) }
        collect { _ = try e.open(pairId: pairId, role: .b, envelopeText: "TP2:" + sentinel) }
        collect { _ = try e.importPair(label: "x", container: Array(sentinel.utf8)) }
        collect { _ = try e.sptOpen(packageBytes: Array(sentinel.utf8)) }
        collect { _ = try e.sptReviewRequest("TPR2:" + sentinel) }
        collect { _ = try e.destroy(pairId: pairId, confirm: sentinel) }

        XCTAssertGreaterThanOrEqual(messages.count, 5, "the refusals must actually have fired")
        for message in messages {
            XCTAssertFalse(message.contains(sentinel),
                           "a refusal echoed the input it refused: \(message)")
        }
    }

    /// And a destroy refusal must not echo the pairId — the operator confirms by
    /// knowing it, so a message that prints it hands over the answer.
    func testTheDestroyRefusalNeverEchoesThePairId() throws {
        let fs = MemoryFs()
        let clock = Date(timeIntervalSince1970: 1_756_684_800)
        let pairId = "5ab1e2c30d4f5a6b7c8d9e0fa1b2c3d4"
        let e = Engine(fs: fs, clock: { clock }, pairIdSource: { Hex.decode(pairId)! })
        let need = try Partition.requiredSourceLength(capacity: 256, capacityRecords: 4)
        _ = try e.gen(label: "confirm",
                      sources: [SourceInput(name: "s", declaredOrigin: "d",
                                            bytes: [UInt8](repeating: 0x2B, count: need))],
                      encryptionBytes: 256, authRecords: 4)

        do {
            _ = try e.destroy(pairId: pairId, confirm: "wrong")
            XCTFail("a wrong confirmation must refuse")
        } catch let refused as EngineRefused {
            XCTAssertEqual(refused.reason, "destroy-unconfirmed")
            XCTAssertFalse(refused.message.contains(pairId),
                           "the refusal must not hand over the value it is asking for")
        }
    }

    // MARK: - helper

    /// `needle` appearing as its own token, not as the tail of an identifier.
    static func containsAsCall(_ text: String, _ needle: String) -> Bool {
        var index = text.startIndex
        while let found = text.range(of: needle, range: index..<text.endIndex) {
            let precededByIdentifier: Bool
            if found.lowerBound == text.startIndex {
                precededByIdentifier = false
            } else {
                let before = text[text.index(before: found.lowerBound)]
                precededByIdentifier = before.isLetter || before.isNumber || before == "_"
            }
            if !precededByIdentifier { return true }
            index = found.upperBound
        }
        return false
    }

    static func contains(_ haystack: [UInt8], _ needle: [UInt8]) -> Bool {
        guard !needle.isEmpty, haystack.count >= needle.count else { return false }
        for start in 0...(haystack.count - needle.count)
        where Array(haystack[start..<(start + needle.count)]) == needle {
            return true
        }
        return false
    }
}
