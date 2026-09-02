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

## The classification is derived, never stored

TruePad records **facts** and bounded **operator declarations**, and derives the
classification from them through one shared evaluator every time it is asked. No
store ever holds a self-certifying verdict — there is no `trueRandom`,
`itCapable`, `perfectSecrecy`, `shannonSecure`, `maximumSecurity`, or
`goldStandard` field anywhere, and none may be added. Downgrades are allowed;
assurance is never *upgraded* by a convenience operation.

## The seven facts

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
| **rollback-witness** | the reuse/rollback authority — a separate state file, a platform-monotonic counter, a browser-local witness, or none |

## Reaching CONDITIONALLY ELIGIBLE

Only this exact conjunction reaches the strongest label, and it exists only on the
native CLI. Each step records a fact the previous one could not:

1. **Generate by the physical ceremony.** `truepad2 ceremony create <workspace>
   --medium-a A --medium-b B --source … --source … --record-bytes F
   --encryption-bytes E --auth-records N --witness-class … --witness-path …
   --assert-offline --assert-distinct-physics --assert-tmpfs-workspace
   --assert-no-persistent-copy`. This records `creation = cli-ceremony`, external
   source, ceremony premises **accepted**, and provisions two peer media, each a
   full byte-verified pair copy. Delivery is still `local-only`, so the pad is
   **INSUFFICIENT EVIDENCE** — the courier has not run yet.

2. **Configure an independent rollback witness** at generation (a separate state
   file, or a TPM platform-monotonic counter). A witness is about **reuse**, not
   entropy or delivery; without one the pad stays INSUFFICIENT.

3. **Accept the private handoff, once the media have reached their peers.**
   `truepad2 ceremony accept <medium> --as A|B --assert-private-handoff
   --assert-no-extra-copy`. This is the one-way boundary that records `delivery =
   physical private handoff (operator premise)`. It refuses a non-ceremony store,
   an unreadable-provenance store, or a missing assertion; it writes durable
   provenance before it reports; and its pad-book record says plainly that
   **TruePad recorded an operator assertion and did not observe the courier.**

With `creation = cli-ceremony`, external-declared source, delivery accepted, no
sealed ancestor, premises accepted, **native** storage, and an independent
rollback witness, `truepad2 status` shows **CONDITIONALLY ELIGIBLE** — beside the
six premises below.

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

Malformed, torn, contradictory, or absent provenance is read as **UNKNOWN**, which
maps to INSUFFICIENT EVIDENCE — never a stronger result. A crash during a
provenance write leaves the old record or none, never a torn one and never one
that looks more assured than what was durably established. A restored or cloned
store keeps its recorded creation; relocating a `gen` store never makes it a
ceremony store. Every one of these is exercised by the falsification and hostile-
input guards under `tests/`.
