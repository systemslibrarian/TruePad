/* ============================================================================
 * TruePad v2 wire envelope (FORMAT-V2.md §6.2, §9.1)
 * ----------------------------------------------------------------------------
 * Pure functions only. The v2 envelope is one line of JSON with exactly
 * eight fields, emitted in exactly this order:
 *
 *   {formatVersion, pairId, direction, sequence, startOffset,
 *    ciphertextLength, ciphertext, tag}
 *
 * Parsing is strict: exactly those eight keys, one accepted spelling per
 * value (lowercase hex only, integer counters only), and the declared
 * ciphertextLength cross-checked against the ciphertext hex. Every refusal
 * here is structural (§14.1): typed, first-class, fired before any secret
 * is touched, and it burns nothing — this module never sees a store.
 *
 * The v1-signature check runs FIRST, before the eight-key rule: a JSON
 * object with a `label` field and no `formatVersion` is the v1 wire shape
 * {label, startOffset, consumed, payload} (§9.1), refused `envelope-v1` —
 * never `malformed-envelope`. That precedence is normative (ledger claim
 * N4 depends on it). There is no compatibility parse and no --legacy flag;
 * the refusal message says so instead of hinting at a bridge.
 *
 * What this module is NOT: it does not verify the tag, check the pairId
 * against a store, or window the sequence — those are the OPEN pipeline's
 * later stages (§12.3 O0 is here; O1 onward is not). It validates wire
 * shape and wire domains, nothing more. `sequence`, `startOffset`, and
 * `ciphertextLength` are checked to be non-negative safe integers only;
 * their operative domains are narrower and checked by the caller.
 * ========================================================================= */

import { bytesToHex, hexToBytes } from "./hex.ts";
import { MAX_CIPHERTEXT_BYTES } from "./wc-one-time.ts";
import type { PadDirection } from "./pad.ts";

export type EnvelopeV2 = {
  pairId: string; // 32 lowercase hex characters (16 bytes)
  direction: PadDirection;
  sequence: number;
  startOffset: number;
  ciphertextLength: number;
  ciphertext: Uint8Array;
  tag: Uint8Array; // 16 bytes
};

export type Envelope2Refusal = {
  ok: false;
  reason: "envelope-v1" | "malformed-envelope" | "oversize-ciphertext";
  message: string;
};

export type Envelope2Decode = { ok: true; envelope: EnvelopeV2 } | Envelope2Refusal;

// The eight wire keys, in the §6.2 emission order. Parse does not care
// about key order (JSON objects are unordered); emission does.
const WIRE_KEYS = [
  "formatVersion",
  "pairId",
  "direction",
  "sequence",
  "startOffset",
  "ciphertextLength",
  "ciphertext",
  "tag"
] as const;

const PAIR_ID_RE = /^[0-9a-f]{32}$/;
const TAG_RE = /^[0-9a-f]{32}$/;
const CIPHERTEXT_RE = /^(?:[0-9a-f]{2})*$/;

function refuseMalformed(why: string): Envelope2Refusal {
  return {
    ok: false,
    reason: "malformed-envelope",
    message: `Malformed envelope: ${why}. Nothing was burned.`
  };
}

function refuseV1(): Envelope2Refusal {
  return {
    ok: false,
    reason: "envelope-v1",
    message:
      "This is a v1 envelope: it carries a label field and no formatVersion. " +
      "v2 tooling cannot open a v1 envelope — there is no --legacy flag and no compatibility " +
      "parse, by design. Open it with the v1 tooling that made it. Nothing was burned."
  };
}

function refuseOversize(declared: number): Envelope2Refusal {
  return {
    ok: false,
    reason: "oversize-ciphertext",
    message:
      `Oversize ciphertext: the envelope declares ${declared} ciphertext bytes but the v2 maximum ` +
      `is ${MAX_CIPHERTEXT_BYTES}. Larger payloads travel as multiple records, each with its own ` +
      "auth record. Nothing was burned."
  };
}

const isCounter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// Strict §6.2 parse. Check order is normative: (1) JSON, (2) the v1
// signature, (3) exactly eight keys, (4) per-field domains, (5) oversize on
// the DECLARED length, (6) declared length vs ciphertext hex length.
export function decodeEnvelope2(text: string): Envelope2Decode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuseMalformed("not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuseMalformed("not a JSON object");
  }
  const raw = parsed as Record<string, unknown>;

  // v1 signature FIRST — a v1 envelope also fails the eight-key rule below,
  // and it must land here, not there (§9.1).
  if ("label" in raw && !("formatVersion" in raw)) {
    return refuseV1();
  }

  // JSON.parse collapses duplicate keys (last one wins) before any check on
  // the parsed object can see them, so "exactly these eight keys" (§6.2) is
  // also enforced on the raw text. Sound because no legal v2 field value can
  // contain a quote character (hex, integers, "A->B"/"B->A").
  for (const key of WIRE_KEYS) {
    const occurrences = text.match(new RegExp(`"${key}"\\s*:`, "g"));
    if (occurrences !== null && occurrences.length > 1) {
      return refuseMalformed(
        `the key ${key} appears ${occurrences.length} times; a v2 envelope carries each of its eight fields exactly once`
      );
    }
  }

  const keys = Object.keys(raw);
  const missing = WIRE_KEYS.filter((key) => !(key in raw));
  const extra = keys.filter((key) => !(WIRE_KEYS as readonly string[]).includes(key));
  if (missing.length > 0 || extra.length > 0) {
    const parts = [
      missing.length > 0 ? `missing ${missing.join(", ")}` : "",
      extra.length > 0 ? `unexpected ${extra.join(", ")}` : ""
    ].filter((part) => part !== "");
    return refuseMalformed(`a v2 envelope has exactly eight fields (${WIRE_KEYS.join(", ")}); this one is ${parts.join(" and ")}`);
  }

  if (raw.formatVersion !== 2) {
    return refuseMalformed(`formatVersion must be the integer 2, not ${JSON.stringify(raw.formatVersion)}`);
  }
  if (typeof raw.pairId !== "string" || !PAIR_ID_RE.test(raw.pairId)) {
    return refuseMalformed("pairId must be exactly 32 lowercase hex characters");
  }
  if (raw.direction !== "A->B" && raw.direction !== "B->A") {
    return refuseMalformed(`direction must be exactly "A->B" or "B->A", not ${JSON.stringify(raw.direction)}`);
  }
  if (!isCounter(raw.sequence)) {
    return refuseMalformed(`sequence must be a non-negative safe integer, not ${JSON.stringify(raw.sequence)}`);
  }
  if (!isCounter(raw.startOffset)) {
    return refuseMalformed(`startOffset must be a non-negative safe integer, not ${JSON.stringify(raw.startOffset)}`);
  }
  if (!isCounter(raw.ciphertextLength)) {
    return refuseMalformed(
      `ciphertextLength must be a non-negative safe integer, not ${JSON.stringify(raw.ciphertextLength)}`
    );
  }
  if (typeof raw.tag !== "string" || !TAG_RE.test(raw.tag)) {
    return refuseMalformed("tag must be exactly 32 lowercase hex characters (a 128-bit tag; lowercase only)");
  }
  if (typeof raw.ciphertext !== "string" || !CIPHERTEXT_RE.test(raw.ciphertext)) {
    return refuseMalformed("ciphertext must be lowercase hex, two characters per byte (uppercase is refused)");
  }

  // Oversize fires on the declared length, before the ciphertext hex is
  // decoded — a truncated hex string does not demote this to malformed.
  if (raw.ciphertextLength > MAX_CIPHERTEXT_BYTES) {
    return refuseOversize(raw.ciphertextLength);
  }
  if (raw.ciphertext.length !== 2 * raw.ciphertextLength) {
    return refuseMalformed(
      `ciphertextLength says ${raw.ciphertextLength} bytes but the ciphertext hex holds ${raw.ciphertext.length / 2}`
    );
  }

  const ciphertext = hexToBytes(raw.ciphertext);
  const tag = hexToBytes(raw.tag);
  if (ciphertext === null || tag === null) {
    // Unreachable after the regexes above; kept so a codec change cannot
    // silently turn strict parse into a throw.
    return refuseMalformed("ciphertext or tag failed strict hex decoding");
  }
  return {
    ok: true,
    envelope: {
      pairId: raw.pairId,
      direction: raw.direction,
      sequence: raw.sequence,
      startOffset: raw.startOffset,
      ciphertextLength: raw.ciphertextLength,
      ciphertext,
      tag
    }
  };
}

// One line of JSON, the eight §6.2 fields in the §6.2 order, lowercase hex.
// Domain violations throw: an envelope this function cannot emit in a form
// decodeEnvelope2 would accept is a programmer error, not a wire condition
// (callers construct envelopes from validated store state).
export function encodeEnvelope2(envelope: EnvelopeV2): string {
  if (!PAIR_ID_RE.test(envelope.pairId)) {
    throw new Error("pairId must be exactly 32 lowercase hex characters");
  }
  if (!isCounter(envelope.sequence) || !isCounter(envelope.startOffset) || !isCounter(envelope.ciphertextLength)) {
    throw new Error("sequence, startOffset, and ciphertextLength must be non-negative safe integers");
  }
  if (envelope.ciphertextLength > MAX_CIPHERTEXT_BYTES) {
    throw new Error(`ciphertextLength ${envelope.ciphertextLength} exceeds MAX_CIPHERTEXT_BYTES ${MAX_CIPHERTEXT_BYTES}`);
  }
  if (envelope.ciphertext.length !== envelope.ciphertextLength) {
    throw new Error(
      `ciphertextLength says ${envelope.ciphertextLength} bytes but the ciphertext holds ${envelope.ciphertext.length}`
    );
  }
  if (envelope.tag.length !== 16) {
    throw new Error(`tag must be exactly 16 bytes, not ${envelope.tag.length}`);
  }
  return JSON.stringify({
    formatVersion: 2,
    pairId: envelope.pairId,
    direction: envelope.direction,
    sequence: envelope.sequence,
    startOffset: envelope.startOffset,
    ciphertextLength: envelope.ciphertextLength,
    ciphertext: bytesToHex(envelope.ciphertext),
    tag: bytesToHex(envelope.tag)
  });
}
