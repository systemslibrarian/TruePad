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
| Validation status | valid/honest X-Wing interop **validated**; adversarial low-order decapsulation **intentionally not byte-identical** (§6); product transfer flow **still not implemented** |

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
| **No** ad-hoc X25519 all-zero rejection changing draft-10 | **Not met.** Noble aborts on an all-zero X25519 result — a policy RFC 7748 §6.1 permits, inherited rather than added by TruePad. **Accepted; see §6** | ⚠️ |

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

## 6. The one divergence — accepted, and described precisely

**DECISION: ACCEPT `@noble/post-quantum` 0.7.1's stricter low-order rejection.**
The dependency is kept. The suite is unchanged. This section is the permanent
record of what was accepted and why, and it corrects two things an earlier draft
of it got wrong.

### 6.1 Three facts, none of which cancels the others

**A — draft-10.** `draft-connolly-cfrg-xwing-kem-10` defines decapsulation as

```
ss_X = X25519(sk_X, ct_X)
```

and specifies **no** all-zero abort. Its machine-readable specification's X25519
returns the resulting u-coordinate. The draft text contains no discussion of
all-zero, low-order, or contributory behaviour anywhere.

**B — RFC 7748.** §6.1 explicitly says an implementation **MAY** check whether
the X25519 shared secret is all-zero and abort. `@noble/curves`' X25519 is
therefore a **conforming RFC 7748 implementation exercising a permitted
policy** — not a broken one, and not a TruePad invention.

**B′ — TruePad writes no such check, and no X25519 of its own.** There is no
all-zero test, no contributory-behaviour test, and no hand-written curve code
anywhere in `src/spt`. What TruePad does is select a dependency and accept its
behaviour.

**C — TruePad.** The selected production dependency inherits that stricter
rejection. Consequently:

* honestly generated draft-10 X-Wing encapsulations remain byte-compatible;
* every official and reference vector remains byte-identical;
* ordinary cross-implementation `pk` / `ct` / `ss` results remain byte-identical;
* **adversarial low-order `ct_X` inputs are a documented decapsulation-behaviour
  divergence.**

Suite `0x0001`'s wire bytes are unchanged and no suite-ID change is required.

### 6.2 The interoperability claim, stated at its true boundary

> TruePad's production X-Wing implementation is byte-identical to draft-10 for
> `GenerateKeyPair`, `Encapsulate`, and all honestly generated ciphertexts
> tested — including all three Appendix C vectors and the independent draft-10
> corpus. Its `Decapsulate` behaviour is deliberately **stricter** for the
> RFC 7748 all-zero X25519 case, because the selected Noble implementation
> aborts on that result. TruePad therefore does **not** claim
> arbitrary-malformed-ciphertext decapsulation equivalence with every draft-10
> implementation.

Neither "a fully byte-exact implementation of draft-10" nor "byte-exact with
draft-10" may be written without that qualification attached.

Demonstrated, on a ciphertext whose `ct_X` is the all-zero u-coordinate:

| Implementation | Behaviour |
| --- | --- |
| `@noble/post-quantum` 0.7.1 | **throws** `invalid private or public key received` |
| `rxwing` 0.1.0-draft10 | **returns** `ss = b5783bcb…a457` |

### 6.3 The "both refuse" argument was wrong, and is withdrawn

An earlier version of this section said the package is refused under both
behaviours because "the frozen construction would return a shared secret the
attacker cannot predict, so the AEAD tag fails". **That is not true in
general.** It held only for the narrow case actually tested: take an honest
package, replace `ct_X` with low-order bytes, change nothing else. There the
tamperer does not know the honest package's `ss_M` and cannot repair the AEAD.

A **malicious sender** is not so limited. An encapsulation key is public, so
Mallory can:

1. run a valid `ML-KEM-768.Encaps(Bob.pk_M)` himself and **keep `ss_M`**;
2. choose `ct_X` = a low-order point, for which draft-10's X25519 yields
   all-zero for every scalar — so `ss_X` is known too;
3. compute `ss = Combiner(ss_M, 0³², ct_X, pk_X)` — every input known;
4. build a **genuinely valid** TPS2 package under that `ss`.

A draft-10 implementation that does not abort derives the same `ss` and the AEAD
verifies. `tests/spt-lowzero-divergence.test.ts` constructs exactly this
fixture and proves all three legs: the reference combiner reproduces **the byte
value `rxwing` actually returns** for that ciphertext; the resulting tag is
genuinely valid (the test decrypts it, and the derived-nonce check passes too);
and TruePad rejects it because Noble's X25519 aborts first.

So the honest statement is: **a package Noble refuses here is one a
non-aborting draft-10 implementation may accept.** That is the difference being
accepted.

### 6.4 Why that is not a protocol break

Because **X-Wing does not authenticate the sender, and never claimed to.**

Any sender can already run an *honest* `XWing.Encaps(Bob.pk)` — the key is
public — and know the resulting shared secret. Mallory's ability to manufacture
a package Bob can open is therefore **not created by the low-order case**; he
has it anyway. "Bob can decrypt it" has never meant "Alice sent it".

That is precisely why §8 exists. A malicious package — ordinary X-Wing or
low-order draft-10 — must still fail the Alice → Bob human confirmation
ceremony, unless Mallory also defeats that ceremony's stated assumptions.

Noble's low-order rejection is therefore **stricter input acceptance**, not the
mechanism that authenticates Alice, and it must not be promoted into an identity
claim.

### 6.5 What the API equality does and does not claim

`openPayloadV1` maps Noble's low-order decapsulation throw and an AES-GCM
authentication failure to the **same `reason` and the same `message`**. That is
kept, and asserted by test: the typed API exposes no decapsulation oracle, and
SPT has no remote TruePad backend to interrogate.

An earlier draft said the difference was "not observable at all". **That is too
strong and is withdrawn.** The two paths execute different code and can differ
in timing. What is claimed is exactly this and nothing more:

> The public API returns the same `reason` and the same `message` for both.

Not claimed: constant-time equality of the two paths, timing
indistinguishability, or unobservability. Endpoint-local timing observation is
not a property this code establishes.

### 6.6 What was deliberately NOT done

The suite was not modified to match the library. No shim reimplements the X25519
step to restore the frozen behaviour — that would mean hand-writing part of the
KEM and still calling it suite `0x0001`. No combiner of our own was written into
production code, and a test asserts `src/spt` contains none.

### 6.7 Pinned

`tests/spt-lowzero-divergence.test.ts` fixes the accepted behaviour in place:
the three draft vectors still match, Noble still rejects the low-order case, and
the divergence is confined to `Decapsulate`. **If a future Noble version begins
returning a combined secret instead, that test fails** — which is the intent. It
would move TruePad onto the draft-10 behaviour without anyone deciding to, and
would make the forged package of §6.3 openable. Re-audit this section before
changing it.

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
