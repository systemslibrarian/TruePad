# TruePad 2 Android Edition — security & durability claims

**Status: 3.0, shipping. Physical-handset validation DONE; human TalkBack
outstanding and non-blocking.** This document covers `truepad-core`,
`truepad-storage`, `truepad-spt` and the `:app` module under `android/`. The app
launches, creates, adds, sends, opens and disables pads over the same frozen
v2.0.0 engine the CLI and Browser Edition use. It carries the TruePad 3.0
assurance line — the single deployment evaluator, the honest Android fact
assembly, the extended claims guards, and an Android hostile-mutation matrix
(§4a).

**IT ALSO SHIPS SEALED PAD TRANSFER AND TPR2 QR, and earlier revisions of this
document said it did not.** That statement was written before the work landed and
was left standing afterwards; it is corrected throughout. Android implements the
full SPT protocol (`android/truepad-spt`, X-Wing = ML-KEM-768 + X25519 via Bouncy
Castle), the durable receiver/handoff state machine (`SptEngine.kt`), the sender
and receiver screens (`SptScreens.kt`), and TPR2 QR display and camera scanning
(`Qr.kt`, `QrScan.kt`). §6 and §12 previously denied the cryptographic dependency
that makes this possible; they no longer do.

Physical evidence now in hand, on a Samsung SM-A176U (Android 16): the
instrumentation suite and on-device security checks, and a two-device ceremony
against a physical iPhone 12 covering optical QR in **both** directions, `.tps2`
import in both directions, real messages opened in both directions, creator/
importer role separation, directional meter separation and replay refusal.

What is NOT in hand: a **human TalkBack pass** (§10) and **physical TPM 2.0**.
Both are recorded as outstanding and are non-blocking by project-owner decision.
Section 9 states what is still NOT claimed, and Section 10 what remains. The companion `docs/ANDROID-3.0-DELTA-AUDIT.md` is the delta record —
what the `android-phase-2` merge brought and what the 3.0 port added on top — and
this document is the client's own security document; where the two overlap, the
delta audit is the finer-grained account and this one must not contradict it.

The Android edition is not a new TruePad. It is the same frozen protocol
(`docs/FORMAT-V2.md`) on a different substrate, and where this document differs
from the CLI or the Browser Edition it is because the SUBSTRATE differs, never
because the protocol was reinterpreted.

The central invariant is unchanged and is not negotiable for platform
convenience:

> **LOSS IS ACCEPTABLE. REUSE IS NOT.**

---

## WHERE EACH CLAIM'S EVIDENCE COMES FROM

Every statement in this document rests on one of three kinds of evidence, and
they are not interchangeable. This table is the first thing to read, because a
green tick means nothing until you know what ran.

| Evidence | What it covers | Where it runs |
|---|---|---|
| **JVM** | The whole protocol and storage state machine — both engine modules are pure Kotlin/JVM and the SAME compiled code runs on ART. Plus the app's source audits and the release-manifest gate. | Every CI run, every local build. |
| **EMULATOR** | The instrumentation suite and the on-device security checks: the real UI, real `java.nio` on ART, real process kill, the real installed package. | Every CI run (`instrumentation` job) and locally. |
| **PHYSICAL DEVICE** | Whatever an emulator cannot be: a real flash translation layer, a real TEE, a vendor's own backup implementation. | **DONE.** `android/tools/physical-device-check.sh` ran on a **Samsung SM-A176U (Android 16)**: the 44-test instrumentation suite and the 18 on-device security checks passed. The gate refuses to run against an emulator. Its first hardware run also corrected three defects in the script's own observations (see commit `6582d22`) — the APK was byte-identical, test tooling only. |
| **HUMAN** | Using the app with TalkBack. | **NOT YET PERFORMED.** The automated baseline in `AccessibilityTest` is not a substitute and does not claim to be. |

So: everything below is JVM- and EMULATOR-validated unless it says otherwise.
Nothing in this document is physical-device evidence, and nothing in it is a
human accessibility pass.

---

## 0. What is the same, and what is different

| Layer | Android | Why |
|---|---|---|
| Message encryption | literal one-time-pad XOR | unchanged; §FORMAT-V2 §1.2 |
| Message authentication | `wc-one-time-v1`, one-time Wegman–Carter, 128-bit tags | unchanged; §2 |
| Wire envelope | Envelope v2 canonical JSON (§6.2) **and** TP2 Compact Transport v1 | unchanged; both spellings, as the release accepts both |
| Store on disk | Store Format v2, byte-identical | unchanged; §1 |
| Courier bundle | the same six-file container | unchanged |
| Rollback witness | `android-none` / `android-local-witness` | product layer, §4 |
| Secret storage | app-private filesystem, no Keystore | §5 |
| Durability | fsync + atomic rename on the app-private volume | §2 |

Nothing here introduces a second cryptographic protocol, and nothing here
replaces the OTP or the Wegman–Carter construction with a conventional cipher.

**Interoperability is verified, not asserted.** `android/vectors/` holds golden
fixtures generated by running the *released* v2.0.0 TypeScript itself — including
a complete `gen → export → import → burn → open → forge → replay` transcript with
every `head.json`, `journal.log`, witness record, `secret.bin`, courier container,
envelope, plaintext and refusal reason it produced. `EngineTraceTest` replays that
transcript through the Kotlin engine and requires byte-for-byte agreement.
Regenerate or verify with:

```
android/tools/regenerate-vectors.sh          # rewrite from tag v2.0.0
android/tools/regenerate-vectors.sh --check  # fail if the committed vectors are stale
```

The script checks v2.0.0 out into a throwaway detached worktree and removes it
again; it never writes to a branch, a tag, or the release commit.

---

## 1. Architecture: where secrets live

```
truepad-core      pure Kotlin/JVM. Hex, POLYVAL/GF(2^128), wc-one-time-v1,
                  the §7 partition, the §16 frame, Envelope v2, TP2 compact
                  transport, a strict JSON reader. No Android imports at all.

truepad-storage   Store Format v2, the §12 transaction engine (the verbs), the
                  rollback witness, product metadata, the courier container —
                  over a small `Fs` abstraction. No Android imports at all.
```

Neither module imports the Android SDK. That is deliberate: the security state
machine is exercised by fast JVM tests, and the SAME compiled code runs on ART.
There is no "Android version" of the engine that could drift from the tested one.

Pad material exists in three places and no others:

1. `secret.bin` on the app-private filesystem;
2. a `ByteArray` inside one verb call;
3. the ciphertext of an envelope the operator chose to emit.

### 1.1 In-memory hygiene — best-effort, and named as such

Every verb zeroes the buffers it allocated (`pad`, `key`, `mask`, the frame, the
plaintext) before returning. **This is hygiene, not erasure.** On ART a
`ByteArray` may have been copied by a moving garbage collector before the zeroing
runs, and neither the JVM nor Android exposes a way to find or scrub those copies.
The claim is "we do not keep it", never "it is gone from memory".

Kotlin `String` is worse: it is immutable and uncontrollable. The engine
therefore never puts plaintext or pad material into a `String` — plaintext
crosses the API as `ByteArray` in both directions.

---

## 2. Storage, and exactly what "durable" means here

`NioFs` is the production backing: plain `java.nio` and `RandomAccessFile`, which
behave identically on ART.

- **Whole-file replace** (`head.json`, `pair.json`, the tombstone): write a temp
  file → `fd.sync()` → `ATOMIC_MOVE` → fsync the parent directory.
- **Append** (`journal.log`, the witness journal): append → `fd.sync()`, and on
  the append that CREATES the file, fsync the parent directory too. An fsync on a
  file descriptor persists the file's *contents*, not its *directory entry*, so
  without that a creating append could be lost whole.
- **Positioned write** (the destruction zero-overwrite): write → `fd.sync()`.

### What is claimed

> The bytes reached the app-private filesystem and were fsynced. A process death
> after that fsync is survived.

That is the Android sense of durable, and it is what the crash matrix in
`CrashAndLifecycleTest` verifies.

### What is NOT claimed

- **Not power loss.** This is not the CLI's Linux/ext4 power-loss claim. Android
  devices, vendor kernels, and flash translation layers vary, and `fsync` on some
  devices has historically not meant what it says. If the phone loses power
  mid-write, the guarantee is the one below: a torn file is *refused*, never
  silently accepted.
- **Not atomicity beyond `ATOMIC_MOVE`.** Where the backing cannot rename
  atomically, the code falls back to a non-atomic replace. A torn `head.json`
  then fails the strict header validation and the store refuses `corrupt-head`;
  a torn `secret.bin` fails the exact-length check and refuses
  `corrupt-secret-body`; a torn journal line refuses `corrupt-journal`. Every
  reader in the engine fails CLOSED. **The rollback witness does not depend on
  atomic replace at all** — it is an append-only journal (§4).
- **Not directory-fsync everywhere.** `fsyncDir` opens the directory for `force()`
  and swallows the failure where the platform does not support it (a macOS
  development host, for instance). On Android/Linux it works. This is stated
  rather than assumed.

### File modes

Files are set 0600 and directories 0700, matching the released CLI. On Android
this is belt and braces, **not** the protection itself: the app-private data
directory is already isolated per-UID, and that isolation — not the mode bits —
is what keeps other apps out. The modes matter when the same store is copied to
shared storage or a desktop. Setting them is best-effort: a filesystem without
POSIX permissions throws, and the operation continues rather than failing a burn
over a mode bit.

### Single writer

Every verb runs under `Fs.withLock(pairId)`: an in-process `ReentrantLock` **plus**
a real OS file lock, so two processes cannot both advance one pair.

Both layers are **bounded** at 10 seconds and then refuse `locked`. Unbounded
blocking is specifically wrong on Android: a verb runs behind a UI action, and a
wait longer than a few seconds is an ANR — the system kills the process, which is
a crash at an arbitrary point in the state machine. A refusal is free and consumes
nothing; a kill is not. Ten seconds is far beyond any legitimate contention here,
because every verb is bounded work on one small store.

---

## 3. Commit ordering — the two rules that matter

**BURN-BEFORE-OUTPUT.** `burn` writes the advanced `head.json`, then appends the
`send` journal line, then advances the witness, and only then does the envelope
exist outside the call.

**PERSIST-BEFORE-USE.** `open` appends the `attempt` reservation and advances the
witness *before* the tag is verified, and durably retires both namespaces (O5)
*before* the plaintext is released (O6).

If any of those durable writes fails, the operation throws and **the output is
withheld**. The material is spent and the message is lost. That is the trade, and
`CrashAndLifecycleTest.aBurnWhoseDurableWriteFailsNeverReturnsAnEnvelope` holds
the engine to it at every one of those points.

The one deliberate inversion: an authentication FAILURE appends its `auth-fail`
line *before* rewriting the header, exactly as the release does.

---

## 4. Rollback witness — where it lives is the whole point

A restore is the classic pad-reuse vector: put yesterday's store back, and every
byte spent since becomes spendable again. Worse, restoring only the header
refills a contested record's verification-attempt budget and defeats the finite
forgery bound of §5.

The witness records exactly the three frozen monotone counters of §15.1 —
`encryptionNextOffset`, `authenticationNextSequence`, `attemptsReserved` — and
nothing else. Never pad contents, keys, masks, plaintext, or ciphertext.

Two kinds, named honestly:

- **`android-none`** — no witness, no claim. A bare FORMAT-V2 store this app never
  provisioned (a CLI store copied in) is `android-none`. Restoring it regresses it
  and resets the attempt budget; §9.4 of FORMAT-V2 stands as written.
- **`android-local-witness`** — an append-only journal at `witness/<pairId>.log`.

**A witness only detects a rollback if it is in a different failure domain from
the thing being rolled back.** The `Engine` therefore takes a *separate* `Fs` for
the witness. The application binds:

```
store   →  Context.getFilesDir()
witness →  Context.getNoBackupFilesDir()
```

Android Auto Backup and device-to-device transfer carry the former and **not** the
latter. A restored pair store therefore meets a witness that still remembers the
true high-water and the true attempt budget, and the operation refuses
`witness-regressed` before anything is consumed.

**What that relies on, precisely.** The exclusion of `getNoBackupFilesDir()` is
Android's own documented contract, and TruePad relies on it. What the app can
verify is its own side: that the two roots really are different trees, and that a
store rewound underneath an untouched witness really is refused — both are tested
on-device (`DeviceEngineTest.aRestoredStoreIsRefusedOnDevice`). What no software
on the handset can verify is that a particular vendor's backup implementation
honours the contract. That is why `allowBackup="false"` and the two rules files
exist as well: three independent ways of asking, so that one of them being wrong
is not the whole defence. If all three were ignored by some OEM path, the witness
would be restored with the store and detect nothing — which is exactly the weak
configuration `WitnessTest.aWitnessInsideTheBackupDomainCannotDetectTheRollback`
demonstrates rather than hides.

And to be explicit about what this is NOT: `getNoBackupFilesDir()` is a directory
the backup system skips. It is not a monotonic counter, not hardware-anchored,
and not a TPM. It gives the witness a different failure domain from the store on
the same device, and nothing more.

`WitnessTest` tests both configurations, including the weak one — a witness inside
the backup domain is restored alongside the store and detects nothing — so the
reason for the split is a test, not a comment.

**Crash safety.** The journal is append-only and never truncated, and records are
LEADING-newline framed (`\n<json>`). A crash mid-append leaves an isolated partial
line the reader drops; it can never fuse with the record before or after it. Only
a torn advance loses its own value, and a torn advance's operation errored and
withheld its output — so the witness never under-reports below a state whose
output was released, and the next clean advance re-records the high-water.

**Fails closed.** A provisioned journal is never emptied, so an established
witness never reads as "fresh": missing, empty, all-corrupt, or missing a
direction all refuse `witness-inconsistent`.

**What it does not do.** Uninstall and "Clear storage" take both trees. That is
LOSS, not reuse. It cannot defend against an attacker who can already rewrite this
app's private storage — that is outside what any local witness can do, and
`android-LOCAL` is named to say so. It is one directory on one device, not an
independent host, and it does not imply the CLI's `separate-state-file` reach or a
TPM's monotonic counter.

### §rollback — the frozen head always says `witnessClass: "none"`

`head.json` carries the CLI's `rollback: { witnessClass: "none", config: {} }`,
byte-identical to a CLI or Browser store. The Android witness is a product layer
recorded in the Android-only `pair.json`, outside the frozen bytes.

Consequently a store whose frozen `witnessClass` is `separate-state-file`,
`platform-monotonic`, or `remote-monotonic` is **REFUSED, never downgraded**. The
CLI can write such stores. Accepting one while enforcing nothing would be claiming
a protection this edition does not provide, so it fails closed with `corrupt-head`
— the same behaviour as the released Browser Edition.

This is a real, deliberate consequence: **Android refuses a strictly larger
population of real CLI stores than the CLI itself accepts.** A pad generated with
`truepad2 gen --witness separate-state-file` cannot be imported here. Generate the
pad with the default `none` class to courier it to Android.

**Terminology — one collision to name before it trips you.** The string
`separate-state-file` appears at two different layers and means two different
things. Here (§rollback), it is a FROZEN-HEAD value: `Store.kt` refuses any
`head.json` whose `rollback.witnessClass` is the literal `"separate-state-file"`
(it insists on `"none"`). In the deployment evaluator (§4a), by contrast,
`RollbackAuthority.separate-state-file` is a LIVE, DERIVED CLASS that the honest
fact-assembly applies to the android-local-witness — the correct, honest label for
a real-but-restorable-with-the-pair journal. A frozen-head validation and a live
derived fact, sharing one spelling; not a contradiction. The frozen head still
always reads `witnessClass: "none"` (above), while the witness's honest live class
is `separate-state-file`.

### An import does NOT delete the witness journal

`discardIncompleteImport` clears a half-finished import so a retry is never
blocked by a ghost. It clears the partial store, the metadata, the marker and the
staging tree — but **not** the rollback witness journal, and that is a deliberate
divergence from the Browser Edition rather than an omission.

The browser deletes it there, and there it is harmless: the browser's witness
lives in the SAME OPFS domain as the store, so nothing can wipe the store and
leave the witness behind. Here the witness is deliberately in ANOTHER failure
domain — that is the entire point of the separation above. So the sequence

    the store is cleared, the witness survives
      -> import an OLDER bundle of the same pad
      -> the witness journal is deleted and re-bootstrapped at the old counters
      -> already-spent material is usable again

would destroy the one piece of evidence engineered to outlive the store. That is
REUSE, so the deletion was removed.

Keeping the journal cannot block a legitimate retry: it is append-only and
reconciliation takes the MAXIMUM, so re-importing the SAME bundle bootstraps to
the same high-waters and reads `aligned`, while re-importing an OLDER one reads
`witness-regressed` — which is the correct answer. LOSS IS ACCEPTABLE; REUSE IS
NOT.


---

## 4a. The deployment assessment — one derived evaluator, and the Android ceiling

TruePad 3.0 asks a question the v2 protocol did not surface: whether a PARTICULAR
deployment can still support Shannon confidentiality, given only the facts the
client has actually recorded. The Android edition answers it exactly as the CLI
and Browser editions do — through the ONE authority — and adds no rule of its own.
`docs/ANDROID-3.0-DELTA-AUDIT.md` is the delta record for how this landed on top of
the `android-phase-2` engine; this section states the resulting security property.

**One evaluator, and Android only feeds it.** `core/Deployment.kt` is a byte-exact
DECISION twin of `src/claims/shannon-deployment.ts` — the same enums, the same
load-bearing ordering, the same three verdicts (NOT ELIGIBLE, INSUFFICIENT
EVIDENCE, CONDITIONALLY ELIGIBLE). `storage/DeploymentAssembly.kt` maps an Android
pad's reality onto the frozen `DeploymentFacts` axes and calls `assessDeployment`.
It invents no eligibility rule; it can only assemble facts, and it assembles them
honestly.

**Derived on every summary, never stored.** The classification is recomputed under
the pair lock on EVERY summary, from live facts. It is never serialized — not into
`head.json`, not into the Android-only `pair.json`, not anywhere. That is the
property that makes it safe: a restore cannot re-present a stronger verdict than
the live facts warrant, because there is no stored verdict to restore. No
self-certifying verdict identifier and no pad-derived fingerprint exist in the
shipped code, and the machine guards below enforce it.

**The Android ceiling — derived from the platform, not hard-coded.** An Android
device has no TPM-anchored platform authority and no operator-pinned root of trust.
It therefore cannot ATTEST a ceremony, so the honest fact-assembly reports
`assuranceAuthority = unavailable` ALWAYS, and it holds no platform-monotonic
counter, so `rollback` is NEVER `platform-monotonic` (the android-local-witness is
the `separate-state-file` class — see the terminology note in §4). The single
strongest path in the evaluator requires BOTH of those facts, so **an Android pad
can NEVER be CONDITIONALLY ELIGIBLE.** The strongest verdict it can reach is
INSUFFICIENT EVIDENCE. Two outcomes are mandated and tested end to end: a pad whose
every source is the platform CSPRNG is a hard **NOT ELIGIBLE**; an
external-declared native pad is **INSUFFICIENT EVIDENCE**, never eligible. A
regressed or inconsistent witness is a positive disqualifier (NOT ELIGIBLE), not
merely unproven. None of this is a hard-coded "Android is insecure" flag: it is the
ordinary output of the shared evaluator over facts the platform genuinely
constrains.

**Where it is proven.** The pure decision is held to the canonical TypeScript by
`DeploymentCorpusTest` against the shared cross-language corpus
`android/vectors/deployment-evaluator-v3.json` (including
`noAndroidTupleIsEverConditionallyEligible` and
`theTwoAndroidSourceOutcomesAreExactlyAsMandated`). The honest assembly is held by
`DeploymentAssemblyTest`
(`aDeviceGeneratedPadIsNotEligibleBecauseTheSourceIsASoftwareCsprng`,
`anExternalSourcePadIsInsufficientNeverEligible`,
`theWitnessKindNeverRaisesTheVerdictAboveInsufficient`). The claims and machine
guards live in `AppSourceAuditTest` — no persisted verdict, no pad-derived
fingerprint, the UI never hard-codes a stronger label than the evaluator produces,
and no overstated vocabulary — and `HostileMutationMatrixTest` proves that
laundering the LOCAL witness to `platform-monotonic`, or any single-fact mutation
that would reach CONDITIONALLY ELIGIBLE, is caught with zero escapes.

---

## 5. Secret storage — no Keystore, and why

Pad material is stored as plain bytes in the app-private data directory. It is
**not** wrapped in an Android Keystore key, and this document does not claim
hardware backing.

That is a considered position, not an omission:

- Keystore protects a key, and the pad is not a key — it is up to megabytes of
  material read at random offsets on every operation. Wrapping it would mean
  decrypting through a Keystore-held key on every read.
- Doing so would make the at-rest protection **computational**. TruePad's message
  layer is information-theoretic; adding an AES-GCM envelope around the pad at
  rest does not weaken the message layer, but it would invite exactly the
  confusion this project works to avoid — and it must never be described as making
  the pad "information-theoretically protected", because it does the opposite of
  that at the storage layer.
- The honest protection today is Android's per-UID app sandbox plus file-based
  encryption while the device is locked, and that is what is claimed.

**Not claimed:** hardware-backed, StrongBox, biometric-gated, or protected against
an attacker with root, an unlocked bootloader, or physical access to a device in
the after-first-unlock state.

A future option worth its own design pass: mint a non-exportable Keystore key at
witness bootstrap and bind the *witness journal* to it, so a journal restored onto
a different device or profile cannot be read and fails closed rather than being
adopted. That strengthens rollback detection without touching the message layer.
It is **not implemented**.

---

## 6. Network, telemetry, and logging

The Android edition performs no network I/O of any kind, and the shipping APK
requests neither INTERNET nor ACCESS_NETWORK_STATE — both are deleted from the
merged manifest with `tools:node="remove"`, so the guarantee is enforced by the
OS rather than asserted here. `ScannerOfflineTest` proves on a handset that the
process cannot open a socket at all, with a positive control so the test cannot
pass vacuously.

There is no analytics SDK and no crash reporter, and no telemetry is sent. That
last point needs stating precisely rather than flatly, because it was flatly
wrong before: **ML Kit arrives with Google's datatransport stack, and the release
APK really was built carrying an enabled Firelog/Clearcut uploader** — a
`CctBackendFactory`, a `JobInfoSchedulerService` and an
`AlarmManagerSchedulerBroadcastReceiver`. The manifest now deletes all three
components. The datatransport CLASSES remain in the APK, because ML Kit
references them directly and removing the artifact fails R8; what is gone is
every entry point that could start them, and
`ScannerOfflineTest.noTelemetryUploaderComponentIsInstalled` asserts that against
the installed package.

**The engine modules are no longer dependency-free, and pretending otherwise was
the error this section carried.** `truepad-core` and `truepad-storage` still
depend on nothing beyond the Kotlin standard library and, for `truepad-storage`,
`truepad-core`. But `truepad-spt` — which ships — depends on **Bouncy Castle**
(`bcprov-jdk18on`) for X-Wing, and `:app` depends on ZXing (QR encoding), Google
ML Kit (QR decoding, bundled model, native `libbarhopper_v3.so`) and AndroidX
CameraX. See §12 and `docs/THIRD-PARTY-NOTICES.md`.

Nothing is logged. `android.util.Log`, `println`, `System.out`/`System.err`, and
`printStackTrace` do not appear anywhere in either module.
`DestructionAndSecretsTest.theEngineHasNoLoggingTelemetryOrNetworkSurface` is a
source-level audit that fails the build if any of them, or a network or analytics
dependency, is introduced — a behavioural test could not catch a leak that only
fires in production.

**Refusal messages are part of the secret boundary.** An Android exception message
reaches logcat, a crash reporter, and sometimes the screen. Refusals may name
lengths, offsets, sequence numbers, and counters — all already visible through
`status` — but never a pad byte, a Wegman–Carter key or mask, a plaintext, **or an
expected tag**. Telling whoever submitted a forgery what the tag should have been
hands them a verifying record for that sequence, so the expected tag is treated as
secret and is covered by the same test.

---

## 7. Format strictness — one deliberate divergence

The Kotlin reader is exactly as strict as `JSON.parse` in every respect but one,
and stricter in that one.

`isSafeCount` requires the ONE canonical decimal spelling. The TypeScript twin is
`Number.isSafeInteger(value) && value >= 0`, and because `JSON.parse` has already
folded `2.0` and `2e0` into the number `2`, it accepts those spellings too. The
Kotlin refuses them. No shipping writer emits one — `JSON.stringify` never does —
so the only inputs affected are hand-edited headers, and for those the strict
reading fails CLOSED.

Everything else is held to byte-parity by the released vectors, including two
traps that are easy to get wrong in Kotlin and are now regression-tested:

- **JavaScript property order.** JS emits integer-like object keys in ascending
  *numeric* order, never insertion order, so `perSequenceAttempts` must serialize
  `{"3":1,"5":2,"12":1}` however the failures arrived. A `LinkedHashMap` would
  emit insertion order and silently stop being byte-identical.
- **Lone surrogates.** `JSON.stringify` is well-formed (ES2019) and escapes an
  unpaired surrogate as `\udXXX`. Emitting it raw would both diverge from the
  released bytes and *corrupt the value*, because encoding a lone surrogate to
  UTF-8 substitutes `?`. An operator-chosen source-declaration name reaches this
  path.

---

## 8. Destruction

Identical to the release. `destroy` requires the pairId as confirmation (never
echoed — the operator confirms by knowing it), writes the durable tombstone
first, then best-effort zero-overwrites each `secret.bin`, then unlinks. The
tombstone, not the absence of files, is the irreversible boundary: every verb
afterwards refuses `pair-destroyed`, **including re-importing the pad's own
courier bundle**.

The stated limitation is repeated verbatim in the tombstone and is not softened
for Android, where it is if anything more true — flash translation layers,
wear levelling, and copy-on-write filesystems all keep old blocks:

> Software can forget its reference to pad material; it cannot prove that flash
> forgot the bytes.

### What "the tombstone is present" means, and why it is not `exists()`

The gate asks **is this path NOT KNOWN TO BE ABSENT** — not "is there a readable
regular file here". Only a definitive `ENOENT` counts as absence. Anything else
at the path (a directory, a symlink whose target is gone, a device node) and any
failure to decide (a permission error, an I/O error) reads as PRESENT and closes
the boundary.

This is not a robustness nit. The gate previously used the platform's ordinary
existence check, and every one of them — Node's `existsSync`, the JVM's
`File.exists()`, Foundation's `fileExists` — FOLLOWS SYMLINKS and answers
`false` for a link whose target is gone. A `destroyed.json` in that shape read
as absent, and a destroyed pair became usable again. That is pad reuse, which is
the one outcome TruePad may never allow, so all editions were corrected
together and are held to the same list of shapes by
`tests/terminal-marker-fail-closed.test.ts`,
`TerminalMarkerFailClosedTest.kt` and `TerminalMarkerFailClosedTests.swift`.

Content is deliberately NOT part of the question. A truncated, unparseable, or
foreign-pairId tombstone still closes the boundary; the reader keeps `exists:
true` through every parse failure. LOSS IS ACCEPTABLE; REUSE IS NOT.

---

## 8a. The application layer

```
Compose UI  ->  PadViewModel  ->  AndroidStorage  ->  Engine (:truepad-storage)
                                                        -> :truepad-core
```

The app is a PLATFORM BINDING and a user interface. It holds no state machine of
its own: it does not know what a sequence number is, never decides whether
something may be sent, and never advances a counter. It calls a verb off the main
thread and renders the result, and the engine's answer — including its refusal —
is authoritative.

**The UI's snapshot is never authoritative.** `pads` and `current` exist to draw
pixels. They are reloaded from the engine after every operation and on every
return to the foreground, so an activity that died mid-operation cannot leave the
operator looking at a stale count, and cannot conclude that an operation "did not
happen" merely because it was not alive to see it finish.

**Duplicate invocation** involves two different properties, and they are worth
keeping apart. The engine's per-pair lock is what makes REUSE impossible:
concurrent burns are serialised and each takes its own region, so no byte is ever
spent twice — that holds however the UI behaves. The ViewModel's mutex prevents
WASTE: without it, six rapid taps are six valid sends, and a one-time pad that
just spent six message slots on one message has lost something real even though
nothing was reused. The falsification round exercises both halves separately.
Disabling a button after the first tap is a courtesy on top of these, never a
control in its own right.

**Navigation is not security-critical.** There is no route table, no deep link
and no URL. Arriving at the send screen for a disabled pad produces exactly the
refusal it would produce anywhere else, because every gate is re-checked inside
the verb.

### Screen capture

`FLAG_SECURE` is set on the activity window BEFORE `super.onCreate`, so it covers
the first frame and the Recents thumbnail. The scope is the whole window rather
than a chosen set of screens: an opened message is plaintext, a composed message
is plaintext before it is sent, and the pad list names who you talk to — a subset
would be a list to maintain and to get wrong the first time a screen gained a
field.

It is a request the system honours. It is **not** a defence against a rooted or
compromised device, an accessibility service the user has granted capture rights
to, or a camera pointed at the screen. The app says so on screen.

### Clipboard

Nothing is copied except by a button the operator pressed, and only a message
they are already looking at — never pad material, keys, masks, tags or witness
state. On API 33+ the clip is marked `EXTRA_IS_SENSITIVE`, which asks the system
not to render a preview of it in the clipboard confirmation UI; that preview is
what would otherwise put a decrypted message on screen outside `FLAG_SECURE`.

The clipboard is a cross-application surface and TruePad cannot police it. The
app states plainly that another application may read it.

### Files in

Every file arrives through the Storage Access Framework, because the operator
opened a picker and chose it. The app holds no storage permission and declares no
intent filter for any content type, so **no other application can push anything
into it**.

What comes back is treated as hostile. The read is bounded at 64 MiB by what
ACTUALLY ARRIVES — the reported size is never consulted, so a provider that
claims one byte and streams forever is cut off rather than obeyed. A display name
is decoration only: never a path, never a decision, and stripped of separators,
control characters and bidi overrides before it is shown. The bytes are then
handed to the engine, which validates the whole bundle in staging before any of
it becomes active; a hostile bundle leaves no active pair and no staging behind.

### Files out

Export writes through `CreateDocument` to a destination the operator picked. The
app never chooses a location, never writes to shared storage, and never hands
another application a URI into the live store — the bytes written are a COPY the
engine produced. Sharing an encrypted message uses `ACTION_SEND` with plain text.

**There is therefore no FileProvider, and no `paths` XML.** That is the strongest
available answer to the question rather than a narrow configuration that has to
stay correct: with no provider authority of TruePad's own, there is nothing that
could resolve a URI into the pad store.

### Backup, in three places

| Mechanism | Setting | Why |
|---|---|---|
| `android:allowBackup` | `false` | The attribute the platform reads. Disables Auto Backup and adb backup. |
| `data_extraction_rules.xml` (API 31+) | `<exclude domain="root"/>` in BOTH `<cloud-backup>` and `<device-transfer>` | The interaction between `allowBackup` and device-to-device transfer has not been documented identically across releases, so the exclusion is stated outright for both channels rather than inferred from one attribute. |
| `backup_rules.xml` (API ≤30) | `<exclude domain="root" path="."/>` | Same policy where `fullBackupContent` is the mechanism. |

A pad is one-time material and a restored copy of one is the two-time pad this
product exists to prevent, so nothing here is asked to travel. `hasFragileUserData`
is `false`, so uninstall takes the data with it.

This is not a claim that the data cannot be extracted. It is a claim that TruePad
does not ask Android to carry it — and the rollback witness in
`getNoBackupFilesDir()` (§4) is the layer that still holds if some path carries
it anyway.

### The manifest surface

One exported component: the launcher activity, with a `MAIN`/`LAUNCHER` filter
and nothing else. No service, no receiver, no provider of TruePad's own, no
cleartext traffic, and exactly one capability-granting permission — CAMERA, to
scan a receive code. `androidx.startup` and ML Kit each merge in one un-exported
provider; `androidx.profileinstaller` merges in an exported receiver, which is
**removed** — an exported component for a feature the app does not use is surface
for nothing.

**The scanner dependency pulls in more than a decoder, and it is cut back
explicitly.** `com.google.mlkit:barcode-scanning` arrives with the Play Services
client stack and, through `com.google.mlkit:common`, Google's datatransport
stack — and it is datatransport that declares the permissions:
`transport-backend-cct` declares INTERNET and ACCESS_NETWORK_STATE, and
`transport-runtime` declares ACCESS_NETWORK_STATE (verified by reading the
manifests inside the resolved `.aar` files; `play-services-basement` declares
none, which an earlier version of this section wrongly claimed) — which put both into the shipping
release APK by merge, unnoticed, in an app that tells the operator it has no
transport of its own. The manifest now deletes both with `tools:node="remove"`,
so what ships asks for CAMERA and nothing else. ML Kit's `MlKitInitProvider`
could NOT be deleted the same way (ML Kit then throws "MlKitContext has not been
initialized"), so it stays, un-exported and package-scoped, pinned by name.

`ScannerOfflineTest` closes the loop on a handset: it shows the process cannot
open a socket at all — a positive control, without which the rest would prove
nothing — and that ML Kit still decodes a production-density symbol, which is
what makes "the model is bundled, not downloaded" an observation rather than a
reading of the vendor's documentation.

Two gates keep it that way, and neither can be satisfied by the other:
`ManifestHardeningTest` reads the INSTALLED debug package on a device, and the
`:app:verifyReleaseManifest` Gradle task parses the merged RELEASE manifest and
fails the build if anything but the launcher is exported, if any permission
beyond CAMERA appears, or if backup is turned back on.

A third gate was added after the INTERNET permission got in: `AppSourceAuditTest`
now reads the source manifest the way the MERGER does, separating entries that
request a permission from entries that delete one, and it requires both removal
lines to be present. The check it replaced asked whether the file contained the
text `android.permission.INTERNET` — true of a manifest that asks for it and
equally true of one that removes it, so adding the removals silently disarmed it.
`HostileMutationMatrixTest` pins that specific failure with its own row: delete a
removal line and the matrix reports an escape.

---

## 9. What the Android edition does NOT claim today

1. **It does not send or receive files as messages.** The engine encrypts
   arbitrary bytes, but Envelope v2 carries no filename and no content type, so a
   "send file" feature would need an Android-only container inside the envelope
   that the CLI and Browser Edition could not open. That is a format fork, and
   the app does not offer the feature rather than quietly create one.
2. It does not claim power-loss durability (§2).
3. It does not claim hardware-backed or Keystore-protected pad storage (§5).
4. It does not claim erasure of pad material from memory or from flash (§1.1, §8).
5. It does not claim protection against a compromised device, root, or an attacker
   who can already write to this app's private storage (§4).
6. It does not claim its rollback witness is an independent failure domain in the
   sense the CLI's `separate-state-file` or a TPM counter is (§4).
7. It does not claim its Sealed Pad Transfer delivery is information-theoretic.
   SPT **is implemented and ships** — the two items that used to stand here said
   the opposite, twice, and were written before the work landed. What is claimed
   is bounded: delivery is protected by post-quantum cryptography (X-Wing =
   ML-KEM-768 + X25519), which is a COMPUTATIONAL guarantee, and a pad that
   arrived sealed carries that fact permanently as sealed ancestry. It never
   becomes an information-theoretic delivery claim.
8. It does not claim to verify operator-supplied source material. TruePad records
   what the operator declares; a declaration is not evidence, and no inspection of
   supplied bytes could make it one.
9. **Emulator evidence is not physical-device evidence — and both now exist.**
   CI results come from an API 35 emulator, which says nothing about a real
   device's flash translation layer, its TEE, or a vendor's own backup path. The
   physical gate has since been run separately on a Samsung SM-A176U (Android 16);
   see §10. Neither substitutes for the other, and this document does not report
   emulator runs as handset runs.
   `android/tools/physical-device-check.sh` is the gate for that, and it REFUSES
   to run against an emulator rather than producing evidence that would read as
   hardware validation and is not.
10. An emitted encrypted message lives only in memory until the operator sends
   it. Leaving the screen loses the message — the pad material is already spent.
   That is the LOSS row, and the screen says so rather than pretending otherwise.
11. The `LOSS IS ACCEPTABLE` half of the invariant is load-bearing: a crash, a
   failed fsync, a severed witness, or a torn file can all cost a message or a
   pad. None of them may cost reuse.

---

## 10. Remaining work

Two items, and neither is a code feature. Both are kinds of evidence that cannot
be manufactured, listed with what would close them.

- **PHYSICAL-DEVICE VALIDATION — DONE** on a Samsung SM-A176U (Android 16):
  51 instrumentation tests and 15 on-device security checks passed. What remains
  on Android is **human TalkBack** and the **Android↔iPhone two-device
  ceremony**, neither of which an automated run can supply. To repeat it,
  connect one authorised handset
  and run:

  ```
  android/tools/physical-device-check.sh
  ```

  It refuses emulators, runs the full on-device gate on the handset, and then
  records what only real hardware can show: the store and witness paths as the
  device reports them, the installed package's backup flags, whether `adb backup`
  of an `allowBackup="false"` app yields anything, and whether a screenshot of a
  `FLAG_SECURE` window really is blank. It records TEE and StrongBox presence as
  device provenance only — TruePad makes no Keystore claim, and that line is not
  one.

- **HUMAN TALKBACK PASS — not yet performed.** `AccessibilityTest` sweeps every
  screen and holds every interactive node to labels, 48dp targets, roles,
  disabled state and heading structure, and `LargeFontTest` re-renders the
  warning copy at 2× font scale. That is a baseline, not a verdict: it cannot
  tell you whether the announcement order makes sense, whether the ceremony is
  followable by ear, or whether a refusal is comprehensible when read aloud.

Also open, none blocking:

- **Dependency currency.** Reviewed and deliberately not changed — see §12.
- **Translation and locale coverage.** One locale's copy ships today.

## 11. Invariant map (frozen protocol → Android substrate)

| FORMAT-V2 invariant | Android mechanism | Verified by |
|---|---|---|
| One-time use of encryption material | `nextOffset` advances durably before emit | `ReusePreventionTest` |
| One-time use of an auth record | `nextSequence` advances durably before emit | `ReusePreventionTest` |
| Burn before output | `commitAdvance` → witness advance → return | `CrashAndLifecycleTest` |
| Attempt reservation before verification | `reserveAttempt` at O3 | `ReusePreventionTest` |
| Finite forgery bound survives restore | witness `attemptsReserved` | `ReusePreventionTest`, `WitnessTest` |
| Rollback detection | witness in a separate storage domain | `WitnessTest` |
| Retirement is monotone | header reconciled against the journal high-water | `ReusePreventionTest` |
| A destroyed pad never resurrects | the durable tombstone | `DestructionAndSecretsTest` |
| Malformed input fails closed | strict grammar, typed refusals | `HostileInputTest`, `StoreFormatTest` |
| Byte-identical to v2.0.0 | golden trace from the released engine | `EngineTraceTest` |
| No secret leaves through an error path | refusal-message audit | `DestructionAndSecretsTest` |
| No telemetry | source-level audit | `DestructionAndSecretsTest`, `AppSourceAuditTest` |
| Store and witness in separate backup domains | `filesDir` vs `noBackupFilesDir` | `DeviceEngineTest`, `AppSourceAuditTest` |
| One exported component | manifest, both build types | `ManifestHardeningTest`, `:app:verifyReleaseManifest` |
| Backup excluded on every channel | manifest + two rules files | `AppSourceAuditTest` |
| Screens not captured | `FLAG_SECURE` on the window | `UiJourneyTest` |
| A picked URI is untrusted | bounded read, sanitised name | `HostileUriTest` |
| A double tap cannot spend twice | engine per-pair lock | `UiJourneyTest`, `CrashAndLifecycleTest` |
| The UI never caches consumable state | reload from the engine on resume | `UiJourneyTest` |
| Claims are not overstated | sentence-scoped claims lint | `AppSourceAuditTest` |
| The deployment classification is derived, never stored | recomputed per summary; no verdict in either stored format; never above INSUFFICIENT on Android | `DeploymentCorpusTest`, `DeploymentAssemblyTest`, `AppSourceAuditTest`, `HostileMutationMatrixTest` |
| Every interactive control is announceable and reachable | whole-tree semantics sweep | `AccessibilityTest` |
| Warnings are never clipped | re-render at 2x font scale | `LargeFontTest` |
| No secret in accessibility metadata | semantics-tree scan | `AccessibilityTest` |
| No raw control byte in any source file | byte scan of the whole tree | `AppSourceAuditTest` |
| The on-device suite actually ran | JUnit XML parsed, classes and counts asserted | `tools/verify-instrumentation.sh` |

---

## 11.5 The operator's role: derived from the pad, never defaulted

**A REUSE defect found in the release-candidate audit and fixed before the RC was
frozen.** Android carried a single GLOBAL `UiState.role = Party2.A`, shared by
every pad, behind a Security-screen radio labelled "Implementation detail. You
never need this to use TruePad."

Two devices holding one pair therefore both burned `A_TO_B` — the same encryption
offsets and the same one-time Wegman–Carter authentication record. No engine
could catch it: each store's counters advance monotonically on its own copy, so
the reuse is ACROSS copies, not within a store.

The role is now derived per pad from `PairMeta.origin` by
`PartyRole.derive` — `GENERATED_HERE` → A, `IMPORTED` → B — and an `UNKNOWN`
origin returns null so the operator is asked rather than guessed at. Sending and
opening both fail closed on a null role. Refusing is LOSS, which this project
accepts; guessing is REUSE, which it does not. The same defect existed in the iOS
and Browser editions and is closed the same way. No wire changed.

---

## 12. Dependency currency — reviewed, deliberately unchanged

Reviewed at closure. Nothing here has a concrete security or build-support
problem, so nothing was upgraded: this phase closes evidence gaps, and swapping a
toolchain underneath the evidence would invalidate it. Recorded so the next
person inherits a decision rather than a silence.

| Component | Pinned | Current | Assessment |
|---|---|---|---|
| **Bouncy Castle** (`bcprov-jdk18on`) | **1.85.2** | 1.85.x | **The only third-party CRYPTOGRAPHIC runtime dependency the Android Edition ships**, and the only entry in this table whose currency is a security question rather than a maintenance one. Used through the low-level `org.bouncycastle.pqc.crypto.*` / `crypto.*` APIs for ML-KEM-768 and X25519 — the two halves of the X-Wing KEM that protects pad **delivery**. It is **not** on the OTP message path: `truepad-core` links no cryptography library, so no Bouncy Castle change can alter the frozen message wire. No applicable unpatched advisory identified at this pin. |
| Gradle | 8.14 | 9.x | Behind but acceptable. 8.14 builds clean with zero deprecation warnings. |
| AGP | 8.7.3 | 9.x | Behind but acceptable. Caps `compileSdk`/`targetSdk` at 35, which is why `OldTargetApi` is suppressed. Raising it is the head of the upgrade chain. |
| Kotlin | 2.0.21 | 2.2.x | Behind but acceptable. |
| Compose BOM | 2024.10.01 | 2026.08.00 | Behind but acceptable. Provides the `DeviceConfigurationOverride` the font-scale tests need. |
| androidx.core / lifecycle / activity | 1.13.1 / 2.8.7 / 1.9.3 | newer | Behind but acceptable. |
| kotlinx-coroutines | 1.9.0 | 1.10.2 | Behind but acceptable. |
| AndroidX test / Espresso | 1.6.x / 3.6.1 | 1.7.x / 3.7.0 | Behind but acceptable; test-only. |
| `actions/checkout`, `setup-java`, `setup-node`, `upload-artifact` | v4 | v7, v6, v7, v7 | Behind by majors. Still supported and green. Worth raising when GitHub next deprecates a runtime — that is a maintenance trigger, not a security one. |
| `android-actions/setup-android` | v3 | v4 | Behind by one major. |
| `gradle/actions/setup-gradle` | v4 | v6 | Behind by two majors. |
| `reactivecircus/android-emulator-runner` | v2.38.0 | v2.38.0 | **Current**, pinned to an exact tag. |

**Security-sensitive updates advisable: none identified.** Note that this table
previously omitted Bouncy Castle entirely — the one component here whose currency
is genuinely a security question — while still concluding that none was advisable.
It is now listed first.

**Bouncy Castle IS a cryptographic dependency, and the sentence that used to end
this section denied it.** It said "No pinned component is a cryptographic
dependency — the engine has none", which contradicted the table immediately above
it. The accurate statement: `truepad-core` and `truepad-storage` depend on
nothing but the Kotlin standard library, and the OTP and Wegman–Carter message
path is implemented there with no third-party cryptography at all. `truepad-spt`
is the exception and the only one: it uses Bouncy Castle's
`org.bouncycastle.pqc.crypto.xwing` for SPT key establishment. Bouncy Castle is
confined to pad DELIVERY and does not touch the message path.

`:app` additionally ships ZXing (QR encoding), Google ML Kit (QR decoding, with a
bundled model and the native `libbarhopper_v3.so` on the camera-input path) and
AndroidX CameraX. None of those is on the message path either.

Nothing is classed obsolete or problematic. Modernisation is its own task with
its own re-validation, and should not be folded into a closure pass.
