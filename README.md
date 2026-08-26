# TruePad

**A true one-time pad — the honest sibling of [DeckBook](https://github.com/systemslibrarian/DeckBook).**

DeckBook's shuffled-deck keystream only *looks* like a one-time pad: 52 cards
folded mod 26 carry ~225.6 bits of entropy where 52 independent letters need
~244.4, and no permutation can hand out one independent uniform symbol per
plaintext symbol. TruePad is the real thing, built to make the difference
visceral: the pad running out, the per-symbol burn, and the crib-drag attack
that leaks against a reused DeckBook keystream but provably learns nothing
against a true pad.

## The three Shannon conditions (the exhibit)

1. **Key ≥ message** — the pad is generated before encryption, and encryption
   refuses outright if the surviving pad is shorter than the message. No
   wraparound, no truncation, no borrowing — ever.
2. **Independent uniform symbols** — every pad symbol is a fresh draw from
   `crypto.getRandomValues()` with rejection sampling (letter mode: uniform
   0–25, add-mod-26; byte mode: uniform 0–255, XOR). Never `Math.random()`.
3. **Used exactly once** — consuming a symbol *deletes* it from the pad.
   No API can return a burned value, so reuse is impossible rather than
   merely forbidden.

The pad itself never touches the public channel: only ciphertext and a
pad-page label travel; the pad goes out of band.

## Core modules (pure, dependency-free, fully unit-tested)

| Module | Purpose |
| --- | --- |
| `src/core/pad.ts` | Rejection-sampled pad generation, irreversible consume/burn, entropy ledger |
| `src/core/cipher-otp.ts` | Letter-mode (add-mod-26) and byte-mode (XOR) encrypt/decrypt; refuses when short |
| `src/core/attack-otp.ts` | Crib dragging: leaks on keystream reuse, ties on a true OTP; shared comparator |
| `src/core/meter.ts` | Pad-remaining vs. message-length meter state and the entropy ledger |
| `src/core/verdict.ts` | Shannon three-condition grader for both a TruePad pad and a DeckBook deck |

## The pad CLI: `truepad-pad` — reuse-safe pad handling, not secure messaging

`src/cli/` is a tool that owns pad state on disk so that a crash, a stale copy
of the pad file, or two processes cannot make a pad symbol serve twice (with
the one limitation stated below). It is **not secure messaging**:
envelopes are unauthenticated, an attacker who knows the plaintext format can
flip chosen bits of a message undetectably, and a forged `startOffset` makes the
receiver burn pad. The tool prints that on every start. There is no message authentication. If it is ever added, Wegman–Carter over
the envelope is the seam, and it costs additional pad.

```sh
node bin/truepad-pad.mjs gen    <dir> [--mode letters|bytes] [--size N] [--external FILE] [--label PAD-XXXX]
node bin/truepad-pad.mjs burn   <dir> (TEXT | --in FILE)       # encrypt: burn pad symbols, print an envelope
node bin/truepad-pad.mjs open   <dir> (ENVELOPE | --in FILE)   # decrypt: seek to the envelope's offset, burn, print plaintext
node bin/truepad-pad.mjs status <dir>
```

The verbs name what happens to the *pad*. Exit codes: `0` ok, `2` refused
(nothing burned), `1` usage or I/O error. Requires Node ≥ 22.18 (it runs the
TypeScript sources under Node's built-in type stripping; the launcher checks
the version before importing anything).

**Durable burn.** A pad directory holds `pad.json` (the pad), `marks.log`
(append-only; one fsynced line per init, burn or open recording the pad's
`nextOffset` afterwards — one past the last burned offset; the highest per
label is the mark the loader checks; kept *separate* from the pad file on
purpose) and, while a process holds the pad, an exclusive `lock`. Files are
created owner-only. On every `burn` and `open` the order is: write the
new `pad.json` and the mark record → fsync → only then print the envelope or
plaintext. A crash in between loses pad symbols and never reuses them; losing
pad is the correct failure direction. On load, a `pad.json` whose `nextOffset`
is below its label's recorded mark is refused as a regressed copy.

**Limitation, stated:** this defends against crashes and against accidentally
loading a stale copy of `pad.json`. It does not defend against an operator
restoring the whole directory from a backup, which regresses the pad and the
mark together.

**External material.** `gen --external FILE` builds a pad from bytes you
supply (for example from a hardware RNG) and tags it `external`. Letter mode
range-reduces by rejection, never modulo. The tool records your assertion of
provenance; it cannot verify where the bytes came from and does not claim to.

## Develop

```sh
npm install
npm test        # Vitest unit suites
npm run dev     # Vite dev server (UI panels)
npm run build   # type-check (browser + CLI configs) + production build
npm run cli -- status <dir>   # the pad CLI (see above)
```

MIT licensed.
