import { describe, expect, it } from "vitest";

import { bytesToHex } from "../src/core/hex";
import { hx } from "./helpers/spt-hex";
import { toBase64Url } from "../src/spt/bytes";
import { SUITE_ID, TPR2_BODY_BYTES, TPR2_PREFIX, XWING_PUBLIC_KEY_BYTES } from "../src/spt/constants";
import { openPayloadV1, sealPayloadV1 } from "../src/spt/crypto-v1";
import {
  decodeReceiveRequest,
  encodeRequestBody,
  parseRequestBody
} from "../src/spt/receive-request";
import { parseSealedPackage } from "../src/spt/sealed-package";
import { generateKeyPairDerand } from "../src/spt/xwing-v1";

/* ============================================================================
 * ONE AUTHORITY FOR THE RECIPIENT'S KEM IDENTITY
 * ----------------------------------------------------------------------------
 * `sealPayloadV1` used to take the canonical request body AND the encapsulation
 * key — the same fact twice, with nothing checking that the two agreed. An
 * honest caller juggling two open requests could pass body `B` with the key
 * from `B'`, producing a package whose `requestHash` names `B` while the KEM
 * ciphertext is for `B'`. `B` cannot open it, and once Phase 1B wraps this
 * layer that package would have spent the sender's one handoff (§10.6) on
 * nothing.
 *
 * The key is now read out of the body that names it, by the one binary parser
 * that also backs `decodeReceiveRequest` and `openPayloadV1`. The seam is
 * closed by construction: there is no second argument to disagree with.
 * ========================================================================= */

/** TEST VECTOR — NOT SECRET — NEVER PRODUCTION MATERIAL */
const SEED_B = "01060b10151a1f24292e33383d42474c51565b60656a6f74797e83888d92979c";
/** TEST VECTOR — NOT SECRET — NEVER PRODUCTION MATERIAL */
const SEED_B_PRIME = "02040608" + "0a".repeat(28);

const BOB = generateKeyPairDerand(hx(SEED_B));
const CHARLIE = generateKeyPairDerand(hx(SEED_B_PRIME));
const ID_B = new Uint8Array(16).fill(0x11);
const ID_B_PRIME = new Uint8Array(16).fill(0x22);

const BODY_B = encodeRequestBody(ID_B, BOB.encapsulationKey);
const BODY_B_PRIME = encodeRequestBody(ID_B_PRIME, CHARLIE.encapsulationKey);
const PAYLOAD = new TextEncoder().encode("one authority");

describe("the redundant key parameter is gone", () => {
  it("sealPayloadV1 takes the body and the payload, and no key", () => {
    // Arity is the mechanical statement of "there is nothing to disagree with".
    // `options` is optional, so `length` counts the two required parameters.
    expect(sealPayloadV1.length).toBe(2);
  });

  it("a body always seals to the key embedded in THAT body", async () => {
    const sealed = await sealPayloadV1(BODY_B, PAYLOAD);
    // Bob opens it...
    const forBob = await openPayloadV1(sealed.packageBytes, BODY_B, BOB.decapsulationSeed);
    expect(forBob.ok).toBe(true);
    // ...and Charlie, whose key is in the OTHER body, cannot.
    const forCharlie = await openPayloadV1(sealed.packageBytes, BODY_B, CHARLIE.decapsulationSeed);
    expect(forCharlie.ok).toBe(false);
  });

  it("changing ONLY body[19..1235) changes the KEM recipient", async () => {
    // Same requestId, same version, same suite — only the embedded key differs.
    const swapped = Uint8Array.from(BODY_B);
    swapped.set(CHARLIE.encapsulationKey, 19);
    expect(bytesToHex(swapped.subarray(0, 19))).toBe(bytesToHex(BODY_B.subarray(0, 19)));

    const sealed = await sealPayloadV1(swapped, PAYLOAD);
    // Charlie's key now opens it; Bob's does not. The recipient followed the
    // body, which is the whole point.
    expect((await openPayloadV1(sealed.packageBytes, swapped, CHARLIE.decapsulationSeed)).ok).toBe(true);
    expect((await openPayloadV1(sealed.packageBytes, swapped, BOB.decapsulationSeed)).ok).toBe(false);
  });

  it("the KEM ciphertext differs between two bodies that differ only in the key", async () => {
    const swapped = Uint8Array.from(BODY_B);
    swapped.set(CHARLIE.encapsulationKey, 19);
    const a = parseSealedPackage((await sealPayloadV1(BODY_B, PAYLOAD)).packageBytes);
    const b = parseSealedPackage((await sealPayloadV1(swapped, PAYLOAD)).packageBytes);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(bytesToHex(a.parsed.header.kemCiphertext)).not.toBe(bytesToHex(b.parsed.header.kemCiphertext));
  });

  it("the mismatch that used to be constructible no longer is", async () => {
    // The old call was sealPayloadV1(BODY_B, CHARLIE.encapsulationKey, payload).
    // There is no longer any way to spell that: the third positional argument
    // is `options`, and an object is not a key.
    const sealed = await sealPayloadV1(BODY_B, PAYLOAD);
    const parsed = parseSealedPackage(sealed.packageBytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // requestHash names BODY_B and the ciphertext is for BODY_B's key: the two
    // halves cannot name different requests.
    expect(bytesToHex(parsed.parsed.header.requestId)).toBe(bytesToHex(ID_B));
    const opened = await openPayloadV1(sealed.packageBytes, BODY_B, BOB.decapsulationSeed);
    expect(opened.ok).toBe(true);
  });
});

describe("no cryptographic operation over a malformed request body", () => {
  const malformed: Array<[string, Uint8Array, string]> = [
    ["one byte short", BODY_B.subarray(0, TPR2_BODY_BYTES - 1), "wrong-body-length"],
    ["one byte long", new Uint8Array([...BODY_B, 0]), "wrong-body-length"],
    ["empty", new Uint8Array(0), "wrong-body-length"],
    ["the right length but all zero", new Uint8Array(TPR2_BODY_BYTES), "unsupported-version"]
  ];

  for (const [name, body, reason] of malformed) {
    it(`parseRequestBody refuses ${name}`, () => {
      const parsed = parseRequestBody(body);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.reason).toBe(reason);
    });

    it(`sealPayloadV1 refuses ${name} BEFORE any KEM work`, async () => {
      await expect(sealPayloadV1(body, PAYLOAD)).rejects.toThrow(RangeError);
    });

    it(`openPayloadV1 refuses ${name} as malformed-request-body`, async () => {
      const sealed = await sealPayloadV1(BODY_B, PAYLOAD);
      const opened = await openPayloadV1(sealed.packageBytes, body, BOB.decapsulationSeed);
      expect(opened.ok).toBe(false);
      if (opened.ok) return;
      expect(opened.reason).toBe("malformed-request-body");
    });
  }

  it("refuses an unsupported version", async () => {
    const body = Uint8Array.from(BODY_B);
    body[0] = 0x02;
    expect(parseRequestBody(body).ok).toBe(false);
    await expect(sealPayloadV1(body, PAYLOAD)).rejects.toThrow(/unsupported transfer version/);
  });

  it("refuses an unsupported suite", async () => {
    for (const suite of [0x0000, 0x0002, 0xffff]) {
      const body = Uint8Array.from(BODY_B);
      body[1] = (suite >> 8) & 0xff;
      body[2] = suite & 0xff;
      const parsed = parseRequestBody(body);
      expect(parsed.ok, `suite ${suite}`).toBe(false);
      if (parsed.ok) return;
      expect(parsed.reason).toBe("unsupported-suite");
      await expect(sealPayloadV1(body, PAYLOAD)).rejects.toThrow(/unsupported suite/);
    }
  });

  it("a 1235-byte buffer that is not a request never becomes a request domain", async () => {
    // The failure this prevents: hashing arbitrary caller bytes as though they
    // were canonical, which would silently define a request nobody made.
    const junk = new Uint8Array(TPR2_BODY_BYTES).fill(0x5a);
    const sealed = await sealPayloadV1(BODY_B, PAYLOAD);
    const opened = await openPayloadV1(sealed.packageBytes, junk, BOB.decapsulationSeed);
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    // Not "request-mismatch": that would mean we hashed it first.
    expect(opened.reason).toBe("malformed-request-body");
  });
});

describe("one parser, two entry points", () => {
  it("decodeReceiveRequest delegates its semantic checks to parseRequestBody", () => {
    // Same body, same verdict, whichever door it comes through.
    for (const mutate of [
      (b: Uint8Array) => (b[0] = 0x02),
      (b: Uint8Array) => (b[2] = 0x02),
      (b: Uint8Array) => (b[1] = 0xff)
    ]) {
      const body = Uint8Array.from(BODY_B);
      mutate(body);
      const binary = parseRequestBody(body);
      const text = decodeReceiveRequest(TPR2_PREFIX + toBase64Url(body));
      expect(binary.ok).toBe(false);
      expect(text.ok).toBe(false);
      if (binary.ok || text.ok) return;
      expect(text.reason).toBe(binary.reason);
      expect(text.message).toBe(binary.message);
    }
  });

  it("a good body gives the same fields through both doors", () => {
    const binary = parseRequestBody(BODY_B);
    const text = decodeReceiveRequest(TPR2_PREFIX + toBase64Url(BODY_B));
    expect(binary.ok && text.ok).toBe(true);
    if (!binary.ok || !text.ok) return;
    expect(bytesToHex(binary.request.requestId)).toBe(bytesToHex(text.request.requestId));
    expect(bytesToHex(binary.request.encapsulationKey)).toBe(bytesToHex(text.request.encapsulationKey));
    expect(bytesToHex(binary.canonicalBody)).toBe(bytesToHex(text.canonicalBody));
    expect(binary.request.suite).toBe(SUITE_ID);
    expect(binary.request.encapsulationKey.length).toBe(XWING_PUBLIC_KEY_BYTES);
  });

  it("returns copies, not views into the caller's buffer", () => {
    const body = Uint8Array.from(BODY_B);
    const parsed = parseRequestBody(body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const beforeId = bytesToHex(parsed.request.requestId);
    const beforeKey = bytesToHex(parsed.request.encapsulationKey);
    // Writing through the caller's buffer must not change what the parse said.
    body.fill(0xcc);
    expect(bytesToHex(parsed.request.requestId)).toBe(beforeId);
    expect(bytesToHex(parsed.request.encapsulationKey)).toBe(beforeKey);
    expect(bytesToHex(parsed.canonicalBody.subarray(0, 3))).toBe("010001");
    // ...and the reverse: writing through the parse must not change the buffer.
    const other = Uint8Array.from(BODY_B);
    const second = parseRequestBody(other);
    if (!second.ok) return;
    second.request.encapsulationKey.fill(0);
    expect(bytesToHex(other)).toBe(bytesToHex(BODY_B));
  });

  it("parseRequestBody does not mutate the caller's body", () => {
    const body = Uint8Array.from(BODY_B);
    const before = bytesToHex(body);
    parseRequestBody(body);
    expect(bytesToHex(body)).toBe(before);
  });
});
