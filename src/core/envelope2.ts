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
 * token. Property names and string values are literal on the wire — no
 * JSON escape sequences, no duplicate keys — enforced by a lexical scan
 * of the raw text, because JSON.parse decodes escapes and collapses
 * duplicates before any check on the parsed object can see them. Values
 * are lowercase hex only and integer counters only, with the declared
 * ciphertextLength cross-checked against the ciphertext hex. JSON
 * inter-token whitespace stays legal exactly as JSON defines it; the
 * grammar is strict about spellings, not byte-exact between tokens.
 * Every refusal here is structural (§14.1): typed, first-class, fired
 * before any secret is touched, and it burns nothing — this module never
 * sees a store.
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

// A top-level string token as spelled in the source: a property name or a
// string value, with whether its source spelling contains an escape.
type WireToken = { kind: "name" | "value"; spelling: string; escaped: boolean };
// A top-level number-valued member, name paired with the number's raw
// source spelling — so 7, 7.0, 7e0, and -0 are distinguishable even though
// JSON.parse folds them all to 7 / 0.
type NumberMember = { name: string; spelling: string };
type WireScan = { tokens: WireToken[]; numbers: NumberMember[] };

// Refusal messages quote the offending spelling, clipped: a hostile line
// can put megabytes behind one escape, and a refusal is not an echo chamber.
const clip = (spelling: string): string => (spelling.length > 48 ? `${spelling.slice(0, 48)}…` : spelling);

// Lexical scan of the top level of an envelope line. Precondition: `text`
// is valid JSON whose top-level value is a non-null, non-array object
// (JSON.parse already succeeded), so the walk never meets a truncated
// string or an unbalanced brace. It lexes strings properly — opening quote
// to unescaped closing quote, a backslash always consuming the character
// after it (the four hex digits of \uXXXX cannot be mistaken for the
// terminator) — and tracks brace depth, so braces, colons, and escaped
// quotes INSIDE values never miscount. One pass, linear: ciphertext hex
// can be long. Tokens below the top level (inside a nested value) are not
// collected; an envelope with a nested value has an extra key and the
// eight-key rule refuses it.
function scanTopLevelStrings(text: string): WireScan {
  const tokens: WireToken[] = [];
  const numbers: NumberMember[] = [];
  let depth = 0;
  let expectName = false;
  let pendingName = ""; // the most recent top-level name, for pairing values
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const start = i + 1;
      let j = start;
      let escaped = false;
      while (j < text.length) {
        const c = text[j];
        if (c === "\\") {
          escaped = true;
          j += 2;
          continue;
        }
        if (c === '"') break;
        j += 1;
      }
      if (depth === 1) {
        const spelling = text.slice(start, j);
        tokens.push({ kind: expectName ? "name" : "value", spelling, escaped });
        if (expectName) pendingName = spelling;
        expectName = false;
      }
      i = j + 1;
    } else if (ch === "{" || ch === "[") {
      depth += 1;
      if (depth === 1) expectName = true; // entering the top-level object
      i += 1;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) break; // top-level object closed; only trailing whitespace remains
      i += 1;
    } else if (depth === 1 && !expectName && (ch === "-" || (ch >= "0" && ch <= "9"))) {
      // A top-level number value: capture its exact source spelling so a
      // non-canonical spelling (7.0, 7e0, -0, 2.000) is distinguishable from
      // the canonical decimal integer, which JSON.parse would hide.
      let j = i + 1;
      while (j < text.length && "+-.eE0123456789".includes(text[j])) j += 1;
      numbers.push({ name: pendingName, spelling: text.slice(i, j) });
      i = j;
    } else {
      if (ch === "," && depth === 1) expectName = true;
      i += 1;
    }
  }
  return { tokens, numbers };
}

// Strict §6.2 parse. Check order is normative: (1) JSON, (2) the v1
// signature, (3) wire spellings — lexical: escape-free property names,
// then no duplicate keys, then escape-free string values, all on the raw
// text — (4) exactly eight keys, (5) per-field domains, (6) oversize on
// the DECLARED length, (7) declared length vs ciphertext hex length.
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

  // Wire spellings, checked lexically on the raw text. JSON.parse decodes
  // escape sequences and collapses duplicate keys (last one wins) before
  // any check on the parsed object can see them, so neither rule can be
  // enforced on `raw`. The canonical grammar has exactly one spelling per
  // key: a property name spelled with ANY escape sequence — of any key,
  // required or extra — is ambiguity, refused before further processing.
  // After that, surviving names are literal, so duplicate logical keys are
  // duplicate spellings and refuse next. String VALUES are held to the
  // same one-spelling rule (§6.3 promises exactly one accepted wire
  // spelling per domain value): an escaped value is refused even when it
  // decodes to an in-domain string.
  const { tokens, numbers } = scanTopLevelStrings(text);
  for (const token of tokens) {
    if (token.kind === "name" && token.escaped) {
      return refuseMalformed(
        `the property name "${clip(token.spelling)}" is spelled with JSON escape sequences; the v2 wire grammar has exactly one spelling per key`
      );
    }
  }
  const nameCounts = new Map<string, number>();
  for (const token of tokens) {
    if (token.kind === "name") {
      nameCounts.set(token.spelling, (nameCounts.get(token.spelling) ?? 0) + 1);
    }
  }
  for (const [name, count] of nameCounts) {
    if (count > 1) {
      return refuseMalformed(`the key ${clip(name)} appears ${count} times; a v2 envelope carries each of its keys exactly once`);
    }
  }
  for (const token of tokens) {
    if (token.kind === "value" && token.escaped) {
      return refuseMalformed(
        `the string value "${clip(token.spelling)}" is spelled with JSON escape sequences; each value has exactly one accepted wire spelling, and the decoded-equivalent form is refused`
      );
    }
  }
  // Number values obey the one-spelling rule too: the counters are canonical
  // decimal integers (no leading zero, no sign, no fraction, no exponent),
  // and formatVersion is literally 2. 7.0, 7e0, -0, and 2.000 all decode
  // in-domain but are non-canonical spellings, refused before the domain
  // checks below ever run.
  for (const { name, spelling } of numbers) {
    if (name === "formatVersion") {
      if (spelling !== "2") {
        return refuseMalformed(`formatVersion must be spelled exactly 2, not ${clip(spelling)}`);
      }
    } else if (name === "sequence" || name === "startOffset" || name === "ciphertextLength") {
      if (!/^(?:0|[1-9][0-9]*)$/.test(spelling)) {
        return refuseMalformed(
          `${name} must be a canonical decimal integer (no leading zero, sign, fraction, or exponent), not ${clip(spelling)}`
        );
      }
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
