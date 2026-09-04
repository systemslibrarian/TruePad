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
    static let shippingTargets = ["TruePadCore", "TruePadClaims", "TruePadStorage", "TruePadSPT",
                                  "TruePadUI"]

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
        for target in Self.shippingTargets {
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
        for target in Self.shippingTargets {
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
