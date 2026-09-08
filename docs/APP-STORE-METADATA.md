# TruePad iOS — App Store listing draft

*Draft. Nothing here has been entered into App Store Connect.*

Positioned as an **educational cryptographic / security utility**, which is what it
is. Not positioned as a messenger, and explicitly not as a Signal alternative —
TruePad requires two people to exchange pad material by hand or by sealed transfer,
which is a deliberate cost, not a feature to be marketed around.

---

## Name and subtitle

- **Name:** `TruePad`
- **Subtitle (30 chars):** `One-time pads, done honestly`

## Promotional text (170 chars)

> Anyone can XOR. The hard part is keeping a one-time pad single-use across
> crashes, restores and two copies. TruePad is that problem, built and shown
> working.

## Description

> **The XOR is the easy part.**
>
> A one-time pad is the simplest cipher there is, and the hardest thing to deploy
> correctly. TruePad is a working, auditable implementation of the part nobody
> shows you: keeping pad material single-use when real software gets involved —
> crashes mid-write, a stale copy of a pad, two people who each think they hold the
> only one, a restored backup, a transfer that failed halfway.
>
> Every one of those is a chance to use a pad symbol twice, and reuse is the one
> failure a one-time pad cannot survive. So TruePad follows one rule, even where it
> costs something:
>
> **LOSS IS ACCEPTABLE. REUSE IS NOT.**
>
> Forced to choose between losing pad material and risking that a symbol serves
> twice, TruePad loses the material.
>
> **What it does**
> • Create a pad and share it with one other person — in person, or as a sealed
>   package over an ordinary channel. That sealed delivery is protected by
>   post-quantum computational cryptography. The messages themselves are
>   protected by the pad, which is not computational. The two are different
>   guarantees, and TruePad does not merge them
> • Send and open messages and files that are encrypted with that pad
> • Scan a receive code by QR, straight off the other phone's screen
> • Watch the pad be consumed, and stop when it runs out
> • Fixed-length records, so two messages of different lengths reveal the same
>   length
>
> **What it is honest about**
> TruePad does not guarantee perfect secrecy as a product claim, and says so on
> screen. It cannot prove that a random source was truly random, that deleted data
> was physically erased, or that two people actually compared their confirmation
> words. It tells you which assumptions each guarantee rests on instead of
> implying they always hold.
>
> **No account. No backend. No telemetry.** The app makes no network requests at
> all. It works entirely offline.
>
> TruePad is an educational and research project. It is not a recommendation to use
> one-time pads for routine communication — it exists to show what that would
> actually cost.

## Keywords (100 chars)

`one-time pad,OTP,cryptography,encryption,security,education,privacy,offline,QR,post-quantum`

## URLs

| Field | Recommendation |
| --- | --- |
| Support URL | the repository's issues page |
| Marketing URL | the GitHub Pages site |
| Privacy Policy URL | a hosted copy of `PRIVACY.md` — **NEEDS USER ACTION**, Apple requires a reachable URL |

## Category and age rating

- **Primary:** Utilities. **Secondary:** Education.
- Age rating: no objectionable content, no user-generated content shared through
  any service, no web browsing, no gambling. Expected **4+**, subject to the
  questionnaire.

## Business model

**One-time paid download**, per the project's intent. No subscriptions, no in-app
purchases, no ads, no analytics, no accounts — adding any of those would change the
product materially and is out of scope here. **No price has been set**; that needs
the developer's decision.

## Screenshot plan

Not captured. No real pad or key material may appear in any screenshot; all content
must be synthetic and created for the purpose.

| # | Screen | State needed | Caption |
| --- | --- | --- | --- |
| 1 | Pads list | 2–3 pads with innocuous names ("Example pad") | *Your pads, and what's left of them* |
| 2 | Create a pad | form open, fixed-length option visible | *Choose a size. Choose where the randomness came from.* |
| 3 | Receive code + QR | a freshly created receive code | *Scan it off the other phone. The code is public.* |
| 4 | Sealed transfer | the give-a-pad screen | *Hand it over once — and only once* |
| 5 | Inbox | a pending receive request | *One request, one pad* |
| 6 | Message sent, fixed-record | encrypted output visible | *Two messages, different lengths, identical cost* |
| 7 | About / claims | the claims boundary on screen | *It tells you what it does not promise* |

Capture on a 6.9" iPhone simulator for the required size, and one smaller class if
Apple requests it. If automated, the harness must be test-only and must not
introduce screenshot-specific code into the Release app.

## Fields still owed by the developer

App Store Connect record, price and availability, the hosted privacy-policy URL,
the App Review contact details, the captured screenshots, and the app icon.
