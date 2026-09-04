# TruePad iOS Edition

Status: **development only.** No App Store build, no 3.0 tag, no release.

    ios/
      TruePadKit/            the Swift package
        Sources/
          TruePadSPT/        production — the only package product
          TruePadKATSupport/ test-only; NOT a product, NOT a dependency of TruePadSPT
        Tests/TruePadSPTTests/
      vendor/                apple/swift-crypto 4.5.2, pinned and patch-audited
      scripts/               isolation gate

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
Apache-2.0. Its entire TruePad delta is 30 lines in one manifest, recorded in
`ios/vendor/EXPECTED-PATCH.diff` and enforced by:

    ios/vendor/verify-vendor.sh

Why vendoring is necessary, and why ordinary resolution is not sufficient on
Darwin, is documented in `ios/vendor/README.md`.
