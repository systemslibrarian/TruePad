# TruePad 3.0: authenticated one-time-pad key management with an operator-pinned root of trust

*A technical description. Development software (`3.0.0-dev.0`); the latest formal
release is TruePad 2.0.0. This paper describes the architecture and the exact
boundaries of its claims. It is not peer-reviewed and asserts no external audit.*

## Abstract

The one-time pad is unconditionally secret under premises that software cannot
establish and that operational software routinely violates: fresh, uniform,
secret, single-use pad material, delivered privately, with state discipline across
crashes, restores, and two-party use. TruePad implements the literal OTP combiner
and one-time Wegman–Carter authentication, then spends its engineering on the
*operational* premises — durable single-use consumption, rollback detection, a
TPM-anchored monotonic authority, and an operator-pinned root of trust for a
physical-ceremony pair — while separating, in code and in its user-facing claims,
the physical premises it cannot prove. Its strongest classification is
*conditional* and is always displayed beside the premises it has not established.
TruePad does not guarantee perfect secrecy as a product claim.

## 1. Motivation

"The cipher is information-theoretic" is true of `C = P ⊕ K` and irrelevant to
whether a deployment is secure. Every practical OTP fails at *key management*:
generation, delivery, and single-use. TruePad's thesis is that a tool should
enforce every one of those it can in software, refuse to overstate the rest, and
make the distinction legible to a reviewer.

## 2. Threat model

TruePad's maximum-assurance profile targets an attacker who can edit any
pair-directory file, restore stale pair directories, rewrite a pair's own
semantics, substitute other pairs' records, provision their **own** external TPM
authority, and run ordinary operations under crashes. It explicitly does **not**
defend against a hostile OS/kernel, a malicious administrator/root, a replaced
binary, compromised TPM firmware, or deliberate reprovisioning of the pinned trust
anchor. And no software layer claims to establish a physical premise (§17).

## 3. Why OTP deployments fail operationally

- **Reuse via crash** — a byte emitted before its consumption is durable.
- **Reuse via restore** — a store rolled back below its high-water sends again.
- **Reuse via clone** — the same state on two machines.
- **Delivery** — a pad delivered over any computational channel inherits that
  channel's assumptions; a courier that may have been observed is unprovable.
- **Claim drift** — an engineering step ("we combined two sources", "a TPM is
  present") silently promoted into a stronger cryptographic claim.

TruePad's design is a direct response to each.

## 4. TruePad architecture

A **pair** has two independent **directions**. A store holds pad material, a
partition into encryption vs one-time authentication material, monotonic
consumption cursors, an attempt ledger, and a freeze flag. Sending is a durable
*burn-before-output* transaction; receiving reserves an attempt, verifies, and
advances atomically. A single **deployment evaluator** maps recorded facts to one
of three classifications; every edition (CLI, Browser) feeds it the same facts and
none duplicates the decision or stores a verdict.

## 5. OTP confidentiality construction

Encryption is the literal XOR of plaintext with fresh pad octets, ciphertext
length equal to plaintext (or the fixed record size), each octet used once. This
has the Shannon property **only** when the OTP premises hold; a pad from a software
CSPRNG is a real, useful source and a **computational** assumption, not an
information-theoretic one, and TruePad classifies it as such.

## 6. One-time authentication

Each message carries a one-time Wegman–Carter tag (`wc-one-time-v1`, POLYVAL over
GF(2¹²⁸)). The forgery bound is information-theoretic **under the one-time-key
assumption**; TruePad draws WC material from the partitioned region, tracks it
durably, and reserves it so a crash cannot reissue it. It is not an AEAD and is not
described as computational.

## 7. Durable consumption state

Consumption is persisted before output (temp → fsync → rename → fsync directory).
If the durable commit succeeds and the output is lost, the material is spent and
the message lost — acceptable. A crash yields a weaker-or-lost state, never a
falsely-stronger one; a torn security-state file reads as absent (fail closed).

## 8. The rollback problem

State discipline is the residual after single-use is enforced locally. A restored
backup can re-present spent state. A **rollback witness** remembers the true
high-water in a separate failure domain and refuses a store that sits below it. A
plain separate-state-file witness detects a restore whose own witness was not also
restored — real protection, but restorable *with* the pair, so it does not satisfy
the maximum-assurance requirement.

## 9. TPM / platform authority

The `platform-monotonic` class anchors a local state file to a hardware TPM 2.0 NV
**counter** — a value that only counts up and is not in any backup. Each witnessed
advance and each ceremony transition consumes exactly one TPM increment through a
crash-safe PREPARE(T+1) → increment → verify sequence; a state whose anchor is
behind the counter is a detected restore. This proves **platform/state
monotonicity under the TPM's own trust assumptions** — and nothing about source
randomness, courier privacy, copies, or erasure.

## 10. Independent root-of-trust pinning

A subtle failure the design closes: `head.json` is unauthenticated
pair-directory data, so a pair that *names* its authority could name a forged or
foreign one. TruePad therefore records the installation's trusted authority in a
**pin** outside every pair directory (public identity only), and resolves a pair's
*claimed* authority against the pin through one shared function, reading the
**pinned** authority's state — never the location `head.json` names. A pair naming
any other authority is *untrusted* (not eligible); an unpinned installation is
*unavailable* (insufficient). There is **no trust-on-first-use**: pinning is an
explicit operator act. This was the last authority-laundering seam found and
closed (a pair may not choose its own root of trust).

## 11. Physical ceremony

A maximum-assurance pair passes a physical ceremony recorded in the pinned
authority as a monotone per-pair ladder: `ordinary → ceremony-created →
handoff-accepted`, with `withdrawn` terminal. `ceremony create` records creation;
`ceremony accept` records the operator's private-handoff assertion (and states
plainly that TruePad did not observe the courier); `ceremony withdraw` is a
permanent downgrade. Editing `provenance.json` cannot mint any of these — the
platform authority is load-bearing.

## 12. Fixed-record metadata privacy

The fixed-record profile frames each plaintext to a constant size, hiding its
exact length inside the OTP-encrypted frame. It is **metadata hardening**, not part
of the secrecy theorem; record count and timing remain visible. The maximum-
assurance ceremony requires it.

## 13. Sealed computational delivery

Sealed Pad Transfer delivers a `.tps2` package under X-Wing (a hybrid of ML-KEM-768
[FIPS 203] and X25519), HKDF-SHA-256, and AES-256-GCM. This delivery is
**computational, end to end**; a pad delivered this way is permanently not
eligible for an information-theoretic *delivery* claim, even though the subsequent
messages are still OTP+WC. Sealed ancestry cannot be laundered by export/re-import.

## 14. Browser limitations

A Browser pad keeps live state in OPFS (one rollback domain, no independent
witness) and generates from a software CSPRNG. It is never maximum-assurance,
whatever its origin. The browser presents its own honest classification and does
not invent a stronger evaluator. Mobile platforms inherit the same rule (a device
without a rollback-resistant monotonic authority is not the maximum-assurance
surface).

## 15. Assurance evaluator

The single evaluator returns **NOT ELIGIBLE** (a known disqualifier), **INSUFFICIENT
EVIDENCE** (a required strong fact not established), or **CONDITIONALLY ELIGIBLE**
(every software-enforceable maximum-assurance fact live and consistent — a native
ceremony pad, external-declared source, accepted private handoff, no sealed
ancestor, premises not withdrawn, fixed records, native storage, a live healthy
platform-monotonic authority that is this installation's pinned authority, and a
platform attestation of `handoff-accepted`). No `gold`/`perfectSecrecy`/
`trueRandom`/`informationTheoretic` flag is ever persisted, and no value derived
from pad bytes is persisted anywhere.

## 16. Security claims

TruePad claims: a literal OTP combiner; information-theoretic one-time WC
authentication under its one-time-key assumption; durable single-use enforcement;
rollback detection; a TPM-monotonic authority under the TPM's assumptions; an
operator-pinned root of trust that a pair cannot self-select; and honest,
per-layer separation of computational vs conditional-information-theoretic claims.
It does **not** claim perfect secrecy as a product, nor that any physical premise
has been established.

## 17. Physical premises software cannot establish

Even at the strongest verdict, unproven and the operator's responsibility:
physical uniformity of the source; source secrecy; source independence; absence of
extra copies/backups/snapshots; private courier behaviour; absence of any stale
external clone; and physical erasure on retirement. The strongest label is always
shown beside these.

## 18. Testing / falsification evidence

At this SHA: ~1563 unit tests across ~69 files; 36 Playwright browser tests; a
mutation-style falsification matrix (single-line mutations of security predicates
must be caught by a targeted test) totalling 43 mutations with 0 real escapes;
machine guards forbidding persisted verdicts and pad-derived metadata; claims
guards forbidding overstatement; and a TPM-**emulator** interoperability suite.
This proves the tests bite and the editions agree — it is **engineering evidence,
not proof of design correctness and not an independent human review**.

## 19. Limitations

- **swtpm is not a physical TPM.** All TPM evidence here is emulator
  interoperability. Physical-hardware validation is outstanding.
- **Source health, considered and declined.** TruePad accepts operator-supplied
  source files and refuses to certify entropy. We evaluated a narrow
  catastrophic-source-failure *rejection* layer and **declined** it: (a) sources
  are XOR-combined and "uniform if at least one source was uniform", so rejecting a
  dead source would refuse configurations that are actually secure; (b) NIST SP
  800-90B health tests (Repetition Count, Adaptive Proportion) require a known
  min-entropy the tool refuses to assign and detect only stuck/constant sources —
  they pass every weak-but-uniform PRNG, the failure that actually breaks an OTP;
  (c) a "passed" check invites the "entropy verified" misreading the whole product
  exists to prevent. TruePad had previously removed an equivalent all-zero check
  for the same reasons. A non-refusing UI *hint* remains possible as optional UX
  polish, outside the engine, claiming nothing.
- **Mobile** (Android completion, native iOS) is unbuilt; no mobile secure element
  is assumed equivalent to the TPM monotonic authority.
- **Browser** rollback exposure and OPFS eviction are real and disclosed.
- The X-Wing delivery KEM is an IETF **draft**, not an RFC.

## 20. Future independent validation

Before any formal 3.0.0: an **independent human cryptography/security review**
(see the review brief); **physical-TPM** hardware validation; **real-device**
Android/iOS validation; **human accessibility** (TalkBack/VoiceOver); and
**real-handheld QR** validation. None is satisfied by the internal evidence above.
Release gating is enumerated in `docs/RELEASE-CHECKLIST-3.0.md`.

---

*TruePad does NOT guarantee perfect secrecy as a product claim.*
