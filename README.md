# TruePad

**A true one-time pad exhibit — the honest sibling of [DeckBook](https://github.com/systemslibrarian/DeckBook) — and a reuse-safe pad CLI.**

Two things live in this repository, separated by directory and by import
direction (`src/core/` is pure; `src/exhibit/` and `src/cli/` may import it
and never each other; a test enforces this):

- **The exhibit** (`src/exhibit/`, deployed to GitHub Pages) teaches Shannon's
  three conditions by letting you watch a pad burn, run out, and shrug off
  crib-dragging.
- **The pad CLI** (`src/cli/`, `truepad-pad`) handles pad material on disk so
  that a crash, a stale copy of the pad file, or two peers sharing one pad
  cannot make a symbol serve twice — with the one limitation its section states.

Neither is a recommendation to use one-time pads for real traffic. Both say,
on the page and on every start, what they do not do.

## The exhibit

DeckBook's shuffled-deck keystream only *looks* like a one-time pad: 52 cards
folded mod 26 carry ~225.6 bits of entropy where 52 independent letters need
~244.4, and no permutation can hand out one independent uniform symbol per
plaintext symbol. TruePad's *combiner* is the real thing, built to make the
difference visceral: the pad running out, the per-symbol burn, and the
crib-drag attack that leaks against a reused DeckBook keystream but learns
nothing against a pad of independent uniform symbols.

### The three Shannon conditions, and what this code can honestly claim

1. **Key ≥ message** — the pad is generated before encryption, and encryption
   refuses outright if the surviving pad is shorter than the message. No
   wraparound, no truncation, no borrowing — ever.
2. **Independent uniform symbols** — every pad symbol is one draw,
   range-reduced by rejection sampling (letter mode: uniform 0–25, add-mod-26;
   byte mode: uniform 0–255, XOR). Never `Math.random()`, never a modulo fold.
   **The draws come from `crypto.getRandomValues()`, a deterministic random
   bit generator.** A pad of *n* symbols therefore carries at most the
   generator's state entropy (on the order of 256 bits), not *n* × bits per
   symbol, and this condition holds *computationally* — against an adversary
   who cannot tell the generator from true randomness — not
   information-theoretically. Operator-supplied material (`Pad.fromExternal`)
   is tagged `external`; the code records that assertion and cannot verify
   physical origin.
3. **Used exactly once** — consuming a symbol *deletes* it from the pad in
   memory, and the receiver refuses any envelope at or below its high-water
   mark. Within one process no API can return a burned value. Across
   processes, crashes and copies, that guarantee needs a durable burn and a
   mark kept apart from the pad file — which is the CLI's job, below. The
   browser exhibit deliberately keeps no pad state.

### The verdict has two lines

Station 4 grades the **combiner** (unconditional given the three conditions —
a theorem about the structure, whatever the source) and the **source**
separately: `computational — bounded by the platform DRBG state` for a
generated pad, `declared external — provenance asserted by the operator, NOT
verified by this tool` for supplied material. A pad that passes all three
conditions with a computational source is the honest common case, and the
page says so instead of rounding it up.

### What crosses the wire

Only the envelope — `{ label, startOffset, consumed, payload }` — ever touches
the public channel; the pad goes out of band. The receiver *seeks* to
`startOffset`, burning everything it skips, and refuses any envelope at or
below what it has already burned: a replay, a late arrival and an overlapping
window all land in the same typed refusal, before any burn.

**The envelope is not authenticated**, and that cuts two ways. A modified
payload decrypts to modified plaintext with no alarm (station 6 is the live
proof: perfect secrecy is not integrity). A modified `startOffset` drives the
seek, so anyone who can rewrite an envelope on the channel can make the
receiver burn forward through its remaining pad — pad can be *destroyed* from
the channel, never reused. The receiver cannot refuse this: without
authentication a forged `startOffset` is indistinguishable from a legitimate one
that advanced because earlier envelopes were lost, and any cap on how far a seek
may jump would refuse exactly the recovery a dropped message needs. Refusal
becomes possible only once the envelope is authenticated — the non-goal above. There is no message authentication here, and the v1 envelope never gains
it. Wegman–Carter over the envelope is the seam, and it costs additional
pad — built, for a separate store format, as `truepad2` below.

### What is deliberately not here

No message authentication (above). No post-quantum anything, no KEM, no key
transport of any kind: the pad travels out of band, and that constraint is the
exhibit's thesis, not a gap to engineer around. No browser persistence of pad
state: IndexedDB syncs, profiles get backed up, and JavaScript strings cannot
be zeroed, so the page keeps its pads in memory and says so.

### Core modules (pure, dependency-free, unit-tested)

| Module | Purpose |
| --- | --- |
| `src/core/pad.ts` | Rejection-sampled or external pad material tagged with its source and direction; irreversible consume/burn; seek by burn-forward; high-water mark; pad-material ledger |
| `src/core/cipher-otp.ts` | Envelope in/out; letter-mode (add-mod-26) and byte-mode (XOR) encrypt/decrypt with role, label, shape, reuse and exhaustion checks — every refusal typed and before any burn |
| `src/core/attack-otp.ts` | Crib dragging: leaks on keystream reuse, ties on a true OTP; shared comparator |
| `src/core/meter.ts` | Pad-remaining vs. message-length meter state and the pad-material ledger (symbols × bits per symbol — material, not entropy) |
| `src/core/verdict.ts` | Shannon three-condition grader, split into COMBINER and SOURCE lines, for a pad and for a DeckBook deck |

## The pad CLI: `truepad-pad` — reuse-safe pad handling, not secure messaging

`src/cli/` is a tool that owns pad state on disk so that a crash, a stale copy
of the pad file, or two processes cannot make a pad symbol serve twice (with
the one limitation stated below). It is **not secure messaging**:
envelopes are unauthenticated, an attacker who knows the plaintext format can
flip chosen bits of a message undetectably, and a forged `startOffset` makes the
receiver burn pad. The tool prints that on every start. Even with durable burn
and the direction split, a pad **still requires out-of-band delivery, still
has no integrity, and still cannot verify that external material came from a
physical source.** This repository does not recommend one-time pads for real
traffic.

```sh
node bin/truepad-pad.mjs gen    <dir> [--mode letters|bytes] [--size N | --external FILE] [--label PAD-XXXX]
node bin/truepad-pad.mjs burn   <dir> --as A|B (TEXT | --in FILE)       # encrypt with YOUR sending pad, print an envelope
node bin/truepad-pad.mjs open   <dir> --as A|B (ENVELOPE | --in FILE)   # decrypt with your receiving pad: seek, burn, print plaintext
node bin/truepad-pad.mjs status <dir>
```

The verbs name what happens to the *pad*. Exit codes: `0` ok, `2` refused
(nothing burned), `1` usage or I/O error. Requires Node ≥ 22.18 (it runs the
TypeScript sources under Node's built-in type stripping; the launcher checks
the version before importing anything and says so if the runtime is too old).

**Direction.** `gen` produces the *pair*: `<dir>/a-to-b/` and `<dir>/b-to-a/`,
each its own store. The courier copies the whole directory to the peer, so
each party holds both halves and `--as` names which party you are: A burns
`a-to-b` and opens `b-to-a`; B the reverse. Every pad records its direction and
the core refuses a pad whose direction does not fit the declared role, which is
what stops two peers who share one pad from both encrypting with it and burning
identical offsets. The role is a declaration: this guards against the accident,
not against a party who lies about who they are.

**Durable burn** (tested on Linux ext4; see the scope notes in `src/cli/store.ts`
and `lock.ts`). Each half holds `pad.json` (the pad) and `marks.log`
(append-only; one fsynced line per init, burn or open recording the pad's
`nextOffset` afterwards — one past the last burned offset; the highest per
label is the mark the loader checks; kept *separate* from the pad file on
purpose); while a process holds the pair there is an exclusive `lock`. Files
are created owner-only. A directory with only one half (a crash in the middle
of `gen`) is refused by every command. On every `burn` and `open` the order is: write
the new `pad.json` and the mark record → fsync → only then print the envelope
or plaintext. A crash in between loses pad symbols and never reuses them;
losing pad is the correct failure direction. On load, a `pad.json` whose
`nextOffset` is below its label's recorded mark is refused as a regressed copy.

**Limitation, stated:** this defends against crashes and against accidentally
loading a stale copy of `pad.json`. It does not defend against an operator
restoring the whole directory from a backup, which regresses the pad and the
mark together.

**External material.** `gen --external FILE` builds the pair from bytes you
supply (for example from a hardware RNG), split at the byte midpoint — first
half A→B, second half B→A — and tags both `external`. Letter mode
range-reduces by rejection, never modulo. The tool records your assertion of
provenance; it cannot verify where the bytes came from and does not claim to.

| Module | Purpose |
| --- | --- |
| `src/cli/store.ts` | Atomic `pad.json` rewrite, append-only fsynced `marks.log`, load-time regression refusal |
| `src/cli/lock.ts` | `O_CREAT\|O_EXCL` lockfile; a leftover lock is refused with instructions, never auto-broken |
| `src/cli/truepad-pad.ts` | `gen` / `burn` / `open` / `status`, the banner, exit codes |
| `bin/truepad-pad.mjs` | Plain-JS launcher: Node-version gate, then the `.ts` entry |

## truepad2 — Store Format v2: authenticated envelopes

`truepad2` is the Wegman–Carter seam named above, actually built — as Store
Format v2, a separate tool over a separate store. `docs/FORMAT-V2.md` is the
binding specification; where this README and that document disagree, the
spec wins.

**What v2 adds.** Every v2 record carries a 128-bit `wc-one-time-v1` tag:
POLYVAL exactly as specified in RFC 8452, under a fresh one-time key, masked
by a fresh one-time value — 32 bytes of pad material per record, spent
whether or not the record ever verifies, never reused or re-derived.
The per-attempt forgery bound is exactly ε = 65540 · 2^-128 at the 1 MiB
record cap, and per record at most `verifyAttemptLimit` times that
(default 8); the bound holds against unbounded computation, conditional on
declared-uniform source material (FORMAT-V2.md §5, §7). Every refusal is
typed — printed as `refused: <type> — <message>`, exit 2 — and burns nothing
it does not say it burns. The v1 attack above, a forged `startOffset` that
makes the receiver burn forward through its remaining pad, becomes a
refusal — except with the stated probability: a forged or tampered envelope
verifies with probability at most `verifyAttemptLimit · ε`, and only a
record that passes the tag check can drive a burn. Skipped material — a
lost message's bytes and auth records — is burned only after a tag
verifies, never on an unauthenticated say-so. That is a bound, not
immunity, and this README states the number instead of rounding it to zero.

**Two budgets.** A v2 direction store holds two independent secret budgets,
frozen at gen and never revisable: encryption bytes (`--encryption-bytes E`)
and authentication records (`--auth-records N`, 32 pad bytes each). Each
send spends exactly one auth record, so the two run out separately;
`status` shows both meters and names which one binds
(`CHANNEL CAPACITY LIMITED BY:`). Auth exhaustion permanently ends sending
on that direction; stranded encryption material is destroyed at retirement,
never spent.

**The availability price, stated plainly.** Every in-window forgery attempt
costs the receiver one durable write — the attempt reservation, persisted
before any verification, so a crash loses an attempt and never grants one.
Forgery spam can freeze the pair; the freeze threshold and the finite
lookahead window are the brakes (the freeze is the reversible operator
brake, the per-sequence attempt limit the permanent one), and out-of-window
garbage is refused free. Auth records an attacker contests are destroyed
unused at an explicit operator `retire`: destruction from the channel is
not eliminated, it is bounded by the window, surfaced to the operator, and
never silent. No failed attempt burns either namespace — contrast v1, where
one forged `startOffset` silently burns any amount of remaining pad.

**What v2 does not change.** The pad still requires out-of-band delivery,
and the courier model is v1's: gen produces the pair, the whole directory
is copied to the peer, and the copies then diverge on purpose — A burns in
A's copy, B opens in B's copy. (In a single shared directory every burn
advances that copy's own auth high-water, so opening your own envelope
there is refused `sequence-retired`; the copy step is part of the protocol,
not a convenience.) Restoring the whole pair directory from a backup still
regresses the counters and the journal together — the v2 format does not
fix backup, and that residual is STILL OPEN until a Phase-4 rollback
witness exists — and v2 adds a named operator assumption of its own: a
pair directory is restored as all three files together or not at all
(FORMAT-V2.md §9.4; a per-file restore that rolls the counters back over
zeroized regions voids the bound outright). Durability is verified on
Linux ext4 only (FORMAT-V2.md §10); Windows, network filesystems, and
macOS power-loss durability are unverified. And this tool still cannot
verify that source material came from a physical source: it records the
operator's declaration. This repository still does not recommend one-time
pads for real traffic.

**v1 coexistence.** v1 pads keep working with `truepad-pad`, unchanged. v2
tooling refuses every v1 store (`v1-store` — letters or bytes) and every
v1 envelope (`envelope-v1`). There is no conversion, in either direction,
ever — no `--legacy`, no `--no-auth`, no `--force`. The one migration is
to generate a fresh v2 pair and retire the v1 pair on its own terms.

```sh
node bin/truepad2.mjs gen          <dir> --source FILE [--source FILE ...] [--origin TEXT ...] --encryption-bytes E --auth-records N
                                   [--verify-attempt-limit 8] [--max-auth-lookahead 64] [--freeze-threshold 32]
node bin/truepad2.mjs burn         <dir> --as A|B (TEXT | --in FILE)           # encrypt + tag with YOUR sending store, print a v2 envelope
node bin/truepad2.mjs open         <dir> --as A|B (ENVELOPE-JSON | --in FILE)  # verify the tag FIRST, then burn, then print plaintext
node bin/truepad2.mjs status       <dir>                                       # both meters + CHANNEL CAPACITY LIMITED BY
node bin/truepad2.mjs clear-freeze <dir>                                       # reversible operator brake; never resets attempt counters
node bin/truepad2.mjs retire       <dir> --direction a-to-b|b-to-a --through-sequence S [--through-offset O] [--reason TEXT]
node bin/truepad2.mjs ceremony     create|verify ...                           # operator ceremony; see docs/CEREMONY.md
```

Exit codes and the Node ≥ 22.18 requirement are v1's, unchanged. The
`ceremony` verb wraps gen and media verification (`ceremony create` /
`ceremony verify`) — offline workspace, multiple sources of distinct
physics, printed operator assertions; the retirement ceremony is a
documented procedure around the standalone `retire` verb. All of it is in
`docs/CEREMONY.md`.

| Module | Purpose |
| --- | --- |
| `src/core/hex.ts` | Lowercase-hex codec — one accepted wire spelling per byte, nothing normalized |
| `src/core/gf128.ts` | GF(2^128)/POLYVAL per RFC 8452, every constant pinned, bit-serial on purpose |
| `src/core/wc-one-time.ts` | `wc-one-time-v1`: canonical bytes, tag = POLYVAL XOR mask, constant-time compare |
| `src/core/envelope2.ts` | The strict eight-field v2 envelope: encode, strict parse, v1-signature refusal |
| `src/core/partition2.ts` | Bytewise-XOR source combination and the deterministic four-slice partition |
| `src/cli/v2/store2.ts` | `head.json` + `secret.bin` + `journal.log`: durable commits, attempt reservation, journal reconciliation, zeroize-after-retire |
| `src/cli/v2/truepad2.ts` | The verbs, the typed refusal register, the banner, exit codes |
| `bin/truepad2.mjs` | Plain-JS launcher: Node-version gate, then the `.ts` entry |

## Develop

```sh
npm install
npm test        # Vitest unit suites (tests/)
npm run test:e2e   # Playwright: drives the real exhibit in Chromium (e2e/); first run: npx playwright install --with-deps chromium
npm run dev     # Vite dev server (the exhibit)
npm run build   # type-check (browser + CLI configs) + production build
npm run cli -- status <dir>   # the pad CLI
```

CI (`.github/workflows/deploy.yml`) runs the unit suites, the build (which
type-checks both configs) and the e2e suite before anything deploys.

MIT licensed.
