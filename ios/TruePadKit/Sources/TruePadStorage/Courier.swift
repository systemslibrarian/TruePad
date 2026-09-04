import Foundation
import TruePadCore

/* ============================================================================
 * The courier container format — byte-exact twin of
 * src/browser/engine/courier-format.ts and Android's Courier.kt.
 *
 * A pair's store IS the pad. The courier step packs the exact FORMAT-V2 store
 * files into ONE self-describing byte container the peer can import, and unpacks
 * one on import. The container is a small JSON envelope with base64 file bodies;
 * base64 is the ON-CONTAINER encoding only.
 *
 * A container written here is byte-identical to one written by the released
 * Browser Edition for the same six files, and `courier-container.json` — a vector
 * generated from the released v2.0.0 — is what holds it to that.
 * ========================================================================= */

public let containerTag = "truepad2-pair-bundle"

public struct CourierFile: Sendable, Equatable {
    public let path: String
    public let bytes: [UInt8]

    public init(path: String, bytes: [UInt8]) {
        self.path = path
        self.bytes = bytes
    }
}

public enum UnpackResult: Sendable {
    case ok(pairId: String, files: [CourierFile])
    case bad(message: String)
}

/// Pack the store files into the container bytes. Two spaces of indentation,
/// matching the released `JSON.stringify(doc, null, 2)`.
public func packContainer(pairId: String, files: [CourierFile]) -> [UInt8] {
    var s = "{\n  \"format\": "
    appendJsonString(&s, containerTag)
    s.append(",\n  \"version\": 1,\n  \"pairId\": ")
    appendJsonString(&s, pairId)
    s.append(",\n  \"files\": [")
    for (i, f) in files.enumerated() {
        if i > 0 { s.append(",") }
        s.append("\n    {\n      \"path\": ")
        appendJsonString(&s, f.path)
        s.append(",\n      \"bytesB64\": ")
        appendJsonString(&s, Data(f.bytes).base64EncodedString())
        s.append("\n    }")
    }
    s.append(files.isEmpty ? "]" : "\n  ]")
    s.append("\n}")
    return Array(s.utf8)
}

/// Parse and structurally validate a container.
///
/// Deeper validation — the exact file set, the headers, reconciliation, pairId
/// agreement — is the importer's TRANSACTIONAL job. This just turns bytes into a
/// typed, well-formed shape or a clear refusal, and never lets a malformed
/// container reach the store.
public func unpackContainer(_ bytes: [UInt8]) -> UnpackResult {
    guard let text = String(bytes: bytes, encoding: .utf8),
          let doc = try? parseStrictJson(text) else {
        return .bad(message: "This file is not valid JSON — it is not a TruePad pad bundle.")
    }
    guard let rec = doc.memberMap else {
        return .bad(message: "This file is not a TruePad pad bundle.")
    }
    guard case .string(let format)? = rec["format"], format == containerTag else {
        return .bad(message: "This file is not a TruePad pad bundle (wrong format tag).")
    }
    guard case .string(let pairId)? = rec["pairId"] else {
        return .bad(message: "Bundle is missing its pairId.")
    }
    guard case .array(let items)? = rec["files"] else {
        return .bad(message: "Bundle is missing its files.")
    }
    var files: [CourierFile] = []
    files.reserveCapacity(items.count)
    for entry in items {
        guard let e = entry.memberMap else {
            return .bad(message: "Bundle contains a malformed file entry.")
        }
        guard case .string(let path)? = e["path"], case .string(let b64)? = e["bytesB64"] else {
            return .bad(message: "Bundle contains a malformed file entry.")
        }
        // STRICT base64: no line breaks, no unknown characters, no missing
        // padding. A container this cannot decode is refused, never guessed at.
        guard let decoded = Data(base64Encoded: b64) else {
            return .bad(message: "Bundle file \"\(path)\" is not valid base64.")
        }
        files.append(CourierFile(path: path, bytes: [UInt8](decoded)))
    }
    return .ok(pairId: pairId, files: files)
}
