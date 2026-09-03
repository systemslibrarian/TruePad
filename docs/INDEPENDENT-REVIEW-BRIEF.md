# TruePad 3.0 — Independent human security review brief

This brief is for an independent human cryptographer / security engineer. It
states the scope, the questions we most want challenged, the highest-risk
components, the defects we already found and fixed, how to run the evidence, and
what a finding would have to show to block a formal 3.0.0 release.

**Internal AI adversarial audits and the falsification matrix are engineering
evidence, not independent review. This brief is the request for the latter.**

- **Repository:** https://github.com/systemslibrarian/TruePad
- **SHA under review:** `master` = **3.0.0-dev.0** (`a6a8b6…`).
- **Latest formal release (unchanged):** TruePad 2.0.0 (`240d7f0`).

## Scope

In scope: OTP confidentiality, one-time Wegman–Carter authentication, durable
consumption/burn semantics, attempt reservation, rollback witnesses,
platform-monotonic TPM authority, the operator-pinned root of trust, the ceremony
state machine, provenance/withdrawal, the single deployment evaluator, and the
Sealed Pad Transfer protocol (reviewed as its own computational protocol).

Out of scope for *this* brief (but real, and separately tracked): physical TPM
hardware behaviour, Android/iOS device behaviour, human accessibility, real QR
cameras. Also out of scope by design: threats above the boundary in
[TRUEPAD-3-SPEC.md](TRUEPAD-3-SPEC.md) §2 (hostile OS/root/binary/firmware).

## Architecture summary

See [REVIEWER-START-HERE.md](REVIEWER-START-HERE.md) for the one-paragraph claim
and the two-hour path, and [SECURITY-REVIEW-MAP.md](SECURITY-REVIEW-MAP.md) for the
per-file trusted surface. The normative behaviour is
[TRUEPAD-3-SPEC.md](TRUEPAD-3-SPEC.md).

## Highest-risk components

1. **`src/cli/v2/store2.ts` + `truepad2.ts`** — durable consumption and
   burn-before-output. A reuse bug here breaks the OTP itself.
2. **`src/core/wc-one-time.ts` + `envelope2.ts`** — one-time auth material and the
   canonical authenticated bytes. Reuse or parser ambiguity breaks authentication.
3. **`src/cli/v2/platform-witness.ts` + `trust-store.ts`** — the TPM authority and
   the root-of-trust pin. A substitution or resolution bug re-opens authority
   laundering.
4. **`src/claims/shannon-deployment.ts`** — the single evaluator. A logic slip
   turns a computational/unknown/unpinned path into a gold verdict.

## The questions we most want you to challenge

Please try to make each of these happen; each should be impossible:

- **Pad reuse after crash** — can any crash point reissue a pad octet or WC key?
- **Authentication-material reuse** — can a WC key be used twice across send/retry/
  restore?
- **Parsing ambiguity** — two distinct messages authenticating to the same bytes,
  or one message with two verifier-accepted serializations.
- **Direction confusion** — a message from one direction accepted as the other.
- **Rollback** — a store restored below its high-water accepted for a send.
- **Cloned state** — the same live state used on two machines without detection.
- **Platform authority substitution** — a pair pointed at a foreign/forged authority
  reaching CONDITIONALLY ELIGIBLE.
- **Trust-store bypass / TOFU** — any path that pins or trusts an authority a pair
  named, without the explicit operator `authority pin`.
- **Ceremony laundering** — editing `provenance.json`/`head.json` to make a
  plain-gen pair read as an accepted ceremony.
- **Terminal-downgrade resurrection** — reversing a platform-attested withdrawal by
  deleting/corrupting a sidecar or restoring old files.
- **Sealed-lineage laundering** — stripping sealed ancestry via export/re-import.
- **Fixed-record accounting** — a plaintext-length leak the fixed frame should hide,
  or an off-by-one in capacity `F−4`.
- **Source-claim overstatement** — any wording/flag that upgrades a source to
  "random/verified/entropy-certified".
- **Browser rollback** — a browser pad reaching maximum assurance, or an OPFS
  restore going undetected in a way the UI misrepresents.
- **SPT key-state cloning** — reusing a Sealed Pad Transfer receive/session key
  state, or a receiver accepting two packages for one request.

## Defects already found and fixed (so you can probe the fixes)

1. **Same-pair provenance laundering** — a gen pair's own `provenance.json` edited
   into a ceremony story. Fixed: the platform authority is load-bearing; provenance
   alone cannot mint `handoff-accepted`.
2. **Withdrawal deletion resurrection** — deleting `withdrawal.json` reversed a
   downgrade. Fixed: terminal `withdrawn` lives in the platform authority.
3. **In-pair fake platform authority** — a forged state file inside the pair dir.
   Fixed: an in-pair authority is rejected; then superseded by the pin.
4. **Foreign external authority substitution** — a pair pointed at the attacker's
   own valid TPM authority. Fixed: the operator-pinned trust root; a pair may not
   choose its authority.

## Test commands and falsification approach

```
npm ci
npm run audit:security     # typecheck + unit + falsification/claims/no-verdict/no-pad-derived guards + build
npm run test:e2e           # Playwright
npm run test:tpm-interop   # OPTIONAL: Linux + swtpm + tpm2-tools (emulator interop, NOT hardware)
```

Falsification: the repository includes machine guards plus a mutation-style
falsification approach (single-line mutations of security-critical predicates are
applied and a targeted test MUST go red). At this SHA the cumulative matrix is 43
mutations with 0 real escapes. This proves the *tests bite*; it does not prove the
*design is correct* — that is your review.

## What would block 3.0

A finding blocks a formal 3.0.0 release if it demonstrates, within the §2
boundary, any of: pad or auth-material reuse; a forgery/parser-ambiguity; a
rollback or clone that is not detected; an authority substitution or TOFU that
reaches CONDITIONALLY ELIGIBLE; a ceremony-laundering or withdrawal-resurrection
path; a sealed-lineage laundering; or a documented claim the implementation does
not earn (an overstatement of secrecy, randomness, or "audited/verified").

## Responsible disclosure

Please follow the route in [`SECURITY.md`](../SECURITY.md). If a finding is a
working exploit, describe the class and the minimal reproduction rather than a
weaponized artifact.
