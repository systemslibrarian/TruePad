# TruePad 3.0 — Security-critical code map

This maps the smallest realistic **review surface** for TruePad 3.0. It is for a
reviewer who wants to check *correctness of the security claims* without reading
every UI file. Each entry names the file, its purpose, the invariant it must
hold, the consequence if it fails, and the tests that exercise it.

Master SHA this map describes: **`a6a8b6…` (3.0.0-dev.0)**. The literal OTP/WC
combiner and the message/SPT/QR wire are byte-identical to the released
**v2.0.0** (`240d7f0`); the 3.0 additions are the state/authority/ceremony
layers under `src/cli/v2/` and the single evaluator in `src/claims/`.

> **Not a claim of completeness.** This is the *intended* trusted surface. A
> reviewer should confirm nothing outside it can influence a security decision —
> in particular that UI code only presents facts the engine produced.

## Where verdicts are decided (read this first)

There is exactly **one** module that turns facts into a deployment
classification. Everything else assembles facts and calls it.

| File | Purpose | Invariant | Failure consequence | Tests |
| --- | --- | --- | --- | --- |
| `src/claims/shannon-deployment.ts` | The single deployment evaluator (`assessDeployment`) and its vocabulary | Pure, total; produces `conditionally-eligible` / `not-eligible` / `insufficient-evidence` from facts only; no edition duplicates the decision; no stored verdict | An overclaim (a computational/unknown/unpinned path reported as gold) | `shannon-deployment.test.ts`, `maximum-assurance.test.ts` (§38 single-evaluator guard) |

## A — OTP confidentiality core (unchanged since v2.0.0)

| File | Purpose | Invariant | Failure consequence | Tests |
| --- | --- | --- | --- | --- |
| `src/core/cipher-otp.ts` | The literal one-time-pad XOR combiner `C = P ⊕ K` | Ciphertext length == plaintext length; each key byte used once | Loss of the Shannon property; reuse | `cipher-otp` / `attack-otp` tests |
| `src/core/pad.ts` | Pair + direction model | A pad byte belongs to exactly one direction; offsets never wrap | Direction confusion; reuse | `pad`/store tests |
| `src/core/partition2.ts` | Partition of source material into encryption vs one-time auth material | Encryption bytes and Wegman–Carter key material are disjoint | Auth-material reuse breaks the WC bound | `partition2.test.ts` |
| `src/core/frame2.ts` | Fixed-record framing (length prefix + zero pad to F) | Frame capacity is `F−4`; the exact plaintext length is hidden inside the OTP-encrypted frame | Length-privacy overclaim, or a framing parse ambiguity | `frame2`/`fixed-*` tests |

## B — Authentication

| File | Purpose | Invariant | Failure consequence | Tests |
| --- | --- | --- | --- | --- |
| `src/core/wc-one-time.ts` | One-time Wegman–Carter authentication (`wc-one-time-v1`, POLYVAL) | Each WC key/mask used for exactly one message; canonical authenticated bytes | Forgery; the information-theoretic auth bound collapses on reuse | `wc-one-time.test.ts`, `tamper2.test.ts` |
| `src/core/gf128.ts` | GF(2¹²⁸) / POLYVAL field arithmetic | Matches the pinned field/reduction | Auth tag mismatch / forgery | `gf128`/`wc` tests |
| `src/core/envelope2.ts` | The message envelope — the canonical bytes that are authenticated and put on the wire | Exactly the frozen `WIRE_KEYS`; rejects extra keys; canonical serialization | Parsing ambiguity → forgery / direction confusion | `envelope2.test.ts` |
| `src/core/compact-envelope2.ts` | Compact presentation of the same envelope | Decodes to the identical canonical bytes | A compact/JSON mismatch that changes what is authenticated | `compact`/`envelope` tests |

## C — Storage & state discipline

| File | Purpose | Invariant | Failure consequence | Tests |
| --- | --- | --- | --- | --- |
| `src/cli/lock.ts` | The per-pair exclusive lock (`acquireLock`, `O_CREAT\|O_EXCL`) | Every burn/open/retire/ceremony transaction runs under this lock; a held lock refuses (never a stale-pid guess) | Concurrent transactions racing → pad/attempt reuse; accept-vs-accept or accept-vs-destroy races | `witness-concurrency.test.ts`, `ceremony-accept.test.ts` (concurrency), `truepad2-cli` |
| `src/cli/v2/store2.ts` | Store Format v2 (`head.json`, `secret.bin`, `journal.log`); durable writes (temp→fsync→rename→fsync dir) | LOSS IS ACCEPTABLE, REUSE IS NOT — persist consumption before output; head monotonic; strict head parse | Pad reuse after crash; a torn write that looks stronger | `store2`/`tamper2`/`truepad2-cli` tests |
| `src/cli/v2/truepad2.ts` | Burn/open/retire transactions, the CLI, and fact-assembly for the evaluator | Burn-before-output; attempt reservation before verify; the evaluator sees the same state under one lock; `head.json` never chooses the trust root | Reuse; direction confusion; authority self-selection | `truepad2-cli`, `witness-concurrency`, `shannon-status-cli`, `trust-root` tests |

## D — Rollback & platform authority (root of trust)

| File | Purpose | Invariant | Failure consequence | Tests |
| --- | --- | --- | --- | --- |
| `src/cli/v2/witness.ts` | Separate-state-file rollback witness | Detects a store restored below its high-water; never the maximum-assurance authority | Undetected rollback → reuse | `witness.test.ts`, `witness-concurrency.test.ts` |
| `src/cli/v2/tpm.ts` | tpm2-tools provider (read/increment NV counter) | Read-only ops never mutate; a non-counter/orderly/wrong-size index is refused | A non-monotonic "authority" accepted | `platform-witness.test.ts` (FakeTpm) |
| `src/cli/v2/platform-witness.ts` | Platform-monotonic TPM authority; the per-pair ceremony-assurance ladder; `resolvePlatformAuthority`; read-only `platformAssurance`/`platformHealth` | Each ladder advance consumes a TPM increment (crash-safe PREPARE→increment→verify); a stale state is anchor-caught; the probe never mutates; **resolution reads the PINNED authority, never head.json's** | Ceremony/rollback forgery; authority substitution | `platform-witness.test.ts`, `platform-assurance.test.ts`, `platform-health.test.ts` |
| `src/cli/v2/trust-store.ts` | The operator-pinned host root of trust (outside every pair directory) | Pin written only by `authority pin` (no trust-on-first-use); public identity only; fail-closed read | A pair choosing its own trust anchor → substitution | `trust-store.test.ts`, `trust-root.test.ts` |

## E — Ceremony, provenance, withdrawal

| File | Purpose | Invariant | Failure consequence | Tests |
| --- | --- | --- | --- | --- |
| `src/cli/v2/ceremony.ts` | `ceremony create/accept/withdraw` — the physical-ceremony state machine | Runs under the pair lock; every transition recorded in the pinned platform authority; one-way accept; terminal withdraw | Gen→ceremony laundering; fake accept; resurrected withdrawal | `ceremony.test.ts`, `ceremony-accept.test.ts` |
| `src/cli/v2/provenance.ts` | Pair-bound `provenance.json` (descriptive on a platform pair) | Strict, fail-closed; bound to both heads' `pairId`; a CLI store is never sealed | A transplanted/forged provenance raising a pair | `provenance.test.ts` |
| `src/cli/v2/withdrawal.ts` | Terminal-withdrawal sidecar (descriptive) | Fail-closed, pair-bound; the load-bearing terminal state is the platform authority | (sidecar only; deletion cannot resurrect a platform-attested withdrawal) | `withdrawal.test.ts`, `maximum-assurance.test.ts` |

## F — Sealed Pad Transfer (separate review; computational delivery)

`src/spt/*.ts` (`xwing-v1.ts`, `sealed-package.ts`, `crypto-v1.ts`,
`receive-request.ts`, `hkdf.ts`, `fingerprint.ts`, `bytes.ts`, `constants.ts`)
and the browser engine (`src/browser/engine/spt-*.ts`, `courier-format.ts`,
`handoff.ts`). This is **computational** delivery (X-Wing = ML-KEM-768 + X25519,
HKDF-SHA-256, AES-256-GCM). A pad delivered by `.tps2` is classified NOT ELIGIBLE
for the information-theoretic *delivery* claim, permanently. Review it as its own
protocol (see `docs/SEALED-PAD-TRANSFER.md`), not as part of OTP correctness.

## G — Browser presentation (never maximum-assurance)

`src/browser/engine/*` and `src/browser/ui/*`. A Browser pad keeps live state in
OPFS (one rollback domain, no independent witness) and generates from a software
CSPRNG, so it is **never** CONDITIONALLY ELIGIBLE. The browser is in scope for
its own claims (source honesty, rollback exposure) but is **not** part of the
maximum-assurance surface. Key files: `store.ts`, `verbs.ts`, `protocol.ts`,
`opfs-vfs.ts`, `ui/security-status.ts`, `ui/source-claims.ts`.

## H — QR presentation (transport only)

`src/browser/ui/qr/*` (`encode.ts`, `decode.ts`, `scan.ts`, `show-qr.ts`,
`payload.ts`, `svg.ts`). QR is a *transport* for the Sealed Pad Transfer receive
code — it carries no secret and changes no security property; it is presentation.

## What is NOT in the trusted surface

The exhibit/teaching material (`src/exhibit/*`, the v1 `truepad-pad` CLI under
`src/cli/`), wordlists, and DOM/rendering helpers do not make security decisions.
Confirm this rather than assume it: a reviewer's job includes checking that no UI
path can construct a `DeploymentFacts` or a verdict itself.

## One-command verification

```
npm run typecheck && npm test && npm run build && npm run test:e2e
```

The security-specific guards (falsification matrix, no-verdict and
no-pad-derived-metadata guards, claims guards) run inside `npm test`. The
TPM-emulator interoperability check is hardware-adjacent and runs separately (see
`docs/REVIEWER-START-HERE.md`). **swtpm is emulator interoperability evidence, not
physical-TPM validation.**
