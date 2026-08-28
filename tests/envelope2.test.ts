import { describe, expect, it } from "vitest";
import { decodeEnvelope2, encodeEnvelope2, type EnvelopeV2 } from "../src/core/envelope2";
import { MAX_CIPHERTEXT_BYTES } from "../src/core/wc-one-time";

/* ============================================================================
 * FORMAT-V2.md §6.2 / §9.1 — the strict v2 wire envelope.
 *
 * Exactly eight keys, one accepted spelling per token — property names
 * and string values literal on the wire, JSON escapes and duplicate keys
 * refused lexically on the raw text — declared length cross-checked,
 * oversize checked on the DECLARED length, and the v1-signature check
 * (label + no formatVersion -> envelope-v1) running before the eight-key
 * rule and before the spelling rules. Every refusal is structural: typed,
 * and it says "Nothing was burned." because nothing was.
 * ========================================================================= */

const PAIR_ID = "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf";
const TAG_HEX = "5bb81c1ec47fe75e649f81d8280c64d9";

// A valid wire object; tests override single fields to break it.
function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    formatVersion: 2,
    pairId: PAIR_ID,
    direction: "A->B",
    sequence: 7,
    startOffset: 4096,
    ciphertextLength: 3,
    ciphertext: "00abff",
    tag: TAG_HEX
  };
  return { ...base, ...overrides };
}

const decode = (fields: Record<string, unknown>) => decodeEnvelope2(JSON.stringify(fields));

function expectRefusal(
  result: ReturnType<typeof decodeEnvelope2>,
  reason: "envelope-v1" | "malformed-envelope" | "oversize-ciphertext"
) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  expect(result.reason).toBe(reason);
  // Structural refusals cost nothing, and the message says so.
  expect(result.message).toContain("Nothing was burned.");
  return result;
}

describe("encode -> decode round-trip", () => {
  it("round-trips every field, byte for byte", () => {
    const envelope: EnvelopeV2 = {
      pairId: PAIR_ID,
      direction: "B->A",
      sequence: 12,
      startOffset: 99,
      ciphertextLength: 4,
      ciphertext: Uint8Array.from([0, 0xab, 0xff, 0x10]),
      tag: Uint8Array.from({ length: 16 }, (_, i) => i)
    };
    const line = encodeEnvelope2(envelope);
    const decoded = decodeEnvelope2(line);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.envelope.pairId).toBe(PAIR_ID);
    expect(decoded.envelope.direction).toBe("B->A");
    expect(decoded.envelope.sequence).toBe(12);
    expect(decoded.envelope.startOffset).toBe(99);
    expect(decoded.envelope.ciphertextLength).toBe(4);
    expect([...decoded.envelope.ciphertext]).toEqual([0, 0xab, 0xff, 0x10]);
    expect([...decoded.envelope.tag]).toEqual([...envelope.tag]);
  });

  it("emits exactly the eight §6.2 fields in the §6.2 order, one line, lowercase hex", () => {
    const line = encodeEnvelope2({
      pairId: PAIR_ID,
      direction: "A->B",
      sequence: 7,
      startOffset: 4096,
      ciphertextLength: 3,
      ciphertext: Uint8Array.from([0, 0xab, 0xff]),
      tag: Uint8Array.from(Array.from({ length: 16 }, (_, i) => (i * 16 + i) % 256))
    });
    expect(line).toBe(
      `{"formatVersion":2,"pairId":"${PAIR_ID}","direction":"A->B","sequence":7,` +
        `"startOffset":4096,"ciphertextLength":3,"ciphertext":"00abff",` +
        `"tag":"00112233445566778899aabbccddeeff"}`
    );
    expect(line).not.toContain("\n");
  });

  it("an empty ciphertext (C = 0) is a valid envelope", () => {
    const line = encodeEnvelope2({
      pairId: PAIR_ID,
      direction: "A->B",
      sequence: 8,
      startOffset: 4128,
      ciphertextLength: 0,
      ciphertext: new Uint8Array(0),
      tag: new Uint8Array(16)
    });
    const decoded = decodeEnvelope2(line);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.envelope.ciphertextLength).toBe(0);
    expect(decoded.envelope.ciphertext.length).toBe(0);
  });

  it("a ciphertext of exactly MAX_CIPHERTEXT_BYTES round-trips — the maximum is inclusive", () => {
    const decoded = decode(
      wire({ ciphertextLength: MAX_CIPHERTEXT_BYTES, ciphertext: "00".repeat(MAX_CIPHERTEXT_BYTES) })
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.envelope.ciphertext.length).toBe(MAX_CIPHERTEXT_BYTES);
  });

  it("encode throws on domain violations instead of emitting a line decode would refuse", () => {
    const good: EnvelopeV2 = {
      pairId: PAIR_ID,
      direction: "A->B",
      sequence: 0,
      startOffset: 0,
      ciphertextLength: 1,
      ciphertext: Uint8Array.from([1]),
      tag: new Uint8Array(16)
    };
    expect(() => encodeEnvelope2({ ...good, pairId: "short" })).toThrow(/pairId/);
    expect(() => encodeEnvelope2({ ...good, ciphertextLength: 2 })).toThrow(/ciphertext/);
    expect(() => encodeEnvelope2({ ...good, tag: new Uint8Array(15) })).toThrow(/tag/);
    expect(() => encodeEnvelope2({ ...good, sequence: -1 })).toThrow(/safe integer/);
  });
});

describe("envelope-v1 — the v1 signature wins over every other rule (§9.1)", () => {
  const V1_LINE = '{"label":"PAD-KQZM-AB","startOffset":12,"consumed":3,"payload":"00ABFF"}';

  it("the real v1 wire shape is refused envelope-v1, never malformed-envelope", () => {
    const refusal = expectRefusal(decodeEnvelope2(V1_LINE), "envelope-v1");
    expect(refusal.message).toMatch(/v1 envelope/);
    expect(refusal.message).toMatch(/no --legacy/);
  });

  it("precedence: a v1 envelope also violates the eight-key rule and must still be envelope-v1", () => {
    // Four keys, none of them the v2 eight — the eight-key rule would call
    // this malformed; the v1-signature check must fire first.
    const refusal = decodeEnvelope2(V1_LINE);
    expect(!refusal.ok && refusal.reason).toBe("envelope-v1");
    // Even a bare label is the v1 signature.
    expectRefusal(decode({ label: "PAD-AAAA-AB" }), "envelope-v1");
  });

  it("a label WITH a formatVersion is not the v1 signature — it falls through to the eight-key rule", () => {
    const refusal = expectRefusal(decode(wire({ label: "PAD-KQZM-AB" })), "malformed-envelope");
    expect(refusal.message).toContain("label");
  });
});

describe("malformed-envelope — strict parse, one accepted spelling (§6.2)", () => {
  it("non-JSON, non-object JSON, and null are malformed", () => {
    for (const text of ["not json", "[]", '"string"', "42", "null", ""]) {
      expectRefusal(decodeEnvelope2(text), "malformed-envelope");
    }
  });

  it("an extra ninth key is malformed", () => {
    const refusal = expectRefusal(decode(wire({ note: "hello" })), "malformed-envelope");
    expect(refusal.message).toContain("note");
  });

  it("a missing key is malformed", () => {
    for (const key of ["formatVersion", "pairId", "direction", "sequence", "startOffset", "ciphertextLength", "ciphertext", "tag"]) {
      const fields = wire();
      delete fields[key];
      // Dropping formatVersion alone leaves no label either, so it is still
      // not the v1 signature — just an incomplete v2 envelope.
      const refusal = expectRefusal(decode(fields), "malformed-envelope");
      expect(refusal.message).toContain(key);
    }
  });

  it("formatVersion must be the integer 2 — 1, 3, '2', and 2.5 are malformed", () => {
    for (const formatVersion of [1, 3, "2", 2.5, null, true]) {
      expectRefusal(decode(wire({ formatVersion })), "malformed-envelope");
    }
  });

  it("uppercase hex is malformed in ciphertext, pairId, and tag — no alternate spellings", () => {
    expectRefusal(decode(wire({ ciphertext: "00ABFF" })), "malformed-envelope");
    expectRefusal(decode(wire({ pairId: PAIR_ID.toUpperCase() })), "malformed-envelope");
    expectRefusal(decode(wire({ tag: TAG_HEX.toUpperCase() })), "malformed-envelope");
  });

  it("odd-length and non-hex ciphertext are malformed", () => {
    expectRefusal(decode(wire({ ciphertext: "00abf" })), "malformed-envelope");
    expectRefusal(decode(wire({ ciphertext: "00zzff" })), "malformed-envelope");
    expectRefusal(decode(wire({ ciphertext: 42 })), "malformed-envelope");
  });

  it("pairId and tag must be exactly 32 hex characters", () => {
    expectRefusal(decode(wire({ pairId: PAIR_ID.slice(0, 30) })), "malformed-envelope");
    expectRefusal(decode(wire({ pairId: PAIR_ID + "00" })), "malformed-envelope");
    expectRefusal(decode(wire({ tag: TAG_HEX.slice(0, 30) })), "malformed-envelope");
  });

  it("direction must be exactly 'A->B' or 'B->A'", () => {
    for (const direction of ["a->b", "AB", "A→B", "B->A ", 0]) {
      expectRefusal(decode(wire({ direction })), "malformed-envelope");
    }
    expect(decode(wire({ direction: "B->A" })).ok).toBe(true);
  });

  it("sequence, startOffset, ciphertextLength: fractions, negatives, 2^53, and strings are malformed", () => {
    for (const key of ["sequence", "startOffset", "ciphertextLength"] as const) {
      for (const value of [1.5, -1, 2 ** 53, "7", null]) {
        expectRefusal(decode(wire({ [key]: value })), "malformed-envelope");
      }
    }
    // 2^53 - 1 is the last safe integer and is accepted for the counters
    // whose operative domain is checked later by the caller.
    expect(decode(wire({ sequence: 2 ** 53 - 1 })).ok).toBe(true);
    expect(decode(wire({ startOffset: 0 })).ok).toBe(true);
  });

  it("declared length vs ciphertext hex: the cross-check refuses a mismatch either way", () => {
    const long = expectRefusal(decode(wire({ ciphertextLength: 4 })), "malformed-envelope");
    expect(long.message).toMatch(/says 4 bytes/);
    expectRefusal(decode(wire({ ciphertextLength: 2 })), "malformed-envelope");
  });
});

describe("wire spellings — escapes and duplicate keys are refused lexically (§6.2)", () => {
  // JSON.parse decodes escape sequences and collapses duplicate keys (last
  // one wins) before any check on the parsed object can see either, so
  // these rules live in a lexical scan of the raw text. The lines below
  // are built by string surgery on a valid envelope: JSON.stringify never
  // emits an escape for any legal v2 value, so no encoded envelope can
  // trip these refusals.
  const VALID = JSON.stringify(wire());

  it("a duplicated key is malformed, even though JSON.parse would collapse it silently", () => {
    const line = VALID.slice(0, -1) + ',"sequence":8}';
    expect(JSON.parse(line).sequence).toBe(8); // parse alone would take the last one
    const refusal = expectRefusal(decodeEnvelope2(line), "malformed-envelope");
    expect(refusal.message).toContain("sequence appears 2 times");
  });

  it("a duplicate whose second spelling uses \\u escapes is malformed — the escaped name refuses first", () => {
    const line = VALID.slice(0, -1) + `,"\\u0070airId":"${PAIR_ID}"}`;
    const refusal = expectRefusal(decodeEnvelope2(line), "malformed-envelope");
    expect(refusal.message).toContain("escape sequences");
  });

  it("a required key spelled ONLY with escapes is malformed, never accepted", () => {
    // "\u0070airId" decodes to pairId, so every check on the parsed
    // object would pass — this is the bypass the spelling rule closes.
    const line = VALID.replace('"pairId"', '"\\u0070airId"');
    expect(JSON.parse(line).pairId).toBe(PAIR_ID);
    const refusal = expectRefusal(decodeEnvelope2(line), "malformed-envelope");
    expect(refusal.message).toContain("escape sequences");
  });

  it("an extra key with an escaped name is malformed via the spelling rule, not the eight-key rule", () => {
    const line = VALID.slice(0, -1) + ',"\\u006eote":"x"}';
    const refusal = expectRefusal(decodeEnvelope2(line), "malformed-envelope");
    expect(refusal.message).toContain("escape sequences");
    expect(refusal.message).not.toContain("unexpected");
  });

  it("escapes in VALUE strings are refused even when they decode to in-domain values", () => {
    // "\u00300abff" decodes to "00abff" and "A-\u003eB" decodes to
    // "A->B": in-domain after decoding, but §6.2/§6.3 promise exactly one
    // accepted wire spelling per value — the decoded-equivalent form is
    // refused, never domain-checked.
    const ct = VALID.replace('"00abff"', '"\\u00300abff"');
    expect(JSON.parse(ct).ciphertext).toBe("00abff");
    expectRefusal(decodeEnvelope2(ct), "malformed-envelope");
    const dir = VALID.replace('"A->B"', '"A-\\u003eB"');
    expect(JSON.parse(dir).direction).toBe("A->B");
    const refusal = expectRefusal(decodeEnvelope2(dir), "malformed-envelope");
    expect(refusal.message).toContain("escape sequences");
  });

  it("JSON inter-token whitespace stays legal — strict about spellings, not byte-exact", () => {
    const pretty = JSON.stringify(wire(), null, 2); // newlines and indentation
    expect(decodeEnvelope2(pretty).ok).toBe(true);
    const spaced = VALID.replace(/":/g, '" : ').replace(/,"/g, ' , "');
    expect(JSON.parse(spaced)).toEqual(wire()); // same object, more whitespace
    expect(decodeEnvelope2(spaced).ok).toBe(true);
  });

  it("braces, colons, and commas inside a value string do not miscount the scan", () => {
    // The extra key is still the refusal, and it is named correctly — the
    // structural characters inside the value were lexed as string content.
    const line = VALID.slice(0, -1) + ',"note":"{[:,]}"}';
    const refusal = expectRefusal(decodeEnvelope2(line), "malformed-envelope");
    expect(refusal.message).toContain("unexpected note");
  });

  it("a nested value mentioning a wire key is not a duplicate — only top-level names count", () => {
    const line = VALID.slice(0, -1) + ',"note":{"pairId":1}}';
    const refusal = expectRefusal(decodeEnvelope2(line), "malformed-envelope");
    expect(refusal.message).toContain("unexpected note"); // eight-key rule, not the duplicate rule
  });

  it("an escaped quote inside a value lexes as content, not a terminator", () => {
    // The raw value is "a\"b\\" — the lexer must ride over \" and \\ to the
    // real closing quote; the refusal is the value-spelling rule.
    const line = VALID.replace('"00abff"', '"a\\"b\\\\"');
    const refusal = expectRefusal(decodeEnvelope2(line), "malformed-envelope");
    expect(refusal.message).toContain("escape sequences");
  });

  it("truncated JSON is malformed before the scanner ever runs", () => {
    expectRefusal(decodeEnvelope2(VALID.slice(0, -2)), "malformed-envelope");
  });

  it("v1 precedence is unchanged — a v1 envelope containing escapes is still envelope-v1", () => {
    // The v1 signature is read from PARSED keys, so a v1 line whose label
    // key or values are spelled with escapes still lands at envelope-v1:
    // the refusal that names the right tooling outranks the spelling rule.
    expectRefusal(decodeEnvelope2('{"\\u006cabel":"PAD-KQZM-AB","startOffset":12}'), "envelope-v1");
    expectRefusal(
      decodeEnvelope2('{"label":"PAD\\u002dKQZM-AB","startOffset":12,"consumed":3,"payload":"00ABFF"}'),
      "envelope-v1"
    );
  });
});

describe("oversize-ciphertext — checked on the DECLARED length (§6.2, §4)", () => {
  it("fires on the declared length even when the ciphertext hex is truncated", () => {
    // The cross-check would also fail here; oversize must win — the declared
    // length is refused before the hex is decoded or measured.
    const refusal = expectRefusal(
      decode(wire({ ciphertextLength: MAX_CIPHERTEXT_BYTES + 1, ciphertext: "00" })),
      "oversize-ciphertext"
    );
    expect(refusal.message).toContain(String(MAX_CIPHERTEXT_BYTES + 1));
    expect(refusal.message).toContain(String(MAX_CIPHERTEXT_BYTES));
  });

  it("fires without materializing an oversize hex string's bytes", () => {
    const declared = MAX_CIPHERTEXT_BYTES + 1;
    const refusal = decode(wire({ ciphertextLength: declared, ciphertext: "00".repeat(declared) }));
    expect(!refusal.ok && refusal.reason).toBe("oversize-ciphertext");
  });

  it("a huge declared length that is still a safe integer is oversize, not malformed", () => {
    const refusal = decode(wire({ ciphertextLength: 2 ** 53 - 1, ciphertext: "00" }));
    expect(!refusal.ok && refusal.reason).toBe("oversize-ciphertext");
  });
});

describe("number spellings — one canonical wire spelling per numeric field (§6.2)", () => {
  // A valid line as raw text, so we can substitute non-canonical number
  // spellings JSON.stringify would never emit.
  const RAW = `{"formatVersion":2,"pairId":"${PAIR_ID}","direction":"A->B","sequence":7,"startOffset":4096,"ciphertextLength":3,"ciphertext":"00abff","tag":"${TAG_HEX}"}`;

  it("the canonical line still decodes", () => {
    expect(decodeEnvelope2(RAW).ok).toBe(true);
  });

  const nonCanonical: [string, string][] = [
    ['"sequence":7', '"sequence":7.0'],
    ['"sequence":7', '"sequence":7e0'],
    ['"sequence":7', '"sequence":07'],
    ['"startOffset":4096', '"startOffset":4.096e3'],
    ['"startOffset":4096', '"startOffset":-0'],
    ['"ciphertextLength":3', '"ciphertextLength":3e0'],
    ['"formatVersion":2', '"formatVersion":2.000'],
    ['"formatVersion":2', '"formatVersion":2e0']
  ];

  for (const [from, to] of nonCanonical) {
    it(`refuses ${to.trim()} — decodes in-domain but is a non-canonical spelling`, () => {
      const result = decodeEnvelope2(RAW.replace(from, to));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("malformed-envelope");
      expect(result.message).toContain("Nothing was burned.");
    });
  }

  it("genuinely out-of-domain numbers are still refused (7.5, -1)", () => {
    expect(decodeEnvelope2(RAW.replace('"sequence":7', '"sequence":7.5')).ok).toBe(false);
    expect(decodeEnvelope2(RAW.replace('"sequence":7', '"sequence":-1')).ok).toBe(false);
  });

  it("a number spelling inside a VALUE string is not a top-level number (no false positive)", () => {
    // The ciphertext value happens to be all hex digits; a bare digit run
    // there must not be mistaken for a numeric member.
    expect(decodeEnvelope2(RAW).ok).toBe(true);
  });
});
