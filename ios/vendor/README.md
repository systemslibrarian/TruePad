# Vendored dependencies — iOS Edition

TruePad vendors exactly one dependency for iOS: **apple/swift-crypto**. This note
records why, what was changed, and how a reviewer or CI job checks that nothing
else was changed.

    upstream    https://github.com/apple/swift-crypto
    version     4.5.2
    commit      da9d28d69ebe3894b18376c8f2395c2f37b8448f
    license     Apache-2.0 (AGPL-3.0-only compatible)
    vendored at ios/vendor/swift-crypto
    delta       ios/vendor/EXPECTED-PATCH.diff  (30 lines, both in Package.swift)
    verify      ios/vendor/verify-vendor.sh

## Why vendor at all?

Because ordinary package resolution cannot produce the build TruePad needs on
Apple platforms. Three facts, each verified against the source rather than
assumed:

1. **swift-crypto before 4.0.0 has no post-quantum API at all.** A `from: "3.0.0"`
   requirement resolves to 3.15.1, in which no Swift file so much as mentions
   X-Wing or ML-KEM — only the BoringSSL C layer is present.
   `XWingMLKEM768X25519` first appears in 4.0.0.

2. **On Darwin, swift-crypto is a shim, not an implementation.** Its sources are
   wrapped in `#if CRYPTO_IN_SWIFTPM && !CRYPTO_IN_SWIFTPM_FORCE_BUILD_API`, and
   on Apple platforms that resolves to a bare `@_exported import CryptoKit`. So
   the entire BoringSSL implementation is dead code there, and
   `XWingMLKEM768X25519` is Apple's CoreCrypto type.

3. **That system type carries an iOS 26 / macOS 26 availability floor.** Apple's
   X-Wing is new. Building against it would mean TruePad's iOS Edition required
   iOS 26 *purely because of which X-Wing implementation it linked* — not because
   of anything TruePad does. It also offers no derandomized encapsulation, which
   TruePad needs to reproduce its frozen known-answer and interop vectors.

Vendoring lets TruePad build swift-crypto's own open-source, BoringSSL-backed
X-Wing instead: same construction, same bytes, deployment floor of iOS 13 (the
package's own annotation; TruePadKit currently sets iOS 16).

## What was changed — the whole delta

Two changes, both in `swift-crypto/Package.swift`. **No file under `Sources/` was
modified, added, or removed.** That is asserted by a test
(`ProductionIsolationTests.testVendoredSourcesCarryNoTruePadPatch`) and by
`ios/scripts/check-release-isolation.sh`, because a patch hidden in `Sources/`
would be linked by the shipping app.

**Patch 1 — `let development = false` → `true`.**
This is *upstream's own switch*, commented in the manifest as "To develop this on
Apple platforms, set this to true". It defines `CRYPTO_IN_SWIFTPM_FORCE_BUILD_API`
on Darwin, which builds the open-source API instead of re-exporting CryptoKit.
TruePad did not invent a mechanism; it selected one upstream provides.

**Patch 2 — export `CCryptoBoringSSL` as a product.**
Upstream keeps this product commented out (it exists for symbol mangling).
Exporting it lets TruePad's `TruePadKATSupport` target call
`XWING_encap_external_entropy` directly, *from outside the production module
graph*. The alternative — patching a hook into `Sources/Crypto` — would put
deterministic encapsulation inside a module the shipping app links. This patch is
what keeps that from being necessary.

## Deterministic encapsulation is test-only, structurally

  LOSS IS ACCEPTABLE; REUSE IS NOT.

Deterministic encapsulation repeats a shared secret whenever its entropy repeats,
so it must never ship. TruePad needs it only to reproduce the draft-10 Appendix-C
corpus and its own deterministic SPT fixtures. The boundary is enforced by
construction, not by naming:

- it lives in `TruePadKATSupport`, which is **not a package product**;
- `TruePadSPT` — the only product — **does not depend on it**;
- an app therefore **cannot import it**: `ios/scripts/check-release-isolation.sh`
  builds a stand-in app and proves the import fails with *no such module*;
- the file also refuses to compile without `TRUEPAD_KAT_SUPPORT`, which only that
  target defines.

Honest limitation: the BoringSSL symbol `XWING_encap_external_entropy` is present
in any binary linking swift-crypto, and TruePad does not claim otherwise —
upstream's *randomized* `XWING_encap` draws 64 random bytes and calls it
internally, so the symbol is inseparable from ordinary encapsulation. What is
proven is that no TruePad production module, source, or symbol reaches it.

## What is NOT vendored

Upstream development material — its test corpus, benchmarks, CI, lint config and
CMake build — is not copied. See `PRUNED-PATHS.txt` for the exact list and the
reasoning. `verify-vendor.sh` removes precisely those paths from pristine upstream
before diffing, so pruning cannot hide a content change.

## Reproducing and verifying

    ios/vendor/verify-vendor.sh            # verify (CI mode)
    ios/vendor/verify-vendor.sh --write    # regenerate EXPECTED-PATCH.diff

The script clones pristine upstream at the pinned **commit** (not just the tag —
a moved tag is treated as a supply-chain event and fails), prunes, diffs, and
requires the result to equal `EXPECTED-PATCH.diff` byte for byte. Drift in either
direction fails. Set `TRUEPAD_SWIFT_CRYPTO_MIRROR` to use a local mirror offline.

To update the vendored copy: change the pins in `verify-vendor.sh`, re-vendor,
re-apply the two patches, run `--write`, **review the regenerated diff**, then
re-run the full X-Wing gate — the Appendix-C vectors and the SPT interop corpus
are the authority on whether a bump changed any byte.

## Security review of the pinned versions

Reviewed against published advisories at the pin `swift-crypto 4.5.2` /
BoringSSL `0226f30`. In each case the fix was confirmed **in the vendored
source**, not inferred from a version number.

| Advisory | Verdict |
| --- | --- |
| CVE-2026-28815 / GHSA-9m44-rr2w-ppp7 — X-Wing decapsulation accepts malformed ciphertext length (fixed 4.3.1) | **Not affected.** The Swift-layer guard is present at `Sources/Crypto/KEM/BoringSSL/XWing_boring.swift`. The BoringSSL side never needed fixing: `XWING_decap` takes no length parameter by design, so the guard is necessarily Swift-side. TruePad guards it independently too — see below. |
| CVE-2026-43823 / GHSA-8q93-f6xh-4f6f — double-free parsing an RSA public key (CRITICAL, fixed 4.5.1) | **Not affected**, on two independent grounds. The pin POSTDATES the fix, and TruePad does not link `_CryptoExtras`, where RSA lives. |
| CVE-2022-37454 — XKCP Keccak sponge integer overflow | **Not affected.** `Sources/CXKCP/FIPS202-opt64/KeccakSponge.inc` carries the post-fix form. |
| ML-KEM / X25519 / AES-GCM in the vendored BoringSSL | No advisory found. These are on TruePad's hot path, so a future advisory here would be directly reachable and should be treated as high priority. |

### One unpatched sibling defect, not reachable from TruePad

`OpenSSLXWingPublicKeyImpl.encapsulateWithOptionalEntropy` at 4.5.2 still passes
the caller's `entropy` array to `CCryptoBoringSSL_XWING_encap_external_entropy`
**without a length check** — the symmetric twin of the buffer CVE-2026-28815 was
filed for, on the encapsulation side, which upstream's fix did not cover.

It is not reachable here. Upstream the method is internal with a single caller
that passes `nil`, and TruePad never calls it at all: the deterministic hook goes
straight to the C entry point through `DeterministicXWing`, which validates the
64-byte entropy length **before** forming a pointer. `XWingMalformedLengthTests`
asserts exactly that, and asserts the refusal comes from TruePad rather than the
library — so this class of defect is guarded here independently of upstream.

Worth reporting upstream as a latent trap for future callers.

### Two currency items to watch

- **The BoringSSL pin is about a year old** (commit dated 2025-09-07). Upstream
  BoringSSL does not issue CVEs for most fixes, so "no advisory" is not the same
  as "no relevant fix". When swift-crypto rolls BoringSSL past `0226f30`, re-run
  the Appendix-C and SPT interop corpora against the new tree before adopting it.
- **`Sources/CXKCP` is a second C dependency** inside swift-crypto, with its own
  provenance (`vendored-sources.txt` names an XKCP *master commit*, not a
  release). A future vendor-currency review should look at it separately.

### The draft-06 / draft-10 label, settled

Upstream's header (`CCryptoBoringSSL_xwing.h`) and `XWing.swift` both cite
draft-connolly-cfrg-xwing-kem-**06**, while TruePad's frozen contract is
draft-**10**. This is recorded so a future reviewer does not have to rediscover
it and does not mistake it for a mismatch.

The labels are not the evidence. What settles it is
`android/vectors/xwing-draft10-appendix-c.json`: the committed draft-10
Appendix-C corpus, which this vendored code reproduces byte-for-byte in all three
directions, alongside the cross-edition SPT corpora. The combiner was read
directly and is the frozen construction — SHA3-256 over
`mlkem_ss ‖ x25519_ss ‖ x25519_ct ‖ x25519_pk ‖ 5c2e2f2f5e5c`, label last. The
header comment is stale; the bytes are not.
