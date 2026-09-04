import Foundation
import XCTest

/// LOSS IS ACCEPTABLE; REUSE IS NOT.
///
/// Deterministic X-Wing encapsulation is a reuse machine: the same `eseed` means
/// the same ML-KEM ciphertext and the same shared secret. TruePad needs it to
/// reproduce frozen vectors, and must never ship it.
///
/// These tests enforce that boundary STRUCTURALLY, at the level of the package
/// graph and the production sources -- not by trusting an underscore in a name.
final class ProductionIsolationTests: XCTestCase {
    static var kitRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // TruePadSPTTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // TruePadKit
    }
    static var iosRoot: URL { kitRoot.deletingLastPathComponent() }

    func manifest() throws -> String {
        try String(contentsOf: Self.kitRoot.appendingPathComponent("Package.swift"), encoding: .utf8)
    }

    /// The manifest with `//` comments removed. These tests assert on what the
    /// package graph DECLARES; prose that merely mentions a target name (including
    /// the comments explaining this very boundary) must not register as a
    /// dependency or a product.
    func manifestCode() throws -> String {
        try manifest()
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> Substring in
                guard let r = line.range(of: "//") else { return line }
                return line[..<r.lowerBound]
            }
            .joined(separator: "\n")
    }

    /// Extract a bracket-balanced array literal that follows `label` in the manifest.
    /// Naive prefix-scanning is wrong here: the products array contains nested
    /// `targets: [...]` arrays, so the first `]` is not the end.
    private func balancedArray(after label: String, in text: String) -> String? {
        guard let start = text.range(of: label) else { return nil }
        var depth = 0
        var out = ""
        for ch in text[start.lowerBound...] {
            if ch == "[" { depth += 1; if depth == 1 { continue } }
            if ch == "]" { depth -= 1; if depth == 0 { return out } }
            if depth >= 1 { out.append(ch) }
        }
        return nil
    }

    /// The test-support target must not be a package product: if it is not a
    /// product, no external app target can depend on it, whatever it is named.
    func testKATSupportIsNotAProduct() throws {
        let m = try manifestCode()
        guard let products = balancedArray(after: "products: [", in: m) else {
            return XCTFail("could not parse the products array")
        }
        XCTAssertTrue(products.contains("TruePadSPT"),
                      "sanity: the products array should declare TruePadSPT")
        XCTAssertFalse(products.contains("TruePadKATSupport"),
                       "TruePadKATSupport must never be exported as a product")
    }

    /// Strip Swift comments — `//` to end of line, and nested `/* ... */` — from
    /// source text.
    ///
    /// The audit below must judge CODE, not prose. The production sources
    /// deliberately explain this very boundary, and naming the forbidden surface
    /// in a doc comment is exactly how that explanation is written. An audit that
    /// cannot tell an explanation from a call site would force the code to stop
    /// documenting its own security property, which is the wrong trade.
    static func strippingComments(_ text: String) -> String {
        var out = ""
        var depth = 0
        var inLineComment = false
        var chars = Array(text)
        var i = 0
        while i < chars.count {
            let c = chars[i]
            let next: Character? = i + 1 < chars.count ? chars[i + 1] : nil

            if inLineComment {
                if c == "\n" { inLineComment = false; out.append(c) }
                i += 1
                continue
            }
            if depth > 0 {
                if c == "/", next == "*" { depth += 1; i += 2; continue }
                if c == "*", next == "/" { depth -= 1; i += 2; continue }
                if c == "\n" { out.append(c) }   // keep line numbering meaningful
                i += 1
                continue
            }
            if c == "/", next == "/" { inLineComment = true; i += 2; continue }
            if c == "/", next == "*" { depth = 1; i += 2; continue }
            out.append(c)
            i += 1
        }
        return out
    }

    /// Every `.target(...)` / `.testTarget(...)` declaration in the manifest, each
    /// as a balanced-parenthesis block. Searching for `name: "TruePadSPT"` directly
    /// is WRONG -- the products array declares a library of the same name first,
    /// and would be matched instead of the target.
    private func targetDeclarations(in code: String) -> [String] {
        var out: [String] = []
        for marker in [".target(", ".testTarget("] {
            var searchStart = code.startIndex
            while let found = code.range(of: marker, range: searchStart..<code.endIndex) {
                var depth = 0
                var decl = ""
                var idx = found.upperBound
                depth = 1
                while idx < code.endIndex, depth > 0 {
                    let ch = code[idx]
                    if ch == "(" { depth += 1 }
                    if ch == ")" { depth -= 1; if depth == 0 { break } }
                    decl.append(ch)
                    idx = code.index(after: idx)
                }
                out.append(decl)
                searchStart = found.upperBound
            }
        }
        return out
    }

    /// The production target must not depend on the test-support target, nor on
    /// the raw BoringSSL C module that exposes the derandomized entry point.
    func testProductionTargetDoesNotDependOnKATSupport() throws {
        let code = try manifestCode()
        let decls = targetDeclarations(in: code)
        XCTAssertFalse(decls.isEmpty, "no target declarations parsed from the manifest")

        let production = decls.filter { $0.contains("name: \"TruePadSPT\"") }
        XCTAssertEqual(production.count, 1,
                       "expected exactly one TruePadSPT target declaration, got \(production.count)")
        let decl = production[0]

        XCTAssertFalse(decl.contains("TruePadKATSupport"),
                       "TruePadSPT must not depend on TruePadKATSupport")
        XCTAssertFalse(decl.contains("CCryptoBoringSSL"),
                       "TruePadSPT must not depend on the raw BoringSSL C module")
        XCTAssertFalse(decl.contains("TRUEPAD_KAT_SUPPORT"),
                       "TruePadSPT must not define the KAT-support flag")

        // And the KAT-support target must exist, be flag-guarded, and be the only
        // place the raw C module is reachable from.
        let katSupport = decls.filter { $0.contains("name: \"TruePadKATSupport\"") }
        XCTAssertEqual(katSupport.count, 1, "expected exactly one TruePadKATSupport target")
        XCTAssertTrue(katSupport[0].contains("TRUEPAD_KAT_SUPPORT"),
                      "TruePadKATSupport must define its compile-time guard flag")
    }

    /// No production source may name the deterministic surface, by any route --
    /// direct call, C symbol, module import, or dynamic lookup.
    func testProductionSourcesNeverNameTheDeterministicSurface() throws {
        let forbidden = [
            "encap_external_entropy",   // the BoringSSL entry point
            "DeterministicXWing",       // TruePad's wrapper
            "TruePadKATSupport",        // the test-support module
            "CCryptoBoringSSL",         // the raw C module
            "eseed",                    // caller-supplied encapsulation entropy
            "encapsulateWithOptionalEntropy",
            "TRUEPAD_KAT_SUPPORT",
            "dlsym",                    // no dynamic lookup workaround
            "NSClassFromString",
            "NSSelectorFromString",
        ]
        let sources = Self.kitRoot.appendingPathComponent("Sources/TruePadSPT")
        let files = try FileManager.default
            .subpathsOfDirectory(atPath: sources.path)
            .filter { $0.hasSuffix(".swift") }
        XCTAssertFalse(files.isEmpty, "no production sources found to audit")

        for file in files {
            let raw = try String(contentsOf: sources.appendingPathComponent(file), encoding: .utf8)
            let text = Self.strippingComments(raw)
            for needle in forbidden {
                XCTAssertFalse(text.contains(needle),
                               "production source \(file) references forbidden symbol '\(needle)'")
            }
        }
    }

    /// The vendored dependency must carry NO TruePad source patch. Both intentional
    /// changes live in its Package.swift; if a future change smuggles a hook into
    /// Sources/, the app would link it, so fail loudly here.
    func testVendoredSourcesCarryNoTruePadPatch() throws {
        let vendorSources = Self.iosRoot.appendingPathComponent("vendor/swift-crypto/Sources")
        let paths = try FileManager.default.subpathsOfDirectory(atPath: vendorSources.path)
        let truePadFiles = paths.filter { $0.lowercased().contains("truepad") }
        XCTAssertTrue(truePadFiles.isEmpty,
                      "vendored swift-crypto Sources/ must contain no TruePad files, found: \(truePadFiles)")
    }
}
