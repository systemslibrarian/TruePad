# TP2 Compact Transport v1

A presentation codec for Envelope v2. It changes what a person copies. It
changes nothing a cryptographer would care about.

```
{"formatVersion":2,"pairId":"ed5825e73edd8beb9962abfed3826985","direction":"A->B",
 "sequence":1,"startOffset":4,"ciphertextLength":5,"ciphertext":"1ab8b8a130",
 "tag":"a4354c856b5c7fba93b3d49f95c55f86"}                          199 characters

TP2:AQLtWCXnPt2L65liq_7TgmmFAAEEBRq4uKEwpDVMhWtcf7qTs9SflcVfhg       62 characters
```

Both lines are the **same** `EnvelopeV2`. Either one opens.

---

## What this is, and what it is not

**It is** a reversible spelling of one envelope:

```
TP2:<canonical unpadded base64url(binary envelope)>
     ↓  decode
EnvelopeV2
     ↓
the exact existing §6 validation / authentication / open pipeline
```

**It is not** a cipher, a MAC, a compression scheme, a second cryptographic
protocol, a new envelope meaning, or a Store Format change. In particular it is
**not an authentication canonicalization**. The Wegman–Carter tag is computed
over the *semantic* fields — `wc-one-time.ts` `canonicalBytes(pairId, direction,
sequence, startOffset, ciphertext)` — and therefore over **neither** the JSON
text **nor** these compact bytes. Nothing here is authenticated separately, and
nothing here needs to be: a compact message decodes to an `EnvelopeV2` and is
then verified by the existing pipeline, unchanged.

**§6.2 canonical JSON remains the canonical wire representation of Envelope v2
and stays valid forever.** It is what `encodeEnvelope2` emits, what
`decodeEnvelope2` parses, what the CLI prints by default, and what every
existing fixture still is.

---

## Binary layout

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | compact transport version — `0x01` |
| 1 | 1 | envelope `formatVersion` — `0x02` |
| 2 | 16 | `pairId`, raw bytes |
| 18 | 1 | `direction` — `0x00` = `A->B`, `0x01` = `B->A` |
| 19 | *n* | `sequence`, canonical unsigned LEB128 |
| … | *n* | `startOffset`, canonical unsigned LEB128 |
| … | *n* | `ciphertextLength`, canonical unsigned LEB128 |
| … | `ciphertextLength` | `ciphertext`, raw bytes |
| … | 16 | `tag`, raw bytes |

Nothing else. **No checksum, no CRC, no hash, no compression, no KDF, no
encryption layer.** A second integrity field would invite the belief that the
transport is a security boundary. It is not — the tag already authenticates the
envelope, and a transport checksum would only detect the corruption the tag
already detects, while making a tampered message look "structurally fine".

`ciphertextLength` is **carried explicitly**, even though a binary parser could
infer it from what remains. It is an existing semantic field of the envelope
grammar, and the compact form asserts it and then checks it against what is
actually present, exactly as the JSON grammar does. Inferring it would quietly
let the two representations describe different things.

### Canonical spellings

One message has one spelling, enforced twice:

- **Varints are minimal.** `0` is `00`, never `80 00`; a multi-byte encoding may
  not end in a group carrying nothing. Decoding uses `BigInt` internally so an
  overlong or oversized varint is refused *before* it could become an imprecise
  `Number`; `EnvelopeV2` itself never sees a `BigInt`.
- **base64url is canonical.** RFC 4648 §5 alphabet only (`A–Z a–z 0–9 - _`), no
  `=` padding, no `+` or `/`. The decoder re-encodes what it decoded and
  requires byte-for-byte equality with the text that arrived.

Neither rule is a security boundary on its own — the tag is — but a transport
that admits several spellings of one message is a transport that will eventually
be asked which spelling was "the" message, and there is no good answer.

Surrounding paste whitespace is trimmed, because that is what a paste looks
like. Whitespace *inside* the payload is not a spelling of anything.

---

## Validation

A compact message can represent **only** what the canonical implementation
would itself emit and accept. After the structural parse, the candidate goes
through `encodeEnvelope2` → `decodeEnvelope2`, so envelope domain rules live in
exactly one place. The compact form is not a looser door into the same house.

`decodeEnvelopeTransport2` is the door both editions use: input beginning
`TP2:` is decoded as compact and **refused as compact** if malformed — it never
falls back to the JSON parser, because a half-typed compact string is not a JSON
document, and pretending otherwise would report the wrong error and invite a
parser-confusion bug. Anything else goes to the existing strict parser, with
byte-identical behaviour and refusal precedence.

---

## Size

JSON spends two hex characters per ciphertext byte; base64url spends about 4/3.
No compression is involved, wanted, or claimed.

| ciphertext | JSON | compact | smaller by |
| --- | --- | --- | --- |
| 1 B | 191 | 56 | 70.7% |
| 5 B | 199 | 62 | 68.8% |
| 1 KiB | 2,240 | 1,422 | 36.5% |
| 1 MiB (max) | 2,097,347 | 1,398,159 | 33.3% |

---

## Where it appears

- **Browser Send** shows, copies, shares and saves the compact form. The worker
  result stays canonical JSON internally — the engine protocol is not reshaped
  to make a screen shorter. The canonical JSON is available under **Details →
  Canonical JSON**, framed as the same message in technical form, not as the
  stronger or more real one.
- **Browser Open** accepts either spelling. No mode selector, no "what format is
  this?" question. Paste → Open.
- **CLI `burn`** prints canonical JSON **by default** — scripts and the test
  suite depend on it, and backward compatibility is not something a presentation
  flag gets to spend. `--compact` opts into the TP2 spelling.
- **CLI `open`** accepts either spelling, with no input flag.

Fixed-size records work unchanged: the codec sees `ciphertextLength` only, and
fixed-record framing lives entirely below this layer. Encrypted files travel
exactly like messages — the payload is arbitrary bytes throughout.

---

## Frozen reference vector

```
JSON     {"formatVersion":2,"pairId":"ed5825e73edd8beb9962abfed3826985",
          "direction":"A->B","sequence":1,"startOffset":4,"ciphertextLength":5,
          "ciphertext":"1ab8b8a130","tag":"a4354c856b5c7fba93b3d49f95c55f86"}

compact  TP2:AQLtWCXnPt2L65liq_7TgmmFAAEEBRq4uKEwpDVMhWtcf7qTs9SflcVfhg
```

This vector is frozen and pinned by a test. If it ever changes, the transport
changed, and every message anyone already copied stops being readable.
