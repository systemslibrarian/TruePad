# Reviewer — start here

You are a security engineer with two hours. This page tells you exactly where to
look, what TruePad claims, and what it deliberately does **not** claim.

**State:** `master` = **3.0.0-dev.0** (development). The latest *formal release*
is **TruePad 2.0.0**; 3.0 is not tagged, released, or published. The literal
OTP/Wegman–Carter combiner and the message/SPT/QR wire are byte-identical to
2.0.0; 3.0 adds the state/authority/ceremony layers reviewed below.

## The claim, in one paragraph

TruePad is an educational/research implementation of **authenticated one-time-pad
key management**. It enforces every one-time-use requirement software can — literal
XOR OTP confidentiality, one-time Wegman–Carter authentication, durable
burn-before-output consumption, attempt reservation, rollback witnesses, a
TPM-anchored monotonic authority, and an operator-pinned root of trust — while
**explicitly separating the physical premises software cannot prove**. Its
strongest verdict is *CONDITIONALLY ELIGIBLE*, always shown beside the premises it
has not proved. **TruePad does NOT guarantee perfect secrecy as a product claim.**

## Threat boundary (what the strongest claim resists, and does not)

Resists, under the maximum-assurance profile: pair-directory file editing;
provenance/withdrawal replacement or deletion; stale directory restore;
same-pair semantic rewriting; cross-pair and authority substitution; a foreign
external TPM authority; ordinary CLI operations; crashes and torn writes.

Does **not** resist, and does not claim to: a hostile OS/kernel, a malicious
administrator or root, a replaced TruePad binary, compromised TPM firmware, or
deliberate reprovisioning of the pinned platform trust anchor. And software never
proves physical randomness, source secrecy, source independence, absence of
hidden copies, private courier behaviour, or physical erasure.

## Suggested review order (about two hours)

1. **Claims / threat model** — `docs/TRUEPAD-3-SPEC.md` §1–§3, `docs/PRODUCT-CLAIMS.md`.
2. **OTP + WC core** — `src/core/cipher-otp.ts`, `partition2.ts`, `wc-one-time.ts`, `gf128.ts`, `envelope2.ts`. *Is the combiner literal XOR? Is WC material one-time and disjoint from encryption bytes? Is the authenticated byte-string canonical and unambiguous?*
3. **State / burn semantics** — `src/cli/v2/store2.ts`, `truepad2.ts` (burn/open/retire). *Is consumption durable before output? Can a crash reuse a pad byte? Are attempts reserved before verify?*
4. **TPM / root of trust** — `src/cli/v2/platform-witness.ts`, `trust-store.ts`, `tpm.ts`. *Can a pair select its own authority? Is the pinned authority the only one read? Is a stale platform state caught?*
5. **Ceremony / provenance** — `src/cli/v2/ceremony.ts`, `provenance.ts`, `withdrawal.ts`. *Can editing JSON turn gen into a ceremony? Can a withdrawal be reversed?*
6. **Deployment evaluator** — `src/claims/shannon-deployment.ts`. *Is there exactly one place a verdict is produced? Does anything else decide?*
7. **Sealed Pad Transfer — separately** — `docs/SEALED-PAD-TRANSFER.md`, `src/spt/*`. This is *computational* delivery; review it as its own protocol.

The compact per-file map with invariants and tests is
[`docs/SECURITY-REVIEW-MAP.md`](SECURITY-REVIEW-MAP.md).

## Five documents, in priority order

1. [`docs/TRUEPAD-3-SPEC.md`](TRUEPAD-3-SPEC.md) — the concise normative spec (read front to back).
2. [`docs/SECURITY-REVIEW-MAP.md`](SECURITY-REVIEW-MAP.md) — the trusted surface.
3. [`docs/MAXIMUM-ASSURANCE.md`](MAXIMUM-ASSURANCE.md) — the strongest path and its root of trust.
4. [`docs/SHANNON-DEPLOYMENT.md`](SHANNON-DEPLOYMENT.md) — why the *combiner* is not the *deployment*.
5. [`docs/SEALED-PAD-TRANSFER.md`](SEALED-PAD-TRANSFER.md) — the computational delivery protocol (separate review).

The [`docs/TRUEPAD-3-WHITEPAPER.md`](TRUEPAD-3-WHITEPAPER.md) gives the argument in
paper form; the [`docs/INDEPENDENT-REVIEW-BRIEF.md`](INDEPENDENT-REVIEW-BRIEF.md)
lists the exact questions we want challenged.

## One-command verification

```
npm ci
npm run audit:security      # typecheck + unit + falsification/claims/no-verdict/no-pad-derived guards + build
npm run test:e2e            # Playwright browser suite
npm run test:tpm-interop    # OPTIONAL, needs Linux + swtpm + tpm2-tools (emulator interoperability, NOT hardware)
```

The falsification/mutation approach and the guard tests are described in the
review brief. Reproduced counts at this SHA: **1563 unit tests / 69 files**, **36
Playwright tests**, a **43-mutation** falsification matrix with **0 real escapes**.

## Known limitations and what is still open

- **swtpm is not a physical TPM.** All TPM evidence here is emulator
  interoperability. Physical-TPM hardware validation is **outstanding**
  (`docs/RELEASE-CHECKLIST-3.0.md`, `docs/PHYSICAL-TPM-VALIDATION.md`).
- **Mobile** (Android completion, native iOS) is not built; Secure Enclave is not
  assumed equivalent to a TPM monotonic authority (`docs/MOBILE-3.0-HANDOFF.md`).
- **Browser is never maximum-assurance** and a browser profile restore can rewind
  local state.
- Real-handheld QR-camera validation and human accessibility (TalkBack/VoiceOver)
  are **outstanding**.

## An explicit request

Internal AI adversarial audits and the falsification matrix are useful
*engineering* evidence — they are **not** an independent human security review.
TruePad 3.0 asks for exactly that before any formal 3.0.0 release. If you find a
real defect, please report it (see `SECURITY.md` for the disclosure route) — the
[`docs/INDEPENDENT-REVIEW-BRIEF.md`](INDEPENDENT-REVIEW-BRIEF.md) names the
findings that would block 3.0.
