# Comparison wordlist — provenance

TruePad renders the protocol's 11-bit indices (§6.3's twelve, §8.2's eight) as
words so two people can compare them aloud. The list below is the source of
those words, vendored verbatim.

| | |
| --- | --- |
| Upstream repository | `bitcoin/bips` |
| Upstream path | `bip-0039/english.txt` |
| Upstream git blob SHA-1 | `942040ed50f7205cafc465496229128ba4f78e75` |
| SHA-256 of the vendored bytes | `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda` |
| Size | 13116 bytes, 2048 lines, trailing newline |
| Date vendored | 2026-08-30 |
| Licence | **MIT** — BIP-0039 states "License: MIT" in its own header and that
  "This BIP falls under the MIT License." |

Verified at vendoring time: exactly 2048 entries, all unique, all lowercase
ASCII, index 0 `abandon`, index 1 `ability`, final entry `zoo`. The blob SHA-1
above was reproduced locally with `git hash-object` against the fetched file and
matches the upstream object.

## What this list is NOT

It is **not** a BIP-39 mnemonic facility. TruePad does not create wallet
mnemonics, apply BIP-39 checksum rules, derive seeds, or accept a user-typed
phrase. It maps a fixed index to a fixed word, and that is all.

## Why the order is frozen

**Index position IS the protocol mapping.** Re-sorting or regenerating this file
in a different order changes which words two people compare, so two conforming
TruePad builds would disagree about a fingerprint while both looked correct.
`tests/ui-wordlist.test.ts` pins the SHA-256 above and re-derives the generated
array from this file on every run.

## No runtime fetch

The list is compiled into the bundle. TruePad never fetches it, never reads it
from a CDN, and takes no dependency on an online mnemonic package for 2048
strings.
