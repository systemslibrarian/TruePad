# Reviewer — start here

You are a security engineer with two hours. This page tells you exactly where to
look, what TruePad claims, and what it deliberately does **not** claim.

**State:** `master` = **3.0.0**, the current *formal release*, tagged `v3.0.0`
on 2026-09-07. **TruePad 2.0.0** was the previous formal release and remains
tagged where it was. The literal OTP/Wegman–Carter combiner and the message/SPT/QR
wire are byte-identical to 2.0.0; 3.0 adds the state/authority/ceremony layers
reviewed below, plus the Android and iOS editions.

Releasing 3.0.0 did **not** create an independent review: none was performed, and
none was required — see `docs/RELEASE-CHECKLIST-3.0.md` §C. This page is still the
place to start if you want to do one.

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
review brief. Reproduced counts at this SHA: **1753 unit tests / 84 files**
(`npm test`) and **36 Playwright tests / 6 files** (`npm run test:e2e`). Re-run
them rather than citing these; they move whenever a test is added. The falsification matrix is described in the
review brief; its count is not restated here, because a number quoted without
being re-run is exactly the kind of stale claim this page exists to avoid.

The mobile editions carry their own suites: **Android 301 JVM/unit tests**
(`./gradlew test` reports 392 executions, but the app module's 91 tests are built
and run for both the debug and release variants, so 301 is the distinct count)
plus **55 on-device instrumentation tests**
(`connectedDebugAndroidTest`, verified by `android/tools/verify-instrumentation.sh`
against a per-class expectation), and **iOS 472 tests**
(`swift test --package-path ios/TruePadKit`), plus
the iOS supply-chain and isolation gates in `ios/scripts/` and `ios/vendor/`. The
iOS suite also runs under AddressSanitizer and ThreadSanitizer on every push, and
CI checks the generated SBOM against the tree and inspects what a device Release
build actually contains.

## Known limitations and what is still open

- **swtpm is not a physical TPM.** All TPM evidence here is emulator
  interoperability. Physical-TPM hardware validation is **outstanding**
  (`docs/RELEASE-CHECKLIST-3.0.md`, `docs/PHYSICAL-TPM-VALIDATION.md`).
- **Mobile is partly built, and the two platforms are at different stages.** The
  **Android Edition ships at 3.0.0** — engine, storage, SPT, QR and UI —
  with emulator instrumentation, single-device physical validation, and the
  two-device ceremony below all done. The
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
  force-quit test. And nothing in that bundle is a transfer between two parties.

  **The two-device work has since been done, on real hardware.** The
  Android↔iPhone Sealed Pad Transfer ceremony ran across a Samsung SM-A176U and
  an iPhone 12: optical QR in both directions read by each phone's own camera,
  12- and 8-word comparisons matching, `.tps2` import both ways, messages opened
  both ways, role and direction separation holding, and replay refused. **Two
  qualifications travel with that result and must not be dropped:** the word
  comparisons were performed by AUTOMATED comparison rather than spoken between
  two people, and the message carriers were host/test carriers rather than
  optical.

  **What remains on mobile is human accessibility, and it is NOT release-blocking**
  by the same standing decision: human TalkBack and human VoiceOver are **NOT
  TESTED**, with no partial pass inferred. Both mobile editions ship in the formal
  3.0.0 release; there is still no App Store build and no signed APK distributed. Secure Enclave is **not** assumed equivalent
  to a TPM monotonic authority (`docs/IOS-SECURITY.md`, `docs/ANDROID-SECURITY.md`,
  `docs/MOBILE-3.0-HANDOFF.md`).
- **Browser is never maximum-assurance** and a browser profile restore can rewind
  local state.
- Real-handheld QR-camera validation is **DONE** — both directions, each phone's
  real camera reading the other's screen.
- **Human accessibility (TalkBack/VoiceOver) is NOT TESTED**, and is
  **non-blocking** by project-owner decision. Automated `AccessibilityTest` and
  `LargeFontTest` are baselines, not a substitute for a person using the app.

## An explicit request

Internal AI adversarial audits and the falsification matrix are useful
*engineering* evidence — they are **not** an independent human security review,
and nothing in this repository should be read as claiming one has happened.

TruePad 3.0 **wants** that review and is asking for it here. It is **not a release
blocker**, by a standing decision of the project owner recorded in
[`docs/RELEASE-CHECKLIST-3.0.md`](RELEASE-CHECKLIST-3.0.md) §C, which is the
canonical authority on what blocks a release. This page previously said the
review was required "before any formal 3.0.0 release", which contradicted that
decision. If you find a
real defect, please report it (see `SECURITY.md` for the disclosure route) — the
[`docs/INDEPENDENT-REVIEW-BRIEF.md`](INDEPENDENT-REVIEW-BRIEF.md) names the
findings that would block 3.0.
