import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { bytesToHex } from "../src/core/hex";
import { hx } from "./helpers/spt-hex";
import { toBase64Url } from "../src/spt/bytes";
import {
  REQUEST_ID_BYTES,
  TPR2_BODY_BYTES,
  TPR2_PREFIX,
  TPR2_TEXT_CHARS,
  XWING_PUBLIC_KEY_BYTES
} from "../src/spt/constants";
import { decodeReceiveRequest, encodeReceiveRequest, encodeRequestBody } from "../src/spt/receive-request";
import { requestFingerprint, requestIndices132 } from "../src/spt/fingerprint";
import { generateKeyPairDerand } from "../src/spt/xwing-v1";

/* ============================================================================
 * TPR2 — the receive request codec, and VECTOR B
 * ----------------------------------------------------------------------------
 * The frozen values below are TEST VECTOR MATERIAL — NOT SECRET — NEVER
 * PRODUCTION MATERIAL. The recipient seed is a counted pattern, published here
 * deliberately so the vector is reproducible; nothing derived from it may ever
 * protect anything.
 * ========================================================================= */

const VECTOR_B = {
  /** TEST VECTOR — NOT SECRET — NEVER PRODUCTION MATERIAL */
  seed: "01060b10151a1f24292e33383d42474c51565b60656a6f74797e83888d92979c",
  requestId: "031425364758697a8b9cadbecfe0f102",
  textHead: "TPR2:AQABAxQlNkdYaXqLnK2-z-DxAidyJB68DlQ",
  textTail: "cX6Fwz0fvuNBGwJzIB_pJQGo",
  requestHash: "5288daabb08983e5eddd4ebcb27a905e4c9422e9866a47d53826c3347f971744",
  indices132: [660, 566, 1367, 776, 1217, 1943, 1467, 1358, 1509, 1182, 1312, 1508]
};

const KEYS = generateKeyPairDerand(hx(VECTOR_B.seed));
const REQUEST_ID = hx(VECTOR_B.requestId);
const TEXT = encodeReceiveRequest(REQUEST_ID, KEYS.encapsulationKey);
const BODY = encodeRequestBody(REQUEST_ID, KEYS.encapsulationKey);

describe("VECTOR B — TPR2", () => {
  it("the body is exactly 1235 bytes with the frozen field layout", () => {
    expect(BODY.length).toBe(TPR2_BODY_BYTES);
    expect(BODY[0]).toBe(0x01);
    expect(BODY[1]).toBe(0x00);
    expect(BODY[2]).toBe(0x01);
    expect(bytesToHex(BODY.subarray(3, 19))).toBe(VECTOR_B.requestId);
    expect(bytesToHex(BODY.subarray(19))).toBe(bytesToHex(KEYS.encapsulationKey));
  });

  it("the text is exactly 1652 characters and matches the frozen vector", () => {
    expect(TEXT.length).toBe(TPR2_TEXT_CHARS);
    expect(TEXT.startsWith(VECTOR_B.textHead)).toBe(true);
    expect(TEXT.endsWith(VECTOR_B.textTail)).toBe(true);
  });

  it("requestHash and the twelve indices match the frozen vector", async () => {
    const hash = await requestFingerprint(BODY);
    expect(bytesToHex(hash)).toBe(VECTOR_B.requestHash);
    expect(requestIndices132(hash)).toEqual(VECTOR_B.indices132);
  });

  it("round-trips to the identical canonical body", () => {
    const decoded = decodeReceiveRequest(TEXT);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(bytesToHex(decoded.canonicalBody)).toBe(bytesToHex(BODY));
    expect(decoded.request.version).toBe(1);
    expect(decoded.request.suite).toBe(1);
    expect(bytesToHex(decoded.request.requestId)).toBe(VECTOR_B.requestId);
    expect(decoded.request.encapsulationKey.length).toBe(XWING_PUBLIC_KEY_BYTES);
  });

  it("carries nothing but the four frozen fields", () => {
    // 1 + 2 + 16 + 1216 accounts for every byte, so there is no room for a
    // pairId, a device identifier, or anything else §5.1 forbids.
    expect(1 + 2 + REQUEST_ID_BYTES + XWING_PUBLIC_KEY_BYTES).toBe(BODY.length);
  });

  it("changing any field changes requestHash", async () => {
    const base = bytesToHex(await requestFingerprint(BODY));
    for (const offset of [0, 1, 2, 3, 18, 19, 1234]) {
      const tweaked = Uint8Array.from(BODY);
      tweaked[offset] ^= 0x01;
      expect(bytesToHex(await requestFingerprint(tweaked)), `offset ${offset}`).not.toBe(base);
    }
  });
});

describe("TPR2 encoding refuses malformed inputs", () => {
  it("a wrong-size requestId or encapsulation key", () => {
    expect(() => encodeRequestBody(new Uint8Array(15), KEYS.encapsulationKey)).toThrow(RangeError);
    expect(() => encodeRequestBody(REQUEST_ID, new Uint8Array(1215))).toThrow(RangeError);
  });
});

describe("TPR2 decoding — falsification", () => {
  const cases: Array<[string, string, string]> = [
    ["wrong prefix", "TPR1:" + TEXT.slice(5), "wrong-prefix"],
    ["no prefix at all", TEXT.slice(5), "wrong-prefix"],
    ["a TPS2 magic instead", "TPS2:" + TEXT.slice(5), "wrong-prefix"],
    ["padded base64url", TPR2_PREFIX + TEXT.slice(5) + "=", "not-base64url"],
    ["standard base64 '+'", TPR2_PREFIX + "+" + TEXT.slice(6), "not-base64url"],
    ["standard base64 '/'", TPR2_PREFIX + "/" + TEXT.slice(6), "not-base64url"],
    ["interior space", TPR2_PREFIX + TEXT.slice(5, 100) + " " + TEXT.slice(101), "not-base64url"],
    ["interior newline", TPR2_PREFIX + TEXT.slice(5, 100) + "\n" + TEXT.slice(101), "not-base64url"],
    ["a character outside the alphabet", TPR2_PREFIX + "*" + TEXT.slice(6), "not-base64url"],
    ["one character short", TEXT.slice(0, TEXT.length - 1), "wrong-body-length"],
    ["one character long", TEXT + "A", "wrong-body-length"],
    ["truncated public key", TEXT.slice(0, 1000), "wrong-body-length"],
    ["absurdly long", TPR2_PREFIX + "A".repeat(100000), "wrong-body-length"]
  ];

  for (const [name, input, reason] of cases) {
    it(`refuses ${name}`, () => {
      const decoded = decodeReceiveRequest(input);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) return;
      expect(decoded.reason).toBe(reason);
    });
  }

  it("refuses a non-canonical base64url spelling of the SAME body", () => {
    // 1235 bytes leaves a 2-character final group whose last character carries
    // four unused low bits. Setting them decodes to identical bytes under a
    // different text — one request with two spellings, which the re-encode
    // comparison is there to refuse.
    const last = TEXT[TEXT.length - 1];
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const alt = alphabet[(alphabet.indexOf(last) + 1) % 64];
    const noncanonical = TEXT.slice(0, -1) + alt;
    expect(noncanonical).not.toBe(TEXT);
    const decoded = decodeReceiveRequest(noncanonical);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.reason).toBe("noncanonical-base64url");
  });

  it("refuses an unsupported transfer version, and does not downgrade", () => {
    const body = Uint8Array.from(BODY);
    body[0] = 0x02;
    const decoded = decodeReceiveRequest(TPR2_PREFIX + toBase64Url(body));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.reason).toBe("unsupported-version");
  });

  it("refuses an unsupported suite, and does not negotiate", () => {
    for (const suite of [0x0000, 0x0002, 0xffff]) {
      const body = Uint8Array.from(BODY);
      body[1] = (suite >> 8) & 0xff;
      body[2] = suite & 0xff;
      const decoded = decodeReceiveRequest(TPR2_PREFIX + toBase64Url(body));
      expect(decoded.ok).toBe(false);
      if (decoded.ok) return;
      expect(decoded.reason).toBe("unsupported-suite");
    }
  });

  it("trims surrounding whitespace, because a paste picks it up", () => {
    for (const wrapped of [` ${TEXT} `, `\n${TEXT}\n`, `\t${TEXT}`, `${TEXT}\r\n`]) {
      expect(decodeReceiveRequest(wrapped).ok).toBe(true);
    }
  });

  it("does not mutate the caller's string or return views into it", () => {
    const decoded = decodeReceiveRequest(TEXT);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    // Writing through the returned arrays must not disturb anything else.
    decoded.request.requestId.fill(0);
    expect(bytesToHex(decoded.canonicalBody.subarray(3, 19))).toBe(VECTOR_B.requestId);
  });
});

/* The fixture is read here only to keep this file's frozen seed honest: it is
 * the same generator the X-Wing vectors use, not a second implementation. */
const FIXTURE = join(resolve(__dirname, "fixtures"), "xwing-draft10-appendix-c.json");
describe("vector hygiene", () => {
  it("VECTOR B's seed is not one of the draft's, so the two are independent", () => {
    const draft = JSON.parse(readFileSync(FIXTURE, "utf8")) as Array<{ seed: string }>;
    expect(draft.map((v) => v.seed)).not.toContain(VECTOR_B.seed);
  });
});
