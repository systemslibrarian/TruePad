# Shannon deployment — the combiner is not the deployment

TruePad's message cipher is a literal one-time-pad XOR: `C = P XOR K`. That is a
fact about the **combiner**, and it is easy to verify from the code. It is a
different thing from whether a **particular deployment** still satisfies the
premises under which Shannon's information-theoretic confidentiality theorem may
be invoked.

This document explains the distinction TruePad makes first-class, and how the
`truepad2 status` "DEPLOYMENT CLAIMS" section and the Browser Edition's Pad
details "Shannon deployment" line derive their result. The rule underneath all
of it:

> **TruePad records facts and operator declarations. It derives claims from
> them. It never stores a self-certifying security verdict.** There is no
> `trueRandom`, `informationTheoretic`, `itCapable`, `perfectSecrecy`,
> `shannonSecure`, or `certifiedEntropy` field in any store, and none may be
> added. Software cannot establish the facts such a flag would assert.

## 1. The combiner versus the deployment

The theorem needs more than a XOR. It needs, at least:

- **sufficient pad** — fresh pad material at least as long as the plaintext
  actually protected;
- **source** — pad symbols genuinely uniformly distributed;
- **secrecy / independence** — the pad unknown to the adversary and
  appropriately independent;
- **one-time use** — no pad symbol reused;
- **delivery / copy discipline** — only the intended parties obtained the pad;
- **state discipline** — stale copies, restores, or clones do not cause reuse.

TruePad can enforce or strongly support parts of the pad-length, one-time-use,
and state-discipline premises. It **cannot prove** physical randomness, source
independence, that only the intended parties hold the pad, private courier
behaviour, the absence of hidden copies, or physical erasure.

## 2. What the software actually enforces

Length and budget (a pad shorter than its plaintext is refused), irreversible
consumption (spent pad is never reclaimed — LOSS IS ACCEPTABLE, REUSE IS NOT),
separate one-time Wegman–Carter authentication material, attempt reservation,
crash-safe transitions, rollback witnesses, destruction boundaries, and
two-party state. These support the one-time-use and state-discipline premises.
None of them is a statement about the pad's physics.

## 3. What the operator asserts

The external-source path requires an explicit operator declaration — verbatim,
that at least one selected source is uniformly random, secret, previously
unused, and independent of the other sources and of the messages. **It is an
operator declaration and never a verification result.** Ticking it changes
nothing about the material and writes nothing to the store; the only record is
the existing `sourceDeclarations[]` (each source's name, the operator's own
origin note, and its length).

## 4. Why a software CSPRNG is not the physical-uniform-source claim

`crypto.getRandomValues` (Browser Edition) and any software CSPRNG are real,
useful sources — and a **computational** assumption. They are the DRBG output of
a seeded generator, not a physical uniform source whose distribution the theorem
takes as a premise. So a browser-generated pad is classified **NOT ELIGIBLE**
for the physical-uniform-source path. It may still be a perfectly reasonable way
to get bytes; it is simply a different claim.

## 5. Why sealed online delivery is computational

Sealed Pad Transfer delivers a `.tps2` package under X-Wing (ML-KEM-768 with
X25519), HKDF-SHA-256, and AES-256-GCM. That delivery is **computational end to
end**. A pad that arrived that way has a delivery premise that rests on
computational hardness, so its deployment is **NOT ELIGIBLE** for an end-to-end
information-theoretic pad-distribution claim — regardless of how the sender's
material was sourced. Ordinary messages after delivery still use OTP XOR plus
Wegman–Carter; the sealed cryptography has finished and never runs again. The
message content and the pad distribution are separate claims.

## 6. Why private handoff is an operator premise

A pad couriered privately on physical media can preserve the possibility of a
conditional information-theoretic deployment — **if** the OTP premises actually
hold. But TruePad cannot observe a courier. It cannot tell whether a medium was
secretly copied, whether a backup exists, or whether the handoff was truly
private. So private handoff is always recorded and reported as an **operator
premise**, never as *verified*, *confirmed*, or *proven*.

## 7. Why a witness is about reuse, not entropy

A rollback witness (a separate state file, or a TPM platform-monotonic counter)
addresses the **state-discipline** premise: it makes a restored or cloned store
detectable so a rolled-back pad cannot be reused. It says nothing about entropy,
pad secrecy, delivery, or erasure. `status` reports the witness class separately
from the deployment assessment for exactly this reason. A swtpm run demonstrates
interoperability, not physical-hardware monotonicity, and is never described as
the latter.

## 8. Why software deletion is not physical erasure

Destruction in TruePad forgets a reference and best-effort overwrites. **Software
can forget its reference to pad material; it cannot prove that flash forgot the
bytes.** A saved `.pad`, a backup, or an OS-synced copy is outside the software's
reach. No status line claims erasure was proved.

## 9. Why combining multiple sources does not prove uniformity

Two physical sources XORed together are **not** automatically uniform. The
correct statement is the one TruePad shows verbatim at generation:

> *"Uniform if at least one declared source was uniform and independent of the others."*

If at least one combined source is genuinely uniform and independent of the
rest, XOR preserves uniformity. Two biased or correlated sources do not become
proven uniform because TruePad XORed them, and TruePad runs no statistical test
that could certify the source premise — a chi-square or NIST-suite pass detects
some broken sources but never proves the Shannon source premise. TruePad
introduces no such certifying test.

## 10. How `status` derives its result

The assessment is a pure function of recorded facts, recomputed every time — no
stored verdict. Two axes feed it:

**Source class** — `external-declared` (operator-supplied, declared, unverified),
`software-csprng`, or `unknown`.
**Delivery class** — `local-generation`, `private-handoff-operator-asserted`,
`sealed-online`, `raw-import-unknown`, or `unknown`.

The classifier's ordering is load-bearing:

1. A **known** computational path — a software CSPRNG source, or sealed
   computational delivery — is **NOT ELIGIBLE**, and can never be promoted.
2. An **unknown** source or delivery is **INSUFFICIENT EVIDENCE**. Absence of
   evidence is never treated as an ideal ceremony.
3. Only an operator-declared external source with no recorded disqualifying
   delivery is **CONDITIONALLY ELIGIBLE** — and even then TruePad has proved none
   of the physical premises, which is why the label always travels with that
   qualification and is never shown as a bare "secure" badge.

Where the facts come from:

- **CLI (`truepad2 status`)** derives from `sourceDeclarations[]` (a CLI store
  always carries operator-declared external sources; there is no CSPRNG path in
  the CLI) and reports the witness class separately. A CLI store is
  CONDITIONALLY ELIGIBLE, with the physical premises left, honestly, unproven.
- **Browser Edition** derives from the pad's `origin` (`generated-here` →
  software CSPRNG; `imported` → source unknown) and, for an imported pad, whether
  a durable sealed-receive marker (`consumed.json`) names it (→ `sealed-online`).
  A browser pad is therefore always NOT ELIGIBLE (generated) or NOT
  ELIGIBLE / INSUFFICIENT EVIDENCE (imported) — the honest thing to say, because
  the Browser Edition cannot supply the physical-source premise.

The classification is a factual statement about what TruePad has and has not
recorded. It is not a security score, and a NOT ELIGIBLE or INSUFFICIENT
EVIDENCE result does not make ordinary message encryption any weaker than the
OTP-plus-Wegman–Carter it already is.
