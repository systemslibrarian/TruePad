# Shannon deployment — the combiner is not the deployment

TruePad's message cipher is a literal one-time-pad XOR: `C = P XOR K`. That is a
fact about the **combiner**, and it is easy to verify from the code. It is a
different thing from whether a **particular deployment** still satisfies the
premises under which Shannon's information-theoretic confidentiality theorem may
be invoked.

This document explains the distinction TruePad makes first-class, and how the
`truepad2 status` "DEPLOYMENT ASSESSMENT" section and the Browser Edition's Pad
details "Deployment assessment" line derive their result. The strongest,
maximum-assurance path — the physical ceremony plus an accepted private handoff —
has its own operator-facing companion, [MAXIMUM-ASSURANCE.md](MAXIMUM-ASSURANCE.md).
The rule underneath all of it:

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

## 10. Plain `gen` is not the ceremony

The most important honesty fix in this profile: a plain `truepad2 gen` store must
not look like a ceremony store. `gen` is a convenience — it takes whatever source
files you name and builds a pair, with no assertion that the generation was
offline, that the sources came from distinct physics, that the workspace was
memory-backed, or that no copy remains. `truepad2 ceremony create` is the
physical-ceremony path, and it *requires* those operator assertions.

So the two are recorded as different **creation** facts (`cli-gen` versus
`cli-ceremony`) in a strict, durable `provenance.json` beside the store, and the
evaluator treats plain-gen creation as a **known disqualifier**: a `gen` store is
**NOT ELIGIBLE**, with the reason *"the pad was generated by plain gen, not the
physical ceremony."* No convenience operation — copy, restore, re-status — ever
rewrites `cli-gen` into `cli-ceremony`.

## 11. The one-way private-handoff acceptance

`ceremony create` can record that a pair was *made* by the ceremony, but it
cannot record that the private courier handoff *happened* — that fact exists only
after the two media reach their peers, and only the operator holds it. So a
freshly created ceremony pair is **INSUFFICIENT EVIDENCE**: the delivery premise
is still `local-only`.

`truepad2 ceremony accept <medium> --as A|B --assert-private-handoff
--assert-no-extra-copy` is the one-way boundary that records it. It refuses
anything but a ceremony pad whose premises were accepted; it requires both
operator assertions; it writes the durable `delivery = physical private handoff
(operator premise)` fact before it reports; and it prints a pad-book record that
says plainly **TruePad recorded an operator assertion and did not observe the
courier.** The transition is one-way: a second `accept` refuses, and no operation
moves the delivery back.

## 12. How `status` derives its result

The assessment is a pure function of recorded facts through **one** evaluator
(`src/claims/shannon-deployment.ts`), recomputed every time — no stored verdict.
Every edition assembles the same seven facts from its own durable store and calls
that evaluator; no edition invents its own rule.

The facts are the immutable provenance — **creation**, **source**, **delivery**,
**sealed-ancestor** (permanent once a sealed `.tps2` appears in the lineage), and
**ceremony-premises** — plus the live **storage authority** (native filesystem,
or ordinary browser storage) and the **rollback witness** class.

The evaluator's ordering is load-bearing:

1. A **known** disqualifier is **NOT ELIGIBLE** and can never be promoted: a
   software CSPRNG source; a sealed `.tps2` delivery or any sealed ancestor;
   ordinary browser storage as the live authority (one rollback domain, no
   independent witness); a withdrawn ceremony premise; or plain-`gen` creation.
2. The **one strongest path** — a native ceremony pad, external-declared source,
   private handoff *accepted*, no sealed ancestor, premises accepted, and an
   independent rollback witness — is **CONDITIONALLY ELIGIBLE**. Even then
   TruePad has proved none of the physical premises, so the label always travels
   with the six it did not prove and is never shown as a bare "secure" badge.
3. Everything else is **INSUFFICIENT EVIDENCE**: the strong premises are not all
   recorded, and absence of evidence is never treated as an ideal ceremony.

Where the facts come from:

- **CLI (`truepad2 status`)** reads the strict `provenance.json` (fail-closed:
  any malformation or self-contradiction is treated as UNKNOWN provenance), holds
  live state on the native filesystem, and reports the witness class separately.
  A `gen` store is NOT ELIGIBLE; a ceremony store is INSUFFICIENT until its
  handoff is accepted, then CONDITIONALLY ELIGIBLE.
- **Browser Edition** reads the pad's `origin` (`generated-here` → software
  CSPRNG; `imported` → source unknown) and, for an imported pad, whether a durable
  sealed-receive marker (`consumed.json`) names it (→ `sealed-tps2`, a permanent
  sealed ancestor). A Browser Edition pad *always* holds its live state in
  ordinary browser storage, which is itself a known disqualifier, so a browser
  pad is **never** CONDITIONALLY ELIGIBLE — whatever its origin. The maximum-
  assurance surface is the native ceremony, not the browser.

The classification is a factual statement about what TruePad has and has not
recorded. It is not a security score, and a NOT ELIGIBLE or INSUFFICIENT
EVIDENCE result does not make ordinary message encryption any weaker than the
OTP-plus-Wegman–Carter it already is.
