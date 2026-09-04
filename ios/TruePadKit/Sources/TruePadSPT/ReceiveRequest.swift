/* ============================================================================
 * TPR2 — the Receive Request codec
 * ----------------------------------------------------------------------------
 * Byte-exact twin of src/spt/receive-request.ts.
 * docs/SEALED-PAD-TRANSFER.md §5. A 1235-byte canonical body, rendered as
 * `TPR2:` plus canonical unpadded base64url — exactly 1652 characters.
 *
 * The body carries FOUR things and nothing else: the transfer version, the
 * suite, a 16-byte public requestId, and the 1216-byte X-Wing encapsulation key.
 * No pairId, no pad metadata, no device or account identity, no secret.
 *
 * There is NO algorithm negotiation. A request naming a version or suite this
 * build does not implement is refused, never downgraded and never "best-effort"
 * decoded — the whole point of freezing suite 0x0001 in a document is that the
 * wire cannot ask for something else.
 *
 * `requestId` is a receiver-side LOOKUP HANDLE and carries no uniqueness
 * guarantee: the requester chooses those bytes and an attacker may choose them
 * to collide. §5.1 is explicit that sender-side state must be keyed by the
 * complete body (or its hash), never by requestId, and this module keeps that
 * possible by always handing back the exact canonical bytes it decoded.
 * ========================================================================= */

import Foundation

public struct ReceiveRequest: Sendable, Equatable {
    public let version: UInt8
    public let suite: UInt16
    public let requestId: [UInt8]
    public let encapsulationKey: [UInt8]
}

/// What can be wrong with the 1235 BINARY bytes, independent of transport.
public enum RequestBodyError: String, Sendable, Equatable {
    case wrongBodyLength = "wrong-body-length"
    case unsupportedVersion = "unsupported-version"
    case unsupportedSuite = "unsupported-suite"
}

/// Everything that can be wrong with a pasted TPR2 text. The body reasons are
/// included verbatim so a caller sees the same vocabulary the other editions use.
public enum RequestDecodeError: String, Sendable, Equatable {
    case wrongPrefix = "wrong-prefix"
    case notBase64Url = "not-base64url"
    case noncanonicalBase64Url = "noncanonical-base64url"
    case wrongBodyLength = "wrong-body-length"
    case unsupportedVersion = "unsupported-version"
    case unsupportedSuite = "unsupported-suite"

    init(_ body: RequestBodyError) {
        switch body {
        case .wrongBodyLength: self = .wrongBodyLength
        case .unsupportedVersion: self = .unsupportedVersion
        case .unsupportedSuite: self = .unsupportedSuite
        }
    }
}

public enum RequestBodyParse: Sendable {
    case ok(request: ReceiveRequest, canonicalBody: [UInt8])
    case failed(reason: RequestBodyError, message: String)
}

public enum RequestDecode: Sendable {
    case ok(request: ReceiveRequest, canonicalBody: [UInt8])
    case failed(reason: RequestDecodeError, message: String)
}

public enum ReceiveRequestCodec {
    /// **The single authority on what a canonical request body is.**
    ///
    /// Every path that treats 1235 bytes as a request goes through here: the TPR2
    /// text decoder, `seal`, and `open`. There is deliberately no second place
    /// that reads byte 0 for a version or bytes [1,3) for a suite — two parsers
    /// are two chances to disagree about what a request *is*, and the first thing
    /// that would disagree is which key the sender encapsulates to.
    ///
    /// The returned `requestId`, `encapsulationKey` and `canonicalBody` are
    /// COPIES (Swift arrays are values), so a caller that mutates one cannot
    /// change what the body said afterwards.
    public static func parseBody(_ body: [UInt8]) -> RequestBodyParse {
        guard body.count == SptConstants.tpr2BodyBytes else {
            return .failed(reason: .wrongBodyLength,
                           message: "a request body is \(SptConstants.tpr2BodyBytes) bytes, got \(body.count)")
        }
        let version = body[0]
        guard version == SptConstants.transferVersion else {
            return .failed(reason: .unsupportedVersion,
                           message: "unsupported transfer version 0x\(String(version, radix: 16))")
        }
        let suite = SptBytes.readUInt16BE(body, 1)
        guard suite == SptConstants.suiteId else {
            let hex = String(format: "%04x", suite)
            return .failed(reason: .unsupportedSuite, message: "unsupported suite 0x\(hex)")
        }
        let request = ReceiveRequest(
            version: version,
            suite: suite,
            requestId: Array(body[3..<19]),
            encapsulationKey: Array(body[19...])
        )
        return .ok(request: request, canonicalBody: body)
    }

    /// Build the canonical 1235-byte body.
    public static func encodeBody(requestId: [UInt8], encapsulationKey: [UInt8]) throws -> [UInt8] {
        guard requestId.count == SptConstants.requestIdBytes else {
            throw SptError.wrongLength("requestId",
                                       expected: SptConstants.requestIdBytes, got: requestId.count)
        }
        guard encapsulationKey.count == SptConstants.xwingPublicKeyBytes else {
            throw SptError.wrongLength("encapsulationKey",
                                       expected: SptConstants.xwingPublicKeyBytes,
                                       got: encapsulationKey.count)
        }
        var body = [UInt8](repeating: 0, count: SptConstants.tpr2BodyBytes)
        body[0] = SptConstants.transferVersion
        SptBytes.writeUInt16BE(&body, 1, SptConstants.suiteId)
        body.replaceSubrange(3..<19, with: requestId)
        body.replaceSubrange(19..<SptConstants.tpr2BodyBytes, with: encapsulationKey)
        return body
    }

    public static func encode(requestId: [UInt8], encapsulationKey: [UInt8]) throws -> String {
        let body = try encodeBody(requestId: requestId, encapsulationKey: encapsulationKey)
        return SptConstants.tpr2Prefix + SptBytes.toBase64Url(body)
    }

    /// Decode a pasted request.
    ///
    /// Surrounding whitespace is trimmed because a paste picks it up; whitespace
    /// INSIDE is invalid, and so are `=` padding, `+` and `/`. The decoded body is
    /// re-encoded and compared character-for-character, which is what actually
    /// makes the encoding canonical: without it, a final group with non-zero
    /// trailing bits decodes to the same 1235 bytes under a different spelling,
    /// and one request would have several texts.
    public static func decode(_ text: String) -> RequestDecode {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix(SptConstants.tpr2Prefix) else {
            return .failed(reason: .wrongPrefix,
                           message: "a receive request starts with \"\(SptConstants.tpr2Prefix)\"")
        }
        // Bound a hostile paste before doing anything per-character with it. The
        // text length is fixed, so the slack is only enough to let the checks
        // below report WHY a near-miss is wrong rather than just "wrong length".
        let length = trimmed.count
        guard length <= SptConstants.tpr2TextChars + 64 else {
            return .failed(reason: .wrongBodyLength,
                           message: "a receive request is exactly \(SptConstants.tpr2TextChars) characters, got \(length)")
        }
        let encoded = String(trimmed.dropFirst(SptConstants.tpr2Prefix.count))
        // Alphabet before length, so `=` padding, `+`, `/` and interior
        // whitespace are named for what they are. Padding in particular changes
        // the length, and reporting a padded request as "wrong length" would send
        // an implementer looking for the wrong bug.
        guard SptBytes.isBase64UrlAlphabet(encoded) else {
            return .failed(reason: .notBase64Url,
                           message: "the request is not canonical unpadded base64url")
        }
        guard length == SptConstants.tpr2TextChars else {
            return .failed(reason: .wrongBodyLength,
                           message: "a receive request is exactly \(SptConstants.tpr2TextChars) characters, got \(length)")
        }
        guard let body = SptBytes.fromBase64Url(encoded) else {
            return .failed(reason: .notBase64Url,
                           message: "the request is not canonical unpadded base64url")
        }
        guard SptBytes.toBase64Url(body) == encoded else {
            return .failed(reason: .noncanonicalBase64Url,
                           message: "the request has a non-canonical base64url spelling")
        }
        // Transport is done; the SEMANTIC validation belongs to the one binary
        // parser, so a request that arrives as text and a request handed straight
        // to seal() are judged by identical rules.
        switch parseBody(body) {
        case .ok(let request, let canonicalBody):
            return .ok(request: request, canonicalBody: canonicalBody)
        case .failed(let reason, let message):
            return .failed(reason: RequestDecodeError(reason), message: message)
        }
    }
}
