# Remaining physical and human gates

> **STATUS — read this before citing anything below.**
>
> | Gate | State |
> | --- | --- |
> | A. Android → iPhone sealed transfer | **EXECUTED** (with the qualification in §A) |
> | B. iPhone → Android sealed transfer | **EXECUTED** (with the qualification in §B) |
> | C. Human TalkBack (Android) | **NOT EXECUTED — NON-BLOCKING** |
> | D. Human VoiceOver (iOS) | **NOT EXECUTED — NON-BLOCKING** |
> | E. Physical Linux TPM 2.0 | **NOT EXECUTED — NON-BLOCKING** |
>
> The non-blocking designations are a standing decision by the project owner,
> recorded in [`RELEASE-CHECKLIST-3.0.md`](RELEASE-CHECKLIST-3.0.md), which is the
> canonical authority. NOT EXECUTED means exactly that: zero steps observed, no
> partial pass inferred.

This document has twice carried a status line that was wrong in opposite
directions — first "NONE EXECUTED" long after the handset work was done, then a
corrected banner sitting directly above a preserved "Nothing in this document has
been performed" note that contradicted it. Both are gone. The table above is the
only status statement here, and each section repeats its own.

These are the gates no automated run can supply — not because anyone forgot them,
but because a machine cannot stand in for a second handset, a human ear, or real
hardware. Every procedure remains written to be re-run.

**What is already done, and is NOT in this document:**

- iOS: installed and launched on an iPhone 12 / iOS 18.6.2, with 9 on-device
  automated tests passing.
- Android: `android/tools/physical-device-check.sh` on a Samsung SM-A176U
  (Android 16) — the 44-test instrumentation suite of that commit, and the
  on-device security gate, both passed. The suite is 55 today and the classes
  added since have not run on that handset; the gate's check count varies by
  device and is deliberately not quoted as a fixed number
  (docs/ANDROID-SECURITY.md §10). The two-device exchange in `CrossEditionTest`
  is NOT part of that 55: it takes runner arguments, is excluded from the default
  run by annotation, and is invoked by name from the physical harness.

**A note on evidence.** Each procedure asks for artefacts. Record them verbatim,
including failures. A gate that "passed but we did not keep the photographs" has
not passed. And nothing here promotes software observation into physical proof:
these procedures establish what a person saw a device do, which is exactly and
only what they claim.

---

## A. Android → iPhone sealed pad transfer (optical ceremony)

**STATUS: EXECUTED** — Samsung SM-A176U ↔ iPhone 12, optical QR read by each
phone's own camera. **Two qualifications, which must travel with every citation of
this result:** the word comparisons were performed by AUTOMATED comparison, not
spoken between two people; and the message carriers were host/test carriers, not
optical. The procedure below therefore remains unexecuted *as written* — a human
spoken ceremony has still not been performed.

**What it proves.** That a pad sealed on Android is delivered to, and opened by,
iOS across the real optical path, and that the twelve- and eight-word comparisons
render and match on two different platforms. It does **NOT** prove that two people
read them aloud to each other: the comparisons were made by AUTOMATED comparison,
exactly as the banner above says. An earlier version of this paragraph said "two
people actually read aloud", which contradicted its own banner and is the precise
overclaim the qualification exists to prevent.

**What it does NOT prove.** Anything information-theoretic. `.tps2` delivery is
computational, permanently. This gate is about interoperability and the human
ceremony, not about the strength of the delivery.

**Setup.** Two people, two handsets, in the same room. Android build from the RC
SHA, iOS build from the same SHA. A disposable pad on the Android device — never
an operational pad.

1. **iPhone publishes.** Inbox tab → *Create a receive code*. The screen
   shows a QR and twelve words. Photograph both.
2. **Android scans.** Send a pad → *Scan a code*. Point the Android camera at the
   iPhone screen. Record the lighting and distance; record any retries.
3. **Compare the twelve words aloud**, iPhone reading, Android listening. They
   must match exactly and in order. Photograph both word lists side by side.
   - **If they do not match: REJECT on Android and stop.** That is a successful
     run of this gate, not a failure — record it and report it.
4. **Android seals.** Choose the disposable pad. Android shows eight confirmation
   words. Photograph.
5. **Compare the eight words aloud.** Both devices must show the same eight.
6. **Android hands over the `.tps2`** by the share sheet — AirDrop, Files, or a
   messaging app. The share sheet is a CARRIER; TruePad has no transport of its
   own and nothing here should suggest otherwise.
7. **iPhone opens it**, compares its own eight words, and saves.
8. **Send one message each way** and open it on the other device.
9. **Check the disqualifier.** On both devices the pad's deployment assessment
   must record a sealed ancestor and must NOT read as information-theoretically
   delivered. Photograph both.
10. **Re-scan the spent request.** Repeat step 2 against the same iPhone request.
    Expected: refused as consumed. Photograph the refusal.

**Record:** both device models and OS versions, the RC SHA, every photograph,
the wording of every refusal, and the elapsed time.

---

## B. iPhone → Android sealed pad transfer

**STATUS: EXECUTED**, with the same two qualifications as §A: automated word
comparison rather than a spoken ceremony, and host/test message carriers rather
than optical ones.

The mirror of A, and it must be run separately: the two directions exercise
different code on both devices — a different sealer, a different opener, a
different camera stack, a different share sheet.

Run A's steps with the roles exchanged: **Android publishes** the receive request,
**iPhone scans and seals**, iPhone shares the `.tps2`, Android opens it.

Pay particular attention at step 3 to the twelve words rendering on Android's
screen while an iPhone camera reads the QR beside them — that combination is not
exercised anywhere in A.

**Record:** the same artefacts as A, kept separately. Do not merge the two runs.

---

## C. Human TalkBack pass (Android)

**STATUS: NOT EXECUTED — NON-BLOCKING** by project-owner decision. No human has
run the app end to end under TalkBack; zero steps were observed. The automated
`AccessibilityTest` and `LargeFontTest` are baselines and are not a substitute.

**What it proves.** That a blind operator can use TruePad, and that what TalkBack
announces is TRUE. The automated tests assert that labels exist and describe
meaning; they cannot hear the result.

**Run it with TalkBack on for the whole session**, on the physical handset, from
a cold start.

1. **Create a pad** end to end without sighted help.
2. **Read the meters.** TalkBack must announce what each number MEANS, not just
   the number — "you can still send four messages", not "four".
3. **Read the deployment assessment.** It must be announced as an assessment,
   with its reason.
4. **Send a message and open one.**
5. **Reach a refusal deliberately** — open a malformed envelope. The refusal must
   be announced, and it must say whether anything was consumed.
6. **Attempt a destruction and abandon it.** The confirmation prompt must be
   announced WITHOUT the identifier it is asking for.
7. **Walk the ceremony screens.** The twelve and eight words must be individually
   addressable and announced with their position — "word four is anchor".
8. **Look for traps:** any control that cannot be reached, any focus that cannot
   escape, any announcement that states more than the product claims.

**Record:** session notes, and an audio or screen recording if the operator
consents. Record every place the announcement was wrong or misleading, however
small — those are defects, and they are the reason this gate exists.

---

## D. Human VoiceOver pass (iOS)

**STATUS: NOT EXECUTED — NON-BLOCKING** by project-owner decision. No human has
run the app end to end under VoiceOver; zero steps were observed.

The same as C, on the iPhone, with VoiceOver on for the whole session.

Two iOS-specific additions:

9. **The envelope and the receive-request text.** Both carry a deliberate
   accessibility label that DESCRIBES them rather than reciting base64. Confirm
   the operator can still copy them, and that the description is accurate.
10. **The decrypted message.** It is deliberately NOT selectable, so it cannot
    reach the general pasteboard. Confirm VoiceOver still reads it, and that the
    operator is not left believing the message is unavailable.

**Record:** as in C.

---

## E. Physical Linux TPM 2.0 validation

**STATUS: NOT EXECUTED — NON-BLOCKING** by project-owner decision. All TPM
evidence in this project is swtpm EMULATOR interoperability and is never to be
promoted past that.

See **`docs/PHYSICAL-TPM-VALIDATION.md`**, which is written to be executed as-is.

Two things in it matter more than the rest:

- **Step 0 pins the TCTI.** Every `tpm2_*` command obeys `TPM2TOOLS_TCTI`, and
  this repository ships a script that exports it pointing at swtpm. Without Step 0
  a shell that has run the emulator interoperability job will send the entire
  "physical" procedure to that emulator and produce a completely green run that is
  not physical evidence at all.
- **swtpm is never physical evidence.** The `test:tpm-interop` CI job is
  interoperability evidence only, and says so in its own job name.

---

## What none of these gates are

None of them is an independent human security review. That is **not** a release
blocker for this project — a standing decision, recorded in
`docs/RELEASE-CHECKLIST-3.0.md` §C. `docs/INDEPENDENT-REVIEW-BRIEF.md` is a
standing offer to reviewers, not a gate.
