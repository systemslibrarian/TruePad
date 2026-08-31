import { describe, expect, it } from "vitest";

import { bytesToHex } from "../src/core/hex";
import { hx } from "./helpers/spt-hex";
import { MemoryVfs } from "../src/browser/engine/vfs";
import { handle } from "../src/browser/engine/verbs";
import { unpackContainer } from "../src/browser/engine/courier-format";
import type { EngineRequest, EngineResponse } from "../src/browser/engine/protocol";

import { writeUint64BE } from "../src/spt/bytes";
import {
  AEAD_TAG_BYTES,
  MAX_PLAINTEXT_BYTES,
  TPS2_FIXED_OVERHEAD_BYTES,
  TPS2_HEADER_BYTES,
  TPS2_OFFSETS
} from "../src/spt/constants";
import {
  derivePadHash,
  deriveAeadKeyBytes,
  deriveConfirmValue,
  deriveNonce,
  derivePrk,
  openPayloadV1,
  sealPayloadV1
} from "../src/spt/crypto-v1";
import { requestFingerprint } from "../src/spt/fingerprint";
import { encodeRequestBody } from "../src/spt/receive-request";
import { packageIdentity, parseSealedPackage } from "../src/spt/sealed-package";
import { encapsulateDerand, generateKeyPairDerand } from "../src/spt/xwing-v1";

/* ============================================================================
 * VECTOR C — the TruePad crypto layer, and VECTOR D — a real pad container
 * ----------------------------------------------------------------------------
 * Everything frozen below is TEST VECTOR MATERIAL — NOT SECRET — NEVER
 * PRODUCTION MATERIAL. The recipient seed and the encapsulation seed are
 * counted patterns published deliberately so the vector is reproducible.
 * ========================================================================= */

/** TEST VECTOR — NOT SECRET — NEVER PRODUCTION MATERIAL */
const SEED = "01060b10151a1f24292e33383d42474c51565b60656a6f74797e83888d92979c";
const REQUEST_ID = "031425364758697a8b9cadbecfe0f102";
/** TEST VECTOR — NOT SECRET — NEVER PRODUCTION MATERIAL */
const ESEED =
  "07121d28333e49545f6a75808b96a1acb7c2cdd8e3eef9040f1a25303b46515c" +
  "67727d88939ea9b4bfcad5e0ebf6010c17222d38434e59646f7a85909ba6b1bc";

const VECTOR_C = {
  payloadText: "TruePad SPT vector C payload — opaque bytes.\n",
  payloadLength: 47,
  requestHash: "5288daabb08983e5eddd4ebcb27a905e4c9422e9866a47d53826c3347f971744",
  sharedSecret: "39531bc48ed91c4b9f380ced5e4c42c39ac3ed2ae15596ac9bd48b5ccc4f512d",
  padHash: "1684ace251c5079c5252ecef929a1ae45f7b7022b8575396932b92a50c0752c1",
  nonce: "9a72341dc800ec07808ec9b9",
  /** TEST VECTOR — NOT SECRET — NEVER PRODUCTION MATERIAL */
  aeadKey: "9dacc1378705c095519f5c1b03c3e92a8d1ee313db62135313e4858175f30f63",
  aadHash: "a73f7507937ec3cfe37e763d61b1b356eb0185648de4267d29045c0e5891d372",
  ciphertext:
    "f3c9d38117729267c7b08adee1d0c1dc66b74c290e23204e13a42d4ab7d790dcac0f531c28c1074d0b40c29ba0e412",
  tag: "67d728b46573735bdd85d17de14242ff",
  packageLength: 1258,
  packageIdentity: "a966c11a63be7a4a20f52c846449b5fab2296ec775694f43fbad45fbcd167d16",
  confirmValue: "5d05c0d7749762262ff678",
  confirmationIndices: [744, 368, 430, 1865, 945, 152, 1534, 1656]
};

const KEYS = generateKeyPairDerand(hx(SEED));
const BODY = encodeRequestBody(hx(REQUEST_ID), KEYS.encapsulationKey);
const PAYLOAD = new TextEncoder().encode(VECTOR_C.payloadText);
const derand = { eseedForVectorsOnly: hx(ESEED) };

async function sealVector() {
  return sealPayloadV1(BODY, KEYS.encapsulationKey, PAYLOAD, derand);
}

describe("VECTOR C — every intermediate is pinned, not just the output", () => {
  it("payload length and the KEM shared secret", () => {
    expect(PAYLOAD.length).toBe(VECTOR_C.payloadLength);
    const enc = encapsulateDerand(KEYS.encapsulationKey, hx(ESEED));
    expect(bytesToHex(enc.sharedSecret)).toBe(VECTOR_C.sharedSecret);
  });

  it("requestHash and padHash", async () => {
    expect(bytesToHex(await requestFingerprint(BODY))).toBe(VECTOR_C.requestHash);
    expect(bytesToHex(await derivePadHash(PAYLOAD))).toBe(VECTOR_C.padHash);
  });

  it("the derived nonce", async () => {
    const ss = hx(VECTOR_C.sharedSecret);
    const rh = hx(VECTOR_C.requestHash);
    expect(bytesToHex(await deriveNonce(ss, rh, hx(VECTOR_C.padHash)))).toBe(VECTOR_C.nonce);
  });

  it("the AAD is 1195 bytes and hashes to the frozen value", async () => {
    const sealed = await sealVector();
    const parsed = parseSealedPackage(sealed.packageBytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.parsed.aad.length).toBe(TPS2_HEADER_BYTES);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", parsed.parsed.aad));
    expect(bytesToHex(digest)).toBe(VECTOR_C.aadHash);
    expect(bytesToHex(parsed.parsed.header.nonce)).toBe(VECTOR_C.nonce);
    expect(parsed.parsed.header.plaintextLength).toBe(VECTOR_C.payloadLength);
  });

  it("the AEAD key and the confirmation value", async () => {
    const sealed = await sealVector();
    const parsed = parseSealedPackage(sealed.packageBytes);
    if (!parsed.ok) throw new Error("parse failed");
    const ss = hx(VECTOR_C.sharedSecret);
    const rh = hx(VECTOR_C.requestHash);
    expect(bytesToHex(await deriveAeadKeyBytes(ss, rh, parsed.parsed.aad))).toBe(VECTOR_C.aeadKey);
    expect(bytesToHex(await deriveConfirmValue(ss, rh, parsed.parsed.aad))).toBe(VECTOR_C.confirmValue);
    expect(bytesToHex(sealed.confirmValue)).toBe(VECTOR_C.confirmValue);
    expect(sealed.confirmationIndices).toEqual(VECTOR_C.confirmationIndices);
  });

  it("the ciphertext, the tag, the whole package, and its identity", async () => {
    const sealed = await sealVector();
    const parsed = parseSealedPackage(sealed.packageBytes);
    if (!parsed.ok) throw new Error("parse failed");
    expect(bytesToHex(parsed.parsed.ciphertext)).toBe(VECTOR_C.ciphertext);
    expect(bytesToHex(parsed.parsed.tag)).toBe(VECTOR_C.tag);
    expect(sealed.packageBytes.length).toBe(VECTOR_C.packageLength);
    expect(sealed.packageBytes.length).toBe(TPS2_FIXED_OVERHEAD_BYTES + PAYLOAD.length);
    expect(bytesToHex(sealed.packageIdentity)).toBe(VECTOR_C.packageIdentity);
  });

  it("PRK is the same whether extracted once or via the convenience wrappers", async () => {
    // The seal path extracts one PRK and expands three times; the exported
    // helpers extract each time. §7.3 says these are the same bytes, and if
    // they ever stop being, the vectors above would be testing a path the
    // product does not take.
    const ss = hx(VECTOR_C.sharedSecret);
    const rh = hx(VECTOR_C.requestHash);
    const prk = await derivePrk(ss, rh);
    expect(prk.length).toBe(32);
    const sealed = await sealVector();
    const parsed = parseSealedPackage(sealed.packageBytes);
    if (!parsed.ok) throw new Error("parse failed");
    expect(bytesToHex(await deriveConfirmValue(ss, rh, parsed.parsed.aad))).toBe(bytesToHex(sealed.confirmValue));
  });

  it("opens back to the identical payload", async () => {
    const sealed = await sealVector();
    const opened = await openPayloadV1(sealed.packageBytes, BODY, KEYS.decapsulationSeed);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(bytesToHex(opened.result.payload)).toBe(bytesToHex(PAYLOAD));
    expect(bytesToHex(opened.result.confirmValue)).toBe(VECTOR_C.confirmValue);
    expect(opened.result.confirmationIndices).toEqual(VECTOR_C.confirmationIndices);
    expect(bytesToHex(opened.result.packageIdentity)).toBe(VECTOR_C.packageIdentity);
  });

  it("is deterministic — sealing twice with the same eseed gives the same bytes", async () => {
    const a = await sealVector();
    const b = await sealVector();
    expect(bytesToHex(a.packageBytes)).toBe(bytesToHex(b.packageBytes));
  });

  it("is randomized without the test hook — two seals differ", async () => {
    const a = await sealPayloadV1(BODY, KEYS.encapsulationKey, PAYLOAD);
    const b = await sealPayloadV1(BODY, KEYS.encapsulationKey, PAYLOAD);
    expect(bytesToHex(a.packageBytes)).not.toBe(bytesToHex(b.packageBytes));
    // ...and both still open.
    for (const s of [a, b]) {
      const opened = await openPayloadV1(s.packageBytes, BODY, KEYS.decapsulationSeed);
      expect(opened.ok).toBe(true);
    }
  });
});

describe("§19 byte identity — the payload is opaque", () => {
  const cases: Array<[string, Uint8Array]> = [
    ["zero-length", new Uint8Array(0)],
    ["one byte", Uint8Array.from([0x00])],
    ["all-zero 4 KiB", new Uint8Array(4096)],
    ["all-0xff 1 KiB", new Uint8Array(1024).fill(0xff)],
    ["every byte value", Uint8Array.from({ length: 256 }, (_, i) => i)],
    ["invalid UTF-8", Uint8Array.from([0xff, 0xfe, 0xc0, 0x80, 0xed, 0xa0, 0x80])],
    ["JSON-looking text", new TextEncoder().encode('{"a": 1}\r\n{"b": 2}\n')],
    ["a block boundary (16 B)", new Uint8Array(16).fill(0x5a)],
    ["one under a block (15 B)", new Uint8Array(15).fill(0x5a)],
    ["one over a block (17 B)", new Uint8Array(17).fill(0x5a)],
    ["64 KiB of counted bytes", Uint8Array.from({ length: 65536 }, (_, i) => (i * 31) & 0xff)]
  ];

  for (const [name, payload] of cases) {
    it(`round-trips ${name} byte for byte`, async () => {
      const sealed = await sealPayloadV1(BODY, KEYS.encapsulationKey, payload);
      const opened = await openPayloadV1(sealed.packageBytes, BODY, KEYS.decapsulationSeed);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(opened.result.payload.length).toBe(payload.length);
      expect(bytesToHex(opened.result.payload)).toBe(bytesToHex(payload));
    });
  }

  it("refuses a payload above 16 MiB rather than truncating it", async () => {
    // Allocated lazily so the suite does not carry 16 MiB around for nothing.
    const oversize = new Uint8Array(MAX_PLAINTEXT_BYTES + 1);
    await expect(sealPayloadV1(BODY, KEYS.encapsulationKey, oversize)).rejects.toThrow(RangeError);
  });
});

describe("§20 caller input ownership", () => {
  it("seal does not mutate the request body, the public key, or the payload", async () => {
    const body = Uint8Array.from(BODY);
    const pk = Uint8Array.from(KEYS.encapsulationKey);
    const payload = Uint8Array.from(PAYLOAD);
    const before = [bytesToHex(body), bytesToHex(pk), bytesToHex(payload)];
    await sealPayloadV1(body, pk, payload, derand);
    expect([bytesToHex(body), bytesToHex(pk), bytesToHex(payload)]).toEqual(before);
  });

  it("open does not mutate the package bytes, the request body, or the seed", async () => {
    const sealed = await sealVector();
    const pkg = Uint8Array.from(sealed.packageBytes);
    const body = Uint8Array.from(BODY);
    const seed = Uint8Array.from(KEYS.decapsulationSeed);
    const before = [bytesToHex(pkg), bytesToHex(body), bytesToHex(seed)];
    await openPayloadV1(pkg, body, seed);
    expect([bytesToHex(pkg), bytesToHex(body), bytesToHex(seed)]).toEqual(before);
  });

  it("the opened payload is the caller's, not a view the module later wipes", async () => {
    const sealed = await sealVector();
    const opened = await openPayloadV1(sealed.packageBytes, BODY, KEYS.decapsulationSeed);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // A second open must not disturb the first result.
    const again = await openPayloadV1(sealed.packageBytes, BODY, KEYS.decapsulationSeed);
    expect(again.ok).toBe(true);
    expect(bytesToHex(opened.result.payload)).toBe(bytesToHex(PAYLOAD));
  });
});

describe("cryptographic falsification", () => {
  async function tamper(edit: (bytes: Uint8Array) => void) {
    const sealed = await sealVector();
    const copy = Uint8Array.from(sealed.packageBytes);
    edit(copy);
    return openPayloadV1(copy, BODY, KEYS.decapsulationSeed);
  }

  it("refuses the wrong recipient key", async () => {
    const other = generateKeyPairDerand(new Uint8Array(32).fill(0x7f));
    const sealed = await sealVector();
    const opened = await openPayloadV1(sealed.packageBytes, BODY, other.decapsulationSeed);
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.reason).toBe("cryptographic-open-failed");
  });

  it("refuses an altered ciphertext", async () => {
    const opened = await tamper((b) => (b[TPS2_HEADER_BYTES] ^= 0x01));
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.reason).toBe("cryptographic-open-failed");
  });

  it("refuses an altered tag", async () => {
    const opened = await tamper((b) => (b[b.length - 1] ^= 0x01));
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.reason).toBe("cryptographic-open-failed");
  });

  it("refuses an altered KEM ciphertext", async () => {
    const opened = await tamper((b) => (b[TPS2_OFFSETS.kemCiphertext] ^= 0x01));
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.reason).toBe("cryptographic-open-failed");
  });

  it("refuses an altered nonce — the AAD covers it", async () => {
    const opened = await tamper((b) => (b[TPS2_OFFSETS.nonce] ^= 0x01));
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.reason).toBe("cryptographic-open-failed");
  });

  it("refuses a package whose requestId or requestHash names another request", async () => {
    for (const offset of [TPS2_OFFSETS.requestId, TPS2_OFFSETS.requestHash]) {
      const opened = await tamper((b) => (b[offset] ^= 0x01));
      expect(opened.ok).toBe(false);
      if (opened.ok) return;
      expect(opened.reason).toBe("request-mismatch");
    }
  });

  it("refuses a package presented against a DIFFERENT request body", async () => {
    const sealed = await sealVector();
    const otherBody = encodeRequestBody(new Uint8Array(16).fill(0x99), KEYS.encapsulationKey);
    const opened = await openPayloadV1(sealed.packageBytes, otherBody, KEYS.decapsulationSeed);
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.reason).toBe("request-mismatch");
  });

  it("reports decapsulation failure and AEAD failure as ONE outcome", async () => {
    // §11: no decapsulation oracle. A wrong key and a flipped tag must be
    // indistinguishable from outside.
    const other = generateKeyPairDerand(new Uint8Array(32).fill(0x7f));
    const sealed = await sealVector();
    const wrongKey = await openPayloadV1(sealed.packageBytes, BODY, other.decapsulationSeed);
    const badTag = await tamper((b) => (b[b.length - 1] ^= 0x01));
    expect(wrongKey.ok).toBe(false);
    expect(badTag.ok).toBe(false);
    if (wrongKey.ok || badTag.ok) return;
    expect(wrongKey.reason).toBe(badTag.reason);
    expect(wrongKey.message).toBe(badTag.message);
  });

  it("the derived-nonce check is DISTINCT and fires after AEAD verification", async () => {
    // Forge a package that verifies but carries a nonce the payload does not
    // derive: seal normally, then re-run the AEAD under the same (wrong) nonce
    // so the tag is valid. This is the bug class §7.4 says would otherwise be
    // silent — a wrong DS_PAD length octet forking the nonce between builds.
    const enc = encapsulateDerand(KEYS.encapsulationKey, hx(ESEED));
    const rh = await requestFingerprint(BODY);
    const wrongNonce = hx("000000000000000000000000");
    const { buildHeader } = await import("../src/spt/sealed-package");
    const header = buildHeader({
      requestId: BODY.slice(3, 19),
      requestHash: rh,
      kemCiphertext: enc.ciphertext,
      nonce: wrongNonce,
      plaintextLength: PAYLOAD.length
    });
    const keyBytes = await deriveAeadKeyBytes(enc.sharedSecret, rh, header);
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
    const body = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: wrongNonce, additionalData: header, tagLength: AEAD_TAG_BYTES * 8 },
        key,
        PAYLOAD
      )
    );
    const forged = new Uint8Array(header.length + body.length);
    forged.set(header, 0);
    forged.set(body, header.length);
    const opened = await openPayloadV1(forged, BODY, KEYS.decapsulationSeed);
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.reason).toBe("derived-nonce-mismatch");
    // ...and NOT folded into the AEAD outcome.
    expect(opened.reason).not.toBe("cryptographic-open-failed");
  });

  it("the confirmation value changes when the authenticated package changes", async () => {
    const a = await sealVector();
    const other = await sealPayloadV1(BODY, KEYS.encapsulationKey, Uint8Array.from([9, 9, 9]), derand);
    expect(bytesToHex(other.confirmValue)).not.toBe(bytesToHex(a.confirmValue));
    expect(other.confirmationIndices).not.toEqual(a.confirmationIndices);
  });

  it("structural refusals reach openPayloadV1 with their own reasons", async () => {
    const sealed = await sealVector();
    const trailing = new Uint8Array([...sealed.packageBytes, 0]);
    const opened = await openPayloadV1(trailing, BODY, KEYS.decapsulationSeed);
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.reason).toBe("length-mismatch");

    const oversize = Uint8Array.from(sealed.packageBytes);
    writeUint64BE(oversize, TPS2_OFFSETS.plaintextLength, BigInt(MAX_PLAINTEXT_BYTES) + 1n);
    const big = await openPayloadV1(oversize, BODY, KEYS.decapsulationSeed);
    expect(big.ok).toBe(false);
    if (big.ok) return;
    expect(big.reason).toBe("declared-length-too-large");
  });

  it("a low-order ct_X is refused, and indistinguishably from an AEAD failure", async () => {
    /* The library's one divergence from the frozen construction (§2.2 adds no
     * all-zero X25519 check; @noble/post-quantum throws on one, and the
     * independent rxwing 0.1.0-draft10 returns a shared secret). This pins the
     * PROTOCOL-level consequence: openPayloadV1 maps the throw to the same
     * single outcome an AEAD rejection produces — which is what the frozen
     * construction would also reach, since an attacker who cannot compute ss
     * cannot produce a valid tag. The divergence is therefore not observable
     * at this boundary. See docs/SEALED-PAD-TRANSFER-VALIDATION.md.
     */
    const lowOrder = await tamper((b) => b.set(new Uint8Array(32), TPS2_OFFSETS.kemCiphertext + 1088));
    const badTag = await tamper((b) => (b[b.length - 1] ^= 0x01));
    expect(lowOrder.ok).toBe(false);
    expect(badTag.ok).toBe(false);
    if (lowOrder.ok || badTag.ok) return;
    expect(lowOrder.reason).toBe("cryptographic-open-failed");
    expect(lowOrder.message).toBe(badTag.message);
  });

  it("packageIdentity distinguishes packages with the same AAD", async () => {
    const a = await sealVector();
    const tweaked = Uint8Array.from(a.packageBytes);
    tweaked[TPS2_HEADER_BYTES] ^= 0x01; // ciphertext only; AAD untouched
    expect(bytesToHex(await packageIdentity(tweaked))).not.toBe(bytesToHex(a.packageIdentity));
    const tagOnly = Uint8Array.from(a.packageBytes);
    tagOnly[tagOnly.length - 1] ^= 0x01; // tag only; AAD and ciphertext untouched
    expect(bytesToHex(await packageIdentity(tagOnly))).not.toBe(bytesToHex(a.packageIdentity));
  });
});

/* ==========================================================================
 * VECTOR D — a REAL existing-format genesis pad bundle
 * --------------------------------------------------------------------------
 * The bytes `packContainer()` actually produces, sealed and reopened through
 * the low-level layer, compared byte for byte. `importImpl` is NOT called: this
 * phase implements no courier integration, and the invariant under test is
 * only that the transfer layer is transparent to the exact container bytes.
 * ======================================================================== */

let idSeq = 1;
async function send(vfs: MemoryVfs, req: Omit<EngineRequest, "id">): Promise<EngineResponse> {
  return handle(vfs, { ...req, id: idSeq++ } as EngineRequest);
}

describe("VECTOR D — a real packContainer bundle", () => {
  it("seals and reopens the exact container bytes", async () => {
    const vfs = new MemoryVfs();
    const gen = await send(vfs, {
      op: "gen",
      label: "spt vector D",
      sources: [{ name: "src.bin", declaredOrigin: "test material, operator-asserted", bytes: new Uint8Array(4096).fill(0x5c) }],
      encryptionBytes: 1024,
      authRecords: 8,
      witnessClass: "browser-none"
    } as Omit<EngineRequest, "id">);
    if (!gen.ok || gen.op !== "gen") throw new Error(`gen failed: ${JSON.stringify(gen)}`);
    const pairId = gen.pair.pairId;

    const exported = await send(vfs, { op: "export-pair", pairId } as Omit<EngineRequest, "id">);
    if (!exported.ok || exported.op !== "export-pair") throw new Error("export failed");
    const container = exported.container;

    // It really is the existing format: six files, the frozen set.
    const unpacked = unpackContainer(container);
    expect(unpacked.ok).toBe(true);
    if (!unpacked.ok) return;
    expect(unpacked.files.map((f) => f.path).sort()).toEqual([
      "a-to-b/head.json",
      "a-to-b/journal.log",
      "a-to-b/secret.bin",
      "b-to-a/head.json",
      "b-to-a/journal.log",
      "b-to-a/secret.bin"
    ]);

    const before = bytesToHex(container);
    const sealed = await sealPayloadV1(BODY, KEYS.encapsulationKey, container);
    const opened = await openPayloadV1(sealed.packageBytes, BODY, KEYS.decapsulationSeed);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // The invariant that outranks everything: byte for byte, no normalization,
    // no JSON reserialization, no pairId or witness rewrite.
    expect(opened.result.payload.length).toBe(container.length);
    expect(bytesToHex(opened.result.payload)).toBe(before);
    // ...and the container the engine handed us was not disturbed.
    expect(bytesToHex(container)).toBe(before);
    // The unpacked view of the reopened bytes is the same bundle.
    const reunpacked = unpackContainer(opened.result.payload);
    expect(reunpacked.ok).toBe(true);
    if (!reunpacked.ok) return;
    expect(reunpacked.pairId).toBe(unpacked.pairId);
    expect(sealed.packageBytes.length).toBe(TPS2_FIXED_OVERHEAD_BYTES + container.length);
  });
});
