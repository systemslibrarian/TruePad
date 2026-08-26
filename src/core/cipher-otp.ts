/* ============================================================================
 * TruePad cipher core
 * ----------------------------------------------------------------------------
 * Pure functions only. No DOM, no localStorage, no CSS imports.
 *
 * Cipher protocol, letter mode (A-Z):
 *
 *   plaintext  -> uppercase A-Z only          (normalizeAZ)
 *              -> numbers 0..25               (lettersToNumbers)
 *              -> add pad symbol mod 26       (encryptLetters)
 *              -> ciphertext letters A-Z
 *
 *   Decrypt subtracts the same pad symbols mod 26.
 *
 * Cipher protocol, byte mode (the honest version):
 *
 *   cipher[i] = plain[i] XOR pad[i]   — XOR is its own inverse.
 *
 * What crosses the public channel is an Envelope:
 *
 *   { label, startOffset, consumed, payload }
 *
 * The pad never does. encrypt* burns from the sender's pointer and emits
 * the envelope; decrypt* takes the envelope and SEEKS the receiver's pad to
 * startOffset by burning forward — every offset between the pointer and
 * startOffset is destroyed, not left recoverable — then burns the window.
 *
 * Every refusal is a first-class result (ok: false), never an exception,
 * and every refusal happens before a single symbol is burned:
 *
 *   mode-mismatch     the pad is the wrong alphabet for this operation
 *   label-mismatch    the envelope names a different pad page
 *   envelope-invalid  offsets are not non-negative integers, or `consumed`
 *                     disagrees with the payload length
 *   reuse-refused     startOffset is at or below the pad's high-water mark:
 *                     THE reuse guard. A replay, a late out-of-order
 *                     arrival, and an overlapping window all land here.
 *   pad-exhausted     the window (skip + message) runs past the pad
 *
 * There is no wraparound, no truncation, no borrowing — ever.
 *
 * The envelope is NOT authenticated, and that cuts two ways:
 *   - a modified payload decrypts to modified plaintext with no alarm
 *     (perfect secrecy is not integrity — see the tamper module);
 *   - a modified startOffset drives the seek. Anyone who can rewrite an
 *     envelope on the channel can make the receiver burn forward through as
 *     much of its remaining pad as they like — an empty payload with
 *     startOffset == size wipes it — and the result is ok: true. That is the
 *     price of burn-forward without a MAC: pad can be DESTROYED from the
 *     channel, never reused. Authenticating the envelope (Wegman–Carter,
 *     which costs additional pad) is the extension seam, not part of this
 *     module.
 * ========================================================================= */

import { Pad, type PadMode } from "./pad";

// Strip everything that is not an A-Z letter and uppercase the rest.
export function normalizeAZ(text: string): string {
  return text.toUpperCase().replace(/[^A-Z]/g, "");
}

// 'A' (char code 65) -> 0, ..., 'Z' (char code 90) -> 25.
export function lettersToNumbers(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0) - 65);
}

// 0 -> 'A', ..., 25 -> 'Z'. Inverse of lettersToNumbers.
export function numbersToLetters(values: number[]): string {
  return values.map((value) => String.fromCharCode(value + 65)).join("");
}

// Cosmetic grouping: "HELLOWORLD" -> "HELLO WORLD".
export function groupedFive(text: string): string {
  return text.match(/.{1,5}/g)?.join(" ") ?? "";
}

/* ---- the wire envelope --------------------------------------------------- */

// Everything the public channel carries. No field is a pad symbol.
export type Envelope<P extends string | Uint8Array = string | Uint8Array> = {
  label: string;
  startOffset: number;
  consumed: number;
  payload: P;
};

export type OtpRefusalReason =
  | "pad-exhausted"
  | "mode-mismatch"
  | "label-mismatch"
  | "envelope-invalid"
  | "reuse-refused";

export type OtpRefusal = {
  ok: false;
  reason: OtpRefusalReason;
  required: number;
  remaining: number;
  message: string;
};

export type EncryptTextResult = { ok: true; envelope: Envelope<string> } | OtpRefusal;
export type EncryptBytesResult = { ok: true; envelope: Envelope<Uint8Array> } | OtpRefusal;

// `skipped` is how many offsets the seek destroyed on the way to startOffset.
export type DecryptTextResult =
  | { ok: true; text: string; startOffset: number; consumed: number; skipped: number }
  | OtpRefusal;
export type DecryptBytesResult =
  | { ok: true; bytes: Uint8Array; startOffset: number; consumed: number; skipped: number }
  | OtpRefusal;

/* ---- refusals ------------------------------------------------------------ */

function refusePadExhausted(required: number, remaining: number): OtpRefusal {
  return {
    ok: false,
    reason: "pad-exhausted",
    required,
    remaining,
    message:
      `Pad exhausted. This message needs ${required} symbols but only ${remaining} remain. ` +
      "A one-time pad cannot borrow, wrap, or reuse — generate more randomness, " +
      "and physically deliver it, before you can send this."
  };
}

// Decrypt-side exhaustion counts the seek: say so, instead of calling the
// skip part of "the message".
function refuseSeekExhausted(skipped: number, consumed: number, remaining: number): OtpRefusal {
  const required = skipped + consumed;
  return {
    ok: false,
    reason: "pad-exhausted",
    required,
    remaining,
    message:
      `Pad exhausted. Opening this envelope needs ${required} symbols (${skipped} skipped to reach its offset + ` +
      `${consumed} for the message) but only ${remaining} remain in this copy. A one-time pad cannot borrow, ` +
      "wrap, or reuse. Nothing was burned."
  };
}

function refuseModeMismatch(expected: PadMode, pad: Pad, required: number): OtpRefusal {
  return {
    ok: false,
    reason: "mode-mismatch",
    required,
    remaining: pad.remaining,
    message: `This operation needs a ${expected}-mode pad, but ${pad.label} is a ${pad.mode}-mode pad.`
  };
}

function refuseLabelMismatch(envelope: Envelope, pad: Pad): OtpRefusal {
  return {
    ok: false,
    reason: "label-mismatch",
    required: envelope.consumed,
    remaining: pad.remaining,
    message: `This envelope is addressed to pad page ${envelope.label}, but this pad is ${pad.label}. Nothing was burned.`
  };
}

function refuseEnvelopeInvalid(envelope: Envelope, pad: Pad, why: string): OtpRefusal {
  return {
    ok: false,
    reason: "envelope-invalid",
    required: Number.isInteger(envelope.consumed) ? envelope.consumed : 0,
    remaining: pad.remaining,
    message: `Malformed envelope: ${why}. Nothing was burned.`
  };
}

function refuseReuse(envelope: Envelope, pad: Pad): OtpRefusal {
  return {
    ok: false,
    reason: "reuse-refused",
    required: envelope.consumed,
    remaining: pad.remaining,
    message:
      `Reuse refused. This envelope starts at offset ${envelope.startOffset}, but this copy of ${pad.label} ` +
      `has already burned every offset up to its high-water mark ${pad.highWaterMark}. A replayed, ` +
      "late, or overlapping envelope cannot be opened with this copy — those symbols are gone from it. " +
      "Nothing was burned."
  };
}

// Every check that must pass before decrypt* touches the pad, in the order
// they fire. Returns the refusal, or null when the window is safe to burn.
function preflightDecrypt(envelope: Envelope, pad: Pad, mode: PadMode, payloadLength: number): OtpRefusal | null {
  if (pad.mode !== mode) {
    return refuseModeMismatch(mode, pad, payloadLength);
  }
  if (envelope.label !== pad.label) {
    return refuseLabelMismatch(envelope, pad);
  }
  if (!Number.isInteger(envelope.startOffset) || envelope.startOffset < 0) {
    return refuseEnvelopeInvalid(envelope, pad, `startOffset ${envelope.startOffset} is not a non-negative integer`);
  }
  if (!Number.isInteger(envelope.consumed) || envelope.consumed < 0) {
    return refuseEnvelopeInvalid(envelope, pad, `consumed ${envelope.consumed} is not a non-negative integer`);
  }
  if (envelope.consumed !== payloadLength) {
    return refuseEnvelopeInvalid(
      envelope,
      pad,
      `consumed says ${envelope.consumed} symbols but the payload holds ${payloadLength}`
    );
  }
  // The reuse guard. Checked before exhaustion on purpose: an envelope that
  // is both a replay and too long is reported as the graver of the two.
  if (envelope.startOffset <= pad.highWaterMark) {
    return refuseReuse(envelope, pad);
  }
  // The seek burns skip + message symbols; all of them must exist.
  const skipped = envelope.startOffset - pad.nextOffset;
  if (skipped + envelope.consumed > pad.remaining) {
    return refuseSeekExhausted(skipped, envelope.consumed, pad.remaining);
  }
  return null;
}

/* ---- letter mode --------------------------------------------------------- */

// Letter mode encrypt: cipher[i] = ( plain[i] + pad[i] ) mod 26.
// Consumes (burns) exactly normalized.length symbols — or none at all.
export function encryptLetters(plaintext: string, pad: Pad): EncryptTextResult {
  const normalized = normalizeAZ(plaintext);
  if (pad.mode !== "letters") {
    return refuseModeMismatch("letters", pad, normalized.length);
  }
  if (normalized.length > pad.remaining) {
    return refusePadExhausted(normalized.length, pad.remaining);
  }
  const startOffset = pad.nextOffset;
  const symbols = pad.consume(normalized.length);
  const plainNums = lettersToNumbers(normalized);
  const cipherNums = plainNums.map((value, index) => (value + symbols[index].value) % 26);
  return {
    ok: true,
    envelope: {
      label: pad.label,
      startOffset,
      consumed: symbols.length,
      payload: numbersToLetters(cipherNums)
    }
  };
}

// Letter mode decrypt: plain[i] = ( cipher[i] - pad[i] + 26 ) mod 26.
// Seeks the receiver's pad to envelope.startOffset (destroying anything
// skipped), then burns the envelope's window from the receiver's own copy.
export function decryptLetters(envelope: Envelope<string>, pad: Pad): DecryptTextResult {
  const normalized = normalizeAZ(envelope.payload);
  const refusal = preflightDecrypt(envelope, pad, "letters", normalized.length);
  if (refusal) {
    return refusal;
  }
  const skipped = envelope.startOffset - pad.nextOffset;
  const symbols = pad.consumeAt(envelope.startOffset, normalized.length);
  const cipherNums = lettersToNumbers(normalized);
  const plainNums = cipherNums.map((value, index) => (value - symbols[index].value + 26) % 26);
  return {
    ok: true,
    text: numbersToLetters(plainNums),
    startOffset: envelope.startOffset,
    consumed: symbols.length,
    skipped
  };
}

/* ---- byte mode ----------------------------------------------------------- */

// Byte mode: XOR with one fresh pad byte per plaintext byte.
export function encryptBytes(plain: Uint8Array, pad: Pad): EncryptBytesResult {
  if (pad.mode !== "bytes") {
    return refuseModeMismatch("bytes", pad, plain.length);
  }
  if (plain.length > pad.remaining) {
    return refusePadExhausted(plain.length, pad.remaining);
  }
  const startOffset = pad.nextOffset;
  const symbols = pad.consume(plain.length);
  const cipher = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i += 1) {
    cipher[i] = plain[i] ^ symbols[i].value;
  }
  return { ok: true, envelope: { label: pad.label, startOffset, consumed: symbols.length, payload: cipher } };
}

// XOR is an involution, but decrypt is NOT the same call as encrypt any
// more: encrypt burns from the sender's pointer, decrypt seeks to the
// envelope's offset. Kept separate so call sites read honestly.
export function decryptBytes(envelope: Envelope<Uint8Array>, pad: Pad): DecryptBytesResult {
  const refusal = preflightDecrypt(envelope, pad, "bytes", envelope.payload.length);
  if (refusal) {
    return refusal;
  }
  const skipped = envelope.startOffset - pad.nextOffset;
  const symbols = pad.consumeAt(envelope.startOffset, envelope.payload.length);
  const plain = new Uint8Array(envelope.payload.length);
  for (let i = 0; i < plain.length; i += 1) {
    plain[i] = envelope.payload[i] ^ symbols[i].value;
  }
  return { ok: true, bytes: plain, startOffset: envelope.startOffset, consumed: symbols.length, skipped };
}

/* ---- wire encoding ------------------------------------------------------- */

// Text form of an envelope for the public channel: JSON with the four wire
// fields. Byte payloads travel as uppercase hex. Every caller that puts an
// envelope on a channel goes through here so they all agree on the form.
export function encodeEnvelope(envelope: Envelope): string {
  const payload =
    typeof envelope.payload === "string"
      ? envelope.payload
      : [...envelope.payload].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join("");
  return JSON.stringify({
    label: envelope.label,
    startOffset: envelope.startOffset,
    consumed: envelope.consumed,
    payload
  });
}

export function decodeEnvelope(text: string, mode: "letters"): Envelope<string> | null;
export function decodeEnvelope(text: string, mode: "bytes"): Envelope<Uint8Array> | null;
export function decodeEnvelope(text: string, mode: PadMode): Envelope | null;
export function decodeEnvelope(text: string, mode: PadMode): Envelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const raw = parsed as Record<string, unknown>;
  const { label, startOffset, consumed, payload } = raw;
  if (
    typeof label !== "string" ||
    typeof startOffset !== "number" ||
    !Number.isInteger(startOffset) ||
    startOffset < 0 ||
    typeof consumed !== "number" ||
    !Number.isInteger(consumed) ||
    consumed < 0 ||
    typeof payload !== "string"
  ) {
    return null;
  }
  if (mode === "letters") {
    if (!/^[A-Z]*$/.test(payload) || payload.length !== consumed) {
      return null;
    }
    return { label, startOffset, consumed, payload };
  }
  if (!/^(?:[0-9A-Fa-f]{2})*$/.test(payload) || payload.length / 2 !== consumed) {
    return null;
  }
  const bytes = new Uint8Array(consumed);
  for (let i = 0; i < consumed; i += 1) {
    bytes[i] = parseInt(payload.slice(i * 2, i * 2 + 2), 16);
  }
  return { label, startOffset, consumed, payload: bytes };
}
