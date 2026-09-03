# TruePad 3.0.0 — Release checklist

This gates a **formal 3.0.0 release**. It is not satisfied today. The software
gates are largely met on `master` (3.0.0-dev.0); the physical, human, and
independent-review gates are **outstanding** and each is release-blocking.

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

Current status: **met** at `a6a8b6…` (1563 unit / 69 files; 36 Playwright;
43-mutation matrix, 0 real escapes; core/spt diff empty). Re-run at the release
candidate SHA.

## B. Physical / human gates (OUTSTANDING — all release-blocking)

| Gate | Procedure | Expected result | Evidence to retain | Status |
| --- | --- | --- | --- | --- |
| Physical TPM hardware validation | `docs/PHYSICAL-TPM-VALIDATION.md` on a genuine TPM 2.0 host | all steps pass on real hardware | signed run log, host/TPM identifiers | **OUTSTANDING** |
| Android physical handset validation | run the Android build on real handsets (`docs/MOBILE-3.0-HANDOFF.md`) | send/receive, storage, QR, crash-safety pass | device matrix, logs | **OUTSTANDING** |
| Human TalkBack (Android) accessibility | a human uses the app end-to-end with TalkBack | usable, no trap, claims read correctly | recorded session notes | **OUTSTANDING** |
| Real handheld QR-camera validation | `docs/QR-VALIDATION.md` on Android + iPhone cameras | scan matrix passes; malformed rejected | device/lighting matrix, photos | **OUTSTANDING** |
| iOS validation (once built) | native iOS build on real devices + VoiceOver | parity + honest deployment class | device matrix, logs | **OUTSTANDING (not built)** |

## C. Independent review gate (OUTSTANDING — release-blocking)

| Gate | Procedure | Expected result | Evidence | Status |
| --- | --- | --- | --- | --- |
| Independent human cryptography/security review | commission a review per `docs/INDEPENDENT-REVIEW-BRIEF.md` | no unresolved release-blocking finding | reviewer report + issue resolution | **OUTSTANDING** |

## D. Release mechanics (only after A–C are green)

1. Re-run all Section A gates at the exact release-candidate SHA; confirm green.
2. Confirm `origin/master` is the intended release SHA and unmoved.
3. Set `package.json` / `package-lock` version to `3.0.0` (from `3.0.0-dev.0`);
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
