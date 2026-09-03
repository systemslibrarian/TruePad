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
| Licence | **MIT**, as stated by BIP-0039 itself (see the notice reproduced below) |

Verified at vendoring time: exactly 2048 entries, all unique, all lowercase
ASCII, index 0 `abandon`, index 1 `ability`, final entry `zoo`. The blob SHA-1
above was reproduced locally with `git hash-object` against the fetched file and
matches the upstream object.

## Attribution and licence notice

BIP-0039's own header states `License: MIT` and that "This BIP falls under the
MIT License." That statement is the licence grant this vendoring relies on, and
it is reproduced here rather than merely cited, because a vendored file that
carries no notice is a file whose terms travel only in someone's memory.

> Copyright (c) 2013 Marek Palatinus, Pavol Rusnak, Aaron Voisine, Sean Bowe
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

**What the notice does and does not settle.** It is the licence BIP-0039 gives
for itself. TruePad relies on it for the one thing it does here — reproducing a
2048-line list of English words in a fixed order — and claims nothing more about
the copyrightability of a word list in any jurisdiction.

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
