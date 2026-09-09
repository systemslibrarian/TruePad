# TruePad — independent human security review packet

**This is the handoff.** It names one exact review target, the ~5% of the
repository where a real defect would matter, the invariants to attack, and how to
report. It deliberately does not restate the normative documents; it links them.

> **INDEPENDENT HUMAN SECURITY REVIEW: NOT PERFORMED.**
> This packet existing does not change that, and neither does an AI having read
> it, someone expressing interest, code having been sent, or a review that began
> and did not finish. The status changes only on an actual human deliverable.

---

## 1. The review target, frozen

| | |
| --- | --- |
| **REVIEW_SHA** | `1677291b0232c8ace3b5de2ad2fac1a796853ab9` |
| **REVIEW_TREE** | `f5273d9bc672d7b81275ac00e2f0a79916414f7d` |

**Do not review "latest master".** Master moves; findings that name a moving
target cannot be triaged. Every finding must say which SHA it applies to.

The **formal released baseline** is separate and immutable:

| | |
| --- | --- |
| **v3.0.0** tag object | `6377f9485da987ba450a81818b79b0848f5ca5f7` |
| **v3.0.0** commit | `996ee4edccfa899f43e74847fe1380cb8399b57d` |
| **v2.0.0** commit (frozen wire baseline) | `240d7f0fa847c8e135cddd3826e7d2da699d1567` |

`REVIEW_SHA` is **v3.0.0 plus post-release assurance, distribution-readiness and
claims work**. The cryptographic core and the transfer protocol — `src/core` and
`src/spt` — are **unchanged since `v2.0.0`**, and CI enforces that on every
commit. So the wire you review is the wire that shipped.

## 2. The governing invariant

> ## LOSS IS ACCEPTABLE. REUSE IS NOT.

Every design tension in this repository resolves that way. A crash, a refusal, a
destroyed pair, an unusable store — all acceptable. One pad byte or one
authentication mask serving twice is not. **If you find a path that prefers
availability over that rule, that is a finding even if nothing is decrypted.**

## 3. The three-claim split

The one thing this project asks reviewers not to blur:

> **PQC protects pad delivery. OTP encrypts messages. Wegman–Carter authenticates
> messages.**

Different guarantees, different strengths. Sealed delivery is **computational**;
the message encryption is not. TruePad **does not claim perfect secrecy as a
product claim**, and treats a claim the code does not earn as a security defect
in its own right (see §7F).

## 4. Primary scope

Six areas. Everything else is out of scope (§5).

### A. OTP / partition / authentication
`src/core/cipher-otp.ts` · `partition2.ts` · `wc-one-time.ts` · `envelope2.ts` ·
`frame2.ts` · `gf128.ts`

- Can any encryption pad byte be consumed twice?
- Can an authentication key or mask be reused across send / retry / restore?
- Can malformed framing alter burn accounting?
- Can an authentication failure advance state unsafely?
- Are the four partition slices disjoint and exact?

### B. Origin / role
`src/browser/ui/role.ts` (the only role authority in the Browser)

The rule is **`generated-here` → A, `imported` → B, anything else → refuse.**

- Can any UI, default, or operator choice override the derived role?
- Can cloning, importing or couriering produce two copies that both act as A?
- Can provenance be lost, or reconstructed incorrectly?
- Does restore/import preserve the role safely?

### C. Burn / commit ordering
`src/cli/v2/store2.ts` · `truepad2.ts` · `android/truepad-storage/src/main/kotlin/dev/systemslibrarian/truepad/storage/Verbs.kt` ·
`ios/TruePadKit/Sources/TruePadStorage/Verbs.swift`

- Is state durable before ciphertext or plaintext becomes externally usable?
- What happens at **every** crash point?
- Can stale state make a symbol serve twice?
- Does every failure path prefer loss?

### D. Sealed Pad Transfer
`src/spt/*` and the Kotlin/Swift ports · spec: [`SEALED-PAD-TRANSFER.md`](SEALED-PAD-TRANSFER.md)

- Is request binding complete — one request bound to one intended pad/handoff?
- Can a TPS2 package be redirected to another receive request, or replayed?
- Can a second independent handoff occur for one pad?
- Does a failed transfer ever leave reusable authority behind?

### E. Native durability
Android: `android/truepad-storage/src/main/kotlin/dev/systemslibrarian/truepad/storage/Fs.kt` (`NioFs.withLock` — in-process lock **plus**
a `FileChannel` lock), manifest hardening, `allowBackup="false"`.
iOS: `ios/TruePadKit/Sources/TruePadStorage/DarwinFs.swift` (`flock`, `F_FULLFSYNC`),
`ios/TruePadKit/Sources/TruePadStorage/KeychainWitnessFs.swift` (witness in the Keychain,
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), backup exclusion.

- Can OS backup/restore produce a **safe-looking stale copy**?
- Are the witness and secret domains genuinely separate failure domains?
- **Are the lock and durability guarantees described more strongly than the
  platform earns?** (This has been wrong in both directions — see §7.)

### F. Claims vs binary
[`PRODUCT-CLAIMS.md`](PRODUCT-CLAIMS.md) — 17 rows × 4 editions.

Material claims drift is treated here as a security defect. Every cell was
checked against primary evidence at `REVIEW_SHA`; **that was an internal check,
not a review.** Challenge any cell you think the code does not earn.

## 5. Explicitly out of scope

Please do not spend paid time on: CSS or visual polish · App Store metadata ·
icon artwork · Pages styling · licensing · BIS/export classification · pricing ·
business model · physical TPM validation · general documentation proofreading ·
the v1 teaching CLI **except** where it could be confused with or invoked from
v2 · speculative redesigns.

And please do not attempt to prove these — they are **premises and boundaries**,
not claims: physical randomness · physical erasure · hostile-OS/root/kernel
resistance · secure-hardware correctness · human word-comparison behaviour.

## 6. Attacker goals

Concrete targets. You do not need to achieve all of them; they are directions.

1. Reuse one encryption-pad byte.
2. Reuse one one-time authentication mask or key.
3. Make A and B disagree on consumed offsets.
4. Restore an old store and continue successfully.
5. Make two copies both believe they are A.
6. Import the same handoff twice.
7. Redirect a sealed package to another receive request.
8. Make a failed operation emit before durable consumption.
9. Get plaintext-message content onto the clipboard, share sheet, or a file.
10. Get secret pad material into logs, errors, or metadata.
11. Make a destroyed pad usable again.
12. Make the claims UI show a stronger verdict than the evidence earns.

## 7. Defect classes already found — probe the repairs

These are real, and they are listed so you can attack the fixes rather than
rediscover the originals.

**A. Role/origin.** Direction was effectively a local default, and two copies
could both act as A — each store's counters advancing monotonically while the
reuse was *across* copies, invisible to either engine. Repaired by deriving role
from the pad's own origin and refusing unknown provenance.
→ *Find another way to create two authorities able to spend the same directional
material.*

**B. Plaintext egress classified from content.** The Browser offered Copy and
Save on the decrypted message beside the same controls used for a public
envelope, and the message/file distinction was once inferred from the decrypted
bytes rather than from the operator's verb. Now `egressForOpenedPayload(mode)`
takes the authoritative mode (`src/browser/ui/egress.ts:78`).
→ *Can any representation or content sniff alter the policy the operator's verb
selected?*

**C. Assurance harnesses that were falsely green.** Not all product defects — but
proof that evidence must itself be attacked:

- a `nm | grep -q` symbol probe under `set -o pipefail` reported a **present**
  symbol as missing (measured 9/200 and 25/200 false negatives);
- an **absent** required workflow was read as green by the release-gate checker;
- an Android clipboard read raced `performClick`;
- claims guards were satisfied by **their own prose** — a cell reading "✓
  guaranteed — this is no longer NOT CLAIMED" passed a check for `NOT CLAIMED`,
  and a forbidden marketing claim hard-wrapped across four lines was never seen.

→ **Do not trust a test name or a green dashboard without reading what it
asserts.** Several here did not assert what their names said.

## 8. Evidence index — navigation, not proof

This table exists so you can find things quickly. **It is not a claim that any of
it was reviewed.**

| Invariant | Implementation | Test | Normative | Known limitation |
| --- | --- | --- | --- | --- |
| Role derivation | `src/browser/ui/role.ts` | `tests/role-derivation.test.ts` | [`SECURITY-REVIEW-MAP.md`](SECURITY-REVIEW-MAP.md) | Browser-only authority; engine owns direction |
| WC one-time mask | `src/core/wc-one-time.ts` | `tests/wc-one-time.test.ts` | `FORMAT-V2.md` §11 | — |
| Fixed-record framing | `src/core/frame2.ts` | `tests/fixed-records.test.ts`, `fixed-record-parity.test.ts` | `FORMAT-V2.md` §16 | Hides length only within a record |
| Partition disjointness | `src/core/partition2.ts` | `tests/partition2.test.ts` | `FORMAT-V2.md` §7 | — |
| Commit-before-emit | `src/cli/v2/store2.ts` | `tests/store2.test.ts` | `FORMAT-V2.md` §12 | Durability claimed only on Linux ext4 |
| Rollback witness | `src/cli/v2/witness.ts` | `tests/witness.test.ts` | `FORMAT-V2.md` §15 | `remote-monotonic` refused `witness-unsupported`; **no edition reaches an independent host** |
| Destroyed tombstone | `src/cli/v2/truepad2.ts` | `tests/destroy.test.ts` | `FORMAT-V2.md` §17 | Software forgetting, never physical erasure |
| SPT request binding | `src/spt/receive-request.ts`, `sealed-package.ts` | `tests/spt-engine.test.ts` | `SEALED-PAD-TRANSFER.md` §6–§8 | Computational, not information-theoretic |
| Plaintext egress | `src/browser/ui/egress.ts` | `tests/plaintext-egress.test.ts` | — | Application policy only; not screenshots or OS memory |
| Android durability | `android/truepad-storage/src/main/kotlin/dev/systemslibrarian/truepad/storage/Fs.kt` | `:truepad-storage:test` | `ANDROID-SECURITY.md` | No power-loss claim |
| iOS backup / witness | `ios/TruePadKit/Sources/TruePadStorage/DarwinFs.swift`, `ios/TruePadKit/Sources/TruePadStorage/KeychainWitnessFs.swift` | `TruePadSPTTests` | `IOS-SECURITY.md` | No power-loss claim; no human VoiceOver pass |
| Claims ledger | `docs/PRODUCT-CLAIMS.md` | `tests/cross-edition-claims.test.ts` | — | Guard pins shape and evidence, not correctness |

## 9. Reproduction — fast paths first

You should be reading code within minutes. Do **not** reproduce the release
ceremony first.

```bash
git clone https://github.com/systemslibrarian/TruePad && cd TruePad
git checkout 1677291b0232c8ace3b5de2ad2fac1a796853ab9
npm ci
```

**Browser / CLI — targeted:**
```bash
npx vitest run tests/wc-one-time.test.ts tests/role-derivation.test.ts \
                tests/plaintext-egress.test.ts
npx vitest run            # full unit suite
npm run test:e2e          # Playwright
```

**Android — JVM only, no emulator:**
```bash
cd android && ./gradlew :truepad-core:test :truepad-storage:test
```

**iOS — macOS + Xcode:**
```bash
cd ios/TruePadKit && swift test --filter TruePadSPTTests.OtpKernelVectorTests
swift test                # full Swift suite (472 XCTest cases)
```

> A `swift test` run prints a swift-testing line reading `0 tests in 0 suites`
> alongside the XCTest results. That is the second harness reporting that it owns
> nothing here, not a filter that matched nothing — read the `Executed N tests`
> line.

Everything, as CI runs it: `npm run audit:security`.

## 10. Reporting

Report privately by the route in [`SECURITY.md`](../SECURITY.md). If a finding is
a working exploit, describe the **class and minimal reproduction** rather than a
weaponised artifact.

Classify each finding **CRITICAL / HIGH / MEDIUM / LOW / INFORMATIONAL**, with:

- title
- **affected SHA**
- affected file / function
- **invariant violated**
- reproduction or reasoning
- security impact
- suggested direction, if any
- whether exploitability was **demonstrated or theoretical**

Please also record **REVIEWED / NO FINDING** for scoped areas you actually
inspected — knowing where a human looked and found nothing is worth as much as a
finding.

**Please do not write "TruePad is secure."** The wording this project wants is
narrow and honest:

> *Within the stated scope, we reviewed X, Y and Z at SHA `…` and found …*

## 11. Related documents

- [`REVIEWER-START-HERE.md`](REVIEWER-START-HERE.md) — two-hour orientation
- [`SECURITY-REVIEW-MAP.md`](SECURITY-REVIEW-MAP.md) — per-file trusted surface
- [`INDEPENDENT-REVIEW-BRIEF.md`](INDEPENDENT-REVIEW-BRIEF.md) — the standing
  offer, and the long catalogue of adversarial questions (not repeated here)
- [`TRUEPAD-3-SPEC.md`](TRUEPAD-3-SPEC.md) — normative behaviour
- [`FORMAT-V2.md`](FORMAT-V2.md) · [`SEALED-PAD-TRANSFER.md`](SEALED-PAD-TRANSFER.md) — the frozen wire and the transfer protocol
