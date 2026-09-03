# Changelog

## Unreleased — planned v3.0.0 (development)

**`master` carries TruePad 3.0 development; the latest FORMAL release remains
2.0.0.** This line is not released, not tagged, and not published to npm; the
public demo stays on the 2.0.0 release. It gathers the maximum-assurance work
integrated from the QR, Shannon-provenance, fixed-record, and maximum-assurance
lanes:

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
