# TruePad iOS — Apple export-compliance inventory

**Status: PREPARED, NOT FILED.** This document states what the shipping iOS binary
actually contains so that Apple's App Encryption questions can be answered from
evidence. It is not legal advice, it asserts no classification, and it records no
approval that does not exist.

**Nothing here proposes changing the cryptography to make the paperwork easier.**
`ITSAppUsesNonExemptEncryption` stays `true` because that is the truthful answer.

---

## A. Factual cryptographic inventory

**The decisive fact for Apple's first branch: TruePad does NOT use Apple's OS
cryptography for any of its algorithms.** The vendored `swift-crypto` is patched so
that `let development = true` (`ios/vendor/swift-crypto/Package.swift`), which
defines `CRYPTO_IN_SWIFTPM_FORCE_BUILD_API` on Darwin and takes every source out of
its `@_exported import CryptoKit` shim. `import Crypto` therefore resolves to a
statically linked BoringSSL, not to CryptoKit. This is deliberate and documented:
CryptoKit's X-Wing carries an iOS 26 availability floor, and TruePad's deployment
target is iOS 16.

| Primitive | Role | Implementation | Standard status | Protects | SPT only? |
| --- | --- | --- | --- | --- | --- |
| OTP XOR combiner | encryption | **TruePad's own Swift** | none — the textbook Vernam construction, not a published algorithm standard | stored + messages | no |
| Four-slice partition / source combination | key-material layout | **TruePad's own Swift** | none. Deliberately NOT a KDF: no extractor or conditioner may sit between declared sources and the secret body | stored | no |
| `wc-one-time-v1` Wegman–Carter | authentication | **TruePad's own Swift** | **mixed** — a first-party one-time-MAC construction over a standard universal hash | messages | no |
| POLYVAL / GF(2¹²⁸) | universal hash | **TruePad's own Swift**, hand-rolled | RFC 8452 §3 | messages | no |
| X-Wing KEM | KEM | vendored BoringSSL | **IETF DRAFT ONLY** — see §D | communications | **yes** |
| ML-KEM-768 | KEM (PQ half of X-Wing) | vendored BoringSSL | FIPS 203 **algorithm**; the build is **not** a FIPS-validated module | communications | yes |
| X25519 | KEM (classical half) | vendored BoringSSL | RFC 7748 | communications | yes |
| AES-256-GCM | AEAD | vendored BoringSSL | FIPS 197 / SP 800-38D | communications | yes |
| HKDF-SHA-256 | KDF | vendored BoringSSL | RFC 5869 | communications | yes |
| SHA-2 / SHA-3 / SHAKE | hash | vendored BoringSSL | FIPS 180-4 / FIPS 202 | communications | yes |

Three tiers matter for the questionnaire, and conflating them would misstate the
app:

1. **Industry-standard, implemented outside the OS** — ML-KEM-768, X25519,
   AES-256-GCM, HKDF-SHA-256, the SHA family. All vendored BoringSSL.
2. **Standard algorithm, first-party implementation** — POLYVAL (RFC 8452 §3),
   hand-written in Swift.
3. **First-party constructions implementing no published algorithm standard** —
   the OTP XOR combiner, the four-slice partition, and `wc-one-time-v1`. These are
   public and fully documented, so they are not proprietary in the trade-secret
   sense, but they are **not** "standard encryption" either, and must not be
   described as such on a form.

---

## B. Proposed answers to Apple's App Encryption questions

Proposed. Not submitted. Each rests on the inventory above.

| Question | Proposed answer | Basis |
| --- | --- | --- |
| Does your app use encryption? | **Yes** | `ITSAppUsesNonExemptEncryption = true` is already in the shipping Info.plist |
| Does it qualify for any of the exemptions? | **Determination required — see §D** | the exemption for "standard encryption within Apple's OS" plainly does **not** apply: TruePad links its own BoringSSL and implements its own combiner and authenticator |
| Does your app implement any encryption algorithms instead of, or in addition to, using Apple's OS encryption? | **Yes** | established above; CryptoKit is bypassed by design |
| Are the algorithms proprietary or non-standard? | **Mixed, and this is the branch that needs a human decision.** Tiers 1–2 are standard; tier 3 is first-party and non-standard | see §A |

---

## C. What the shipping bytes actually implement

**Settled mechanically, not by reading comments.** The vendored upstream cites
revision **06** in two places — `CCryptoBoringSSL_xwing.h:28` and
`Sources/Crypto/KEM/XWing.swift:37`. TruePad freezes revision **10**. The question
that matters is not which number appears in a comment but which bytes ship, and
the repository already contains the authority to answer it:
`android/vectors/xwing-draft10-appendix-c.json`, the committed draft-10
Appendix-C corpus both mobile editions are held to.

`XWingKATTests` runs the shipping iOS implementation against that corpus. All
seven cases pass, byte for byte, over all three vectors:

| Check | Result |
| --- | --- |
| draft-10 Appendix-C public key | byte-equal |
| deterministic encapsulation ciphertext | byte-equal |
| shared secret | byte-equal |
| decapsulation | byte-equal |
| frozen sizes — pk 1216, seed 32, ct 1120, ss 32, entropy 64 | exact |
| X25519 half vs an independent implementation | agrees |
| mutated entropy breaks the vectors | fails as it must — the KAT is not vacuous |

**Conclusion.** The vendored upstream comments cite revision 06, but the shipping
TruePad iOS implementation is byte-conformant with TruePad's frozen revision-10
suite as proved by the revision-10 Appendix-C KAT corpus. **The upstream comments
are stale provenance text, not the protocol version TruePad implements.**

The vendored source was **not** edited to change "-06" to "-10". The vendor tree is
pinned and byte-verified by `verify-vendor.sh`; a cosmetic downstream patch would
create a permanent diff against upstream for no engineering gain. The discrepancy
is recorded here instead, which is where a reader of the export paperwork will
need it.

---

## D. Which BIS path applies — a determination, not an assumption

**This section previously concluded that a CCATS was likely required, and that was
wrong.** It reasoned "these constructions are not formal standards, therefore
non-standard cryptography, therefore classification request". That skips the
actual definition.

BIS defines **non-standard cryptography** as cryptographic functionality that is
**neither adopted by a recognised standards body NOR otherwise published**. Those
are two conditions, and TruePad fails the second one decisively:

- the entire source is public;
- the wire format is publicly specified in `docs/FORMAT-V2.md`, `docs/COMPACT-TRANSPORT.md` and `docs/SEALED-PAD-TRANSFER.md`;
- X-Wing is itself a **published** IETF Internet-Draft, not an unpublished scheme;
- the OTP combiner is the textbook Vernam construction, published since 1919;
- POLYVAL is RFC 8452 §3;
- Wegman–Carter one-time authentication is published academic work (1981).

"Not an RFC" and "not published" are different claims, and only the second is what
the definition turns on.

### Role first, because "encryption algorithm" is not a synonym for "cryptography"

| Construction | Role | Not merely |
| --- | --- | --- |
| OTP XOR combiner | **encryption** | — |
| Four-slice partition / source combination | **key management / partitioning** | not an encryption algorithm |
| `wc-one-time-v1` | **authentication** | not an encryption algorithm |
| POLYVAL | universal hash feeding the authenticator | not an encryption algorithm |
| TP2 / TPR2 / TPS2 | **encoding / container** | not cryptography at all |
| Sealed Pad Transfer | **protocol** | composed of the standard primitives above |

### The two paths

- **§740.17(b)(1)** — permits **self-classification** for qualifying items, with a
  self-classification report rather than a classification request.
- **§740.17(b)(3)** — **requires** a classification request for specified
  categories, including items performing genuine **non-standard cryptography**.

**Which one TruePad falls under is the open question, and this document does not
answer it.** The analysis above establishes that the usual trigger for (b)(3) —
unpublished or proprietary cryptography — does **not** obviously apply, because
everything TruePad does is published. That is not the same as establishing that
(b)(1) applies. That determination needs someone competent to make it against the
current regulation text.

**Status: EXPORT DETERMINATION PENDING.** Not "CCATS required". Not "exempt".

### The reusable rule, kept narrow

This is a determination about **TruePad**, not a general claim about software. The
policy worth carrying forward is only this:

> Every cryptographic product needs a determination. Not every cryptographic
> product needs a classification request.

Nothing here implies that an app bundling AES, TLS or standard post-quantum
primitives needs a new BIS filing.

---

## E. Apple's questionnaire is a separate question again

Apple's own App Encryption questions are not the BIS determination, and answering
one does not answer the other. Apple distinguishes at least three cases: OS-only
encryption; industry-standard encryption implemented outside the OS; and
proprietary or non-standard encryption.

| Apple question | Proposed answer | Basis |
| --- | --- | --- |
| Does your app use encryption? | **Yes** | already declared in the shipping Info.plist |
| Does it implement encryption instead of, or in addition to, Apple's OS encryption? | **Yes**, unambiguously | CryptoKit is bypassed by design; `testRunsBelowTheCryptoKitAvailabilityFloor` confirms the BoringSSL path |
| Is the encryption industry-standard, or proprietary/non-standard? | **Determination required — see §D** | tiers 1–2 are standard; tier 3 is first-party but fully published |

`ITSAppUsesNonExemptEncryption` stays **`true`**. No
`ITSEncryptionExportComplianceCode` is present, and **no placeholder was added** —
a fake value there could be mistaken for a real approval. If App Store Connect
issues one, it goes in the shipping Info.plist at that point and not before.

Apple states that where documentation is required, its own export-compliance
review generally takes about **two business days once complete documentation is
supplied**. That is Apple's review only, and is unrelated to the duration of any
BIS process.

---

## F. What remains genuinely unresolved

1. **Which BIS path applies** — see §D. Needs a determination, not an inference.
2. **Whether any prior filing exists.** None is claimed and none was inferred. No
   CCATS, no ECCN, no exemption, no Apple compliance code exists in this
   repository.
3. **France and other jurisdiction-specific declarations.** Not assessed.
