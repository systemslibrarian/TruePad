import { describe, expect, it } from "vitest";
import { decodeEnvelope2, encodeEnvelope2, type EnvelopeV2 } from "../src/core/envelope2";
import {
  COMPACT_PREFIX,
  decodeCompactEnvelope2,
  decodeEnvelopeTransport2,
  encodeCompactEnvelope2,
  fromBase64Url,
  toBase64Url
} from "../src/core/compact-envelope2";
import { canonicalBytes, MAX_CIPHERTEXT_BYTES } from "../src/core/wc-one-time";
import { bytesToHex, hexToBytes } from "../src/core/hex";

/* ============================================================================
 * TP2 Compact Transport v1 — a PRESENTATION codec, and nothing more
 * ----------------------------------------------------------------------------
 * What a person copies should be `TP2:AbCd…`, not 200 characters of JSON. That
 * is a packaging problem. These specs pin that the packaging changed and the
 * SECURITY SEMANTICS did not:
 *
 *   · §6.2 canonical JSON is still emitted, still parsed, still canonical;
 *   · a compact message decodes to a byte-for-byte identical EnvelopeV2;
 *   · the canonical AUTHENTICATION bytes — which the Wegman-Carter tag is
 *     computed over — are identical whichever spelling arrived, because the tag
 *     is computed over the semantic fields and over NEITHER text;
 *   · a compact message can represent only what the canonical implementation
 *     would itself emit and accept.
 *
 * The transport carries no checksum on purpose. The tag already authenticates
 * the envelope, and a second integrity field would invite the belief that the
 * transport is a security boundary. It is not.
 * ========================================================================= */

// The fixture from real use, frozen. Every byte of it is load-bearing.
const FIXTURE =
  '{"formatVersion":2,"pairId":"ed5825e73edd8beb9962abfed3826985","direction":"A->B","sequence":1,' +
  '"startOffset":4,"ciphertextLength":5,"ciphertext":"1ab8b8a130","tag":"a4354c856b5c7fba93b3d49f95c55f86"}';

// The frozen compact vector for that envelope. If this string ever changes, the
// transport changed, and every previously-copied message stops being readable.
const FIXTURE_COMPACT = "TP2:AQLtWCXnPt2L65liq_7TgmmFAAEEBRq4uKEwpDVMhWtcf7qTs9SflcVfhg";

function envelopeOf(json: string): EnvelopeV2 {
  const decoded = decodeEnvelope2(json);
  if (!decoded.ok) throw new Error(`fixture does not decode: ${decoded.message}`);
  return decoded.envelope;
}

// The bytes the TAG is computed over (wc-one-time canonicalBytes). Not the
// JSON, not the compact payload — the semantic fields.
function authBytes(envelope: EnvelopeV2): string {
  const pairId = hexToBytes(envelope.pairId);
  if (pairId === null) throw new Error("bad pairId");
  return bytesToHex(
    canonicalBytes({
      pairId,
      direction: envelope.direction,
      sequence: envelope.sequence,
      startOffset: envelope.startOffset,
      ciphertext: envelope.ciphertext
    })
  );
}

const sample = (over: Partial<EnvelopeV2> = {}): EnvelopeV2 => ({ ...envelopeOf(FIXTURE), ...over });

// The payload of a compact string, decoded to raw bytes for surgery.
function compactBytes(text: string): Uint8Array {
  const bytes = fromBase64Url(text.slice(COMPACT_PREFIX.length));
  if (bytes === null) throw new Error("fixture is not base64url");
  return bytes;
}
const recompact = (bytes: Uint8Array): string => COMPACT_PREFIX + toBase64Url(bytes);

/* ==========================================================================
 * 1. The frozen vector, and bijectivity.
 * ======================================================================== */

describe("the frozen transport vector", () => {
  it("JSON -> compact -> JSON is byte-for-byte the original fixture", () => {
    const envelope = envelopeOf(FIXTURE);
    const compact = encodeCompactEnvelope2(envelope);
    expect(compact).toBe(FIXTURE_COMPACT);

    const back = decodeCompactEnvelope2(compact);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(encodeEnvelope2(back.envelope)).toBe(FIXTURE);
  });

  it("the compact form is dramatically shorter, and shorter at every size", () => {
    expect(FIXTURE.length).toBe(199);
    expect(FIXTURE_COMPACT.length).toBe(62);
    // JSON spends two hex characters per ciphertext byte; base64url spends 4/3.
    // No compression is involved, wanted, or claimed.
    for (const n of [1, 5, 1024, 65536]) {
      const envelope = sample({ ciphertextLength: n, ciphertext: new Uint8Array(n).fill(0xab) });
      expect(encodeCompactEnvelope2(envelope).length).toBeLessThan(encodeEnvelope2(envelope).length);
    }
  });

  it("is bijective over a wide field sweep, including the varint boundaries", () => {
    const lengths = [0, 1, 5, 127, 128, 129, 255, 256, 1024];
    const counters = [0, 1, 127, 128, 16383, 16384, 2 ** 32, Number.MAX_SAFE_INTEGER];
    for (const direction of ["A->B", "B->A"] as const) {
      for (const n of lengths) {
        for (const counter of counters) {
          const envelope = sample({
            direction,
            sequence: counter,
            startOffset: counter,
            ciphertextLength: n,
            ciphertext: new Uint8Array(n).fill(n & 0xff)
          });
          const json = encodeEnvelope2(envelope);
          const back = decodeCompactEnvelope2(encodeCompactEnvelope2(envelope));
          expect(back.ok, `${direction}/${n}/${counter}`).toBe(true);
          if (!back.ok) continue;
          expect(encodeEnvelope2(back.envelope)).toBe(json);
        }
      }
    }
  });
});

/* ==========================================================================
 * 2. FROZEN AUTHENTICATION SEMANTICS — the load-bearing part.
 * ======================================================================== */

describe("authentication semantics are untouched", () => {
  it("canonical auth bytes are identical whichever spelling arrived", () => {
    const fromJson = envelopeOf(FIXTURE);
    const fromCompact = decodeCompactEnvelope2(FIXTURE_COMPACT);
    expect(fromCompact.ok).toBe(true);
    if (!fromCompact.ok) return;

    // The envelopes are semantically identical...
    expect(fromCompact.envelope.pairId).toBe(fromJson.pairId);
    expect(fromCompact.envelope.direction).toBe(fromJson.direction);
    expect(fromCompact.envelope.sequence).toBe(fromJson.sequence);
    expect(fromCompact.envelope.startOffset).toBe(fromJson.startOffset);
    expect(fromCompact.envelope.ciphertextLength).toBe(fromJson.ciphertextLength);
    expect([...fromCompact.envelope.ciphertext]).toEqual([...fromJson.ciphertext]);
    expect([...fromCompact.envelope.tag]).toEqual([...fromJson.tag]);

    // ...and therefore the bytes the TAG is computed over are byte-identical.
    expect(authBytes(fromCompact.envelope)).toBe(authBytes(fromJson));
  });

  it("the compact bytes are NOT the authentication bytes", () => {
    // Stated as a test so nobody can quietly start authenticating the
    // transport: the auth input contains neither spelling's text.
    const envelope = envelopeOf(FIXTURE);
    const auth = authBytes(envelope);
    const compactPayloadHex = bytesToHex(compactBytes(FIXTURE_COMPACT));
    expect(auth).not.toBe(compactPayloadHex);
    expect(auth).not.toContain(compactPayloadHex);
    // The auth bytes are a fixed-shape block over the semantic fields.
    expect(auth.length / 2).toBe(80);
  });

  it("auth bytes stay identical across the whole sweep", () => {
    for (const n of [0, 1, 16, 17, 1024]) {
      for (const direction of ["A->B", "B->A"] as const) {
        const envelope = sample({ direction, ciphertextLength: n, ciphertext: new Uint8Array(n).fill(7) });
        const back = decodeCompactEnvelope2(encodeCompactEnvelope2(envelope));
        expect(back.ok).toBe(true);
        if (!back.ok) continue;
        expect(authBytes(back.envelope)).toBe(authBytes(envelope));
      }
    }
  });
});

/* ==========================================================================
 * 3. Malformed compact input — every one refused, before any secret.
 * ======================================================================== */

describe("malformed compact envelopes are refused", () => {
  const bad = (text: string, why: string) => {
    const result = decodeCompactEnvelope2(text);
    expect(result.ok, `${why} must be refused`).toBe(false);
    return result;
  };

  it("(1-5) prefix and base64url spelling", () => {
    // Wrong prefix: not compact at all.
    bad("TP1:AQL", "wrong prefix");
    bad("tp2:AQL", "lowercase prefix");
    bad("AQLtWCXn", "no prefix");
    // Empty payload.
    bad("TP2:", "empty payload");
    // Alphabet: ordinary base64 characters are not base64url.
    bad("TP2:AQL+/wAA", "'+' and '/' are not base64url");
    bad("TP2:AQL$xyz", "invalid character");
    // Padding is not part of the spelling.
    const padded = bad("TP2:AQLtWCXnPt2L65liq_7TgmmFAAEEBRq4uKEwpDVMhWtcf7qTs9SflcVfhg=", "'=' padding");
    expect(padded.ok === false && padded.message).toMatch(/padding/);
    // Non-canonical spelling: trailing bits that re-encode differently.
    const bytes = compactBytes(FIXTURE_COMPACT);
    const canonical = toBase64Url(bytes);
    const lastIdx = canonical.length - 1;
    const alt = canonical.slice(0, lastIdx) + (canonical[lastIdx] === "g" ? "h" : "g");
    if (alt !== canonical) {
      const result = decodeCompactEnvelope2(COMPACT_PREFIX + alt);
      // Either the re-encode check or a later structural check refuses it; what
      // must never happen is silent acceptance of a second spelling.
      expect(result.ok).toBe(false);
    }
  });

  it("(6-9) header bytes", () => {
    const base = compactBytes(FIXTURE_COMPACT);
    const wrongTransport = base.slice();
    wrongTransport[0] = 0x02;
    expect(bad(recompact(wrongTransport), "transport version 2").ok).toBe(false);

    const wrongFormat = base.slice();
    wrongFormat[1] = 0x03;
    expect(bad(recompact(wrongFormat), "formatVersion 3").ok).toBe(false);

    // Envelope v1 keeps its own refusal reason rather than becoming generic.
    const v1 = base.slice();
    v1[1] = 0x01;
    const v1Result = decodeCompactEnvelope2(recompact(v1));
    expect(v1Result.ok).toBe(false);
    if (!v1Result.ok) expect(v1Result.reason).toBe("envelope-v1");

    const badDirection = base.slice();
    badDirection[18] = 0x02;
    const dir = bad(recompact(badDirection), "direction 0x02");
    if (!dir.ok) expect(dir.message).toMatch(/direction byte/);

    // Truncated inside the pairId.
    expect(bad(recompact(base.slice(0, 10)), "truncated pairId").ok).toBe(false);
  });

  it("(10-13) varints", () => {
    const base = compactBytes(FIXTURE_COMPACT);
    // Truncated: a continuation bit with nothing after it.
    const truncated = new Uint8Array([...base.slice(0, 19), 0x80]);
    expect(bad(recompact(truncated), "truncated varint").ok).toBe(false);

    // Overlong: 0 spelled as 80 00 rather than 00.
    const overlong = new Uint8Array([...base.slice(0, 19), 0x80, 0x00, ...base.slice(20)]);
    const over = bad(recompact(overlong), "overlong varint");
    if (!over.ok) expect(over.message).toMatch(/minimally encoded/);

    // Past the safe-integer range: ten 0xff groups.
    const huge = new Uint8Array([...base.slice(0, 19), 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
    const big = bad(recompact(huge), "varint beyond safe integers");
    if (!big.ok) expect(big.message).toMatch(/safe-integer|64 bits/);

    // ciphertextLength beyond MAX_CIPHERTEXT_BYTES gets the typed reason.
    const head = [0x01, 0x02, ...base.subarray(2, 19), 0x00, 0x00];
    const lengthBytes: number[] = [];
    let v = MAX_CIPHERTEXT_BYTES + 1;
    do {
      const byte = v & 0x7f;
      v = Math.floor(v / 128);
      lengthBytes.push(v > 0 ? byte | 0x80 : byte);
    } while (v > 0);
    const oversize = decodeCompactEnvelope2(recompact(new Uint8Array([...head, ...lengthBytes, ...new Array(16).fill(0)])));
    expect(oversize.ok).toBe(false);
    if (!oversize.ok) expect(oversize.reason).toBe("oversize-ciphertext");
  });

  it("(14-18) ciphertext length agreement and the tag", () => {
    const envelope = sample({ ciphertextLength: 5, ciphertext: new Uint8Array([1, 2, 3, 4, 5]) });
    const base = compactBytes(encodeCompactEnvelope2(envelope));

    // Declared 5, one byte short of 5 + tag.
    expect(bad(recompact(base.slice(0, base.length - 1)), "ciphertext/tag short").ok).toBe(false);
    // One byte too many after the tag.
    const extra = new Uint8Array([...base, 0x00]);
    const trailing = bad(recompact(extra), "trailing byte");
    if (!trailing.ok) expect(trailing.message).toMatch(/trailing byte/);
    // Missing the tag entirely.
    expect(bad(recompact(base.slice(0, base.length - 16)), "missing tag").ok).toBe(false);
    // A 15-byte tag: the remaining-bytes check catches it.
    expect(bad(recompact(base.slice(0, base.length - 1)), "15-byte tag").ok).toBe(false);
  });

  it("(19-21) hostile size and whitespace", () => {
    // A megabyte of alphabet is bounded and refused, not chewed on.
    const hostile = COMPACT_PREFIX + "A".repeat(4_000_000);
    const result = decodeCompactEnvelope2(hostile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/characters/);

    // Whitespace INSIDE the payload is not a spelling of anything.
    const withSpace = FIXTURE_COMPACT.slice(0, 20) + " " + FIXTURE_COMPACT.slice(20);
    expect(decodeCompactEnvelope2(withSpace).ok).toBe(false);
    expect(decodeCompactEnvelope2(FIXTURE_COMPACT.replace("TP2:", "TP2: ")).ok).toBe(false);

    // Surrounding paste whitespace IS forgiven — it is what a paste looks like.
    expect(decodeCompactEnvelope2(`  \n${FIXTURE_COMPACT}\t\n `).ok).toBe(true);
  });
});

/* ==========================================================================
 * 4. Tamper: structural refusal, or the existing authenticated refusal.
 * ======================================================================== */

describe("tampering with a compact message", () => {
  it("every field mutation is caught structurally or reaches the open path with a changed semantic", () => {
    const original = envelopeOf(FIXTURE);
    const base = compactBytes(FIXTURE_COMPACT);

    const mutations: [string, (b: Uint8Array) => void][] = [
      ["pairId byte", (b) => { b[5] ^= 0xff; }],
      ["direction", (b) => { b[18] = b[18] === 0 ? 1 : 0; }],
      ["sequence", (b) => { b[19] = 9; }],
      ["startOffset", (b) => { b[20] = 9; }],
      ["ciphertext", (b) => { b[b.length - 17] ^= 0xff; }],
      ["tag", (b) => { b[b.length - 1] ^= 0xff; }]
    ];
    for (const [name, mutate] of mutations) {
      const bytes = base.slice();
      mutate(bytes);
      const result = decodeCompactEnvelope2(recompact(bytes));
      if (!result.ok) continue; // structural refusal is a fine outcome
      // Otherwise it must be a DIFFERENT envelope than the original — the old
      // tag now covers different semantics, and the open path rejects it. What
      // must never happen is a mutation decoding back to the original.
      const changed =
        result.envelope.pairId !== original.pairId ||
        result.envelope.direction !== original.direction ||
        result.envelope.sequence !== original.sequence ||
        result.envelope.startOffset !== original.startOffset ||
        bytesToHex(result.envelope.ciphertext) !== bytesToHex(original.ciphertext) ||
        bytesToHex(result.envelope.tag) !== bytesToHex(original.tag);
      expect(changed, `${name} must not decode back to the original envelope`).toBe(true);
      // A changed field means changed AUTH bytes (except a tag-only edit, which
      // the tag comparison itself catches).
      if (name !== "tag") {
        expect(authBytes(result.envelope), `${name} must change the auth bytes`).not.toBe(authBytes(original));
      } else {
        expect(authBytes(result.envelope)).toBe(authBytes(original));
        expect(bytesToHex(result.envelope.tag)).not.toBe(bytesToHex(original.tag));
      }
    }
  });

  it("ciphertextLength is CARRIED and checked, never inferred", () => {
    // Claim one byte fewer than are actually present: a parser that inferred
    // the length from what remained would accept this happily.
    const envelope = sample({ ciphertextLength: 5, ciphertext: new Uint8Array([1, 2, 3, 4, 5]) });
    const base = compactBytes(encodeCompactEnvelope2(envelope));
    const lied = base.slice();
    lied[21] = 4; // ciphertextLength varint: 5 -> 4
    const result = decodeCompactEnvelope2(recompact(lied));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/trailing byte|declares/);
  });
});

/* ==========================================================================
 * 5. The transport door: both spellings, no mode selector, no fallback.
 * ======================================================================== */

describe("decodeEnvelopeTransport2", () => {
  it("accepts canonical JSON exactly as before", () => {
    const viaTransport = decodeEnvelopeTransport2(FIXTURE);
    const viaJson = decodeEnvelope2(FIXTURE);
    expect(viaTransport.ok).toBe(true);
    expect(viaJson.ok).toBe(true);
    if (viaTransport.ok && viaJson.ok) {
      expect(encodeEnvelope2(viaTransport.envelope)).toBe(encodeEnvelope2(viaJson.envelope));
    }
  });

  it("accepts compact", () => {
    const result = decodeEnvelopeTransport2(FIXTURE_COMPACT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(encodeEnvelope2(result.envelope)).toBe(FIXTURE);
  });

  it("a malformed TP2 input FAILS AS COMPACT and never falls back to JSON", () => {
    // A half-typed compact string is not a JSON document, and pretending it
    // might be would report the wrong error and invite parser confusion.
    const result = decodeEnvelopeTransport2("TP2:!!!!");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/base64url/);
      expect(result.message).not.toMatch(/JSON/);
    }
    // Even a TP2 string whose payload happens to be JSON-ish stays compact.
    const jsonish = decodeEnvelopeTransport2(`TP2:${FIXTURE}`);
    expect(jsonish.ok).toBe(false);
  });

  it("JSON refusal reasons and precedence are unchanged", () => {
    for (const input of ["", "{}", "not json", '{"formatVersion":1}', '{"formatVersion":2}']) {
      const viaTransport = decodeEnvelopeTransport2(input);
      const viaJson = decodeEnvelope2(input);
      expect(viaTransport.ok).toBe(viaJson.ok);
      if (!viaTransport.ok && !viaJson.ok) {
        expect(viaTransport.reason).toBe(viaJson.reason);
        expect(viaTransport.message).toBe(viaJson.message);
      }
    }
  });
});

/* ==========================================================================
 * 6. base64url primitives.
 * ======================================================================== */

describe("canonical base64url", () => {
  it("round-trips every byte value and every length modulo", () => {
    for (let n = 0; n <= 24; n += 1) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) bytes[i] = (i * 37 + 11) & 0xff;
      const text = toBase64Url(bytes);
      expect(text).not.toMatch(/[=+/]/);
      const back = fromBase64Url(text);
      expect(back).not.toBeNull();
      if (back !== null) expect([...back]).toEqual([...bytes]);
    }
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) all[i] = i;
    const back = fromBase64Url(toBase64Url(all));
    expect(back && [...back]).toEqual([...all]);
  });

  it("refuses padding, foreign alphabets, and impossible lengths", () => {
    expect(fromBase64Url("AQL=")).toBeNull();
    expect(fromBase64Url("AQL+")).toBeNull();
    expect(fromBase64Url("AQL/")).toBeNull();
    expect(fromBase64Url("A")).toBeNull(); // length % 4 === 1 is impossible
    expect(fromBase64Url("AAAAA")).toBeNull();
    expect(fromBase64Url(" AQL")).toBeNull();
  });
});

/* ==========================================================================
 * 7. Interoperability: one EnvelopeV2, whichever spelling and whichever edition.
 * ======================================================================== */

describe("interoperability matrix", () => {
  it("every spelling decodes to the identical EnvelopeV2", () => {
    // Browser and CLI share src/core byte-for-byte, so the matrix reduces to:
    // the two spellings must be interchangeable at the transport door that
    // BOTH editions call. The end-to-end CLI legs live in the CLI suite and
    // the browser legs in the browser suites; this pins the shared core.
    const envelope = envelopeOf(FIXTURE);
    const json = encodeEnvelope2(envelope);
    const compact = encodeCompactEnvelope2(envelope);

    const spellings = [json, compact, `  ${compact}  `, `\n${json}\n`];
    const canonical = spellings.map((text) => {
      const decoded = decodeEnvelopeTransport2(text);
      expect(decoded.ok, `${text.slice(0, 24)} must decode`).toBe(true);
      if (!decoded.ok) throw new Error("unreachable");
      return { json: encodeEnvelope2(decoded.envelope), auth: authBytes(decoded.envelope) };
    });
    for (const one of canonical) {
      expect(one.json).toBe(canonical[0].json);
      expect(one.auth).toBe(canonical[0].auth);
    }
    // ...and the canonical JSON is still exactly the fixture.
    expect(canonical[0].json).toBe(FIXTURE);
  });

  it("works for fixed-size records: the codec sees ciphertextLength only", () => {
    // Fixed-record framing lives entirely BELOW this layer. A fixed store's
    // ciphertext is F bytes whatever the plaintext was, and the transport must
    // not assume ciphertextLength has anything to do with plaintext length.
    for (const f of [32, 256, 4096]) {
      const envelope = sample({ ciphertextLength: f, ciphertext: new Uint8Array(f).fill(0x5a) });
      const back = decodeCompactEnvelope2(encodeCompactEnvelope2(envelope));
      expect(back.ok).toBe(true);
      if (!back.ok) continue;
      expect(back.envelope.ciphertextLength).toBe(f);
      expect(back.envelope.ciphertext.length).toBe(f);
      expect(authBytes(back.envelope)).toBe(authBytes(envelope));
    }
  });

  it("carries arbitrary bytes, so file payloads travel exactly like messages", () => {
    // Encrypted file payloads are arbitrary bytes; nothing here is text-only.
    const bytes = new Uint8Array(512);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
    const envelope = sample({ ciphertextLength: bytes.length, ciphertext: bytes });
    const back = decodeCompactEnvelope2(encodeCompactEnvelope2(envelope));
    expect(back.ok).toBe(true);
    if (back.ok) expect([...back.envelope.ciphertext]).toEqual([...bytes]);
  });
});

/* ==========================================================================
 * 8. Falsification (§25): the mistakes these specs must catch.
 * ======================================================================== */

describe("falsification — the codec may not drift", () => {
  it("the frozen vector is frozen: any layout change breaks it", () => {
    // This single assertion is what stops the binary layout being "improved"
    // later. Every message anyone has already copied depends on it.
    expect(encodeCompactEnvelope2(envelopeOf(FIXTURE))).toBe(FIXTURE_COMPACT);
  });

  it("direction is CARRIED — dropping it changes the auth bytes", () => {
    const ab = sample({ direction: "A->B" });
    const ba = sample({ direction: "B->A" });
    expect(encodeCompactEnvelope2(ab)).not.toBe(encodeCompactEnvelope2(ba));
    expect(authBytes(ab)).not.toBe(authBytes(ba));
    const back = decodeCompactEnvelope2(encodeCompactEnvelope2(ba));
    expect(back.ok && back.envelope.direction).toBe("B->A");
  });

  it("sequence and startOffset survive decode unchanged", () => {
    for (const [sequence, startOffset] of [[0, 0], [1, 4], [127, 128], [128, 16384], [65535, 2 ** 40]] as const) {
      const envelope = sample({ sequence, startOffset });
      const back = decodeCompactEnvelope2(encodeCompactEnvelope2(envelope));
      expect(back.ok).toBe(true);
      if (!back.ok) continue;
      expect(back.envelope.sequence).toBe(sequence);
      expect(back.envelope.startOffset).toBe(startOffset);
    }
  });

  it("a truncated pairId or tag can never round-trip", () => {
    const base = compactBytes(FIXTURE_COMPACT);
    expect(decodeCompactEnvelope2(recompact(base.slice(0, 17))).ok).toBe(false);
    expect(decodeCompactEnvelope2(recompact(base.slice(0, base.length - 5))).ok).toBe(false);
  });

  it("the encoder refuses anything encodeEnvelope2 refuses", () => {
    // The compact form is not a looser door into the same house.
    expect(() => encodeCompactEnvelope2(sample({ pairId: "NOTHEX" }))).toThrow();
    expect(() => encodeCompactEnvelope2(sample({ ciphertextLength: 4 }))).toThrow(); // disagrees with ciphertext
    expect(() => encodeCompactEnvelope2(sample({ tag: new Uint8Array(15) }))).toThrow();
    expect(() => encodeCompactEnvelope2(sample({ sequence: -1 }))).toThrow();
    expect(() => encodeCompactEnvelope2(sample({ sequence: 1.5 }))).toThrow();
  });

  it("JSON is still accepted, and is still what encodeEnvelope2 emits", () => {
    // If anyone ever "replaces" the JSON envelope, these fail.
    expect(encodeEnvelope2(envelopeOf(FIXTURE))).toBe(FIXTURE);
    expect(decodeEnvelope2(FIXTURE).ok).toBe(true);
    expect(decodeEnvelopeTransport2(FIXTURE).ok).toBe(true);
  });
});
