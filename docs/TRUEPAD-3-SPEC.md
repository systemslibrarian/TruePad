# TruePad 3.0 — Normative Specification

Status: **development** (`3.0.0-dev.0`). This document is the concise, normative
description of TruePad 3.0: what an implementation MUST, SHOULD, and MUST NOT do,
and what a reviewer can rely on. Rationale is kept brief and links to the detailed
documents; audit history lives in those documents, not here.

Requirement words (MUST, MUST NOT, SHOULD, SHOULD NOT, MAY) are used per RFC 2119
/ RFC 8174 intent. The **byte-level** message, storage, and Sealed-Pad-Transfer
formats are specified normatively in [FORMAT-V2.md](FORMAT-V2.md) (frozen, from
the 2.0 line) and [SEALED-PAD-TRANSFER.md](SEALED-PAD-TRANSFER.md); this spec
governs the *behaviour and security invariants*, not a re-statement of the bytes.

Overarching rule, referenced throughout: **LOSS IS ACCEPTABLE, REUSE IS NOT.**

---

## 1. Terminology

- **Pad / key material `K`** — secret random octets, consumed once.
- **Pair** — two peers sharing pad material, with two independent **directions**.
- **Direction** — `A->B` or `B->A`; a one-way channel with its own pad region and
  its own consumption state.
- **Combiner** — the literal one-time-pad XOR, `C = P ⊕ K`.
- **Deployment** — a particular installation/use of the combiner; whether it still
  satisfies the one-time-pad premises is a *separate* question from the combiner.
- **Ceremony** — the physical generation/handoff procedure that a maximum-assurance
  pair passes through.
- **Authority (platform)** — a TPM-anchored monotonic counter + local state file
  that records rollback high-water and per-pair ceremony assurance.
- **Trust pin** — the operator's declaration of which platform authority this
  installation trusts, stored outside every pair directory.
- **Deployment evaluator** — the single function mapping recorded facts to one of
  three classifications.

## 2. Threat model

The maximum-assurance profile MUST resist an attacker who can: edit, replace, or
delete any **pair-directory** file (`head.json`, `provenance.json`,
`withdrawal.json`, and any file placed inside a pair directory); restore stale
pair directories; rewrite a pair's own semantics; substitute another pair's
records; provision and name their **own external** TPM authority; and run ordinary
CLI operations, including under crash/torn-write conditions.

It MUST NOT claim resistance against: a hostile OS or kernel; a malicious
administrator or root; a replaced TruePad binary; compromised TPM firmware; or
deliberate reprovisioning of the pinned platform trust anchor or host trust
configuration. These are documented limits, not defended positions.

Software MUST NOT claim to establish any **physical** premise (see §28).

## 3. Pair model

An implementation MUST represent a pair as two directions, each with: pad region,
authentication material region, a monotonic consumption cursor, an attempt ledger,
and a freeze flag. The two directions MUST be independent: consuming in one MUST
NOT advance the other. A store MUST carry a public, non-secret `pairId` identical
across both directions' headers; a pair whose two halves disagree on `pairId` is a
spliced pair and MUST NOT be treated as a single pair for any ceremony or
maximum-assurance decision.

## 4. Direction separation

Every message MUST be bound to its direction. The authenticated byte-string
(§9) MUST include the direction (or a value that makes cross-direction replay a
verification failure). An implementation MUST NOT allow a ciphertext or auth tag
produced for one direction to verify or decrypt as the other. `pairId` binding is
public identity only and MUST NOT be derived from pad bytes.

## 5. Pad partition

Source octets MUST be partitioned so that the octets used as **encryption** pad
and the octets used as **one-time authentication** material are disjoint. An
implementation MUST NOT reuse an encryption octet as auth material or vice versa.
The partition is fixed at generation and recorded in the header; it MUST NOT be
revisable after generation.

## 6. Message framing

A message MAY be framed. In the **fixed-record** profile (§19) a plaintext is
framed to exactly `F` octets (a u32 little-endian length prefix, the plaintext,
then zero padding), giving capacity `F − 4`. The exact plaintext length MUST then
be hidden inside the OTP-encrypted frame; a plaintext exceeding `F − 4` MUST be
refused before anything is consumed. Framing is metadata hardening; it MUST NOT be
described as part of the OTP secrecy theorem.

## 7. OTP encryption

Encryption MUST be the literal XOR of plaintext with fresh pad octets:
`C[i] = P[i] ⊕ K[offset+i]`. Ciphertext length MUST equal plaintext length (or the
fixed record size). Each pad octet MUST be used at most once across the store's
entire life. An implementation MUST NOT substitute a stream cipher, KDF-expanded
key, or any computational construction for `K` and still call the result a
one-time pad.

## 8. Wegman–Carter authentication

Each message MUST be authenticated with a one-time Wegman–Carter tag
(`wc-one-time-v1`, POLYVAL over GF(2¹²⁸)). The WC key/mask for a message MUST be
used for exactly one message. The information-theoretic forgery bound holds only
under this one-time-key assumption; an implementation MUST NOT reuse WC material,
and MUST reserve/advance WC state so that a crash cannot reissue the same WC key.
An implementation MUST NOT replace WC with a computational AEAD and describe the
bound as information-theoretic.

## 9. Canonical authenticated bytes

The exact octet string that is authenticated MUST be canonical and unambiguous.
The message envelope MUST carry exactly the frozen wire keys and MUST reject any
extra key. Two distinct semantic messages MUST NOT be able to serialize to the
same authenticated bytes, and one message MUST NOT admit two valid
serializations that a verifier would accept differently (no parser ambiguity).
See [FORMAT-V2.md](FORMAT-V2.md) §6 and `envelope2.ts`.

## 10. One-time authentication material

Authentication material MUST be one-time and drawn from the partitioned region
(§5). The implementation MUST track auth-material consumption durably and MUST
refuse to send when it cannot (fail closed). Verification attempts against a
received sequence MUST be bounded (§13).

## 11. Burn / open transaction rules

**Send (burn):** the implementation MUST durably record the consumption of pad and
auth material **before** releasing the ciphertext/tag (burn-before-output). If the
durable commit succeeds but the output is lost, the material is spent and the
message is lost — acceptable. If the commit fails, nothing may have been emitted.

**Receive (open):** the implementation MUST reserve a verification attempt (§13)
**before** verifying, MUST verify the tag, and MUST advance receive state
atomically with acceptance. A failed verification MUST NOT advance the accept
cursor, and MUST consume an attempt.

Both MUST hold the pair lock for the whole transaction.

## 12. Crash semantics

For every state transition the implementation MUST define its crash points such
that a crash yields a **weaker-or-lost** state, never a **falsely-stronger** one.
Durable writes MUST be atomic (temp → fsync → rename → fsync directory). A torn or
partial security-state file MUST read as absent/invalid (fail closed), never as a
partial record that looks more assured than what was durably established.

## 13. Attempt reservation

Each received sequence MUST have a bounded number of verification attempts,
reserved durably **before** the attempt. Exhausting the limit MUST permanently
contest that sequence (it can never accept). A restore that rolled back only the
attempt count MUST be detectable via the rollback authority (§14). This prevents a
restored store from refilling a contested record's guesses.

## 14. Rollback witnesses

A pair MAY be configured with a rollback witness that remembers the store's true
high-water in a separate failure domain, so a store restored *below* its witness
is detectable and refused. Two witness classes exist:

- **separate-state-file** — a plain file in another location. It detects a stale
  restore whose own witness was not also restored. It is real rollback protection
  but MUST NOT satisfy the maximum-assurance rollback requirement (it can be
  restored together with the pair).
- **platform-monotonic** — §15.

A witness says nothing about entropy, delivery, or erasure. An implementation MUST
report the witness state separately from the deployment classification, and MUST
refuse a send when a configured witness shows the store is behind it.

## 15. Platform-monotonic authority

The `platform-monotonic` class (provider `tpm2-nv-counter-v1`) anchors a local
state file to a hardware TPM 2.0 **NV counter** — an external value that only
counts up and cannot be restored from a backup. The implementation MUST require the
index to be a non-orderly 8-octet COUNTER and MUST bind to its TPM **Name**. Each
witnessed advance and each ceremony-assurance transition (§17) MUST consume exactly
one TPM increment via a crash-safe PREPARE(state at T+1) → increment → verify
sequence. A state file whose anchor is **behind** the TPM (a restore) or
inconsistent MUST fail closed. Read-only probes MUST NOT increment the TPM or
settle a prepared commit.

This authority proves **platform/state monotonicity** under the TPM's own trust
assumptions. It MUST NOT be represented as proving source randomness, courier
privacy, absence of copies, or physical erasure.

## 16. Independent trusted-authority pin (root of trust)

A pair MUST NOT choose its own root of trust. `head.json` is unauthenticated
pair-directory data; it MAY *reference* a platform authority but MUST NOT *define*
which authority is trusted. The installation's trusted authority MUST be recorded
in a **trust pin** stored OUTSIDE every pair directory (a host trust store),
holding only the public identity (provider, `authorityId`, NV index, NV Name) and
the trusted state-file location.

Every platform-authority consumer (status/verdict, burn/open/retire, ceremony
create/accept/withdraw) MUST resolve a pair's *claimed* authority against the pin
through one shared function and MUST read the **pinned** authority's state — never
the location `head.json` names. A pair claiming any other authority MUST be
`untrusted` (NOT ELIGIBLE and refused); an unpinned installation MUST be
`unavailable` (INSUFFICIENT, and platform operations refused). There MUST be **no
trust-on-first-use**: a pin is written only by an explicit operator command
(`authority pin`) that inspects the live TPM, shows the public identity, and
requires explicit confirmation. A malformed/torn/deleted pin MUST fail closed to
unpinned; the implementation MUST NOT silently re-enroll.

The pin is durable and outside the pair-writable domain; its protection is stated
against the §2 boundary only, not against a hostile OS/root/binary.

## 17. Ceremony state machine

A maximum-assurance pair MUST pass a physical ceremony recorded in the pinned
platform authority as a monotone, per-pair ladder:

```
ordinary → ceremony-created → handoff-accepted        (withdrawn is terminal)
```

- `ceremony create` MUST record `ceremony-created` (against the pinned authority),
  requiring the operator assertions (offline, distinct physics, tmpfs workspace,
  no persistent copy) which the tool records but cannot verify.
- `ceremony accept` MUST advance to `handoff-accepted` — refusing unless the
  authority already attests `ceremony-created` — recording the operator's private-
  handoff assertion, and stating plainly that TruePad did not observe the courier.
- Each transition MUST run under the pair lock, refuse a tombstoned/half/spliced/
  wrong-pair/unpinned/mismatched pair, and be durable before it reports.

An implementation MUST NOT let editing `provenance.json` produce `handoff-accepted`
(the platform authority is load-bearing; provenance is descriptive on a platform
pair).

## 18. Terminal withdrawal

`ceremony withdraw` MUST record a terminal `withdrawn` in the pinned platform
authority (for a platform pair). Once recorded, the pair MUST read NOT ELIGIBLE,
MUST refuse re-acceptance, and the downgrade MUST survive deleting or corrupting
any pair-directory sidecar and restoring older provenance. `withdrawn` is terminal:
no transition leaves it. (For a pair with no platform authority, a withdrawal is a
descriptive sidecar within the already-non-gold band; the implementation MUST NOT
present such a pair as maximum-assurance.)

## 19. Fixed-record profile

The fixed-record profile (§6) is a **metadata-hardening policy**. The physical
ceremony MUST require fixed records. An implementation MUST NOT describe fixed
records as an axiom of the OTP secrecy theorem, and MUST state that record count
and timing remain visible.

## 20. Provenance semantics

A CLI store MUST carry a strict, fail-closed, pair-bound `provenance.json`
recording facts (creation, source class, delivery, sealed-ancestor,
ceremony-premises) — never a self-certifying verdict. It MUST bind to the pair's
`pairId`; a record whose `pairId` does not match the heads MUST read as UNKNOWN. On
a platform pair, provenance is corroborating/descriptive; the load-bearing ceremony
facts are the platform authority (§16–§18).

## 21. Sealed ancestry

If a pad's lineage contains a sealed (`.tps2`) delivery, the sealed-ancestor fact
is **permanent** and the deployment MUST be NOT ELIGIBLE for the information-
theoretic *delivery* claim. An implementation MUST NOT allow export/re-import or
any convenience operation to launder sealed ancestry.

## 22. Browser classification

A Browser Edition pad keeps live state in ordinary browser storage (OPFS) — one
rollback domain with no independent witness — and generates from a software CSPRNG.
It MUST be classified **NOT ELIGIBLE** for maximum assurance regardless of origin.
The browser MUST NOT present a maximum-assurance verdict or invent a stronger
evaluator.

## 23. Sealed Pad Transfer classification

Sealed Pad Transfer delivers a `.tps2` package under X-Wing (ML-KEM-768 + X25519),
HKDF-SHA-256, and AES-256-GCM. This delivery is **computational, end to end**. The
message content after delivery is still OTP+WC, but the *delivery* premise rests on
computational hardness; the deployment MUST be NOT ELIGIBLE for an end-to-end
information-theoretic pad-distribution claim. See [SEALED-PAD-TRANSFER.md](SEALED-PAD-TRANSFER.md).

## 24. Import / restore behaviour

An imported pad's source is UNKNOWN to the receiver; its delivery is sealed
(computational) only if a durable sealed-receive marker names it, else raw-import
UNKNOWN. Restoring a store below its rollback witness MUST be refused (§14). An
implementation MUST NOT reconstruct absent provenance into a stronger story.

## 25. Failure / refusal rules

Every security decision MUST fail closed. A refusal MUST consume nothing (free
refusal) wherever the check is a preflight. Availability failures (an unreachable
witness/authority) MUST map to INSUFFICIENT, not to a stronger result and not to
silent success. A positive rollback/corruption/substitution signal MUST map to NOT
ELIGIBLE. Refusals MUST be typed and state the consequence.

## 26. Deployment evaluator

There MUST be exactly one module that maps recorded facts to a classification. All
editions MUST assemble the same fact set and call it; no edition may duplicate the
decision or persist a verdict. The classifications are:

- **NOT ELIGIBLE** — a known disqualifier (software CSPRNG source; sealed delivery/
  ancestor; browser storage; withdrawn/inconsistent authority; plain-gen creation;
  regressed/inconsistent witness; untrusted authority).
- **INSUFFICIENT EVIDENCE** — a required strong fact is not currently established
  (unpinned/unreachable authority; handoff not accepted; separate-state-file only;
  unknown provenance).
- **CONDITIONALLY ELIGIBLE** — every software-enforceable maximum-assurance fact is
  live and consistent (see §27), shown beside the physical premises not proved.

No `shannonEligible` / `goldStandard` / `perfectSecrecy` / `maximumSecurity` /
`trueRandom` / `informationTheoretic` flag may exist in any store, and no
pad-derived value (hash/fingerprint/MAC of pad bytes) may be persisted anywhere.

## 27. Maximum-assurance conjunction

`CONDITIONALLY ELIGIBLE` requires, in substance, ALL of: creation = physical
ceremony; source = external-declared; delivery = physical private handoff
(operator-asserted, accepted); no sealed ancestor; ceremony premises accepted and
not withdrawn; fixed authenticated record profile; native live storage authority;
a **live, healthy platform-monotonic** rollback authority; that authority
**pinned and trusted** by this installation, matching the live TPM; the platform
authority attesting **`handoff-accepted`** for this exact pair; consistent pair
identity; no contradictory security-state; no rollback/regression; and no terminal
withdrawal. Any missing, unknown, or degraded element MUST prevent the verdict.

## 28. Physical premises software does not prove

Even at the strongest verdict, TruePad has NOT proved, and the operator remains
responsible for: physical uniformity of the source; source secrecy; source
independence (of the other sources and of the messages); the absence of extra
copies, backups, or synced snapshots; that the courier handoff was private; that
no stale external clone can cause reuse; and that pad material was physically
erased on retirement. The strongest label MUST always be displayed beside these.

**TruePad does NOT guarantee perfect secrecy as a product claim.**
