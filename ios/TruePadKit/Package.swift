// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "TruePadKit",
    platforms: [.macOS(.v14), .iOS(.v16)],
    products: [
        // The shipping products. An app links these and nothing else from
        // this package, so it cannot reach TruePadKATSupport (below).
        .library(name: "TruePadCore", targets: ["TruePadCore"]),
        .library(name: "TruePadClaims", targets: ["TruePadClaims"]),
        .library(name: "TruePadStorage", targets: ["TruePadStorage"]),
        .library(name: "TruePadSPT", targets: ["TruePadSPT"]),
        .library(name: "TruePadUI", targets: ["TruePadUI"]),
    ],
    dependencies: [
        // Vendored apple/swift-crypto 4.5.2 (Apache-2.0), upstream commit
        // da9d28d69ebe3894b18376c8f2395c2f37b8448f. THREE intentional patches,
        // pinned byte-for-byte by ios/vendor/EXPECTED-PATCH.diff: two in its
        // Package.swift (the `development` switch, and exporting CCryptoBoringSSL
        // for the test-only KAT support), and ONE IN CRYPTO CODE --
        // Sources/Crypto/KEM/BoringSSL/XWing_boring.swift, an entropy-length
        // guard closing the unfixed sibling of CVE-2026-28815. That third patch
        // changes behaviour and IS in the shipping binary; this comment used to
        // say "two patches, both in its Package.swift", which understated it.
        // See ios/vendor/README.md and ios/vendor/verify-vendor.sh.
        .package(path: "../vendor/swift-crypto"),
    ],
    targets: [
        // ---- Production: the authenticated-OTP kernel --------------------
        // Deliberately depends on NOTHING. The OTP message path -- the literal
        // XOR, the four-slice partition, POLYVAL and the Wegman-Carter tag --
        // links no cryptography library at all, so no library can be blamed for
        // it and no library change can alter it. This mirrors the Android
        // Edition, where truepad-core is a pure-Kotlin module and Bouncy Castle
        // is reachable only from the separate Sealed Pad Transfer module
        // (Decision 19). SptKernelIsolationTests enforces it.
        .target(name: "TruePadCore"),

        // ---- Production: the deployment/assurance evaluator ---------------
        // The Swift twin of src/claims/shannon-deployment.ts. Like the kernel it
        // depends on NOTHING -- it is a pure total function from recorded facts
        // to a verdict, so it cannot read a file, reach a platform API, or cache
        // anything between calls. The committed deployment-evaluator-v3 corpus
        // holds every edition to the same answers.
        .target(name: "TruePadClaims"),

        // ---- Production: the durable store ------------------------------
        // The v2 store state machine over a filesystem abstraction, plus the SPT
        // orchestration verbs that compose the durable transfer protocol over it.
        //
        // It links TruePadSPT (and so, transitively, swift-crypto) because
        // SptEngine.swift lives here -- the same layering as Android, where
        // SptEngine.kt is in :truepad-storage and imports :truepad-spt. The
        // isolation that is claimed, tested, and load-bearing is one level down:
        // the OTP KERNEL links no cryptography library, so no library change can
        // alter the frozen message wire (ProductionIsolationTests). The store
        // itself does reach a cipher, through the transfer verbs, and this
        // comment says so rather than repeating a tidier claim that stopped
        // being true when those verbs landed.
        .target(name: "TruePadStorage",
                dependencies: ["TruePadCore", "TruePadClaims", "TruePadSPT"]),

        // ---- Production: Sealed Pad Transfer ------------------------------
        .target(
            name: "TruePadSPT",
            dependencies: [
                // The pure kernel, for the strict JSON reader and the canonical
                // ISO-8601 arithmetic the durable records are re-validated
                // against. It depends on nothing itself, so this adds no library
                // to the graph -- the same shape as Android, where :truepad-spt
                // imports truepad.core for exactly these.
                "TruePadCore",
                // Crypto alone: SPT needs X-Wing, HKDF-SHA-256, AES-256-GCM and
                // SHA-2/SHA-3, all of which live here. _CryptoExtras is deliberately
                // omitted, and the reason is narrower than it may look: it keeps
                // the SWIFT RSA/PAKE surface -- and the CRITICAL RSA double-free
                // advisory that lives in it -- out of the module graph, and keeps
                // SwiftASN1 out of the linked binary.
                //
                // It does NOT mean no RSA code ships. `Crypto` depends on
                // CCryptoBoringSSL, and that C object is ~2.6 MB and DOES contain
                // RSA, DSA, DES, PEM, X.509 and SPAKE2 -- verified by symbol in
                // the built app. Excluding _CryptoExtras removes a Swift surface
                // and a specific advisory's code path; it does not shrink
                // BoringSSL, and claiming otherwise would be false.
                .product(name: "Crypto", package: "swift-crypto"),
            ],
            // The comparison wordlist ONLY. `.process("Resources")` would copy the
            // whole directory, which shipped the provenance markdown inside the
            // app bundle -- harmless, but it is not the app's business to carry a
            // licence note to a phone. Naming the file means the bundle contains
            // exactly what the ceremony needs.
            resources: [.copy("Resources/comparison-words.txt")]
        ),

        // ---- Production: the presentation layer ---------------------------
        // SwiftUI views are impossible to test on CI without a device, so every
        // decision in the UI that can be wrong in a way that MATTERS -- what may
        // go in a QR code, whether a verdict was derived or stored, whether a
        // limitation was softened, whether a confirmation prompt echoes the value
        // it asks for -- lives in plain Swift here and is tested. It does not
        // link TruePadSPT: the UI has no business reaching the KEM.
        .target(name: "TruePadUI", dependencies: ["TruePadCore", "TruePadClaims", "TruePadStorage"]),

        // ---- Test support: NOT a product, NOT a dependency of TruePadSPT --
        // Deterministic (caller-supplied-entropy) X-Wing encapsulation, needed to
        // drive the frozen draft-10 Appendix-C vectors and TruePad's deterministic
        // interop fixtures. Because this is not a product and TruePadSPT does not
        // depend on it, it is absent from the shipping module graph by
        // construction -- not by naming convention. Guarded by TRUEPAD_KAT_SUPPORT
        // as belt-and-braces so the file cannot compile anywhere else.
        .target(
            name: "TruePadKATSupport",
            dependencies: [
                .product(name: "Crypto", package: "swift-crypto"),
                .product(name: "CCryptoBoringSSL", package: "swift-crypto"),
            ],
            swiftSettings: [.define("TRUEPAD_KAT_SUPPORT")]
        ),

        // ---- Vector generation: a tool, not a product --------------------
        // The twin of scripts/gen-spt-interop.ts. It links TruePadKATSupport, so
        // it is an executable TARGET with no product: a shipping app cannot
        // depend on it any more than it can depend on the KAT support itself.
        .executableTarget(
            name: "spt-vector-tool",
            dependencies: ["TruePadSPT", "TruePadKATSupport"]
        ),

        // ---- Tests ------------------------------------------------------
        .testTarget(
            name: "TruePadSPTTests",
            dependencies: [
                "TruePadCore",
                "TruePadClaims",
                "TruePadStorage",
                "TruePadUI",
                "TruePadSPT",
                "TruePadKATSupport",
                .product(name: "Crypto", package: "swift-crypto"),
            ]
        ),
    ]
)
