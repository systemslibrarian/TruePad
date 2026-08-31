# Sealed Pad Transfer — cryptographic validation record

**Phase 1A. Recorded 2026-08-30.**

What this file is: the evidence behind the claim that TruePad's suite `0x0001`
implementation is the construction `docs/SEALED-PAD-TRANSFER.md` §2.2 froze. It
records versions, hashes, what was checked, and what was found — including one
divergence. It makes no claim beyond what was executed.

---

## 1. What is validated, and what is not

| | |
| --- | --- |
| Frozen TruePad suite | `0x0001` |
| Defined by | `docs/SEALED-PAD-TRANSFER.md` §2.2, which freezes the whole of draft-connolly-cfrg-xwing-kem-10 |
| Draft status | Internet-Draft, revision **10**, 2 March 2026, expires 3 September 2026. Independent Submission stream. **Not CFRG-adopted. Not an RFC.** |
| Implemented in this phase | X-Wing wrapper, TPR2 codec, TPS2 codec, HKDF schedule, AES-256-GCM, fingerprints, reference vectors |
| **Not** implemented in this phase | persisted receive requests, sender handoff enforcement, provenance enforcement, receive state machine, cross-tab session, Browser UI, courier integration, CLI verbs |

This is **not** a NIST CAVP validation, not a FIPS validation, and not an audit.
It is a conformance and cross-implementation check that was run and whose
results are written down.

---

## 2. Production implementation

| | |
| --- | --- |
| Package | `@noble/post-quantum` |
| Version | **0.7.1**, pinned exactly (no caret, no tilde) |
| Export used | `ml_kem768_x25519` from `@noble/post-quantum/hybrid.js` |
| npm integrity | `sha512-+P9981IiAnVh+rmcubozzVwrEy3XsN/tMhTnvsjV9VDaYpOnNCqWqKo2FLWxbu92YHfjGIlE5XnW175UK+ln+Q==` |
| npm shasum | `b57156fab2b4661f965d3d2d9776a7dbd1310ff8` |
| `gitHead` in the published manifest | `a23736036d4d5b34dd3a9e0ee312fd43d00154ac` |
| Source | `github.com/paulmillr/noble-post-quantum` |
| License | MIT |

Transitive dependencies, all pinned by `package-lock.json`:

| Package | Version | Integrity |
| --- | --- | --- |
| `@noble/curves` | 2.4.0 | `sha512-P4/62zrgfH33CneE3Dn4WhJVA22YUU0eR51wKIan4NVRvwsA0YnPTwWGpNbpuacSujmSFLvyzpyuR30+fbq2Ew==` |
| `@noble/hashes` | 2.4.0 | `sha512-X5XaVWZIBCT7HHZGm5I7ZQXDwLG+bGXuSrMQAW+7Zvl87h1kmc1ZB1VSRJcpUfoUrGQp4Fkoxm5kZ+Ms+aW+eA==` |
| `@noble/ciphers` | 2.4.0 | `sha512-AnjFn0Jv92laAkvMrghlFZq4qQCIN/4DxFV/eooqtC2YTjB7kBeLMS2T9KJX4Dn+ZVXLOwK0lSgqDtx9gvxtiw==` |

All MIT. This is TruePad's **first and only** production dependency.

---

## 3. Source audit against the frozen construction

The published README says `ml_kem768_x25519` implements X-Wing and tracks
draft-10. That sentence was not taken on trust: `package/src/hybrid.ts` from the
0.7.1 tarball was read, and each frozen element checked against it.

| §2.2 requirement | Found in 0.7.1 | Verdict |
| --- | --- | --- |
| `sk` 32 B, `pk` 1216 B, `ct` 1120 B, `ss` 32 B | `lengths` = `{seed:32, publicKey:1216, secretKey:32, msg:32, msgRand:64, cipherText:1120}` | ✅ |
| Seed expansion SHAKE256(sk, 96) | `expandSeedXof(shake256)` with `seedCoder.bytesLen` = 64 + 32 = 96 | ✅ |
| `d = [0,32)`, `z = [32,64)` | `ml_kem768.keygen(expanded[0:64])`, which is FIPS 203 `KeyGen_internal(d, z)` | ✅ |
| X25519 scalar `= [64,96)` | `x25519kem.keygen(expanded[64:96])` | ✅ |
| `pk = pk_M ‖ pk_X` | `pkCoder.encode([pk_M(1184), pk_X(32)])` | ✅ |
| `ct = ct_M ‖ ct_X` | `ctCoder.encode([ct_M(1088), ct_X(32)])` | ✅ |
| ML-KEM-768 per FIPS 203 | `ml_kem768` from `ml-kem.ts` | ✅ |
| FIPS 203 §7.2 encapsulation-key check in `Encaps` | `ml-kem` raises `wrong publicKey modulus` on a non-canonical `pk_M`; verified empirically | ✅ |
| X25519 per RFC 7748 | `x25519` from `@noble/curves/ed25519.js` | ✅ |
| Combiner `SHA3-256(ss_M ‖ ss_X ‖ ct_X ‖ pk_X ‖ 5c2e2f2f5e5c)` | `sha3_256(concatBytes(ss[0], ss[1], ct[1], pk[1], asciiToBytes('\\.//^\\')))` — that literal is the 6 bytes `5c 2e 2f 2f 5e 5c`; preimage measured at **134 bytes** | ✅ |
| **No** ML-KEM ciphertext in the combiner | `ct[0]` does not appear | ✅ |
| **No** recipient ML-KEM key in the combiner | `pk[0]` does not appear | ✅ |
| **No** extra HKDF inside X-Wing | the preset is `combineKEMS(…, sha3_256 combiner, …)`; the HKDF-bearing `createKitchenSink` preset is a **different** export and is not used | ✅ |
| Deterministic keygen sufficient for vectors | `keygen(seed32)` | ✅ |
| Deterministic encapsulation sufficient for vectors | `encapsulate(pk, eseed64)` | ✅ |
| **No** ad-hoc X25519 all-zero rejection changing draft-10 | **NOT met — see §6** | ❌ |

---

## 4. Layer A — the authoritative draft vectors

Source: `https://www.ietf.org/archive/id/draft-connolly-cfrg-xwing-kem-10.txt`,
Appendix C, extracted verbatim into
`tests/fixtures/xwing-draft10-appendix-c.json` (3 vectors).

| Vector | `pk` from `seed` | `ct` from `eseed` | `ss` | `Decapsulate(ct, sk)` |
| --- | --- | --- | --- | --- |
| 1 | ✅ | ✅ | ✅ | ✅ |
| 2 | ✅ | ✅ | ✅ | ✅ |
| 3 | ✅ | ✅ | ✅ | ✅ |

**All three match byte-for-byte.** Run by `tests/spt-xwing.test.ts`.

> **Vector caveat, recorded not assumed.** Appendix C carries the draft's own
> editorial qualification. Its heading reads, verbatim:
>
> > *"Appendix C. Test vectors # TODO: replace with test vectors that re-use
> > ML-KEM, X25519 values"*
>
> These are provisional Internet-Draft artifacts pending alignment with
> component-algorithm test data. They are **not** a NIST CAVP validation and are
> not presented as one. This is exactly why §2.2.2 also requires an independent
> implementation: a vector that only agrees with itself proves nothing.

---

## 5. Layer C — independent draft-10 implementation

| | |
| --- | --- |
| Implementation | **`rxwing` 0.1.0-draft10** |
| Source | `codeberg.org/handcrafted-security/rxwing` (crates.io) |
| Self-description | *"Minimalist pure Rust implementation of the X-Wing Key Encapsulation Mechanism (draft 10)"*; the README states "Current implementation matches the draft RFC version 10" |
| Built on | `rkyber` (ML-KEM), `x25519-dalek` (X25519) — no shared code with noble |
| Licence | MIT / Apache-2.0 |
| Toolchain | rustc 1.98.0 (Homebrew), cargo 1.98.0 — **audit tool only, outside the production bundle** |

Independence is genuine: different language, different authors, different
underlying ML-KEM and X25519 implementations.

**Excluded candidates, and why.** `xwing-kem` 0.2.0 on PyPI is authored by this
repository's own owner and gives no implementation independence for this gate.
Older RustCrypto `x-wing` releases implement draft-06 and would not be a
draft-10 check at all.

**Harness.** `rxwing` exposes `generate_keypair_derand` / `encaps_derand` only
to its own tests (`mod xwing_internal` is private). The crate source was
vendored and **one line** changed —

```
-mod xwing_internal;
+pub mod xwing_internal;
```

— confirmed by `diff -r` against the registry copy as the only difference. No
algorithm was touched.

**Result**, over 8 deterministic inputs — the 3 draft vectors plus 5 seeds and
eseeds the draft never saw:

| Comparison | Result |
| --- | --- |
| Encapsulation key (`pk`, 1216 B) equal | **8 / 8** |
| KEM ciphertext (`ct`, 1120 B) equal | **8 / 8** |
| Shared secret from encapsulation (`ss`, 32 B) equal | **8 / 8** |
| Shared secret from decapsulation equal | **8 / 8** |
| Both implementations match draft-10 Appendix C | **3 / 3** |

Cross-implementation validation is therefore **claimed, and executed**.

---

## 6. The one divergence found

**`@noble/post-quantum` 0.7.1 rejects an all-zero X25519 shared secret. The
frozen construction does not.**

§2.2 of the specification is explicit:

> *"On the all-zero X25519 result: draft-10 explicitly declines to mandate a
> check, and TruePad does not add one."*

The draft's `Decapsulate` is `ss_X = X25519(sk_X, ct_X)` with no check, and the
draft text contains **no** discussion of all-zero, low-order, or contributory
behaviour anywhere. `@noble/curves` raises `invalid private or public key
received` when X25519 yields zero, and `_ecdhKem` does not suppress it.

Demonstrated, on a ciphertext whose `ct_X` is the all-zero u-coordinate:

| Implementation | Behaviour |
| --- | --- |
| `@noble/post-quantum` 0.7.1 | **throws** `invalid private or public key received` |
| `rxwing` 0.1.0-draft10 | **returns** `ss = b5783bcb…a457` |

So the divergence is real and observable **between implementations**.

**Scope, stated precisely.**

* Reachable only on an attacker-supplied `ct_X` that is a low-order point. An
  honest sender's `ct_X = X25519(ek_X, base)` never is.
* Under **both** behaviours the package is refused. The frozen construction
  would return a shared secret the attacker cannot predict, so the AEAD tag
  fails; noble refuses one step earlier.
* At TruePad's own boundary the difference is **not observable at all**:
  `openPayloadV1` maps a decapsulation throw and an AEAD failure to the single
  outcome `cryptographic-open-failed` with an identical message, which is
  required anyway so the protocol offers no decapsulation oracle (§11).
  `tests/spt-vectors.test.ts` asserts that a low-order `ct_X` and a flipped tag
  are indistinguishable through the API.
* No honest package is affected, and no package is accepted that should not be.

**What was NOT done, deliberately.** The suite was not modified to match the
library. No shim reimplements the X25519 step to restore the frozen behaviour —
that would mean hand-writing part of the KEM and still calling it suite
`0x0001`. No combiner of our own was written.

**Status: an open decision, not a resolved one.** The divergence is recorded
here, pinned by a test (`tests/spt-xwing.test.ts`, "the one behavioural
divergence from the frozen construction") so a library change is noticed, and
carried forward for an explicit accept-or-replace decision. The options are:
accept it and record the exception in §2.2; replace the dependency; or add the
check to §2.2 as a deliberate TruePad-specific deviation, which §2.2 currently
argues against on interoperability grounds — and which the rxwing result above
shows would indeed be an interoperability difference, not a theoretical one.

---

## 7. TruePad-layer vectors

Frozen in `tests/`, all deterministic, all labelled **TEST VECTOR — NOT SECRET
— NEVER PRODUCTION MATERIAL**.

| Vector | What it pins | Where |
| --- | --- | --- |
| **A** | draft-10 Appendix C, all three | `tests/spt-xwing.test.ts` |
| **B** | TPR2 body (1235 B), text (1652 chars), `requestHash`, the twelve 132-bit indices | `tests/spt-receive-request.test.ts` |
| **C** | `ss`, `padHash`, nonce, AAD hash, AEAD key, ciphertext, tag, whole package (1258 B), `packageIdentity`, `confirmValue`, the eight 88-bit indices | `tests/spt-vectors.test.ts` |
| **D** | a real `packContainer()` genesis bundle sealed and reopened byte-for-byte | `tests/spt-vectors.test.ts` |

Measured, not assumed:

| Quantity | Value |
| --- | --- |
| TPR2 body | 1235 bytes |
| TPR2 text | 1652 characters |
| TPS2 header = AAD | **1195 bytes** |
| TPS2 fixed overhead | **1211 bytes** |
| Maximum plaintext | 16 777 216 bytes |
| Domain-separator lengths | 34 / 23 / 36 / 25 / 29, each measured from the encoded string |

---

## 8. Platform primitives

| Primitive | Source |
| --- | --- |
| SHA-256 | `crypto.subtle.digest` |
| HMAC-SHA-256 | `crypto.subtle.sign` |
| AES-256-GCM, 12-byte nonce, full 128-bit tag | `crypto.subtle.encrypt` / `decrypt` |
| SHAKE-256, SHA3-256, SHA3-512 | inside `@noble/post-quantum` |
| HKDF-SHA-256 composition | `src/spt/hkdf.ts` — see below |

**Why HKDF is composed rather than taken from `subtle.deriveBits`.** A concrete
portability problem, demonstrated rather than assumed: Node's WebCrypto caps
`algorithm.info` at **1024 bytes**, and §7.3's AEAD-key info is
`uint8(len(DS_AEAD_KEY)) ‖ DS_AEAD_KEY ‖ AAD` = 1 + 23 + 1195 = **1219 bytes**.
The AAD's size is frozen, so the derivation cannot be reshaped to fit. RFC 5869
is therefore composed over the platform's HMAC-SHA-256, which has no such limit,
and `tests/spt-hkdf.test.ts` pins it to RFC 5869 Appendix A's own SHA-256
vectors (A.1, A.2, and A.3's zero-length salt).

AES was **not** implemented by hand, and no second AEAD was added.

---

## 9. Build

| Check | Result |
| --- | --- |
| Node | v26.5.0 |
| `npm test` | pass |
| `npm run build` (typecheck + vite) | pass |
| `npm run test:e2e` | pass |
| Browser bundle includes the KEM locally | yes — no CDN, no runtime fetch |
| `eval` / `new Function` in the shipped bundle | none introduced |
| WASM fetched from a network | none |
| CSP change required | none |

---

## 10. What may NOT be said on the strength of this document

* Not *"TruePad supports online PQC pad transfer."* It does not. Phase 1A
  implements the cryptographic core; nothing in the shipped product offers the
  feature.
* Not *"X-Wing is a standard."* It is an Internet-Draft, Independent Submission,
  not CFRG-adopted, not an RFC.
* Not *"validated"* in the FIPS or CAVP sense.
* Not *"the implementation is constant-time."* Nothing here measured that.
* Not *"secrets are erased."* `src/spt` zeroizes buffers it owns, best-effort.
  JavaScript offers no guarantee that a garbage-collected copy is gone, that the
  engine forgot the bytes, or that physical RAM was erased.
