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
    ],
    dependencies: [
        // Vendored apple/swift-crypto 4.5.2 (Apache-2.0), upstream commit
        // da9d28d69ebe3894b18376c8f2395c2f37b8448f. Two intentional patches, both
        // in its Package.swift; see ios/vendor/README.md and ios/vendor/verify-vendor.sh.
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
        // The v2 store state machine over a filesystem abstraction. Depends on
        // the kernel and on Foundation/Darwin, but NOT on any crypto library:
        // the durable consumption state is where reuse safety actually lives,
        // and it is written against the platform, not against a cipher.
        .target(name: "TruePadStorage", dependencies: ["TruePadCore"]),

        // ---- Production: Sealed Pad Transfer ------------------------------
        .target(
            name: "TruePadSPT",
            dependencies: [
                // Crypto alone: SPT needs X-Wing, HKDF-SHA-256, AES-256-GCM and
                // SHA-2/SHA-3, all of which live here. _CryptoExtras is deliberately
                // omitted -- it would put SwiftASN1 and a large RSA/PAKE surface into
                // the shipping module graph for no benefit. (SwiftPM still resolves
                // and compiles them as part of the dependency package; what this
                // controls is what the app's module graph actually links.)
                .product(name: "Crypto", package: "swift-crypto"),
            ]
        ),

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
                "TruePadSPT",
                "TruePadKATSupport",
                .product(name: "Crypto", package: "swift-crypto"),
            ]
        ),
    ]
)
