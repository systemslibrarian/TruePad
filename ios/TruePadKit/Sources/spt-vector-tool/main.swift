/* ============================================================================
 * Generate the iOS-side SPT interop corpus.
 * ----------------------------------------------------------------------------
 * The twin of scripts/gen-spt-interop.ts, pointing the other way.
 *
 * `android/vectors/spt-interop.json` proves Browser -> iOS: the released
 * TypeScript packages are opened by this edition, and resealed byte-for-byte.
 * That already implies the reverse by transitivity — a byte-identical sealer is
 * openable by anyone who can open the original — but it exercises only the
 * DERANDOMIZED seal path. A fault in production encapsulation (the system
 * CSPRNG path) would not appear in it at all, because the fixtures never use it.
 *
 * So this tool emits both:
 *
 *   reproducible: true   deterministic seals, from the SAME inputs as the
 *                        TypeScript corpus. Any edition must reproduce these
 *                        byte-for-byte and open them.
 *   reproducible: false  seals made with REAL entropy from the production path.
 *                        They cannot be reproduced by anyone, including a rerun
 *                        of this tool. Other editions must OPEN them.
 *
 * Run:  swift run --package-path ios/TruePadKit spt-vector-tool ios/vectors/spt-swift-generated.json
 *
 * This target is not a package product; a shipping app cannot link it.
 * ========================================================================= */

import Foundation
import TruePadKATSupport
import TruePadSPT

struct FixedEntropyEncapsulator: XWingEncapsulating {
    let eseed: [UInt8]
    func encapsulate(encapsulationKey: [UInt8]) throws -> XWingEncapsulation {
        let r = try DeterministicXWing.encapsulate(publicKey: encapsulationKey, eseed: eseed)
        return XWingEncapsulation(ciphertext: r.ciphertext, sharedSecret: r.sharedSecret)
    }
}

func hex(_ s: String) -> [UInt8] {
    var out = [UInt8](); out.reserveCapacity(s.count / 2)
    var i = s.startIndex
    while i < s.endIndex {
        let j = s.index(i, offsetBy: 2)
        out.append(UInt8(s[i..<j], radix: 16)!)
        i = j
    }
    return out
}

func hexString(_ b: [UInt8]) -> String { b.map { String(format: "%02x", $0) }.joined() }
func rep(_ b: String, _ n: Int) -> String { String(repeating: b, count: n) }

// The same three inputs the TypeScript corpus uses, so the deterministic half of
// this file is directly comparable with android/vectors/spt-interop.json.
let deterministicCases: [(label: String, seed: String, eseed: String, requestId: String, payload: String)] = [
    (
        "vector-c",
        "01060b10151a1f24292e33383d42474c51565b60656a6f74797e83888d92979c",
        "07121d28333e49545f6a75808b96a1acb7c2cdd8e3eef9040f1a25303b46515c"
            + "67727d88939ea9b4bfcad5e0ebf6010c17222d38434e59646f7a85909ba6b1bc",
        "031425364758697a8b9cadbecfe0f102",
        "TruePad SPT vector C payload — opaque bytes.\n"
    ),
    ("empty-payload", rep("aa", 32), rep("bb", 64), rep("cc", 16), ""),
    ("one-kib-payload", rep("11", 32), rep("22", 64), rep("33", 16), String(repeating: "P", count: 1024)),
]

// Recipients for the production-entropy cases. Deterministic recipients keep the
// diff small; only the seal entropy is real.
let productionCases: [(label: String, seed: String, requestId: String, payload: String)] = [
    ("production-entropy-short", rep("5a", 32), rep("a5", 16), "sealed by iOS with the system CSPRNG\n"),
    ("production-entropy-empty", rep("6b", 32), rep("b6", 16), ""),
    ("production-entropy-1kib", rep("7c", 32), rep("c7", 16), String(repeating: "Q", count: 1024)),
]

// `build` returns the entry rather than appending to a global: under Swift 6
// concurrency checking, top-level state is main-actor isolated and a plain
// function may not mutate it.
func build(label: String, reproducible: Bool, seedHex: String, requestId: String,
           payload: [UInt8], eseedHex: String?) throws -> [String: Any] {
    let seed = hex(seedHex)
    let encapsulationKey = try XWing.publicKey(fromSeed: seed)
    let body = try ReceiveRequestCodec.encodeBody(requestId: hex(requestId),
                                                  encapsulationKey: encapsulationKey)

    let sealed: SealResult
    if let eseedHex {
        sealed = try SptCryptoV1.seal(canonicalRequestBody: body, payload: payload,
                                      encapsulator: FixedEntropyEncapsulator(eseed: hex(eseedHex)))
    } else {
        sealed = try SptCryptoV1.seal(canonicalRequestBody: body, payload: payload)
    }

    // Self-check, exactly as the TypeScript generator does: this edition's opener
    // must recover the payload from this edition's own package before the bytes
    // are written down as evidence for anyone else.
    guard case .ok(let opened) = SptCryptoV1.open(packageBytes: sealed.packageBytes,
                                                  canonicalRequestBody: body,
                                                  decapsulationSeed: seed) else {
        FileHandle.standardError.write(Data("\(label): Swift could not open its own package\n".utf8))
        exit(1)
    }
    guard opened.payload == payload else {
        FileHandle.standardError.write(Data("\(label): Swift open payload mismatch\n".utf8))
        exit(1)
    }

    var entry: [String: Any] = [
        "label": label,
        "reproducible": reproducible,
        "requestBodyHex": hexString(body),
        "decapSeedHex": seedHex,
        "payloadHex": hexString(payload),
        "packageHex": hexString(sealed.packageBytes),
        "confirmValueHex": hexString(sealed.confirmValue),
        "confirmationIndices": sealed.confirmationIndices,
    ]
    if let eseedHex { entry["eseedHex"] = eseedHex }
    return entry
}

var cases: [[String: Any]] = []
for c in deterministicCases {
    cases.append(try build(label: c.label, reproducible: true, seedHex: c.seed,
                           requestId: c.requestId, payload: Array(c.payload.utf8),
                           eseedHex: c.eseed))
}
for c in productionCases {
    cases.append(try build(label: c.label, reproducible: false, seedHex: c.seed,
                           requestId: c.requestId, payload: Array(c.payload.utf8),
                           eseedHex: nil))
}

let document: [String: Any] = [
    "note": "iOS Edition SPT seal output. Cases with reproducible=true must be reproduced "
        + "byte-for-byte by any edition from the same inputs; every case must OPEN to payloadHex. "
        + "Cases with reproducible=false were sealed with real entropy from the production path "
        + "and cannot be regenerated identically -- they exist so the other editions open bytes "
        + "this edition produced WITHOUT injected randomness.",
    "source": "ios/TruePadKit Sources/TruePadSPT SptCryptoV1.seal",
    "cases": cases,
]

let path = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "spt-swift-generated.json"
let json = try JSONSerialization.data(withJSONObject: document,
                                      options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
try json.write(to: URL(fileURLWithPath: path))
FileHandle.standardError.write(Data("wrote \(cases.count) cases to \(path)\n".utf8))
