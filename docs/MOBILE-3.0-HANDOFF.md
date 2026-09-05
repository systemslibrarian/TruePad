# TruePad 3.0 — Mobile handoff (Android completion + native iOS)

This was the handoff written for the next implementation milestone: finishing
Android and building a native iOS app. **Both milestones have since moved**, so
the status block below is corrected; the rest of the page — what a mobile platform
can and cannot honestly claim, and the shared invariants both platforms MUST
inherit — still stands and is still the governing text.

**Corrected status (the original block named a branch that no longer exists):**

- **Android:** the `android-phase-2` branch was proven an ancestor of master and
  then DELETED, local and remote. The Android 3.0-dev application lives on
  **master**, not on a branch. Its engine, storage, SPT, QR and UI are built;
  emulator instrumentation and single-device physical validation on a real
  handset are done.
- **iOS:** the whole engine exists on master (`ios/TruePadKit` — `TruePadCore`,
  `TruePadClaims`, `TruePadStorage`, `TruePadSPT`, `TruePadUI`), byte-identical to
  the frozen wire and cross-checked against the Browser and Android editions in
  all four directions. It carries the §12 verbs, the courier bundle, the SPT
  durable state machine and the full sealed-transfer ceremony, the deployment
  evaluator, the TP2 compact transport, and a SwiftUI view layer whose
  security-carrying decisions are tested — plus a **native app target** at
  `ios/TruePadApp` that builds for `generic/platform=iOS` in Debug and Release.
  The app **has been installed and launched on a physical iPhone** (iPhone 12,
  iOS 18.6.2), where 9 on-device automated tests pass. This paragraph previously
  said it had not been, and that it was blocked on a
  local Apple ID for development signing, not on code.
- **Neither is released.** No App Store build, no Play production build, no 3.0
  tag.
- **Still outstanding on both, and not substitutable by any automated evidence:**
  the two-device Android↔iPhone optical ceremony, human TalkBack, human
  VoiceOver, and physical-iPhone validation.

Because the original block pinned specific SHAs that have long since advanced, it
is deliberately not replaced with new ones here — a SHA written into prose goes
stale the next commit. `git log` is the authority for where master is.

## 1. What Android already implements (v2.0.0-level)

Verified by reading `origin/android-phase-2` (no checkout/merge performed):

- **Crypto core — byte-exact Kotlin twin of `src/core/*`:** `Envelope.kt`
  (envelope2), `Frame.kt` (frame2), `WcOneTime.kt` (one-time WC / POLYVAL),
  `Partition.kt` (partition2 OTP source combine), `Gf128.kt`, `CompactEnvelope.kt`
  (TP2), plus Hex/Json/Direction. Headers state "byte-exact twin of src/core/*.ts".
- **Storage engine — twin of `src/browser/engine`:** `Store.kt`, `Verbs.kt`
  (gen/burn/open/status/listPairs/listSummaries/destroy/export), `Courier.kt`
  (container), `Witness.kt`, `Fs.kt`, `Meta.kt`.
- **Compose app** with the source-claim text ported verbatim; an
  Android-appropriate storage layout (`getFilesDir()` store, `getNoBackupFilesDir()`
  local witness), `allowBackup=false`, `FLAG_SECURE`.
- **Own CI** and a **one-way** shared-vector snapshot pinned to the `v2.0.0` tag.

## 2. What Android does NOT have

- **Sealed Pad Transfer** (`src/spt/*`), **QR** (`src/browser/ui/qr/*`), and the
  BIP-39 wordlist — deliberately out of scope ("pads arrive by courier file only").
- **The entire TruePad 3.0 maximum-assurance line** added on master after the
  fork: pair-bound `provenance.json`; terminal `withdrawal`; the
  **platform-monotonic TPM authority**; the **operator-pinned root of trust**; the
  ceremony assurance ladder (`ceremony create/accept/withdraw`); and the single
  **deployment evaluator** (`shannon-deployment.ts`) / `status.deployment` view.
- Android's witness is `android-local-witness` — a second local backup domain,
  **explicitly NOT a monotonic counter, not hardware-anchored, not a TPM**. It
  refuses `platform-monotonic`/`remote-monotonic` rather than downgrading. Pad
  material is not wrapped in Android Keystore; there is no StrongBox claim.

## 3. Compatibility (good news)

- **Wire is byte-stable across the whole `2908d58..master` range.** Zero commits
  touched `wc-one-time.ts`, `frame2.ts`, `envelope2.ts`, `partition2.ts`,
  `gf128.ts`; `compact-envelope2.ts` was added once (in 2.0.0) and Android ported
  it. So Android's envelope/frame/WC/partition/compact **bytes match current
  master**, not merely 2.0.0. The courier container format is likewise unchanged.
- **Rebase is textually conflict-free:** Android's only non-`android/` changes are
  two new files (`.github/workflows/android.yml`, `docs/ANDROID-SECURITY.md`); the
  intersection with master's changed files is empty.

## 4. Compatibility (the real work)

- **Aligning Android with 3.0 is a re-port, not a merge.** A rebase would leave a
  *v2.0.0-semantics engine on a 3.0 tree*: no provenance/withdrawal/trust-root/
  platform-witness/ceremony, and a Kotlin protocol lacking `status.deployment`.
- **Stale fixtures:** `engine-trace.json` is stale vs master (`verbs.ts` took ~10
  commits; `protocol.ts` now returns a `DeploymentView`). The one-way vector
  snapshot is checked only in the Kotlin direction against the `v2.0.0` tag; it does
  not verify against master HEAD's engine behaviour/protocol shape.

## 5. Android work remaining (recommended order)

1. **Port the deployment evaluator verbatim** (`shannon-deployment.ts` →
   `Deployment.kt`) — the single source of the verdict. Android MUST NOT invent a
   stronger evaluator.
2. **Port provenance + withdrawal** (pair-bound, fail-closed) as facts.
3. **Decide the platform-authority story honestly (see §7).** Android's local
   witness is not a TPM; a maximum-assurance verdict is therefore **not reachable**
   on Android today. Classify accordingly.
4. **Regenerate shared vectors against master HEAD** (not only the `v2.0.0` tag),
   and add the `DeploymentView`/status shape to the Kotlin protocol.
5. **Physical-device gate:** run `android/tools/physical-device-check.sh` on a real
   handset (it refuses emulators by design). **Status: DONE** — Samsung
   SM-A176U (Android 16), 44 instrumentation tests + 15 security checks passed.
6. **Human TalkBack pass:** a human end-to-end run. Automated `AccessibilityTest`/
   `LargeFontTest` are baselines only. **Status: NOT YET RUN — outstanding.**

## 6. Deployment class on Android (must be honest)

Because Android has no TPM platform-monotonic authority and no operator-pinned
root of trust, an Android pad **MUST NOT** be classified CONDITIONALLY ELIGIBLE.
Like the Browser, it should read at most INSUFFICIENT/NOT ELIGIBLE for the
maximum-assurance profile, with the honest reason (no independent live monotonic
rollback authority). Android may still be a fully useful authenticated-OTP client;
it simply is not the maximum-assurance surface. Mobile UI does not get to invent a
stronger verdict.

## 7. The platform-authority question, precisely

Do **not** assume any mobile secure element is equivalent to the desktop TPM
`platform-monotonic` authority. The 3.0 root of trust needs a hardware
**monotonic counter** that cannot be restored from a backup, plus an
operator-pinned identity outside the app's writable domain. Before claiming any
mobile equivalent, the implementer MUST verify the platform actually provides a
rollback-resistant monotonic counter with the required properties. If it cannot,
the mobile app receives a **weaker, truthful** deployment class — never a
simulated gold. (Android StrongBox/TEE presence is provenance-only, not a security
claim; iOS Secure Enclave is addressed in `MOBILE-3.0-HANDOFF.md` §iOS and the iOS
plan.)

See [MOBILE-IOS-PLAN.md](MOBILE-IOS-PLAN.md) for the native iOS architecture, and
the shared invariants below.

## 8. Shared invariants (Android AND iOS MUST inherit)

- **LOSS IS ACCEPTABLE. REUSE IS NOT.**
- Persist consumption **before** output; never wrap pad offsets; strict direction
  separation; reserve authentication attempts before verification.
- No pad-derived public fingerprint; terminal destruction/downgrade precedence.
- **Same message envelope; same canonical authenticated bytes; same fixed-record
  semantics** (share the vector corpus — see [INTEROP-VECTORS.md](INTEROP-VECTORS.md)).
- Same claims vocabulary; **same shared deployment-evaluator semantics**.
- If a platform cannot meet an invariant, **refuse the feature or downgrade the
  deployment class** — never silently weaken the invariant.

## 9. Do / don't for this milestone

- **Do not** merge, rebase, or delete `android-phase-2` in this pass.
- **Do not** claim swtpm or an emulator is a physical-device pass.
- **Do** treat the wire/vector compatibility as the asset it is: the hard part
  (crypto/wire) already agrees; the work is the 3.0 state/authority/evaluator
  layer and the honest mobile deployment class.
