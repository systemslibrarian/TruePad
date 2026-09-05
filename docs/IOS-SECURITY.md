# TruePad 3 iOS Edition — security & durability claims

**Status: DEVELOPMENT. Not released, not tagged, not on the App Store.**

This document states what the iOS Edition claims, what it does not, and where the
line runs. It is written to the same standard as `ANDROID-SECURITY.md`: every
claim names its evidence, and every limitation is written down rather than left
to be discovered.

The governing rule is unchanged:

> **LOSS IS ACCEPTABLE; REUSE IS NOT.**

And the claims boundary is unchanged:

> **PQC protects pad delivery. OTP encrypts messages. Wegman–Carter authenticates
> messages.**

Nothing in this edition promotes software evidence into proof of physical
secrecy, randomness, erasure, exclusivity, or hardware monotonicity.

---

## IMPLEMENTATION STATUS AT THE TIME OF WRITING

This document describes the iOS Edition's security design. Some of it is built
and tested; some is specified here and not yet built. Saying which is which is
part of the point.

| Area | Status |
| --- | --- |
| X-Wing / SPT crypto, byte-exact | **BUILT**, cross-edition corpora green |
| OTP kernel (POLYVAL, WC tag, partition, frame) | **BUILT**, frozen vectors green |
| v2 envelope wire + strict JSON | **BUILT**, 20-case refusal corpus green |
| Durable file layer (`DarwinFs`) | **BUILT**, both backings tested |
| Store Format v2 (head/journal/reconcile) | **BUILT**, byte-exact vs frozen fixture |
| Rollback witness (Fs-backed, engine level) | **BUILT**, incl. the weak-configuration test |
| OTP verbs (gen/send/open/retire/destroy) | **BUILT**, orderings tested by interruption |
| Product bookkeeping (pair.json, tombstone, handoff) | **BUILT**, byte-exact vs the released CLI and Android |
| Courier bundle (export/import) | **BUILT**, byte-exact vs the released v2.0.0 container |
| Rollback witness — Keychain failure domain | **BUILT**; logic tested, PLATFORM behaviour unverified (see §5) |
| SPT durable state machine | **BUILT**, receiver + sender gates tested by fault injection |
| SPT verbs (review / confirm / seal / open / commit) | **BUILT**, ceremony green end to end on two engines |
| Deployment evaluator | **BUILT**, held to the shared cross-edition corpus |
| TP2 compact envelope transport | **BUILT**, byte-exact vs the released corpus; `open` takes either spelling |
| SwiftUI application layer | **BUILT**; security-carrying decisions tested, layout/VoiceOver are the human gate |
| Native app target (`ios/TruePadApp`) | **BUILT** — Debug and Release for `generic/platform=iOS`, minimum OS 16.0 verified on the binary |
| Installed/launched on a physical iPhone | **DONE** — installed and launched on an iPhone 12 running iOS 18.6.2; process stable across repeated cold starts, and app-private storage created under `Library/Application Support/TruePad` |
| On-device state/lifecycle/camera pass | **RUNS** on an iPhone 12 / iOS 18.6.2 via `ios/TruePadApp/TruePadAppUITests`. Covers lifecycle, durable consumption across a force-quit, a refused forgery consuming no pad material, a refused destruction, receive-request durability and terminal cancellation, and no camera prompt from ordinary navigation. A COMPLETED destruction and a full on-device round trip are NOT covered — see `REVIEWER-START-HERE.md` |
| Human VoiceOver validation | **OUTSTANDING** (human gate) |
| Physical iPhone validation | **OUTSTANDING** (hardware gate) — installation and launch are NOT the same as validation; see §11 |
| Android↔iPhone two-device ceremony | **OUTSTANDING** (human gate) |

A claim in this document about an unbuilt component is a **specification**, not
evidence. Do not cite it as evidence.

---

## 0. What is the same, and what is different

**The same.** The wire is frozen and shared. This edition reproduces the X-Wing
draft-10 Appendix-C vectors, the `wc-one-time-v1` canonical bytes and tags, the
`partition-v2` four-slice layout, the `frame-v2` fixed records, the v2 envelope
grammar and its typed refusals, `head.json` byte-for-byte including JavaScript
property order, and the Sealed Pad Transfer TPR2/TPS2 formats — all against the
same committed fixtures the Browser and Android Editions answer to. Cross-edition
interop is demonstrated in all four directions, not asserted.

**The different.** The substrate. iOS is not Linux and not Android, and three
differences matter enough to name up front:

1. **`fsync()` is not a durability barrier on Darwin.** It pushes bytes out of
   the kernel and into the drive, which may still hold them in its own write
   cache. Apple provides `fcntl(F_FULLFSYNC)` for callers that need the real
   barrier. Every sync in this edition is `F_FULLFSYNC`.
2. **There is no `getNoBackupFilesDir()`.** Android gets a second storage root
   that its backup system contractually skips, which is what gives the Android
   witness a different failure domain from the store. iOS has no such directory.
   §5 explains what is used instead, and why it is weaker.
3. **The watchdog, not the ANR killer.** A verb that blocks too long gets the app
   killed mid-transition. Locks are bounded and refuse rather than wait.

---

## 1. Architecture: where secrets live

```
TruePadCore      the OTP kernel. Depends on NOTHING — no crypto library at all.
TruePadStorage   the durable store over an Fs abstraction.
TruePadSPT       Sealed Pad Transfer. The only module that links swift-crypto.
TruePadKATSupport  test-only. NOT a package product. Unreachable from the app.
```

`TruePadCore` linking no cryptography library is the iOS statement of the same
separation Android makes (its `truepad-core` is pure Kotlin, with Bouncy Castle
reachable only from `truepad-spt`). The OTP message path is information-theoretic
and owes nothing to any library: no library change can alter the frozen message
wire, and no library has to be trusted for it. `ProductionIsolationTests` enforces
this from both directions — the manifest declaration and the kernel's own imports.

### 1.1 In-memory hygiene — best-effort, and named as such

`SptBytes.wipe` zeroes buffers this code owns. It does **not** prove a copy the
Swift runtime made is gone, that the allocator forgot the bytes, or that physical
RAM was erased. Swift values are copy-on-write and the optimiser is free to move
them. This is hygiene, not erasure, and it is never counted as evidence.

---

## 2. Storage, and exactly what "durable" means here

`DarwinFs` is the production backing.

- **Whole-file replace** (`head.json`, markers): create the temp file with its
  Data Protection class and `0600` **before any bytes are written** → write →
  `F_FULLFSYNC` → `rename(2)` → `F_FULLFSYNC` the parent directory.
- **Append** (`journal.log`, the witness journal): append → `F_FULLFSYNC`, and on
  the append that **creates** the file, sync the parent directory too. Syncing a
  file descriptor persists the file's *contents*, not its *directory entry*, so
  without that a creating append can be lost whole — and the journal and witness
  journal are both created by their first append.
- **Positioned write** (the destruction zero-overwrite): write → `F_FULLFSYNC`.

### What is claimed

> The bytes reached the app-private container and were flushed with
> `F_FULLFSYNC`. A process death, an app termination, or an ordinary reboot after
> that point is survived.

### What is NOT claimed

- **Not power-loss atomicity across the state machine.** `F_FULLFSYNC` orders one
  file's bytes. It does not make a multi-file transition atomic. The engine's
  answer to a torn transition is ordering plus fail-closed readers, not a claim
  that torn states cannot happen.
- **Not secure erasure.** `writeRange` with zeros clears the **logical** bytes.
  APFS is copy-on-write over flash with wear levelling, so previous physical
  blocks may persist until the controller reuses them. **No userspace API on iOS
  can establish that a byte is physically gone, and TruePad does not claim it.**
  What the zero-overwrite buys is that the material is no longer reachable
  through the file — which is what stops REUSE, and is a different and weaker
  statement than erasure.
- **Not a guarantee that `F_FULLFSYNC` is honoured all the way down.** It is the
  strongest barrier the platform offers. If a filesystem refuses it, `DarwinFs`
  falls back to `fsync()` **and sets an observable flag**, so the weaker
  guarantee can be reported rather than silently assumed.

### File modes and container isolation

Files are `0600`, directories `0700`, matching the released CLI. On iOS this is
**belt and braces, not the protection itself**: the app container is already
isolated per-app, and that isolation — not the mode bits — is what keeps other
apps out. The modes matter when a store is copied to a shared location or a
desktop, so it does not silently widen.

### Data Protection

New files are created with a Data Protection class, applied at creation so the
secret body never exists on disk unprotected, not even briefly. The default is
`.completeUnlessOpen` rather than `.complete`, and the trade is deliberate: a
store must remain writable while the device is locked if a verb is already in
flight, and `.complete` would fail those writes outright. A caller may choose the
stronger class.

**What Data Protection is and is not.** It encrypts at rest with a key tied to
the device and, for the stronger classes, the passcode. It is **not** proof of
erasure, **not** a monotonic counter, and **not** a hardware attestation of
exclusivity. A device with no passcode has materially weaker protection, and
nothing in the app can compel one.

### Single writer

Every verb runs under `Fs.withLock(pairId)`: an in-process lock **plus** a real
`flock(2)`, so two processes cannot both advance one pair.

Both layers are **bounded** at 10 seconds and then refuse `locked`. Unbounded
blocking is specifically wrong on a phone: a verb runs behind a UI action, and a
long wait gets the app killed by the watchdog — a crash at an arbitrary point in
the state machine. A refusal is free and consumes nothing; a kill is not. Both
layers poll rather than block, because a blocking acquire would reintroduce the
wait the timeout exists to prevent.

---

## 3. Commit ordering — the two rules that matter

**BURN-BEFORE-OUTPUT.** `send` writes the advanced `head.json`, then appends the
`send` journal line, then advances the witness, and only then does the envelope
exist outside the call.

**PERSIST-BEFORE-USE.** `open` appends the `attempt` reservation and advances the
witness *before* the tag is verified, and durably retires both namespaces *before*
the plaintext is released.

If any of those durable writes fails, the operation throws and **the output is
withheld**. The material is spent and the message is lost. That is the trade.

The one deliberate inversion: an authentication FAILURE appends its `auth-fail`
line *before* rewriting the header, exactly as the released implementation does.

**Why the header moves before the journal line.** A crash between them leaves a
header AHEAD of its journal, which loses a record but never replays one. The
opposite order would leave a header BEHIND its history, and the loader would have
to refuse the whole store. Both halves are tested.

---

## 4. Format strictness — deliberate divergences, both fail-closed

Two places where this edition refuses input the other editions would accept.
Both are refusals, never silent acceptance, and both are recorded rather than
hidden.

1. **Non-canonical numeric spellings in `head.json`.** The TypeScript check is
   `Number.isSafeInteger(v) && v >= 0`, which — because a JSON parser has already
   folded `2.0` and `2e0` into `2` — accepts those spellings. This edition
   requires the one canonical decimal spelling, as Android does. No shipping
   writer emits anything else, so the only inputs affected are hand-edited
   headers, and for those the strict reading fails closed.

2. **Lone surrogate escapes are refused outright.** Kotlin and JavaScript strings
   are UTF-16 and can hold an unpaired surrogate, which a well-formed
   `JSON.stringify` re-emits as `\udXXX`, so `head.json` round-trips. A Swift
   `String` cannot represent one at all. Substituting `U+FFFD` would parse such a
   file happily and then **re-serialize different bytes**, silently breaking the
   byte-exact interop that `head.json`'s whole claim rests on. So the reader
   refuses. A valid surrogate *pair* is combined normally; only genuinely
   unpaired input is refused. A store this rejects is one no ordinary text input
   can produce, and refusing to read it is the LOSS-over-REUSE answer.

---

## 5. Rollback witness on iOS — the design, and why it is weaker than Android's

**IMPLEMENTED, with one honest gap: the logic is tested, the platform behaviour
is not, and cannot be from here. Read §5.1 before citing any of this.**

A restore is the classic pad-reuse vector: put yesterday's store back, and every
byte spent since becomes spendable again. Worse, restoring only the header
refills a contested record's verification-attempt budget and defeats the finite
forgery bound.

A witness only detects a rollback **if it is in a different failure domain from
the thing being rolled back.** Android gets that for free:
`getNoBackupFilesDir()` is a documented directory its backup system skips. **iOS
has no equivalent directory.** So the design differs, and the assurance is
different too.

### What iOS actually offers, and what each thing is worth

**(a) The store itself is excluded from backup.** `isExcludedFromBackup` keeps
the store out of iCloud and Finder backups. This is not primarily a witness
mechanism — it is a *removal of the routine rollback path*. After an iCloud or
Finder restore, the store is not reinstated **old**; it is not reinstated at all.
That is LOSS, which is acceptable. It does not help against a container copied by
other means.

**(b) The witness lives in the Keychain, `ThisDeviceOnly`.** The Keychain is not
in the app container, so a copied or restored *container* meets a witness that
still remembers the true high-water and the true attempt budget, and the
operation refuses before anything is consumed.

`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` items are wrapped with a
device-bound key and **cannot be restored to a different device** — Apple
documents this. So device migration and restore-to-new-device do not carry the
witness across.

### What that relies on, precisely — and one thing it must NOT rely on

- **RELIED-UPON APPLE CONTRACT:** `ThisDeviceOnly` keychain items are device-bound
  and are not restorable to another device. This is documented behaviour.
- **RELIED-UPON APPLE CONTRACT:** `isExcludedFromBackup` keeps a file out of
  iCloud and Finder backups.
- **EXPLICITLY NOT RELIED UPON:** that keychain items survive app deletion.
  They historically do, but **Apple states this is an implementation detail and
  should not be relied upon** — iOS 10.3 beta briefly changed it before the
  change was rolled back. The design therefore must not assume a witness outlives
  an uninstall, and must fail closed if it does not.
- **VERIFIED BY OUR OWN TESTS** (once built): that the store root and the witness
  really are different domains, and that a store rewound underneath an untouched
  witness is refused.
- **NOT VERIFIABLE BY ANY SOFTWARE ON THE HANDSET:** that a particular restore,
  migration, or backup-extraction path honours these contracts.

### Fail-closed rules

- Witness present, store rewound → refuse `witness-regressed`.
- Store present, witness missing/empty/corrupt/partial → refuse
  `witness-inconsistent`. This is fail-closed **on purpose**: the app cannot
  distinguish "witness lost to an uninstall" from "attacker deleted the witness",
  and guessing in the attacker's favour is how reuse happens. The cost is that a
  genuinely lost witness makes the pad unusable. That is LOSS, and it is
  acceptable.

### The weak configuration, named rather than hidden

If a same-device restore from an **encrypted local backup** reinstates both the
container and the keychain together, the witness is restored alongside the store
and **detects nothing**. This is the exact analogue of Android's weak
configuration, and it will be demonstrated by a test rather than argued away.

### 5.1 What is verified, what is relied upon, and what is measured-impossible

`KeychainWitnessFs` implements the witness domain as an `Fs` over the
data-protection Keychain with
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, bound as the Engine's
`witnessFs`. `AfterFirstUnlock` so a verb can still advance the witness while the
device is locked; `ThisDeviceOnly` so the item is device-bound.

**VERIFIED HERE (8 tests):** that only the witness journal path shape is accepted
and every store path — `secret.bin` above all — is refused outright, so pad
material cannot reach the Keychain by construction rather than by discipline;
that store operations are refused, so this cannot be mis-bound as the store's
`Fs`; that wiping the container leaves the witness intact and the rewind is
caught; that a vanished witness fails closed rather than reading as fresh; and
that compaction preserves the high-water exactly.

**MEASURED, AND IT SHAPES THE DESIGN:** the data-protection Keychain returns
`errSecMissingEntitlement` (-34018) to an unsigned binary. This was probed
directly, not assumed. Consequently **neither `swift test` nor CI can exercise the
real Keychain backend at all** — only a signed app on a device can. That is why
the backend is an injected protocol: the logic above it is fully testable, and the
untestable part is isolated to one small type and named.

**RELIED UPON, NOT VERIFIED HERE:** that a `ThisDeviceOnly` item is genuinely
device-bound and does not migrate in a restore. That is Apple's documented
contract. It stays on the physical-iPhone gate.

**EXPLICITLY NOT RELIED UPON:** that Keychain items survive app deletion. Apple
states this is an implementation detail. The design assumes they may vanish and
fails closed when they do — which on iOS is a case that will actually occur.

**Compaction.** A Keychain item cannot grow without bound. Above a threshold the
journal is folded to its per-direction maximum, which is the same fold
reconciliation already performs, pre-computed — so it can only move the recorded
high-water UP and can never mask a rollback. A blob that does not parse is
preserved rather than folded away, and the reader fails closed on it.

### And to be explicit about what this is NOT

The Keychain is not a monotonic counter, not hardware-anchored, and **not a TPM**.
The Secure Enclave protects keys; it does not provide the desktop TPM's monotonic
counter authority, and this edition never describes it as doing so. The iOS
witness gives a different failure domain on the same device, and nothing more.

### The frozen head still says `witnessClass: "none"`

`head.json` carries `rollback: { witnessClass: "none", config: {} }`,
byte-identical to a CLI, Browser, or Android store. The iOS witness is a product
layer outside the frozen bytes. Consequently a store whose frozen `witnessClass`
is `separate-state-file`, `platform-monotonic`, or `remote-monotonic` is
**REFUSED, never downgraded** — accepting one while enforcing nothing would be
claiming a protection this edition does not provide. This is already implemented
and tested.

---

## 6. Backup, restore, and copy — the threat model, enumerated

| Scenario | Expected behaviour |
| --- | --- |
| App crash / process death | Survived after `F_FULLFSYNC`; torn writes refused closed |
| Reboot | Survived |
| App update | Container preserved; store and witness intact |
| App uninstall + reinstall | Container gone → store gone. LOSS, acceptable. Witness may or may not persist; design must not depend on it |
| iCloud backup | Store excluded → not captured |
| Finder/iTunes backup | Store excluded → not captured |
| Full-device restore (same device, encrypted backup) | **Weak configuration**: store and witness may return together → rollback undetected. Named in §5 |
| Restore to a NEW device | `ThisDeviceOnly` witness does not migrate → store without witness → refuse `witness-inconsistent` |
| Device migration | As above |
| Keychain reset | Witness gone → refuse `witness-inconsistent` (LOSS) |
| Restored/copied app container | Witness (outside container) still remembers → refuse `witness-regressed` |
| Files copy of a pad file | Creates an extra physical copy TruePad cannot track. See §7 |
| Duplicate pair directories | Must be refused, not merged |
| Stale head + newer journal | Refused `regressed-below-mark` (implemented, tested) |
| Newer head + stale journal | Accepted; loses a record, never replays one (implemented, tested) |
| Terminal marker damage | Fail closed |
| Copied tombstone | Must remain terminal |
| Copied metadata without authoritative state | Metadata is never authority (§8) |

Rows marked implemented are tested today. The rest are specifications until the
verbs, witness and SPT state machine exist, and will be tested as they land.

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

### The app-switcher snapshot — a copy iOS makes, not one TruePad writes

**Observed on a real iPhone 12, not inferred.** When TruePad leaves the
foreground, iOS renders the view hierarchy and writes it into the app's own
container at:

```
Library/SplashBoard/Snapshots/sceneID:dev.systemslibrarian.truepad-default/*.ktx
```

Six such files were written during one backgrounding on the handset, including a
`downscaled/` variant. This is normal iOS behaviour and it is what draws the
app-switcher card — but it means **whatever is on screen becomes a file**.

That matters here specifically because TruePad displays a decrypted message on
the Open screen and a message being composed on the Send screen. A snapshot of
either is plaintext at rest: it is outside the store, so the store's
`.completeUnlessOpen` protection class and its backup exclusion do not describe
it, and it survives a force-quit.

**What TruePad does about it.** `TruePadRootView` covers the interface whenever
the scene is not `active`, including the sheet it presents, so the render iOS
captures is the cover rather than the content. The rule is in `ScreenPrivacy`,
which is tested — the important part being that it fires on `inactive` and not
only on `background`, because the snapshot is taken during that transition.
Covering only at `background` produces an app-switcher card that looks blank
while the file on disk still holds the plaintext.

**What this does NOT claim.** It does not remove snapshots iOS has already
written, it does not stop a screenshot the operator takes deliberately, and the
*contents* of a post-fix snapshot have not been decoded and inspected on the
handset — that needs the on-device UI pass that is still outstanding. What was
verified on hardware is that the snapshot files are written at all, and that the
build carrying the cover installs, launches, backgrounds, and stays resident.

---

### A published receive request outliving the screen that showed it

**Found on the handset, by a test that could not pass.** The Receive tab held the
published request in memory only. `request.json` and `dk.bin` were durable and
nothing ever read them back, so a force-quit left a LIVE one-time key pending on
disk that the interface could no longer reach.

What that cost was not the key — the engine's one-time property held throughout,
and `sptOpen` still read terminality from disk. What it cost was every operator
action on it: the request could not be cancelled, the twelve words could not be
shown again, and — the one that matters — it could not be **rejected**. Rejecting
is how a word comparison that does not match is supposed to end, and there was no
longer a way to do it. The key stayed pending until it expired or a package
consumed it.

`Engine.sptRestorePendingReceiveRequest()` now reads pending receiver state back
from the store and the tab adopts it on launch. The decapsulation seed is
deliberately **not** returned: everything above the engine needs the public
request, its words and its expiry, and nothing above the engine has any business
holding a private key. An expired or terminal request is not offered back.

---

### Two more copies iOS or SwiftUI makes, both closed

The app-switcher snapshot above was the first of these found by putting the app
on a handset. Auditing outward from it turned up two more. Both are the same
shape: **a copy of protected material, made outside the store, by a mechanism the
store's guarantees say nothing about.**

**The handoff scratch file.** Handing a pad over writes the WHOLE pad — or a
sealed package containing it — to a fixed name in the container's `tmp/` so the
share sheet has something to pass to another app. Nothing removed it. The file
was written BEFORE the sheet appeared, so cancelling still left it; and it
outlived `destroy`, which zero-overwrites `secret.bin` and unlinks the half
directories *inside* the store and never looks at `tmp/`. The engine believed the
material was gone while a complete copy of it sat on the device. The comment on
`ShareableFile` said the file "is removed afterwards", which was the intent and
was not the code.

It is now removed when the share sheet is dismissed — however it is dismissed —
and swept at every launch, because a process that dies while the sheet is up
never reaches the dismiss handler. **Removal is unlinking, not erasure**: the
destruction limitation applies to this file exactly as it applies to a pad.

There was no pad-reuse path through it — the pairId is tombstoned and `tmp/` is
not reachable by any file picker (`UIFileSharingEnabled` and
`LSSupportsOpeningDocumentsInPlace` are both false) — so this was residue, not a
reuse failure.

**Plaintext and the general pasteboard.** The Open screen rendered the decrypted
message with `.textSelection(.enabled)`. That routes text to the GENERAL
pasteboard, which is Universal-Clipboard-eligible: the one thing the pad exists
to protect could be copied to any Mac or iPad signed into the same Apple ID.

`LeakageAuditTests` bans the `UIPasteboard` symbol in shipping source, and a
declarative SwiftUI modifier walked around that ban without the symbol ever
appearing — which is the more general lesson: **a symbol ban does not cover a
declarative equivalent.**

The cause underneath was that `Egress` had no case for the decrypted message, so
`EgressPolicy`'s rule that pad material never reaches the clipboard had nothing
to say about plaintext, and `mayCopyToClipboard` was dead code no view consulted.
`Egress.plaintext` now exists and is refused for clipboard, QR and file alike, and
the Open screen no longer offers selection. The envelope on the Send screen keeps
it: an envelope is `publicText`, and copying it is the workflow.

---

## 7. Files, sharing, and extra physical copies

A pad or a sealed package that leaves the app through the share sheet or Files
becomes **a copy TruePad cannot track, count, or destroy.** Exporting raw pad
material for physical handoff is a deliberate, explicitly-confirmed operator
action, and the evaluator records that the pad took a physical route — it does not
pretend the copy does not exist.

AirDrop, Files, and the share sheet are **carriers only**. There is no TruePad
backend, no account, no BLE/MultipeerConnectivity/Wi-Fi/NFC protocol, and no
pad-in-QR. Physical proximity does not make an X-Wing-delivered pad
information-theoretic: **a sealed `.tps2` delivery is computational, permanently.**

---

## 8. What the deployment evaluator may NEVER claim on iOS

**NOT YET IMPLEMENTED. Specification.**

The evaluator derives an assurance classification from evidence. It must never
persist a verdict as authority, and on iOS specifically it may never conclude:

- that a pad is information-theoretically delivered when its ancestry includes a
  sealed `.tps2` — **sealed ancestry permanently disqualifies that claim, for both
  sender and receiver**;
- that a software CSPRNG is proof of physical entropy;
- that Keychain or Secure Enclave storage makes a pad TPM-class, or promotes it
  to the maximum-assurance class the Linux TPM path reaches;
- that an unknown import is anything better than unknown — **an unknown import is
  never upgraded**;
- that erasure, exclusivity, or hardware monotonicity has been demonstrated.

There must be no stored `perfectSecrecy` or `shannonSecure` authority field
anywhere. A source guard over Swift, Kotlin and TypeScript will enforce that.

**The iOS ceiling.** iOS is a legitimately weaker rollback-authority class than
the TPM-backed desktop path, and the evaluator must say so plainly rather than
rounding up.

---

## 9. Network, telemetry, and logging

The iOS Edition performs no network I/O, has no analytics, and logs no pad
material, private request keys, plaintext, or ciphertext. Unlike Android there is
no manifest permission to withhold, so this is enforced by source audit and build
inspection rather than by a declaration. Attributed precisely, because an earlier
version of this sentence credited the wrong mechanism:

- **The no-logging rule is enforced by a TEST**, `LeakageAuditTests`, which runs
  in CI over all five kit modules.
- **The release-binary inspection checks NETWORK-capable symbols**, and KAT,
  determinism, RSA and ASN.1 symbols. **It does not check for logging**, and no
  script in this repository does.

The source side of that is COMPLETE rather than sampled: every `.swift` file that
ships — the app target and all five kit modules, 47 files — was scanned with
comments stripped for `print`, `debugPrint`, `dump`, `NSLog`, `os_log`, `Logger`,
`OSLog`, `OSLogStore` and the common analytics SDK names, as CALLS rather than as
substrings. **There are none.** Comments are stripped because prose about not
logging must not be able to satisfy a check for logging.

**A binary check for logging is not meaningful, and is deliberately not
attempted.** Swift and SwiftUI force-load OSLog into any app that links them —
`__swift_FORCE_LOAD_$_swiftOSLog_$_TruePad` is present in the Release binary, and
`__os_log_impl` is among its imported symbols — whether or not a line of TruePad
calls them. A binary probe therefore cannot distinguish the app's own logging
from the runtime's, so claiming one would be a check that could never fail
honestly. The source audit is where this property is actually established.

The symbol checks that DO run are checked over **every Mach-O image in the
bundle**, not just the main executable. That distinction is load-bearing: a Swift
Debug build emits `TruePad.debug.dylib` and leaves the executable a thin
launcher, so a probe that reads only the executable sees ~120 symbols instead of
~115,000, and every "this symbol is absent" and "this framework is not linked"
check passes vacuously. Release has no debug dylib — verified: one Mach-O image,
77,220 symbols — which is why this survived until a Debug bundle was inspected on
a handset. What caught it was the positive control: the vendored X-Wing symbols
had to be FOUND and were not. **Negative checks cannot detect their own
vacuity**; only a check that must fire can.

What has NOT been done is a dynamic log capture from the handset: `log stream`
on this macOS has no device mode, and `devicectl device sysdiagnose` fails
against this device with the same error class as the UI-automation refusal. So
the no-logging claim rests on complete source and binary evidence, and not on an
observed device log.

---

## 10. Destruction

Destruction overwrites the secret body with zeros and marks the pair terminal. As
§2 states, this makes the material **unreachable through the file**; it is not
proof the physical blocks are gone. Retirement, by contrast, is logical — the
counters decide liveness, and `secret.bin` is not rewritten.

A destroyed or retired pair must never become usable again, including after a
container copy or a restore.

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

## 11. What the iOS Edition does NOT claim today

- No physical *validation* on an iPhone. The app has been **installed and
  launched on an iPhone 12 running iOS 18.6.2**, and that is all that phrase
  covers: the process starts, stays up, and creates its container. The state
  pass — pad creation, send/open, burn-before-output across process death,
  destruction staying terminal, receive-request one-time-ness across a relaunch,
  and the camera-permission sequence — has **NOT** run on hardware, because the
  handset would not enter UI-automation mode. **OUTSTANDING.**
- No human VoiceOver validation. Automated accessibility checks are not a
  substitute. **OUTSTANDING.**
- No two-device Android↔iPhone optical ceremony. **OUTSTANDING.**
- No independent human security review. AI-assisted audits are internal
  engineering review only. **OUTSTANDING.**
- No physical TPM hardware validation anywhere in the project. **OUTSTANDING**,
  and no emulator, VM, Secure Enclave, or Android keystore substitutes for it.
- No power-loss durability claim.
- No secure-erasure claim.
- No hardware monotonic rollback authority.

---

## 12. Invariant map (frozen protocol → iOS substrate)

| Frozen invariant | iOS mechanism | Status |
| --- | --- | --- |
| One writer per pair | in-process lock + `flock(2)`, bounded | BUILT |
| Burn before output | header → journal → witness → return | header/journal BUILT |
| Persist before use | attempt reservation before tag verification | NOT YET |
| No cursor rewind | `regressed-below-mark` on load | BUILT |
| Torn state fails closed | strict head/journal/secret validation | BUILT |
| Byte-exact wire | frozen fixtures, all four interop directions | BUILT |
| Sealed ancestry permanent | evaluator facts | NOT YET |
| Rollback detection | Keychain `ThisDeviceOnly` witness | NOT YET |
| Physical erasure | **not claimed by any mechanism** | N/A |
| Hardware monotonicity | **not claimed by any mechanism** | N/A |

---

## Sources for the Apple behaviour relied upon

- [`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — Apple Developer Documentation](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly)
- [Recovering keychain items after iCloud restore — Apple Developer Forums](https://developer.apple.com/forums/thread/738597)
- [iOS keychain values survive app uninstall — Apple Developer Forums](https://developer.apple.com/forums/thread/22874)
- [iOS 10.3 beta keychain autodelete change and rollback — Apple Developer Forums](https://developer.apple.com/forums/thread/72271)
