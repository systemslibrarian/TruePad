# Reviewer — start here

You are a security engineer with two hours. This page tells you exactly where to
look, what TruePad claims, and what it deliberately does **not** claim.

**State:** `master` = **3.0.0-dev.0** (development). The latest *formal release*
is **TruePad 2.0.0**; 3.0 is not tagged, released, or published. The literal
OTP/Wegman–Carter combiner and the message/SPT/QR wire are byte-identical to
2.0.0; 3.0 adds the state/authority/ceremony layers reviewed below.

## The claim, in one paragraph

TruePad is an educational/research implementation of **authenticated one-time-pad
key management**. It enforces every one-time-use requirement software can — literal
XOR OTP confidentiality, one-time Wegman–Carter authentication, durable
burn-before-output consumption, attempt reservation, rollback witnesses, a
TPM-anchored monotonic authority, and an operator-pinned root of trust — while
**explicitly separating the physical premises software cannot prove**. Its
strongest verdict is *CONDITIONALLY ELIGIBLE*, always shown beside the premises it
has not proved. **TruePad does NOT guarantee perfect secrecy as a product claim.**

## Threat boundary (what the strongest claim resists, and does not)

Resists, under the maximum-assurance profile: pair-directory file editing;
provenance/withdrawal replacement or deletion; stale directory restore;
same-pair semantic rewriting; cross-pair and authority substitution; a foreign
external TPM authority; ordinary CLI operations; crashes and torn writes.

Does **not** resist, and does not claim to: a hostile OS/kernel, a malicious
administrator or root, a replaced TruePad binary, compromised TPM firmware, or
deliberate reprovisioning of the pinned platform trust anchor. And software never
proves physical randomness, source secrecy, source independence, absence of
hidden copies, private courier behaviour, or physical erasure.

## Suggested review order (about two hours)

1. **Claims / threat model** — `docs/TRUEPAD-3-SPEC.md` §1–§3, `docs/PRODUCT-CLAIMS.md`.
2. **OTP + WC core** — `src/core/cipher-otp.ts`, `partition2.ts`, `wc-one-time.ts`, `gf128.ts`, `envelope2.ts`. *Is the combiner literal XOR? Is WC material one-time and disjoint from encryption bytes? Is the authenticated byte-string canonical and unambiguous?*
3. **State / burn semantics** — `src/cli/v2/store2.ts`, `truepad2.ts` (burn/open/retire). *Is consumption durable before output? Can a crash reuse a pad byte? Are attempts reserved before verify?*
4. **TPM / root of trust** — `src/cli/v2/platform-witness.ts`, `trust-store.ts`, `tpm.ts`. *Can a pair select its own authority? Is the pinned authority the only one read? Is a stale platform state caught?*
5. **Ceremony / provenance** — `src/cli/v2/ceremony.ts`, `provenance.ts`, `withdrawal.ts`. *Can editing JSON turn gen into a ceremony? Can a withdrawal be reversed?*
6. **Deployment evaluator** — `src/claims/shannon-deployment.ts`. *Is there exactly one place a verdict is produced? Does anything else decide?*
7. **Sealed Pad Transfer — separately** — `docs/SEALED-PAD-TRANSFER.md`, `src/spt/*`. This is *computational* delivery; review it as its own protocol.

The compact per-file map with invariants and tests is
[`docs/SECURITY-REVIEW-MAP.md`](SECURITY-REVIEW-MAP.md).

## Five documents, in priority order

1. [`docs/TRUEPAD-3-SPEC.md`](TRUEPAD-3-SPEC.md) — the concise normative spec (read front to back).
2. [`docs/SECURITY-REVIEW-MAP.md`](SECURITY-REVIEW-MAP.md) — the trusted surface.
3. [`docs/MAXIMUM-ASSURANCE.md`](MAXIMUM-ASSURANCE.md) — the strongest path and its root of trust.
4. [`docs/SHANNON-DEPLOYMENT.md`](SHANNON-DEPLOYMENT.md) — why the *combiner* is not the *deployment*.
5. [`docs/SEALED-PAD-TRANSFER.md`](SEALED-PAD-TRANSFER.md) — the computational delivery protocol (separate review).

The [`docs/TRUEPAD-3-WHITEPAPER.md`](TRUEPAD-3-WHITEPAPER.md) gives the argument in
paper form; the [`docs/INDEPENDENT-REVIEW-BRIEF.md`](INDEPENDENT-REVIEW-BRIEF.md)
lists the exact questions we want challenged.

## One-command verification

```
npm ci
npm run audit:security      # typecheck + unit + falsification/claims/no-verdict/no-pad-derived guards + build
npm run test:e2e            # Playwright browser suite
npm run test:tpm-interop    # OPTIONAL, needs Linux + swtpm + tpm2-tools (emulator interoperability, NOT hardware)
```

The falsification/mutation approach and the guard tests are described in the
review brief. Reproduced counts at this SHA: **1585 unit tests / 72 files** and
**36 Playwright tests / 6 files**. The falsification matrix is described in the
review brief; its count is not restated here, because a number quoted without
being re-run is exactly the kind of stale claim this page exists to avoid.

The mobile editions carry their own suites: **Android 184 JVM + 19 app unit
tests**, and **iOS 325 tests** (`swift test --package-path ios/TruePadKit`), plus
the iOS supply-chain and isolation gates in `ios/scripts/` and `ios/vendor/`. The
iOS suite also runs under AddressSanitizer and ThreadSanitizer on every push, and
CI checks the generated SBOM against the tree and inspects what a device Release
build actually contains.

## Known limitations and what is still open

- **swtpm is not a physical TPM.** All TPM evidence here is emulator
  interoperability. Physical-TPM hardware validation is **outstanding**
  (`docs/RELEASE-CHECKLIST-3.0.md`, `docs/PHYSICAL-TPM-VALIDATION.md`).
- **Mobile is partly built, and the two platforms are at different stages.** The
  **Android 3.0-dev app exists on master** — engine, storage, SPT, QR and UI —
  with emulator instrumentation and single-device physical validation done. The
  **iOS Edition now has the whole engine** (`ios/TruePadKit`: the OTP core, the
  durable store, the §12 verbs, the courier bundle, the Sealed Pad Transfer state
  machine and ceremony, the deployment evaluator, and a SwiftUI view layer) proven
  byte-identical to the frozen wire in all four cross-edition directions. There is
  now a **native app target** at `ios/TruePadApp` — a plain committed `.xcodeproj`
  with one target, one source file and an explicit Info.plist — which BUILDS for
  `generic/platform=iOS` in Debug and Release. It has now been **installed and
  launched on an iPhone 12 running iOS 18.6.2**, where the process is stable
  across repeated cold starts and creates its app-private store under
  `Library/Application Support/TruePad`, with `Documents` left empty.

  The on-device state pass now RUNS, through a committed XCUITest bundle at
  `ios/TruePadApp/TruePadAppUITests`. Described by what it actually drives: pad
  creation; a send whose consumption is still consumed after a force-quit; a
  malformed message refused with NO pad material consumed; a REFUSED destruction
  changing nothing; a receive request surviving a force-quit with its
  cancellation terminal across a relaunch; no camera prompt from ordinary
  navigation; the device-CSPRNG pad reading NOT ELIGIBLE; and the accessibility
  labels on the elements that carry decisions.

  **Three things it deliberately does not cover.** A COMPLETED destruction is not
  reachable from the interface at all: confirming one means typing the pairId,
  and TruePad never displays it — the operator is expected to know it from the
  pad book, a `head.json` or the tombstone. A full send-then-open round trip on
  one device is not driven either: the only route the interface offers for moving
  the envelope is the system edit menu, and Copy/Paste did not land reliably
  under XCUITest — the round trip is covered by the host suite, and what a
  handset uniquely adds (durable consumption on APFS) is covered by the
  force-quit test. And nothing here is a transfer between two parties: the
  Android↔iPhone ceremony remains outstanding, as do human VoiceOver and
  physical TPM.
  Neither platform is released; there is no App Store build and no 3.0 tag.
  **Physical mobile validation is outstanding on both** — the two-device
  Android↔iPhone ceremony, human TalkBack and human VoiceOver have not been
  performed. Secure Enclave is **not** assumed equivalent to a TPM monotonic
  authority (`docs/IOS-SECURITY.md`, `docs/ANDROID-SECURITY.md`,
  `docs/MOBILE-3.0-HANDOFF.md`).
- **Browser is never maximum-assurance** and a browser profile restore can rewind
  local state.
- Real-handheld QR-camera validation and human accessibility (TalkBack/VoiceOver)
  are **outstanding**.

## An explicit request

Internal AI adversarial audits and the falsification matrix are useful
*engineering* evidence — they are **not** an independent human security review.
TruePad 3.0 asks for exactly that before any formal 3.0.0 release. If you find a
real defect, please report it (see `SECURITY.md` for the disclosure route) — the
[`docs/INDEPENDENT-REVIEW-BRIEF.md`](INDEPENDENT-REVIEW-BRIEF.md) names the
findings that would block 3.0.
