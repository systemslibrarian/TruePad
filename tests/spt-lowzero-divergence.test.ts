import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { sha3_256 } from "@noble/hashes/sha3.js";

import { bytesToHex } from "../src/core/hex";
import { hx } from "./helpers/spt-hex";
import { concatBytes } from "../src/spt/bytes";
import {
  AEAD_TAG_BYTES,
  MLKEM_CIPHERTEXT_BYTES,
  MLKEM_PUBLIC_KEY_BYTES,
  TPS2_OFFSETS,
  X25519_BYTES
} from "../src/spt/constants";
import {
  deriveAeadKeyBytes,
  deriveConfirmValue,
  deriveNonce,
  derivePadHash,
  openPayloadV1,
  sealPayloadV1
} from "../src/spt/crypto-v1";
import { requestFingerprint } from "../src/spt/fingerprint";
import { encodeRequestBody } from "../src/spt/receive-request";
import { buildHeader } from "../src/spt/sealed-package";
import { decapsulate, encapsulateDerand, generateKeyPairDerand } from "../src/spt/xwing-v1";

/* ============================================================================
 * THE ACCEPTED LOW-ORDER X25519 DIVERGENCE
 * ----------------------------------------------------------------------------
 * DECISION: keep @noble/post-quantum 0.7.1 and ACCEPT its stricter rejection.
 * These tests pin that decision so a dependency change cannot alter it quietly.
 *
 * Three facts that must coexist, none of which cancels the others:
 *
 *   A. draft-connolly-cfrg-xwing-kem-10 defines Decapsulate as
 *      `ss_X = X25519(sk_X, ct_X)` and specifies no all-zero abort; its
 *      machine-readable X25519 returns the resulting u-coordinate.
 *
 *   B. RFC 7748 §6.1 explicitly permits an implementation to check for an
 *      all-zero X25519 output and abort. Noble's X25519 is therefore a
 *      CONFORMING RFC 7748 implementation, exercising a permitted policy.
 *
 *   C. TruePad's selected dependency inherits that stricter rejection. Honest
 *      encapsulations stay byte-compatible and every reference vector still
 *      matches; ADVERSARIAL low-order ct_X inputs are a documented
 *      decapsulation-behaviour divergence.
 *
 * PRODUCTION CODE GAINS NOTHING FROM THIS FILE. The draft-10 combiner below is
 * written in TEST CODE ONLY, to construct the adversarial fixture. `src/spt`
 * has no combiner of its own and must never grow one.
 * ========================================================================= */

/** TEST VECTOR — NOT SECRET — NEVER PRODUCTION MATERIAL */
const BOB_SEED = "4242424242424242424242424242424242424242424242424242424242424242";
/** TEST VECTOR — NOT SECRET — NEVER PRODUCTION MATERIAL */
const ESEED = Array.from({ length: 64 }, (_, i) => i.toString(16).padStart(2, "0")).join("");

const BOB = generateKeyPairDerand(hx(BOB_SEED));
const REQUEST_ID = new Uint8Array(16).fill(0x33);
const BODY = encodeRequestBody(REQUEST_ID, BOB.encapsulationKey);
const PAYLOAD = new TextEncoder().encode("a pad Mallory would like Bob to accept");

/** The X-Wing label, `\.//^\` — six bytes. */
const XWING_LABEL = Uint8Array.from([0x5c, 0x2e, 0x2f, 0x2f, 0x5e, 0x5c]);

/** TEST ONLY. §2.2's `Combiner`, transcribed here so the fixture below can be
 *  built. Nothing in `src/spt` computes this; the production build gets its
 *  shared secret from the KEM and only from the KEM. */
function draft10Combiner(ssM: Uint8Array, ssX: Uint8Array, ctX: Uint8Array, pkX: Uint8Array): Uint8Array {
  return sha3_256(concatBytes(ssM, ssX, ctX, pkX, XWING_LABEL));
}

describe("case 1 — low-order TAMPER of an existing honest package", () => {
  /* The narrow case. An honest package is sealed, then its ct_X is replaced
   * with a low-order point and NOTHING ELSE is changed. Here the tamperer does
   * not know the honest package's ss_M, so under draft-10's behaviour the
   * recombined secret is one they cannot predict and the AEAD tag fails anyway.
   *
   * This is the case the Phase 1A test covered — and, on its own, it is NOT a
   * general argument that both behaviours refuse. Case 2 is why. */
  it("noble throws at the X25519 layer", () => {
    const enc = encapsulateDerand(BOB.encapsulationKey, hx(ESEED));
    const tampered = Uint8Array.from(enc.ciphertext);
    tampered.set(new Uint8Array(X25519_BYTES), MLKEM_CIPHERTEXT_BYTES);
    expect(() => decapsulate(tampered, BOB.decapsulationSeed)).toThrow();
  });

  it("openPayloadV1 refuses it, with the AEAD failure's reason and message", async () => {
    const sealed = await sealPayloadV1(BODY, PAYLOAD, { eseedForVectorsOnly: hx(ESEED) });
    const lowOrder = Uint8Array.from(sealed.packageBytes);
    lowOrder.set(new Uint8Array(X25519_BYTES), TPS2_OFFSETS.kemCiphertext + MLKEM_CIPHERTEXT_BYTES);
    const badTag = Uint8Array.from(sealed.packageBytes);
    badTag[badTag.length - 1] ^= 0x01;

    const a = await openPayloadV1(lowOrder, BODY, BOB.decapsulationSeed);
    const b = await openPayloadV1(badTag, BODY, BOB.decapsulationSeed);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (a.ok || b.ok) return;
    expect(a.reason).toBe("cryptographic-open-failed");
    // The PUBLIC API exposes the same reason and the same message. That is the
    // whole claim: no typed decapsulation oracle. It is NOT a claim that the
    // two internal paths are constant-time or timing-indistinguishable — they
    // execute different code, and nothing here measures that.
    expect(a.reason).toBe(b.reason);
    expect(a.message).toBe(b.message);
  });
});

describe("case 2 — a MALICIOUS SENDER, who knows ss_M", () => {
  /* The general case, and the one that shows "both implementations refuse" was
   * false. Mallory does not tamper with someone else's package; he builds his
   * own:
   *
   *   1. run a valid ML-KEM-768 encapsulation to Bob's pk_M — the encapsulation
   *      key is PUBLIC, so anyone may — and KEEP ss_M;
   *   2. choose ct_X = a low-order point, for which draft-10's X25519 yields
   *      all-zero for every scalar;
   *   3. compute ss = Combiner(ss_M, 0^32, ct_X, pk_X) — every input known;
   *   4. build a genuinely valid TPS2 package under that ss.
   *
   * A draft-10 implementation that does not abort will derive the same ss, and
   * the AEAD will verify. Noble aborts first. */

  const zero32 = new Uint8Array(32);
  const pkM = BOB.encapsulationKey.subarray(0, MLKEM_PUBLIC_KEY_BYTES);
  const pkX = BOB.encapsulationKey.subarray(MLKEM_PUBLIC_KEY_BYTES);
  // The ML-KEM coins Mallory chooses. TEST ONLY — a real Mallory draws them.
  const mlkemCoins = hx(ESEED).subarray(0, 32);
  const mEnc = ml_kem768.encapsulate(pkM, mlkemCoins);
  const ctX = zero32; // the all-zero u-coordinate: X25519(k, 0) = 0 for all k
  const ct = concatBytes(mEnc.cipherText, ctX);
  const forgedSharedSecret = draft10Combiner(mEnc.sharedSecret, zero32, ctX, pkX);

  /** Build a valid TPS2 package under a shared secret we supply, using ONLY
   *  TruePad's own §7.3/§7.4 derivations and WebCrypto. Nothing bespoke. */
  async function forgePackage() {
    const requestHash = await requestFingerprint(BODY);
    const padHash = await derivePadHash(PAYLOAD);
    const nonce = await deriveNonce(forgedSharedSecret, requestHash, padHash);
    const header = buildHeader({
      requestId: REQUEST_ID,
      requestHash,
      kemCiphertext: ct,
      nonce,
      plaintextLength: PAYLOAD.length
    });
    const keyBytes = await deriveAeadKeyBytes(forgedSharedSecret, requestHash, header);
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
    const body = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: header, tagLength: AEAD_TAG_BYTES * 8 },
        key,
        PAYLOAD
      )
    );
    return { package: concatBytes(header, body), header, nonce, key, requestHash };
  }

  it("A — the reference path derives exactly the shared secret rxwing produces", () => {
    // The in-test combiner is not trusted on its own. This value was produced
    // by rxwing 0.1.0-draft10, an INDEPENDENT draft-10 implementation, running
    // its real Decapsulate on this exact ciphertext with Bob's seed. If the
    // transcription above were wrong, this would not match.
    expect(bytesToHex(forgedSharedSecret)).toBe(
      "b5783bcbcabd3fc72910d002367cd1dde4e40a039410ffb2298843bf5657a457"
    );
    // ...and it is genuinely the low-order case: ss_X is the all-zero value.
    expect(bytesToHex(ctX)).toBe("00".repeat(32));
    expect(ct.length).toBe(MLKEM_CIPHERTEXT_BYTES + X25519_BYTES);
  });

  it("A′ — ss_M really is known to the sender, which is what breaks the old argument", () => {
    // The encapsulation key is public, so anyone can run this and keep ss_M.
    // The old wording said the attacker "cannot predict that shared secret";
    // every input to the combiner here is either public or chosen by Mallory.
    const again = ml_kem768.encapsulate(pkM, mlkemCoins);
    expect(bytesToHex(again.sharedSecret)).toBe(bytesToHex(mEnc.sharedSecret));
    expect(bytesToHex(draft10Combiner(again.sharedSecret, zero32, ctX, pkX))).toBe(
      bytesToHex(forgedSharedSecret)
    );
  });

  it("B — the AEAD tag is genuinely valid under that secret", async () => {
    const forged = await forgePackage();
    // Decrypt it with the same derived key: if the tag were not valid, this
    // throws. So a draft-10 implementation reaching the AEAD would accept.
    const opened = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: forged.nonce,
          additionalData: forged.header,
          tagLength: AEAD_TAG_BYTES * 8
        },
        forged.key,
        forged.package.subarray(forged.header.length)
      )
    );
    expect(bytesToHex(opened)).toBe(bytesToHex(PAYLOAD));
    // The derived-nonce check would pass too, so nothing downstream saves us.
    const padHash = await derivePadHash(opened);
    const expected = await deriveNonce(forgedSharedSecret, forged.requestHash, padHash);
    expect(bytesToHex(expected)).toBe(bytesToHex(forged.nonce));
    // ...and the confirmation value is computable, i.e. Mallory could read words.
    const confirm = await deriveConfirmValue(forgedSharedSecret, forged.requestHash, forged.header);
    expect(confirm.length).toBe(11);
  });

  it("C — TruePad rejects it, because noble's X25519 aborts before the AEAD path", async () => {
    const forged = await forgePackage();
    const opened = await openPayloadV1(forged.package, BODY, BOB.decapsulationSeed);
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.reason).toBe("cryptographic-open-failed");
    // The decapsulation itself is where it stops.
    expect(() => decapsulate(ct, BOB.decapsulationSeed)).toThrow();
  });

  it("does not make TruePad stricter about anything that authenticates ALICE", async () => {
    /* Why case 2 is not a break, and why noble's rejection must not be promoted
     * into an identity claim.
     *
     * A KEM encapsulation key is PUBLIC. Any sender can already run an HONEST
     * XWing.Encaps(Bob.pk) and know the resulting shared secret — no low-order
     * trick needed. X-Wing does not authenticate the sender, and never claimed
     * to. "Bob can decrypt it" has never meant "Alice sent it"; that is exactly
     * why §8's human confirmation ceremony exists.
     *
     * So Mallory can manufacture an openable package either way. What he cannot
     * do is make Alice read HIS confirmation words. Noble's low-order rejection
     * is stricter INPUT ACCEPTANCE, not sender authentication. */
    const mallory = generateKeyPairDerand(new Uint8Array(32).fill(0x99));
    void mallory;
    // An entirely honest Mallory package for Bob's request: no low-order trick,
    // and Bob CAN open it. Openability was never the authentication.
    const honestMallory = await sealPayloadV1(BODY, new TextEncoder().encode("Mallory's pad"));
    const opened = await openPayloadV1(honestMallory.packageBytes, BODY, BOB.decapsulationSeed);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // ...and its confirmation words differ from Alice's for the same request,
    // which is the check that actually catches him (§8.2).
    const alice = await sealPayloadV1(BODY, PAYLOAD);
    const aliceOpened = await openPayloadV1(alice.packageBytes, BODY, BOB.decapsulationSeed);
    expect(aliceOpened.ok).toBe(true);
    if (!aliceOpened.ok) return;
    expect(opened.result.confirmationIndices).not.toEqual(aliceOpened.result.confirmationIndices);
  });
});

describe("the accepted exception is pinned", () => {
  const VECTORS = JSON.parse(
    readFileSync(join(resolve(__dirname, "fixtures"), "xwing-draft10-appendix-c.json"), "utf8")
  ) as Array<{ seed: string; pk: string; eseed: string; ct: string; ss: string }>;

  it("ordinary draft-10 vectors still match, so the exception is narrow", () => {
    // If a future noble version changed anything about the HONEST path, this
    // fails first and the divergence discussion is moot.
    for (const v of VECTORS) {
      const kp = generateKeyPairDerand(hx(v.seed));
      expect(bytesToHex(kp.encapsulationKey)).toBe(v.pk);
      const enc = encapsulateDerand(hx(v.pk), hx(v.eseed));
      expect(bytesToHex(enc.ciphertext)).toBe(v.ct);
      expect(bytesToHex(enc.sharedSecret)).toBe(v.ss);
      expect(bytesToHex(decapsulate(hx(v.ct), hx(v.seed)))).toBe(v.ss);
    }
  });

  it("noble STILL rejects the low-order case — if this fails, re-audit deliberately", () => {
    /* THIS TEST FAILING IS NOT A BUG IN THE TEST.
     *
     * It means the pinned dependency changed its X25519 policy and now returns
     * a combined secret where it used to abort. That would move TruePad onto
     * the draft-10 behaviour without anyone deciding to, and it would make the
     * forged package in case 2 OPENABLE. Re-audit §6 of
     * docs/SEALED-PAD-TRANSFER-VALIDATION.md before changing this. */
    const enc = encapsulateDerand(BOB.encapsulationKey, hx(ESEED));
    const lowOrder = Uint8Array.from(enc.ciphertext);
    lowOrder.set(new Uint8Array(X25519_BYTES), MLKEM_CIPHERTEXT_BYTES);
    expect(() => decapsulate(lowOrder, BOB.decapsulationSeed)).toThrow();
  });

  it("the divergence is confined to X25519 decapsulation, not to keygen or encapsulation", () => {
    // Same seed, same key pair; same eseed, same ciphertext and secret. The
    // exception touches only what Decapsulate does with a hostile ct_X.
    const a = generateKeyPairDerand(hx(BOB_SEED));
    expect(bytesToHex(a.encapsulationKey)).toBe(bytesToHex(BOB.encapsulationKey));
    const e1 = encapsulateDerand(BOB.encapsulationKey, hx(ESEED));
    const e2 = encapsulateDerand(BOB.encapsulationKey, hx(ESEED));
    expect(bytesToHex(e1.ciphertext)).toBe(bytesToHex(e2.ciphertext));
    // ...and an honest ciphertext decapsulates normally.
    expect(bytesToHex(decapsulate(e1.ciphertext, BOB.decapsulationSeed))).toBe(bytesToHex(e1.sharedSecret));
  });

  it("production code has no combiner of its own", () => {
    // The draft-10 combiner in this file is TEST code. If `src/spt` ever grows
    // one, the suite has stopped being "whatever the audited library does".
    const root = resolve(__dirname, "..", "src", "spt");
    for (const file of ["crypto-v1.ts", "xwing-v1.ts", "index.ts", "fingerprint.ts", "hkdf.ts"]) {
      const source = readFileSync(join(root, file), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, `${file} must not compute the X-Wing combiner`).not.toMatch(/sha3_256|shake256|5c2e2f2f5e5c/);
    }
  });
});
