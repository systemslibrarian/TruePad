# TruePad iOS — export determination packet

**Status: EXPORT DETERMINATION PENDING.**

A compact evidence pack for whoever makes the determination — the developer, an
export adviser, or Apple's own review. It states facts with source references and
**does not reach a conclusion it is not entitled to reach.** It says neither
"CCATS required" nor "CCATS not required", because neither has been established.

---

## 1. What the application is

TruePad is an **educational and research** implementation of authenticated
one-time-pad key management, distributed as a **mass-market, general-public**
iPhone application with no server component, no accounts and no network I/O. Its
purpose is to demonstrate what keeping one-time-pad assumptions intact actually
costs in real software.

**It is fully public, open-source software.** The entire implementation, the wire
formats and the security analysis are published:

- source: <https://github.com/systemslibrarian/TruePad> (AGPL-3.0-only)
- wire formats: `docs/FORMAT-V2.md`, `docs/COMPACT-TRANSPORT.md`, `docs/SEALED-PAD-TRANSFER.md`
- normative spec: `docs/TRUEPAD-3-SPEC.md`

This matters to the determination: BIS's definition of **non-standard
cryptography** requires functionality that is *neither adopted by a recognised
standards body **nor** otherwise published*. Both conditions. TruePad fails the
second decisively.

## 2. Cryptographic functionality, by role

Roles are separated because "encryption algorithm" is not a synonym for
"cryptography", and collapsing them would misdescribe the app.

| Function | **Role** | Implementation | Standard status |
| --- | --- | --- | --- |
| OTP XOR combiner | **encryption** | TruePad's own Swift | the Vernam construction — published 1919; not a modern algorithm standard |
| Four-slice partition / source combination | **key management** | TruePad's own Swift | none; deliberately *not* a KDF |
| `wc-one-time-v1` | **authentication** | TruePad's own Swift | one-time Wegman–Carter — published academic work (1981) |
| POLYVAL / GF(2¹²⁸) | universal hash | TruePad's own Swift | **RFC 8452 §3** |
| TP2 / TPR2 / TPS2 | **encoding / container** | TruePad's own Swift | not cryptography |
| Sealed Pad Transfer | **protocol** | TruePad's own Swift over the primitives below | composed of published standards |
| X-Wing KEM | KEM | vendored BoringSSL | **IETF Internet-Draft**, revision 10 — see §4 |
| ML-KEM-768 | KEM (PQ half) | vendored BoringSSL | **FIPS 203** algorithm; the build is *not* a FIPS-validated module |
| X25519 | KEM (classical half) | vendored BoringSSL | RFC 7748 |
| AES-256-GCM | AEAD | vendored BoringSSL | FIPS 197 / SP 800-38D |
| HKDF-SHA-256 | KDF | vendored BoringSSL | RFC 5869 |
| SHA-2 / SHA-3 / SHAKE | hash | vendored BoringSSL | FIPS 180-4 / FIPS 202 |

## 3. Encryption is implemented outside Apple's operating system

**Established fact, and the decisive one for Apple's first branch.** The vendored
`swift-crypto` is patched so `let development = true`
(`ios/vendor/swift-crypto/Package.swift`), defining
`CRYPTO_IN_SWIFTPM_FORCE_BUILD_API` on Darwin and taking every source out of its
`@_exported import CryptoKit` shim. `import Crypto` therefore resolves to a
statically linked BoringSSL, **not** CryptoKit.

**Why, and it is not to avoid Apple's crypto:** CryptoKit's X-Wing carries an iOS
26 availability floor, and TruePad's deployment target is **iOS 16**. Confirmed by
the test `testRunsBelowTheCryptoKitAvailabilityFloor`.

## 4. X-Wing: draft status, and what the shipping bytes actually are

X-Wing is a **published IETF Internet-Draft** (`draft-connolly-cfrg-xwing-kem`).
It is **not** an RFC, **not** CFRG-adopted, and **not** NIST-standardized.
ML-KEM-768 is separately standardized as FIPS 203; that does **not** promote
X-Wing's status, and no form should describe it as a standard.

TruePad freezes **revision 10**. The vendored upstream cites revision **06** in
comments (`CCryptoBoringSSL_xwing.h:28`, `Sources/Crypto/KEM/XWing.swift:37`).
The discrepancy was settled by execution rather than by reading:

> `XWingKATTests` runs the shipping iOS implementation against the committed
> revision-10 Appendix-C corpus (`android/vectors/xwing-draft10-appendix-c.json`).
> All three vectors match **byte for byte** — public key, deterministic
> encapsulation ciphertext, shared secret and decapsulation — with the frozen
> sizes exact (pk 1216, seed 32, ct 1120, ss 32, entropy 64). A companion case
> proves the KAT is not vacuous: mutating the entropy breaks it.

**The upstream comments are stale provenance text. The shipping implementation is
byte-conformant with revision 10.** Paperwork should cite revision 10.

## 5. Other facts a determination usually needs

| Question | Answer |
| --- | --- |
| Is the encryption user-accessible? | Yes — encrypting and decrypting messages is the product's function |
| Is the cryptography removable by the user? | No |
| Is this mass-market software for the general public? | Yes — a paid consumer iPhone app, no restricted user class |
| Is there a server component? | **No.** No backend, no accounts, no network I/O |
| Does it perform key management? | Yes — that is the point of the product |
| Is any cryptography proprietary or unpublished? | **No.** Every construction is public, and so is the source |
| Existing Apple declaration | `ITSAppUsesNonExemptEncryption = true`, in the shipping Info.plist |
| Any existing CCATS / ECCN / exemption? | **None claimed and none inferred.** No filing exists in this repository |

## 6. The open question

Which BIS path applies:

- **§740.17(b)(1)** — permits **self-classification**, with a self-classification
  report rather than a classification request.
- **§740.17(b)(3)** — **requires** a classification request for specified
  categories, including genuine **non-standard cryptography**.

The evidence above establishes that the usual trigger for (b)(3) — proprietary or
unpublished cryptography — does **not** plainly apply to TruePad. That is not the
same as establishing that (b)(1) does. **This packet does not answer the question;
it is the material needed to answer it.**

Apple's own export-compliance review is a separate process, and Apple states it
generally takes about two business days once complete documentation is supplied.

## 7. What must not be done to make this easier

- Do not change `ITSAppUsesNonExemptEncryption` to `false`. It would be false.
- Do not remove or weaken X-Wing to simplify the paperwork.
- Do not describe X-Wing as an RFC, an IETF standard, or NIST-standardized.
- Do not invent an `ITSEncryptionExportComplianceCode`. None exists, and no
  placeholder has been added to the shipping Info.plist for exactly that reason.
