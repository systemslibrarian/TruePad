# Maximum-assurance OTP — the strongest path TruePad software can support

This is the operator-facing companion to
[SHANNON-DEPLOYMENT.md](SHANNON-DEPLOYMENT.md). It describes the single strongest
deployment TruePad will classify — **CONDITIONALLY ELIGIBLE** — how to reach it,
and, just as important, exactly what it does and does not mean.

> **What "maximum assurance" is not.** It is not proof of information-theoretic
> security. Software cannot establish the physical premises the one-time-pad
> theorem needs — genuine physical randomness, source independence, a truly
> private courier, the absence of hidden copies, or physical erasure. This
> profile enforces every premise software *can*, records the operator premises it
> *cannot* verify honestly and immutably enough that ordinary operations cannot
> launder them, and states the remaining physical premises every time it shows
> the strongest label. It never converts a computational fact into an
> information-theoretic one by wording.

## The threat boundary (what "cannot launder" means)

The maximum-assurance profile is designed to resist an attacker who can **edit,
replace, or delete ordinary pair-directory files** — `provenance.json`,
`withdrawal.json` — and **restore stale pair directories**, without letting any
of that raise the classification. Concretely it resists: same-pair semantic
rewriting, cross-pair substitution, provenance replacement/deletion, withdrawal
replacement/deletion, stale directory restoration, stale-state cloning, ordinary
supported CLI operations, and accidental crashes/torn writes.

It does **not** claim resistance against a party that can replace the TruePad
binary, replace the kernel, compromise the OS, compromise TPM firmware, or
deliberately reprovision the platform trust anchor. Those remain platform and
operator limits. The load-bearing ceremony facts therefore live in the
**TPM-anchored platform authority** (see below), whose state file sits *outside*
the pair directory and whose transitions are bound to a hardware monotonic
counter — so editing pair-directory JSON cannot mint or resurrect them.

## The classification is derived, never stored

TruePad records **facts** and bounded **operator declarations**, and derives the
classification from them through one shared evaluator every time it is asked. No
store ever holds a self-certifying verdict — there is no `trueRandom`,
`itCapable`, `perfectSecrecy`, `shannonSecure`, `maximumSecurity`, or
`goldStandard` field anywhere, and none may be added. Downgrades are allowed;
assurance is never *upgraded* by a convenience operation.

## The eight facts

The evaluator (`src/claims/shannon-deployment.ts`) takes exactly these, and every
edition assembles them from its own durable store:

| Fact | What it records |
| --- | --- |
| **creation** | how the pad was made — `cli-ceremony`, `cli-gen`, `browser-generated`, `imported`, or `unknown` |
| **source** | how the material was sourced — `external-declared`, `software-csprng`, or `unknown` |
| **delivery** | how it reached its holder — `physical-private-operator-asserted`, `local-only`, `sealed-tps2`, `raw-import-unknown`, or `unknown` |
| **sealed-ancestor** | whether any sealed `.tps2` appears in the lineage — **permanent** once true |
| **ceremony-premises** | the operator-premise state — `accepted`, `absent`, `withdrawn`, or `unknown` |
| **storage** | where live state is held — `native` filesystem, or `browser-opfs` |
| **rollback-authority** | the LIVE reuse/rollback authority — its class AND current health (reachable, consistent, not behind the store), obtained under the pair lock |
| **assurance-authority** | what the INDEPENDENT platform authority attests for this pair — `handoff-accepted` / `ceremony-created` / `withdrawn` / `ordinary` / `unavailable` / `inconsistent`. This is the strong ceremony fact that pair-directory JSON cannot forge (see below) |

Every fact is bound to the exact pair by the public `pairId`: a strong provenance
record transplanted beside another pair does not apply to it (see
[SHANNON-DEPLOYMENT.md §13](SHANNON-DEPLOYMENT.md)).

## Reaching CONDITIONALLY ELIGIBLE

Only this exact conjunction reaches the strongest label, and it exists only on the
native CLI. Each step records a fact the previous one could not:

0. **Pin the installation's trusted platform authority** (once) — `truepad2
   authority pin …` (see below). Ceremony operations and the strongest verdict
   are refused until an authority is pinned; a pair may never choose the trust
   root.

1. **Generate by the physical ceremony, anchored to the pinned TPM.** `truepad2
   ceremony create <workspace> --medium-a A --medium-b B --source … --source …
   --record-bytes F --encryption-bytes E --auth-records N --witness-class
   platform-monotonic --witness-path … --assert-offline --assert-distinct-physics
   --assert-tmpfs-workspace --assert-no-persistent-copy`. This records `creation =
   cli-ceremony`, external source, ceremony premises **accepted**, and provisions
   two peer media, each a full byte-verified pair copy. Delivery is still
   `local-only`, so the pad is **INSUFFICIENT EVIDENCE** — the courier has not run.

2. **Use a live platform-monotonic (TPM) rollback authority.** A witness is about
   **reuse**, not entropy or delivery. For the maximum-assurance profile the
   rollback authority must be a live, reachable, consistent, non-regressed TPM NV
   counter (`--witness-class platform-monotonic`). A `separate-state-file` witness
   remains fully supported and strongly rollback-protected, **but it can be
   restored together with the pair**, so it does *not* satisfy the maximum-
   assurance requirement — an accepted ceremony pad backed only by one stays
   INSUFFICIENT, and status says so in its rollback-authority detail line. Because
   the authority is checked **live**, a TPM that is unreachable, regressed, or
   inconsistent drops the verdict; the label never appears without a live TPM.

3. **Accept the private handoff, once the media have reached their peers.**
   `truepad2 ceremony accept <medium> --as A|B --assert-private-handoff
   --assert-no-extra-copy`. This is the one-way boundary. It runs under the pair
   lock; refuses a tombstoned, half, spliced, non-ceremony, sealed-lineage,
   wrong-pair-bound, withdrawn, or unreadable-provenance store, or a missing
   assertion; **advances the independent platform authority to `handoff-accepted`
   for this pair** (which refuses unless the authority already attests
   `ceremony-created` — so a forged provenance the authority never recorded cannot
   be accepted); writes the descriptive `provenance.json`; and its pad-book record
   says plainly that **TruePad recorded an operator assertion and did not observe
   the courier.**

With `creation = cli-ceremony`, external-declared source, delivery accepted, no
sealed ancestor, premises accepted, **native** storage, a **live, healthy
platform-monotonic** rollback authority, **and the platform authority attesting
`handoff-accepted` for this pair**, `truepad2 status` shows **CONDITIONALLY
ELIGIBLE** — beside the six premises below.

## The independent platform ceremony authority (why editing JSON cannot mint gold)

`provenance.json` is an ordinary, editable pair-directory file. On its own it is
enough to *describe* a ceremony — but not to *prove* one: a plain-`gen` pair whose
`provenance.json` is hand-edited to claim `creation = cli-ceremony`,
`ceremony-premises = accepted` reads that way to the file parser. So the
**load-bearing** ceremony facts do not live in `provenance.json` at all.

They live in the **platform authority** — the same TPM-anchored
`platform-monotonic` witness the strongest verdict already requires. Its state
file sits *outside* the pair directory, and it records, per pair, a monotone
ceremony ladder:

```
ordinary → ceremony-created → handoff-accepted        (withdrawn is terminal)
```

Each advance is a real ceremony operation that consumes a **TPM increment**:
`ceremony create` records `ceremony-created`; `ceremony accept` advances to
`handoff-accepted`; `ceremony withdraw` records the terminal `withdrawn`. The
evaluator requires `assurance-authority = handoff-accepted` for the strongest
verdict, and reads it with a strictly read-only probe. Consequences:

- A plain-`gen` pair the authority never recorded reads `ordinary`. Editing its
  `provenance.json` changes nothing the evaluator trusts, and `ceremony accept`
  refuses (it cannot advance `ordinary → handoff-accepted`).
- A stale restore of the authority's own state file is caught by its TPM anchor
  and reads `inconsistent` — NOT ELIGIBLE.
- A pair cloned to a machine **without** the correct platform authority reads
  `unavailable` — never gold.

## Withdrawing a ceremony premise (a permanent downgrade)

`truepad2 ceremony withdraw <medium> --as A|B [--reason …]` records a supported,
one-way downgrade. On a **platform pair** it advances the platform authority to
the terminal `withdrawn` — so the downgrade **survives deleting or corrupting
`withdrawal.json`, and survives restoring an older `provenance.json`**, because
the evaluator reads the terminal state from the independent authority (a stale
restore of that authority is caught by its anchor). A descriptive
`withdrawal.json` sidecar is also written. (On a pair with **no** platform
authority — never a maximum-assurance pair — the sidecar is the only record, so a
withdrawal there is a best-effort downgrade within the already-non-gold band.) A
withdrawn pair cannot re-accept a handoff. See
[SHANNON-DEPLOYMENT.md §14](SHANNON-DEPLOYMENT.md).

## The six premises that remain yours

The strongest label never appears alone. TruePad has **not** proved, and you
remain responsible for:

- at least one source was genuinely uniform and secret;
- the source was independent of the other sources and of the messages;
- no extra copies, backups, or cloud-synced snapshots exist;
- the courier handoff was actually private;
- no stale external clone can cause reuse;
- the pad material was physically erased on retirement.

## Why the Browser Edition is never the maximum-assurance surface

A Browser Edition pad always holds its live state in ordinary browser storage
(OPFS), which is one rollback domain with no independent host witness — a known
disqualifier on its own. A browser-generated pad is additionally a software
CSPRNG source, and a sealed-delivered pad carries a permanent sealed ancestor. So
a browser pad is **never** CONDITIONALLY ELIGIBLE, whatever its origin. That is
the honest thing to say, not a defect: the maximum-assurance path is the native
ceremony.

## What fails closed

Malformed, torn, contradictory, absent, or **wrong-pair** provenance is read as
**UNKNOWN**, which maps to INSUFFICIENT EVIDENCE — never a stronger result. A
crash during a provenance write leaves the old record or none, never a torn one
and never one that looks more assured than what was durably established. A
restored or cloned store keeps its recorded creation; relocating a `gen` store
never makes it a ceremony store; transplanting a strong record beside another
pair never raises it; **rewriting a pair's own `provenance.json` into a ceremony
story never reaches gold, because the ceremony fact lives in the platform
authority, not the JSON.** The rollback and ceremony authorities are both checked
**live** under the pair lock, so a witness or authority that has gone unreachable,
regressed, or inconsistent drops the verdict immediately rather than leaving a
stale green. A durable withdrawal on a platform pair cannot be undone by deleting
or corrupting the sidecar or by restoring old provenance. **A pair that names any
platform authority other than the installation's pinned one — including an
attacker's own external, internally-valid TPM authority pre-loaded with the
victim `pairId` — is NOT ELIGIBLE and cannot burn, because the trust root is the
pin, not the pair.** Every one of these is exercised by the falsification,
hostile-input, concurrency, pair-substitution, same-pair-forgery,
platform-assurance, and root-of-trust guards under `tests/`.

## The root of trust: an operator-pinned authority (a pair cannot choose it)

`head.json` is unauthenticated pair-directory data, so it may only *reference* a
platform authority — it may never *define* which authority is trusted. The
installation's trusted authority is instead **pinned by the operator**, once,
into a host trust store OUTSIDE every pair directory (`~/.config/truepad/
platform-trust.json`, or `$TRUEPAD_TRUST_STORE`):

```
truepad2 authority pin <trusted-state-path> --nv-index 0xHANDLE --confirm <authorityId>
```

The command inspects the live TPM index (a non-orderly 8-octet counter), reads
the state file, shows the public identity (provider, NV index, NV Name,
authorityId, path), and writes the pin only after the operator re-confirms the
authorityId. There is **no trust-on-first-use**: opening or `status`-ing a pair
never enrolls its authority. `authority show` prints the pin; `authority unpin`
removes it.

Every platform operation then **resolves** a pair's *claimed* authority against
the pin, through one shared function, and reads the **pinned** state file — never
the one `head.json` names:

- pair claims the pinned authority → **trusted** (the pinned state's attestation
  is read);
- pair claims **any other** authority → **untrusted** → NOT ELIGIBLE, and
  burn/open/retire/ceremony all refuse;
- no pin, or an unreachable pinned TPM → INSUFFICIENT (never gold);
- the live TPM at the pinned index no longer has the pinned Name → inconsistent
  → NOT ELIGIBLE.

So an attacker who edits `head.json` to point at their **own** external TPM
authority (even one pre-loaded with the victim `pairId`) is rejected: that
authority is not the pinned one. And redirecting only the state-file path is
moot, because resolution reads the pinned location, not `head.json`'s.

> **Trust-store boundary.** The pin is durable and outside the pair-directory
> writable domain, so an attacker bounded to pair-directory writes cannot forge
> or redirect it. It is **not** a claim against a hostile OS, a malicious
> administrator, root compromise, a replaced TruePad binary, or host-level
> configuration tampering — those can change the host trust config and are
> outside the claim. Deleting the pin makes the platform authority unavailable
> (a refusal/loss), never a false trust: loss is acceptable, false trust is not.

## Physical-TPM validation is a separate, outstanding gate

The platform authority is validated in this environment by unit tests (a
deterministic FakeTpm) and by the TPM-emulator (swtpm + tpm2-tools)
interoperability job. **That is emulator interoperability evidence, not physical
TPM hardware validation.** A claim about a specific physical TPM remains a
separate real-hardware validation item, tracked outside this software closure.
