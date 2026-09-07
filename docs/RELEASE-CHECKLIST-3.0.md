# TruePad 3.0.0 — Release checklist

**THIS DOCUMENT IS THE CANONICAL AUTHORITY ON 3.0 RELEASE READINESS.** Where any
other document in the repository disagrees with it about what blocks a release,
what is complete, or what has not been tested, this one is correct and the other
one is stale. Fix the other one.

> ## RELEASED — TruePad 3.0.0, 2026-09-07
>
> The three blocking items below were met and the release was made. What that
> release did **not** include has not changed and is not quietly promoted by it:
> human TalkBack, human VoiceOver, physical TPM 2.0 validation and independent
> human security review were **not performed**, were **not gates**, and are still
> recorded as open in Sections B and C.
>
> **Reviewed, frozen candidate**
>
> | | |
> | --- | --- |
> | candidate `HEAD` | `a05ea9b21b7c17d1f91c9534972be9e2c4711685` |
> | candidate tree | `8483f595d53498f791866da3518b64494b6d7ad2` |
> | unresolved HIGH | 0 |
> | unresolved MEDIUM | 0 |
>
> The release commit that follows the candidate contains **release-state work
> only** — version metadata, current release documentation, release-state guards
> and the regenerated SBOM. It changes no cryptographic, protocol, storage,
> role-authority, handoff, fixed-record, egress or navigation semantics.

## What blocked the 3.0.0 release

Three things, and nothing else. All three were green at the candidate SHA above.

1. **Zero unresolved HIGH findings.** — met.
2. **Zero unresolved MEDIUM findings.** — met.
3. **The required software gates green at the release-candidate SHA** — Section A;
   met, and re-run again on the versioned release tree.

## What does NOT block it, and is not pretended to be done

These are recorded honestly, marked incomplete, and deliberately not gates. Each
is a standing decision by the project owner, not an oversight, and none may be
reintroduced as a blocker without the owner saying so:

- **Human TalkBack (Android) — NOT TESTED.** No human has run the app end to end
  under TalkBack. The automated `AccessibilityTest` and `LargeFontTest` are
  baselines and are not a substitute for it.
- **Human VoiceOver (iOS) — NOT TESTED.** As above; no steps were observed.
- **Physical TPM 2.0 hardware — NOT VALIDATED.** The swtpm evidence in CI is
  emulator interoperability only, and is never to be promoted past that.
- **Independent human security review — NOT PERFORMED.** An earlier version of
  this document listed it as release-blocking; see Section C.

## What IS complete

The physical gates that were outstanding have been met, and Section B records
each with the hardware it ran on: Android physical handset, iOS on-device pass,
real handheld QR-camera validation, the Android↔iPhone two-device SPT ceremony,
and physical two-direction message interop. One qualification travels with the
ceremony everywhere it is cited and must not be dropped: **the word comparisons
were performed by automated comparison, not spoken between two people**, and the
message carriers were host/test carriers rather than optical.

The three blocking items were green, and the `v3.0.0` tag and the GitHub 3.0.0
release were made on that basis. **No npm publication was made**, and a GitHub
release does not authorize one: TruePad has never been distributed through npm,
and a first-time publication would be a new distribution channel rather than a
release step.

---

## A. Software gates

### Results at the reviewed candidate `a05ea9b`

These are the figures the release decision was made on. They are the PRE-release
numbers: the release commit adds release-state guards, so the Browser/CLI count
moves. The re-run on the versioned release tree is recorded under "Release-tree
re-run" below.

| Suite | Result |
| --- | --- |
| Browser/CLI `npm test` | **1703 / 1703**, 81 files |
| Browser/CLI typecheck, build, Playwright | clean · clean · **36 / 36** |
| Android JVM (`./gradlew check`) | **301 distinct tests**, **392 executions** |
| Android instrumentation (suite size) | **55 tests**, 10 classes |
| Android instrumentation on physical Samsung SM-A176U | **55 / 55**, 10 classes, **0 failures, 0 errors, 0 skipped** |
| iOS `swift test` | **471 / 471** (the reviewed candidate; the release tree adds one negative-control test — see below) |
| iOS on-device `TruePadAppUITests`, physical iPhone 12 | 16 tests, **3 skipped** (the two two-device classes), 0 failures |

### Release-tree re-run (the versioned 3.0.0 tree)

The candidate being green is not enough: the gates were run again after the
version stamps, the released-state documentation and the release-state guards
went in. The Browser/CLI count moves because `tests/release-state.test.ts` is new;
every other figure is unchanged, which is the point — release mechanics changed no
behaviour.

**TWO RELEASE COMMITS DID NOT TAG, AND A THIRD CARRIES THE REPAIRS.** The release
was blocked twice at the exact-SHA CI gate. Neither failure was a product defect,
and neither was caused by a release commit. What they exposed was that two test
harnesses and one CI script were unreliable, and that a red run could not say why.

**CORRECTION, RECORDED DELIBERATELY.** The commit message of
`059c985fc27af4312cf020b5941830eb90f7918c` describes the AddressSanitizer failure
as a one-off flake that "never reproduced". **That is false, and this supersedes
it.** It reproduced on the very next release commit. That commit is not rewritten
and its history is not force-pushed; the mistaken characterisation stands where it
was written, and this is the correction.

### What actually failed

| | |
| --- | --- |
| iOS | `AppShellRegressionTests.testTheStoreIsMarkedExcludedFromBackupOnEveryOpen` |
| Android | `FixedRecordSmokeTest.aFixedRecordPadGivesEveryMessageTheSameCiphertextLength` |

Both failed in their **setup**, not on the property they exist to check.

**iOS.** The test excluded a store from backup through the product, cleared the
flag with `setResourceValues(isExcludedFromBackup: false)`, then read it back and
required `false`. It got a stale `true`. The read was never the problem: measured
over 300 iterations, the raw `getxattr` view and the `URL` view disagreed 228
times, and a freshly constructed `URL` — the workaround already in the test —
returned the stale value 3 times. `removeAllCachedResourceValues()` makes it
worse. **The Foundation WRITE is not synchronously visible.** A `removexattr`
version of the repair failed too, at a different line: over 400 iterations the
attribute REAPPEARED after a successful removal **every single time**, a median of
150µs later, because the product's own exclusion write was still in flight and
landed on top of the clear. Clearing that directory is not fixable without waiting
and retrying, which would make the precondition a measurement of timing.
So the negative state is now **constructed instead of reached**: the directory is
created with `FileManager`, has never been excluded, and therefore has nothing in
flight against it. Opening a store on it exercises the identical path —
`makeDirectory` returns early for a directory that already exists, so `init`'s
reassertion is the only thing that can set the flag, which is exactly the defect
the test was written for. **100 consecutive runs, 0 failures** (60 under
AddressSanitizer, 40 plain).

**Android.** The test clicked Copy and read the clipboard **once, immediately**.
`performClick` returns when the click is dispatched, not when the handler's write
has landed, and on the CI emulator the read came back EMPTY — the assertion
printed "Copy handed over something that is not the compact transport form:" with
nothing after the colon. The repair seeds a UUID sentinel, clicks the real Copy
control, waits for idle, then polls **with a 15-second deadline** until the
clipboard has actually CHANGED from its pre-click value, is not the sentinel, and
carries the compact prefix. Comparing against the pre-click value rather than only
the sentinel is what makes it honest: this test calls Copy twice, and had the
platform ever refused the seed, a sentinel-only guard would have accepted the
FIRST message's transport on the second call — non-empty, correctly prefixed and
completely wrong. On timeout it reports the SHAPE of what it saw and never the
content, because a harness that prints clipboards into a CI log is one product
defect away from printing a plaintext into one.

**Neither repair weakens anything.** No assertion was deleted, loosened, skipped
or made conditional, and `ConcurrencyTests`' two contention assertions were never
touched. Both repairs were mutation-proved against the product rather than merely
re-run: removing the store's reassertion on open makes the iOS test red; making
Copy hand over the canonical form instead of the compact one makes the Android
test red; making Copy do nothing makes it red with "clipboard unchanged since
before the click=true"; and pointing the iOS observation at the wrong attribute,
or making it always answer "excluded", makes it red too.

### A third gate: the release-binary inspector was reporting a symbol that was there as missing

The repaired commit then failed the iOS workflow at
`Inspect what the release binary actually contains`, §4:

    PASS  the vendored BoringSSL provides CCryptoBoringSSL_XWING_encap
    FAIL  CCryptoBoringSSL_XWING_decap is missing — the X-Wing path is not the vendored one

**The symbol was present.** This is a false negative in the gate, and it was
demonstrated rather than argued:

> The old §4 presence probe was empirically false-negative. Against a local
> object where both X-Wing symbols were independently verified present — both
> defined text symbols in a single 2.6 MB `CCryptoBoringSSL.o`, from the same
> `xwing.cc` — the exact `nm -g "$BORING" | grep -qF "$symbol"` pipeline reported
> `encap` missing **9 times in 200** and `decap` missing **25 times in 200**. The
> `nm` stream was **177,247 bytes**, exceeding the 64 KiB pipe buffer; under
> `pipefail`, `grep -q` terminates at its first match, closes the pipe, and `nm`
> exits via SIGPIPE, so the pipeline reports failure for a symbol that is there.
> `decap` sorts one line earlier than `encap`, so `grep` exits marginally sooner
> and leaves marginally more of `nm`'s output unwritten — which is the whole
> difference between the symbol that failed a release and the one that did not.

**The script had already documented this exact trap, in its own header, and §4
reintroduced it anyway.** The note above §1 reads: "`set -o pipefail` plus
`grep -q` on a LARGE stream is a trap... Every check in the first version of this
script was vacuous for exactly that reason." Sections 1–3 avoid it by capturing
`nm` output to a file first. Section 4 did not.

Corroborating evidence, none of it about the product: the only change to any
iOS-linked path since the previous green iOS run was the `project.pbxproj`
version bump — eight lines of `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION`;
`ios/vendor` and `ios/TruePadKit/Sources` were byte-identical; and the same script
passed locally on a byte-identical toolchain (Xcode 26.6 / 17F113, Swift 6.3.3).

**The repair, which does not weaken the requirement.** Both symbols are still
required, from the vendored BoringSSL, in a device Release build. What changed is
how the question is asked: `nm` is captured once to a file and **its own exit
status is checked**, so a probe that fails is reported as a failed probe rather
than as a missing symbol; the file is then searched, which has no producer to
kill. Candidate objects are enumerated `LC_ALL=C` sorted instead of
`find … | head -1`, and **every** candidate must provide both symbols — strictly
stronger than inspecting whichever copy the filesystem yielded first. On failure
the gate now prints which object it read, its size, and the X-Wing symbols
actually present, so a red result is actionable. The same construct in the
workflow's separate link-proof step was repaired the same way; it was not under
`pipefail` and so was not lying, but it was one setting away from it.

**The candidate set was recorded from a real build, not assumed.** One device
Release build of all five shipping schemes produces exactly **one**
`CCryptoBoringSSL.o` under `Release-iphoneos` — 2,631,212 bytes, `nm` exit 0,
3,128 global symbols — and it is the complete vendored object rather than a
fragment: all seven X-Wing entry points are defined text symbols in it, alongside
`EVP_AEAD_CTX_seal`, `SHA256_Init`, `CRYPTO_memcmp`, `X25519` and 51 ML-KEM
symbols. The five schemes share one DerivedData tree and one products directory,
so BoringSSL is compiled once and shared, which is why there is one. With that
architecture confirmed, requiring EVERY candidate to provide BOTH symbols is
equivalent to the single-object case today and degrades safely if the layout ever
yields more; it is not loosened to "one of them somewhere".

**And the gate is now policed by a gate.** `ios/scripts/selftest-symtab.sh` runs
on fixtures, needs no iOS build, and proves: a present symbol is found in 200/200
trials on a table larger than a pipe buffer; a removed symbol is reported absent;
removing one does not hide the other; a probe that cannot run fails loudly instead
of reporting "absent"; an empty products directory yields no candidates; candidate
order is sorted regardless of creation order; and the banned `nm | grep -q`
construct cannot return. That last check needed fixing itself — its first version
fired on `symtab.sh`'s own comment describing the construct, so it now scans code
rather than prose, and asserts both that it fires on the real construct and that
it ignores a comment mentioning it.

### The CI script could not report its own failure

The step piped `swift test` through `tail -20`, so the only complete output lived
in `/tmp` on a runner that is destroyed with the job. Worse, `shell: bash -e` plus
`set -o pipefail` ended the step AT the failing pipeline, so the diagnostics
written below it never ran at all — which is why the first red run named nothing.
The runs now capture the test command's status, print the failing cases, keep all
three logs as an artifact, and exit with the status the run earned. Verified by
simulation rather than assumed: with a deliberately failing test present, the
plain and AddressSanitizer steps both go **red and name it**, and with the suite
healthy both are green. Against the previous version of the step the same
deliberate failure produced red with **no test named and no diagnostic at all**.


| Gate | Result on the release tree |
| --- | --- |
| `npm run typecheck` (3 projects) | PASS |
| `npm test` | **1720 / 1720**, 82 files (1703 / 81 at the candidate, + 17 release-state guards in 1 new file) |
| `npm run build` | PASS |
| `npm run test:e2e` (Playwright) | **36 / 36** |
| Frozen crypto/wire — `git diff v2.0.0 HEAD -- src/core src/spt` | **empty** |
| Android `./gradlew check` (JVM + lint + `verifyReleaseManifest`) | BUILD SUCCESSFUL — **301 distinct tests, 392 executions**, 0 failures, 0 errors, 0 skipped |
| Android `:app:assembleDebug :app:assembleRelease` | BUILD SUCCESSFUL |
| Release APK audit (`aapt2` over the built artefact) | `dev.systemslibrarian.truepad`, versionName **3.0.0**, versionCode **3**; permissions: `CAMERA` only — **no `INTERNET`, no `ACCESS_NETWORK_STATE`**; **one** exported component (`MainActivity`); no test-orchestration component; no `.b` clone package or resources |
| Android vectors vs released v2.0.0 (`regenerate-vectors.sh --check`) | byte-identical |
| Android vectors vs this tree (`verify-vectors-current.sh`) | byte-identical, evaluator corpus included |
| Android instrumentation on the physical **Samsung SM-A176U** | **55 / 55**, 10 classes, **0 failures, 0 errors, 0 skipped** |
| iOS `swift test` | **472 / 472** |
| iOS `swift test --sanitize=address` | **472 / 472**, no AddressSanitizer finding |
| iOS `swift test --sanitize=thread` | **472 / 472**, no ThreadSanitizer finding |
| iOS `swift build` / `swift build -c release` | PASS / PASS |
| `check-release-isolation.sh` · `verify-vendor.sh` · `check-notices.sh` · `check-app-project.sh` · `gen-sbom.sh --check` | PASS · PASS · PASS · PASS · PASS |

**Falsification.** The release-state guards were mutation-proved rather than
merely run: 36 single-edit mutations — a version sliding back to `-dev` in each of
the six locations, one of the four iOS `MARKETING_VERSION` declarations missed, a
signing team committed, the `.b` clone suffix returning, a fabricated DOI, a
fabricated `v1.0.0`, the automation qualification dropped from the ceremony
record, an unsupported App Store claim, TalkBack or physical TPM marked done, and
each released-state document sliding back to its pre-release wording — and every
one of them was caught. One real gap was found that way and closed: the SBOM guard
originally read `components` only, so a stale `metadata.component` passed.

### The gates themselves

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
| Android physical handset validation | run the Android build on real handsets (`docs/MOBILE-3.0-HANDOFF.md`) | send/receive, storage, QR, crash-safety pass | device matrix, logs | **DONE** — Samsung SM-A176U, Android 16. The **full** suite — 55 tests across all ten classes — ran on that handset against the 3.0.0 release tree: 0 failures, 0 errors, 0 skips. An earlier `ANDROID-SECURITY.md` §1 note said four classes had never run there; that was true when written and is not true now, and §1 says so rather than being rewritten. What has NOT been re-run on the handset is `physical-device-check.sh` itself; its last hardware run is the one at `6582d22`. |
| iOS on-device state pass | `ios/TruePadApp/TruePadAppUITests` on a physical iPhone | all on-device tests pass; the two two-device classes report SKIPPED | test log + device/OS recorded | **DONE** — iPhone 12 / iOS 18.6.2. `CrossEditionSealTest` and `CrossEditionMessageTest` need a second handset and a courier, so they skip unless `scripts/cross-edition-physical.sh` sets `TEST_RUNNER_TRUEPAD_PHYSICAL_CEREMONY=1`. They used to FAIL instead, which made this row's expected result unreachable on a healthy build. |
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

## D. Release mechanics — performed 2026-09-07, after the three blocking items were green

> Section B is **not** a precondition of this section, and this heading used to
> say it was — "only after A and B are green". Section B contains three rows that
> are permanently open by owner decision (human TalkBack, human VoiceOver,
> physical TPM), so requiring B to be green would have deadlocked the release on
> exactly the gates the document had just declared non-blocking, two screens
> earlier. The preconditions are the three items under "What blocked the 3.0.0
> release".

1. Re-run all Section A gates at the exact release-candidate SHA; confirm green.
2. Confirm `origin/master` is the intended release SHA and unmoved.
3. Set the version to `3.0.0` in **every** location. There are six, and only the
   first two are npm's. **Done**, and now guarded by `tests/release-state.test.ts`
   with literal expectations rather than values read back out of the tree:
   - `package.json` and `package-lock.json` — `3.0.0`
   - `android/app/build.gradle.kts` — `versionName = "3.0.0"`, `versionCode = 3`
   - `ios/TruePadApp/TruePadApp.xcodeproj/project.pbxproj` —
     `MARKETING_VERSION = "3.0.0"` in **all four** build configurations, and
     `CURRENT_PROJECT_VERSION = 2`
   - `CITATION.cff` — `version: "3.0.0"`, with `date-released`
   - `ios/sbom.json` — regenerated, because `gen-sbom.sh` reads `package.json`
   No location still reads `-dev`, and the CHANGELOG heading moved from
   "Unreleased — planned v3.0.0" to the dated `## v3.0.0 — 2026-09-07`.
4. Update README/SECURITY to state 3.0.0 as the latest formal release; keep the
   2.0.x historical wording accurate. **Done.** SECURITY now names **3.0.x** as
   the supported line and 2.0.0 as the previous formal release rather than
   claiming an ongoing 2.0.x maintenance commitment the project does not have.
5. Decide Pages: the public demo cutover to 3.0 is a deliberate step (the current
   workflow deploys only on a `v*` tag or manual dispatch). **Done** — the
   `v3.0.0` tag push is what deployed it.
6. Tag `v3.0.0` (annotated) at the release SHA; create the GitHub 3.0.0 release.
   **Done**, and only after every required workflow was green for that exact SHA.
7. **No npm publication.** `3.0.0` was NOT published to npm. This project has
   never had an npm distribution channel, and a GitHub release does not create
   one.
8. Never move or rewrite the `v2.0.0` tag or the historical 2.0.0 release.
   **Unmoved:** tag object `e94b6a3ca8aa2111a1a320c7911044d808521326`, peeling to
   commit `240d7f0fa847c8e135cddd3826e7d2da699d1567`.

> **Do not mark any Section B or C item complete without the real hardware, real
> device, real human, or real independent reviewer. swtpm is emulator
> interoperability evidence, not physical-TPM validation; Playwright/image decode
> is not a handheld-camera pass.**
