# Sealed Pad Transfer v1

**STATUS: PHASE 0 — SPECIFIED, NOT IMPLEMENTED.**
No code in `src/**` implements any of this. Nothing in the shipped product
offers it. This document exists so that a later implementation phase has no
cryptographic design decisions left to improvise.

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
| X-Wing security proof | Barbosa, Connolly, Duarte, Kaiser, Schwabe, Varner, Westerbaan, *X-Wing: The Hybrid KEM You've Been Looking For* | **Peer-reviewed**, IACR Communications in Cryptology 2024; ePrint 2024/039 | Supporting evidence |
| **X25519MLKEM768** (TLS) | `draft-ietf-tls-ecdhe-mlkem` | IETF TLS WG draft; widely deployed **in TLS** | **NO — see below** |
| ML-KEM in browser WebCrypto | WICG *Modern Algorithms in the Web Cryptography API*, Draft Community Group Report, 29 June 2026 | **Draft, not shipping in browsers** | Implementation note, §14 |

**X25519MLKEM768 is explicitly rejected for this protocol.** Its "combiner" is
bare concatenation `ss_ML-KEM ‖ ss_X25519`, which is then fed into the **TLS 1.3
key schedule**, where the handshake transcript is folded in as salt and HKDF
derives the session key. The combining work is done by TLS, not by the
construction. Lifting the concatenation out of TLS and calling it a KEM would be
an ad-hoc construction wearing a standard's name. That is exactly the mistake
this section exists to avoid.

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

### 2.2 The freeze, and what "X-Wing" means in this document

The construction in §2.1 is **reproduced normatively here**. Suite `0x0001` is
defined by *this document*, and it happens to equal
`draft-connolly-cfrg-xwing-kem-10`. If a later X-Wing draft or RFC changes the
construction, **suite `0x0001` does not change** — a future suite `0x0002` would
track it, and old packages remain openable. This is why the suite registry
exists. TruePad must never ship something called X-Wing that is not the X-Wing
it was proven to be.

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

### 6.3 Words: 8 words, 88 bits

Take `requestHash[0..11)` — the first **11 bytes = 88 bits** — as a big-endian
88-bit integer, and split it into **8 indices of 11 bits each**, most
significant first. Index *i* selects word *i* from a pinned 2048-word list.

**Why 8 and not 6.** The attack is a *second preimage*: Mallory must produce a
different request whose fingerprint matches the one Bob will read aloud.

The unit matters, and getting it wrong would overstate the margin by fifteen
orders of magnitude. Mallory does **not** grind keypairs — he needs exactly
one. §5.1 hands him **16 freely chosen `requestId` bytes**, which are a
constraint on honest generators and not on him, so a trial is one SHA-256 over a
1270-byte preimage ≈ **20 compressions**. The cost is therefore **≈2⁹² SHA-256
compressions**, not 2⁸⁸ key generations — and the table below quotes the
conservative 2⁸⁸ floor rather than that figure.

| Words | Bits | Commodity GPU (2³⁴/s) | Large GPU cluster (2⁵⁰/s) | Bitcoin-scale SHA-256 ASIC (2⁷¹/s) |
| --- | --- | --- | --- | --- |
| 4 | 44 | ~17 minutes — **broken** | instant | instant |
| 6 | 66 | ~136 years | **~18 hours** | **~31 ms** |
| **8** | **88** | ~6 × 10⁸ years | ~8 700 years | **~36 hours** |

Cells charge the attacker **one compression per trial** — a floor that credits
him with an amortisation he does not actually have. `requestId` sits at body
offset 3, hence preimage offset 38, inside SHA-256 **block 0** of the 20-block
1270-byte preimage, so no midstate is reusable and a real trial costs the full
~20 compressions: ≈2⁹² in total, or roughly 30 days at the ASIC tier. The
conservative figure is quoted so the published margin cannot be an overclaim.

Eight words is chosen against the first two tiers. Six is rejected because it is
**~18 hours at cluster scale and milliseconds at ASIC scale** — not because six
is theoretically weak, but because it is practically reachable.

**Against the third tier the fingerprint alone does not exclude the attack, and
this document does not pretend otherwise.** Note carefully *which* channel the
attacker needs: **none of the side channel.** He substitutes Bob's TPR2 on the
**request** channel — which this protocol already assumes is unauthenticated —
with a colliding request; Alice's fingerprint matches; Bob then reads his
genuine words over a genuine authenticated side channel; and they match.
Grinding the fingerprint is precisely the technique for *not* needing a
side-channel position. The 7-day `PENDING` TTL (§10.1) bounds the grinding
window, and at 2⁷¹/s that window is ~2⁹⁰ compressions — which is to say the ASIC
tier does complete the conservative-floor grind inside one TTL. That is the
honest reason this concession is stated rather than rounded away, and it is the
strongest argument for physical exchange (§16.5) over any online path.

With `T` requests live at once, the work to hit *some* target is 2⁸⁸/T, which is
why §10.1 imposes a `PENDING` time-to-live.

The words are a **fingerprint**. They are not a password, not a key, not KEM
randomness, and not a shared secret. They are never fed into any derivation.

### 6.4 The wordlist

Normative requirements: exactly **2048** words · lowercase ASCII `a–z` · unique
4-character prefixes (so a mis-heard tail is still unambiguous) · pinned in-tree
and identified by the SHA-256 of the canonical newline-separated file.

**Intended list: BIP-39 English** (`bitcoin/bips`, `bip-0039/english.txt`),
which meets all of the above and is the most widely transcribed such list.

> **Open item carried to Phase 1 (the only one):** the BIP-39 wordlist's licence
> was not confirmed during this survey and **must** be verified before
> vendoring. If it proves unsuitable, any list meeting the requirements above is
> substituted. This affects **no key, ciphertext, or package byte** — the
> wordlist is a *rendering* of the fingerprint, not an input to it — but both
> parties must share the same list, which is why it is pinned by hash.

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

Uniqueness of (key, nonce) does **not** rest on CSPRNG freshness. The CSPRNG is
still trusted for the `requestId` and for KEM key generation and encapsulation
(§17), and that trust is now stated in §16.1 rather than left implicit.

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

rendered as 8 words by the §6.3 procedure and the same wordlist.

Alice sees these after sealing. Bob sees them **only** for a package he actually
decapsulated and AEAD-verified.

> **THE RECEIVER READS FIRST.** Bob speaks his words before Alice speaks hers.
> Alice MUST NOT emit her words until a package she sealed has been delivered,
> and the UI keeps hers masked until she marks Bob's as received.

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
  ├── operator rejects ──► back to PENDING   (nothing consumed; retry allowed)
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

> **`PENDING` requests expire.** A pending request carries a durable creation
> time and a **time-to-live of 7 days**, after which it transitions to
> `CANCELLED` and its `dk` is logically destroyed. Two reasons, both real: a
> one-time private key with no expiry is an indefinite liability on the
> recipient's device (§13 #22), and §6.3's fingerprint work factor degrades as
> `2⁸⁸/T` with `T` requests live at once, so `T` must be bounded by something
> other than the operator's memory. Expiry is checked on every access, and an
> expired request refuses as FREE — it is never silently revived.

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
reusable. Consuming first means a crash between the two loses the transfer (the
operator makes a new request and the sender re-seals).

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
| **After `CONSUMED` durable, before import commit** | **NO** | logically destroyed | no | **NO** | **Transfer lost.** New request; sender re-seals. *This is the accepted loss.* |
| After import commit, before request cleanup | no | logically destroyed | **yes** | no | Cleanup is idempotent |
| Storage full during the pre-flight scratch copy (**pre**-CAS) | yes | yes | no | yes | FREE — free space, re-open the package |
| Storage full during the importer's staging or copy loop (**post**-CAS) | **NO** | logically destroyed | no | **NO** | **Transfer lost** — the same accepted loss as above: new request, sender re-seals |
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
  the code's own: *"a pair with id … already exists **in this browser**"*. A
  saved `.tps2` re-opened in another browser profile, another browser, or after
  "clear site data" **does** reproduce the pad, because the sealed package is a
  durable copy of it. **The recipient must delete the package after a successful
  import.** This is the same property the existing courier export already has —
  Sealed Pad Transfer adds a long-lived encrypted copy, not a new failure class.
- Replay can never resurrect a destroyed pair: the existing importer refuses
  `pair-destroyed`, and `destroyImpl` writes the tombstone *before* it overwrites
  or unlinks anything, so even an interrupted destroy still refuses.

### 10.5 Sender re-sealing

**One receive request → one sealed package.** Sender-side state here is keyed by
the **complete request body**, not by `requestId` (§5.1). After a package exists
for a given body, the *exact* package may be saved, re-saved, and re-shared
freely. Re-sealing produces a **different** package — `XWing.Encaps` is
randomized, so a second seal yields a different `ct_kem`, a different `ss`, and
different §8 confirmation words — which is precisely why the *existing* package
must be re-shared rather than a new one generated.
TruePad does not silently produce a second, independently encapsulated package
for R as though it were the same operation — two valid packages for one request
would give Bob a choice he has no basis to make, and would give Mallory a
plausible reason to send a third. Re-sealing requires an explicit new operation
and says so.

---

## 11. Failure taxonomy

**FREE** = no receive request consumed, nothing changed.
**LOSS** = the request is consumed; the operator must create a new one.
A LOSS is never reported as "nothing changed".

| Failure | Class |
| --- | --- |
| malformed receive request | FREE |
| unsupported transfer version | FREE |
| unsupported suite | FREE |
| request not found / cancelled | FREE |
| request already consumed | FREE (refused before decapsulation) |
| requestId / requestHash mismatch | FREE |
| request fingerprint not confirmed by operator | FREE (sender side; nothing sealed) |
| malformed sealed package | FREE |
| oversized sealed package | FREE |
| KEM decapsulation failure | FREE |
| AEAD verification failure | FREE |
| derived-nonce mismatch (§7.4) | FREE — checked after AEAD verification |
| sender confirmation not accepted | FREE (returns to `PENDING`) |
| container malformed / wrong file set / bad pairId (pre-flight) | FREE |
| header reconciliation failure, or a non-`none` `rollback.witnessClass` (a CLI-origin store) | FREE — `loadStore()` runs in the pre-flight on a scratch copy |
| duplicate pair (`pair-exists`) | FREE |
| destroyed pair (`pair-destroyed`) | FREE |
| request consumed concurrently (compare-and-set lost) | FREE |
| any failure strictly **after** the CAS — storage mid-commit, or a pairId-scoped state change (a concurrent `destroy` or courier import) landing between the pre-flight and the commit | **LOSS** — the only LOSS class |

**Every check that can be made without committing MUST be made while the request
is still `PENDING`.** Only a failure that can occur strictly *after* `CONSUMED`
is durable is a LOSS.

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

All six are FREE, and they cover every ordinary mistake: a corrupt bundle, a
duplicate pairId, a tombstoned pair. `loadStore()` belongs in the pre-flight too: its inputs are entirely the bundle
bytes plus the pairId/direction cross-check, all deterministic, so it runs on a
private scratch copy and its refusals — including a CLI-origin store whose
frozen witness class the browser cannot honour — are FREE. What remains
genuinely LOSS is only **storage failing mid-commit**, because that is the sole
refusal reachable after the one-time key has been spent.

An earlier draft of this document classified the importer refusals as LOSS
outright, which would have turned every ordinary mistake into a permanent
transfer loss; a later one classified them FREE without saying how, which would
have reported a consumed request as "nothing changed". Neither is acceptable,
and the pre-flight is what makes the FREE classification true rather than
convenient.

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
| 17 | Duplicate pair import | Refused `pair-exists` | **Existing** importer | **Only within this origin's OPFS.** A saved `.tps2` opened in another profile/browser, or after site data is cleared, reproduces the pad — two parties burning the same offsets is a two-time pad. Delete the package after import. Inherited from the existing courier export, not introduced here |
| 18 | Destroyed-pair resurrection | Refused `pair-destroyed` | **Existing** tombstone | LOSS class |
| 19 | Crash before consumption | Request still usable | §10.3 | — |
| 20 | Crash after consumption | Transfer lost; never reusable after a crash, browser kill, or killed tab | §10.2 ordering | **Power loss between the `CONSUMED` flush and the medium is not claimed** (§10.2, §10.3) |
| 21 | Crash during import | Inactive retryable pair | **Existing** staging | — |
| 22 | Stolen pending recipient private key | Attacker can open packages sealed to that request | — | Cancel the request; make a new one |
| 23 | Stolen sealed package only | Useless without the decapsulation key | KEM | HNDL — §14 |
| 24 | Stolen plaintext pad | **Total compromise** of that pair | — | Out of scope; destroy the pair |
| 25 | Future PQ break | Archived packages may become openable | **ML-KEM-768 alone against a quantum adversary** — a CRQC breaks X25519 outright, so the hybrid covers a *classical* ML-KEM break, not this one | §14 |
| 26 | Future symmetric break | Archives compromised | **SHA3-256** (the X-Wing combiner), **HKDF-SHA-256**, or **AES-256-GCM** — any one alone suffices | §14 |
| 27 | Compromised endpoint | **No protection** | — | §15 |
| 28 | CSPRNG state duplication or repetition | Key generation and encapsulation repeat | **No protection** — platform CSPRNG. (key, nonce) uniqueness is unaffected: §7.4 derives the nonce | §7.4, §16.1, §17 |
| 29 | Two tabs, one pending request, two packages | Refused — the second compare-and-set fails | `requestId`-scoped CAS (§10.1) | The existing importer does not prevent this: its lock is pairId-scoped |
| 30 | 2⁸⁸-capable attacker MITM on the **request** channel | **Fingerprint collision — §6 defeated** with no side-channel presence | Nothing in the fingerprint excludes this tier; the 7-day TTL only bounds the window | §6.3 — the honest limit, and the argument for physical exchange (§16.5) |

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

The hybrid suite is chosen so that **no single primitive break opens the
archive** — but the popular shorthand "the attacker must break both" is *false*
for the adversary this section posits, and stating it would be an overclaim. A
cryptanalytically relevant quantum computer breaks X25519 outright, so against
**that** adversary **ML-KEM-768 alone carries the entire claim**. The hybrid's
value is that its two branches cover *different* adversaries, not that their
work factors multiply.

Precisely, an attacker needs **one** of:

1. the hybrid KEM — meaning **ML-KEM-768 against a quantum adversary**, or
   **X25519 against a classical adversary who cryptanalyses ML-KEM**;
2. the **SHA3-256** combiner, inside which §2.1 places the entire X-Wing
   security argument;
3. the DEM — **HKDF-SHA-256** or **AES-256-GCM**.

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
> computational assumptions of X25519, ML-KEM-768, **SHA3-256 as the X-Wing
> combiner**, HKDF-SHA-256 and AES-256-GCM; **on the platform CSPRNG actually
> producing fresh, unpredictable bytes** for key generation, encapsulation and
> the `requestId`; and conditional on the operator actually having performed
> both human comparison ceremonies — which TruePad cannot observe, and which are
> therefore OPERATOR assumptions, not verification results.

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
| Status | **shipped** | **specified, not implemented** |

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

> **The worker, not the UI, owns the fingerprint ceremony.** A boolean
> `confirmed` arriving from the UI is **never** sufficient. Such a flag has no
> subject: a UI-thread adversary — a browser extension, injected script, or
> tampered bundle chunk — could call `seal(body_attacker, confirmed = true)` and
> receive the entire pad sealed to its own key, as a *public* artifact §18
> otherwise permits the UI to hold. That defeats the control §6.1 calls the
> single most important thing this protocol must prevent, and §15's
> endpoint-compromise disclaimer does not cover it, because §18 exists precisely
> to make partial compromise survivable.
>
> Instead the worker records the confirmation **keyed by the request bytes**:
>
> ```
> confirmRequestFingerprint(body):                 # worker
>     requestHash ← H_ds(DS_REQUEST_FP, body)
>     record CONFIRMED { requestHash, body, at } in worker-confined storage
>     return requestHash, words88(requestHash[0..11))
> ```
>
> and `seal()` requires a CONFIRMED record whose stored `body` equals the body
> being sealed, **byte for byte**. The record is one-shot per `requestHash` and
> is discarded on any edit of the pasted code, which also closes the
> time-of-check/time-of-use gap where an operator verifies body *B* and `seal()`
> re-reads *B′*.
>
> A stronger form, recommended if the Phase-1 UX budget allows: the worker issues
> a random 2–3 position challenge ("read me words 2, 5 and 7") and seals only on
> a correct echo. That also defends against an operator who compares only the
> first and last words. The body-keyed record above is the floor, not the ideal.

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
    return requestHash, words88(requestHash[0..11))  # half-open: bytes 0..10

confirmRequestFingerprint(body):                    # WORKER — B2
    (requestHash, words) ← requestFingerprint(body)
    record CONFIRMED { requestHash, body, at } in worker-confined storage
    return requestHash, words                        # one-shot; dropped on edit

words88(b11):                                       # 11 bytes → 8 words
    n ← big-endian integer of b11                   # 88 bits
    for i in 0..7:  idx[i] ← (n >> (77 - 11·i)) & 0x7FF
    return [ WORDLIST[idx[0]], …, WORDLIST[idx[7]] ]

seal(body, padFileBytes):                           # WORKER
    require body parses per §5.1, version 0x01, suite 0x0001
    require a CONFIRMED record exists whose stored body == body, BYTE FOR BYTE
    require |padFileBytes| ≤ 16 777 216
    requestHash ← requestFingerprint(body).requestHash
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
    return (header ‖ ct ‖ tag), words88(confirm)
    # Alice's words stay MASKED until she marks Bob's as received (§8.2)

openSealed(pkg):                                    # WORKER
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
    hold padFileBytes in the worker            # B3: the importer is NOT called
    return words88(confirm)                    # Bob reads these FIRST (§8.2)

commitReceive(requestId, padFileBytes):            # after the operator confirms
    # PRE-FLIGHT — non-mutating, all failures FREE (§11)
    require unpack(padFileBytes) is well-formed and is exactly the 6 expected files
    require pairId is 32 lowercase hex
    require loadStore(<scratch>/a-to-b) and loadStore(<scratch>/b-to-a) both succeed
        # reconciliation, and rollback:none-only — a CLI-origin store refuses here.  FREE
    require both heads' pairId == container pairId
        and the two halves are a matched A->B / B->A pair                            # FREE
        # <scratch> lives OUTSIDE <pairId>/ and importing/<pairId>/ (§10.1),
        # and is removed on every exit path
    require NOT exists(<pairId>/destroyed.json)         # pair-destroyed, FREE
    require NOT committedPairExists(<pairId>)           # pair-exists,    FREE

    under a lock scoped to requestId:
        CAS: PENDING → CONSUMED, durably           # B4; a lost CAS aborts FREE
    # from here on, any failure is LOSS and MUST be reported as such
    commit the EXISTING import with padFileBytes   # B3 — first call to import-pair
    logically destroy dk
    tell the operator to delete the .tps2 file     # B10
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
and check they match* · WORD × 8 → **[The words matched]** → **[Seal pad]** →
**[Save sealed pad]** / **[Share sealed pad]** → *Ask them to read their
confirmation words to you first* → **[Their words matched]** → *Now read these
back to them* · WORD × 8

**Recipient:** *Receive a pad* → **[Create receive code]** → *Send this code to
the other person; check these words with them before they seal the pad*
· WORD × 8 → … → *Choose the sealed pad file* → *Read these confirmation words
to the sender **first**, then check theirs match* · WORD × 8 → **[The words
matched]** → **[Add pad]** → *Delete the sealed pad file — it is a complete copy
of the pad* → **[Delete sealed file]**

Two things in that flow are normative, not cosmetic. **The recipient reads the
confirmation words first** (§8.2) — so the sender's are revealed only after she
marks the recipient's as received, and never before. And **the recipient deletes
the sealed file** (§10.4) — it is a durable copy of the pad, and leaving it
behind is what makes the cross-installation two-time pad possible.

Buttons say *"The words matched"*, not *"I verified"*: TruePad observes a click,
not a comparison (§6.1).

TPR2 may be copy/paste or QR. TPS2 is a **file** — never the clipboard.
