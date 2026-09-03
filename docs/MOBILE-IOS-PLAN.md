# TruePad 3.0 — Native iOS implementation plan

There is **no** native iOS implementation yet. This is the plan, not code. It
specifies the architecture, the platform choices, the honest deployment
classification iOS can support, and the invariants it MUST inherit.

## 1. Language & UI

- **Swift + SwiftUI** (target current iOS; a UIKit fallback only where SwiftUI
  cannot meet an accessibility or camera requirement).
- A thin, testable **engine module** in pure Swift (no UI imports) that is the
  Swift twin of the shared core: envelope, frame, partition, one-time WC / POLYVAL,
  and the storage/verbs state machine — implemented to the **same canonical bytes**
  as `src/core/*` and validated against the shared vector corpus
  ([INTEROP-VECTORS.md](INTEROP-VECTORS.md)). Keep crypto out of the SwiftUI layer.

## 2. Secure local storage & file protection

- Store the pad/state under **`NSFileProtectionComplete`** (or
  `CompleteUnlessOpen` only where a background write is unavoidable), so the store
  is encrypted at rest by the device's Data Protection when locked.
- Exclude the store from iCloud/iTunes backup where a backup would be a rollback
  vector (`URLResourceValues.isExcludedFromBackup`), mirroring Android's
  `allowBackup=false` / no-backup witness domain.
- Small non-pad secrets (if any) MAY use the Keychain with an appropriate
  accessibility class; **pad material is not a Keychain item** — it is bulk data in
  a protected file, written atomically.

## 3. Crash-safe local state (the load-bearing part)

- Every consumption MUST be **durable before output**: write the new
  consumption state with an atomic replace (write temp → `fsync`/`F_FULLFSYNC` →
  atomic rename), then release the ciphertext. iOS `Data.write(options:.atomic)` is
  a rename; add an explicit `F_FULLFSYNC` for durability on the store file and its
  directory. LOSS IS ACCEPTABLE, REUSE IS NOT.
- Handle **background/foreground/termination**: a burn in progress MUST either
  complete durably or be safely abandoned; use a background task assertion to
  finish the durable write, and on relaunch resume to a *weaker-or-equal* state,
  never a fabricated stronger one.

## 4. Biometric gating

- Gate opening a pair (and destructive actions) behind **LocalAuthentication**
  (Face ID / Touch ID) where appropriate. This is an access-control convenience; it
  is **not** a cryptographic claim and MUST NOT be presented as one.

## 5. QR camera path

- Use **AVFoundation** (`AVCaptureMetadataOutput`, `.qr`) for the receive-code
  scan. As on every edition, a scanned `TPR2` enters the **same** flow as paste —
  **no auto-confirm**; the human still compares the words. Handle permission denial
  with a clear message and a working paste fallback.
- Validate on real cameras per [QR-VALIDATION.md](QR-VALIDATION.md) (outstanding).

## 6. Import / export

- Import courier files and export via **`UIDocumentPicker`** and the system share
  sheet (Files app). Never place secret material in a URL, pasteboard-by-default, or
  a screenshot-visible surface; consider blocking screenshots on sensitive screens.

## 7. Accessibility

- Full **VoiceOver** support: labelled controls, correct heading order, 44pt
  targets, Dynamic Type. A human VoiceOver pass is a release gate (like Android's
  TalkBack), not something automated tests can sign off.

## 8. Interoperability

- The iOS engine MUST interoperate with Browser/CLI/Android at the **byte** level:
  identical message envelope, canonical authenticated bytes, fixed-record framing,
  and courier container. Prove it against the shared vector corpus in **both**
  directions where feasible. The **same deployment-evaluator semantics** apply; iOS
  MUST NOT define its own evaluator or a stronger verdict.

## 9. Deployment class on iOS — the honest limitation

> **Do not assume the Secure Enclave provides an equivalent of the desktop TPM
> `platform-monotonic` authority.** The Secure Enclave gives hardware-backed key
> storage and biometric-gated keys; it does **not** expose to apps a
> **rollback-resistant hardware monotonic counter** of the kind the 3.0 root of
> trust requires (a value that only counts up, cannot be restored from a backup,
> and anchors a local witness). Apple's `DeviceCheck`/`App Attest` are
> server-mediated attestations, not a local monotonic authority usable as an
> offline rollback anchor.

Therefore, on current iOS, the **maximum-assurance profile is not reachable**: an
iOS pad MUST be classified at most INSUFFICIENT / NOT ELIGIBLE for maximum
assurance, with the honest reason (no independent live monotonic rollback
authority; local storage is one rollback domain). This is the same posture as the
Browser and current Android. If a future iOS capability genuinely provides the
required monotonic + operator-pinned properties, revisit — but only after
verifying the property, never by simulating gold in the UI.

An iOS app is still a valuable authenticated-OTP client with strong at-rest
protection and biometric access control; it simply is not the maximum-assurance
surface.

## 10. Inherited invariants

Everything in [MOBILE-3.0-HANDOFF.md](MOBILE-3.0-HANDOFF.md) §8 applies verbatim:
loss-acceptable/reuse-not, persist-before-output, no offset wrap, direction
separation, attempt reservation before verify, no pad-derived fingerprint,
terminal-downgrade precedence, identical wire/envelope/fixed-record semantics, the
shared evaluator, and "refuse or downgrade — never silently weaken."

## 11. A note on "second implementation" credibility

A native Swift engine that independently reaches the same canonical bytes is
useful **interoperability** evidence and a good cross-check of the spec. It is
**not** an independent security review merely because it is written in another
language, and it MUST NOT be presented as one (see
[INDEPENDENT-REVIEW-BRIEF.md](INDEPENDENT-REVIEW-BRIEF.md)).
