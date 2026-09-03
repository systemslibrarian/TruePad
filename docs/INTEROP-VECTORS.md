# TruePad 3.0 — Interoperability & test-vector package

This defines what an outside developer needs to build a **minimal independent
implementation** of the TruePad wire/state formats and prove byte-level
interoperability. A second implementation is useful **interoperability** evidence;
it is **not** an independent security review (see
[INDEPENDENT-REVIEW-BRIEF.md](INDEPENDENT-REVIEW-BRIEF.md)).

## Minimal format subset (what a second implementation must cover)

To interoperate for ordinary messaging, implement the frozen v2 byte formats
(normative in [FORMAT-V2.md](FORMAT-V2.md); Swift/Kotlin/Rust ports must match the
same bytes as `src/core/*`):

1. **Pad partition** (`partition2`) — how source octets split into encryption vs
   one-time authentication material.
2. **OTP encryption** — literal XOR.
3. **One-time Wegman–Carter** (`wc-one-time-v1`) — POLYVAL over GF(2¹²⁸), one-time
   key/mask.
4. **Message envelope** (`envelope2`) — the canonical authenticated byte-string and
   the exact wire keys.
5. **Compact envelope** (`compact-envelope2` / TP2) — the compact presentation that
   decodes to the identical canonical bytes.
6. **Fixed-record framing** (`frame2`) — u32-LE length prefix + plaintext + zero
   pad to `F`, capacity `F − 4`.
7. **Courier container** — the pair-transport container format.

The maximum-assurance layer (provenance, TPM authority, root-of-trust pin, ceremony
assurance, the deployment evaluator) is **platform-specific state**, not wire; a
second implementation interoperates for *messages* without reimplementing it, and
if it does reimplement the evaluator it MUST use the same semantics
([TRUEPAD-3-SPEC.md](TRUEPAD-3-SPEC.md) §26–§27) and never a stronger verdict.

## The corpus

The canonical vectors are generated from the reference TypeScript. The Android
port already ships a working example of this pattern (`android/tools/generate-vectors.mjs`
+ `android/vectors/*.json`, checked in the Kotlin direction). The corpus SHOULD
include, each as `{ input, expected_bytes }` (hex), with **no secret required**
where a fixed test pad is used:

- **OTP/WC vectors** — plaintext + pad + WC material → ciphertext + tag.
- **Envelope vectors** — a message → its canonical authenticated bytes → its wire
  form and its compact (TP2) form (both decode to the same canonical bytes).
- **Fixed-record vectors** — plaintexts at, below, and above capacity `F − 4`
  (the over-capacity case is an expected **refusal**, not bytes).
- **Pair-direction vectors** — the same plaintext in `A->B` vs `B->A` must produce
  distinct, non-cross-verifiable outputs.
- **Courier-container vectors** — a container round-trips to the same pair state.

## Valid / invalid (positive and negative) corpus

An interoperable verifier MUST accept every **valid** vector and reject every
**invalid** one. Include negative cases:

- an envelope with an **extra wire key** → rejected;
- a **truncated/oversized** ciphertext or tag → rejected;
- a **tampered** tag or ciphertext byte → verification fails;
- a **cross-direction** envelope → verification fails;
- a **duplicate/replayed** sequence beyond the attempt bound → contested;
- a **malformed frame** (bad length prefix, non-zero padding where zero is
  required) → rejected.

Each negative case names the **expected refusal**; a second implementation that
*accepts* any of them is non-interoperable and a potential forgery/parse-ambiguity
bug.

## Recommended target language

For a minimal independent implementation used as interoperability evidence,
**Rust** is the best fit: memory-safe, no GC surprises for constant-time-ish code,
easy exact-byte control, good test tooling, and it forces explicit handling of the
refusal cases. **Go** is a reasonable alternative (simple, memory-safe, fast to
write) if the implementer prefers it. Either is fine; the point is a *separate*
codebase reaching the *same bytes*, not another cryptosystem built for optics.

A future native **Swift** iOS engine ([MOBILE-IOS-PLAN.md](MOBILE-IOS-PLAN.md))
will itself be such a second implementation and can contribute vectors — but, as
above, being written in another language does not make it independent security
review.

## How to run interop

1. Generate the corpus from the reference implementation at a known SHA.
2. Feed each `input` to the second implementation; compare `output` bytes exactly.
3. Feed each negative case; confirm the expected refusal.
4. Record the reference SHA, the second-implementation commit, and the pass matrix.

Do not treat a green interop matrix as a security proof — it proves the two agree
on the bytes, which is necessary but not sufficient.
