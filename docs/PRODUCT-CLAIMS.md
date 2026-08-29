# TruePad 2 — cross-edition product claims

This is the **cross-edition** claims ledger: one table so an operator can see,
at a glance, which guarantees are the same on every edition, which are the
weaker operational substitute a given platform provides, which are the
operator's to discharge, and which one edition makes and another does **not**.

It is deliberately conservative. The governing rule is the one the whole
project is built on:

> The XOR is already a true one-time pad. The machinery only keeps the
> theorem's hypotheses true *outside* the equation, and **no engineering
> action is ever promoted into a stronger cryptographic claim than it
> deserves.**

The authoritative per-edition detail lives elsewhere and is only summarised
here:

- **Browser Edition** — `docs/BROWSER-SECURITY.md` (the source of the Browser
  column below).
- **Frozen protocol** — `docs/FORMAT-V2.md` (Store Format v2, `wc-one-time-v1`,
  the §11 vectors, §12 transactions, §17 destruction).
- **Byte-for-byte interop** — `docs/INTEROPERABILITY.md` (a browser store and a
  CLI store are the same files; the interop suite proves it).

Only the **Browser Edition** column is populated today. **Operational
(Desktop/CLI)** claims are governed by `FORMAT-V2.md` §10 and are not restated
here; the **Android** and **Desktop** *product* columns are marked
`forthcoming` and must not be read as present guarantees.

---

## The four classifications

Every row carries exactly one classification. It answers "*who or what makes
this true, and how strong is it?*", not "*is it good?*".

- **PROTOCOL** — guaranteed by the frozen Store Format v2 / `wc-one-time-v1`
  construction. Identical on every edition, because every edition reuses the
  **same `src/core` modules byte-for-byte** (`hex`, `gf128`, `wc-one-time`,
  `envelope2`, `partition2`, `frame2`). A PROTOCOL claim does not get weaker or
  stronger when the platform changes.

- **PLATFORM-OP** — an *operational* guarantee an edition enforces using its
  platform's primitives (single-writer locking, durable commit ordering,
  destruction boundary). The **guarantee is real but platform-scoped and named
  by its substrate**: the Browser Edition's instance is **BROWSER-OP** (OPFS
  sync access handles, `flush()`, Web Locks — see `BROWSER-SECURITY.md`), which
  is weaker than and distinct from the CLI's native equivalent. Never quote one
  edition's PLATFORM-OP strength for another.

- **OPERATOR** — an assumption **only the operator can discharge**: physical
  source provenance and uniformity, out-of-band pad delivery, not clearing
  site data / not restoring an old backup, keeping the two couriered copies
  disciplined. The tool states these; it cannot enforce them.

- **NATIVE-ONLY / UNVERIFIED** — a guarantee **some** edition makes that the
  edition in question does **not**. Stated as absent, never faked or borrowed.
  For the Browser Edition these are power-loss durability, an independent
  external rollback witness, and physical media erasure.

---

## Cross-edition claims matrix

Legend: **✓ PROTOCOL** identical everywhere · **BROWSER-OP** / native-op the
platform's operational form · **OPERATOR** the operator's to discharge ·
**not claimed** stated absent · **forthcoming** not yet a shipped product
column, do not rely on it.

| # | Claim | Class | Browser Edition | Android (forthcoming) | Desktop (forthcoming) |
| - | --- | --- | --- | --- | --- |
| 1 | Store Format v2 files, canonical JSON bytes, POLYVAL, `wc-one-time-v1`, four-slice partition, fixed-record frame, strict envelope grammar | PROTOCOL | ✓ `src/core` reused byte-for-byte; the §11 vectors and the adversarial corpus pass in the browser build (`INTEROPERABILITY.md`) | forthcoming | forthcoming |
| 2 | A store written on one edition is byte-identical and openable on another (browser ⇄ CLI) | PROTOCOL | ✓ proven by `tests/browser-interop.test.ts` (browser-none stores; witnessClass `none`) | forthcoming | forthcoming |
| 3 | Authenticated by default; no downgrade, no `--legacy` / `--no-auth` / `--force`, no v1 path | PROTOCOL | ✓ the browser engine has no such request at all; a v1 store is refused `v1-store` | forthcoming | forthcoming |
| 4 | Commit-before-emit; **loss is acceptable, reuse is not** | PROTOCOL (order) + PLATFORM-OP (durability) | BROWSER-OP: the §12 order preserved in the worker over OPFS `flush()` | forthcoming | forthcoming |
| 5 | Exactly one mutator per pair at a time | PLATFORM-OP | BROWSER-OP: Web Locks (`navigator.locks`), not a UI `isBusy` flag | forthcoming | forthcoming |
| 6 | Three-counter rollback witness; a regressed store refuses `witness-regressed` before consuming anything | PROTOCOL (the record + refusal) + PLATFORM-OP (where it lives) | BROWSER-OP: `browser-none` or `browser-local-witness` (a crash-safe append-only journal in a second, separately-cleared OPFS store, keyed by pair.json; an established witness fails closed, never fresh), §4 | forthcoming | forthcoming |
| 7 | Irreversible `destroyed.json` boundary; restartable, idempotent destroy that refuses the pair everywhere after | PROTOCOL + PLATFORM-OP | BROWSER-OP: tombstone in OPFS; every verb gates on it before any secret read | forthcoming | forthcoming |
| 8 | Retirement is logical — advancing durable counters retires material; `secret.bin` is written once and never rewritten (only zero-overwritten at destroy) | PROTOCOL | ✓ | forthcoming | forthcoming |
| 9 | Uniformity is conditional and stated verbatim: *"Uniform if at least one declared source was uniform and independent of the others."* | PROTOCOL (combiner) + OPERATOR (source) | ✓ verdict shown verbatim at gen; the combiner is unconditional given the conditions, the source is graded separately | forthcoming | forthcoming |
| 10 | No pad-derived value in any metadata (no hash / checksum / fingerprint in head or manifest, N14) | PROTOCOL | ✓ | forthcoming | forthcoming |
| 11 | Secrets never leave the engine boundary; the UI receives only wire-public envelopes, non-secret meters, and plaintext on a successful open | PLATFORM-OP | BROWSER-OP: engine + store live in a dedicated Web Worker + OPFS; no secret in `localStorage`/`sessionStorage`/URL/history/console/logs | forthcoming | forthcoming |
| 12 | No backend, accounts, analytics, telemetry, cloud, or auto-sync; zero network requests during cryptographic operation | PLATFORM-OP | BROWSER-OP: installable PWA with a local shell; third-party assets vendored, strict CSP | forthcoming | forthcoming |
| 13 | Power-loss durability of a mid-write | NATIVE-ONLY / UNVERIFIED | **not claimed** — OPFS documents no power-loss semantics (the CLI claims it only on Linux ext4, `FORMAT-V2.md` §10) | forthcoming | forthcoming |
| 14 | An **independent external** rollback witness (a separate host failure domain) | NATIVE-ONLY | **not offered** — the browser cannot reach an independent host domain; it offers only the browser-local classes of §4, and says so verbatim | forthcoming | forthcoming |
| 15 | Physical erasure of pad material on destroy | NATIVE-ONLY / not claimed | **not claimed** — *"Software can forget its reference to pad material; it cannot prove that flash forgot the bytes."* Zero-overwrite is best-effort hygiene | forthcoming | forthcoming |
| 16 | Physical source provenance / one-file-one-source **by filesystem identity** | OPERATOR / platform caveat | declared, not verified; the browser File API exposes no inode, so alias detection is limited to spotting the *same `File` object* re-selected in one session — an object-reference check, never a comparison of source bytes (§6, §9). Source **content never conditions acceptance** — stated, not invented | forthcoming | forthcoming |
| 17 | Store survives "clear site data", profile restore, or an Incognito context ending | OPERATOR | **not protected** — these destroy or regress the OPFS store; stated operator responsibilities (§2) | forthcoming | forthcoming |

---

## The two source classes — and the one combiner

Rows 9 and 16 above are about the **source**. This section separates the
source claim from the **combiner** claim, because they have different
strengths and conflating them is the single easiest way to overclaim a
one-time pad.

### The combiner is the same on both paths, and it is exact

Every declared source independently supplies the complete
`L = 2·(E + 32·N)` bytes. Those bytes are combined by **bytewise XOR**:

```
M[i] = S1[i] XOR S2[i] XOR … XOR Sn[i]        for every 0 <= i < L
```

and `M` is partitioned into the four secret slices
`[A→B enc][A→B auth][B→A enc][B→A auth]` (`FORMAT-V2.md` §7). Between the
declared sources and the secret body there is **no KDF, no extractor, no hash
conditioner, no whitening, no compression, no modulo folding, and no
statistical test that gates acceptance**. Sources are never concatenated and
never split between them — each one covers the whole pad. Surplus bytes beyond
`L` are unused.

Nothing conditions on what the bytes *say*: an all-zero combined result is
accepted (it is a legitimate draw from the uniform distribution, and refusing
it would condition the accepted distribution), and two sources are never
refused for holding equal bytes. This is **PROTOCOL**, and it does not get
weaker or stronger with the source.

Why multi-source XOR is worth doing: if **at least one** declared source is
genuinely uniform, secret, and independent of the others, the XOR is exactly
uniform over the full space — the other sources need not be perfect, and an
adversary who fully controls all *but* that one learns nothing. The source
carrying the guarantee must also be **secret**; a uniform but published source
guarantees nothing. TruePad cannot determine whether that premise is
physically true.

### The source claim is NOT the same on both paths

| | Device-generated | External ceremony |
| - | --- | --- |
| **Source** | `crypto.getRandomValues()` — the platform's cryptographic random generator (CSPRNG) | operator-supplied files, operator-declared origin |
| **Strength** | **computational / platform source assumption**. Real, and named as what it is | **information-theoretic *eligibility* only if** the operator's physical source assumptions are actually true |
| **Combiner** | exact XOR construction (above) | exact XOR construction (above) |
| **Class** | PLATFORM-OP (source) + PROTOCOL (combiner) | OPERATOR (source) + PROTOCOL (combiner) |
| **What TruePad verified** | that it called the platform CSPRNG | **nothing about the material's physics** |

The device path is **never** described as "truly random", "verified true
randomness", "physical randomness", or "information-theoretically verified".
The combiner may be mathematically exact while the source claim is
computational; those are two statements, and TruePad keeps them apart.

The external path's statement stays **conditional** in every rendering:

> *"Uniform if at least one declared source was uniform and independent of the
> others."* — TruePad did not verify that assumption. If that source
> assumption is true, the pad material satisfies the information-theoretic
> randomness requirement of a one-time pad.

It is never rendered as "perfect secrecy achieved", "true OTP verified", or
"information-theoretic security confirmed".

### A checkbox is not a measurement

The external path requires an explicit **operator declaration** before the pad
can be created:

> *"I understand that TruePad cannot verify physical randomness. For an
> information-theoretic one-time-pad claim, at least one selected source must
> actually be uniformly random, secret, independent of the other combined
> sources, and never previously used."*

This is an **OPERATOR declaration and never a verification result**. Ticking it
changes nothing about the material, and nothing about it is written to the
store: **no `trueRandom`, no `informationTheoretic`, no `verifiedRandom` flag
exists in Store Format v2, and none may be added** — software cannot establish
those facts. The only persisted record is the existing
`head.json → sourceDeclarations[]`: each source's name, the operator's own
origin note, and its length. Nothing pad-derived (N14).

### Delivery is the other half

A source claim is not an end-to-end claim. The pad **file** is the secret, and
for an end-to-end information-theoretic secrecy claim it must also be
delivered through a secret method whose confidentiality does not itself depend
on computational encryption assumptions — physical handoff on removable media
is the clearest ceremony. Email, Dropbox, Google Drive, OneDrive, ordinary
cloud storage and encrypted messengers **do not preserve that claim**; they may
be computationally secure ways to move a file, which is a *different*
guarantee, not a weaker form of the same one.

### The source claim and the platform claim are independent

Choosing the external ceremony does **not** give the Browser Edition any of the
guarantees in rows 13–15 and 17. It does not add power-loss durability, an
independent external rollback witness, physical erasure on destroy, or survival
across "clear site data". Equally, the device generator does not take any of
those away. **A true physical source strengthens neither the authentication
construction nor the operational reuse-prevention machinery**, and neither of
those proves anything about the source's physics. Three separate guarantees:

- **A — OTP secrecy**: XOR under genuinely uniform, independent, secret,
  one-use material. Source is OPERATOR; combiner is PROTOCOL.
- **B — Authentication**: `wc-one-time-v1` Wegman–Carter, and its existing
  bounded forgery claim. PROTOCOL.
- **C — Operational reuse prevention**: counters, journals, attempt
  reservation, the rollback witness, locks, retirement, the destruction
  tombstone. PROTOCOL + PLATFORM-OP.

B and C do not prove A's physical-randomness premise, and A's premise does not
strengthen B or C.

---

## What the Browser Edition explicitly does NOT claim

Restated from `BROWSER-SECURITY.md` §8 so it sits beside the matrix:

- **NOT** native `fsync` / power-loss durability (row 13).
- **NOT** an independent external rollback witness (row 14).
- **NOT** physical erasure on `destroy` (row 15).
- **NOT** verification of source physical provenance or uniformity (rows 9, 16)
  — on *either* source path, and the operator declaration is a declaration,
  not a measurement.
- **NOT** protection against "clear site data", profile restore, or an
  Incognito context evaporating the store (row 17).

Each of these is also surfaced in the in-app **Security Status** screen, so the
operator meets the browser's actual scope, never a borrowed one.

---

## How to read a future edition column

When the Android or Desktop columns are populated they follow the same rule:

- A **PROTOCOL** row stays ✓ **only if** that edition reuses `src/core`
  byte-for-byte and passes the §11 vectors and the adversarial corpus in its
  own build. Anything less is not the frozen protocol.
- A **PLATFORM-OP** row must name that edition's own substrate and its own
  strength. It may not inherit the Browser Edition's BROWSER-OP wording, nor
  quote the CLI's native strength.
- A **NATIVE-ONLY** row is filled in only when that edition genuinely provides
  the guarantee on its platform — never by relabelling a weaker mechanism.
