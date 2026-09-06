# TruePad iOS Edition

Status: **development only.** No App Store build, no 3.0 tag, no release.

    ios/
      TruePadKit/            the Swift package
        Sources/
          TruePadCore/       the OTP kernel — depends on NOTHING
          TruePadStorage/    the durable store, witness, and Fs backings
          TruePadSPT/        Sealed Pad Transfer (the only module linking swift-crypto)
          TruePadKATSupport/ test-only; NOT a product, NOT a dependency of any product
          spt-vector-tool/   host-only vector generator; not a product
        Tests/TruePadSPTTests/
      vendor/                apple/swift-crypto 4.5.2, pinned and patch-audited
      vectors/               this edition's own cross-edition SPT corpus
      scripts/               isolation, notices and supply-chain gates

## What exists, and what does not

**Built:** the OTP kernel (POLYVAL, `wc-one-time-v1`, the four-slice partition,
fixed-record frames, the strict envelope grammar), the durable store (Store Format
v2 with byte-identical `head.json`, `F_FULLFSYNC` durability, the rollback
witness), and Sealed Pad Transfer — all held to the frozen vectors and
cross-checked against the Browser and Android Editions in both directions.

**Built since this line last said otherwise:** the OTP verbs over the store, the
SPT durable state machine, the deployment evaluator and the SwiftUI application
all exist and ship. This paragraph used to list them as "Not built", which stopped
being true some time ago.

**Not claimed:** human VoiceOver validation has not happened, and there is no App
Store build. The app HAS been built, signed, installed and launched on a physical
iPhone 12 (iOS 18.6.2), where the on-device suite passes, and it has completed a
two-device ceremony against a physical Android handset. What remains unclaimed is
human accessibility validation and any distribution channel.

## The X-Wing gate

The iOS Edition must speak the **same** X-Wing as the Browser and Android
Editions, byte for byte — not an equivalent construction that happens to
interoperate. The authority is the committed draft-10 Appendix-C corpus
`android/vectors/xwing-draft10-appendix-c.json`, the same fixture the other two
editions are held to, exercised in all three directions:

    seed             -> public key
    (pk, eseed)      -> ciphertext, shared secret      (deterministic)
    (ciphertext, sk) -> shared secret

with `XWingKATTests` additionally pinning the wire layout against an independent
X25519 implementation, the X25519 clamping behaviour, and the frozen sizes; and
`XWingHostileInputTests` pinning the cross-edition policy that a degenerate
(low-order) X25519 result is **rejected**, matching Browser and Android.

    swift test --package-path ios/TruePadKit

## Deterministic encapsulation is structurally test-only

  LOSS IS ACCEPTABLE; REUSE IS NOT.

Reproducing frozen vectors requires encapsulating with fixed entropy. Shipping
that capability would be a reuse machine. It is therefore confined to
`TruePadKATSupport`, which is not a package product and not a dependency of
`TruePadSPT`, so a shipping app cannot import, link, or name it:

    ios/scripts/check-release-isolation.sh

builds a stand-in app against the package's products and proves — among other
checks — that `import TruePadKATSupport` fails to compile with *no such module*.
The script also states plainly what it does **not** prove; see its output and
`ios/vendor/README.md`.

## Vendored dependency

`ios/vendor/swift-crypto` is apple/swift-crypto 4.5.2 at commit `da9d28d6`,
Apache-2.0. Its entire TruePad delta is **65 lines across two files** — three
changes: two in `swift-crypto/Package.swift`, and one HARDENING PATCH to
`Sources/Crypto/KEM/BoringSSL/XWing_boring.swift` that adds the entropy-length
guard upstream's CVE-2026-28815 fix omitted on the encapsulation side.

The earlier wording here — "30 lines in one manifest" — was retracted once and
came back. It matters because it hides the only part of the delta that changes
CRYPTOGRAPHIC BEHAVIOUR: a reader who believes the delta is manifest-only has no
reason to review the patch that is not. Recorded in
`ios/vendor/EXPECTED-PATCH.diff` and enforced byte-for-byte by:

    ios/vendor/verify-vendor.sh

Why vendoring is necessary, and why ordinary resolution is not sufficient on
Darwin, is documented in `ios/vendor/README.md`.
