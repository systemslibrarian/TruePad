# Notes for App Review

*Draft, for the App Review Notes field. Written to be usable by a reviewer with one
device and no account.*

---

**What TruePad is.** An educational cryptographic utility about one-time pads. Two
people create a shared pad, give each other a copy, and then send messages that are
encrypted with that pad. The interesting part is not the encryption — it is
everything required to keep pad material single-use across crashes, restores and
two copies of the same pad.

**There is no account and no backend.** Nothing to sign up for, nothing to log in
to. The app makes no network requests at all; it links no networking framework. It
works fully offline, and airplane mode is a reasonable way to review it.

**Why the camera permission exists.** Only to scan a QR code containing a *public*
receive code, so one phone can read it off another's screen. It is requested when
you tap Scan, never at launch. Camera images are not saved and not uploaded.

---

## What a reviewer can do with a single device

All of this works on one device, with no second installation:

1. **Create a pad.** Pads tab → *Create a pad*. Give it a name, accept the default
   size, create. The pad opens directly.
2. **Send a message.** *Send message*, type anything, encrypt. You are shown the
   encrypted message and offered Copy and Share. That string is ciphertext and is
   meant to be shareable.
3. **Open your own message.** Go back, choose *Open message*, and paste what you
   just copied. It will be **refused** — and that refusal is correct, not a bug.
   Each direction of a pad belongs to one side, so a pad cannot open a message it
   sent. See the note below.
4. **Watch the pad get used up.** The pad screen shows remaining capacity, which
   decreases as you send. Send a few messages and watch it fall.
5. **Create a receive code.** Inbox tab → *Create a receive code*. This shows a
   code and a QR image. It is public information and is what the other person
   scans.
6. **Scan a QR code.** With the receive code on screen, the Scan control is the
   camera path. Pointing it at another phone showing a receive code is the intended
   use, and is what needs a second device.
7. **Read the claims.** The About tab states plainly what TruePad does and does not
   guarantee.

## What genuinely needs a second installation

Completing a pad transfer, and opening a message written by the other side. Both
require two devices because a pad has two ends by design. If a second device is
convenient, installing TruePad on it and using *Create a receive code* on one and
*Scan* on the other exercises the whole flow.

## Two behaviours that look like bugs and are not

**A decrypted message has no Copy, Save or Share, and its text cannot be selected.**
This is deliberate. Decrypted message text stays inside the app and is display-only.
Received **files** *can* be saved — saving them is the point of sending a file — and
encrypted transports (the message you send, and the receive code) remain fully
copyable and shareable, because those are ciphertext and public request material
rather than plaintext.

**A pad refuses to open a message it sent.** Direction is a durable property of the
pad, not a per-device choice: a pad created here is one party, an imported pad is
the other, and a pad whose origin is unknown refuses rather than guessing. This
prevents both copies of a pad from spending the same key material twice.

## What TruePad does not claim

The About screen says this, and the app's wording is kept consistent with it.
TruePad does **not** claim to be unbreakable, anonymous, or proof against a
compromised device. It does not claim to prove that a random source was truly
random, that deleted data was physically erased, or that anyone actually compared
the confirmation words. It states the assumptions its guarantees rest on rather
than implying they always hold.

## Contact

Support and issue reporting: see the repository linked from the App Store listing.
