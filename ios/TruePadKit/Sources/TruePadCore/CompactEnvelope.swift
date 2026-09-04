/* ============================================================================
 * TP2 Compact Transport v1 — a PRESENTATION codec for Envelope v2 (§6).
 *
 * What a person copies today is 200-odd characters of JSON with two hex
 * characters per ciphertext byte. What they should copy — or scan — is
 * `TP2:AbCd…`. That is a packaging problem, and this solves exactly that and
 * nothing else.
 *
 * WHAT THIS IS NOT, because the distinction is the whole point:
 *   · not a cipher, not a MAC, not a second cryptographic protocol
 *   · not a new envelope meaning, and not a Store Format change
 *   · NOT an authentication canonicalization. The Wegman–Carter tag is computed
 *     over the SEMANTIC fields (pairId, direction, sequence, startOffset,
 *     ciphertext) — never over the JSON text, and never over these compact
 *     bytes. Nothing here is authenticated separately, and nothing here needs to
 *     be: a compact message decodes to an EnvelopeV2 and is then verified by the
 *     existing pipeline, unchanged.
 *
 * §6.2 canonical JSON remains THE wire representation and stays valid forever.
 * This is a reversible spelling of the same envelope:
 *
 *     TP2:<canonical unpadded base64url(binary envelope)>
 *          -> EnvelopeV2 -> the exact existing validation pipeline
 *
 * Two canonicality rules keep one message from having many spellings: the
 * varints are minimal (`80 00` for zero is refused), and the base64url text is
 * re-encoded and compared byte for byte with what arrived. Neither is a security
 * boundary on its own — the tag is — but a transport that admits several
 * spellings of one message is a transport that will eventually be asked which
 * spelling was "the" message, and there is no good answer.
 *
 * `ciphertextLength` is carried explicitly even though a binary parser could
 * infer it from what remains. It is an existing semantic field of the envelope
 * grammar, and the compact form asserts it and then CHECKS it, exactly as the
 * JSON grammar does. Inferring it would quietly make the two representations
 * describe different things.
 * ========================================================================= */

public enum CompactEnvelope {
    public static let prefix = "TP2:"
    public static let transportVersion: UInt8 = 0x01
    static let envelopeFormatVersion: UInt8 = 0x02
    static let pairIdBytes = 16
    static let tagBytes = 16
    static let directionAB: UInt8 = 0x00
    static let directionBA: UInt8 = 0x01

    /// Refuse a hostile paste long before decoding it. The largest legitimate
    /// compact message is a max-size ciphertext plus a small fixed header, and
    /// base64url costs 4 characters per 3 bytes.
    public static var maxCompactChars: Int {
        ((WcOneTime.maxCiphertextBytes + 64) * 4 + 2) / 3 + prefix.count
    }

    static let b64urlAlphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

    static func refuse(_ message: String) -> EnvelopeDecode {
        .refused(reason: .malformedEnvelope, message: message)
    }

    // ---- canonical unpadded base64url --------------------------------------

    public static func toBase64Url(_ bytes: [UInt8]) -> String {
        var out = ""
        out.reserveCapacity((bytes.count * 4 + 2) / 3)
        var i = 0
        while i < bytes.count {
            let remaining = bytes.count - i
            let b0 = Int(bytes[i])
            let b1 = remaining > 1 ? Int(bytes[i + 1]) : 0
            let b2 = remaining > 2 ? Int(bytes[i + 2]) : 0
            out.append(b64urlAlphabet[b0 >> 2])
            out.append(b64urlAlphabet[((b0 & 0x03) << 4) | (b1 >> 4)])
            if remaining > 1 { out.append(b64urlAlphabet[((b1 & 0x0F) << 2) | (b2 >> 6)]) }
            if remaining > 2 { out.append(b64urlAlphabet[b2 & 0x3F]) }
            i += 3
        }
        return out
    }

    /// STRICT: the RFC 4648 §5 alphabet only — no `=` padding, no `+` or `/`, and
    /// no whitespace anywhere inside. A group of length 1 is impossible in base64.
    public static func fromBase64Url(_ text: String) -> [UInt8]? {
        let chars = Array(text)
        // A faithful primitive: "" is the encoding of zero bytes. Whether an
        // EMPTY payload is a legitimate compact envelope is a question for the
        // envelope decoder, which refuses it there with a message that says why.
        if chars.count % 4 == 1 { return nil }
        if chars.isEmpty { return [] }

        func index(_ c: Character) -> Int? { b64urlAlphabet.firstIndex(of: c) }

        var out: [UInt8] = []
        out.reserveCapacity(chars.count * 3 / 4)
        var i = 0
        while i < chars.count {
            let group = chars.count - i
            guard let c0 = index(chars[i]), let c1 = index(chars[i + 1]) else { return nil }
            out.append(UInt8((c0 << 2) | (c1 >> 4)))
            if group > 2 {
                guard let c2 = index(chars[i + 2]) else { return nil }
                out.append(UInt8(((c1 & 0x0F) << 4) | (c2 >> 2)))
                if group > 3 {
                    guard let c3 = index(chars[i + 3]) else { return nil }
                    out.append(UInt8(((c2 & 0x03) << 6) | c3))
                }
            }
            i += 4
        }
        return out
    }

    // ---- canonical unsigned LEB128 -----------------------------------------

    /// MINIMAL encoding only. The writer never emits a redundant group and the
    /// reader refuses one, so `0` is `00` and never `80 00`.
    static func writeUleb128(_ out: inout [UInt8], _ value: Int) {
        var v = value
        repeat {
            let byte = UInt8(v & 0x7F)
            v /= 128
            out.append(v > 0 ? byte | 0x80 : byte)
        } while v > 0
    }

    enum UlebRead {
        case ok(value: Int, next: Int)
        case failed(why: String)
    }

    static func readUleb128(_ bytes: [UInt8], _ offset: Int, _ field: String) -> UlebRead {
        var value: UInt64 = 0
        var shift: UInt64 = 0
        var i = offset
        while true {
            guard i < bytes.count else { return .failed(why: "\(field) varint is truncated") }
            let byte = bytes[i]
            // Guard the shift BEFORE applying it, so a long varint cannot wrap.
            if shift > 63 { return .failed(why: "\(field) varint is longer than 64 bits") }
            let chunk = UInt64(byte & 0x7F)
            if shift >= 64 || (chunk << shift) >> shift != chunk {
                return .failed(why: "\(field) exceeds the safe-integer range")
            }
            value |= chunk << shift
            i += 1
            if byte & 0x80 == 0 {
                // Canonical: a multi-byte encoding may not end in a group that
                // carries nothing. `80 00` is the same number as `00`, refused.
                if i - offset > 1 && byte == 0x00 {
                    return .failed(why: "\(field) varint is not minimally encoded")
                }
                break
            }
            shift += 7
            if shift > 63 { return .failed(why: "\(field) varint is longer than 64 bits") }
        }
        guard value <= UInt64(EnvelopeCodec.maxSafeInteger) else {
            return .failed(why: "\(field) exceeds the safe-integer range")
        }
        return .ok(value: Int(value), next: i)
    }

    // ---- encode -------------------------------------------------------------

    /// Refuses anything `EnvelopeCodec.encode` would refuse, BY ASKING IT: the
    /// compact form may only ever represent an envelope the canonical
    /// implementation would itself emit. It is not a looser door into the same
    /// house.
    public static func encode(_ envelope: EnvelopeV2) throws -> String {
        _ = try EnvelopeCodec.encode(envelope)   // throws on any domain violation
        guard let pairId = Hex.decode(envelope.pairId), pairId.count == pairIdBytes else {
            throw EnvelopeCodingError.badPairId(envelope.pairId)
        }
        var head: [UInt8] = [transportVersion, envelopeFormatVersion]
        head.append(contentsOf: pairId)
        head.append(envelope.direction == .aToB ? directionAB : directionBA)
        writeUleb128(&head, envelope.sequence)
        writeUleb128(&head, envelope.startOffset)
        writeUleb128(&head, envelope.ciphertextLength)

        var bytes = head
        bytes.append(contentsOf: envelope.ciphertext)
        bytes.append(contentsOf: envelope.tag)
        return prefix + toBase64Url(bytes)
    }

    // ---- decode -------------------------------------------------------------

    /// Structural parse, then the EXISTING canonical machinery decides. The round
    /// trip through the canonical encoder/decoder is deliberate: envelope domain
    /// rules live in exactly one place, and a compact message can represent only
    /// what that place accepts.
    public static func decode(_ text: String) -> EnvelopeDecode {
        let trimmed = text.trimmingCharactersInWhitespace()
        guard trimmed.hasPrefix(prefix) else {
            return refuse("a compact envelope begins with \"\(prefix)\"")
        }
        guard trimmed.count <= maxCompactChars else {
            return refuse("this compact envelope is \(trimmed.count) characters; the largest "
                          + "possible is \(maxCompactChars)")
        }
        let payload = String(trimmed.dropFirst(prefix.count))
        guard !payload.isEmpty else { return refuse("\"\(prefix)\" carries no payload") }
        guard !payload.contains("=") else {
            return refuse("compact payloads are unpadded base64url; \"=\" padding is not part of "
                          + "the spelling")
        }
        guard let bytes = fromBase64Url(payload) else {
            return refuse("the compact payload is not canonical unpadded base64url (A-Z a-z 0-9 - _)")
        }
        // One message, one spelling: re-encode and require the exact same text.
        guard toBase64Url(bytes) == payload else {
            return refuse("the compact payload is not the canonical base64url spelling of its own bytes")
        }

        var at = 0
        func need(_ count: Int) -> Bool { bytes.count - at >= count }

        guard need(2) else { return refuse("the compact envelope is truncated before its version bytes") }
        guard bytes[at] == transportVersion else {
            return refuse("compact transport version \(bytes[at]) is not supported (this build "
                          + "speaks \(transportVersion))")
        }
        at += 1
        guard bytes[at] == envelopeFormatVersion else {
            // v1 envelopes are refused by their OWN reason everywhere else; keep that.
            if bytes[at] == 0x01 {
                return .refused(reason: .envelopeV1,
                                message: "this compact envelope declares Envelope v1, which this "
                                    + "build does not accept")
            }
            return refuse("envelope formatVersion \(bytes[at]) is not 2")
        }
        at += 1

        guard need(pairIdBytes) else { return refuse("the compact envelope is truncated inside its pairId") }
        let pairId = Hex.encode(Array(bytes[at..<(at + pairIdBytes)]))
        at += pairIdBytes

        guard need(1) else { return refuse("the compact envelope is truncated before its direction") }
        let directionByte = bytes[at]
        guard directionByte == directionAB || directionByte == directionBA else {
            // Hex by hand: String(format:) needs Foundation, and the kernel
            // imports nothing.
            let hex = Hex.encode([directionByte])
            return refuse("direction byte 0x\(hex) is neither 0x00 (A->B) nor 0x01 (B->A)")
        }
        let direction: PadDirection = directionByte == directionAB ? .aToB : .bToA
        at += 1

        let sequence: Int, startOffset: Int, ciphertextLength: Int
        switch readUleb128(bytes, at, "sequence") {
        case .failed(let why): return refuse(why)
        case .ok(let v, let next): sequence = v; at = next
        }
        switch readUleb128(bytes, at, "startOffset") {
        case .failed(let why): return refuse(why)
        case .ok(let v, let next): startOffset = v; at = next
        }
        switch readUleb128(bytes, at, "ciphertextLength") {
        case .failed(let why): return refuse(why)
        case .ok(let v, let next): ciphertextLength = v; at = next
        }

        guard ciphertextLength <= WcOneTime.maxCiphertextBytes else {
            return .refused(reason: .oversizeCiphertext,
                            message: "ciphertextLength \(ciphertextLength) exceeds "
                                + "MAX_CIPHERTEXT_BYTES \(WcOneTime.maxCiphertextBytes)")
        }
        // The DECLARED length is checked against what is actually carried, exactly
        // as the JSON grammar checks it — never inferred from what is left over.
        let remaining = bytes.count - at
        guard remaining >= ciphertextLength + tagBytes else {
            return refuse("ciphertextLength declares \(ciphertextLength) bytes plus a "
                          + "\(tagBytes)-byte tag, but only \(remaining) bytes remain")
        }
        guard remaining <= ciphertextLength + tagBytes else {
            return refuse("\(remaining - ciphertextLength - tagBytes) trailing byte(s) follow the "
                          + "tag; a compact envelope carries nothing else")
        }
        let ciphertext = Array(bytes[at..<(at + ciphertextLength)])
        let tag = Array(bytes[(at + ciphertextLength)...])

        // Hand the candidate to the canonical implementation and let IT decide.
        let json: String
        do {
            json = try EnvelopeCodec.encode(EnvelopeV2(
                pairId: pairId, direction: direction, sequence: sequence,
                startOffset: startOffset, ciphertextLength: ciphertextLength,
                ciphertext: ciphertext, tag: tag))
        } catch {
            return refuse("the compact envelope does not describe a valid Envelope v2 — \(error)")
        }
        return EnvelopeCodec.decode(json)
    }

    // ---- the transport door -------------------------------------------------

    /// Accepts EITHER spelling, with no mode selector anywhere above it.
    ///
    /// A `TP2:` input is decoded as compact and REFUSED as compact if malformed —
    /// it never falls through to the JSON parser, because a half-typed compact
    /// string is not a JSON document, and pretending otherwise would report the
    /// wrong error and invite a parser-confusion bug. Anything else goes to the
    /// existing strict canonical parser, byte for byte as before.
    public static func decodeTransport(_ text: String) -> EnvelopeDecode {
        isCompact(text) ? decode(text) : EnvelopeCodec.decode(text)
    }

    public static func isCompact(_ text: String) -> Bool {
        text.trimmingCharactersInWhitespace().hasPrefix(prefix)
    }
}

public enum EnvelopeCodingError: Error, Equatable {
    case badPairId(String)
}

extension String {
    /// `String.trimmingCharacters(in: .whitespacesAndNewlines)` needs Foundation,
    /// and TruePadCore imports nothing. This trims the same set JavaScript's
    /// `String.prototype.trim` does for the inputs this codec sees.
    func trimmingCharactersInWhitespace() -> String {
        var chars = Array(self)
        func isSpace(_ c: Character) -> Bool {
            c == " " || c == "\t" || c == "\n" || c == "\r" || c == "\u{0B}" || c == "\u{0C}"
                || c == "\u{A0}" || c == "\u{FEFF}"
        }
        while let f = chars.first, isSpace(f) { chars.removeFirst() }
        while let l = chars.last, isSpace(l) { chars.removeLast() }
        return String(chars)
    }
}
