# Changelog

## Unreleased — planned v2.0.0

**v2.0.0 will be TruePad's first formally tagged release.** The number reflects
the current Format v2 / Browser generation of the system, not a sequence of
earlier releases: there was never a formal TruePad 1.0. `truepad-pad` and its
unauthenticated Format v1 envelope predate this generation and are kept as
teaching material, but they were never released under a version tag.

This entry describes the current audited release candidate. It will receive a
version and a date when formally tagged.

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

### Known limitations at this candidate

Recorded in full in the [release audit](docs/SEALED-PAD-TRANSFER-RELEASE-AUDIT.md),
which returns a verdict of **B — release ready with documented non-blocking
limitations**: browser profile restore can rewind the local state domain, the
OPFS write fallback is not truly atomic, the word ceremonies depend on humans
performing them, an archived sealed file carries harvest-now-decrypt-later
exposure, and no software can prove physical erasure.
