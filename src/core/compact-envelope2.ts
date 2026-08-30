/* ============================================================================
 * TP2 Compact Transport v1 — a PRESENTATION codec for Envelope v2 (§6)
 * ----------------------------------------------------------------------------
 * What a person copies today is 200-odd characters of JSON with two hex
 * characters per ciphertext byte. What they should copy is `TP2:AbCd…`. That
 * is a packaging problem, and this module solves exactly that and nothing else.
 *
 * WHAT THIS IS NOT, because the distinction is the whole point:
 *   · not a cipher, not a MAC, not a second cryptographic protocol
 *   · not a new envelope meaning and not a Store Format change
 *   · NOT an authentication canonicalization. The Wegman–Carter tag is
 *     computed over the SEMANTIC fields (wc-one-time.ts `canonicalBytes`:
 *     pairId, direction, sequence, startOffset, ciphertext) — never over the
 *     JSON text, and never over these compact bytes. Nothing here is
 *     authenticated separately, and nothing here needs to be: a compact
 *     message decodes to an EnvelopeV2 and is then verified by the existing
 *     pipeline, unchanged.
 *
 * §6.2 canonical JSON remains THE wire representation of Envelope v2 and stays
 * valid forever. This is a reversible spelling of the same envelope:
 *
 *     TP2:<canonical unpadded base64url(binary envelope)>
 *          ↓
 *     EnvelopeV2
 *          ↓
 *     the exact existing validation / authentication / open pipeline
 *
 * Two canonicality rules keep one message from having many spellings. The
 * varints are minimal (`80 00` for zero is refused), and the base64url text is
 * re-encoded and compared byte-for-byte with what arrived. Neither is a
 * security boundary on its own — the tag is — but a transport that admits
 * several spellings of one message is a transport that will eventually be
 * asked which spelling was "the" message, and there is no good answer.
 *
 * `ciphertextLength` is carried explicitly even though a binary parser could
 * infer it from what remains. It is an existing semantic field of the envelope
 * grammar, and the compact form asserts it and then checks it, exactly as the
 * JSON grammar does. Inferring it would quietly make the two representations
 * describe different things.
 *
 * Dependency-free and platform-neutral: no Buffer, no atob/btoa, no Node or
 * DOM API. The same bytes in the browser, the CLI, and the tests.
 * ========================================================================= */

import { decodeEnvelope2, encodeEnvelope2, type Envelope2Decode, type EnvelopeV2 } from "./envelope2.ts";
import { bytesToHex, hexToBytes } from "./hex.ts";
import { MAX_CIPHERTEXT_BYTES } from "./wc-one-time.ts";

export const COMPACT_PREFIX = "TP2:";
export const COMPACT_TRANSPORT_VERSION = 0x01;
const ENVELOPE_FORMAT_VERSION = 0x02;
const PAIR_ID_BYTES = 16;
const TAG_BYTES = 16;
const DIRECTION_AB = 0x00;
const DIRECTION_BA = 0x01;

// Refuse a hostile paste long before decoding it. The largest legitimate
// compact message is a max-size ciphertext plus a small fixed header, and
// base64url costs 4 characters per 3 bytes.
const MAX_COMPACT_CHARS = Math.ceil(((MAX_CIPHERTEXT_BYTES + 64) * 4) / 3) + COMPACT_PREFIX.length;

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_INDEX: Record<string, number> = {};
for (let i = 0; i < B64URL.length; i += 1) {
  B64URL_INDEX[B64URL[i]] = i;
}

const refuse = (message: string): Envelope2Decode => ({ ok: false, reason: "malformed-envelope", message });

/* ---- canonical unpadded base64url ----------------------------------------- */

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const remaining = bytes.length - i;
    const b0 = bytes[i];
    const b1 = remaining > 1 ? bytes[i + 1] : 0;
    const b2 = remaining > 2 ? bytes[i + 2] : 0;
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (remaining > 1) out += B64URL[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (remaining > 2) out += B64URL[b2 & 0x3f];
  }
  return out;
}

// Strict: the RFC 4648 §5 alphabet only, no `=` padding, no `+` or `/`, and no
// whitespace anywhere inside. A group of length 1 is impossible in base64.
export function fromBase64Url(text: string): Uint8Array | null {
  // A faithful primitive: "" is the encoding of zero bytes. Whether an EMPTY
  // payload is a legitimate compact envelope is a question for the envelope
  // decoder, which refuses it there with a message that says why.
  if (text.length % 4 === 1) {
    return null; // impossible: base64 groups are never 1 character
  }
  if (text.length === 0) {
    return new Uint8Array(0);
  }
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let written = 0;
  for (let i = 0; i < text.length; i += 4) {
    const group = text.length - i;
    const c0 = B64URL_INDEX[text[i]];
    const c1 = B64URL_INDEX[text[i + 1]];
    if (c0 === undefined || c1 === undefined) return null;
    out[written++] = (c0 << 2) | (c1 >> 4);
    if (group > 2) {
      const c2 = B64URL_INDEX[text[i + 2]];
      if (c2 === undefined) return null;
      out[written++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
      if (group > 3) {
        const c3 = B64URL_INDEX[text[i + 3]];
        if (c3 === undefined) return null;
        out[written++] = ((c2 & 0x03) << 6) | c3;
      }
    }
  }
  return out.subarray(0, written);
}

/* ---- canonical unsigned LEB128 -------------------------------------------- */

// Minimal encoding only. The writer never emits a redundant group and the
// reader refuses one, so `0` is `00` and never `80 00`.
function writeUleb128(out: number[], value: number): void {
  let v = value;
  do {
    const byte = v & 0x7f;
    v = Math.floor(v / 128);
    out.push(v > 0 ? byte | 0x80 : byte);
  } while (v > 0);
}

type UlebRead = { ok: true; value: number; next: number } | { ok: false; why: string };

// BigInt only INSIDE the decode, so an overlong or oversized varint is caught
// before it could become an imprecise Number. EnvelopeV2 itself never sees one.
function readUleb128(bytes: Uint8Array, offset: number, field: string): UlebRead {
  let value = 0n;
  let shift = 0n;
  let i = offset;
  for (;;) {
    if (i >= bytes.length) {
      return { ok: false, why: `${field} varint is truncated` };
    }
    const byte = bytes[i];
    value |= BigInt(byte & 0x7f) << shift;
    i += 1;
    if ((byte & 0x80) === 0) {
      // Canonical: a multi-byte encoding may not end in a group that carries
      // nothing. `80 00` is the same number as `00` and is refused.
      if (i - offset > 1 && byte === 0x00) {
        return { ok: false, why: `${field} varint is not minimally encoded` };
      }
      break;
    }
    shift += 7n;
    if (shift > 63n) {
      return { ok: false, why: `${field} varint is longer than 64 bits` };
    }
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, why: `${field} exceeds the safe-integer range` };
  }
  return { ok: true, value: Number(value), next: i };
}

/* ---- encode ---------------------------------------------------------------- */

// Refuses anything encodeEnvelope2 would refuse, by asking it: the compact form
// may only ever represent an envelope the canonical implementation would itself
// emit. It is not a looser door into the same house.
export function encodeCompactEnvelope2(envelope: EnvelopeV2): string {
  encodeEnvelope2(envelope); // throws on any domain violation; output discarded
  const pairId = hexToBytes(envelope.pairId);
  if (pairId === null || pairId.length !== PAIR_ID_BYTES) {
    throw new Error("pairId must be exactly 32 lowercase hex characters");
  }
  const head: number[] = [COMPACT_TRANSPORT_VERSION, ENVELOPE_FORMAT_VERSION];
  for (const byte of pairId) head.push(byte);
  head.push(envelope.direction === "A->B" ? DIRECTION_AB : DIRECTION_BA);
  writeUleb128(head, envelope.sequence);
  writeUleb128(head, envelope.startOffset);
  writeUleb128(head, envelope.ciphertextLength);

  const bytes = new Uint8Array(head.length + envelope.ciphertext.length + TAG_BYTES);
  bytes.set(head, 0);
  bytes.set(envelope.ciphertext, head.length);
  bytes.set(envelope.tag, head.length + envelope.ciphertext.length);
  return COMPACT_PREFIX + toBase64Url(bytes);
}

/* ---- decode ---------------------------------------------------------------- */

// Structural parse, then the EXISTING canonical machinery decides. The
// round-trip through encodeEnvelope2/decodeEnvelope2 is deliberate: envelope
// domain rules live in exactly one place, and a compact message can represent
// only what that place accepts.
export function decodeCompactEnvelope2(text: string): Envelope2Decode {
  const trimmed = text.trim();
  if (!trimmed.startsWith(COMPACT_PREFIX)) {
    return refuse(`a compact envelope begins with "${COMPACT_PREFIX}"`);
  }
  if (trimmed.length > MAX_COMPACT_CHARS) {
    return refuse(`this compact envelope is ${trimmed.length} characters; the largest possible is ${MAX_COMPACT_CHARS}`);
  }
  const payload = trimmed.slice(COMPACT_PREFIX.length);
  if (payload.length === 0) {
    return refuse(`"${COMPACT_PREFIX}" carries no payload`);
  }
  if (payload.includes("=")) {
    return refuse("compact payloads are unpadded base64url; \"=\" padding is not part of the spelling");
  }
  const bytes = fromBase64Url(payload);
  if (bytes === null) {
    return refuse("the compact payload is not canonical unpadded base64url (A-Z a-z 0-9 - _)");
  }
  // One message, one spelling: re-encode and require the exact same text.
  if (toBase64Url(bytes) !== payload) {
    return refuse("the compact payload is not the canonical base64url spelling of its own bytes");
  }

  let at = 0;
  const need = (count: number, what: string): boolean => {
    if (bytes.length - at < count) {
      return false;
    }
    void what;
    return true;
  };
  if (!need(2, "header")) return refuse("the compact envelope is truncated before its version bytes");
  if (bytes[at] !== COMPACT_TRANSPORT_VERSION) {
    return refuse(`compact transport version ${bytes[at]} is not supported (this build speaks ${COMPACT_TRANSPORT_VERSION})`);
  }
  at += 1;
  if (bytes[at] !== ENVELOPE_FORMAT_VERSION) {
    // v1 envelopes are refused by their own reason everywhere else; keep that.
    return bytes[at] === 0x01
      ? { ok: false, reason: "envelope-v1", message: "this compact envelope declares Envelope v1, which this build does not accept" }
      : refuse(`envelope formatVersion ${bytes[at]} is not 2`);
  }
  at += 1;

  if (!need(PAIR_ID_BYTES, "pairId")) return refuse("the compact envelope is truncated inside its pairId");
  const pairId = bytesToHex(bytes.subarray(at, at + PAIR_ID_BYTES));
  at += PAIR_ID_BYTES;

  if (!need(1, "direction")) return refuse("the compact envelope is truncated before its direction");
  const directionByte = bytes[at];
  if (directionByte !== DIRECTION_AB && directionByte !== DIRECTION_BA) {
    return refuse(`direction byte 0x${directionByte.toString(16).padStart(2, "0")} is neither 0x00 (A->B) nor 0x01 (B->A)`);
  }
  const direction = directionByte === DIRECTION_AB ? "A->B" : "B->A";
  at += 1;

  const sequence = readUleb128(bytes, at, "sequence");
  if (!sequence.ok) return refuse(sequence.why);
  at = sequence.next;
  const startOffset = readUleb128(bytes, at, "startOffset");
  if (!startOffset.ok) return refuse(startOffset.why);
  at = startOffset.next;
  const ciphertextLength = readUleb128(bytes, at, "ciphertextLength");
  if (!ciphertextLength.ok) return refuse(ciphertextLength.why);
  at = ciphertextLength.next;

  if (ciphertextLength.value > MAX_CIPHERTEXT_BYTES) {
    return {
      ok: false,
      reason: "oversize-ciphertext",
      message: `ciphertextLength ${ciphertextLength.value} exceeds MAX_CIPHERTEXT_BYTES ${MAX_CIPHERTEXT_BYTES}`
    };
  }
  // The declared length is checked against what is actually carried, exactly as
  // the JSON grammar checks it — never inferred from what is left over.
  const remaining = bytes.length - at;
  if (remaining < ciphertextLength.value + TAG_BYTES) {
    return refuse(
      `ciphertextLength declares ${ciphertextLength.value} bytes plus a ${TAG_BYTES}-byte tag, but only ${remaining} bytes remain`
    );
  }
  if (remaining > ciphertextLength.value + TAG_BYTES) {
    return refuse(
      `${remaining - ciphertextLength.value - TAG_BYTES} trailing byte(s) follow the tag; a compact envelope carries nothing else`
    );
  }
  const ciphertext = bytes.slice(at, at + ciphertextLength.value);
  const tag = bytes.slice(at + ciphertextLength.value);

  // Hand the candidate to the canonical implementation and let IT decide.
  let json: string;
  try {
    json = encodeEnvelope2({
      pairId,
      direction,
      sequence: sequence.value,
      startOffset: startOffset.value,
      ciphertextLength: ciphertextLength.value,
      ciphertext,
      tag
    });
  } catch (error) {
    return refuse(`the compact envelope does not describe a valid Envelope v2 — ${(error as Error).message}`);
  }
  return decodeEnvelope2(json);
}

/* ---- the transport door ---------------------------------------------------- */

// Accepts either spelling, with no mode selector anywhere above it. A `TP2:`
// input is decoded as compact and REFUSED as compact if malformed — it never
// falls through to the JSON parser, because a half-typed compact string is not
// a JSON document and pretending otherwise would report the wrong error and
// invite a parser-confusion bug. Anything else goes to the existing strict
// canonical parser, byte for byte as before.
export function decodeEnvelopeTransport2(text: string): Envelope2Decode {
  const trimmed = text.trim();
  if (trimmed.startsWith(COMPACT_PREFIX)) {
    return decodeCompactEnvelope2(trimmed);
  }
  return decodeEnvelope2(text);
}

export function isCompactEnvelope2(text: string): boolean {
  return text.trim().startsWith(COMPACT_PREFIX);
}
