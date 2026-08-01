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
| `src/pad.ts` | Rejection-sampled pad generation, irreversible consume/burn, entropy ledger |
| `src/cipher-otp.ts` | Letter-mode (add-mod-26) and byte-mode (XOR) encrypt/decrypt; refuses when short |
| `src/attack-otp.ts` | Crib dragging: leaks on keystream reuse, ties on a true OTP; shared comparator |
| `src/meter.ts` | Pad-remaining vs. message-length meter state and the entropy ledger |
| `src/verdict.ts` | Shannon three-condition grader for both a TruePad pad and a DeckBook deck |

## Develop

```sh
npm install
npm test        # Vitest unit suites
npm run dev     # Vite dev server (UI panels)
npm run build   # type-check + production build
```

MIT licensed.
