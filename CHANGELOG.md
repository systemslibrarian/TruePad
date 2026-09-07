# Changelog

## v3.0.0 — 2026-09-07

**TruePad 3.0.0 is the project's second formally tagged release, and the first to
ship three editions: the Browser Edition, an Android Edition, and a native iOS
Edition.** It is not a new cipher. The Format v2 wire is unchanged and is still
held to the frozen v2.0.0 vectors; what changed is that pad handling became
something two people can actually do on two phones, and that the most serious
defect this project has found was fixed.

The governing rule is unchanged — **LOSS IS ACCEPTABLE. REUSE IS NOT.** So are the
claim boundaries: PQC protects pad delivery, OTP encrypts messages, Wegman–Carter
authenticates them. TruePad still does **NOT** guarantee perfect secrecy as a
product claim, and nothing in this release is offered as software proof of
physical secrecy, randomness, erasure, exclusivity, or hardware monotonicity.

### iOS Edition (new)

- Native Swift kernel and kit under `ios/TruePadKit`: `TruePadCore` (the OTP
  kernel, linking no cryptography library at all), `TruePadStorage` (Store Format
  v2, `F_FULLFSYNC` durability, the rollback witness) and `TruePadSPT` (Sealed Pad
  Transfer). Held to the frozen v2.0.0 wire vectors and the draft-10 Appendix-C
  X-Wing corpus.
- Cross-edition interop proven in **all four directions** (Browser↔iOS,
  Android↔iOS), including corpora sealed with each edition's real CSPRNG rather
  than only with injected test entropy.
- `apple/swift-crypto` 4.5.2 vendored at commit `da9d28d6` with a 65-line reviewed
  patch, enforced byte-for-byte by `ios/vendor/verify-vendor.sh`.
- Deterministic X-Wing encapsulation is **structurally** test-only: it is not a
  package product, and a shipping app cannot import it.
- No App Store build. There IS a native iOS application (`ios/TruePadApp`),
  installed and launched on a physical iPhone 12 running iOS 18.6.2, where the
  on-device automated suite passes.
- **The two-device physical ceremony is DONE**, and an earlier version of this
  entry still listed it as outstanding. Between a physical iPhone 12 and a
  physical Samsung SM-A176U: optical QR scanned by each phone's real camera from
  the other's screen in **both** directions; the twelve-word and eight-word
  comparisons matching across the gap; `.tps2` sealed-pad import in both
  directions; real messages encrypted on one handset and opened on the other in
  both directions; creator/importer role separation and directional meter
  separation observed on the durable stores; and replay refused on both devices
  with nothing consumed.
  Two honest qualifications. The word comparisons were read from the two screens
  by AUTOMATION, not spoken aloud by two people — that is not a human ceremony and
  is not offered as one. And the message round trips used host/test carriers (a
  screenshot decoded offline, and a share to a non-shipping catcher); only the SPT
  gates were optical.
- Still NOT performed, and non-blocking by project-owner decision: **human
  VoiceOver**, **human TalkBack**, and **physical TPM 2.0** (the swtpm evidence in
  CI is emulator interoperability only).

### Android Edition

- **Sealed Pad Transfer on the handset.** Create a receive code on one phone, seal
  a `.tps2` package against it on the other, import it back. The whole exchange is
  reachable from the app instead of from a terminal.
- **Pads / Inbox / About** bottom navigation, each tab parking its own back stack,
  so glancing at About in the middle of receiving a pad no longer destroys the
  ceremony in progress.
- **"Share this pad" and "Receive a pad"** as the two obvious front-door actions.
  The receive code is the thing the two people exchange, and its QR spelling
  carries the canonical public TPR2 payload exactly — nothing added, nothing
  truncated.
- **External random material** can be chosen at creation instead of the device
  CSPRNG, and the declared origin is recorded rather than assumed. The choice is
  never silently substituted back to the device generator.
- **One pad, one handoff.** Once a pad has been handed over the share affordance
  is withdrawn rather than left to be pressed a second time, and an honest
  re-save of the same physical copy is offered separately and labelled as such.
- The interface carries TruePad's own visual identity — one accent, one type
  scale, one set of surfaces — rather than the platform default, and the iOS
  Edition takes the same tokens so the two phones look like one product.

### Message packaging and transport

- **Fixed-length records.** A pad may be created with a fixed record size, so two
  messages of different lengths cost the same material and reveal the same length.
  This is a metadata-hardening policy, not a Shannon axiom, and the physical
  ceremony requires it.
- **Corrected fixed-record capacity accounting.** The remaining-sends meter
  counted authentication records alone. On a fixed-record pad every send also
  spends a whole record of encryption bytes, so the meter could promise more sends
  than the pad was able to pay for. All four engines — Browser, CLI, Android, iOS
  — now report `min(remaining records, floor(remaining bytes / F))` and name which
  of the two budgets is the binding one.
- **TP2 compact transport is the ordinary human-facing spelling of an envelope**:
  one `TP2:` line short enough to paste into anything. **Canonical JSON is
  retained as the technical spelling**, unchanged and still normative. Both are
  accepted everywhere they were before; neither replaces the other.

### Plaintext egress

One policy, on all three editions, decided by what the operator chose to open and
never by inspecting the decrypted bytes:

> **Decrypted message text remains display-only inside TruePad. Received file
> payloads may be saved as the explicit file-delivery operation.**

- A decrypted MESSAGE has no Copy, no Save and no Share. Its text is also not
  selectable, because a drag and a copy shortcut reached the very clipboard the
  button had just been removed from.
- A received FILE is still saved, because saving it *is* the delivery.
- The public transport spellings are untouched and remain copyable, shareable and
  renderable as QR: the TP2 envelope, the canonical JSON envelope, and the TPR2
  receive code. Those are ciphertext and public request material, not plaintext.
- The classification is produced in exactly one place, from the operator's own
  choice of "open message" or "open file", so a decrypted message cannot be
  relabelled a received file in order to obtain an export path.

### Security fixes

- **Cross-copy role/reuse (the most serious defect fixed this cycle).** Direction
  was decided locally rather than being a durable property of the pair, so an
  edition could settle which half it acted as independently of the other copy.
  Two copies of the SAME pair could therefore both operate on the same directional
  half — spending the same one-time material twice — while each local store's
  counters advanced monotonically and looked entirely healthy. Nothing in a single
  store could see it, which is why it survived so long.
  The repair makes the role derived, not chosen: a pad **generated here** is party
  A, an **imported** pad is party B, and an origin that cannot say produces a
  **refusal rather than a guess**. Every edition derives it the same way, and the
  send path refuses outright rather than defaulting.
  It was subsequently demonstrated on hardware: two physical handsets holding the
  same pair sent on opposite halves, each device's send meter moved only for its
  own half, and neither device's material was touched by the other's activity.
- **Android SPT:** `requirePadSealable` now tests `attemptsReserved` alongside the
  two cursors, matching the frozen authority. A pad that took a failed open at
  genesis is no longer sealable.
- **Android storage:** a path that exists but is not a regular file no longer
  reads as absence. `Absent` is the state that permits a second handoff, so this
  was a fail-open in the reuse direction.
- **Vendored swift-crypto:** added the entropy-length guard upstream's
  CVE-2026-28815 fix omitted on the encapsulation side.

### Supply chain

- All 29 GitHub Actions references pinned to immutable commit SHAs; Dependabot
  added for `github-actions`; the Gradle distribution is now checksum-verified.
  Full audit in `docs/SUPPLY-CHAIN.md`.

**3.0.0 also lands the maximum-assurance work** integrated from the QR,
Shannon-provenance, fixed-record and maximum-assurance lanes:

- **QR transport** for the Sealed Pad Transfer receive code.
- **Derived deployment assessment** (a single evaluator; no stored verdict) that
  distinguishes the OTP *combiner* from a particular *deployment*, and never
  launders a computational or unknown path into an information-theoretic claim.
- **Fixed-record privacy profile** — a metadata-hardening policy (not a Shannon
  axiom); the physical ceremony requires fixed records.
- **Maximum-assurance OTP architecture**: immutable, pair-bound `provenance.json`;
  a one-way `ceremony accept` and a terminal `ceremony withdraw`; live rollback
  and ceremony authorities; and an **operator-pinned platform root of trust**
  (`truepad2 authority pin`) so a pair cannot choose its own trust anchor. The
  strongest verdict, CONDITIONALLY ELIGIBLE, still states the physical premises
  software cannot prove, and physical-TPM hardware validation remains outstanding.

## v2.0.0 — 2026-09-01

**v2.0.0 is TruePad's first formally tagged release.** The number reflects
the current Format v2 / Browser generation of the system, not a sequence of
earlier releases: there was never a formal TruePad 1.0. `truepad-pad` and its
unauthenticated Format v1 envelope predate this generation and are kept as
teaching material, but they were never released under a version tag.

### The system as it now stands

- **Browser Edition** — a working two-party app that runs entirely on the
  device. Create a pad, share it once, then send and open messages and files.
  No backend, no account, no telemetry, nothing uploaded.
- **Store Format v2** — the authenticated path. OTP encryption with one-time
  Wegman–Carter authentication over canonical bytes, durable single-use state,
  and refusal rather than reuse when the two disagree.
- **Witness and rollback protections** — three-counter witness classes, with the
  browser's own boundary documented rather than papered over.
- **Sealed online pad delivery** — the pad can be delivered as a `.tps2` file
  through an ordinary channel, sealed under X-Wing draft-10 (ML-KEM-768 with
  X25519), HKDF-SHA-256 and AES-256-GCM, with two human word ceremonies binding
  the receive request and the resulting package.
- **The physical / online guarantee split, kept explicit** — a privately handed
  pad and a sealed online delivery do not carry the same claim, and no surface
  is allowed to blur them.
- **Claims discipline** — a product-claims ledger, a release audit that verified
  the shipped artefacts against it, and machine guards that fail the build when
  a document starts claiming more than the code earns.

### Licensing

- Project licensing changed from MIT to GNU AGPL v3 only (**AGPL-3.0-only**)
  for the current release line. Previously distributed revisions remain
  available under the licenses under which they were distributed. Third-party
  components keep their own licenses and notices.

### Known limitations at this release

Recorded in full in the [release audit](docs/SEALED-PAD-TRANSFER-RELEASE-AUDIT.md),
which returns a verdict of **B — release ready with documented non-blocking
limitations**: browser profile restore can rewind the local state domain, the
OPFS write fallback is not truly atomic, the word ceremonies depend on humans
performing them, an archived sealed file carries harvest-now-decrypt-later
exposure, and no software can prove physical erasure.
