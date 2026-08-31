# Sealed Pad Transfer v1

**STATUS: PHASE 1B — STORAGE / PROVENANCE FOUNDATION IMPLEMENTED;
SEALED TRANSFER PRODUCT FLOW NOT IMPLEMENTED.**

**Nothing in the shipped product offers sealed transfer.** There is no UI, no
verb, no menu item, no QR, and no way for an operator to reach any of it.
TruePad does **not** support online PQC pad transfer, and this document must not
be read as saying it does.

**Phase 1A** implemented suite `0x0001` in `src/spt/**` — the X-Wing wrapper
(§2.2), the TPR2 (§5) and TPS2 (§7.1) codecs, the key schedule (§7.3), the
derived nonce (§7.4), AES-256-GCM, `requestHash`, the `requestWords132` and
`confirmationWords88` indices, `packageIdentity`, and committed reference
vectors. `docs/SEALED-PAD-TRANSFER-VALIDATION.md` records the dependency audit,
the draft-10 vectors, the cross-implementation run against an independent
draft-10 implementation, and one **accepted** divergence: the pinned library
aborts when X25519 yields all-zero — a policy RFC 7748 §6.1 permits and which it
inherits rather than TruePad adding — where draft-10 specifies no abort. That
decision is closed; suite `0x0001`'s wire bytes are unchanged.

**Phase 1B** implemented the storage foundation, in `src/browser/engine/**`:

* **pair provenance** — `origin` on `pair.json` (§10.7), written by `gen` and by
  every import, never backfilled and never inferred;
* **the imported-forwarding refusal** — an `imported` pad may no longer be
  exported onward either, closing the walking-pace twin of the sealed hole
  (§10.7.1);
* **the one-handoff record** — the marker-last transaction, its frozen file
  layout and marker grammar, and `HANDOFF-SPENT / UNREADABLE` (§10.9);
* **physical/sealed cross-mode semantics** on the existing `export-pair`;
* **crash behaviour under the non-atomic `writeFileAtomic` fallback**, tested
  against a fault-injecting backing rather than assumed from `MemoryVfs`.

Still **not** implemented, and therefore not existing:

* persisted receive requests and the `PENDING`/`CANCELLED`/`CONSUMED` machine (§10.1);
* the one-time recipient `dk` lifecycle;
* the TPR2 operator ceremony and the §6 words;
* sender verification state (§10.5);
* the product `seal(body, pairId)` operation, `openSealed`, `commitReceive`,
  `reject`, `abandon`;
* the cross-tab receive session and its Web Locks (§10.10);
* any Browser UI, QR, or CLI verb.

The low-level `sealPayloadV1` / `openPayloadV1` take **bytes**. They are for
cryptographic composition and reference vectors. The product operation remains
`seal(body, pairId)`, reading the live store inside the worker; there must never
be an RPC named `seal(body, padFileBytes)` (§18, §20). The Phase 1B storage
helpers are likewise internal: `commitSealedHandoff` is not a worker RPC.

> **The Phase-1A storage prerequisite, and what became of it.** Phase 1A carried
> forward that §10.9's "one atomic replace" could not be honoured because
> `OpfsVfs.writeFileAtomic()` is atomic only where `FileSystemFileHandle.move()`
> exists. Three resolutions were open: a design that fails closed under the
> fallback, another crash-safe representation, or a narrower platform claim.
> Phase 1B took the **first**: §10.9 is now marker-last, and a torn marker fails
> closed as `HANDOFF-SPENT / UNREADABLE`. `OpfsVfs` was not modified and its
> fallback is **still not atomic** — that is a standing fact about the platform,
> now designed around rather than assumed away, and the fault-injection tests
> exercise it directly rather than trusting `MemoryVfs`.

---

## 0. Thesis

> **PQC delivers the pad. OTP encrypts the messages.
> They are separate security layers with separate claims.**

Sealed Pad Transfer changes nothing about TruePad's message cryptography. After
a successful unwrap the recipient holds **exactly** the ordinary pad-file bytes
the existing courier export produces, and those bytes go through **exactly** the
existing importer. The OTP, the Wegman–Carter authenticator, Store Format v2,
the witnesses, the TPM anchor, destruction, and the TP2 compact transport are
untouched and unaware of this protocol.

```
recipient one-time receive request  (TPR2, public)
        ↓
hybrid PQ/T key establishment       (X-Wing: X25519 + ML-KEM-768)
        ↓
AEAD of the EXISTING pad-file bytes (HKDF-SHA-256 → AES-256-GCM)
        ↓
sealed transfer file                (.tps2, binary)
        ↓
decapsulation + AEAD verification
        ↓
EXACT original pad-file bytes
        ↓
the EXISTING import validator
        ↓
ordinary OTP + one-time Wegman–Carter messaging
```

PQC here is a **delivery wrapper**. It is not OTP encryption, not a replacement
for OTP or Wegman–Carter, not a Store Format, not a second message-encryption
layer, not a randomness conditioner, and **not an information-theoretic delivery
mechanism**.

---

## 1. Standards survey — status as verified on 2026-08-30

Recorded as facts with status, because the suite freeze depends on them.

| Reference | Version / date | Status | Suitable here? |
| --- | --- | --- | --- |
| **FIPS 203** — ML-KEM | Final, August 2024 | **Published US federal standard** | Yes — ML-KEM-768 is the PQ component |
| **RFC 7748** — X25519 | RFC 7748, January 2016 | **IETF Standards Track RFC** | Yes — the traditional component |
| **NIST SP 800-227** — Recommendations for KEMs | **Final, September 2025** | **Published NIST Special Publication** | Yes — §4.6.2 *approves* general-purpose key combiners (Eq. 14/15) and cites X-Wing |
| **X-Wing** — general-purpose hybrid KEM | `draft-connolly-cfrg-xwing-kem-10`, 2 March 2026, expires 3 September 2026 | **Internet-Draft. Independent Submission (ISE). Intended status Informational. NOT adopted by CFRG. NOT an RFC.** The draft itself states it "is not endorsed by the IETF and has no formal standing in the IETF standards process." | Yes, with the status stated — see §2 |
| X-Wing — status re-checked 2026-08-30 | still `-10`; **no newer revision has appeared** | unchanged from Phase 0 | suite `0x0001` stands unmodified |
| X-Wing security proof | Barbosa, Connolly, Duarte, Kaiser, Schwabe, Varner, Westerbaan, *X-Wing: The Hybrid KEM You've Been Looking For* | **Peer-reviewed**, IACR Communications in Cryptology 2024; ePrint 2024/039 | Supporting evidence |
| **RFC 10024** — *Post-Quantum Traditional (PQ/T) Hybrid Key Agreement Mechanisms for TLS 1.3* (X25519MLKEM768) | **Proposed Standard, August 2026** (formerly `draft-ietf-tls-ecdhe-mlkem`) | **Published IETF Proposed Standard** — not a draft | **NO, and the RFC itself says why — see below** |
| ML-KEM in browser WebCrypto | WICG *Modern Algorithms in the Web Cryptography API*, Draft Community Group Report, 29 June 2026 | **Draft, not shipping in browsers** | Implementation note, §14 |

**X25519MLKEM768 is standardized — and is still rejected for this protocol, on
the standard's own authority.** Its "combiner" is bare concatenation
`ss_ML-KEM ‖ ss_X25519`, fed into the **TLS 1.3 key schedule**, where the
handshake transcript is folded in and HKDF derives the session key. The
combining work is done by TLS, not by the construction. RFC 10024's Security
Considerations say so directly:

> "The security analysis relies crucially on the TLS 1.3 message transcript, and
> one cannot assume a similar hybridization is secure in other protocols."

Both facts are recorded because both matter: **X25519MLKEM768 is now RFC 10024,
a Proposed Standard**, and **transplanting it into TruePad's non-TLS transfer
would be exactly the error its own Security Considerations warn against.** Being
standardized does not make a construction portable.

**No finalized, general-purpose X25519 + ML-KEM-768 hybrid KEM standard exists
as of this date.** That is the honest state of the world, and the suite below is
chosen with it stated rather than papered over.

---

## 2. Suite registry

v1 supports **exactly one** suite. There is no negotiation, no downgrade, and no
"try older crypto". An unknown suite identifier is refused.

| Suite ID | Name | KEM | KDF | AEAD | Status of the normative construction |
| --- | --- | --- | --- | --- | --- |
| `0x0001` | `TPSPT1-XWING-HKDF256-AESGCM256` | X-Wing (X25519 + ML-KEM-768) | HKDF-SHA-256 (RFC 5869) | AES-256-GCM (SP 800-38D) | KEM: Internet-Draft (see §1). KDF/AEAD: published standards |

### 2.1 Why X-Wing, and why it is suitable outside TLS

X-Wing is **general-purpose by construction**. Its combiner is

```
ss = SHA3-256( ss_M ‖ ss_X ‖ ct_X ‖ pk_X ‖ XWingLabel )
```

where `ss_M` is the ML-KEM-768 shared secret (32 B), `ss_X` the X25519 shared
secret (32 B), `ct_X` the X25519 ephemeral public key (32 B), `pk_X` the
recipient's X25519 public key (32 B), and `XWingLabel` is the 6-byte constant
`5c 2e 2f 2f 5e 5c` (ASCII `\./` then `/^\`). Total hashed input: **134 bytes**.

Everything the security argument needs is *inside* the hash. There is no
transcript from an enclosing protocol, no session state, and no framework
dependency — which is precisely the property X25519MLKEM768-for-TLS lacks. Its
proof gives IND-CCA security **if either** X25519 **or** ML-KEM-768 remains
secure, which is the exact hybrid property this protocol wants.

**Sizes (X-Wing):** encapsulation key **1216 B** · decapsulation key **32 B**
(seed) · ciphertext **1120 B** · shared secret **32 B**.

### 2.2 The COMPLETE frozen construction

Phase 0 reproduced the combiner and left `KeyGen`/`Encaps`/`Decaps` as calls.
That left cryptographic choices for Phase 1, which Phase 0 existed to eliminate.
**Suite `0x0001` freezes the whole of `draft-connolly-cfrg-xwing-kem-10`**, and
it is reproduced here so that after this document there is no question of the
form *"how should we implement `XWing.KeyGen`?"*

**Sizes.** `sk` 32 · `pk` 1216 · `ct` 1120 · `ss` 32.

```
XWingLabel = 5c 2e 2f 2f 5e 5c            # 6 bytes: ASCII "\./" then "/^\"

def expandDecapsulationKey(sk):           # sk is the packed 32-byte seed
    expanded = SHAKE256(sk, 96)           # 96 OCTETS (the draft writes 96*8 bits)
    (pk_M, sk_M) = ML-KEM-768.KeyGen_internal(expanded[0:32],    # d
                                              expanded[32:64])   # z
    sk_X = expanded[64:96]                                       # X25519 scalar
    pk_X = X25519(sk_X, X25519_BASE)
    return (sk_M, sk_X, pk_M, pk_X)

def GenerateKeyPair():
    sk = random(32)
    (sk_M, sk_X, pk_M, pk_X) = expandDecapsulationKey(sk)
    return sk, concat(pk_M, pk_X)         # pk = pk_M[0:1184] ‖ pk_X[1184:1216]

def GenerateKeyPairDerand(sk):            # for test vectors ONLY
    (sk_M, sk_X, pk_M, pk_X) = expandDecapsulationKey(sk)
    return sk, concat(pk_M, pk_X)

def Encapsulate(pk):
    pk_M = pk[0:1184]
    pk_X = pk[1184:1216]
    ek_X = random(32)
    ct_X = X25519(ek_X, X25519_BASE)
    ss_X = X25519(ek_X, pk_X)
    (ss_M, ct_M) = ML-KEM-768.Encaps(pk_M)     # MUST do the FIPS 203 §7.2
                                               # encapsulation-key check
    ss = Combiner(ss_M, ss_X, ct_X, pk_X)
    ct = concat(ct_M, ct_X)                    # ct_M[0:1088] ‖ ct_X[1088:1120]
    return (ss, ct)

def EncapsulateDerand(pk, eseed):         # for test vectors ONLY; eseed is 64 B
    pk_M = pk[0:1184]
    pk_X = pk[1184:1216]
    ek_X = eseed[32:64]
    ct_X = X25519(ek_X, X25519_BASE)
    ss_X = X25519(ek_X, pk_X)
    (ss_M, ct_M) = ML-KEM-768.EncapsDerand(pk_M, eseed[0:32])
    ss = Combiner(ss_M, ss_X, ct_X, pk_X)
    ct = concat(ct_M, ct_X)
    return (ss, ct)

def Decapsulate(ct, sk):
    (sk_M, sk_X, pk_M, pk_X) = expandDecapsulationKey(sk)
    ct_M = ct[0:1088]
    ct_X = ct[1088:1120]
    ss_M = ML-KEM-768.Decapsulate(ct_M, sk_M)  # NOT required to perform the
                                               # decapsulation-key check
    ss_X = X25519(sk_X, ct_X)
    return Combiner(ss_M, ss_X, ct_X, pk_X)

def Combiner(ss_M, ss_X, ct_X, pk_X):
    return SHA3-256(concat(ss_M, ss_X, ct_X, pk_X, XWingLabel))   # 134 B in
```

**Validation, exactly as the draft has it — and no more.**
`Encaps` **MUST** perform the FIPS 203 §7.2 encapsulation-key check and raise on
failure. `Decaps` is **NOT** required to perform the decapsulation-key check.

> **On the all-zero X25519 result — three facts, and TruePad adds no check of
> its own.**
>
> 1. **draft-10 specifies no all-zero abort.** `Decapsulate` is
>    `ss_X = X25519(sk_X, ct_X)`, and the draft discusses low-order,
>    contributory or all-zero behaviour nowhere.
> 2. **TruePad writes no such check, and no X25519 of its own.** Adding an
>    ad-hoc contributory-behaviour check would take suite `0x0001` outside the
>    construction that was proven, for a property X-Wing's own security argument
>    does not rest on — the combiner hashes `ct_X` and `pk_X` alongside `ss_X`,
>    and IND-CCA follows from ML-KEM-768 **or** gap-CDH on Curve25519. Adding
>    checks to a frozen suite because they feel prudent is precisely how a
>    "hybrid standard" stops being the thing that was analysed.
> 3. **The pinned dependency does abort, and TruePad accepts that.**
>    `@noble/post-quantum` 0.7.1, via `@noble/curves`, raises when X25519 yields
>    all-zero — a policy **RFC 7748 §6.1 explicitly permits**. It is inherited,
>    not added. The decision to keep the dependency is closed, and suite
>    `0x0001` and every wire byte are unchanged.
>
> What this does and does not mean: honestly generated ciphertexts, all frozen
> wire bytes, and every reference vector are unaffected. Only **adversarial
> low-order `ct_X` decapsulation** differs, and TruePad therefore does not claim
> arbitrary-malformed-ciphertext decapsulation equivalence with every draft-10
> implementation. `docs/SEALED-PAD-TRANSFER-VALIDATION.md` §6 is the full
> record; the two documents must not drift apart.

**Cryptographic dependencies of this suite, in full:** ML-KEM-768 (FIPS 203),
X25519 (RFC 7748), **SHAKE-256** (key expansion), **SHA3-256** (combiner), and
**SHA3-512** — the last two via ML-KEM-768's internals and via X-Wing's own
security argument, which models **SHA3-256, SHA3-512 and SHAKE-256 as random
oracles**. §16.1 lists all of them; reducing this to "the SHA3-256 combiner"
would understate what the construction assumes.

### 2.2.1 The freeze rule

Suite `0x0001` is defined by **this document**, and equals
`draft-connolly-cfrg-xwing-kem-10` (re-verified 2026-08-30: still `-10`, no
newer revision). If a later X-Wing draft or RFC changes anything above, **suite
`0x0001` does not change** — a future suite `0x0002` tracks it and old packages
stay openable. TruePad must never ship something called X-Wing that is not the
X-Wing that was proven.

### 2.2.2 Reference vectors required before Phase 1 ships

Phase 1 **MUST** validate against, at minimum:

1. `GenerateKeyPairDerand(sk)` for a fixed 32-byte `sk` → expected `pk` (1216 B)
   and the intermediate `expanded` 96 bytes;
2. `EncapsulateDerand(pk, eseed)` for a fixed 64-byte `eseed` → expected `ct`
   (1120 B) and `ss` (32 B);
3. `Decapsulate(ct, sk)` → the same `ss`;
4. the `Combiner` alone over a fixed 134-byte input.

> **Provenance caveat, recorded rather than assumed.** draft-10's own test
> vectors carry editorial qualification and are an Internet-Draft artifact, not
> a validated standard's. Before production use, Phase 1 **MUST** additionally
> cross-check against at least one **independent** X-Wing implementation, and
> record which one and at what version. A vector that only agrees with itself
> proves nothing.

### 2.3 The approved fallback, recorded now

If X-Wing does not progress, or if a FIPS-validation context requires it, the
replacement is **NIST SP 800-227 §4.6.2, Expression (14)** — a *finalized*
approved combiner:

```
K ← KDM( (S1, S2, …, St), OtherInput )
```

approved "for any t > 1 if at least one shared secret … is generated from …
an approved KEM" (ML-KEM-768 qualifies), with the two-step KDM
`Expand(Extract(salt, Z), FixedInfo)` — i.e. HKDF — and "extraction is performed
with **all** shared secrets as the input". `FixedInfo` may carry "encapsulation
keys, ciphertexts, parameter sets, and domain separators", which is exactly what
§7.3 already does. Both shared secrets here are fixed-length 32 B, so the
concatenation `ss_M ‖ ss_X` is unambiguous and SP 800-227's variable-length
concatenation warning does not apply.

That fallback would be suite `0x0002`, specified when needed. It is **not**
implemented in v1.

---

## 3. What actually gets sealed — audit of the existing pad file

Determined by reading the current implementation, not assumed.

| Question | Answer |
| --- | --- |
| What bytes are the "pad file"? | `packContainer()` output (`src/browser/engine/courier-format.ts`): UTF-8 of `JSON.stringify(doc, null, 2)` where `doc = { format: "truepad2-pair-bundle", version: 1, pairId, files: [{ path, bytesB64 }] }` |
| Which files? | Exactly the 6 `BUNDLE_FILES`, in fixed order: `a-to-b/{head.json,secret.bin,journal.log}`, `b-to-a/{…}` |
| Deterministic? | **Yes**, for a fixed store snapshot: fixed file order, fixed JSON key order, fixed indentation |
| Maximum legitimate size | Dominated by `secret.bin` = `E + 32·N` per direction, base64-inflated 4/3. "Large" preset (E=4 194 304, N=4096) ≈ **11.5 MB** |
| Who owns acceptance? | `importImpl()` — file-set validation, staging under `importing/<pairId>/`, both headers loaded and reconciled, pairId/direction agreement. **This remains the sole authority.** |
| Duplicate pair | `committedPairExists()` → refuses `pair-exists`. A second independently consumable copy **cannot** be created in one installation. |
| Destroyed pair | `requireNotDestroyed()` → refuses `pair-destroyed`. A tombstone cannot be resurrected by import. |
| Reusable transaction | `importImpl()` in full — stage and validate under `importing/<pairId>/`, then commit: write `importing.json` **first**, copy the validated files, bootstrap the witness, write `pair.json`, and **remove `importing.json` — that removal is the commit point.** While the marker is present the pair is not active (`import-incomplete`) |

**There is no second pad-container format.** The AEAD plaintext *is* the byte
string above. The sealed package inherits that container's base64 inflation; v1
does not re-encode, re-compress, or re-serialize it, because §8 forbids it.

---

## 4. Artifacts

| | Receive Request | Sealed Package |
| --- | --- | --- |
| Direction | recipient → sender | sender → recipient |
| Prefix / magic | text `TPR2:` | binary `TPS2` (`54 50 53 32`) |
| Representation | canonical unpadded Base64URL text | **binary file**, suggested extension `.tps2` |
| Secret content | **none** — entirely public | pad ciphertext only |
| Size | 1652 characters (§5.2) | pad-file size + 1211 B (§7.1) |

The sealed package is **never** base64'd in the normal path. It may be
megabytes; it is a file.

Suggested filename: `truepad-sealed-<first 8 hex of requestId>.tps2`. The
filename carries no pairId, no pad name, and no identity, and is **never**
authenticated — it is convenience only.

---

## 5. TPR2 — the Receive Request

### 5.1 Canonical body (1235 bytes)

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | transfer format version = `0x01` |
| 1 | 2 | suite ID, big-endian = `0x0001` |
| 3 | 16 | `requestId`, 16 CSPRNG bytes |
| 19 | 1216 | X-Wing encapsulation key |

Nothing else. The body **must not** contain: pairId, pad metadata, account or
device identity, email, username, any stable identifier, or any secret.

`requestId` is **public**, and is a **receiver-side lookup handle**. It is *not*
a sender-side identity and carries **no uniqueness guarantee**, because the
requester chooses those 16 bytes and an attacker may choose them to collide.
**All sender-side state — the §18 confirmation record above all — MUST be keyed
by the complete 1235-byte body, never by `requestId`.**

### 5.2 Text encoding and exact length

`TPR2:` ‖ Base64URL(body), canonical, **unpadded** (RFC 4648 §5 alphabet;
no `=`, no `+`, no `/`). Whitespace surrounding a paste may be trimmed;
whitespace inside is invalid.

```
1235 bytes → ⌈1235 × 4 / 3⌉ = 1647 Base64URL characters
             + 5 characters of "TPR2:"
           = 1652 characters total
```

### 5.3 QR feasibility — measured, not guessed

Base64URL contains lowercase and `-`/`_`, none of which are in QR alphanumeric
mode, so **byte mode** is required. Version-40 byte-mode capacities:

| EC level | Capacity | 1652 chars fits? |
| --- | --- | --- |
| L | 2953 B | **yes**, comfortably |
| M | 2331 B | **yes** |
| Q | 1663 B | **yes, by 11 bytes** — marginal |
| H | 1273 B | **no** |

So a TPR2 request fits a single QR code at version 40, EC level L or M
comfortably and Q only just. A version-40 symbol is 177×177 modules and demands
a decent camera and a large display. **QR is optional convenience; copy/paste
and file export are the normative channels.**

---

## 6. Request fingerprint and safety words

### 6.1 Why this exists

Encrypting to a public key does not tell Alice the key is **Bob's**. An attacker
who substitutes a TPR2 request makes Alice seal **the entire pad** to the
attacker. That is a total confidentiality failure, and it is the single most
important thing this protocol must prevent.

**v1 has no path that skips the comparison.** TruePad does not release a sealed
package until the operator **declares** they compared the words with the
recipient over an authenticated side channel (in person, or a voice call where
they recognise the voice). There is no "skip" button, because a skip button is
the attack.

That declaration is an **OPERATOR** assumption in this project's classification
— *a declaration, never a verification result*, exactly as
`PRODUCT-CLAIMS.md` says of the source ceremony. TruePad observes a click; it
cannot observe a side channel. The protocol's guarantee is therefore
*conditional on the operator having actually compared*, and is stated that way
everywhere it appears.

### 6.2 Construction

Domain-separated hashing, used everywhere in this protocol:

```
H_ds(DS, X) = SHA-256( uint8(len(DS)) ‖ DS ‖ X )

Byte ranges in this document are **half-open** throughout: `X[a..b)` and
`[a, b)` both mean bytes `a` through `b-1`.
```

The 1-byte length prefix makes the encoding injective across different
separators.

> **The length octet is the actual byte length of `DS`.** Implementations MUST
> compute `len(DS)` and MUST NOT hard-code it, and MUST assert
> `1 ≤ len(DS) ≤ 255`. A wrong constant here does not fail loudly: it silently
> forks `requestHash` — and therefore the §6 words, the §7.3 HKDF salt, and AAD
> bytes [23, 55) — between two conforming implementations, producing exactly the
> symptom of an active attack. **The parenthesised byte counts above are
> informative; a conformance test MUST assert each against the measured string.**
> (The declarations are in the block that follows.)
>
> (The first draft of this document wrote 33 for a 34-byte separator. The repair
> that added `DS_PAD` then wrote 28 for a 29-byte one — in a position where the
> error would *not* have failed loudly. The rule is stated, and mechanically
> tested, because the mistake has now been made twice.)

```
DS_REQUEST_FP = "TruePad/SPT/v1/request-fingerprint"      (34 bytes ASCII)
DS_AEAD_KEY   = "TruePad/SPT/v1/aead-key"                 (23 bytes ASCII)
DS_CONFIRM    = "TruePad/SPT/v1/transfer-confirmation"    (36 bytes ASCII)
DS_NONCE      = "TruePad/SPT/v1/aead-nonce"               (25 bytes ASCII)
DS_PAD        = "TruePad/SPT/v1/pad-commitment"           (29 bytes ASCII)

requestHash = H_ds(DS_REQUEST_FP, canonicalRequestBody)        [32 bytes]
```

`canonicalRequestBody` is the **complete** 1235-byte body of §5.1 — version,
suite, requestId, and the encapsulation key. Substituting any of them changes
the fingerprint.

### 6.3 Request words: 12 words, 132 bits

The Phase-0 draft rendered 88 bits here and *conceded in the same breath* that
Bitcoin-scale SHA-256 capability defeats it in about 36 hours. That is not an
acceptable margin for the control whose failure means **Alice encrypts the
entire pad to the attacker**. A control that is documented as breakable by an
adversary tier that demonstrably exists is not a control; 88 bits is withdrawn
here and the request fingerprint is raised to a 128-bit class.

**Rendering — `requestWords132`.** Take `requestHash[0..17)` — the first **17
bytes** — as a big-endian 136-bit integer `n`. Discard the **low 4 bits**, i.e.
use `m = n >> 4`, a **132-bit** value. Split `m` into **12 indices of 11 bits**,
most-significant first: index *i* (0-based) is `(m >> (121 - 11·i)) & 0x7FF`.
Shifts are therefore 121, 110, 99, 88, 77, 66, 55, 44, 33, 22, 11, 0 — an exact,
non-overlapping partition of all 132 bits. Each index selects one word from the
pinned 2048-word list (§6.4).

**Work factors**, on the same declared basis as before — one SHA-256 compression
per trial, a conservative floor that credits the attacker with an amortisation
he does not have (`requestId` sits in block 0 of the 20-block preimage, so a
real trial costs ~20 compressions, i.e. ≈2¹³⁶):

| Rendering | Bits | Commodity GPU (2³⁴/s) | Large GPU cluster (2⁵⁰/s) | Bitcoin-scale ASIC (2⁷¹/s) |
| --- | --- | --- | --- | --- |
| 8 words *(withdrawn)* | 88 | ~6 × 10⁸ y | ~8 700 y | **~36 hours** |
| **12 words** | **132** | ~1 × 10²² y | ~1.5 × 10¹⁷ y | **~7 × 10¹⁰ years** |

At the ASIC tier the floor is 2⁶¹ seconds ≈ 73 billion years, against a universe
of ~1.4 × 10¹⁰. The margin no longer depends on the attacker's budget, on the
7-day TTL, on consumer hardware, or on anyone's guess about whether TruePad is a
target — **none of which are security properties**, and all of which the Phase-0
draft leaned on to some degree.

Twelve words is more to read aloud than eight. That is the price of the control
whose failure is total, and it is paid once per pad.

> **All twelve are compared. A position challenge is UX, never security margin.**
> Asking the operator to echo a random 2–3 positions ("read me words 2, 5 and 7")
> is worth adding, because it catches someone who glances at the first and last
> word and says "yes". But checking 3 of 12 eleven-bit words compares **33
> bits**, not 132, and it **MUST NOT replace the normative comparison of the
> full fingerprint**. Un-compared words contribute nothing and are never credited
> to the margin. The same applies to §8: the 88-bit confirmation argument assumes
> **all eight** words are actually compared, and if an implementation ever
> compares fewer, the number in that argument changes accordingly.

### 6.4 The wordlist

Normative requirements: exactly **2048** words · lowercase ASCII `a–z` · unique
4-character prefixes (so a mis-heard tail is still unambiguous) · pinned in-tree
and identified by the SHA-256 of the canonical newline-separated file.

**Intended list: BIP-39 English** (`bitcoin/bips`, `bip-0039/english.txt`),
which meets all of the above and is the most widely transcribed such list.

**Provenance — resolved as far as this phase honestly can.** BIP-39's own
specification text declares `License: MIT`, and the list is published at
`bitcoin/bips` as `bip-0039/english.txt`. That sentence covers the BIP document;
it does not by itself settle every provenance question for the standalone
`english.txt` asset, and this document does not pretend it does.

Before vendoring, Phase 1 **MUST**: verify the exact source and applicable
licence of the file; preserve any required attribution or licence notice;
vendor the exact 2048-word file; pin its **SHA-256 over the canonical
newline-separated content**; and test that it has exactly 2048 entries, all
lowercase ASCII, all unique, with **unique 4-character prefixes** and canonical
newline handling. **If the licence cannot be established cleanly, a differently
licensed 2048-word list meeting the same requirements is substituted before
Phase 1 ships** — the list is a *rendering*, so this changes no package byte,
though both parties must share the same list, which is what the hash pin is for.

> **TruePad's display is not a BIP-39 mnemonic**, and must never be described as
> one. There is no seed, no entropy, no checksum word, and no wallet. TruePad
> uses a pinned human-readable wordlist to render fingerprint **bits** for a
> spoken comparison. The words are never key material, never a password, and
> never an input to any derivation.

---

## 7. TPS2 — the Sealed Package

### 7.1 Binary layout

| Offset | Size | Field | In AAD? |
| --- | --- | --- | --- |
| 0 | 4 | magic `TPS2` = `54 50 53 32` | yes |
| 4 | 1 | transfer format version = `0x01` | yes |
| 5 | 2 | suite ID big-endian = `0x0001` | yes |
| 7 | 16 | `requestId` (copied from the request) | yes |
| 23 | 32 | `requestHash` (§6.2) | yes |
| 55 | 1120 | X-Wing ciphertext | yes |
| 1175 | 12 | AES-GCM nonce | yes |
| 1187 | 8 | plaintext length, uint64 big-endian | yes |
| **1195** | *n* | AES-256-GCM ciphertext of the pad-file bytes | — |
| 1195+*n* | 16 | AES-GCM tag | — |

**Fixed overhead: 1211 bytes** (1195 header + 16 tag). For a 745 KB "Medium"
pad file that is 0.16%; for 11.5 MB it is 0.01%.

### 7.2 Associated data

```
AAD = the entire header, bytes [0, 1195)
```

Every public field is authenticated. There is **no** unauthenticated routing
metadata, because unauthenticated metadata that later changes semantics is how
protocols get confused.

### 7.3 Key derivation

```
ss   = X-Wing shared secret                                    [32 bytes]
PRK  = HKDF-Extract( salt = requestHash, IKM = ss )            [32 bytes]

aeadKey = HKDF-Expand( PRK,
                       info = uint8(len(DS_AEAD_KEY)) ‖ DS_AEAD_KEY ‖ AAD,
                       L = 32 )                                [32 bytes]
```

The salt binds the derivation to the complete canonical request; the info binds
it to every public header field. HKDF's contract permits — and intends —
multiple `Expand` calls from one `PRK` under different `info`, which is how §8's
confirmation value is derived from the same `PRK`.

No password. No PBKDF. No pad byte is ever used as, or contributes entropy to, a
delivery key, and no pad byte reaches the wire outside the AEAD.

One exception, stated so it cannot be read as a contradiction: a **one-way
commitment** to the pad file (`padHash`, §7.4) is used as HKDF-Expand **info**
for nonce derivation. It is a domain separator, not key material — the key comes
from `ss` alone — and because `PRK` is secret, the public nonce reveals nothing
about the pad.

### 7.4 AEAD

AES-256-GCM (SP 800-38D). Key 32 B · nonce **12 B** · tag **16 B** (128 bits,
the full tag; truncated tags are refused).

**Nonce: derived, not drawn.**

```
padHash ← H_ds(DS_PAD, padFileBytes)                            [32 B, never on the wire]
nonce   ← HKDF-Expand( PRK, u8(len(DS_NONCE)) ‖ DS_NONCE ‖ padHash, 12 )
```

(`DS_PAD` and `DS_NONCE` are declared with the other separators in §6.2, under
the rule that their lengths are computed and never hard-coded. That rule matters
more here than anywhere else: `padHash` never reaches the wire and the nonce is
carried rather than re-derived, so a wrong length octet would **not** fail
loudly — two builds would silently produce different nonces for the same pad and
the same request, and every package would still verify. §20's `openSealed`
therefore **re-derives the nonce and compares it**, which turns that entire bug
class into a refusal.)

A random nonce would make (key, nonce) uniqueness rest entirely on the CSPRNG
producing fresh bytes. Under duplicated RNG state — a restored VM snapshot, a
cloned browser profile, a resumed mobile process image — a second seal against
the same request would reproduce the same `ss` *and* the same nonce, and every
other header field would match too, since the pad-file length is fixed by the
capacity preset and §3's container is deterministic. Two distinct pad files
under one (key, nonce) in AES-GCM does not degrade gracefully: it yields the
plaintext XOR **and** the GHASH subkey. That is the worst outcome this design
has, and it must not depend on an assumption the rest of the project declines to
make.

Deriving the nonce removes the dependency at **zero wire cost and no layout
change**. There is no circularity: `PRK` depends only on `requestHash` and `ss`;
the nonce then enters the AAD, which enters the aead-key `info`. Distinct
plaintexts under one request therefore yield distinct keys **by construction**;
identical plaintexts yield the same nonce **for a given `PRK`**.

Note precisely what that does *not* mean: `XWing.Encaps` is randomized, so a
second seal draws fresh randomness, giving a different `ct_kem`, `ss`, `PRK`,
nonce, key, ciphertext, tag, **and different §8 confirmation words**. Deriving
the nonce makes the package a deterministic function of `PRK`; it does not make
`PRK` deterministic, and it must not — §8.3's argument rests on Alice's
encapsulation randomness being fresh. Re-sealing is therefore **not** idempotent,
which is exactly why §10.5 requires the *same package* to be re-shared rather
than a new one produced.

**Re-audit of the exact invariant, claimed no more strongly than it is earned.**

- **No circularity.** `PRK ← (requestHash, ss)`; `padHash ← padFileBytes`;
  `nonce ← (PRK, padHash)`; `AAD ∋ nonce`; `key ← (PRK, AAD)`. Strictly acyclic.
- **Same `PRK` + same plaintext** → same `(key, nonce)`. Safe **only because the
  plaintext is identical**, which is AES-GCM's one permitted repetition: an
  identical (key, nonce, plaintext, AAD) yields an identical ciphertext and
  leaks nothing new.
- **Same `PRK` + different plaintext** → different `padHash` → different nonce →
  different AAD → different key. Uniqueness therefore rests on **SHA-256
  collision resistance over the pad file**, which is a *computational*
  assumption and is named as one, not smuggled in as a structural guarantee.
- **What this removes and what it does not.** It removes the dependency on
  CSPRNG *freshness* for (key, nonce) uniqueness — a duplicated RNG state no
  longer produces a catastrophic repetition with different plaintexts. It does
  **not** make the construction independent of randomness: the CSPRNG is still
  trusted for `requestId`, for X-Wing key generation, and for encapsulation, and
  a duplicated RNG state still repeats `ss` and therefore `PRK`. The honest
  claim is *"(key, nonce) uniqueness does not additionally depend on nonce
  freshness"*, not *"uniqueness is independent of all randomness"*.
- **Divergence is caught.** `openSealed` re-derives the nonce and compares
  (§20), so a build disagreeing about `len(DS_PAD)` refuses instead of silently
  forking.
- **Domain separators** remain exact and computed, never hard-coded (§6.2).

All of this is stated in §16.1's assumption list rather than left implicit.

Maximum plaintext: **16 MiB** (`16 777 216` bytes), comfortably above the
largest legitimate pad file (~11.5 MB) and far below AES-GCM's limits. A
declared `plaintextLength` above this, or one disagreeing with the actual
ciphertext length, is refused before decryption.

---

## 8. Transfer confirmation — authenticating Alice to Bob

### 8.1 Why this exists

§6 authenticates **Bob to Alice**. It does nothing in the other direction.
Bob's TPR2 is public, so **Mallory can seal a perfectly valid package** — a pad
Mallory generated — to Bob's request, and claim to be Alice.

> **"Bob can decrypt it" does not prove Alice sent it.** It proves *someone*
> encapsulated to Bob's public key. Anyone can do that.

### 8.2 Construction

```
confirmValue = HKDF-Expand( PRK,
                            info = uint8(len(DS_CONFIRM)) ‖ DS_CONFIRM ‖ AAD,
                            L = 11 )                            [88 bits]
```

rendered as **8 words = 88 bits** by `confirmationWords88`: take
`confirmValue[0..11)` as a big-endian 88-bit integer and split it into **8**
indices of 11 bits, shifts 77, 66, 55, 44, 33, 22, 11, 0, from the same pinned
wordlist (§6.4).

The two ceremonies are deliberately named apart — `requestWords132` and
`confirmationWords88` — because they render different values at different
strengths for different threat models, and confusing them would be easy and bad.

#### 8.2.1 Why 88 bits is defensible here, proved separately

This is **not** "88 is fine because the other one is stronger". They are
independent ceremonies and this one gets its own argument.

The request fingerprint faces an **offline, known-target** grind: the target is
computable from public data, so an attacker can search at hardware speed with no
interaction. The confirmation faces neither of those conditions.

- **The target is unknown.** `confirmValue` derives from `PRK`, hence from the
  X-Wing shared secret. Under §6 having succeeded, Mallory holds neither Alice's
  encapsulation randomness nor Bob's `dk`, so he cannot compute Alice's words.
  There is nothing to grind *toward*.
- **The receiver reads first (§8.2).** Bob commits to the package he actually
  opened before Alice speaks, so hearing Bob does not hand Mallory a target for
  Alice's value either — it hands him a value he must have already matched.
- **Each attempt is an online, human-rate trial.** For Mallory's package to be
  accepted, *his* `confirmValue` must equal what Alice reads. He cannot test a
  candidate without sending a package and having a human compare. Success
  probability per attempt is 2⁻⁸⁸.

Now the adversarial cases §4 requires:

| Scenario | Outcome |
| --- | --- |
| Mallory sends **many** candidate packages | Each is one online trial at 2⁻⁸⁸. Bob opens one at a time, reads its words, and they mismatch. Nothing accumulates: distinct packages give independent `ss`, so this is sampling, not grinding |
| Mallory **hears Bob read first** | Bob's words are for the package Bob opened. If that is Mallory's, Mallory already knows them; if it is Alice's, Mallory cannot have produced them. Hearing them yields no search target |
| **Alice does not reveal on mismatch** | Normative: on mismatch Alice's words stay masked and the transfer is abandoned. Mallory learns one bit ("wrong"), not 88 |
| **Retries / abandoned attempts** | Alice's target is **fixed for the life of the request** — §10.5 stores one package and never re-encapsulates. The argument therefore does **not** rest on a moving target; it rests on the target never being spoken into a round that survives. That is what makes rejection **terminal** (§10.1): once Alice's words are said aloud, the round ends one way or the other |
| **Observable but authenticated side channel** | Covered by receiver-first: an eavesdropper hears committed values, never a target to grind |
| **Malicious package ordering** | Mallory racing his package in first only means Bob opens Mallory's and reads *its* words; Alice's then mismatch and the transfer is **abandoned terminally**. Ordering buys no advantage, and the rejected session cannot be committed afterwards |

The distinguishing property is that **the confirmation has no offline oracle**.
**Four** conditions carry that, and every one is normative rather than advisory,
because dropping any of them turns this section from a proof into a hope:

1. **receiver-first** (§8.2) — Bob commits before Alice speaks;
2. **no reveal on mismatch** — Alice's words stay masked and the round ends;
3. **rejection is terminal** (§10.1) — a spoken target never outlives its round;
4. **one live session per request** (§10.1) — a rejected package cannot be
   committed later.

Conditions 3 and 4 were **missing** from the first Phase-0.5 draft, and their
absence made the proof false: an abandoned round left Alice's fixed target known
and grindable offline for up to seven days.

**Premises this argument assumes and cannot itself enforce**, stated in §6.1's
voice: that Bob opens **one package at a time** rather than collecting
candidates and choosing after hearing Alice, and that **all eight words** are
compared. Both are **OPERATOR** assumptions.

**On severity, so the repair is not over-scoped:** even in the violated case the
grind is 2⁸⁸ **X-Wing encapsulations** — roughly 2¹⁰³–2¹⁰⁸ operations, with no
ASIC tier in existence for ML-KEM — not 2⁸⁸ SHA-256 compressions. **88 bits does
not need to rise.** The conditions are made normative because the section is
written as a proof and the spec relies on it as one, not because the number was
close.

Alice sees these after sealing. Bob sees them **only** for a package he actually
decapsulated and AEAD-verified.

> **THE RECEIVER READS FIRST.** Bob speaks his words before Alice speaks hers.
> Alice MUST NOT emit her words until a package she sealed has been delivered,
> and the UI keeps hers masked until she marks Bob's as received.
>
> Like the comparisons themselves, this ordering is an **OPERATOR** assumption:
> TruePad can mask a field and order its buttons, but it cannot hear who spoke
> first. §8.2.1's proof depends on it, so it is named as an assumption rather
> than presented as a property the software enforces.

This ordering is normative, not etiquette. The side channel is required to be
*authenticated*; it is **not** required to be *confidential*. If Alice speaks
first on an authenticated-but-observable channel, Mallory can drop Alice's
package, hear her words, seal his own pad to Bob's genuine request, and grind
toward that now-**known** target. With a random nonce that grind was cheap; §7.4
now derives the nonce, which removes the free grinding input — but the ordering
rule is what makes the target unknown in the first place, and it is the control
that must not be omitted.

Because Bob has already opened a package when he speaks, his words are committed
and an eavesdropper gains nothing by hearing them.

### 8.3 Security argument

**Given that §6 succeeded** — that is, given Alice sealed to Bob's *genuine*
request — the argument runs as follows. `confirmValue` derives from `PRK`, which
derives from the **X-Wing shared secret**. Computing it requires having completed
a real encapsulation to *this* request, and it is bound through `AAD` to this
exact package. Mallory's substituted package yields a different `ss`, hence
different words.

Crucially, Mallory cannot compute *Alice's* words either: they derive from
**Alice's encapsulation randomness**, which Mallory does not hold, and the only
other route to that `ss` is Bob's decapsulation key. So — under the stated
hypothesis, and under §8.2's receiver-first rule — Mallory is not grinding
toward a known target but blind-guessing an unknown 88-bit value.

**§6 is not an extra precaution before §8; it is a *precondition* of §8's
argument.** If Mallory also substituted the request toward Alice, he holds both
shared secrets, knows Alice's words exactly, and this argument does not apply.
§6 is what excludes that case, which is why neither ceremony is optional.

A passive observer who copies Alice's package verbatim is not an attacker here:
that *is* Alice's pad, and replay is handled by §10.

---

## 9. Binding — what a substitution attack runs into

| Change | Detected by |
| --- | --- |
| Different request (key substitution) | §6 safety words, compared before sealing |
| `requestId` altered | AAD → AEAD tag fails; and receiver matches it against the pending request |
| `requestHash` altered | AAD → tag fails; receiver recomputes it from its own stored request |
| Suite ID altered | AAD → tag fails; and unknown suite refuses before any key use |
| Transfer version altered | AAD → tag fails; and unknown version refuses first |
| KEM ciphertext altered | Decapsulation yields a different `ss` → wrong key → tag fails |
| Nonce altered | AAD **and** `info` → different key → tag fails |
| Declared length altered | Structural refusal before decryption; also in AAD |
| Ciphertext or tag altered | AEAD tag fails |
| Package from a *different* request | `requestId`/`requestHash` mismatch, refused before decapsulation |
| Wrong pad sealed by Mallory | §8 confirmation words differ |

---

## 10. Lifecycle, replay, and crash safety

### 10.1 Receiver state machine

```
ABSENT
  │ create receive request  (worker generates X-Wing keypair)
  ▼
PENDING ────── cancel, or 7-day TTL expiry ──────► CANCELLED (terminal)
  │  private key in OPFS, worker-confined
  │
  │ a package arrives: structural checks, requestId/requestHash/suite/version
  │ match, decapsulate, AEAD-verify, hold the plaintext pad bytes in the worker.
  │ THE EXISTING IMPORTER IS NOT CALLED YET (see below).
  ▼
AWAITING_CONFIRMATION  (transient, in-memory, NOT durable)
  │
  ├── operator rejects ──► CANCELLED  (terminal; dk destroyed; FREE)
  │     Rejection is TERMINAL, not a retry. §8.2.1's proof requires that a
  │     confirmation value spoken aloud never outlives its round: returning to
  │     PENDING would leave Alice's target fixed (§10.5 stores one package for
  │     the life of the request) and known to anyone who heard it, on a channel
  │     §8.2 does not require to be confidential — an offline target where the
  │     proof asserts there is none. It also closes session substitution: a
  │     rejected package can never be committed later.
  │
  │     **Cost: a NEW PAD *and* a NEW RECEIVE REQUEST — not "one new
  │     request".** By the time rejection is possible Alice has already sealed,
  │     so §10.6's one-handoff marker on her pad is spent and that pad can
  │     never be sealed again. Bob's request is likewise terminal. Recovery is
  │     therefore: Alice generates a fresh pad, Bob creates a fresh receive
  │     request, and the ceremony restarts from §8.1. Any wording that prices
  │     rejection at one new request understates it by a whole pad.
  │
  │ operator confirms the §8 words
  ▼
CONSUMED  ── durable, written BEFORE the import commit ──
  │
  ▼
COMPLETE  (pad imported, transfer private key logically destroyed)
```

`PENDING`, `CANCELLED`, `CONSUMED`, and `COMPLETE` are **durable**.
`AWAITING_CONFIRMATION` is deliberately **not**: a crash there simply returns to
`PENDING`, having consumed nothing.

> **The decrypted pad bytes never leave the worker, and are never handed back
> in.** `openSealed` returns an opaque `sessionId` and the confirmation words;
> the plaintext is held in a transient worker-only session alongside the
> `requestId`, the `requestHash`, the package identity, and the `confirmValue`.
> `commitReceive(sessionId)` then imports **those same held bytes**.
>
> The Phase-0 signature `commitReceive(requestId, padFileBytes)` reintroduced
> the plaintext as a caller-supplied argument at the commit boundary, which let
> the UI substitute a *different but otherwise perfectly valid* bundle between
> the moment the operator compared Alice's words and the moment the pad was
> imported. The words would have attested one pad and the importer would have
> committed another. That signature is withdrawn.
>
> **One live session per request, enforced.** A new `openSealed` for a given
> `requestId` atomically destroys and zeroes any prior session for it, and
> `commitReceive` refuses unless its session is still the current one for that
> `requestId`. Without this, Mallory's package could be opened, rejected, and
> then still committed after Alice's was opened — importing the very pad the
> operator refused. `packageIdentity` is what that check compares, and it commits
> to the **complete** TPS2 bytes — magic through the final GCM tag. An earlier
> draft used `SHA-256(AAD)` while calling it "exactly which package"; the AAD is
> only the public header, so two packages differing solely in ciphertext or tag
> would have shared one identity. This is local bookkeeping **after** AEAD
> verification, never a substitute for it.
>
> The session is **transient by design**. A crash loses it, leaves the request
> `PENDING`, and consumes nothing — the operator re-opens the `.tps2` and the
> sender confirmation is repeated. Losing a session costs nothing *on the
> receiver axis*; it is `PAD-SPENT` overall, since a package existed to open
> (§11). Carrying a session across a crash would mean persisting decrypted pad
> bytes for no benefit.

> **`import-pair` is a single committing transaction — there is no validate-only
> mode.** `importImpl()` runs from staging straight through `writePairMeta` to
> the removal of `importing.json`, which is the commit. Calling it "to validate"
> before the operator has confirmed would make **Mallory's pad a live, usable
> pair before a single confirmation word is spoken**. Phase 1 MUST NOT call it
> before confirmation. A pre-confirmation check MUST NOT **create, write, stage
> into, or remove** anything under `<pairId>/` or `importing/<pairId>/`.
> Non-mutating **existence lookups** against `<pairId>/` are permitted and are
> *required* by §11's pre-flight; `unpackContainer()`, `validateBundleFileSet()`
> and `loadStore()` equivalents run on a private scratch copy outside both paths.

> **`requestId` collisions are handled, not assumed away.** `requestId` is the
> receiver's own lookup key and lock scope, so a collision is a storage question
> even though it is not a security identity. Generation **retries** on a local
> collision with any existing `PENDING`, `CANCELLED`, `CONSUMED` or `COMPLETE`
> record. On arrival, a package must match **both** the `requestId` **and** the
> full stored canonical request — the recorded `requestHash` — **before any
> private-key use**. `requestId` alone never selects security state; it only
> finds the candidate record whose `requestHash` then has to agree.

> **`PENDING` requests expire.** A pending request carries a durable creation
> time and a **time-to-live of 7 days**, after which it transitions to
> `CANCELLED` and its `dk` is logically destroyed. Expiry is checked on every
> access, and an expired request refuses — never silently revived.
>
> **What the TTL is for, now that the fingerprint is 132 bits.** It is *not*
> what makes request authentication strong. The 132-bit fingerprint stands on
> its own (§6.3); an earlier draft's `2⁸⁸/T` multi-target argument is **stale**,
> and on the same conservative accounting the figure is `2¹³²/T`, which at any
> plausible `T` remains far out of reach. The TTL stays for three ordinary
> reasons: a pending decapsulation key is an unnecessary long-lived liability
> (§13 #22), bounding outstanding state is operationally useful, and
> multi-target exposure exists generically. **Remove the TTL tomorrow and
> request authentication does not become weak.**

> **`PENDING → CONSUMED` is a compare-and-set, not a blind write.** It runs
> under an exclusive lock scoped to the **`requestId`** and succeeds only if the
> stored state is still `PENDING`; a lost CAS aborts as FREE. Without this, two
> tabs on one origin can each reach `AWAITING_CONFIRMATION` for the same pending
> request with two *different* packages and import both — one `dk`, two
> decapsulations, two live pads. The existing importer does not prevent it,
> because its lock is scoped to **pairId** and the two packages carry different
> pairIds, so they never contend and `pair-exists` never fires.

### 10.2 The commit ordering, and why

**`CONSUMED` is made durable BEFORE the pad import commits.**

TruePad's governing rule decides this: **loss is acceptable; reuse is not.** If
the request were consumed *after* the import, a crash between them would leave a
`PENDING` request whose one-time key had already successfully opened a package —
reusable. Consuming first means a crash between the two loses the transfer — and because
§10.6 spends the pad's one handoff on the first seal, recovery is a **new pad**,
not a re-seal of the old one.

**The ordering and its durability are two different claims, and only one of them
is unconditional.** The *ordering* is unconditional: nothing releases a pad
import before `CONSUMED` is written. The *durability* of that write is
**BROWSER-OP** — OPFS `flush()`, for which browsers document no power-loss
semantics, exactly as `PRODUCT-CLAIMS.md` row 13 and `BROWSER-SECURITY.md` §2
already state. So:

- a crash, a browser kill, or a killed tab can **never** revive a used one-time
  key, because the `CONSUMED` write has been flushed; but
- **power loss** between the flush and the medium is outside what this edition
  claims anywhere, and is therefore outside what it claims here. It is listed in
  the crash table as such rather than silently covered by an unqualified
  "never".

The pad import itself is separately crash-safe already: it validates in
`importing/<pairId>/`, then writes the `importing.json` marker **before** copying
anything into place and removes it **only after** `pair.json` is written — so the
marker's removal is the commit point, and a crash anywhere in that window leaves
an inactive, retryable pair rather than a partial active one. Sealed Pad Transfer
adds nothing to this; it reuses it exactly.

### 10.3 Crash point table

| Crash point | Request reusable? | Transfer key exists? | Pad imported? | Replay accepted? | Recovery |
| --- | --- | --- | --- | --- | --- |
| During request generation, before `PENDING` durable | n/a — no request | no | no | n/a | Create a request |
| `PENDING`, before any package | **yes** | yes | no | n/a | Normal — send the code |
| After structural checks, before decapsulation | yes | yes | no | yes (nothing happened) | Re-open the package |
| After decapsulation, before AEAD verify | yes | yes | no | yes | Re-open the package |
| After AEAD verify, before confirmation | yes | yes | no | yes | Re-open; words shown again |
| After confirmation, before `CONSUMED` durable | yes | yes | no | yes | Re-open the package |
| **After `CONSUMED` durable, before import commit** | **NO** | **still present** — destruction happens after the import commit (§20) | no | **NO** | **Transfer lost.** The pad's one handoff is spent: generate a **new pad** (§10.6). The stranded `dk` is destroyed by the same cleanup that reaps the CONSUMED record; until then it is a live key for a package that will never be imported |
| After import commit, before request cleanup | no | **still present** until cleanup runs | **yes** | no | Cleanup is idempotent, and destroying `dk` is part of it |
| Storage full during the pre-flight scratch copy (**pre**-CAS) | yes | yes | no | yes | FREE — free space, re-open the package |
| Storage full during the importer's staging or copy loop (**post**-CAS) | **NO** | **still present** until cleanup | no | **NO** | **Transfer lost** — the same accepted loss: generate a **new pad** (§10.6) |
| Browser killed at any point | as above | as above | as above | as above | State machine is the recovery |
| Two tabs, same request, different packages | **NO** — the second CAS fails | — | one only | no | The `requestId`-scoped compare-and-set is what prevents this |
| **Power loss** between the `CONSUMED` flush and the medium | **NOT CLAIMED** | — | — | — | OPFS documents no power-loss semantics (`PRODUCT-CLAIMS.md` row 13). The ordering holds; the durability of the write is BROWSER-OP, not native |

### 10.4 Replay rules

- **Before consumption**, re-processing the identical package is *allowed and
  necessary* — transport loses files, and the operator may legitimately retry.
- **After consumption**, replay is **refused**, and refused **before**
  decapsulation. A consumed request's key is never used again merely because a
  package looks valid.
- The same sealed file mailed twice is therefore harmless.
- Replay can never create a second independently consumable pad **in the
  installation that holds the pending request** — the existing importer refuses
  `pair-exists` against that origin's OPFS. The qualifier is load-bearing and is
  the code's own: *"a pair with id … already exists **in this browser**"*.

  > **Correction to the Phase-0 draft, which was cryptographically wrong here.**
  > Phase 0 said a saved `.tps2` opened "in another browser profile, another
  > browser, or after clear-site-data" reproduces the pad. **It does not.** The
  > package does not contain Bob's one-time decapsulation key; that key lives
  > only in the origin's worker-confined OPFS. A fresh origin has no `dk`, so
  > under the stated computational assumptions the file is inert there. Phase 0
  > contradicted its own threat matrix, which correctly said a stolen package
  > alone is useless.
  >
  > The accurate model has three cases:
  >
  > | Attacker holds | Result |
  > | --- | --- |
  > | `.tps2` **alone** | A computationally encrypted archive. **Not** presently openable — no `dk` |
  > | `.tps2` **+ a matching `dk`** (a restored, cloned, or still-`PENDING` recipient state) | Decrypts; reproduces the pad. This is the real risk, and it is §9's profile-rollback case, not a property of the file |
  > | `.tps2` **+ a future break** of the delivery cryptography | May become readable later — §14 |
  >
  > Deleting the package after import therefore remains **strongly recommended
  > hygiene**, but for the honest reason: it removes an archive that becomes
  > readable if the recipient key state is ever restored, or if the delivery
  > cryptography is broken later. Not because the file is a plaintext-equivalent
  > copy of the pad — it is not.
  >
  > And TruePad cannot promise deletion at all: copies already sent through
  > email, chat, cloud storage, backups, or another device are beyond any button
  > this application can render.
- Replay can never resurrect a destroyed pair: the existing importer refuses
  `pair-destroyed`, and `destroyImpl` writes the tombstone *before* it overwrites
  or unlinks anything, so even an interrupted destroy still refuses.

#### 10.4.1 The rollback boundary — inherited, not improved

Every "never" above is scoped to **the current, non-rolled-back Browser origin
state**, and Sealed Pad Transfer gets no stronger rollback claim than the
Browser Edition already has. The receive-request record, the recipient `dk`, and
the browser-local witness all live in the **same** OPFS failure domain, so a
restoration of that domain restores them together — the witness cannot testify
against a rollback that carried it along.

| Event | Pending `dk` | Consumed state | Replay possible? |
| --- | --- | --- | --- |
| Ordinary crash / tab kill | survives | survives | no — §10.2 ordering holds |
| **Full profile restore** | **restored** | **rolled back** | **YES** — a consumed request can return to `PENDING` with its `dk`, and a retained `.tps2` then decrypts again |
| **Cloned profile / OPFS copy** | **duplicated** | duplicated | **YES** — the clone can consume the same package independently |
| "Clear site data" | **destroyed** | destroyed | no — this is **LOSS**, not replay: the `dk` is gone and a retained `.tps2` becomes inert. Recovery is a **new pad** (§10.6) |
| Power loss around the `CONSUMED` flush | see §10.3 | not claimed | see §10.3 |

The two rows that matter point in opposite directions and are routinely
confused: **clear-site-data destroys the key and causes loss; profile
restore/clone restores the key and permits replay.** Only the second is a
security event, and it is the same event `PRODUCT-CLAIMS.md` row 17 and
`BROWSER-SECURITY.md` §2 already document for pads themselves.

This is why `platform-monotonic` exists for the *witness*, and why nothing
analogous exists here: a browser origin has no external authority to appeal to.
An operator who restores an old profile can replay a transfer, and TruePad
cannot detect it.

### 10.5 Sender re-sealing

**One receive request → one sealed package**, enforced by a durable transaction
rather than by convention. Phase 0 stated the rule and specified no mechanism,
so two tabs could both observe CONFIRMED, both run the **randomized**
`XWing.Encaps`, and produce two valid packages with two different confirmation
values — leaving Bob a choice he has no basis to make, and Mallory a plausible
reason to send a third.

**Three kinds of state, deliberately kept apart.** An earlier draft ran them
together into one `CONFIRMED → SEALING → SEALED { package bytes, confirmValue }`
machine persisted as a single atomic object. Phase 1B withdrew that persistence
model (§10.9), and the states it conflated are not the same kind of thing.

**A. Sender ceremony state — `CONFIRMED`.** Keyed by the complete canonical
request body, or equivalently its full `requestHash` — never by `requestId`,
which the requester chooses and which §5.1 gives no uniqueness guarantee. It
means one thing only: *the operator declared that all twelve of Bob's request
words matched over the side channel.*

**B. Transient operation state — `SEALING`.** In-memory, for the duration of one
attempt. **It is not the durable handoff authority.** A crash here, before
`handoff.json` exists, means no package escaped; the pre-commit staging may be
cleaned and the attempt retried (§10.9.1).

**C. Durable handoff state — the presence or absence of `handoff.json`.** This,
and nothing else, is what says whether the pad's one handoff is spent. For a
sealed handoff the durable data is three files (§10.9):

```
<pairId>/handoff.json          permanent commit marker — hashes and metadata
<pairId>/handoff/package.tps2  the exact package bytes
<pairId>/handoff/confirm.bin   the exact 11-byte confirmation value
```

The marker holds **hashes**, not the package and not the confirmation value.

> **Once `handoff.json` exists, the pad's handoff is SPENT** — independently of
> whether the payload is later dismissed, and independently of whether the
> marker can still be read.

Ordering, under the pad lock (§10.10.1) and the request-scoped sender lock:

1. **acquire the locks**;
2. **read the durable handoff state** inside them;
3. if a **valid sealed marker** exists → this request may only be **re-shared**:
   if `marker.requestHash` matches, return the **exact committed package and
   confirmation**; if it differs, refuse. **Never encapsulate again.**
4. if a **physical marker** or an **unreadable marker** exists → refuse;
5. if **absent** and the request is `CONFIRMED` → encapsulate **once**, build the
   package, and commit it by the marker-last transaction of §10.9.1;
6. **only after that commit succeeds** may any package byte be released to the
   UI;
7. a concurrent caller waits on the lock and receives the **same stored package**.

**If persistence fails before release, no package leaves the worker.** The
alternative — releasing bytes that were never recorded — is how Alice ends up
reading confirmation words for a package she cannot reproduce.

**CONFIRMED, defined exactly** (§11 of the closure brief): it is an **OPERATOR
declaration** — *"the full 12 request words matched over the side channel"* —
and never a cryptographic proof that the comparison happened. It is bound to the
canonical body byte-for-byte; it is **one-shot**; it is **invalidated by any
edit** of the pasted code; it carries the same **7-day TTL** as a pending
request; and confirmation of body *B* can never authorize sealing body *B′*.
**What cleanup may and may not remove.** `CONFIRMED` is ceremony state and may
be discarded when appropriate *before* a handoff commits. **Handoff-spent state
is permanent.** Dismissing a transfer may delete `handoff/package.tps2` and
`handoff/confirm.bin`; it may **never** delete `handoff.json` (§10.9.4). After a
dismissal the package can no longer be re-shared and the confirmation value is
no longer recoverable — and the pad remains handed off forever, with a new
encapsulation forbidden. Dismissal is **not** a return to `ABSENT` or to
`CONFIRMED`; there is no path back.

A crash in `SEALING` leaves `CONFIRMED` intact and no marker, so the attempt is
simply retried — safe because nothing was released.

**Re-share, not re-seal.** The **exact same package** may be saved and sent as
often as transport requires, for as long as it is still stored. What is refused
is a *second independent encapsulation* for the same request. Those two are not
degrees of the same thing: one hands over bytes that already exist, the other
runs `XWing.Encaps` again and produces a package with a different confirmation
value.

**Rollback limitation, same as everywhere.** A full profile restore can rewind
sender state too, returning SEALED to CONFIRMED and permitting a second
encapsulation. The Browser Edition has no independent anti-rollback authority to
appeal to here either (§10.4.1).

### 10.6 What may be sealed — the pairing rule

This is security-critical and Phase 0 did not address it.

**Audit of today's behaviour.** `exportImpl` (`verbs.ts`) refuses only a
destroyed pair, an incomplete import, and a missing pair. There is **no
once-only guard and no handoff state anywhere in the codebase**, and the pad
screen deliberately offers *"Save the pad file again"* — re-export is a feature,
so that a lost courier copy can be re-delivered.

That is safe for a *physical* courier, where the operator hands one medium to
one person and knows they did. It is **not** safe to inherit unchanged into an
online transfer, where re-sealing to a second request is one click and leaves no
trace. If Alice seals the same live pad to Bob **and** to Charlie, both hold the
same directional material and both will consume it independently — **a two-time
pad**, which is the worst outcome this product has.

**The frozen v1 rule.** Sealed Pad Transfer is a **pairing ceremony**, not a
distribution channel:

1. **Locally generated, at genesis, only.** A pad may be sealed only by the
   installation that **generated** it, and only while it is at genesis — both
   directions with `nextOffset`, `nextSequence` and `attemptsReserved` all zero,
   read from the **live store**, never from bytes a caller supplied. `loadStore`
   already returns all three as a pure non-mutating read, so this is checkable.
2. **One pad → one sealed handoff, ever.** A durable per-`pairId` **handoff
   marker** is written when a package is first sealed; §10.9 owns its grammar
   and this section does not restate it. A seal is refused when any marker
   exists. If a valid **sealed** marker's `requestHash` matches the body being
   sealed, the committed package may be **re-shared** exactly as stored — but
   never encapsulated again (§10.5, §10.8).
3. **Provenance, NOT a marker, is what an import records.** Phase 0.5's first
   draft said "the marker is also written on import", and that is now wrong:
   the handoff marker is the *sender's* record of having handed a pad off, and
   **an installation that imported a pad is not that pad's sender**. Writing one
   there would claim a handoff this installation never performed.

   The hole is real and the repair is provenance. The marker lives in the
   sealer's origin; it is **not** in the sealed plaintext — `packContainer()`
   carries exactly the six `BUNDLE_FILES`, and `pair.json` is not among them. So
   without a rule, a pad that *arrives* lands at genesis with no marker and
   passes (1) and (2) unchanged:

   > Alice seals pad P to Bob → Bob imports it at genesis → **Bob seals the same
   > pairId to Charlie.** Alice and Charlie now hold the same directional
   > material, both starting at offset 0: keystream reuse **and** reuse of the
   > same Wegman–Carter keys. No operator error, no rollback, no physical path
   > — just the protocol working as specified.

   Both import paths — ordinary courier and, later, sealed — therefore write
   `origin: "imported"` on `pair.json` (§10.7), and **no handoff marker**. The
   division of labour is exact:

   * the **sender's one-handoff state** is local to the installation that hands
     a pad off, and only that installation writes it;
   * **receiver provenance** records that the pad arrived from elsewhere;
   * `imported` provenance makes **both** future physical export and future
     sealed transfer ineligible (§10.7.1).

   **An imported pad can never be sealed onward, nor exported onward**, whether
   it arrived sealed or by ordinary courier. `handoff.json` is never placed in
   the courier bundle, and is never created merely because a pad was imported.

**Recovery when a transfer is lost is a NEW PAD, not a re-seal.** §10.2's
accepted loss, a TTL expiry, and a cleared recipient all produce the same
situation: the request is spent, and a *new* request has a new body and hence a
new `requestHash`, which rule (2) refuses. That collision is resolved in favour
of rule (2), deliberately and at a stated cost:

> **The pad's one handoff is spent. Generate a new pad and repeat the ceremony;
> the old pad can never be re-sealed.**

The permissive alternative — "allow a re-seal when the transfer failed" — is
rejected because **the sender cannot distinguish "Bob never imported" from "Bob
imported and says he didn't."** A protocol that takes the sender's word for that
is a two-time-pad generator with extra steps. Generating a new pad costs
seconds; the alternative costs the security of every message the pad protects.
A revocation ceremony could relax this and is explicitly out of scope for v1.

**The cross-mode gap is closed in §10.8, not left to the operator.** Rules
(1)–(3) alone still permit the mixed path — seal pad P to Bob online, then use
*"Save the pad file again"* to hand the same P to Charlie physically — because
nothing today records that a pad left by the physical route. §10.8 freezes the
policy that closes it. What remains an **OPERATOR** assumption after §10.8 is
narrower and stated there.

---

---

### 10.7 Provenance — the frozen representation

§10.6(3) requires provenance. Phase 0.5 offered Phase 1 a choice between "the
same durable marker" and "an `origin` field on `pair.json`". **That choice is
withdrawn. The representation is `origin` on `pair.json`, and only that.**

**Why not the handoff marker.** The marker is `{ pairId, requestHash, at }`. An
imported pad has no `requestHash` of its own on the courier path and no
*sender-side* one on the sealed path, so recording provenance in it would mean
inventing a sentinel `requestHash` and teaching rule (2)'s equality test to
special-case that sentinel. Two different facts — *"this pad's one handoff is
spent on request X"* and *"this pad did not originate here"* — would then share
one record and one comparison. Overloading a security predicate to carry a
second meaning is how the Phase 0.5 hole was created in the first place.

**The frozen field.** `pair.json` gains exactly one field:

```
origin: "generated-here" | "imported"
```

Written by `gen` as `"generated-here"`, by every import path as `"imported"`.
`origin` is a statement the installation makes about **itself**, and it is only
as trustworthy as the origin it lives in: OPFS is reachable from the page as well
as the worker, so script execution in the TruePad origin can rewrite it. That is
endpoint compromise (§15), which already has everything; it is not a hole this
field could close. What the field *does* close is the remote attacker's route,
and that is the one that matters here.

`pair.json` is browser-local: it is **not** among the six `BUNDLE_FILES`
(`a-to-b/{head.json,secret.bin,journal.log}` and `b-to-a/{…}`), so a sender
cannot put a chosen `origin` into a bundle and have the importer believe it. The
value is written by the *importing* installation about itself.

**Fail-closed, exactly like `witness`.** `readPairMeta` already refuses a
`witness` value it does not recognise (`corrupt-pair-meta`). `origin` gets the
same treatment: a present-but-unrecognised value is `corrupt-pair-meta`, not a
default. Unknown *other* fields stay tolerated, as today.

**The third state is `unknown`, and it is not a value on disk.** A `pair.json`
with no `origin` — or no `pair.json` at all, which `readPairMeta` today answers
with defaults — yields `origin = unknown` in memory. `unknown` is never written.

### 10.7.1 What each provenance may do

**A pad whose provenance is `unknown` may not be sealed.** This follows from
§10.6(1) as a matter of fact, not of caution: TruePad cannot tell a
locally-generated legacy pad from one that arrived by courier before this field
existed, and it must not guess in the direction that produces a two-time pad.

**And an `imported` pad may not be exported onward either.** An earlier draft
gated *sealing* only, and said ordinary physical export was unchanged for
imported pads. That left the same two-time pad reachable at walking pace:

> Alice hands the pad to Bob → Bob imports it → Bob picks **"Save the pad
> file"** → Bob gives that file to Charlie. Bob and Charlie now hold
> independently consumable copies of the same directional material and the same
> Wegman–Carter keys. No operator error by the product's own rules — just the
> forwarding the sealed path already refuses, done with a file manager.

Before provenance existed there was nothing to check. Now there is, so the rule
covers **both** software-mediated routes:

| `origin` | First software-mediated handoff (export **or** seal) | Everything else — send, open, retire, destroy |
| --- | --- | --- |
| `"generated-here"` | **yes** — export or seal, subject to §10.6 and §10.8 | unchanged |
| `"imported"` | **never, by either route** | unchanged |
| `unknown` (absent field, or absent `pair.json`) | **physical export only**, never sealed | unchanged |

`unknown` keeping physical export is a **legacy compatibility boundary, and not
evidence that forwarding is safe**. Pads written before this field exists must
keep working, and for them TruePad genuinely does not know where the pad came
from; the operator assumption of §10.8 is all there is. It is stated as a
concession, not a finding.

Send, open, retire and destroy are untouched for every value. An imported pad is
a fully working pad — it simply cannot be passed on again.

**No migration, no backfill, no "assume generated-here for pads older than X".**
A backfill would have to guess, and a wrong guess is exactly the two-time pad.
The absence of a field is information: it means *nobody recorded this*.

### 10.7.2 The ordinary courier path records `imported` too

§10.6(3) is usually read as being about sealed transfer. It is not. **Any**
import must record `"imported"`, including the ordinary courier import that
predates this document — otherwise Bob imports a pad file from a USB stick and
seals it onward to Charlie, which is the same two-time pad by a different route.

**Frozen write ordering.** It introduces no new failure window, because it adds
no new write:

1. `importImpl()` stages under `importing/<pairId>/` exactly as today;
2. the commit sequence writes `pair.json` — **`origin: "imported"` is a field of
   that same object, written by that same call**, never a second file and never
   a later write;
3. the commit completes by **removing `importing.json`**, exactly as today.

A crash between (2) and (3) leaves `importing.json` present, so
`committedPairExists()` still returns **false**, the pad is still not committed,
and `discardIncompleteImport` still cleans it. A crash before (2) leaves no
`pair.json`, hence `origin = unknown` on any partial remains — which §10.7.1
already refuses to seal. **There is no ordering in which a committed pad exists
without provenance**, and no ordering in which a crash upgrades a pad's
provenance.

`gen` is the mirror image: `origin: "generated-here"` is a field of the
`pair.json` that creating the pad already writes. If that write is lost, the
result is `unknown` — unsealable, fail-closed, and the operator generates
another pad.

### 10.8 Cross-mode handoff — physical and sealed

**The problem.** Export is repeatable by design: `exportImpl` refuses only a
destroyed pair, an incomplete import, and a missing pair, and the pad screen
offers *"Save the pad file again"* so a lost courier copy can be re-delivered.
Sealing is once-only. Two modes with different rules over one pad is a gap
unless the policy spans both, and §10.6(2)'s marker only ever sees the sealed
side.

**The frozen policy: one pad, one handoff, whichever mode it used.**

The handoff record of §10.9 gains a `mode` and is written by **both** paths:

First, provenance (§10.7.1): an `imported` pad is refused **both** routes, and
an `unknown` pad is refused sealing. What follows applies to a pad this
installation generated.

| First handoff | Then export again | Then seal |
| --- | --- | --- |
| none yet | allowed — records `mode: "physical"` | allowed (subject to §10.6, §10.7) |
| `mode: "physical"` | **allowed, unchanged** — this is the re-delivery affordance | **refused** — `pad-already-handed-off` |
| `mode: "sealed"` | **refused** — `pad-already-sealed` | **re-share only, never a new encapsulation** — see below |

**What "then seal" means once a sealed marker exists.** Spelled out, because
"refused unless the same `requestHash`" read like permission to seal again:

| Situation | Outcome |
| --- | --- |
| same `requestHash`, committed package still stored | return the **exact stored package and confirmation**. **No new X-Wing encapsulation.** |
| same `requestHash`, payload dismissed, missing, or corrupt | refuse — **spent and unrecoverable**. Still no reseal. |
| different `requestHash` | refuse |

Three deliberate asymmetries, each with its reason:

* **Export after export stays allowed.** It is a shipped affordance with a real
  purpose, and the physical courier's safety has always rested on the operator
  knowing who they handed the medium to. Retroactively refusing it would break
  working deployments to buy nothing the operator was not already assuming.
* **Seal after export is refused.** TruePad cannot know whether an exported file
  reached a third party, was a backup, or is still on the operator's disk. The
  conservative reading is the only safe one, and the recovery — generate a new
  pad — costs seconds.
* **Export after seal is refused.** This is the one *new refusal on an existing
  verb* that this document requires of Phase 1, and it is the row that
  closes the gap §10.6 could not reach. Post-seal export has no legitimate
  purpose: the recipient already holds the pad, delivered. Its only uses are a
  hazardous backup of live material and the exact "seal to Bob, save to
  Charlie" two-time pad.

**What is still an operator assumption, stated narrowly.** A first export is
recorded as a handoff whether the operator handed the file to someone or merely
made a backup; TruePad cannot distinguish them, and deliberately assumes the
worse. And nothing here constrains what a person does with a file that has
already left: *n* physical copies of one pad remain *n* copies. The assumption
that survives §10.8 is **not** "one pad, one other person" — it is the narrower
**"a pad file, once exported, went to at most one other person."**

**Why re-export stays open for a physical marker, when forwarding does not.**
The distinction is what the software actually knows. For a `generated-here` pad
whose first handoff was physical, TruePad cannot tell a re-save destined for the
same peer from one destined for a third person — so the operator assumption
above is genuinely all there is, and refusing "Save the pad file again" would
break a shipped affordance to buy nothing. For an `imported` pad it is not a
question of assumption: the pad demonstrably **already arrived from somewhere
else**, so a copy leaving here is a second recipient by construction. Software
refuses what it knows, and documents what it cannot.

### 10.9 The sender handoff record — marker-last, not one atomic file

**The Phase-0.6 model is withdrawn.** It required the marker, the sealed package
and the confirmation value to land in **one** `handoff.json` by a single atomic
replace, on the reasoning that two writes admit a crash between them.

That reasoning was right about the hazard and wrong about the primitive.
`OpfsVfs.writeFileAtomic()` is genuinely atomic only where
`FileSystemFileHandle.move()` works; elsewhere it falls back to

```
truncate(0)  →  write  →  flush
```

on the target itself, so a crash leaves a target that **exists and is wrong**.
"One atomic replace" was therefore not a primitive this product has everywhere.
Two repairs were available and both are refused: narrowing supported browsers to
make the old prose true would choose the document over the users, and calling
the fallback atomic would be false. The transaction is restructured instead.

**Frozen layout.** Three browser-local files. None is Store Format v2, and none
travels in the six-file courier bundle — this is bookkeeping *about* a pad, not
part of it.

```
<pairId>/handoff.json            the permanent COMMIT MARKER
<pairId>/handoff/package.tps2    the exact TPS2 bytes    (sealed only)
<pairId>/handoff/confirm.bin     the exact 11 bytes      (sealed only)
```

**Frozen marker.** Canonical JSON, written in exactly this property order:

```
physical: { "version":1, "pairId", "mode":"physical", "at" }

sealed:   { "version":1, "pairId", "mode":"sealed", "at",
            "requestHash",      // canonical unpadded base64url, 32 bytes
            "packageIdentity",  // ditto — SHA-256 of the COMPLETE package
            "confirmHash" }     // ditto — SHA-256(confirmValue)
```

The reader need not depend on property order, but refuses everything else: a
non-object, a missing or extra field, a wrong version, a pairId that is not 32
lowercase hex or names another pair, an unsupported mode, a non-canonical
timestamp, malformed or padded or non-canonical base64url, a wrong decoded size,
a physical marker carrying sealed-only fields, and a sealed marker missing any
of them. No permissive defaults anywhere.

`packageIdentity` is the §10.1 definition — SHA-256 over the complete TPS2
bytes — and there is exactly one such definition in the codebase. `confirm.bin`
holds the 11-byte value and nothing else: never words, never indices, never a
mnemonic. The marker keeps only `SHA-256(confirmValue)`, so a dismissed
confirmation is genuinely gone.

### 10.9.1 The marker-last transaction

Under `vfs.withLock(pairId)` — the store's own pad lock (§10.10.1):

1. require the marker **absent**;
2. remove recognised pre-commit staging (safe only because there is no marker);
3. write `package.tps2`; 4. read it back and require byte equality;
5. require `SHA-256(package) == packageIdentity` as supplied;
6. write `confirm.bin`; 7. read it back and require byte equality;
8. compute `confirmHash`; 9. build the marker;
10. **write `handoff.json` LAST**; 11. read it back and strict-parse;
12. require it to describe the staged bytes;
13. only now may any package byte or confirmation datum reach a caller.

`handoff.json` **is** the commit point. Everything before it is pre-commit and,
by invariant, was never released — so it can be discarded and retried. Everything
after it is spent.

### 10.9.2 Existence is load-bearing

**A `handoff.json` that exists but cannot be read is not "no handoff".**
Empty, truncated, malformed, semantically invalid, or merely unreadable, it means
`HANDOFF-SPENT / STATE UNREADABLE`, and every operation that could produce
another recipient copy refuses. The file is never auto-deleted, never
auto-repaired, and never interpreted as absence. There is no
`catch { return absent }` on this path.

This is how the non-atomic fallback fails safely, and it has a price, stated
plainly:

> **A torn marker may cost the handoff. It must never reopen the pad.
> LOSS IS ACCEPTABLE. REUSE IS NOT.**

The operator is told that TruePad cannot determine the handoff state and
therefore will not create another copy. They are **not** told to delete the
file — that is precisely the action that would convert a lost handoff into a
reused pad.

### 10.9.3 Crash points, frozen

| Crash point | Marker | Released? | Then |
| --- | --- | --- | --- |
| before staging | absent | no | retry |
| package torn | absent | no | staging is a pre-commit orphan; clean and retry |
| package done, before confirm | absent | no | clean and retry |
| package + confirm done, before marker | absent | no | clean and retry |
| **during the marker's fallback write** | **exists, maybe corrupt** | no | **SPENT / unreadable — never retry with another package** |
| marker written, worker dies before replying | valid | no | reload the **exact** staged bytes, verify against the marker, return them — **never re-encapsulate** |
| marker valid, package missing or altered | valid | — | **SPENT / unrecoverable** — no reseal |
| marker valid, confirmation missing or altered | valid | — | **SPENT / unrecoverable** — no reseal |

### 10.9.4 The marker is permanent

Once `handoff.json` exists it is **never deleted** by normal product operation —
not on dismissal, download, share, retry, transfer completion, or removing the
pad from the ordinary UI. Dismissing a sealed transfer may delete
`handoff/package.tps2` and `handoff/confirm.bin`; it may not delete the marker.
After that cleanup the pad stays permanently handed off, a same-request re-share
is correctly unavailable, and **no new package is created in its place**.

### 10.9.5 What the storage layer is not

The substrate persists bytes a caller has already produced. It does not parse
TPR2, generate keys, encapsulate, choose a pad, judge genesis eligibility, or
verify any human ceremony — Phase 1C owns all of that, and a storage layer that
guessed at authorization would be a second, weaker gate. In particular it takes
no `origin` argument: provenance is the caller's check (§10.7.1), enforced where
the product decision is made.

**Not a witness.** These files are browser-local bookkeeping. A profile rollback
can rewind them exactly as it can rewind sender state (§10.5) and receiver state
(§10.4.1), and the Browser Edition has no independent authority to appeal to.
Recorded, not claimed away.

### 10.10 The receive session across tabs

§10.1's session is "transient, worker-only, in-memory". A browser profile can
have several tabs open on TruePad, each with its own worker, so *in-memory* is
per-worker — and Phase 0.5 never said what happens when two of them open
packages for one request.

**Frozen: one live receive session per request, held by a Web Lock for the
session's entire lifetime.**

1. `openSealed` acquires the Web Lock `"spt-recv:" ‖ requestId` **before**
   decapsulating, and **holds it until the session ends** — by
   `commitReceive`, by rejection, or by the worker going away.
2. A second tab calling `openSealed` for the same `requestId` does not queue
   behind it: it requests the lock with `ifAvailable`, fails immediately, and
   refuses with *"this transfer is already open in another tab"*. Queueing would
   let a second decapsulation start the moment the first session ended, which is
   precisely the substitution §10.1 forbids.
3. The lock releasing on worker teardown is the crash story: a closed tab drops
   the lock, the transient session dies with it, the request stays `PENDING`,
   and the operator re-opens the `.tps2` (§10.1). No durable cleanup, no lease,
   no timeout to tune.

**Why a Web Lock and not a durable flag.** A durable "session open" flag would
survive the crash that the session itself does not, and would need reaping. The
lock's lifetime is exactly the session's lifetime, which is the property wanted.

**The lock spans two RPCs, so it must be released on four paths, not three.**
`openSealed` and `commitReceive` are separate calls; the worker holds the lock by
keeping the `navigator.locks.request` callback pending between them. It is
released on commit, on rejection, and on worker teardown — and, **frozen here
because it is the one an implementation forgets**, on an explicit
`abandon(sessionId)` when the operator closes the transfer without deciding. Without
`abandon`, an abandoned session blocks the request for its own tab as well as
every other, and the only cure is closing the tab. `abandon` zeroizes the session
exactly as rejection does but leaves the request `PENDING`: abandoning is not
rejecting, and only rejection is terminal (§8.2.1).

### 10.10.1 The frozen lock namespace

Four scopes, and **no prefix keyed by two different things**. An earlier draft
used `"spt-req:"` for the sender's `requestHash` *and* the receiver's
`requestId`; they never collide (32-byte vs 16-byte values) but one prefix
standing for two key types is a trap, not a design.

| Scope | Lock | Held by |
| --- | --- | --- |
| a pad | **`vfs.withLock(pairId)`** — the store's existing pad lock | `seal`, `exportPad`, `import-pair`, `destroy` |
| sender state for one request | `"spt-send:" ‖ requestHash` | `seal` |
| a live receive session | `"spt-recv:" ‖ requestId` | `openSealed` … `commitReceive`/`reject`/`abandon` |
| the receiver's request record | `"spt-req:" ‖ requestId` | the CAS, cancellation, expiry |

**The pad lock is the store's own lock, not a new one.** A bespoke
`"spt-seal:" ‖ pairId` would have been a *second* lock over the same pad, and
two locks over one object exclude nothing: a seal reading `<pairId>/` and an
import writing it would each hold their own and proceed. Sealed Pad Transfer
takes the lock the importer already takes.

**Why no deadlock, stated rather than assumed.** `seal` acquires pad → sender
state; `commitReceive` acquires session → request → pad. A cycle would need
someone holding a sender-state lock and waiting on a pad, session, or request
lock. Only `seal` ever takes `"spt-send:"`, and it already holds the pad lock
and takes nothing further. The wait-for graph therefore has no cycle. This is
the argument that must be re-checked before **any** new lock is added.

### 10.10.2 `commitReceive` lock ordering

`commitReceive` runs inside the session, so it already holds
`"spt-recv:" ‖ requestId`. It then needs the `requestId`-scoped lock for the CAS
(§20) and the pairId scope for the import (`vfs.withLock(pairId)`).

**Frozen order, outermost first:**

```
"spt-recv:" ‖ requestId      (already held, since openSealed)
  → "spt-req:" ‖ requestId    (the CAS)
    → vfs.withLock(pairId)    (the import)
```

Never the reverse, at any depth: **a request-scoped lock is always acquired
before a pad-scoped lock on this path.** §20's `seal()` nests the other way —
pad outermost, then `"spt-send:" ‖ requestHash` — and §10.10.1 shows why the
combination still cannot cycle: nothing that holds `"spt-send:"` waits on
anything. That argument, not the ordering rule, is what makes the pair safe, and
it is the thing to re-check before adding a lock.

The CAS lock and the pairId lock are released on the way out; the session lock
is released last, when the session is forgotten.

### 10.10.3 Terminal rejection destroys every session, everywhere

§8.2.1 makes operator rejection **terminal**: the request moves to `CANCELLED`
and `dk` is destroyed. For that to mean anything across tabs:

1. The transition is written **durably first** — `PENDING → CANCELLED` with `dk`
   logically destroyed — under the `"spt-req:" ‖ requestId` lock, before any UI
   acknowledgement.
2. The rejecting session is discarded immediately: its `padFileBytes`,
   `confirmValue` and `packageIdentity` are zeroized and the session lock
   released.
3. **Any other session for that `requestId` is dead by construction**, not by
   notification. §10.10 permits only one live session per request, so there is
   no second session to hunt down. A tab that still displays a stale session
   fails at its next call: `commitReceive` resolves the session, finds the
   request `CANCELLED`, and refuses.
4. `openSealed` on a `CANCELLED` request refuses before decapsulating (§20),
   so a package for a rejected round can never be re-opened — including the
   package that was rejected.

**No cross-tab message is required, and none is trusted.** A `BroadcastChannel`
notice may be sent to make other tabs *look* correct sooner, but it is a UI
courtesy: correctness rests entirely on the durable `CANCELLED` state and the
single-session rule, both of which a tab that missed the message still hits.

---

## 11. Failure taxonomy

**A failure has two independent costs, and one table column cannot carry both.**

* **Receiver axis — the receive request.**
  `REQUEST-FREE` = the request was not consumed and is still usable.
  `REQUEST-LOST` = the request is consumed; Bob must create a new one.
* **Sender axis — the one handoff.** It records what *this attempt* did.
  `HANDOFF-UNSPENT` = this attempt did not seal.
  `HANDOFF-SPENT` = this attempt sealed, so §10.6's one-handoff record is
  burned. **That pad can never be sealed again, whatever happened at Bob's
  end.** Recovery costs a new pad, not a retry.
  A refusal caused by a handoff *already* spent by an earlier ceremony is
  `HANDOFF-UNSPENT` on this axis — this attempt changed nothing — and the pad
  is of course still spent. That row says so in its own text.

**Who can observe which axis.** The two axes are observed by **different
people**, which is why neither party's screen can simply print the Outcome
column. Bob's installation knows the receiver axis exactly and can only *infer*
the sender axis — a forged package means no genuine pad was ever sealed. Alice's
installation knows the sender axis exactly and learns the receiver axis only if
Bob tells her. So: **each side is shown the axis it actually knows**, and the
Outcome column below is the *ceremony's* cost as an outside observer with both
halves would score it. It is the ledger this document reasons in, not a string
to render.

**`REQUEST-FREE` is narrower than it sounds on a `PAD-SPENT` row.** Bob's request
is genuinely still `PENDING` and still usable — but not with the same pad, since
Alice's is spent. In practice a `PAD-SPENT` outcome means Alice generates a new
pad and seals *that* to Bob's surviving request. The request being reusable is
what saves Bob from reading twelve words aloud again; it does not save the pad.

**Never report a failure as "nothing changed" once the handoff is spent.** The
earlier one-dimensional table did exactly that: every row after `seal()` said
FREE, which was true of Bob's request and false of Alice's pad. An operator
reading "nothing changed" after a mid-ceremony failure would reasonably retry
with the same pad — and §10.6 will refuse, correctly but confusingly, unless the
failure told the truth the first time. The honest three outcomes are:

| Outcome | Means |
| --- | --- |
| `FREE` | `REQUEST-FREE` **and** `HANDOFF-UNSPENT` — genuinely nothing changed |
| `PAD-SPENT` | `REQUEST-FREE` but `HANDOFF-SPENT` — Bob's request survives; **Alice needs a new pad** |
| `LOSS` | `REQUEST-LOST` and `HANDOFF-SPENT` — new pad *and* new request |

`FREE` is reserved for the pre-seal rows. It is not a synonym for "recoverable".

| Failure | Receiver axis | Sender axis | Outcome |
| --- | --- | --- | --- |
| malformed receive request | `REQUEST-FREE` | `HANDOFF-UNSPENT` | FREE |
| unsupported transfer version | `REQUEST-FREE` | `HANDOFF-UNSPENT` | FREE |
| unsupported suite | `REQUEST-FREE` | `HANDOFF-UNSPENT` | FREE |
| request fingerprint not confirmed by operator (§8.1) | `REQUEST-FREE` | `HANDOFF-UNSPENT` | FREE |
| sender's pad ineligible to seal (§10.6: imported, legacy, or already handed off) | `REQUEST-FREE` | `HANDOFF-UNSPENT` | FREE — refused before `seal()` |
| request not found / cancelled / expired | `REQUEST-FREE` | `HANDOFF-SPENT` | **PAD-SPENT** |
| request already consumed | `REQUEST-FREE` | `HANDOFF-SPENT` | **PAD-SPENT** — refused before decapsulation |
| requestId / requestHash mismatch | `REQUEST-FREE` | `HANDOFF-SPENT` | **PAD-SPENT** |
| malformed sealed package | `REQUEST-FREE` | `HANDOFF-SPENT` | **PAD-SPENT** |
| oversized sealed package | `REQUEST-FREE` | `HANDOFF-SPENT` | **PAD-SPENT** |
| KEM decapsulation failure | `REQUEST-FREE` | `HANDOFF-SPENT` | **PAD-SPENT** |
| AEAD verification failure | `REQUEST-FREE` | `HANDOFF-SPENT` | **PAD-SPENT** |
| derived-nonce mismatch (§7.4) | `REQUEST-FREE` | `HANDOFF-SPENT` | **PAD-SPENT** — checked after AEAD verification |
| receive session lost, unknown, or already used | `REQUEST-FREE` | `HANDOFF-SPENT` | **PAD-SPENT** — re-open the package |
| operator rejects the §8.2 confirmation words | **`REQUEST-LOST`** | `HANDOFF-SPENT` | **LOSS** — rejection is terminal (§8.2.1); the request moves to `CANCELLED` |
| container malformed / wrong file set / bad pairId (pre-flight) | `REQUEST-FREE` | `HANDOFF-SPENT` | **PAD-SPENT** |
| header reconciliation failure, or a non-`none` `rollback.witnessClass` (a CLI-origin store) | `REQUEST-FREE` | `HANDOFF-SPENT` | **PAD-SPENT** — `loadStore()` runs in the pre-flight on a scratch copy |
| duplicate pair (`pair-exists`) | `REQUEST-FREE` | `HANDOFF-SPENT` | **PAD-SPENT** |
| destroyed pair (`pair-destroyed`) | `REQUEST-FREE` | `HANDOFF-SPENT` | **PAD-SPENT** |
| request consumed concurrently (compare-and-set lost) | `REQUEST-FREE` | `HANDOFF-SPENT` | **PAD-SPENT** |
| any failure strictly **after** the CAS — storage mid-commit, or a pairId-scoped state change (a concurrent `destroy` or courier import) landing between the pre-flight and the commit | **`REQUEST-LOST`** | `HANDOFF-SPENT` | **LOSS** |

Two rows are `REQUEST-LOST`: the terminal rejection of §8.2.1, and any failure
after the CAS. Every other post-seal row leaves Bob's request reusable and
Alice's pad spent — which is precisely why the second column has to exist.

**Every check that can be made without committing MUST be made while the request
is still `PENDING`.** Only a failure that can occur strictly *after* `CONSUMED`
is durable is `REQUEST-LOST`. This is a statement about the **receiver axis
only** — it never makes the sender's handoff unspent.

This requires an explicit **pre-flight**, because §10.2 orders the `CONSUMED`
compare-and-set *before* the import commit, and `import-pair` has no
validate-only mode (§10.1). Classifying the importer's refusals as FREE is
therefore only honest if they are detected **before** the CAS. The pre-flight
runs, in the worker, on a private copy, touching nothing:

| Pre-flight check | Mechanism | Mutating? |
| --- | --- | --- |
| container well-formed | `unpackContainer()` equivalent | no |
| exactly the 6 expected files, no duplicates | `validateBundleFileSet()` equivalent | no |
| pairId is 32 lowercase hex | regex | no |
| both halves load and reconcile | `loadStore()` on a **private scratch copy** outside `<pairId>/` and `importing/<pairId>/` | no |
| pair not destroyed | `exists(<pairId>/destroyed.json)` | **no** — a pure lookup |
| pair not already present | **`committedPairExists(<pairId>)`** — the importer's own predicate, verbatim | **no** — pure lookups |

> **The duplicate check must be `committedPairExists()`, not a paraphrase of
> it.** That predicate returns **false** when `<pairId>/importing.json` is
> present, because a pair still carrying the marker is *not committed* and a
> retry may legitimately clean and redo it (`discardIncompleteImport`). Spelling
> it as a bare `exists(<pairId>/…/head.json)` would break exactly the recovery
> §10.3 documents for its one accepted loss: a crash after `CONSUMED` during the
> importer's copy loop leaves both `importing.json` **and** `a-to-b/head.json`,
> and the naive predicate would then refuse `pair-exists` **forever**, making the
> pad permanently unimportable in that browser — while the real importer would
> have cleaned it and completed.

All six are `REQUEST-FREE` — `PAD-SPENT` overall, since reaching them means a
package was sealed — and they cover every ordinary mistake: a corrupt bundle, a
duplicate pairId, a tombstoned pair. `loadStore()` belongs in the pre-flight too: its inputs are entirely the bundle
bytes plus the pairId/direction cross-check, all deterministic, so it runs on a
private scratch copy and its refusals — including a CLI-origin store whose
frozen witness class the browser cannot honour — are FREE. What remains
genuinely `REQUEST-LOST` is only **storage failing mid-commit**, because that is the sole
refusal reachable after the one-time key has been spent.

An earlier draft classified the importer refusals as LOSS outright, which would
have turned every ordinary mistake into a permanent transfer loss; a later one
classified them FREE without saying how, which would have reported a consumed
request as "nothing changed"; the version after that said how, but still owed the
operator the other half — those rows are `REQUEST-FREE` and `HANDOFF-SPENT`, not
"nothing changed". The pre-flight is what makes the `REQUEST-FREE` half true
rather than convenient; the second axis is what keeps the sentence honest.

Decapsulation and AEAD failures are reported as **one** indistinguishable
outcome ("this package could not be opened for this request") so the protocol
offers no decapsulation oracle.

The derived-nonce mismatch is deliberately a **distinct** named outcome rather
than part of that blob. It is reachable only *after* a valid 128-bit GCM tag, so
it tells an attacker nothing he did not already have to know; folding it in would
discard the only signal the §7.4 re-derivation exists to produce — a build
disagreeing about `len(DS_PAD)`.

---

## 12. Privacy and metadata

| Field | Public? | Stable? | Linkable? | Necessary? | Bound how |
| --- | --- | --- | --- | --- | --- |
| TPR2 version, suite | public | constant | no | yes — parsing | fingerprint, AAD |
| TPR2 `requestId` | public | **one-time** | no | yes — binding | fingerprint, AAD |
| TPR2 encapsulation key | public | **one-time** | no | yes — the KEM | fingerprint, AAD |
| TPS2 `requestHash` | public | one-time | to *that* request only | yes — binding | AAD, KDF salt |
| TPS2 KEM ciphertext | public | one-time | no | yes | AAD |
| TPS2 nonce | public | one-time | no | yes | AAD, KDF info |
| TPS2 plaintext length | public | — | no | yes | AAD |
| pairId, pad name, capacities, counters, source declarations, witness config | **encrypted** | — | — | — | inside the AEAD plaintext |

**No stable user identifier exists anywhere in either artifact.** Every field is
freshly random or a constant. Two receive requests from the same person are
**not linkable by any TruePad protocol field**.

**Unavoidable leakage:** that a package exists; its byte length (≈ pad-file
size, hence roughly the pad's capacity tier); the protocol and suite; the
`requestId` and `requestHash`; and the public KEM material.

Length is **not** padded in v1. Padding to hide capacity tier would cost up to
11 MB of transfer per message to conceal a three-way distinction the recipient
learns seconds later anyway, when the pad is imported. The cost is not justified;
the leakage is documented instead.

Linkability from IP address, email account, or chat transport is **outside
TruePad** and is not addressed by this protocol.

---

## 13. Threat matrix

| # | Attack | Expected result | Property relied on | Residual |
| --- | --- | --- | --- | --- |
| 1 | Passive network observer | Learns package exists, length, suite, public KEM fields | AEAD confidentiality | Length ≈ pad size |
| 2 | Active request substitution | **Refused** — words differ | §6 fingerprint over the complete request | Operator must actually compare; and the ASIC tier is **not** excluded by the fingerprint — see #30, §6.3, §16.5 |
| 3 | Malicious replacement TPR2 | As #2 | §6 | As #2 |
| 4 | Malicious replacement TPS2 | Refused — AEAD tag | AAD covers every header field | — |
| 5 | Bit modification anywhere | Refused | AES-GCM | — |
| 6 | Sealed to wrong recipient | Refused at decapsulation/AEAD | KEM | Alice must verify words first |
| 7 | Fake sender (Mallory's pad) | **Refused** — confirmation words differ | §8, derived from `ss` | Operator must compare |
| 8 | Request replay | Refused after consumption | Durable `CONSUMED` before import | Durability of that write is BROWSER-OP (§10.2) |
| 9 | Package replay | Harmless before consumption; refused after | §10.4 | — |
| 10 | Cross-request package | Refused before decapsulation | `requestId`/`requestHash` | — |
| 11 | Suite downgrade | Refused; no negotiation exists | Single-suite registry | — |
| 12 | Malformed public key | Refused — length and KEM validation | §5.1, KEM rules | — |
| 13 | Malformed KEM ciphertext | Refused — length, then AEAD | Fixed 1120 B | — |
| 14 | AEAD forgery | Refused | AES-256-GCM, full 128-bit tag | — |
| 15 | Truncated package | Refused — length arithmetic | Fixed layout | — |
| 16 | Oversized package | Refused before decryption | 16 MiB cap | — |
| 17 | Duplicate pair import | Refused `pair-exists` | **Existing** importer | Only within this origin's OPFS. See #31–#33 for what a saved `.tps2` can and cannot do |
| 18 | Destroyed-pair resurrection | Refused `pair-destroyed` | **Existing** tombstone, checked in the pre-flight | **FREE** — the pre-flight runs before the CAS, so nothing is consumed. Only a destroy landing *after* a successful pre-flight and *after* the CAS is LOSS, which is the race in §11's final row |
| 19 | Crash before consumption | Request still usable | §10.3 | — |
| 20 | Crash after consumption | Transfer lost; never reusable after a crash, browser kill, or killed tab | §10.2 ordering | **Power loss between the `CONSUMED` flush and the medium is not claimed** (§10.2, §10.3) |
| 21 | Crash during import | Inactive retryable pair | **Existing** staging | — |
| 22 | Stolen pending recipient private key | Attacker can open packages sealed to that request | — | Cancel the request; make a new one |
| 23 | Stolen sealed package only | Useless without the decapsulation key | KEM | HNDL — §14 |
| 24 | Stolen plaintext pad | **Total compromise** of that pair | — | Out of scope; destroy the pair |
| 25 | Future PQ break | Archived packages may become openable | **ML-KEM-768 alone against a quantum adversary** — a CRQC breaks X25519 outright, so the hybrid covers a *classical* ML-KEM break, not this one | §14 |
| 26 | Future symmetric break | Archives compromised | **SHA3-256**, **SHA3-512**, **SHAKE-256** (all three are X-Wing random-oracle assumptions; SHAKE-256 also expands the seed), **HKDF-SHA-256**, or **AES-256-GCM** — any one alone suffices | §14, §2.2 |
| 27 | Compromised endpoint | **No protection** | — | §15 |
| 28 | CSPRNG state duplication or repetition | Key generation and encapsulation repeat | **No protection** — platform CSPRNG. (key, nonce) uniqueness is unaffected: §7.4 derives the nonce | §7.4, §16.1, §17 |
| 29 | Two tabs, one pending request, two packages | Refused — the second compare-and-set fails | `requestId`-scoped CAS (§10.1) | The existing importer does not prevent this: its lock is pairId-scoped |
| 30 | Offline request-fingerprint grind at the **new** strength | **Refused** — 132 bits, floor 2⁶¹ s ≈ 7 × 10¹⁰ years even at Bitcoin-scale ASIC | `requestWords132` (§6.3) | Assumes all 12 words are actually compared |
| 31 | **Active malicious UI with worker-RPC authority** | **NO PROTECTION** — it submits its own body, confirms it, and seals | None. There is no trusted input path to the worker | **Classified as endpoint compromise** (§15, §18). Withdrawn Phase-0 claim |
| 32 | Partial word comparison (operator checks 3 of 12) | Only 33 bits actually compared | Position challenge is UX only | Un-compared words are never credited (§6.3) |
| 33 | `.tps2` stolen **alone** | **Inert** — holds no decapsulation key | X-Wing + AEAD | Archive risk only: §34, §35 |
| 34 | `.tps2` + **restored or cloned recipient `dk`** | **Decrypts; pad reproduced** | None — the key came back with the profile | **Full profile restore / OPFS clone** (§10.4.1). The real risk the Phase-0 draft mis-attributed to the file |
| 35 | `.tps2` + future delivery-crypto break | May become readable later | — | §14, harvest-now-decrypt-later |
| 36 | "Clear site data" on the recipient | `dk` destroyed; a retained `.tps2` becomes inert | — | **LOSS, not replay** — commonly confused with #34 |
| 37 | Two sender tabs seal concurrently | **Refused** — the second sees SEALED and returns the same package | `requestHash`-scoped lock + durable SEALED state (§10.5) | A full profile rollback can rewind SEALED |
| 38 | Receive-session substitution after confirmation | **Refused** — `commitReceive(sessionId)` takes no pad bytes | Opaque worker-held session (§10.1) | Session is transient; a crash costs a re-open, not a pad |
| 39 | Same pad sealed to **two** recipients | **Refused** — genesis-only, one handoff record per pairId | §10.6 pairing rule | Now also covers the physical path — see #47 |
| 40 | Old `.tps2` replayed after the pair was destroyed | Refused `pair-destroyed` in the pre-flight | Existing tombstone | FREE (#18) |
| 41 | **Bob re-seals a pad he imported**, to Charlie | **Refused** — sealing requires `origin == "generated-here"` | §10.7 `origin` on `pair.json`, written by **every** import path | Phase 0.5's first draft did **not** stop this: provenance lives in the sealer's origin and `pair.json` is not in the bundle. It was the largest hole the falsification rounds found |
| 42 | Alice speaks her words first on an observable channel | Her fixed target becomes known and grindable offline | Receiver-first (§8.2) — an **OPERATOR** assumption | Even violated, the grind is 2⁸⁸ X-Wing encapsulations (~2¹⁰³⁺ ops), not SHA-256 |
| 43 | Rejected package committed after a later one is opened | **Refused** — rejection is terminal and one session is live per request | §10.1 | Phase 0.5's first draft returned a rejected round to PENDING, which permitted exactly this |
| 44 | Seal called with caller-supplied pad bytes | **Not possible** — `seal(body, pairId)` reads the live store | §20, §18 | The first draft's `seal(body, padFileBytes)` let stale genesis bytes pass the genesis check |
| 45 | Two sender tabs seal one genesis pad to **different** requests | **Refused** — the pairId lock is outermost and `handoff.json` is read inside it | §10.6(2), lock order in §20 | The requestHash lock alone did not contend across different requests |
| 46 | X-Wing draft revision drift | Suite `0x0001` is frozen by **this** document | §2.2.1 | A future revision becomes suite `0x0002`; it does not mutate `0x0001` |
| 47 | **Seal to Bob, then "Save the pad file again" to Charlie** | **Refused** — export after a sealed handoff is `pad-already-sealed` | §10.8 cross-mode policy; one `handoff.json` per pairId (§10.9) | The one existing-verb behaviour change Phase 1 owes. The reverse order (export, then seal) is refused too |
| 48 | Pad imported by **ordinary courier**, then sealed onward | **Refused** — the courier import writes `origin: "imported"` in the same `pair.json` the commit already writes | §10.7.2 | Same two-time pad as #41 by a different route |
| 49 | Legacy pad (no `origin` field) sealed | **Refused** — `unknown` is not `generated-here`; no backfill, no guess | §10.7.1 | Physical export stays available for `unknown` as an explicit legacy boundary, not as evidence forwarding is safe |
| 50 | Two tabs open the **same** package, or two packages for one request | **Refused** — `openSealed` takes `"spt-recv:"‖requestId` with `ifAvailable` and holds it for the session's life | §10.10 | Deliberately does **not** queue: queueing would let a second decapsulation begin the instant the first session ended |
| 51 | Crash between the sealed package and the handoff marker | **Safe** — the marker is written LAST and is the commit point; staging without a marker was never released, so it is discarded and retried | §10.9.1 | The Phase-0.6 "one atomic replace" model was withdrawn: `OpfsVfs.writeFileAtomic()` is atomic only where `move()` works |
| 53 | Crash DURING the marker's own non-atomic write | **Refused thereafter** — a marker that exists and cannot be read is `HANDOFF-SPENT / UNREADABLE`, never absence | §10.9.2 | A torn marker may cost the handoff. It never reopens the pad |
| 54 | **Imported pad re-exported physically** to a third party | **Refused** — `imported` may not export onward, not only may not seal | §10.7.1 | The walking-pace twin of #41. Gating sealing alone left it open |
| 55 | Corrupt marker deleted to "unstick" the pad | **Never automatic** — no code path deletes `handoff.json`, and the refusal does not suggest it | §10.9.2, §10.9.4 | Deleting it is exactly what turns a lost handoff into a reused pad |
| 52 | Stale tab commits after the operator rejected in another tab | **Refused** — `CANCELLED` is written durably before any acknowledgement, and `commitReceive` re-checks | §10.10.3 | Correctness rests on durable state, never on a `BroadcastChannel` notice |

---

## 14. Harvest-now, decrypt-later

An adversary can archive TPR2 requests, `.tps2` packages, and later TP2
ciphertext messages, and attack them years later.

**If the delivery cryptography is broken later, the archived package yields the
pad — and the pad yields every archived message that pad protected.**

This is the honest consequence of online delivery, and it is why physical
delivery is a *different claim* rather than a less convenient version of the
same one:

> **"The messages use OTP" does not erase weaknesses in how the pad was
> delivered.** A one-time pad delivered under computational protection inherits
> that protection's lifetime.

**No single KEM component-family failure necessarily defeats the X-Wing hybrid
under its stated assumptions.** That property is real, and it is the only one
the hybrid buys — it does **not** extend to the delivery stack, which depends
additionally on SHA3-256, SHA3-512, SHAKE-256, HKDF-SHA-256, AES-256-GCM, the
platform CSPRNG, endpoint integrity, and both operator ceremonies. An earlier
draft wrote "no single primitive break opens the archive", which is false: a
break of the combiner or of the DEM opens it with no KEM work at all. The
popular shorthand "the attacker must break both" is *false*
for the adversary this section posits, and stating it would be an overclaim. A
cryptanalytically relevant quantum computer breaks X25519 outright, so against
**that** adversary **ML-KEM-768 alone carries the entire claim**. The hybrid's
value is that its two branches cover *different* adversaries, not that their
work factors multiply.

Precisely, an attacker needs **one** of:

1. the hybrid KEM — meaning **ML-KEM-768 against a quantum adversary**, or
   **X25519 against a classical adversary who cryptanalyses ML-KEM**;
2. **SHA3-256, SHA3-512, or SHAKE-256** — X-Wing's security argument models all
   three as random oracles (§2.2), and SHAKE-256 additionally expands the
   decapsulation seed, so a break there is a break of key generation itself;
3. the DEM — **HKDF-SHA-256** or **AES-256-GCM**;
4. the **platform CSPRNG**, for key generation and encapsulation (§17).

The archive's security is the **weakest** of these, not their sum. "Remote" is
not "impossible", and the OTP theorem does not reach backwards to cover the
delivery.

---

## 15. Endpoint compromise

Sealed Pad Transfer does **not** protect against an attacker who already
controls Alice's device while the pad is plaintext, Bob's device after unwrap,
the worker execution environment, the OS or account with equivalent access, a
sufficiently privileged browser extension, or a plaintext pad file the user
exported elsewhere. The KEM solves none of these, and is not claimed to.

---

## 16. Claims ledger

### 16.1 What may be said

> **Hybrid post-quantum / traditional protected pad delivery**, under the
> computational assumptions of X25519, ML-KEM-768, **SHA3-256, SHA3-512 and
> SHAKE-256** (X-Wing models all three as random oracles, and SHAKE-256 expands
> the decapsulation seed), HKDF-SHA-256 and AES-256-GCM; **on the platform CSPRNG actually
> producing fresh, unpredictable bytes** for key generation, encapsulation and
> the `requestId`; and conditional on the operator actually having performed
> both human comparison ceremonies **in full** (all 12 request words, all 8
> confirmation words), **the receiver-first ordering** of §8.2, and the
> recipient opening **one package at a time** — none of which TruePad can
> observe, and all of which are therefore OPERATOR assumptions, not verification
> results.

After import, messages use **OTP confidentiality** and **one-time Wegman–Carter
authentication**, unchanged, with their own separate claims.

### 16.2 What may never be said

- ❌ "PQC OTP" · "quantum-proof pad" · "unconditionally secure transfer"
- ❌ "information-theoretic online delivery" · "perfect secrecy over the Internet"
- ❌ "PQC makes the OTP stronger" — it does not touch the OTP
- ❌ "ML-KEM authenticates the recipient" — a KEM authenticates nobody; §6 does
- ❌ "successful decryption proves the sender" — it does not; §8 does

### 16.3 The quantum claim, exactly

ML-KEM's security is **computational**, resting on its standardized
post-quantum hardness assumptions. X25519 is traditional and classically
computational. X-Wing is IND-CCA secure if **either** component family holds.
AES-256, HKDF and SHA-256 are computational symmetric primitives.

**Therefore Sealed Pad Transfer is computational security, end to end, in the
delivery layer.** This does not downgrade the OTP theorem or the Wegman–Carter
bound — both are exactly as they were. It changes the **end-to-end deployment
claim**, because the pad travelled under computational protection.

### 16.4 The false implication, rejected explicitly

> ❌ *"The pad is OTP, therefore sending it under PQC preserves
> information-theoretic end-to-end secrecy."*

**It does not.** The weakest link in a deployment is the delivery of the key
material. An information-theoretic cipher delivered by a computational channel
yields a computational deployment. Physical handoff exists precisely because it
is the only delivery that keeps the stronger claim available.

### 16.5 Physical exchange remains first-class

Future UX offers two clearly distinct choices — *Exchange in person* and *Send
securely online* — and never presents the second as an upgrade of the first.

| | Physical exchange | Sealed Pad Transfer |
| --- | --- | --- |
| Delivery claim | can support the conditional **information-theoretic** path | **computational** |
| Requires | meeting; removable media | an authenticated side channel for two word comparisons |
| HNDL exposure | none from delivery | archived package is attackable later |
| Status | **shipped** | **core and storage built; no reachable flow** |

---

## 17. Randomness separation

Transfer cryptography uses **platform CSPRNG** randomness per the KEM and AEAD
specifications. This has **nothing** to do with True OTP source provenance, and
is never described as proving physical randomness.

External OTP source material is **never** fed into KEM key generation,
encapsulation randomness, the `requestId`, or the §6 request fingerprint. One
dependency is stated rather than denied: `padHash` reaches the nonce (§7.4), the
nonce reaches the AAD, and the AAD reaches the `info` of the §8 confirmation
Expand — so the pad file does influence the **transfer confirmation** words.
That is safe (HKDF-Expand under a secret `PRK` reveals nothing about its info)
and it is inherent to binding the confirmation to the actual package. The AES
nonce is
derived from `PRK` and a one-way commitment to the pad file (§7.4); no external
source byte and no pad byte is key material or contributes entropy to any
delivery key.
The pad source and the delivery cryptography are separate, in both directions.

---

## 18. Worker confinement (normative for Phase 1)

Two crown jewels stay out of the UI thread:

1. **recipient transfer private keys** — generated in the worker, stored in
   OPFS pending-request state, **never** in `localStorage`, never crossing the
   RPC boundary;
2. **unwrapped pad-file bytes** — staged and imported inside the worker; they
   never enter ordinary DOM state.

> **The worker owns the confirmation RECORD. It cannot own human intent.**
>
> A boolean `confirmed` arriving from the UI is never sufficient, because it has
> no subject: an honest-but-buggy UI could confirm body *B* and then seal *B′*.
> The worker therefore records the confirmation **keyed by the request bytes**:
>
> ```
> confirmRequestFingerprint(body):                 # worker
>     requestHash ← H_ds(DS_REQUEST_FP, body)
>     record CONFIRMED { requestHash, body, at } in worker-confined storage
>     return requestHash, requestWords132(requestHash)
> ```
>
> and `seal()` requires a CONFIRMED record whose stored `body` equals the body
> being sealed, **byte for byte**. The record is one-shot per `requestHash` and
> is discarded on any edit of the pasted code.
>
> **What this buys, exactly:** it closes time-of-check/time-of-use and body
> substitution. A UI *bug* can no longer seal a body the operator never saw.
>
> **What it does NOT buy, stated plainly because the Phase-0 draft claimed
> otherwise:** it does **not** authenticate human intent against an *active
> malicious* UI. The Phase-0 text argued that body-keying defeated a UI-thread
> adversary. That argument is **wrong**, and it is withdrawn. TPR2 is public,
> `requestHash` is public, and the safety words are computable from public data —
> so a script with authority to invoke the transfer worker API can simply submit
> its **own** body, call `confirmRequestFingerprint` on it, and then `seal()`.
> Every check passes, because every input was legitimate; the only thing missing
> is a human, and the worker cannot see humans. A position challenge (§6.3) does
> not help either: the challenge words are computable from the same public data.
>
> **There is no trusted input path from the operator to the worker in the browser
> architecture, and this document does not invent one.** No "secure attention"
> property exists to appeal to. Therefore, normatively:
>
> > **An attacker with arbitrary Sealed-Pad worker-RPC authority is classified as
> > ENDPOINT COMPROMISE for transfer authorization (§15), not as an attacker the
> > ceremonies defend against.**
>
> Worker confinement still earns its keep — pad bytes need not be copied into
> ordinary DOM state, recipient private keys stay worker-confined, and exact-body
> records close accidental substitution. It is a real boundary against bugs and
> against passive exposure. It is not a boundary against code that already runs
> with the application's own authority, and claiming otherwise would be exactly
> the kind of promoted engineering action this project forbids.

For sending, the pad is **not** exported in plaintext to the UI so the UI can
encrypt it. The worker reads the store, serializes the existing pad file, seals
it, and returns only the sealed public package.

The UI receives: public artifacts, fingerprints, status. Nothing else.

Transfer private keys are **logically destroyed** on consumption or
cancellation. TruePad does **not** claim physical erasure from browser storage —
the same limitation, stated the same way, as everywhere else in this project.

---

## 19. No backend, no long-term identity

v1 requires **no** account, server, key directory, push service, online API,
certificate authority, analytics, or cloud database. TPR2 and `.tps2` travel
through any channel the operators like; the channel is a **courier**, not a
trusted TruePad service.

v1 deliberately has **no** contact graph, long-term identity key, signed
prekeys, key transparency, directory, account recovery, or multi-device sync.
Those would be a different project.

---

## 20. Reference pseudocode

Byte-exact. No step says "hash the relevant data".

```
receiveRequestGenerate():
    (ek, dk) ← XWing.KeyGen()                      # ek 1216 B, dk 32 B seed
    requestId ← CSPRNG(16)
    body ← 0x01 ‖ u16be(0x0001) ‖ requestId ‖ ek   # 1235 B
    store PENDING { requestId, dk, body } in worker-confined OPFS
    return body

receiveRequestEncode(body):
    return "TPR2:" ‖ base64url_unpadded(body)      # 1652 chars

requestFingerprint(body):                           # pure function
    requestHash ← SHA-256( u8(len(DS_REQUEST_FP)) ‖ DS_REQUEST_FP ‖ body )
    return requestHash, requestWords132(requestHash)

confirmRequestFingerprint(body):                    # WORKER — B2
    (requestHash, words) ← requestFingerprint(body)
    record CONFIRMED { requestHash, body, at } in worker-confined storage
    return requestHash, words                        # one-shot; dropped on edit

requestWords132(requestHash):                       # 17 bytes → 12 words
    n ← big-endian integer of requestHash[0..17)    # 136 bits
    m ← n >> 4                                      # 132 bits; low 4 discarded
    for i in 0..11: idx[i] ← (m >> (121 - 11·i)) & 0x7FF
    return [ WORDLIST[idx[0]], …, WORDLIST[idx[11]] ]

confirmationWords88(b11):                           # 11 bytes → 8 words
    n ← big-endian integer of b11                   # 88 bits
    for i in 0..7:  idx[i] ← (n >> (77 - 11·i)) & 0x7FF
    return [ WORDLIST[idx[0]], …, WORDLIST[idx[7]] ]

seal(body, pairId):                                 # WORKER
    # The caller names the PAD, never its bytes. §18 forbids exporting the pad
    # in plaintext so the UI can encrypt it; taking padFileBytes here would also
    # make the genesis check (§10.6) evaluate a snapshot the caller chose rather
    # than the live store — sealing weeks-old genesis bytes to a second
    # recipient would pass every check and produce a two-time pad.
    require body parses per §5.1, version 0x01, suite 0x0001
    require a CONFIRMED record exists whose stored body == body, BYTE FOR BYTE
    requestHash ← requestFingerprint(body).requestHash

    # LOCK ORDER: pairId lock OUTERMOST, then requestHash. Never the reverse.
    acquire vfs.withLock(pairId)                    # the store's pad lock
      require pair.json origin == "generated-here"          # §10.7
          # absent field or absent pair.json => unknown => REFUSE (§10.7.1)
      require NOT exists(<pairId>/destroyed.json)
      (ab, ba) ← loadStore(<pairId>/a-to-b), loadStore(<pairId>/b-to-a)
      require both directions at GENESIS from the LIVE store:               # §10.6(1)
          nextOffset == 0 and nextSequence == 0 and attemptsReserved == 0
      # DURABLE handoff state decides, not sender ceremony state (§10.5).
      state ← readHandoffState(vfs, pairId)                         # §10.9
      if state.kind == "sealed":
          # RE-SHARE ONLY. Never a second encapsulation.
          require state.marker.requestHash == requestHash  # else REFUSE
          committed ← loadCommittedSealedHandoff(vfs, pairId)
              # throws handoff-unrecoverable if the payload was dismissed,
              # is missing, or no longer matches the marker — still no reseal
          return committed.package, confirmationWords88(committed.confirmValue)
      if state.kind == "physical":         REFUSE pad-already-handed-off  # §10.8
      if state.kind == "unreadable-spent": REFUSE handoff-state-unreadable # §10.9.2
      # state.kind == "absent" — and only here may anything be encapsulated.

      acquire lock "spt-send:" ‖ requestHash        # §10.10.1
        require sender state for requestHash == CONFIRMED
        mark SEALING                                # transient; not the authority

        padFileBytes ← packContainer(pairId, the six BUNDLE_FILES read here)
        require |padFileBytes| ≤ 16 777 216
    (ct_kem, ss) ← XWing.Encaps(ek from body)       # ct_kem 1120 B, ss 32 B
    PRK   ← HKDF-Extract(salt = requestHash, IKM = ss)
    padHash ← SHA-256( u8(len(DS_PAD)) ‖ DS_PAD ‖ padFileBytes )   # not on the wire
    nonce ← HKDF-Expand(PRK, u8(len(DS_NONCE)) ‖ DS_NONCE ‖ padHash, 12)   # B7
    header ← "TPS2" ‖ 0x01 ‖ u16be(0x0001) ‖ requestId ‖ requestHash
             ‖ ct_kem ‖ nonce ‖ u64be(|padFileBytes|)          # 1195 B
    AAD ← header
    key ← HKDF-Expand(PRK, u8(len(DS_AEAD_KEY)) ‖ DS_AEAD_KEY ‖ AAD, 32)
    (ct, tag) ← AES-256-GCM-Encrypt(key, nonce, AAD, padFileBytes)
        confirm ← HKDF-Expand(PRK, u8(len(DS_CONFIRM)) ‖ DS_CONFIRM ‖ AAD, 11)

        # MARKER-LAST (§10.9.1): stage the package, read it back, stage the
        # confirmation, read it back, and write handoff.json LAST. The marker
        # carries HASHES; the bytes live in their own files. Nothing is
        # released before this returns.
        commitSealedHandoff(vfs, pairId,
            { packageBytes    = header ‖ ct ‖ tag,
              requestHash     = requestHash,
              confirmValue    = confirm,
              packageIdentity = SHA-256(header ‖ ct ‖ tag) },
            at)
        # A failure here that leaves handoff.json EXISTING but unverifiable is
        # handoff-state-unreadable: spent, never retried with a new package.
        zeroize padFileBytes
      release locks

    return package, confirmationWords88(confirm)
    # Alice's words stay MASKED until she marks Bob's as received (§8.2)

exportPad(pairId):                                  # WORKER — §10.8
    acquire vfs.withLock(pairId)               # same lock as seal(); one writer
      require pair exists, NOT destroyed, NOT mid-import   # unchanged from today

      # 1 — PROVENANCE first (§10.7.1). An imported pad may not leave again by
      #     ANY route, so this precedes reading a single store byte.
      origin ← pair.json origin                # absent field / no pair.json => unknown
      if origin == "imported":  REFUSE imported-pair-cannot-export

      # 2 — durable handoff state (§10.9).
      state ← readHandoffState(vfs, pairId)
      if state.kind == "sealed":            REFUSE pad-already-sealed
      if state.kind == "unreadable-spent":  REFUSE handoff-state-unreadable
      # "physical" permits re-export under the §10.8 operator assumption, and
      # does NOT rewrite the marker: the recorded time stays the FIRST handoff.

      # 3 — build the exact six-file container IN MEMORY. Not released yet.
      container ← packContainer(pairId, the six BUNDLE_FILES)

      # 4 — MARKER LAST, and only on a first handoff.
      if state.kind == "absent":
          commitPhysicalHandoff(vfs, pairId, at)
          # A throw BEFORE the marker exists leaves the pad absent and
          # retryable. A marker that exists but cannot be verified is
          # handoff-state-unreadable — spent. Either way the container below is
          # NOT returned.

    release lock
    # 5 — ONLY now, after the marker commit succeeded.
    return container

openSealed(pkg) -> sessionId:                       # WORKER
    # ONE live session per request, for the session's whole lifetime (§10.10).
    acquire lock "spt-recv:" ‖ pkg.requestId WITH ifAvailable
      → unavailable ⇒ refuse "already open in another tab"; do NOT queue
    # held from here until commitReceive, rejection, or worker teardown
    parse per §7.1; refuse on magic/version/suite/length/trailing bytes
    look up PENDING request by pkg.requestId
      → not found | cancelled | consumed | expired  ⇒ refuse (FREE)
    require pkg.requestHash == stored requestHash          # recomputed locally
    require 1195 + pkg.plaintextLength + 16 == |pkg|
    require pkg.plaintextLength ≤ 16 777 216
    ss  ← XWing.Decaps(dk, pkg.ct_kem)
    PRK ← HKDF-Extract(salt = pkg.requestHash, IKM = ss)
    key ← HKDF-Expand(PRK, u8(len(DS_AEAD_KEY)) ‖ DS_AEAD_KEY ‖ AAD, 32)
    padFileBytes ← AES-256-GCM-Decrypt(key, nonce, AAD, ct, tag)
        # Decaps and AEAD failures surface as ONE indistinguishable outcome
    # Re-derive the nonce and compare. padHash never travels, so a wrong DS_PAD
    # length octet would otherwise fork the nonce SILENTLY between builds and
    # every package would still verify. This makes that a refusal. FREE (§11).
    padHash ← SHA-256( u8(len(DS_PAD)) ‖ DS_PAD ‖ padFileBytes )
    require pkg.nonce == HKDF-Expand(PRK, u8(len(DS_NONCE)) ‖ DS_NONCE ‖ padHash, 12)

    confirm ← HKDF-Expand(PRK, u8(len(DS_CONFIRM)) ‖ DS_CONFIRM ‖ AAD, 11)

    # OPAQUE WORKER-ONLY SESSION. The decrypted bytes NEVER leave the worker and
    # are never re-supplied by the caller — otherwise the UI could substitute
    # another otherwise-valid bundle between confirmation and import.
    session ← { sessionId: random(16),
                requestId, requestHash,
                packageIdentity: SHA-256(COMPLETE TPS2 bytes,
                                          magic .. final GCM tag),
                                       # NOT SHA-256(AAD) — the AAD is only the
                                       # 1195-byte header and commits to
                                       # neither the ciphertext nor the tag
                padFileBytes,                       # held, not returned
                confirmValue: confirm }
    hold session in transient worker-only memory   # NOT durable, by design
    return session.sessionId, confirmationWords88(confirm)
                                               # Bob reads these FIRST (§8.2)

commitReceive(sessionId):                          # after the operator confirms
    # The ONLY input is an opaque handle. No caller may supply pad bytes.
    # LOCK ORDER (§10.10.2), outermost first:
    #   "spt-recv:"‖requestId  (already held)  →  "spt-req:"‖requestId  →  pairId
    session ← resolve(sessionId)  or refuse (FREE — session lost or unknown)
    padFileBytes ← session.padFileBytes            # the EXACT bytes that
                                                   # produced the words Bob read

    # PRE-FLIGHT — non-mutating, all failures FREE (§11)
    require unpack(padFileBytes) is well-formed and is exactly the 6 expected files
    require pairId is 32 lowercase hex
    require loadStore(<scratch>/a-to-b) and loadStore(<scratch>/b-to-a) both succeed
        # reconciliation, and rollback:none-only — a CLI-origin store refuses here.  FREE
    require both heads' pairId == container pairId
        and the two halves are a matched A->B / B->A pair                # PAD-SPENT
        # <scratch> lives OUTSIDE <pairId>/ and importing/<pairId>/ (§10.1),
        # and is removed on every exit path
    require NOT exists(<pairId>/destroyed.json)    # pair-destroyed, PAD-SPENT
    require NOT committedPairExists(<pairId>)      # pair-exists,    PAD-SPENT

    acquire lock "spt-req:" ‖ requestId            # inside the session lock
        CAS: PENDING → CONSUMED, durably      # B4; a lost CAS aborts PAD-SPENT
    # from here on, any failure is LOSS (§11: REQUEST-LOST and HANDOFF-SPENT)
    # and MUST be reported as such — never as "nothing changed"
    commit the EXISTING import with session.padFileBytes   # first import-pair call
    # The import writes pair.json with origin: "imported" (§10.7.2) and then
    # removes importing.json as the active-state commit. It creates NO handoff
    # marker: this installation did not hand this pad off, and claiming a
    # handoff it never performed would be a lie in the pad's own record.
    logically destroy dk
    forget the session; release "spt-req:" then "spt-recv:"   # session lock last
    advise deleting the .tps2 file (§10.4)

reject(sessionId):                                  # §8.2.1, §10.10.3
    acquire lock "spt-req:" ‖ session.requestId
        durably: PENDING → CANCELLED, dk logically destroyed   # BEFORE any ack
    zeroize session.padFileBytes, confirmValue, packageIdentity
    forget the session; release "spt-req:" then "spt-recv:"
    # No other session can exist for this requestId (§10.10), so there is
    # nothing to notify. A BroadcastChannel notice is UI courtesy only.

abandon(sessionId):                                 # §10.10 — closed, not decided
    zeroize session.padFileBytes, confirmValue, packageIdentity
    forget the session; release "spt-recv:" ‖ requestId
    # The request stays PENDING. Abandoning is NOT rejecting; only rejection
    # is terminal. Without this the session lock outlives the operator's
    # intent and blocks the request until the tab closes.
```

**The invariant that outranks everything here:**

```
unwrap(seal(existingPadFileBytes)) == existingPadFileBytes      BYTE-FOR-BYTE
```

No normalization, no unzip/re-zip, no JSON re-serialization, no pairId rewrite,
no witness rewrite, no role rewrite. **"AEAD verified" does not mean "valid
TruePad pad"** — the existing importer remains the sole authority for that.

---

## 21. Human language (Level 1)

No KEM, HKDF, or AEAD vocabulary appears in the beginner flow. Security and
Details may name them exactly.

**Sender:** *Send pad securely online* → *Ask the other person to create a
receive code* → **[Paste receive code]** → *Read these words to the other person
and check they match* · WORD × 12 → **[The words matched]** → **[Seal pad]** →
**[Save sealed pad]** / **[Share sealed pad]** → *Ask them to read their
confirmation words to you first* → **[Their words matched]** → *Now read these
back to them* · WORD × 8

**Recipient:** *Receive a pad* → **[Create receive code]** → *Send this code to
the other person; check these words with them before they seal the pad*
· WORD × 12 → … → *Choose the sealed pad file* → *Read these confirmation words
to the sender **first**, then check theirs match* · WORD × 8 → **[The words
matched]** → **[Add pad]** → *This sealed file holds an encrypted copy of the
pad. Delete it when you no longer need it — keeping it preserves an archive that
could be read if this device's key state is restored, or if the delivery
cryptography is broken in future.* → **[Delete sealed file]**

Two things in that flow are normative, not cosmetic. **The recipient reads the
confirmation words first** (§8.2) — so the sender's are revealed only after she
marks the recipient's as received, and never before. And **the recipient is told to delete the sealed file** (§10.4) — not because
the file alone is a usable pad (it is not; it holds no decapsulation key) but
because it is an archive that becomes readable if this device's key state is
restored or the delivery cryptography is later broken. The button cannot reach
copies already in email, chat, cloud storage, or backups, and does not claim to.

Buttons say *"The words matched"*, not *"I verified"*: TruePad observes a click,
not a comparison (§6.1).

TPR2 may be copy/paste or QR. TPS2 is a **file** — never the clipboard.
