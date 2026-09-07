import Foundation
import XCTest

/// THE ORDINARY iOS SUITE MUST BE RUNNABLE ALONE, AND THE TWO-DEVICE ONE MUST
/// STILL BE RUNNABLE ON PURPOSE.
///
/// `TruePadAppUITests` is the bundle docs/RELEASE-CHECKLIST-3.0.md names as the
/// iOS gate, expecting "all on-device tests pass". Three tests in it need a
/// Samsung on the same desk, a receive code that handset published moments ago,
/// and a courier moving bytes between the two — and they FAILED rather than
/// skipped when those were absent, so the gate as written could not be re-run
/// green on a healthy build. Whether the bundle passed depended on how it was
/// invoked, which is the exact property android/app/build.gradle.kts says must
/// not exist.
///
/// Android has a build-level answer (`@CrossEditionStep` plus the runner's
/// `notAnnotation`). iOS has the same discipline at runtime, and this holds the
/// two ends of it together — including the orphan check, which is how a file that
/// belonged to no target at all sat in the directory unnoticed.
final class PhysicalSuiteIsolationTests: XCTestCase {

    private var uiTestDir: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()   // ios/
            .appendingPathComponent("TruePadApp/TruePadAppUITests")
    }

    private var pbxproj: String {
        (try? String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("TruePadApp/TruePadApp.xcodeproj/project.pbxproj"),
            encoding: .utf8)) ?? ""
    }

    private func uiTestFiles() throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: uiTestDir.path)
            .filter { $0.hasSuffix(".swift") }
            .sorted()
    }

    private func body(_ name: String) throws -> String {
        try String(contentsOf: uiTestDir.appendingPathComponent(name), encoding: .utf8)
    }

    /// The classes that cannot run without a second physical device.
    private let twoDevice = ["CrossEditionSealTest.swift", "CrossEditionMessageTest.swift"]
    private let optIn = "TRUEPAD_PHYSICAL_CEREMONY"

    func testTheGuardFoundTheBundle() throws {
        // POSITIVE CONTROL. Everything below passes over an empty directory.
        let files = try uiTestFiles()
        XCTAssertGreaterThanOrEqual(files.count, 5, "the UI-test bundle was not found")
        for name in twoDevice {
            XCTAssertTrue(files.contains(name), "\(name) is gone; this guard now names nothing")
        }
        XCTAssertGreaterThan(pbxproj.count, 10_000, "project.pbxproj was not found")
    }

    func testEveryTwoDeviceClassSkipsUnlessTheHarnessIsDriving() throws {
        for name in twoDevice {
            let src = try body(name)
            XCTAssertTrue(src.contains("try XCTSkipUnless("),
                          "\(name) still FAILS rather than skips without its second device")
            // THE CONDITION, NOT THE MESSAGE. `contains(optIn)` was satisfied by
            // the skip's explanatory sentence alone, so the gate could read a
            // different environment variable entirely and this still passed.
            XCTAssertTrue(
                src.contains("ProcessInfo.processInfo.environment[\"\(optIn)\"] == \"1\""),
                "\(name)'s skip does not test the ceremony opt-in itself")
            // KEYED ON THE OPT-IN, NOT ON THE INPUTS. Skipping because an input
            // is missing would make a misconfigured ceremony skip silently — the
            // one outcome worse than the failure this replaces.
            XCTAssertFalse(src.contains("XCTSkipUnless(ProcessInfo.processInfo.environment[\"TPR2\"]"),
                           "\(name) skips on a missing input instead of on the opt-in")
            // And when it DOES run, every original assertion is still as loud.
            XCTAssertTrue(src.contains("XCTUnwrap"), "\(name) no longer insists on its inputs")
        }
    }

    func testNoOrdinaryTestHidesBehindTheOptIn() throws {
        for name in try uiTestFiles() where !twoDevice.contains(name) {
            XCTAssertFalse(try body(name).contains(optIn),
                           "\(name) is an ordinary product test and must not be gated behind the "
                            + "two-device opt-in — that is how coverage disappears quietly")
        }
    }

    func testNoUITestFileIsOrphanedFromTheTarget() throws {
        // A .swift file in this directory that no target builds runs never, shows
        // up in no report, and looks like coverage in a listing.
        // `OpenFieldBindingProbe.swift` was exactly that: present, untracked, and
        // in no section of project.pbxproj at all.
        for name in try uiTestFiles() {
            XCTAssertTrue(pbxproj.contains(name),
                          "\(name) is in TruePadAppUITests but belongs to no target, so it never "
                            + "runs — add it to the target or delete it")
        }
    }

    func testTheHarnessSetsTheOptInItselfSoThePhysicalSuiteStillRuns() throws {
        let script = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent()                    // repo root
                .appendingPathComponent("scripts/cross-edition-physical.sh"),
            encoding: .utf8)
        // xcodebuild forwards TEST_RUNNER_<X> into the runner as <X>.
        XCTAssertTrue(script.contains("TEST_RUNNER_\(optIn)=1"),
                      "the ceremony harness no longer enables the tests it exists to run")
    }
}
