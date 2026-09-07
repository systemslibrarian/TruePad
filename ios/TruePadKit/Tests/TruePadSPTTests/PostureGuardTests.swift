import Foundation
import XCTest

/// Cheap guards against future regressions that would be expensive to notice
/// later. None of these adds a product feature; each one closes a door.
final class PostureGuardTests: XCTestCase {
    static var kitRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }
    static var repoRoot: URL { kitRoot.deletingLastPathComponent().deletingLastPathComponent() }

    /// The shipping products. The test-only and host-only targets are excluded on
    /// purpose and named here so the exclusion is deliberate rather than implicit.
    /// The app shell: shipping Swift that is not a SwiftPM target.
    static let appShellTarget = "TruePadApp"
    /// The SwiftPM targets. Used where the question is about `Package.swift`.
    static let shippingTargets = ["TruePadCore", "TruePadClaims", "TruePadStorage", "TruePadSPT",
                                  "TruePadUI"]

    /// Every directory of SHIPPING SWIFT, which is a larger set than the SwiftPM
    /// targets: `ios/TruePadApp/TruePadApp/` is compiled into the binary an
    /// operator installs and declares no target of its own, so it sat outside the
    /// no-network ban, the stored-verdict ban and the leakage sweep alike. It is
    /// clean today — which is exactly the kind of fact that stops being true
    /// without anyone noticing.
    static let shippingSourceTargets = shippingTargets + [appShellTarget]

    func manifestCode() throws -> String {
        try String(contentsOf: Self.kitRoot.appendingPathComponent("Package.swift"), encoding: .utf8)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> Substring in
                guard let r = line.range(of: "//") else { return line }
                return line[..<r.lowerBound]
            }
            .joined(separator: "\n")
    }

    func sources(of target: String) throws -> [(name: String, text: String)] {
        // THE APP SHELL IS A TARGET TOO. `ios/TruePadApp/TruePadApp/` is compiled
        // into the binary an operator installs, and it sat outside every sweep
        // here — the no-network ban, the stored-verdict ban, all of it. It is
        // clean today, which is exactly the kind of fact that stops being true
        // without anyone noticing. Named rather than derived from Package.swift,
        // because it is not a SwiftPM target.
        if target == Self.appShellTarget {
            let dir = Self.kitRoot.deletingLastPathComponent()
                .appendingPathComponent("TruePadApp/TruePadApp")
            let files = try FileManager.default.subpathsOfDirectory(atPath: dir.path)
                .filter { $0.hasSuffix(".swift") }
            return try files.map { (name: "\(target)/\($0)",
                                    text: try String(contentsOf: dir.appendingPathComponent($0),
                                                     encoding: .utf8)) }
        }
        let dir = Self.kitRoot.appendingPathComponent("Sources/\(target)")
        let files = try FileManager.default.subpathsOfDirectory(atPath: dir.path)
            .filter { $0.hasSuffix(".swift") }
        return try files.map { (name: "\(target)/\($0)",
                                text: try String(contentsOf: dir.appendingPathComponent($0),
                                                 encoding: .utf8)) }
    }

    // MARK: - _CryptoExtras must not enter the shipping graph

    /// `_CryptoExtras` carries the RSA and PAKE surface, and pulls SwiftASN1 with
    /// it. TruePad uses none of it. Keeping it out is not merely tidiness: the
    /// CRITICAL RSA double-free advisory (CVE-2026-43823) lives in exactly that
    /// module, and TruePad's unreachability argument for it rests on this single
    /// fact. If a future change links `_CryptoExtras`, that argument silently
    /// stops holding — so it fails here instead.
    ///
    /// Deliberate review is still possible: this guard names the products, so
    /// adding the dependency means changing this test too, which is the review.
    /// Every `.target(...)` / `.executableTarget(...)` / `.testTarget(...)` block,
    /// balanced-paren extracted.
    ///
    /// Searching for `name: "TruePadSPT"` directly is WRONG and I got it wrong
    /// once: the products array declares a library of the same name FIRST, so the
    /// search lands on the product and the guard inspects a block that could never
    /// contain a dependency — passing vacuously. Caught by mutating the manifest
    /// and finding the guard did not bite.
    private func targetDeclarations(in code: String) -> [String] {
        var out: [String] = []
        for marker in [".target(", ".executableTarget(", ".testTarget("] {
            var from = code.startIndex
            while let found = code.range(of: marker, range: from..<code.endIndex) {
                var depth = 1
                var decl = ""
                var idx = found.upperBound
                while idx < code.endIndex, depth > 0 {
                    let ch = code[idx]
                    if ch == "(" { depth += 1 }
                    if ch == ")" { depth -= 1; if depth == 0 { break } }
                    decl.append(ch)
                    idx = code.index(after: idx)
                }
                out.append(decl)
                from = found.upperBound
            }
        }
        return out
    }

    func testNoShippingProductLinksCryptoExtras() throws {
        let code = try manifestCode()
        let decls = targetDeclarations(in: code)
        XCTAssertFalse(decls.isEmpty, "no target declarations parsed")

        for target in Self.shippingTargets {
            let matching = decls.filter { $0.contains("name: \"\(target)\"") }
            XCTAssertEqual(matching.count, 1,
                           "expected exactly one \(target) TARGET declaration, got \(matching.count)")
            let decl = matching.first ?? ""

            XCTAssertFalse(decl.contains("_CryptoExtras"),
                           "\(target) must not link _CryptoExtras — TruePad's unreachability "
                           + "argument for the RSA advisory depends on it staying out")
            XCTAssertFalse(decl.contains("CryptoExtras"),
                           "\(target) must not link CryptoExtras")
        }

        // And no shipping source may import it either, whatever the manifest says.
        for target in Self.shippingSourceTargets {
            for file in try sources(of: target) {
                XCTAssertFalse(file.text.contains("import _CryptoExtras"),
                               "\(file.name) imports _CryptoExtras")
                XCTAssertFalse(file.text.contains("import CryptoExtras"),
                               "\(file.name) imports CryptoExtras")
            }
        }
    }

    // MARK: - network posture

    /// TruePad performs NO network I/O. Android proves this with a manifest that
    /// declares no INTERNET permission; iOS has no such declaration to inspect, so
    /// the guard has to be at the source level.
    ///
    /// A pad-management app that quietly gained a network call would be a
    /// different product, and the failure would be silent — nothing else in the
    /// suite would notice. This is the thing that notices.
    func testShippingSourcesHaveNoNetworkCapability() throws {
        let forbidden = [
            "import Network",           // Network.framework
            "import NetworkExtension",
            "URLSession",
            "URLRequest",
            "NSURLConnection",
            "CFSocket",
            "Socket(",
            "getaddrinfo",
            "CFStream",
            "NWConnection",
            "NWListener",
        ]
        for target in Self.shippingSourceTargets {
            for file in try sources(of: target) {
                let text = Self.stripComments(file.text)
                for needle in forbidden {
                    XCTAssertFalse(text.contains(needle),
                                   "\(file.name) references \(needle): TruePad ships no network "
                                   + "capability, and there is no manifest permission on iOS to "
                                   + "catch this later")
                }
            }
        }
    }

    /// The kernel is dependency-free by design; assert it imports nothing that
    /// would drag a runtime in. Foundation is permitted in storage, not here.
    func testTheOtpKernelImportsNothing() throws {
        for file in try sources(of: "TruePadCore") {
            let text = Self.stripComments(file.text)
            for line in text.split(separator: "\n") where line.hasPrefix("import ") {
                XCTFail("\(file.name) has \(line) — TruePadCore depends on nothing")
            }
        }
        // The claims evaluator is likewise pure.
        for file in try sources(of: "TruePadClaims") {
            let text = Self.stripComments(file.text)
            for line in text.split(separator: "\n") where line.hasPrefix("import ") {
                XCTFail("\(file.name) has \(line) — TruePadClaims depends on nothing")
            }
        }
    }

    // MARK: - no stored verdict, in ANY edition

    /// A verdict must never be persisted. Storing one lets it outlive the facts
    /// that produced it, and a stale "eligible" is precisely the claim TruePad
    /// must never make.
    ///
    /// This sweeps Swift, Kotlin AND TypeScript from one place, because the rule
    /// is cross-edition and a per-edition guard is one edition away from being
    /// forgotten.
    func testNoEditionStoresAVerdictField() throws {
        // The same token list Android's AppSourceAuditTest already enforces, so
        // the two guards cannot drift apart on what counts as a stored verdict.
        let forbiddenFields = ["perfectSecrecy", "shannonSecure", "shannonEligible",
                               "goldStandard", "perfect_secrecy", "shannon_secure"]
        let roots = [
            ("iOS", "ios/TruePadKit/Sources", [".swift"]),
            ("Android", "android", [".kt"]),
            ("Browser/CLI", "src", [".ts"]),
        ]

        var scanned = 0
        for (edition, relative, extensions) in roots {
            let root = Self.repoRoot.appendingPathComponent(relative)
            guard let e = FileManager.default.enumerator(atPath: root.path) else { continue }
            for case let path as String in e {
                guard extensions.contains(where: { path.hasSuffix($0) }) else { continue }
                if path.contains("/build/") || path.contains("/.build/") { continue }
                // PRODUCTION sources only. A guard test legitimately NAMES the
                // forbidden tokens as data — Android's AppSourceAuditTest does
                // exactly that — and flagging one guard for enforcing the rule
                // would be the same mistake the production-source audit already
                // made once.
                if path.contains("/test/") || path.contains("/Tests/")
                    || path.contains("/androidTest/") || path.hasSuffix(".test.ts")
                    || path.contains("/tests/") { continue }
                guard let text = try? String(contentsOf: root.appendingPathComponent(path),
                                             encoding: .utf8) else { continue }
                scanned += 1
                let code = Self.stripComments(text)
                for field in forbiddenFields {
                    XCTAssertFalse(code.contains(field),
                                   "[\(edition)] \(path) mentions \(field): a verdict must be "
                                   + "DERIVED from live facts, never stored")
                }
            }
        }
        XCTAssertGreaterThan(scanned, 100, "the sweep should have covered all three editions, "
                             + "only scanned \(scanned) files")
    }

    // MARK: - helper

    /// Strip `//` and `/* */` so prose explaining a forbidden term is not mistaken
    /// for a use of it — the same lesson the production-source audit already
    /// learned.
    /// The brace-balanced block introduced by the first `{` at or after `anchor`,
    /// anchor included. Nil when the anchor is absent or its block never closes.
    ///
    /// STRUCTURAL, NOT A BYTE COUNT. Both plaintext-leakage guards used to read a
    /// fixed window forward from this same anchor — `prefix(900)` in
    /// `LeakageAuditTests` and `prefix(700)` in `AppShellRegressionTests`. The
    /// block they guard ends 621 characters in, so the tighter one had 79
    /// characters of margin: adding 308 characters of ORDINARY PRODUCT PROSE
    /// inside the block pushes `.textSelection(.enabled)` past both windows, and
    /// every precondition those guards assert still passes while it happens. A
    /// region a paragraph can walk out of is not a region.
    ///
    /// `ThemeTokenTests` learned this from a 220-character window that a mutation
    /// walked straight through, and replaced it with structural walking. The two
    /// guards that matter most had not caught up.
    ///
    /// Braces inside string literals are skipped by a quote-toggling scan, which
    /// is deliberately simple and has two known limits, stated so nobody
    /// calibrates the guard's strength wrongly from this comment:
    ///
    ///   · a `\(...)` interpolation is NOT re-entered, so a quote inside one
    ///     flips the scanner's idea of whether it is in a string. In practice the
    ///     region walked here contains none, and a wrong flip ENDS the region
    ///     early or runs it to the end of the file — the first is caught by the
    ///     callers' `hasSuffix("}")` and precondition assertions, the second
    ///     makes the region larger, never smaller.
    ///   · it is applied to comment-stripped text, and `stripComments` is not
    ///     string-aware either; a `//` inside a string literal in the scanned file
    ///     would corrupt the input. Also caught by the same preconditions.
    ///
    /// Both fail toward a region that is too LARGE or an outright test failure,
    /// never toward one that is too small — which is the direction that would hide
    /// a violation. Strictly stronger than the character count it replaces.
    static func blockAfter(_ anchor: String, in text: String) -> String? {
        guard let a = text.range(of: anchor) else { return nil }
        var depth = 0
        var started = false
        var inString = false
        var escaped = false
        var out = ""
        for ch in text[a.lowerBound...] {
            out.append(ch)
            if escaped { escaped = false; continue }
            if ch == "\\" { escaped = true; continue }
            if ch == "\"" { inString.toggle(); continue }
            if inString { continue }
            if ch == "{" {
                depth += 1
                started = true
            } else if ch == "}" {
                depth -= 1
                if started && depth == 0 { return out }
            }
        }
        return nil
    }

    static func stripComments(_ text: String) -> String {
        var out = ""
        var depth = 0
        var inLine = false
        let chars = Array(text)
        var i = 0
        while i < chars.count {
            let c = chars[i]
            let next: Character? = i + 1 < chars.count ? chars[i + 1] : nil
            if inLine {
                if c == "\n" { inLine = false; out.append(c) }
                i += 1; continue
            }
            if depth > 0 {
                if c == "/", next == "*" { depth += 1; i += 2; continue }
                if c == "*", next == "/" { depth -= 1; i += 2; continue }
                if c == "\n" { out.append(c) }
                i += 1; continue
            }
            if c == "/", next == "/" { inLine = true; i += 2; continue }
            if c == "/", next == "*" { depth = 1; i += 2; continue }
            out.append(c)
            i += 1
        }
        return out
    }
}
