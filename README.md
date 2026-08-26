# TruePad

**A true one-time pad exhibit — the honest sibling of [DeckBook](https://github.com/systemslibrarian/DeckBook) — and a reuse-safe pad CLI.**

Two things live in this repository, separated by directory and by import
direction (`src/core/` is pure; `src/exhibit/` and `src/cli/` may import it
and never each other; a test enforces this):

- **The exhibit** (`src/exhibit/`, deployed to GitHub Pages) teaches Shannon's
  three conditions by letting you watch a pad burn, run out, and shrug off
  crib-dragging.
- **The pad CLI** (`src/cli/`, `truepad-pad`) handles pad material on disk so
  a symbol is never used twice across crashes, copies, or two peers.

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
the channel, never reused. Message authentication (Wegman–Carter over the
envelope) is the extension seam; it costs additional pad and is not in this
revision.

### Core modules (pure, dependency-free, unit-tested)

| Module | Purpose |
| --- | --- |
| `src/core/pad.ts` | Rejection-sampled or external pad material tagged with its source and direction; irreversible consume/burn; seek by burn-forward; high-water mark; entropy ledger |
| `src/core/cipher-otp.ts` | Envelope in/out; letter-mode (add-mod-26) and byte-mode (XOR) encrypt/decrypt with role, label, shape, reuse and exhaustion checks — every refusal typed and before any burn |
| `src/core/attack-otp.ts` | Crib dragging: leaks on keystream reuse, ties on a true OTP; shared comparator |
| `src/core/meter.ts` | Pad-remaining vs. message-length meter state and the entropy ledger |
| `src/core/verdict.ts` | Shannon three-condition grader, split into COMBINER and SOURCE lines, for a pad and for a DeckBook deck |

## The pad CLI: `truepad-pad` — reuse-safe pad handling, not secure messaging

`src/cli/` is an operational tool that owns pad state on disk so a pad symbol
is never used twice across process boundaries. It is **not secure messaging**:
envelopes are unauthenticated, an attacker who knows the plaintext format can
flip chosen bits of a message undetectably, and a forged `startOffset` makes the
receiver burn pad. The tool prints that on every start. Even with durable burn
and the direction split, a pad **still requires out-of-band delivery, still
has no integrity, and still cannot verify that external material came from a
physical source.** This repository does not recommend one-time pads for real
traffic.

```sh
node bin/truepad-pad.mjs gen    <dir> [--mode letters|bytes] [--size N] [--external FILE] [--label PAD-XXXX]
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

**Durable burn.** Each half holds `pad.json` (the pad) and `marks.log`
(append-only, one fsynced line per burn recording the label's high-water mark,
kept *separate* from the pad file on purpose); while a process holds the pair
there is an exclusive `lock`. On every `burn` and `open` the order is: write
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
