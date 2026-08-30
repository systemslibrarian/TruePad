# TruePad Store Format v2 — binding specification (Phase 0)

**Status.** This document is the binding specification for TruePad Store
Format v2. It is written before any v2 code exists, on purpose: Phase 0
produces this spec and the reference vectors under `spec/reference/`, and
nothing else. No file under `src/` implements what follows; the phases that
will are named claim by claim in §14. Where this spec and any implementation
disagree, this spec wins.

**Status of conventions.** The v1 tree (`src/`, `bin/`, `tests/`) was checked
before this document was written. Every file name, field name, flag, refusal
type, and constant introduced here that does not exist in that tree — which
is nearly all of them, including `pairId`, `head.json`, `secret.bin`,
`journal.log`, the v2 envelope, and most refusal types in §14 — is **PROPOSED
by this spec**: binding on v2 implementations, implemented by none yet.
(Two refusal names are not new: `regressed-below-mark` and `locked` carry
forward v1's existing typed reasons in `src/cli/store.ts` and
`src/cli/lock.ts` unchanged.)
Where this spec describes v1 behavior, it describes what the v1 code actually
does, verified against the tree; where the two differ, §9 documents the
difference rather than redefining v1.

**Language.** MUST, MUST NOT, and MAY are used as in RFC 2119. "Durable" and
"durably", everywhere in this spec, mean durable per §10 and nothing
stronger; every crash-safety claim in §12 is conditional on §10's platform
scope. "Refuses" means: the operation does not happen, nothing is burned,
the refusal is typed (§14), and the process exits 2 (the v1 exit-code
convention, carried forward).

**Thesis, restated once.** The XOR is already a true one-time pad. Everything
in this format is machinery that keeps the theorem's hypotheses true outside
the equation — and no engineering action in this document is promoted into a
stronger cryptographic claim than it deserves. Confidentiality here is
information-theoretic only under §7's declared-uniform assumption and
§13's used-once invariants (§5.4 restates the scope); authentication is
information-theoretic with exactly the ε of §5, under exactly the
conditions §5 states.

---

## 1. Store structure: non-secret header, secret body

A v2 pair directory holds two direction stores under one lock, continuing
the v1 layout (`src/cli/truepad-pad.ts` holds the v1 pair the same way):

```
<dir>/                pair directory, mode 0700
  lock                exclusive lockfile, O_CREAT|O_EXCL (§10)
  a-to-b/             direction store for A->B
    head.json         non-secret header — no secret ever appears here
    secret.bin        secret body — every secret lives here and only here
    journal.log       append-only, fsynced, one JSON line per event (§12)
  b-to-a/             direction store for B->A, same three files
```

All files are created mode 0600, directories 0700, as in v1
(`src/cli/store.ts`). A pair directory with only one direction store is a
half-pair and every v2 operation refuses it (`half-pair`), exactly as v1's
`requirePair` refuses a half-pair today.

### 1.1 `head.json` — the non-secret header

The header is JSON. That is permitted because every header field that
participates in authentication has an exact, specified projection into the
canonical byte string of §6 — the projection table in §6.3 is exhaustive.
Tags are computed only over §6 canonical bytes, never over any JSON
serialization. Fields:

```json
{
  "formatVersion": 2,
  "pairId": "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
  "direction": "A->B",
  "mode": "bytes",
  "sourceDeclarations": [
    { "name": "qrng-usb.bin", "declaredOrigin": "vendor QRNG, operator-asserted", "lengthBytes": 4260032 }
  ],
  "encryption": { "capacity": 1048576, "nextOffset": 0 },
  "authentication": {
    "profile": "wc-one-time-v1",
    "tagBits": 128,
    "capacityRecords": 32768,
    "nextSequence": 0,
    "verifyAttemptLimit": 8,
    "maxCiphertextBytes": 1048576,
    "maxAuthLookahead": 64
  },
  "recordPolicy": { "authenticated": "required", "downgradeAllowed": false },
  "rollback": { "witnessClass": "none", "config": {} },
  "verification": {
    "failurePolicy": { "kind": "freeze", "threshold": 32 },
    "failureCount": 0,
    "clearedAtFailureCount": 0,
    "perSequenceAttempts": {}
  }
}
```

Field rules:

- `formatVersion` MUST be the integer `2`. v1 store files carry no
  `formatVersion` field at all (verified against `src/core/pad.ts`); its
  absence is the v1 signature, and §9 gives the refusal.
- `pairId` is exactly 32 lowercase hex characters encoding 16 bytes. It is
  an identifier, not a secret and not pad material: it MUST NOT be drawn
  from the combined source material (§7 partitions every source byte into a
  secret slice; spending one on a public identifier would violate that).
  gen draws it from the platform RNG; its randomness serves only collision
  avoidance between stores, and no secrecy or uniformity claim attaches to
  it. It replaces v1's human-readable `label` (`PAD-XXXX-AB`); see §9.
- `direction` is exactly `"A->B"` or `"B->A"` (the v1 serialization
  strings). Projection to canonical bytes: §6.3.
- `mode` MUST be `"bytes"`. §3.
- `sourceDeclarations` is operational metadata only: what the operator
  declared about each source at gen. Its entries MUST NOT contain anything
  derived from pad bytes — no hashes, salted hashes, checksums, or
  fingerprints of the material (Phase 1's manifest rule, already binding on
  the header). The three fields shown are the Phase-0 minimum; Phase 1 owns
  the final schema (§14 open questions).
- `encryption.capacity` (E) and `authentication.capacityRecords` (N) are
  the two independent secret budgets, frozen at gen by §7, never revisable.
  Both MUST be non-negative safe integers (< 2^53); `capacity` is in bytes.
- `encryption.nextOffset` and `authentication.nextSequence` are the two
  irreversible high-waters. `0 ≤ nextOffset ≤ capacity`,
  `0 ≤ nextSequence ≤ capacityRecords`; each only ever increases (§13).
- `verifyAttemptLimit` default 8 (§8.3) and `maxAuthLookahead` default 64
  (§8.2) are per-store values; §5.3's bounds scale with them.
  `maxCiphertextBytes` is not a per-store knob: it MUST equal
  `MAX_CIPHERTEXT_BYTES = 1048576` (§4) — the value §5's exact ε is
  derived at — and a header carrying any other value is refused
  `corrupt-head`. A Phase-5 narrowing is a spec amendment that re-derives
  §5's ε, not a header setting.
- `recordPolicy` is fixed at the values shown. There is no other v2 record
  policy: `authenticated` MUST be `"required"` and `downgradeAllowed` MUST
  be `false`. A header saying anything else is refused (`corrupt-head`).
  No flag, environment variable, or config may relax this (§13).
- `rollback.witnessClass` is one of `"none"`, `"separate-state-file"`,
  `"platform-monotonic"`, `"remote-monotonic"`. Phase 0 defined only
  `"none"`; Phase 4 defines the classes normatively in §15 —
  `"separate-state-file"` is implemented (config `{ "path": <absolute
  path> }`), while `"platform-monotonic"` and `"remote-monotonic"` are
  specified with their assumptions and REFUSED by this build
  (`witness-unsupported`, fail closed — never a silent downgrade).
  `config` is class-specific and `{}` for `"none"`.
- `recordPolicy.record` (added with Phase 5, §16) is
  `{ "kind": "variable" }` or `{ "kind": "fixed", "bytes": F }`. A header
  without the field — every store generated before Phase 5 — is variable;
  that compatibility rule is normative, and load-time validation accepts
  exactly these three shapes.
- `verification.failurePolicy` is `{ "kind": "freeze", "threshold": T }`,
  T default 32 (PROPOSED default; operator-settable at gen). `failureCount`
  and `clearedAtFailureCount` implement the reversible freeze (§8.4);
  `perSequenceAttempts` maps decimal sequence strings to attempt counts for
  live sequences. All three are caches of the journal (§12.1) — the journal
  is the durable authority, and load-time reconciliation takes the maximum
  (§12.1), so a stale header can never under-count an attacker's attempts.

### 1.2 `secret.bin` — the secret body

Every secret in a v2 store lives in `secret.bin` and only there. The file
has a fixed size for the life of the store: exactly `E + 32·N` bytes.

```
offset 0            .. E-1            encryption slice: byte at offset e is pad byte e
offset E + 32·s     .. E + 32·s + 15  auth record s: K_s (16 bytes)
offset E + 32·s + 16.. E + 32·s + 31  auth record s: R_s (16 bytes)
```

for `0 ≤ e < E`, `0 ≤ s < N`. Which bytes are *live* is decided by the
header/journal counters, never by file content: a byte below
`encryption.nextOffset`, and any record below `authentication.nextSequence`,
is retired whether or not its bytes still read back. Retired regions
remain physically present in `secret.bin` for the life of the store:
after gen, no v2 operation writes `secret.bin` (§10.1, §12). Retirement
is logical — enforced by the durable counters, which never move
backwards — and it prevents reuse; it is not physical erasure, and this
spec does not pretend the two are the same. Overwriting newly retired
regions in place was considered and rejected: §10 promises nothing about
sector-write atomicity, so an in-place write to a live `secret.bin` that
dies mid-write can tear the sector straddling the retired/live boundary
and corrupt *live* material adjacent to it — pad bytes, `K`, `R` —
which is damage to material still trusted, not merely lost capacity (on
a receiving store, a corrupted live pad byte would let a later genuine
record verify and release wrong plaintext). And even a clean overwrite
would have bought only this: software can forget its reference to pad
material; it cannot prove that the storage medium forgot the bytes.
Phase 6 owns destruction and its stated limits; nothing in this format
claims secure erasure.

A `secret.bin` whose length is not exactly `E + 32·N` is refused
structurally (`corrupt-secret-body`) before any of it is used.

### 1.3 At-rest protection, stated separately

At-rest protection for a v2 store is: file modes (0600/0700), removable
media, physical control of that media, and the ceremony (Phase 3). It is
never encryption, and this spec never implies otherwise. Encrypting a pad
with a key would make the key the secret and the pad a fiction; the format
therefore does not do it, and says so instead of implying protection it
does not have.

---

## 2. The authentication profile: `wc-one-time-v1`

`wc-one-time-v1` is TruePad's instantiation and encoding of a published,
analyzed construction. It is **not a new hash**. From the allowed menu
(one-time polynomial evaluation over GF(2^128); POLYVAL per RFC 8452;
Poly1305), this spec picks:

> **(b) POLYVAL, exactly as specified in RFC 8452** — Gueron, Langley,
> Lindell, "AES-GCM-SIV: Nonce Misuse-Resistant Authenticated Encryption",
> RFC 8452 (Informational, IRTF/CFRG), April 2019. POLYVAL is defined in
> its Section 3; its field-operation examples (`a·b`, `dot(a, b)`) are in
> its Section 7, and its Appendix A (the POLYVAL–GHASH relationship)
> carries a worked POLYVAL evaluation. §11's generator asserts all of
> them before emitting anything.

composed as a Wegman–Carter one-time-masked MAC:

> Wegman, M. N. and Carter, J. L., "New hash functions and their use in
> authentication and set equality", Journal of Computer and System
> Sciences 22(3), 1981, pp. 265–279.

The ε-AXU property of polynomial evaluation hashing that §5 relies on is
the classical theorem, published independently in:

> den Boer, B., "A simple and key-economical unconditional authentication
> scheme", Journal of Computer Security 2(1), 1993, pp. 65–71.
>
> Taylor, R., "An integrity check value algorithm for stream ciphers",
> Advances in Cryptology — CRYPTO '93, LNCS 773, Springer, 1994,
> pp. 40–48.
>
> Bierbrauer, J., Johansson, T., Kabatianskii, G., Smeets, B., "On families
> of hash functions via geometric codes and concatenation", Advances in
> Cryptology — CRYPTO '93, LNCS 773, Springer, 1994, pp. 331–342.

An attribution note, in this project's register: those three papers
establish polynomial evaluation as a universal hash family with the
`d/|F|` bound, each in its own notation; the XOR-differential restatement
over GF(2^128) used in §5 is the standard modern corollary, as used
throughout the GHASH/POLYVAL literature — cited as such, not as a verbatim
theorem of any one of the three.

Why (b) and not the other two allowed families: (a) hand-pinning a
polynomial-evaluation hash would reproduce POLYVAL's content without
POLYVAL's published test vectors, and this project prefers a construction
whose every constant can be checked against an RFC over one whose constants
are merely stated by this spec. (c) Poly1305 is a fine MAC whose published
per-forgery bound (Bernstein, "The Poly1305-AES message-authentication
code", FSE 2005) has the form `8·⌈L/16⌉ / 2^106` — not `d·2^-128`; choosing
it would be legitimate but would buy a strictly looser stated ε at the same
32 bytes per record. The simplest theorem wins.

**Forbidden**, restated from the architecture as normative: any "GF(2^128)
polynomial hash" without full pinning; GHASH-without-spec; novel polynomials
or novel families; key recycling of any kind; any KDF, extractor, or
conditioner anywhere in the auth path; 64-bit tags.

### 2.1 The construction

Authentication has its own namespace, indexed by `sequence` (never by
`startOffset`). Auth record `s` is 32 bytes of pad material (§1.2, carved by
§7): a fresh 16-byte hash key `K_s` and a fresh 16-byte mask `R_s`. For the
record with sequence `s`:

```
tag = POLYVAL(K_s, X_1, ..., X_m) XOR R_s
```

where `X_1..X_m` are the 16-byte blocks of the canonical byte string of §6.
Each `(K_s, R_s)` authenticates exactly one canonical byte string, ever. A
record is spent by retirement (§8, §12) whether or not it ever verified
anything; it is never reused, recycled, or re-derived. 32 bytes per record
is ~320 KB per 10,000 records: key recycling would buy nothing worth the
theorem it costs.

### 2.2 Every constant, pinned

- **Field:** GF(2^128) defined by the irreducible polynomial
  `x^128 + x^127 + x^126 + x^121 + 1` (RFC 8452 §3).
- **Field-element encoding and byte order:** RFC 8452 §3's little-endian
  convention, in both bytes and bits: the least significant bit of the
  first byte is the coefficient of `x^0`; the most significant bit of the
  last byte is the coefficient of `x^127`. A field element as a 128-bit
  integer is therefore a little-endian read of its 16 bytes.
- **The dot operation:** `dot(a, b) = a·b·x^-128`, where
  `x^-128 = x^127 + x^124 + x^121 + x^114 + 1` (RFC 8452 §3).
- **Evaluation order:** `S_0 = 0`; `S_j = dot(S_{j-1} XOR X_j, H)` for
  `j = 1..m`; the result is `S_m` (RFC 8452 §3 — blocks in order, Horner).
- **Message-block encoding:** the canonical byte string of §6, split into
  consecutive 16-byte blocks, first block first.
- **Partial-block handling:** the canonical string is zero-padded to a
  16-byte boundary at construction (§6). POLYVAL never sees a partial
  block. Padding is disambiguated by the authenticated `ciphertextLength`
  field, never by inspecting the padding.
- **Length encoding:** `ciphertextLength` as an unsigned 64-bit
  little-endian integer inside the fixed 64-byte canonical header (§6).
  There is no trailing length block; §5.1 proves none is needed.
- **Domain separation:** canonical block 1 is the constant
  `"wc-one-time-v1"` ASCII followed by two 0x00 bytes
  (`77632d6f6e652d74696d652d76310000`). It is fixed, nonzero, and first —
  §5.1 uses the nonzero part.
- **Tag encoding:** the 16-byte field element, encoded to bytes by the same
  RFC 8452 mapping, carried on the wire as 32 lowercase hex characters.
- **Key/mask sizes:** `K_s` 16 bytes, `R_s` 16 bytes, 32 bytes per record.
  All 2^128 values of `K_s` are legal, including zero — the §5 bound
  already accounts for every key, so there is no rejection step and no
  conditioning of any kind between pad material and key (§7).
- **Tag width:** 128 bits. This is the v2 minimum and the only v2 value;
  64-bit tags are forbidden.

The reference implementation under `spec/reference/` implements exactly
this pinning to compute §11's vectors. It does not constitute the security
argument; §5 does, by citation.

---

## 3. Mode: v2 is bytes-only

`mode` MUST be `"bytes"`. Letters mode is v1- and exhibit-only, and this is
a disposition, not an accident:

- v1 letter-mode stores **remain v1 forever**. They are never converted,
  reinterpreted, or wrapped. The letters alphabet, its add-mod-26 combiner,
  and its rejection sampling stay exactly where they are today: in
  `src/core/` for the exhibit and for v1 pads.
- v2 tooling refuses any v1 store — letters or bytes — with the typed
  refusal `v1-store` (§9, §14). A letters store is not a special case with
  a special path; it is a v1 store.
- No v2 encoding for letter-mode material exists in this spec, so no v2
  code path can be extended toward one without amending the spec first.

Why: the §6 canonical encoding, the §4 size bound, and the §5 block count
are all byte-denominated. A letters variant would need its own canonical
encoding and its own bound derivation, and the exhibit — the only place
letters earn their keep — neither needs authentication nor persists pads.

---

## 4. MAX_CIPHERTEXT_BYTES

```
MAX_CIPHERTEXT_BYTES = 1048576   (1 MiB — the architecture default, kept)
```

This is the maximum ciphertext length of the variable-length Phase-2 record
format. A record whose declared or actual ciphertext length exceeds it is
**malformed**: refused structurally (`oversize-ciphertext`), before any
authentication material is read, costing no durable write (§8, §12).

The default is kept, not deviated from, for these reasons: (1) it bounds
the §5 block count, and with it the exact ε, at a value that keeps the
security statement short; (2) a whole record must be held in memory to
verify before any byte of it is trusted (§12 — plaintext is released only
after the tag passes and the burn is durable), and 1 MiB keeps that
obligation trivial; (3) the CLI's messages are operator text and files a
courier-provisioned pad can afford — a channel whose messages routinely
exceed 1 MiB is spending pad at a rate this tool's ceremony model does not
serve well anyway. Larger payloads are split into multiple records, each
with its own auth record, by the Phase-2 tooling.

Phase 5 MAY later choose a fixed record size ≤ MAX_CIPHERTEXT_BYTES. That
narrows this maximum — and thereby fixes the block count in §5's exact
expression, which is then re-derived as `d = 4 + ⌈C_max/16⌉` at the
narrowed `C_max` — it does not introduce the first bound; this section
did.

---

## 5. The exact forgery bound

The architecture's `ε ≈ L_max·2^-128` was guidance. This section is the
normative mathematics; from here on there is no `≈` in the security
statement.

### 5.1 The theorem, specialized to this encoding

Consider polynomial evaluation hashing over GF(2^128): the family
`H_K(M) = Σ_{j=1..m} M_j · K^{m-j+1}` over block sequences
`M = (M_1..M_m)`, key `K` uniform. Note the sum ends at `K^1` — the zero
constant term is load-bearing: with a `K^0` term, two equal-length
messages differing only in the last block would have a key-independent
XOR difference, and the family would not be XOR-universal at all.

The bound (the `d/|F|` bound of den Boer 1993; Taylor, CRYPTO '93;
Bierbrauer–Johansson–Kabatianskii–Smeets, CRYPTO '93 — §2's citations and
attribution note): for any two block sequences `M ≠ M'` of at most `d`
blocks each and any 16-byte `δ`, **provided the difference polynomial
`g(k) = poly_M(k) + poly_M'(k) + δ` is not the zero polynomial**,

```
Pr_K[ H_K(M) XOR H_K(M') = δ ] ≤ d · 2^-128
```

because a nonzero polynomial of degree ≤ d has at most d roots in the
field. The hypothesis is not decoration: distinctness of the sequences
alone does not supply it. With this indexing, `M_1` multiplies the highest
power of `K`, so a sequence prefixed with all-zero blocks hashes
identically to the unprefixed one for every key — `(0^16, X)` collides
with `(X)` with probability 1. The hypothesis holds whenever the two
sequences have equal block counts (some coefficient at degree ≥ 1 then
differs, whatever `δ` is), and whenever they have unequal block counts and
the longer sequence's leading block is nonzero (its top coefficient
survives in `g`). The encoding below is built to land in those cases,
always:

1. **POLYVAL is this family at a substituted key.** Unrolling RFC 8452's
   iteration: `POLYVAL(H, X_1..X_m) = Σ_j X_j · H'^{m-j+1}` where
   `H' = H·x^-128`. Multiplication by the fixed invertible field element
   `x^-128` is a bijection on the field, so uniform `H` gives uniform `H'`,
   and the bound for key `H'` is the bound for key `H`. The Montgomery-style
   factor changes no probability.
2. **The encoding is injective.** Two distinct records (any difference in
   `pairId`, `direction`, `sequence`, `startOffset`, or ciphertext bytes)
   produce distinct canonical byte strings: the header fields sit at fixed
   offsets in a fixed-width 64-byte prefix, and equal-length ciphertexts
   pad identically while unequal-length ciphertexts already differ in the
   authenticated `ciphertextLength` field at offset 56. Distinct canonical
   strings produce distinct block sequences.
3. **Distinct block sequences give a nonzero `g`, even across lengths.**
   For equal block counts, some block differs, so some coefficient of `g`
   at degree ≥ 1 is nonzero. For unequal block counts `m > m'`, the
   coefficient of `k^m` in `g` is `X_1` — and canonical block 1 is the
   domain-separation constant, which is nonzero by construction (§2.2).
   The classical leading-zero-block subtlety (a shorter message colliding
   with itself prefixed by zero blocks) cannot occur, which is why no
   trailing length block is needed.

### 5.2 ε at MAX_CIPHERTEXT_BYTES

The canonical string of a record with ciphertext length `C` has

```
d(C) = 4 + ⌈C/16⌉   blocks
```

(64-byte header = 4 blocks, plus the padded ciphertext). At
`C = MAX_CIPHERTEXT_BYTES = 1048576`:

```
d_max = 4 + 65536 = 65540
```

**The per-attempt forgery bound of wc-one-time-v1 is exactly**

```
ε = 65540 · 2^-128        ( = 16385 · 2^-126, < 2^-111.9 )
```

This is the normative ε. Concretely: an attacker who has seen the
legitimate envelope for sequence `s` — canonical string `M`, tag
`t = POLYVAL(K_s, M) XOR R_s` — and submits any `(M', t')` with `M' ≠ M`
succeeds iff `POLYVAL(K_s, M) XOR POLYVAL(K_s, M') = t XOR t'`, which the
theorem bounds by ε. Because `R_s` is uniform, fresh, and used once, the
observed tag reveals nothing about `K_s` (it is a one-time pad on the hash
output), so the bound is information-theoretic: it holds against unbounded
computation. For an in-window sequence whose legitimate envelope was never
emitted, the attacker has seen nothing under `(K_s, R_s)` and any submitted
tag succeeds with probability exactly `2^-128 ≤ ε`.

### 5.3 Per-record and per-window

Attempts against a sequence are capped by the durable reservation machinery
(§8.3, §12), so:

```
P[forge record s]          ≤ verifyAttemptLimit · ε
                           = 8 · 65540 · 2^-128  =  524320 · 2^-128   (< 2^-108.9)

P[forge any record in the
  contestable window, at
  any single moment]       ≤ maxAuthLookahead · verifyAttemptLimit · ε
                           = 64 · 8 · 65540 · 2^-128                  (< 2^-102.9)
```

finite by construction and crash-safe by the reservation invariant (a crash
loses an attempt, never grants one — §12). One honest scope note: the
reservation invariant makes the per-record attempt count *crash*-safe, not
*restore*-safe. A backup-restore of the pair can roll `perSequenceAttempts`
back to an earlier value — failed authentications reserve attempts without
moving the high-waters, so the load-time mark check cannot see the
regression — handing an attacker `verifyAttemptLimit` fresh guesses per
restore. This is closed for a store with a configured rollback witness,
which records `attemptsReserved` and refuses the restored store
`witness-regressed` (§15.1, §15.4, N18a); at `witnessClass: "none"` it is
part of §9.4's stated backup-restore residual. These bounds are per the
stated defaults; a store generated with different `verifyAttemptLimit` or
`maxAuthLookahead` substitutes its own values into the same expressions.

### 5.4 What this bound does not say

It says nothing about the uniformity of the source material — that is §7's
declared-uniform assumption and the verdict's conditional. It says nothing
about confidentiality (the encryption slice's job, conditional the same
way). It says nothing about availability — §8.4 prices that separately and
honestly. And it does not make the store's *files* tamper-evident: it
authenticates envelopes on the channel, not `head.json` on disk (§10, §9's
open residual).

---

## 6. Canonical authenticated bytes

Tags are computed over the byte string defined here — never over JSON, and
never over any re-serialization of JSON.

### 6.1 Layout

All integers unsigned little-endian. LE is pinned throughout for one
reason: the §2 field-element encoding is RFC 8452's little-endian mapping,
and one byte order in one construction is one fewer place to be wrong.

```
offset  width  field
------  -----  -----------------------------------------------------------
0       16     domain separator: 77632d6f6e652d74696d652d76310000
               (ASCII "wc-one-time-v1", then two 0x00 bytes)
16      16     pairId (16 raw bytes)
32      1      formatVersion: 0x02
33      1      direction: 0x00 = A->B, 0x01 = B->A
34      6      reserved: MUST be 0x00 in any constructed canonical
               string (supplied by the spec, never by the wire — §6.3)
40      8      sequence          u64 LE
48      8      startOffset       u64 LE
56      8      ciphertextLength  u64 LE
64      C      ciphertext (C = ciphertextLength ≤ MAX_CIPHERTEXT_BYTES)
64+C    p      0x00 padding, p = (16 − (C mod 16)) mod 16
```

Total length `64 + C + p`; block count `4 + ⌈C/16⌉`. An empty ciphertext
(`C = 0`) yields exactly the 64-byte header and no padding block.

### 6.2 The wire envelope (PROPOSED)

The v2 envelope is one line of JSON, emitted with exactly these eight
fields in exactly this order:

```json
{"formatVersion":2,"pairId":"a0a1…af","direction":"A->B","sequence":7,"startOffset":4096,"ciphertextLength":32,"ciphertext":"4041…5f","tag":"5bb8…64d9"}
```

Parsing is strict, and every check below is structural (§14.1's
structural class, fired at §12.3 O0 — free, before any secret is
touched):

- The v1-signature check runs first, before the eight-key rule: a JSON
  object with a `label` field and no `formatVersion` is a v1 envelope,
  refused `envelope-v1` (§9) — never `malformed-envelope`. This
  precedence is what makes ledger claim N4 decidable. (The signature is
  read from the parsed keys, so a v1 line whose spellings use JSON
  escapes still lands here, not below.)
- After that, spellings are checked lexically, on the raw text: property
  names on the wire are the eight literal spellings, with no JSON escape
  sequences, and no property name appears twice — an escaped or
  duplicated property name, of any key, required or extra, is
  `malformed-envelope`. String values are held to the same one-spelling
  rule: a value spelled with escape sequences is `malformed-envelope`
  even when it decodes to an in-domain string. Number values obey it too:
  `formatVersion` is spelled exactly `2`, and `sequence`, `startOffset`,
  and `ciphertextLength` are canonical decimal integers matching
  `^(0|[1-9][0-9]*)$` — a non-canonical spelling that still parses
  in-domain (`7.0`, `7e0`, `-0`, `2.000`) is `malformed-envelope`. JSON
  inter-token whitespace remains legal exactly as JSON defines it; the
  grammar is strict about spellings, not byte-exact between tokens.
- After that, the input MUST be a JSON object with exactly these eight
  keys — no extras, none missing. (Key order is not significant on parse;
  JSON does not order objects. Tags do not depend on it; they are over
  §6.1 bytes.) `formatVersion` MUST be the integer 2. Anything else
  non-conforming: `malformed-envelope`.
- `pairId` MUST match `^[0-9a-f]{32}$` (32 lowercase hex characters).
  `tag` MUST match `^[0-9a-f]{32}$`. `ciphertext` MUST match
  `^(?:[0-9a-f]{2})*$`. Uppercase hex is refused: one accepted
  representation, byte for byte, no alternates.
- `direction` MUST be exactly `"A->B"` or `"B->A"`.
- `sequence`, `startOffset`, `ciphertextLength` MUST be non-negative safe
  integers (JSON numbers that are integers in `[0, 2^53)`) AND spelled
  canonically per the bullet above; a value that is out of that range, or
  spelled non-canonically, is `malformed-envelope`. Their operative
  domains are narrower and checked
  later: `sequence` against §8.1/§8.2's window, `startOffset` against
  §12.3 O1's offset and capacity checks.
- `ciphertext` MUST be exactly `2·ciphertextLength` characters; a mismatch
  is `malformed-envelope` (the v1 `consumed`-vs-payload cross-check,
  carried forward).
- `ciphertextLength > maxCiphertextBytes` is `oversize-ciphertext`,
  checked on the declared length before the hex is even decoded.

### 6.3 Parse → canonical-bytes projection

The wire envelope is human-readable, so the projection from parsed fields
to §6.1 bytes is specified exactly:

| wire field         | domain (after strict parse)      | canonical projection                      |
| ------------------ | -------------------------------- | ----------------------------------------- |
| `formatVersion`    | the integer 2                    | byte 0x02 at offset 32                    |
| `pairId`           | 32 lowercase hex chars           | 16 raw bytes at offset 16 (hex-decoded)   |
| `direction`        | `"A->B"` \| `"B->A"`             | 0x00 \| 0x01 at offset 33                 |
| `sequence`         | integer in [0, 2^53)             | u64 LE at offset 40                       |
| `startOffset`      | integer in [0, 2^53)             | u64 LE at offset 48                       |
| `ciphertextLength` | integer in [0, maxCiphertextBytes] | u64 LE at offset 56                     |
| `ciphertext`       | hex, length 2·ciphertextLength   | raw bytes at offset 64, then 0x00 pad     |
| `tag`              | 32 lowercase hex chars           | not part of the canonical string — it is compared against the computed tag |

Every authenticated field round-trips exactly: the domains above are
bounded, the widths fixed, and each domain value has exactly one canonical
byte image and exactly one accepted wire spelling. The domain separator,
and the reserved zeros at offsets 34–39, come from the spec, not the wire.

---

## 7. Source-material partition

gen combines the declared sources by bytewise XOR (Phase 1 owns the
multi-source UX; this section owns the partition, which is identical for
one source or many). Let `M[0 .. L)` be the combined material,

```
L = 2 · (E + 32 · N)
```

with `E = encryption.capacity` and `N = authentication.capacityRecords`,
both frozen at gen. The partition is deterministic and exact:

```
M[0            .. E)             A->B encryption slice   (byte e ↦ offset e)
M[E            .. E + 32N)       A->B authentication slice
M[E + 32N      .. 2E + 32N)      B->A encryption slice   (byte E+32N+e ↦ offset e)
M[2E + 32N     .. 2E + 64N)      B->A authentication slice
```

Within an authentication slice, record `s` (for `0 ≤ s < N`) is bytes
`[32s, 32s+16)` as `K_s` and `[32s+16, 32s+32)` as `R_s`, in slice-local
offsets.

Normative rules:

- Every combined source byte populates **exactly one** secret position in
  **exactly one** slice. Material is never copied, never reused across
  slices, and never processed: no KDF, no extractor, no hash conditioner —
  the XOR combination and this partition are the only operations between
  declared sources and secret body (raw declared-uniform material only).
- **gen MUST refuse** (`source-too-short`) unless every declared source
  supplies at least `L` bytes. Exactly the first `L` bytes of each source
  are combined; surplus beyond `L` is not used, and gen MUST say how many
  bytes went unused rather than implying they were.
- One file is one source. gen MUST NOT split a single file and count it as
  two sources (Phase 1's rule, binding on the format's required-length
  check from the start: the length every source must supply is the whole
  `L`, per direction budgets included).
- The two directions' budgets are equal by this formula (E and N are per
  direction). This supersedes v1's `--external` midpoint split — see §9.

The verdict line for combined material is Phase 1's, quoted here so the
format and the verdict cannot drift apart: "Uniform if at least one
declared source was uniform and independent of the others."

---

## 8. The auth-sequence window

Let `nextSequence` be the receiving store's auth high-water and `s` an
incoming envelope's sequence. Order of checks and their costs is normative
(§12 places them in the OPEN pipeline; every check in §8.1–§8.2 precedes
attempt reservation and costs no durable write).

### 8.1 Below and beyond: replay and malformed

- `s < nextSequence` — a replay or a retired record: refusal
  `sequence-retired`. This is the class the v1 reuse guard becomes.
- `s ≥ capacityRecords` — no such record exists in this store, ever:
  **malformed**, refusal `sequence-malformed`.

### 8.2 The finite window

```
MAX_AUTH_LOOKAHEAD = 64   (architecture default, kept)
```

An envelope with `nextSequence + maxAuthLookahead ≤ s < capacityRecords` is
refused: `sequence-out-of-window`, structurally, free. Only
`nextSequence ≤ s < min(nextSequence + maxAuthLookahead, capacityRecords)`
can ever reach attempt reservation.

The tradeoff, stated rather than left implicit: a finite window bounds the
immediately contestable future — at any moment an attacker can contest at
most `maxAuthLookahead × verifyAttemptLimit = 512` attempts (§5.3 gives the
resulting bound), and can force at most that many reserved-attempt durable
writes against slots the sender has not reached. The price is that more
than `maxAuthLookahead` consecutive lost records push the legitimate sender
out of the receiver's window, and recovery is then an explicit operator
action (§8.5) — the channel does not heal silently. Unlimited lookahead
was rejected: it would tolerate arbitrary loss, but every future slot in
the store would be contestable at once (`capacityRecords ×
verifyAttemptLimit` durable-write attempts and a contested-state ledger
bounded only by the store size). 64 is kept as the default because a
courier channel that loses 64 consecutive messages is having an
operational incident that ought to surface an operator, not a protocol
event to absorb silently. A store generated with a different value carries
it in `authentication.maxAuthLookahead`; this spec's bounds scale as §5.3
states.

### 8.3 verifyAttemptLimit (default 8) and the reservation

`verifyAttemptLimit` caps verification attempts per sequence, permanently.
Its default is 8: enough that a few transit-corrupted deliveries of a
legitimate envelope do not permanently contest the record (each corrupted
delivery burns one attempt; the intact copy still verifies on a later
attempt), small enough that `8·ε` stays below `2^-108` (§5.3). Before any
verification, the attempt is durably reserved (§12, and invariant §13);
`perSequenceAttempts[s] ≥ verifyAttemptLimit` refuses `sequence-contested`
before reservation, free. A contested sequence is permanent: never
verifiable again under its `K_s`/`R_s`; recovery is §8.5.

### 8.4 The freeze, and the availability price

`failureCount` counts actual failed verifications (durably, before each
refusal is emitted — §12). When `failureCount − clearedAtFailureCount ≥
failurePolicy.threshold` (default 32), the pair is frozen: burn and open
both refuse (`frozen`) until an operator clears the freeze, which records
`clearedAtFailureCount = failureCount` and resets nothing else — not
`failureCount`, not any attempt counter (§13).

The availability price of authenticated open is stated, not hidden: every
in-window forgery attempt costs the receiver one durable write (the
reservation). Forgery spam can freeze the receiver; sustained spam against
future slots can force the operator to retire records — bounded by the
finite window (at most `maxAuthLookahead × verifyAttemptLimit` contestable
at any moment); out-of-window garbage is refused free. The freeze
threshold and the window are the two brakes: the freeze is the reversible
operator brake, the attempt limit is the permanent cryptographic brake.
Neither ever costs secrecy, and no failed attempt burns either namespace
(§13) — but "no pad destruction" would overstate it, so this spec does
not say that. Auth records an attacker contests are destroyed unused at
recovery (§8.5): destruction from the channel is not eliminated, it is
**bounded** — at most the contestable window at any moment, repeatable
only as the legitimate sender advances the window — and **surfaced** to
the operator as an explicit retire, never silent. The encryption slice is
untouched by any failed attempt; contrast v1, where one forged
`startOffset` silently burns any amount of remaining pad. That is the
cost of a finite, stateable forgery bound: the failure direction is
correct, and its price is named.

### 8.5 Operator recovery

Recovery from a contested sequence, or from a sender pushed out of the
window, is an explicit operator action, journaled (§12.1): retire — advance
`nextSequence` past the affected records (destroying their `K`/`R` without
use) — or retire the pair. The Phase-3 ceremony owns the operator-facing
verb and its confirmations; the format defines the journal record and the
monotonicity rule it must obey (§13: state never moves backwards; clearing
a freeze never resets attempt counters).

---

## 9. v1 coexistence

### 9.1 Refusals, not bridges

- A v2 open of a v1 envelope is a typed refusal: `envelope-v1`. Detection:
  a JSON envelope with a `label` field and no `formatVersion` is v1 (the
  v1 wire shape `{label, startOffset, consumed, payload}` is verified
  against `src/core/cipher-otp.ts`); nothing with `formatVersion: 2` and
  the §6.2 shape is. There is no `--legacy`, no compatibility parse, no
  best-effort mode. This list of flags that do not exist is normative:
  `--no-auth`, `--legacy`, `--force` (§13).
- v2 tooling refuses any v1 store with `v1-store` (a `pad.json` with
  symbols and no `formatVersion` is the v1 signature — verified against
  `src/core/pad.ts` `serialize()`); letters or bytes makes no difference
  (§3).
- v1 tooling, unchanged, fails on v2 stores by its own existing checks
  (`Pad.deserialize` refuses objects that are not v1 pads). Nothing in
  Phase 0 modifies v1 code, and no later phase may weaken v1's refusals to
  accommodate v2.

### 9.2 Migration stance

There is no store conversion, in either direction, ever — this roadmap's
one v2 migration is: **generate a fresh v2 pair** (at a Phase-3 ceremony
once ceremonies exist; from Phase-1 gen tooling before then), and retire the
v1 pair on its own terms. Reasons, stated: v1 material's provenance
(platform DRBG, or a single external file split at a midpoint) cannot be
retrofitted into §7's declared-source partition; v1 stores carry no
capacity split between encryption and authentication and no material to
fund the auth namespace; and a converter would be exactly the kind of
bridge that turns a format boundary into a compatibility surface.

### 9.3 Documented v1 differences

| | v1 (verified against the tree) | v2 (this spec) |
| --- | --- | --- |
| Identity | `label` `PAD-XXXX-AB`/`-BA`, human-readable, on the wire | `pairId` 16 bytes hex + explicit `direction` field |
| Envelope | `{label, startOffset, consumed, payload}`, unauthenticated; hex payload accepted in either case | eight strict fields incl. `tag` (§6.2); lowercase hex only |
| Version marker | none anywhere (no `formatVersion` in `pad.json` or envelopes) | `formatVersion: 2` in header and envelope |
| Modes | `letters` (default) and `bytes` | `bytes` only (§3) |
| External material | `--external FILE`: one file split at the byte midpoint, first half A→B, second half B→A | superseded by §7's deterministic four-slice partition of combined declared sources |
| Store files | `pad.json` (symbol map) + `marks.log` + `lock` | `head.json` + `secret.bin` + `journal.log` + `lock` (§1) |
| Forged `startOffset` | burns the receiver's remaining pad; the v1 banner says so on every start | refused except with the §5 probability: a forged or tampered envelope verifies with probability at most `verifyAttemptLimit·ε` (§5.3); only a record that passes the tag check can drive a burn (Phase 2 wires the enforcement; the format makes it expressible) |
| Seek | any structurally valid envelope drives the seek-and-burn | skip material is burned only after the tag verifies (§12 OPEN) |
| Exit codes / refusal register | `0` ok, `2` refused (nothing burned), `1` usage or I/O error; envelope-level reasons (`OtpRefusalReason`, `src/core/cipher-otp.ts`): `pad-exhausted`, `direction-mismatch`, `mode-mismatch`, `label-mismatch`, `envelope-invalid`, `reuse-refused`; store-level: `no-pad`, `corrupt-pad`, `regressed-below-mark`, `corrupt-marks`, `locked` | identical convention, extended taxonomy (§14.1) |

### 9.4 OPEN V1 RESIDUAL — carried forward, still open, and wider in v2

Restoring a whole pair directory from a backup still regresses the state
files and the journal **together** — `head.json` and `journal.log` in v2,
exactly as `pad.json` and `marks.log` in v1. The v2 FORMAT does not fix
backup. Only a Phase-4 rollback witness — an authority outside the
directory's failure domain — addresses it, with the strength caveats
Phase 4 owns ("a witness is only as monotonic as the mechanism enforcing
its non-regression"). Until a witness class other than `none` is
configured and enforced, this residual stands, and this spec states it
rather than claiming otherwise.

v2's three-file store also invites a **mismatched per-file restore** (for
example, a backup tool that versions small text files but skips the large
binary). An earlier revision of this spec named that variant *worse* than
the whole-directory restore: its required §1.2 zeroize could leave
restored counters pointing at all-zero records, and an all-zero `(K, R)`
verifies an attacker's all-zero tag with probability 1
(`POLYVAL(0, M) = 0`). That hazard described a store this format no
longer produces: §1.2 now forbids writing `secret.bin` after gen, so on
an active store the file never changes and there are no zeroed regions
for counters to roll back over. What a restore of `head.json` and
`journal.log` to earlier counters does instead — with the unchanged
`secret.bin`, whole-directory or per-file makes no difference to the
outcome — is resurrect retired-but-physically-present material for
**reuse**: the classic two-time-pad regression, plus re-verification
under spent `K`/`R`. The load-time mark check catches the half it can
see: a `head.json` behind a journal that survived the restore is refused
`regressed-below-mark` (§12.1). It cannot catch both state files
regressing together — that is indistinguishable from an honest earlier
state, content never decides liveness (§1.2), and a header fingerprint of
the material would violate §1.1's no-derived-content rule. The **named
operator assumption**, alongside §10.3's, therefore keeps its wording: a
pair directory is restored as all three files together or not at all —
no longer because a partial restore is a distinct catastrophe, but
because every restore that regresses both state files, partial or whole,
collapses into the whole-directory residual above, and only the partial
restore that leaves the journal behind is caught. That whole-directory
residual stays OPEN; the Phase-4 witness is what retires the assumption,
and until then it stands, stated.

**Phase-4 status of this residual.** §15 (added with Phase 4) delivers
the witness. For a store with `witnessClass: "separate-state-file"`
configured and its witness file in a genuinely independent failure
domain, the two-time-pad regression above becomes the typed refusal
`witness-regressed` before anything is consumed: a restored
`head.json`/`journal.log` — whole-directory or the both-files-together
partial restore the load-time mark check cannot see — carries
high-waters below what the witness recorded, and the store refuses to
move. The witness also records `attemptsReserved`, so a restore that
rolls back ONLY the per-record attempt budget — refilling a contested
record's guesses without regressing the high-waters — is caught the same
way (§15.1, §5.3). At the default `witnessClass: "none"` — every store
that does not opt in — **this residual stands exactly as written above,
and now also covers the attempt-budget rollback**: a backup-restore resets
`perSequenceAttempts`, so the finite-forgery bound is crash-safe but not
restore-safe without a witness. The per-class strength caveats of §15
apply: a separate state file is only as unrestorable as the domain it
lives in.

---

## 10. Durability & concurrency model

Every "durable"/"durably" in this spec means durable per this section, and
the §12 crash-matrix guarantees are conditional on it.

### 10.1 Definition

An operation is **durable** when the data AND the metadata needed to find
it have reached stable storage per the platform's fsync semantics: file
contents via `fsync` on the file descriptor, and — where the platform
supports opening a directory handle — the directory entry via `fsync` on
the directory. Concretely, v2 carries forward v1's two primitives from
`src/cli/store.ts`: atomic replace (write `<name>.tmp.<pid>` in full with
short writes detected, fsync, rename over the target, fsync the
directory) for `head.json`, and append-then-fsync (append one line, fsync
the file, fsync the directory) for `journal.log`. `secret.bin` has
exactly one write point: its initial write at gen MUST be durable —
written in full with short writes detected, fsynced, directory entry
fsynced — before `head.json` or the `init` journal line exists (§12.4).
After gen it is never written again (§1.2): retirement moves the
counters, not the file.

### 10.2 Platform scope, stated

The scope comments below are pulled from the v1 source rather than
restated from memory; they bind v2's claims exactly as they bind v1's.

From `src/cli/store.ts` (header comment), verbatim:

> Limitation, stated rather than papered over: this defends against
> crashes and against loading a stale copy of pad.json. It does not defend
> against an operator restoring the whole directory from a backup, which
> regresses the pad and the mark together. Tested on Linux ext4 only (the
> test suite writes under os.tmpdir()). fsync on a directory handle is
> POSIX behaviour; where a directory cannot be opened it is skipped, and
> the file fsyncs still run.

From `src/cli/lock.ts` (header comment), verbatim:

> Fail closed on a leftover lock: after a crash or SIGKILL the lockfile
> survives, and this module does NOT decide whether the recorded pid is
> dead (pids are reused). It refuses and tells the operator exactly what
> to remove once they have confirmed nothing else holds the pad. Tested on
> a local Linux ext4 filesystem only; O_EXCL semantics on network
> filesystems were not tested.

Therefore, normatively: v2 durability is **verified on Linux ext4 only**.
Directory fsync may silently no-op on some platforms, and where a
directory handle cannot be opened it is skipped. **Windows and network
filesystems are UNVERIFIED.** On macOS, `fsync(2)` is documented by the
platform as not guaranteeing media flush without `F_FULLFSYNC`, which the
v1 primitives do not issue; macOS power-loss durability is therefore also
UNVERIFIED, and this spec says so rather than implying a proven
append-only register on any platform outside the verified scope.

### 10.3 Concurrency scope

The model is a **single-host exclusive lock**: `O_CREAT|O_EXCL` on
`<dir>/lock`, held for the duration of any operation on either half of the
pair, released on exit and on SIGINT/SIGTERM, fail-closed on leftovers
(refusal `locked`, no pid-liveness guessing) — v1's `lock.ts`, unchanged
in design. A pair
directory on shared or network storage, or reached from two hosts, is
**out of scope**: `O_EXCL` is not trusted there (the lock.ts scope comment
above), no reliable detection of "this directory is on NFS/SMB from two
hosts" exists in portable Node, so this is a **named operator assumption**
— the operator keeps each pair directory on local storage reachable from
one host — refused where detectable, assumed and stated where not.

**The witness needs its own lock.** A witness file (§15.2) sits OUTSIDE every
pair directory and **one file may witness several pairs**, so the pair lock
above does not cover it: two pairs advancing at once hold two *different* pair
locks while performing one read-modify-write over one shared file. Atomic
replace (§10.1) prevents a torn file; it does not prevent a **lost update** —
the elementwise maximum of §15.3 is applied only to the key being advanced,
and every other pair's entry is carried over from the snapshot that writer
read, which a concurrent writer may already have superseded. The result would
regress a counter the witness had committed, which is precisely the condition
§9.4/§15.3 exist to refuse.

Normatively, therefore: the §15.3 ADVANCE read-modify-write is performed under
a **second exclusive lock keyed on the witness file itself** — `O_CREAT|O_EXCL`
on a sibling `<witness>.lock`, acquired before the witness is read for
mutation and released only after the durable replace and directory fsync
complete. The lock is keyed on the witness, never on the pair, the pairId, or
the (pair, direction): the pairs sharing a witness are exactly the ones that
must exclude one another. **Lock order is PAIR then WITNESS**, everywhere and
without exception, and no pair lock is ever acquired while a witness lock is
held. The PREFLIGHT read takes no witness lock — it reads only its own pair's
entry, which no other writer may modify while this operation holds that pair's
lock — so the lock is not held across a user-facing operation.

The witness lock inherits the pair lock's stance verbatim: fail-closed on
leftovers, **no pid-liveness guessing**. A contending updater waits and then
refuses rather than proceeding unserialised.

**The lock is probed at preflight, and the probe is what keeps a leftover
free.** The advance acquires the lock *after* the §12 durable commit, so a lock
nobody will ever release would let every operation commit, retire the record's
pad, and only then fail — destroying one record per invocation, on every pair
sharing that witness, indefinitely. That would be strictly worse than the lost
update the lock prevents, whose refusal is free. So the preflight acquires and
immediately releases the lock on a short bound, alongside the writability
probe, and a leftover refuses `locked` before anything is consumed. The advance
waits far longer, because refusing *there* costs pad. Like the writability
probe this is a probe, not a guarantee: a peer taking the lock between probe
and advance still costs the one in-flight record — the bound §15.3 already
states, unchanged, not a second loss row. No new refusal name is introduced;
a held witness is the existing `locked` refusal. The availability consequence
is stated rather than hidden: a lock left behind by a crash or SIGKILL makes
**every pair sharing that witness** refuse until an operator confirms nothing
holds it and removes the file. That is the intended trade — a refusal is an
availability failure, a lost update is a silent rollback of committed state.

**One authority, one lock.** The lock is keyed on the witness's *canonical*
path, not the string in the header: the parent directory is resolved
(collapsing relative paths, `..`, and symlinked parents) and the basename is
resolved to its on-disk spelling (collapsing case on a case-insensitive
filesystem, where `realpath` alone returns the path as given and would
otherwise hand two spellings of one file two different locks). A witness path
whose final component is a **symbolic link** is refused: the atomic replace
does not follow it, so the first advance would replace the link with a regular
file and leave its target frozen — one authority silently becoming two. A
basename ending in `.lock` is refused as reserved. A **relative** witness path
is refused at load, since it would name different files from different working
directories. What this does not establish is stated rather than invented: a
**hard link**, or two bind mounts or network paths onto one file, are
indistinguishable here, and two stores reaching one witness that way do not
exclude each other. Identity is the platform's path identity and no more —
never a hash of witness or pad content (N17).

**Scope, and it is narrower than the pair lock's.** The exclusion is only as
good as `O_EXCL` on the medium, which §10.2 scopes to local Linux ext4, with
network filesystem semantics untested. The exposure is *worse* here than for a
pad directory, because §15.2's argument for a witness is that it lives in a
failure domain the pair's backup does not cover — which tempts an operator
toward a network share or a sync client, exactly where `O_EXCL` may admit two
writers. Normatively, therefore: **a witness shared by more than one pair MUST
live on a local filesystem on one host**; "independent failure domain" means a
different device or backup regime, not a network share. This build cannot
detect the violation and does not pretend to.

This adds no field to the witness (§15.2's entry shape is frozen: the lock is a
separate file, never a generation counter, epoch, or writer id inside the
witness) and **no durability claim**: the witness lock rides on the same
`O_EXCL` and fsync primitives as everything else here, under the same §10.2
scope, and on a witness medium chosen to be independent it is no better
verified than that.

---

## 11. Test vectors

### 11.1 Reference implementation constraints (met, and binding on changes)

The reference implementation lives in `spec/reference/`:
`wc-one-time-v1.mjs` (the pinned construction) and `vectors.mjs` (the
generator). Constraints, all currently satisfied and binding on any future
edit: plain `.mjs` for Node ≥ 22; **zero dependencies and zero imports**
(not even `node:` builtins) other than `vectors.mjs` importing
`wc-one-time-v1.mjs`; nothing imported from `src/`, ever, even
accidentally (the files import only each other); deterministic output (no
clock, no randomness). The vectors are generated by exactly one named
command:

```
node spec/reference/vectors.mjs
```

which asserts the RFC 8452 Appendix A POLYVAL examples before emitting
anything and prints the JSON embedded below (about a second of compute;
the field arithmetic is bit-serial on purpose — the reference is written
to be checked against RFC 8452 line by line, not to be fast). The spec
embeds the vectors; the code never becomes a second spec — where the two
disagree, this document wins and the code has a bug.

The keys and masks below are test constants for comparing implementations.
Nothing shaped like them is ever real pad material, and the protocol uses
each `(K, R)` for exactly one sequence number; the cases reuse one pair
across messages because they test the hash, not the protocol.

### 11.2 RFC 8452 cross-checks (asserted by the generator)

The field-operation values are from RFC 8452 Section 7; the POLYVAL
evaluation is the worked example in its Appendix A.

| check | source | value |
| --- | --- | --- |
| a | §7 | `66e94bd4ef8a2c3b884cfa59ca342b2e` |
| b | §7 | `ff000000000000000000000000000000` |
| a·b | §7 | `37856175e9dc9df26ebc6d6171aa0ae9` |
| dot(a, b) | §7 | `ebe563401e7e91ea3ad6426b8140c394` |
| POLYVAL(`25629347589242761d31f826ba4b757b`, `4f4f95668c83dfb6401762bb2d01a262`, `d1a24ddd2721d006bbe45f20d3c9f362`) | App. A | `f7a3b47b846119fae5b7866cf5e5b77e` |

### 11.3 The frozen vectors

Output of `node spec/reference/vectors.mjs`, embedded verbatim:

```json
{
  "command": "node spec/reference/vectors.mjs",
  "profile": "wc-one-time-v1",
  "construction": "tag = POLYVAL(K, canonical bytes) XOR R (RFC 8452 POLYVAL; FORMAT-V2.md Sections 2 and 6)",
  "rfc8452CrossChecks": "passed (asserted before emission)",
  "noteOnKeys": "test constants only; the protocol uses each (K, R) for exactly one sequence number",
  "cases": [
    {
      "name": "hash-only",
      "note": "POLYVAL(K, canonical bytes) with no mask applied; every other case is this plus an XOR",
      "key": "000102030405060708090a0b0c0d0e0f",
      "mask": null,
      "pairId": "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
      "direction": 0,
      "sequence": 7,
      "startOffset": 4096,
      "ciphertextLength": 32,
      "ciphertext": "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f",
      "canonicalBytes": "77632d6f6e652d74696d652d76310000a0a1a2a3a4a5a6a7a8a9aaabacadaeaf0200000000000000070000000000000000100000000000002000000000000000404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f",
      "canonicalBlocks": 6,
      "hash": "4ba90e0dd06af1497c869bc334117ac6"
    },
    {
      "name": "full-tag",
      "note": "same fields as hash-only; tag = hash XOR mask",
      "key": "000102030405060708090a0b0c0d0e0f",
      "mask": "101112131415161718191a1b1c1d1e1f",
      "pairId": "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
      "direction": 0,
      "sequence": 7,
      "startOffset": 4096,
      "ciphertextLength": 32,
      "ciphertext": "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f",
      "canonicalBytes": "77632d6f6e652d74696d652d76310000a0a1a2a3a4a5a6a7a8a9aaabacadaeaf0200000000000000070000000000000000100000000000002000000000000000404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f",
      "canonicalBlocks": 6,
      "hash": "4ba90e0dd06af1497c869bc334117ac6",
      "tag": "5bb81c1ec47fe75e649f81d8280c64d9"
    },
    {
      "name": "empty-ciphertext",
      "note": "C = 0: canonical bytes are exactly the 64-byte header, 4 blocks",
      "key": "000102030405060708090a0b0c0d0e0f",
      "mask": "101112131415161718191a1b1c1d1e1f",
      "pairId": "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
      "direction": 0,
      "sequence": 8,
      "startOffset": 4128,
      "ciphertextLength": 0,
      "ciphertext": "",
      "canonicalBytes": "77632d6f6e652d74696d652d76310000a0a1a2a3a4a5a6a7a8a9aaabacadaeaf0200000000000000080000000000000020100000000000000000000000000000",
      "canonicalBlocks": 4,
      "hash": "1a78ebf5d8a790e5f7a8630f141a691e",
      "tag": "0a69f9e6ccb286f2efb1791408077701"
    },
    {
      "name": "partial-block",
      "note": "C = 5: one padded ciphertext block; ciphertextLength (not the padding) fixes the boundary",
      "key": "000102030405060708090a0b0c0d0e0f",
      "mask": "101112131415161718191a1b1c1d1e1f",
      "pairId": "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
      "direction": 0,
      "sequence": 9,
      "startOffset": 4128,
      "ciphertextLength": 5,
      "ciphertext": "c0c1c2c3c4",
      "canonicalBytes": "77632d6f6e652d74696d652d76310000a0a1a2a3a4a5a6a7a8a9aaabacadaeaf0200000000000000090000000000000020100000000000000500000000000000c0c1c2c3c40000000000000000000000",
      "canonicalBlocks": 5,
      "hash": "7ef162614dd3184bb608bbd7f076f558",
      "tag": "6ee0707259c60e5cae11a1ccec6beb47"
    },
    {
      "name": "max-ciphertext",
      "note": "C = MAX_CIPHERTEXT_BYTES; ciphertext byte i = i mod 256, not embedded",
      "key": "f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff",
      "mask": "e0e1e2e3e4e5e6e7e8e9eaebecedeeef",
      "pairId": "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
      "direction": 1,
      "sequence": 10,
      "startOffset": 4133,
      "ciphertextLength": 1048576,
      "ciphertextRule": "byte[i] = i mod 256, for i in [0, 1048576)",
      "canonicalLength": 1048640,
      "canonicalBlocks": 65540,
      "hash": "bb000eb83f148210d884e5b9dfa26a68",
      "tag": "5be1ec5bdbf164f7306d0f52334f8487"
    }
  ]
}
```

The `max-ciphertext` case's 65,540 blocks are exactly the `d_max` at which
§5.2's ε is evaluated.

---

## 12. State machine and crash matrix

Both transactions run under the pair lock (§10.3) and the §10 durability
model. "Commit" below always means the §10 primitives in the order given.

### 12.1 Journal, and load-time reconciliation

`journal.log` is the append-only durable authority (v1's `marks.log`,
generalized). One JSON line per event; types (PROPOSED):

```
{op:"init",        pairId, direction, capacity, capacityRecords, at}
{op:"send",        sequence, startOffset, consumed, nextOffset, nextSequence, at}
{op:"attempt",     sequence, at}
{op:"auth-fail",   sequence, failureCount, at}
{op:"open",        sequence, startOffset, consumed, skipped, nextOffset, nextSequence, at}
{op:"retire",      toSequence, toOffset, reason, at}
{op:"clear-freeze", atFailureCount, at}
```

`at` is operational metadata (an ISO timestamp), never authenticated and
never load-bearing. The operator actions (`retire`, `clear-freeze`) commit
in the same order as the SEND and OPEN advance commits (§12.2 S2, §12.3
O5): header rewrite first, journal append second, each durable per §10.
(OPEN's failure path is the one deliberate exception to that order —
§12.3 O4 appends the `auth-fail` line before the header rewrite; §12.1's
maximum rule absorbs either ordering.) On load, compute the journal's aggregates:
max `nextOffset` (over `send`, `open`, and `retire.toOffset` lines), max
`nextSequence` (over `send`, `open`, and `retire.toSequence` lines),
per-sequence `attempt` counts, `auth-fail` count, and the last
`clear-freeze.atFailureCount`. Then:

- **High-waters** (`encryption.nextOffset`, `authentication.nextSequence`)
  in `head.json` **below** the journal's maxima: refusal
  `regressed-below-mark` — a stale header copy, exactly v1's load refusal.
  At or above the journal's maxima: allowed; the header being ahead is the
  crash signature of dying between the header rename and the journal
  append, and the header is the later truth (v1 has the same property
  between `pad.json` and `marks.log`).
- **Attempt counts, `failureCount`, and `clearedAtFailureCount`** are
  never a regression trigger: a header below the journal on these is the
  expected cache-lag state (§12.3 O3 permits deferring the header
  refresh). Each is resolved as the **elementwise maximum** of header and
  journal values (`clearedAtFailureCount`: the header value or the last
  journaled `atFailureCount`, whichever is larger — both are monotone).
  The reservation is journaled *before* verification (§12.3), so the
  journal can never under-count verifications actually begun: a crash can
  only make the machine believe in *more* spent attempts than the
  attacker truly got, never fewer.
- A malformed final journal line is the append-crash signature and is
  refused `corrupt-journal` with instructions; a malformed line mid-file
  is not a crash signature and is refused `corrupt-journal` for hand
  inspection (v1's `corrupt-marks` distinction between the two, carried
  forward unchanged).

### 12.2 SEND

```
States:  S0 checked  →  S1 staged (in memory)  →  S2 committed  →  S3 emitted
```

- **S0 — checks, all free:** pair lock held; store loads clean (§12.1);
  not frozen (§8.4); plaintext length `C ≤ maxCiphertextBytes`
  (`oversize-ciphertext`); auth budget: `nextSequence < capacityRecords`
  (else `auth-exhausted` — sending is permanently dead, §13); encryption
  budget: `nextOffset + C ≤ capacity` (else `encryption-exhausted`). Any
  refusal here costs nothing durable.
- **S1 — staged:** `s := nextSequence`; read `K_s`, `R_s` and the
  encryption window `[nextOffset, nextOffset + C)` from `secret.bin`;
  compute ciphertext (XOR) and tag (§2.1) in memory. Nothing on disk has
  changed.
- **S2 — committed, durably:** rewrite `head.json` with
  `nextSequence := s + 1`, `nextOffset := nextOffset + C` (atomic
  replace); append the `send` journal line (append-then-fsync).
  `secret.bin` is not touched: the consumed regions stay physically
  present, retired by the counters alone (§1.2).
- **S3 — emitted:** only now is the envelope written to stdout.

Crash matrix (SEND):

| crash during | on-disk result | loss | reuse? |
| --- | --- | --- | --- |
| S0/S1 | unchanged | nothing | no |
| S2, before `head.json` rename lands | temp file lingers; old state | nothing (retry re-stages) | no |
| S2, after rename, before journal append | header ahead of journal — allowed on load (§12.1) | the staged record + window: consumed, never emitted | no |
| after S2, before S3 | fully committed | the material (envelope never existed outside the process) | no |

A crash before emission loses material and never reuses it — v1's
non-negotiable burn order (`store.ts`: "(1) write … (2) fsync … (3) only
then does the caller emit"), extended to two namespaces. Losing pad is the
correct failure direction. There is no zeroize step, and the reasoning
that once ordered one strictly after the counters now removes it
entirely. An earlier revision required overwriting the newly retired
regions with zeros; zeroize-before-counters was always forbidden, because
zeroing a live auth record would later verify an attacker-knowable
all-zero key — but zeroize-after-counters is an in-place write to a live
`secret.bin`, and §10 promises nothing about sector-write atomicity: a
power loss mid-write can tear the sector straddling the retired/live
boundary and corrupt *live* bytes adjacent to it, damage to trusted
material rather than the safe lose-material direction (§1.2 states the
receiving-store consequence). One order voids the bound, the other
corrupts live material; the write is therefore not performed at all, and
retirement is the counters' act alone.

### 12.3 OPEN

```
States:  O0 structural  →  O1 window  →  O2 state gates  →  O3 reserved
         →  O4 verified/failed  →  O5 retired  →  O6 released
```

- **O0 — structural, free, before any secret is touched:** parse per §6.2.
  `malformed-envelope`, `envelope-v1`, `oversize-ciphertext`,
  `wrong-pair` (pairId ≠ store's), `wrong-direction` (envelope direction
  is not the one this role opens) all fire here, reading nothing from
  `secret.bin`.
- **O1 — window, free:** `sequence-retired` (`s < nextSequence`);
  `sequence-malformed` (`s ≥ capacityRecords`); `sequence-out-of-window`
  (§8.2). Encryption-side consistency, also free: `offset-retired`
  (`startOffset < nextOffset` — a legitimate sender's offsets never run
  behind an accepting receiver); `encryption-exhausted`
  (`startOffset + C > capacity`).
- **O2 — state gates, free:** `frozen` (§8.4); `sequence-contested`
  (§8.3).
- **O3 — reservation, durable, the first durable act:** append the
  `attempt` journal line and fsync. Verification MUST NOT begin unless
  this reservation is durable (§13). (The `head.json`
  `perSequenceAttempts` cache may be refreshed here or at the next
  header rewrite; the journal is the authority either way — §12.1.)
- **O4 — verify:** read `K_s`, `R_s`; compute the tag over §6 canonical
  bytes; compare constant-time.
  - **Fail:** append the `auth-fail` journal line and rewrite `head.json`
    (`failureCount + 1`), durably, and only THEN emit the `auth-failed`
    refusal. No secret material is retired: neither namespace burns, and
    `K_s`/`R_s` remain live for the sequence's remaining attempts (§13).
  - **Pass:** compute the plaintext in memory (XOR against
    `[startOffset, startOffset + C)`), then O5.
- **O5 — retired, durably:** rewrite `head.json` with
  `nextSequence := s + 1` and `nextOffset := startOffset + C` — retiring
  every auth sequence ≤ s and all encryption material through the end of
  the accepted window, including the skipped `[old nextOffset,
  startOffset)` bytes and the skipped sequences' `K`/`R`, which are
  destroyed unused (lost-message material is burned as surely as used
  material); append the `open` journal line. `secret.bin` is not
  touched: the retired ranges, used and skipped alike, stay physically
  present (§1.2).
- **O6 — released:** only now is the plaintext written to stdout.

Crash matrix (OPEN):

| crash during | on-disk result | loss | reuse? | free attempt? |
| --- | --- | --- | --- | --- |
| O0–O2 | unchanged | nothing | no | no (nothing durable happened; nothing was verified) |
| O3, before append is durable | possibly a torn last journal line (refused with instructions on next load, §12.1) | nothing verified; at worst one attempt appears spent | no | no |
| O3→O4, after reservation, before compare completes | attempt journaled | one attempt of the 8 (the envelope can be retried while attempts remain) | no | no — the reservation preceded the verification |
| O4 fail, before the `auth-fail` append | attempt journaled; no failure recorded | the refusal was never emitted; the freeze counter under-counts by at most this one crash | no | no |
| O4 fail, after the `auth-fail` append, before the header rewrite | journal holds the failure; header `failureCount` lags — resolved by §12.1's maximum, nothing under-counts | the refusal was never emitted | no | no |
| O4 pass → O5, before header rename lands | attempt journaled, counters unchanged | one attempt; the envelope re-verifies on retry | no | no |
| O5, after rename, before journal append | header ahead of journal — allowed (§12.1) | plaintext never released; the record and window are retired: the envelope can never be opened (its sequence is now `sequence-retired`) — the message is lost, not reusable | no | no |
| O5→O6 | fully committed | the plaintext (re-running the open now refuses `sequence-retired`) | no | no |

Every crash, at every point, loses **material or an attempt — never
reuse, and never a free attempt**. The one genuinely unpleasant row is
crash-inside-O5: an authenticated message can be lost with its material
retired and its plaintext never released. That is the correct failure
direction for a pad — the alternative (release before durable retirement)
would let a crash replay the release — and the spec states the price
rather than hiding the row.

### 12.4 gen

gen is not a state machine worth a matrix, but two crash properties are
normative. First, inherited from v1: the two direction stores are written
one after the other under the pair lock; a crash between them leaves a
half-pair, and every v2 operation refuses a half-pair (`half-pair`)
rather than using the surviving half. Second, new with the head/secret
split and easy to get fatally wrong: within one direction store, gen MUST
make `secret.bin` durable per §10 — written in full with short writes
detected, fsynced, its directory entry fsynced — **before** writing
`head.json` and the `init` journal line, and gen's success output is
gated on all three being durable. The order matters because the reverse
is silent: v1 kept pad material inside the one file it wrote durably
(`pad.json`, via the atomic-replace primitive), while a v2 `secret.bin`
written without fsync could survive a power loss at its correct fixed
length with lost or zeroed data blocks — passing the §1.2 length check,
undetectable thereafter (content never decides liveness), and turning
later sends into XOR-with-zeros, ciphertext equal to plaintext. A
directory missing any of the three files is `corrupt-store` and refused.
Zeroization of gen's in-memory material and the Phase-3 workspace rules
(tmpfs, no persistent copy) are ceremony properties, not format
properties, and are claimed only by Phase 3.

---

## 13. Format invariants (normative)

Reproduced verbatim from the Phase-0 architecture; each is a normative
requirement of this format, and §14's ledger phrases the testable form:

> - A v2 pair is always authenticated. No v2 operation can emit an
>   unauthenticated record. No --no-auth/--legacy/--force exists.
> - A v2 open of a v1 envelope is a typed refusal.
> - Auth exhaustion permanently kills sending. Stranded encryption
>   material is destroyed at the retirement ceremony, never spent.
> - Successful advance to position N retires every position ≤ N in
>   BOTH namespaces (encryption offsets; auth sequences).
> - Failed authentication burns neither namespace.
> - Structural and window refusals (malformed, oversize, replay,
>   out-of-window, v1 envelope) precede attempt reservation and
>   never consume a durable write.
> - VERIFICATION-ATTEMPT RESERVATION: after all structural/window
>   checks pass and before evaluating the authenticator, durably
>   increment perSequenceAttempts[N]. Verification MUST NOT occur
>   unless the reservation is durable (§10). A crash after
>   reservation loses an attempt, never creates a free attempt.
>   failureCount increments only on an actual failed verification
>   and is persisted before its refusal is emitted.
> - A sequence reaching verifyAttemptLimit is permanently contested:
>   never verifiable again under its K/R. Recovery is an explicit
>   operator action that retires it (advances the auth high-water
>   past it) or retires the pair. Clearing a freeze never resets
>   attempt counters.
> - Encryption and authentication state never move backwards.

And the state distinctions, from the same architecture:

> Persistent state, distinguished: encryption high-water (irreversible) |
> auth high-water (irreversible) | rollback witness (externally monotone) |
> failure/attempt counters (durable metadata, NOT secret consumption —
> attempt reservations persisted BEFORE verification, failureCount before
> its refusal, so a crash or restart never resets an attacker's attempt
> count).

Two clarifications this spec adds (they interpret, not weaken): "durably"
in the reservation invariant means §10; and "retires every position ≤ N in
BOTH namespaces" is implemented by §12.3 O5 as `nextSequence := N + 1` and
`nextOffset := startOffset + C` in one atomic header replace.

`status` (Phase-2 verb) MUST show both meters — encryption bytes remaining
of `capacity`, auth records remaining of `capacityRecords` — plus a
`CHANNEL CAPACITY LIMITED BY:` line and the maximum remaining sends. The
maximum remaining sends is `capacityRecords − nextSequence` (each send
consumes exactly one auth record); the LIMITED BY line names
`AUTHENTICATION` when remaining records ≤ ⌈remaining encryption bytes /
maxCiphertextBytes⌉ — even maximum-size sends cannot exhaust the
encryption budget before the records run out — and `ENCRYPTION` otherwise
(PROPOSED display rule).

---

## 14. Failure semantics and the claims ledger

### 14.1 Refusal taxonomy

Every refusal is typed, burns nothing it does not say it burns, and exits
2. Classes: **structural**, **window**, and **budget** refusals precede
attempt reservation and cost no durable write; **state** refusals are
read-only checks of durable state, also free; **verification** is the only
refusal class that costs durable writes (one reservation, one failure
record), and never secret material. gen-time refusals are structural:
nothing exists yet to burn. All type names are PROPOSED except
`regressed-below-mark` and `locked`, which carry forward v1's existing
typed reasons unchanged (`src/cli/store.ts`, `src/cli/lock.ts`); v1's
envelope-level register (`OtpRefusalReason`) is listed in §9.3's
refusal-register row for comparison.

| refusal | class | fires | durable cost |
| --- | --- | --- | --- |
| `malformed-envelope` | structural | §6.2 strict-parse violation | none |
| `envelope-v1` | structural | v1 wire shape (§9.1) | none |
| `oversize-ciphertext` | structural | declared or actual `C > maxCiphertextBytes` (§4) | none |
| `wrong-pair` | structural | envelope pairId ≠ store pairId | none |
| `wrong-direction` | structural | direction/role mismatch (v1's `direction-mismatch`, carried) | none |
| `v1-store` | structural | v2 tooling pointed at a v1 store (§9.1, incl. every letters store) | none |
| `corrupt-head` / `corrupt-secret-body` / `corrupt-store` | structural | header/body/store fails its checks (§1, §12.4) | none |
| `corrupt-journal` | structural | malformed journal line — torn last line vs mid-file, distinguished (§12.1) | none |
| `half-pair` | structural | one direction store missing (§12.4) | none |
| `no-store` | structural | the directory holds no pair at all — v1's `no-pad` analogue; a directory with orphan `secret.bin`/`journal.log` but no header is `corrupt-store` instead (§12.4) | none |
| `regressed-below-mark` | structural | header high-waters behind journal (§12.1) | none |
| `source-too-short` | structural (gen) | a declared source supplies fewer than `L = 2·(E + 32·N)` bytes (§7) | none |
| `ceremony-incomplete` | structural (ceremony) | a Phase-3 ceremony precondition unmet — missing operator assertion, fewer than two sources, provisioned media, two media names reaching one filesystem object, or a medium copy that fails byte-verification against the workspace pair (added with Phase 3; see `docs/CEREMONY.md`) | none |
| `sequence-retired` | window | `s < nextSequence` (§8.1) | none |
| `sequence-malformed` | window | `s ≥ capacityRecords` (§8.1) | none |
| `sequence-out-of-window` | window | beyond `maxAuthLookahead` (§8.2) | none |
| `offset-retired` | window | `startOffset < nextOffset` (§12.3 O1) | none |
| `encryption-exhausted` | window (OPEN) / budget (SEND) | window runs past `capacity` — fires window-class at §12.3 O1, budget-class at §12.2 S0 | none |
| `auth-exhausted` | budget | `nextSequence ≥ capacityRecords` on send — permanent (§13) | none |
| `frozen` | state | freeze active (§8.4) | none |
| `sequence-contested` | state | attempts ≥ `verifyAttemptLimit` (§8.3) — permanent | none |
| `locked` | state | lockfile held/leftover (§10.3) | none |
| `pair-destroyed` | state | a durable `destroyed.json` marks the pair — refused before any secret is read, on `burn`/`open`/`status`/`clear-freeze`/`retire`/`ceremony verify` (§17.3, added with Phase 6) | none |
| `record-size-mismatch` | structural | fixed-record store: envelope `ciphertextLength ≠ F`, or a plaintext longer than `F − 4` (§16, added with Phase 5) | none |
| `witness-unreachable` | state (witness) | configured witness cannot be read (§15.3) — fail closed | none |
| `witness-inconsistent` | state (witness) | witness file violates its own shape (§15.3) — fail closed | none |
| `witness-regressed` | state (witness) | store high-waters below the witness record (§15.3, §9.4) — a restored store, refused before any burn | none |
| `witness-unsupported` | structural | `witnessClass` platform-monotonic/remote-monotonic in this build (§15.2) — refused, never silently downgraded | none |
| `destroy-unconfirmed` | structural | destroy without the matching confirmation (§17.1) — nothing touched | none |
| `auth-failed` | verification | tag mismatch (§12.3 O4) | one reservation + one failure record; **no secret burned** |

### 14.2 Claims ledger

Phrasing is deliberately testable: the repo already tests its README's
sentences (`tests/claims.test.ts` asserts exact phrases and their
absences; `tests/tamper.test.ts` the tamper behavior), and this ledger is
the hook Phase 2 wires into that suite. **The format never claims what
only a later phase enforces.** "Format-normative" means: required of any
conforming v2 implementation by this document, checkable the moment such
an implementation exists; the mathematics in N6–N7 holds now.

**Normative in the v2 format as specified here:**

| # | claim (testable sentence) | anchor |
| --- | --- | --- |
| N1 | A v2 store contains no secret outside `secret.bin`; `head.json` parses as JSON and contains none of the store's `K`, `R`, or encryption bytes. | §1 |
| N2 | No v2 operation can emit an unauthenticated record: the v2 envelope grammar has no tagless form, and `recordPolicy` admits no other value than `{authenticated:"required", downgradeAllowed:false}`. | §1.1, §6.2 |
| N3 | The strings `--no-auth`, `--legacy`, `--force` are not accepted by any v2 verb. | §9.1, §13 |
| N4 | A v2 open of a v1 envelope exits 2 with refusal `envelope-v1` and burns nothing. | §9.1 |
| N5 | v2 tooling refuses every v1 store — letters or bytes — with `v1-store`; no conversion path exists. | §3, §9 |
| N6 | The tag of the §11 `full-tag` vector, recomputed from the §6 layout and §2 constants, equals `5bb81c1ec47fe75e649f81d8280c64d9`; all five vectors reproduce under `node spec/reference/vectors.mjs`. | §11 |
| N7 | The per-attempt forgery bound is exactly `ε = 65540·2^-128` at `maxCiphertextBytes = 1048576`, and per record at most `verifyAttemptLimit·ε`. | §5 |
| N8 | Structural, window, and budget refusals touch no byte of `secret.bin` and append no journal line (state refusals are equally free; §14.1). | §8, §12.3, §14.1 |
| N9 | Verification never begins before its attempt reservation is durable; failed verification retires no sequence and no encryption byte; `failureCount` is durable before the `auth-failed` refusal is emitted. | §12.3, §13 |
| N10 | Accepting sequence `s` durably sets `nextSequence = s+1` and `nextOffset = startOffset + C` before any plaintext is released. | §12.3 |
| N11 | `nextOffset`, `nextSequence`, per-sequence attempt counts, and `failureCount` never decrease across any sequence of v2 operations, crashes, and reloads — absent external replacement of the store's files (§9.4) — given §10's platform scope. | §12.1, §13 |
| N12 | A store generated per §7 required exactly `2·(E + 32·N)` bytes from every declared source, and gen refused (`source-too-short`) any source supplying less. | §7 |
| N13 | Required durability ordering at gen: `secret.bin` durable before `head.json` and the `init` line exist (§12.4). After gen, no v2 operation writes `secret.bin` except `destroy`'s terminal teardown (§17.2), which overwrites then unlinks it — `burn`/`open`/`retire` never rewrite it (§1.2). | §1.2, §12.4, §17.2 |
| N14 | `sourceDeclarations` entries in `head.json` contain no hash, checksum, fingerprint, or any other value derived from pad bytes. | §1.1 |
| N15 | With a witness configured, `burn`/`open`/`retire` refuse `witness-unreachable` or `witness-inconsistent` before anything is consumed when the witness cannot be read or fails its shape. | §15.3 |
| N16 | Store high-waters OR `attemptsReserved` strictly below the witness record refuse `witness-regressed` before anything is consumed — a restored store cannot move, and cannot refill a contested record's attempt budget. | §15.3, §9.4 |
| N17 | A witness entry is exactly the three monotone counters (two high-waters + `attemptsReserved`), all required — a missing or extra field is `witness-inconsistent`, never a silent default — and contains no pad byte, key, mask, plaintext, or ciphertext. | §15.1, §15.2 |
| N18 | `witnessClass` platform-monotonic or remote-monotonic is refused `witness-unsupported` at gen and at load — never silently downgraded to a weaker class. | §15.2 |
| N18a | With a witness configured, a restore that rolls back the per-record attempt budget (failed authentications reserve attempts without moving the high-waters) is refused `witness-regressed`, so §5's finite-forgery bound is restore-safe, not only crash-safe. | §15.1, §15.4 |
| N19 | A fixed-record store refuses a valid-range `ciphertextLength ≠ F` structurally (`record-size-mismatch`), costing nothing durable; a `ciphertextLength > maxCiphertextBytes` is still refused first by §4's oversize check (`oversize-ciphertext`), also free. | §16.2 |
| N20 | For a fixed-record store, the per-attempt forgery bound is exactly `(4 + F/16) · 2^-128`. | §16 |
| N21 | `destroy` refuses without the matching confirmation (`destroy-unconfirmed`) touching nothing; after it succeeds, `secret.bin`, `head.json`, and `journal.log` are gone, the tombstone records the intent, and no erasure of the medium is claimed. | §17 |
| N21a | A pair with a durable `destroyed.json` is refused `pair-destroyed` by `burn`/`open`/`status`/`clear-freeze`/`retire`/`ceremony verify` before any byte of `secret.bin` is read, even when the store files still look valid; no `--force`/restore/clear reopens it. | §17.3 |
| N21b | `destroy` is restartable: a rerun after an interrupted teardown finishes cleanup without refusing on the existing tombstone, preserves the original `destroyedAt`, never resurrects the pair, and converges (idempotent already-destroyed once complete). | §17.2, §17.3 |

(`record-frame-invalid`, §16.2, is an exit-1 error on the post-commit
path, not a refusal: nothing was refused before consumption, and the
material is already retired when it fires.)

**Later-phase claims — originally promised, now delivered where marked:**

| # | claim | phase |
| --- | --- | --- |
| L1 | Multi-source gen: repeatable `--source`, equal lengths, bytewise XOR, one-file-one-source, the verbatim verdict line "Uniform if at least one declared source was uniform and independent of the others.", and a manifest with nothing derived from pad bytes. | Phase 1 — DELIVERED |
| L2 | Live authentication: the SEND and OPEN transactions of §12 actually executed by `burn`/`open`; the forged-`startOffset` burn attack becoming the typed refusals of §14.1; the freeze and window brakes operating; the `status` meters and `CHANNEL CAPACITY LIMITED BY:` display of §13; this ledger's N-claims wired into the claims-test suite. | Phase 2 — DELIVERED |
| L3 | Ceremony as code: `ceremony create/verify`, offline gen with ≥2 sources of distinct physics, tmpfs workspace, two peer media, printed operator assertions, retirement ceremony (including auth-exhausted pairs, contested-record retirement, destruction of stranded encryption material). | Phase 3 — DELIVERED |
| L4 | Rollback witness (§15): `separate-state-file` live with fail-closed semantics and the §9.4 closure for witnessed stores; the confidentiality/metadata split stated. `platform-monotonic`/`remote-monotonic` specified, unimplemented, refused `witness-unsupported`. | Phase 4 — DELIVERED (two classes specified-only) |
| L5 | Fixed-size records ≤ `maxCiphertextBytes` (§16), narrowing §4's maximum per store and fixing the block count in §5's expression. | Phase 5 — DELIVERED |
| L6 | `destroy` semantics (§17) and the verbatim README destruction sentence ("Software can forget its reference to pad material; it cannot prove that flash forgot the bytes."). | Phase 6 — DELIVERED |

**Standing residual, restated:** §9.4's whole-directory-restore regression
is closed only for stores with a configured witness (§15, with its
per-class caveats); at the default `witnessClass: "none"` it stands as
written. §1.2's retirement is logical, not physical — retired bytes remain
present in `secret.bin`, and §17 states destruction's limits and claims no
erasure of the medium. Every durability claim above is scoped by §10 to
verified-on-Linux-ext4.

### 14.3 Open questions

Stated, not answered by invention:

1. **`sourceDeclarations` final schema** — the Phase-0 minimum (§1.1) is
   three fields; Phase 1 must fix the declaration vocabulary (how physics
   is named, whether the operator's uniformity assertion is a field or
   only ceremony text) without ever adding content derived from pad bytes.
2. **Journal growth** — `journal.log` is append-only for life (attempt
   counters must never reset, §13). v1's `marks.log` has the same
   unbounded-growth property at smaller scale. Whether any compaction
   (e.g., a journaled checkpoint that preserves the monotone aggregates)
   is admissible without weakening §12.1 is unresolved; until resolved,
   no compaction.
3. **Freeze scope** — this spec freezes the whole pair (both directions,
   both verbs, §8.4) on the receiving store's threshold. Whether Phase 2
   operational experience justifies freezing only `open` (sending is
   attacker-uninfluenced) is open; the spec starts with the stricter
   pause.
4. **macOS durability** — §10.2 marks macOS UNVERIFIED (no `F_FULLFSYNC`
   in the v1 primitives). Whether v2's implementation phase adopts
   platform-conditional full-flush, or simply keeps macOS out of the
   verified set, is open; the claims stay scoped either way.
5. **Operator recovery surface** — the `retire` journal record is defined
   (§12.1); the operator-facing verb, its confirmation flow, and how the
   retirement ceremony references it belong to Phase 3 and are not
   designed here.
6. **pairId collision discipline** — 16 random bytes make accidental
   collision negligible but nothing checks uniqueness across ceremonies;
   whether the pad book (Phase 3) should record pairIds for operator
   cross-checking is open. No cryptographic claim rests on uniqueness.

---

## 15. Rollback witness (added with Phase 4)

The witness is an authority OUTSIDE the pair directory's failure domain
that remembers how far a store has advanced, so a store rolled back by a
restore refuses to move instead of reusing retired positions. It is
optional (`witnessClass: "none"` is the default and claims nothing), and
its classes differ in strength — the docs say so rather than flattening
them: **a witness is only as monotonic as the mechanism enforcing its
non-regression.**

### 15.1 The record, and what a witness never sees

Per (pair, direction), a witness holds exactly one record:

```
WitnessRecord = { pairId, direction, encryptionNextOffset,
                  authenticationNextSequence, attemptsReserved }
```

Three monotone counters. The two high-waters catch a restore that would
REUSE material (§9.4). **`attemptsReserved`** — the total verification
attempts ever reserved for this (pair, direction) — catches a restore
that would refill the per-record attempt budget: a failed authentication
reserves an attempt WITHOUT moving the high-waters (§12.3 O3, O4-fail), so
a witness recording only the high-waters would never learn about an
attacker's guesses, and a pair backup-restore could reset
`perSequenceAttempts` and hand the attacker `verifyAttemptLimit` fresh
guesses per restore — defeating §5's finite-forgery bound. The witness is
advanced with `attemptsReserved` at the reservation itself (O3, before
verification), so a restored store below it is refused `witness-regressed`
before anything is consumed. Still counters only: never pad contents, hash
keys, masks, plaintext, or ciphertext — that is the content-confidentiality
half of the claim. The metadata half is smaller and stated: any witness
observes burn timing and counter progression; a REMOTE witness would
observe them off-host (message timing, byte volume, message count —
traffic analysis). Local and platform classes are preferred; remote is a
stated tradeoff, not a hidden one.

### 15.2 The classes

- `"none"` — no witness, no claim. §9.4's residual stands as written.
- `"separate-state-file"` — implemented. Config `{ "path": <absolute
  path> }`: a JSON witness file, atomic-replace + fsync per §10, 0600,
  holding `{ "formatVersion": 2, "witness": { "<pairId>/<direction>":
  { "encryptionNextOffset": n, "authenticationNextSequence": n,
  "attemptsReserved": n } } }`. The entry shape is FROZEN as exactly those
  three counters, all required, all non-negative safe integers, no other
  keys: there is no legacy two-counter form, and an entry missing
  `attemptsReserved` (or any counter) is `witness-inconsistent` — never a
  silent 0, which would reopen the attempt-budget rollback of §15.1.
  **Provisioning is EXPLICIT.** A fresh witness is the canonical
  `{"formatVersion":2,"witness":{}}`, created by `truepad2 witness init
  <absolute-path>` with the §10 durable discipline at mode 0600; a valid
  witness object with no entry yet for this (pair, direction) is then the
  fresh bootstrap and accepts a fresh pair. A **zero-byte or whitespace-only**
  file is NOT a fresh witness — it is `witness-inconsistent` at both
  touchpoints. It used to be the documented bootstrap (`touch`), which made
  three situations byte-identical: a file the operator provisioned, one
  truncated by a failed write or a full medium, and a restored zero-length
  placeholder. Adopting an empty file as fresh let an accident be durably
  rewritten with a single key, DELETING every other pair's recorded
  high-water while the operation reported success. Emptiness is not evidence
  of intent. `witness init` refuses to overwrite a witness holding entries and
  refuses to overwrite one it cannot parse. This makes accidental empty state
  distinguishable from an operator-created authority; it does **not** make the
  class rollback-proof — restoring an older VALID witness remains outside this
  class's guarantee, below. One file may witness several pairs. Its strength caveat, verbatim from
  the architecture: an independent backup/failure domain, **NOT
  intrinsically monotonic (a second device can be restored too)** — a
  witness file restored from ITS backup regresses the witness. The
  preflight-snapshot check above closes a replacement that becomes visible
  BETWEEN an operation's preflight and its advance; it does **not** make a
  plain file intrinsically monotonic. A whole authority restored or replaced
  with an older VALID copy outside that window has no external truth against
  which a separate state file could detect the fact — which is precisely why
  `platform-monotonic` and `remote-monotonic` exist, and neither is
  implemented here. The operator assumption is that the
  path lives in a different failure domain (another medium, not covered
  by the same backup) and is never restored. Protection begins at the
  first witnessed commit; an entry-less witness accepts a fresh pair.
- `"platform-monotonic"` — a TPM or platform monotonic counter. Specified
  by this section's semantics with the assumption stated (the platform
  enforces non-regression; the host is trusted to talk to the real
  counter), but UNIMPLEMENTED in this build: gen and load refuse it,
  `witness-unsupported`, fail closed.
- `"remote-monotonic"` — a service enforcing forward-only state. Same
  semantics, assumption stated (the service is honest and available),
  same `witness-unsupported` refusal in this build, plus the metadata
  tradeoff of §15.1.

### 15.3 Semantics (normative for every implemented class)

The witness participates in exactly the verbs that advance high-waters:
`burn`, `open`, `retire`. `status` reads and reports the witness state
but refuses nothing (it is read-only). Two touchpoints:

- **PREFLIGHT**, before anything is consumed, with the free refusals of
  §14.1: the witness cannot be read, OR its directory is not writable
  (the advance below writes there, so an unwritable witness is caught
  now rather than after the store commits) → `witness-unreachable`; it
  parses but violates its own shape → `witness-inconsistent`; the
  store's effective high-waters OR its `attemptsReserved` are strictly
  below the witness record's → `witness-regressed`. All FAIL CLOSED and
  consume nothing — witness
  outage is an availability failure, never a silent downgrade. The store
  being AHEAD of the witness is the benign crash signature (§15.3's
  advance ordering below) and passes. A **zero-byte or whitespace-only**
  witness file is `witness-inconsistent`, not a bootstrap (§15.2); a valid
  witness with no entry for this (pair, direction) passes as fresh.
  Preflight additionally **captures a snapshot** of the whole validated
  witness — its entries and their three counters, which are non-secret
  monotone integers, so the snapshot IS the state and no digest of anything
  is taken (N17). That snapshot belongs to the operation and is the one its
  own advance checks; an operation never takes a second, later reading after
  its store has committed.
- **ADVANCE**, at two points, each writing the witness durably (monotone,
  elementwise maximum on all three counters). The monotone property is over
  the WHOLE file, not merely the key being advanced: no successful advance may
  lower or remove any counter of any other entry. Because one file may witness
  several pairs, whose pair locks do not exclude one another, that read-modify-
  write is serialised under the witness's own exclusive lock — **§10.3**, which
  also fixes the PAIR-then-WITNESS lock order and the stale-lock stance.
  Under that lock, before anything is modified, the advance rechecks the
  current file against its operation's preflight snapshot: **for every key the
  snapshot held, that key must still exist and all three of its counters must
  be >= the snapshot's.** Componentwise `>=`, never byte equality — equality
  would reject the legitimate concurrent forward progress the lock exists to
  make safe, while `>=` accepts another pair advancing its own key and rejects
  a key that vanished or a counter that went backwards. That is the signature
  of the witness authority itself being replaced or rolled back beneath a
  committed operation, and it is refused: the witness is left exactly as
  found and the output is withheld. Since the store has already committed,
  this is the LOSS row below, not a free refusal — loss is acceptable,
  durably endorsing a state below what this operation already read is not.
  (1) **At the reservation**
  (O3), before verification: record the incremented `attemptsReserved`.
  This is what makes a rolled-back attempt budget detectable — the
  witness learns of each guess as it is reserved, not only when the
  high-waters move. (2) **After the §12 durable commit and before the
  emit** (between S2 and S3; between O5 and O6; after retire's commit):
  write the new high-waters. If either write fails, the material or the
  attempt is already durable and the envelope or plaintext MUST NOT be
  released —
  the same loss row as a crash between commit and emit (§12: material,
  never reuse). Because the preflight probes writability, an unwritable
  witness refuses free BEFORE the store commits, so the availability
  price of a severed witness link is bounded to at most the one record
  in flight when the medium first fails, then clean free refusals at
  every subsequent preflight. Only a witness that fails to write in the
  race between the preflight probe and the advance (a quota hit, a medium
  yanked mid-operation) costs that one in-flight record.

### 15.4 What this closes, and what it does not

For a witnessed store, both §9.4 restore variants — whole-directory and
the mismatched per-file restore — become `witness-regressed` refusals
before any burn, and so does a restore that rolls back ONLY the attempt
budget (a contested record's guesses cannot be refilled by restoring the
pair): the witness's `attemptsReserved` makes §5's finite-forgery bound
restore-safe for a witnessed store, not only crash-safe. What it does not
do: protect a store whose witness file shares the store's failure domain
(the §15.2 caveat — a witness restored or emptied alongside the pair
knows nothing), protect at `witnessClass: "none"` (there, §5's bound is
crash-safe but a backup-restore resets the attempt budget, and §9.4's
residual stands), verify pad material content (§1.2: content never
decides liveness), or hide the counters from whoever holds the witness.

---

## 16. Fixed-size authenticated records (added with Phase 5)

A store MAY freeze every record at one ciphertext size `F`, chosen at gen
and never revisable: `recordPolicy.record = { "kind": "fixed",
"bytes": F }`, with `F` a multiple of 16, `32 ≤ F ≤ maxCiphertextBytes`.
This narrows §4's maximum for that store — it does not introduce the
first bound (§4 did) — and thereby fixes the block count in §5's exact
expression:

```
d(F) = 4 + F/16          per-attempt ε = (4 + F/16) · 2^-128
```

(for the suggested `F = 1024`: `d = 68`, ε = 68·2^-128 < 2^-121.9). The
§5.2 statement at `d_max = 65540` remains the format-wide maximum, which
a variable store at the 1 MiB cap can reach.

### 16.1 The frame

The plaintext length moves INSIDE the encrypted-and-authenticated region:

```
frame = plaintextLength (u32 LE) || plaintext || 0x00 padding, exactly F bytes
```

Plaintext capacity per record is `F − 4`. The wire `ciphertextLength` of
every record from a fixed store is exactly `F`, so the channel observes
record count and timing, never message length — that is the point, and
its price is stated: every send consumes `F` encryption bytes and one
auth record regardless of message size.

### 16.2 Rules

- gen: `--record-bytes F` creates a fixed store; the default remains
  `{ "kind": "variable" }`. The default is argued, not assumed: fixed is
  the recommended posture where message length is sensitive, but it
  spends `F` pad bytes per message however short the message, and the
  spec does not make that spend a silent default. A header without
  `recordPolicy.record` (pre-Phase-5) is variable (§1.1).
- SEND on a fixed store: a plaintext longer than `F − 4` is refused
  `record-size-mismatch` (free, before anything is staged). Otherwise
  the frame is built, encrypted over exactly `F` pad bytes, and §12.2
  proceeds unchanged with `C = F`.
- OPEN on a fixed store: an envelope whose `ciphertextLength ≠ F` is
  refused `record-size-mismatch` structurally — before the window
  checks, costing nothing durable — except a `ciphertextLength >
  maxCiphertextBytes`, which §4's oversize check (`oversize-ciphertext`)
  refuses first, also free. §12.3 then proceeds unchanged; after
  the tag verifies and O5 commits, the frame is parsed and the
  `plaintextLength` prefix selects the released bytes.
- A decrypted frame whose length field exceeds `F − 4` cannot come from
  a conforming sender and cannot be forged into existence below the §5
  probability; if it occurs, the material is already retired (O5) and
  the tool reports `record-frame-invalid` and exits 1 — an error, not a
  refusal, in the same loss row as a crash after O5: material lost,
  never reused, no output released.

---

## 17. Destruction (added with Phase 6)

`destroy` removes a pair's accessible material and records the intent. It
claims exactly what software can claim, and states the rest:

> Software can forget its reference to pad material; it cannot prove
> that flash forgot the bytes.

### 17.1 The verb

`destroy <dir> --confirm <pairId> [--reason TEXT]`, pair-level, under the
pair lock. `--confirm` MUST equal the pair's pairId where any half's
header — or, on a resume, the existing tombstone — yields one; for a pair
too corrupt to yield one, the literal confirmation `destroy-unreadable-pair`
is required instead. Anything else is refused `destroy-unconfirmed`, and
nothing is touched. A v1 store is refused `v1-store` (v1 material is
handled by v1's own documentation) — unless a durable tombstone already
marks the directory, in which case this is a destroy-resume of a v2 pair
and proceeds. destroy MUST work on corrupt v2 stores — a store too damaged
to load is still a store an operator must be able to destroy.

### 17.2 Order of operations (normative)

1. Acquire the pair lock; validate the confirmation.
2. Write the tombstone `destroyed.json` durably (atomic replace + fsync):
   pairId where known, timestamp, operator reason, and — where readable —
   each direction's final high-waters. Non-secret only; the tombstone is
   the recorded intent and survives the destruction. **On a resume** (a
   well-formed tombstone already exists), the original tombstone is
   PRESERVED, not rewritten — its `destroyedAt`, `reason`, and
   high-waters are the historical truth of when destruction began, and a
   retry after a crash MUST NOT restamp them.
3. Per half: overwrite `secret.bin` with zeros and fsync — attempted,
   with failures reported, never claimed as erasure. Files already gone
   (a resume past this point) are skipped.
4. Unlink `secret.bin`, `head.json`, `journal.log` in each half; remove
   the half directories; fsync the pair directory. `manifest.json` and
   the tombstone remain: they are the pair's non-secret record. Already
   missing files/directories are acceptable — the step converges.
5. Print the storage-specific limitation, including the sentence above:
   copy-on-write filesystems (APFS among them) may preserve the
   pre-overwrite blocks; SSD wear leveling may preserve any block;
   backups are outside this tool's reach. Physical destruction of
   exhausted or destroyed media is a ceremony step (`docs/CEREMONY.md`),
   not a software claim.

A configured witness is deliberately untouched: its counters are
non-secret, monotone, and harmless for a pair that no longer exists.

### 17.3 The tombstone is the irreversible destruction boundary

`destroyed.json` is not merely historical metadata. **Once it is durable,
the pair has crossed an irreversible line and MUST NEVER be used for a
cryptographic operation again** — even if an interrupted teardown left
`head.json`, `journal.log`, and a whole or partially-zeroed `secret.bin`
behind, and even if those files still look structurally valid. The
tombstone is authoritative over the store files.

- **Normal operations refuse a tombstoned pair.** `burn`, `open`,
  `status`, `clear-freeze`, `retire`, and `ceremony verify` MUST check for
  a durable `destroyed.json` BEFORE loading the pair or reading any byte
  of `secret.bin`, and refuse `pair-destroyed`. This is a known,
  intentional condition — never `corrupt-store`. Nothing is consumed.
- **No path reopens it.** There is no `--force`, no restore, no clear, no
  undo, and no tombstone-removal verb that returns a tombstoned pair to an
  active state. Deleting `destroyed.json` by hand is outside TruePad's
  guarantees, and restoring an active state after the destruction boundary
  is unsupported and unsafe (the secret body may be partially overwritten;
  reusing it risks reuse of pad material).
- **`destroy` is restartable.** A destroy interrupted after the tombstone
  is durable is completed by rerunning `destroy`: it does not refuse
  merely because the tombstone exists, it finishes overwriting and
  unlinking whatever remains, and repeated invocations converge to the
  same final state (both halves gone; `secret.bin`/`head.json`/
  `journal.log` gone; `manifest.json` and the tombstone remaining). A
  rerun on an already-fully-destroyed pair reports an idempotent
  already-destroyed result and changes nothing. A rerun never resurrects
  or reinitializes a pair.

The distinction the spec keeps: the tombstone is the irreversible
software/state decision that the pair is dead; the overwrite and unlink
are best-effort removal of accessible copies; physical erasure is outside
the software claim (the verbatim sentence above).

### 17.4 Crash matrix (destruction)

Under the §10 durability model. At every point AFTER the tombstone is
durable, loss is acceptable; reuse or resumed cryptographic use is
forbidden.

| crash point | on-disk state | normal ops | recovery |
| --- | --- | --- | --- |
| before the tombstone is durable | pair unchanged; no secret overwrite has begun | continue after the ordinary stale-lock recovery (§10.3) | none needed; the pair is still active |
| after tombstone durable, before any `secret.bin` overwrite | tombstone + intact stores | refuse `pair-destroyed` | rerun `destroy` — completes cleanup |
| during the zero-overwrite of a `secret.bin` | tombstone + a partially-zeroed secret body | refuse `pair-destroyed` (the partial secret is NEVER read or consumed) | rerun `destroy` |
| between the two halves | tombstone + one half torn down, one present | refuse `pair-destroyed` (no surviving half is usable) | rerun `destroy` |
| during unlink/removal | tombstone + some files/dirs gone | refuse `pair-destroyed` | rerun `destroy` |
| after all files removed | tombstone (+ `manifest.json`) only | refuse `pair-destroyed` | rerun is idempotent already-destroyed |

---

*End of binding specification. §15–§17 were added with Phases 4–6; the
Phase-0 obligation (the fourteen sections above them) is unchanged.
Changes to this document are format changes: they require regenerating
§11's vectors with the single named command and re-deriving §5's ε if §4,
§6, or a store's §16 record size moved.*
