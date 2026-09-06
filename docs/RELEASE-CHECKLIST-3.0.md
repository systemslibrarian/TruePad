# TruePad 3.0.0 — Release checklist

This gates a **formal 3.0.0 release**. It is not satisfied today. The software
gates are met on `master` (3.0.0-dev.0); the **physical and human** gates are
outstanding and each is release-blocking.

**Independent human security review is NOT a release blocker for this project.**
That is a standing project decision, not an oversight, and it must not be
reintroduced as a gate. An earlier version of this document listed it as
release-blocking; see Section C.

Nothing here authorizes creating a `v3.0.0` tag, a GitHub 3.0 release, or an npm
publication. Those happen only after every release-blocking item is green.

---

## A. Software gates (largely met on 3.0.0-dev.0)

| Gate | Procedure | Expected result | Evidence | Blocking? |
| --- | --- | --- | --- | --- |
| Typecheck (3 projects) | `npm run typecheck` | clean | CI log | yes |
| Unit + guards | `npm test` (or `npm run audit:security`) | all pass | CI log, count | yes |
| Falsification matrix | run the mutation matrix | 0 real escapes | matrix output | yes |
| No-verdict / no-pad-derived guards | in `npm test` | pass | test names | yes |
| Claims guards | in `npm test` | pass | `source-claim`, `front-door-claims` | yes |
| Build | `npm run build` | clean bundle | CI log | yes |
| Playwright e2e | `npm run test:e2e` | all pass | CI log, count | yes |
| Frozen crypto/wire | `git diff v2.0.0 master -- src/core src/spt` | empty | diff | yes |
| Dependency confinement | ordinary OTP path pulls no SPT/QR crypto dep | preserved | `docs/SECURITY-REVIEW-MAP.md`, dependency audit | yes |

Re-run at the release-candidate SHA rather than trusting the figures above; an
earlier revision of this line pinned counts from `a6a8b6…` that drifted stale.

**The mobile editions have their own software gates, and this table used to have
none.** Android: `./gradlew check` (JVM + lint + `verifyReleaseManifest`),
`connectedDebugAndroidTest` on a handset or emulator, and `assembleRelease`. iOS:
`swift test`, generic Debug and Release builds, `check-app-project.sh`,
`inspect-release-binary.sh`, `check-notices.sh`, `check-release-isolation.sh`,
`gen-sbom.sh --check`, `vendor/verify-vendor.sh`, and the ASan/TSan runs. All are
blocking.

## B. Physical / human gates

**RELEASE POLICY, set by the project owner:** accessibility and physical TPM are
**NON-BLOCKING**. They are recorded honestly below and are NOT marked complete.
The release-blocking bar is: zero unresolved HIGH findings, zero unresolved
MEDIUM findings, and green required software/release tests.

| Gate | Procedure | Expected result | Evidence to retain | Status |
| --- | --- | --- | --- | --- |
| Android physical handset validation | run the Android build on real handsets (`docs/MOBILE-3.0-HANDOFF.md`) | send/receive, storage, QR, crash-safety pass | device matrix, logs | **DONE** — Samsung SM-A176U, Android 16 |
| iOS on-device state pass | `ios/TruePadApp/TruePadAppUITests` on a physical iPhone | all on-device tests pass | test log + device/OS recorded | **DONE** — iPhone 12 / iOS 18.6.2 |
| Real handheld QR-camera validation | `docs/QR-VALIDATION.md` on Android + iPhone cameras | scan matrix passes; malformed rejected | device logs | **DONE** — both directions, each phone's real camera reading the other's screen |
| Android↔iPhone two-device SPT ceremony | `docs/CEREMONY.md` across two real handsets | words match; reject path works | both device logs | **DONE** — optical QR both directions, 12- and 8-word comparisons matching, `.tps2` import both ways, messages opened both ways, role/direction separation, replay refused. The word comparisons were read by AUTOMATION, not spoken between two people; the message carriers were host/test carriers, not optical. |
| Human TalkBack (Android) accessibility | a human uses the app end-to-end with TalkBack | usable, no trap, claims read correctly | recorded session notes | **NOT TESTED — NON-BLOCKING** |
| Human VoiceOver (iOS) accessibility | a human uses the app end-to-end with VoiceOver | usable, no trap, claims read correctly | recorded session notes | **NOT TESTED — NON-BLOCKING** |
| Physical TPM hardware validation | `docs/PHYSICAL-TPM-VALIDATION.md` on a genuine TPM 2.0 host | all steps pass on real hardware | signed run log, host/TPM identifiers | **NOT VALIDATED — NON-BLOCKING.** The swtpm evidence in CI is emulator interoperability only. |

## C. Independent review — NOT a release gate

Independent human cryptography/security review is **not required** to release
this project, and must not be listed as release-blocking.

`docs/INDEPENDENT-REVIEW-BRIEF.md` remains in the tree as a **standing offer to
reviewers**, not as a gate: if someone wishes to review TruePad, it tells them
where to start and what the project claims. Nothing waits on it.

This is recorded explicitly because the previous version of this checklist made
it release-blocking, which would have deadlocked the release on an event the
project had already decided not to require.

## D. Release mechanics (only after A and B are green)

1. Re-run all Section A gates at the exact release-candidate SHA; confirm green.
2. Confirm `origin/master` is the intended release SHA and unmoved.
3. Set the version to `3.0.0` in **every** location. There are six, and only the
   first two are npm's:
   - `package.json` and `package-lock.json` (from `3.0.0-dev.0`)
   - `android/app/build.gradle.kts` — `versionName` (from `3.0.0-dev.0`) and
     `versionCode` (monotonic; currently 2)
   - `ios/TruePadApp/TruePadApp.xcodeproj/project.pbxproj` — `MARKETING_VERSION`
     in **all** build configurations (currently `3.0.0-dev.0`), and
     `CURRENT_PROJECT_VERSION` (monotonic; currently 1)
   Verify afterwards that no location still reads `-dev`;
   move the CHANGELOG "Unreleased — planned v3.0.0" heading to a dated `## v3.0.0`.
4. Update README/SECURITY to state 3.0.0 as the latest formal release; keep the
   2.0.x historical wording accurate.
5. Decide Pages: the public demo cutover to 3.0 is a deliberate step (the current
   workflow deploys only on a `v*` tag or manual dispatch).
6. Tag `v3.0.0` (annotated) at the release SHA; create the GitHub 3.0.0 release.
7. If publishing to npm, publish `3.0.0` (not before A–C).
8. Never move or rewrite the `v2.0.0` tag or the historical 2.0.0 release.

> **Do not mark any Section B or C item complete without the real hardware, real
> device, real human, or real independent reviewer. swtpm is emulator
> interoperability evidence, not physical-TPM validation; Playwright/image decode
> is not a handheld-camera pass.**
