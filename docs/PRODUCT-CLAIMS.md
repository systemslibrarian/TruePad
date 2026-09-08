# TruePad 3 — cross-edition product claims

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
  column below). That document uses its own older vocabulary — **NATIVE-ONLY /
  UNVERIFIED** — for the browser-versus-CLI comparison it was written to make.
  It maps onto this table's **NOT CLAIMED** / **NOT OFFERED** / **UNVERIFIED**
  and is not a second, competing set of claims.
- **Android Edition** — `docs/ANDROID-SECURITY.md` (the source of the Android
  column below).
- **iOS Edition** — `docs/IOS-SECURITY.md` (the source of the iOS column below).
- **Frozen protocol** — `docs/FORMAT-V2.md` (Store Format v2, `wc-one-time-v1`,
  the §11 vectors, §12 transactions, §17 destruction).
- **Byte-for-byte interop** — `docs/INTEROPERABILITY.md` (a browser store and a
  CLI store are the same files; the interop suite proves it).

**Every edition is now assessed row by row.** 3.0.0 ships three user-facing
editions — Browser, Android and iOS — alongside the operational `truepad2`
CLI, and leaving three columns marked *forthcoming* while three products
shipped was itself a claims defect. The columns below are populated from the
evidence that already exists in this repository; where that evidence does not
reach, the cell says **UNVERIFIED** and names what is missing, rather than
borrowing a neighbouring column's strength.

The authoritative per-edition boundaries remain:
`docs/BROWSER-SECURITY.md`, `docs/ANDROID-SECURITY.md`, `docs/IOS-SECURITY.md`,
and `FORMAT-V2.md` §10 for the CLI.

---

## The six classifications

Every cell carries exactly one classification. It answers "*who or what makes
this true, and how strong is it?*", not "*is it good?*".

- **PROTOCOL** — guaranteed by the frozen Store Format v2 / `wc-one-time-v1`
  construction. Identical on every edition, because every edition implements
  the **same frozen wire** and is held to the **same vectors** (`hex`, `gf128`,
  `wc-one-time`, `envelope2`, `partition2`, `frame2`). A PROTOCOL claim does
  not get weaker or stronger when the platform changes. Note the difference in
  *mechanism*: Browser and CLI reuse `src/core` **byte-for-byte**; Android and
  iOS are **independent reimplementations held to the same test vectors**,
  which is a real cross-check but a different kind of assurance.

- **PLATFORM-OP** — an *operational* guarantee an edition enforces using its
  platform's primitives (single-writer locking, durable commit ordering,
  destruction boundary). The **guarantee is real but platform-scoped and named
  by its substrate**: **BROWSER-OP** (OPFS sync access handles, `flush()`, Web
  Locks), **ANDROID-OP** (app-private `filesDir`/`noBackupFilesDir`, `NioFs`),
  **IOS-OP** (app container, `DarwinFs`), **NATIVE-OP** (the CLI's POSIX
  equivalent). Never quote one edition's PLATFORM-OP strength for another.

- **OPERATOR** — an assumption **only the operator can discharge**: physical
  source provenance and uniformity, out-of-band pad delivery, not clearing
  site data / not restoring an old backup, keeping the two couriered copies
  disciplined. The tool states these; it cannot enforce them.

- **NOT CLAIMED** — the edition does not assert this, and nothing here should
  be read as asserting it. Stated as absent, never faked or borrowed.

- **NOT OFFERED** — the edition has no mechanism for it at all, because its
  substrate cannot reach one. Distinct from NOT CLAIMED: there is nothing to
  turn on.

- **UNVERIFIED** — the mechanism is present and is believed to hold, but the
  specific evidence that would make it a claim **has not been produced in this
  repository**. An UNVERIFIED cell is not a promise and not a denial; it names
  the missing test. This is the honest classification for anything a shipped
  edition does that no gate yet measures.

---

## Cross-edition claims matrix

Legend: **✓ PROTOCOL** identical everywhere · **BROWSER-OP / ANDROID-OP /
IOS-OP / NATIVE-OP** the platform's operational form · **OPERATOR** the
operator's to discharge · **NOT CLAIMED** / **NOT OFFERED** stated absent ·
**UNVERIFIED** mechanism present, evidence not produced here.

| # | Claim | Class | Browser | Android | iOS | CLI / Native |
| - | --- | --- | --- | --- | --- | --- |
| 1 | Store Format v2 files, canonical JSON bytes, POLYVAL, `wc-one-time-v1`, four-slice partition, fixed-record frame, strict envelope grammar | PROTOCOL | ✓ `src/core` reused byte-for-byte; the §11 vectors and the adversarial corpus pass in the browser build (`INTEROPERABILITY.md`) | ✓ independent Kotlin implementation held to the same frozen vectors (`android/vectors/wc-one-time-v1.json`, `envelope-encode.json`, `envelope-refusals.json`, `head-key-order.json`) | ✓ independent Swift implementation held to the same frozen vectors (`ios/vectors/`), 472 Swift tests incl. ASan/TSan | ✓ `src/core` reused byte-for-byte; the reference implementation of the frozen wire |
| 2 | A store written on one edition is byte-identical and openable on another — "byte-identical" **as `INTEROPERABILITY.md` §2 defines it**: the same bytes *but for* the random `pairId`, the operator's source declarations, and each side's own journal timestamps | PROTOCOL | ✓ **browser ⇄ CLI, both directions, against the real binary.** `tests/browser-interop.test.ts` writes a browser store and has `bin/truepad2.mjs` open it, and opens a CLI-written store in the browser engine. The unqualified byte-equality proof is at the **envelope** level (a browser envelope equals the CLI's, tag included); the store-level claim carries the §2 carve-out above. Scope: `browser-none` stores | ✓ **against the released v2.0.0 bytes, by full transcript.** `EngineTraceTest` replays the released `gen → export → import → burn → open → forge → replay` sequence from `android/vectors/engine-trace.json` — generated by the released TypeScript at tag `v2.0.0` (`240d7f0`, hash-pinned; the generator refuses if the tag moves) and inside the `--check` diff — comparing **real** artifacts unmodified: 811-byte Store Format v2 `head.json` at genesis, after each burn, after the forged open and after the opens; both 768-byte `secret.bin` slices; `journal.log`; the 5 KB courier container; and every emitted envelope. The one transform, `androidised()`, rewrites only `pair.json`'s witness-class *name* — product-local bookkeeping that is not Store Format v2 and never travels in the courier bundle. **UNVERIFIED**: no *live* Android ⇄ Browser/CLI store round trip runs anywhere; the equivalence is fixture-based | **UNVERIFIED** — and **weaker than Android**, which is why it is not promoted alongside it. iOS has **no `engine-trace` equivalent** (`grep -rn engine-trace ios/` returns nothing). Its container evidence proves the **bundle envelope format only**: the shared `android/vectors/courier-container.json` fixture holds **three stub files** — `head.json` is the literal 19 bytes `{"formatVersion":2}`, `secret.bin` is 5 bytes, `journal.log` is `{}` — so `CourierTests` pins JSON shape, key order and base64 spelling, not store bytes, and it never imports what it unpacks. The six-file assertion is a **separate iOS→iOS test over `MemoryFs`**, not cross-edition. No iOS ⇄ Browser/CLI store round trip exists in any suite | ✓ the other half of the browser ⇄ CLI proof, under the same §2 carve-out, and the generator of the fixtures the phones are held to |
| 3 | Authenticated by default; no downgrade, no `--legacy` / `--no-auth` / `--force`, no v1 path | PROTOCOL | ✓ the browser engine has no such request at all; a v1 store is refused `v1-store` | ✓ no downgrade request exists in the app; `v1-store` refusal shared across editions | ✓ no downgrade request exists in the app; `v1-store` refusal shared across editions | ✓ `truepad2` has no downgrade flag; v1 lives only in the separate teaching CLI |
| 4 | Commit-before-emit; **loss is acceptable, reuse is not** | PROTOCOL (order) + PLATFORM-OP (durability) | BROWSER-OP: the §12 order preserved in the worker over OPFS `flush()` | ANDROID-OP: the §12 order preserved over `NioFs` on app-private storage | IOS-OP: the §12 order preserved over `DarwinFs` in the app container | NATIVE-OP: the §12 order over POSIX; durability claimed only where §10 says |
| 5 | Exactly one mutator per pair at a time | PLATFORM-OP | BROWSER-OP: Web Locks (`navigator.locks`), not a UI `isBusy` flag | ANDROID-OP: a process-scoped mutator lock in `PadViewModel`, not a UI enabled/disabled flag. **Single-process only** — it does not arbitrate a second app instance | IOS-OP: single-process serialisation in the app container. **Single-process only** | NATIVE-OP: OS file locking, which is the strongest of the four |
| 6 | Three-counter rollback witness; a regressed store refuses `witness-regressed` before consuming anything | PROTOCOL (the record + refusal) + PLATFORM-OP (where it lives) | BROWSER-OP: `browser-none` or `browser-local-witness` (a crash-safe append-only journal in a second, separately-cleared OPFS store, keyed by pair.json; an established witness fails closed, never fresh), §4 | ANDROID-OP: an append-only witness log under `noBackupFilesDir/truepad/witness/<pairId>.log` — a **different failure domain from the store**, and excluded from Android backup/restore, so a restored store meets a witness that still remembers. Refuses `witness-regressed` / `witness-inconsistent` | IOS-OP: `ios-local-witness`, or `ios-none` when no witness is established. The shipping composition root puts the witness in the **Keychain** (`KeychainWitnessFs` over `SystemKeychainBackend`, `kSecUseDataProtectionKeychain`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) — a different failure domain from the app container, and **device-local, never synced**. **This is not a pad in the Keychain and cannot become one:** the type's path grammar admits only `witness/<32-hex>.log`, and `writeFileAtomic`, `readRange`, `writeRange` and `list` all throw `unsupportedOperation`, so the surface that would be needed to store pad material structurally does not exist | NATIVE-OP: `witness-inconsistent` / `witness-locked` / `witness-unreachable` / `witness-path-unsafe`; the only edition that can point at an **independent host** |
| 7 | Irreversible `destroyed.json` boundary; restartable, idempotent destroy that refuses the pair everywhere after | PROTOCOL + PLATFORM-OP | BROWSER-OP: tombstone in OPFS; every verb gates on it before any secret read | ANDROID-OP: tombstone in app-private storage; every verb gates on it | IOS-OP: tombstone in the app container, probed with `lstat` so a **symlinked tombstone cannot read as absent** and revive a destroyed pair | NATIVE-OP: tombstone on the filesystem; every verb gates on it |
| 8 | Retirement is logical — advancing durable counters retires material. **`secret.bin` is written when the store is created and never rewritten thereafter**, which is N13's actual scope: *after gen*, no v2 operation writes it except `destroy`'s terminal teardown, and `burn` / `open` / `retire` never rewrite it. **Creating a store is not a rewrite:** acquiring a pair by **import** materialises the bundle's six files — both directions' `secret.bin` included — so a reviewer greping for durable writes correctly finds gen *and* the import staging and commit. What N13 forbids is a *second* write to a store that already has one, and the import path is guarded by a pair-exists refusal rather than by overwriting | PROTOCOL | ✓ | ✓ | ✓ | ✓ |
| 9 | Uniformity is conditional and stated verbatim: *"Uniform if at least one declared source was uniform and independent of the others."* | PROTOCOL (combiner) + OPERATOR (source) | ✓ verdict shown verbatim at gen; the combiner is unconditional given the conditions, the source is graded separately | ✓ the same verdict text, shown verbatim | ✓ the same verdict text, shown verbatim | ✓ the same verdict text, shown verbatim |
| 10 | No pad-derived value in any **store** metadata — no hash, checksum or fingerprint in `head.json` or `manifest.json` (N14). **One dependency is stated rather than denied:** where **Sealed Pad Transfer** is used, the durable per-pair `handoff.json` marker stores `packageIdentity` and `confirmHash`, and the pad influences them — `padHash` reaches the nonce, the nonce reaches the AAD, and the AAD reaches the confirmation `info` (`SEALED-PAD-TRANSFER.md` §17). That is safe because HKDF-Expand under a secret `PRK` reveals nothing about its `info`, and it is inherent to binding the confirmation to the actual package — but it is a **computational** argument, not an information-theoretic one, and no pad byte is key material or contributes entropy to any delivery key | PROTOCOL | ✓ for the N14 store scope; the SPT marker exception above applies wherever sealed transfer is used | ✓ same scope, same stated exception | ✓ same scope, same stated exception | ✓ same scope, same stated exception |
| 11 | Secrets never leave the engine boundary; the UI receives only wire-public envelopes, non-secret meters, and plaintext on a successful open | PLATFORM-OP | BROWSER-OP: engine + store live in a dedicated Web Worker + OPFS; no secret in `localStorage`/`sessionStorage`/URL/history/console/logs | ANDROID-OP: secrets stay inside the engine's process memory; **never in the Keychain-equivalent, never in `SharedPreferences`, never in a log**. The clipboard, when the operator uses it, is a **stated egress** the app cannot close | IOS-OP: the same boundary; **no pad material in the Keychain**, by rule. The system clipboard (and Universal Clipboard) is a **stated egress** | NATIVE-OP: process memory and the filesystem the operator chose |
| 12 | No backend, accounts, analytics, telemetry, cloud, or auto-sync; zero network requests during cryptographic operation | PLATFORM-OP | BROWSER-OP: installable PWA with a local shell; third-party assets vendored, strict CSP | ANDROID-OP: **`INTERNET` and `ACCESS_NETWORK_STATE` are removed from the merged manifest** (`tools:node="remove"`), the datatransport uploader's entry points with them; `allowBackup="false"`. CAMERA is the only capability-granting permission, for the receive-code QR. Enforced by `ManifestHardeningTest` | IOS-OP: no networking symbol in shipping source — `URLSession`, `NWConnection`, `CloudKit`, `AdSupport` and six more are gate-banned (`tests/ios-privacy-manifest.test.ts`); the privacy manifest declares no tracking and no collected data | NATIVE-OP: no network code path in `truepad2` |
| 13 | Power-loss durability of a mid-write | PLATFORM-OP where claimed; otherwise NOT CLAIMED | **NOT CLAIMED** — OPFS documents no power-loss semantics | **NOT CLAIMED** — Android's storage stack documents no power-loss semantics TruePad can rely on, and none has been tested | **NOT CLAIMED** — same standing; not tested | claimed **only on Linux ext4** (`FORMAT-V2.md` §10), and nowhere else |
| 14 | An **independent external** rollback witness (a separate host failure domain) | NOT OFFERED except on the CLI | **NOT OFFERED** — the browser cannot reach an independent host domain; only the browser-local classes of §4, stated verbatim | **NOT OFFERED** — the app has no network and no independent host; its witness is device-local, in a different *directory* failure domain, not a different *host* | **NOT OFFERED** — device-local only | ✓ the one edition that can be pointed at an independent host |
| 15 | Physical erasure of pad material on destroy | NOT CLAIMED on every edition | **NOT CLAIMED** — *"Software can forget its reference to pad material; it cannot prove that flash forgot the bytes."* Zero-overwrite is best-effort hygiene | **NOT CLAIMED** — identical reasoning; flash translation layers and wear levelling are outside the app | **NOT CLAIMED** — identical reasoning | **NOT CLAIMED** — identical reasoning, on every filesystem |
| 16 | Physical source provenance / one-file-one-source **by filesystem identity** | OPERATOR / platform caveat | declared, not verified; the browser File API exposes no inode, so alias detection is limited to spotting the *same `File` object* re-selected in one session — an object-reference check, never a comparison of source bytes (§6, §9). Source **content never conditions acceptance** | **OPERATOR** — the Storage Access Framework hands back a per-URI grant, not an inode; two URIs can name one file. Declared, not verified. Source **content never conditions acceptance** | **OPERATOR** — the document picker likewise exposes no stable filesystem identity. Declared, not verified. Source **content never conditions acceptance** | the only edition with real filesystem identity available (`src/cli/v2/ceremony.ts`), and the only one that should ever be quoted for it |
| 17 | Store survives a platform-level data wipe (clear site data, app uninstall, profile restore) | OPERATOR | **not protected** — clearing site data destroys or regresses the OPFS store; stated operator responsibilities (§2) | **not protected** — uninstall, or "Clear storage", removes both the store and its witness. `allowBackup="false"` is deliberate: a restored store is a **reuse risk**, so it is refused rather than restored | **not protected** — deleting the app removes the container. Pad material is deliberately excluded from backup | **not protected** — the operator owns the filesystem, and the pad file with it |

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
adversary who fully controls all *but* that one learns nothing.

Two precisions on that. First, **secrecy is a separate requirement from
uniformity**: material an adversary can obtain **may still be XORed in** — the
combiner has no content-dependent rejection and is no weaker for it — it simply
cannot be the source that *carries* the guarantee. At least one combined source
must also be secret from the adversary. Second, the permission holds only under
**independence**, and independence must be **joint, not pairwise**: `S3 = S1 ⊕
S2` is independent of each of `S1` and `S2` separately yet cancels the XOR to
zero. Material an adversary supplied, chose, or could have influenced is
therefore never a safe extra input — a source chosen against yours can cancel
it. TruePad cannot determine whether any of that is true.

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

and it then says, in the same panel, what that verdict is **not**:

> *"The verdict above is about uniformity only. An information-theoretic
> secrecy claim would also require that the source material you supplied was,
> and stays, secret from the adversary; that it was independent of the messages
> this pad will protect, in either direction; that no other pad is ever derived
> from it; and that this pad material is used exactly once. TruePad's counters
> enforce that last condition within TruePad — a copy of the pad file made
> outside it is beyond them. TruePad established none of the rest; that is what
> you declared."*

**Uniformity is not secrecy.** The frozen verdict speaks to the first hypothesis
only; the sentence above carries the rest of the premise. The two must never be
fused: propagating secrecy or key-message independence *into* the verdict would
make it claim something an XOR does not establish, and dropping them from the
ceremony would let uniformity read as secrecy. Both are the same error in
opposite directions.

It is never rendered as "perfect secrecy achieved", "true OTP verified", or
"information-theoretic security confirmed".

### A checkbox is not a measurement

The external path requires an explicit **operator declaration** before the pad
can be created:

> *"I understand that TruePad cannot verify physical randomness. For an
> information-theoretic one-time-pad secrecy claim about this pad's material, at
> least one selected source must actually be uniformly random, secret from the
> adversary, and never previously used. That source must also be independent of
> all the other selected sources taken together, and of the messages this pad
> will protect. It must never be used to make another pad."*

This is an **OPERATOR declaration and never a verification result**. Ticking it
changes nothing about the material, and nothing about it is written to the
store: **no `trueRandom`, no `informationTheoretic`, no `verifiedRandom`,
`itCapable`, `perfectSecrecy`, `shannonSecure` or `certifiedEntropy` flag exists
in Store Format v2, and none may be added** — software cannot establish those
facts. The only persisted record is the existing `head.json →
sourceDeclarations[]`: each source's name, the operator's own origin note, and
its length. Nothing pad-derived (N14).

TruePad turns these facts into a **derived** *deployment assessment* —
`CONDITIONALLY ELIGIBLE`, `NOT ELIGIBLE`, or `INSUFFICIENT EVIDENCE` — shown by
`truepad2 status` and on the Browser Edition's Pad details. One shared evaluator
computes it from provenance every time and never stores it. A software CSPRNG
source, a sealed computational delivery, ordinary browser storage as the live
authority, or a plain `gen` store (which is *not* the physical ceremony) is NOT
ELIGIBLE; a ceremony store whose private handoff has not yet been accepted is
INSUFFICIENT EVIDENCE; and only a native ceremony pad with an *accepted* private
handoff, attested by the installation's **operator-pinned** platform authority (a
pair may not choose its own trust root), is CONDITIONALLY ELIGIBLE — with the
physical premises still unproven and shown beside the label. See
[Shannon deployment](SHANNON-DEPLOYMENT.md) and
[Maximum assurance](MAXIMUM-ASSURANCE.md).

### Content confidentiality, length privacy, and traffic analysis are three claims

These are kept apart on purpose:

- **Content confidentiality** is the OTP theorem under its premises: given a
  fresh, uniform, secret, one-time pad, the ciphertext reveals nothing about the
  plaintext *content*. This holds for a **variable**-length record too — a
  variable record does not weaken content secrecy; it simply lets the ciphertext
  length equal the plaintext length.
- **Length privacy** is a separate, metadata-hardening property. A **fixed**
  record size (`recordPolicy.record = { kind: "fixed", bytes: F }`, §16) frames
  every message to exactly F ciphertext bytes with the plaintext length carried
  *inside* the OTP-encrypted, authenticated frame, so an observer sees a fixed
  F-byte record and never the exact plaintext length (for plaintext up to F − 4).
  Each record spends F fresh pad bytes and one auth record however short the
  message. Fixed records are **required** for the CLI physical/Shannon ceremony
  and recommended (e.g. F = 4096) elsewhere; a fixed record size is **not** what
  makes the OTP theorem apply.
- **Traffic analysis** is not addressed. Fixed records do **not** hide that a
  message was sent, when, its direction, the **number of records**, the total
  size across several records, communication frequency, endpoint identity, or
  any network metadata. TruePad is not "metadata private", "traffic-analysis
  resistant", "untraceable", or "anonymous". A stronger construction (fixed
  records + fixed cadence + dummy records) would leak less, but it would consume
  pad continuously and is a separate protocol; it is **not implemented**.

### Delivery is the other half

A source claim is not an end-to-end claim. The pad **file** is the secret, and
for an end-to-end information-theoretic secrecy claim it must also be
delivered through a secret method whose confidentiality does not itself depend
on computational encryption assumptions — physical handoff on removable media
is the clearest ceremony. Email, Dropbox, Google Drive, OneDrive, ordinary
cloud storage and encrypted messengers **do not preserve that claim**; they may
be computationally secure ways to move a file, which is a *different*
guarantee, not a weaker form of the same one.

#### Sealed Pad Transfer — SHIPPED (Browser, Android and iOS Editions)

`docs/SEALED-PAD-TRANSFER.md` specifies **Sealed Pad Transfer v1**: online pad
delivery under a hybrid post-quantum/traditional KEM, with two human
verification ceremonies. It is **offered in the Browser, Android and iOS
Editions** as one of two ways to give the other person their copy of a pad — *Send securely online*
beside *Save pad file*, neither presented as better. Where it stands, precisely:

| Layer | Status |
| --- | --- |
| Cryptographic / transport core — suite `0x0001`, TPR2 and TPS2 codecs, key schedule, reference vectors | **implemented** (`src/spt/**`) |
| Storage / provenance foundation — pad origin, the one-handoff record, its crash behaviour | **implemented** (`src/browser/engine/**`) |
| The product transfer flow — receive requests, both word ceremonies, sealing, opening, import | **implemented** (Browser `src/browser/ui/**`; Android `:truepad-spt` + `SptScreens.kt`; iOS `TruePadSPT` + `TruePadUI`) |
| QR transport for the receive code | **implemented in 3.0.0** (Browser Edition, `src/browser/ui/qr/**`, and both mobile editions); it was **deferred at the 2.0.0 release** (see the sealed-transfer release audit). An optional convenience carrying the same public TPR2; copy/paste remains the normative channel and the twelve words still authenticate |
| Any CLI sealed-transfer command | **not implemented** — `truepad-pad` and `truepad2` have no such verb |

**The CLI offers none of it.** The distinction that matters is not whether the
feature exists but what its delivery claims, and it is recorded here so it
cannot be blurred:

| | Physical exchange | Sealed Pad Transfer |
| --- | --- | --- |
| Delivery claim | can support the conditional **information-theoretic** path | **computational** — X25519 + ML-KEM-768, SHA3-256/512, SHAKE-256, HKDF-SHA-256, AES-256-GCM |
| Recipient authentication | you are looking at them | a **12-word, 132-bit** fingerprint compared over an authenticated side channel — an OPERATOR declaration, never a verification result |
| Against a compromised endpoint | the pad is exposed anyway | **no protection**, and specifically: an active script with transfer-worker authority is classified as endpoint compromise, not as an attacker the ceremonies stop |
| Harvest-now-decrypt-later | no exposure from delivery | an archived package is attackable later — by a future break of the delivery cryptography, or by a restored/cloned copy of the recipient key state. Either yields the pad, and the pad yields every archived message it protected |
| Status | **shipped** | **shipped** (Browser, Android and iOS Editions; the CLI has no such command) |

The point of the row is the middle one. Sealing an information-theoretic cipher's
key material inside a computational envelope produces a **computational**
deployment: the OTP theorem and the Wegman–Carter bound are unchanged, but the
end-to-end claim is only ever as strong as how the pad travelled. That is why
physical handoff stays first-class rather than becoming the inconvenient option,
and why the sentence *"the messages use OTP"* will never be allowed to stand in
for *"the pad was delivered safely"*.

### The source claim and the platform claim are independent

Choosing the external ceremony does **not** give the Browser Edition any of the
guarantees in rows 13–15 and 17. It does not add power-loss durability, an
independent external rollback witness, physical erasure on destroy, or survival
across "clear site data". Equally, the device generator does not take any of
those away. **A true physical source strengthens neither the authentication
construction nor the operational reuse-prevention machinery**, and neither of
those proves anything about the source's physics. Three separate guarantees:

- **A — OTP secrecy**: XOR under material that is genuinely uniform, secret
  from the adversary, jointly independent of the other combined sources,
  **independent of the messages it protects**, and used once. Key-message
  independence is a hypothesis of the theorem in its own right: pad material
  derived from — or chosen after seeing — the traffic it encrypts breaks
  perfect secrecy however uniform it is. Source is OPERATOR; combiner is
  PROTOCOL.
- **B — Authentication**: `wc-one-time-v1` Wegman–Carter, and its existing
  bounded forgery claim. PROTOCOL.
- **C — Operational reuse prevention**: counters, journals, attempt
  reservation, the rollback witness, locks, retirement, the destruction
  tombstone. PROTOCOL + PLATFORM-OP.

B and C do not prove A's physical-randomness premise, and A's premise does not
strengthen B or C.

---

## Size presets are a cross-edition product rule

**Small, Medium and Large must have identical capacities on Browser, Android and
iOS.** They are convenience defaults — a preset writes the two engine budgets and
nothing else — but they are NAMES the operator reads, and a name that means two
different things in two editions is a product defect even when neither pad is
unsafe.

| Preset | Encryption bytes (E) | Auth records / messages (N) | Source material required, `L = 2 · (E + 32 · N)` |
|---|---:|---:|---:|
| Small  | 16 384    | 64    | 36 864 |
| Medium | 262 144   | 512   | 557 056 |
| Large  | 4 194 304 | 4 096 | 8 650 752 |

`N` is the number of one-time authentication records and therefore the HARD
ceiling on messages in one direction — "up to N messages each way" is a statement
of the cap, not an estimate. `L` is DERIVED from the four-slice rule and is never
tabulated in code.

This was not always true. The Android Edition shipped Small 16 KB/128, Medium
64 KB/512 and Large 256 KB/2048, so two people who both chose "Medium" received
pads of different capacities depending on which app they held. Android now uses
the values above, and `PadSizeParityTest` reads the Browser Edition's own source
so drift in EITHER direction fails the build.

Nothing else about a preset is special: the four-slice partition, the
required-source rule, serialization, fixed-record behaviour and custom sizes are
untouched by which preset is chosen, and pads that already exist keep the
capacities they were created with.

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

Every column is populated, and each one stays honest by the same rules:

- A **PROTOCOL** row stays ✓ **only if** that edition either reuses `src/core`
  byte-for-byte (Browser, CLI) **or** is an independent implementation that
  passes the same frozen vectors in its own build (Android, iOS). Anything less
  is not the frozen protocol. The two mechanisms are not interchangeable and
  the cell must say which one it is.
- A **PLATFORM-OP** row must name that edition's own substrate and its own
  strength. It may not inherit the Browser Edition's BROWSER-OP wording, nor
  quote the CLI's native strength.
- **NOT OFFERED** is filled in only when the substrate has no mechanism at all;
  **NOT CLAIMED** when a mechanism exists but the guarantee is not asserted.
  Neither may be quietly upgraded by relabelling a weaker mechanism.
- **UNVERIFIED** must name the missing evidence, so the cell reads as a piece
  of outstanding work rather than as a hedge. When that evidence is produced,
  the cell changes; until then it does not drift upward.

A regression guard enforces the shape of this table:
`tests/cross-edition-claims.test.ts`.
