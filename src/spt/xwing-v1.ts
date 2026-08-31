/* ============================================================================
 * X-Wing (suite 0x0001) — the narrow TruePad wrapper
 * ----------------------------------------------------------------------------
 * docs/SEALED-PAD-TRANSFER.md §2.2 freezes the WHOLE of
 * draft-connolly-cfrg-xwing-kem-10 as suite 0x0001. This file does not
 * implement it; it wraps @noble/post-quantum's `ml_kem768_x25519`, whose
 * construction was audited byte-for-byte against that freeze and validated
 * against the draft's own Appendix C vectors and an independent draft-10
 * implementation. docs/SEALED-PAD-TRANSFER-VALIDATION.md records the audit,
 * the versions, and the one behavioural divergence found.
 *
 * What this wrapper is FOR, given the library already exposes a KEM:
 *
 *   · it pins the sizes, so a library change that altered any of them fails
 *     here rather than three layers up;
 *   · it fixes TruePad's persisted private key as the 32-byte X-Wing SEED and
 *     never an expanded, implementation-specific key structure — §12 of the
 *     Phase 1A brief, and the reason a recipient key stays portable across any
 *     conforming X-Wing implementation;
 *   · it keeps the derandomized entry points visibly separate from the
 *     production ones (see the TEST-ONLY banner below).
 *
 * It adds NO cryptography. There is no TruePad combiner, no extra KDF, no
 * additional validation, and no all-zero X25519 policy of our own: adding any
 * of those would take suite 0x0001 outside the construction that was analysed,
 * which §2.2 refuses in terms.
 * ========================================================================= */

import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import {
  XWING_CIPHERTEXT_BYTES,
  XWING_ESEED_BYTES,
  XWING_PUBLIC_KEY_BYTES,
  XWING_SEED_BYTES,
  XWING_SHARED_SECRET_BYTES
} from "./constants.ts";

export type XWingKeyPair = {
  /** The 32-byte X-Wing seed. THIS is the recipient's private key: §12 of the
   *  Phase 1A brief, and §10.1's `dk`. Everything else is re-derivable. */
  decapsulationSeed: Uint8Array;
  encapsulationKey: Uint8Array;
};

export type XWingEncapsulation = {
  ciphertext: Uint8Array;
  sharedSecret: Uint8Array;
};

function requireLength(bytes: Uint8Array, expected: number, what: string): void {
  if (!(bytes instanceof Uint8Array)) throw new TypeError(`${what}: expected Uint8Array`);
  if (bytes.length !== expected) {
    throw new RangeError(`${what}: expected ${expected} bytes, got ${bytes.length}`);
  }
}

/** Production key generation. Randomness comes from the library's platform
 *  CSPRNG; §13 forbids a seed argument on this path. */
export function generateKeyPair(): XWingKeyPair {
  const { secretKey, publicKey } = ml_kem768_x25519.keygen();
  requireLength(secretKey, XWING_SEED_BYTES, "decapsulationSeed");
  requireLength(publicKey, XWING_PUBLIC_KEY_BYTES, "encapsulationKey");
  return { decapsulationSeed: secretKey, encapsulationKey: publicKey };
}

/** Production encapsulation. Randomness comes from the library's platform
 *  CSPRNG; §13 forbids a seed argument on this path. */
export function encapsulate(encapsulationKey: Uint8Array): XWingEncapsulation {
  requireLength(encapsulationKey, XWING_PUBLIC_KEY_BYTES, "encapsulationKey");
  const { cipherText, sharedSecret } = ml_kem768_x25519.encapsulate(encapsulationKey);
  requireLength(cipherText, XWING_CIPHERTEXT_BYTES, "ciphertext");
  requireLength(sharedSecret, XWING_SHARED_SECRET_BYTES, "sharedSecret");
  return { ciphertext: cipherText, sharedSecret };
}

export function decapsulate(ciphertext: Uint8Array, decapsulationSeed: Uint8Array): Uint8Array {
  requireLength(ciphertext, XWING_CIPHERTEXT_BYTES, "ciphertext");
  requireLength(decapsulationSeed, XWING_SEED_BYTES, "decapsulationSeed");
  const sharedSecret = ml_kem768_x25519.decapsulate(ciphertext, decapsulationSeed);
  requireLength(sharedSecret, XWING_SHARED_SECRET_BYTES, "sharedSecret");
  return sharedSecret;
}

/* ==========================================================================
 * TEST-ONLY DERANDOMIZED SURFACES
 * --------------------------------------------------------------------------
 * §2.2's `GenerateKeyPairDerand` and `EncapsulateDerand`, marked in the frozen
 * document itself as "for test vectors ONLY". They exist so this build can be
 * checked against draft-10's Appendix C vectors and against an independent
 * implementation. A production caller that reaches for one of these has
 * replaced a CSPRNG with a value someone chose, which for a KEM means the
 * shared secret is chosen too.
 *
 * They are not exported from index.ts. Nothing outside tests may import them.
 * ======================================================================== */

/** TEST ONLY — see the banner above. */
export function generateKeyPairDerand(seed: Uint8Array): XWingKeyPair {
  requireLength(seed, XWING_SEED_BYTES, "seed");
  const { secretKey, publicKey } = ml_kem768_x25519.keygen(seed);
  requireLength(publicKey, XWING_PUBLIC_KEY_BYTES, "encapsulationKey");
  return { decapsulationSeed: secretKey, encapsulationKey: publicKey };
}

/** TEST ONLY — see the banner above. `eseed` is 64 bytes: [0,32) are the
 *  ML-KEM-768 coins, [32,64) the X25519 ephemeral scalar (§2.2). */
export function encapsulateDerand(encapsulationKey: Uint8Array, eseed: Uint8Array): XWingEncapsulation {
  requireLength(encapsulationKey, XWING_PUBLIC_KEY_BYTES, "encapsulationKey");
  requireLength(eseed, XWING_ESEED_BYTES, "eseed");
  const { cipherText, sharedSecret } = ml_kem768_x25519.encapsulate(encapsulationKey, eseed);
  requireLength(cipherText, XWING_CIPHERTEXT_BYTES, "ciphertext");
  requireLength(sharedSecret, XWING_SHARED_SECRET_BYTES, "sharedSecret");
  return { ciphertext: cipherText, sharedSecret };
}
